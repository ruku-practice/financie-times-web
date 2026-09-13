/**
 * 日付別ランキングの並べ替えの受け入れ検査（2026-09-13・ルク 08:36「出来高順に並ばない・過去の日も全部おかしい」）
 *
 * 原因：js/advanced.js が並べ替え釦を document.querySelectorAll(".sort-tab-btn") で拾っていた。
 *       全体市況 v3.0.0 から期間・粒度・上位・指標の釦（16個）も同じクラスを持つため、
 *       全体市況で釦を押すと travelSort が null になり（data-sort が無い）、並びがメンバー増加数順に落ちていた。
 *       さらに押した釦以外の active を全部外していた（並べ替え釦の選択表示も消える）。
 *
 * 検査：
 *   D1 全体市況の釦を押しても travelSort は "volume" のまま・並べ替え釦の選択表示も残る
 *   D2 その後に日付別ランキングを開く＝出来高の降順（最新日）
 *   D3 並べ替え釦を押しても全体市況の釦の選択表示は消えない
 *   D4 メンバー増加数順→全体市況で釦を押す→戻っても増加数順のまま
 *   D5 data/daily の全日付で、実際の並べ替え釦を押して描いた表の順が出来高の降順／増加数の降順
 *   D6 コンソールエラー0
 *
 * 配信サーバーはこのスクリプトが自分で立てて止める（127.0.0.1:8995）。
 * 実行: node tests/check_daily_sort.js   出力: tests/out/check_daily_sort.json
 */

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { chromium } = require("/private/tmp/claude-501/-Users-kkr-ruku-data/e38f9b75-e4a5-4a31-89ba-3262c9b8e651/scratchpad/pw/node_modules/playwright-core");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(__dirname, "out");
const SERVE_DIR = path.join(OUT_DIR, "serve_daily");
const PORT = 8995;
const BASE = `http://127.0.0.1:${PORT}/root/index.html`;

