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

# スプレッドシートへ最新データを追記
def write_to_spreadsheet(sheet_name, data):
    global workbook
    if not workbook:
        return
        
    try:
        ws = workbook.worksheet(sheet_name)
    except gspread.exceptions.WorksheetNotFound:
        print(f"Worksheet '{sheet_name}' not found. Creating new...")
        ws = workbook.add_worksheet(title=sheet_name, rows=1, cols=1)

    max_column = ws.col_count + 1

    now = now_jst()
    formatted_date = now.strftime("%Y%m%d")
    today_as_number = int(formatted_date)
    current_time = now.strftime('%H:%M')

    # get_daily_stats.py の書き出しフォーマット
    datalist = [
        max_column, formatted_date, today_as_number, current_time, data["sheet_name"],
        0, 0, 0, 0, 0, 0,  # dateTime, dateTime_f, max_price, min_price, avg_price, amount
        data["volume"], data["close_price"], data["stock"],
        data["marketCap"], data["volume_data"], data["num_member"],
        data["active_ranking"], data["current_price"]
    ]

    datalist_2d = convert_1d_to_2d(datalist, 1)

    max_retries = 3
    for attempt in range(max_retries):
        try:
            ws.add_cols(1)
            cell_range = gspread.utils.rowcol_to_a1(1, max_column) + ':' + gspread.utils.rowcol_to_a1(19, max_column)
            ws.update(cell_range, datalist_2d)
            print(f"Spreadsheet updated successfully for: {data['sheet_name']}")
            time.sleep(1) # API制限用スリープ
            break
        except Exception as e:
            print(f"Spreadsheet write error ({data['sheet_name']}, attempt {attempt+1}/{max_retries}): {e}")
            time.sleep(5)

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

    for slug, data in results.items():
        folder = data["sheet_name"]
        
        # A. スプレッドシート書き込み (テストモード以外)
        if not args.test:
            print(f"Writing to Google Sheets for {folder}...")
            write_to_spreadsheet(folder, data)
        else:
            print(f"[TEST MODE] Skipping Spreadsheet write for {folder}")

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
    save_history_meta(today_str)

    # 5. Web表示用JSONを再ビルド
    build_site_data()
    print("Daily update completed.")

def main():
    asyncio.run(main_async())

if __name__ == "__main__":
    main()
