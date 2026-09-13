#!/bin/bash
# =============================================================================
# 合体（全体市況＋分析）v3.2.1 を本番（GitHub Pages）へ出す「押せば出る」スクリプト（release_fix_daily_sort.sh の写し・2026-09-13）
#
#   既定＝ドライラン：何をするかを全部印字して、何も変えない（git fetch だけは行う＝origin の最新を知るため）
#   実行＝  bash scripts/release_merged.sh --execute
#   任意＝  --no-rebuild   origin/main を取り込んだあとの data/overview 再生成を飛ばす
#           --wait MIN     GitHub Pages の反映を待つ上限（分・既定 8）
#
#   🔴 本番に出す前の前提（決裁 A のあとに社長室の指示で行う・このスクリプトは行わない＝満たしていなければ実行で止まる）
#     P1 旧「分析」タブを外している（決裁6＝本番に出さない）＝index.html に data-tab="analysis-tab" が無い
#     P2 毎晩の処理が schema 2 の集計を作る＝.github/workflows/daily.yml と metadata.yml の push の前に
#        scripts/build_overview.py と tests/check_overview_data.py がある（無いと翌朝から data/overview が古いまま）
#     P3 index.html の版（?v=）が下の VERSION と同じ
#
#   やること
#     ①worktree（feature/analysis-tab）に origin/main を取り込む（衝突するなら止まる・stash 禁止）
#     ②data/overview を最新の history.json から作り直し、tests/check_overview_data.py が通ればコミット（--no-rebuild で省略）
#     ③origin/main へ push（fast-forward のみ・force しない）
#     ④GitHub Pages の反映を curl で確認（v=VERSION・合体の JS／CSS の SHA256 一致・data/overview の JSON 200・history.json は状態表示）
#     ⑤progress.md / VERIFIED.md に貼る1行の雛形を印字
#
#   bash 3.2（macOS 標準）で動く。作成 2026-09-13 12:00 JST（社長室28室目・合体の担当）。
# =============================================================================
set -euo pipefail

VERSION="3.2.2"
PRODUCT_DIR="/Users/kkr/ruku_data/00_products/apps/FiNANCiE-times-web"
WORKTREE="$PRODUCT_DIR/.claude/worktrees/analysis-tab"
BRANCH="feature/analysis-tab"
PROD_URL="https://ruku-practice.github.io/financie-times-web"
GIT_ID=(-c user.name=kkr -c user.email=kkr@kkr-MacM5Max.local)
CHECK_FILES="js/merged.js js/merged-core.js js/merged-analysis.js js/overview.js js/advanced.js css/layout.css css/advanced.css"
CHECK_DATA="data/overview/market.json data/overview/v24.json data/overview/members.json data/overview/monthly.json data/overview/bundles.json"

EXECUTE=0
REBUILD=1
WAIT_MIN=8
while [ $# -gt 0 ]; do
  case "$1" in
    --execute) EXECUTE=1 ;;
    --no-rebuild) REBUILD=0 ;;
    --wait) shift; WAIT_MIN="${1:-8}" ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "不明な引数: $1" >&2; exit 2 ;;
  esac
  shift
done

MODE="ドライラン（何も変えない）"
[ "$EXECUTE" = 1 ] && MODE="実行"
now() { TZ=Asia/Tokyo date "+%F %H:%M"; }
say() { printf '%s\n' "$*"; }
plan() { printf '  [予定] %s\n' "$*"; }
stop() { printf '\n🛑 止まりました: %s\n' "$*" >&2; exit 1; }
run() { # 実行モードだけ本当に走らせる
  if [ "$EXECUTE" = 1 ]; then printf '  [実行] %s\n' "$*"; "$@"; else plan "$*"; fi
}

say "=== 合体 v${VERSION} 本番リリース ｜ モード＝${MODE} ｜ $(now) JST ==="
say "worktree: ${WORKTREE}"
say "branch  : ${BRANCH} → origin/main"
say "本番URL : ${PROD_URL}/"
say ""

# ---------- 0. 前提の確認（読むだけ） ----------
[ -d "$WORKTREE/.git" ] || [ -f "$WORKTREE/.git" ] || stop "worktree が見つかりません: ${WORKTREE}"
cd "$WORKTREE"
CUR_BRANCH="$(git branch --show-current)"
[ "$CUR_BRANCH" = "$BRANCH" ] || stop "worktree のブランチが ${BRANCH} ではありません（今: ${CUR_BRANCH}）"
DIRTY="$(git status --porcelain --untracked-files=no)"
[ -z "$DIRTY" ] || stop "worktree に未コミットの変更があります。先にコミットか破棄してください:
${DIRTY}"
say "[確認] worktree はクリーン（追跡ファイルの未コミットなし）・HEAD $(git rev-parse --short HEAD)"

