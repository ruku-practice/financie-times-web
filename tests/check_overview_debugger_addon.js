/**
 * 断（デバッガー）が1回目の検収で追加した検査。
 * check_overview.js の既存24項目が拾っていなかった穴を2つ検証する。
 *
 * 1) 出来高ランキング表の「前期間比」列（4列目）が、常にハードコードの "-" になっていないか。
 *    （js/overview.js の renderPanelC 内、volume分岐の4番目の<td>がリテラル "-" 固定）
 * 2) 任意範囲で開始日に未来日（データの最終日より後）を入れたとき、
 *    範囲が「全期間」相当に暴走していないか（本来は空/最小範囲になるべき）。
 *
 * 実行: node tests/check_overview_debugger_addon.js
 * （事前に check_overview.js と同じ手順でサーバーを立てておくこと。BASE_ROOTは環境変数 OV_BASE_ROOT で上書き可）
 */
const path = require("path");
const { chromium } = require("/private/tmp/claude-501/-Users-kkr-ruku-data/e38f9b75-e4a5-4a31-89ba-3262c9b8e651/scratchpad/pw/node_modules/playwright-core");

const BASE_ROOT = process.env.OV_BASE_ROOT || "http://127.0.0.1:8991/root/index.html";

const STUB_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

async function waitOverviewReady(page) {
  await page.waitForFunction(() => window.FinancieOverview && window.FinancieOverview._debug.state.initialized, { timeout: 15000 });
  await page.waitForFunction(() => {
    const tb = document.getElementById("ov-ranking-tbody");
    return tb && !tb.textContent.includes("読み込んでいます");
  }, { timeout: 15000 });
}

async function run() {
  const results = [];
  const record = (id, ok, detail) => {
    results.push({ id, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"} ${id}: ${detail}`);
  };

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("**/financie.jp/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: STUB_PNG }));
  const page = await context.newPage();
  await page.goto(BASE_ROOT, { waitUntil: "domcontentloaded", timeout: 20000 });
  await waitOverviewReady(page);

  // ---- 1) 前期間比列がハードコードの "-" になっていないか ----
  const zenkikanhi = await page.$$eval("#ov-ranking-tbody tr.ov-ranking-row[data-folder] td:nth-child(4)", (tds) => tds.map((td) => td.textContent.trim()));
  const allDash = zenkikanhi.length > 0 && zenkikanhi.every((t) => t === "-");
  record(
    "DBG-1-zenkikanhi-not-hardcoded",
    !allDash,
    `出来高ランキングの「前期間比」列＝${JSON.stringify(zenkikanhi.slice(0, 5))}（先頭5行）。全行 "-" ならjs/overview.js:507のハードコードが原因`
  );

  // ---- 2) 未来日の開始日で範囲が暴走しないか ----
  await page.fill("#ov-start-date", "2099-01-01");
  await page.dispatchEvent("#ov-start-date", "change");
  await page.dispatchEvent("#ov-start-date", "blur"); // 日付欄は確定（blur/Enter）で反映（重4対応・2026-09-12 夜）
  await page.waitForTimeout(300);
  const future = await page.evaluate(() => {
    const s = window.FinancieOverview._debug.state;
    const days = window.FinancieOverview._debug.data.market.days;
    return { startIdx: s.startIdx, endIdx: s.endIdx, startDate: days[s.startIdx], nDays: s.endIdx - s.startIdx + 1 };
  });
  // 全期間(991日)にまで暴走していないか＝せめて直近90日程度の幅に収まっているべき、という緩い基準
  const notRunaway = future.nDays <= 91;
  record(
    "DBG-2-future-start-date",
    notRunaway,
    `開始日に2099-01-01を入れた結果 startDate=${future.startDate} nDays=${future.nDays}（990超なら「全期間」に暴走）`
  );

  await context.close();
  await browser.close();

  const allOk = results.every((r) => r.ok);
  console.log(allOk ? "\nALL PASS" : "\nSOME FAILED（断が見つけた穴。担当が直すこと）");
  process.exit(allOk ? 0 : 1);
}

run().catch((err) => { console.error(err); process.exit(1); });
