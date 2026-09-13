/**
 * 合体 v3.2.0 の受け入れ検査（設計書「検査」M1〜M8 の土台）。
 * 全体市況タブ1つに、共通の操作帯・結論・機運の5指標・見せ方の箱が並ぶかを、実ブラウザで確かめる。
 * 配信サーバーはこのスクリプトが自分で立てて止める（127.0.0.1:8997）。
 * 実行: node tests/check_merged.js   出力: tests/out/check_merged.json・merged_{1280_light,1280_dark,390}.png
 */
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { chromium } = require(process.env.FT_PLAYWRIGHT || "/private/tmp/claude-501/-Users-kkr-ruku-data/e38f9b75-e4a5-4a31-89ba-3262c9b8e651/scratchpad/pw/node_modules/playwright-core");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(__dirname, "out");
const SERVE = path.join(OUT, "serve_merged");
const PORT = 8997;
const BASE = `http://127.0.0.1:${PORT}/root/index.html`;
const ref = JSON.parse(fs.readFileSync(path.join(OUT, "reference_merged.json"), "utf-8"));
const results = [];
const record = (id, ok, detail) => { results.push({ id, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${id} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`); };

async function waitServer() {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/root/data/overview/market.json`, { method: "HEAD" }); if (r.ok) return; } catch (e) {} await new Promise((r) => setTimeout(r, 200)); }
  throw new Error("server did not start");
}
const ready = (page) => page.waitForFunction(() => window.FinancieOverview && window.FinancieOverview._debug.state.initialized && window.FinancieOverview._debug.charts.volume, { timeout: 30000 });
async function scrollThrough(page) {
  await page.evaluate(async () => { for (let y = 0; y < document.documentElement.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); } window.scrollTo(0, 0); });
  await page.waitForTimeout(800);
}
const chartOk = (c) => !!c && c.data.datasets.length > 0 && c.data.datasets.some((d) => d.data.some((v) => v !== null && v !== undefined && !(typeof v === "number" && isNaN(v)))) && c.canvas.getBoundingClientRect().height >= 150;

