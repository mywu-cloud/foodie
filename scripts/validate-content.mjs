/**
 * 餐廳資料交叉驗證（npm run validate，build 前自動執行）
 *
 * Zod schema 只能檢查「欄位型別」，檢查不到這些跨檔案的關係：
 *   - regionId / categoryId / tierId 是否存在於 taxonomy
 *   - districtId 是否屬於該縣市、subcategoryId 是否屬於該分類
 *   - coverImage / gallery 的照片檔案是否真的存在於 public/
 *   - urlId 是否跟檔名一致
 * 有任何錯誤就以 exit code 1 結束 → build 失敗 → 網站維持上一版，不會上線壞資料。
 */
import { readFile, readdir, access } from 'node:fs/promises';

const TAXONOMY = 'src/content/taxonomy';
const RESTAURANTS = 'src/content/restaurants';

const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));
const exists = (p) => access(p).then(() => true, () => false);

const { regions } = await readJson(`${TAXONOMY}/regions.json`);
const { categories } = await readJson(`${TAXONOMY}/categories.json`);
const { tiers } = await readJson(`${TAXONOMY}/tiers.json`);

const errors = [];
const warnings = [];

// taxonomy 本身：id 不可重複
const dupCheck = (label, ids) => {
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) errors.push(`[taxonomy] ${label} id 重複：${id}`);
    seen.add(id);
  }
};
dupCheck('縣市', regions.map((r) => r.id));
regions.forEach((r) => dupCheck(`${r.name} 的鄉鎮區`, r.districts.map((d) => d.id)));
dupCheck('分類', categories.map((c) => c.id));
dupCheck('分級', tiers.map((t) => t.id));

const files = (await readdir(RESTAURANTS)).filter((f) => f.endsWith('.json'));

for (const file of files) {
  const slug = file.replace(/\.json$/, '');
  const where = `[${file}]`;
  let r;
  try {
    r = await readJson(`${RESTAURANTS}/${file}`);
  } catch (e) {
    errors.push(`${where} JSON 格式錯誤：${e.message}`);
    continue;
  }

  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    errors.push(`${where} 檔名（網址代號）只能用英文小寫、數字與 -`);
  }
  if (r.urlId && r.urlId !== slug) {
    warnings.push(`${where} urlId「${r.urlId}」與檔名不同，網址以檔名為準：/restaurant/${slug}`);
  }

  const region = regions.find((x) => x.id === r.regionId);
  if (!region) errors.push(`${where} 找不到縣市 regionId「${r.regionId}」`);
  else if (!region.districts.some((d) => d.id === r.districtId)) {
    errors.push(
      `${where} 鄉鎮區「${r.districtId}」不屬於${region.name}（可用：${region.districts.map((d) => d.id).join(', ')}）`
    );
  }

  const category = categories.find((x) => x.id === r.categoryId);
  if (!category) errors.push(`${where} 找不到分類 categoryId「${r.categoryId}」`);
  else if (r.subcategoryId && !category.subcategories.some((s) => s.id === r.subcategoryId)) {
    errors.push(`${where} 細分類「${r.subcategoryId}」不屬於${category.name}`);
  }

  if (!tiers.some((t) => t.id === r.tierId)) errors.push(`${where} 找不到分級 tierId「${r.tierId}」`);

  if (r.lastReviewedAt && Number.isNaN(Date.parse(r.lastReviewedAt))) {
    errors.push(`${where} lastReviewedAt「${r.lastReviewedAt}」不是有效日期`);
  }

  const photos = [r.coverImage, ...(r.gallery ?? []).map((g) => g?.src)].filter(Boolean);
  for (const src of photos) {
    if (/^https?:\/\//.test(src)) {
      warnings.push(`${where} 照片使用外部網址 ${src}（請確認有授權，建議改為上傳到本站）`);
      continue;
    }
    if (!src.startsWith('/')) {
      errors.push(`${where} 照片路徑要以 / 開頭，例如 /images/restaurants/xxx.webp：${src}`);
      continue;
    }
    if (!(await exists(`public${decodeURI(src)}`))) errors.push(`${where} 照片檔不存在：public${src}`);
  }
}

warnings.forEach((w) => console.warn(`⚠️  ${w}`));
if (errors.length) {
  errors.forEach((e) => console.error(`❌ ${e}`));
  console.error(`\n資料驗證失敗：${errors.length} 個錯誤（共 ${files.length} 家店）`);
  process.exit(1);
}
console.log(`✅ 資料驗證通過：${files.length} 家店${warnings.length ? `，${warnings.length} 個提醒` : ''}`);
