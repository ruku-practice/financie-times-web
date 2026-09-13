#!/bin/bash
# 合体 v3.2.0（feature/analysis-tab＝全体市況＋分析）をステージング Worker「financie-times-analysis-staging」へ
# 配信する出力フォルダを作る。v3.1 のステージング（financie-times-staging）とは別の Worker。
# サイトは /financie/ 配下・history.json 等は除外・25MiB超で停止・noindex。
#
# 使い方:
#   bash scripts/build_analysis_staging.sh            # 出力フォルダを作って OUT= を表示
#   cd "$OUT" && set -a && . ~/.secrets/cloudflare_workers_token.env && set +a && npx wrangler deploy
set -euo pipefail
SRC="${1:-/Users/kkr/ruku_data/00_products/apps/FiNANCiE-times-web/.claude/worktrees/analysis-tab}"
WORKER_NAME="financie-times-analysis-staging"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/an_stg.XXXXXX")"
mkdir -p "$OUT/site/financie"
cp "$SRC/index.html" "$SRC/advanced.html" "$OUT/site/financie/"
cp -R "$SRC/css" "$SRC/js" "$OUT/site/financie/"
rsync -a --exclude 'history.json' --exclude 'history_checkpoint.json' --exclude '2026.xlsx' --exclude 'ranking_daily (1).json' --exclude 'metadata_last_run.txt' --exclude '/analysis/' "$SRC/data/" "$OUT/site/financie/data/"
cat > "$OUT/site/index.html" <<'HTML'
<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="0; url=/financie/"><title>FiNANCiE TIMES merged v3.2.3 (staging)</title></head><body><a href="/financie/">/financie/</a></body></html>
HTML
printf '/*\n  X-Robots-Tag: noindex\n' > "$OUT/site/_headers"
printf 'User-agent: *\nDisallow: /\n' > "$OUT/site/robots.txt"
cat > "$OUT/wrangler.jsonc" <<JSON
{"name":"${WORKER_NAME}","compatibility_date":"2026-09-01","assets":{"directory":"./site","not_found_handling":"404-page"},"workers_dev":true}
JSON
BIG="$(find "$OUT/site" -size +25M -print)"
if [ -n "$BIG" ]; then echo "STOP: 25MiB超のファイルがある"; echo "$BIG"; exit 1; fi
echo "OUT=$OUT"
echo "worker=$WORKER_NAME files=$(find "$OUT/site" -type f | wc -l | tr -d ' ') size=$(du -sh "$OUT/site" | cut -f1)"
