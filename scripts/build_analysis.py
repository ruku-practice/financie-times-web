"""「分析」タブ用の集計スクリプト（単独実行・読み取りのみ・本家へのアクセスなし）。

data/history.json（PJ→日付→生データ）と data/projects_summary.json（folder/slug/name）
から、ブラウザ側で「期間（30日／90日／1年／全期間／自由）」を切り替えて
分析レポート（company/output/2026-09/2026-09-12_FiNANCiE_分析レポート_直近の動きと機運.md）
の図10枚を描き直せるよう、必要最小限の表を data/analysis/ に書き出す。

出力先: data/analysis/
  - series.json  : 日次の全体系列（24h出来高合計・出来高が立ったPJ数・メンバー合計
                   （停止PJは最後の値を据え置き）・公式PJのメンバー・時価総額合計）
  - v24.json     : 日×PJの24h出来高（生の volume＝レポート定義。欠測ルールは掛けない）
  - price.json   : 日×PJの価格（current_price・小数2桁）
  - monthly.json : 月×PJの30日出来高（PJごとに翌月1〜5日のうち最初に volume_data>0 の日の値・無ければ0＝仕様メモ §6）
  - bundles.json : 束（NinjaDAO系・令和の虎系・RED系）と単独表示PJ・短い表示名・名寄せ表

欠測の扱い（🔴全体市況と違う・dev-lead 2026-09-13 06:50 の判断）:
  分析レポートは生の volume を合算しているので、ここでも欠測ルール（volume==volume_data を null）
  は掛けない。数値化できない値だけ null。全体市況の数字と 1〜3% ズレるのは仕様（注記で示す）。

名寄せ（aliases）: 分析レポート担当の名寄せ表が届いたら ALIASES に「別folder → 正のfolder」を
  書く。同じ正 folder に寄せた行は日ごとに合算する（2026-09-13 時点では空＝名寄せ無し）。

実行:
  python3 scripts/build_analysis.py
"""

import json
import os
import datetime as _dt

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
OUT_DIR = os.path.join(DATA_DIR, "analysis")

HISTORY_PATH = os.path.join(DATA_DIR, "history.json")
SUMMARY_PATH = os.path.join(DATA_DIR, "projects_summary.json")

# 束の定義（分析レポート §2「束で見る」＝ルクの 2026-02-07 レポートを踏襲・TEAM RED は推定で RED系）
BUNDLES = [
    {"key": "ninjadao", "label": "NinjaDAO系",
     "folders": ["319_ninjadaoplus", "cryptoninjagames", "236_gachiho", "312_orochi_cnp", "209_cnpninjadao"]},
    {"key": "reiwa", "label": "令和の虎系",
     "folders": ["299_takenouchi_jyuku", "231_minnaka", "241_tsuhan-tora", "313_Dotcon", "229_jigyosaisei"]},
    {"key": "red", "label": "RED系",
     "folders": ["372_sports_of_heart", "404_TEAMRED", "321_akainu_akaneko", "304_scent_japan_dao",
                 "221_red_hopes"]},  # 214_red_tokyo_premium は 404_TEAMRED へ名寄せ済み
]

# 束に入れず単独で見せるPJ（分析レポートの円グラフ・積み上げの区分に合わせる）
STANDALONE = ["363_real_value", "356_yurutoken", "198_MetaverseMahjong"]

# 短い表示名（レポートの呼び方）。無いPJは name を「｜」「|」で切った前半（14字まで）
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

# 名寄せ表（前身 folder → 後継 folder）＝分析タブ仕様メモ §3（2026-09-13 06:45・分析レポート担当）。
#   確定3件＋候補（強）1件（パティスリー・ル・ヴェール → KX：鹿児島タイムズ＝ルク確認待ちだが v2 レポートと揃えて結合）。
#   同じ日付が両方にあれば後継を優先（仕様メモ §2-2）。
ALIASES = {
    "214_red_tokyo_premium": "404_TEAMRED",          # RED° TOKYO PREMIUM → TEAM RED（3/31 メンバー 3,842 が完全一致）
    "226_yamamotosyoten": "373_yamamotoshoten",      # 山本商店（slug の綴り違い・870 が一致）
    "383_Otoyume_Panda": "408_g3b5137c8ead142f995528051be2fa72a",  # 音夢パンダ（名前同一）
    "345_PatisserieLeVert": "380_kagoshima_times",   # 候補（強）＝ルク確認待ち
}

