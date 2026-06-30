#!/usr/bin/env python3
"""Update FiNANCiE project metadata for the spreadsheet and web JSON.

This migrates the old nightly local tasks:
- get_sluglist.py: discover newly listed FiNANCiE project slugs
- update_img_url.py: refresh image URLs for rows marked NG or changed og:image
"""

import argparse
import asyncio
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import gspread
import requests
from bs4 import BeautifulSoup
from google.oauth2.service_account import Credentials
from playwright.async_api import TimeoutError as PlaywrightTimeoutError
from playwright.async_api import async_playwright

JST = timezone(timedelta(hours=9))
SPREADSHEET_ID = "1bjBz634jh4xIALM8nJ6G9V9MINWincIdYSUYa3w8qHo"
LIST_SHEET = "list"
SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]
ROOT = Path(__file__).resolve().parents[1]
HISTORY_PATH = ROOT / "data" / "history.json"


def today_key() -> str:
    return datetime.now(JST).strftime("%Y%m%d")


def get_credentials():
    creds_path = os.environ.get("GOOGLE_CREDENTIALS_PATH")
    if creds_path and Path(creds_path).exists():
        return Credentials.from_service_account_file(creds_path, scopes=SCOPES)

    creds_json = os.environ.get("GOOGLE_CREDENTIALS_JSON")
    if creds_json:
        return Credentials.from_service_account_info(json.loads(creds_json), scopes=SCOPES)

    local_path = Path(
        "/Users/kurokzhr/Library/CloudStorage/GoogleDrive-ruku.practice@gmail.com/"
        "マイドライブ/00_XXX_TIMES/00_CreateAutoTimes/100_FiNANCiE/"
        "writeinfo2spreadsheet-d08cec7b431b.json"
    )
    if local_path.exists():
        return Credentials.from_service_account_file(local_path, scopes=SCOPES)

    fallback = ROOT / "writeinfo2spreadsheet-d08cec7b431b.json"
    if fallback.exists():
        return Credentials.from_service_account_file(fallback, scopes=SCOPES)

    raise FileNotFoundError("Google credentials not found")


def open_workbook():
    return gspread.authorize(get_credentials()).open_by_key(SPREADSHEET_ID)


def load_history() -> dict:
    if not HISTORY_PATH.exists():
        return {}
    return json.loads(HISTORY_PATH.read_text(encoding="utf-8"))


def save_history(history: dict) -> None:
    HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    HISTORY_PATH.write_text(
        json.dumps(history, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def retry(callable_, *args, **kwargs):
    delay = 2
    for attempt in range(5):
        try:
            return callable_(*args, **kwargs)
        except Exception:
            if attempt == 4:
                raise
            time.sleep(delay)
            delay = min(delay * 2, 30)


def normalize_row(row: list[str], width: int = 10) -> list[str]:
    return row + [""] * max(0, width - len(row))


def list_records(rows: list[list[str]]) -> list[dict]:
    records = []
    for index, row in enumerate(rows[1:], start=2):
        cells = normalize_row(row)
        slug = cells[1].strip()
        if not slug:
            continue
        records.append(
            {
                "row": index,
                "slug": slug,
                "folder": cells[2].strip() or f"{index - 1}_{slug}",
                "image": cells[4].strip(),
                "name": cells[6].strip() or slug,
                "status": cells[9].strip() if len(cells) > 9 else "",
            }
        )
    return records


def next_empty_slug_row(rows: list[list[str]]) -> int:
    for index, row in enumerate(rows[1:], start=2):
        cells = normalize_row(row)
        if not cells[1].strip():
            return index
    return len(rows) + 1


def fetch_user_info(slug: str, timeout: int = 20) -> tuple[str, str]:
    url = f"https://financie.jp/users/{slug}"
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
        )
    }
    response = requests.get(url, timeout=timeout, headers=headers)
    response.raise_for_status()
    soup = BeautifulSoup(response.text, "html.parser")

    image_tag = soup.find("meta", property="og:image")
    image_url = image_tag.get("content", "").strip() if image_tag else ""

    name_tag = soup.find("span", class_="p-user-info__name")
    if name_tag:
        name = name_tag.get_text(strip=True)
    else:
        title_tag = soup.find("meta", property="og:title")
        name = title_tag.get("content", "").strip() if title_tag else slug

    # og:title は "プロジェクト名 | FiNANCiE" 形式。この接尾辞が付くとランキング側
    # （接尾辞なし）と名前で突合できず、クラシック版で現役PJが全消えする。源流で除去する。
    name = re.sub(r"\s*[|｜]\s*FiNANCiE\s*$", "", name, flags=re.IGNORECASE).strip()

    return image_url, name or slug


