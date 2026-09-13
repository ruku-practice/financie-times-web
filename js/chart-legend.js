/**
 * FiNANCiE TIMES グラフの凡例（全グラフ共通・v3.1 項目3）
 *
 * - 凡例の項目を押すと系列（円グラフは切片）を出し入れする。消した項目は打ち消し線＋薄く。
 * - 縦軸は Chart.js が「表示中の系列だけ」で取り直す（固定の上下限を持つグラフを除く）。
 * - 消した項目は localStorage（ft_legend_hidden）にグラフごと・名前で記憶し、
 *   期間の変更などで描き直しても、再読み込みしても消えたまま。
 * - 「全部出す」で全項目を戻し、そのグラフの記憶を消す。
 * - ds.ftLocked が true の系列（全体市況の「その他を表示」チェックで隠した「その他」）は、
 *   記憶にも「全部出す」にも含めない（チェックの状態と食い違わないように）。
 *
 * 使い方：FtLegend.render(chart, detailsElement, "グラフごとの記憶キー")
 *   detailsElement は <details class="ov-legend"><summary>凡例</summary><div class="ov-legend-items"></div></details>
 */
(function () {
  const STORE_KEY = "ft_legend_hidden";

  function readStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {}; } catch (e) { return {}; }
  }

  function writeStore(store) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* 記憶できなくても動く */ }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function isSliceChart(chart) {
    return chart.config.type === "doughnut" || chart.config.type === "pie";
  }

  function entriesOf(chart) {
    if (isSliceChart(chart)) {
      const colors = chart.data.datasets[0].backgroundColor;
      const ids = chart.data.datasets[0].ftIds || [];
      return chart.data.labels.map((label, i) => ({ id: ids[i] || label, label, color: Array.isArray(colors) ? colors[i] : colors, visible: chart.getDataVisibility(i), locked: false }));
    }
    return chart.data.datasets.map((ds, i) => ({
      id: ds.ftId || ds.label, // 記憶の識別子＝folder（同名の案件が2つあるため名前では区別できない・断 v3.1 重2）
      label: ds.label,
      color: !ds.backgroundColor || ds.backgroundColor === "transparent" || typeof ds.backgroundColor !== "string" ? ds.borderColor : ds.backgroundColor,
      visible: chart.isDatasetVisible(i),
      locked: ds.ftLocked === true
    }));
  }

  function setVisible(chart, i, visible) {
    if (isSliceChart(chart)) {
      if (chart.getDataVisibility(i) !== visible) chart.toggleDataVisibility(i);
    } else {
      chart.setDatasetVisibility(i, visible);
    }
  }

  // 記憶を今のグラフに当てる（描き直し直後に呼ぶ）。記憶に無い項目は出す（同じキーを共有する別のグラフで戻されたとき用）
  function applyStored(chart, storeKey) {
    const hidden = new Set(readStore()[storeKey] || []);
    let changed = false;
    entriesOf(chart).forEach((en, i) => {
      if (en.locked) return;
      const want = !hidden.has(en.id);
      if (en.visible !== want) { setVisible(chart, i, want); changed = true; }
    });
    if (changed) chart.update("none");
  }

  // 今のグラフの状態を記憶へ。今のグラフに載っていない名前の記憶は残す
  // （上位10→20→10 と切り替えても、消した案件が勝手に戻らないように）
  function saveFromChart(chart, storeKey) {
    const store = readStore();
    const hidden = new Set(store[storeKey] || []);
    entriesOf(chart).forEach((en) => {
      if (en.locked) return;
      if (en.visible) hidden.delete(en.id); else hidden.add(en.id);
    });
    if (hidden.size > 0) store[storeKey] = Array.from(hidden); else delete store[storeKey];
    writeStore(store);
  }

  // opts.onChange：この凡例で出し入れしたあとに呼ぶ（同じ記憶キーを共有する他のグラフを揃えるため）
  function render(chart, box, storeKey, opts) {
    if (!chart || !box) return;
    const items = box.querySelector(".ov-legend-items");
    const summary = box.querySelector("summary");
    if (!items) return;
    const onChange = opts && typeof opts.onChange === "function" ? opts.onChange : null;
    // 初回だけ：PC は開く・スマホはたたむ（描画域を優先）。以降は利用者の開閉を保つ
    if (!box.dataset.ftInit) {
      box.open = !(window.matchMedia && window.matchMedia("(max-width: 768px)").matches);
      box.dataset.ftInit = "1";
    }
    applyStored(chart, storeKey);

    const draw = () => {
      const entries = entriesOf(chart);
      const offCount = entries.filter((en) => !en.visible && !en.locked).length;
      // 押せると分かる手がかり（エマ v3.1 重1）：開閉の印は CSS（::before）・文言に「押すと出し入れ」
      if (summary) summary.textContent = offCount > 0 ? `凡例（${entries.length}・${offCount}件を非表示）｜押すと出し入れ` : `凡例（${entries.length}）｜押すと出し入れ`;
      items.innerHTML = entries.map((en, i) =>
        `<button type="button" class="ov-legend-item${en.visible ? "" : " off"}" data-index="${i}" aria-pressed="${en.visible}" title="${en.visible ? "押すと隠す" : "押すと出す"}"><span class="ov-legend-swatch" style="background:${escapeHtml(en.color || "#6b7280")}"></span>${escapeHtml(en.label)}</button>`
      ).join("") + `<button type="button" class="ov-legend-all" data-legend-all="1"${offCount > 0 ? ` title="非表示の${offCount}件を全部出す"` : " disabled aria-disabled=\"true\" title=\"非表示の項目がありません\""}>全部出す</button>`;

      items.querySelectorAll(".ov-legend-item").forEach((btn) => {
        btn.addEventListener("click", () => {
          const i = Number(btn.getAttribute("data-index"));
          const now = entriesOf(chart)[i];
          setVisible(chart, i, !now.visible);
          chart.update();
          saveFromChart(chart, storeKey);
          draw();
          if (onChange) onChange();
        });
      });
      items.querySelector(".ov-legend-all").addEventListener("click", () => {
        entriesOf(chart).forEach((en, i) => { if (!en.locked && !en.visible) setVisible(chart, i, true); });
        chart.update();
        const store = readStore();
        delete store[storeKey];
        writeStore(store);
        draw();
        if (onChange) onChange();
      });
    };
    draw();
  }

  // 記憶から特定の項目を外す（例：全体市況の「その他を表示」を入れ直したとき＝断 v3.1 重1）
  function forget(storeKeys, id) {
    const store = readStore();
    let changed = false;
    (Array.isArray(storeKeys) ? storeKeys : [storeKeys]).forEach((k) => {
      if (!Array.isArray(store[k])) return;
      const next = store[k].filter((x) => x !== id);
      if (next.length !== store[k].length) { changed = true; if (next.length > 0) store[k] = next; else delete store[k]; }
    });
    if (changed) writeStore(store);
  }

  window.FtLegend = { render, forget, STORE_KEY };
})();
