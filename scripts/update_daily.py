import os
import sys
import json
import re
import argparse
import asyncio
import time
from datetime import datetime, timezone, timedelta

JST = timezone(timedelta(hours=9))


def now_jst():
    return datetime.now(JST)
import gc as sys_gc
import psutil
import math
from playwright.async_api import async_playwright
import gspread
from google.oauth2.service_account import Credentials
from gspread.exceptions import APIError
from google.auth.exceptions import TransportError

# API Scope
scope = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']

# スプレッドシート情報
GS_ID = "1bjBz634jh4xIALM8nJ6G9V9MINWincIdYSUYa3w8qHo"
SLUG_LIST_SHEET = "list"

# クレデンシャル取得ヘルパー
def get_credentials():
    creds_path = os.environ.get("GOOGLE_CREDENTIALS_PATH")
    if creds_path and os.path.exists(creds_path):
        print(f"Using credentials file at: {creds_path}")
        return Credentials.from_service_account_file(creds_path, scopes=scope)

    creds_json = os.environ.get("GOOGLE_CREDENTIALS_JSON")
    if creds_json:
        print("Using credentials from environment variable GOOGLE_CREDENTIALS_JSON")
        info = json.loads(creds_json)
        return Credentials.from_service_account_info(info, scopes=scope)

    local_path = "/Users/kurokzhr/Library/CloudStorage/GoogleDrive-ruku.practice@gmail.com/マイドライブ/00_XXX_TIMES/00_CreateAutoTimes/100_FiNANCiE/writeinfo2spreadsheet-d08cec7b431b.json"
    if not os.path.exists(local_path):
        local_path = "./writeinfo2spreadsheet-d08cec7b431b.json"

    if os.path.exists(local_path):
        print(f"Using credentials file at: {local_path}")
        return Credentials.from_service_account_file(local_path, scopes=scope)

    raise FileNotFoundError(
        "Google service account credentials not found. "
        "Set GOOGLE_CREDENTIALS_PATH, GOOGLE_CREDENTIALS_JSON, or provide key JSON file."
    )


