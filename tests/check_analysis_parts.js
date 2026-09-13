/**
 * 手順2の受け入れ検証：js/analysis.js を「集計」「箱ごとの描画」「旧タブの包み」に
 * 分けたあと、window.AnalysisParts.createInstance が独立した2つのインスタンスとして
 * 動くこと・window.FtAnalysisCore.computeIndicators が旧タブの結果と一致することを確かめる。
 *
 * 配信サーバーはこのスクリプトが自分で立てる（127.0.0.1:8996・check_analysis.js の作りを真似る）。
 * 実行: node tests/check_analysis_parts.js
 * 出力: tests/out/check_analysis_parts.json
 */

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { chromium } = require("/private/tmp/claude-501/-Users-kkr-ruku-data/e38f9b75-e4a5-4a31-89ba-3262c9b8e651/scratchpad/pw/node_modules/playwright-core");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(__dirname, "out");
const SERVE_DIR = path.join(OUT_DIR, "serve_parts");
const PORT = 8996;
const BASE_ROOT = `http://127.0.0.1:${PORT}/root/index.html?tab=analysis`;

function setupServeDir() {
  fs.mkdirSync(SERVE_DIR, { recursive: true });
  const p = path.join(SERVE_DIR, "root");
  try { fs.unlinkSync(p); } catch (e) { /* none */ }
  fs.symlinkSync(ROOT, p, "dir");
}

function startServer() {
  return spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: SERVE_DIR, stdio: "ignore" });
}

