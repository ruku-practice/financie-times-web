"""合体（v3.2.0・schema 2）の期待値を history.json から独立に計算する（検証用）。

scripts/build_overview.py は import しない・data/overview/ の生成物も読まない。
data/history.json・data/projects_summary.json・docs/analysis_code/window_compare.py の
MERGES（文字列として読むだけ）から、この場でもう一度「名寄せ」「欠測の式（契約C）」
「暦日の期間（契約D）」を実装し直し、check_overview_data.py とは別の実装で期待値を作る。

出力:
  - tests/out/reference_merged.json      : 期間ごとの出来高合計・PJ数・上位10（smooth/raw）・
                                            メンバー純増（smooth/raw）・一斉変動の日 など
  - tests/out/reference_merged_diff.md   : 旧v3.1→名寄せのみ→名寄せ+記録どおり の3段の差分表

実行:
  python3 tests/reference_merged.py
"""

import json
import os
import re
from datetime import date, timedelta

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
OUT_DIR = os.path.join(BASE_DIR, "tests", "out")

HISTORY_PATH = os.path.join(DATA_DIR, "history.json")
SUMMARY_PATH = os.path.join(DATA_DIR, "projects_summary.json")
MAIN_REPO_DIR = os.path.normpath(os.path.join(BASE_DIR, "..", "..", ".."))
WINDOW_COMPARE_PATH = os.path.join(MAIN_REPO_DIR, "docs", "analysis_code", "window_compare.py")
if not os.path.exists(WINDOW_COMPARE_PATH):
    alt = os.path.join(BASE_DIR, "docs", "analysis_code", "window_compare.py")
    if os.path.exists(alt):
        WINDOW_COMPARE_PATH = alt


# ---------- 基本ユーティリティ ----------

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


def extract_merges(text):
    m = re.search(r"MERGES\s*=\s*\[", text)
    if not m:
        return []
    start = m.end() - 1
    depth = 0
    end = None
    for i in range(start, len(text)):
        if text[i] == "[":
            depth += 1
        elif text[i] == "]":
            depth -= 1
            if depth == 0:
                end = i
                break
    block = text[start:end + 1] if end else text[start:start + 2000]
    pairs = re.findall(r"\(\s*['\"]([^'\"]+)['\"]\s*,\s*['\"]([^'\"]+)['\"]\s*\)", block)
    return [tuple(p) for p in pairs]


def dkey_to_date(s):
    return date(int(s[0:4]), int(s[4:6]), int(s[6:8]))


def date_to_dkey(d):
    return d.strftime("%Y%m%d")


def daterange(start, end):
    days = []
    d = start
    while d <= end:
        days.append(d)
        d += timedelta(days=1)
    return days


# ---------- データ読み込み・名寄せ ----------

def load_history():
    with open(HISTORY_PATH, encoding="utf-8") as f:
        return json.load(f)


def load_summary():
    with open(SUMMARY_PATH, encoding="utf-8") as f:
        return json.load(f)


def apply_merges(history, merges):
    """前身のdataを後継へ統合（同じ日付は後継優先）・前身は削除。破壊的にhistoryを変更する。"""
    for a, b in merges:
        if a not in history or b not in history:
            continue
        for d, v in history[a]["data"].items():
            if d not in history[b]["data"]:
                history[b]["data"][d] = v
        del history[a]


# ---------- 出来高（volume）: smooth / raw ----------

def vol_raw(rec):
    if rec is None:
        return None
    return to_number(rec.get("volume"))


def vol_smooth(rec):
    """ならす＝24H=30日一致の日を欠測として値なしにする（v3.1の定義）。"""
    if rec is None:
        return None
    volume = to_number(rec.get("volume"))
    volume_data = to_number(rec.get("volume_data"))
    if volume is not None and volume_data is not None and volume > 0 and volume == volume_data:
        return None
    return volume


