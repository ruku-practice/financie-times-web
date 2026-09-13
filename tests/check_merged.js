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
