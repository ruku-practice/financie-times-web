/* ============================================================
 * FiNANCiE TIMES 「分析」タブ v0.1.0（2026-09-13）
 *
 * 分析レポート（company/output/2026-09/2026-09-12_FiNANCiE_分析レポート_直近の動きと機運.md）
 * の図10枚を、期間（30日／90日／1年／全期間／自由）を切り替えて描き直す。
 * データは scripts/build_analysis.py が夜間に作る data/analysis/*.json（静的）。
 *
 * advanced.js が読み込まれたあとに読み込まれる想定。advanced.js の switchTab から
 * window.FinancieAnalysis.onShow() を呼んでもらう（全体市況 overview.js と同じ型）。
 *
 * 合体時（全体市況とのガッチャンコ）のメモ：
 *  - computeRange / fmt* / HTML凡例 は overview.js とほぼ同じ写し＝共有モジュールへ切り出す候補
 *  - テーマ（白黒）は overview.js のトグルが <html data-theme> を変えるのを MutationObserver で見て追従
 *  - 出来高の欠測の扱いが全体市況と違う（分析＝生の記録値・全体市況＝24h=30日を欠測）＝統一はルク判断
 * ============================================================ */

(function () {
  "use strict";

  const AN_VERSION = "0.1.0";

  const AN_CONFIG = {
    files: {
      series: "data/analysis/series.json",
      v24: "data/analysis/v24.json",
      price: "data/analysis/price.json",
      monthly: "data/analysis/monthly.json",
      bundles: "data/analysis/bundles.json"
    },
    defaultPeriod: 90,           // 30 | 90 | 365 | 'all' | 'custom'
    dumbbellTop: 8,
    priceTop: 10,
    shareTop: 5,
    rankingTop: 30,
    monthlyMinMonths: 3,         // 期間内の完了月がこれ未満なら直近6か月に広げる
    monthlyFallbackMonths: 6,
    thresholds: {                // 機運の5指標（レポート§5・先に決めた閾値）
      volumeChangePct: 20,
      activeChangePct: 10,
      priceUpCount: 6
    }
  };

  // dataviz スキルの検証済みパレット（8色・並び順が CVD 安全の仕組み・光/暗で段を変える）
  const PALETTE = {
    light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
    dark:  ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"]
  };
  const OTHER_COLOR = { light: "#8a8986", dark: "#77766f" };
  const EXTRA_COLOR = { light: "#52514e", dark: "#c3c2b7" }; // 9〜10本目（点線・破線で見分ける）

  const URL_KEYS = { period: "an_p", start: "an_s", end: "an_e" };

  /* ------------------------------------------------------------
   * 状態
   * ------------------------------------------------------------ */
  const anState = {
    initialized: false,
    loaded: false,
    period: AN_CONFIG.defaultPeriod,
    startIdx: 0,
    endIdx: 0,
    rangeSwapped: false,
    pendingStart: null, // 自由期間（適用前）
    pendingEnd: null
  };
  const anData = {};
  const anCharts = {};
  const colorMap = {}; // folder → パレットの段（同じPJは期間を変えても同じ色）
  let dom = null;

  /* ------------------------------------------------------------
   * 小道具
   * ------------------------------------------------------------ */
  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  }
  function palette() { return PALETTE[currentTheme()]; }
  function otherColor() { return OTHER_COLOR[currentTheme()]; }
  function chartInk() {
    const light = currentTheme() === "light";
    return {
      tick: light ? "#52514e" : "#c3c2b7",
      gridX: light ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.04)",
      gridY: light ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.07)"
    };
  }
  function isMobile() {
    return window.matchMedia && window.matchMedia("(max-width: 768px)").matches;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmtInt(v) {
    if (v === null || v === undefined || isNaN(v)) return "-";
    return Math.round(v).toLocaleString("ja-JP");
  }
  // 円 → 読みやすい単位（億円／万円／円）
  function fmtYen(v) {
    if (v === null || v === undefined || isNaN(v)) return "-";
    const a = Math.abs(v);
    if (a >= 1e8) return (v / 1e8).toFixed(2) + "億円";
    if (a >= 1e4) return Math.round(v / 1e4).toLocaleString("ja-JP") + "万円";
    return Math.round(v).toLocaleString("ja-JP") + "円";
  }
  // 軸用の短い表記
  function fmtYenTick(v) {
    const a = Math.abs(v);
    if (a >= 1e8) return (v / 1e8).toFixed(a >= 1e9 ? 0 : 1) + "億";
    if (a >= 1e4) return Math.round(v / 1e4).toLocaleString("ja-JP") + "万";
    return String(Math.round(v));
  }
  function fmtPct(v, digits) {
    if (v === null || v === undefined || isNaN(v) || !isFinite(v)) return "-";
    const d = digits === undefined ? 1 : digits;
    let t = v.toFixed(d);
    if (Number(t) === 0) t = (0).toFixed(d); // 「-0%」を出さない
    return (Number(t) > 0 ? "+" : "") + t + "%";
  }
  function pctChange(now, base) {
    if (base === null || base === undefined || base === 0 || now === null || now === undefined) return null;
    return (now / base - 1) * 100;
  }
  function fmtMD(d) { return d.slice(5, 7).replace(/^0/, "") + "/" + d.slice(8, 10).replace(/^0/, ""); }
  function fmtYMD(d) { return d.replace(/-/g, "/"); }
  function addDays(dateStr, n) {
    const d = new Date(dateStr + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function daysBetween(a, b) {
    return Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000);
  }
  function changeClass(v) { return v === null ? "" : v > 0 ? "an-up" : v < 0 ? "an-down" : ""; }
  function financieUrl(p) { return "https://financie.jp/users/" + encodeURIComponent(p.slug || p.folder); }

  // 日付 → index（無い日は直前／直後）
  function floorIndex(days, target) {
    let lo = 0, hi = days.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (days[mid] <= target) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }
  function ceilIndex(days, target) {
    let lo = 0, hi = days.length - 1, ans = days.length;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (days[mid] >= target) { ans = mid; hi = mid - 1; } else lo = mid + 1; }
    return ans;
  }

  /* ------------------------------------------------------------
   * 読み込み
   * ------------------------------------------------------------ */
  function fetchJson(path) {
    return fetch(path, { cache: "no-cache" }).then((r) => {
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      return r.json();
    });
  }

  function loadAll() {
    const f = AN_CONFIG.files;
    return Promise.all([
      fetchJson(f.series), fetchJson(f.v24), fetchJson(f.price), fetchJson(f.monthly), fetchJson(f.bundles)
    ]).then(([series, v24, price, monthly, bundles]) => {
      anData.series = series;
      anData.v24 = v24;
      anData.price = price;
      anData.monthly = monthly;
      anData.bundles = bundles;
      anData.dayIndex = {};
      series.days.forEach((d, i) => { anData.dayIndex[d] = i; });
      anData.folderIndex = {};
      v24.projects.forEach((p, i) => { anData.folderIndex[p.folder] = i; });
      anData.priceFolderIndex = {};
      price.projects.forEach((p, i) => { anData.priceFolderIndex[p.folder] = i; });
      anState.loaded = true;
    });
  }

  /* ------------------------------------------------------------
   * 期間（合体時に共有化：overview.js computeRange と同じ index 基準）
   * ------------------------------------------------------------ */
  function computeRange() {
    const days = anData.series.days;
    const latestIdx = days.length - 1;
    anState.rangeSwapped = false;
    if (anState.period === "custom") {
      let endIdx = anState.pendingEnd ? floorIndex(days, anState.pendingEnd) : latestIdx;
      if (endIdx < 0) endIdx = 0;
      let startIdx = anState.pendingStart ? ceilIndex(days, anState.pendingStart) : 0;
      if (startIdx >= days.length) startIdx = latestIdx;
      if (startIdx > endIdx) { const t = startIdx; startIdx = endIdx; endIdx = t; anState.rangeSwapped = true; }
      anState.startIdx = startIdx;
      anState.endIdx = endIdx;
    } else if (anState.period === "all") {
      anState.startIdx = 0;
      anState.endIdx = latestIdx;
    } else {
      const n = Number(anState.period);
      anState.endIdx = latestIdx;
      // 暦日で N 日（記録の欠けがあっても「終了日から N-1 日前」を開始日にする）
      const startDate = addDays(days[latestIdx], -(n - 1));
      anState.startIdx = Math.max(0, ceilIndex(days, startDate));
    }
    dom.startInput.value = days[anState.startIdx];
    dom.endInput.value = days[anState.endIdx];
    dom.rangeNote.textContent = anState.rangeSwapped ? "開始日と終了日を入れ替えました" : "";
    dom.rangeNote.classList.toggle("hidden-element", !anState.rangeSwapped);
  }

  function rangeLabel() {
    const days = anData.series.days;
    return `${fmtYMD(days[anState.startIdx])}〜${fmtYMD(days[anState.endIdx])}（${anState.endIdx - anState.startIdx + 1}日分の記録）`;
  }

  // 暦日の窓 [startDate, endDate] に入る index の配列
  function indicesBetween(startDate, endDate) {
    const days = anData.series.days;
    const s = ceilIndex(days, startDate);
    const e = floorIndex(days, endDate);
    const out = [];
    for (let i = s; i <= e; i++) out.push(i);
    return out;
  }

  function sumSeries(arr, indices) {
    let s = 0;
    indices.forEach((i) => { const v = arr[i]; if (v !== null && v !== undefined) s += v; });
    return s;
  }

  /* ------------------------------------------------------------
   * 集計（純粋関数・state の範囲に対して）
   * ------------------------------------------------------------ */
  function projectTotals(indices) {
    const v = anData.v24;
    return v.projects.map((p, pi) => {
      const row = v.rows[pi];
      let sum = 0;
      indices.forEach((i) => { const x = row[i]; if (x !== null && x !== undefined) sum += x; });
      return { folder: p.folder, slug: p.slug, name: p.name, short: p.short, total: sum };
    });
  }

  function rangeIndices() {
    const out = [];
    for (let i = anState.startIdx; i <= anState.endIdx; i++) out.push(i);
    return out;
  }

  // 前期間＝同じ長さ（暦日）の直前
  function prevRangeIndices() {
    const days = anData.series.days;
    const len = daysBetween(days[anState.startIdx], days[anState.endIdx]) + 1;
    const prevEnd = addDays(days[anState.startIdx], -1);
    const prevStart = addDays(prevEnd, -(len - 1));
    if (prevEnd < days[0]) return [];
    return indicesBetween(prevStart, prevEnd);
  }

  // 週＝期末を末尾にした暦日7日区切り。先頭の端数は捨てる。
  function weeklyBuckets() {
    const days = anData.series.days;
    const endDate = days[anState.endIdx];
    const startDate = days[anState.startIdx];
    const weeks = [];
    let we = endDate;
    while (true) {
      const ws = addDays(we, -6);
      if (ws < startDate) break;
      weeks.push({ start: ws, end: we, indices: indicesBetween(ws, we) });
      we = addDays(ws, -1);
    }
    weeks.reverse();
    const dropped = weeks.length ? daysBetween(startDate, weeks[0].start) : daysBetween(startDate, endDate) + 1;
    return { weeks, dropped };
  }

  function activeCount(indices) {
    const rows = anData.v24.rows;
    let n = 0;
    for (let pi = 0; pi < rows.length; pi++) {
      const row = rows[pi];
      for (let k = 0; k < indices.length; k++) {
        const x = row[indices[k]];
        if (x !== null && x !== undefined && x > 0) { n++; break; }
      }
    }
    return n;
  }

  // 価格指数：期間内で最初に 0 より大きい値の日＝100
  function priceIndexRow(folder, indices) {
    const pi = anData.priceFolderIndex[folder];
    if (pi === undefined) return indices.map(() => null);
    const row = anData.price.rows[pi];
    let base = null;
    return indices.map((i) => {
      const v = row[i];
      if (base === null) { if (v !== null && v !== undefined && v > 0) base = v; else return null; }
      if (v === null || v === undefined) return null;
      return (v / base) * 100;
    });
  }

  function priceAt(folder, idx) {
    const pi = anData.priceFolderIndex[folder];
    if (pi === undefined) return null;
    const v = anData.price.rows[pi][idx];
    return v === null || v === undefined ? null : v;
  }

  // 30日前の価格（無い／0 なら直前5日で代替）
  function priceAround(folder, dateStr) {
    const days = anData.series.days;
    for (let k = 0; k <= 5; k++) {
      const d = addDays(dateStr, -k);
      const idx = anData.dayIndex[d];
      if (idx === undefined) continue;
      const v = priceAt(folder, idx);
      if (v !== null && v > 0) return v;
    }
    return null;
  }

  // 束・単独PJ・その他の区分（レポート§2の7区分）
  function segments() {
    const b = anData.bundles;
    const segs = b.bundles.map((x) => ({ key: x.key, label: x.label, folders: x.folders }));
    b.standalone.forEach((f) => {
      const p = anData.v24.projects[anData.folderIndex[f]];
      if (p) segs.push({ key: f, label: p.short, folders: [f] });
    });
    return segs;
  }

  /* ------------------------------------------------------------
   * 機運の5指標（期末基準の固定窓・期間ボタンに依存しない）
   * ------------------------------------------------------------ */
  function computeIndicators() {
    const S = anData.series;
    const days = S.days;
    const endDate = days[anState.endIdx];
    const T = AN_CONFIG.thresholds;

    // 1. 直近30日 vs 前30日（出来高）
    const last30 = indicesBetween(addDays(endDate, -29), endDate);
    const prev30 = indicesBetween(addDays(endDate, -59), addDays(endDate, -30));
    const vLast = sumSeries(S.v24_total, last30);
    const vPrev = sumSeries(S.v24_total, prev30);
    const vChange = pctChange(vLast, vPrev);
    // 上位2PJを除いた比較
    const totLast = projectTotals(last30).sort((a, b) => b.total - a.total);
    const top2 = totLast.slice(0, 2);
    const totPrev = projectTotals(prev30);
    const prevMap = {}; totPrev.forEach((t) => { prevMap[t.folder] = t.total; });
    const exLast = vLast - top2.reduce((s, t) => s + t.total, 0);
    const exPrev = vPrev - top2.reduce((s, t) => s + (prevMap[t.folder] || 0), 0);
    const exChange = pctChange(exLast, exPrev);

    // 2. 月次が2か月連続増（直近の完了月3つ）
    const M = anData.monthly;
    const endMonth = endDate.slice(0, 7);
    const usable = [];
    M.months.forEach((m, j) => { if (m < endMonth && M.picked_days[j] <= endDate) usable.push({ month: m, total: M.totals[j] }); });
    const m3 = usable.slice(-3);
    const m2up = m3.length === 3 && m3[0].total < m3[1].total && m3[1].total < m3[2].total;

    // 3. 出来高が立ったPJ数：直近4週 vs 前4週
    const wk = [];
    for (let k = 0; k < 8; k++) {
      const we = addDays(endDate, -7 * k);
      const ws = addDays(we, -6);
      wk.push(activeCount(indicesBetween(ws, we)));
    }
    const recent4 = wk.slice(0, 4).reduce((a, b) => a + b, 0) / 4;
    const prev4 = wk.slice(4, 8).reduce((a, b) => a + b, 0) / 4;
    const aChange = pctChange(recent4, prev4);

    // 4. メンバー純増：直近30日 vs 前30日
    function membersOn(dateStr) {
      const idx = floorIndex(days, dateStr);
      if (idx < 0) return null;
      return S.members_total[idx];
    }
    const mEnd = membersOn(endDate);
    const m30 = membersOn(addDays(endDate, -30));
    const m60 = membersOn(addDays(endDate, -60));
    const mLast = mEnd !== null && m30 !== null ? mEnd - m30 : null;
    const mPrev = m30 !== null && m60 !== null ? m30 - m60 : null;

    // 5. 価格上位10（期末時点）のうち30日前より上昇
    const endIdx = anState.endIdx;
    const priceRank = anData.price.projects.map((p) => ({ folder: p.folder, short: p.short, price: priceAt(p.folder, endIdx) }))
      .filter((x) => x.price !== null && x.price > 0)
      .sort((a, b) => b.price - a.price)
      .slice(0, AN_CONFIG.priceTop);
    const before = addDays(endDate, -30);
    let upCount = 0;
    priceRank.forEach((x) => {
      const base = priceAround(x.folder, before);
      x.base = base;
      x.change = pctChange(x.price, base);
      if (base !== null && x.price > base) upCount++;
    });

    const items = [
      { n: 1, label: "直近30日出来高の前30日比", def: `全PJの24h出来高合算。${fmtMD(addDays(endDate, -29))}〜${fmtMD(endDate)} ÷ ${fmtMD(addDays(endDate, -59))}〜${fmtMD(addDays(endDate, -30))}`,
        threshold: `+${T.volumeChangePct}%以上`, actual: `${fmtYen(vLast)} ÷ ${fmtYen(vPrev)} ＝ ${fmtPct(vChange, 0)}（上位2PJを除くと ${fmtPct(exChange, 0)}）`,
        ok: vChange !== null && vChange >= T.volumeChangePct },
      { n: 2, label: "月次出来高が2か月連続増", def: `30日出来高（翌月1日）の全PJ合計。直近の完了月3つ（${m3.map((x) => x.month.slice(2).replace("-", "/")).join("→") || "-"}）`,
        threshold: "2か月連続増", actual: m3.length === 3 ? m3.map((x) => (x.total / 1e8).toFixed(2)).join(" → ") + "億円" : "完了月が3つ未満",
        ok: m2up },
      { n: 3, label: "出来高が立ったPJ数の広がり", def: "週に出来高＞0 の日があるPJ数。直近4週平均 ÷ 前4週平均（期末を末尾にした7日区切り）",
        threshold: `+${T.activeChangePct}%以上`, actual: `${recent4.toFixed(1)} ÷ ${prev4.toFixed(1)} ＝ ${fmtPct(aChange, 1)}`,
        ok: aChange !== null && aChange >= T.activeChangePct },
      { n: 4, label: "メンバー純増の加速", def: "全PJ合計（停止PJは据え置き）の直近30日純増 vs 前30日純増",
        threshold: "直近＞前30日 かつ 直近＞0", actual: `${mLast === null ? "-" : (mLast > 0 ? "+" : "") + fmtInt(mLast)}人 vs ${mPrev === null ? "-" : (mPrev > 0 ? "+" : "") + fmtInt(mPrev)}人`,
        ok: mLast !== null && mPrev !== null && mLast > mPrev && mLast > 0 },
      { n: 5, label: "価格上位10PJの反転", def: `${fmtMD(endDate)}時点の価格上位10PJのうち、30日前（${fmtMD(before)}・0なら直前5日）より上昇したPJ数`,
        threshold: `${T.priceUpCount}PJ以上`, actual: `${upCount} / ${priceRank.length}`,
        ok: upCount >= T.priceUpCount }
    ];
    const count = items.filter((x) => x.ok).length;
    const band = count >= 4 ? "あり" : count >= 2 ? "兆しあり" : "なし";
    return { items, count, band, vLast, vPrev, vChange, exChange, top2, recent4, prev4, aChange, mLast, mPrev, m3, priceRank, upCount, endDate };
  }

  /* ------------------------------------------------------------
   * 描画の共通部品
   * ------------------------------------------------------------ */
  function colorFor(folder, i) {
    const pal = palette();
    if (colorMap[folder] === undefined) {
      const used = new Set(Object.values(colorMap));
      let slot = -1;
      for (let k = 0; k < pal.length; k++) { if (!used.has(k)) { slot = k; break; } }
      colorMap[folder] = slot >= 0 ? slot : pal.length + (Object.keys(colorMap).length % 2);
    }
    const slot = colorMap[folder];
    if (slot < pal.length) return { color: pal[slot], dash: [] };
    return { color: EXTRA_COLOR[currentTheme()], dash: slot % 2 === 0 ? [6, 4] : [2, 3] };
  }

  function destroyChart(key) {
    if (anCharts[key]) { anCharts[key].destroy(); anCharts[key] = null; }
  }

  function xTicks(shortLabels) {
    return {
      color: chartInk().tick,
      maxRotation: 0, minRotation: 0, autoSkip: true,
      maxTicksLimit: isMobile() ? 6 : 12,
      font: { size: 11 },
      callback: (value, index) => shortLabels[index] !== undefined ? shortLabels[index] : value
    };
  }

  function yTicksYen() {
    return { color: chartInk().tick, font: { size: 11 }, callback: (v) => fmtYenTick(v) };
  }

  function baseOptions(extra) {
    const ink = chartInk();
    return Object.assign({
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false }, tooltip: { mode: "index", intersect: false } },
      scales: {
        x: { ticks: { color: ink.tick, font: { size: 11 } }, grid: { color: ink.gridX } },
        y: { ticks: { color: ink.tick, font: { size: 11 } }, grid: { color: ink.gridY } }
      }
    }, extra || {});
  }

  function makeChart(key, canvasId, config) {
    destroyChart(key);
    const el = document.getElementById(canvasId);
    if (!el) return null;
    anCharts[key] = new Chart(el.getContext("2d"), config);
    return anCharts[key];
  }

  // HTML凡例（押すと系列を出し入れ・円グラフはスライス単位）
  function renderLegend(key, boxId) {
    const chart = anCharts[key];
    const box = document.getElementById(boxId);
    if (!chart || !box) return;
    const isDonut = chart.config.type === "doughnut";
    const entries = isDonut
      ? chart.data.labels.map((label, i) => ({ label, color: chart.data.datasets[0].backgroundColor[i], visible: chart.getDataVisibility(i), dashed: false }))
      : chart.data.datasets.map((ds, i) => ({ label: ds.label, color: ds.borderColor || ds.backgroundColor, visible: chart.isDatasetVisible(i), dashed: !!(ds.borderDash && ds.borderDash.length) }));
    box.innerHTML = entries.map((en, i) =>
      `<button type="button" class="an-legend-item${en.visible ? "" : " off"}" data-index="${i}" aria-pressed="${en.visible}"><span class="an-legend-swatch${en.dashed ? " dashed" : ""}" style="background:${en.color};color:${en.color}"></span>${escapeHtml(en.label)}</button>`
    ).join("");
    box.querySelectorAll(".an-legend-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = Number(btn.getAttribute("data-index"));
        let vis;
        if (isDonut) { chart.toggleDataVisibility(i); vis = chart.getDataVisibility(i); }
        else { vis = !chart.isDatasetVisible(i); chart.setDatasetVisibility(i, vis); }
        chart.update();
        btn.classList.toggle("off", !vis);
        btn.setAttribute("aria-pressed", String(vis));
      });
    });
  }

  /* ------------------------------------------------------------
   * 0. 結論（KPI＋自動文）
   * ------------------------------------------------------------ */
  function renderConclusion(ind, totalsNow, prevTotalsMap, vNow, vPrev) {
    const days = anData.series.days;
    const range = rangeIndices();
    const change = pctChange(vNow, vPrev);
    const activeN = activeCount(range);
    const activePrev = prevRangeIndices().length ? activeCount(prevRangeIndices()) : null;

    dom.kpiTotal.textContent = fmtYen(vNow);
    dom.kpiTotalSub.textContent = rangeLabel();
    dom.kpiChange.textContent = fmtPct(change, 0);
    dom.kpiChange.className = "metric-value " + changeClass(change);
    dom.kpiChangeSub.textContent = vPrev > 0 ? `前期間 ${fmtYen(vPrev)}` : "前期間のデータなし";
    dom.kpiActive.textContent = fmtInt(activeN) + " PJ";
    dom.kpiActiveSub.textContent = activePrev === null ? "期間内に出来高＞0の日があるPJ" : `前期間 ${fmtInt(activePrev)} PJ`;
    dom.kpiMembers.textContent = ind.mLast === null ? "-" : (ind.mLast > 0 ? "+" : "") + fmtInt(ind.mLast) + "人";
    dom.kpiMembers.className = "metric-value " + changeClass(ind.mLast);
    dom.kpiMembersSub.textContent = ind.mPrev === null ? "前30日のデータなし" : `前30日 ${(ind.mPrev > 0 ? "+" : "") + fmtInt(ind.mPrev)}人`;
    dom.kpiVerdict.textContent = `${ind.count} / 5`;
    dom.kpiVerdictSub.textContent = `判定＝${ind.band}（期末 ${fmtYMD(ind.endDate)} 基準）`;

    // 自動文（テンプレ3本固定・数字差し込み・原因や見通しは書かない）
    const top1 = totalsNow[0];
    const share1 = vNow > 0 && top1 ? (top1.total / vNow) * 100 : null;
    const top2now = totalsNow.slice(0, 2);
    const exNow = vNow - top2now.reduce((s, t) => s + t.total, 0);
    const exPrev = vPrev - top2now.reduce((s, t) => s + (prevTotalsMap[t.folder] || 0), 0);
    const exChange = pctChange(exNow, exPrev);
    const dir = (v) => v === null ? "比較できず" : v >= 5 ? "増" : v <= -5 ? "減" : "横ばい";
    const lines = [];
    lines.push(`<strong>出来高：</strong>${rangeLabel()}の出来高合計は ${fmtYen(vNow)}。前期間比 ${fmtPct(change, 0)}（${dir(change)}）。` +
      (top1 ? `上位1PJは ${escapeHtml(top1.short)}（シェア ${share1.toFixed(1)}%）。上位2PJ（${top2now.map((t) => escapeHtml(t.short)).join("・")}）を除くと前期間比 ${fmtPct(exChange, 0)}。` : ""));
    lines.push(`<strong>裾野：</strong>出来高が立ったPJ数は ${fmtInt(activeN)} PJ` + (activePrev === null ? "。" : `（前期間 ${fmtInt(activePrev)} PJ）。`) +
      `期末直近4週平均 ${ind.recent4.toFixed(1)} PJ／前4週平均 ${ind.prev4.toFixed(1)} PJ（${fmtPct(ind.aChange, 1)}）。` +
      (ind.m3.length === 3 ? `直近の完了月3つの月次出来高は ${ind.m3.map((x) => (x.total / 1e8).toFixed(2)).join(" → ")} 億円。` : ""));
    lines.push(`<strong>判定：</strong>機運の5指標のうち当てはまるのは ${ind.count}/5 ＝「${ind.band}」（ルール：4〜5＝あり・2〜3＝兆しあり・0〜1＝なし）。` +
      `当てはまった指標＝${ind.items.filter((x) => x.ok).map((x) => x.n).join("・") || "なし"}。`);
    dom.conclusion.innerHTML = lines.map((l) => `<li>${l}</li>`).join("");
  }

  /* ------------------------------------------------------------
   * 1. 日次出来高＋7日平均
   * ------------------------------------------------------------ */
  function renderDaily() {
    const S = anData.series;
    const days = S.days;
    const range = rangeIndices();
    const labels = range.map((i) => days[i]);
    const shortLabels = range.map((i) => fmtMD(days[i]));
    const totals = range.map((i) => S.v24_total[i] === null ? null : S.v24_total[i]);
    // 7日移動平均＝その日を含む暦日7日の記録の平均（記録が4日未満なら null）
    const avg = range.map((i) => {
      const idxs = indicesBetween(addDays(days[i], -6), days[i]);
      const vals = idxs.map((k) => S.v24_total[k]).filter((v) => v !== null && v !== undefined);
      if (vals.length < 4) return null;
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    });
    const pal = palette();
    const many = range.length > 200;
    makeChart("daily", "anDailyChart", {
      type: "bar",
      data: {
        labels,
        datasets: [
          { type: "line", label: "7日移動平均", data: avg, borderColor: pal[1], backgroundColor: "transparent", borderWidth: 2, pointRadius: 0, tension: 0.2, spanGaps: true, order: 0 },
          { label: "日次出来高", data: totals, backgroundColor: pal[0], borderRadius: many ? 0 : 3, barPercentage: many ? 1 : 0.8, categoryPercentage: many ? 1 : 0.9, order: 1 }
        ]
      },
      options: baseOptions({
        scales: {
          x: { ticks: xTicks(shortLabels), grid: { color: chartInk().gridX } },
          y: { beginAtZero: true, ticks: yTicksYen(), grid: { color: chartInk().gridY } }
        },
        plugins: { legend: { display: false }, tooltip: { mode: "index", intersect: false, callbacks: { label: (c) => `${c.dataset.label}: ${fmtYen(c.parsed.y)}` } } }
      })
    });
    renderLegend("daily", "an-legend-daily");
    const max = totals.reduce((m, v, k) => (v !== null && (m.v === null || v > m.v) ? { v, k } : m), { v: null, k: -1 });
    dom.dailySub.textContent = rangeLabel();
    dom.dailyNote.textContent = max.v === null ? "" : `期間内の最大は ${fmtYMD(labels[max.k])} の ${fmtYen(max.v)}。7日平均の底は ${fmtYen(Math.min.apply(null, avg.filter((v) => v !== null)))}。`;
  }

  /* ------------------------------------------------------------
   * 2. 週次出来高・出来高が立ったPJ数（2軸にせず2枚）
   * ------------------------------------------------------------ */
  function renderWeekly() {
    const S = anData.series;
    const { weeks, dropped } = weeklyBuckets();
    const labels = weeks.map((w) => `${fmtMD(w.start)}〜${fmtMD(w.end)}`);
    const shortLabels = weeks.map((w) => fmtMD(w.start));
    const totals = weeks.map((w) => sumSeries(S.v24_total, w.indices));
    const actives = weeks.map((w) => activeCount(w.indices));
    const pal = palette();
    const many = weeks.length > 60;
    makeChart("weeklyVol", "anWeeklyVolChart", {
      type: "bar",
      data: { labels, datasets: [{ label: "週次出来高", data: totals, backgroundColor: pal[0], borderRadius: many ? 0 : 3 }] },
      options: baseOptions({
        scales: { x: { ticks: xTicks(shortLabels), grid: { color: chartInk().gridX } }, y: { beginAtZero: true, ticks: yTicksYen(), grid: { color: chartInk().gridY } } },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `週次出来高: ${fmtYen(c.parsed.y)}` } } }
      })
    });
    makeChart("weeklyActive", "anWeeklyActiveChart", {
      type: "line",
      data: { labels, datasets: [{ label: "出来高が立ったPJ数", data: actives, borderColor: pal[2], backgroundColor: "transparent", borderWidth: 2, pointRadius: many ? 0 : 3, tension: 0.2 }] },
      options: baseOptions({
        scales: { x: { ticks: xTicks(shortLabels), grid: { color: chartInk().gridX } }, y: { beginAtZero: true, ticks: { color: chartInk().tick, font: { size: 11 }, precision: 0 }, grid: { color: chartInk().gridY } } },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `出来高が立ったPJ数: ${c.parsed.y} PJ` } } }
      })
    });
    dom.weeklySub.textContent = `${weeks.length}週`;
    const last4 = actives.slice(-4), prev4 = actives.slice(-8, -4);
    const avg = (a) => a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : "-";
    dom.weeklyNote.textContent = (dropped > 0 ? `期間の先頭 ${dropped} 日は7日に満たないため週に入れていません。` : "") +
      (weeks.length >= 8 ? ` 直近4週平均 ${avg(last4)} PJ／その前4週平均 ${avg(prev4)} PJ。` : "") +
      " 全体市況タブの「週」は ISO 週（月曜始まり）なので区切りが違います。";
  }

  /* ------------------------------------------------------------
   * 3. 上位8の今期間 vs 前期間（横棒2本）＋ 上位2PJの価格指数
   * ------------------------------------------------------------ */
  function renderDumbbell(totalsNow, prevTotalsMap) {
    const top = totalsNow.slice(0, AN_CONFIG.dumbbellTop);
    const labels = top.map((t) => t.short);
    const pal = palette();
    makeChart("dumbbell", "anDumbbellChart", {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "前期間", data: top.map((t) => prevTotalsMap[t.folder] || 0), backgroundColor: otherColor(), borderRadius: 3 },
          { label: "今期間", data: top.map((t) => t.total), backgroundColor: pal[1], borderRadius: 3 }
        ]
      },
      options: baseOptions({
        indexAxis: "y",
        interaction: { mode: "index", intersect: false, axis: "y" },
        scales: {
          x: { beginAtZero: true, ticks: yTicksYen(), grid: { color: chartInk().gridY } },
          y: { ticks: { color: chartInk().tick, font: { size: 12 } }, grid: { display: false } }
        },
        plugins: { legend: { display: false }, tooltip: { mode: "index", intersect: false, axis: "y", callbacks: { label: (c) => `${c.dataset.label}: ${fmtYen(c.parsed.x)}` } } }
      })
    });
    renderLegend("dumbbell", "an-legend-dumbbell");

    // 上位2PJの価格指数
    const range = rangeIndices();
    const days = anData.series.days;
    const top2 = totalsNow.slice(0, 2);
    const datasets = top2.map((t) => {
      const c = colorFor(t.folder);
      return { label: t.short, data: priceIndexRow(t.folder, range), borderColor: c.color, borderDash: c.dash, backgroundColor: "transparent", borderWidth: 2, pointRadius: 0, tension: 0.15, spanGaps: true };
    });
    makeChart("index2", "anIndex2Chart", {
      type: "line",
      data: { labels: range.map((i) => days[i]), datasets },
      options: baseOptions({
        scales: { x: { ticks: xTicks(range.map((i) => fmtMD(days[i]))), grid: { color: chartInk().gridX } }, y: { ticks: { color: chartInk().tick, font: { size: 11 }, callback: (v) => v }, grid: { color: chartInk().gridY } } },
        plugins: { legend: { display: false }, tooltip: { mode: "index", intersect: false, callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y === null ? "-" : c.parsed.y.toFixed(1)}` } } }
      })
    });
    renderLegend("index2", "an-legend-index2");
    dom.index2Title.textContent = `出来高 上位2PJ（${top2.map((t) => t.short).join("・")}）の価格（期間内で最初に0より大きい日＝100）`;
    const prevIdx = prevRangeIndices();
    dom.dumbbellSub.textContent = prevIdx.length ? `今期間 ${rangeLabel()} ／ 前期間 ${fmtYMD(days[prevIdx[0]])}〜${fmtYMD(days[prevIdx[prevIdx.length - 1]])}` : `今期間 ${rangeLabel()} ／ 前期間のデータなし`;
    dom.dumbbellNote.textContent = top.map((t) => `${t.short} ${fmtYen(prevTotalsMap[t.folder] || 0)}→${fmtYen(t.total)}`).join("・");
  }

  /* ------------------------------------------------------------
   * 4. 月次出来高（束＋単独PJ＋その他）
   * ------------------------------------------------------------ */
  function renderMonthly() {
    const M = anData.monthly;
    const days = anData.series.days;
    const startDate = days[anState.startIdx], endDate = days[anState.endIdx];
    const endMonth = endDate.slice(0, 7);
    let cols = [];
    M.months.forEach((m, j) => {
      // 完了月＝月の初日が期間の開始日以降で、翌月1日の記録が期末以前にある月
      if (m < endMonth && M.picked_days[j] <= endDate && (m + "-01") >= startDate) cols.push(j);
    });
    let note = "";
    if (cols.length < AN_CONFIG.monthlyMinMonths) {
      const usable = [];
      M.months.forEach((m, j) => { if (m < endMonth && M.picked_days[j] <= endDate) usable.push(j); });
      cols = usable.slice(-AN_CONFIG.monthlyFallbackMonths);
      note = `期間内の完了月が${AN_CONFIG.monthlyMinMonths}つ未満のため、期末までの直近${cols.length}か月を表示しています。`;
    }
    const segs = segments();
    const folderIdx = {}; M.projects.forEach((p, i) => { folderIdx[p.folder] = i; });
    const labels = cols.map((j) => M.months[j]);
    const shortLabels = cols.map((j) => M.months[j].slice(2).replace("-", "/"));
    const pal = palette();
    const datasets = segs.map((sg, si) => ({
      label: sg.label,
      data: cols.map((j) => sg.folders.reduce((s, f) => { const pi = folderIdx[f]; const v = pi === undefined ? null : M.rows[pi][j]; return s + (v || 0); }, 0)),
      backgroundColor: pal[si % pal.length],
      stack: "m"
    }));
    const segSum = cols.map((j, k) => datasets.reduce((s, d) => s + d.data[k], 0));
    datasets.push({ label: `その他`, data: cols.map((j, k) => Math.max(0, (M.totals[j] || 0) - segSum[k])), backgroundColor: otherColor(), stack: "m" });
    makeChart("monthly", "anMonthlyChart", {
      type: "bar",
      data: { labels, datasets },
      options: baseOptions({
        scales: { x: { stacked: true, ticks: xTicks(shortLabels), grid: { color: chartInk().gridX } }, y: { stacked: true, beginAtZero: true, ticks: yTicksYen(), grid: { color: chartInk().gridY } } },
        plugins: { legend: { display: false }, tooltip: { mode: "index", intersect: false, callbacks: { label: (c) => `${c.dataset.label}: ${fmtYen(c.parsed.y)}` } } }
      })
    });
    renderLegend("monthly", "an-legend-monthly");
    const totalsShown = cols.map((j) => M.totals[j] || 0);
    const peak = totalsShown.reduce((m, v, k) => (v > m.v ? { v, k } : m), { v: -1, k: -1 });
    dom.monthlySub.textContent = cols.length ? `${labels[0]}〜${labels[labels.length - 1]}（${cols.length}か月）` : "表示できる完了月がありません";
    dom.monthlyNote.textContent = note + (cols.length ? ` 表示月の合計 ${fmtYen(totalsShown.reduce((a, b) => a + b, 0))}・最大は ${labels[peak.k]} の ${fmtYen(peak.v)}・最新月 ${labels[labels.length - 1]} は ${fmtYen(totalsShown[totalsShown.length - 1])}。` : "") +
      ` 月次は「翌月1日時点の30日出来高」を前月分とする定義（1日の記録が欠けていれば2〜5日の最初の日）。期末の月は途中のため入れていません。`;
  }

  /* ------------------------------------------------------------
   * 5. シェア（2つの円）
   * ------------------------------------------------------------ */
  function renderShare(totalsNow, vNow) {
    const segs = segments();
    const totalMap = {}; totalsNow.forEach((t) => { totalMap[t.folder] = t.total; });
    const pal = palette();
    const segVals = segs.map((sg) => sg.folders.reduce((s, f) => s + (totalMap[f] || 0), 0));
    const segOther = Math.max(0, vNow - segVals.reduce((a, b) => a + b, 0));
    const donutOptions = (title) => ({
      responsive: true, maintainAspectRatio: false, animation: false, cutout: "55%",
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.label}: ${fmtYen(c.parsed)}（${vNow > 0 ? (c.parsed / vNow * 100).toFixed(1) : "0"}%）` } } }
    });
    makeChart("shareBundle", "anShareBundleChart", {
      type: "doughnut",
      data: { labels: segs.map((sg) => sg.label).concat(["その他"]), datasets: [{ data: segVals.concat([segOther]), backgroundColor: segs.map((_, i) => pal[i % pal.length]).concat([otherColor()]), borderWidth: 2, borderColor: currentTheme() === "light" ? "#ffffff" : "#131A26" }] },
      options: donutOptions()
    });
    renderLegend("shareBundle", "an-legend-share-bundle");
    const top = totalsNow.slice(0, AN_CONFIG.shareTop);
    const topOther = Math.max(0, vNow - top.reduce((s, t) => s + t.total, 0));
    makeChart("shareTop", "anShareTopChart", {
      type: "doughnut",
      data: { labels: top.map((t) => t.short).concat([`その他${fmtInt(totalsNow.filter((t) => t.total > 0).length - top.length)}PJ`]), datasets: [{ data: top.map((t) => t.total).concat([topOther]), backgroundColor: top.map((t) => colorFor(t.folder).color).concat([otherColor()]), borderWidth: 2, borderColor: currentTheme() === "light" ? "#ffffff" : "#131A26" }] },
      options: donutOptions()
    });
    renderLegend("shareTop", "an-legend-share-top");
    dom.shareSub.textContent = rangeLabel();
    const pct = (v) => vNow > 0 ? (v / vNow * 100).toFixed(1) + "%" : "-";
    dom.shareNote.textContent = segs.map((sg, i) => `${sg.label} ${pct(segVals[i])}`).join("・") + `・その他 ${pct(segOther)}。上位5PJ：` + top.map((t) => `${t.short} ${pct(t.total)}`).join("・") + "。";
  }

  /* ------------------------------------------------------------
   * 6. 上位30の表
   * ------------------------------------------------------------ */
  function renderTop30(totalsNow, prevTotalsMap, vNow) {
    const days = anData.series.days;
    const endDate = days[anState.endIdx];
    const last30 = indicesBetween(addDays(endDate, -29), endDate);
    const last30Map = {}; projectTotals(last30).forEach((t) => { last30Map[t.folder] = t.total; });
    const top = totalsNow.slice(0, AN_CONFIG.rankingTop);
    dom.top30Tbody.innerHTML = top.map((t, i) => {
      const ch = pctChange(t.total, prevTotalsMap[t.folder]);
      return `<tr data-folder="${escapeHtml(t.folder)}"><td class="rank">${i + 1}</td>` +
        `<td><a href="?project=${encodeURIComponent(t.folder)}" title="${escapeHtml(t.name)}">${escapeHtml(t.short)}</a><a class="an-ext-link" href="${financieUrl(t)}" target="_blank" rel="noopener" title="FiNANCiEで見る">↗</a></td>` +
        `<td class="num">${fmtInt(t.total)}</td><td class="num">${vNow > 0 ? (t.total / vNow * 100).toFixed(1) : "-"}%</td>` +
        `<td class="num">${fmtInt(last30Map[t.folder] || 0)}</td><td class="num ${changeClass(ch)}">${prevTotalsMap[t.folder] ? fmtPct(ch, 0) : "-"}</td></tr>`;
    }).join("") || `<tr><td colspan="6" class="text-center">期間内に出来高のあるPJがありません。</td></tr>`;
    const topShare = vNow > 0 ? top.reduce((s, t) => s + t.total, 0) / vNow * 100 : 0;
    dom.top30Sub.textContent = rangeLabel();
    dom.top30Note.textContent = `上位${top.length}PJで期間合計の ${topShare.toFixed(1)}%。「期末直近30日」は ${fmtYMD(addDays(endDate, -29))}〜${fmtYMD(endDate)} の合算。名前＝このサイトの個別ページ・↗＝FiNANCiE 本家。`;
  }

  /* ------------------------------------------------------------
   * 7. 価格上位10の指数
   * ------------------------------------------------------------ */
  function renderPrice(ind) {
    const range = rangeIndices();
    const days = anData.series.days;
    const datasets = ind.priceRank.map((x) => {
      const c = colorFor(x.folder);
      return { label: `${x.short}（${fmtInt(x.price)}円・30日前比 ${fmtPct(x.change, 1)}）`, data: priceIndexRow(x.folder, range), borderColor: c.color, borderDash: c.dash, backgroundColor: "transparent", borderWidth: 2, pointRadius: 0, tension: 0.15, spanGaps: true };
    });
    makeChart("price", "anPriceChart", {
      type: "line",
      data: { labels: range.map((i) => days[i]), datasets },
      options: baseOptions({
        scales: { x: { ticks: xTicks(range.map((i) => fmtMD(days[i]))), grid: { color: chartInk().gridX } }, y: { ticks: { color: chartInk().tick, font: { size: 11 } }, grid: { color: chartInk().gridY } } },
        plugins: { legend: { display: false }, tooltip: { mode: "index", intersect: false, callbacks: { label: (c) => `${c.dataset.label.split("（")[0]}: ${c.parsed.y === null ? "-" : c.parsed.y.toFixed(1)}` } } }
      })
    });
    renderLegend("price", "an-legend-price");
    const up = ind.priceRank.filter((x) => x.change !== null && x.change > 0).length;
    dom.priceSub.textContent = `期末 ${fmtYMD(ind.endDate)} 時点の価格上位10PJ`;
    dom.priceNote.textContent = `上位10のうち30日前より上昇 ${up}PJ・下落 ${ind.priceRank.length - up}PJ。指数の基準は「期間内で最初に0より大きい値の日」（上場前・価格0の日は線を引かない）。9本目以降は同じ灰色で線種（破線・点線）を変えています。`;
  }

  /* ------------------------------------------------------------
   * 8. メンバー（公式・全体の2枚）
   * ------------------------------------------------------------ */
  function renderMembers() {
    const S = anData.series;
    const days = S.days;
    const range = rangeIndices();
    const labels = range.map((i) => days[i]);
    const shortLabels = range.map((i) => fmtMD(days[i]));
    const pal = palette();
    const lineOpts = (label, color, data) => ({ type: "line", data: { labels, datasets: [{ label, data, borderColor: color, backgroundColor: "transparent", borderWidth: 2, pointRadius: 0, tension: 0.1, spanGaps: true }] },
      options: baseOptions({
        scales: { x: { ticks: xTicks(shortLabels), grid: { color: chartInk().gridX } }, y: { ticks: { color: chartInk().tick, font: { size: 11 }, callback: (v) => fmtInt(v) }, grid: { color: chartInk().gridY } } },
        plugins: { legend: { display: false }, tooltip: { mode: "index", intersect: false, callbacks: { label: (c) => `${c.dataset.label}: ${fmtInt(c.parsed.y)}人` } } }
      }) });
    const official = range.map((i) => S.official_members[i]);
    const total = range.map((i) => S.members_total[i]);
    makeChart("membersOfficial", "anMembersOfficialChart", lineOpts("FiNANCiE公式PJ", pal[0], official));
    makeChart("membersAll", "anMembersAllChart", lineOpts("全PJ合計", pal[2], total));
    const firstVal = (arr) => arr.find((v) => v !== null && v !== undefined);
    const lastVal = (arr) => arr.slice().reverse().find((v) => v !== null && v !== undefined);
    const o0 = firstVal(official), o1 = lastVal(official), t0 = firstVal(total), t1 = lastVal(total);
    dom.membersSub.textContent = rangeLabel();
    dom.membersNote.textContent = `公式PJ ${fmtInt(o0)}人 → ${fmtInt(o1)}人（${fmtPct(pctChange(o1, o0), 1)}）・全PJ合計 ${fmtInt(t0)}人 → ${fmtInt(t1)}人（${fmtPct(pctChange(t1, t0), 1)}）。2軸にせず2枚に分けています。`;
  }

  /* ------------------------------------------------------------
   * 9. 機運の5指標の表
   * ------------------------------------------------------------ */
  function renderIndicators(ind) {
    dom.indicatorsTbody.innerHTML = ind.items.map((x) =>
      `<tr><td class="rank">${x.n}</td><td>${escapeHtml(x.label)}</td><td class="def">${escapeHtml(x.def)}</td><td>${escapeHtml(x.threshold)}</td><td class="num">${escapeHtml(x.actual)}</td><td class="${x.ok ? "an-ok" : "an-ng"}">${x.ok ? "○ 当てはまる" : "× 当てはまらない"}</td></tr>`
    ).join("");
    dom.indicatorsSub.innerHTML = `期末 ${fmtYMD(ind.endDate)} 基準・当てはまり ${ind.count}/5 ＝ <span class="an-verdict">${escapeHtml(ind.band)}</span>`;
  }

  /* ------------------------------------------------------------
   * 全体の再計算
   * ------------------------------------------------------------ */
  function recomputeAll() {
    if (!anState.loaded) return;
    computeRange();
    const range = rangeIndices();
    const prev = prevRangeIndices();
    const S = anData.series;
    const vNow = sumSeries(S.v24_total, range);
    const vPrev = sumSeries(S.v24_total, prev);
    const totalsNow = projectTotals(range).sort((a, b) => b.total - a.total);
    const prevTotalsMap = {};
    projectTotals(prev).forEach((t) => { prevTotalsMap[t.folder] = t.total; });
    const ind = computeIndicators();

    renderConclusion(ind, totalsNow, prevTotalsMap, vNow, vPrev);
    renderDaily();
    renderWeekly();
    renderDumbbell(totalsNow, prevTotalsMap);
    renderMonthly();
    renderShare(totalsNow, vNow);
    renderTop30(totalsNow, prevTotalsMap, vNow);
    renderPrice(ind);
    renderMembers();
    renderIndicators(ind);

    // 検査用（tests/check_analysis.js）＝最後に描いた期間の集計値
    anState.last = { vNow, vPrev, activeNow: activeCount(range), topFolders: totalsNow.slice(0, 30).map((t) => t.folder), indicators: ind.items.map((x) => ({ n: x.n, ok: x.ok, actual: x.actual })), count: ind.count, band: ind.band, endDate: ind.endDate,
      recent4: ind.recent4, prev4: ind.prev4, mLast: ind.mLast, mPrev: ind.mPrev, vLast30: ind.vLast, vPrev30: ind.vPrev, top2: ind.top2.map((t) => t.folder), priceTop10: ind.priceRank.map((x) => x.folder), upCount: ind.upCount,
      weeks: anCharts.weeklyVol ? anCharts.weeklyVol.data.labels.length : 0, months: anCharts.monthly ? anCharts.monthly.data.labels.length : 0 };
    dom.meta.textContent = `非公式・毎日1回の記録 ／ データ ${fmtYMD(S.first_day)}〜${fmtYMD(S.latest)}（${S.n_projects}PJ）・集計 ${S.built_at || "-"} ／ 表示 ${rangeLabel()}`;
    syncUrl();
  }

  /* ------------------------------------------------------------
   * URL・操作
   * ------------------------------------------------------------ */
  function syncUrl() {
    if (!window.history || !window.history.replaceState) return;
    const params = new URLSearchParams(window.location.search);
    Object.values(URL_KEYS).forEach((k) => params.delete(k));
    params.set("tab", "analysis");
    if (anState.period !== AN_CONFIG.defaultPeriod) params.set(URL_KEYS.period, String(anState.period));
    if (anState.period === "custom") {
      params.set(URL_KEYS.start, anData.series.days[anState.startIdx]);
      params.set(URL_KEYS.end, anData.series.days[anState.endIdx]);
    }
    const qs = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? "?" + qs : ""}${window.location.hash}`);
  }

  function restoreStateFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const p = params.get(URL_KEYS.period);
    if (p === "custom") {
      anState.period = "custom";
      anState.pendingStart = params.get(URL_KEYS.start);
      anState.pendingEnd = params.get(URL_KEYS.end);
    } else if (p === "all" || ["30", "90", "365"].includes(p)) {
      anState.period = p === "all" ? "all" : Number(p);
    }
    setActivePeriod();
  }

  function setActivePeriod() {
    dom.periodGroup.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.getAttribute("data-period") === String(anState.period)));
  }

  function applyCustom() {
    const s = dom.startInput.value, e = dom.endInput.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !/^\d{4}-\d{2}-\d{2}$/.test(e)) {
      dom.rangeNote.textContent = "開始日と終了日を両方入れてください";
      dom.rangeNote.classList.remove("hidden-element");
      return;
    }
    anState.period = "custom";
    anState.pendingStart = s;
    anState.pendingEnd = e;
    setActivePeriod();
    recomputeAll();
  }

  function attachEvents() {
    dom.periodGroup.addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-period]");
      if (!b) return;
      const v = b.getAttribute("data-period");
      anState.period = v === "all" ? "all" : Number(v);
      setActivePeriod();
      recomputeAll();
    });
    dom.apply.addEventListener("click", applyCustom);
    [dom.startInput, dom.endInput].forEach((inp) => {
      inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); applyCustom(); } });
    });
    dom.errorReload.addEventListener("click", () => { anState.loaded = false; anState.initialized = false; init(); });
    // テーマ（白黒）の切替に追従＝overview.js のトグルが <html data-theme> を変える
    const mo = new MutationObserver(() => { if (anState.loaded && !document.getElementById("analysis-view").classList.contains("hidden-element")) recomputeAll(); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }

  function bindDom() {
    const g = (id) => document.getElementById(id);
    dom = {
      meta: g("an-meta"), error: g("an-error"), errorText: g("an-error-text"), errorReload: g("an-error-reload"),
      loading: g("an-loading"), body: g("an-body"),
      periodGroup: g("an-period-group"), startInput: g("an-start-date"), endInput: g("an-end-date"), apply: g("an-apply"), rangeNote: g("an-range-note"),
      kpiTotal: g("an-kpi-total"), kpiTotalSub: g("an-kpi-total-sub"), kpiChange: g("an-kpi-change"), kpiChangeSub: g("an-kpi-change-sub"),
      kpiActive: g("an-kpi-active"), kpiActiveSub: g("an-kpi-active-sub"), kpiMembers: g("an-kpi-members"), kpiMembersSub: g("an-kpi-members-sub"),
      kpiVerdict: g("an-kpi-verdict"), kpiVerdictSub: g("an-kpi-verdict-sub"), conclusion: g("an-conclusion"),
      dailySub: g("an-daily-sub"), dailyNote: g("an-daily-note"),
      weeklySub: g("an-weekly-sub"), weeklyNote: g("an-weekly-note"),
      dumbbellSub: g("an-dumbbell-sub"), dumbbellNote: g("an-dumbbell-note"), index2Title: g("an-index2-title"),
      monthlySub: g("an-monthly-sub"), monthlyNote: g("an-monthly-note"),
      shareSub: g("an-share-sub"), shareNote: g("an-share-note"),
      top30Sub: g("an-top30-sub"), top30Note: g("an-top30-note"), top30Tbody: g("an-top30-tbody"),
      priceSub: g("an-price-sub"), priceNote: g("an-price-note"),
      membersSub: g("an-members-sub"), membersNote: g("an-members-note"),
      indicatorsSub: g("an-indicators-sub"), indicatorsTbody: g("an-indicators-tbody")
    };
  }

  function showLoadError(err) {
    console.error("Analysis load error:", err);
    dom.loading.classList.add("hidden-element");
    dom.error.classList.remove("hidden-element");
    dom.errorText.textContent = "分析のデータの読み込みに失敗しました。通信状態を確かめて、もう一度読み込んでください。";
  }

  function init() {
    if (!dom) { bindDom(); attachEvents(); }
    anState.initialized = true;
    dom.error.classList.add("hidden-element");
    dom.loading.classList.remove("hidden-element");
    dom.body.classList.add("hidden-element");
    loadAll().then(() => {
      const days = anData.series.days;
      [dom.startInput, dom.endInput].forEach((inp) => { inp.min = days[0]; inp.max = days[days.length - 1]; });
      restoreStateFromUrl();
      dom.loading.classList.add("hidden-element");
      dom.body.classList.remove("hidden-element");
      recomputeAll();
    }).catch(showLoadError);
  }

  function onShow() {
    if (!anState.initialized) init();
    else if (anState.loaded) syncUrl();
  }

  console.info("FiNANCiE TIMES analysis v" + AN_VERSION);
  window.FinancieAnalysis = {
    onShow,
    AN_CONFIG,
    _debug: { state: anState, charts: anCharts, data: anData, computeIndicators, colorFor, currentTheme, recomputeAll }
  };
})();
