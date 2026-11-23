#!/usr/bin/env python3
"""
試算表匯入：Mac Numbers（.numbers）或 CSV → src/content/restaurants/*.json

用法：
  python3 scripts/import_spreadsheet.py 檔案.numbers [更多檔案…] [--dry-run] [--report 報告.md]

- 讀取所有工作表、所有表格；第一列是欄位名稱
- 認得的欄位（中文即可）：店名、縣市、區、地址、營業時間、店休日、特色料理、分類、品嚐日期
  另外也接受 CSV 範本的欄位：網址代號、細分類、分級、電話、價位、標籤、店家介紹、緯度、經度、分級理由、複核日期
- 縣市、鄉鎮區不存在時自動新增到 src/content/taxonomy/regions.json（代號用拼音）
- 分類沒填時，依 data-import/category-rules.json 的關鍵字自動判斷；原本填的分類文字保留成標籤
- 分級一律設為「待評鑑」（unrated）—— 分級由編輯人工評定（見 CLAUDE.md），匯入不會自動給分級
- 已有同名店家（同縣市）會跳過，不會覆蓋
- 有任何「錯誤」就整批不寫入；「提醒」不影響匯入，但請看一下

需要：pip install numbers-parser pypinyin
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TAXONOMY = ROOT / "src/content/taxonomy"
RESTAURANTS = ROOT / "src/content/restaurants"
RULES = ROOT / "data-import/category-rules.json"

# 全台縣市：名稱 → 代號（沿用 regions.json 既有代號；嘉義市/縣、新竹市/縣合併為同一個地區）
COUNTIES = {
    "台北": "taipei", "新北": "new-taipei", "基隆": "keelung", "桃園": "taoyuan",
    "新竹": "hsinchu", "苗栗": "miaoli", "台中": "taichung", "彰化": "changhua",
    "南投": "nantou", "雲林": "yunlin", "嘉義": "chiayi", "台南": "tainan",
    "高雄": "kaohsiung", "屏東": "pingtung", "宜蘭": "yilan", "花蓮": "hualien",
    "台東": "taitung", "澎湖": "penghu", "金門": "kinmen", "連江": "lienchiang", "馬祖": "lienchiang",
}
# 匯入時可能需要自動新增的分類／細分類名稱
CATEGORY_NAMES = {
    "southeast-asian": "東南亞",
    "vietnamese": "越南", "thai": "泰式",
    "specialty-coffee": "自家烘焙咖啡",
}
HEADER_ALIASES = {
    "name": ["店名", "name"],
    "county": ["縣市", "regionId", "region"],
    "district": ["區", "鄉鎮區", "鄉鎮市區", "行政區", "districtId", "district"],
    "address": ["地址", "address"],
    "hours": ["營業時間", "openingHours"],
    "closed": ["店休日", "公休日", "公休"],
    "dishes": ["特色料理", "招牌", "招牌料理"],
    "category": ["分類", "categoryId", "category"],
    "subcategory": ["細分類", "subcategoryId"],
    "visited": ["品嚐日期", "造訪日期", "複核日期", "最後複核日期", "lastReviewedAt"],
    "urlId": ["網址代號", "urlId", "slug"],
    "tier": ["分級", "tierId"],
    "phone": ["電話", "phone"],
    "price": ["價位", "priceRange"],
    "tags": ["標籤", "tags"],
    "description": ["店家介紹", "介紹", "description"],
    "lat": ["緯度", "lat"],
    "lng": ["經度", "lng"],
    "editorNote": ["分級理由", "編輯備註", "editorNote"],
}

try:
    from pypinyin import lazy_pinyin
except ImportError:  # pragma: no cover
    sys.exit("請先安裝：pip install numbers-parser pypinyin")


# ---------------------------------------------------------------- 工具
def norm(s) -> str:
    """全形轉半形空白、去頭尾空白、臺→台"""
    if s is None:
        return ""
    if isinstance(s, (dt.datetime, dt.date)):
        return s.strftime("%Y-%m-%d")
    if isinstance(s, float) and s.is_integer():
        s = int(s)
    s = str(s).replace("　", " ").replace("臺", "台").strip()
    return re.sub(r"\s+", " ", s)


def strip_suffix(name: str) -> str:
    return re.sub(r"(市|縣|區|鄉|鎮)$", "", name) if len(name) > 2 else name


def slugify(text: str) -> str:
    parts = []
    for chunk in lazy_pinyin(text, errors="default"):  # 非中文（英文店名）保持原樣
        chunk = unicodedata.normalize("NFKD", chunk).encode("ascii", "ignore").decode().lower()
        chunk = re.sub(r"[^a-z0-9]+", "-", chunk).strip("-")
        if chunk:
            parts.append(chunk)
    slug = "-".join(parts)
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug[:60].rstrip("-")


def read_tables(path: Path):
    """回傳 [(工作表名稱, [ {欄位: 值} ... ])]"""
    if path.suffix.lower() == ".numbers":
        from numbers_parser import Document

        out = []
        for sheet in Document(str(path)).sheets:
            for table in sheet.tables:
                rows = table.rows(values_only=True)
                if not rows:
                    continue
                header = [norm(h) for h in rows[0]]
                out.append((sheet.name, [dict(zip(header, r)) for r in rows[1:]]))
        return out
    if path.suffix.lower() == ".csv":
        raw = path.read_bytes()
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = raw.decode("big5")
        rows = list(csv.reader(text.splitlines()))
        header = [norm(h) for h in rows[0]]
        return [(path.stem, [dict(zip(header, r)) for r in rows[1:]])]
    raise SystemExit(f"不支援的檔案格式：{path.name}（請用 .numbers 或 .csv）")


# ---------------------------------------------------------------- 主程式
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+", type=Path)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--report", type=Path, help="把匯入報告（Markdown）另存到這個檔案")
    args = ap.parse_args()

    regions_doc = json.loads((TAXONOMY / "regions.json").read_text("utf-8"))
    categories_doc = json.loads((TAXONOMY / "categories.json").read_text("utf-8"))
    tiers = json.loads((TAXONOMY / "tiers.json").read_text("utf-8"))["tiers"]
    rules = json.loads(RULES.read_text("utf-8"))
    regions = regions_doc["regions"]
    categories = categories_doc["categories"]

    existing = {}
    for f in RESTAURANTS.glob("*.json"):
        d = json.loads(f.read_text("utf-8"))
        existing[f.stem] = d
    existing_names = {(d.get("regionId"), norm(d.get("name"))) for d in existing.values()}
    used_slugs = set(existing)
    all_district_ids = {d["id"] for r in regions for d in r["districts"]}

    errors, warnings, created, skipped = [], [], [], []
    added_regions, added_districts, added_categories = [], [], []
    today = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=8)).strftime("%Y-%m-%d")

    def find_region(county: str):
        key = strip_suffix(county)
        for r in regions:
            if strip_suffix(norm(r["name"])) == key or r["id"] == county:
                return r
        rid = COUNTIES.get(key)
        if not rid:
            return None
        r = next((x for x in regions if x["id"] == rid), None)
        if r is None:
            r = {"id": rid, "name": key, "popular": False, "districts": []}
            regions.append(r)
            added_regions.append(f"{key}（{rid}）")
        return r

    def find_district(region, name: str):
        key = strip_suffix(name)
        for d in region["districts"]:
            if d["id"] == name or strip_suffix(norm(d["name"])) == key:
                return d
        base = f'{region["id"]}-{slugify(key).replace("-", "")}'
        did, n = base, 2
        while did in all_district_ids:
            did, n = f"{base}-{n}", n + 1
        d = {"id": did, "name": name}
        region["districts"].append(d)
        all_district_ids.add(did)
        added_districts.append(f'{region["name"]}・{name}（{did}）')
        return d

    def ensure_category(cid: str, sub: str | None):
        c = next((x for x in categories if x["id"] == cid), None)
        if c is None:
            c = {"id": cid, "name": CATEGORY_NAMES.get(cid, cid), "showOnHome": False, "subcategories": []}
            categories.append(c)
            added_categories.append(f'{c["name"]}（{cid}）')
        if sub and not any(s["id"] == sub for s in c["subcategories"]):
            c["subcategories"].append({"id": sub, "name": CATEGORY_NAMES.get(sub, sub)})
            added_categories.append(f'{c["name"]}・{CATEGORY_NAMES.get(sub, sub)}（{sub}）')
        return c

    def classify(cat_text: str, name: str, dishes: str):
        # 直接填代號或分類名稱
        for c in categories:
            if cat_text and cat_text in (c["id"], c["name"]):
                return c["id"], None, "表格分類"
        for source, text in (("表格分類", cat_text), ("店名", name), ("特色料理", dishes)):
            if not text:
                continue
            for rule in rules["rules"]:
                if any(k in text for k in rule["match"]):
                    sub = rule.get("subcategory")
                    if not sub:  # 分類確定後，再用店名／特色料理找同分類的細分類（例如 Coffee → 自家烘焙咖啡）
                        for r2 in rules["rules"]:
                            if r2["category"] == rule["category"] and r2.get("subcategory") and any(
                                k in f"{name} {dishes}" for k in r2["match"]
                            ):
                                sub = r2["subcategory"]
                                break
                    return rule["category"], sub, source
        return rules["defaultCategory"], None, "預設"

    records = []
    for path in args.files:
        for sheet, rows in read_tables(path):
            for i, raw in enumerate(rows, start=2):
                row = {}
                for key, names in HEADER_ALIASES.items():
                    for n in names:
                        if n in raw and norm(raw[n]) != "":
                            row[key] = raw[n]
                            break
                if not any(norm(v) for v in raw.values()):
                    continue
                where = f"{path.name}／{sheet}／第 {i} 列（{norm(row.get('name')) or '未命名'}）"
                name = norm(row.get("name"))
                county = norm(row.get("county"))
                dist_raw = norm(row.get("district"))
                address = norm(row.get("address"))
                for key, label in (("name", "店名"), ("county", "縣市"), ("district", "區"), ("address", "地址")):
                    if not norm(row.get(key)):
                        errors.append(f"{where}：「{label}」不可空白")
                if not (name and county and dist_raw and address):
                    continue

                # 工作表名稱是縣市時，用來交叉檢查打錯的縣市
                sheet_region = find_region(norm(sheet)) if strip_suffix(norm(sheet)) in COUNTIES else None
                region = find_region(county)
                if sheet_region and region and sheet_region["id"] != region["id"]:
                    warnings.append(f"{where}：縣市填「{county}」，但在「{sheet}」工作表 → 以工作表為準：{sheet_region['name']}")
                    county, region = sheet_region["name"], sheet_region
                if region is None:
                    errors.append(f"{where}：不認得的縣市「{county}」")
                    continue

                if "/" in dist_raw or "／" in dist_raw:
                    first = re.split(r"[/／]", dist_raw)[0].strip()
                    warnings.append(f"{where}：區「{dist_raw}」有多個，先採用「{first}」，請確認")
                    dist_raw = first
                district = find_district(region, dist_raw)

                if (region["id"], name) in existing_names:
                    skipped.append(f"{name}（{region['name']}，網站上已有）")
                    continue

                # 分類
                cat_text = norm(row.get("category"))
                cid, sub, source = classify(cat_text, name, norm(row.get("dishes")))
                if norm(row.get("subcategory")):
                    sub = norm(row.get("subcategory"))
                ensure_category(cid, sub)

                # 地址：補上縣市與區
                full_address = address
                if not address.startswith(county[:2]):
                    full_address = f"{county}{dist_raw}{address}"

                hours = norm(row.get("hours"))
                closed = norm(row.get("closed"))
                if closed:
                    if not re.search(r"休|公休", closed):
                        closed = f"{closed}公休"
                    hours = f"{hours}（{closed}）" if hours else closed

                dishes = norm(row.get("dishes"))
                description = norm(row.get("description")) or (f"招牌：{dishes}" if dishes else (cat_text or "待補充店家介紹"))

                visited = row.get("visited")
                reviewed = today
                note = norm(row.get("editorNote"))
                if isinstance(visited, (dt.datetime, dt.date)):
                    reviewed = visited.strftime("%Y-%m-%d")
                elif norm(visited):
                    v = norm(visited)
                    if re.fullmatch(r"\d{4}[-/.]\d{1,2}[-/.]\d{1,2}", v):
                        y, m, d = re.split(r"[-/.]", v)
                        reviewed = f"{int(y):04d}-{int(m):02d}-{int(d):02d}"
                    else:
                        note = (note + "\n" if note else "") + f"個人評分：{v}"

                slug = norm(row.get("urlId")).lower() or slugify(name) or "shop"
                base, n = slug, 2
                while slug in used_slugs:
                    slug, n = f"{base}-{n}", n + 1
                used_slugs.add(slug)

                tags = []
                if cat_text and cat_text not in (c["name"] for c in categories):
                    tags.append(cat_text)
                if norm(row.get("tags")):
                    tags += [t.strip() for t in re.split(r"[、,，|｜]", norm(row["tags"])) if t.strip()]

                tier = "unrated"
                if norm(row.get("tier")):
                    t = norm(row["tier"])
                    match = next((x for x in tiers if t in (x["id"], x["name"])), None)
                    if match:
                        tier = match["id"]
                    else:
                        warnings.append(f"{where}：不認得的分級「{t}」，改為待評鑑")

                rec = {
                    "urlId": slug,
                    "name": name,
                    "regionId": region["id"],
                    "districtId": district["id"],
                    "categoryId": cid,
                    **({"subcategoryId": sub} if sub else {}),
                    "tierId": tier,
                    "address": full_address,
                    **({"phone": norm(row["phone"])} if norm(row.get("phone")) else {}),
                    **({"openingHours": hours} if hours else {}),
                    **({"priceRange": norm(row["price"])} if norm(row.get("price")) in ("$", "$$", "$$$", "$$$$") else {}),
                    "tags": tags,
                    "description": description,
                    **({"editorNote": note} if note else {}),
                    "lastReviewedAt": reviewed,
                }
                for k in ("lat", "lng"):
                    if norm(row.get(k)):
                        try:
                            rec[k] = float(norm(row[k]))
                        except ValueError:
                            warnings.append(f"{where}：{k}「{row[k]}」不是數字，已略過")
                records.append((slug, rec, source))
                created.append(rec)

    # ---------------------------------------------------------------- 報告
    cat_name = {c["id"]: c["name"] for c in categories}
    sub_name = {s["id"]: s["name"] for c in categories for s in c["subcategories"]}
    lines = [f"# 匯入報告（{today}）", ""]
    lines.append(f"- 新增店家：**{len(created)}** 家")
    lines.append(f"- 跳過（網站上已有）：{len(skipped)} 家")
    lines.append(f"- 錯誤：{len(errors)}　提醒：{len(warnings)}")
    if errors:
        lines += ["", "## ❌ 錯誤（整批未匯入，請修正後重新上傳）", *[f"- {e}" for e in errors]]
    if warnings:
        lines += ["", "## ⚠️ 提醒", *[f"- {w}" for w in warnings]]
    if added_regions or added_districts or added_categories:
        lines += ["", "## 自動新增的地區／分類"]
        lines += [f"- 縣市：{x}" for x in added_regions]
        lines += [f"- 鄉鎮區：{x}" for x in added_districts]
        lines += [f"- 分類：{x}" for x in added_categories]
    if skipped:
        lines += ["", "## 跳過", *[f"- {s}" for s in skipped]]
    if created:
        lines += ["", "## 新增店家", "", "| 店名 | 地區 | 分類 | 判斷依據 | 網址代號 |", "|---|---|---|---|---|"]
        region_name = {r["id"]: r["name"] for r in regions}
        dist_name = {d["id"]: d["name"] for r in regions for d in r["districts"]}
        for slug, r, source in records:
            cat = cat_name.get(r["categoryId"], r["categoryId"])
            if r.get("subcategoryId"):
                cat += f"・{sub_name.get(r['subcategoryId'], r['subcategoryId'])}"
            lines.append(f"| {r['name']} | {region_name[r['regionId']]}・{dist_name[r['districtId']]} | {cat} | {source} | {slug} |")
    report = "\n".join(lines) + "\n"
    print(report)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(report, "utf-8")

    if errors:
        return 1
    if args.dry_run:
        print("（試跑，未寫入任何檔案）")
        return 0

    for slug, rec, _ in records:
        (RESTAURANTS / f"{slug}.json").write_text(json.dumps(rec, ensure_ascii=False, indent=2) + "\n", "utf-8")
    if added_regions or added_districts:
        (TAXONOMY / "regions.json").write_text(json.dumps(regions_doc, ensure_ascii=False, indent=2) + "\n", "utf-8")
    if added_categories:
        (TAXONOMY / "categories.json").write_text(json.dumps(categories_doc, ensure_ascii=False, indent=2) + "\n", "utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
