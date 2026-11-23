/**
 * 部署前壓縮照片（npm run build 的最後一步，只處理 dist/，不改 repo 內的原檔）
 *
 * /admin（Sveltia）上傳時就會轉 WebP 1600px，但 /contribute（Decap）沒有這個功能，
 * 投稿者常直接上傳 3–8 MB 的手機原圖。這裡在部署前把 dist/images 內的照片
 * 縮到最長邊 1600px、重新壓縮，檔名與格式不變（JSON 裡的路徑才不會失效）。
 * 壓完沒有變小就保留原檔。
 */
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import sharp from 'sharp';

const ROOT = 'dist/images';
const MAX = 1600;
const SKIP_BELOW = 300 * 1024; // 300 KB 以下且尺寸不超過 MAX 的不處理

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

let count = 0, before = 0, after = 0;
for await (const file of walk(ROOT)) {
  const ext = extname(file).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) continue;
  const { size } = await stat(file);
  const input = await readFile(file);
  let meta;
  try {
    meta = await sharp(input).metadata();
  } catch (e) {
    console.warn(`⚠️  無法讀取照片，略過：${file}（${e.message}）`);
    continue;
  }
  if (size < SKIP_BELOW && Math.max(meta.width ?? 0, meta.height ?? 0) <= MAX) continue;

  let pipeline = sharp(input).rotate().resize({ width: MAX, height: MAX, fit: 'inside', withoutEnlargement: true });
  if (ext === '.png') pipeline = pipeline.png({ compressionLevel: 9, palette: true });
  else if (ext === '.webp') pipeline = pipeline.webp({ quality: 82 });
  else pipeline = pipeline.jpeg({ quality: 82, mozjpeg: true });
  const output = await pipeline.toBuffer();

  if (output.length < size) {
    await writeFile(file, output);
    count++;
    before += size;
    after += output.length;
  }
}

const mb = (n) => (n / 1024 / 1024).toFixed(1);
console.log(
  count
    ? `🖼  壓縮 ${count} 張照片：${mb(before)} MB → ${mb(after)} MB`
    : '🖼  照片都已是適當大小，不需壓縮'
);
