"""data/overview/*.json（schema 2）の生成物検査（2026-09-13 合体 v3.2.0）。

scripts/build_overview.py の出力を、data/history.json・data/projects_summary.json・
docs/analysis_code/window_compare.py と突き合わせて検査する。失敗したら終了コード1。

結果: tests/out/check_overview_data.json に {"allOk": bool, "results": [{"id","ok","detail"}, ...]}

実行:
  python3 tests/check_overview_data.py
"""

import json
import os
import re
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
OV_DIR = os.path.join(DATA_DIR, "overview")
OUT_DIR = os.path.join(BASE_DIR, "tests", "out")

HISTORY_PATH = os.path.join(DATA_DIR, "history.json")
SUMMARY_PATH = os.path.join(DATA_DIR, "projects_summary.json")
BUILD_OVERVIEW_PATH = os.path.join(BASE_DIR, "scripts", "build_overview.py")
# window_compare.py は本体リポジトリ側（worktree には無い）。
# worktree: <repo>/.claude/worktrees/analysis-tab → 3つ上が <repo>。
MAIN_REPO_DIR = os.path.normpath(os.path.join(BASE_DIR, "..", "..", ".."))
WINDOW_COMPARE_PATH = os.path.join(MAIN_REPO_DIR, "docs", "analysis_code", "window_compare.py")
if not os.path.exists(WINDOW_COMPARE_PATH):
    # 保険：worktree 側にも同名ファイルがあればそちらを使う
    alt = os.path.join(BASE_DIR, "docs", "analysis_code", "window_compare.py")
    if os.path.exists(alt):
        WINDOW_COMPARE_PATH = alt

MAX_BYTES = 25 * 1024 * 1024
EXPECTED_PROJECTS = 406

METRIC_FILES = ["v24.json", "v30.json", "price.json", "members.json", "stock.json", "mcap.json"]
ALL_FILES = ["market.json"] + METRIC_FILES + ["monthly.json", "bundles.json"]

results = []


def check(id_, ok, detail=""):
    results.append({"id": id_, "ok": bool(ok), "detail": detail})


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


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


def round_or_none(value):
    if value is None:
        return None
    if isinstance(value, float) and value == int(value):
        return int(value)
    if isinstance(value, float):
        return round(value, 4)
    return value


