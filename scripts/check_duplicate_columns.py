#!/usr/bin/env python3
"""スプレッドシート各シートの行2（YYYYMMDD）を読み、同一日付が複数列あるものを列挙する。

読み取り専用。スプレッドシートへは1バイトも書き込まない。
"""

import argparse
import json
import os
import re
from collections import defaultdict
from pathlib import Path

import gspread
from google.oauth2.service_account import Credentials

# update_daily を import すると playwright / psutil まで読み込まれ、
# それらが入っていない環境（手元のMac等）では動かない。
# 診断ツールはどこでも動くべきなので、必要な定数とヘルパーだけをここに複製する。
# ※ GS_ID・scope・認証の探索順・行2の正規化は update_daily.py と一致させること。
GS_ID = "1bjBz634jh4xIALM8nJ6G9V9MINWincIdYSUYa3w8qHo"
SCOPE = ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"]

READ_CHUNK = 100


def get_credentials():
    creds_path = os.environ.get("GOOGLE_CREDENTIALS_PATH")
    if creds_path and os.path.exists(creds_path):
        return Credentials.from_service_account_file(creds_path, scopes=SCOPE)

    creds_json = os.environ.get("GOOGLE_CREDENTIALS_JSON")
    if creds_json:
        return Credentials.from_service_account_info(json.loads(creds_json), scopes=SCOPE)

    local_path = "/Users/kurokzhr/Library/CloudStorage/GoogleDrive-ruku.practice@gmail.com/マイドライブ/00_XXX_TIMES/00_CreateAutoTimes/100_FiNANCiE/writeinfo2spreadsheet-d08cec7b431b.json"
    if not os.path.exists(local_path):
        local_path = "./writeinfo2spreadsheet-d08cec7b431b.json"
    if os.path.exists(local_path):
        return Credentials.from_service_account_file(local_path, scopes=SCOPE)

    raise FileNotFoundError(
        "Google service account credentials not found. "
        "Set GOOGLE_CREDENTIALS_PATH, GOOGLE_CREDENTIALS_JSON, or provide key JSON file."
    )


def quote_sheet_name(sheet_name):
    return "'" + str(sheet_name).replace("'", "''") + "'"


def col_letter(col):
    """1始まりの列番号を A1 の列文字に変換（例: 1→A, 27→AA）"""
    return re.sub(r"\d+$", "", gspread.utils.rowcol_to_a1(1, col))


def sheet_a1_range(sheet_name, a1):
    return f"{quote_sheet_name(sheet_name)}!{a1}"


def normalize_date_cell(val):
    """行2の日付セルを YYYYMMDD 文字列に正規化（空なら ""）"""
    if val is None:
        return ""
    s = str(val).strip().replace(",", "")
    if re.match(r"^\d{8}(\.0+)?$", s):
        return s.split(".")[0]
    return s


def fetch_all_sheet_meta(workbook):
    """fetch_sheet_metadata で title / sheetId / columnCount を取得"""
    meta = workbook.fetch_sheet_metadata()
    sheets = []
    for s in meta.get("sheets", []):
        props = s.get("properties", {}) or {}
        title = props.get("title")
        if title is None:
            continue
        grid = props.get("gridProperties", {}) or {}
        sheets.append({
            "title": title,
            "sheetId": props.get("sheetId"),
            "columnCount": int(grid.get("columnCount") or 1),
            "rowCount": int(grid.get("rowCount") or 1),
        })
    return sheets


