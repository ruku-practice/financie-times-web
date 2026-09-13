/* ============================================================
 * FiNANCiE TIMES テーマ（ライト／ダーク）v3.2.0（2026-09-13 合体）
 *
 *  - 既定＝ライト（白）。OS の設定には追従しない。記憶＝localStorage "ft_theme"（"light"|"dark"）
 *    （ルク 2026-09-13 07:17「既定の背景を白に。そのうえでダークに変更できるように」）
 *  - <html data-theme> は index.html 先頭の1行が最初に必ず付ける（ちらつき防止）。ここは切替と色の読み出しだけ。
 *  - 色の正本は css/advanced.css の CSS 変数。JS は FtTheme.color("--chart-tick") のように読む
 *    （Chart.js の canvas は CSS が効かないので、テーマを変えたら描き直す必要がある）。
 *  - 切り替えたら window に "ft-theme-change" を投げる。各グラフはこれを聞いて、見えているものだけ描き直す。
 *  - どの JS より先に読み込む（overview.js・advanced.js・analysis.js・chart-legend.js が使う）。
 * ============================================================ */
(function () {
  "use strict";
  const KEY = "ft_theme";
  const LABEL = { light: "🌙 ダーク", dark: "☀️ ライト" }; // 押すと「次に変わるテーマ」を示す
  const TITLE = { light: "背景を黒にする", dark: "背景を白にする" };

  function current() {
    return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  // CSS 変数を1つ読む（前後の空白を落とす）。無ければ fallback
  function color(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback || "";
    } catch (e) {
      return fallback || "";
    }
  }

  function updateToggle() {
    const b = document.getElementById("theme-toggle");
    if (!b) return;
    const t = current();
    b.textContent = LABEL[t];
    b.title = TITLE[t];
    b.setAttribute("aria-pressed", String(t === "dark"));
  }

  function apply(theme, remember) {
    const t = theme === "dark" ? "dark" : "light";
    const changed = current() !== t;
    document.documentElement.setAttribute("data-theme", t);
    if (remember !== false) { try { localStorage.setItem(KEY, t); } catch (e) { /* 記憶できなくても動く */ } }
    updateToggle();
    if (changed) window.dispatchEvent(new CustomEvent("ft-theme-change", { detail: { theme: t } }));
  }

  function init() {
    updateToggle();
    const b = document.getElementById("theme-toggle");
    if (b && !b.dataset.ftThemeBound) {
      b.dataset.ftThemeBound = "1";
      b.addEventListener("click", () => apply(current() === "dark" ? "light" : "dark", true));
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.FtTheme = { KEY, current, color, apply, updateToggle };
})();
