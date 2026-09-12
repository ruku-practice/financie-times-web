"""総覧ダッシュボード用の集計スクリプト（単独実行）。

data/history.json（日×プロジェクトの生データ）と data/projects_summary.json
（folder/slug/name の対応表）から、ブラウザ側で期間・粒度・上位N・その他の
切替を自前でできるよう、指標ごとに「日×プロジェクト」の表を7本書き出す。

出力先: data/overview/
  - market.json  : 全体サマリ（日次合計・アクティブ件数など）
  - v24.json     : 24h出来高（volume）
  - v30.json     : 30日出来高（volume_data）
  - price.json   : 現在価格（current_price）
  - members.json : メンバー数（num_member）
  - stock.json   : トークン在庫（stock）
  - mcap.json    : 時価総額（marketCap）

欠測ルール（重要）:
  volume == volume_data かつ volume > 0 の日は、24h出来高が取得できず
  30日値で埋められた可能性がある（scripts/update_daily.py 104-122, 230行の
  既知の挙動）。この日は v24 を null 扱いにする。数値化できない値も null。

実行:
  python3 scripts/build_overview.py
"""

import json
import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
OUT_DIR = os.path.join(DATA_DIR, "overview")

HISTORY_PATH = os.path.join(DATA_DIR, "history.json")
SUMMARY_PATH = os.path.join(DATA_DIR, "projects_summary.json")


def to_number(value):
    """数値または数値文字列を float に。変換できなければ None。"""
    if value is None:
        return None
    if isinstance(value, bool):
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
    # JSON を小さくするため小数は程よく丸める（整数はそのまま）
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


def build():
    history = load_json(HISTORY_PATH)
    summary = load_json(SUMMARY_PATH)

    os.makedirs(OUT_DIR, exist_ok=True)

    # プロジェクトの並び順は projects_summary.json（現在のランキング順）に合わせる。
    projects = []
    for item in summary:
        folder = item.get("folder")
        if folder not in history:
            continue
        # データ取得開始日（その案件の最古の記録日）＝画面の注記に使う
        rec_days = sorted(history[folder].get("data", {}).keys())
        first_raw = rec_days[0] if rec_days else None
        projects.append({
            "folder": folder,
            "slug": item.get("slug", folder),
            "name": item.get("name", folder),
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

    # 指標ごとの rows を作りながら、market.json 用の集計も同時に積む。
    v24_rows = []
    v30_rows = []
    price_rows = []
    members_rows = []
    stock_rows = []
    mcap_rows = []

    v24_total = [0.0] * n_days
    v24_has_any = [False] * n_days  # その日にv24の有効値が1件でもあるか
    active_count = [0] * n_days     # v24 > 0 の件数
    n_count = [0] * n_days          # その日にレコードそのものがある件数
    members_total = [0.0] * n_days
    members_has_any = [False] * n_days

    for p in projects:
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

            # 欠測ルール: volume == volume_data かつ volume > 0 は null。
            v24_val = volume
            if (
                volume is not None
                and volume_data is not None
                and volume > 0
                and volume == volume_data
            ):
                v24_val = None

            v24_row[i] = round_or_none(v24_val)
            if v24_val is not None:
                v24_total[i] += v24_val
                v24_has_any[i] = True
                if v24_val > 0:
                    active_count[i] += 1

            v30_row[i] = round_or_none(volume_data)
            price_row[i] = round_or_none(to_number(rec.get("current_price")))
            stock_row[i] = round_or_none(to_number(rec.get("stock")))
            mcap_row[i] = round_or_none(to_number(rec.get("marketCap")))

            members_val = to_number(rec.get("num_member"))
            members_row[i] = round_or_none(members_val)
            if members_val is not None:
                members_total[i] += members_val
                members_has_any[i] = True

        v24_rows.append(v24_row)
        v30_rows.append(v30_row)
        price_rows.append(price_row)
        members_rows.append(members_row)
        stock_rows.append(stock_row)
        mcap_rows.append(mcap_row)

    market = {
        "days": days,
        "v24_total": [
            round_or_none(v24_total[i]) if v24_has_any[i] else None
            for i in range(n_days)
        ],
        "active": active_count,
        "n": n_count,
        "members_total": [
            round_or_none(members_total[i]) if members_has_any[i] else None
            for i in range(n_days)
        ],
        "latest": days_raw[-1] if days_raw else None,
        "first_day": days[0] if days else None,
    }

    write_json(os.path.join(OUT_DIR, "market.json"), market)

    proj_meta = [{"folder": p["folder"], "slug": p["slug"], "name": p["name"], "first": p["first"]} for p in projects]

    def write_metric(filename, rows):
        write_json(os.path.join(OUT_DIR, filename), {
            "days": days,
            "projects": proj_meta,
            "rows": rows,
        })

    write_metric("v24.json", v24_rows)
    write_metric("v30.json", v30_rows)
    write_metric("price.json", price_rows)
    write_metric("members.json", members_rows)
    write_metric("stock.json", stock_rows)
    write_metric("mcap.json", mcap_rows)

    print(f"days={n_days} projects={n_projects}")
    for fname in ["market.json", "v24.json", "v30.json", "price.json", "members.json", "stock.json", "mcap.json"]:
        path = os.path.join(OUT_DIR, fname)
        size = os.path.getsize(path)
        print(f"  {fname}: {size / 1024:.1f} KB")


if __name__ == "__main__":
    build()
