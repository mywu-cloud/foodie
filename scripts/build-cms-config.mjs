/**
 * 產生 /admin 後台（Sveltia CMS）的設定檔 public/admin/config.yml
 *
 * 為什麼要「產生」而不是手寫：地區 / 鄉鎮區 / 分類 / 細分類 / 分級的下拉選單
 * 必須跟 src/content/taxonomy/*.json 完全一致。每次 build 前重新產生，
 * 在後台新增一個鄉鎮區並存檔 → 觸發部署 → 下拉選單就自動多一個選項。
 *
 * 輸出格式是 JSON（JSON 本身就是合法的 YAML），省去 YAML 套件依賴。
 *
 * 環境變數（選填）：
 *   CMS_AUTH_URL  OAuth 登入用的 Cloudflare Worker 網址（sveltia-cms-auth）。
 *                 沒設定時後台只能用「GitHub Personal Access Token」登入。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const TAXONOMY = 'src/content/taxonomy';
const OUT = 'public/admin/config.yml';

const readJson = async (f) => JSON.parse(await readFile(`${TAXONOMY}/${f}`, 'utf8'));

const { regions } = await readJson('regions.json');
const { categories } = await readJson('categories.json');
const { tiers } = await readJson('tiers.json');

// 鄉鎮區、細分類 id 必須全站唯一（Sveltia 的 select 不允許重複值，重複會讓整個後台打不開），
// 由 scripts/validate-content.mjs 在 build 時檢查。label 帶上縣市名稱方便辨識；
// 選錯縣市/鄉鎮區組合也會在 build 時被擋下來。
const districtOptions = regions.flatMap((r) =>
  r.districts.map((d) => ({ label: `${r.name}・${d.name}（${d.id}）`, value: d.id }))
);
const subcategoryOptions = categories.flatMap((c) =>
  c.subcategories.map((s) => ({ label: `${c.name}・${s.name}`, value: s.id }))
);

const restaurantFields = [
  {
    name: 'urlId',
    label: '網址代號',
    widget: 'string',
    hint: '只能用英文小寫、數字與 -，例如 ah-ming-congee。會變成網址 /restaurant/ah-ming-congee，建立後不要再改。',
    pattern: ['^[a-z0-9]+(-[a-z0-9]+)*$', '只能用英文小寫、數字與 -'],
  },
  { name: 'name', label: '店名', widget: 'string' },
  {
    name: 'regionId',
    label: '縣市',
    widget: 'select',
    options: regions.map((r) => ({ label: r.name, value: r.id })),
  },
  {
    name: 'districtId',
    label: '鄉鎮市區',
    widget: 'select',
    options: districtOptions,
    hint: '請選擇與上方縣市相符的區域。沒有的話先到「分類設定 → 地區」新增。',
  },
  {
    name: 'categoryId',
    label: '分類',
    widget: 'select',
    options: categories.map((c) => ({ label: c.name, value: c.id })),
  },
  {
    name: 'subcategoryId',
    label: '細分類',
    widget: 'select',
    required: false,
    options: subcategoryOptions,
    hint: '選填，需與上方分類相符',
  },
  {
    name: 'tierId',
    label: '分級（人工評定）',
    widget: 'select',
    options: [...tiers].sort((a, b) => a.order - b.order).map((t) => ({ label: t.name, value: t.id })),
    default: 'unrated',
  },
  {
    name: 'coverImage',
    label: '封面照',
    widget: 'image',
    required: false,
    hint: '列表卡片與詳情頁主圖。上傳時自動轉成 WebP 並縮到 1600px 寬。請只用自己拍攝或店家授權的照片。',
  },
  {
    name: 'gallery',
    label: '美食照片',
    widget: 'list',
    required: false,
    summary: '{{fields.caption}}',
    fields: [
      { name: 'src', label: '照片', widget: 'image' },
      { name: 'caption', label: '說明（例如：招牌虱目魚肚粥）', widget: 'string', required: false },
    ],
  },
  { name: 'description', label: '店家介紹（前台顯示）', widget: 'text' },
  { name: 'address', label: '地址', widget: 'string' },
  { name: 'phone', label: '電話', widget: 'string', required: false },
  { name: 'openingHours', label: '營業時間', widget: 'string', required: false, hint: '例如 06:00-13:00（週一公休）' },
  {
    name: 'priceRange',
    label: '價位',
    widget: 'select',
    required: false,
    options: [
      { label: '$（150 以下）', value: '$' },
      { label: '$$（150–400）', value: '$$' },
      { label: '$$$（400–1000）', value: '$$$' },
      { label: '$$$$（1000 以上）', value: '$$$$' },
    ],
  },
  {
    name: 'tags',
    label: '標籤',
    widget: 'list',
    required: false,
    hint: '用逗號分隔，例如：在地排隊名店, 只收現金',
  },
  { name: 'lat', label: '緯度', widget: 'number', value_type: 'float', required: false },
  { name: 'lng', label: '經度', widget: 'number', value_type: 'float', required: false },
  { name: 'editorNote', label: '分級理由（內部備註，不顯示於前台）', widget: 'text', required: false },
  {
    name: 'lastReviewedAt',
    label: '最後複核日期',
    widget: 'datetime',
    format: 'YYYY-MM-DD',
    date_format: 'YYYY-MM-DD',
    time_format: false,
  },
];

const schemaNote = { name: '$schema', widget: 'hidden' };

const config = {
  backend: {
    name: 'github',
    repo: 'mywu-cloud/foodie',
    branch: 'main',
    ...(process.env.CMS_AUTH_URL ? { base_url: process.env.CMS_AUTH_URL } : {}),
    commit_messages: {
      create: 'content: 新增 {{collection}}「{{slug}}」',
      update: 'content: 更新 {{collection}}「{{slug}}」',
      delete: 'content: 刪除 {{collection}}「{{slug}}」',
      uploadMedia: 'media: 上傳 {{path}}',
      deleteMedia: 'media: 刪除 {{path}}',
    },
  },
  site_url: 'https://twfood.pages.dev',
  display_url: 'https://twfood.pages.dev',
  locale: 'zh_Hant',
  media_folder: 'public/images/restaurants',
  public_folder: '/images/restaurants',
  media_libraries: {
    default: {
      config: {
        slugify_filename: true,
        transformations: {
          raster_image: { format: 'webp', quality: 82, width: 1600, height: 1600 },
        },
      },
    },
  },
  collections: [
    {
      name: 'restaurants',
      label: '餐廳',
      label_singular: '餐廳',
      folder: 'src/content/restaurants',
      extension: 'json',
      format: 'json',
      create: true,
      delete: true,
      identifier_field: 'name',
      slug: '{{fields.urlId}}',
      summary: '{{name}}｜{{regionId}}・{{categoryId}}｜{{tierId}}',
      sortable_fields: ['name', 'lastReviewedAt', 'regionId', 'tierId'],
      preview_path: '/restaurant/{{slug}}',
      fields: restaurantFields,
    },
    {
      name: 'taxonomy',
      label: '分類設定',
      delete: false,
      files: [
        {
          name: 'regions',
          label: '地區（縣市 → 鄉鎮市區）',
          file: `${TAXONOMY}/regions.json`,
          format: 'json',
          fields: [
            schemaNote,
            {
              name: 'regions',
              label: '縣市',
              widget: 'list',
              summary: '{{fields.name}}（{{fields.id}}）',
              fields: [
                { name: 'id', label: '代號（英文，建立後不要改）', widget: 'string' },
                { name: 'name', label: '名稱', widget: 'string' },
                { name: 'popular', label: '顯示在首頁熱門地區', widget: 'boolean', default: false },
                {
                  name: 'districts',
                  label: '鄉鎮市區',
                  widget: 'list',
                  summary: '{{fields.name}}（{{fields.id}}）',
                  fields: [
                    {
                      name: 'id',
                      label: '代號（英文，建立後不要改）',
                      widget: 'string',
                      hint: '全站不可重複，建議加縣市前綴，例如 chiayi-east、kaohsiung-sanmin',
                      pattern: ['^[a-z0-9]+(-[a-z0-9]+)*$', '只能用英文小寫、數字與 -'],
                    },
                    { name: 'name', label: '名稱', widget: 'string' },
                  ],
                },
              ],
            },
          ],
        },
        {
          name: 'categories',
          label: '料理分類',
          file: `${TAXONOMY}/categories.json`,
          format: 'json',
          fields: [
            schemaNote,
            {
              name: 'categories',
              label: '分類',
              widget: 'list',
              summary: '{{fields.name}}（{{fields.id}}）',
              fields: [
                { name: 'id', label: '代號（英文，建立後不要改）', widget: 'string' },
                { name: 'name', label: '名稱', widget: 'string' },
                { name: 'showOnHome', label: '首頁直接顯示', widget: 'boolean', default: false },
                {
                  name: 'subcategories',
                  label: '細分類',
                  widget: 'list',
                  required: false,
                  summary: '{{fields.name}}（{{fields.id}}）',
                  fields: [
                    { name: 'id', label: '代號（英文，全站不可重複）', widget: 'string' },
                    { name: 'name', label: '名稱', widget: 'string' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

await mkdir('public/admin', { recursive: true });
await writeFile(
  OUT,
  `# 自動產生的檔案，請勿手動修改 —— 來源：scripts/build-cms-config.mjs + src/content/taxonomy/*.json\n` +
    JSON.stringify(config, null, 2) +
    '\n'
);
console.log(`CMS config written: ${OUT}（${regions.length} 縣市、${districtOptions.length} 鄉鎮區、${categories.length} 分類）`);

// ---------------------------------------------------------------------------
// /contribute：一般使用者投稿入口（Decap CMS + Open Authoring）
//
// Sveltia CMS 不支援 editorial workflow / open authoring，所以投稿入口改用 Decap CMS：
// 使用者用自己的 GitHub 帳號登入 → 修改存到他自己 fork 的分支 → 自動開 PR 到本 repo →
// admin 在 GitHub 審查後合併才上線。投稿者沒有 repo 寫入權限，所以不可能直接刪除或改到 main。
//
// 差異（相對 /admin）：
//   - 只開放「餐廳」，不開放分類設定；不能刪除
//   - 分級欄位是「建議分級」，最終由 admin 審查時決定
//   - editorNote（內部分級理由）隱藏，保留原值
//   - Decap 沒有上傳時壓縮照片；改由 scripts/optimize-images.mjs 在部署時壓縮 dist 內的照片
//   - Open Authoring 必須用 GitHub OAuth 登入，沒設定 CMS_AUTH_URL 時頁面會顯示「尚未開放」
// ---------------------------------------------------------------------------
const CONTRIB_OUT = 'public/contribute/config.yml';

const contributeFields = restaurantFields.map((f) => {
  switch (f.name) {
    case 'tierId':
      return {
        ...f,
        label: '建議分級（僅供參考，由編輯審查後決定）',
        hint: '依你的實際體驗建議；最終分級由台灣美食通編輯評定。',
      };
    case 'editorNote':
      return { name: 'editorNote', label: '編輯備註', widget: 'hidden', required: false };
    case 'coverImage':
      return {
        ...f,
        hint: '請只上傳自己拍攝的照片（不要從 Google 地圖、部落格或社群下載）。手機原圖即可，網站會自動壓縮。',
      };
    case 'lastReviewedAt':
      return { ...f, label: '造訪日期', hint: '你最近一次造訪這家店的日期' };
    default:
      return f;
  }
});

const contributeConfig = {
  backend: {
    name: 'github',
    repo: 'mywu-cloud/foodie',
    branch: 'main',
    open_authoring: true,
    ...(process.env.CMS_AUTH_URL ? { base_url: process.env.CMS_AUTH_URL } : {}),
    commit_messages: {
      create: 'content(投稿): 新增「{{slug}}」',
      update: 'content(投稿): 更新「{{slug}}」',
      delete: 'content(投稿): 刪除「{{slug}}」',
      uploadMedia: 'media(投稿): 上傳 {{path}}',
      deleteMedia: 'media(投稿): 刪除 {{path}}',
      openAuthoring: '{{message}}（投稿者：{{author-login}}）',
    },
  },
  publish_mode: 'editorial_workflow',
  site_url: 'https://twfood.pages.dev',
  display_url: 'https://twfood.pages.dev',
  locale: 'zh_Hant',
  media_folder: 'public/images/restaurants',
  public_folder: '/images/restaurants',
  collections: [
    {
      name: 'restaurants',
      label: '餐廳',
      label_singular: '餐廳',
      folder: 'src/content/restaurants',
      extension: 'json',
      format: 'json',
      create: true,
      delete: false,
      identifier_field: 'name',
      slug: '{{fields.urlId}}',
      summary: '{{name}}',
      sortable_fields: ['name'],
      preview_path: '/restaurant/{{slug}}',
      fields: contributeFields,
    },
  ],
};

await mkdir('public/contribute', { recursive: true });
await writeFile(
  CONTRIB_OUT,
  `# 自動產生的檔案，請勿手動修改 —— 來源：scripts/build-cms-config.mjs\n` +
    JSON.stringify(contributeConfig, null, 2) +
    '\n'
);
console.log(`CMS config written: ${CONTRIB_OUT}（投稿入口，${process.env.CMS_AUTH_URL ? '已設定 OAuth' : '尚未設定 OAuth → 頁面顯示尚未開放'}）`);