def try_fetch_user_info(slug: str) -> tuple[str, str] | None:
    try:
        return fetch_user_info(slug)
    except Exception as exc:
        print(f"  Failed to fetch user info for {slug}: {type(exc).__name__}: {exc}")
        return None


async def maybe_login(page) -> None:
    email = os.environ.get("FINANCIE_EMAIL")
    password = os.environ.get("FINANCIE_PASSWORD")
    if not email or not password:
        print("FINANCIE_EMAIL/PASSWORD not set. Scanning without login.")
        return

    login_url = "https://financie.jp/login/mail"
    await page.goto(login_url, wait_until="domcontentloaded", timeout=60000)

    email_selectors = [
        "input#signin_email",
        "input[name='signin[email]']",
        "input[type='email']",
        "input[type='text']",
    ]
    password_selectors = [
        "input#signin_password",
        "input[name='signin[password]']",
        "input[type='password']",
    ]

    email_field = None
    for selector in email_selectors:
        try:
            email_field = await page.wait_for_selector(selector, timeout=8000, state="visible")
            if email_field:
                break
        except Exception:
            pass
    if not email_field:
        raise RuntimeError("FiNANCiE email field not found")
    await email_field.fill(email)

    password_field = None
    for selector in password_selectors:
        try:
            password_field = await page.wait_for_selector(selector, timeout=8000, state="visible")
            if password_field:
                break
        except Exception:
            pass
    if not password_field:
        raise RuntimeError("FiNANCiE password field not found")
    await password_field.fill(password)

    button = await page.wait_for_selector("button[type='submit'], input[type='submit']", timeout=10000)
    await button.click()
    try:
        await page.wait_for_load_state("domcontentloaded", timeout=20000)
    except PlaywrightTimeoutError:
        pass
    await page.wait_for_timeout(5000)
    print(f"Login attempted. Current URL: {page.url}")


async def discover_slugs(pages: int) -> set[str]:
    slugs: set[str] = set()
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=[
                "--disable-dev-shm-usage",
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-gpu",
                "--disable-extensions",
                "--disable-notifications",
            ],
        )
        page = await browser.new_page(
            viewport={"width": 1920, "height": 1080},
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
            ),
        )
        page.set_default_timeout(60000)
        await maybe_login(page)

        for page_num in range(1, pages + 1):
            url = f"https://financie.jp/home/heroes_list?page={page_num}&tab=recommended_heroes"
            print(f"Scanning page {page_num}/{pages}: {url}")
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=60000)
                try:
                    await page.wait_for_selector("a[href^='/users/']", timeout=30000)
                except PlaywrightTimeoutError:
                    print(f"  No user links found on page {page_num}")
                html = await page.content()
                found = set(re.findall(r'href="/users/([0-9A-Za-z_-]+)', html))
                print(f"  Found {len(found)} slugs")
                slugs.update(found)
                await page.wait_for_timeout(2000)
            except Exception as exc:
                print(f"  Failed page {page_num}: {type(exc).__name__}: {exc}")
        await browser.close()
    return slugs


def append_list_row(worksheet, row_num: int, slug: str, image_url: str, name: str) -> str:
    folder = f"{row_num - 1}_{slug}"
    values = [[
        slug,
        f'=D{row_num}&"_"&B{row_num}',
        str(row_num - 1),
        image_url,
        f'=iferror(image(E{row_num}),"")',
        name,
        f'=HYPERLINK("https://financie.jp/users/{slug}/")',
        f"=CHECK_URL({row_num})",
    ]]
    retry(
        worksheet.update,
        f"B{row_num}:I{row_num}",
        values,
        value_input_option="USER_ENTERED",
    )
    return folder


def create_initial_project_sheet(workbook, folder: str, slug: str) -> None:
    try:
        worksheet = workbook.worksheet(folder)
    except gspread.exceptions.WorksheetNotFound:
        worksheet = workbook.add_worksheet(title=folder, rows=20, cols=1)

    max_column = worksheet.col_count + 1
    now = datetime.now(JST)
    date_key = now.strftime("%Y%m%d")
    values = [
        max_column,
        date_key,
        int(date_key),
        now.strftime("%H:%M"),
        slug,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
    ]
    retry(worksheet.add_cols, 1)
    retry(
        worksheet.update,
        f"{gspread.utils.rowcol_to_a1(1, max_column)}:{gspread.utils.rowcol_to_a1(19, max_column)}",
        [[value] for value in values],
    )


