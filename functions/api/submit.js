/**
 * POST /api/submit —— 一般使用者投稿（免登入）→ 自動對 repo 開 Pull Request，由編輯審查合併才上線
 *
 * Cloudflare Pages Function（跟網站同網域，部署時 wrangler 會一起打包 functions/ 目錄）。
 *
 * 需要在 Cloudflare Pages 專案 → Settings → Variables and Secrets 設定：
 *   GITHUB_SUBMIT_TOKEN  （Secret）Fine-grained token，只授權 mywu-cloud/foodie，
 *                        權限 Contents: Read and write、Pull requests: Read and write
 *   TURNSTILE_SECRET     （Secret）Cloudflare Turnstile 的 Secret key
 * 選填：
 *   GITHUB_REPO          預設 mywu-cloud/foodie
 *   MAX_OPEN_SUBMISSIONS 尚未審查的投稿 PR 上限，預設 50（超過就暫停收件，防灌水）
 *   GITHUB_API           預設 https://api.github.com（測試時可指向模擬伺服器）
 *   TURNSTILE_VERIFY_URL 預設 Cloudflare 官方驗證網址（測試用）
 *
 * 安全設計：
 *   - 投稿者完全碰不到 main：只會建立 submission/* 分支 + PR；不能刪除任何東西
 *   - 只接受固定欄位、長度上限；縣市／分類必須存在於 taxonomy
 *   - 修改既有店家時只套用「真的有改」的欄位；tierId、editorNote、urlId、lastReviewedAt 一律不動
 *   - 建議分級只寫在 PR 說明，不寫入 tierId（分級由編輯決定，見 CLAUDE.md）
 *   - Turnstile 驗證 + 蜜罐欄位 + 同網域檢查 + 待審 PR 數量上限
 */
import { pinyin } from 'pinyin-pro';
import regionsSeed from '../../src/content/taxonomy/regions.json';
import categoriesData from '../../src/content/taxonomy/categories.json';
import tiersData from '../../src/content/taxonomy/tiers.json';

const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const LIMITS = { name: 60, address: 150, phone: 30, openingHours: 150, description: 1000, note: 1000, submitter: 30, tag: 20 };
const PRICE = ['$', '$$', '$$$', '$$$$'];

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

const clean = (v, max) =>
  typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '';

const slugify = (text) =>
  pinyin(text, { toneType: 'none', type: 'array', nonZh: 'consecutive' })
    .join('-')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '') || 'shop';

const twToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const rand = () => Math.random().toString(36).slice(2, 8);

// base64 → 檢查檔頭是否為 JPEG／PNG／WebP，並估算大小
function inspectImage(b64) {
  if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(b64)) return null;
  const size = Math.floor((b64.length * 3) / 4);
  const head = atob(b64.slice(0, 24));
  const bytes = [...head].map((c) => c.charCodeAt(0));
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { ext: 'jpg', size };
  if (bytes[0] === 0x89 && head.slice(1, 4) === 'PNG') return { ext: 'png', size };
  if (head.slice(0, 4) === 'RIFF' && head.slice(8, 12) === 'WEBP') return { ext: 'webp', size };
  return null;
}

async function verifyTurnstile(secret, token, ip, url) {
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token || '');
  if (ip) form.append('remoteip', ip);
  const r = await fetch(url || 'https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const data = await r.json();
  return Boolean(data.success);
}