def extract_merges(text):
    """MERGES = [ (...), (...) ] のブロックからタプルの文字列を抜き出す（文字列ベース）。"""
    m = re.search(r"MERGES\s*=\s*\[", text)
    if not m:
        return []
    start = m.end() - 1  # position of '['
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


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    # ---- ファイル読み込み ----
    files = {}
    for fname in ALL_FILES:
        path = os.path.join(OV_DIR, fname)
        try:
            files[fname] = load_json(path)
        except FileNotFoundError:
            files[fname] = None
            check(f"file_exists:{fname}", False, "ファイルが無い")

    history = load_json(HISTORY_PATH)
    summary = load_json(SUMMARY_PATH)

    build_text = open(BUILD_OVERVIEW_PATH, encoding="utf-8").read()
    window_text = open(WINDOW_COMPARE_PATH, encoding="utf-8").read()
    build_merges = extract_merges(build_text)
    window_merges = extract_merges(window_text)

    # ---- 1. schema 2・存在するファイルで days・projects が完全一致 ----
    ref_days = None
    ref_projects = None
    days_ok = True
    projects_ok = True
    schema_ok = True
    for fname in ALL_FILES:
        obj = files.get(fname)
        if obj is None:
            continue
        if obj.get("schema") != 2:
            schema_ok = False
        if ref_days is None:
            ref_days = obj.get("days")
            ref_projects = obj.get("projects")
        else:
            if obj.get("days") != ref_days:
                days_ok = False
            if obj.get("projects") != ref_projects:
                projects_ok = False
    check("schema_is_2_all_files", schema_ok, "全ファイル schema==2 であること")
    check("days_identical_across_files", days_ok, "全ファイルの days が完全一致")
    check("projects_identical_across_files", projects_ok, "全ファイルの projects（同じ中身・同じ順）が完全一致")

    # ---- 2. 406PJ ----
    n_proj = len(ref_projects) if ref_projects else 0
    check("project_count_406", n_proj == EXPECTED_PROJECTS, f"projects数={n_proj}（期待{EXPECTED_PROJECTS}）")

    # ---- 3. MERGES 完全一致（build_overview.py vs window_compare.py） ----
    check(
        "merges_match_window_compare",
        build_merges == window_merges and len(build_merges) == 3,
        f"build_overview={build_merges} window_compare={window_merges}",
    )

    # ---- 4. 前身3つが projects に無い ----
    predecessors = {a for a, b in build_merges}
    successors = {b for a, b in build_merges}
    proj_folders = {p["folder"] for p in (ref_projects or [])}
    check(
        "predecessors_not_in_projects",
        len(predecessors & proj_folders) == 0,
        f"projects に残っている前身={predecessors & proj_folders}",
    )
    check(
        "successors_in_projects",
        successors.issubset(proj_folders),
        f"projects に無い後継={successors - proj_folders}",
    )

    # ---- 5. パティスリーと鹿児島タイムズは別々にある ----
    check(
        "patisserie_kagoshima_separate",
        {"345_PatisserieLeVert", "380_kagoshima_times"}.issubset(proj_folders),
        f"両方とも projects にあるか: {'345_PatisserieLeVert' in proj_folders}, {'380_kagoshima_times' in proj_folders}",
    )

    # ---- 6. 後継3つの slug・name が summary の後継行と一致 ----
    summary_by_folder = {it.get("folder"): it for it in summary}
    proj_by_folder = {p["folder"]: p for p in (ref_projects or [])}
    slug_name_ok = True
    slug_name_detail = []
    for a, b in build_merges:
        s = summary_by_folder.get(b)
        p = proj_by_folder.get(b)
        if not s or not p:
            slug_name_ok = False
            slug_name_detail.append(f"{b}: summary或いはprojectsに無い")
            continue
        if p.get("slug") != s.get("slug", b) or p.get("name") != s.get("name", b):
            slug_name_ok = False
            slug_name_detail.append(f"{b}: overview(slug={p.get('slug')},name={p.get('name')}) != summary(slug={s.get('slug')},name={s.get('name')})")
    check("successor_slug_name_from_summary", slug_name_ok, "; ".join(slug_name_detail) or "OK")

    # ---- gap: history.json から独立に数え直した集合と完全一致 ----
    history_copy = json.loads(json.dumps(history))  # 独立コピー（build_overview.py は import しない）
    for a, b in build_merges:
        if a in history_copy and b in history_copy:
            for d, v in history_copy[a]["data"].items():
                if d not in history_copy[b]["data"]:
                    history_copy[b]["data"][d] = v
            del history_copy[a]

    days_raw = ref_days_raw = None
    v24_obj = files.get("v24.json")
    if v24_obj:
        days_raw = [d.replace("-", "") for d in v24_obj["days"]]
        day_index = {d: i for i, d in enumerate(days_raw)}
        projects_list = v24_obj["projects"]

        expected_gap = set()
        for p_idx, p in enumerate(projects_list):
            data = history_copy.get(p["folder"], {}).get("data", {})
            for dkey, rec in data.items():
                if dkey not in day_index:
                    continue
                volume = to_number(rec.get("volume"))
                volume_data = to_number(rec.get("volume_data"))
                if volume is not None and volume_data is not None and volume > 0 and volume == volume_data:
                    expected_gap.add((p_idx, day_index[dkey]))

        actual_gap = set(tuple(x) for x in v24_obj.get("gap", []))
        check(
            "v24_gap_matches_independent_recount",
            expected_gap == actual_gap,
            f"expected={len(expected_gap)} actual={len(actual_gap)} 過不足={len(expected_gap ^ actual_gap)}",
        )

        # ---- v24 rows: 名寄せ後の生の volume と一致（丸め後） ----
        mismatches = 0
        checked = 0
        for p_idx, p in enumerate(projects_list):
            data = history_copy.get(p["folder"], {}).get("data", {})
            row = v24_obj["rows"][p_idx]
            for dkey, i in day_index.items():
                rec = data.get(dkey)
                expected = round_or_none(to_number(rec.get("volume"))) if rec else None
                checked += 1
                if row[i] != expected:
                    mismatches += 1
        check("v24_rows_match_raw_volume", mismatches == 0, f"不一致={mismatches}/{checked}")
    else:
        check("v24_gap_matches_independent_recount", False, "v24.json が無い")
        check("v24_rows_match_raw_volume", False, "v24.json が無い")

    # ---- monthly: picked_day の妥当性 ----
    monthly = files.get("monthly.json")
    if monthly and v24_obj:
        days_iso = monthly["days"]
        months = monthly["months"]
        rows = monthly["rows"]
        picked_day = monthly["picked_day"]
        v30_obj = files.get("v30.json")
        bad = []
        for m_idx, month in enumerate(months):
            y, mm = int(month[0:4]), int(month[5:7])
            ny, nm = (y + 1, 1) if mm == 12 else (y, mm + 1)
            valid_iso = {f"{ny:04d}-{nm:02d}-{dd:02d}" for dd in range(1, 6)}
            for p_idx in range(len(rows)):
                pd = picked_day[p_idx][m_idx]
                val = rows[p_idx][m_idx]
                if pd is None:
                    if val not in (0, None):
                        bad.append(f"pj{p_idx}/{month}: picked_dayなしなのにrows={val}")
                    continue
                if pd < 0 or pd >= len(days_iso):
                    bad.append(f"pj{p_idx}/{month}: picked_day範囲外={pd}")
                    continue
                picked_iso = days_iso[pd]
                if picked_iso not in valid_iso:
                    bad.append(f"pj{p_idx}/{month}: picked_day={picked_iso} は翌月1-5日の範囲外")
                # その日の値が rows と一致
                if v30_obj is not None:
                    v30_val = v30_obj["rows"][p_idx][pd]
                    if round_or_none(v30_val) != round_or_none(val):
                        bad.append(f"pj{p_idx}/{month}: rows={val} != v30[{picked_iso}]={v30_val}")
                # それより前の候補日は volume_data>0 でない
                for cand_iso in sorted(valid_iso):
                    if cand_iso >= picked_iso:
                        continue
                    try:
                        cand_idx = days_iso.index(cand_iso)
                    except ValueError:
                        continue
                    if v30_obj is not None:
                        cand_val = v30_obj["rows"][p_idx][cand_idx]
                        if cand_val is not None and cand_val > 0:
                            bad.append(f"pj{p_idx}/{month}: 候補日{cand_iso}が picked({picked_iso}) より前で volume_data>0")
        check("monthly_picked_day_valid", len(bad) == 0, f"不正={len(bad)}件 例: {bad[:5]}")
    else:
        check("monthly_picked_day_valid", False, "monthly.json または v24.json が無い")

    # ---- 各ファイル 25MiB 未満 ----
    size_ok = True
    size_detail = []
    for fname in ALL_FILES:
        path = os.path.join(OV_DIR, fname)
        if not os.path.exists(path):
            continue
        size = os.path.getsize(path)
        size_detail.append(f"{fname}={size/1024:.1f}KB")
        if size > MAX_BYTES:
            size_ok = False
    check("all_files_under_25mib", size_ok, "; ".join(size_detail))

    all_ok = all(r["ok"] for r in results)
    out = {"allOk": all_ok, "results": results}
    with open(os.path.join(OUT_DIR, "check_overview_data.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    for r in results:
        mark = "OK " if r["ok"] else "NG "
        print(f"{mark}{r['id']}: {r['detail']}")
    print(f"\nallOk={all_ok} ({sum(1 for r in results if r['ok'])}/{len(results)})")

    if not all_ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
