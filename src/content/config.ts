import { defineCollection, z } from 'astro:content';

// 餐廳/小吃資料集合。每一筆都是一個編輯過的條目，分級 (tierId) 一律人工指派。
const restaurants = defineCollection({
  type: 'data',
  schema: z.object({
    name: z.string(),
    regionId: z.string(),        // 對應 taxonomy/regions.json 的 region id
    districtId: z.string(),      // 對應該 region 底下的 district id
    categoryId: z.string(),      // 對應 taxonomy/categories.json 的一級分類 id
    subcategoryId: z.string().optional(), // 對應該分類底下的二級細分類 id（可選）
    tierId: z.string(),          // 對應 taxonomy/tiers.json，人工編輯指派
    address: z.string(),
    phone: z.string().optional(),
    openingHours: z.string().optional(),
    priceRange: z.enum(['$', '$$', '$$$', '$$$$']).optional(),
    tags: z.array(z.string()).default([]), // 例如「素食友善」「可訂位」「寵物友善」
    description: z.string(),
    coverImage: z.string().optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
    editorNote: z.string().optional(),   // 編輯給分級的理由，供內部追蹤
    lastReviewedAt: z.string(),          // ISO date，人工複核日期，用於判斷資料是否過舊
  }),
});

export const collections = { restaurants };