def save_history_meta(date_key):
    meta = {
        "latest_collected": {
            "date": f"{date_key[:4]}-{date_key[4:6]}-{date_key[6:8]}",
            "date_key": date_key,
            "updated_at": now_jst().isoformat(),
        }
    }
    with open("data/history_meta.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)


def save_daily_collected(date_key):
    """各日の取得日時を data/daily_collected.json に追記する。
    タイムトラベル画面が「取得日時」表示に利用する（前日結果の明記用）。"""
    path = "data/daily_collected.json"
    m = {}
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                m = json.load(f)
        except Exception:
            m = {}
    m[date_key] = now_jst().isoformat()
    with open(path, "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False, indent=2)


def already_collected_today():
    today_key = now_jst().strftime("%Y%m%d")
    meta_path = "data/history_meta.json"
    if os.path.exists(meta_path):
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
        if meta.get("latest_collected", {}).get("date_key") == today_key:
            return True
    return False

# グローバルワークブックオブジェクト
workbook = None
gc = None

def convert_1d_to_2d(l, cols):
    return [l[i:i + cols] for i in range(0, len(l), cols)]

# 24H出来高のスクレイピング取得
async def get_24h_volume(page, initial_volume, slug_id):
    max_retries = 5
    for attempt in range(max_retries):
        try:
            element = await page.wait_for_selector('#bancor-chart-types li:nth-child(1)', state='visible', timeout=10000)
            await element.scroll_into_view_if_needed()
            await element.click()
            await page.wait_for_timeout(5000)
            
            element = await page.query_selector('.connector-market-trading-volume')
            volume = (await element.text_content()).replace(',', '')
            
            if volume != initial_volume:
                return volume
            
            await page.wait_for_timeout(5000)
        except Exception as e:
            print(f"[Slug:{slug_id}] 24h取引量の取得でエラー: {e}")
    return initial_volume

# URL遷移リトライ
async def retry_page_goto(page, url, max_retries=5):
    for attempt in range(max_retries):
        try:
            timeout = 45000 + (attempt * 15000)
            await page.goto(url, wait_until='networkidle', timeout=timeout)
            try:
                await page.wait_for_load_state('domcontentloaded', timeout=timeout/2)
                await page.wait_for_load_state('networkidle', timeout=timeout/2)
                await page.wait_for_timeout(3000)
                return True
            except Exception as wait_error:
                print(f"Page load wait error: {wait_error}")
                if attempt < max_retries - 1:
                    await page.reload()
                    await page.wait_for_timeout(5000)
                    continue
        except Exception as e:
            print(f"Page goto error: {e}, attempt: {attempt + 1}/{max_retries}")
            if attempt < max_retries - 1:
                await page.wait_for_timeout(5000)
                try:
                    await page.reload()
                except:
                    pass
            else:
                return False
    return False

# 単一スラッグスクレイピング＆書き出し
async def process_single_slug(browser, slug, sheet_name, test_mode, thread_id, results_dict, zero_member_slugs=None, timeout_slugs=None, max_retries=3):
    context = None
    for retry in range(max_retries):
        try:
            print(f"[Thread {thread_id}] Starting {slug} (attempt {retry+1}/{max_retries})")
            context = await browser.new_context(
                viewport={'width': 1920, 'height': 1080},
                user_agent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            )
            page = await context.new_page()
            page.set_default_timeout(45000)
            page.set_default_navigation_timeout(45000)

            # ユーザーページ
            url = f"https://financie.jp/users/{slug}"
            if not await retry_page_goto(page, url):
                if timeout_slugs is not None:
                    timeout_slugs.append((slug, sheet_name))
                return False

            # 基本データの抽出
            elements = await page.query_selector_all('#script__trading_card_rate')
            if not elements or len(elements) < 2:
                raise Exception("Could not find basic stats elements (#script__trading_card_rate)")

            num_member_text = await elements[0].text_content()
            num_member = int(num_member_text.replace('人', '').replace(',', ''))

            # メンバー数が0の場合はリトライ考慮
            if num_member == 0 and zero_member_slugs is not None and retry < max_retries - 1:
                print(f"[Slug:{slug}] Members count is 0. Waiting to retry...")
                await asyncio.sleep(5)
                continue

            market_cap_text = await elements[1].text_content()
            market_cap = market_cap_text.replace("¥", "").replace(",", "")

            elements_rank = await page.query_selector_all('.c-acr-rank')
            active_ranking = (await elements_rank[0].text_content()).replace('位', '') if elements_rank else "-"

            # マーケット詳細ページ
            volume = 0.0
            close_price = 0.0
            stock = 0
            volume_data = 0.0
            current_price = 0.0

            if market_cap != "0":
                url_market = f"https://financie.jp/communities/{slug}/market"
                if await retry_page_goto(page, url_market):
                    try:
                        # 総株数 (在庫)
                        elements_stock = await page.query_selector_all('.currency.int-part')
                        if elements_stock:
                            stock = int((await elements_stock[0].text_content()).replace(',', ''))
                        
                        # 累計取引量
                        element_volume_data = await page.query_selector('.connector-market-trading-volume')
                        if element_volume_data:
                            volume_data = float((await element_volume_data.text_content()).replace(',', ''))
                        
                        # 前日終値基準価格
                        element_close = await page.query_selector('.connector-price-range-limit-base')
                        if element_close:
                            int_part = await (await element_close.query_selector('.int-part')).text_content()
                            float_part = await (await element_close.query_selector('.float-part')).text_content()
                            close_price = float(f"{int_part}{float_part}".replace(',', ''))
                        
                        # 現在価格
                        element_curr = await page.query_selector('.connector-price')
                        if element_curr:
                            int_part = await (await element_curr.query_selector('.int-part')).text_content()
                            float_part = await (await element_curr.query_selector('.float-part')).text_content()
                            current_price = float(f"{int_part}{float_part}".replace(',', ''))
                        
                        # 24H 取引量
                        volume_raw = await get_24h_volume(page, str(volume_data), slug)
                        volume = float(volume_raw)
                    except Exception as me:
                        print(f"[Slug:{slug}] Market details parsing error: {me}")

            # 結果をスレッドセーフに辞書に格納
            results_dict[slug] = {
                "volume": volume,
                "close_price": close_price,
                "stock": stock,
                "marketCap": int(market_cap) if market_cap.isdigit() else 0,
                "volume_data": volume_data,
                "num_member": num_member,
                "active_ranking": active_ranking,
                "current_price": current_price,
                "sheet_name": sheet_name
            }

            print(f"[Slug:{slug}] Scraping success. Price: {current_price}, Members: {num_member}")
            return True

        except Exception as e:
            print(f"[Slug:{slug}] Processing error: {e}")
            if retry < max_retries - 1:
                await asyncio.sleep(5)
        finally:
            if context:
                await context.close()
            sys_gc.collect()
    
    return False

# 並行スクレイピング
async def scrape_all_projects(projects, thread_count=4):
    results_dict = {}
    zero_member_slugs = []
    timeout_slugs = []

    print(f"Launching browser to scrape {len(projects)} projects...")
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            headless=True,
            args=[
                '--disable-dev-shm-usage',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--disable-extensions',
                '--disable-notifications',
            ]
        )

        semaphore = asyncio.Semaphore(thread_count)

        async def process_with_sem(proj, idx):
            async with semaphore:
                await process_single_slug(
                    browser, proj["slug"], proj["folder"], False,
                    (idx % thread_count) + 1, results_dict,
                    zero_member_slugs, timeout_slugs
                )

        tasks = [asyncio.create_task(process_with_sem(proj, i)) for i, proj in enumerate(projects)]
        await asyncio.gather(*tasks, return_exceptions=True)

        # メンバー数0で失敗したスラッグの再処理
        if zero_member_slugs:
            print(f"Retrying {len(zero_member_slugs)} projects with zero member count after 60s...")
            await asyncio.sleep(60)
            tasks = [asyncio.create_task(process_single_slug(browser, slug, sheet, False, 1, results_dict)) for slug, sheet in zero_member_slugs]
            await asyncio.gather(*tasks, return_exceptions=True)

        # タイムアウト等で失敗したスラッグの再処理
        if timeout_slugs:
            print(f"Retrying {len(timeout_slugs)} timed-out projects after 60s...")
            await asyncio.sleep(60)
            tasks = [asyncio.create_task(process_single_slug(browser, slug, sheet, False, 1, results_dict)) for slug, sheet in timeout_slugs]
            await asyncio.gather(*tasks, return_exceptions=True)

        await browser.close()
    
    return results_dict

# シート名を A1 記法用にクォート（' は '' にエスケープ）
def quote_sheet_name(sheet_name):
    return "'" + str(sheet_name).replace("'", "''") + "'"


def col_letter(col):
    """1始まりの列番号を A1 の列文字に変換（例: 1→A, 27→AA）"""
    return re.sub(r"\d+$", "", gspread.utils.rowcol_to_a1(1, col))


def sheet_a1_range(sheet_name, a1):
    """'シート名'!A1 形式のレンジ文字列を作る"""
    return f"{quote_sheet_name(sheet_name)}!{a1}"


def normalize_date_cell(val):
    """行2の日付セルを YYYYMMDD 文字列に正規化（空なら ""）"""
    if val is None:
        return ""
    # 数値として保存された日付が桁区切り付きで返ることがあるためカンマを落とす
    s = str(val).strip().replace(",", "")
    if re.match(r"^\d{8}(\.0+)?$", s):
        return s.split(".")[0]
    return s


def build_datalist(col_number, data, now=None):
    """1列19行の datalist（意味・並びは現行と同一）"""
    if now is None:
        now = now_jst()
    formatted_date = now.strftime("%Y%m%d")
    today_as_number = int(formatted_date)
    current_time = now.strftime("%H:%M")
    return [
        col_number, formatted_date, today_as_number, current_time, data["sheet_name"],
        0, 0, 0, 0, 0, 0,  # dateTime, dateTime_f, max_price, min_price, avg_price, amount
        data["volume"], data["close_price"], data["stock"],
        data["marketCap"], data["volume_data"], data["num_member"],
        data["active_ranking"], data["current_price"]
    ]


def _retry_sheets_api(func, *args, label="", delays=(2, 5, 15), **kwargs):
    """バッチ API 用の指数バックオフ（最大3回）。成功時は戻り値、3回失敗時は例外を再送出。"""
    last_err = None
    for attempt in range(3):
        try:
            return func(*args, **kwargs)
        except Exception as e:
            last_err = e
            print(f"Sheets API error ({label}, attempt {attempt + 1}/3): {e}")
            if attempt < 2:
                time.sleep(delays[attempt])
    raise last_err


# スプレッドシートへ最新データをバッチ追記（読み取り・列追加・書き込みを束ねる）
def write_all_to_spreadsheet(results, force=False):
    """全プロジェクト分をまとめてスプレッドシートに書き込む。

    - force=False: 最終列の行2が今日ならスキップ（途中再開用）
    - force=True: 最終列の行2が今日ならその列を上書き（列は増やさない）
    - 最終列が今日でない / シート未作成: 右に1列追加して書く（新規は現行同様2列目）
    """
    global workbook
    if not workbook:
        return
    if not results:
        print("Spreadsheet write: no results to write.")
        return

    now = now_jst()
    today_str = now.strftime("%Y%m%d")
    print(f"\n--- Spreadsheet batch write (force={force}, today={today_str}) ---")

    # 1. メタデータ一括取得
    meta = _retry_sheets_api(
        workbook.fetch_sheet_metadata,
        label="fetch_sheet_metadata",
    )
    sheet_meta = {}  # title -> {sheetId, columnCount, rowCount}
    used_sheet_ids = set()
    for s in meta.get("sheets", []):
        props = s.get("properties", {})
        title = props.get("title")
        if title is None:
            continue
        grid = props.get("gridProperties", {}) or {}
        sid = props.get("sheetId")
        if sid is not None:
            used_sheet_ids.add(sid)
        sheet_meta[title] = {
            "sheetId": sid,
            "columnCount": int(grid.get("columnCount") or 1),
            "rowCount": int(grid.get("rowCount") or 1),
        }

    # results をシート名単位に（同一シートが複数来ても最後を採用）
    by_sheet = {}
    for slug, data in results.items():
        sheet_name = data.get("sheet_name")
        if not sheet_name:
            continue
        by_sheet[sheet_name] = data

    # 2. 既存シートの最終列・行2をチャンク読み取り
    existing_names = [n for n in by_sheet if n in sheet_meta]
    last_date_by_sheet = {}  # sheet_name -> YYYYMMDD or ""
    read_chunk = 100
    for i in range(0, len(existing_names), read_chunk):
        chunk_names = existing_names[i:i + read_chunk]
        ranges = []
        for name in chunk_names:
            col = sheet_meta[name]["columnCount"]
            a1 = f"{col_letter(col)}2"
            ranges.append(sheet_a1_range(name, a1))
        print(f"Reading last-column dates: batch {i // read_chunk + 1} ({len(ranges)} ranges)...")
        # UNFORMATTED_VALUE を明示する。既定の FORMATTED_VALUE だと、日付が数値として
        # 保存されているシートで "20,260,727" のように桁区切りが付いて突き合わせに失敗する。
        res = _retry_sheets_api(
            workbook.values_batch_get,
            ranges,
            params={"valueRenderOption": "UNFORMATTED_VALUE"},
            label=f"values_batch_get dates {i // read_chunk + 1}",
        )
        value_ranges = res.get("valueRanges", [])
        for idx, name in enumerate(chunk_names):
            date_val = ""
            if idx < len(value_ranges):
                vals = value_ranges[idx].get("values") or []
                if vals and vals[0]:
                    date_val = normalize_date_cell(vals[0][0])
            last_date_by_sheet[name] = date_val

    # 3. スキップ / force上書き / 列追加 / 新規 に振り分け
    to_skip = []
    to_overwrite = []   # (sheet_name, data, write_col)
    to_append = []      # (sheet_name, data, write_col)  既存シートに列追加
    to_create = []      # (sheet_name, data, write_col)  新規シート

    for sheet_name, data in by_sheet.items():
        if sheet_name not in sheet_meta:
            # 新規: rows=1,cols=1 のあと列を1本足し、2列目に書く（現行と同じ）
            to_create.append((sheet_name, data, 2))
            continue
        last_date = last_date_by_sheet.get(sheet_name, "")
        col_count = sheet_meta[sheet_name]["columnCount"]
        if last_date == today_str:
            if force:
                to_overwrite.append((sheet_name, data, col_count))
            else:
                to_skip.append(sheet_name)
        else:
            to_append.append((sheet_name, data, col_count + 1))

    print(
        f"Plan: append={len(to_append)}, overwrite={len(to_overwrite)}, "
        f"create={len(to_create)}, skip={len(to_skip)}"
    )

    # 4. 構造変更（addSheet / appendDimension）をまとめて1回
    structure_requests = []
    next_sheet_id = (max(used_sheet_ids) + 1) if used_sheet_ids else 1

    for sheet_name, data, write_col in to_create:
        while next_sheet_id in used_sheet_ids:
            next_sheet_id += 1
        sid = next_sheet_id
        used_sheet_ids.add(sid)
        next_sheet_id += 1
        sheet_meta[sheet_name] = {
            "sheetId": sid,
            "columnCount": 1,
            "rowCount": 1,
        }
        structure_requests.append({
            "addSheet": {
                "properties": {
                    "sheetId": sid,
                    "title": sheet_name,
                    "gridProperties": {"rowCount": 1, "columnCount": 1},
                }
            }
        })
        # 列を1本足して2列目に書く
        structure_requests.append({
            "appendDimension": {
                "sheetId": sid,
                "dimension": "COLUMNS",
                "length": 1,
            }
        })
        # 19行分の領域を確保
        structure_requests.append({
            "appendDimension": {
                "sheetId": sid,
                "dimension": "ROWS",
                "length": 18,
            }
        })
        sheet_meta[sheet_name]["columnCount"] = 2
        sheet_meta[sheet_name]["rowCount"] = 19

    for sheet_name, data, write_col in to_append:
        meta_s = sheet_meta[sheet_name]
        sid = meta_s["sheetId"]
        structure_requests.append({
            "appendDimension": {
                "sheetId": sid,
                "dimension": "COLUMNS",
                "length": 1,
            }
        })
        meta_s["columnCount"] = meta_s["columnCount"] + 1
        if meta_s["rowCount"] < 19:
            structure_requests.append({
                "appendDimension": {
                    "sheetId": sid,
                    "dimension": "ROWS",
                    "length": 19 - meta_s["rowCount"],
                }
            })
            meta_s["rowCount"] = 19

    for sheet_name, data, write_col in to_overwrite:
        meta_s = sheet_meta[sheet_name]
        if meta_s["rowCount"] < 19:
            structure_requests.append({
                "appendDimension": {
                    "sheetId": meta_s["sheetId"],
                    "dimension": "ROWS",
                    "length": 19 - meta_s["rowCount"],
                }
            })
            meta_s["rowCount"] = 19

    # 514シート分だと1リクエストが巨大になりタイムアウトしやすいので分割する。
    # ここが落ちると列位置が不定になるため、リトライ後も失敗したら例外を上げて中断する。
    structure_chunk = 200
    if structure_requests:
        print(f"Applying {len(structure_requests)} structure requests (addSheet/appendDimension)...")
        for i in range(0, len(structure_requests), structure_chunk):
            reqs = structure_requests[i:i + structure_chunk]
            _retry_sheets_api(
                workbook.batch_update,
                {"requests": reqs},
                label=f"batch_update structure {i // structure_chunk + 1}",
            )

    # 5. 値書き込み（50件ずつ）。valueInputOption は gspread Worksheet.update のデフォルト RAW に合わせる
    write_jobs = []  # (sheet_name, data, write_col, kind)
    for item in to_append:
        write_jobs.append((*item, "append"))
    for item in to_overwrite:
        write_jobs.append((*item, "overwrite"))
    for item in to_create:
        write_jobs.append((*item, "create"))

    written = 0
    overwritten = 0
    created = 0
    failed = 0
    write_chunk = 50

    for i in range(0, len(write_jobs), write_chunk):
        batch = write_jobs[i:i + write_chunk]
        data_items = []
        for sheet_name, data, write_col, kind in batch:
            datalist = build_datalist(write_col, data, now=now)
            datalist_2d = convert_1d_to_2d(datalist, 1)
            a1 = f"{col_letter(write_col)}1:{col_letter(write_col)}19"
            data_items.append({
                "range": sheet_a1_range(sheet_name, a1),
                "majorDimension": "ROWS",
                "values": datalist_2d,
            })
        body = {
            "valueInputOption": "RAW",
            "data": data_items,
        }
        batch_no = i // write_chunk + 1
        print(f"Writing values batch {batch_no} ({len(batch)} sheets)...")
        try:
            _retry_sheets_api(
                workbook.values_batch_update,
                body,
                label=f"values_batch_update {batch_no}",
            )
            for _sheet_name, _data, _col, kind in batch:
                if kind == "overwrite":
                    overwritten += 1
                elif kind == "create":
                    created += 1
                    written += 1
                else:
                    written += 1
        except Exception as e:
            print(f"Values batch {batch_no} failed after retries: {e}")
            failed += len(batch)
            for sheet_name, _data, _col, kind in batch:
                print(f"  failed: {sheet_name} ({kind})")

    # 新規作成分は「新規書き込み」に含め、サマリは指定フォーマット
    # 新規書き込み = append + create / force上書き = overwrite / スキップ / 失敗
    new_writes = written  # append + create（上で create も written に加算済み）
    print(
        f"Spreadsheet batch write done: "
        f"新規書き込み {new_writes}件 / スキップ {len(to_skip)}件 / "
        f"force上書き {overwritten}件 / 失敗 {failed}件"
    )
    if to_skip and len(to_skip) <= 20:
        print(f"  skipped: {', '.join(to_skip)}")
    elif to_skip:
        print(f"  skipped (sample): {', '.join(to_skip[:10])} ...")

    return failed

# Web表示用JSONを再ビルド
def build_site_data():
    global workbook
    if not workbook:
        print("Workbook not loaded. Cannot fetch HTML1/HTML2 sheets.")
        return

    print("\n--- Starting Web JSON Rebuild ---")
    
    # 1. HTML1, HTML2の生データをロード
    print("Fetching HTML1 and HTML2 sheets data...")
    ranges = [
        "HTML1!A1:S450",
        "HTML2!A1:S450"
    ]
    try:
        res = workbook.values_batch_get(ranges)
        value_ranges = res.get('valueRanges', [])
        html1_raw = value_ranges[0].get('values', []) if len(value_ranges) > 0 else []
        html2_raw = value_ranges[1].get('values', []) if len(value_ranges) > 1 else []
        
        def clean_sheet_data(raw_rows):
            cleaned = []
            for row in raw_rows:
                if not any(cell is not None and str(cell).strip() != "" for cell in row):
                    continue
                cleaned_row = [str(cell).strip() if cell is not None else "" for cell in row]
                cleaned.append(cleaned_row)
            return cleaned

        html1_data = clean_sheet_data(html1_raw)
        html2_data = clean_sheet_data(html2_raw)
    except Exception as e:
        print(f"Error fetching HTML1/HTML2 sheets: {e}")
        return

    # --- データ健全性ガード ---
    # スクレイプがFiNANCiEの認証/エラーページにリダイレクトされた日は、HTML1/HTML2に
    # エラーページのタイトルや終了PJのゴミが入る（例: 2026-06-29 03:18の更新でランキングが
    # GOLF DAO等の終了PJ＋'FinancieWebAuth'に化けた）。その場合 ranking_daily.json を
    # 上書きせず、前回の正常版を保持する（projects_summary は別経路で計算され信頼できるので更新する）。
    ERROR_TITLES = {"FinancieWebAuth", "FiNANCiE - ドリーム・シェアリング・サービス"}

    def looks_broken(html_data):
        rows = html_data[4:] if len(html_data) > 4 else []
        if len(rows) < 5:
            return True  # 行が極端に少ない＝取得失敗
        names = [r[2] for r in rows if len(r) > 2]
        return any(n in ERROR_TITLES for n in names)  # エラーページ混入

    if looks_broken(html1_data) or looks_broken(html2_data):
        print("⚠ HTML1/HTML2 に異常（エラーページ/行数不足）を検出。"
              "ranking_daily.json は前回の正常版を保持します。")
        try:
            prev = json.load(open("data/ranking_daily.json", encoding="utf-8"))
            html1_data = prev.get("html1", html1_data)
            html2_data = prev.get("html2", html2_data)
        except Exception as e:
            print(f"  前回 ranking_daily.json の読込に失敗（保持できず）: {e}")

    # 2. history.json から個別PJの時系列詳細をビルド
    history_path = "data/history.json"
    if not os.path.exists(history_path):
        print(f"History file {history_path} does not exist.")
        return

    with open(history_path, 'r', encoding='utf-8') as f:
        history = json.load(f)

    os.makedirs("data/projects", exist_ok=True)

    projects_summary = []

    all_dates = set()
    for folder, proj in history.items():
        all_dates.update(proj["data"].keys())
    
    sorted_dates = sorted(list(all_dates))
    latest_date = sorted_dates[-1] if sorted_dates else now_jst().strftime("%Y%m%d")

    for folder, proj in history.items():
        slug = proj["slug"]
        name = proj["name"]
        logo = proj["logo"]
        data_map = proj["data"]

        if not data_map:
            continue

        proj_dates = sorted(data_map.keys())
        proj_latest_date = proj_dates[-1]
        latest_info = data_map[proj_latest_date]

        volume = latest_info.get("volume", 0.0)
        current_price = latest_info.get("current_price", 0.0)
        num_member = latest_info.get("num_member", 0)
        stock = latest_info.get("stock", 0)
        marketCap = latest_info.get("marketCap", 0)
        active_ranking = latest_info.get("active_ranking", "-")

        member_change = 0
        if len(proj_dates) > 1:
            current_mem = latest_info.get("num_member", 0)
            prev_info = data_map[proj_dates[-2]]
            prev_mem = prev_info.get("num_member", 0)
            member_change = current_mem - prev_mem

        projects_summary.append({
            "folder": folder,
            "slug": slug,
            "name": name,
            "logo": logo,
            "latest_date": proj_latest_date,
            "price": current_price,
            "volume_24h": volume,
            "members": num_member,
            "member_change_24h": member_change,
            "stock": stock,
            "marketCap": marketCap,
            "active_ranking": active_ranking
        })

        # 個別時系列JSON書き出し
        time_series = []
        for d in proj_dates:
            d_info = data_map[d]
            time_series.append({
                "date": d,
                "price": d_info.get("current_price", 0.0),
                "volume": d_info.get("volume", 0.0),
                "members": d_info.get("num_member", 0),
                "stock": d_info.get("stock", 0),
                "marketCap": d_info.get("marketCap", 0),
                "active_ranking": d_info.get("active_ranking", "-")
            })

        proj_file_path = f"data/projects/{folder}.json"
        with open(proj_file_path, 'w', encoding='utf-8') as f:
            json.dump({
                "folder": folder,
                "slug": slug,
                "name": name,
                "logo": logo,
                "history": time_series
            }, f, ensure_ascii=False, indent=2)

    # 3. 保存
    ranking_daily = {
        "latest_date": latest_date,
        "html1": html1_data,
        "html2": html2_data
    }
    
    with open("data/ranking_daily.json", 'w', encoding='utf-8') as f:
        json.dump(ranking_daily, f, ensure_ascii=False, indent=2)

    with open("data/projects_summary.json", 'w', encoding='utf-8') as f:
        json.dump(projects_summary, f, ensure_ascii=False, indent=2)

    # 4. タイムトラベル用日次ランキングファイル（data/daily/YYYYMMDD.json）の生成
    print("Generating daily historical rankings...")
    os.makedirs("data/daily", exist_ok=True)
    
    daily_data = {}
    for d in sorted_dates:
        daily_data[d] = []

    for folder, proj in history.items():
        slug = proj["slug"]
        name = proj["name"]
        logo = proj["logo"]
        data_map = proj["data"]
        
        proj_dates = sorted(data_map.keys())
        for idx, d in enumerate(proj_dates):
            d_info = data_map[d]
            
            # 各種値の取得
            price = d_info.get("current_price", 0.0)
            volume_24h = d_info.get("volume", 0.0)
            members = d_info.get("num_member", 0)
            stock = d_info.get("stock", 0)
            marketCap = d_info.get("marketCap", 0)
            
            price_diff = 0.0
            volume_24h_diff = 0.0
            members_diff = 0
            stock_diff = 0
            
            if idx > 0:
                prev_d = proj_dates[idx-1]
                prev_info = data_map[prev_d]
                price_diff = price - prev_info.get("current_price", 0.0)
                volume_24h_diff = volume_24h - prev_info.get("volume", 0.0)
                members_diff = members - prev_info.get("num_member", 0)
                stock_diff = stock - prev_info.get("stock", 0)
            
            daily_data[d].append({
                "folder": folder,
                "slug": slug,
                "name": name,
                "logo": logo,
                "price": price,
                "price_diff": round(price_diff, 4),
                "volume_24h": volume_24h,
                "volume_24h_diff": round(volume_24h_diff, 4),
                "members": members,
                "members_diff": members_diff,
                "stock": stock,
                "stock_diff": stock_diff,
                "marketCap": marketCap,
                "active_ranking": d_info.get("active_ranking", "-")
            })
            
    for d, items in daily_data.items():
        daily_file_path = f"data/daily/{d}.json"
        with open(daily_file_path, 'w', encoding='utf-8') as f:
            json.dump(items, f, ensure_ascii=False, indent=2)

    # 5. 月次および累計取引量ランキング（data/monthly/YYYYMM.json ＆ all_time.json）の生成
    print("Generating monthly and all-time volume rankings...")
    os.makedirs("data/monthly", exist_ok=True)
    
    monthly_volumes = {}
    all_time_volumes = {}
    
    for folder, proj in history.items():
        data_map = proj["data"]
        all_time_sum = 0.0
        
        for d, d_info in data_map.items():
            vol = d_info.get("volume", 0.0)
            all_time_sum += vol
            
            if len(d) >= 6:
                ym = d[:6]
                if ym not in monthly_volumes:
                    monthly_volumes[ym] = {}
                if folder not in monthly_volumes[ym]:
                    monthly_volumes[ym][folder] = 0.0
                monthly_volumes[ym][folder] += vol
                
        all_time_volumes[folder] = all_time_sum

    for ym, folder_vols in monthly_volumes.items():
        rank_list = []
        for folder, vol in folder_vols.items():
            if folder not in history:
                continue
            proj_info = history[folder]
            rank_list.append({
                "folder": folder,
                "slug": proj_info["slug"],
                "name": proj_info["name"],
                "logo": proj_info["logo"],
                "total_volume": round(vol, 4)
            })
        
        rank_list.sort(key=lambda x: x["total_volume"], reverse=True)
        for rank_idx, item in enumerate(rank_list):
            item["rank"] = rank_idx + 1
            
        with open(f"data/monthly/{ym}.json", 'w', encoding='utf-8') as f:
            json.dump(rank_list, f, ensure_ascii=False, indent=2)

    all_time_list = []
    for folder, vol in all_time_volumes.items():
        if folder not in history:
            continue
        proj_info = history[folder]
        all_time_list.append({
            "folder": folder,
            "slug": proj_info["slug"],
            "name": proj_info["name"],
            "logo": proj_info["logo"],
            "total_volume": round(vol, 4)
        })
    all_time_list.sort(key=lambda x: x["total_volume"], reverse=True)
    for rank_idx, item in enumerate(all_time_list):
        item["rank"] = rank_idx + 1
        
    with open("data/monthly/all_time.json", 'w', encoding='utf-8') as f:
        json.dump(all_time_list, f, ensure_ascii=False, indent=2)

    monthly_list = sorted(list(monthly_volumes.keys()))
    with open("data/monthly/list.json", 'w', encoding='utf-8') as f:
        json.dump(monthly_list, f, ensure_ascii=False, indent=2)

    print("Success! Web JSON Rebuild Completed.")


# メイン処理
async def main_async():
    parser = argparse.ArgumentParser(description="FiNANCiE TIMES daily updater script.")
    parser.add_argument("--build-only", action="store_true", help="Only rebuild frontend web JSON from history.json, skip scraping.")
    parser.add_argument("--test", action="store_true", help="Run scraping but skip writing to Google Spreadsheet.")
    parser.add_argument("--force", action="store_true", help="Run even if today's data is already collected.")
    parser.add_argument("--threads", type=int, default=4, help="Scraping concurrency threads.")
    args = parser.parse_args()

    if args.build_only:
        build_site_data()
        return

    if not args.force and already_collected_today():
        print("Today's data is already collected. Use --force to run anyway.")
        return

    global workbook, gc
    print("Initializing Google Sheets client...")
    try:
        creds = get_credentials()
        gc = gspread.authorize(creds)
        workbook = gc.open_by_key(GS_ID)
    except Exception as e:
        print(f"Google Sheets init failed: {e}")
        if not args.test:
            print("Cannot proceed without Sheet access. Exit.")
            sys.exit(1)

    # 2. プロジェクトリストの取得
    print("Loading active projects from Spreadsheet...")
    list_ws = workbook.worksheet(SLUG_LIST_SHEET)
    list_data = list_ws.get_all_values()

    projects = []
    for row in list_data[1:]:
        if len(row) > 2 and row[1].strip() and row[2].strip():
            projects.append({
                "slug": row[1].strip(),
                "folder": row[2].strip(),
                "name": row[6].strip() if len(row) > 6 and row[6].strip() else row[1].strip(),
                "logo": row[4].strip() if len(row) > 4 else ""
            })
    print(f"Total active projects: {len(projects)}")

    # 3. スクレイピング実行
    results = await scrape_all_projects(projects, thread_count=args.threads)
    print(f"Scraped stats for {len(results)}/{len(projects)} projects.")

    # 4. スプレッドシート追記 & ローカル history.json の更新
    history_path = "data/history.json"
    if os.path.exists(history_path):
        with open(history_path, 'r', encoding='utf-8') as f:
            history = json.load(f)
    else:
        history = {}

    today_str = now_jst().strftime("%Y%m%d")

    # A. スプレッドシート書き込みは全件まとめて1回（テストモード以外）
    write_failed = 0
    if not args.test:
        write_failed = write_all_to_spreadsheet(results, force=args.force) or 0
    else:
        print(f"[TEST MODE] Skipping Spreadsheet write for {len(results)} projects")

    for slug, data in results.items():
        folder = data["sheet_name"]

        # B. history.json に追記
        if folder not in history:
            # 既存プロジェクトリストのロゴや名前を使用
            proj_info = next((p for p in projects if p["folder"] == folder), None)
            history[folder] = {
                "slug": slug,
                "name": proj_info["name"] if proj_info else folder,
                "logo": proj_info["logo"] if proj_info else "",
                "data": {}
            }
        
        history[folder]["data"][today_str] = {
            "volume": round(data["volume"], 4),
            "close_price": data["close_price"],
            "stock": data["stock"],
            "marketCap": data["marketCap"],
            "volume_data": round(data["volume_data"], 4),
            "num_member": data["num_member"],
            "active_ranking": data["active_ranking"],
            "current_price": data["current_price"]
        }

    print("Saving updated history.json...")
    with open(history_path, 'w', encoding='utf-8') as f:
        json.dump(history, f, ensure_ascii=False, indent=2)

    # シート書き込みに失敗が残っている場合は「本日完了」の印を残さず、異常終了する。
    # こうしないとワークフローの3回リトライが働かないまま成功扱いになり、
    # 翌日まで欠けたシートが埋まらない。リトライ側は当日列スキップがあるので、
    # 書けなかったシートだけを書き直すことになる。
    if write_failed:
        print(f"❌ {write_failed}件のシート書き込みが失敗したままです。history_meta は更新せず異常終了します。")
        sys.exit(1)

    save_history_meta(today_str)
    save_daily_collected(today_str)

    # 5. Web表示用JSONを再ビルド
    build_site_data()
    print("Daily update completed.")

def main():
    asyncio.run(main_async())

if __name__ == "__main__":
    main()
