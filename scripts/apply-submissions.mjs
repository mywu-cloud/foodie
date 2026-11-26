/**
 * 處理 /admin「投稿審核」的結果（.github/workflows/apply-submissions.yml 在 submissions/ 有變動時執行）
 *
 * 每一筆 submissions/<id>.json：
 *   status = pending   → 不動（等待審核）
 *   status = approved  → 寫入 src/content/restaurants/<slug>.json、照片搬到 public/images/restaurants/、
 *                        有新鄉鎮區就加進 regions.json → 跑資料驗證 → 通過才刪除投稿檔
 *                        驗證沒過：這筆完全還原，狀態改回 pending 並把錯誤寫進 reviewError（後台看得到）
 *   status = rejected  → 刪除投稿檔與照片
 * 另外會清掉沒有對應投稿檔的孤兒照片（例如直接在後台刪除投稿）。
 *
 * 輸出：stdout 最後一行 RESULT=<changed|none>，workflow 據此決定要不要部署。
 */
import { readFile, writeFile, readdir, rename, rm, mkdir, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pinyin } from 'pinyin-pro';

const SUB = 'submissions';
const PHOTOS = `${SUB}/photos`;
const RESTAURANTS = 'src/content/restaurants';
const REGIONS = 'src/content/taxonomy/regions.json';
const PUBLIC_IMG = 'public/images/restaurants';

const exists = (p) => access(p).then(() => true, () => false);
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));
const writeJson = (p, v) => writeFile(p, JSON.stringify(v, null, 2) + '\n');
const twToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

const slugify = (text) =>
  pinyin(text, { toneType: 'none', type: 'array', nonZh: 'consecutive' })
    .join('-')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '') || 'shop';

const EDITABLE = ['name', 'address', 'phone', 'openingHours', 'priceRange', 'description', 'regionId', 'districtId', 'categoryId', 'subcategoryId', 'tierId', 'editorNote'];
const REQUIRED = ['name', 'address', 'description', 'regionId', 'districtId', 'categoryId', 'tierId'];
const ORDER = ['urlId', 'name', 'regionId', 'districtId', 'categoryId', 'subcategoryId', 'tierId', 'address', 'phone',
  'openingHours', 'priceRange', 'tags', 'description', 'coverImage', 'gallery', 'lat', 'lng', 'editorNote', 'lastReviewedAt'];

const str = (v) => (v == null ? '' : String(v).trim());
const toList = (v) => (v == null || v === '' ? [] : Array.isArray(v) ? v : [v]).filter(Boolean);

// 簡易「交易」：記錄每個檔案的原始內容，失敗時整筆還原
function transaction() {
  const backups = new Map(); // path → Buffer | null（null = 原本不存在）
  const remember = async (p) => {
    if (!backups.has(p)) backups.set(p, (await exists(p)) ? await readFile(p) : null);
  };
  return {
    async write(p, content) { await remember(p); await writeFile(p, content); },
    async move(from, to) { await remember(from); await remember(to); await rename(from, to); },
    async remove(p) { await remember(p); await rm(p, { force: true }); },
    async rollback() {
      for (const [p, buf] of backups) {
        if (buf === null) await rm(p, { force: true });
        else await writeFile(p, buf);
      }
    },
  };
}

function validate() {
  try {
    execFileSync('node', ['scripts/validate-content.mjs'], { stdio: 'pipe', encoding: 'utf8' });
    return null;
  } catch (e) {
    return (e.stdout + e.stderr).split('\n').filter((l) => l.startsWith('❌')).join('\n') || e.message;
  }
}

