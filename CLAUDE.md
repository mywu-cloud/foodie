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

分級資料庫是**人工編輯／自建**：Google 地圖的評分與評論可以先拿來**參考**，但分級由編輯判斷後指派，不由評分自動換算，原因：

- Google 評分反映的是大眾平均意見，本站分級是編輯的評定；兩者可以互相參照，但不能直接畫上等號
- 分級的可信度是這個網站的差異化賣點，自動化評分容易失真（例如新開幕店家灌評論）

實際流程：編輯先參考 Google 地圖的評分、評論數與評論內容，再實地或透過可信管道確認店家資訊 → 在對應的 `src/content/restaurants/*.json` 填寫 `tierId` 與 `editorNote`（記錄評定理由，供內部追蹤）→ 更新 `lastReviewedAt` → 提交 PR 或直接 commit 到 main，觸發 GitHub Actions 部署。

`scripts/fetch-data.mjs` 只負責同步客觀、可公開重製的欄位（電話、營業時間、地址是否變動），異動會寫進帶時間戳的快照，需要人工複核才會更新到 content collection。

## 店家基本資料查證：以 Google 地圖為準

店家的**客觀基本資料**一律參考 Google 地圖查證；與現有資料不一致時，**以 Google 地圖為準**修正或補充：

| 欄位 | 做法 |
|---|---|
| 店名 | 以 Google 地圖上的正式店名為準（例如錯字、全名） |
| 地址、鄉鎮區 | 以 Google 地圖地址為準；地址所在鄉鎮區與資料不同時一併修正（鄉鎮區不存在就新增到 `regions.json`） |
| 營業時間、公休日 | 以 Google 的**常態**營業時間為準（`usual_weekday_hours`），不要用臨時店休或特殊節日時間 |
| 電話 | Google 有、資料沒有就補上 |

規則：

- **先確認是同一家店再改**：店名相符且地址在同一縣市／鄉鎮才修正。只找到同名不同地址的分店、名稱不同的店、或找不到時，**不要修改**，列出來請編輯確認
- 新匯入或新增的店家，建議都先跑一次 Google 地圖比對
- 修正結果開 PR，PR 說明列出「有修改」與「無法確認」兩份清單，給編輯審查後合併
- **評分與評論可以參考**：查證時可一併查看 Google 評分、評論數與評論內容，作為編輯評定分級的參考；需要留紀錄時寫在 `editorNote`，並註明查詢日期，例如「Google 4.3（約 1.2 萬則，2026-11-23 查詢）；評論多提到湯頭清甜、假日排隊久」
- **分級仍由編輯決定**：`tierId` 不可由 Google 評分自動換算或由腳本寫入（見上方「分級編輯流程」）；Google 評分不顯示在前台
- 評論**原文**與他人拍攝的照片有著作權，不複製到網站；`editorNote` 用自己的話摘要重點即可

## 頁面路由結構

```
/                           首頁：搜尋列 + 熱門地區 + 分類（含更多分類收合）+ 本週精選
/region/[region]            地區列表頁
/category                   分類瀏覽：全部分類與細分類＋店家數
/category/[category]        分類列表頁（含二級細分類切換）
/category/[category]/[sub]  細分類列表頁（例如 /category/coffee/specialty-coffee）
/restaurant/[slug]          餐廳詳情頁
/search                     搜尋頁（關鍵字 + 縣市／鄉鎮區／分類／分級篩選）
```

搜尋/篩選以查詢字串組合（如 `/search?q=牛肉湯&region=kaohsiung&category=snacks&tier=must-eat`）。目前由靜態頁 `src/pages/search.astro` 在前端篩選（build 時輸出全部店家卡片），不需要 Worker；店家數量大到頁面過重時，再改由 Worker 的 `/search` 端點處理。首頁搜尋框送出的 `district=縣市:鄉鎮區`、`category=分類[:細分類]` 可帶多個值。

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
  lib/restaurants.ts        店家列表共用排序（分級 → 有封面照 → 最近複核日期）
public/admin/               編輯後台（Sveltia CMS），config.yml 由 scripts/build-cms-config.mjs 產生，勿手改
public/images/restaurants/  照片（後台上傳自動轉 WebP 1600px）
workers/api.js              Cloudflare Worker：搜尋 API + 受保護的寫入端點
scripts/fetch-data.mjs      GitHub Actions 排程執行的資料同步腳本
scripts/build-cms-config.mjs  taxonomy → 後台下拉選單
scripts/validate-content.mjs  跨檔案驗證（id 對應、照片存在），build 前執行，失敗即不部署
scripts/import-csv.mjs      CSV 批次匯入（全部通過才寫檔；既有檔預設跳過）
scripts/import_spreadsheet.py  Numbers／CSV 匯入（Python；自動新增鄉鎮區、依 data-import/category-rules.json 判斷分類；同縣市同店名跳過；tierId 一律 unrated）
data-import/inbox/          自助上傳區：上傳後 .github/workflows/import-spreadsheet.yml 自動匯入、驗證、觸發部署
.github/workflows/          排程同步 + 部署
```

## 尚待決定事項

- 收錄範圍：全台同步收錄，或先集中南部（高雄起步）再擴張
- 分級複核週期：`lastReviewedAt` 多久沒更新要視為過舊、需要重新複核
## 編輯後台（已決定）

採用 Git-based CMS（Sveltia CMS，`/admin`），不自建資料庫後台：存檔 = commit JSON 與照片到 main → Actions 部署。理由：維持「JSON + 靜態 build」的資料層不變、零伺服器成本、權限交給 GitHub repo 寫入權限。批次建檔用 `scripts/import-csv.mjs`。操作說明見 `docs/ADMIN.md`。

- 新增 taxonomy 欄位或餐廳欄位時，要同步更新 `src/content/config.ts`、`scripts/build-cms-config.mjs`、`scripts/import-csv.mjs`
- 選填欄位在 schema 用 `optional()` helper（把 `""`／`null` 視為未填），因為 CMS 可能存出空值
- Worker 的寫入端點保留給未來前台投稿／多人協作，目前不使用
