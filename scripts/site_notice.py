#!/usr/bin/env python3
"""日付別ランキング上部に出すお知らせ (data/site_notices.json) を管理する。

- new_projects: 新規Slug発見の告知。expires（既定7日）を過ぎると自動で掃除される
- error: 自動更新失敗の告知。expires を持たず、同じ source の成功時に clear-error で消す

GitHub Actions の失敗ステップからも呼ぶため、標準ライブラリのみで動くこと。
"""

import argparse
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

JST = timezone(timedelta(hours=9))
PATH = Path(__file__).resolve().parents[1] / "data" / "site_notices.json"


def today_jst() -> datetime:
    return datetime.now(JST)


def load() -> dict:
    if not PATH.exists():
        return {"notices": []}
    try:
        return json.loads(PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"notices": []}


def save(data: dict) -> None:
    PATH.parent.mkdir(parents=True, exist_ok=True)
    PATH.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def prune(notices: list[dict]) -> list[dict]:
    """期限切れの new_projects を落とす。error は expires を持たないので残る。"""
    today = today_jst().strftime("%Y-%m-%d")
    kept = []
    for n in notices:
        expires = n.get("expires")
        if n.get("type") != "error" and expires and expires < today:
            continue
        kept.append(n)
    return kept


def add_new_projects(projects: list[dict], days: int = 7) -> None:
    """projects = [{"slug": ..., "name": ...}, ...] を1件の告知として追加。"""
    if not projects:
        return
    data = load()
    now = today_jst()
    data["notices"] = prune(data.get("notices", []))
    data["notices"].append(
        {
            "type": "new_projects",
            "date": now.strftime("%Y-%m-%d"),
            "expires": (now + timedelta(days=days)).strftime("%Y-%m-%d"),
            "projects": projects,
        }
    )
    save(data)
    print(f"site_notice: added new_projects notice ({len(projects)} projects)")


def add_error(source: str, run_url: str = "", message: str = "") -> None:
    data = load()
    notices = prune(data.get("notices", []))
    # 同じ source のエラーは1件に保つ（最新で置き換え）
    notices = [n for n in notices if not (n.get("type") == "error" and n.get("source") == source)]
    notices.append(
        {
            "type": "error",
            "source": source,
            "date": today_jst().strftime("%Y-%m-%d %H:%M JST"),
            "message": message
            or f"自動更新（{source}）が失敗しました。表示中の数値が古い可能性があります。",
            "run_url": run_url,
        }
    )
    data["notices"] = notices
    save(data)
    print(f"site_notice: added error notice for {source}")


def clear_error(source: str) -> None:
    data = load()
    before = data.get("notices", [])
    after = [n for n in prune(before) if not (n.get("type") == "error" and n.get("source") == source)]
    if len(after) != len(before):
        data["notices"] = after
        save(data)
        print(f"site_notice: cleared notices for {source} (or pruned expired)")
    else:
        print(f"site_notice: no change for {source}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_new = sub.add_parser("add-new-projects", help="新規プロジェクト発見の告知を追加")
    p_new.add_argument("--project", action="append", default=[], metavar="slug=name")
    p_new.add_argument("--days", type=int, default=7)

    p_err = sub.add_parser("add-error", help="自動更新エラーの告知を追加")
    p_err.add_argument("--source", required=True)
    p_err.add_argument("--run-url", default="")
    p_err.add_argument("--message", default="")

    p_clr = sub.add_parser("clear-error", help="指定 source のエラー告知を消す（期限切れも掃除）")
    p_clr.add_argument("--source", required=True)

    args = parser.parse_args()
    if args.command == "add-new-projects":
        projects = []
        for item in args.project:
            slug, _, name = item.partition("=")
            projects.append({"slug": slug, "name": name or slug})
        add_new_projects(projects, days=args.days)
    elif args.command == "add-error":
        add_error(args.source, run_url=args.run_url, message=args.message)
    elif args.command == "clear-error":
        clear_error(args.source)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