# 本番に出す前の前提 P1〜P3（ドライランでは一覧だけ・実行では1つでも欠けたら止まる）
MISSING=""
if grep -q 'data-tab="analysis-tab"' index.html; then
  MISSING="${MISSING}
  P1 旧「分析」タブがまだ index.html にある（決裁6＝本番に出さない。社長室の指示で外す）"
fi
for wf in .github/workflows/daily.yml .github/workflows/metadata.yml; do
  if ! grep -q "build_overview.py" "$wf" || ! grep -q "check_overview_data.py" "$wf"; then
    MISSING="${MISSING}
  P2 ${wf} の push の前に build_overview.py と check_overview_data.py が無い（翌朝から data/overview が古いまま）"
  fi
done
V_IN_HTML="$(grep -o '?v=[0-9.]*' index.html | sort -u | tr '\n' ' ')"
if [ "$V_IN_HTML" != "?v=${VERSION} " ]; then
  MISSING="${MISSING}
  P3 index.html の版が ${VERSION} にそろっていない（今: ${V_IN_HTML}）"
fi
if [ -n "$MISSING" ]; then
  say "[確認] 🛑 本番に出す前の前提が欠けています:${MISSING}"
  [ "$EXECUTE" = 1 ] && stop "前提 P1〜P3 を満たしてから再実行してください（ドライランは続けて全体の予定を表示します）"
else
  say "[確認] 前提 P1（分析タブなし）・P2（毎晩の集計）・P3（版 ${VERSION}）はそろっている"
fi

MAIN_DIRTY_N="$(git -C "$PRODUCT_DIR" status --porcelain --untracked-files=no | wc -l | tr -d ' ')"
say "[確認] 元フォルダ（main）の未コミット: ${MAIN_DIRTY_N}本（このスクリプトは触りません・stash もしません）"

say "[確認] git fetch origin（remote-tracking の更新だけ・作業ツリーは変えない）"
git fetch --quiet origin
LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse origin/main)"
AHEAD="$(git rev-list --count origin/main..HEAD)"
BEHIND="$(git rev-list --count HEAD..origin/main)"
say "[確認] origin/main=$(git rev-parse --short "$REMOTE_SHA")  この枝は ${AHEAD}本先・${BEHIND}本後ろ"

# ---------- ① origin/main を取り込む ----------
say ""
say "① origin/main を worktree の ${BRANCH} へ取り込む"
if [ "$BEHIND" = 0 ]; then
  say "  origin/main はこの枝の祖先＝取り込み不要（fast-forward で push できます）"
else
  if git merge-tree --write-tree --quiet "$LOCAL_SHA" "$REMOTE_SHA" >/dev/null 2>&1; then
    say "  衝突なし（merge-tree で判定）＝origin/main の ${BEHIND}本（毎晩のデータ更新など）を merge で取り込みます"
    say "  取り込む中身:"; git log --oneline HEAD..origin/main | sed 's/^/    /'
    run git "${GIT_ID[@]}" merge --no-edit --no-ff -m "merge: origin/main を取り込み（合体 v${VERSION} リリース前）" origin/main
  else
    say "  衝突するファイル:"; git merge-tree --write-tree "$LOCAL_SHA" "$REMOTE_SHA" 2>/dev/null | sed -n '2,40p' | sed 's/^/    /' || true
    stop "origin/main との取り込みで衝突します。worktree で手で解決してから再実行してください（元フォルダは触らないこと）"
  fi
fi

# ---------- ② data/overview の作り直し＋生成物の検査 ----------
say ""
if [ "$REBUILD" = 1 ]; then
  say "② data/overview を最新の history.json から作り直す（build_overview.py → check_overview_data.py）"
  if [ "$EXECUTE" = 1 ]; then
    python3 scripts/build_overview.py | sed 's/^/    /'
    python3 tests/check_overview_data.py | tail -3 | sed 's/^/    /' || stop "tests/check_overview_data.py が通りません（data/overview はコミットしていません）"
    if [ -n "$(git status --porcelain -- data/overview)" ]; then
      git add -- data/overview
      git "${GIT_ID[@]}" commit --quiet -m "chore: 総覧データ（data/overview・schema 2）を再生成（$(now) JST・合体 v${VERSION} リリース前）"
      say "  [実行] 再生成分をコミット $(git rev-parse --short HEAD)"
    else
      say "  再生成しても変化なし＝コミットしない"
    fi
  else
    plan "python3 scripts/build_overview.py → python3 tests/check_overview_data.py（通らなければ止まる）→ 変化があれば data/overview をコミット"
  fi
else
  say "② data/overview の作り直しは --no-rebuild で省略（総覧のデータは history.json の日付で止まります）"
fi

