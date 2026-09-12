/**
 * 「分析」タブ v0.1.0 の受け入れ検証。
 * Playwright(playwright-core, chrome channel) でヘッドレス起動し、
 * tests/out/reference_analysis.json（history.json から独立計算した期待値）と
 * 画面（window.FinancieAnalysis._debug.state.last）を突き合わせる。
 *
 * 配信サーバーはこのスクリプトが自分で立てる（127.0.0.1:8994・tests/out/serve に
 * root と financie の symlink）。終わったら止める。
 *
 * 実行: python3 tests/reference_analysis.py && node tests/check_analysis.js
 * 出力: tests/out/check_analysis.json, tests/out/analysis_{1280,390}.png, analysis_light_1280.png
 */

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { chromium } = require("/private/tmp/claude-501/-Users-kkr-ruku-data/e38f9b75-e4a5-4a31-89ba-3262c9b8e651/scratchpad/pw/node_modules/playwright-core");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(__dirname, "out");
const SERVE_DIR = path.join(OUT_DIR, "serve");
const PORT = 8994;
const BASE_ROOT = `http://127.0.0.1:${PORT}/root/index.html?tab=analysis`;
const BASE_SUB = `http://127.0.0.1:${PORT}/financie/index.html?tab=analysis`;

const STUB_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function setupServeDir() {
  fs.mkdirSync(SERVE_DIR, { recursive: true });
  for (const name of ["root", "financie"]) {
    const p = path.join(SERVE_DIR, name);
    try { fs.unlinkSync(p); } catch (e) { /* none */ }
    fs.symlinkSync(ROOT, p, "dir");
  }
}

function startServer() {
  const proc = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: SERVE_DIR, stdio: "ignore" });
  return proc;
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

async function installStubs(context) {
  await context.route("**/financie.jp/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: STUB_PNG }));
}

async function waitReady(page) {
  await page.waitForFunction(() => window.FinancieAnalysis && window.FinancieAnalysis._debug.state.loaded && window.FinancieAnalysis._debug.state.last, { timeout: 30000 });
  await page.waitForTimeout(200);
}

const readLast = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.FinancieAnalysis._debug.state.last)));

// 画面はページ内の容器（overflow-y:auto）でスクロールするため、fullPage で撮る前に容器を開く（エマ重2）
async function fullShot(page, file) {
  await page.evaluate(() => {
    document.querySelectorAll("*").forEach((el) => {
      const cs = getComputedStyle(el);
      if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 4) {
        el.style.setProperty("overflow", "visible", "important");
        el.style.setProperty("height", "auto", "important");
        el.style.setProperty("max-height", "none", "important");
      }
    });
    document.documentElement.style.setProperty("height", "auto", "important");
    document.body.style.setProperty("height", "auto", "important");
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: file, fullPage: true });
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitReady(page);
  return h;
}

// 各グラフが「空でない」＝ dataset が1つ以上あり、null でない点が1つ以上あり、描画域が 160px 以上
const chartsStatus = (page) => page.evaluate(() => {
  const ch = window.FinancieAnalysis._debug.charts;
  return Object.keys(ch).map((k) => {
    const c = ch[k];
    if (!c) return { key: k, ok: false, why: "no chart" };
    const points = c.data.datasets.reduce((s, d) => s + d.data.filter((v) => v !== null && v !== undefined && !isNaN(v)).length, 0);
    const h = c.canvas.getBoundingClientRect().height;
    const w = c.canvas.getBoundingClientRect().width;
    return { key: k, ok: c.data.datasets.length > 0 && points > 0 && h >= 160 && w >= 200, datasets: c.data.datasets.length, points, h: Math.round(h), w: Math.round(w) };
  });
});

// 文字色と背景のコントラスト（WCAG）。要素の背景は祖先をたどって最初の不透明色を使う
const contrastCheck = (page, selectors) => page.evaluate((sels) => {
  function parse(c) { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const a = m[1].split(",").map((x) => parseFloat(x)); return { r: a[0], g: a[1], b: a[2], a: a.length > 3 ? a[3] : 1 }; }
  function lum(c) { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); }
  function bgOf(el) { let e = el; while (e) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0.99) return c; e = e.parentElement; } return { r: 255, g: 255, b: 255, a: 1 }; }
  const out = [];
  sels.forEach((sel) => {
    const el = document.querySelector(sel);
    if (!el) { out.push({ sel, ratio: null }); return; }
    const fg = parse(getComputedStyle(el).color); const bg = bgOf(el);
    const l1 = lum(fg), l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const size = parseFloat(getComputedStyle(el).fontSize);
    const bold = parseInt(getComputedStyle(el).fontWeight, 10) >= 700;
    const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
    out.push({ sel, ratio: Math.round(ratio * 100) / 100, need, ok: ratio >= need });
  });
  return out;
}, selectors);

