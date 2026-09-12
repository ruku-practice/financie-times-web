/**
 * 総覧ダッシュボード（v3.0.0）の受け入れ検証。
 * Playwright(playwright-core, chrome channel) でヘッドレス起動し、
 * tests/out/reference.json（history.json から独立計算した期待値）と
 * 画面の表示値を突き合わせる。
 *
 * 実行: node tests/check_overview.js
 * 出力: tests/out/check_overview.json, tests/out/overview_{1280,768,390}.png
 */

const path = require("path");
const fs = require("fs");
const { chromium } = require("/private/tmp/claude-501/-Users-kkr-ruku-data/e38f9b75-e4a5-4a31-89ba-3262c9b8e651/scratchpad/pw/node_modules/playwright-core");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(__dirname, "out");
const PORT = 8991;
const BASE_ROOT = `http://127.0.0.1:${PORT}/root/index.html`;
const BASE_SUB = `http://127.0.0.1:${PORT}/financie/index.html`;

function loadReference() {
  const p = path.join(OUT_DIR, "reference.json");
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function num(text) {
  if (text === null || text === undefined) return NaN;
  return Number(String(text).replace(/[^0-9.\-]/g, ""));
}

// 1x1 透明PNG（外部ブロック時のフォールバック画像がonerrorループするのを防ぐ）
const STUB_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

async function installStubs(context) {
  // 外部ドメイン（financie.jp のフォールバック画像等）はネットワーク越しに毎回叩かず、
  // その場でダミー画像を返す（テスト環境のネットワーク遮断による無限リトライ対策）。
  await context.route("**/financie.jp/**", (route) => {
    route.fulfill({ status: 200, contentType: "image/png", body: STUB_PNG });
  });
}

async function waitOverviewReady(page) {
  await page.waitForFunction(() => {
    return window.FinancieOverview && window.FinancieOverview._debug.state.initialized;
  }, { timeout: 15000 });
  await page.waitForFunction(() => {
    const tb = document.getElementById("ov-ranking-tbody");
    return tb && !tb.textContent.includes("読み込んでいます");
  }, { timeout: 15000 });
}

async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const ref = loadReference();
  const results = [];
  const record = (id, ok, detail) => {
    results.push({ id, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"} ${id}: ${detail}`);
  };

  const browser = await chromium.launch({ channel: "chrome", headless: true });

  // ---------- A3 / A4 / A5 / A6 / A7 / A8 / A9 / A11 / A15 : ルート配信 ----------
  {
    const consoleErrors = [];
    const requests = [];
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await installStubs(context);
    const page = await context.newPage();
    page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
    page.on("request", (req) => { requests.push(req.url()); });

    await page.goto(BASE_ROOT, { waitUntil: "domcontentloaded", timeout: 20000 });
    await waitOverviewReady(page);

    // A3: 総覧タブが初期表示
    const overviewVisible = await page.evaluate(() => !document.getElementById("overview-view").classList.contains("hidden-element"));
    record("A3", overviewVisible === true, `overview-view visible=${overviewVisible}`);

    // A4: 既定(90日・日・上位10・出来高)でKPI1が90日合計と一致(±1)
    const kpiTotalText1 = await page.textContent("#ov-kpi-total");
    const kpi1 = num(kpiTotalText1);
    const expect90 = ref.last_90.total;
    record("A4", Math.abs(kpi1 - expect90) <= 1, `kpi=${kpi1} expect=${expect90}`);

    // A5: 30日に変更 → 一致
    await page.click('#ov-period-group button[data-period="30"]');
    await page.waitForTimeout(300);
    const kpi30 = num(await page.textContent("#ov-kpi-total"));
    record("A5-30d", Math.abs(kpi30 - ref.last_30.total) <= 1, `kpi=${kpi30} expect=${ref.last_30.total}`);

    // A5: 任意範囲 2026-07-01 〜 2026-07-31
    await page.fill("#ov-start-date", "2026-07-01");
    await page.dispatchEvent("#ov-start-date", "change");
    await page.fill("#ov-end-date", "2026-07-31");
    await page.dispatchEvent("#ov-end-date", "change");
    await page.waitForTimeout(300);
    const kpiRange = num(await page.textContent("#ov-kpi-total"));
    const rr = ref.range_20260701_20260731;
    record("A5-range", Math.abs(kpiRange - rr.total) <= 1, `kpi=${kpiRange} expect=${rr.total}`);

    // 上位10の顔ぶれ・順位確認（この時点=任意範囲・topN=10）
    const top10Folders = await page.$$eval("#ov-ranking-tbody tr.ov-ranking-row[data-folder]", (rows) => rows.map((r) => r.getAttribute("data-folder")));
    const sameOrder = JSON.stringify(top10Folders) === JSON.stringify(rr.top10_folders);
    record("A6-range-top10", sameOrder, `got=${JSON.stringify(top10Folders)} expect=${JSON.stringify(rr.top10_folders)}`);

    // A6: 90日に戻して上位10確認、続けて20/30で行数を確認
    await page.click('#ov-period-group button[data-period="90"]');
    await page.waitForTimeout(300);
    const top10Folders90 = await page.$$eval("#ov-ranking-tbody tr.ov-ranking-row[data-folder]", (rows) => rows.map((r) => r.getAttribute("data-folder")));
    const match90 = JSON.stringify(top10Folders90) === JSON.stringify(ref.last_90.top10_folders);
    record("A6-90d-top10", match90, `got=${JSON.stringify(top10Folders90)} expect=${JSON.stringify(ref.last_90.top10_folders)}`);

    // A16(旧DBG-1後追い): 90日・上位10の「前期間比」列が reference.py の独立計算(前の90日との比)と一致(±0.1pt)
    const zenkikanhi90 = await page.$$eval("#ov-ranking-tbody tr.ov-ranking-row[data-folder] td:nth-child(4)", (tds) => tds.map((td) => td.textContent.trim()));
    const diffRef = ref.last_90.top10_diff_pct || [];
    const diffMismatches = [];
    diffRef.forEach((r, i) => {
      const cellText = zenkikanhi90[i];
      if (r.pct === null) {
        // 前期間ゼロ: 現在値>0なら「新規」、現在値も0なら「—」を期待
        const expected = r.current > 0 ? "新規" : "—";
        if (cellText !== expected) diffMismatches.push(`${r.folder}: got=${cellText} expect=${expected}`);
        return;
      }
      const m = /^([▲▼])([\d,.]+)%$/.exec(cellText);
      if (!m) { diffMismatches.push(`${r.folder}: got=${cellText}（形式不一致） expect_pct=${r.pct.toFixed(1)}`); return; }
      const sign = m[1] === "▲" ? 1 : -1;
      const val = sign * Number(m[2].replace(/,/g, ""));
      if (Math.abs(val - r.pct) > 0.1) diffMismatches.push(`${r.folder}: got=${val} expect=${r.pct.toFixed(1)}`);
    });
    record("A16-zenkikanhi-90d", diffMismatches.length === 0, `mismatches=${JSON.stringify(diffMismatches)}`);

    await page.click('#ov-topn-group button[data-topn="20"]');
    await page.waitForTimeout(300);
    const rowCount20 = await page.$$eval("#ov-ranking-tbody tr", (rows) => rows.length);
    record("A6-top20-rowcount", rowCount20 === 21, `rows=${rowCount20} expect=21 (20+その他)`);

    await page.click('#ov-topn-group button[data-topn="30"]');
    await page.waitForTimeout(300);
    const rowCount30 = await page.$$eval("#ov-ranking-tbody tr", (rows) => rows.length);
    record("A6-top30-rowcount", rowCount30 === 31, `rows=${rowCount30} expect=31 (30+その他)`);

    await page.click('#ov-topn-group button[data-topn="10"]');
    await page.waitForTimeout(300);

    // A7: 週・月粒度でパネルAの合計 = 日粒度の期間合計(±1)
    const dayTotal = await page.evaluate(() => {
      const ds = window.FinancieOverview._debug.charts.volume.data.datasets;
      return ds.reduce((s, d) => s + d.data.reduce((a, b) => a + b, 0), 0);
    });
    await page.click('#ov-granularity-group button[data-granularity="week"]');
    await page.waitForTimeout(300);
    const weekTotal = await page.evaluate(() => {
      const ds = window.FinancieOverview._debug.charts.volume.data.datasets;
      return ds.reduce((s, d) => s + d.data.reduce((a, b) => a + b, 0), 0);
    });
    await page.click('#ov-granularity-group button[data-granularity="month"]');
    await page.waitForTimeout(300);
    const monthTotal = await page.evaluate(() => {
      const ds = window.FinancieOverview._debug.charts.volume.data.datasets;
      return ds.reduce((s, d) => s + d.data.reduce((a, b) => a + b, 0), 0);
    });
    record("A7-week", Math.abs(weekTotal - dayTotal) <= 1, `day=${dayTotal} week=${weekTotal}`);
    record("A7-month", Math.abs(monthTotal - dayTotal) <= 1, `day=${dayTotal} month=${monthTotal}`);
    await page.click('#ov-granularity-group button[data-granularity="day"]');
    await page.waitForTimeout(300);

    // A8: 初回は market.json + v24.json のみ。価格に切替でprice.jsonが1回だけ増える
    const filesBeforeMetric = await page.evaluate(() => window.__ovLoadedFiles.slice());
    await page.click('#ov-metric-group button[data-metric="price"]');
    await page.waitForTimeout(300);
    const filesAfterMetric = await page.evaluate(() => window.__ovLoadedFiles.slice());
    const priceCountBefore = filesBeforeMetric.filter((f) => f.includes("price.json")).length;
    const priceCountAfter = filesAfterMetric.filter((f) => f.includes("price.json")).length;
    const onlyMarketAndV24Initially = filesBeforeMetric.every((f) => f.includes("market.json") || f.includes("v24.json"))
      && filesBeforeMetric.some((f) => f.includes("market.json"))
      && filesBeforeMetric.some((f) => f.includes("v24.json"));
    record("A8-initial-files", onlyMarketAndV24Initially, `before=${JSON.stringify(filesBeforeMetric)}`);
    record("A8-price-once", priceCountBefore === 0 && priceCountAfter === 1, `before=${priceCountBefore} after=${priceCountAfter}`);
    await page.click('#ov-metric-group button[data-metric="volume"]');
    await page.waitForTimeout(200);

    // A9: その他を非表示
    await page.uncheck("#ov-show-others");
    await page.waitForTimeout(300);
    const othersHidden = await page.evaluate(() => {
      const ds = window.FinancieOverview._debug.charts.volume.data.datasets;
      const other = ds.find((d) => d.label === "その他");
      return other ? other.hidden === true : false;
    });
    record("A9", othersHidden, `hidden=${othersHidden}`);
    await page.check("#ov-show-others");
    await page.waitForTimeout(200);

    // A17: 開始日＞終了日を入れると、黙って収束せず入れ替えて注記を出す（DBG-3）
    // 🔴 page.fill() 自体が type=date の change を発火するため、直後に dispatchEvent を
    //    重ねると「入れ替え済みの値」に対してもう一度 change が飛び、rangeSwapped が
    //    偽に戻ってしまう（実機のユーザー操作では起きない・fillのみで1回にする）。
    await page.fill("#ov-start-date", "2026-08-01");
    await page.fill("#ov-end-date", "2026-01-01");
    await page.waitForTimeout(300);
    const swapped = await page.evaluate(() => {
      const s = window.FinancieOverview._debug.state;
      const days = window.FinancieOverview._debug.data.market.days;
      return {
        startDate: days[s.startIdx],
        endDate: days[s.endIdx],
        rangeSwapped: s.rangeSwapped
      };
    });
    const noteVisible = await page.evaluate(() => {
      const el = document.getElementById("ov-range-note");
      return !!el && !el.classList.contains("hidden-element") && el.textContent.includes("入れ替えました");
    });
    record(
      "A17-swap-order",
      swapped.rangeSwapped === true && swapped.startDate === "2026-01-01" && swapped.endDate === "2026-08-01" && noteVisible,
      `swapped=${JSON.stringify(swapped)} noteVisible=${noteVisible}`
    );
    // 90日に戻す（後続テストへの影響を消す）
    await page.click('#ov-period-group button[data-period="90"]');
    await page.waitForTimeout(300);

    // A11: フッター文言・煽り語なし
    const footerText = await page.textContent(".ov-footer");
    const hasRequired = ["非公式", "表示値", "保証しません"].every((w) => footerText.includes(w));
    record("A11-footer", hasRequired, footerText);

    const bannedScan = await page.evaluate(() => {
      const el = document.getElementById("overview-view").cloneNode(true);
      el.querySelectorAll(".table-pj-link").forEach((a) => a.remove());
      return el.innerText || el.textContent || "";
    });
    const banned = ["急騰", "注目", "買い", "上昇中"];
    const bannedHits = banned.filter((w) => bannedScan.includes(w));
    record("A11-no-hype", bannedHits.length === 0, `hits=${JSON.stringify(bannedHits)}`);

    // A15: 既存タブがエラーなく開く
    await page.click('.tab-nav-btn[data-tab="single-tab"]');
    await page.waitForTimeout(400);
    await page.click('.tab-nav-btn[data-tab="compare-tab"]');
    await page.waitForTimeout(400);
    await page.click('.tab-nav-btn[data-tab="daily-tab"]');
    await page.waitForTimeout(800);
    await page.click('.tab-nav-btn[data-tab="monthly-tab"]');
    await page.waitForTimeout(800);
    await page.click('.tab-nav-btn[data-tab="overview-tab"]');
    await page.waitForTimeout(300);
    record("A15-console-errors", consoleErrors.length === 0, `errors=${JSON.stringify(consoleErrors.slice(0, 5))}`);

    await context.close();
  }

  // ---------- A10: レスポンシブ ----------
  for (const w of [1280, 768, 390]) {
    const context = await browser.newContext({ viewport: { width: w, height: 900 } });
    await installStubs(context);
    const page = await context.newPage();
    await page.goto(BASE_ROOT, { waitUntil: "domcontentloaded", timeout: 20000 });
    await waitOverviewReady(page);
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth
    }));
    record(`A10-${w}`, overflow.scrollWidth <= overflow.innerWidth, JSON.stringify(overflow));

    // A18: 最下部までスクロールし、遅延読み込みのパネルD(価格)・E(メンバー増減)が
    // 実際に描画される（Chartのデータ系列が1本以上）ことを確認してからスクショを取る。
    // 🔴 実際にスクロールするのは window ではなく .main-chart-area（overflow-y:auto の
    //    内側コンテナ、1280幅のPCレイアウトで顕在化）。scrollIntoView はどちらの
    //    レイアウトでも祖先のスクロール位置を適切に動かすためこちらを使う。
    await page.evaluate(() => {
      document.getElementById("ovMembersChart").scrollIntoView({ block: "end" });
    });
    await page.waitForFunction(() => {
      const s = window.FinancieOverview._debug.state;
      return s.panelDReady && s.panelEReady;
    }, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(300);
    const panelDE = await page.evaluate(() => {
      const s = window.FinancieOverview._debug.state;
      const charts = window.FinancieOverview._debug.charts;
      const dSeries = charts.price ? charts.price.data.datasets.length : 0;
      const eSeries = charts.members ? charts.members.data.datasets.length : 0;
      return { panelDReady: s.panelDReady, panelEReady: s.panelEReady, dSeries, eSeries };
    });
    record(
      `A18-panelDE-${w}`,
      panelDE.panelDReady && panelDE.panelEReady && panelDE.dSeries >= 1 && panelDE.eSeries >= 1,
      JSON.stringify(panelDE)
    );

    await page.screenshot({ path: path.join(OUT_DIR, `overview_${w}.png`), fullPage: true });
    await context.close();
  }

  // ---------- A13: /financie/ サブパス ----------
  {
    const failedResponses = [];
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await installStubs(context);
    const page = await context.newPage();
    page.on("response", (res) => {
      const url = res.url();
      if (url.includes("/financie/data/") && res.status() !== 200) {
        failedResponses.push(`${res.status()} ${url}`);
      }
    });
    await page.goto(BASE_SUB, { waitUntil: "domcontentloaded", timeout: 20000 });
    await waitOverviewReady(page);
    const overviewVisible = await page.evaluate(() => !document.getElementById("overview-view").classList.contains("hidden-element"));
    record("A13", overviewVisible && failedResponses.length === 0, `visible=${overviewVisible} failed=${JSON.stringify(failedResponses)}`);
    await context.close();
  }

  await browser.close();

  const allOk = results.every((r) => r.ok);
  fs.writeFileSync(path.join(OUT_DIR, "check_overview.json"), JSON.stringify({ allOk, results }, null, 2));
  console.log(allOk ? "\nALL PASS" : "\nSOME FAILED");
  process.exit(allOk ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
