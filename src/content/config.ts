import { defineCollection, z } from 'astro:content';

// 後台（/admin）或 CSV 匯入時，沒填的選填欄位可能存成 "" 或 null。
// 統一視為「沒有填」，避免 Zod 驗證失敗導致整個網站 build 不過。
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' || v === null ? undefined : v), schema.optional());

// 照片：路徑一律是 /images/restaurants/xxx.webp（實體檔放在 public/images/restaurants/）
const photo = z.object({
  src: z.string(),
  caption: optional(z.string()), // 例如「招牌虱目魚肚粥」
});

// 餐廳/小吃資料集合。每一筆都是一個編輯過的條目，分級 (tierId) 一律人工指派。
const restaurants = defineCollection({
  type: 'data',
  schema: z.object({
    urlId: optional(z.string()),  // 網址代號，應與檔名相同（後台用來決定新檔案的檔名）
    name: z.string(),
    regionId: z.string(),        // 對應 taxonomy/regions.json 的 region id
    districtId: z.string(),      // 對應該 region 底下的 district id
    categoryId: z.string(),      // 對應 taxonomy/categories.json 的一級分類 id
    subcategoryId: optional(z.string()), // 對應該分類底下的二級細分類 id（可選）
    tierId: z.string(),          // 對應 taxonomy/tiers.json，人工編輯指派
    address: z.string(),
    phone: optional(z.string()),
    openingHours: optional(z.string()),
    priceRange: optional(z.enum(['$', '$$', '$$$', '$$$$'])),
    tags: z.preprocess((v) => (v == null ? [] : v), z.array(z.string())).default([]), // 例如「素食友善」「可訂位」
    description: z.string(),
    coverImage: optional(z.string()),    // 封面照（列表卡片、詳情頁主圖）
    // 美食照片相簿。後台一次上傳多張時存成字串陣列 ["/images/..", ..]；
    // 舊格式 / CSV 匯入是 [{ src, caption }]；單張時可能存成字串。三種都接受，統一轉成 { src, caption }。
    gallery: z
      .preprocess((v) => {
        if (v == null || v === '') return [];
        const list = Array.isArray(v) ? v : [v];
        return list.filter(Boolean).map((p) => (typeof p === 'string' ? { src: p } : p));
      }, z.array(photo))
      .default([]),
    lat: optional(z.number()),
    lng: optional(z.number()),
    editorNote: optional(z.string()),   // 編輯給分級的理由，供內部追蹤（不顯示在前台）
    lastReviewedAt: z.string(),          // ISO date，人工複核日期，用於判斷資料是否過舊
  }),
});

export const collections = { restaurants };
