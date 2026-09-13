"""総覧ダッシュボード用の集計スクリプト（単独実行）。schema 2（2026-09-13 合体 v3.2.0）。

data/history.json（日×プロジェクトの生データ）と data/projects_summary.json
（folder/slug/name の対応表）から、ブラウザ側で期間・粒度・上位N・その他の
切替を自前でできるよう、data/overview/ に schema 2 の表を書き出す。

集計は1系統（旧 data/analysis/・build_analysis.py は廃止）。名寄せ（MERGES）を
掛けた406PJで、日×PJの表6本（v24・v30・price・members・stock・mcap）＋
market.json・monthly.json・bundles.json の9本を書く。series.json は作らない
（合計はブラウザ側で計算する契約＝docs/2026-09-13_合体_設計.md 契約B）。

出力先: data/overview/
  - market.json  : days・projects・first_day・latest・n（記録のあるPJ数）のみ
  - v24.json     : 24h出来高（volume・生の値）＋gap（欠測の目印）
  - v30.json     : 30日出来高（volume_data）
  - price.json   : 現在価格（current_price）
  - members.json : メンバー数（num_member・生の値）
  - stock.json   : トークン在庫（stock）
  - mcap.json    : 時価総額（marketCap）
  - monthly.json : 月×PJの30日出来高ピック（+ picked_day）
  - bundles.json : 束・単独・公式PJ・名寄せ表

名寄せ（MERGES・確定3組・仕様メモ §3-1・window_compare.py と同じ文字列）:
  前身の data を後継へ統合（同じ日付は後継を優先）。前身は projects から除く。
  合体画面は前身の記録を含む・個別ページ（data/projects/ 等）は変えない。

欠測ルール（v24 の gap）:
  volume == volume_data かつ volume > 0 の日は、24h出来高が取得できず30日値で
  埋められた可能性がある（scripts/update_daily.py の既知の挙動）。この日は
  rows には生の値をそのまま入れ、gap に [pjIndex, dayIndex] を積む。
  「ならす（smooth）」表示はブラウザ側で gap の日を除いて計算する。

実行:
  python3 scripts/build_overview.py
"""

import datetime as _dt
import json
import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
OUT_DIR = os.path.join(DATA_DIR, "overview")

HISTORY_PATH = os.path.join(DATA_DIR, "history.json")
SUMMARY_PATH = os.path.join(DATA_DIR, "projects_summary.json")

SCHEMA = 2
MAX_BYTES = 25 * 1024 * 1024  # 25 MiB

# 名寄せ（確定3組）＝ docs/analysis_code/window_compare.py の MERGES と文字列で一致させる。
# パティスリー・ル・ヴェール → 鹿児島タイムズ は候補（強）止まりで結合しない（2026-09-13 07:02 ルク決裁）。
MERGES = [
    ("214_red_tokyo_premium", "404_TEAMRED"),
    ("226_yamamotosyoten", "373_yamamotoshoten"),
    ("383_Otoyume_Panda", "408_g3b5137c8ead142f995528051be2fa72a"),
]

# 束の定義（build_analysis.py の BUNDLES から移植・同一内容）
BUNDLES = [
    {"key": "ninjadao", "label": "NinjaDAO系",
     "folders": ["319_ninjadaoplus", "cryptoninjagames", "236_gachiho", "312_orochi_cnp", "209_cnpninjadao"]},
    {"key": "reiwa", "label": "令和の虎系",
     "folders": ["299_takenouchi_jyuku", "231_minnaka", "241_tsuhan-tora", "313_Dotcon", "229_jigyosaisei"]},
    {"key": "red", "label": "RED系",
     "folders": ["372_sports_of_heart", "404_TEAMRED", "321_akainu_akaneko", "304_scent_japan_dao",
                 "221_red_hopes"]},  # 214_red_tokyo_premium は 404_TEAMRED へ名寄せ済み
]

# 束に入れず単独で見せるPJ（build_analysis.py の STANDALONE から移植）
STANDALONE = ["363_real_value", "356_yurutoken", "198_MetaverseMahjong"]

OFFICIAL_FOLDER = "308_tokenplus"

