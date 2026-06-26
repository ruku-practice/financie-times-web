import os
import sys
import json
import re
import time
from datetime import datetime
import gspread
from google.oauth2.service_account import Credentials

def retry_api_call(func, *args, **kwargs):
    max_retries = 5
    delay = 3
    for attempt in range(max_retries):
        try:
            return func(*args, **kwargs)
        except Exception as e:
            print(f"API Error (attempt {attempt+1}/{max_retries}): {e}")
            if attempt == max_retries - 1:
                raise
            time.sleep(delay)
            delay = min(delay * 2, 30)

def main():
    scope = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']
    credentials_path = "/Users/kurokzhr/Library/CloudStorage/GoogleDrive-ruku.practice@gmail.com/マイドライブ/00_XXX_TIMES/00_CreateAutoTimes/100_FiNANCiE/writeinfo2spreadsheet-d08cec7b431b.json"

    # GitHub Actions環境変数対応
    creds_json = os.environ.get("GOOGLE_CREDENTIALS_JSON")
    if creds_json:
        info = json.loads(creds_json)
        credentials = Credentials.from_service_account_info(info, scopes=scope)
    elif os.path.exists(credentials_path):
        credentials = Credentials.from_service_account_file(credentials_path, scopes=scope)
    else:
        # カレントディレクトリフォールバック
        credentials = Credentials.from_service_account_file("./writeinfo2spreadsheet-d08cec7b431b.json", scopes=scope)

    gc = gspread.authorize(credentials)

    key = "1bjBz634jh4xIALM8nJ6G9V9MINWincIdYSUYa3w8qHo"
    wb = gc.open_by_key(key)

    # 1. HTML1, HTML2のデータをスプレッドシートからそのままロード
    print("Loading HTML1 and HTML2 sheets from Spreadsheet...")
    
    # 450行分取得 (全プロジェクトをカバー)
    ranges = [
        "HTML1!A1:S450",
        "HTML2!A1:S450"
    ]
    
    try:
        res = retry_api_call(wb.values_batch_get, ranges)
        value_ranges = res.get('valueRanges', [])
        
        # HTML1データの抽出
        html1_raw = value_ranges[0].get('values', []) if len(value_ranges) > 0 else []
        # HTML2データの抽出
        html2_raw = value_ranges[1].get('values', []) if len(value_ranges) > 1 else []
        
        # 不要な空行・空セルのトリミング
        def clean_sheet_data(raw_rows):
            cleaned = []
            for row in raw_rows:
                # 完全に空の行はスキップ
                if not any(cell is not None and str(cell).strip() != "" for cell in row):
                    continue
                # 各セルの空白トリム
                cleaned_row = [str(cell).strip() if cell is not None else "" for cell in row]
                cleaned.append(cleaned_row)
            return cleaned

        html1_data = clean_sheet_data(html1_raw)
        html2_data = clean_sheet_data(html2_raw)

    except Exception as e:
        print(f"Error loading HTML1/HTML2: {e}")
        sys.exit(1)

    # 2. 従来通り history.json から高機能版用の個別PJ時系列JSONをビルド
    history_path = "data/history.json"
    if not os.path.exists(history_path):
        print(f"History file {history_path} does not exist. Please run merge_history_batch.py first.")
        sys.exit(1)

    print("Loading history.json to build project time-series details...")
    with open(history_path, 'r', encoding='utf-8') as f:
        history = json.load(f)

    # 出力用ディレクトリ
    os.makedirs("data/projects", exist_ok=True)

    projects_summary = []
    
    # 全ての日付リストを抽出して最新の日付を特定する
    all_dates = set()
    for folder, proj in history.items():
        all_dates.update(proj["data"].keys())
    
    sorted_dates = sorted(list(all_dates))
    latest_date = sorted_dates[-1] if sorted_dates else datetime.now().strftime("%Y%m%d")

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

        # PJ サマリー情報の追加 (検索用)
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

        # 個別PJの時系列データを軽量化して出力
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

    # 3. ファイルの保存
    # ランキングファイル保存 (スプレッドシートの生データをそのまま書き出し)
    ranking_daily = {
        "latest_date": latest_date,
        "html1": html1_data,
        "html2": html2_data
    }
    
    with open("data/ranking_daily.json", 'w', encoding='utf-8') as f:
        json.dump(ranking_daily, f, ensure_ascii=False, indent=2)

    # サマリーファイル保存
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

    print("Success! Web data files created under data/")
    print(f"Total projects detailed: {len(projects_summary)}")
    print(f"HTML1 rows: {len(html1_data)}, HTML2 rows: {len(html2_data)}")

if __name__ == "__main__":
    main()
