/**
 * 日付別ランキングの並べ替えと表記の受け入れ検査
 *
 * 2026-09-13 08:36（v3.1.1）ルク「出来高順に並ばない・過去の日も全部おかしい」
 *   原因：js/advanced.js が並べ替え釦を document.querySelectorAll(".sort-tab-btn") で拾っていた。
 *         全体市況 v3.0.0 から期間・粒度・上位・指標の釦（16個）も同じクラスを持つため、
 *         全体市況で釦を押すと travelSort が null になり（data-sort が無い）、並びがメンバー増加数順に落ちていた。
 * 2026-09-13 13:27（v3.2.4）ルク「▲はマイナスに見える＝上昇は +・下落は ▲」「％は前日比・差は前日差」
 *   「価格の上昇率（前日比）順・上昇額（前日差）順を足す」→ 価格の2つは足切り（24H出来高1,000円以上・前日価格が分かる）
 *
 * 検査：
 *   D1 全体市況の釦を押しても travelSort は "volume" のまま・並べ替え釦の選択表示も残る
 *   D2 その後に日付別ランキングを開く＝出来高の降順（最新日）
 *   D3 並べ替え釦を押しても全体市況の釦の選択表示は消えない
 *   D4 メンバー増加数順→全体市況で釦を押す→戻っても増加数順のまま
 *   D5 data/daily の全日付で、実際の並べ替え釦（4種）を押して描いた表の順が降順・価格の2つは足切りを通った PJ だけ（件数も一致）
 *      ＋同じ全日付で、増減のセルの記号が元データの符号と一致（+／▲／±0／-）・▼ を使っていない・色のクラスも一致
 *   D6 コンソールエラー0
 *   D7 見出しと各セルの語：％の列だけ「前日比」、差の列は「前日差」（PC の見出し・スマホのカードの data-label）
 *   D8 釦4つの aria-pressed・並べ替え中の列の見出しの印（↓）・足切りの注記は価格の2つのときだけ出て件数が合う
 *   D9 スマホ 390：カードの見出し（::before）が語どおり・横にはみ出さない・注記が見える
 *   D10 データの無い日を開いたあとに並べ替えを押しても、前に開いていた日の行を出さない
 *
 * 期待値は画面のコード（js/advanced.js の DAILY_SORTS）を使わず、この検査の中で元データから計算する。
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

// 列の語（index.html の見出しの並び）＝期待値
const EXPECT_HEAD = ["順位", "プロジェクト", "24H 出来高［千円］", "前日差", "前日価格［円］", "前日比", "現在価格［円］", "前日差", "メンバー数［人］", "前日差", "トークン在庫［個］", "前日差"];
const SORT_KEYS = ["volume", "members", "price_rate", "price_diff"];
const SORT_COL = { volume: "volume", members: "members", price_rate: "price_rate", price_diff: "price_diff" };

const results = [];
function record(id, ok, detail) {
  results.push({ id, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
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

// 値の並びが降順か（数値でないものは -Infinity 扱い）。崩れた最初の位置を返す
function firstBreak(values) {
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : -Infinity);
  for (let i = 0; i + 1 < values.length; i++) if (num(values[i]) < num(values[i + 1])) return i;
  return -1;
}

async function blockLogos(context) {
  await context.route("**/financie.jp/**", (route) => route.fulfill({ status: 404, body: "" }));
  await context.route("**/image-financie.storage.googleapis.com/**", (route) => route.fulfill({ status: 404, body: "" }));
}

async function openDaily(page) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.FinancieOverview && window.FinancieOverview._debug.state.initialized, { timeout: 30000 });
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
    await blockLogos(context);
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));

    await openDaily(page);

    // D1 全体市況の釦を一通り押す（利用者が既定のタブで最初に触る操作）
    for (const sel of ['#ov-period-group button[data-period="30"]', '#ov-granularity-group button[data-granularity="week"]', '#ov-topn-group button[data-topn="20"]', '#ov-metric-group button[data-metric="price"]', '#ov-period-group button[data-period="90"]']) {
      await page.click(sel);
      await page.waitForTimeout(150);
    }
    const d1 = await page.evaluate(() => ({
      travelSort: typeof travelSort !== "undefined" ? travelSort : "(未定義)",
      volumeActive: document.querySelector('.sort-tab-btn[data-sort="volume"]').classList.contains("active"),
      othersActive: Array.from(document.querySelectorAll('.sort-criteria-group .sort-tab-btn[data-sort]:not([data-sort="volume"])')).some((b) => b.classList.contains("active"))
    }));
    record("D1-overview-buttons-keep-daily-sort", d1.travelSort === "volume" && d1.volumeActive && !d1.othersActive, d1);

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

    // D7 見出しの語（PC）
    const head = await page.evaluate(() => Array.from(document.querySelectorAll("#daily-travel-view thead th")).map((th) => th.textContent.trim()));
    record("D7a-thead-words", JSON.stringify(head) === JSON.stringify(EXPECT_HEAD), { head });

    // D8 釦4つ・見出しの印・注記（最新日）
    const d8 = [];
    for (const key of SORT_KEYS) {
      await page.click(`.sort-criteria-group .sort-tab-btn[data-sort="${key}"]`);
      await page.waitForTimeout(100);
      d8.push(await page.evaluate(({ key }) => {
        const rankable = (r) => typeof r.volume_24h === "number" && r.volume_24h >= 1000 && typeof r.price === "number" && isFinite(r.price) && typeof r.price_diff === "number" && isFinite(r.price_diff) && (r.price - r.price_diff) > 0;
        const note = document.getElementById("daily-sort-note");
        const pressed = Array.from(document.querySelectorAll(".sort-criteria-group .sort-tab-btn[data-sort]")).map((b) => `${b.getAttribute("data-sort")}:${b.getAttribute("aria-pressed")}:${b.classList.contains("active")}`);
        const marked = Array.from(document.querySelectorAll("#daily-travel-view th[aria-sort]")).map((th) => ({ col: th.getAttribute("data-sort-col"), after: getComputedStyle(th, "::after").content, text: th.textContent.trim() }));
        return {
          key, pressed, marked,
          noteHidden: note.hidden, noteVisible: note.getBoundingClientRect().height > 0, noteText: note.textContent,
          expectRankable: dailyData.filter(rankable).length, total: dailyData.length
        };
      }, { key }));
    }
    const d8ok = d8.every((x) => {
      const pressedOk = x.pressed.every((p) => { const [k, ap, act] = p.split(":"); return (k === x.key) === (ap === "true") && (k === x.key) === (act === "true"); }) && x.pressed.length === 4;
      const markOk = x.marked.length === 1 && x.marked[0].col === SORT_COL[x.key] && /↓/.test(x.marked[0].after) && !/[▲▼]/.test(x.marked[0].after);
      const isPrice = x.key === "price_rate" || x.key === "price_diff";
      const noteOk = isPrice
        ? (!x.noteHidden && x.noteVisible && x.noteText.includes(`この日 ${x.expectRankable}件／全${x.total}件`) && x.noteText.includes("1,000円以上"))
        : (x.noteHidden && !x.noteVisible);
      return pressedOk && markOk && noteOk;
    });
    record("D8-buttons-mark-note", d8ok, d8.map((x) => ({ key: x.key, marked: x.marked, noteHidden: x.noteHidden, note: x.noteText.slice(-24), expect: `${x.expectRankable}/${x.total}` })));
    await page.click('.sort-criteria-group .sort-tab-btn[data-sort="volume"]');

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

    // D5 全日付：実際の並べ替え釦（4種）を押して描いた表（全件）の順・足切り・記号を確かめる
    const dates = fs.readdirSync(path.join(ROOT, "data", "daily")).filter((f) => /^\d{8}\.json$/.test(f)).map((f) => f.slice(0, 8)).sort();
    const sweep = { dates: dates.length, sortBad: { volume: [], members: [], price_rate: [], price_diff: [] }, rankBad: [], countBad: [], loadBad: [], markBad: [], wordBad: [], cells: 0, marks: { plus: 0, minus: 0, zero: 0, dash: 0, under: 0 }, priceRows: 0 };
    const CHUNK = 60;
    for (let c = 0; c < dates.length; c += CHUNK) {
      const part = dates.slice(c, c + CHUNK);
      const res = await page.evaluate(async ({ list, expectHead }) => {
        const out = [];
        const num = (v) => (typeof v === "number" && isFinite(v) ? v : -Infinity);
        const fin = (v) => typeof v === "number" && isFinite(v);
        const broken = (vals) => { for (let i = 0; i + 1 < vals.length; i++) if (num(vals[i]) < num(vals[i + 1])) return i; return -1; };
        // 期待値（画面のコードを使わず、元データから計算）
        const rate = (r) => (fin(r.price) && fin(r.price_diff) && (r.price - r.price_diff) > 0 ? (r.price_diff / (r.price - r.price_diff)) * 100 : null);
        const rankable = (r) => typeof r.volume_24h === "number" && r.volume_24h >= 1000 && rate(r) !== null;
        const value = { volume: (r) => r.volume_24h, members: (r) => r.members_diff, price_rate: rate, price_diff: (r) => r.price_diff };
        const raws = (r) => [fin(r.volume_24h_diff) ? r.volume_24h_diff : null, rate(r), fin(r.price_diff) ? r.price_diff : null, fin(r.members_diff) ? r.members_diff : null, fin(r.stock_diff) ? r.stock_diff : null];
        const CELL_RE = /^[+▲][\d,.]+%?(未満)?$|^±0%?$|^-$/;
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
          const rowsNow = () => Array.from(document.querySelectorAll("#historic-ranking-tbody tr")).filter((tr) => tr.querySelector("a.table-pj-link"));
          const rec = { d, n: data.length, sort: {}, rankBad: 0, markBad: [], wordBad: [], cells: 0, marks: { plus: 0, minus: 0, zero: 0, dash: 0, under: 0 } };
          for (const key of ["volume", "members", "price_rate", "price_diff"]) {
            document.querySelector(`.sort-criteria-group .sort-tab-btn[data-sort="${key}"]`).click();
            const rows = rowsNow().map((tr) => byFolder[tr.querySelector("a.table-pj-link").getAttribute("data-folder")]);
            const vals = rows.map((row) => (row ? value[key](row) : null));
            const isPrice = key === "price_rate" || key === "price_diff";
            const expectN = isPrice ? data.filter(rankable).length : data.length;
            const b = broken(vals);
            if (isPrice) rec.rankBad += rows.filter((row) => !row || !rankable(row)).length;
            rec.sort[key] = { rows: rows.length, expectN, b, at: b >= 0 ? [vals[b], vals[b + 1]] : null };
            if (key === "volume") {
              // 記号と語：全行・増減の5列（4・6・8・10・12列目）
              rowsNow().forEach((tr, i) => {
                const row = byFolder[tr.querySelector("a.table-pj-link").getAttribute("data-folder")];
                const tds = tr.querySelectorAll("td");
                if (i === 0) {
                  const labels = Array.from(tds).map((td) => td.getAttribute("data-label"));
                  if (JSON.stringify(labels) !== JSON.stringify(expectHead)) rec.wordBad.push(JSON.stringify(labels));
                }
                const rv = raws(row);
                [3, 5, 7, 9, 11].forEach((ci, k) => {
                  const td = tds[ci];
                  const t = td.textContent.trim();
                  const raw = rv[k];
                  const pct = ci === 5;
                  rec.cells++;
                  let ok = CELL_RE.test(t) && !/▼/.test(t) && (pct ? (t === "-" || /%/.test(t)) : !/%/.test(t));
                  if (raw === null) { ok = ok && t === "-" && td.classList.contains("diff-flat"); rec.marks.dash++; }
                  else if (raw === 0) { ok = ok && /^±0%?$/.test(t) && td.classList.contains("diff-flat"); rec.marks.zero++; }
                  else if (raw > 0) { ok = ok && t.startsWith("+") && td.classList.contains("diff-up"); rec.marks.plus++; }
                  else { ok = ok && t.startsWith("▲") && td.classList.contains("diff-down"); rec.marks.minus++; }
                  if (/未満$/.test(t)) rec.marks.under++;
                  if (!ok && rec.markBad.length < 3) rec.markBad.push(`${row.folder} col${ci + 1} raw=${raw} text=${t} class=${td.className}`);
                });
              });
            }
          }
          out.push(rec);
        }
        return out;
      }, { list: part, expectHead: EXPECT_HEAD });
      res.forEach((x) => {
        if (x.load !== undefined) { sweep.loadBad.push(`${x.d}:${x.load}`); return; }
        Object.entries(x.sort).forEach(([key, s]) => {
          if (s.rows !== s.expectN) sweep.countBad.push(`${x.d}/${key}:${s.rows}/${s.expectN}`);
          if (s.b >= 0) sweep.sortBad[key].push(`${x.d}@${s.b}:${JSON.stringify(s.at)}`);
          if (key === "price_rate") sweep.priceRows += s.rows;
        });
        if (x.rankBad) sweep.rankBad.push(`${x.d}:${x.rankBad}`);
        x.markBad.forEach((m) => sweep.markBad.push(`${x.d} ${m}`));
        x.wordBad.forEach((m) => sweep.wordBad.push(`${x.d} ${m}`));
        sweep.cells += x.cells;
        Object.keys(sweep.marks).forEach((k) => { sweep.marks[k] += x.marks[k]; });
      });
      console.log(`  D5 ${Math.min(c + CHUNK, dates.length)}/${dates.length} 日 sortBad=${Object.values(sweep.sortBad).map((a) => a.length).join("/")} count=${sweep.countBad.length} rank=${sweep.rankBad.length} mark=${sweep.markBad.length}`);
    }
    record("D5a-all-dates-volume-desc", sweep.sortBad.volume.length === 0 && sweep.loadBad.length === 0, `dates=${sweep.dates} bad=${sweep.sortBad.volume.length} load=${sweep.loadBad.length} ${sweep.sortBad.volume.slice(0, 3).join(" ")} ${sweep.loadBad.slice(0, 3).join(" ")}`);
    record("D5b-all-dates-members-desc", sweep.sortBad.members.length === 0, `dates=${sweep.dates} bad=${sweep.sortBad.members.length} ${sweep.sortBad.members.slice(0, 3).join(" ")}`);
    record("D5c-all-rows-rendered", sweep.countBad.length === 0, `bad=${sweep.countBad.length} ${sweep.countBad.slice(0, 3).join(" ")}`);
    record("D5d-all-dates-price-rate-desc", sweep.sortBad.price_rate.length === 0 && sweep.priceRows > 0, `dates=${sweep.dates} bad=${sweep.sortBad.price_rate.length} rankedRows=${sweep.priceRows} ${sweep.sortBad.price_rate.slice(0, 3).join(" ")}`);
    record("D5e-all-dates-price-diff-desc", sweep.sortBad.price_diff.length === 0, `dates=${sweep.dates} bad=${sweep.sortBad.price_diff.length} ${sweep.sortBad.price_diff.slice(0, 3).join(" ")}`);
    record("D5f-price-sorts-only-rankable", sweep.rankBad.length === 0, `bad=${sweep.rankBad.length} ${sweep.rankBad.slice(0, 3).join(" ")}`);
    record("D5g-all-cells-sign-matches-data", sweep.markBad.length === 0 && sweep.marks.plus > 0 && sweep.marks.minus > 0 && sweep.marks.zero > 0, `cells=${sweep.cells} marks=${JSON.stringify(sweep.marks)} bad=${sweep.markBad.length} ${sweep.markBad.slice(0, 3).join(" | ")}`);
    record("D7b-all-dates-cell-labels", sweep.wordBad.length === 0, `bad=${sweep.wordBad.length} ${sweep.wordBad.slice(0, 1).join(" ")}`);

    // D6 コンソールエラー0
    record("D6-no-console-errors", consoleErrors.length === 0, `errors=${consoleErrors.length} ${consoleErrors.slice(0, 2).join(" | ")}`);
    await context.close();

    // D9 スマホ 390：カードの見出し・はみ出し・注記
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await blockLogos(mctx);
    const mp = await mctx.newPage();
    await openDaily(mp);
    await mp.click('.tab-nav-btn[data-tab="daily-tab"]');
    await mp.waitForFunction(() => document.querySelectorAll("#historic-ranking-tbody a.table-pj-link").length > 0, { timeout: 30000 });
    await mp.click('.sort-criteria-group .sort-tab-btn[data-sort="price_rate"]');
    await mp.waitForTimeout(200);
    const d9 = await mp.evaluate(() => {
      const tr = document.querySelector("#historic-ranking-tbody tr");
      const before = Array.from(tr.querySelectorAll("td")).map((td) => getComputedStyle(td, "::before").content.replace(/^"|"$/g, ""));
      const note = document.getElementById("daily-sort-note");
      const btns = Array.from(document.querySelectorAll(".sort-criteria-group .sort-tab-btn[data-sort]")).map((b) => { const r = b.getBoundingClientRect(); return { h: Math.round(r.height), right: Math.round(r.right) }; });
      return { before, scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, noteH: note.getBoundingClientRect().height, noteText: note.textContent.slice(0, 20), btns };
    });
    // 価格の上昇率順＝6列目（前日比）の項目名だけに「↓」が付く（エマ v3.2.4 軽4・再確認 新中1 で「↓ 並べ替え中」→「↓」）
    const expectBefore = EXPECT_HEAD.map((h, i) => (i === 5 ? `${h} ↓` : h));
    // 計算値は「"前日比" " ↓ 並べ替え中"」のように文字列が2つ並ぶことがある＝つなぎ目の「" "」を外してから比べる
    const beforeText = d9.before.map((c) => c.replace(/"\s*"/g, ""));
    record("D9-mobile-card-labels-and-fit", JSON.stringify(beforeText) === JSON.stringify(expectBefore) && d9.scrollW <= d9.innerW && d9.noteH > 0 && d9.btns.every((b) => b.h >= 44 && b.right <= d9.innerW), { ...d9, expectBefore, beforeText });

    // D9b 390：いちばん長い項目名（24H 出来高［千円］）で並べ替えても、印つきの項目名が2行に割れない
    //   カードは2列＝同じ行の隣のセル（前日差）と高さがそろう（エマ再確認 新中1「↓並べ替｜え中」）
    await mp.click('.sort-criteria-group .sort-tab-btn[data-sort="volume"]');
    await mp.waitForTimeout(200);
    const d9b = await mp.evaluate(() => Array.from(document.querySelectorAll("#historic-ranking-tbody tr")).slice(0, 20).map((tr) => {
      const tds = tr.querySelectorAll("td");
      return { sorted: tds[2].hasAttribute("data-sorted"), h: Math.round(tds[2].getBoundingClientRect().height), hNext: Math.round(tds[3].getBoundingClientRect().height) };
    }));
    record("D9b-mobile-sorted-label-one-line", d9b.length === 20 && d9b.every((c) => c.sorted && Math.abs(c.h - c.hNext) <= 1), { rows: d9b.length, bad: d9b.filter((c) => !c.sorted || Math.abs(c.h - c.hNext) > 1).slice(0, 3) });
    await mctx.close();

    // D10 データの無い日を開いたあとに並べ替えを押しても、前の日の行を出さない
    const fctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await blockLogos(fctx);
    const fp = await fctx.newPage();
    await openDaily(fp);
    await fp.click('.tab-nav-btn[data-tab="daily-tab"]');
    await fp.waitForFunction(() => document.querySelectorAll("#historic-ranking-tbody a.table-pj-link").length > 0, { timeout: 30000 });
    await fp.evaluate(() => { const el = document.getElementById("travel-date-picker"); el.value = "2023-01-01"; el.dispatchEvent(new Event("change", { bubbles: true })); });
    await fp.waitForFunction(() => /見つかりません/.test(document.getElementById("historic-ranking-tbody").textContent), { timeout: 15000 });
    await fp.click('.sort-criteria-group .sort-tab-btn[data-sort="price_rate"]');
    await fp.waitForTimeout(200);
    const d10 = await fp.evaluate(() => ({ rows: document.querySelectorAll("#historic-ranking-tbody a.table-pj-link").length, text: document.getElementById("historic-ranking-tbody").textContent.trim().slice(0, 30), noteHidden: document.getElementById("daily-sort-note").hidden, more: getComputedStyle(document.getElementById("btn-load-more-daily")).display }));
    record("D10-failed-day-no-stale-rows", d10.rows === 0 && d10.noteHidden && d10.more === "none", d10);
    await fctx.close();
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
