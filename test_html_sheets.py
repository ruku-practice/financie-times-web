import gspread
from google.oauth2.service_account import Credentials

scope = ['https://www.googleapis.com/auth/spreadsheets','https://www.googleapis.com/auth/drive']
credentials_path = "/Users/kurokzhr/Library/CloudStorage/GoogleDrive-ruku.practice@gmail.com/マイドライブ/00_XXX_TIMES/00_CreateAutoTimes/100_FiNANCiE/writeinfo2spreadsheet-d08cec7b431b.json"
credentials = Credentials.from_service_account_file(credentials_path, scopes=scope)
gc = gspread.authorize(credentials)

key = "1bjBz634jh4xIALM8nJ6G9V9MINWincIdYSUYa3w8qHo"
wb = gc.open_by_key(key)

# HTML1 (出来高順)
try:
    print("--- HTML1 first 10 rows ---")
    ws_html1 = wb.worksheet("HTML1")
    rows1 = ws_html1.get_all_values()
    for idx, row in enumerate(rows1[:10]):
        print(f"Row {idx+1}: {row}")
except Exception as e:
    print("Error loading HTML1:", e)

# HTML2 (メンバー数増順)
try:
    print("\n--- HTML2 first 10 rows ---")
    ws_html2 = wb.worksheet("HTML2")
    rows2 = ws_html2.get_all_values()
    for idx, row in enumerate(rows2[:10]):
        print(f"Row {idx+1}: {row}")
except Exception as e:
    print("Error loading HTML2:", e)