const results = [];
function record(id, ok, detail) {
  results.push({ id, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${detail}`);
}

function setupServeDir() {
  fs.mkdirSync(SERVE_DIR, { recursive: true });
  const p = path.join(SERVE_DIR, "root");
  try { fs.unlinkSync(p); } catch (e) { /* none */ }
  fs.symlinkSync(ROOT, p, "dir");
}

async function waitServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/root/data/history_meta.json`, { method: "HEAD" });
      if (r.ok) return;
    } catch (e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start");
}

// 表の行を data-folder の順で読む（日付別ランキングの tbody）
const readOrder = (page) => page.evaluate(() => Array.from(document.querySelectorAll("#historic-ranking-tbody a.table-pj-link")).map((a) => a.getAttribute("data-folder")));

// 値の並びが降順か（数値でないものは -Infinity 扱い）。崩れた最初の位置を返す
function firstBreak(values) {
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : -Infinity);
  for (let i = 0; i + 1 < values.length; i++) if (num(values[i]) < num(values[i + 1])) return i;
  return -1;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  setupServeDir();
  const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: SERVE_DIR, stdio: "ignore" });
  let browser;
  try {
    await waitServer();
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route("**/financie.jp/**", (route) => route.fulfill({ status: 404, body: "" }));
    await context.route("**/image-financie.storage.googleapis.com/**", (route) => route.fulfill({ status: 404, body: "" }));
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));

    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.FinancieOverview && window.FinancieOverview._debug.state.initialized, { timeout: 30000 });

    // D1 全体市況の釦を一通り押す（利用者が既定のタブで最初に触る操作）
    for (const sel of ['#ov-period-group button[data-period="30"]', '#ov-granularity-group button[data-granularity="week"]', '#ov-topn-group button[data-topn="20"]', '#ov-metric-group button[data-metric="price"]', '#ov-period-group button[data-period="90"]']) {
      await page.click(sel);
      await page.waitForTimeout(150);
    }
    const d1 = await page.evaluate(() => ({
      travelSort: typeof travelSort !== "undefined" ? travelSort : "(未定義)",
      volumeActive: document.querySelector('.sort-tab-btn[data-sort="volume"]').classList.contains("active"),
      membersActive: document.querySelector('.sort-tab-btn[data-sort="members"]').classList.contains("active")
    }));
    record("D1-overview-buttons-keep-daily-sort", d1.travelSort === "volume" && d1.volumeActive && !d1.membersActive, JSON.stringify(d1));

    // D2 日付別ランキングを開く＝最新日が出来高の降順
    await page.click('.tab-nav-btn[data-tab="daily-tab"]');
    await page.waitForFunction(() => document.querySelectorAll("#historic-ranking-tbody a.table-pj-link").length > 0, { timeout: 30000 });
    const d2 = await page.evaluate(() => {
      const byFolder = {};
      dailyData.forEach((r) => { byFolder[r.folder] = r; });
      const order = Array.from(document.querySelectorAll("#historic-ranking-tbody a.table-pj-link")).map((a) => a.getAttribute("data-folder"));
      return { date: document.getElementById("travel-date-picker").value, rows: order.length, vols: order.map((f) => byFolder[f] ? byFolder[f].volume_24h : null), expectTop: dailyData.map((r) => r.volume_24h).sort((a, b) => b - a).slice(0, 5) };
    });
    const d2Break = firstBreak(d2.vols);
    record("D2-daily-latest-sorted-by-volume", d2.rows === 20 && d2Break === -1 && d2.vols[0] === d2.expectTop[0], `date=${d2.date} rows=${d2.rows} head=${JSON.stringify(d2.vols.slice(0, 5))} expectTop=${JSON.stringify(d2.expectTop)} break=${d2Break}`);

    // D3 並べ替え釦を押しても全体市況の釦の選択表示は消えない
    await page.click('.sort-tab-btn[data-sort="members"]');
    await page.waitForTimeout(150);
    const d3 = await page.evaluate(() => ({
      travelSort,
      membersActive: document.querySelector('.sort-tab-btn[data-sort="members"]').classList.contains("active"),
      volumeActive: document.querySelector('.sort-tab-btn[data-sort="volume"]').classList.contains("active"),
      ovPeriodActive: document.querySelector('#ov-period-group button[data-period="90"]').classList.contains("active"),
      ovGranActive: document.querySelector('#ov-granularity-group button.active') !== null,
      ovTopnActive: document.querySelector('#ov-topn-group button[data-topn="20"]').classList.contains("active"),
      ovMetricActive: document.querySelector('#ov-metric-group button[data-metric="price"]').classList.contains("active")
    }));
    record("D3-daily-sort-keeps-overview-active", d3.travelSort === "members" && d3.membersActive && !d3.volumeActive && d3.ovPeriodActive && d3.ovGranActive && d3.ovTopnActive && d3.ovMetricActive, JSON.stringify(d3));

    // D4 増加数順→全体市況で釦を押す→戻っても増加数順
    await page.click('.tab-nav-btn[data-tab="overview-tab"]');
    await page.waitForTimeout(200);
    await page.click('#ov-period-group button[data-period="365"]');
    await page.waitForTimeout(200);
    await page.click('.tab-nav-btn[data-tab="daily-tab"]');
    await page.waitForTimeout(300);
    const d4 = await page.evaluate(() => {
      const byFolder = {};
      dailyData.forEach((r) => { byFolder[r.folder] = r; });
      const order = Array.from(document.querySelectorAll("#historic-ranking-tbody a.table-pj-link")).map((a) => a.getAttribute("data-folder"));
      return { travelSort, membersActive: document.querySelector('.sort-tab-btn[data-sort="members"]').classList.contains("active"), diffs: order.map((f) => byFolder[f] ? byFolder[f].members_diff : null) };
    });
    record("D4-members-sort-survives-overview-clicks", d4.travelSort === "members" && d4.membersActive && firstBreak(d4.diffs) === -1, `travelSort=${d4.travelSort} active=${d4.membersActive} head=${JSON.stringify(d4.diffs.slice(0, 6))}`);

    // D5 全日付：実際の並べ替え釦を押して描いた表（全件）の順を確かめる
    const dates = fs.readdirSync(path.join(ROOT, "data", "daily")).filter((f) => /^\d{8}\.json$/.test(f)).map((f) => f.slice(0, 8)).sort();
    const sweep = { dates: dates.length, volumeBad: [], membersBad: [], countBad: [], loadBad: [] };
    const CHUNK = 60;
    for (let c = 0; c < dates.length; c += CHUNK) {
      const part = dates.slice(c, c + CHUNK);
      const res = await page.evaluate(async (list) => {
        const out = [];
        const num = (v) => (typeof v === "number" && isFinite(v) ? v : -Infinity);
        const broken = (vals) => { for (let i = 0; i + 1 < vals.length; i++) if (num(vals[i]) < num(vals[i + 1])) return i; return -1; };
        for (const d of list) {
          let data;
          try {
            const r = await fetch(`data/daily/${d}.json`);
            if (!r.ok) { out.push({ d, load: r.status }); continue; }
            data = await r.json();
          } catch (e) { out.push({ d, load: String(e) }); continue; }
          // ロゴは中身を問わないので埋め込みの1px画像に差し替える（384行×990日の画像通信で検査が止まらないように）
          // 🔴壊れた画像だと onerror→本家のロゴ→404→onerror… と通信が回り続けて1日あたり数秒かかる＝正しい1pxのGIFにする
          data.forEach((row) => { row.logo = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"; });
          dailyData = data;
          showAllDaily = true;
          const byFolder = {};
          data.forEach((row) => { byFolder[row.folder] = row; });
          const readVals = (key) => Array.from(document.querySelectorAll("#historic-ranking-tbody a.table-pj-link")).map((a) => { const row = byFolder[a.getAttribute("data-folder")]; return row ? row[key] : null; });
          document.querySelector('.sort-tab-btn[data-sort="volume"]').click();
          const vols = readVals("volume_24h");
          const vb = broken(vols);
          document.querySelector('.sort-tab-btn[data-sort="members"]').click();
          const mems = readVals("members_diff");
          const mb = broken(mems);
          out.push({ d, n: data.length, rows: vols.length, vb, mb, vAt: vb >= 0 ? [vols[vb], vols[vb + 1]] : null, mAt: mb >= 0 ? [mems[mb], mems[mb + 1]] : null });
        }
        return out;
      }, part);
      res.forEach((x) => {
        if (x.load !== undefined) { sweep.loadBad.push(`${x.d}:${x.load}`); return; }
        if (x.rows !== x.n) sweep.countBad.push(`${x.d}:${x.rows}/${x.n}`);
        if (x.vb >= 0) sweep.volumeBad.push(`${x.d}@${x.vb}:${JSON.stringify(x.vAt)}`);
        if (x.mb >= 0) sweep.membersBad.push(`${x.d}@${x.mb}:${JSON.stringify(x.mAt)}`);
      });
      console.log(`  D5 ${Math.min(c + CHUNK, dates.length)}/${dates.length} 日 volumeBad=${sweep.volumeBad.length} membersBad=${sweep.membersBad.length}`);
    }
    record("D5a-all-dates-volume-desc", sweep.volumeBad.length === 0 && sweep.loadBad.length === 0, `dates=${sweep.dates} bad=${sweep.volumeBad.length} load=${sweep.loadBad.length} ${sweep.volumeBad.slice(0, 3).join(" ")} ${sweep.loadBad.slice(0, 3).join(" ")}`);
    record("D5b-all-dates-members-desc", sweep.membersBad.length === 0, `dates=${sweep.dates} bad=${sweep.membersBad.length} ${sweep.membersBad.slice(0, 3).join(" ")}`);
    record("D5c-all-rows-rendered", sweep.countBad.length === 0, `bad=${sweep.countBad.length} ${sweep.countBad.slice(0, 3).join(" ")}`);

    // D6 コンソールエラー0
    record("D6-no-console-errors", consoleErrors.length === 0, `errors=${consoleErrors.length} ${consoleErrors.slice(0, 2).join(" | ")}`);
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
  const allOk = results.length > 0 && results.every((r) => r.ok);
  fs.writeFileSync(path.join(OUT_DIR, "check_daily_sort.json"), JSON.stringify({ allOk, results, at: new Date().toISOString() }, null, 2));
  console.log(allOk ? `\nALL PASS (${results.length})` : `\nSOME FAILED (${results.filter((r) => !r.ok).length}/${results.length})`);
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