function github(env) {
  const base = env.GITHUB_API || 'https://api.github.com';
  const repo = env.GITHUB_REPO || 'mywu-cloud/foodie';
  return async (method, path, body) => {
    const r = await fetch(`${base}/repos/${repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${env.GITHUB_SUBMIT_TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'twfood-submit',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    const data = text ? JSON.parse(text) : null;
    if (!r.ok) {
      const err = new Error(`GitHub ${method} ${path} → ${r.status}`);
      err.status = r.status;
      err.data = data;
      throw err;
    }
    return data;
  };
}

const b64ToUtf8 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, '')), (c) => c.charCodeAt(0)));

export async function onRequestPost({ request, env }) {
  if (!env.GITHUB_SUBMIT_TOKEN || !env.TURNSTILE_SECRET) {
    return json(503, { error: '投稿功能尚未開放' });
  }
  // 同網域檢查（防止其他網站代送）
  const origin = request.headers.get('origin');
  if (origin && new URL(origin).host !== new URL(request.url).host) return json(403, { error: '來源不正確' });

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: '資料格式錯誤' });
  }
  if (body.website) return json(200, { ok: true }); // 蜜罐欄位：機器人才會填，假裝成功

  const ip = request.headers.get('cf-connecting-ip');
  if (!(await verifyTurnstile(env.TURNSTILE_SECRET, body.turnstileToken, ip, env.TURNSTILE_VERIFY_URL))) {
    return json(400, { error: '驗證失敗，請重新勾選「我不是機器人」後再送出' });
  }

  const gh = github(env);
  const regionsDoc = structuredClone(regionsSeed);
  const errors = [];
  const d = body.data || {};
  const mode = body.mode === 'update' ? 'update' : 'create';

  // ---------- 欄位檢查 ----------
  const rec = {
    name: clean(d.name, LIMITS.name),
    address: clean(d.address, LIMITS.address),
    phone: clean(d.phone, LIMITS.phone),
    openingHours: clean(d.openingHours, LIMITS.openingHours),
    priceRange: PRICE.includes(d.priceRange) ? d.priceRange : '',
    description: clean(d.description, LIMITS.description),
    regionId: clean(d.regionId, 40),
    districtId: clean(d.districtId, 60),
    categoryId: clean(d.categoryId, 40),
    subcategoryId: clean(d.subcategoryId, 40),
  };
  const districtOther = clean(d.districtOther, 10);
  const note = clean(body.note, LIMITS.note);
  const submitter = clean(body.submitter, LIMITS.submitter);
  const suggestedTier = tiersData.tiers.find((t) => t.id === body.suggestedTier);

  if (!rec.name) errors.push('請填寫店名');
  if (!rec.address) errors.push('請填寫地址');
  if (mode === 'create' && rec.description.length < 5) errors.push('請簡單介紹這家店（至少 5 個字）');

  const region = regionsDoc.regions.find((r) => r.id === rec.regionId);
  if (!region) errors.push('請選擇縣市');
  let newDistrict = null;
  if (region) {
    if (rec.districtId === '__other') {
      if (!/^[一-鿿]{1,6}(區|鄉|鎮|市)$/.test(districtOther)) {
        errors.push('請填寫鄉鎮市區名稱，例如「三民區」「恆春鎮」');
      } else {
        const existing = region.districts.find((x) => x.name === districtOther);
        if (existing) rec.districtId = existing.id;
        else {
          let id = `${region.id}-${slugify(districtOther.replace(/(區|鄉|鎮|市)$/, '')).replace(/-/g, '')}`;
          const allIds = new Set(regionsDoc.regions.flatMap((r) => r.districts.map((x) => x.id)));
          while (allIds.has(id)) id += '2';
          newDistrict = { id, name: districtOther };
          region.districts.push(newDistrict);
          rec.districtId = id;
        }
      }
    } else if (!region.districts.some((x) => x.id === rec.districtId)) {
      errors.push('請選擇鄉鎮市區');
    }
  }
  const category = categoriesData.categories.find((c) => c.id === rec.categoryId);
  if (!category) errors.push('請選擇分類');
  if (category && rec.subcategoryId && !category.subcategories.some((s) => s.id === rec.subcategoryId)) {
    rec.subcategoryId = '';
  }

  const photos = Array.isArray(body.photos) ? body.photos.slice(0, MAX_PHOTOS) : [];
  const photoMeta = [];
  for (const [i, p] of photos.entries()) {
    const info = inspectImage(p?.data);
    if (!info) errors.push(`第 ${i + 1} 張照片格式不支援`);
    else if (info.size > MAX_PHOTO_BYTES) errors.push(`第 ${i + 1} 張照片太大`);
    else photoMeta.push({ ...info, data: p.data });
  }
  if (body.photosConfirmed !== true && photoMeta.length) errors.push('請確認照片為自己拍攝');

  if (errors.length) return json(400, { error: errors.join('；') });

  try {
    // 待審投稿太多時暫停收件（防灌水）
    const max = Number(env.MAX_OPEN_SUBMISSIONS || 50);
    const open = await gh('GET', '/pulls?state=open&per_page=100');
    if (open.filter((pr) => pr.head?.ref?.startsWith('submission/')).length >= max) {
      return json(429, { error: '目前待審查的投稿較多，請過幾天再試，謝謝！' });
    }

    const mainRef = await gh('GET', '/git/ref/heads/main');
    const baseSha = mainRef.object.sha;
    const baseCommit = await gh('GET', `/git/commits/${baseSha}`);

    // ---------- 組成店家資料 ----------
    let slug, record, before = null;
    if (mode === 'update') {
      slug = clean(body.slug, 80);
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return json(400, { error: '找不到要修改的店家' });
      let file;
      try {
        file = await gh('GET', `/contents/src/content/restaurants/${slug}.json?ref=${baseSha}`);
      } catch {
        return json(400, { error: '找不到要修改的店家' });
      }
      before = JSON.parse(b64ToUtf8(file.content));
      record = { ...before };
      // 只套用有改動的欄位；分級、編輯備註、網址代號、複核日期不動
      for (const k of ['name', 'address', 'phone', 'openingHours', 'priceRange', 'description', 'regionId', 'districtId', 'categoryId', 'subcategoryId']) {
        const v = rec[k];
        if ((v || '') !== (before[k] || '')) {
          if (v) record[k] = v;
          else if (!['name', 'address', 'description', 'regionId', 'districtId', 'categoryId'].includes(k)) delete record[k];
        }
      }
      const editable = ['name', 'address', 'phone', 'openingHours', 'priceRange', 'description', 'regionId', 'districtId', 'categoryId', 'subcategoryId'];
      if (!photoMeta.length && editable.every((k) => (record[k] || '') === (before[k] || ''))) {
        return json(400, { error: '沒有偵測到任何修改，請修改有誤的欄位或加上照片後再送出' });
      }
    } else {
      slug = slugify(rec.name);
      // 避免撞名：檔案存在就加後綴
      for (let n = 2; ; n++) {
        try {
          await gh('GET', `/contents/src/content/restaurants/${slug}.json?ref=${baseSha}`);
          slug = `${slugify(rec.name)}-${n}`;
        } catch {
          break;
        }
      }
      record = {
        urlId: slug,
        name: rec.name,
        regionId: rec.regionId,
        districtId: rec.districtId,
        categoryId: rec.categoryId,
        ...(rec.subcategoryId ? { subcategoryId: rec.subcategoryId } : {}),
        tierId: 'unrated',
        address: rec.address,
        ...(rec.phone ? { phone: rec.phone } : {}),
        ...(rec.openingHours ? { openingHours: rec.openingHours } : {}),
        ...(rec.priceRange ? { priceRange: rec.priceRange } : {}),
        tags: [],
        description: rec.description,
        lastReviewedAt: twToday(),
      };
    }

    // ---------- 照片 ----------
    const tree = [];
    const photoPaths = [];
    for (const p of photoMeta) {
      const path = `public/images/restaurants/${slug}-${rand()}.${p.ext}`;
      const blob = await gh('POST', '/git/blobs', { content: p.data, encoding: 'base64' });
      tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
      photoPaths.push('/' + path.replace(/^public\//, ''));
    }
    if (photoPaths.length) {
      const gallery = Array.isArray(record.gallery) ? [...record.gallery] : [];
      let rest = photoPaths;
      if (!record.coverImage) {
        record.coverImage = photoPaths[0];
        rest = photoPaths.slice(1);
      }
      record.gallery = [...gallery, ...rest];
      if (!record.gallery.length) delete record.gallery;
    }

    const order = ['urlId', 'name', 'regionId', 'districtId', 'categoryId', 'subcategoryId', 'tierId', 'address', 'phone',
      'openingHours', 'priceRange', 'tags', 'description', 'coverImage', 'gallery', 'lat', 'lng', 'editorNote', 'lastReviewedAt'];
    const out = {};
    for (const k of order) if (record[k] !== undefined) out[k] = record[k];
    for (const k of Object.keys(record)) if (!(k in out)) out[k] = record[k];

    tree.push({ path: `src/content/restaurants/${slug}.json`, mode: '100644', type: 'blob', content: JSON.stringify(out, null, 2) + '\n' });
    if (newDistrict) {
      tree.push({ path: 'src/content/taxonomy/regions.json', mode: '100644', type: 'blob', content: JSON.stringify(regionsDoc, null, 2) + '\n' });
    }

    // ---------- 分支 → commit → PR ----------
    const newTree = await gh('POST', '/git/trees', { base_tree: baseCommit.tree.sha, tree });
    const title = `${mode === 'create' ? '投稿新增' : '投稿修改'}：${out.name}`;
    const commit = await gh('POST', '/git/commits', {
      message: `content(投稿): ${mode === 'create' ? '新增' : '修改'}「${out.name}」${submitter ? `（投稿者：${submitter}）` : ''}`,
      tree: newTree.sha,
      parents: [baseSha],
    });
    const branch = `submission/${slug}-${Date.now().toString(36)}`;
    await gh('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: commit.sha });

    const regionName = region.name;
    const districtName = region.districts.find((x) => x.id === out.districtId)?.name ?? out.districtId;
    const lines = [
      `> 由網站 \`/user\` 投稿自動建立。合併前請確認內容；**分級請由編輯決定**（投稿者的建議分級不會寫入資料）。`,
      '',
      `- 類型：**${mode === 'create' ? '新增店家' : '修改既有店家'}**`,
      `- 店名：${out.name}（${regionName}・${districtName}）`,
      `- 投稿者：${submitter || '（未填）'}`,
      `- 建議分級：${suggestedTier ? suggestedTier.name : '（未填）'}`,
      ...(newDistrict ? [`- ⚠️ 新增鄉鎮區：${regionName}・${newDistrict.name}（\`${newDistrict.id}\`）`] : []),
      ...(photoPaths.length ? [`- 照片：${photoPaths.length} 張（請確認為投稿者自行拍攝）`] : []),
      ...(note ? ['', '**投稿者備註**', '', note.split('\n').map((l) => `> ${l}`).join('\n')] : []),
    ];
    if (before) {
      const labels = { name: '店名', address: '地址', phone: '電話', openingHours: '營業時間', priceRange: '價位', description: '介紹', regionId: '縣市', districtId: '鄉鎮區', categoryId: '分類', subcategoryId: '細分類' };
      const changed = Object.keys(labels).filter((k) => (before[k] || '') !== (out[k] || ''));
      lines.push('', '**修改內容**', '', '| 欄位 | 原本 | 改為 |', '|---|---|---|');
      for (const k of changed) lines.push(`| ${labels[k]} | ${String(before[k] ?? '').replace(/\|/g, '｜')} | ${String(out[k] ?? '').replace(/\|/g, '｜')} |`);
      if (!changed.length) lines.push('| （沒有修改欄位，只新增照片） | | |');
    }
    lines.push('', '審查清單：', '- [ ] 資料正確（可對照 Google 地圖）', '- [ ] 照片為投稿者自行拍攝、無他人肖像', '- [ ] 合併後到 `/admin` 評定分級');

    const pr = await gh('POST', '/pulls', { title, head: branch, base: 'main', body: lines.join('\n') });
    try {
      await gh('POST', `/issues/${pr.number}/labels`, { labels: ['user-submission'] });
    } catch {
      /* 標籤失敗不影響投稿 */
    }
    return json(200, { ok: true, number: pr.number });
  } catch (e) {
    console.error('submit failed', e.message, JSON.stringify(e.data || {}));
    return json(502, { error: '送出時發生問題，請稍後再試' });
  }
}

export const onRequestGet = () => json(405, { error: 'Method Not Allowed' });