# 短い表示名（build_analysis.py の SHORT_NAMES から移植・同一内容）
SHORT_NAMES = {
    "319_ninjadaoplus": "にんプラ",
    "cryptoninjagames": "CNG",
    "236_gachiho": "ガチホ",
    "312_orochi_cnp": "オロチ",
    "209_cnpninjadao": "CNPスター",
    "299_takenouchi_jyuku": "竹之内塾",
    "231_minnaka": "ミンナカ",
    "241_tsuhan-tora": "通販の虎",
    "313_Dotcon": "Dotcon",
    "229_jigyosaisei": "事業再生版",
    "372_sports_of_heart": "SOH",
    "214_red_tokyo_premium": "RED° TOKYO",
    "321_akainu_akaneko": "AKAINU AKANEKO",
    "304_scent_japan_dao": "Scent Japan DAO",
    "221_red_hopes": "RED SPORTS",
    "404_TEAMRED": "TEAM RED",
    "363_real_value": "REAL VALUE",
    "356_yurutoken": "ゆるトークン",
    "198_MetaverseMahjong": "メタバース麻雀",
    "308_tokenplus": "FiNANCiE公式",
}


def short_name(folder, name):
    if folder in SHORT_NAMES:
        return SHORT_NAMES[folder]
    head = name.replace("|", "｜").split("｜")[0].strip()
    head = head.replace(" | FiNANCiE", "").strip()
    return head[:14] if head else folder


def to_number(value):
    """数値または数値文字列を float に。変換できなければ None。"""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        try:
            return float(value)
        except (TypeError, ValueError):
            return None
    return None


def round_or_none(value):
    if value is None:
        return None
    if isinstance(value, float) and value == int(value):
        return int(value)
    if isinstance(value, float):
        return round(value, 4)
    return value


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def built_at():
    return _dt.datetime.now(_dt.timezone(_dt.timedelta(hours=9))).strftime("%Y-%m-%d %H:%M JST")


def apply_merges(history):
    """前身 → 後継へ data を統合し、前身を history から取り除く（window_compare.py と同じ手順）。"""
    for a, b in MERGES:
        if a not in history or b not in history:
            continue
        for d, v in history[a]["data"].items():
            if d not in history[b]["data"]:
                history[b]["data"][d] = v
        del history[a]


