"""総覧ダッシュボードの期待値を history.json から独立に計算する（検証用）。

build_overview.py の出力（data/overview/*.json）は使わず、data/history.json を
直接読んで同じ欠測ルールをここでも実装し直す。check_overview.js が、この
スクリプトの出力と画面の表示値を突き合わせる。

出力: tests/out/reference.json
"""

import json
import os
from datetime import date, timedelta

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
OUT_DIR = os.path.join(BASE_DIR, "tests", "out")


def to_number(value):
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def load_history():
    with open(os.path.join(DATA_DIR, "history.json"), "r", encoding="utf-8") as f:
        return json.load(f)


def load_summary():
    with open(os.path.join(DATA_DIR, "projects_summary.json"), "r", encoding="utf-8") as f:
        return json.load(f)


def v24_for(rec):
    """欠測ルール込みの24h出来高。null なら None を返す。"""
    volume = to_number(rec.get("volume"))
    volume_data = to_number(rec.get("volume_data"))
    if (
        volume is not None
        and volume_data is not None
        and volume > 0
        and volume == volume_data
    ):
        return None
    return volume


def ymd_to_date(s):
    return date(int(s[0:4]), int(s[4:6]), int(s[6:8]))


def date_to_ymd(d):
    return d.strftime("%Y%m%d")


def daterange_inclusive(start, end):
    days = []
    d = start
    while d <= end:
        days.append(date_to_ymd(d))
        d += timedelta(days=1)
    return days


def period_summary(history, folders, day_keys):
    """指定した日付集合について、プロジェクトごとの v24 合計・日次合計を返す。"""
    day_set = set(day_keys)
    per_project_total = {}
    daily_total = {d: 0.0 for d in day_keys}
    daily_has_any = {d: False for d in day_keys}

    for folder in folders:
        data = history[folder].get("data", {})
        total = 0.0
        has_any = False
        for d in day_keys:
            rec = data.get(d)
            if rec is None:
                continue
            v = v24_for(rec)
            if v is None:
                continue
            total += v
            has_any = True
            daily_total[d] += v
            daily_has_any[d] = True
        per_project_total[folder] = total if has_any else 0.0

    grand_total = sum(per_project_total.values())
    active = sum(1 for v in per_project_total.values() if v > 0)

    ranking = sorted(per_project_total.items(), key=lambda kv: kv[1], reverse=True)

    return {
        "total": grand_total,
        "active_count": active,
        "n_projects": len(folders),
        "ranking": ranking,  # list of (folder, total) desc
        "daily_total": daily_total,
    }


def top_n_share(summary, n):
    top = summary["ranking"][:n]
    top_sum = sum(v for _, v in top)
    total = summary["total"]
    share = (top_sum / total) if total else 0.0
    return {
        "top_folders": [f for f, _ in top],
        "top_sum": top_sum,
        "share": share,
    }


def week_bucket_sum(daily_total):
    """ISO週単位に丸めた合計（全体の合計と一致するはずの検算用）。"""
    buckets = {}
    for d, v in daily_total.items():
        dt = ymd_to_date(d)
        iso_year, iso_week, _ = dt.isocalendar()
        key = f"{iso_year}-W{iso_week:02d}"
        buckets[key] = buckets.get(key, 0.0) + v
    return sum(buckets.values())


def month_bucket_sum(daily_total):
    buckets = {}
    for d, v in daily_total.items():
        key = d[0:6]
        buckets[key] = buckets.get(key, 0.0) + v
    return sum(buckets.values())


def build_reference():
    history = load_history()
    summary = load_summary()
    folders = [p["folder"] for p in summary if p["folder"] in history]

    all_days = sorted(set(d for o in history.values() for d in o["data"].keys()))
    latest = ymd_to_date(all_days[-1])

    def last_n_days(n):
        start = latest - timedelta(days=n - 1)
        return daterange_inclusive(start, latest)

    result = {}

    for label, n in [("last_90", 90), ("last_30", 30)]:
        days = last_n_days(n)
        summ = period_summary(history, folders, days)
        top10 = top_n_share(summ, 10)

        # 前期間比（DBG-1）: 同じ長さの直前の期間の合計と突き合わせるための独立計算。
        prev_end_date = ymd_to_date(days[0]) - timedelta(days=1)
        prev_start_date = prev_end_date - timedelta(days=n - 1)
        prev_days = daterange_inclusive(prev_start_date, prev_end_date)
        prev_summ = period_summary(history, folders, prev_days)
        prev_total_map = dict(prev_summ["ranking"])
        cur_total_map = dict(summ["ranking"])
        top10_diff_pct = []
        for folder in top10["top_folders"]:
            cur = cur_total_map.get(folder, 0.0)
            prev = prev_total_map.get(folder, 0.0)
            pct = None if prev == 0 else ((cur - prev) / prev) * 100.0
            top10_diff_pct.append({"folder": folder, "current": cur, "prev": prev, "pct": pct})

        result[label] = {
            "start": days[0],
            "end": days[-1],
            "n_days": len(days),
            "total": summ["total"],
            "active_count": summ["active_count"],
            "n_projects": summ["n_projects"],
            "top10_folders": top10["top_folders"],
            "top10_share": top10["share"],
            "top10_diff_pct": top10_diff_pct,
            "week_bucket_total": week_bucket_sum(summ["daily_total"]),
            "month_bucket_total": month_bucket_sum(summ["daily_total"]),
        }

    # 任意範囲: 2026-07-01 〜 2026-07-31
    r_start = date(2026, 7, 1)
    r_end = date(2026, 7, 31)
    r_days = daterange_inclusive(r_start, r_end)
    r_days = [d for d in r_days if d in set(all_days)]
    summ = period_summary(history, folders, r_days)
    top10 = top_n_share(summ, 10)
    result["range_20260701_20260731"] = {
        "start": r_days[0] if r_days else None,
        "end": r_days[-1] if r_days else None,
        "n_days": len(r_days),
        "total": summ["total"],
        "active_count": summ["active_count"],
        "n_projects": summ["n_projects"],
        "top10_folders": top10["top_folders"],
        "top10_share": top10["share"],
    }

    result["latest_date"] = date_to_ymd(latest)
    result["total_projects"] = len(folders)

    return result


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    ref = build_reference()
    out_path = os.path.join(OUT_DIR, "reference.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(ref, f, ensure_ascii=False, indent=2)
    print(f"wrote {out_path}")
    print(json.dumps({k: v for k, v in ref.items() if k in ("last_90", "last_30")}, ensure_ascii=False, indent=2)[:2000])
