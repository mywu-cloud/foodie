# 台灣美食通

台灣分區（縣市 → 鄉鎮市區）、分類（料理類型，含細分類）、分級（人工編輯評定）的美食／小吃查詢網站。

分級資料全部由編輯人工建檔與複核，不是自動爬取或計算第三方評分——詳見 [`CLAUDE.md`](./CLAUDE.md) 的架構說明。

## 技術棧

Astro（靜態輸出）+ Astro Content Collections（資料層）+ GitHub Actions（排程同步）+ Cloudflare Pages（託管）+ Cloudflare Workers（搜尋 API）。

## 快速開始

```bash
npm install
npm run dev        # 本機開發，預設 http://localhost:4321
npm run build      # 產生靜態網站到 dist/
npm run preview    # 預覽 build 結果
```

## 目錄結構

```
src/content/taxonomy/    分區 / 分類 / 分級 三份定義檔（regions.json / categories.json / tiers.json）
src/content/restaurants/ 每家餐廳一個 JSON 檔案
src/pages/                首頁、地區頁、分類頁、餐廳詳情頁
src/components/           TierBadge、RestaurantCard、CategoryCard 等元件
workers/api.js            Cloudflare Worker：搜尋 API
scripts/fetch-data.mjs    資料同步腳本（GitHub Actions 排程執行）
```

## 新增一筆餐廳資料

1. 在 `src/content/taxonomy/` 確認要用的 `regionId`／`districtId`／`categoryId`／`tierId` 是否已存在，沒有的話先在對應 taxonomy 檔案新增。
2. 在 `src/content/restaurants/` 新增一個 JSON 檔（檔名即為網址 slug），欄位定義見 `src/content/config.ts`。範例可參考 `ah-ming-congee.json`。
3. 分級（`tierId`）由編輯依實際評估手動指定，並填寫 `editorNote` 記錄評定理由。
4. Commit / PR 到 `main`，GitHub Actions 會自動 build 並部署到 Cloudflare Pages。

## 資料同步（自動化的部分）

`npm run sync-data` 會呼叫官方資料源（如觀光局開放資料、Places API 即時查詢）同步客觀欄位（電話、營業時間、地址是否異動），並寫入 `data-snapshots/` 底下帶時間戳的快照——**每次都是新增檔案，不覆蓋歷史**。異動需要人工複核後才會更新進 `src/content/restaurants/`。

分級與評論內容不透過這個腳本自動產生。

## 部署

`.github/workflows/data-update.yml` 每日排程執行資料同步並部署；`push` 到 `main` 也會觸發部署。需要在 repo secrets 設定：

- `DATA_SOURCE_API_KEY` — 資料同步用的官方 API key（唯讀）
- `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` — Cloudflare Pages 部署權限
- Worker 的 `API_WRITE_TOKEN` 用 `wrangler secret put API_WRITE_TOKEN` 另外設定，不放在這裡

## 資料授權聲明

不長期快取、重製第三方平台（如 Google）的評分或評論內容；分級與店家介紹皆為原創編輯內容。
# foodie