def build():
    history = load_json(HISTORY_PATH)
    summary = load_json(SUMMARY_PATH)

    os.makedirs(OUT_DIR, exist_ok=True)

    apply_merges(history)  # 前身を history から削除＝以降のループは自然と後継だけを拾う

    # プロジェクトの並び順は projects_summary.json（現在のランキング順）に合わせる。
    # 前身の folder は history から既に消えているので、下の「folder not in history」で
    # 自動的にスキップされる＝後継の folder/slug/name は後継自身の summary 行から取る。
    projects = []
    for item in summary:
        folder = item.get("folder")
        if folder not in history:
            continue
        name = item.get("name", folder)
        rec_days = sorted(history[folder].get("data", {}).keys())
        first_raw = rec_days[0] if rec_days else None
        projects.append({
            "folder": folder,
            "slug": item.get("slug", folder),
            "name": name,
            "short": short_name(folder, name),
            "first": f"{first_raw[0:4]}-{first_raw[4:6]}-{first_raw[6:8]}" if first_raw else None,
        })

    # 全日付の和集合（昇順）。
    all_days = set()
    for folder_data in history.values():
        all_days |= set(folder_data.get("data", {}).keys())
    days_raw = sorted(all_days)  # "YYYYMMDD"
    days = [f"{d[0:4]}-{d[4:6]}-{d[6:8]}" for d in days_raw]

    n_days = len(days_raw)
    n_projects = len(projects)
    day_index = {d: i for i, d in enumerate(days_raw)}

    v24_rows = []
    v30_rows = []
    price_rows = []
    members_rows = []
    stock_rows = []
    mcap_rows = []
    gap = []

    n_count = [0] * n_days  # その日にレコードそのものがある件数

    for p_idx, p in enumerate(projects):
        folder = p["folder"]
        data = history[folder].get("data", {})

        v24_row = [None] * n_days
        v30_row = [None] * n_days
        price_row = [None] * n_days
        members_row = [None] * n_days
        stock_row = [None] * n_days
        mcap_row = [None] * n_days

        for i, dkey in enumerate(days_raw):
            rec = data.get(dkey)
            if rec is None:
                continue

            n_count[i] += 1

            volume = to_number(rec.get("volume"))
            volume_data = to_number(rec.get("volume_data"))

            # gap（欠測の目印）: 丸める前の生の値で判定。rows には生の volume をそのまま入れる。
            if (
                volume is not None
                and volume_data is not None
                and volume > 0
                and volume == volume_data
            ):
                gap.append([p_idx, i])

            v24_row[i] = round_or_none(volume)
            v30_row[i] = round_or_none(volume_data)
            price_row[i] = round_or_none(to_number(rec.get("current_price")))
            stock_row[i] = round_or_none(to_number(rec.get("stock")))
            mcap_row[i] = round_or_none(to_number(rec.get("marketCap")))
            members_row[i] = round_or_none(to_number(rec.get("num_member")))

        v24_rows.append(v24_row)
        v30_rows.append(v30_row)
        price_rows.append(price_row)
        members_rows.append(members_row)
        stock_rows.append(stock_row)
        mcap_rows.append(mcap_row)

    market = {
        "schema": SCHEMA,
        "built_at": built_at(),
        "days": days,
        "projects": [{"folder": p["folder"], "slug": p["slug"], "name": p["name"], "short": p["short"], "first": p["first"]} for p in projects],
        "n": n_count,
        "latest": days_raw[-1] if days_raw else None,
        "first_day": days[0] if days else None,
    }
    write_json(os.path.join(OUT_DIR, "market.json"), market)

    proj_meta = [{"folder": p["folder"], "slug": p["slug"], "name": p["name"], "short": p["short"], "first": p["first"]} for p in projects]

    def base_obj(extra=None):
        obj = {
            "schema": SCHEMA,
            "built_at": built_at(),
            "days": days,
            "projects": proj_meta,
        }
        if extra:
            obj.update(extra)
        return obj

    def write_metric(filename, rows, extra=None):
        obj = base_obj({"rows": rows})
        if extra:
            obj.update(extra)
        write_json(os.path.join(OUT_DIR, filename), obj)

    write_metric("v24.json", v24_rows, {"gap": gap})
    write_metric("v30.json", v30_rows)
    write_metric("price.json", price_rows)
    write_metric("members.json", members_rows)
    write_metric("stock.json", stock_rows)
    write_metric("mcap.json", mcap_rows)

    # monthly.json: 月×PJ の30日出来高ピック（翌月1〜5日のうち最初に volume_data>0 の日）。
    # 最新日を含む月（暫定・未確定）は入れない（先読み防止）。
    first_month = days_raw[0][0:6] if days_raw else None
    last_month = days_raw[-1][0:6] if days_raw else None
    months = []
    if first_month and last_month:
        y, m = int(first_month[0:4]), int(first_month[4:6])
        while f"{y:04d}{m:02d}" < last_month:
            months.append((y, m))
            m += 1
            if m == 13:
                y, m = y + 1, 1

    month_keys = []
    month_cands = []  # 各月の「翌月1〜5日」の候補キー（存在する日だけ）
    for (y, m) in months:
        ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)
        cands = [k for k in (f"{ny:04d}{nm:02d}{dd:02d}" for dd in range(1, 6)) if k in day_index]
        if not cands:
            continue
        month_keys.append(f"{y:04d}-{m:02d}")
        month_cands.append(cands)

    monthly_rows = []
    picked_day = []
    for p in projects:
        data = history[p["folder"]].get("data", {})
        row = []
        picked_row = []
        for cands in month_cands:
            v = 0
            picked = None
            for k in cands:
                rec = data.get(k)
                x = to_number(rec.get("volume_data")) if rec else None
                if x is not None and x > 0:
                    v = x
                    picked = day_index[k]
                    break
            row.append(round_or_none(v))
            picked_row.append(picked)
        monthly_rows.append(row)
        picked_day.append(picked_row)

    write_json(os.path.join(OUT_DIR, "monthly.json"), base_obj({
        "months": month_keys,
        "rows": monthly_rows,
        "picked_day": picked_day,
    }))

    existing = {p["folder"] for p in projects}
    write_json(os.path.join(OUT_DIR, "bundles.json"), base_obj({
        "bundles": [{"key": b["key"], "label": b["label"], "folders": [f for f in b["folders"] if f in existing]} for b in BUNDLES],
        "standalone": [f for f in STANDALONE if f in existing],
        "official": OFFICIAL_FOLDER,
        "merges": [list(pair) for pair in MERGES],
    }))

    print(f"days={n_days} projects={n_projects} gap={len(gap)}")
    total_bytes = 0
    over_limit = False
    for fname in ["market.json", "v24.json", "v30.json", "price.json", "members.json", "stock.json", "mcap.json", "monthly.json", "bundles.json"]:
        path = os.path.join(OUT_DIR, fname)
        size = os.path.getsize(path)
        total_bytes += size
        flag = ""
        if size > MAX_BYTES:
            over_limit = True
            flag = "  *** 25MiB 超 ***"
        print(f"  {fname}: {size / 1024:.1f} KB{flag}")

    if over_limit:
        raise SystemExit(1)


if __name__ == "__main__":
    build()