OFFICIAL_FOLDER = "308_tokenplus"


def to_number(value):
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


def compact(value, ndigits=0):
    """JSON を小さくする丸め。None はそのまま。"""
    if value is None:
        return None
    if ndigits == 0:
        return int(round(value))
    r = round(value, ndigits)
    return int(r) if r == int(r) else r


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def short_name(folder, name):
    if folder in SHORT_NAMES:
        return SHORT_NAMES[folder]
    head = name.replace("|", "｜").split("｜")[0].strip()
    head = head.replace(" | FiNANCiE", "").strip()
    return head[:14] if head else folder


def iso(dkey):
    return f"{dkey[0:4]}-{dkey[4:6]}-{dkey[6:8]}"


def build():
    history = load_json(HISTORY_PATH)
    summary = load_json(SUMMARY_PATH)
    os.makedirs(OUT_DIR, exist_ok=True)

    # 名寄せ：前身の data を後継へ。同じ日付が両方にあれば後継を優先（仕様メモ §2-2＝window_compare.py と同じ）
    merged = {}
    for folder, pdata in history.items():
        if folder in ALIASES:
            continue
        merged[folder] = {"data": dict(pdata.get("data", {}))}
    for src, dst in ALIASES.items():
        if src not in history or dst not in merged:
            continue
        for dkey, rec in history[src].get("data", {}).items():
            if dkey not in merged[dst]["data"]:
                merged[dst]["data"][dkey] = rec

    # 欠測補正（仕様メモ §4）：num_member が直前 ≥100 から 0 に落ちた日は欠測＝前の値で埋める
    for pdata in merged.values():
        prev = None
        for dkey in sorted(pdata["data"]):
            rec = pdata["data"][dkey]
            m = to_number(rec.get("num_member"))
            if m == 0 and prev is not None and prev >= 100:
                rec = dict(rec)
                rec["num_member"] = prev
                pdata["data"][dkey] = rec
            else:
                prev = m

    projects = []
    seen = set()
    for item in summary:
        folder = item.get("folder")
        target = ALIASES.get(folder, folder)
        if target not in merged or target in seen:
            continue
        seen.add(target)
        rec_days = sorted(merged[target]["data"].keys())
        projects.append({
            "folder": target,
            "slug": item.get("slug", target),
            "name": item.get("name", target),
            "short": short_name(target, item.get("name", target)),
            "first": iso(rec_days[0]) if rec_days else None,
            "last": iso(rec_days[-1]) if rec_days else None,
        })

    all_days = set()
    for pdata in merged.values():
        all_days |= set(pdata["data"].keys())
    days_raw = sorted(all_days)
    days = [iso(d) for d in days_raw]
    n_days = len(days_raw)

    v24_rows, price_rows = [], []
    v24_total = [0.0] * n_days
    v24_has = [False] * n_days
    active = [0] * n_days
    members_total = [0.0] * n_days
    members_has = [False] * n_days
    mcap_total = [0.0] * n_days
    mcap_has = [False] * n_days
    official_members = [None] * n_days

    for p in projects:
        data = merged[p["folder"]]["data"]
        v24_row = [None] * n_days
        price_row = [None] * n_days
        last_members = None
        for i, dkey in enumerate(days_raw):
            rec = data.get(dkey)
            if rec is not None:
                volume = to_number(rec.get("volume"))
                volume_data = to_number(rec.get("volume_data"))
                # 🔴分析レポートの定義＝生の volume をそのまま合算（欠測ルールは掛けない）。
                #   全体市況（build_overview.py）は volume==volume_data の日を null にするため、
                #   直近30日合計が約1〜3%小さく出る。合体時にどちらへ寄せるかはルク判断（設計.md）。
                v24 = volume
                v24_row[i] = compact(v24)
                if v24 is not None:
                    v24_total[i] += v24
                    v24_has[i] = True
                    if v24 > 0:
                        active[i] += 1
                price_row[i] = compact(to_number(rec.get("current_price")), 2)
                m = to_number(rec.get("num_member"))
                if m is not None:
                    last_members = m
                mc = to_number(rec.get("marketCap"))
                if mc is not None:
                    mcap_total[i] += mc
                    mcap_has[i] = True
                if p["folder"] == OFFICIAL_FOLDER and m is not None:
                    official_members[i] = compact(m)
            # 停止PJは最後の値を据え置き（記録が始まる前は加えない）
            if last_members is not None:
                members_total[i] += last_members
                members_has[i] = True
        v24_rows.append(v24_row)
        price_rows.append(price_row)

    proj_meta = [{k: p[k] for k in ("folder", "slug", "name", "short", "first", "last")} for p in projects]

    series = {
        "days": days,
        "v24_total": [compact(v24_total[i]) if v24_has[i] else None for i in range(n_days)],
        "active": active,
        "members_total": [compact(members_total[i]) if members_has[i] else None for i in range(n_days)],
        "official_members": official_members,
        "mcap_total": [compact(mcap_total[i]) if mcap_has[i] else None for i in range(n_days)],
        "n_projects": len(projects),
        "first_day": days[0] if days else None,
        "latest": days[-1] if days else None,
        "built_at": _dt.datetime.now(_dt.timezone(_dt.timedelta(hours=9))).strftime("%Y-%m-%d %H:%M JST"),
    }
    write_json(os.path.join(OUT_DIR, "series.json"), series)
    write_json(os.path.join(OUT_DIR, "v24.json"), {"days": days, "projects": proj_meta, "rows": v24_rows})
    write_json(os.path.join(OUT_DIR, "price.json"), {"days": days, "projects": proj_meta, "rows": price_rows})

    # 月次＝翌月1日の volume_data（無ければ 2〜5日の最初の値）を前月分とする
    day_index = {d: i for i, d in enumerate(days_raw)}
    record_count = {}
    for pdata in merged.values():
        for k in pdata["data"]:
            record_count[k] = record_count.get(k, 0) + 1
    first_month = days_raw[0][0:6]
    last_month = days_raw[-1][0:6]
    months = []
    y, m = int(first_month[0:4]), int(first_month[4:6])
    while f"{y:04d}{m:02d}" < last_month:  # 最新日の月は途中なので入れない
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
    # 仕様メモ §4・§6：PJごとに「翌月1〜5日のうち最初に volume_data > 0 の日」の値。無ければ 0
    monthly_rows = []
    monthly_totals = [0.0] * len(month_keys)
    for p in projects:
        data = merged[p["folder"]]["data"]
        row = []
        for j, cands in enumerate(month_cands):
            v = 0
            for k in cands:
                rec = data.get(k)
                x = to_number(rec.get("volume_data")) if rec else None
                if x is not None and x > 0:
                    v = x
                    break
            row.append(compact(v))
            monthly_totals[j] += v
        monthly_rows.append(row)
    write_json(os.path.join(OUT_DIR, "monthly.json"), {
        "months": month_keys,
        "picked_days": [iso(c[0]) for c in month_cands],
        "projects": proj_meta,
        "rows": monthly_rows,
        "totals": [compact(t) for t in monthly_totals],
    })

    existing = {p["folder"] for p in projects}
    write_json(os.path.join(OUT_DIR, "bundles.json"), {
        "bundles": [{"key": b["key"], "label": b["label"], "folders": [f for f in b["folders"] if f in existing]} for b in BUNDLES],
        "standalone": [f for f in STANDALONE if f in existing],
        "official": OFFICIAL_FOLDER,
        "aliases": ALIASES,
    })

    print(f"days={n_days} projects={len(projects)} months={len(month_keys)} latest={series['latest']}")
    for fname in ["series.json", "v24.json", "price.json", "monthly.json", "bundles.json"]:
        print(f"  {fname}: {os.path.getsize(os.path.join(OUT_DIR, fname)) / 1024:.1f} KB")


if __name__ == "__main__":
    build()