async function waitServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/root/data/analysis/series.json`, { method: "HEAD" });
      if (r.ok) return;
    } catch (e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start");
}

const STUB_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
async function installStubs(context) {
  await context.route("**/financie.jp/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: STUB_PNG }));
}

async function waitReady(page) {
  await page.waitForFunction(() => window.FinancieAnalysis && window.FinancieAnalysis._debug.state.loaded && window.FinancieAnalysis._debug.state.last, { timeout: 30000 });
  await page.waitForTimeout(200);
}

async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const results = [];
  const record = (id, ok, detail) => { results.push({ id, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${id}: ${detail}`); };

  setupServeDir();
  const server = startServer();
  await waitServer();
  const browser = await chromium.launch({ channel: "chrome", headless: true });

  try {
    const consoleErrors = [];
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ja-JP" });
    await installStubs(context);
    const page = await context.newPage();
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    await page.goto(BASE_ROOT, { waitUntil: "domcontentloaded", timeout: 30000 });
    await waitReady(page);

    // P1 window.FtAnalysisCore / window.AnalysisParts が公開されている
    const globals = await page.evaluate(() => ({ core: typeof window.FtAnalysisCore, parts: typeof window.AnalysisParts, createInstance: typeof (window.AnalysisParts && window.AnalysisParts.createInstance) }));
    record("P1-globals-exposed", globals.core === "object" && globals.parts === "object" && globals.createInstance === "function", JSON.stringify(globals));

    // P2 テスト用の2つの箱を body の末尾へ足し、2つの独立インスタンスで daily / monthly を描く
    const setup = await page.evaluate(() => {
      function box(prefix, ids) {
        const div = document.createElement("div");
        div.id = prefix + "-container";
        ids.forEach((id) => {
          const tag = id.endsWith("Chart") ? "canvas" : "div";
          const el = document.createElement(tag);
          el.id = prefix + "-" + id;
          if (tag === "canvas") { el.width = 400; el.height = 240; el.style.width = "400px"; el.style.height = "240px"; }
          div.appendChild(el);
        });
        document.body.appendChild(div);
        return div.id;
      }
      const c1 = box("test1", ["anDailyChart", "an-legend-daily", "an-daily-sub", "an-daily-note"]);
      const c2 = box("test2", ["anMonthlyChart", "an-legend-monthly", "an-monthly-sub", "an-monthly-note"]);

      const getEl1 = (id) => document.getElementById("test1-" + id);
      const getEl2 = (id) => document.getElementById("test2-" + id);
      window.__t1 = window.AnalysisParts.createInstance({ getEl: getEl1 });
      window.__t2 = window.AnalysisParts.createInstance({ getEl: getEl2 });

      const state = window.FinancieAnalysis._debug.state;
      const data = window.FinancieAnalysis._debug.data;
      const partState = { startIdx: state.startIdx, endIdx: state.endIdx, window: state.window, period: state.period };
      window.__t1.render("daily", partState, data);
      window.__t2.render("monthly", partState, data);

      const oldDaily = window.FinancieAnalysis._debug.charts.daily;
      const c1chart = window.__t1.charts.daily;
      const c2chart = window.__t2.charts.monthly;
      const pointsOf = (chart) => chart ? chart.data.datasets.reduce((s, d) => s + d.data.filter((v) => v !== null && v !== undefined && !isNaN(v)).length, 0) : -1;
      return {
        containers: [c1, c2],
        distinct: !!c1chart && !!c2chart && c1chart !== c2chart && c1chart !== oldDaily && c2chart !== oldDaily,
        c1Points: pointsOf(c1chart), c2Points: pointsOf(c2chart), oldDailyPoints: pointsOf(oldDaily),
        c1Type: c1chart ? c1chart.config.type : null, c2Type: c2chart ? c2chart.config.type : null
      };
    });
    record("P2-two-instances-render", setup.distinct && setup.c1Points > 0 && setup.c2Points > 0, JSON.stringify(setup));

    // P3 片方を dispose しても、もう片方と旧タブの chart は残る
    const disposeCheck = await page.evaluate(() => {
      window.__t1.dispose("daily");
      const oldDaily = window.FinancieAnalysis._debug.charts.daily;
      return {
        t1DailyGone: window.__t1.charts.daily === null || window.__t1.charts.daily === undefined,
        t2MonthlyAlive: !!(window.__t2.charts.monthly && !window.__t2.charts.monthly.destroyed),
        oldDailyAlive: !!(oldDaily && !oldDaily.destroyed)
      };
    });
    record("P3-dispose-isolated", disposeCheck.t1DailyGone && disposeCheck.t2MonthlyAlive && disposeCheck.oldDailyAlive, JSON.stringify(disposeCheck));

    // P4 disposeAll で自分のインスタンスの残りchartも消える（t2）
    const disposeAllCheck = await page.evaluate(() => {
      window.__t2.disposeAll();
      const oldDaily = window.FinancieAnalysis._debug.charts.daily;
      return {
        t2Gone: window.__t2.charts.monthly === null || window.__t2.charts.monthly === undefined,
        oldDailyStillAlive: !!(oldDaily && !oldDaily.destroyed)
      };
    });
    record("P4-disposeAll-own-instance-only", disposeAllCheck.t2Gone && disposeAllCheck.oldDailyStillAlive, JSON.stringify(disposeAllCheck));

    // P5 FtAnalysisCore.computeIndicators の結果が旧タブの _debug.state.last.indicators と一致
    const indMatch = await page.evaluate(() => {
      const state = window.FinancieAnalysis._debug.state;
      const data = window.FinancieAnalysis._debug.data;
      const cfg = window.FinancieAnalysis.AN_CONFIG;
      const input = { series: data.series, v24: data.v24, price: data.price, priceFolderIndex: data.priceFolderIndex, dayIndex: data.dayIndex, config: cfg };
      const ind = window.FtAnalysisCore.computeIndicators(input, { endIdx: state.endIdx, window: state.window });
      const coreItems = ind.items.map((x) => ({ n: x.n, ok: x.ok, actual: x.actual }));
      const uiItems = state.last.indicators;
      return { coreItems, uiItems, count: ind.count, uiCount: state.last.count, band: ind.band, uiBand: state.last.band };
    });
    const itemsMatch = JSON.stringify(indMatch.coreItems) === JSON.stringify(indMatch.uiItems);
    record("P5-computeIndicators-matches-ui", itemsMatch && indMatch.count === indMatch.uiCount && indMatch.band === indMatch.uiBand, JSON.stringify({ itemsMatch, count: indMatch.count, uiCount: indMatch.uiCount, band: indMatch.band, uiBand: indMatch.uiBand }));

    // P6 コンソールエラー0（このテストの操作分のみ・overview.js 等の既存不具合は対象外）
    const partsErrors = consoleErrors.filter((e) => !e.includes("overview.js"));
    record("P6-console-clean", partsErrors.length === 0, JSON.stringify(partsErrors));

    await context.close();
  } finally {
    await browser.close();
    server.kill();
  }

  const allOk = results.every((r) => r.ok);
  fs.writeFileSync(path.join(OUT_DIR, "check_analysis_parts.json"), JSON.stringify({ allOk, results, at: new Date().toISOString() }, null, 2));
  console.log(allOk ? "\nALL PASS" : "\nSOME FAILED");
  process.exit(allOk ? 0 : 1);
}

run().catch((err) => { console.error(err); process.exit(1); });
