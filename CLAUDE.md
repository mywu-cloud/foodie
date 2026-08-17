# CLAUDE.md — 台灣分區分類分級美食網 架構藍圖

這份文件是給未來的 Claude（或任何開發者）在這個專案上工作時的架構參考，記錄了「為什麼」這樣設計，以及哪些規則是不能違反的。

## 專案目標

一個台灣美食／小吃查詢網站，讓使用者依照三個維度找店：**分區**（縣市 → 鄉鎮市區）、**分類**（料理類型，含二級細分類）、**分級**（編輯人工評定的推薦等級）。差異化重點不是「資料量最大」，而是分級的可信度——分級全部人工編輯，不是自動爬第三方評分算出來的。

## 技術棧

沿用 [flights-276.pages.dev](https://flights-276.pages.dev)（機票追蹤器）與日本旅遊網站專案驗證過的組合：

- **Astro**（`output: 'static'`）— 內容為主的網站，SEO 優先，不需要 SPA
- **Astro Content Collections** — 餐廳資料以 `src/content/restaurants/*.json` 管理，透過 `src/content/config.ts` 的 Zod schema 驗證
- **GitHub Actions** — 排程執行資料同步腳本、產生歷史快照、觸發部署
- **Cloudflare Pages** — 靜態網站託管
- **Cloudflare Workers** — 提供 `/search` 篩選 API（跨 region × category × tier 查詢），未來可擴充編輯後台的寫入端點

## 三個強制修正事項（來自先前專案的教訓）

這三點在機票追蹤器與日本旅遊網站專案都踩過雷，這個專案從一開始就要避免：

1. **資料快照不可覆蓋**：`scripts/fetch-data.mjs` 每次執行都要寫入一份帶時間戳的新檔案到 `data-snapshots/`，不可覆蓋前一份。歷史資料遺失了就回不來。
2. **通知要去重**：資料異動需要人工複核時（例如偵測到營業時間改變），發通知前要檢查是否已經通知過同一筆異動，避免洗版。
3. **Worker 寫入端點必須驗證**：`workers/api.js` 中任何非 GET 的請求都要檢查 `Authorization` header 是否帶有正確的 `API_WRITE_TOKEN`（見 `wrangler.toml` 註解）。GET `/search` 維持公開、不需驗證。

## 資料模型

三個 taxonomy 檔案放在 `src/content/taxonomy/`，是整個網站的路由與篩選依據：

| 檔案 | 內容 | 關鍵欄位 |
|---|---|---|
| `regions.json` | 縣市 → 鄉鎮市區 | `id`, `name`, `popular`（是否顯示於首頁快速入口）, `districts[]` |
| `categories.json` | 一級分類 + 可選二級細分類 | `id`, `name`, `showOnHome`（首頁直接顯示 or 收進「更多分類」）, `subcategories[]` |
| `tiers.json` | 分級定義 | `id`, `name`, `order`, `colorToken`（對應 CDS 語意色票） |

餐廳資料（`src/content/restaurants/*.json`）透過 `regionId` / `districtId` / `categoryId` / `subcategoryId` / `tierId` 參照上述 taxonomy，schema 定義在 `src/content/config.ts`。

**重要**：`tierId` 一律由編輯手動指派（見下方「分級編輯流程」），任何自動化腳本都不應該寫入或覆蓋這個欄位。

## 分級編輯流程

分級資料庫是**人工編輯／自建**，不是從 Google 評分或其他第三方平台自動推算，原因：

- Google Places API 等第三方資料的使用條款通常限制長期快取、大量重製其評分／評論內容，直接拿來當自己資料庫的核心資產有授權風險（這點跟日本旅遊網站專案處理 Booking.com 資料的邏輯一致——只做即時查詢或導流連結，不做長期落地儲存）
- 分級的可信度是這個網站的差異化賣點，自動化評分容易失真（例如新開幕店家灌評論）

實際流程：編輯實地或透過可信管道確認店家資訊 → 在對應的 `src/content/restaurants/*.json` 填寫 `tierId` 與 `editorNote`（記錄評定理由，供內部追蹤）→ 更新 `lastReviewedAt` → 提交 PR 或直接 commit 到 main，觸發 GitHub Actions 部署。

`scripts/fetch-data.mjs` 只負責同步客觀、可公開重製的欄位（電話、營業時間、地址是否變動），異動會寫進帶時間戳的快照，需要人工複核才會更新到 content collection。

## 頁面路由結構

```
/                           首頁：搜尋列 + 熱門地區 + 分類（含更多分類收合）+ 本週精選
/region/[region]            地區列表頁
/category/[category]        分類列表頁（含二級細分類連結）
/restaurant/[slug]          餐廳詳情頁
```

搜尋/篩選以查詢字串組合（如 `/search?region=kaohsiung&category=snacks&tier=must-eat`），由 Worker 的 `/search` 端點處理跨維度查詢。

## 目錄結構

```
src/
  content/
    config.ts              Zod schema 定義
    taxonomy/               分區/分類/分級三份定義檔
    restaurants/            每筆餐廳一個 JSON 檔
  layouts/BaseLayout.astro
  components/               TierBadge / RestaurantCard / CategoryCard 等
  pages/                    對應上方路由結構
  lib/taxonomy.ts           taxonomy 讀取與查詢的共用函式
workers/api.js              Cloudflare Worker：搜尋 API + 受保護的寫入端點
scripts/fetch-data.mjs      GitHub Actions 排程執行的資料同步腳本
.github/workflows/          排程同步 + 部署
```

## 尚待決定事項

- 收錄範圍：全台同步收錄，或先集中南部（高雄起步）再擴張
- 分級複核週期：`lastReviewedAt` 多久沒更新要視為過舊、需要重新複核
- 編輯後台：目前寫入靠直接編輯 JSON + git commit，資料量變大後可能需要一個簡易後台介面（Worker 的寫入端點已預留）