# ---------- ③ push ----------
say ""
say "③ origin/main へ push（fast-forward のみ・force しない）"
if git merge-base --is-ancestor "$REMOTE_SHA" HEAD || { [ "$EXECUTE" != 1 ] && [ "$BEHIND" != 0 ]; }; then
  run git push origin "HEAD:main"
else
  stop "origin/main が HEAD の祖先ではありません（①の取り込みが必要）"
fi
PUSHED_SHA="$(git rev-parse HEAD)"

# ---------- ④ GitHub Pages の反映確認 ----------
say ""
say "④ GitHub Pages の反映を確認（最大 ${WAIT_MIN}分・30秒ごと）"
local_sha() { shasum -a 256 "$1" | cut -c1-16; }
LOCAL_SHAS="$(for f in $CHECK_FILES; do printf '%s=%s ' "$f" "$(local_sha "$f")"; done)"
if [ "$EXECUTE" = 1 ]; then
  DEADLINE=$(( $(date +%s) + WAIT_MIN * 60 ))
  OK=0
  PUB_SHAS=""
  while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    V="$(curl -s "${PROD_URL}/?r=${RANDOM}" | grep -o 'v=[0-9.]*' | sort -u | tr '\n' ' ' || true)"
    PUB_SHAS="$(for f in $CHECK_FILES; do printf '%s=%s ' "$f" "$(curl -sL "${PROD_URL}/${f}?v=${VERSION}&r=${RANDOM}" | shasum -a 256 | cut -c1-16)"; done)"
    if [ "$V" = "v=${VERSION} " ] && [ "$PUB_SHAS" = "$LOCAL_SHAS" ]; then OK=1; break; fi
    say "  … まだ（$(now)）: index=${V} js/css=${PUB_SHAS}"
    sleep 30
  done
  [ "$OK" = 1 ] || stop "時間内に本番へ反映されませんでした。gh run list --workflow=pages-build-deployment を確認してください"
  DATA_CODES="$(for f in $CHECK_DATA; do printf '%s=%s ' "${f##*/}" "$(curl -s -o /dev/null -w '%{http_code}' "${PROD_URL}/${f}")"; done)"
  HISTORY="$(curl -s -o /dev/null -w '%{http_code}' "${PROD_URL}/data/history.json")"
  ANALYSIS_TAB="$(curl -s "${PROD_URL}/?r=${RANDOM}" | grep -c 'data-tab="analysis-tab"' || true)"
  say "  ✅ 本番 ${PROD_URL}/ ＝ v=${VERSION}・SHA256 一致（${PUB_SHAS}）・${DATA_CODES}・history.json ${HISTORY}（現状維持）・分析タブの釦 ${ANALYSIS_TAB}件"
  if printf '%s' "$DATA_CODES" | tr ' ' '\n' | grep -v '^$' | grep -qv '=200$'; then stop "data/overview の JSON に 200 以外があります: ${DATA_CODES}"; fi
  [ "$ANALYSIS_TAB" = 0 ] || stop "本番に分析タブの釦が残っています（${ANALYSIS_TAB}件）"
else
  plan "curl ${PROD_URL}/ に v=${VERSION}（ほかの版なし）・${CHECK_FILES} の SHA256 が一致するまで待つ"
  plan "${CHECK_DATA} が全部 200・history.json は状態表示・分析タブの釦が0件"
  say "  （いまの手元の SHA256: ${LOCAL_SHAS}）"
fi

# ---------- ⑤ 雛形 ----------
say ""
say "⑤ 記録の雛形（progress.md と VERIFIED.md に貼る）"
say "--- progress.md（## 進捗ログ（2026-09） の先頭に）---"
say "- $(now) JST｜稼働中｜ **合体（全体市況＋分析）v${VERSION} を本番（GitHub Pages）へ反映**（コミット $(git rev-parse --short "$PUSHED_SHA")・scripts/release_merged.sh） ／ 検証：curl で ${PROD_URL}/ に v=${VERSION}・合体の JS／CSS の SHA256 一致・data/overview の JSON 200 ／ 次：翌朝の定期実行で data/overview が更新されるかを確認"
say "--- VERIFIED.md（表に1行）---"
say "| ✅ 合体（全体市況＋分析）v${VERSION} を本番（GitHub Pages）へ反映 | $(TZ=Asia/Tokyo date +%F) | コミット \`$(git rev-parse --short "$PUSHED_SHA")\`・\`scripts/release_merged.sh --execute\`。curl：\`${PROD_URL}/\` に \`v=${VERSION}\`・${CHECK_FILES} の SHA256 一致・data/overview の JSON 200 |"
say ""
if [ "$EXECUTE" = 1 ]; then
  say "=== 完了 $(now) JST ==="
else
  say "=== ドライラン終了（何も変えていません）。実行は: bash scripts/release_merged.sh --execute ==="
fi
