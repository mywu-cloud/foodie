/**
 * 批次匯入餐廳資料：CSV → src/content/restaurants/*.json
 *
 * 用法：
 *   npm run import -- data-import/my-list.csv              # 只新增，已存在的店會跳過
 *   npm run import -- data-import/my-list.csv --dry-run    # 只檢查、不寫檔
 *   npm run import -- data-import/my-list.csv --overwrite  # 已存在的店：用 CSV 有填的欄位覆蓋，空白欄位保留原值
 *
 * 範本：data-import/restaurants-template.csv（Excel / Google 試算表開啟、另存 CSV 即可）
 *
 * 規則：
 *   - 縣市 / 鄉鎮區 / 分類 / 細分類 / 分級 可以填中文名稱（高雄、鹽埕區、台式、必吃首選）或代號（kaohsiung…）
 *   - 全部列都檢查通過才會寫檔；任何一列有錯就整批不寫，避免匯入一半
 *   - 分級沒填 → unrated（待評鑑）；複核日期沒填 → 今天
 *   - 標籤用 、 , ｜ 分隔；美食照片填檔名、用 ｜ 分隔（檔案先放到 public/images/restaurants/）
 *   - 支援 UTF-8（含 Excel 的 BOM）與 Big5 編碼
 */
import { readFile, writeFile, access } from 'node:fs/promises';

const TAXONOMY = 'src/content/taxonomy';
const RESTAURANTS = 'src/content/restaurants';
const IMG_PREFIX = '/images/restaurants/';

const args = process.argv.slice(2);
const csvPath = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
const overwrite = args.includes('--overwrite');
if (!csvPath) {
  console.error('用法：npm run import -- <檔案.csv> [--dry-run] [--overwrite]');
  process.exit(1);
}

// ---------- 讀檔 + 編碼偵測 ----------
const buf = await readFile(csvPath);
let text = new TextDecoder('utf-8').decode(buf);
if (text.includes('�')) text = new TextDecoder('big5').decode(buf); // Excel 預設存檔可能是 Big5
text = text.replace(/^﻿/, '');

// ---------- 最小 CSV 解析（支援引號、引號內換行與逗號、"" 跳脫） ----------
function parseCsv(src) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

// ---------- 欄位名稱（中英文都可以） ----------
const HEADER_ALIASES = {
  urlId: ['urlId', 'slug', '網址代號'],
  name: ['name', '店名'],
  region: ['regionId', 'region', '縣市'],
  district: ['districtId', 'district', '鄉鎮區', '鄉鎮市區', '行政區'],
  category: ['categoryId', 'category', '分類'],
  subcategory: ['subcategoryId', 'subcategory', '細分類'],
  tier: ['tierId', 'tier', '分級'],
  address: ['address', '地址'],
  phone: ['phone', '電話'],
  openingHours: ['openingHours', '營業時間'],
  priceRange: ['priceRange', '價位'],
  tags: ['tags', '標籤'],
  description: ['description', '介紹', '店家介紹'],
  coverImage: ['coverImage', '封面照'],
  gallery: ['gallery', '美食照片', '照片'],
  lat: ['lat', '緯度'],
  lng: ['lng', '經度'],
  editorNote: ['editorNote', '分級理由', '編輯備註'],
  lastReviewedAt: ['lastReviewedAt', '複核日期', '最後複核日期'],
};
const REQUIRED = ['urlId', 'name', 'region', 'district', 'category', 'address', 'description'];

const [header, ...dataRows] = parseCsv(text);
const colIndex = {};
header.forEach((h, i) => {
  const key = Object.entries(HEADER_ALIASES).find(([, names]) => names.includes(h.trim()))?.[0];
  if (key) colIndex[key] = i;
  else if (h.trim()) console.warn(`⚠️  不認得的欄位「${h}」，將忽略`);
});
const missingCols = REQUIRED.filter((k) => !(k in colIndex));
if (missingCols.length) {
  console.error(`❌ CSV 缺少必要欄位：${missingCols.map((k) => HEADER_ALIASES[k].at(-1)).join('、')}`);
  process.exit(1);
}

// ---------- taxonomy 對照 ----------
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));
const { regions } = await readJson(`${TAXONOMY}/regions.json`);
const { categories } = await readJson(`${TAXONOMY}/categories.json`);
const { tiers } = await readJson(`${TAXONOMY}/tiers.json`);