def upsert_history_project(history: dict, folder: str, slug: str, name: str, image_url: str) -> None:
    date_key = today_key()
    project = history.setdefault(
        folder,
        {
            "slug": slug,
            "name": name,
            "logo": image_url,
            "data": {},
        },
    )
    project["slug"] = slug
    project["name"] = name or project.get("name") or slug
    project["logo"] = image_url or project.get("logo", "")
    project.setdefault("data", {})
    project["data"].setdefault(
        date_key,
        {
            "volume": 0,
            "close_price": 0,
            "stock": 0,
            "marketCap": 0,
            "volume_data": 0,
            "num_member": 0,
            "active_ranking": 0,
            "current_price": 0,
        },
    )


def update_history_logo(history: dict, slug: str, image_url: str, name: str | None = None) -> bool:
    changed = False
    for project in history.values():
        if project.get("slug") != slug:
            continue
        if image_url and project.get("logo") != image_url:
            project["logo"] = image_url
            changed = True
        if name and name != slug and project.get("name") != name:
            project["name"] = name
            changed = True
    return changed


def rebuild_site_data(workbook) -> None:
    sys.path.insert(0, str(ROOT / "scripts"))
    import update_daily  # pylint: disable=import-error,import-outside-toplevel

    update_daily.workbook = workbook
    update_daily.build_site_data()


async def main() -> int:
    parser = argparse.ArgumentParser(description="Update FiNANCiE slug and image metadata.")
    parser.add_argument("--pages", type=int, default=15)
    parser.add_argument("--sleep", type=float, default=1.0)
    parser.add_argument("--test", action="store_true", help="Skip spreadsheet writes.")
    parser.add_argument(
        "--skip-image-check",
        action="store_true",
        help="Only discover new slugs; do not refresh existing image URLs.",
    )
    args = parser.parse_args()

    os.chdir(ROOT)
    workbook = open_workbook()
    list_ws = workbook.worksheet(LIST_SHEET)
    rows = retry(list_ws.get_all_values)
    records = list_records(rows)
    existing_slugs = {record["slug"] for record in records}
    print(f"Existing list slugs: {len(existing_slugs)}")

    discovered_slugs = await discover_slugs(args.pages)
    print(f"Discovered slugs: {len(discovered_slugs)}")
    new_slugs = sorted(discovered_slugs - existing_slugs)
    print(f"New slugs: {len(new_slugs)}")

    history = load_history()
    changed = False

    next_row = next_empty_slug_row(rows)
    for slug in new_slugs:
        print(f"Adding new slug: {slug}")
        info = try_fetch_user_info(slug)
        if not info:
            print(f"  Skip new slug because profile metadata was unavailable: {slug}")
            continue
        image_url, name = info
        folder = f"{next_row - 1}_{slug}"
        if not args.test:
            folder = append_list_row(list_ws, next_row, slug, image_url, name)
            create_initial_project_sheet(workbook, folder, slug)
        upsert_history_project(history, folder, slug, name, image_url)
        changed = True
        next_row += 1
        time.sleep(args.sleep)

    if args.skip_image_check:
        print("Skipping existing image URL checks.")
    else:
        print(f"Checking image URLs for {len(records)} existing slugs.")
        for record in records:
            slug = record["slug"]
            marker = " status=NG" if record["status"].upper() == "NG" else ""
            print(f"Checking image URL for {slug} (row {record['row']}{marker})")
            info = try_fetch_user_info(slug)
            if not info:
                time.sleep(args.sleep)
                continue
            image_url, name = info
            if image_url and image_url != record["image"]:
                print(f"  Image changed: {record['image']} -> {image_url}")
                if not args.test:
                    retry(list_ws.update_cell, record["row"], 5, image_url)
                changed = update_history_logo(history, slug, image_url, name) or changed
            else:
                changed = update_history_logo(history, slug, image_url, name) or changed
            time.sleep(args.sleep)

    if changed:
        save_history(history)
    else:
        print("No local history metadata changes.")

    rebuild_site_data(workbook)
    print("Metadata update complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
