/* ============================================================
 * ページの並び（縦1列／横2列）の切替 v0.1.0（2026-09-13）
 *  - html[data-layout="v"|"h"] を付け替える（CSS＝css/layout.css）
 *  - 既定＝縦1列（ルク 07:08「箱を縦に1列」）。選択は localStorage "ft_layout" に記憶
 *  - どのタブでも効く（全体市況・分析）。Chart.js は responsive なので幅が変われば自分で描き直す
 *  合体時：overview.js のテーマ切替（applyTheme）と同じ場所へ寄せる
 * ============================================================ */
(function () {
  "use strict";
  const KEY = "ft_layout";
  const LABEL = { v: "⇔ 横2列", h: "⇕ 縦1列" }; // 押すと「次に変わる並び」を示す
  const TITLE = { v: "箱を横2列に並べる", h: "箱を縦1列に並べる" };

  function current() {
    return document.documentElement.getAttribute("data-layout") === "h" ? "h" : "v";
  }

  function apply(mode, remember) {
    const m = mode === "h" ? "h" : "v";
    document.documentElement.setAttribute("data-layout", m);
    if (remember) { try { localStorage.setItem(KEY, m); } catch (e) { /* 記憶できなくても動く */ } }
    const b = document.getElementById("layout-toggle");
    if (b) {
      b.textContent = LABEL[m];
      b.title = TITLE[m];
      b.setAttribute("aria-pressed", String(m === "h"));
    }
    // 幅が変わったことをグラフに伝える（Chart.js の ResizeObserver が拾うが、念のため）
    window.setTimeout(() => window.dispatchEvent(new Event("resize")), 50);
  }

  function init() {
    let saved = null;
    try { saved = localStorage.getItem(KEY); } catch (e) { saved = null; }
    apply(saved === "h" ? "h" : "v", false);
    const b = document.getElementById("layout-toggle");
    if (b) b.addEventListener("click", () => apply(current() === "h" ? "v" : "h", true));
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.FinancieLayout = { current, apply, KEY };
})();