const norm = (s) => s.trim().replace(/臺/g, '台').replace(/[市縣區鄉鎮]$/, '');
const findBy = (list, v) => list.find((x) => x.id === v.trim()) ?? list.find((x) => norm(x.name) === norm(v));
const exists = (p) => access(p).then(() => true, () => false);
const imgPath = (v) => (/^(https?:)?\//.test(v) ? v : IMG_PREFIX + v);
const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // 台灣時間

// ---------- 逐列轉換 + 檢查 ----------
const errors = [];
const results = [];
const seenSlugs = new Set();

for (const [i, row] of dataRows.entries()) {
  const line = i + 2; // 第 1 列是標題
  const get = (k) => (k in colIndex ? (row[colIndex[k]] ?? '').trim() : '');
  const err = (m) => errors.push(`第 ${line} 列（${get('name') || '未命名'}）：${m}`);

  for (const k of REQUIRED) if (!get(k)) err(`「${HEADER_ALIASES[k].at(-1)}」不可空白`);

  const urlId = get('urlId').toLowerCase();
  if (urlId && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(urlId)) err(`網址代號「${urlId}」只能用英文小寫、數字與 -`);
  if (seenSlugs.has(urlId)) err(`網址代號「${urlId}」在 CSV 中重複`);
  seenSlugs.add(urlId);

  const region = get('region') && findBy(regions, get('region'));
  if (get('region') && !region) err(`找不到縣市「${get('region')}」`);
  const district = region && get('district') && findBy(region.districts, get('district'));
  if (region && get('district') && !district) {
    err(`${region.name}沒有「${get('district')}」，請先在後台「分類設定 → 地區」新增`);
  }

  const category = get('category') && findBy(categories, get('category'));
  if (get('category') && !category) err(`找不到分類「${get('category')}」`);
  const sub = category && get('subcategory') && findBy(category.subcategories, get('subcategory'));
  if (category && get('subcategory') && !sub) err(`${category.name}沒有細分類「${get('subcategory')}」`);

  const tier = get('tier') ? findBy(tiers, get('tier')) : tiers.find((t) => t.id === 'unrated');
  if (!tier) err(`找不到分級「${get('tier')}」（可用：${tiers.map((t) => t.name).join('、')}）`);

  const priceRange = get('priceRange');
  if (priceRange && !['$', '$$', '$$$', '$$$$'].includes(priceRange)) err(`價位只能填 $、$$、$$$、$$$$`);

  const num = (k) => {
    const v = get(k);
    if (!v) return undefined;
    const n = Number(v);
    if (Number.isNaN(n)) err(`${HEADER_ALIASES[k].at(-1)}「${v}」不是數字`);
    return n;
  };
  const lat = num('lat');
  const lng = num('lng');

  const reviewed = get('lastReviewedAt').replace(/\//g, '-');
  if (reviewed && Number.isNaN(Date.parse(reviewed))) err(`複核日期「${get('lastReviewedAt')}」格式錯誤，請用 2026-11-23`);

  const coverImage = get('coverImage') ? imgPath(get('coverImage')) : undefined;
  const gallery = get('gallery')
    ? get('gallery').split(/[|｜\n]/).map((s) => s.trim()).filter(Boolean).map((s) => ({ src: imgPath(s) }))
    : undefined;
  for (const src of [coverImage, ...(gallery ?? []).map((g) => g.src)].filter(Boolean)) {
    if (src.startsWith('/') && !(await exists(`public${src}`))) err(`照片檔不存在：public${src}`);
  }

  const record = {
    urlId,
    name: get('name'),
    regionId: region?.id,
    districtId: district?.id,
    categoryId: category?.id,
    subcategoryId: sub?.id,
    tierId: get('tier') ? tier?.id : undefined, // 沒填就不覆蓋既有分級；新店另外補 unrated
    address: get('address'),
    phone: get('phone') || undefined,
    openingHours: get('openingHours') || undefined,
    priceRange: priceRange || undefined,
    tags: get('tags') ? get('tags').split(/[、,，|｜]/).map((s) => s.trim()).filter(Boolean) : undefined,
    description: get('description'),
    coverImage,
    gallery,
    lat,
    lng,
    editorNote: get('editorNote') || undefined,
    lastReviewedAt: reviewed || undefined,
  };
  results.push({ line, urlId, record });
}

if (errors.length) {
  errors.forEach((e) => console.error(`❌ ${e}`));
  console.error(`\n匯入中止：${errors.length} 個錯誤，沒有寫入任何檔案。修正 CSV 後再執行一次。`);
  process.exit(1);
}

// ---------- 寫檔 ----------
const FIELD_ORDER = [
  'urlId', 'name', 'regionId', 'districtId', 'categoryId', 'subcategoryId', 'tierId', 'address', 'phone',
  'openingHours', 'priceRange', 'tags', 'description', 'coverImage', 'gallery', 'lat', 'lng', 'editorNote',
  'lastReviewedAt',
];
const ordered = (o) => {
  const out = {};
  for (const k of FIELD_ORDER) if (o[k] !== undefined) out[k] = o[k];
  for (const k of Object.keys(o)) if (!(k in out) && o[k] !== undefined) out[k] = o[k]; // 保留未知欄位
  return out;
};
const strip = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

let created = 0, updated = 0, skipped = 0;
for (const { urlId, record } of results) {
  const path = `${RESTAURANTS}/${urlId}.json`;
  const isExisting = await exists(path);
  let out;
  if (isExisting) {
    if (!overwrite) {
      console.log(`⏭  已存在，跳過：${urlId}（要更新請加 --overwrite）`);
      skipped++;
      continue;
    }
    out = ordered({ ...(await readJson(path)), ...strip(record) }); // CSV 空白欄位 → 保留原值
    updated++;
  } else {
    out = ordered({ tierId: 'unrated', lastReviewedAt: today, ...strip(record) });
    created++;
  }
  if (!dryRun) await writeFile(path, JSON.stringify(out, null, 2) + '\n');
  console.log(`${isExisting ? '✏️  更新' : '✅ 新增'}：${path}`);
}

console.log(
  `\n${dryRun ? '（試跑，未寫檔）' : ''}完成：新增 ${created}、更新 ${updated}、跳過 ${skipped}。` +
    (dryRun ? '' : '\n下一步：npm run validate && git add src/content/restaurants public/images && git commit && git push')
);
