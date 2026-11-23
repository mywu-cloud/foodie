# 編輯後台與資料匯入

台灣美食通有兩種輸入資料的方式，最後都是把 JSON 和照片 commit 進這個 repo，由 GitHub Actions 自動 build 並部署到 Cloudflare Pages（約 1–2 分鐘後上線）。

| 方式 | 適合 | 入口 |
|---|---|---|
| **/admin 後台** | 日常新增或修改單筆資料、上傳美食照片、新增鄉鎮區與分類 | https://twfood.pages.dev/admin/ |
| **試算表自動匯入** | 用 Numbers 整理好的店家清單，整批上傳 | 把 `.numbers` / `.csv` 上傳到 GitHub 的 `data-import/inbox/`（說明見該資料夾的 README） |
| **CSV 批次匯入（本機）** | 需要在電腦上裝 Node.js | `npm run import -- 檔案.csv` |

部署前會先跑 `npm run validate` 做交叉檢查（縣市與鄉鎮區是否對得上、照片檔是否存在、分級是否有效）。檢查沒過就不會部署，網站維持上一版。

---

## 一、/admin 後台（Sveltia CMS）

### 登入方式 A：GitHub Token（不用額外設定，馬上能用）

1. GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → Generate new token
2. Repository access 選 **Only select repositories → mywu-cloud/foodie**
3. Permissions → Repository permissions → **Contents: Read and write**（Metadata 會自動設成 Read）
4. 到 https://twfood.pages.dev/admin/ → 選 **Sign In with Token**（使用存取權杖登入）→ 貼上 token

Token 只存在你的瀏覽器裡。建議設定到期日，到期後重新產生一個即可。

### 登入方式 B：「用 GitHub 登入」按鈕（OAuth，之後要給別的編輯用時再設）

1. 部署 OAuth Worker：照 https://github.com/sveltia/sveltia-cms-auth 的 README 按 **Deploy to Cloudflare Workers**
2. GitHub → Settings → Developer settings → **OAuth Apps → New OAuth App**
   - Homepage URL：`https://twfood.pages.dev`
   - Authorization callback URL：`https://<你的worker>.workers.dev/callback`
3. 在 Worker 設定環境變數：`GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`（用 secret）、`ALLOWED_DOMAINS=twfood.pages.dev`
4. 在 foodie repo → Settings → Secrets and variables → Actions → **Variables** 新增 `CMS_AUTH_URL = https://<你的worker>.workers.dev`
5. 隨便 push 一次讓網站重新部署，後台就會出現「Sign In with GitHub」

> 權限由 GitHub 控管：只有對 `mywu-cloud/foodie` 有寫入權限的帳號能存檔。要加編輯，就到 repo → Settings → Collaborators 邀請對方。

### 新增一家店

1. 左側 **餐廳** → **新增**
2. **網址代號**填英文，例如 `ah-ming-congee`，網址會是 `/restaurant/ah-ming-congee`。建立後不要再改。
3. 縣市、鄉鎮區、分類、分級都是下拉選單。**鄉鎮區要選跟縣市相符的**（選項標籤有寫縣市名稱）；選錯的話部署前的檢查會擋下來。
4. **封面照 / 美食照片**：直接拖拉照片上傳，會自動轉成 WebP、最長邊縮到 1600px，檔案存到 `public/images/restaurants/`
5. 按 **儲存**，就會 commit 到 main，約 1–2 分鐘後上線

### 新增鄉鎮區或分類

左側 **分類設定** → **地區** 或 **料理分類** → 在對應的縣市底下新增一個鄉鎮區（代號用英文、**全站不可重複**，建議加縣市前綴如 `kaohsiung-sanmin`，建立後不要改）→ 儲存。重新部署後，餐廳表單的下拉選單就會出現新選項。

分級（tiers.json）刻意沒有開放在後台修改，因為它是網站的核心定義；要調整請直接改 JSON。

### 照片注意事項

- 只用**自己拍攝**或**店家授權**的照片，不要從 Google 地圖、部落格或社群抓（見 CLAUDE.md 的授權原則）
- 手機照片直接上傳就好，壓縮會自動處理
- 照片都放在 repo 裡。幾百到上千張 WebP 都沒問題；如果 repo 超過約 1 GB，再考慮改成 Cloudflare R2

### 本機使用後台（選用）

`npm run dev` 後開 http://localhost:4321/admin/ → 選 **Work with Local Repository**，然後選 foodie 資料夾（需要 Chrome 或 Edge）。改動會直接寫進本機檔案，再自己 commit。

---

## 二、試算表自動匯入（不用安裝任何軟體）

1. GitHub → foodie repo → 打開 `data-import/inbox` 資料夾 → **Add file → Upload files**
2. 拖入 `.numbers`（或 `.csv`）→ **Commit changes**
3. Actions 分頁的「試算表匯入」會自動執行：轉換 → 驗證 → 成功就匯入並部署；失敗就整批不匯入，錯誤寫在該次執行的 Summary
4. 處理過的檔案移到 `data-import/done/` 或 `failed/`，報告在 `data-import/reports/`

欄位格式、自動分類規則見 `data-import/inbox/README.md`。注意：repo 是公開的，上傳的檔案與報告任何人都看得到。

## 三、CSV 批次匯入（本機）

1. 用 Excel 或 Google 試算表打開 `data-import/restaurants-template.csv`，一列填一家店，填完**刪除範例列**
2. 另存為 CSV（Excel 選「CSV UTF-8」最保險；Big5 也能讀）
3. 照片檔先放進 `public/images/restaurants/`，CSV 的「封面照」「美食照片」欄位填檔名。多張照片用 `｜` 分隔。
4. 先試跑檢查：

   ```bash
   npm run import -- data-import/我的清單.csv --dry-run
   ```

5. 沒有錯誤就正式匯入，再 commit：

   ```bash
   npm run import -- data-import/我的清單.csv
   npm run validate
   git add src/content/restaurants public/images && git commit -m "content: 批次匯入" && git push
   ```

### 欄位說明

| 欄位 | 必填 | 說明 |
|---|---|---|
| 網址代號 | ✅ | 英文小寫、數字、`-`，即檔名與網址 |
| 店名 | ✅ | |
| 縣市 / 鄉鎮區 | ✅ | 中文名稱或代號都可以：`高雄`、`高雄市`、`kaohsiung`；`鹽埕區`、`鹽埕`、`yancheng`；台/臺 都可以 |
| 分類 | ✅ | `台式`、`小吃`… 或代號 |
| 細分類 | | 需屬於該分類 |
| 分級 | | `必吃首選` / `巷弄推薦` / `在地口碑` / `待評鑑`；沒填 → 待評鑑 |
| 地址 | ✅ | |
| 店家介紹 | ✅ | 前台顯示 |
| 電話、營業時間 | | |
| 價位 | | `$` `$$` `$$$` `$$$$` |
| 標籤 | | 用 `、` 或 `,` 分隔 |
| 封面照、美食照片 | | 檔名（放在 `public/images/restaurants/`），多張用 `｜` 分隔 |
| 緯度、經度 | | 數字 |
| 分級理由 | | 內部備註，不顯示於前台 |
| 複核日期 | | `2026-11-23`；沒填 → 匯入當天 |

### 規則

- **整批檢查**：任何一列有錯（找不到縣市、照片不存在…），整批都不寫入，錯誤訊息會標出第幾列
- **已存在的店預設跳過**。加 `--overwrite` 時，只用 CSV **有填**的欄位覆蓋，空白欄位保留原值（所以不會把後台填好的分級理由洗掉）
