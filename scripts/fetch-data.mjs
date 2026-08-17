/**
 * 資料同步腳本（由 GitHub Actions 排程執行）
 *
 * 這支腳本「不」負責決定分級——分級 (tierId) 一律由編輯在
 * src/content/restaurants/*.json 手動維護。這支腳本只負責同步
 * 客觀、可公開重製的欄位（例如營業時間、電話、地址是否有變動），
 * 並且用官方 API／可信的開放資料源，避免快取第三方評分資料的授權風險。
 *
 * 強制規則（沿用自日本旅遊網站專案的失敗教訓）：
 * 1. 每次執行都要「新增」一份帶時間戳的快照，不可覆蓋前一份 —
 *    否則會像先前的飛機票追蹤器一樣遺失歷史資料。
 * 2. 發送通知（例如「某店家異動待複核」）前要做去重，避免重複通知。
 */
import { writeFile, mkdir } from 'node:fs/promises';

const SNAPSHOT_DIR = 'data-snapshots';

async function main() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  await mkdir(SNAPSHOT_DIR, { recursive: true });

  // TODO: 呼叫官方資料源（如觀光局開放資料、Google Places API 即時查詢），
  // 只取客觀欄位，不落地儲存第三方評分/評論內容。
  const snapshot = {
    generatedAt: timestamp,
    changes: [], // { restaurantSlug, field, oldValue, newValue }
  };

  await writeFile(
    `${SNAPSHOT_DIR}/${timestamp}.json`,
    JSON.stringify(snapshot, null, 2)
  );

  // TODO: 去重後，把需要人工複核的異動整理成 issue 或通知，而不是每次都全發。
  console.log(`Snapshot written: ${SNAPSHOT_DIR}/${timestamp}.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