def period_volume(history, folders, days_dkeys, mode):
    """指定folders・指定日集合(dkey文字列のリスト)について、出来高合計・アクティブPJ数・
    PJごとの合計を返す。mode: 'smooth' or 'raw'"""
    getter = vol_smooth if mode == "smooth" else vol_raw
    per_folder = {}
    for f in folders:
        data = history[f].get("data", {})
        total = 0.0
        for d in days_dkeys:
            v = getter(data.get(d))
            if v is not None:
                total += v
        per_folder[f] = total
    grand_total = sum(per_folder.values())
    active = sum(1 for v in per_folder.values() if v > 0)
    ranking = sorted(per_folder.items(), key=lambda kv: kv[1], reverse=True)
    top10 = [f for f, _ in ranking[:10]]
    return {"total": grand_total, "active": active, "top10": top10, "per_folder": per_folder}


def period_days(end_d, n, all_dkeys_set):
    """終了日(end_d, date型)からn暦日さかのぼった [start,end] のdkeyリスト（存在する日だけ）。"""
    start_d = end_d - timedelta(days=n - 1)
    all_calendar = daterange(start_d, end_d)
    dkeys = [date_to_dkey(d) for d in all_calendar if date_to_dkey(d) in all_dkeys_set]
    return start_d, end_d, dkeys


def prev_period_days(start_d, n, first_d, all_dkeys_set):
    """前期間＝同じ暦日数の直前。firstより前にかかれば None を返す。"""
    prev_end = start_d - timedelta(days=1)
    prev_start = prev_end - timedelta(days=n - 1)
    if prev_start < first_d:
        return None
    all_calendar = daterange(prev_start, prev_end)
    dkeys = [date_to_dkey(d) for d in all_calendar if date_to_dkey(d) in all_dkeys_set]
    return prev_start, prev_end, dkeys


# ---------- メンバー: smooth（①forward-fill ＋ ②一斉変動）／ raw ----------

def build_member_arrays(history, folders, days_raw):
    """folder→日index配列（raw値・Noneは記録なし）を作る。"""
    day_index = {d: i for i, d in enumerate(days_raw)}
    n = len(days_raw)
    raw = {}
    for f in folders:
        arr = [None] * n
        for dkey, rec in history[f].get("data", {}).items():
            i = day_index.get(dkey)
            if i is None:
                continue
            arr[i] = to_number(rec.get("num_member"))
        raw[f] = arr
    return raw, day_index


def smooth_fill_member_array(arr):
    """契約C①：直前が≥100で0が続き、後で正の値へ戻った区間だけ直前値で埋める。
    nullを挟んだら区間は切れる。戻らない0（停止）は埋めない。"""
    n = len(arr)
    out = list(arr)
    prev_val = None  # 直前の既知の値（0を含む）。Noneはその時点で「区間が切れている」
    i = 0
    while i < n:
        v = arr[i]
        if v is None:
            prev_val = None
            i += 1
            continue
        if v == 0 and prev_val is not None and prev_val >= 100:
            j = i
            while j < n and arr[j] == 0:
                j += 1
            if j < n and arr[j] is not None and arr[j] > 0:
                fill_val = prev_val
                for k in range(i, j):
                    out[k] = fill_val
                prev_val = arr[j]
                i = j + 1
                continue
            else:
                # 戻らない（停止）＝埋めない。生の0のまま進める。
                prev_val = 0
                i += 1
                continue
        else:
            prev_val = v
            i += 1
    return out


def compute_diffs(arr):
    """隣接する「記録がある2点」間の差分。無ければNone。"""
    n = len(arr)
    diffs = [None] * n
    for i in range(1, n):
        if arr[i] is not None and arr[i - 1] is not None:
            diffs[i] = arr[i] - arr[i - 1]
    return diffs


