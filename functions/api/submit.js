/**
 * POST /api/submit —— 一般使用者投稿（免登入）→ 存進 repo 的 submissions/ 收件匣，由編輯在 /admin「投稿審核」核准才上線
 *
 * 流程：投稿 → submissions/<id>.json（+ submissions/photos/）直接 commit 到 main（不觸發部署）
 *      → 編輯在 /admin 把「審核狀態」改成「核准上線」或「退件」並存檔
 *      → .github/workflows/apply-submissions.yml 執行 scripts/apply-submissions.mjs 寫入店家資料並部署
 *
 * Cloudflare Pages Function（跟網站同網域，部署時 wrangler 會一起打包 functions/ 目錄）。
 *
 * 需要在 Cloudflare Pages 專案 → Settings → Variables and Secrets 設定：
 *   GITHUB_SUBMIT_TOKEN  （Secret）Fine-grained token，只授權 mywu-cloud/foodie，
 *                        權限 Contents: Read and write（不再需要 Pull requests 權限）
 *   TURNSTILE_SECRET     （Secret）Cloudflare Turnstile 的 Secret key
 * 選填：
 *   GITHUB_REPO          預設 mywu-cloud/foodie
 *   MAX_OPEN_SUBMISSIONS 收件匣待審投稿上限，預設 50（超過就暫停收件，防灌水）
 *   GITHUB_API           預設 https://api.github.com（測試時可指向模擬伺服器）
 *   TURNSTILE_VERIFY_URL 預設 Cloudflare 官方驗證網址（測試用）
 *
 * 安全設計：
 *   - 投稿只會寫入 submissions/ 資料夾，碰不到 src/content 與 public/；不能刪除任何東西
 *   - 只接受固定欄位、長度上限；縣市／分類必須存在於 taxonomy
 *   - 修改既有店家時只套用「真的有改」的欄位（含編輯在後台調整的分級）；urlId 不動
 *   - 建議分級只當參考顯示在審核頁，不寫入 tierId（分級由編輯決定，見 CLAUDE.md）
 *   - 新鄉鎮區不直接寫入 regions.json，核准時才加入
 *   - Turnstile 驗證 + 蜜罐欄位 + 同網域檢查 + 待審投稿數量上限
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
    let pending = [];
    try {
      pending = (await gh('GET', '/contents/submissions?ref=main')).filter((f) => f.name.endsWith('.json'));
    } catch (e) {
      if (e.status !== 404) throw e; // 資料夾還不存在 = 0 筆
    }
    if (pending.length >= max) {
      return json(429, { error: '目前待審查的投稿較多，請過幾天再試，謝謝！' });
    }

    const mainRef = await gh('GET', '/git/ref/heads/main');
    const baseSha = mainRef.object.sha;

    // ---------- 組成投稿資料 ----------
    const EDITABLE = ['name', 'address', 'phone', 'openingHours', 'priceRange', 'description', 'regionId', 'districtId', 'categoryId', 'subcategoryId'];
    let targetSlug = '', before = null, proposed;
    if (mode === 'update') {
      targetSlug = clean(body.slug, 80);
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(targetSlug)) return json(400, { error: '找不到要修改的店家' });
      let file;
      try {
        file = await gh('GET', `/contents/src/content/restaurants/${targetSlug}.json?ref=${baseSha}`);
      } catch {
        return json(400, { error: '找不到要修改的店家' });
      }
      before = JSON.parse(b64ToUtf8(file.content));
      proposed = { ...before };
      // 只套用有改動的欄位；必填欄位清空時保留原值
      for (const k of EDITABLE) {
        const v = rec[k];
        if ((v || '') !== (before[k] || '')) {
          if (v) proposed[k] = v;
          else if (!['name', 'address', 'description', 'regionId', 'districtId', 'categoryId'].includes(k)) proposed[k] = '';
        }
      }
      if (!photoMeta.length && EDITABLE.every((k) => (proposed[k] || '') === (before[k] || ''))) {
        return json(400, { error: '沒有偵測到任何修改，請修改有誤的欄位或加上照片後再送出' });
      }
    } else {
      proposed = { ...rec, tierId: 'unrated', editorNote: '' };
    }

    const id = `${slugify(rec.name || before?.name || 'shop').slice(0, 30).replace(/-+$/, '')}-${Date.now().toString(36)}${rand().slice(0, 3)}`;

    // ---------- 照片：先放在 submissions/photos/（不會部署上線），核准後才搬到 public/ ----------
    const tree = [];
    const photoPaths = [];
    for (const p of photoMeta) {
      const path = `submissions/photos/${id}-${rand()}.${p.ext}`;
      const blob = await gh('POST', '/git/blobs', { content: p.data, encoding: 'base64' });
      tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
      photoPaths.push('/' + path);
    }

    const regionName = region.name;
    const districtName = newDistrict?.name ?? region.districts.find((x) => x.id === proposed.districtId)?.name ?? proposed.districtId;
    const labels = { name: '店名', address: '地址', phone: '電話', openingHours: '營業時間', priceRange: '價位', description: '介紹', regionId: '縣市', districtId: '鄉鎮區', categoryId: '分類', subcategoryId: '細分類' };
    const summary = [
      `${mode === 'create' ? '【新增店家】' : `【修改既有店家：${before.name}（/restaurant/${targetSlug}）】`}`,
      `${proposed.name}（${regionName}・${districtName}）`,
      ...(newDistrict ? [`⚠️ 新增鄉鎮區：${regionName}・${newDistrict.name}（${newDistrict.id}）——核准時會一併加入地區設定`] : []),
      ...(photoPaths.length ? [`照片 ${photoPaths.length} 張（請確認為投稿者自行拍攝、無他人肖像）`] : []),
    ];
    if (before) {
      const changed = EDITABLE.filter((k) => (before[k] || '') !== (proposed[k] || ''));
      summary.push('', '修改內容：');
      for (const k of changed) summary.push(`・${labels[k]}：${before[k] || '（空白）'} → ${proposed[k] || '（清空）'}`);
      if (!changed.length) summary.push('・（沒有修改欄位，只新增照片）');
    }

    const submission = {
      status: 'pending',
      mode,
      ...(targetSlug ? { targetSlug } : {}),
      submittedAt: new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 16),
      submitter,
      suggestedTier: suggestedTier ? suggestedTier.name : '',
      note,
      summary: summary.join('\n'),
      name: proposed.name,
      regionId: proposed.regionId,
      districtId: proposed.districtId,
      categoryId: proposed.categoryId,
      subcategoryId: proposed.subcategoryId || '',
      tierId: proposed.tierId || 'unrated',
      address: proposed.address,
      phone: proposed.phone || '',
      openingHours: proposed.openingHours || '',
      priceRange: proposed.priceRange || '',
      description: proposed.description,
      editorNote: proposed.editorNote || '',
      photos: photoPaths,
      // 核准時用來判斷「哪些欄位被投稿者或編輯改過」，只套用有變動的欄位（後台隱藏）
      baseline: before
        ? JSON.stringify(Object.fromEntries([...EDITABLE, 'tierId', 'editorNote'].map((k) => [k, before[k] ?? ''])))
        : '',
      newDistrict: newDistrict ? JSON.stringify({ regionId: region.id, ...newDistrict }) : '',
    };
    tree.push({ path: `submissions/${id}.json`, mode: '100644', type: 'blob', content: JSON.stringify(submission, null, 2) + '\n' });

    // ---------- 直接 commit 到 main（只動 submissions/，不觸發部署）。main 剛好被別人更新時重試 ----------
    const message = `submission: ${mode === 'create' ? '新增' : '修改'}「${proposed.name}」${submitter ? `（投稿者：${submitter}）` : ''}`;
    let parent = baseSha;
    for (let attempt = 1; ; attempt++) {
      const parentCommit = await gh('GET', `/git/commits/${parent}`);
      const newTree = await gh('POST', '/git/trees', { base_tree: parentCommit.tree.sha, tree });
      const commit = await gh('POST', '/git/commits', { message, tree: newTree.sha, parents: [parent] });
      try {
        await gh('PATCH', '/git/refs/heads/main', { sha: commit.sha, force: false });
        break;
      } catch (e) {
        if (attempt >= 4 || e.status !== 422) throw e;
        parent = (await gh('GET', '/git/ref/heads/main')).object.sha;
      }
    }
    return json(200, { ok: true, id });
  } catch (e) {
    console.error('submit failed', e.message, JSON.stringify(e.data || {}));
    return json(502, { error: '送出時發生問題，請稍後再試' });
  }
}

export const onRequestGet = () => json(405, { error: 'Method Not Allowed' });
