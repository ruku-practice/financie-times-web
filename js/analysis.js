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
 * 2026-09-13 手順2：このファイルを3つに分けた（見た目・数字・URL の動きは変えない）。
 *  - 集計（純粋関数）は js/analysis-core.js（window.FtAnalysisCore）へ切り出し済み。
 *  - このファイルには「箱ごとの描画」（window.AnalysisParts）と、
 *    それを呼ぶ「旧タブの包み」（window.FinancieAnalysis）が残っている。
 *  - 合体（js/merged.js）は window.AnalysisParts.createInstance({getEl}) を
 *    自分の状態・URL・DOM のもとで呼び直す想定（分析タブ設計 §契約A）。
 *
 * 合体時（全体市況とのガッチャンコ）のメモ：
 *  - computeRange / fmt* / HTML凡例 は overview.js とほぼ同じ写し＝共有モジュールへ切り出す候補
 *  - テーマ（白黒）は overview.js のトグルが <html data-theme> を変えるのを MutationObserver で見て追従
 *  - 出来高の欠測の扱いが全体市況と違う（分析＝生の記録値・全体市況＝24h=30日を欠測）＝統一はルク判断
 * ============================================================ */

(function () {
  "use strict";

  const AN_VERSION = "3.2.3";
  const C = window.FtAnalysisCore;

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

  const URL_KEYS = { period: "an_p", start: "an_s", end: "an_e", window: "an_w" };
  const WINDOWS = [30, 90, 180];

  // 箱の描画順（旧タブの包みが1回の再計算で回す順）
  const BOX_ORDER = ["conclusion", "daily", "weeklyVol", "weeklyActive", "dumbbell", "index2", "monthly", "shareBundle", "shareTop", "top30", "price", "membersOfficial", "membersAll", "indicators"];

  /* ------------------------------------------------------------
   * テーマ・色（DOM は読むだけ＝<html data-theme> の判定のみ。書き換えない）
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

  /* ============================================================
   * 箱ごとの描画：window.AnalysisParts
   *
   * createInstance({ getEl }) → { render(boxId, state, data), dispose(boxId), disposeAll(), charts, colorFor, currentTheme }
   *
   * - getEl(localId) は要素を返す関数（旧タブでは id => document.getElementById(id)）。
   * - render の中では URL・localStorage を触らない・操作帯にイベントを付けない。
   * - Chart はインスタンスごとに持ち、同じ boxId で描き直す前に必ず破棄する。
   * - state = { startIdx, endIdx, window, period }（呼び出し側のコピー。書き換えない）
   * - data  = { series, v24, price, monthly, bundles, dayIndex, folderIndex, priceFolderIndex }
   * ============================================================ */
  function createAnalysisPartsInstance(opts) {
    const getEl = (opts && opts.getEl) || ((id) => document.getElementById(id));
    const charts = {};
    const colorMap = {}; // folder → パレットの段（このインスタンス内で、期間を変えても同じ色）

    function rangeLabelOf(days, state) {
      return `${C.fmtYMD(days[state.startIdx])}〜${C.fmtYMD(days[state.endIdx])}（${state.endIdx - state.startIdx + 1}日分の記録）`;
    }

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
      if (charts[key]) { charts[key].destroy(); charts[key] = null; }
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
      return { color: chartInk().tick, font: { size: 11 }, callback: (v) => C.fmtYenTick(v) };
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
      const el = getEl(canvasId);
      if (!el) return null;
      charts[key] = new Chart(el.getContext("2d"), config);
      return charts[key];
    }

    // HTML凡例（押すと系列を出し入れ・円グラフはスライス単位）
    function renderLegend(key, boxId) {
      const chart = charts[key];
      const box = getEl(boxId);
      if (!chart || !box) return;
      const isDonut = chart.config.type === "doughnut";
      const entries = isDonut
        ? chart.data.labels.map((label, i) => ({ label, color: chart.data.datasets[0].backgroundColor[i], visible: chart.getDataVisibility(i), dashed: false }))
        : chart.data.datasets.map((ds, i) => ({ label: ds.label, color: ds.borderColor || ds.backgroundColor, visible: chart.isDatasetVisible(i), dashed: !!(ds.borderDash && ds.borderDash.length),
            dashKind: ds.borderDash && ds.borderDash.length ? (ds.borderDash[0] >= 5 ? "破線" : "点線") : "" }));
      box.innerHTML = entries.map((en, i) =>
        `<button type="button" class="an-legend-item${en.visible ? "" : " off"}" data-index="${i}" aria-pressed="${en.visible}"><span class="an-legend-swatch${en.dashed ? " dashed" : ""}" style="background:${en.color};color:${en.color}"></span>${C.escapeHtml(en.label)}${en.dashKind ? `（${en.dashKind}）` : ""}</button>`
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

    function makeIndicatorsInput(data) {
      return { series: data.series, v24: data.v24, price: data.price, priceFolderIndex: data.priceFolderIndex, dayIndex: data.dayIndex, config: AN_CONFIG };
    }

    /* ---- 0. 結論（KPI＋自動文） ---- */
    function renderConclusion(state, data) {
      const days = data.series.days;
      const range = C.rangeIndices(state.startIdx, state.endIdx);
      const prev = C.prevRangeIndices(days, state.startIdx, state.endIdx);
      const vNow = C.sumSeries(data.series.v24_total, range);
      const vPrev = C.sumSeries(data.series.v24_total, prev);
      const totalsNow = C.projectTotals(data.v24, range).sort((a, b) => b.total - a.total);
      const prevTotalsMap = {};
      C.projectTotals(data.v24, prev).forEach((t) => { prevTotalsMap[t.folder] = t.total; });
      const ind = C.computeIndicators(makeIndicatorsInput(data), { endIdx: state.endIdx, window: state.window });

      const change = C.pctChange(vNow, vPrev);
      const activeN = C.activeCount(data.v24, range);
      const activePrev = prev.length ? C.activeCount(data.v24, prev) : null;
      const rangeLabelStr = rangeLabelOf(days, state);

      getEl("an-kpi-total").textContent = C.fmtYen(vNow);
      getEl("an-kpi-total-sub").textContent = rangeLabelStr;
      const kpiChangeEl = getEl("an-kpi-change");
      kpiChangeEl.textContent = C.fmtPct(change, 0);
      kpiChangeEl.className = "metric-value " + C.changeClass(change);
      getEl("an-kpi-change-sub").textContent = vPrev > 0 ? `前期間 ${C.fmtYen(vPrev)}` : "前期間のデータなし";
      getEl("an-kpi-active").textContent = C.fmtInt(activeN) + " PJ";
      getEl("an-kpi-active-sub").textContent = activePrev === null ? "期間内に出来高＞0の日があるPJ" : `前期間 ${C.fmtInt(activePrev)} PJ`;
      const kpiMembersEl = getEl("an-kpi-members");
      kpiMembersEl.textContent = ind.mLast === null ? "-" : (ind.mLast > 0 ? "+" : "") + C.fmtInt(ind.mLast) + "人";
      kpiMembersEl.className = "metric-value " + C.changeClass(ind.mLast);
      getEl("an-kpi-members-label").textContent = `メンバー純増（期末直近${ind.W}日）`;
      getEl("an-kpi-members-sub").textContent = ind.mPrev === null ? `前${ind.W}日のデータなし` : `前${ind.W}日 ${(ind.mPrev > 0 ? "+" : "") + C.fmtInt(ind.mPrev)}人`;
      getEl("an-kpi-verdict").textContent = `${ind.count} / 5`;
      getEl("an-kpi-verdict-sub").textContent = `判定＝${ind.band}（期末 ${C.fmtYMD(ind.endDate)}・窓 ${ind.W}日）`;

      // 自動文（テンプレ3本固定・数字差し込み・原因や見通しは書かない）
      const top1 = totalsNow[0];
      const share1 = vNow > 0 && top1 ? (top1.total / vNow) * 100 : null;
      const top2now = totalsNow.slice(0, 2);
      const exNow = vNow - top2now.reduce((s, t) => s + t.total, 0);
      const exPrev = vPrev - top2now.reduce((s, t) => s + (prevTotalsMap[t.folder] || 0), 0);
      const exChange = C.pctChange(exNow, exPrev);
      const dir = (v) => v === null ? "比較できず" : v >= 5 ? "増" : v <= -5 ? "減" : "横ばい";
      const lines = [];
      // カードにある数字（合計・前期間比）は繰り返さず、カードに無いこと（集中度・上位2を除いた比）だけ書く（エマ中8）
      // 前期間が無い（全期間など）ときは「上位2PJを除くと前期間比」の節ごと出さない（値なしの「-」で終わっていた＝エマ v3.2.0 中7）
      const exClause = exChange === null ? "" : `上位2PJ（${top2now.map((t) => C.escapeHtml(t.short)).join("・")}）を除くと前期間比 ${C.fmtPct(exChange, 0)}。`;
      lines.push(`<strong>出来高：</strong>${change === null ? "前期間がないため比較できません。" : `前期間比は${dir(change)}。`}` + // 「前期間比は比較できず」の重なり（エマ v3.2.1 軽）
        (top1 ? `上位1PJは ${C.escapeHtml(top1.short)}（シェア ${share1.toFixed(1)}%）。${exClause}` : "期間内に出来高のあるPJがありません。"));
      // 期間と窓が同じ日数なら同じ数字を2回言わない（エマ中2）
      const periodDays = C.daysBetween(days[state.startIdx], days[state.endIdx]) + 1;
      const sameAsWindow = periodDays === ind.W && state.period !== "custom";
      lines.push(`<strong>裾野：</strong>取引のあったPJ数は期間内 ${C.fmtInt(activeN)} PJ` + (activePrev === null ? "。" : `（前期間 ${C.fmtInt(activePrev)} PJ・${C.fmtPct(C.pctChange(activeN, activePrev), 1)}）。`) +
        (sameAsWindow ? "" : `窓${ind.W}日では直近 ${ind.nRec} PJ／前 ${ind.nPrv} PJ（${C.fmtPct(ind.aChange, 1)}）。`) +
        `窓内の後半÷前半（出来高）＝${C.fmtPct(ind.halfChange, 0)}。`);
      lines.push(`<strong>判定：</strong>機運の5指標（窓 ${ind.W}日・期末 ${C.fmtYMD(ind.endDate)} 基準）のうち当てはまるのは ${ind.count}/5 ＝「${ind.band}」（ルール：4〜5＝あり・2〜3＝兆しあり・0〜1＝なし）。` +
        `当てはまった指標＝${ind.items.filter((x) => x.ok).map((x) => x.label).join("・") || "なし"}。`);
      getEl("an-conclusion").innerHTML = lines.map((l) => `<li>${l}</li>`).join("");
    }

    /* ---- 1. 日次出来高＋7日平均 ---- */
    function renderDaily(state, data) {
      const S = data.series;
      const days = S.days;
      const range = C.rangeIndices(state.startIdx, state.endIdx);
      const labels = range.map((i) => days[i]);
      const shortLabels = range.map((i) => C.fmtMD(days[i]));
      const totals = range.map((i) => S.v24_total[i] === null ? null : S.v24_total[i]);
      // 7日移動平均＝その日を含む暦日7日の記録の平均（記録が4日未満なら null）
      const avg = range.map((i) => {
        const idxs = C.indicesBetween(days, C.addDays(days[i], -6), days[i]);
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
          plugins: { legend: { display: false }, tooltip: { mode: "index", intersect: false, callbacks: { label: (c) => `${c.dataset.label}: ${C.fmtYen(c.parsed.y)}` } } }
        })
      });
      renderLegend("daily", "an-legend-daily");
      const max = totals.reduce((m, v, k) => (v !== null && (m.v === null || v > m.v) ? { v, k } : m), { v: null, k: -1 });
      getEl("an-daily-sub").textContent = rangeLabelOf(days, state);
      getEl("an-daily-note").textContent = max.v === null ? "" : `期間内の最大は ${C.fmtYMD(labels[max.k])} の ${C.fmtYen(max.v)}。7日平均の底は ${C.fmtYen(Math.min.apply(null, avg.filter((v) => v !== null)))}。`;
    }

    /* ---- 2. 週次出来高（箱：weeklyVol）／取引のあったPJ数（箱：weeklyActive） ---- */
    function renderWeeklyVol(state, data) {
      const S = data.series;
      const days = S.days;
      const { weeks, dropped } = C.weeklyBuckets(days, state.startIdx, state.endIdx);
      const labels = weeks.map((w) => `${C.fmtMD(w.start)}〜${C.fmtMD(w.end)}`);
      const shortLabels = weeks.map((w) => C.fmtMD(w.start));
      const totals = weeks.map((w) => C.sumSeries(S.v24_total, w.indices));
      const actives = weeks.map((w) => C.activeCount(data.v24, w.indices));
      const pal = palette();
      const many = weeks.length > 60;
      makeChart("weeklyVol", "anWeeklyVolChart", {
        type: "bar",
        data: { labels, datasets: [{ label: "週次出来高", data: totals, backgroundColor: pal[0], borderRadius: many ? 0 : 3 }] },
        options: baseOptions({
          scales: { x: { ticks: xTicks(shortLabels), grid: { color: chartInk().gridX } }, y: { beginAtZero: true, ticks: yTicksYen(), grid: { color: chartInk().gridY } } },
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `週次出来高: ${C.fmtYen(c.parsed.y)}` } } }
        })
      });
      getEl("an-weekly-sub").textContent = `${weeks.length}週`;
      const last4 = actives.slice(-4), prev4 = actives.slice(-8, -4);
      const avg = (a) => a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : "-";
      getEl("an-weekly-note").textContent = (dropped > 0 ? `期間の先頭 ${dropped} 日は7日に満たないため週に入れていません。` : "") +
        (weeks.length >= 8 ? ` 直近4週平均 ${avg(last4)} PJ／その前4週平均 ${avg(prev4)} PJ。` : "");
    }

    function renderWeeklyActive(state, data) {
      const S = data.series;
      const days = S.days;
      const { weeks } = C.weeklyBuckets(days, state.startIdx, state.endIdx);
      const labels = weeks.map((w) => `${C.fmtMD(w.start)}〜${C.fmtMD(w.end)}`);
      const shortLabels = weeks.map((w) => C.fmtMD(w.start));
      const actives = weeks.map((w) => C.activeCount(data.v24, w.indices));
      const pal = palette();
      const many = weeks.length > 60;
      makeChart("weeklyActive", "anWeeklyActiveChart", {
        type: "line",
        data: { labels, datasets: [{ label: "取引のあったPJ数", data: actives, borderColor: pal[2], backgroundColor: "transparent", borderWidth: 2, pointRadius: many ? 0 : 3, tension: 0.2 }] },
        options: baseOptions({
          scales: { x: { ticks: xTicks(shortLabels), grid: { color: chartInk().gridX } }, y: { beginAtZero: true, ticks: { color: chartInk().tick, font: { size: 11 }, precision: 0 }, grid: { color: chartInk().gridY } } },
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `取引のあったPJ数: ${c.parsed.y} PJ` } } }
        })
      });
    }

    /* ---- 3. 上位8の今期間 vs 前期間（箱：dumbbell）／上位2PJの価格指数（箱：index2） ---- */
    function renderDumbbell(state, data) {
      const days = data.series.days;
      const range = C.rangeIndices(state.startIdx, state.endIdx);
      const prev = C.prevRangeIndices(days, state.startIdx, state.endIdx);
      const totalsNow = C.projectTotals(data.v24, range).sort((a, b) => b.total - a.total);
      const prevTotalsMap = {};
      C.projectTotals(data.v24, prev).forEach((t) => { prevTotalsMap[t.folder] = t.total; });
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
          plugins: { legend: { display: false }, tooltip: { mode: "index", intersect: false, axis: "y", callbacks: { label: (c) => `${c.dataset.label}: ${C.fmtYen(c.parsed.x)}` } } }
        })
      });
      renderLegend("dumbbell", "an-legend-dumbbell");
      const rangeLabelStr = rangeLabelOf(days, state);
      getEl("an-dumbbell-sub").textContent = prev.length ? `今期間 ${rangeLabelStr} ／ 前期間 ${C.fmtYMD(days[prev[0]])}〜${C.fmtYMD(days[prev[prev.length - 1]])}` : `今期間 ${rangeLabelStr} ／ 前期間のデータなし`;
      getEl("an-dumbbell-note").textContent = top.map((t) => `${t.short} ${C.fmtYen(prevTotalsMap[t.folder] || 0)}→${C.fmtYen(t.total)}`).join("・");
    }

    function renderIndex2(state, data) {
      const days = data.series.days;
      const range = C.rangeIndices(state.startIdx, state.endIdx);
      const totalsNow = C.projectTotals(data.v24, range).sort((a, b) => b.total - a.total);
      const top2 = totalsNow.slice(0, 2);
      const datasets = top2.map((t) => {
        const c = colorFor(t.folder);
        return { label: t.short, data: C.priceIndexRow(data.price, data.priceFolderIndex, t.folder, range), borderColor: c.color, borderDash: c.dash, backgroundColor: "transparent", borderWidth: 2, pointRadius: 0, tension: 0.15, spanGaps: true };
      });
      makeChart("index2", "anIndex2Chart", {
        type: "line",
        data: { labels: range.map((i) => days[i]), datasets },
        options: baseOptions({
          scales: { x: { ticks: xTicks(range.map((i) => C.fmtMD(days[i]))), grid: { color: chartInk().gridX } }, y: { ticks: { color: chartInk().tick, font: { size: 11 }, callback: (v) => v }, grid: { color: chartInk().gridY } } },
          plugins: { legend: { display: false }, tooltip: { mode: "index", intersect: false, callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y === null ? "-" : c.parsed.y.toFixed(1)}` } } }
        })
      });
      renderLegend("index2", "an-legend-index2");
      getEl("an-index2-title").textContent = `出来高 上位2PJ（${top2.map((t) => t.short).join("・")}）の価格（期間内で最初に0より大きい日＝100）`;
    }

    /* ---- 4. 月次出来高（束＋単独PJ＋その他） ---- */
    function renderMonthly(state, data) {
      const M = data.monthly;
      const days = data.series.days;
      const startDate = days[state.startIdx], endDate = days[state.endIdx];
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
      const segs = C.segments(data.bundles, data.v24, data.folderIndex);
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
          plugins: { legend: { display: false }, tooltip: { mode: "index", intersect: false, callbacks: { label: (c) => `${c.dataset.label}: ${C.fmtYen(c.parsed.y)}` } } }
        })
      });
      renderLegend("monthly", "an-legend-monthly");
      const totalsShown = cols.map((j) => M.totals[j] || 0);
      const peak = totalsShown.reduce((m, v, k) => (v > m.v ? { v, k } : m), { v: -1, k: -1 });
      getEl("an-monthly-sub").textContent = cols.length ? `${labels[0]}〜${labels[labels.length - 1]}（${cols.length}か月）` : "表示できる完了月がありません";
      getEl("an-monthly-note").textContent = "束＝関連するPJのまとまり（分析レポートの区分：NinjaDAO系・令和の虎系・RED系）。" + note + (cols.length ? ` 表示月の合計 ${C.fmtYen(totalsShown.reduce((a, b) => a + b, 0))}・最大は ${labels[peak.k]} の ${C.fmtYen(peak.v)}・最新月 ${labels[labels.length - 1]} は ${C.fmtYen(totalsShown[totalsShown.length - 1])}。` : "") +
        ` 月次は「翌月1日時点の30日出来高」を前月分とする定義（1日の記録が欠けていれば2〜5日の最初の日）。期末の月は途中のため入れていません。`;
    }

    /* ---- 5. シェア（箱：shareBundle・shareTop の2つの円） ---- */
    function renderShareBundle(state, data) {
      const range = C.rangeIndices(state.startIdx, state.endIdx);
      const totalsNow = C.projectTotals(data.v24, range).sort((a, b) => b.total - a.total);
      const vNow = C.sumSeries(data.series.v24_total, range);
      const segs = C.segments(data.bundles, data.v24, data.folderIndex);
      const totalMap = {}; totalsNow.forEach((t) => { totalMap[t.folder] = t.total; });
      const pal = palette();
      const segVals = segs.map((sg) => sg.folders.reduce((s, f) => s + (totalMap[f] || 0), 0));
      const segOther = Math.max(0, vNow - segVals.reduce((a, b) => a + b, 0));
      makeChart("shareBundle", "anShareBundleChart", {
        type: "doughnut",
        data: { labels: segs.map((sg) => sg.label).concat(["その他"]), datasets: [{ data: segVals.concat([segOther]), backgroundColor: segs.map((_, i) => pal[i % pal.length]).concat([otherColor()]), borderWidth: 2, borderColor: currentTheme() === "light" ? "#ffffff" : "#131A26" }] },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false, cutout: "55%",
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.label}: ${C.fmtYen(c.parsed)}（${vNow > 0 ? (c.parsed / vNow * 100).toFixed(1) : "0"}%）` } } }
        }
      });
      renderLegend("shareBundle", "an-legend-share-bundle");
      getEl("an-share-sub").textContent = rangeLabelOf(data.series.days, state);
      const pct = (v) => vNow > 0 ? (v / vNow * 100).toFixed(1) + "%" : "-";
      const top = totalsNow.slice(0, AN_CONFIG.shareTop);
      getEl("an-share-note").textContent = segs.map((sg, i) => `${sg.label} ${pct(segVals[i])}`).join("・") + `・その他 ${pct(segOther)}。上位5PJ：` + top.map((t) => `${t.short} ${pct(t.total)}`).join("・") + "。";
    }

    function renderShareTop(state, data) {
      const range = C.rangeIndices(state.startIdx, state.endIdx);
      const totalsNow = C.projectTotals(data.v24, range).sort((a, b) => b.total - a.total);
      const vNow = C.sumSeries(data.series.v24_total, range);
      const top = totalsNow.slice(0, AN_CONFIG.shareTop);
      const topOther = Math.max(0, vNow - top.reduce((s, t) => s + t.total, 0));
      makeChart("shareTop", "anShareTopChart", {
        type: "doughnut",
        data: { labels: top.map((t) => t.short).concat([`その他${C.fmtInt(totalsNow.filter((t) => t.total > 0).length - top.length)}PJ`]), datasets: [{ data: top.map((t) => t.total).concat([topOther]), backgroundColor: top.map((t) => colorFor(t.folder).color).concat([otherColor()]), borderWidth: 2, borderColor: currentTheme() === "light" ? "#ffffff" : "#131A26" }] },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false, cutout: "55%",
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.label}: ${C.fmtYen(c.parsed)}（${vNow > 0 ? (c.parsed / vNow * 100).toFixed(1) : "0"}%）` } } }
        }
      });
      renderLegend("shareTop", "an-legend-share-top");
    }

    /* ---- 6. 上位30の表 ---- */
    function renderTop30(state, data) {
      const days = data.series.days;
      const endDate = days[state.endIdx];
      const range = C.rangeIndices(state.startIdx, state.endIdx);
      const prev = C.prevRangeIndices(days, state.startIdx, state.endIdx);
      const totalsNow = C.projectTotals(data.v24, range).sort((a, b) => b.total - a.total);
      const prevTotalsMap = {};
      C.projectTotals(data.v24, prev).forEach((t) => { prevTotalsMap[t.folder] = t.total; });
      const vNow = C.sumSeries(data.series.v24_total, range);
      const last30 = C.indicesBetween(days, C.addDays(endDate, -29), endDate);
      const last30Map = {}; C.projectTotals(data.v24, last30).forEach((t) => { last30Map[t.folder] = t.total; });
      const top = totalsNow.slice(0, AN_CONFIG.rankingTop);
      getEl("an-top30-tbody").innerHTML = top.map((t, i) => {
        const ch = C.pctChange(t.total, prevTotalsMap[t.folder]);
        // スマホのカード表示で列名を出すため、全セルに data-label を付ける（全体市況の重2と同じ・エマ重1）
        return `<tr data-folder="${C.escapeHtml(t.folder)}"><td class="rank" data-label="順位">${i + 1}</td>` +
          `<td data-label="プロジェクト"><a href="?project=${encodeURIComponent(t.folder)}" title="${C.escapeHtml(t.name)}">${C.escapeHtml(t.short)}</a><a class="an-ext-link" href="${C.financieUrl(t)}" target="_blank" rel="noopener" title="FiNANCiEで見る">本家↗</a></td>` +
          `<td class="num" data-label="期間合計（円）">${C.fmtInt(t.total)}</td><td class="num" data-label="シェア">${vNow > 0 ? (t.total / vNow * 100).toFixed(1) : "-"}%</td>` +
          `<td class="num" data-label="期末直近30日（円）">${C.fmtInt(last30Map[t.folder] || 0)}</td><td class="num ${C.changeClass(ch)}" data-label="前期間比">${prevTotalsMap[t.folder] ? C.fmtPct(ch, 0) : "-"}</td></tr>`;
      }).join("") || `<tr><td colspan="6" class="text-center">期間内に出来高のあるPJがありません。</td></tr>`;
      const topShare = vNow > 0 ? top.reduce((s, t) => s + t.total, 0) / vNow * 100 : 0;
      getEl("an-top30-sub").textContent = rangeLabelOf(days, state);
      getEl("an-top30-note").textContent = `上位${top.length}PJで期間合計の ${topShare.toFixed(1)}%。「期末直近30日」は ${C.fmtYMD(C.addDays(endDate, -29))}〜${C.fmtYMD(endDate)} の合算。名前＝このサイトの個別ページ・↗＝FiNANCiE 本家。`;
    }

    /* ---- 7. 価格上位10の指数 ---- */
    function renderPrice(state, data) {
      const range = C.rangeIndices(state.startIdx, state.endIdx);
      const days = data.series.days;
      const ind = C.computeIndicators(makeIndicatorsInput(data), { endIdx: state.endIdx, window: state.window });
      const datasets = ind.priceRank.map((x) => {
        const c = colorFor(x.folder);
        return { label: `${x.short}（${C.fmtInt(x.price)}円・30日前比 ${C.fmtPct(x.change, 1)}）`, data: C.priceIndexRow(data.price, data.priceFolderIndex, x.folder, range), borderColor: c.color, borderDash: c.dash, backgroundColor: "transparent", borderWidth: 2, pointRadius: 0, tension: 0.15, spanGaps: true };
      });
      makeChart("price", "anPriceChart", {
        type: "line",
        data: { labels: range.map((i) => days[i]), datasets },
        options: baseOptions({
          scales: { x: { ticks: xTicks(range.map((i) => C.fmtMD(days[i]))), grid: { color: chartInk().gridX } }, y: { ticks: { color: chartInk().tick, font: { size: 11 } }, grid: { color: chartInk().gridY } } },
          plugins: { legend: { display: false }, tooltip: { mode: "index", intersect: false, callbacks: { label: (c) => `${c.dataset.label.split("（")[0]}: ${c.parsed.y === null ? "-" : c.parsed.y.toFixed(1)}` } } }
        })
      });
      renderLegend("price", "an-legend-price");
      const up = ind.priceRank.filter((x) => x.change !== null && x.change > 0).length;
      getEl("an-price-sub").textContent = `期末 ${C.fmtYMD(ind.endDate)} 時点の価格上位10PJ`;
      getEl("an-price-note").textContent = `上位10のうち30日前より上昇 ${up}PJ・下落 ${ind.priceRank.length - up}PJ。指数の基準は「期間内で最初に0より大きい値の日」（上場前・価格0の日は線を引かない）。9本目以降は同じ灰色で線種（破線・点線）を変えています。`;
    }

    /* ---- 8. メンバー（箱：membersOfficial・membersAll の2枚） ---- */
    function memberLineChart(label, color, seriesData, labels, shortLabels) {
      return { type: "line", data: { labels, datasets: [{ label, data: seriesData, borderColor: color, backgroundColor: "transparent", borderWidth: 2, pointRadius: 0, tension: 0.1, spanGaps: true }] },
        options: baseOptions({
          scales: { x: { ticks: xTicks(shortLabels), grid: { color: chartInk().gridX } }, y: { ticks: { color: chartInk().tick, font: { size: 11 }, callback: (v) => C.fmtInt(v) }, grid: { color: chartInk().gridY } } },
          plugins: { legend: { display: false }, tooltip: { mode: "index", intersect: false, callbacks: { label: (c) => `${c.dataset.label}: ${C.fmtInt(c.parsed.y)}人` } } }
        }) };
    }

    function renderMembersOfficial(state, data) {
      const S = data.series;
      const days = S.days;
      const range = C.rangeIndices(state.startIdx, state.endIdx);
      const labels = range.map((i) => days[i]);
      const shortLabels = range.map((i) => C.fmtMD(days[i]));
      const pal = palette();
      const official = range.map((i) => S.official_members[i]);
      makeChart("membersOfficial", "anMembersOfficialChart", memberLineChart("FiNANCiE公式PJ", pal[0], official, labels, shortLabels));
    }

    function renderMembersAll(state, data) {
      const S = data.series;
      const days = S.days;
      const range = C.rangeIndices(state.startIdx, state.endIdx);
      const labels = range.map((i) => days[i]);
      const shortLabels = range.map((i) => C.fmtMD(days[i]));
      const pal = palette();
      const total = range.map((i) => S.members_total[i]);
      makeChart("membersAll", "anMembersAllChart", memberLineChart("全PJ合計", pal[2], total, labels, shortLabels));
      const official = range.map((i) => S.official_members[i]);
      const firstVal = (arr) => arr.find((v) => v !== null && v !== undefined);
      const lastVal = (arr) => arr.slice().reverse().find((v) => v !== null && v !== undefined);
      const o0 = firstVal(official), o1 = lastVal(official), t0 = firstVal(total), t1 = lastVal(total);
      getEl("an-members-sub").textContent = rangeLabelOf(days, state);
      getEl("an-members-note").textContent = `公式PJ ${C.fmtInt(o0)}人 → ${C.fmtInt(o1)}人（${C.fmtPct(C.pctChange(o1, o0), 1)}）・全PJ合計 ${C.fmtInt(t0)}人 → ${C.fmtInt(t1)}人（${C.fmtPct(C.pctChange(t1, t0), 1)}）。2軸にせず2枚に分けています。`;
    }

    /* ---- 9. 機運の5指標の表 ---- */
    function renderIndicators(state, data) {
      const ind = C.computeIndicators(makeIndicatorsInput(data), { endIdx: state.endIdx, window: state.window });
      getEl("an-indicators-tbody").innerHTML = ind.items.map((x) =>
        `<tr><td class="rank" data-label="#">${x.n}</td><td data-label="指標">${C.escapeHtml(x.label)}</td><td class="def" data-label="定義・算出">${C.escapeHtml(x.def)}</td><td data-label="閾値">${C.escapeHtml(x.threshold)}</td><td class="num" data-label="実測">${C.escapeHtml(x.actual)}</td><td class="verdict ${x.ok ? "an-ok" : "an-ng"}" data-label="判定">${x.ok ? "○ 当てはまる" : "× 当てはまらない"}</td></tr>`
      ).join("");
      getEl("an-indicators-sub").innerHTML = `期末 ${C.fmtYMD(ind.endDate)} 基準・窓 ${ind.W}日・当てはまり ${ind.count}/5 ＝ <span class="an-verdict">${C.escapeHtml(ind.band)}</span>`;
      const windowGroup = getEl("an-window-group");
      if (windowGroup) windowGroup.querySelectorAll("button").forEach((b) => b.classList.toggle("active", Number(b.getAttribute("data-window")) === ind.W));
    }

    const RENDERERS = {
      conclusion: renderConclusion,
      daily: renderDaily,
      weeklyVol: renderWeeklyVol,
      weeklyActive: renderWeeklyActive,
      dumbbell: renderDumbbell,
      index2: renderIndex2,
      monthly: renderMonthly,
      shareBundle: renderShareBundle,
      shareTop: renderShareTop,
      top30: renderTop30,
      price: renderPrice,
      membersOfficial: renderMembersOfficial,
      membersAll: renderMembersAll,
      indicators: renderIndicators
    };

    function render(boxId, state, data) {
      const fn = RENDERERS[boxId];
      if (!fn) throw new Error("AnalysisParts: unknown boxId '" + boxId + "'");
      fn(state, data);
    }

    function dispose(boxId) { destroyChart(boxId); }
    function disposeAll() { Object.keys(charts).forEach((k) => destroyChart(k)); }

    return { render, dispose, disposeAll, charts, colorFor, currentTheme };
  }

  window.AnalysisParts = { createInstance: createAnalysisPartsInstance };

  /* ============================================================
   * 旧タブの包み：window.FinancieAnalysis
   * 自分の期間・URL・DOM 操作帯を持ち、描画は AnalysisParts のインスタンス経由。
   * ============================================================ */
  const analysisInstance = createAnalysisPartsInstance({ getEl: (id) => document.getElementById(id) });

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
    pendingEnd: null,
    window: 90 // 機運の5指標の窓（日）＝30/90/180・既定90（2026-09-13 06:58 ルク決裁・仕様メモ §5）
  };
  const anData = {};
  let dom = null;

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

  function rangeLabel() {
    const days = anData.series.days;
    return `${C.fmtYMD(days[anState.startIdx])}〜${C.fmtYMD(days[anState.endIdx])}（${anState.endIdx - anState.startIdx + 1}日分の記録）`;
  }

  function indicatorsInputForDebug() {
    return { series: anData.series, v24: anData.v24, price: anData.price, priceFolderIndex: anData.priceFolderIndex, dayIndex: anData.dayIndex, config: AN_CONFIG };
  }
  function computeIndicatorsForDebug() {
    return C.computeIndicators(indicatorsInputForDebug(), { endIdx: anState.endIdx, window: anState.window });
  }

  /* ------------------------------------------------------------
   * 全体の再計算
   * ------------------------------------------------------------ */
  function recomputeAll() {
    if (!anState.loaded) return;

    // 期間（FtAnalysisCore の純粋関数で計算し、この包みが自分の操作帯へ反映する＝契約A）
    const days = anData.series.days;
    const r = C.computeRange(days, { period: anState.period, pendingStart: anState.pendingStart, pendingEnd: anState.pendingEnd });
    anState.startIdx = r.startIdx;
    anState.endIdx = r.endIdx;
    anState.rangeSwapped = r.rangeSwapped;
    dom.startInput.value = days[anState.startIdx];
    dom.endInput.value = days[anState.endIdx];
    dom.rangeNote.textContent = anState.rangeSwapped ? "開始日と終了日を入れ替えました" : "";
    dom.rangeNote.classList.toggle("hidden-element", !anState.rangeSwapped);

    const range = C.rangeIndices(anState.startIdx, anState.endIdx);
    const prev = C.prevRangeIndices(days, anState.startIdx, anState.endIdx);
    const S = anData.series;
    const vNow = C.sumSeries(S.v24_total, range);
    const vPrev = C.sumSeries(S.v24_total, prev);
    const totalsNow = C.projectTotals(anData.v24, range).sort((a, b) => b.total - a.total);
    const ind = computeIndicatorsForDebug();

    // 箱ごとの描画（AnalysisParts のインスタンス経由）
    const partState = { startIdx: anState.startIdx, endIdx: anState.endIdx, window: anState.window, period: anState.period };
    BOX_ORDER.forEach((boxId) => analysisInstance.render(boxId, partState, anData));

    // 検査用（tests/check_analysis.js）＝最後に描いた期間の集計値
    anState.last = { vNow, vPrev, activeNow: C.activeCount(anData.v24, range), topFolders: totalsNow.slice(0, 30).map((t) => t.folder), indicators: ind.items.map((x) => ({ n: x.n, ok: x.ok, actual: x.actual })), count: ind.count, band: ind.band, endDate: ind.endDate,
      recent4: ind.recent4, prev4: ind.prev4, mLast: ind.mLast, mPrev: ind.mPrev, vLastW: ind.vLast, vPrevW: ind.vPrev, h1: ind.h1, h2: ind.h2, nRec: ind.nRec, nPrv: ind.nPrv, W: ind.W, top2: ind.top2.map((t) => t.folder), priceTop10: ind.priceRank.map((x) => x.folder), upCount: ind.upCount,
      weeks: analysisInstance.charts.weeklyVol ? analysisInstance.charts.weeklyVol.data.labels.length : 0, months: analysisInstance.charts.monthly ? analysisInstance.charts.monthly.data.labels.length : 0 };
    dom.meta.textContent = `非公式・毎日1回の記録 ／ データ ${C.fmtYMD(S.first_day)}〜${C.fmtYMD(S.latest)}（${S.n_projects}PJ）・集計 ${S.built_at || "-"} ／ 表示 ${rangeLabel()}`;
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
    if (anState.window !== 90) params.set(URL_KEYS.window, String(anState.window));
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
    const w = Number(params.get(URL_KEYS.window));
    if (WINDOWS.includes(w)) anState.window = w;
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
    dom.windowGroup.addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-window]");
      if (!b) return;
      const w = Number(b.getAttribute("data-window"));
      if (!WINDOWS.includes(w)) return;
      anState.window = w;
      recomputeAll();
    });
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
      windowGroup: g("an-window-group")
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
    _debug: { state: anState, charts: analysisInstance.charts, data: anData, computeIndicators: computeIndicatorsForDebug, colorFor: analysisInstance.colorFor, currentTheme: analysisInstance.currentTheme, recomputeAll }
  };
})();