async function approve(id, s, tx) {
  // 照片：submissions/photos/x → public/images/restaurants/x
  const movePhoto = async (src) => {
    if (!src.startsWith(`/${PHOTOS}/`)) return src; // 編輯在後台換成其他照片路徑時保持原樣
    const file = src.slice(PHOTOS.length + 2);
    await mkdir(PUBLIC_IMG, { recursive: true });
    if (await exists(`${PHOTOS}/${file}`)) await tx.move(`${PHOTOS}/${file}`, `${PUBLIC_IMG}/${file}`);
    return `/images/restaurants/${file}`;
  };
  const photos = [];
  for (const p of toList(s.photos)) photos.push(await movePhoto(str(p)));

  // 新鄉鎮區（核准時才加入地區設定）
  if (s.newDistrict) {
    const nd = typeof s.newDistrict === 'string' ? JSON.parse(s.newDistrict) : s.newDistrict;
    if (nd?.id && str(s.districtId) === nd.id) {
      const doc = await readJson(REGIONS);
      const region = doc.regions.find((r) => r.id === nd.regionId);
      if (region && !region.districts.some((d) => d.id === nd.id)) {
        region.districts.push({ id: nd.id, name: nd.name });
        await tx.write(REGIONS, JSON.stringify(doc, null, 2) + '\n');
      }
    }
  }

  let slug, record;
  if (s.mode === 'update') {
    slug = str(s.targetSlug);
    const path = `${RESTAURANTS}/${slug}.json`;
    if (!slug || !(await exists(path))) throw new Error(`要修改的店家 ${slug || '(空白)'} 已不存在`);
    record = await readJson(path);
    const baseline = s.baseline ? (typeof s.baseline === 'string' ? JSON.parse(s.baseline) : s.baseline) : {};
    // 只套用「跟投稿當下不一樣」的欄位（投稿者改的 + 編輯在後台改的），避免蓋掉之後在後台做的其他修改
    for (const k of EDITABLE) {
      const v = str(s[k]);
      if (v === str(baseline[k])) continue;
      if (v) record[k] = v;
      else if (!REQUIRED.includes(k)) delete record[k];
    }
  } else {
    const base = slugify(str(s.name));
    slug = base;
    for (let n = 2; await exists(`${RESTAURANTS}/${slug}.json`); n++) slug = `${base}-${n}`;
    record = { urlId: slug, tags: [] };
    for (const k of EDITABLE) {
      const v = str(s[k]);
      if (v) record[k] = v;
    }
    if (!record.tierId) record.tierId = 'unrated';
  }

  if (photos.length) {
    let rest = photos;
    if (!record.coverImage) {
      record.coverImage = photos[0];
      rest = photos.slice(1);
    }
    const gallery = [...toList(record.gallery), ...rest];
    if (gallery.length) record.gallery = gallery;
  }
  record.lastReviewedAt = twToday();

  const out = {};
  for (const k of ORDER) if (record[k] !== undefined) out[k] = record[k];
  for (const k of Object.keys(record)) if (!(k in out)) out[k] = record[k];
  await tx.write(`${RESTAURANTS}/${slug}.json`, JSON.stringify(out, null, 2) + '\n');
  return slug;
}

async function removePhotosOf(id, tx) {
  if (!(await exists(PHOTOS))) return;
  for (const f of await readdir(PHOTOS)) if (f.startsWith(`${id}-`)) await tx.remove(`${PHOTOS}/${f}`);
}

const log = [];
let changed = false;
const files = (await exists(SUB)) ? (await readdir(SUB)).filter((f) => f.endsWith('.json')) : [];

for (const file of files) {
  const id = file.replace(/\.json$/, '');
  const path = `${SUB}/${file}`;
  let s;
  try {
    s = await readJson(path);
  } catch (e) {
    log.push(`⚠️ ${file} JSON 格式錯誤，略過：${e.message}`);
    continue;
  }
  const status = str(s.status) || 'pending';
  if (status === 'pending') continue;

  const tx = transaction();
  if (status === 'rejected') {
    await removePhotosOf(id, tx);
    await tx.remove(path);
    log.push(`❌ 退件：${s.name}（${id}）`);
    continue;
  }
  if (status !== 'approved') {
    log.push(`⚠️ ${file} 狀態「${status}」看不懂，略過`);
    continue;
  }

  let slug, error;
  try {
    slug = await approve(id, s, tx);
    error = validate();
  } catch (e) {
    error = e.message;
  }
  if (error) {
    await tx.rollback();
    await writeJson(path, { ...s, status: 'pending', reviewError: `核准失敗（${twToday()}），請修正後再核准一次：\n${error}` });
    log.push(`⚠️ 核准失敗，已退回待審：${s.name}（${id}）\n${error}`);
    continue;
  }
  await removePhotosOf(id, tx); // 編輯在後台移除的照片
  await tx.remove(path);
  changed = true;
  log.push(`✅ 已上線：${s.name} → /restaurant/${slug}（${s.mode === 'update' ? '修改' : '新增'}）`);
}

// 孤兒照片：投稿檔已不存在（例如直接在後台刪除投稿）
if (await exists(PHOTOS)) {
  const ids = new Set(((await exists(SUB)) ? await readdir(SUB) : []).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)));
  for (const f of await readdir(PHOTOS)) {
    if (f.startsWith('.')) continue;
    const owner = [...ids].some((id) => f.startsWith(`${id}-`));
    if (!owner) {
      await rm(`${PHOTOS}/${f}`, { force: true });
      log.push(`🧹 刪除孤兒照片 ${f}`);
    }
  }
}

console.log(log.length ? log.join('\n') : '沒有需要處理的投稿');
console.log(`RESULT=${changed ? 'changed' : 'none'}`);