async function main() {
  fs.mkdirSync(SERVE, { recursive: true });
  const link = path.join(SERVE, "root");
  try { fs.unlinkSync(link); } catch (e) {}
  fs.symlinkSync(ROOT, link, "dir");
  const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: SERVE, stdio: "ignore" });
  let browser;
  const errors = [];
  try {
    await waitServer();
    browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--mute-audio"] });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.route("**/financie.jp/**", (r) => r.fulfill({ status: 404, body: "" }));
    await ctx.route("**/image-financie.storage.googleapis.com/**", (r) => r.fulfill({ status: 404, body: "" }));
    const page = await ctx.newPage();
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(`${String(e)} @ ${(e.stack || "").split("\n").slice(1, 3).join(" | ")}`));
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await ready(page);

    // M1 タブ1つ・操作帯1本
    const m1 = await page.evaluate(() => ({
      overviewTabs: Array.from(document.querySelectorAll(".tab-nav-btn")).filter((b) => b.textContent.trim() === "全体市況").length,
      periodGroups: document.querySelectorAll("#ov-period-group").length, gapGroups: document.querySelectorAll("#ov-gap-mode").length,
      gapLabel: (document.querySelector("#ov-gap-mode .ov-control-label") || {}).textContent, gapButtons: Array.from(document.querySelectorAll("#ov-gap-mode button")).map((b) => b.textContent.trim()),
      theme: document.querySelectorAll("#theme-toggle").length, layout: document.querySelectorAll("#layout-toggle").length,
      ovCards: document.querySelectorAll("#overview-view .ov-chart-card").length
    }));
    record("M1-one-tab-one-band", m1.overviewTabs === 1 && m1.periodGroups === 1 && m1.gapGroups === 1 && m1.theme === 1 && m1.layout === 1 && m1.gapLabel === "欠測・一斉変動の日" && JSON.stringify(m1.gapButtons) === JSON.stringify(["ならす", "記録どおり"]) && m1.ovCards === 4, m1);

    // M6 既定＝ライト（記憶なし・OS に追従しない）
    const m6 = await page.evaluate(() => ({ theme: document.documentElement.getAttribute("data-theme"), bg: getComputedStyle(document.body).backgroundColor }));
    record("M6-default-light", m6.theme === "light" && m6.bg === "rgb(243, 244, 246)", m6);

    // M2 既定の見せ方（出来高＝積み上げ・シェア＝円・価格＝円・メンバー＝純増）と、結論・機運
    await scrollThrough(page);
    const m2 = await page.evaluate(() => {
      const ch = window.FinancieOverview._debug.charts;
      const vis = (sel) => { const el = document.querySelector(sel); return !!el && !el.hidden && el.getBoundingClientRect().height > 0; };
      return {
        volumeType: ch.volume && ch.volume.config.type, shareType: ch.share && ch.share.config.type, priceTitle: document.getElementById("ov-panelD-title").textContent,
        stackPane: vis('[data-ft-box-root="volume"] [data-view-pane="stack"]'), bundlePane: vis("#mg-pane-monthly"), netPane: vis('[data-ft-box-root="members"] [data-view-pane="net"]'),
        conclusion: document.querySelectorAll("#mg-conclusion li").length, indicators: document.querySelectorAll("#mg-indicators-tbody tr").length,
        verdict: document.getElementById("mg-kpi-verdict").textContent, members: document.getElementById("mg-kpi-members").textContent
      };
    });
    record("M2-default-views", m2.volumeType === "bar" && m2.shareType === "doughnut" && /円/.test(m2.priceTitle) && m2.stackPane && !m2.bundlePane && m2.netPane, m2);
    record("M2-conclusion-indicators", m2.conclusion === 3 && m2.indicators === 5 && /^\d \/ 5$/.test(m2.verdict) && m2.members !== "-", m2);

    // 見せ方を1つずつ切り替えて、箱の中の図が描かれるか（分析の部品＝FtMergedAnalysis のインスタンス／全体市況の部品）
    const views = [
      { box: "volume", view: "bundle", sel: '.ft-view-group[data-box="volume"] button[data-view="bundle"]', pane: "#mg-pane-monthly", chart: "part:monthly" },
      { box: "volume", view: "total", sel: '.ft-view-group[data-box="volume"] button[data-view="total"]', pane: "#mg-pane-daily", chart: "part:daily" },
      { box: "volume", view: "active", sel: '.ft-view-group[data-box="volume"] button[data-view="active"]', pane: "#mg-pane-weekly", chart: "part:weeklyActive" },
      { box: "share", view: "bundle", sel: '#ov-share-view button[data-view="bundle"]', pane: "#mg-pane-share", chart: "part:shareBundle" },
      { box: "ranking", view: "compare", sel: '.ft-view-group[data-box="ranking"] button[data-view="compare"]', pane: "#mg-pane-dumbbell", chart: "part:dumbbell" },
      { box: "members", view: "level", sel: '.ft-view-group[data-box="members"] button[data-view="level"]', pane: '[data-ft-box-root="members"] [data-view-pane="level"]', chart: "ov:membersLevelAll" }
    ];
    for (const v of views) {
      await page.click(v.sel);
      await page.waitForTimeout(300);
      await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: "center" }), v.pane);
      await page.waitForTimeout(1200);
      const st = await page.evaluate(({ chart, pane }) => {
        const [kind, key] = chart.split(":");
        const c = kind === "part" ? window.FtMergedAnalysis.getInstance().charts[key] : window.FinancieOverview._debug.charts[key];
        const ok = !!c && c.data.datasets.length > 0 && c.data.datasets.some((d) => d.data.some((x) => x !== null && x !== undefined)) && c.canvas.getBoundingClientRect().height >= 150;
        const p = document.querySelector(pane);
        return { ok, h: c ? Math.round(c.canvas.getBoundingClientRect().height) : 0, paneVisible: !!p && !p.hidden, stored: JSON.parse(localStorage.getItem("ft_views") || "{}") };
      }, v);
      record(`M2-view-${v.box}-${v.view}`, st.ok && st.paneVisible && st.stored[v.box] === v.view, st);
    }
    // 価格：最初の値＝100・価格上位
    await page.click('.ft-view-group[data-box="price"] button[data-view="index"]');
    await page.click('.ft-view-group[data-box="pricePick"] button[data-view="price"]');
    await page.evaluate(() => document.getElementById("ovPriceChart").scrollIntoView({ block: "center" }));
    await page.waitForTimeout(1000);
    const pr = await page.evaluate(() => {
      const c = window.FinancieOverview._debug.charts.price;
      const firsts = c.data.datasets.map((d) => d.data.find((x) => x !== null));
      return { title: document.getElementById("ov-panelD-title").textContent, firsts: firsts.slice(0, 3), all100: firsts.every((x) => x === null || Math.abs(x - 100) < 1e-9), n: c.data.datasets.length };
    });
    record("M2-view-price-index-pick", pr.all100 && pr.n === 10 && /期末の価格上位10/.test(pr.title), pr);

    // M7 見せ方の記憶（再読み込みで保持）
    await page.reload({ waitUntil: "domcontentloaded" });
    await ready(page);
    const m7 = await page.evaluate(() => ({ volume: (document.querySelector('.ft-view-group[data-box="volume"] button.active') || {}).dataset, pane: !document.querySelector("#mg-pane-weekly").hidden, members: !document.querySelector('[data-ft-box-root="members"] [data-view-pane="level"]').hidden }));
    record("M7-views-persist", m7.volume && m7.volume.view === "active" && m7.pane && m7.members, m7);
    await page.evaluate(() => { localStorage.removeItem("ft_views"); });
    await page.reload({ waitUntil: "domcontentloaded" });
    await ready(page);

    // M3 欠測の切替＝ KPI の期間合計が reference_merged.json（別実装）と一致・URL に gap=raw
    const kpi = () => page.evaluate(() => Number(document.getElementById("ov-kpi-total").textContent.replace(/[^0-9]/g, "")));
    const smooth = await kpi();
    await page.click('#ov-gap-mode button[data-gap="raw"]');
    await page.waitForTimeout(800);
    const raw = await kpi();
    const url = await page.evaluate(() => new URL(location.href).searchParams.get("gap"));
    const exp = ref.periods.latest_90;
    record("M3-gap-switch-matches-reference", Math.abs(smooth - Math.round(exp.smooth.total)) <= 1 && Math.abs(raw - Math.round(exp.raw.total)) <= 1 && url === "raw", { smooth, raw, expSmooth: Math.round(exp.smooth.total), expRaw: Math.round(exp.raw.total), url });
    await page.click('#ov-gap-mode button[data-gap="smooth"]');
    await page.waitForTimeout(500);

    // ---- エマ v3.2.0 の検収（11:01）の直しの検査 M10〜M16 ----
    // M10 KPI「メンバー純増」が選んだ期間に従う（契約 C・中2）＝reference_merged.json（別実装）の期間の純増と一致
    const membersNet = () => page.evaluate(() => Number(document.getElementById("mg-kpi-members").getAttribute("data-members-net")));
    const clickPeriod = async (p) => { await page.click(`#ov-period-group button[data-period="${p}"]`); await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(1500); };
    const m10 = { p90: await membersNet() };
    await clickPeriod("30"); m10.p30 = await membersNet();
    await clickPeriod("all"); m10.all = await membersNet();
    // M11 全期間：結論の1行目が値なしの「-」で終わらない（中7）・粒度を週へ切り替えた注記（軽11）
    const m11 = await page.evaluate(() => ({
      line1: document.querySelector("#mg-conclusion li").textContent,
      note: document.getElementById("ov-range-note").textContent, noteHidden: document.getElementById("ov-range-note").classList.contains("hidden-element"),
      gran: (document.querySelector("#ov-granularity-group button.active") || {}).textContent,
      label: document.getElementById("mg-kpi-members-label").textContent, sub: document.getElementById("mg-kpi-members-sub").textContent
    }));
    await page.click('#ov-gap-mode button[data-gap="raw"]'); await page.waitForTimeout(1500); m10.allRaw = await membersNet();
    await page.click('#ov-gap-mode button[data-gap="smooth"]'); await clickPeriod("90");
    const mp = ref.member_periods;
    record("M10-kpi-members-follows-period", m10.p90 === mp.latest_90.smooth_net && m10.p30 === mp.latest_30.smooth_net && m10.all === mp.all.smooth_net && m10.allRaw === mp.all.raw_net && m10.p90 !== m10.p30,
      { m10, ref: { p90: mp.latest_90.smooth_net, p30: mp.latest_30.smooth_net, all: mp.all.smooth_net, allRaw: mp.all.raw_net } });
    record("M11-all-period-no-dangling", !/前期間比 -/.test(m11.line1) && !m11.noteHidden && /週/.test(m11.note) && m11.gran === "週" && /期間のメンバー純増/.test(m11.label) && /比較できる前期間がありません/.test(m11.sub), m11);

    // M12 KPI の数値の上端がそろう・KPI の下と「結論」の間が 24px 以上（中3）
    const m12 = await page.evaluate(() => {
      window.scrollTo(0, 0);
      const tops = Array.from(document.querySelectorAll("#ov-kpi-grid .metric-value")).map((e) => Math.round(e.getBoundingClientRect().top));
      const grid = document.getElementById("ov-kpi-grid").getBoundingClientRect();
      const head = document.getElementById("mg-sec-conclusion").getBoundingClientRect();
      return { tops, gap: Math.round(head.top - grid.bottom) };
    });
    record("M12-kpi-aligned-gap", m12.tops.length === 6 && Math.max(...m12.tops) - Math.min(...m12.tops) <= 1 && m12.gap >= 24, m12);

    // M13 シェアの見せ方：束の見出し・aria-pressed（中5）
    const shareUi = () => page.evaluate(() => ({ title: document.getElementById("ov-share-title").textContent, pressed: Array.from(document.querySelectorAll("#ov-share-view button")).map((b) => b.getAttribute("aria-pressed")) }));
    await page.click('#ov-share-view button[data-view="bundle"]'); await page.waitForTimeout(800);
    const m13a = await shareUi();
    await page.click('#ov-share-view button[data-view="donut"]'); await page.waitForTimeout(800);
    const m13b = await shareUi();
    record("M13-share-title-aria", /束/.test(m13a.title) && !/100%積み上げ/.test(m13a.title) && JSON.stringify(m13a.pressed) === JSON.stringify(["false", "false", "true"]) && /期間合計/.test(m13b.title) && JSON.stringify(m13b.pressed) === JSON.stringify(["true", "false", "false"]), { m13a, m13b });

    // M14 上位10は検証済みの10色（9位・10位が青系の段で見分けられなかった＝中4）・11位以降だけ青系
    const m14 = await page.evaluate(() => {
      const f = window.FinancieOverview._debug.ovColor;
      const cs = getComputedStyle(document.documentElement);
      return { cols: Array.from({ length: 10 }, (_, i) => f(i)), var9: cs.getPropertyValue("--series-9").trim(), var10: cs.getPropertyValue("--series-10").trim(), c11: f(10) };
    });
    record("M14-top10-validated-colors", new Set(m14.cols).size === 10 && m14.cols[8] === m14.var9 && m14.cols[9] === m14.var10 && m14.cols.every((c) => !/^hsl/.test(c)) && /^hsl/.test(m14.c11), m14);

    // M15 呼び名・注記（中6 ISO 週・中8 PJ・軽10 ならすの title）＝隠れた見せ方も含めて textContent で数える
    const m15 = await page.evaluate(() => {
      const t = document.getElementById("overview-view").textContent;
      const title = document.querySelector('#ov-gap-mode button[data-gap="smooth"]').title;
      return { iso: (t.match(/ISO 週/g) || []).length, tatta: (t.match(/出来高が立った/g) || []).length, pjLong: (t.match(/取引のあったプロジェクト数/g) || []).length, anken: (t.match(/案件/g) || []).length, title };
    });
    record("M15-wording", m15.iso === 0 && m15.tatta === 0 && m15.pjLong === 0 && m15.anken === 0 && /埋め/.test(m15.title) && !/戻った日を除き/.test(m15.title), m15);

    // 画面の文字（呼び名の統一）
    const words = await page.evaluate(() => { const t = document.body.innerText; return { torihiki: (t.match(/取引量/g) || []).length, h24: (t.match(/24h/g) || []).length }; });
    record("M9-wording", words.torihiki === 0 && words.h24 === 0, words);

    // M8 横はみ出し・スクショ（ライト／ダーク）
    await scrollThrough(page);
    const ov1280 = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    await page.screenshot({ path: path.join(OUT, "merged_1280_light.png"), fullPage: true });
    await page.click("#theme-toggle");
    await page.waitForTimeout(800);
    await scrollThrough(page);
    const dark = await page.evaluate(() => ({ theme: document.documentElement.getAttribute("data-theme"), stored: localStorage.getItem("ft_theme"), tick: window.FinancieOverview._debug.charts.volume.options.scales.y.ticks.color }));
    await page.screenshot({ path: path.join(OUT, "merged_1280_dark.png"), fullPage: true });
    record("M6-toggle-dark", dark.theme === "dark" && dark.stored === "dark" && dark.tick === "#9ca3af", dark);
    await page.click("#theme-toggle");
    await page.waitForTimeout(500);

    // M16 PC：「絞り込み」の釦は出さず、操作は全部見える（中9 はスマホだけ）
    const m16pc = await page.evaluate(() => { window.scrollTo(0, 0); return { toggle: document.getElementById("ov-controls-toggle").getBoundingClientRect().height, gran: document.getElementById("ov-granularity-group").getBoundingClientRect().height, gap: document.getElementById("ov-gap-mode").getBoundingClientRect().height }; });
    record("M16-pc-no-controls-toggle", m16pc.toggle === 0 && m16pc.gran > 0 && m16pc.gap > 0, m16pc);

    // M20 日付別ランキング PC：並べ替え中の列の見出しに ▼（エマ 日付別 軽3）
    await page.click('.tab-nav-btn[data-tab="daily-tab"]');
    await page.waitForFunction(() => document.querySelectorAll("#historic-ranking-tbody tr").length > 5, { timeout: 30000 });
    const sortTh = () => page.evaluate(() => Array.from(document.querySelectorAll("#daily-travel-view th[aria-sort]")).map((th) => ({ col: th.getAttribute("data-sort-col"), after: getComputedStyle(th, "::after").content })));
    const m20a = await sortTh();
    await page.click('.sort-criteria-group .sort-tab-btn[data-sort="members"]');
    await page.waitForTimeout(300);
    const m20b = await sortTh();
    await page.click('.sort-criteria-group .sort-tab-btn[data-sort="volume"]');
    await page.click('.tab-nav-btn[data-tab="overview-tab"]');
    record("M20-daily-sorted-column-mark", m20a.length === 1 && m20a[0].col === "volume" && /▼/.test(m20a[0].after) && m20b.length === 1 && m20b[0].col === "members", { m20a, m20b });

    const sp = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await sp.route("**/financie.jp/**", (r) => r.fulfill({ status: 404, body: "" }));
    await sp.route("**/image-financie.storage.googleapis.com/**", (r) => r.fulfill({ status: 404, body: "" }));
    const sPage = await sp.newPage();
    sPage.on("pageerror", (e) => errors.push(`[390] ${String(e)} @ ${(e.stack || "").split("\n").slice(1, 3).join(" | ")}`));
    await sPage.goto(BASE, { waitUntil: "domcontentloaded" });
    await ready(sPage);
    await scrollThrough(sPage);
    const ov390 = await sPage.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    await sPage.screenshot({ path: path.join(OUT, "merged_390.png"), fullPage: true });

    // M17 スマホ：見せ方・小中大の釦が箱の枠の中に収まり、高さ 44px 以上（エマ v3.2.0 重1・軽12）
    const m17 = await sPage.evaluate(() => {
      const sel = "#overview-view .ft-view-group button, #overview-view #ov-share-view button, #overview-view .ov-size-btn[data-size]";
      const bad = [];
      const all = Array.from(document.querySelectorAll(sel));
      all.forEach((b) => {
        const card = b.closest(".chart-card, .ov-ranking-card");
        const r = b.getBoundingClientRect(), c = card.getBoundingClientRect();
        if (r.left < c.left - 0.5 || r.right > c.right + 0.5 || r.height < 44) bad.push({ t: b.textContent.trim(), l: Math.round(r.left), r: Math.round(r.right), h: Math.round(r.height), cl: Math.round(c.left), cr: Math.round(c.right) });
      });
      return { n: all.length, bad };
    });
    // 釦の数＝出来高 4＋3・シェア 3＋3・ランキング 2・価格 2＋2＋3・メンバー 2＋3＝27（1つでも消えたら FAIL にする）
    record("M17-sp-view-buttons-inside-44", m17.n === 27 && m17.bad.length === 0, m17);

    // M18 スマホ：見せ方を替えたあと、既定「上位＋その他」へ押して戻れる（重1）
    await sPage.click('.ft-view-group[data-box="volume"] button[data-view="bundle"]');
    await sPage.waitForTimeout(400);
    await sPage.click('.ft-view-group[data-box="volume"] button[data-view="stack"]', { timeout: 5000 });
    await sPage.waitForTimeout(400);
    const m18 = await sPage.evaluate(() => ({ view: window.FtMerged.state().views.volume, stackPane: !document.querySelector('[data-ft-box-root="volume"] [data-view-pane="stack"]').hidden }));
    record("M18-sp-view-back-to-default", m18.view === "stack" && m18.stackPane, m18);

    // M19 スマホの操作帯：「期間」だけ見せ、残りは「絞り込み ▾」でたたむ・開くと全部 44px（エマ v3.2.0 中9）
    const bandState = () => sPage.evaluate(() => {
      const vis = (el) => !!el && el.getBoundingClientRect().height > 0;
      const t = document.getElementById("ov-controls-toggle");
      const bar = document.getElementById("overview-controls");
      return {
        toggle: vis(t), expanded: t && t.getAttribute("aria-expanded"), period: vis(document.getElementById("ov-period-group")),
        gran: vis(document.getElementById("ov-granularity-group")), gap: vis(document.getElementById("ov-gap-mode")),
        summary: (document.getElementById("ov-controls-summary") || {}).textContent, bandH: Math.round(bar.getBoundingClientRect().height),
        small: Array.from(bar.querySelectorAll("button, input[type=date], label")).filter((el) => { const h = el.getBoundingClientRect().height; return h > 0 && h < 44; }).length
      };
    });
    await sPage.evaluate(() => window.scrollTo(0, 0));
    const m19a = await bandState();
    await sPage.click("#ov-controls-toggle");
    await sPage.waitForTimeout(300);
    const m19b = await bandState();
    record("M19-sp-controls-collapse", m19a.toggle && m19a.expanded === "false" && m19a.period && !m19a.gran && !m19a.gap && /ならす/.test(m19a.summary) && /上位10/.test(m19a.summary)
      && m19b.expanded === "true" && m19b.gran && m19b.gap && m19b.small === 0 && m19a.bandH < m19b.bandH, { m19a, m19b });

    // M21 日付別ランキング 390：並べ替え釦の高さ 44px 以上（エマ 日付別 軽2・合体 軽13）
    await sPage.click('.tab-nav-btn[data-tab="daily-tab"]');
    await sPage.waitForFunction(() => document.querySelectorAll("#historic-ranking-tbody tr").length > 5, { timeout: 30000 });
    const m21 = await sPage.evaluate(() => Array.from(document.querySelectorAll(".sort-criteria-group .sort-tab-btn")).map((b) => Math.round(b.getBoundingClientRect().height)));
    record("M21-sp-daily-sort-44", m21.length === 2 && m21.every((h) => h >= 44), { heights: m21 });
    await sPage.click('.tab-nav-btn[data-tab="overview-tab"]');
    record("M8-no-horizontal-overflow", ov1280.sw <= ov1280.iw && ov390.sw <= ov390.iw, { ov1280, ov390 });
    record("M0-no-console-errors", errors.length === 0, { n: errors.length, first: errors.slice(0, 3) });
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
  const allOk = results.length > 0 && results.every((r) => r.ok);
  fs.writeFileSync(path.join(OUT, "check_merged.json"), JSON.stringify({ allOk, results, at: new Date().toISOString() }, null, 2));
  console.log(allOk ? `\nALL PASS (${results.length})` : `\nSOME FAILED (${results.filter((r) => !r.ok).length}/${results.length})`);
  process.exit(allOk ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
