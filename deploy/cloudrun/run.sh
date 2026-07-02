#!/usr/bin/env bash
# FiNANCiE TIMES 日次更新（Cloud Run Job のエントリポイント）
# 必要env:
#   GH_TOKEN              … repo push 権限トークン（Secret Manager）
#   GOOGLE_CREDENTIALS_JSON … シート用サービスアカウント鍵の中身（Secret Manager）
set -euo pipefail

REPO="ruku-practice/financie-times-web"
GH_TOKEN="$(printf '%s' "${GH_TOKEN:-}" | tr -d '\r\n[:space:]')"
ORIGIN="https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git"
WORK=/work

echo "==================== $(date) financie daily (cloud run) start ====================="
rm -rf "$WORK"
git clone --quiet "$ORIGIN" "$WORK"
cd "$WORK"
git config user.name  "cloud-run-bot"
git config user.email "cloud-run-bot@users.noreply.github.com"

# シート用サービスアカウント鍵をファイル化
printf '%s' "${GOOGLE_CREDENTIALS_JSON:-}" > /tmp/sa.json
export GOOGLE_CREDENTIALS_PATH=/tmp/sa.json
export PYTHONUNBUFFERED=1

# テストモード: スクレイピングのみ（シート書き込み・push なし）
if [ "${TEST_MODE:-}" = "true" ]; then
  echo "===== TEST_MODE: scripts/update_daily.py --test --force を1回実行、push しない ====="
  python3 scripts/update_daily.py --test --force
  echo "==================== $(date) financie daily TEST done ====================="
  exit 0
fi

# 本番: リトライ付き。--force は付けない（update_daily.py の
# already_collected_today ガードに任せる。収集済みなら正常終了・二重書き込みなし）
ok=0
for a in 1 2 3; do
  echo "----- 試行 $a/3 $(date) -----"
  if python3 scripts/update_daily.py; then ok=1; break; fi
  if [ "$a" -lt 3 ]; then echo "失敗 → 120秒後に再試行"; sleep 120; fi
done
[ "$ok" -eq 1 ] || { echo "❌ 3回とも失敗"; exit 1; }

# データ更新を main へ push
git add data/
if git diff --staged --quiet; then
  echo "変更なし"
else
  git commit -q -m "chore: daily data update $(date -u +%Y-%m-%dT%H:%MZ) [cloud-run]"
  git push --quiet origin HEAD:main
  echo "✓ main に push"
fi

echo "==================== $(date) financie daily done ====================="
