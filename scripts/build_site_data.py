import os
import sys
import json
import re
import time
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

    print("Success! Web data files created under data/")
    print(f"Total projects detailed: {len(projects_summary)}")
    print(f"HTML1 rows: {len(html1_data)}, HTML2 rows: {len(html2_data)}")

if __name__ == "__main__":
    main()
