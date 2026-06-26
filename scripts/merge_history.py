import os
import sys
import json
import time
import re
import gspread
from google.oauth2.service_account import Credentials

# APIレートリミット対策のためのリトライラッパー
def retry_api_call(func, *args, **kwargs):
    max_retries = 10
    delay = 5
    for attempt in range(max_retries):
        try:
            return func(*args, **kwargs)
        except Exception as e:
            print(f"API Error (attempt {attempt+1}/{max_retries}): {e}")
            if attempt == max_retries - 1:
                raise
            time.sleep(delay)
            # 指数バックオフ、最大60秒
            delay = min(delay * 2, 60)

def main():
    # ディレクトリ作成
    os.makedirs("data", exist_ok=True)
    os.makedirs("scripts", exist_ok=True)

    scope = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']
    credentials_path = "/Users/kurokzhr/Library/CloudStorage/GoogleDrive-ruku.practice@gmail.com/マイドライブ/00_XXX_TIMES/00_CreateAutoTimes/100_FiNANCiE/writeinfo2spreadsheet-d08cec7b431b.json"
    
    if not os.path.exists(credentials_path):
        print(f"Credentials not found at {credentials_path}")
        sys.exit(1)

    print("Authenticating with Google Sheets API...")
    credentials = Credentials.from_service_account_file(credentials_path, scopes=scope)
    gc = gspread.authorize(credentials)

    keys = {
        "2026": "1bjBz634jh4xIALM8nJ6G9V9MINWincIdYSUYa3w8qHo",
        "2025": "1ObSqlX6WhrywERsdYnHi59058AIydgt_UlEyXA005uM",
        "2024": "1mkOJctOSAJRninTTskXBxbXOssYjMJR62bBWjbQUNck"
    }

    # 2026年のワークブックを開いてプロジェクトリストを取得
    print("Fetching active project list from 2026 sheet...")
    wb_2026 = gc.open_by_key(keys["2026"])
    list_ws = wb_2026.worksheet("list")
    list_data = list_ws.get_all_values()

    # listシートの構造:
    # 2列目(index 1): slug
    # 3列目(index 2): folder (個別シート名)
    # 5列目(index 4): logo URL
    # 7列目(index 6): title
    projects = []
    for idx, row in enumerate(list_data[1:]):
        if len(row) > 2 and row[1].strip() and row[2].strip():
            projects.append({
                "slug": row[1].strip(),
                "folder": row[2].strip(),
                "name": row[6].strip() if len(row) > 6 and row[6].strip() else row[1].strip(),
                "logo": row[4].strip() if len(row) > 4 else ""
            })

    print(f"Found {len(projects)} active projects.")

    # 各ワークブックを事前に開いてキャッシュ
    workbooks = {}
    for year, key in keys.items():
        print(f"Opening workbook for {year}...")
        workbooks[year] = gc.open_by_key(key)

    # チェックポイント読み込み
    checkpoint_path = "data/history_checkpoint.json"
    if os.path.exists(checkpoint_path):
        print(f"Loading checkpoint from {checkpoint_path}...")
        with open(checkpoint_path, 'r', encoding='utf-8') as f:
            history = json.load(f)
    else:
        history = {}

    total_projects = len(projects)
    for p_idx, proj in enumerate(projects):
        folder_name = proj["folder"]
        
        # 既に完了しているプロジェクトはスキップ
        if folder_name in history and history[folder_name].get("_completed", False):
            print(f"[{p_idx+1}/{total_projects}] Skipping {folder_name} (already completed)")
            continue

        print(f"\n[{p_idx+1}/{total_projects}] Processing {folder_name} ({proj['name']})...")
        
        proj_data = history.get(folder_name, {
            "slug": proj["slug"],
            "name": proj["name"],
            "logo": proj["logo"],
            "data": {}
        })

        for year, wb in workbooks.items():
            try:
                # ワークシート取得
                ws = retry_api_call(wb.worksheet, folder_name)
                # 全データをロード
                grid = retry_api_call(ws.get_all_values)
                
                if not grid or len(grid) < 2:
                    continue

                date_row = grid[1]  # Row 2 (index 1) が日付行

                for col_idx, val in enumerate(date_row):
                    val = val.strip()
                    # 8桁の数値 (YYYYMMDD) の列を抽出
                    if re.match(r'^\d{8}$', val):
                        date_str = val
                        
                        def get_val(row_idx, default=""):
                            if row_idx < len(grid) and col_idx < len(grid[row_idx]):
                                return grid[row_idx][col_idx].strip()
                            return default
                        
                        # 数値に変換するヘルパー
                        def get_float(row_idx):
                            raw = get_val(row_idx)
                            if not raw: return 0.0
                            try: return float(raw.replace(",", ""))
                            except: return 0.0
                            
                        def get_int(row_idx):
                            raw = get_val(row_idx)
                            if not raw: return 0
                            try: return int(raw.replace(",", ""))
                            except: return 0

                        # volumeの取得とクレンジング
                        volume_raw = get_val(11) # Row 12 (index 11)
                        volume = 0.0
                        if volume_raw:
                            try:
                                volume = float(volume_raw.replace(",", ""))
                                # $10^8$ 以上の値（生値）は 10^18 で除算して補正
                                if volume >= 100000000.0:
                                    volume = volume / (10**18)
                            except:
                                pass

                        close_price = get_float(12)    # Row 13 (index 12)
                        stock = get_int(13)            # Row 14 (index 13)
                        marketCap = get_int(14)        # Row 15 (index 14)
                        volume_data = get_float(15)    # Row 16 (index 15)
                        num_member = get_int(16)        # Row 17 (index 16)
                        active_ranking = get_val(17)   # Row 18 (index 17)
                        current_price = get_float(18)  # Row 19 (index 18)

                        proj_data["data"][date_str] = {
                            "volume": round(volume, 4),
                            "close_price": close_price,
                            "stock": stock,
                            "marketCap": marketCap,
                            "volume_data": round(volume_data, 4),
                            "num_member": num_member,
                            "active_ranking": active_ranking,
                            "current_price": current_price
                        }
                print(f"  Loaded {year} data. Total days now: {len(proj_data['data'])}")
            except gspread.exceptions.WorksheetNotFound:
                # 過去のスプレッドシートにそのプロジェクトがない場合はスキップ
                pass
            except Exception as e:
                print(f"  Error loading {year} for {folder_name}: {e}")

        # このプロジェクトの処理完了
        proj_data["_completed"] = True
        history[folder_name] = proj_data

        # チェックポイントに保存
        with open(checkpoint_path, 'w', encoding='utf-8') as f:
            json.dump(history, f, ensure_ascii=False, indent=2)
            
        # API制限に配慮して少しスリープ
        time.sleep(0.5)

    # 最終的なマージデータの作成 (checkpointファイルから _completed 等のメタデータを除外して出力)
    print("\nProcessing completed. Writing final history.json...")
    final_history = {}
    for folder, proj in history.items():
        if "_completed" in proj:
            del proj["_completed"]
        final_history[folder] = proj

    with open("data/history.json", 'w', encoding='utf-8') as f:
        json.dump(final_history, f, ensure_ascii=False, indent=2)

    print("Success! data/history.json created.")

if __name__ == "__main__":
    main()