const TEXT_SELECTORS = ["#an-kpi-total", "#an-kpi-total-sub", ".an-conclusion li", ".an-note", ".an-section-head h3", ".an-section-sub", "#an-top30-tbody td.num", "#an-indicators-tbody td.def", ".an-ok", ".an-ng", ".an-legend-item", ".chart-card-title", "#an-top30-tbody a", ".an-ext-link"];

async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const ref = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "reference_analysis.json"), "utf-8"));
  const results = [];
  const record = (id, ok, detail) => { results.push({ id, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${id}: ${detail}`); };

  // B0 名寄せ＝仕様メモの参照実装（docs/analysis_code/window_compare.py の MERGES）とキー集合が完全一致（断の提案1）
  {
    const wc = fs.readFileSync(path.join(ROOT, "..", "..", "..", "docs", "analysis_code", "window_compare.py"), "utf-8");
    const m = wc.match(/MERGES\s*=\s*\[([^\]]*)\]/);
    const wcPairs = m ? [...m[1].matchAll(/\('([^']+)','([^']+)'\)/g)].map((x) => `${x[1]}>${x[2]}`).sort() : [];
    const py = fs.readFileSync(path.join(ROOT, "scripts", "build_analysis.py"), "utf-8");
    const block = py.slice(py.indexOf("ALIASES = {"), py.indexOf("}", py.indexOf("ALIASES = {")));
    const myPairs = [...block.matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map((x) => `${x[1]}>${x[2]}`).sort();
    const refPy = fs.readFileSync(path.join(ROOT, "tests", "reference_analysis.py"), "utf-8");
    const rb = refPy.slice(refPy.indexOf("MERGES = ["), refPy.indexOf("]", refPy.indexOf("MERGES = [")));
    const refPairs = [...rb.matchAll(/\("([^"]+)",\s*"([^"]+)"\)/g)].map((x) => `${x[1]}>${x[2]}`).sort();
    record("B0-aliases-match-spec", wcPairs.length === 3 && JSON.stringify(wcPairs) === JSON.stringify(myPairs) && JSON.stringify(wcPairs) === JSON.stringify(refPairs), `spec=${JSON.stringify(wcPairs)} build=${JSON.stringify(myPairs)} ref=${JSON.stringify(refPairs)}`);
    // 候補（パティスリー→鹿児島タイムズ）が結合されていない＝両方が別PJとして残り、鹿児島側に 2025-10-01 以前の値が無い（断の提案2）
    const v24 = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "analysis", "v24.json"), "utf-8"));
    const fi = {}; v24.projects.forEach((p, i) => { fi[p.folder] = i; });
    const cut = v24.days.findIndex((d) => d >= "2025-10-01");
    const kagoBefore = fi["380_kagoshima_times"] !== undefined ? v24.rows[fi["380_kagoshima_times"]].slice(0, cut).filter((v) => v !== null).length : -1;
    record("B0-candidate-not-merged", fi["345_PatisserieLeVert"] !== undefined && fi["380_kagoshima_times"] !== undefined && kagoBefore === 0 && v24.projects.length === 406, `patisserie=${fi["345_PatisserieLeVert"] !== undefined} kagoshima=${fi["380_kagoshima_times"] !== undefined} kagoBefore=${kagoBefore} projects=${v24.projects.length}`);
  }

  setupServeDir();
  const server = startServer();
  await waitServer();
  const browser = await chromium.launch({ channel: "chrome", headless: true });

  try {
    // ---------- PC 1280 ----------
    {
      const consoleErrors = [];
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ja-JP" });
      await installStubs(context);
      const page = await context.newPage();
      page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
      await page.goto(BASE_ROOT, { waitUntil: "domcontentloaded", timeout: 30000 });
      await waitReady(page);

      // B1 タブが見えている・全体市況は隠れている
      const vis = await page.evaluate(() => ({ an: !document.getElementById("analysis-view").classList.contains("hidden-element"), ov: document.getElementById("overview-view").classList.contains("hidden-element"), tabActive: document.querySelector('.tab-nav-btn[data-tab="analysis-tab"]').classList.contains("active") }));
      record("B1-tab-visible", vis.an && vis.ov && vis.tabActive, JSON.stringify(vis));

      // B2 既定 90日＝期間合計・上位10・出来高が立ったPJ数が独立計算と一致
      let last = await readLast(page);
      record("B2-90d-total", Math.abs(last.vNow - ref.last_90.total) <= 1, `ui=${last.vNow} ref=${ref.last_90.total}`);
      record("B2-90d-top10", JSON.stringify(last.topFolders.slice(0, 10)) === JSON.stringify(ref.last_90.top10_folders), `ui=${last.topFolders.slice(0, 10)} ref=${ref.last_90.top10_folders}`);
      record("B2-90d-active", last.activeNow === ref.last_90.active, `ui=${last.activeNow} ref=${ref.last_90.active}`);

      // B3 11グラフすべて空でない（既定）
      let st = await chartsStatus(page);
      record("B3-charts-90d", st.length === 11 && st.every((s) => s.ok), JSON.stringify(st));

      // B4 30日に変更 → 合計・前期間比の元の値が一致し、90日と数字が変わる
      const v90 = last.vNow;
      await page.click('#an-period-group button[data-period="30"]');
      await waitReady(page);
      last = await readLast(page);
      record("B4-30d-total", Math.abs(last.vNow - ref.last_30.total) <= 1 && last.vNow !== v90, `ui=${last.vNow} ref=${ref.last_30.total} (90d=${v90})`);
      record("B4-30d-prev", Math.abs(last.vPrev - ref.latest_indicators.W30.prev_total) <= 1, `ui=${last.vPrev} ref=${ref.latest_indicators.W30.prev_total}`);
      // 既定の窓＝90日で、最新日の判定が独立計算と一致
      record("B4-default-window", last.W === 90 && last.count === ref.latest_indicators.W90.count, `W=${last.W} count=${last.count} ref=${ref.latest_indicators.W90.count}`);
      record("B4-url", (await page.evaluate(() => location.search)).includes("an_p=30"), await page.evaluate(() => location.search));

      // B5 全期間 → 全グラフ空でない・月次が全月・週が100以上
      await page.click('#an-period-group button[data-period="all"]');
      await waitReady(page);
      last = await readLast(page);
      st = await chartsStatus(page);
      record("B5-all-charts", st.every((s) => s.ok), JSON.stringify(st.filter((s) => !s.ok)) || "all ok");
      // 全期間は約25万セルを整数に丸めているので、合計の許容差＝合計の 1e-7（約450円）
      record("B5-all-total", Math.abs(last.vNow - ref.all.total) <= Math.max(1, ref.all.total * 1e-7), `ui=${last.vNow} ref=${ref.all.total}`);
      record("B5-all-buckets", last.months >= 30 && last.weeks >= 100, `months=${last.months} weeks=${last.weeks}`);

      // B6 自由期間（適用ボタン）2026-07-01〜07-31 → 合計・上位10一致
      await page.fill("#an-start-date", "2026-07-01");
      await page.fill("#an-end-date", "2026-07-31");
      await page.click("#an-apply");
      await waitReady(page);
      last = await readLast(page);
      const rr = ref.range_20260701_20260731;
      record("B6-custom-total", Math.abs(last.vNow - rr.total) <= 1, `ui=${last.vNow} ref=${rr.total}`);
      record("B6-custom-top10", JSON.stringify(last.topFolders.slice(0, 10)) === JSON.stringify(rr.top10_folders), `ui=${last.topFolders.slice(0, 10)}`);
      record("B6-custom-url", (await page.evaluate(() => location.search)).includes("an_s=2026-07-01") , await page.evaluate(() => location.search));

      // B7 自由期間（終了 2026-09-11 固定・Enter で確定）＋窓30日 → 機運の5指標が独立計算（仕様メモ §6-2）と一致
      await page.fill("#an-start-date", "2026-06-14");
      await page.fill("#an-end-date", "2026-09-11");
      await page.focus("#an-end-date");
      await page.keyboard.press("Enter");
      await waitReady(page);
      await page.click('#an-window-group button[data-window="30"]');
      await waitReady(page);
      last = await readLast(page);
      const fx = ref.fixed_20260911.W30;
      record("B7-fixed-end", last.endDate === "2026-09-11" && last.W === 30, `end=${last.endDate} W=${last.W}`);
      record("B7-ind1-volume", Math.abs(last.vLastW - fx.recent_total) <= 1 && Math.abs(last.vPrevW - fx.prev_total) <= 1, `ui=${last.vLastW}/${last.vPrevW} ref=${fx.recent_total}/${fx.prev_total}`);
      record("B7-ind1-top2", JSON.stringify(last.top2) === JSON.stringify(fx.recent_top2), `ui=${last.top2}`);
      // 日×PJ を整数に丸めた表の合算なので、許容差＝5円（約1.5万セル）
      record("B7-ind2-half", Math.abs(last.h2 - fx.half2_total) <= 5 && Math.abs(last.h1 - fx.half1_total) <= 5, `ui=${last.h2}/${last.h1} ref=${fx.half2_total}/${fx.half1_total}`);
      record("B7-ind3-active", last.nRec === fx.active_recent && last.nPrv === fx.active_prev, `ui=${last.nRec}/${last.nPrv} ref=${fx.active_recent}/${fx.active_prev}`);
      record("B7-weeks-ref", Math.abs(last.recent4 - ref.fixed_20260911.weeks_active_recent4_avg) < 0.01 && Math.abs(last.prev4 - ref.fixed_20260911.weeks_active_prev4_avg) < 0.01, `ui=${last.recent4}/${last.prev4}（レポート v1 の 162.5／163.0）`);
      record("B7-ind4-members", last.mLast === fx.members_recent_net && last.mPrev === fx.members_prev_net, `ui=${last.mLast}/${last.mPrev} ref=${fx.members_recent_net}/${fx.members_prev_net}`);
      record("B7-ind5-price", JSON.stringify(last.priceTop10) === JSON.stringify(fx.price_top10) && last.upCount === fx.price_up_count, `ui=${last.upCount} ${last.priceTop10} ref=${fx.price_up_count}`);
      record("B7-verdict-30", last.count === fx.count && JSON.stringify(last.indicators.map((x) => x.ok)) === JSON.stringify(fx.ok) && last.band === (fx.count >= 4 ? "あり" : fx.count >= 2 ? "兆しあり" : "なし"), `count=${last.count} band=${last.band} ref=${fx.count}`);
      const marks = await page.$$eval("#an-indicators-tbody tr td:last-child", (tds) => tds.map((t) => t.textContent.trim()[0]));
      record("B7-table-marks", JSON.stringify(marks) === JSON.stringify(last.indicators.map((x) => x.ok ? "○" : "×")), JSON.stringify(marks));
      // 自動文3行目は「当てはまった指標」を番号でなく名前で言う（エマ重2）
      const concl3 = await page.evaluate(() => document.querySelectorAll("#an-conclusion li")[2].textContent);
      record("B7-conclusion-labels", concl3.includes("当てはまった指標＝") && !/当てはまった指標＝\d/.test(concl3), concl3.slice(-80));
      // 窓 90日（既定）・180日でも一致し、窓で数字が変わる（仕様メモ：30日 3/5・90日 1/5・180日 0/5）
      await page.click('#an-window-group button[data-window="90"]');
      await waitReady(page);
      last = await readLast(page);
      const f90 = ref.fixed_20260911.W90;
      record("B7-verdict-90", last.W === 90 && last.count === f90.count && JSON.stringify(last.indicators.map((x) => x.ok)) === JSON.stringify(f90.ok) && Math.abs(last.vLastW - f90.recent_total) <= 1, `count=${last.count} ref=${f90.count} vLast=${last.vLastW}/${f90.recent_total}`);
      await page.click('#an-window-group button[data-window="180"]');
      await waitReady(page);
      last = await readLast(page);
      const f180 = ref.fixed_20260911.W180;
      record("B7-verdict-180", last.W === 180 && last.count === f180.count && JSON.stringify(last.indicators.map((x) => x.ok)) === JSON.stringify(f180.ok), `count=${last.count} ref=${f180.count}`);
      record("B7-window-url", (await page.evaluate(() => location.search)).includes("an_w=180"), await page.evaluate(() => location.search));
      await page.click('#an-window-group button[data-window="90"]');
      await waitReady(page);

      // B8 上位30の表＝30行・シェア合計が期間合計以下
      const rows = await page.$$eval("#an-top30-tbody tr[data-folder]", (trs) => trs.map((tr) => ({ f: tr.getAttribute("data-folder"), total: Number(tr.children[2].textContent.replace(/[^0-9]/g, "")), link: tr.querySelector("a") ? tr.querySelector("a").getAttribute("href") : "", ext: tr.querySelector("a.an-ext-link") ? tr.querySelector("a.an-ext-link").getAttribute("href") : "" })));
      record("B8-top30-rows", rows.length === 30 && rows.every((r) => r.link.startsWith("?project=") && r.ext.startsWith("https://financie.jp/users/")), `rows=${rows.length}`);
      record("B8-top30-order", rows.every((r, i) => i === 0 || rows[i - 1].total >= r.total), "降順");

      // B9 入れ替え（開始＞終了）→ 注記が出て集計は入れ替えた範囲
      await page.fill("#an-start-date", "2026-08-31");
      await page.fill("#an-end-date", "2026-08-01");
      await page.click("#an-apply");
      await waitReady(page);
      const swapped = await page.evaluate(() => ({ note: document.getElementById("an-range-note").textContent, s: document.getElementById("an-start-date").value, e: document.getElementById("an-end-date").value }));
      record("B9-swap", swapped.note.includes("入れ替え") && swapped.s === "2026-08-01" && swapped.e === "2026-08-31", JSON.stringify(swapped));

      // B17 開始＝終了（1日）：落ちない・週次は空（注記あり）・他は描ける（断の提案1）
      await page.fill("#an-start-date", "2026-09-10");
      await page.fill("#an-end-date", "2026-09-10");
      await page.click("#an-apply");
      await waitReady(page);
      const oneDay = await page.evaluate(() => ({ weeks: window.FinancieAnalysis._debug.charts.weeklyVol.data.labels.length, note: document.getElementById("an-weekly-note").textContent, kpi: document.getElementById("an-kpi-total").textContent }));
      st = await chartsStatus(page);
      const nonWeekly = st.filter((x) => !x.key.startsWith("weekly"));
      record("B17-oneday-range", oneDay.weeks === 0 && oneDay.note.includes("7日に満たない") && nonWeekly.every((x) => x.ok) && oneDay.kpi !== "-", JSON.stringify(oneDay));

      // B18 データの範囲外（最古日より前〜最新日より後）→ 丸めて全期間と同じ合計（断の提案2）
      await page.fill("#an-start-date", "2022-01-01");
      await page.fill("#an-end-date", "2027-12-31");
      await page.click("#an-apply");
      await waitReady(page);
      last = await readLast(page);
      const clamped = await page.evaluate(() => ({ s: document.getElementById("an-start-date").value, e: document.getElementById("an-end-date").value }));
      record("B18-out-of-data-range", Math.abs(last.vNow - ref.all.total) <= Math.max(1, ref.all.total * 1e-7) && clamped.s === ref.first_day && clamped.e === ref.latest, `ui=${last.vNow} ref=${ref.all.total} ${JSON.stringify(clamped)}`);

      // B19 完了月が3つ未満の期末（データ開始の直後）→ 例外なく判定が出る（断の提案3）
      await page.goto(BASE_ROOT + "&an_p=custom&an_s=2023-12-21&an_e=2024-01-31", { waitUntil: "domcontentloaded" });
      await waitReady(page);
      last = await readLast(page);
      record("B19-early-end-date", Number.isInteger(last.count) && ["なし", "兆しあり", "あり"].includes(last.band) && last.indicators.every((x) => typeof x.ok === "boolean" && !/NaN|undefined/.test(x.actual)), `count=${last.count} band=${last.band} ${JSON.stringify(last.indicators.map((x) => x.actual))}`);
      await page.goto(BASE_ROOT, { waitUntil: "domcontentloaded" });
      await waitReady(page);

      // B10 ダーク（既定）のコントラスト AA
      await page.click('#an-period-group button[data-period="90"]');
      await waitReady(page);
      let cc = await contrastCheck(page, TEXT_SELECTORS);
      record("B10-contrast-dark", cc.every((c) => c.ok), JSON.stringify(cc.filter((c) => !c.ok)) || "all ok");
      const hDark = await fullShot(page, path.join(OUT_DIR, "analysis_1280.png"));
      record("B10-fullpage-shot", hDark > 3000, `page height=${hDark}px（1画面 900px より十分に長い＝全区画が写っている）`);

      // B11 ライトへ切替 → 描き直され、コントラスト AA
      await page.click("#theme-toggle");
      await page.waitForTimeout(500);
      const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
      st = await chartsStatus(page);
      cc = await contrastCheck(page, TEXT_SELECTORS);
      const lineColor = await page.evaluate(() => window.FinancieAnalysis._debug.charts.daily.data.datasets[1].backgroundColor);
      record("B11-light-theme", theme === "light" && st.every((s) => s.ok) && lineColor === "#2a78d6", `theme=${theme} bar=${lineColor}`);
      record("B11-contrast-light", cc.every((c) => c.ok), JSON.stringify(cc.filter((c) => !c.ok)) || "all ok");
      const hLight = await fullShot(page, path.join(OUT_DIR, "analysis_light_1280.png"));
      record("B11-fullpage-shot", hLight > 3000, `page height=${hLight}px`);
      await page.click("#theme-toggle");
      await page.waitForTimeout(300);

      // B12 横はみ出しなし
      const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      record("B12-no-hscroll-1280", ov.sw <= ov.iw + 1, JSON.stringify(ov));

      // B21 スクロールはページ全体で動く（内側スクロール容器が無い・ルク 07:08 の指摘）
      const scroll = await page.evaluate(async () => {
        const mca = document.querySelector(".main-chart-area");
        const dl = document.querySelector(".dashboard-layout");
        window.scrollTo(0, 0);
        window.scrollTo(0, 2500);
        await new Promise((r) => setTimeout(r, 100));
        return { innerOverflow: mca ? getComputedStyle(mca).overflowY : null, dlHeight: dl ? getComputedStyle(dl).height : null, dlScroll: dl ? dl.scrollHeight > dl.clientHeight + 4 && getComputedStyle(dl).overflowY !== "visible" : null, docScrollable: document.documentElement.scrollHeight > window.innerHeight + 100, scrollY: window.scrollY };
      });
      record("B21-page-scroll", scroll.innerOverflow === "visible" && scroll.docScrollable && scroll.scrollY >= 2000, JSON.stringify(scroll));
      await page.evaluate(() => window.scrollTo(0, 0));

      // B22 箱の並び：既定＝縦1列（全体市況・分析とも）→ 押すと横2列 → 再読み込みで記憶
      const cols = () => page.evaluate(() => {
        const g = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).gridTemplateColumns.split(" ").length : null; };
        return { mode: document.documentElement.getAttribute("data-layout"), an: g("#analysis-view .charts-grid"), btn: document.getElementById("layout-toggle").textContent };
      });
      let c = await cols();
      record("B22-layout-default-v", c.mode === "v" && c.an === 1, JSON.stringify(c));
      await page.click("#layout-toggle");
      await page.waitForTimeout(400);
      c = await cols();
      const st2 = await chartsStatus(page);
      record("B22-layout-h", c.mode === "h" && c.an === 2 && st2.every((x) => x.ok), JSON.stringify(c));
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitReady(page);
      c = await cols();
      record("B22-layout-remembered", c.mode === "h" && c.an === 2, JSON.stringify(c));
      // 全体市況タブでも1列／2列が効く
      await page.click('.tab-nav-btn[data-tab="overview-tab"]');
      await page.waitForFunction(() => window.FinancieOverview && window.FinancieOverview._debug.state.initialized, { timeout: 20000 });
      await page.waitForTimeout(500);
      const ovH = await page.evaluate(() => getComputedStyle(document.querySelector("#overview-view .charts-grid")).gridTemplateColumns.split(" ").length);
      await page.click("#layout-toggle");
      await page.waitForTimeout(400);
      const ovV = await page.evaluate(() => getComputedStyle(document.querySelector("#overview-view .charts-grid")).gridTemplateColumns.split(" ").length);
      record("B22-layout-overview", ovH === 2 && ovV === 1, `overview h=${ovH} v=${ovV}`);
      await page.evaluate(() => { try { localStorage.removeItem("ft_layout"); } catch (e) { /* none */ } });
      await page.goto(BASE_ROOT, { waitUntil: "domcontentloaded" });
      await waitReady(page);

      // B13 コンソールエラー 0
      record("B13-console", consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 3)));

      // B14 URL 復元（an_p=all で開き直す）
      await page.goto(BASE_ROOT + "&an_p=all", { waitUntil: "domcontentloaded" });
      await waitReady(page);
      last = await readLast(page);
      record("B14-url-restore", Math.abs(last.vNow - ref.all.total) <= Math.max(1, ref.all.total * 1e-7), `ui=${last.vNow} ref=${ref.all.total}`);
      await context.close();
    }

    // ---------- スマホ 390（最低線） ----------
    {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "ja-JP" });
      await installStubs(context);
      const page = await context.newPage();
      await page.goto(BASE_ROOT, { waitUntil: "domcontentloaded", timeout: 30000 });
      await waitReady(page);
      const st = await chartsStatus(page);
      const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      record("B15-mobile-charts", st.every((s) => s.ok), JSON.stringify(st.filter((s) => !s.ok)) || "all ok");
      record("B15-mobile-no-hscroll", ov.sw <= ov.iw + 1, JSON.stringify(ov));
      const tap = await page.$$eval("#an-period-group button, #an-apply", (bs) => bs.map((b) => Math.round(b.getBoundingClientRect().height)));
      record("B15-mobile-tap", tap.every((h) => h >= 32), JSON.stringify(tap));
      // スマホの表に列名（data-label）が出る（エマ重1）
      const labels = await page.evaluate(() => ({
        top30: [...document.querySelectorAll("#an-top30-tbody tr:first-child td")].map((td) => td.getAttribute("data-label")),
        ind: [...document.querySelectorAll("#an-indicators-tbody tr:first-child td")].map((td) => td.getAttribute("data-label")),
        shown: getComputedStyle(document.querySelector("#an-top30-tbody tr:first-child td:nth-child(3)"), "::before").content
      }));
      record("B15-mobile-data-label", labels.top30.every(Boolean) && labels.ind.every(Boolean) && labels.shown.includes("期間合計"), JSON.stringify(labels));
      // スマホの機運表：#1 のカードでも「判定」が card の中に収まっている（エマ重1）
      const ind1 = await page.evaluate(() => {
        const tr = document.querySelector("#an-indicators-tbody tr");
        const td = tr.querySelector("td.verdict");
        const a = tr.getBoundingClientRect(), b = td.getBoundingClientRect();
        return { inside: b.right <= a.right + 1 && b.bottom <= a.bottom + 1 && b.width > 0, text: td.textContent.trim() };
      });
      record("B15-mobile-indicator1-verdict", ind1.inside && /^[○×]/.test(ind1.text), JSON.stringify(ind1));
      // 定義セルが tr の内側（min-width:220px がスマホで解除されている・エマ3回目②）
      const defCell = await page.evaluate(() => {
        const tr = document.querySelector("#an-indicators-tbody tr"); const td = tr.querySelector("td.def");
        const a = tr.getBoundingClientRect(), b = td.getBoundingClientRect();
        return { inside: b.right <= a.right + 1 && b.left >= a.left - 1, minWidth: getComputedStyle(td).minWidth, w: Math.round(b.width) };
      });
      record("B15-mobile-def-cell", defCell.inside && defCell.minWidth === "0px", JSON.stringify(defCell));
      await fullShot(page, path.join(OUT_DIR, "analysis_390.png"));
      await context.close();
    }

    // ---------- /financie/ サブパス ----------
    {
      const failed = [];
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await installStubs(context);
      const page = await context.newPage();
      page.on("response", (res) => { const u = res.url(); if (u.includes("/financie/data/") && res.status() !== 200) failed.push(`${res.status()} ${u}`); });
      await page.goto(BASE_SUB, { waitUntil: "domcontentloaded", timeout: 30000 });
      await waitReady(page);
      const loaded = await page.evaluate(() => performance.getEntriesByType("resource").filter((e) => e.name.includes("/data/analysis/")).length);
      record("B16-subpath", failed.length === 0 && loaded >= 5, `failed=${JSON.stringify(failed)} analysisFiles=${loaded}`);
      await context.close();
    }
  } finally {
    await browser.close();
    server.kill();
  }

  const allOk = results.every((r) => r.ok);
  fs.writeFileSync(path.join(OUT_DIR, "check_analysis.json"), JSON.stringify({ allOk, results, at: new Date().toISOString() }, null, 2));
  console.log(allOk ? "\nALL PASS" : "\nSOME FAILED");
  process.exit(allOk ? 0 : 1);
}

run().catch((err) => { console.error(err); process.exit(1); });
