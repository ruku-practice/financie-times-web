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

    os.makedirs("data", exist_ok=True)

    # 1. 2026年のワークブックを開いてプロジェクトリストを取得
    print("Fetching active project list from 2026 sheet...")
    wb_2026 = gc.open_by_key(keys["2026"])
    list_ws = wb_2026.worksheet("list")
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

    print(f"Found {len(projects)} active projects.")

    # データの初期化
    history = {}
    for proj in projects:
        history[proj["folder"]] = {
            "slug": proj["slug"],
            "name": proj["name"],
            "logo": proj["logo"],
            "data": {}
        }

    # 各ワークブックからデータをバッチ取得してマージ
    batch_size = 50

    for year, file_id in keys.items():
        print(f"\n--- Loading {year} Spreadsheet (Key: {file_id}) ---")
        wb = gc.open_by_key(file_id)
        
        # 存在するワークシート名一覧を取得してキャッシュ
        print("Caching worksheets list...")
        sheets_list = [ws.title for ws in wb.worksheets()]
        print(f"Total worksheets in {year}: {len(sheets_list)}")
        
        # このスプレッドシートに存在するプロジェクトのシート範囲リストを作成
        valid_ranges = []
        folder_to_proj = {}
        for proj in projects:
            folder = proj["folder"]
            if folder in sheets_list:
                # 最初の20行、列はAからZZまで取得 (ZZ=702列)
                valid_ranges.append(f"'{folder}'!A1:ZZ20")
                folder_to_proj[folder] = proj

        print(f"Requesting data for {len(valid_ranges)} worksheets...")

        # バッチ分割して取得
        for i in range(0, len(valid_ranges), batch_size):
            batch = valid_ranges[i:i + batch_size]
            print(f"Fetching batch {i // batch_size + 1}/{(len(valid_ranges) - 1) // batch_size + 1} ({len(batch)} sheets)...")
            
            try:
                res = retry_api_call(wb.values_batch_get, batch)
                value_ranges = res.get('valueRanges', [])
                
                for vr in value_ranges:
                    range_name = vr.get('range', '')
                    # シート名抽出 (例: "'cryptoninjagames'!A1:ZZ20" -> "cryptoninjagames")
                    match = re.match(r"^'?([^'!]+)'?!", range_name)
                    if not match:
                        continue
                    folder_name = match.group(1)
                    
                    rows = vr.get('values', [])
                    if len(rows) < 2:
                        continue
                        
                    date_row = rows[1] # Row 2 (index 1) が日付
                    
                    # 日付パターン一致列をスキャン
                    for col_idx, val in enumerate(date_row):
                        if val is None:
                            continue
                        val_str = str(val).strip()
                        if re.match(r'^\d{8}$', val_str):
                            date_str = val_str
                            
                            # 安全に値を取得するヘルパー
                            def get_val(row_idx):
                                if row_idx < len(rows) and col_idx < len(rows[row_idx]):
                                    v = rows[row_idx][col_idx]
                                    return v if v is not None else ""
                                return ""

                            # 数値変換ヘルパー
                            def get_float(row_idx):
                                v = get_val(row_idx)
                                if v == "": return 0.0
                                try: return float(str(v).replace(",", ""))
                                except: return 0.0
                                
                            def get_int(row_idx):
                                v = get_val(row_idx)
                                if v == "": return 0
                                try: return int(float(str(v).replace(",", "")))
                                except: return 0

                            # volumeの取得とクレンジング
                            volume_raw = get_val(11) # Row 12 (index 11)
                            volume = 0.0
                            if volume_raw != "":
                                try:
                                    volume = float(str(volume_raw).replace(",", ""))
                                    if volume >= 100000000.0:
                                        volume = volume / (10**18)
                                except:
                                    pass

                            close_price = get_float(12)    # Row 13 (index 12)
                            stock = get_int(13)            # Row 14 (index 13)
                            marketCap = get_int(14)        # Row 15 (index 14)
                            volume_data = get_float(15)    # Row 16 (index 15)
                            num_member = get_int(16)        # Row 17 (index 16)
                            active_ranking = str(get_val(17)).strip() # Row 18 (index 17)
                            current_price = get_float(18)  # Row 19 (index 18)

                            # マージ
                            history[folder_name]["data"][date_str] = {
                                "volume": round(volume, 4),
                                "close_price": close_price,
                                "stock": stock,
                                "marketCap": marketCap,
                                "volume_data": round(volume_data, 4),
                                "num_member": num_member,
                                "active_ranking": active_ranking,
                                "current_price": current_price
                            }
            except Exception as e:
                print(f"Error fetching batch {i // batch_size + 1}: {e}")
            
            # API制限対策で少しスリープ
            time.sleep(1)

    print("\nWriting data/history.json...")
    with open("data/history.json", 'w', encoding='utf-8') as f:
        json.dump(history, f, ensure_ascii=False, indent=2)
    print("Success! data/history.json generated.")

if __name__ == "__main__":
    main()
