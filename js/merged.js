/* ============================================================
 * FiNANCiE TIMES 合体 v3.2.0｜共通の状態・URL・読み込み・箱の描き直し
 *
 * 設計書 docs/2026-09-13_合体_設計.md「契約（手順0）」A：
 *  - 共通の状態（期間・開始終了・粒度・上位N・その他・指標・欠測・機運の窓・見せ方）と URL の読み書きの持ち主はここだけ。
 *    描画の部品（overview.js・analysis の部品）は FtMerged.state() を読み、変化は subscribe で受ける。URL は触らない。
 *  - 優先順位＝URL ＞ 記憶 ＞ 既定（共有リンクを再現できる）。
 *  - 箱は「見えている／古い（stale）」を持つ。状態が変わったら全部を古くし、見えている箱だけすぐ描く。
 *    あとで見えた箱は古ければ描く。非同期の描画は世代番号で古い結果を捨てる。
 *  - JSON は FtMergedCore.createLoader で読む（通信中の Promise も共有）。
 * js/merged-core.js と js/theme.js のあとに読み込む。
 * ============================================================ */
(function () {
  "use strict";
  const C = window.FtMergedCore;

  // URL のキーは v3.1 の全体市況と分析タブのものをそのまま使う（旧リンクがそのまま開ける）
  const URL_KEYS = { period: "ov_p", start: "ov_s", end: "ov_e", granularity: "ov_g", topN: "ov_n", metric: "ov_m", others: "ov_o", gap: "gap", window: "an_w" };
  const STORE = { gap: "ft_gap_mode", views: "ft_views", legacyShare: "ft_share_view" };
  const METRICS = ["volume", "price", "members", "stock", "mcap"];
  const PERIODS = ["7", "30", "90", "365", "all"];
  const WINDOWS = [30, 90, 180];

  // 見せ方の既定＝ルク決裁 08:26（出来高＝上位Nの積み上げ／シェア＝円／価格＝円の実額／メンバー＝日ごとの純増）
  const DEFAULTS = {
    period: 90, start: null, end: null,
    granularity: "day", granularityManual: false,
    topN: 10, metric: "volume", showOthers: true,
    gap: "smooth", window: 90,
    views: { volume: "stack", share: "donut", ranking: "table", price: "yen", pricePick: "volume", members: "net" }
  };
  const VIEW_CHOICES = {
    volume: ["stack", "bundle", "total", "active"],
    share: ["donut", "trend", "bundle"],
    ranking: ["table", "compare"],
    price: ["yen", "index"],
    pricePick: ["volume", "price"],
    members: ["net", "level"]
  };

  const FILES = {
    market: "data/overview/market.json", v24: "data/overview/v24.json", v30: "data/overview/v30.json",
    price: "data/overview/price.json", members: "data/overview/members.json", stock: "data/overview/stock.json",
    mcap: "data/overview/mcap.json", monthly: "data/overview/monthly.json", bundles: "data/overview/bundles.json"
  };

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

  function readStore(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function writeStore(key, v) { try { if (v === null) localStorage.removeItem(key); else localStorage.setItem(key, v); } catch (e) { /* 記憶できなくても動く */ } }

  /* ---------------- 状態 ---------------- */
  // 既定 → 記憶 → URL の順に上書きする（URL が最優先）
  function initState(search) {
    const s = clone(DEFAULTS);
    // 記憶
    const g = readStore(STORE.gap);
    if (g === "raw") s.gap = "raw"; // 旧 "exclude"・"smooth"・無し＝ならす
    let stored = null;
    try { stored = JSON.parse(readStore(STORE.views) || "null"); } catch (e) { stored = null; }
    if (stored && typeof stored === "object") {
      Object.keys(VIEW_CHOICES).forEach((k) => { if (VIEW_CHOICES[k].includes(stored[k])) s.views[k] = stored[k]; });
    } else {
      const legacy = readStore(STORE.legacyShare); // v3.1 のシェアの見せ方（stack＝推移・donut＝円）
      if (legacy === "stack") s.views.share = "trend";
    }
    // URL
    const q = new URLSearchParams(search || "");
    const p = q.get(URL_KEYS.period);
    if (PERIODS.includes(p)) s.period = p === "all" ? "all" : Number(p);
    else if (p === "custom" && isDate(q.get(URL_KEYS.start)) && isDate(q.get(URL_KEYS.end))) {
      s.period = "custom"; s.start = q.get(URL_KEYS.start); s.end = q.get(URL_KEYS.end);
    }
    const gr = q.get(URL_KEYS.granularity);
    if (["day", "week", "month"].includes(gr)) { s.granularity = gr; s.granularityManual = true; }
    const n = q.get(URL_KEYS.topN);
    if (["10", "20", "30"].includes(n)) s.topN = Number(n);
    const m = q.get(URL_KEYS.metric);
    if (METRICS.includes(m)) s.metric = m;
    if (q.get(URL_KEYS.others) === "0") s.showOthers = false;
    const gap = q.get(URL_KEYS.gap);
    if (gap === "raw" || gap === "smooth") s.gap = gap;
    const w = Number(q.get(URL_KEYS.window));
    if (WINDOWS.includes(w)) s.window = w;
    return s;
  }

  // 状態 → URL の検索文字列（既定と同じものは書かない・他のキー（tab・project など）は残す）
  function toSearch(s, baseSearch) {
    const q = new URLSearchParams(baseSearch || "");
    Object.values(URL_KEYS).forEach((k) => q.delete(k));
    if (s.period !== DEFAULTS.period) q.set(URL_KEYS.period, String(s.period));
    if (s.period === "custom" && isDate(s.start) && isDate(s.end)) { q.set(URL_KEYS.start, s.start); q.set(URL_KEYS.end, s.end); }
    if (s.granularityManual) q.set(URL_KEYS.granularity, s.granularity);
    if (s.topN !== DEFAULTS.topN) q.set(URL_KEYS.topN, String(s.topN));
    if (s.metric !== DEFAULTS.metric) q.set(URL_KEYS.metric, s.metric);
    if (!s.showOthers) q.set(URL_KEYS.others, "0");
    if (s.gap !== DEFAULTS.gap) q.set(URL_KEYS.gap, s.gap);
    if (s.window !== DEFAULTS.window) q.set(URL_KEYS.window, String(s.window));
    const out = q.toString();
    return out ? `?${out}` : "";
  }

  let state = clone(DEFAULTS);
  const listeners = [];

  function syncUrl() {
    if (!window.history || !window.history.replaceState) return;
    const search = toSearch(state, window.location.search);
    window.history.replaceState(null, "", `${window.location.pathname}${search}${window.location.hash}`);
  }

  // patch を当てて、記憶・URL を更新し、購読者へ知らせる。views は箱ごとに混ぜる
  // opts.silent＝状態と URL だけ直して、購読者にも箱にも知らせない（描き直しの中で正規化した値を書き戻すとき用）
  function set(patch, opts) {
    const before = state;
    const next = Object.assign(clone(state), patch || {});
    if (patch && patch.views) next.views = Object.assign(clone(state.views), patch.views);
    state = next;
    if (state.gap !== before.gap) writeStore(STORE.gap, state.gap);
    if (JSON.stringify(state.views) !== JSON.stringify(before.views)) writeStore(STORE.views, JSON.stringify(state.views));
    if (!opts || !opts.skipUrl) syncUrl();
    if (opts && opts.silent) return clone(state);
    const changed = Object.keys(patch || {});
    listeners.slice().forEach((fn) => { try { fn(clone(state), changed); } catch (e) { console.error("FtMerged listener", e); } });
    if (!opts || !opts.skipRedraw) {
      if (changed.length === 1 && changed[0] === "views") Object.keys(patch.views).forEach((box) => redrawBox(box));
      else invalidate();
    }
    return clone(state);
  }

  function subscribe(fn) {
    listeners.push(fn);
    return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
  }

  /* ---------------- 箱（見えている／古い・世代番号） ---------------- */
  const boxes = new Map(); // id → { el, render, visible, stale }
  const generation = C.createGeneration();
  let observer = null;

  function ensureObserver() {
    if (observer || typeof IntersectionObserver === "undefined") return;
    observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const id = entry.target.getAttribute("data-ft-box");
        const b = boxes.get(id);
        if (!b) return;
        b.visible = entry.isIntersecting;
        if (b.visible && b.stale) draw(id, generation.current());
      });
    }, { root: null, threshold: 0.01 });
  }

  // render(state, ctx) は描画する関数。ctx.isCurrent() が false になったら、非同期の結果を捨てる
  function registerBox(id, el, render) {
    if (!el) return;
    el.setAttribute("data-ft-box", id);
    boxes.set(id, { el, render, visible: false, stale: true });
    ensureObserver();
    if (observer) observer.observe(el);
    else draw(id, generation.current()); // IntersectionObserver が無い環境ではすぐ描く
  }

  function draw(id, g) {
    const b = boxes.get(id);
    if (!b) return;
    b.stale = false;
    const ctx = { gen: g, isCurrent: () => generation.isCurrent(g), view: state.views[id], boxId: id };
    // render が false を返したら「今は描かなかった」（隠れている見せ方など）＝古いまま残し、次に見えたときに描く
    Promise.resolve().then(() => b.render(clone(state), ctx)).then((res) => { if (res === false) b.stale = true; })
      .catch((err) => { b.stale = true; console.error(`FtMerged draw ${id}`, err); });
  }

  function invalidate() {
    const g = generation.next();
    boxes.forEach((b, id) => { b.stale = true; if (b.visible || !observer) draw(id, g); });
  }

  // 見せ方の箱 "volume" を描き直すときは、その見せ方ごとの箱（"volume:bundle" など）も古くする
  function redrawBox(id) {
    boxes.forEach((b, key) => {
      if (key !== id && !key.startsWith(`${id}:`)) return;
      b.stale = true;
      if (b.visible || !observer) draw(key, generation.current());
    });
  }

  /* ---------------- 見せ方の釦 ---------------- */
  // <div class="ft-view-group" data-box="volume"><button data-view="stack">…</button>…</div>
  // 箱の中の [data-view-pane="stack"] だけを出す（他は hidden）
  function syncViewUi(box) {
    const view = state.views[box];
    document.querySelectorAll(`.ft-view-group[data-box="${box}"] button[data-view]`).forEach((b) => {
      const on = b.getAttribute("data-view") === view;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    });
    document.querySelectorAll(`[data-ft-box-root="${box}"] [data-view-pane]`).forEach((pane) => {
      pane.hidden = !pane.getAttribute("data-view-pane").split(/\s+/).includes(view); // "donut trend" のように複数可
    });
  }

  function setView(box, view) {
    if (!VIEW_CHOICES[box] || !VIEW_CHOICES[box].includes(view) || state.views[box] === view) return;
    set({ views: { [box]: view } });
    syncViewUi(box);
  }

  function bindViewButtons(rootEl) {
    (rootEl || document).querySelectorAll(".ft-view-group[data-box]").forEach((group) => {
      const box = group.getAttribute("data-box");
      if (group.dataset.ftBound) { syncViewUi(box); return; }
      group.dataset.ftBound = "1";
      group.querySelectorAll("button[data-view]").forEach((btn) => btn.addEventListener("click", () => setView(box, btn.getAttribute("data-view"))));
      syncViewUi(box);
    });
  }

  /* ---------------- データ ---------------- */
  const loader = C.createLoader((path) => fetch(path).then((r) => {
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  }));

  function load(name) {
    if (!FILES[name]) return Promise.reject(new Error(`unknown data: ${name}`));
    window.__ovLoadedFiles = window.__ovLoadedFiles || [];
    if (!loader.has(FILES[name])) window.__ovLoadedFiles.push(FILES[name]);
    return loader.load(FILES[name]);
  }

  /* ---------------- 起動 ---------------- */
  state = initState(window.location.search);
  window.addEventListener("ft-theme-change", () => invalidate());

  window.FtMerged = {
    DEFAULTS, VIEW_CHOICES, URL_KEYS, FILES,
    state: () => clone(state), set, subscribe,
    registerBox, invalidate, redrawBox, setView, bindViewButtons, syncViewUi,
    syncAllViews: () => Object.keys(VIEW_CHOICES).forEach((k) => syncViewUi(k)),
    load, generation,
    _debug: { boxes, initState, toSearch }
  };
})();