def apply_mass_change_zero(smooth_diffs_by_folder, raw_diffs_by_folder, n_days, threshold_pj=20, threshold_amount=100):
    """契約C②（v3.1 の membersGapInfo と同じ判定）：**生の値の差分**で、100人以上減った（または増えた）PJが
    20件以上の日を一斉変動の日とする（減る側を先に見る）。その日は**生の値で同じ向きに動いた**PJの smooth の増減を0にし、
    逆向きは残す。smooth_diffs_by_folder を書き換え、一斉変動日の一覧を返す。
    （2026-09-13 10:05 修正：①で埋めた値で判定すると 2024-09-12・09-14 が外れ、merged-core／v3.1 と食い違った）"""
    folders = list(smooth_diffs_by_folder.keys())
    events = []
    for i in range(1, n_days):
        neg = [f for f in folders if raw_diffs_by_folder[f][i] is not None and raw_diffs_by_folder[f][i] <= -threshold_amount]
        pos = [f for f in folders if raw_diffs_by_folder[f][i] is not None and raw_diffs_by_folder[f][i] >= threshold_amount]
        if len(neg) >= threshold_pj:
            sign, n_over, direction = -1, len(neg), "down"
        elif len(pos) >= threshold_pj:
            sign, n_over, direction = 1, len(pos), "up"
        else:
            continue
        zeroed = [f for f in folders
                  if raw_diffs_by_folder[f][i] is not None and (raw_diffs_by_folder[f][i] < 0 if sign < 0 else raw_diffs_by_folder[f][i] > 0)
                  and smooth_diffs_by_folder[f][i] is not None]
        impact = sum(smooth_diffs_by_folder[f][i] for f in zeroed)
        for f in zeroed:
            smooth_diffs_by_folder[f][i] = 0
        events.append({"day_index": i, "direction": direction, "n_pj_over_threshold": n_over, "n_pj_zeroed": len(zeroed), "impact": impact})
    return events


