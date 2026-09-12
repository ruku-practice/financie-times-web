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
    # 名寄せ（仕様メモ §3・後継優先）と メンバー0落ちの前値埋め（§4）＝ window_compare.py と同じ
    MERGES = [("214_red_tokyo_premium", "404_TEAMRED"), ("226_yamamotosyoten", "373_yamamotoshoten"),
              ("383_Otoyume_Panda", "408_g3b5137c8ead142f995528051be2fa72a"), ("345_PatisserieLeVert", "380_kagoshima_times")]
    for a, b in MERGES:
        if a in history and b in history:
            for d, v in history[a]["data"].items():
                if d not in history[b]["data"]:
                    history[b]["data"][d] = v
            del history[a]
    for f, v in history.items():
        prev = None
        for d in sorted(v["data"]):
            m = to_number(v["data"][d].get("num_member"))
            if m == 0 and prev is not None and prev >= 100:
                v["data"][d] = dict(v["data"][d]); v["data"][d]["num_member"] = prev
            else:
                prev = m
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

    def indicators(end, W=30):
        """機運の5指標＝仕様メモ §6-2＋窓 W（window_compare.py と同じ定義）"""
        ra, rb = end - timedelta(days=W - 1), end
        pa, pb = end - timedelta(days=2 * W - 1), end - timedelta(days=W)
        ha = end - timedelta(days=W // 2 - 1)
        rec = total_between(ra, rb)
        prv = total_between(pa, pb)
        h2 = total_between(ha, rb)[0]
        h1 = total_between(ra, ha - timedelta(days=1))[0]
        n_rec = active_between(ra, rb)
        n_prv = active_between(pa, pb)
        m_now = members_total_on(rb)
        m_w = members_total_on(pb)
        m_2w = members_total_on(pa - timedelta(days=1))
        ranks = sorted(
            [(f, price_on(f, end)) for f in folders if price_on(f, end) and price_on(f, end) > 0],
            key=lambda x: -x[1])[:10]
        up = 0
        for f, p in ranks:
            base = price_around(f, end - timedelta(days=W))
            if base is not None and p > base:
                up += 1
        top2 = sorted(rec[1].items(), key=lambda x: -x[1])[:2]
        ok = [rec[0] / prv[0] - 1 >= 0.20 if prv[0] > 0 else False,
              h2 > h1 if h1 > 0 else False,
              n_rec / n_prv - 1 >= 0.10 if n_prv > 0 else False,
              (m_now - m_w) > (m_w - m_2w) and (m_now - m_w) > 0,
              up >= 6]
        return {
            "end": end.isoformat(), "W": W,
            "recent_total": round(rec[0]), "prev_total": round(prv[0]),
            "half2_total": round(h2), "half1_total": round(h1),
            "recent_top2": [f for f, _ in top2],
            "active_recent": n_rec, "active_prev": n_prv,
            "members_recent_net": round(m_now - m_w), "members_prev_net": round(m_w - m_2w),
            "price_top10": [f for f, _ in ranks], "price_up_count": up,
            "ok": ok, "count": sum(ok),
        }

    # 週次の「出来高が立ったPJ数」（レポート v1 の図2・4週vs4週の参考値）
    def weekly_active(end, n):
        return [active_between(end - timedelta(days=7 * k + 6), end - timedelta(days=7 * k)) for k in range(n)]

    def period(start, end, name):
        tot, per = total_between(start, end)
        ranked = sorted(per.items(), key=lambda x: -x[1])
        return {"start": start.isoformat(), "end": end.isoformat(), "total": round(tot),
                "top10_folders": [f for f, _ in ranked[:10]], "active": active_between(start, end)}

    wk = weekly_active(date(2026, 9, 11), 8)
    out = {
        "first_day": first.isoformat(),
        "latest": latest.isoformat(),
        "fixed_20260911": {"W30": indicators(date(2026, 9, 11), 30), "W90": indicators(date(2026, 9, 11), 90), "W180": indicators(date(2026, 9, 11), 180),
                           "weeks_active_recent4_avg": sum(wk[:4]) / 4, "weeks_active_prev4_avg": sum(wk[4:8]) / 4},
        "latest_indicators": {"W30": indicators(latest, 30), "W90": indicators(latest, 90), "W180": indicators(latest, 180)},
        "last_30": period(latest - timedelta(days=29), latest, "last_30"),
        "last_90": period(latest - timedelta(days=89), latest, "last_90"),
        "range_20260701_20260731": period(date(2026, 7, 1), date(2026, 7, 31), "jul"),
        "all": period(first, latest, "all"),
    }
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, "reference_analysis.json"), "w", encoding="utf-8") as fp:
        json.dump(out, fp, ensure_ascii=False, indent=1)
    for W in ("W30", "W90", "W180"):
        f = out["fixed_20260911"][W]; l = out["latest_indicators"][W]
        print(W, "fixed:", f["count"], f["ok"], f["recent_total"], f["prev_total"], "| latest:", l["count"], l["ok"])
    print("weeks", out["fixed_20260911"]["weeks_active_recent4_avg"], out["fixed_20260911"]["weeks_active_prev4_avg"], "last_90", out["last_90"]["total"], out["last_90"]["active"])


if __name__ == "__main__":
    main()
