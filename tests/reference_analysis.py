"""「分析」タブの期待値を data/history.json から独立に計算する（検証用）。

scripts/build_analysis.py の出力（data/analysis/*.json）は使わず、history.json を
直接読んで分析レポート（2026-09-12）の定義をここでも実装し直す。
tests/check_analysis.js が、この出力と画面の表示値を突き合わせる。

定義（レポート「数字の出どころ・算出式」）:
  - 出来高＝各日の volume（24h出来高・生の記録値）を全PJで合算
  - 週＝終了日を末尾にした暦日7日区切り。出来高が立ったPJ数＝その週に volume>0 の日があるPJ数
  - メンバー＝全PJ合計（停止PJは最後の値を据え置き）
  - 価格上位10＝終了日時点の current_price 上位10。30日前比＝30日前（0なら直前5日）
  - 月次＝翌月1〜5日のうち記録件数が窓の最大の90%以上ある最初の日の volume_data 合算

出力: tests/out/reference_analysis.json
  - fixed_20260911: 終了日 2026-09-11 固定＝レポートの数字（14.97M／11.15M／162.5／163.0／+1,494／3/10）
  - last_30 / last_90 / all: 最新日を終了日にした期間合計と上位10
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


def dkey(d):
    return d.strftime("%Y%m%d")


def main():
    history = json.load(open(os.path.join(DATA_DIR, "history.json"), encoding="utf-8"))
    summary = json.load(open(os.path.join(DATA_DIR, "projects_summary.json"), encoding="utf-8"))
    folders = [it["folder"] for it in summary if it.get("folder") in history]
    short = {}
    for it in summary:
        short[it["folder"]] = it.get("name", it["folder"])

    all_days = sorted({k for f in folders for k in history[f]["data"].keys()})
    first = date(int(all_days[0][0:4]), int(all_days[0][4:6]), int(all_days[0][6:8]))
    latest = date(int(all_days[-1][0:4]), int(all_days[-1][4:6]), int(all_days[-1][6:8]))

    def vol(f, d):
        rec = history[f]["data"].get(dkey(d))
        return to_number(rec.get("volume")) if rec else None

    def total_between(start, end):
        s = 0.0
        per = {}
        d = start
        while d <= end:
            for f in folders:
                v = vol(f, d)
                if v is not None:
                    s += v
                    per[f] = per.get(f, 0.0) + v
            d += timedelta(days=1)
        return s, per

    def active_between(start, end):
        n = 0
        for f in folders:
            d = start
            hit = False
            while d <= end:
                v = vol(f, d)
                if v is not None and v > 0:
                    hit = True
                    break
                d += timedelta(days=1)
            if hit:
                n += 1
        return n

    def members_total_on(target):
        # 停止PJは最後の値を据え置き（target 以前の最後の記録）
        s = 0.0
        for f in folders:
            keys = sorted(k for k in history[f]["data"].keys() if k <= dkey(target))
            if not keys:
                continue
            m = to_number(history[f]["data"][keys[-1]].get("num_member"))
            if m is not None:
                s += m
        return s

    def price_on(f, d):
        rec = history[f]["data"].get(dkey(d))
        return to_number(rec.get("current_price")) if rec else None

    def price_around(f, d):
        for k in range(0, 6):
            v = price_on(f, d - timedelta(days=k))
            if v is not None and v > 0:
                return v
        return None

    def indicators(end):
        last30 = total_between(end - timedelta(days=29), end)
        prev30 = total_between(end - timedelta(days=59), end - timedelta(days=30))
        weeks = []
        for k in range(8):
            we = end - timedelta(days=7 * k)
            weeks.append(active_between(we - timedelta(days=6), we))
        recent4 = sum(weeks[:4]) / 4
        prev4 = sum(weeks[4:8]) / 4
        m_end = members_total_on(end)
        m30 = members_total_on(end - timedelta(days=30))
        m60 = members_total_on(end - timedelta(days=60))
        ranks = sorted(
            [(f, price_on(f, end)) for f in folders if price_on(f, end) and price_on(f, end) > 0],
            key=lambda x: -x[1])[:10]
        up = 0
        for f, p in ranks:
            base = price_around(f, end - timedelta(days=30))
            if base is not None and p > base:
                up += 1
        top2 = sorted(last30[1].items(), key=lambda x: -x[1])[:2]
        return {
            "end": end.isoformat(),
            "last30_total": round(last30[0]),
            "prev30_total": round(prev30[0]),
            "last30_top2": [f for f, _ in top2],
            "weeks_active_recent4_avg": recent4,
            "weeks_active_prev4_avg": prev4,
            "members_last30_net": round(m_end - m30),
            "members_prev30_net": round(m30 - m60),
            "price_top10": [f for f, _ in ranks],
            "price_up_count": up,
        }

    def period(start, end, name):
        tot, per = total_between(start, end)
        ranked = sorted(per.items(), key=lambda x: -x[1])
        return {"start": start.isoformat(), "end": end.isoformat(), "total": round(tot),
                "top10_folders": [f for f, _ in ranked[:10]], "active": active_between(start, end)}

    out = {
        "first_day": first.isoformat(),
        "latest": latest.isoformat(),
        "fixed_20260911": indicators(date(2026, 9, 11)),
        "latest_indicators": indicators(latest),
        "last_30": period(latest - timedelta(days=29), latest, "last_30"),
        "last_90": period(latest - timedelta(days=89), latest, "last_90"),
        "range_20260701_20260731": period(date(2026, 7, 1), date(2026, 7, 31), "jul"),
        "all": period(first, latest, "all"),
    }
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, "reference_analysis.json"), "w", encoding="utf-8") as fp:
        json.dump(out, fp, ensure_ascii=False, indent=1)
    print(json.dumps({k: out[k] for k in ("fixed_20260911", "last_90")}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