def sum_diffs_in_range(diffs_by_folder, day_index_set):
    total = 0.0
    for f, diffs in diffs_by_folder.items():
        for i in day_index_set:
            if diffs[i] is not None:
                total += diffs[i]
    return total


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    history_raw = load_history()
    summary = load_summary()
    window_text = open(WINDOW_COMPARE_PATH, encoding="utf-8").read()
    merges = extract_merges(window_text)

    folders_v31 = [it["folder"] for it in summary if it.get("folder") in history_raw]
    n_pj_v31 = len(folders_v31)

    # ---- 名寄せ後の history（406PJ） ----
    import copy
    history_merged = copy.deepcopy(history_raw)
    apply_merges(history_merged, merges)
    folders_merged = [it["folder"] for it in summary if it.get("folder") in history_merged]
    n_pj_merged = len(folders_merged)

    all_dkeys_merged = sorted({d for f in folders_merged for d in history_merged[f]["data"].keys()})
    all_dkeys_v31 = sorted({d for f in folders_v31 for d in history_raw[f]["data"].keys()})
    all_dkeys_set_merged = set(all_dkeys_merged)
    all_dkeys_set_v31 = set(all_dkeys_v31)

    first_d_merged = dkey_to_date(all_dkeys_merged[0])
    latest_d = dkey_to_date(all_dkeys_merged[-1])

    # ---- 期間の定義 ----
    period_defs = []
    for n in (90, 30, 365):
        period_defs.append({"label": f"latest_{n}", "end": latest_d, "n": n})
    period_defs.append({"label": "all", "end": latest_d, "n": (latest_d - first_d_merged).days + 1})
    period_defs.append({"label": "range_20260701_20260731", "start": date(2026, 7, 1), "end": date(2026, 7, 31)})
    for n in (90, 30):
        period_defs.append({"label": f"fixed20260911_{n}", "end": date(2026, 9, 11), "n": n})

    def resolve_period(pdef, all_dkeys_set, folders, first_d):
        if "start" in pdef:
            start_d, end_d = pdef["start"], pdef["end"]
            n = (end_d - start_d).days + 1
        else:
            end_d = pdef["end"]
            n = pdef["n"]
            start_d = end_d - timedelta(days=n - 1)
        dkeys = [date_to_dkey(d) for d in daterange(start_d, end_d) if date_to_dkey(d) in all_dkeys_set]
        prev = prev_period_days(start_d, n, first_d, all_dkeys_set)
        return start_d, end_d, n, dkeys, prev

    # ---- 3段の出来高集計（旧v3.1／名寄せのみ／名寄せ+記録どおり） ----
    stage_results = {"v31_409_null": {}, "merge_only_406_null": {}, "merge_raw_406_raw": {}}
    period_results = {}

    for pdef in period_defs:
        label = pdef["label"]
        # 406PJ側（名寄せ後）の期間解決を基準に使う
        start_d, end_d, n, dkeys_merged, prev_merged = resolve_period(pdef, all_dkeys_set_merged, folders_merged, first_d_merged)
        _, _, _, dkeys_v31, prev_v31 = resolve_period(pdef, all_dkeys_set_v31, folders_v31, dkey_to_date(all_dkeys_v31[0]))

        smooth_merged = period_volume(history_merged, folders_merged, dkeys_merged, "smooth")
        raw_merged = period_volume(history_merged, folders_merged, dkeys_merged, "raw")
        smooth_v31 = period_volume(history_raw, folders_v31, dkeys_v31, "smooth")

        prev_smooth_merged = None
        prev_raw_merged = None
        if prev_merged:
            _, _, prev_dkeys = prev_merged
            prev_smooth_merged = period_volume(history_merged, folders_merged, prev_dkeys, "smooth")["total"]
            prev_raw_merged = period_volume(history_merged, folders_merged, prev_dkeys, "raw")["total"]
        prev_smooth_v31 = None
        if prev_v31:
            _, _, prev_dkeys_v31 = prev_v31
            prev_smooth_v31 = period_volume(history_raw, folders_v31, prev_dkeys_v31, "smooth")["total"]

        period_results[label] = {
            "start": start_d.isoformat(), "end": end_d.isoformat(), "n_days": n,
            "smooth": {"total": smooth_merged["total"], "active": smooth_merged["active"], "top10": smooth_merged["top10"], "prev_total": prev_smooth_merged},
            "raw": {"total": raw_merged["total"], "active": raw_merged["active"], "top10": raw_merged["top10"], "prev_total": prev_raw_merged},
        }
        stage_results["v31_409_null"][label] = smooth_v31["total"]
        stage_results["merge_only_406_null"][label] = smooth_merged["total"]
        stage_results["merge_raw_406_raw"][label] = raw_merged["total"]

    # ---- メンバー: smooth（①②）／raw ----
    raw_members, day_index = build_member_arrays(history_merged, folders_merged, all_dkeys_merged)
    smooth_arrays = {f: smooth_fill_member_array(raw_members[f]) for f in folders_merged}
    smooth_diffs = {f: compute_diffs(smooth_arrays[f]) for f in folders_merged}
    raw_diffs = {f: compute_diffs(raw_members[f]) for f in folders_merged}

    mass_events = apply_mass_change_zero(smooth_diffs, raw_diffs, len(all_dkeys_merged))

    member_period_results = {}
    for pdef in period_defs:
        label = pdef["label"]
        start_d, end_d, n, dkeys_merged, _ = resolve_period(pdef, all_dkeys_set_merged, folders_merged, first_d_merged)
        idxs = [day_index[d] for d in dkeys_merged]
        smooth_net = sum_diffs_in_range(smooth_diffs, idxs)
        raw_net = sum_diffs_in_range(raw_diffs, idxs)
        member_period_results[label] = {"smooth_net": smooth_net, "raw_net": raw_net}

    # 2026-06-24 の全PJ純増（smooth/raw）
    target = "20260624"
    d0624 = day_index.get(target)
    net_0624_smooth = None
    net_0624_raw = None
    if d0624 is not None:
        net_0624_smooth = sum(smooth_diffs[f][d0624] for f in folders_merged if smooth_diffs[f][d0624] is not None)
        net_0624_raw = sum(raw_diffs[f][d0624] for f in folders_merged if raw_diffs[f][d0624] is not None)

    mass_event_dates = sorted({
        (all_dkeys_merged[e["day_index"]], e["direction"]) for e in mass_events
    })
    mass_events_detail = [
        {"date": f"{d[0][0:4]}-{d[0][4:6]}-{d[0][6:8]}", "direction": d[1]}
        for d in mass_event_dates
    ]

    # ---- 分析レポート再現値チェック（終了2026-09-11・記録どおり） ----
    report_check = {
        "fixed30_raw_total": period_results["fixed20260911_30"]["raw"]["total"],
        "fixed30_raw_prev_total": period_results["fixed20260911_30"]["raw"]["prev_total"],
        "expect_recent_about": 14_970_000,
        "expect_prev_about": 11_150_000,
    }

    out = {
        "merges": merges,
        "n_pj_v31": n_pj_v31,
        "n_pj_merged": n_pj_merged,
        "periods": period_results,
        "member_periods": member_period_results,
        "member_net_20260624": {"smooth": net_0624_smooth, "raw": net_0624_raw},
        "mass_change_days": mass_events_detail,
        "report_reproduction_fixed_20260911": report_check,
    }
    out_path = os.path.join(OUT_DIR, "reference_merged.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"wrote {out_path}")

    # ---- 差の表 ----
    lines = []
    lines.append("# 出来高合計の3段比較（tests/reference_merged.py・独立実装）")
    lines.append("")
    lines.append("| 期間 | 旧v3.1（409PJ・欠測null） | 名寄せのみ（406PJ・欠測null） | 名寄せ+記録どおり（406PJ・生） | 名寄せの差 | 欠測の差 |")
    lines.append("|---|---:|---:|---:|---:|---:|")
    for pdef in period_defs:
        label = pdef["label"]
        a = stage_results["v31_409_null"][label]
        b = stage_results["merge_only_406_null"][label]
        c = stage_results["merge_raw_406_raw"][label]
        merge_diff = b - a
        gap_diff = c - b
        lines.append(f"| {label} | {a:,.0f} | {b:,.0f} | {c:,.0f} | {merge_diff:+,.0f} | {gap_diff:+,.0f} |")
    lines.append("")
    lines.append("- 「名寄せの差」＝名寄せのみ − 旧v3.1（409→406PJ化の影響のみ）")
    lines.append("- 「欠測の差」＝名寄せ+記録どおり − 名寄せのみ（gapの日をnullから生の値に戻した影響のみ）")
    lines.append("")
    lines.append("## 分析レポート再現値（終了2026-09-11・記録どおり）")
    lines.append("")
    lines.append(f"- 直近30日: {report_check['fixed30_raw_total']:,.0f}円（期待 約 {report_check['expect_recent_about']:,}）")
    lines.append(f"- 前30日: {report_check['fixed30_raw_prev_total']:,.0f}円（期待 約 {report_check['expect_prev_about']:,}）")
    lines.append("")
    lines.append("## 一斉変動の日（メンバー・②の判定＝20PJ以上が同じ日に同じ向きへ100人以上）")
    lines.append("")
    if mass_events_detail:
        for e in mass_events_detail:
            lines.append(f"- {e['date']}（{e['direction']}）")
    else:
        lines.append("- 該当なし")
    lines.append("")
    lines.append(f"- 2026-06-24 全PJ純増: smooth={net_0624_smooth:+,.0f} / raw={net_0624_raw:+,.0f}")

    diff_path = os.path.join(OUT_DIR, "reference_merged_diff.md")
    with open(diff_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"wrote {diff_path}")

    # ---- 標準出力にも主要な数字を出す ----
    print(f"n_pj_v31={n_pj_v31} n_pj_merged={n_pj_merged}")
    for label in ("latest_90", "latest_30", "fixed20260911_30", "fixed20260911_90"):
        p = period_results[label]
        print(f"{label}: smooth={p['smooth']['total']:,.0f} raw={p['raw']['total']:,.0f}")
    print(f"member_net_20260624: smooth={net_0624_smooth} raw={net_0624_raw}")
    print(f"mass_change_days: {mass_events_detail}")


if __name__ == "__main__":
    main()
