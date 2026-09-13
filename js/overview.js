/* ============================================================
 * FiNANCiE TIMES 全体市況タブ（Dune型ダッシュボード） v3.2.0
 *
 * advanced.js が読み込まれたあとに読み込まれる想定（同じドキュメント内の
 * 別スクリプトなので、トップレベルの let/const は共有される）。
 * advanced.js 側からは window.FinancieOverview.onShow() を1回だけ呼んでもらう。
 * ============================================================ */

(function () {
  "use strict";

  const OV_APP_VERSION = "3.2.3";

  // 出来高の単位＝「円」（2026-09-12 21:30 ルク決定・本家 financie.jp が円表示のため）。
  // ラベルの定義はここ1か所だけ（A12）。切り替えるときはこの1行だけ直せばよい。
  const OVERVIEW_CONFIG = {
    volumeUnitLabel: "円",
    dataFiles: {
      market: "data/overview/market.json",
      volume: "data/overview/v24.json",
      price: "data/overview/price.json",
      members: "data/overview/members.json",
      stock: "data/overview/stock.json",
      mcap: "data/overview/mcap.json"
    },
    defaultTopN: 10,
    defaultPeriod: 90,
    // 日付欄を打っている途中（フォーカス中）は、この時間だけ入力が止まってから再計算する（重4）
    dateInputDebounceMs: 1000
  };

  const METRIC_LABELS = {
    volume: "出来高",
    price: "価格",
    members: "メンバー数",
    stock: "在庫",
    mcap: "時価総額"
  };

  // 系列の色（v3.2.0）：1〜10位は検証済みの10色（dataviz の8色＋9・10位を validate_palette.js で10色として通したもの・
  // テーマごとに段を変える＝CSS 変数 --series-1..10）。11位以降は同じ青系の明るさ違い（凡例と表で識別）。
  // 「その他」は灰（--series-other）＋凡例は斜線の見本。
  // 旧：9位以降を青系にしていたため上位10の9位と10位が ΔE 2.1 で見分けられなかった（エマ v3.2.0 中4）。
  const OV_FALLBACK_COLORS = {
    light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948", "#0e8fa8", "#a0522d"],
    dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767", "#118fa6", "#c0703a"]
  };
  const OV_VALIDATED_COLORS = 10;

  function ovColor(i) {
    const t = currentTheme();
    if (i < OV_VALIDATED_COLORS) return tc(`--series-${i + 1}`, OV_FALLBACK_COLORS[t][i]);
    const k = i - OV_VALIDATED_COLORS; // 0..19（上位30まで）
    const l = (t === "light" ? 70 : 62) - (k % 22) * 1.6;
    return `hsl(214, 45%, ${l.toFixed(1)}%)`;
  }

  function ovOtherColor() {
    return tc("--series-other", currentTheme() === "light" ? "#6b7280" : "#9ca3af");
  }

  function isMobile() {
    return window.matchMedia && window.matchMedia("(max-width: 768px)").matches;
  }

  /* ------------------------------------------------------------
   * テーマ（v3.2.0）：切替と色の正本は js/theme.js（FtTheme）と css/advanced.css の CSS 変数。
   * 既定＝ライト。theme.js が読まれていないとき（古い index.html）だけ、ここで切替を持つ。
   * ------------------------------------------------------------ */
  const THEME_KEY = "ft_theme";
  const tc = (name, fallback) => (window.FtTheme ? window.FtTheme.color(name, fallback) : fallback);

  function currentTheme() {
    if (window.FtTheme) return window.FtTheme.current();
    return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  function updateThemeToggle() {
    if (window.FtTheme) { window.FtTheme.updateToggle(); return; }
    const b = document.getElementById("theme-toggle");
    if (!b) return;
    const light = currentTheme() === "light";
    b.textContent = light ? "🌙 ダーク" : "☀️ ライト";
    b.setAttribute("aria-pressed", String(!light));
    b.title = light ? "背景を黒にする" : "背景を白にする";
  }

  function applyTheme(theme) {
    if (window.FtTheme) { window.FtTheme.apply(theme, true); return; } // 描き直しは ft-theme-change で
    document.documentElement.setAttribute("data-theme", theme === "dark" ? "dark" : "light");
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* 記憶できなくても動く */ }
    updateThemeToggle();
    if (ovState.initialized) recomputeAll();
  }

  function setupThemeToggle() {
    // テーマが変わったら描き直す（見えていない箱は遅延描画のまま＝画面に入ったときに新しい色で描かれる）
    window.addEventListener("ft-theme-change", () => { if (ovState.initialized) recomputeAll(); });
    if (window.FtTheme) return; // 釦は theme.js が持つ
    const b = document.getElementById("theme-toggle");
    if (!b) return;
    updateThemeToggle();
    b.addEventListener("click", () => applyTheme(currentTheme() === "light" ? "dark" : "light"));
  }

  // グラフの文字・罫線の色（CSS 変数から・無ければテーマごとの既定値）
  function chartColors() {
    const light = currentTheme() === "light";
    return {
      tick: tc("--chart-tick", light ? "#4b5563" : "#9ca3af"),
      gridX: tc("--chart-grid-x", light ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.03)"),
      gridY: tc("--chart-grid-y", light ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.05)")
    };
  }

  /* ------------------------------------------------------------
   * グラフの高さ：各グラフ右上の「小／中／大」（既定＝中）・グラフごとに localStorage に記憶（ルク要望2）
   * ------------------------------------------------------------ */
  const SIZE_KEY = "ft_chart_size";
  const CHART_SIZES = { s: { pc: 200, sp: 160 }, m: { pc: 320, sp: 240 }, l: { pc: 460, sp: 360 } }; // 中＝320（横長1列で 260 は薄い＝エマ v3.1 軽9）
  let chartSizes = {};
  try { chartSizes = JSON.parse(localStorage.getItem(SIZE_KEY) || "{}") || {}; } catch (e) { chartSizes = {}; }

  function chartSizeOf(key) {
    return CHART_SIZES[chartSizes[key]] ? chartSizes[key] : "m";
  }

  /* ------------------------------------------------------------
   * 状態
   * ------------------------------------------------------------ */
  const ovState = {
    initialized: false,
    period: OVERVIEW_CONFIG.defaultPeriod, // 7|30|90|365|'all'|'custom'
    granularity: "day", // 'day'|'week'|'month'
    granularityManual: false,
    topN: OVERVIEW_CONFIG.defaultTopN,
    metric: "volume",
    showOthers: true,
    startIdx: 0,
    endIdx: 0,
    rangeSwapped: false,
    // パネルD/Eは画面に出てくるまでデータを読まない（初回読み込みを market+v24 だけに絞るため）
    panelDReady: false,
    panelEReady: false,
    // 日付欄の未確定の変更（重4）
    dateDirty: false,
    // シェアの見せ方：'stack'（100%積み上げの推移）／'donut'（期間合計の円グラフ・ルク一言 21:56）
    shareView: "stack"
  };
  const SHARE_VIEW_KEY = "ft_share_view";
  try { if (localStorage.getItem(SHARE_VIEW_KEY) === "donut") ovState.shareView = "donut"; } catch (e) { /* 記憶なし */ }
  // メンバー数の増減：欠測・一斉変動の日の扱い 'exclude'（既定・除く）／'raw'（そのまま）＝2026-09-13 07:10 ルク指摘
  ovState.gapMode = "exclude";
  const GAP_MODE_KEY = "ft_gap_mode";
  try { if (localStorage.getItem(GAP_MODE_KEY) === "raw") ovState.gapMode = "raw"; } catch (e) { /* 記憶なし */ }

  const ovData = {}; // { volume: {days,projects,rows,folderIndex}, market: {...}, ... }
  const ovCharts = { volume: null, share: null, price: null, members: null };

  window.__ovLoadedFiles = window.__ovLoadedFiles || [];

  /* 合体 v3.2.0：集計の共通部品（js/merged-core.js）と、共通の状態・URL の持ち主（js/merged.js）を使う。
     FtMerged が無いとき（旧 index.html）は、これまでどおりこのファイルが状態を持つ。 */
  const core = () => window.FtMergedCore;
  const merged = () => window.FtMerged || null;
  // 欠測・一斉変動の日の扱い：smooth（ならす・既定）／raw（記録どおり）
  function gapMode() {
    const m = merged();
    if (m) return m.state().gap === "raw" ? "raw" : "smooth";
    return ovState.gapMode === "raw" ? "raw" : "smooth";
  }
  // 出来高の行列（smooth＝24H＝30日の日を値なしに・raw＝生の値）
  function volRows() { return core().volumeRows(ovData.volume, gapMode()); }

  /* ------------------------------------------------------------
   * DOM
   * ------------------------------------------------------------ */
  let dom = null;

  function bindDom() {
    dom = {
      desc: document.getElementById("ov-desc"),
      meta: document.getElementById("ov-meta"),
      error: document.getElementById("ov-error"),
      errorText: document.getElementById("ov-error-text"),
      errorReload: document.getElementById("ov-error-reload"),
      periodGroup: document.getElementById("ov-period-group"),
      granularityGroup: document.getElementById("ov-granularity-group"),
      topnGroup: document.getElementById("ov-topn-group"),
      metricGroup: document.getElementById("ov-metric-group"),
      startInput: document.getElementById("ov-start-date"),
      endInput: document.getElementById("ov-end-date"),
      rangeNote: document.getElementById("ov-range-note"),
      showOthers: document.getElementById("ov-show-others"),
      kpiTotalLabel: document.getElementById("ov-kpi-total-label"),
      kpiTotal: document.getElementById("ov-kpi-total"),
      kpiTotalSub: document.getElementById("ov-kpi-total-sub"),
      kpiAvg: document.getElementById("ov-kpi-avg"),
      kpiActive: document.getElementById("ov-kpi-active"),
      kpiActiveSub: document.getElementById("ov-kpi-active-sub"),
      kpiShareLabel: document.getElementById("ov-kpi-share-label"),
      kpiShare: document.getElementById("ov-kpi-share"),
      kpiShareSub: document.getElementById("ov-kpi-share-sub"),
      panelDTitle: document.getElementById("ov-panelD-title"),
      shareTitle: document.getElementById("ov-share-title"),
      shareView: document.getElementById("ov-share-view"),
      rankingTitle: document.getElementById("ov-ranking-title"),
      rankingNote: document.getElementById("ov-ranking-note"),
      rankingThead: document.getElementById("ov-ranking-thead"),
      rankingTbody: document.getElementById("ov-ranking-tbody"),
      legends: {
        volume: document.getElementById("ov-legend-volume"),
        share: document.getElementById("ov-legend-share"),
        price: document.getElementById("ov-legend-price"),
        members: document.getElementById("ov-legend-members")
      }
    };
  }

  /* ------------------------------------------------------------
   * ユーティリティ
   * ------------------------------------------------------------ */
  const fmtInt = (n) => (n === null || n === undefined || isNaN(n)) ? "-" : Math.round(n).toLocaleString("ja-JP");
  const fmtFloat = (n, d = 2) => (n === null || n === undefined || isNaN(n)) ? "-" : Number(n).toLocaleString("ja-JP", { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtPercent = (n, d = 1) => (n === null || n === undefined || isNaN(n)) ? "-" : `${(n * 100).toFixed(d)}%`;

  // "YYYY-MM-DD" → "YYYY/MM/DD"（見出し用）
  const fmtDateJa = (s) => (s ? s.replace(/-/g, "/") : "-");
  // "YYYY-MM-DD" → "MM/DD"（グラフの横軸・期末値の日付用）
  const fmtMD = (s) => (s ? s.slice(5).replace("-", "/") : "");

  // 変化率の書式（全指標で1つに統一・中3/中4）。
  //   前期間（または期首値）が無い → 「比較なし」／前期間ゼロで今期>0 → 「新規」／ちょうど0 → 「±0%」
  //   10倍超（+1000%以上）は「▲10倍超」に丸める（巨大な数字が煽りに見えないように）
  function fmtChangePct(current, base) {
    if (base === null || base === undefined || current === null || current === undefined) return { text: "比較なし", cls: "diff-flat" };
    if (base === 0) {
      if (current > 0) return { text: "新規", cls: "diff-up" };
      return { text: "比較なし", cls: "diff-flat" };
    }
    const pct = ((current - base) / base) * 100;
    if (pct === 0) return { text: "±0%", cls: "diff-flat" };
    if (pct >= 1000) return { text: "▲10倍超", cls: "diff-up" };
    const arrow = pct > 0 ? "▲" : "▼";
    return { text: `${arrow}${Math.abs(pct).toFixed(1)}%`, cls: pct > 0 ? "diff-up" : "diff-down" };
  }

  // 増減（実数）の書式：▲1,234／▼80,827／±0／比較なし
  function fmtChangeAbs(diff) {
    if (diff === null || diff === undefined || isNaN(diff)) return { text: "比較なし", cls: "diff-flat" };
    if (diff === 0) return { text: "±0", cls: "diff-flat" };
    const arrow = diff > 0 ? "▲" : "▼";
    return { text: `${arrow}${fmtInt(Math.abs(diff))}`, cls: diff > 0 ? "diff-up" : "diff-down" };
  }

  // 順位変化：→（変わらず）／▲3／▼2／比較なし
  function fmtRankChange(prevRank, nowRank) {
    if (!prevRank) return { text: "比較なし", cls: "diff-flat" };
    const d = prevRank - nowRank;
    if (d === 0) return { text: "→", cls: "diff-flat" };
    return { text: d > 0 ? `▲${d}` : `▼${Math.abs(d)}`, cls: d > 0 ? "diff-up" : "diff-down" };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function fetchOverviewFile(path) {
    window.__ovLoadedFiles.push(path);
    return fetch(path).then((res) => {
      if (!res.ok) throw new Error(`failed to load ${path}`);
      return res.json();
    });
  }

  function indexMetricPayload(payload) {
    payload.folderIndex = {};
    payload.projects.forEach((p, i) => { payload.folderIndex[p.folder] = i; });
    return payload;
  }

  const MERGED_FILE = { market: "market", volume: "v24", price: "price", members: "members", stock: "stock", mcap: "mcap" };

  function ensureMetricLoaded(metricKey) {
    if (ovData[metricKey]) return Promise.resolve(ovData[metricKey]);
    const m = merged();
    const pr = m ? m.load(MERGED_FILE[metricKey]) : fetchOverviewFile(OVERVIEW_CONFIG.dataFiles[metricKey]);
    return pr.then((payload) => {
      ovData[metricKey] = metricKey === "market" ? payload : indexMetricPayload(payload);
      return ovData[metricKey];
    });
  }

  // 日付配列に対する二分探索（days は "YYYY-MM-DD" の昇順文字列）
  function floorIndex(days, target) {
    let lo = 0, hi = days.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (days[mid] <= target) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return ans;
  }

  function ceilIndex(days, target) {
    let lo = 0, hi = days.length - 1, ans = days.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (days[mid] >= target) { ans = mid; hi = mid - 1; } else { lo = mid + 1; }
    }
    return ans;
  }

  // 期間内で最初・最後に記録のある値と、その日のインデックス
  function firstLastValid(row, startIdx, endIdx) {
    let first = null, last = null, firstIdx = -1, lastIdx = -1;
    for (let i = startIdx; i <= endIdx; i++) {
      if (row[i] !== null && row[i] !== undefined) { first = row[i]; firstIdx = i; break; }
    }
    for (let i = endIdx; i >= startIdx; i--) {
      if (row[i] !== null && row[i] !== undefined) { last = row[i]; lastIdx = i; break; }
    }
    return { first, last, firstIdx, lastIdx };
  }

  /* ------------------------------------------------------------
   * 期間・粒度の計算
   * ------------------------------------------------------------ */
  function computeRange() {
    const days = ovData.market.days;
    const spec = ovState.period === "custom"
      ? { period: "custom", start: ovState.customStart || dom.startInput.value, end: ovState.customEnd || dom.endInput.value }
      : { period: ovState.period };
    // 期間は暦日で数える（契約 D）。7／30／90／365＝期末から暦日 N 日
    const r = core().computeRange(days, spec);
    ovState.startIdx = r.startIdx;
    ovState.endIdx = r.endIdx;
    ovState.range = r;
    // 開始＞終了は入れ替えて扱い、注記を出す。共通の状態と URL にも入れ替えた順で書き戻す（描き直しはしない）
    if (r.swapped) {
      ovState.customStart = days[r.startIdx];
      ovState.customEnd = days[r.endIdx];
      ovState.swapNoticeKey = `${ovState.customStart}|${ovState.customEnd}`;
      if (merged()) merged().set({ start: ovState.customStart, end: ovState.customEnd }, { silent: true });
    }
    ovState.rangeSwapped = r.swapped || (ovState.period === "custom" && ovState.swapNoticeKey === `${days[r.startIdx]}|${days[r.endIdx]}`);
    if (ovState.period !== "custom") ovState.swapNoticeKey = null;

    // 打っている途中の欄（編集中）には書き戻さない（重4：1字ごとに値が飛ぶのを防ぐ）。
    // 🔴 document.activeElement は Chrome の日付欄が年→月へ自動で進む瞬間に空になるため使わない。
    //    focus/blur で自前に持つ editingInputs を見る。
    if (!editingInputs.has(dom.startInput)) dom.startInput.value = days[ovState.startIdx];
    if (!editingInputs.has(dom.endInput)) dom.endInput.value = days[ovState.endIdx];
    if (dom.rangeNote) {
      dom.rangeNote.textContent = ovState.rangeSwapped ? "開始日と終了日を入れ替えました" : "";
      dom.rangeNote.classList.toggle("hidden-element", !ovState.rangeSwapped);
    }
  }

  function autoAdjustGranularity() {
    const nDays = ovState.range ? ovState.range.calendarDays : ovState.endIdx - ovState.startIdx + 1;
    if (!ovState.granularityManual) {
      ovState.granularity = nDays > 365 ? "week" : "day";
      dom.granularityGroup.querySelectorAll("button").forEach((btn) => {
        btn.classList.toggle("active", btn.getAttribute("data-granularity") === ovState.granularity);
      });
    }
  }

  function isoWeekKey(dateStr) {
    const d = new Date(dateStr + "T00:00:00Z");
    const dayNum = (d.getUTCDay() + 6) % 7; // Monday=0
    d.setUTCDate(d.getUTCDate() - dayNum + 3);
    const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const week = 1 + Math.round(((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  }

  // 期間内の日付インデックスを、粒度に応じたバケツへまとめる。
  // 戻り値: [{ label, short, indices: [dayIdx, ...] }, ...]（時系列順）
  //   label = ツールチップ用（日:YYYY-MM-DD／週:YYYY-Www（MM/DD〜）／月:YYYY-MM）
  //   short = 横軸用の短い表記（日・週:MM/DD、月:YYYY/MM）＝回転させずに読める（重1・軽6）
  function buildBuckets() {
    const days = ovData.market.days;
    const range = ovState.range || core().computeRange(days, { period: "all" });
    const { buckets, dropped } = core().buckets(days, range, ovState.granularity);
    ovState.bucketDropped = dropped; // 週の先頭で捨てた端数の日数（注記用）
    return buckets.map((b) => {
      const indices = [];
      for (let i = b.startIdx; i <= b.endIdx; i++) indices.push(i);
      let label, short;
      if (ovState.granularity === "week") { label = `${fmtDateJa(b.start)}〜${fmtMD(b.end)}`; short = fmtMD(b.end); }
      else if (ovState.granularity === "month") { label = b.key; short = b.key.replace("-", "/"); }
      else { label = b.start; short = fmtMD(b.start); }
      return { label, short, indices };
    });
  }

  /* ------------------------------------------------------------
   * 上位N（常に「出来高」の期間合計で決める・パネルA/B/D/Eで共通）
   * ------------------------------------------------------------ */
  function computeTopNVolumeFolders() {
    const payload = ovData.volume;
    const rows = volRows();
    const totals = payload.projects.map((p, i) => {
      let sum = 0;
      const row = rows[i];
      for (let d = ovState.startIdx; d <= ovState.endIdx; d++) {
        if (row[d] !== null && row[d] !== undefined) sum += row[d];
      }
      return { folder: p.folder, slug: p.slug, name: p.name, first: p.first, total: sum };
    });
    totals.sort((a, b) => b.total - a.total);
    return totals;
  }

  /* ------------------------------------------------------------
   * KPI・見出し
   * ------------------------------------------------------------ */
  // 前期間＝同じ暦日数の直前（記録の初日より前にかかるときは partial・全く無ければ null）
  function prevPeriodRange() {
    if (!ovState.range) return null;
    return core().prevRange(ovData.market.days, ovState.range);
  }

  // 期間の全体出来高＝行列（欠測の切替に従う）から足す。KPI・内訳・ランキングが同じ数から出る（契約 B）
  function sumMarketV24(startIdx, endIdx) {
    return core().sumOf(core().projectTotals(volRows(), startIdx, endIdx));
  }

  // 「上位N」の N を実際の数に置き換える（中1）・データの日付と件数を見出しに出す（中2・中7）
  function renderHeadings() {
    const n = ovState.topN;
    const days = ovData.market.days;
    const latest = days[days.length - 1];
    const count = ovData.volume.projects.length;
    if (dom.desc) dom.desc.textContent = `全プロジェクトを横断した出来高・価格・メンバー数・在庫・時価総額の推移。上位${n}＋その他で内訳を見られます。`;
    const first = ovData.market.first_day || days[0];
    if (dom.meta) dom.meta.textContent = `非公式・${count}プロジェクト・記録 ${fmtDateJa(first)}〜${fmtDateJa(latest)}（毎日1回）・それ以前のデータは持っていません（FiNANCiE 自体はそれ以前からあるサービスです）`;
    if (dom.kpiTotalLabel) dom.kpiTotalLabel.textContent = `期間の全体出来高（${OVERVIEW_CONFIG.volumeUnitLabel}）`;
    if (dom.kpiShareLabel) dom.kpiShareLabel.textContent = `上位${n}のシェア`;
    if (dom.panelDTitle) dom.panelDTitle.textContent = `価格の推移（上位${n}・円）`;
  }

  function renderKPIs(topRanked) {
    const total = sumMarketV24(ovState.startIdx, ovState.endIdx);
    const nDays = ovState.range ? ovState.range.calendarDays : ovState.endIdx - ovState.startIdx + 1;
    const avg = nDays > 0 ? total / nDays : 0;

    const prev = prevPeriodRange();
    let subText = "比較できる前期間がありません";
    if (prev) {
      const prevTotal = sumMarketV24(prev.startIdx, prev.endIdx);
      if (prevTotal > 0) {
        const diffPct = (total - prevTotal) / prevTotal;
        const sign = diffPct >= 0 ? "多い" : "少ない";
        subText = `前期間より${fmtPercent(Math.abs(diffPct))}${sign}`; // 呼び名を結論・ランキングの「前期間」にそろえる（エマ v3.2.1 軽）
      }
    }

    dom.kpiTotal.textContent = `${fmtInt(total)}`;
    dom.kpiTotalSub.textContent = subText;
    dom.kpiAvg.textContent = `${fmtInt(avg)}`;

    const vr = volRows();
    const activeCount = ovData.volume.projects.filter((p, i) => {
      const row = vr[i];
      let s = 0;
      for (let d = ovState.startIdx; d <= ovState.endIdx; d++) {
        if (row[d] !== null && row[d] !== undefined) s += row[d];
      }
      return s > 0;
    }).length;
    dom.kpiActive.textContent = `${activeCount}`;
    dom.kpiActiveSub.textContent = `/ 全${ovData.volume.projects.length} PJ`; // 見出し「取引のあったPJ数」と呼び名をそろえる（エマ v3.2.0 中8）

    const topN = topRanked.slice(0, ovState.topN);
    const topSum = topN.reduce((s, x) => s + x.total, 0);
    const share = total > 0 ? topSum / total : 0;
    dom.kpiShare.textContent = fmtPercent(share);
    dom.kpiShareSub.textContent = `その他 ${fmtPercent(Math.max(0, 1 - share))}`;
  }

  /* ------------------------------------------------------------
   * グラフ共通（横軸の短い日付・凡例はHTMLで別出し）
   * ------------------------------------------------------------ */
  function xTicksOptions(shortLabels) {
    return {
      color: chartColors().tick,
      maxRotation: 0,
      minRotation: 0,
      autoSkip: true,
      maxTicksLimit: isMobile() ? 6 : 12,
      font: { size: 11 },
      callback: (value, index) => shortLabels[index] !== undefined ? shortLabels[index] : value
    };
  }

  const NO_CANVAS_LEGEND = { display: false };

  // 縦軸の余白＝表示中の系列で上下限を取ったあとに 6% 足す（grace は目盛りの丸めに飲まれて 3.6% になった＝エマ v3.1 中5）。
  // 凡例で系列を消したときは Chart.js が残りで上下限を取り直すので、この余白も追随する。
  function axisHeadroom(scale) {
    const span = scale.max - scale.min;
    if (!(span > 0)) return;
    if (scale.max > 0) scale.max += span * 0.06;
    if (scale.min < 0) scale.min -= span * 0.06;
  }

  // Chart.js の凡例はキャンバスの描画域を食う（スマホで描画域が9〜22pxに潰れた・重1）。
  // 代わりにカードの下へHTMLの凡例を出す（js/chart-legend.js＝全グラフ共通・v3.1 項目3：
  // 押して出し入れ・縦軸は残った系列で再計算・「全部出す」・消した状態は描き直しても再読み込みしても保つ）。
  function renderHtmlLegend(chartKey) {
    const chart = ovCharts[chartKey];
    const box = dom.legends[chartKey];
    if (!chart || !box || !window.FtLegend) return;
    window.FtLegend.render(chart, box, `ov:${chartKey}`);
  }

  /* ------------------------------------------------------------
   * パネル A / B: 全体出来高（積み上げ）・シェア（100%積み上げ）
   * ------------------------------------------------------------ */
  function buildSeriesForBuckets(buckets, topFolders) {
    const payload = ovData.volume;
    const rows = volRows();
    const series = topFolders.map((tf) => {
      const idx = payload.folderIndex[tf.folder];
      const row = idx !== undefined ? rows[idx] : null;
      const data = buckets.map((b) => {
        if (!row) return 0;
        let s = 0;
        b.indices.forEach((di) => { if (typeof row[di] === "number") s += row[di]; });
        return s;
      });
      return { folder: tf.folder, name: tf.name, data };
    });

    // その他 = 全PJの合計 - 上位N合計（同じ行列から＝欠測の切替と食い違わない）
    const othersData = buckets.map((b, bi) => {
      let bucketTotal = 0;
      b.indices.forEach((di) => {
        for (let p = 0; p < rows.length; p++) { const v = rows[p][di]; if (typeof v === "number") bucketTotal += v; }
      });
      const topSumThisBucket = series.reduce((s, ser) => s + ser.data[bi], 0);
      return Math.max(0, bucketTotal - topSumThisBucket);
    });

    return { series, othersData };
  }

  function renderPanelAB(topFolders) {
    const buckets = buildBuckets();
    const topN = topFolders.slice(0, ovState.topN);
    const { series, othersData } = buildSeriesForBuckets(buckets, topN);
    const labels = buckets.map((b) => b.label);
    const shortLabels = buckets.map((b) => b.short);

    const datasetsA = series.map((s, i) => ({
      label: s.name,
      ftId: s.folder,
      data: s.data,
      backgroundColor: ovColor(i),
      stack: "vol"
    }));
    datasetsA.push({
      label: "その他",
      data: othersData,
      backgroundColor: ovOtherColor(),
      stack: "vol",
      hidden: !ovState.showOthers,
      ftLocked: !ovState.showOthers // 「その他を表示」で隠したときは凡例の記憶・「全部出す」の対象にしない
    });

    if (ovCharts.volume) ovCharts.volume.destroy();
    const volCtx = document.getElementById("ovVolumeChart").getContext("2d");
    ovCharts.volume = new Chart(volCtx, {
      type: "bar",
      data: { labels, datasets: datasetsA },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: NO_CANVAS_LEGEND,
          tooltip: { mode: "index", intersect: false }
        },
        scales: {
          x: { stacked: true, ticks: xTicksOptions(shortLabels), grid: { color: chartColors().gridX } },
          // 余白（afterDataLimits）＝いちばん高い棒の上に 6%。最大月 448.4M に対し軸の上限が 450M で、棒が天井に触れて切れて見えた（06:45 ルク指摘）
          y: { stacked: true, afterDataLimits: axisHeadroom, ticks: { color: chartColors().tick }, grid: { color: chartColors().gridY } }
        }
      }
    });
    renderHtmlLegend("volume");

    if (ovState.shareView === "bundle") { // 束の円は分析の部品が描く（見せ方の切替）・見出しは見せ方ごとに替える（エマ v3.2.0 中5）
      if (dom.shareTitle) dom.shareTitle.textContent = "出来高シェア（期間合計・束＋単独PJ＋その他）";
      return;
    }
    if (ovState.shareView === "donut") {
      renderShareDonut(series, othersData);
      return;
    }
    if (dom.shareTitle) dom.shareTitle.textContent = "出来高シェア（推移・100%積み上げ）"; // 円・束と同じ形に（エマ v3.2.1 軽）

    // シェア（100%積み上げ）: バケツごとの合計（上位N + その他）でパーセント化
    const bucketTotals = labels.map((_, bi) => {
      let t = othersData[bi];
      series.forEach((s) => { t += s.data[bi]; });
      return t;
    });
    const shareDatasets = series.map((s, i) => ({
      label: s.name,
      ftId: s.folder,
      data: s.data.map((v, bi) => bucketTotals[bi] > 0 ? (v / bucketTotals[bi]) * 100 : 0),
      backgroundColor: ovColor(i),
      stack: "share"
    }));
    shareDatasets.push({
      label: "その他",
      data: othersData.map((v, bi) => bucketTotals[bi] > 0 ? (v / bucketTotals[bi]) * 100 : 0),
      backgroundColor: ovOtherColor(),
      stack: "share",
      hidden: !ovState.showOthers,
      ftLocked: !ovState.showOthers // 「その他を表示」で隠したときは凡例の記憶・「全部出す」の対象にしない
    });

    if (ovCharts.share) ovCharts.share.destroy();
    const shareCtx = document.getElementById("ovShareChart").getContext("2d");
    ovCharts.share = new Chart(shareCtx, {
      type: "bar",
      data: { labels, datasets: shareDatasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: NO_CANVAS_LEGEND,
          tooltip: { mode: "index", intersect: false }
        },
        scales: {
          x: { stacked: true, ticks: xTicksOptions(shortLabels), grid: { color: chartColors().gridX } },
          y: { stacked: true, min: 0, max: 100, ticks: { color: chartColors().tick, callback: (v) => v + "%" }, grid: { color: chartColors().gridY } }
        }
      }
    });
    renderHtmlLegend("share");
  }

  // シェアの円グラフ：期間合計の上位N＋その他（「その他」チェックを外すと上位Nだけで100%）
  function renderShareDonut(series, othersData) {
    const totals = series.map((s) => s.data.reduce((a, b) => a + b, 0));
    const labels = series.map((s) => s.name);
    const ids = series.map((s) => s.folder); // 凡例の記憶の識別子（棒グラフと共通＝同じPJを同じ記憶で出し入れ）
    const colors = series.map((_, i) => ovColor(i));
    if (ovState.showOthers) {
      totals.push(othersData.reduce((a, b) => a + b, 0));
      labels.push("その他");
      ids.push("その他");
      colors.push(ovOtherColor());
    }
    const grand = totals.reduce((a, b) => a + b, 0);
    if (dom.shareTitle) dom.shareTitle.textContent = `出来高シェア（期間合計・上位${ovState.topN}${ovState.showOthers ? "＋その他" : ""}）`;

    if (ovCharts.share) ovCharts.share.destroy();
    const ctx = document.getElementById("ovShareChart").getContext("2d");
    ovCharts.share = new Chart(ctx, {
      type: "doughnut",
      data: { labels, datasets: [{ data: totals, ftIds: ids, backgroundColor: colors, borderColor: tc("--donut-gap", currentTheme() === "light" ? "#ffffff" : "#131A26"), borderWidth: 1 }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "55%",
        plugins: {
          legend: NO_CANVAS_LEGEND,
          tooltip: {
            callbacks: {
              label: (item) => {
                const v = item.parsed;
                const pct = grand > 0 ? (v / grand) * 100 : 0;
                return ` ${fmtInt(v)} ${OVERVIEW_CONFIG.volumeUnitLabel}（${pct.toFixed(1)}%）`;
              }
            }
          }
        }
      }
    });
    renderHtmlLegend("share");
  }

  /* ------------------------------------------------------------
   * パネル C: 指標ランキング表
   * ------------------------------------------------------------ */
  // 列の定義：head = 見出し／label = スマホのカード表示で各セルに付ける短い列名（重2）／align = 見出しの寄せ（軽4）
  function rankingColumns(metric) {
    const unit = OVERVIEW_CONFIG.volumeUnitLabel;
    const rank = { head: "順位", label: "順位", align: "center" };
    const pj = { head: "プロジェクト", label: "プロジェクト", align: "left" };
    const cols = {
      volume: [rank, pj,
        { head: `期間合計（${unit}）`, label: `期間合計（${unit}）`, align: "right" },
        { head: "前期間比", label: "前期間比", align: "right" },
        { head: "シェア", label: "シェア", align: "right" },
        { head: "順位変化", label: "順位変化", align: "right" }],
      price: [rank, pj,
        { head: `期末値（${unit}）`, label: `期末値（${unit}）`, align: "right" },
        { head: "期間の変化率", label: "期間の変化率", align: "right" }],
      members: [rank, pj,
        { head: "期末値（人）", label: "期末値（人）", align: "right" },
        { head: "期間の増減（人）", label: "期間の増減（人）", align: "right" }],
      stock: [rank, pj,
        { head: "期末値（個）", label: "期末値（個）", align: "right" },
        { head: "期間の増減（個）", label: "期間の増減（個）", align: "right" }],
      mcap: [rank, pj,
        { head: `期末値（${unit}）`, label: `期末値（${unit}）`, align: "right" },
        { head: "期間の変化率", label: "期間の変化率", align: "right" }]
    };
    return cols[metric] || cols.volume;
  }

  const ROW_HINT = "名前を押すと個別分析・名前の右の ↗ で FiNANCiE のプロジェクトページ（新しいタブ）。名前に載せると各PJのデータ取得開始日が出ます";
  const RANKING_NOTES = {
    volume: `並び＝期間合計の多い順。「その他」＝上位以外の全件（期間中に取引の無かったPJも含む）。${ROW_HINT}`,
    price: `並び＝期間の変化率の高い順。期末値＝期間内で最後に記録された値（終了日より前で止まっているPJは日付を添えています）。${ROW_HINT}`,
    members: `並び＝期間の増減の多い順。メンバー数の増減は購入者数ではありません。期末値＝期間内で最後に記録された値。${ROW_HINT}`,
    stock: `並び＝在庫の減りが大きい順。減りは販売数ではありません（売り戻しと差し引き）。期末値＝期間内で最後に記録された値。${ROW_HINT}`,
    mcap: `並び＝期間の変化率の高い順。期末値＝期間内で最後に記録された値。${ROW_HINT}`
  };

  function renderRankingHeader(metric) {
    const cols = rankingColumns(metric);
    dom.rankingThead.innerHTML = `<tr>${cols.map((c) => `<th class="ov-th-${c.align}">${c.head}</th>`).join("")}</tr>`;
    return cols;
  }

  function rankingRowsForMetric(metric) {
    if (metric === "volume") {
      const ranked = computeTopNVolumeFolders(); // already sorted desc by period total (全409件)
      const prev = prevPeriodRange();
      let prevRankedMap = {};
      let prevTotalMap = null; // null=前期間なし。存在すればfolder->前期間合計（データが無ければ0）
      if (prev) {
        const payload = ovData.volume;
        prevTotalMap = {};
        const vr = volRows();
        const prevTotals = payload.projects.map((p, i) => {
          let s = 0;
          const row = vr[i];
          for (let d = prev.startIdx; d <= prev.endIdx; d++) {
            if (row[d] !== null && row[d] !== undefined) s += row[d];
          }
          prevTotalMap[p.folder] = s;
          return { folder: p.folder, total: s };
        });
        prevTotals.sort((a, b) => b.total - a.total);
        prevTotals.forEach((r, i) => { prevRankedMap[r.folder] = i + 1; });
      }
      const grandTotal = ranked.reduce((s, r) => s + r.total, 0);
      return { ranked, extra: { prevRankedMap, prevTotalMap, grandTotal } };
    }

    // 出来高以外の指標: 選んだ指標そのものの値で並べ替え
    const payload = ovData[metric];
    const rows = payload.projects.map((p, i) => {
      const row = payload.rows[i];
      const { first, last, lastIdx } = firstLastValid(row, ovState.startIdx, ovState.endIdx);
      let changeAbs = null, changePct = null;
      if (first !== null && last !== null) {
        changeAbs = last - first;
        changePct = first !== 0 ? changeAbs / first : null;
      }
      // 並べ替え基準: stock は「減り」を大きい順（減少が大きいほど上位）、それ以外は変化率降順。
      let sortValue;
      if (metric === "stock") sortValue = changeAbs === null ? -Infinity : -changeAbs; // 減少(負)ほど大きい正値に
      else if (metric === "members") sortValue = changeAbs === null ? -Infinity : changeAbs;
      else sortValue = changePct === null ? -Infinity : changePct;
      return { folder: p.folder, slug: p.slug, name: p.name, firstDay: p.first, first, last, lastIdx, changeAbs, changePct, sortValue };
    });
    rows.sort((a, b) => b.sortValue - a.sortValue);
    return { ranked: rows, extra: {} };
  }

  // 期末値：終了日より前で記録が止まっているPJは「（MM/DD時点）」を添える（軽1）
  function lastValueCell(text, lastIdx) {
    if (lastIdx >= 0 && lastIdx < ovState.endIdx) {
      return `${text}<span class="ov-asof">（${fmtMD(ovData.market.days[lastIdx])}時点）</span>`;
    }
    return text;
  }

  // 本家 FiNANCiE のプロジェクトページ（実在を curl で3件確認済み：/users/<slug>）
  function financieUrl(r) {
    return `https://financie.jp/users/${encodeURIComponent(r.slug || r.folder)}`;
  }

  // 名前＝FiNANCiE TIMES 内の個別分析（?project=<folder>）・名前の右の ↗＝本家（新しいタブ）。v3.1 項目5（v3.0.0 の「名前＝本家」を入れ替え）
  function projectCell(r) {
    const firstDay = r.firstDay || r.first;
    const title = `個別分析を見る${typeof firstDay === "string" ? `・データ取得開始 ${fmtDateJa(firstDay)}` : ""}`;
    return `<td class="text-left"><span class="ov-pj-cell"><a class="table-pj-link ov-pj-link" href="?project=${encodeURIComponent(r.folder)}" title="${escapeHtml(title)}">${escapeHtml(r.name)}</a><a class="ov-ext-link" href="${financieUrl(r)}" target="_blank" rel="noopener" title="FiNANCiEで見る（新しいタブ）" aria-label="${escapeHtml(r.name)} を FiNANCiEで見る（新しいタブ）"><span class="ov-ext" aria-hidden="true">↗</span></a></span></td>`;
  }

  function renderPanelC() {
    const metric = ovState.metric;
    dom.rankingTitle.textContent = `指標ランキング（${METRIC_LABELS[metric]}）`;
    const cols = renderRankingHeader(metric);
    if (dom.rankingNote) dom.rankingNote.textContent = RANKING_NOTES[metric] || "";

    ensureMetricLoaded(metric).then(() => {
      const { ranked, extra } = rankingRowsForMetric(metric);
      const topN = ranked.slice(0, ovState.topN);
      const restCount = ranked.length - topN.length;
      const othersLabel = `その他（上位${ovState.topN}以外の${restCount}件）`;

      let rowsHtml = "";
      if (metric === "volume") {
        topN.forEach((r, i) => {
          const rank = fmtRankChange(extra.prevRankedMap[r.folder], i + 1);
          const share = extra.grandTotal > 0 ? r.total / extra.grandTotal : 0;
          const prevTotal = extra.prevTotalMap ? extra.prevTotalMap[r.folder] : null;
          const diff = fmtChangePct(r.total, prevTotal);
          rowsHtml += `<tr class="ov-ranking-row" data-folder="${escapeHtml(r.folder)}">
            <td class="text-center">${i + 1}</td>
            ${projectCell(r)}
            <td class="text-right">${fmtInt(r.total)}</td>
            <td class="text-right ${diff.cls}">${diff.text}</td>
            <td class="text-right">${fmtPercent(share)}</td>
            <td class="text-right ${rank.cls}">${rank.text}</td>
          </tr>`;
        });
        if (ovState.showOthers && restCount > 0) {
          const restFolders = ranked.slice(ovState.topN);
          const othersSum = restFolders.reduce((s, r) => s + r.total, 0);
          const othersShare = extra.grandTotal > 0 ? othersSum / extra.grandTotal : 0;
          let othersDiff;
          if (extra.prevTotalMap) {
            const prevOthersSum = restFolders.reduce((s, r) => s + (extra.prevTotalMap[r.folder] || 0), 0);
            othersDiff = fmtChangePct(othersSum, prevOthersSum);
          } else {
            othersDiff = fmtChangePct(othersSum, null);
          }
          rowsHtml += `<tr class="ov-ranking-row ov-others-row"><td class="text-center">-</td><td class="text-left">${othersLabel}</td><td class="text-right">${fmtInt(othersSum)}</td><td class="text-right ${othersDiff.cls}">${othersDiff.text}</td><td class="text-right">${fmtPercent(othersShare)}</td><td class="text-right diff-flat">対象外</td></tr>`;
        }
      } else if (metric === "price" || metric === "mcap") {
        topN.forEach((r, i) => {
          const chg = fmtChangePct(r.last, r.first);
          const lastText = metric === "price" ? fmtFloat(r.last, 2) : fmtInt(r.last);
          rowsHtml += `<tr class="ov-ranking-row" data-folder="${escapeHtml(r.folder)}">
            <td class="text-center">${i + 1}</td>
            ${projectCell(r)}
            <td class="text-right">${lastValueCell(lastText, r.lastIdx)}</td>
            <td class="text-right ${chg.cls}">${chg.text}</td>
          </tr>`;
        });
        if (ovState.showOthers && restCount > 0) {
          rowsHtml += `<tr class="ov-ranking-row ov-others-row"><td class="text-center">-</td><td class="text-left">${othersLabel}</td><td class="text-right diff-flat">対象外</td><td class="text-right diff-flat">対象外</td></tr>`;
        }
      } else if (metric === "members" || metric === "stock") {
        topN.forEach((r, i) => {
          const chg = fmtChangeAbs(r.changeAbs);
          rowsHtml += `<tr class="ov-ranking-row" data-folder="${escapeHtml(r.folder)}">
            <td class="text-center">${i + 1}</td>
            ${projectCell(r)}
            <td class="text-right">${lastValueCell(fmtInt(r.last), r.lastIdx)}</td>
            <td class="text-right ${chg.cls}">${chg.text}</td>
          </tr>`;
        });
        if (ovState.showOthers && restCount > 0) {
          rowsHtml += `<tr class="ov-ranking-row ov-others-row"><td class="text-center">-</td><td class="text-left">${othersLabel}</td><td class="text-right diff-flat">対象外</td><td class="text-right diff-flat">対象外</td></tr>`;
        }
      }

      dom.rankingTbody.innerHTML = rowsHtml || `<tr><td colspan="${cols.length}" class="text-center">データがありません</td></tr>`;

      // スマホのカード表示で列名を出すため、全セルに data-label を付ける（重2）
      dom.rankingTbody.querySelectorAll("tr").forEach((tr) => {
        tr.querySelectorAll("td").forEach((td, i) => {
          if (cols[i]) td.setAttribute("data-label", cols[i].label);
        });
      });

      dom.rankingTbody.querySelectorAll(".ov-ranking-row[data-folder]").forEach((tr) => {
        tr.addEventListener("click", (e) => {
          if (e.target.closest("a")) return; // 名前のリンク（本家へ）はそのまま通す
          window.location.href = `?project=${encodeURIComponent(tr.getAttribute("data-folder"))}`;
        });
      });
    });
  }

  /* ------------------------------------------------------------
   * パネル D: 価格の推移（上位N・円の絶対値）
   * ------------------------------------------------------------ */
  function renderPanelD(topFolders) {
    ensureMetricLoaded("price").then((payload) => {
      const days = ovData.market.days;
      const labels = days.slice(ovState.startIdx, ovState.endIdx + 1);
      const shortLabels = labels.map(fmtMD);
      const asIndex = ovState.priceView === "index";
      // 選び方：出来高上位（既定・他の図と同じ上位）／期末の価格上位
      let picks = topFolders.slice(0, ovState.topN);
      if (ovState.pricePick === "price") {
        picks = payload.projects.map((p, i) => ({ folder: p.folder, name: p.name, v: firstLastValid(payload.rows[i], ovState.startIdx, ovState.endIdx).last }))
          .filter((x) => typeof x.v === "number" && x.v > 0)
          .sort((a, b) => b.v - a.v)
          .slice(0, ovState.topN);
      }
      if (dom.panelDTitle) {
        const pickText = ovState.pricePick === "price" ? `期末の価格上位${ovState.topN}` : `上位${ovState.topN}`;
        dom.panelDTitle.textContent = `価格の推移（${pickText}・${asIndex ? "期間内で最初に値が付いた日＝100" : "円"}）`;
      }

      const datasets = picks.map((tf, i) => {
        const idx = payload.folderIndex[tf.folder];
        const row = idx !== undefined ? payload.rows[idx] : null;
        // 価格 0 以下は「値が付いていない日」として null（線は spanGaps でつなぐ）。指数＝期間内で最初に 0 より大きい値＝100
        const data = [];
        let base = null;
        for (let d = ovState.startIdx; d <= ovState.endIdx; d++) {
          const v = row ? row[d] : null;
          const ok = typeof v === "number" && v > 0;
          if (ok && base === null) base = v;
          data.push(ok ? (asIndex ? (v / base) * 100 : v) : null);
        }
        return { label: tf.name, ftId: tf.folder, data, borderColor: ovColor(i), backgroundColor: "transparent", borderWidth: 2, pointRadius: 0, spanGaps: true, tension: 0.1 };
      });

      if (ovCharts.price) ovCharts.price.destroy();
      const ctx = document.getElementById("ovPriceChart").getContext("2d");
      const fmtY = (v) => (asIndex ? fmtFloat(v, 0) : `${fmtFloat(v, Number.isInteger(v) ? 0 : 2)} 円`);
      ovCharts.price = new Chart(ctx, {
        type: "line",
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: NO_CANVAS_LEGEND,
            tooltip: { mode: "index", intersect: false, callbacks: { label: (item) => `${item.dataset.label}: ${asIndex ? fmtFloat(item.raw, 1) : `${fmtFloat(item.raw, 2)} 円`}` } }
          },
          scales: {
            x: { ticks: xTicksOptions(shortLabels), grid: { color: chartColors().gridX } },
            y: { min: asIndex ? undefined : 0, afterDataLimits: axisHeadroom, ticks: { color: chartColors().tick, callback: fmtY }, grid: { color: chartColors().gridY } }
          }
        }
      });
      renderHtmlLegend("price");
    });
  }

  /* ------------------------------------------------------------
   * パネル E: メンバー数の増減（日ごとの純増・上位N＋その他の積み上げ）
   * ------------------------------------------------------------ */
  // 欠測・一斉変動の日（2026-09-13 ルク指摘＝06/24 に「その他」が −15,611 で縦軸が潰れた）。
  //  ①0落ち：直前が GAP_ZERO_MIN 以上で 0 になった日は欠測＝前の値で埋める（分析タブ仕様メモ §4）
  //  ②一斉変動：GAP_MASS_MIN 以上のPJが同じ日に同じ向きへ GAP_MASS_STEP 以上動いた日（本家側の再集計の跡・
  //    実測＝2026-06-24 は45PJがそろって約−100・2024-09-12 は211PJが0→09-14 に復帰）は、その日の増減を全PJ 0 にする
  const GAP_ZERO_MIN = 100;
  const GAP_MASS_MIN = 20;
  const GAP_MASS_STEP = 100;
  let gapCache = null; // { filled: rows（①適用後）, massDays: {dayIdx: {count, sign}} }

  // 式の正本は js/merged-core.js（membersInfo＝①で埋めた行と一斉変動の日）。検査の互換のため名前を残す
  function membersGapInfo(payload) {
    return core().membersInfo(payload);
  }

  // そのPJが d 日に、一斉変動と同じ向きへ動いたか（記録の生の値で判定・大きさは問わない）。
  // 2026-06-24 の再集計は −1〜−2,741 まで連続的（比率で削られている）で、しきい値では切り分けられない
  // （100人以上だけ 0 にすると −5,468 が残る・実測）。逆向き（本物の増加）は残す。
  function isMassMove(rawRow, d, sign) {
    const a = rawRow[d - 1], b = rawRow[d];
    if (typeof a !== "number" || typeof b !== "number") return false;
    return sign < 0 ? b - a < 0 : b - a > 0;
  }

  // 注記は結論から1文・2行目に日付（エマ v3.1 中3＝2つのモードで同じ骨格）
  function renderGapNote() {
    const el = document.getElementById("ov-gap-note");
    if (!el || !ovData.members) return;
    const list = core().massDaysIn(ovData.members, ovState.startIdx, ovState.endIdx);
    const dates = list.map((x) => `${fmtDateJa(x.date)}（${x.count}件が同時に${x.sign < 0 ? "減" : "増"}）`).join("・");
    if (gapMode() === "raw") {
      el.textContent = `記録どおりの値です（期間内の一斉変動の日＝${list.length}日）。` +
        (list.length ? `\n${dates}は本家側の再集計の跡で、実際の退会・入会ではありません。「ならす」で除けます。` : "\n「ならす」にすると、0に落ちて戻った日と一斉変動の日を除きます。");
    } else {
      el.textContent = `欠測の日をならしています（期間内の一斉変動の日＝${list.length}日）。` +
        `\n0に落ちて後で戻った日は前の値で埋め、一斉変動の日${list.length ? `（${dates}）` : ""}はその向きの増減を0にしています。「記録どおり」で元の値に戻せます。`;
    }
  }

  // メンバーの水準（見せ方「水準」）：全PJ合計（初日から積み上げ＝契約 C）と FiNANCiE公式PJ の2枚（2軸にしない）
  function renderMembersLevel(payload) {
    const mode = gapMode();
    const days = ovData.market.days;
    const labels = days.slice(ovState.startIdx, ovState.endIdx + 1);
    const shortLabels = labels.map(fmtMD);
    const level = core().membersLevel(payload, mode);
    const base = mode === "raw" ? payload.rows : core().membersInfo(payload).filled;
    const officialIdx = payload.folderIndex["308_tokenplus"];
    const all = labels.map((_, k) => level[ovState.startIdx + k]);
    const official = labels.map((_, k) => {
      const v = officialIdx === undefined ? null : base[officialIdx][ovState.startIdx + k];
      return typeof v === "number" ? v : null;
    });
    renderGapNote();
    const draw = (key, canvasId, label, data, color) => {
      const el = document.getElementById(canvasId);
      if (!el) return;
      if (ovCharts[key]) ovCharts[key].destroy();
      ovCharts[key] = new Chart(el.getContext("2d"), {
        type: "line",
        data: { labels, datasets: [{ label, data, borderColor: color, backgroundColor: "transparent", borderWidth: 2, pointRadius: 0, spanGaps: true, tension: 0.1 }] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: NO_CANVAS_LEGEND, tooltip: { mode: "index", intersect: false, callbacks: { label: (item) => `${label}: ${fmtInt(item.raw)} 人` } } },
          scales: {
            x: { ticks: xTicksOptions(shortLabels), grid: { color: chartColors().gridX } },
            y: { afterDataLimits: axisHeadroom, ticks: { color: chartColors().tick, callback: (v) => fmtInt(v) }, grid: { color: chartColors().gridY } }
          }
        }
      });
    };
    draw("membersLevelAll", "ovMembersLevelAll", "全PJ合計のメンバー数", all, ovColor(0));
    draw("membersLevelOfficial", "ovMembersLevelOfficial", "FiNANCiE公式PJのメンバー数", official, ovColor(1));
  }

  function renderPanelE(topFolders) {
    ensureMetricLoaded("members").then((payload) => {
      if (ovState.membersView === "level") { renderMembersLevel(payload); return; }
      const buckets = buildBuckets();
      const topN = topFolders.slice(0, ovState.topN);
      // 日ごとの純増（欠測の切替に従う・式は js/merged-core.js の membersDaily）
      const daily = core().membersDaily(payload, gapMode()).net;
      function netAddRow(folder) {
        const idx = payload.folderIndex[folder];
        if (idx === undefined) return {};
        const row = daily[idx];
        const net = {};
        for (let d = ovState.startIdx; d <= ovState.endIdx; d++) net[d] = row[d];
        return net;
      }

      const series = topN.map((tf) => {
        const net = netAddRow(tf.folder);
        const data = buckets.map((b) => {
          let s = 0, has = false;
          b.indices.forEach((di) => { if (net[di] !== null && net[di] !== undefined) { s += net[di]; has = true; } });
          return has ? s : 0;
        });
        return { name: tf.name, folder: tf.folder, data };
      });
      renderGapNote();

      // その他 = 上位N以外の全プロジェクトの純増合計
      const topFolderSet = new Set(topN.map((t) => t.folder));
      const otherIdx = payload.projects.map((p, i) => (topFolderSet.has(p.folder) ? -1 : i)).filter((i) => i >= 0);
      const othersData = buckets.map((b) => {
        let s = 0;
        otherIdx.forEach((pi) => {
          const row = daily[pi];
          b.indices.forEach((di) => { const v = row[di]; if (typeof v === "number") s += v; });
        });
        return s;
      });

      const labels = buckets.map((b) => b.label);
      const shortLabels = buckets.map((b) => b.short);
      const datasets = series.map((s, i) => ({
        label: s.name,
        ftId: s.folder,
        data: s.data,
        backgroundColor: ovColor(i),
        stack: "members"
      }));
      datasets.push({
        label: "その他",
        data: othersData,
        backgroundColor: ovOtherColor(),
        stack: "members",
        hidden: !ovState.showOthers,
      ftLocked: !ovState.showOthers // 「その他を表示」で隠したときは凡例の記憶・「全部出す」の対象にしない
      });

      if (ovCharts.members) ovCharts.members.destroy();
      const ctx = document.getElementById("ovMembersChart").getContext("2d");
      ovCharts.members = new Chart(ctx, {
        type: "bar",
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: NO_CANVAS_LEGEND,
            tooltip: { mode: "index", intersect: false }
          },
          scales: {
            x: { stacked: true, ticks: xTicksOptions(shortLabels), grid: { color: chartColors().gridX } },
            y: { stacked: true, afterDataLimits: axisHeadroom, ticks: { color: chartColors().tick }, grid: { color: chartColors().gridY } }
          }
        }
      });
      renderHtmlLegend("members");
    });
  }

  /* ------------------------------------------------------------
   * 状態をURLに残す（個別分析から戻っても期間・上位・指標が保たれる・軽9）
   * ------------------------------------------------------------ */
  const URL_KEYS = { period: "ov_p", granularity: "ov_g", topN: "ov_n", metric: "ov_m", start: "ov_s", end: "ov_e", others: "ov_o" };

  function syncUrl() {
    if (merged()) return; // URL の持ち主は js/merged.js（契約 A）
    if (!window.history || !window.history.replaceState) return;
    const params = new URLSearchParams(window.location.search);
    Object.values(URL_KEYS).forEach((k) => params.delete(k));
    if (ovState.period !== OVERVIEW_CONFIG.defaultPeriod) params.set(URL_KEYS.period, String(ovState.period));
    if (ovState.period === "custom") {
      params.set(URL_KEYS.start, ovData.market.days[ovState.startIdx]);
      params.set(URL_KEYS.end, ovData.market.days[ovState.endIdx]);
    }
    if (ovState.granularityManual) params.set(URL_KEYS.granularity, ovState.granularity);
    if (ovState.topN !== OVERVIEW_CONFIG.defaultTopN) params.set(URL_KEYS.topN, String(ovState.topN));
    if (ovState.metric !== "volume") params.set(URL_KEYS.metric, ovState.metric);
    if (!ovState.showOthers) params.set(URL_KEYS.others, "0");
    const qs = params.toString();
    const url = `${window.location.pathname}${qs ? "?" + qs : ""}${window.location.hash}`;
    window.history.replaceState(null, "", url);
  }

  // 選択中の釦に active と aria-pressed（シェアの見せ方の組だけ aria-pressed が無かった＝エマ v3.2.0 中5）
  function setActive(group, attr, value) {
    group.querySelectorAll("button").forEach((b) => {
      const on = b.getAttribute(attr) === String(value);
      b.classList.toggle("active", on);
      if (b.hasAttribute(attr)) b.setAttribute("aria-pressed", String(on));
    });
  }

  // 期間の注記（操作帯の開始〜終了の横）：入れ替え・粒度を自動で週にした・週の端数を捨てた（エマ v3.2.0 軽11）
  function renderRangeNote() {
    if (!dom.rangeNote) return;
    const lines = [];
    if (ovState.rangeSwapped) lines.push("開始日と終了日を入れ替えました");
    if (ovState.granularity === "week" && !ovState.granularityManual) lines.push("期間が1年を超えるので、粒度を「週」にしました（粒度の釦で変えられます）");
    if (ovState.granularity === "week" && ovState.bucketDropped > 0) lines.push(`週は期末を末尾にした7日区切りのため、先頭の${ovState.bucketDropped}日は週の図に入れていません`);
    dom.rangeNote.textContent = lines.length ? `${lines.join("。")}。` : "";
    dom.rangeNote.classList.toggle("hidden-element", lines.length === 0);
  }

  // スマホの「絞り込み ▾」：たたんでいても今の選び方が分かるように要約を出す（エマ v3.2.0 中9）
  const GRANULARITY_LABELS = { day: "日", week: "週", month: "月" };
  function updateControlsSummary() {
    const el = document.getElementById("ov-controls-summary");
    if (!el || !ovData.market) return;
    const days = ovData.market.days;
    const parts = [];
    if (ovState.period === "custom") parts.push(`${fmtMD(days[ovState.startIdx])}〜${fmtMD(days[ovState.endIdx])}`);
    // 「（自動）」は期間に合わせて週へ切り替えたときだけ（既定の「日」に付けると何が自動か分からない＝エマ v3.2.1 軽）
    parts.push(`${GRANULARITY_LABELS[ovState.granularity] || ""}${!ovState.granularityManual && ovState.granularity === "week" ? "（自動）" : ""}`);
    parts.push(`上位${ovState.topN}`);
    parts.push(ovState.showOthers ? "その他あり" : "その他なし");
    parts.push(gapMode() === "raw" ? "記録どおり" : "ならす");
    el.textContent = parts.join("・");
  }

  function setupControlsToggle() {
    const btn = document.getElementById("ov-controls-toggle");
    const bar = document.getElementById("overview-controls");
    if (!btn || !bar || btn.dataset.bound) return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => {
      const collapsed = bar.classList.toggle("is-collapsed");
      btn.setAttribute("aria-expanded", String(!collapsed));
      if (btn.firstElementChild) btn.firstElementChild.textContent = collapsed ? "絞り込み ▾" : "絞り込み ▴";
    });
  }

  // 共通の状態（js/merged.js）を、このファイルの状態と釦の見た目へ写す
  function pullMergedState() {
    const m = merged();
    if (!m) return;
    const s = m.state();
    ovState.period = s.period;
    ovState.customStart = s.start;
    ovState.customEnd = s.end;
    ovState.granularity = s.granularity;
    ovState.granularityManual = s.granularityManual;
    ovState.topN = s.topN;
    ovState.metric = s.metric;
    ovState.showOthers = s.showOthers;
    ovState.gapMode = s.gap === "raw" ? "raw" : "exclude";
    ovState.shareView = s.views.share === "trend" ? "stack" : s.views.share; // donut | stack | bundle
    ovState.priceView = s.views.price;
    ovState.pricePick = s.views.pricePick;
    ovState.membersView = s.views.members;
    if (!dom) return;
    if (s.period === "custom") dom.periodGroup.querySelectorAll("button").forEach((b) => { b.classList.remove("active"); b.setAttribute("aria-pressed", "false"); }); // 期間の釦を外すときは aria-pressed も（断 v3.2.1 重1）
    else setActive(dom.periodGroup, "data-period", String(s.period));
    setActive(dom.granularityGroup, "data-granularity", s.granularity);
    setActive(dom.topnGroup, "data-topn", String(s.topN));
    setActive(dom.metricGroup, "data-metric", s.metric);
    if (dom.showOthers) dom.showOthers.checked = s.showOthers;
    if (dom.shareView) setActive(dom.shareView, "data-view", ovState.shareView); // donut | stack | bundle（再読み込み後も記憶に合わせる）
    const gapGroup = document.getElementById("ov-gap-mode");
    if (gapGroup) gapGroup.querySelectorAll("button[data-gap]").forEach((b) => {
      const on = (b.getAttribute("data-gap") === "raw") === (s.gap === "raw");
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    });
  }

  let recomputeQueued = false;
  function scheduleRecompute() {
    if (!ovState.initialized || recomputeQueued) return;
    recomputeQueued = true;
    Promise.resolve().then(() => { recomputeQueued = false; recomputeAll(); });
  }

  function restoreStateFromUrl() {
    if (merged()) { pullMergedState(); return; }
    const params = new URLSearchParams(window.location.search);
    const p = params.get(URL_KEYS.period);
    if (p === "all" || ["7", "30", "90", "365"].includes(p)) {
      ovState.period = p === "all" ? "all" : Number(p);
      setActive(dom.periodGroup, "data-period", p);
    } else if (p === "custom" && params.get(URL_KEYS.start) && params.get(URL_KEYS.end)) {
      ovState.period = "custom";
      dom.startInput.value = params.get(URL_KEYS.start);
      dom.endInput.value = params.get(URL_KEYS.end);
      dom.periodGroup.querySelectorAll("button").forEach((b) => { b.classList.remove("active"); b.setAttribute("aria-pressed", "false"); }); // 期間の釦を外すときは aria-pressed も（断 v3.2.1 重1）
    }
    const g = params.get(URL_KEYS.granularity);
    if (["day", "week", "month"].includes(g)) {
      ovState.granularity = g;
      ovState.granularityManual = true;
      setActive(dom.granularityGroup, "data-granularity", g);
    }
    const n = params.get(URL_KEYS.topN);
    if (["10", "20", "30"].includes(n)) {
      ovState.topN = Number(n);
      setActive(dom.topnGroup, "data-topn", n);
    }
    const m = params.get(URL_KEYS.metric);
    if (METRIC_LABELS[m]) {
      ovState.metric = m;
      setActive(dom.metricGroup, "data-metric", m);
    }
    if (params.get(URL_KEYS.others) === "0") {
      ovState.showOthers = false;
      dom.showOthers.checked = false;
    }
  }

  /* ------------------------------------------------------------
   * 全体の再描画
   * ------------------------------------------------------------ */
  function recomputeAll() {
    pullMergedState();
    computeRange();
    autoAdjustGranularity();
    renderHeadings();
    const topFolders = computeTopNVolumeFolders();
    renderKPIs(topFolders);
    renderPanelAB(topFolders);
    renderRangeNote(); // 週の端数（bucketDropped）は renderPanelAB の中で決まる
    updateControlsSummary();
    renderPanelC();
    // パネルD/Eは、画面に一度出てくるまでは描画（＝price.json/members.jsonの取得）を遅らせる。
    // （初回読み込みを market.json + v24.json だけに絞るため。一度出たら以降は追随する）
    if (ovState.panelDReady) renderPanelD(topFolders);
    if (ovState.panelEReady) renderPanelE(topFolders);
    syncUrl();
  }

  // パネルD/Eが画面に入って初めて、それぞれの指標データを読んで描画する。
  function setupLazyPanels() {
    const dCard = document.getElementById("ovPriceChart").closest(".chart-card");
    const eCard = document.getElementById("ovMembersChart").closest(".chart-card");

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        // データを読む前に画面に入ったとき（再読み込みでスクロール位置が戻った等）は、印だけ付けて初回の描画に任せる
        if (!ovState.initialized) {
          if (entry.target === dCard) ovState.panelDReady = true;
          if (entry.target === eCard) ovState.panelEReady = true;
          observer.unobserve(entry.target);
          return;
        }
        if (entry.target === dCard && !ovState.panelDReady) {
          ovState.panelDReady = true;
          renderPanelD(computeTopNVolumeFolders());
          observer.unobserve(dCard);
        }
        if (entry.target === eCard && !ovState.panelEReady) {
          ovState.panelEReady = true;
          renderPanelE(computeTopNVolumeFolders());
          observer.unobserve(eCard);
        }
      });
    }, { root: null, threshold: 0.05 });

    observer.observe(dCard);
    observer.observe(eCard);
  }

  // 凡例の初期状態：PCは開く・スマホはたたむ（描画域を優先）。以降は利用者の開閉を保つ。
  function setupLegends() {
    const open = !isMobile();
    Object.values(dom.legends).forEach((box) => { if (box) box.open = open; });
  }

  function applyChartSize(key) {
    const box = dom.legends[key];
    if (!box) return;
    const card = box.closest(".chart-card");
    const wrap = card.querySelector(".chart-wrapper");
    const size = chartSizeOf(key);
    wrap.style.height = `${isMobile() ? CHART_SIZES[size].sp : CHART_SIZES[size].pc}px`;
    card.querySelectorAll(".ov-size-btn[data-size]").forEach((b) => { // 見せ方の釦（data-view）は触らない
      const on = b.getAttribute("data-size") === size;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    });
    if (ovCharts[key]) ovCharts[key].resize();
  }

  function setupChartSizes() {
    Object.keys(dom.legends).forEach((key) => {
      const box = dom.legends[key];
      if (!box) return;
      const card = box.closest(".chart-card");
      card.querySelectorAll(".ov-size-btn[data-size]").forEach((b) => {
        b.addEventListener("click", () => {
          chartSizes[key] = b.getAttribute("data-size");
          try { localStorage.setItem(SIZE_KEY, JSON.stringify(chartSizes)); } catch (e) { /* 記憶できなくても動く */ }
          applyChartSize(key);
        });
      });
      applyChartSize(key);
    });
    // PC⇄スマホの境目をまたいだら高さを取り直す
    if (window.matchMedia) {
      const mq = window.matchMedia("(max-width: 768px)");
      const onChange = () => Object.keys(dom.legends).forEach(applyChartSize);
      if (mq.addEventListener) mq.addEventListener("change", onChange); else if (mq.addListener) mq.addListener(onChange);
    }
  }

  /* ------------------------------------------------------------
   * イベント登録
   * ------------------------------------------------------------ */
  let dateTimer = null;
  const editingInputs = new Set(); // フォーカス中の日付欄（focus で入れ blur で外す）

  // "YYYY-MM-DD" で 2000年以降なら、打ち終わった値とみなす
  function isPlausibleDate(v) {
    return /^\d{4}-\d{2}-\d{2}$/.test(v || "") && Number(v.slice(0, 4)) >= 2000;
  }

  // 確定済みの期間を日付欄へ書き戻す（打ちかけの値を捨てる／入れ替え後の値を両方の欄に出す）
  function restoreDateInputs() {
    if (!ovData.market) return;
    const days = ovData.market.days;
    dom.startInput.value = days[ovState.startIdx];
    dom.endInput.value = days[ovState.endIdx];
  }

  // 日付欄の確定（重4）：フォーカスが外れた・Enter・または入力が止まって一定時間で再計算する。
  function commitDateInputs() {
    if (dateTimer) { clearTimeout(dateTimer); dateTimer = null; }
    if (!ovState.dateDirty) return;
    ovState.dateDirty = false;
    if (merged()) {
      const a = dom.startInput.value, b = dom.endInput.value;
      if (isPlausibleDate(a) && isPlausibleDate(b)) merged().set({ period: "custom", start: a, end: b, granularityManual: false });
      else restoreDateInputs();
      return;
    }
    dom.periodGroup.querySelectorAll("button").forEach((b) => { b.classList.remove("active"); b.setAttribute("aria-pressed", "false"); }); // 期間の釦を外すときは aria-pressed も（断 v3.2.1 重1）
    ovState.period = "custom";
    ovState.granularityManual = false;
    recomputeAll();
  }

  function attachEvents() {
    dom.periodGroup.querySelectorAll("button[data-period]").forEach((btn) => {
      btn.addEventListener("click", () => {
        setActive(dom.periodGroup, "data-period", btn.getAttribute("data-period"));
        const val = btn.getAttribute("data-period");
        if (merged()) { merged().set({ period: val === "all" ? "all" : Number(val), start: null, end: null, granularityManual: false }); return; }
        ovState.period = val === "all" ? "all" : Number(val);
        ovState.granularityManual = false;
        ovState.dateDirty = false;
        recomputeAll();
      });
    });

    [dom.startInput, dom.endInput].forEach((input) => {
      input.addEventListener("focus", () => editingInputs.add(input));
      input.addEventListener("change", () => {
        ovState.dateDirty = true;
        if (editingInputs.has(input)) {
          // 年の桁が揃っていない途中の値（例 0002-06-15）では再計算しない
          if (!isPlausibleDate(dom.startInput.value) || !isPlausibleDate(dom.endInput.value)) return;
          // 打っている途中＝止まってから再計算（値の書き戻しは computeRange 側でフォーカス中は行わない）
          if (dateTimer) clearTimeout(dateTimer);
          dateTimer = setTimeout(commitDateInputs, OVERVIEW_CONFIG.dateInputDebounceMs);
        } else {
          commitDateInputs();
        }
      });
      input.addEventListener("blur", () => {
        editingInputs.delete(input);
        // 🔴 blur では欄の値から再計算しない（入れ替え後に片方の欄だけ古い値が残り、表示と集計がズレた回帰＝エマ再検収 重1）。
        //    未確定なら確定（両方の欄へ書き戻す）、確定済みなら欄を確定値へ戻すだけ。
        if (ovState.dateDirty) commitDateInputs();
        else restoreDateInputs();
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); input.blur(); } // blur 側で確定する（編集中フラグを外してから書き戻すため）
      });
    });

    dom.granularityGroup.querySelectorAll("button[data-granularity]").forEach((btn) => {
      btn.addEventListener("click", () => {
        setActive(dom.granularityGroup, "data-granularity", btn.getAttribute("data-granularity"));
        if (merged()) { merged().set({ granularity: btn.getAttribute("data-granularity"), granularityManual: true }); return; }
        ovState.granularity = btn.getAttribute("data-granularity");
        ovState.granularityManual = true;
        const topFolders = computeTopNVolumeFolders();
        renderPanelAB(topFolders);
        if (ovState.panelEReady) renderPanelE(topFolders);
        syncUrl();
      });
    });

    dom.topnGroup.querySelectorAll("button[data-topn]").forEach((btn) => {
      btn.addEventListener("click", () => {
        setActive(dom.topnGroup, "data-topn", btn.getAttribute("data-topn"));
        if (merged()) { merged().set({ topN: Number(btn.getAttribute("data-topn")) }); return; }
        ovState.topN = Number(btn.getAttribute("data-topn"));
        recomputeAll();
      });
    });

    dom.metricGroup.querySelectorAll("button[data-metric]").forEach((btn) => {
      btn.addEventListener("click", () => {
        setActive(dom.metricGroup, "data-metric", btn.getAttribute("data-metric"));
        if (merged()) { merged().set({ metric: btn.getAttribute("data-metric") }); return; }
        ovState.metric = btn.getAttribute("data-metric");
        renderPanelC();
        syncUrl();
      });
    });

    dom.showOthers.addEventListener("change", () => {
      ovState.showOthers = dom.showOthers.checked;
      // 入れ直したら「その他」は必ず出す（凡例で消した記憶が残って食い違わないように・断 v3.1 重1）
      if (ovState.showOthers && window.FtLegend) window.FtLegend.forget(["ov:volume", "ov:share", "ov:members"], "その他");
      if (merged()) { merged().set({ showOthers: ovState.showOthers }); return; }
      const topFolders = computeTopNVolumeFolders();
      renderPanelAB(topFolders);
      if (ovState.panelEReady) renderPanelE(topFolders);
      renderPanelC();
      syncUrl();
    });

    if (dom.errorReload) {
      dom.errorReload.addEventListener("click", () => window.location.reload());
    }

    // メンバー数の増減：欠測を除く／そのまま（記憶・ルク指摘 07:10）
    const gapGroup = document.getElementById("ov-gap-mode");
    if (gapGroup) {
      gapGroup.querySelectorAll("button[data-gap]").forEach((b) => b.classList.toggle("active", (b.getAttribute("data-gap") === "raw") === (gapMode() === "raw")));
      gapGroup.querySelectorAll("button[data-gap]").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (merged()) { merged().set({ gap: btn.getAttribute("data-gap") === "raw" ? "raw" : "smooth" }); return; }
          ovState.gapMode = btn.getAttribute("data-gap") === "raw" ? "raw" : "exclude";
          try { localStorage.setItem(GAP_MODE_KEY, ovState.gapMode); } catch (e) { /* 記憶できなくても動く */ }
          setActive(gapGroup, "data-gap", ovState.gapMode);
          if (ovState.panelEReady) renderPanelE(computeTopNVolumeFolders());
        });
      });
    }

    if (dom.shareView) {
      const syncShareButtons = () => setActive(dom.shareView, "data-view", ovState.shareView);
      syncShareButtons();
      dom.shareView.querySelectorAll("button[data-view]").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (merged()) { const v = btn.getAttribute("data-view"); merged().setView("share", v === "donut" || v === "bundle" ? v : "trend"); return; }
          ovState.shareView = btn.getAttribute("data-view") === "donut" ? "donut" : "stack";
          try { localStorage.setItem(SHARE_VIEW_KEY, ovState.shareView); } catch (e) { /* 記憶できなくても動く */ }
          syncShareButtons();
          if (ovState.initialized) renderPanelAB(computeTopNVolumeFolders());
        });
      });
    }
  }

  /* ------------------------------------------------------------
   * 初回表示
   * ------------------------------------------------------------ */
  function showLoadError(err) {
    console.error("Overview load error:", err);
    if (dom.error) {
      dom.error.classList.remove("hidden-element");
      if (dom.errorText) dom.errorText.textContent = "全体市況のデータの読み込みに失敗しました。通信状態を確かめて、もう一度読み込んでください。";
    }
    dom.rankingTbody.innerHTML = `<tr><td colspan="6" class="text-center">全体市況のデータの読み込みに失敗しました。</td></tr>`;
  }

  function init() {
    bindDom();
    attachEvents();
    setupControlsToggle();
    setupLegends();
    setupChartSizes();
    setupLazyPanels();
    restoreStateFromUrl();
    if (merged()) merged().subscribe(() => scheduleRecompute()); // 共通の状態が変わったら描き直す

    Promise.all([
      ensureMetricLoaded("market"),
      ensureMetricLoaded("volume")
    ]).then(() => {
      const days = ovData.market.days;
      [dom.startInput, dom.endInput].forEach((input) => {
        input.min = days[0];
        input.max = days[days.length - 1];
      });
      ovState.initialized = true;
      recomputeAll();
    }).catch(showLoadError);
  }

  function onShow() {
    if (!ovState.initialized) {
      init();
    }
  }

  console.info("FiNANCiE TIMES overview v" + OV_APP_VERSION);
  setupThemeToggle(); // ヘッダーのトグルは総覧タブに関係なく効かせる
  window.FinancieOverview = {
    onShow,
    OVERVIEW_CONFIG,
    // 検査用（tests/check_overview.js から参照）。本番の見た目には影響しない。
    _debug: { state: ovState, charts: ovCharts, data: ovData, membersGapInfo, ovColor, isMobile, applyTheme, currentTheme, chartSizeOf, CHART_SIZES }
  };
})();