def batch_get_row2(workbook, sheets):
    """各シートの行2（A2:最終列2）をチャンク化して values_batch_get"""
    # sheet_title -> list of cell values for row 2 (index 0 = col A)
    row2_by_sheet = {}
    for i in range(0, len(sheets), READ_CHUNK):
        chunk = sheets[i:i + READ_CHUNK]
        ranges = []
        for sh in chunk:
            last = col_letter(sh["columnCount"])
            ranges.append(sheet_a1_range(sh["title"], f"A2:{last}2"))
        print(
            f"Reading row2 batch {i // READ_CHUNK + 1}/"
            f"{(len(sheets) - 1) // READ_CHUNK + 1} ({len(ranges)} ranges)..."
        )
        # 既定の FORMATTED_VALUE だと数値保存の日付に桁区切りが付くため UNFORMATTED_VALUE を明示
        res = workbook.values_batch_get(
            ranges, params={"valueRenderOption": "UNFORMATTED_VALUE"}
        )
        value_ranges = res.get("valueRanges", [])
        for idx, sh in enumerate(chunk):
            vals = []
            if idx < len(value_ranges):
                rows = value_ranges[idx].get("values") or []
                if rows:
                    vals = rows[0]
            row2_by_sheet[sh["title"]] = vals
    return row2_by_sheet


def find_duplicates(row2_values):
    """行2の値リストから YYYYMMDD が2回以上出る日付と列番号（1始まり）を返す。

    戻り値: {date_str: [col_numbers, ...], ...}  （重複がある日付のみ）
    """
    date_to_cols = defaultdict(list)
    for col_idx, raw in enumerate(row2_values):
        date_str = normalize_date_cell(raw)
        if re.match(r"^\d{8}$", date_str):
            date_to_cols[date_str].append(col_idx + 1)
    return {d: cols for d, cols in date_to_cols.items() if len(cols) >= 2}


def main():
    parser = argparse.ArgumentParser(
        description="FiNANCiE TIMES スプレッドシートの重複日付列を読み取り専用で検査する"
    )
    parser.add_argument(
        "--json",
        dest="json_path",
        default=None,
        help="結果を JSON で書き出すパス（省略時は標準出力のみ）",
    )
    args = parser.parse_args()

    print("Initializing Google Sheets client (read-only check)...")
    creds = get_credentials()
    gc = gspread.authorize(creds)
    workbook = gc.open_by_key(GS_ID)

    print("Fetching sheet metadata...")
    sheets = fetch_all_sheet_meta(workbook)
    print(f"Total sheets: {len(sheets)}")

    row2_by_sheet = batch_get_row2(workbook, sheets)

    findings = []  # {sheet, date, columns}
    for sh in sheets:
        title = sh["title"]
        dups = find_duplicates(row2_by_sheet.get(title, []))
        for date_str, cols in sorted(dups.items()):
            findings.append({
                "sheet": title,
                "date": date_str,
                "columns": cols,
            })

    # シート単位の件数
    sheets_with_dups = sorted({f["sheet"] for f in findings})
    # 延べ重複列数: 各重複日付について「余分な列」=(出現回数-1) の合計
    # 仕様: 重複列の列挙が主目的なので、重複に関与した列の総数も出す
    extra_dup_cols = 0  # 2本目以降の列数（本当に余分な本数）
    involved_cols = 0   # 重複に関与した全列数
    for f in findings:
        n = len(f["columns"])
        involved_cols += n
        extra_dup_cols += n - 1

    # 一覧出力
    print("\n=== 重複日付列一覧 ===")
    if not findings:
        print("(なし)")
    else:
        for f in findings:
            cols_str = ", ".join(str(c) for c in f["columns"])
            print(f"{f['sheet']} / {f['date']} / 列 {cols_str}")

    print("\n=== サマリ ===")
    print(f"重複ありシート数: {len(sheets_with_dups)}")
    print(f"全シート数: {len(sheets)}")
    print(f"延べ重複列数（重複に関与した列の合計）: {involved_cols}")
    print(f"余分な列数（各日付の 2 本目以降の合計）: {extra_dup_cols}")

    payload = {
        "spreadsheet_id": GS_ID,
        "total_sheets": len(sheets),
        "sheets_with_duplicates": len(sheets_with_dups),
        "duplicate_findings": findings,
        "involved_column_count": involved_cols,
        "extra_column_count": extra_dup_cols,
        "sheet_names_with_duplicates": sheets_with_dups,
    }

    if args.json_path:
        out_path = Path(args.json_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"\nJSON written to: {out_path}")


if __name__ == "__main__":
    main()
