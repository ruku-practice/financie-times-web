/* ============================================================
 * FiNANCiE TIMES 合体 v3.2.0｜分析の部品（AnalysisParts）を全体市況の箱で動かす
 *
 *  - data/overview（schema 2）を、分析の部品が読む形（series・v24・price・monthly・bundles）へ変換する。
 *    欠測の切替（smooth／raw）ごとに1回だけ作って覚える（js/merged-core.js の式を使う＝全体市況の図と同じ数）。
 *  - 全体市況の箱の要素の ID は、分析タブの ID の頭を an → mg に替えたもの（an-kpi-total → mg-kpi-total・anDailyChart → mgDailyChart）。
 *    分析タブ（旧）はそのまま an- の要素で動く（別のインスタンス＝互いに干渉しない）。
 *  - 箱は FtMerged.registerBox で登録する（画面に入ったら描く・状態が変わったら描き直す・古い世代の結果は捨てる）。
 * js/merged-core.js・js/merged.js・js/analysis-core.js・js/analysis.js のあとに読み込む。
 * ============================================================ */
(function () {
  "use strict";
  const C = () => window.FtMergedCore;
  const M = () => window.FtMerged;
  const cache = {};

  function analysisData(mode) {
    const key = mode === "raw" ? "raw" : "smooth";
    if (cache[key]) return cache[key];
    const pr = Promise.all(["market", "v24", "price", "members", "monthly", "bundles"].map((n) => M().load(n)))
      .then(([market, v24, price, members, monthly, bundles]) => {
        const core = C();
        const days = market.days;
        const last = days.length - 1;
        const rows = core.volumeRows(v24, key);
        const v24Total = core.dailyTotals(rows, 0, last);
        const active = days.map((_, d) => {
          let n = 0;
          for (let p = 0; p < rows.length; p++) { const v = rows[p][d]; if (typeof v === "number" && v > 0) n++; }
          return n;
        });
        // メンバーの水準＝初日から積み上げ（契約 C）。公式PJは①で埋めた値（smooth）か生の値（raw）
        const membersTotal = core.membersLevel(members, key);
        const officialIdx = members.projects.findIndex((p) => p.folder === bundles.official);
        const base = key === "raw" ? members.rows : core.membersInfo(members).filled;
        const officialMembers = days.map((_, d) => {
          const v = officialIdx < 0 ? null : base[officialIdx][d];
          return typeof v === "number" ? v : null;
        });
        const series = {
          days, v24_total: v24Total, active, members_total: membersTotal, official_members: officialMembers,
          n_projects: v24.projects.length, first_day: market.first_day || days[0], latest: days[last], built_at: market.built_at
        };
        // 月次：その月の採用日＝PJ の採用日のうちいちばん遅い日。期末より後なら、その月は使わない（先読みしない＝契約 B）
        const pickedDays = monthly.months.map((_, j) => {
          let mx = -1;
          monthly.picked_day.forEach((row) => { const v = row[j]; if (typeof v === "number" && v > mx) mx = v; });
          return mx >= 0 ? days[mx] : "9999-12-31";
        });
        const totals = monthly.months.map((_, j) => monthly.rows.reduce((s, r) => s + (typeof r[j] === "number" ? r[j] : 0), 0));
        const aliases = {};
        (bundles.merges || []).forEach((m) => { aliases[m[0]] = m[1]; });
        const data = {
          series,
          v24: { days, projects: v24.projects, rows },
          price,
          monthly: { months: monthly.months, picked_days: pickedDays, projects: monthly.projects, rows: monthly.rows, totals },
          bundles: { bundles: bundles.bundles, standalone: bundles.standalone, official: bundles.official, aliases }
        };
        data.dayIndex = {};
        days.forEach((d, i) => { data.dayIndex[d] = i; });
        data.folderIndex = {};
        v24.projects.forEach((p, i) => { data.folderIndex[p.folder] = i; });
        data.priceFolderIndex = {};
        price.projects.forEach((p, i) => { data.priceFolderIndex[p.folder] = i; });
        return data;
      });
    cache[key] = pr;
    pr.catch(() => { delete cache[key]; });
    return pr;
  }

  // 分析の部品の state（startIdx・endIdx・window・period）を共通の状態から作る（期間は暦日＝契約 D）
  function partState(state, days) {
    const spec = state.period === "custom" ? { period: "custom", start: state.start, end: state.end } : { period: state.period };
    const r = C().computeRange(days, spec);
    return { period: state.period, startIdx: r.startIdx, endIdx: r.endIdx, window: state.window };
  }

  const toMergedId = (id) => String(id).replace(/^an-/, "mg-").replace(/^an([A-Z])/, "mg$1");

  // 全体市況の箱に置いていない要素（分析タブの KPI の一部など）は、描き先の無い仮の要素を返す（部品の中で null にならないように）
  const placeholders = new Map();
  function placeholder(id) {
    if (!placeholders.has(id)) placeholders.set(id, document.createElement(/Chart$/.test(id) ? "canvas" : "div"));
    return placeholders.get(id);
  }

  let instance = null;
  function getInstance() {
    if (!instance) instance = window.AnalysisParts.createInstance({ getEl: (id) => document.getElementById(toMergedId(id)) || placeholder(id) });
    return instance;
  }

  // name＝FtMerged の箱の名前（見せ方の箱なら "volume:bundle" のように「箱:見せ方」）
  // el＝画面に入ったら描く要素／partIds＝この要素で描く分析の箱
  // after(state, data, ctx)＝部品を描いたあとに合体の画面だけで上書きする処理（任意）
  function register(name, el, partIds, after) {
    if (!el || !M() || !window.AnalysisParts) return;
    const [viewBox, view] = name.split(":");
    M().registerBox(name, el, (state, ctx) => {
      if (view && state.views[viewBox] !== view) return false; // 隠れている見せ方は描かない（出したときに描く）
      return analysisData(state.gap).then((data) => {
        if (!ctx.isCurrent()) return;
        const st = partState(state, data.series.days);
        partIds.forEach((b) => getInstance().render(b, st, data));
        if (after) return after(state, data, ctx);
      });
    });
  }

  // KPI「メンバー純増」＝選んだ期間の日ごとの純増の合計（契約 C・エマ v3.2.0 中2）。
  // 分析の部品は「期末直近W日（窓）」で書くので、合体の画面ではここで期間の値に書き換える。窓の値は機運の5指標の表（④）に残る
  function renderMembersKpi(state, data, ctx) {
    return M().load("members").then((members) => {
      if (!ctx.isCurrent()) return;
      const core = C();
      const key = state.gap === "raw" ? "raw" : "smooth";
      const days = data.series.days;
      const spec = state.period === "custom" ? { period: "custom", start: state.start, end: state.end } : { period: state.period };
      const r = core.computeRange(days, spec);
      const prev = core.prevRange(days, r);
      const now = core.membersNet(members, key, r.startIdx, r.endIdx);
      const signed = (v) => `${v > 0 ? "+" : ""}${Math.round(v).toLocaleString("ja-JP")}人`;
      const valueEl = document.getElementById("mg-kpi-members");
      const labelEl = document.getElementById("mg-kpi-members-label");
      const subEl = document.getElementById("mg-kpi-members-sub");
      if (labelEl) labelEl.textContent = "期間のメンバー純増";
      if (valueEl) {
        valueEl.textContent = signed(now);
        valueEl.className = `metric-value ${now > 0 ? "diff-up" : now < 0 ? "diff-down" : "diff-flat"}`;
        valueEl.setAttribute("data-members-net", String(now));
      }
      if (subEl) {
        if (!prev) subEl.textContent = "比較できる前期間がありません";
        else subEl.textContent = `前期間${prev.partial ? "（記録の初日から）" : ""} ${signed(core.membersNet(members, key, prev.startIdx, prev.endIdx))}`;
      }
    });
  }

  // 全体市況の箱へ分析の部品をつなぐ（見せ方の釦・窓の釦・箱の登録）
  function init() {
    const m = M();
    if (!m || !window.AnalysisParts || !document.getElementById("mg-sec-conclusion")) return;
    m.bindViewButtons(document);
    m.syncAllViews();
    // KPI（期間のメンバー純増・機運）は操作帯の直下＝スマホでは結論の欄より先に画面に入る。結論の欄だけを見張ると、
    // 開いただけでは KPI が「-」のままだった（エマ v3.2.1 中A）＝KPI の並びも同じ描画で見張る
    register("kpi", document.getElementById("ov-kpi-grid"), ["conclusion"], renderMembersKpi);
    register("conclusion", document.getElementById("mg-sec-conclusion"), ["conclusion"], renderMembersKpi);
    register("indicators", document.getElementById("mg-sec-indicators"), ["indicators"]);
    register("volume:bundle", document.getElementById("mg-pane-monthly"), ["monthly"]);
    register("volume:total", document.getElementById("mg-pane-daily"), ["daily"]);
    register("volume:active", document.getElementById("mg-pane-weekly"), ["weeklyVol", "weeklyActive"]);
    register("share:bundle", document.getElementById("mg-pane-share"), ["shareBundle"]);
    register("ranking:compare", document.getElementById("mg-pane-dumbbell"), ["dumbbell"]);
    const wg = document.getElementById("mg-window-group");
    if (wg) wg.querySelectorAll("button[data-window]").forEach((b) => b.addEventListener("click", () => m.set({ window: Number(b.getAttribute("data-window")) })));
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.FtMergedAnalysis = { analysisData, partState, toMergedId, register, getInstance, init };
})();
