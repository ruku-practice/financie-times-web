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
    // 日付欄は「確定（フォーカスが外れる・Enter）」で反映する（重4対応）＝blur を送る
    await page.dispatchEvent("#ov-end-date", "blur");
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
        const expected = r.current > 0 ? "新規" : "比較なし";
        if (cellText !== expected) diffMismatches.push(`${r.folder}: got=${cellText} expect=${expected}`);
        return;
      }
      if (r.pct >= 1000 && cellText === "▲10倍超") return; // +1000%以上は「▲10倍超」に丸める仕様
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
    await page.dispatchEvent("#ov-end-date", "blur");
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

    // ---------- エマの突き返し対応（2026-09-12 夜）の受け入れ検査 ----------
    // A25: 単位＝円（ルク決定7）：表の見出し・KPIの見出しに「円」、総覧に pt の表記が無い
    const unitScan = await page.evaluate(() => {
      const el = document.getElementById("overview-view");
      return {
        head: document.getElementById("ov-ranking-thead").textContent,
        kpi: document.getElementById("ov-kpi-total-label").textContent,
        hasPt: /\bpt\b/.test(el.innerText)
      };
    });
    record("A25-unit-yen", unitScan.head.includes("円") && unitScan.kpi.includes("円") && !unitScan.hasPt, JSON.stringify(unitScan));

    // A26: 「その他」行にシェアが出て、上位10のシェア＋その他≈100%（中5）・件数の書き方は「上位10以外のN件」（ルク決定8＝全件）
    const shares = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#ov-ranking-tbody tr")];
      const others = rows.find((r) => r.classList.contains("ov-others-row"));
      const top = rows.filter((r) => r.hasAttribute("data-folder")).map((r) => parseFloat(r.children[4].textContent));
      const total = window.FinancieOverview._debug.data.volume.projects.length;
      return {
        others: others ? others.children[4].textContent.trim() : null,
        othersLabel: others ? others.children[1].textContent.trim() : null,
        topSum: top.reduce((a, b) => a + b, 0),
        expectCount: total - 10
      };
    });
    const othersPct = parseFloat(shares.others);
    record(
      "A26-others-share-and-count",
      !isNaN(othersPct) && Math.abs(shares.topSum + othersPct - 100) <= 0.6 && shares.othersLabel === `その他（上位10以外の${shares.expectCount}件）`,
      JSON.stringify(shares)
    );

    // A27: 「上位N」の N が実際の数（中1）
    await page.click('#ov-topn-group button[data-topn="20"]');
    await page.waitForTimeout(300);
    const nLabels = await page.evaluate(() => ({
      kpi: document.getElementById("ov-kpi-share-label").textContent,
      d: document.getElementById("ov-panelD-title").textContent,
      desc: document.getElementById("ov-desc").textContent,
      anyN: /上位N/.test(document.getElementById("overview-view").innerText)
    }));
    record("A27-topN-label", nLabels.kpi.includes("上位20") && nLabels.d.includes("上位20") && nLabels.desc.includes("上位20") && !nLabels.anyN, JSON.stringify(nLabels));

    // A24: 上位30で系列の色が重複しない（中6）
    await page.click('#ov-topn-group button[data-topn="30"]');
    await page.waitForTimeout(300);
    const colors = await page.evaluate(() => window.FinancieOverview._debug.charts.volume.data.datasets.map((d) => d.backgroundColor));
    record("A24-colors-unique-top30", new Set(colors).size === colors.length && colors.length === 31, `n=${colors.length} unique=${new Set(colors).size}`);
    await page.click('#ov-topn-group button[data-topn="10"]');
    await page.waitForTimeout(300);

    // A28: 見出しにデータの日付・件数・非公式（中2・中7）、共通フッターにも「非公式」
    const meta = await page.textContent("#ov-meta");
    const latestDate = await page.evaluate(() => window.FinancieOverview._debug.data.market.days.slice(-1)[0].replace(/-/g, "/"));
    record("A28-meta", meta.includes("非公式") && meta.includes(latestDate) && /\d+プロジェクト/.test(meta), meta.trim());
    const appFooter = await page.textContent(".app-footer");
    record("A28-app-footer-unofficial", appFooter.includes("非公式"), appFooter.trim());

    // A23: 指標の切り替えはランキング表の見出しの横（重5）＝同じカードの中・表との距離200px未満
    const metricPlace = await page.evaluate(() => {
      const g = document.getElementById("ov-metric-group");
      const card = g.closest(".ov-ranking-card");
      const t = document.getElementById("ov-ranking-table").getBoundingClientRect();
      const r = g.getBoundingClientRect();
      return { inCard: !!card, distance: Math.round(t.top - r.bottom) };
    });
    record("A23-metric-in-ranking-card", metricPlace.inCard && metricPlace.distance >= 0 && metricPlace.distance < 200, JSON.stringify(metricPlace));

    // A29: 変化の書式が全指標で1つ（中4）＝4列目は ▲x／▼x／±0／新規／比較なし／▲10倍超 のどれか・期末値は価格2桁／他は整数（＋「（MM/DD時点）」）
    for (const m of ["price", "mcap", "members", "stock"]) {
      await page.click(`#ov-metric-group button[data-metric="${m}"]`);
      await page.waitForTimeout(400);
      const cells = await page.$$eval("#ov-ranking-tbody tr[data-folder] td:nth-child(4)", (tds) => tds.map((t) => t.textContent.trim()));
      const bad = cells.filter((t) => !/^(▲|▼)[\d,.]+%?$|^±0%?$|^新規$|^比較なし$|^▲10倍超$/.test(t));
      const last = await page.$$eval("#ov-ranking-tbody tr[data-folder] td:nth-child(3)", (tds) => tds.map((t) => t.textContent.trim()));
      const badLast = m === "price"
        ? last.filter((t) => !/^[\d,]+\.\d{2}(（\d\d\/\d\d時点）)?$/.test(t))
        : last.filter((t) => !/^-?[\d,]+(（\d\d\/\d\d時点）)?$/.test(t));
      record(`A29-change-format-${m}`, cells.length > 0 && bad.length === 0 && badLast.length === 0, `bad=${JSON.stringify(bad)} badLast=${JSON.stringify(badLast.slice(0, 3))}`);
    }
    await page.click('#ov-metric-group button[data-metric="volume"]');
    await page.waitForTimeout(300);
    const rankCells = await page.$$eval("#ov-ranking-tbody tr[data-folder] td:nth-child(6)", (tds) => tds.map((t) => t.textContent.trim()));
    const badRank = rankCells.filter((t) => !/^→$|^(▲|▼)\d+$|^比較なし$/.test(t));
    record("A29-rank-change-format", rankCells.length > 0 && badRank.length === 0, `bad=${JSON.stringify(badRank)}`);

    // A31: 期間・上位・指標がURLに残り、再読み込みで戻る（軽9）
    await page.click('#ov-period-group button[data-period="30"]');
    await page.waitForTimeout(300);
    const urlAfter30 = page.url();
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitOverviewReady(page);
    const restored = await page.evaluate(() => ({
      period: window.FinancieOverview._debug.state.period,
      active: document.querySelector("#ov-period-group button.active").getAttribute("data-period")
    }));
    record("A31-url-state", urlAfter30.includes("ov_p=30") && restored.period === 30 && restored.active === "30", `url=${urlAfter30} restored=${JSON.stringify(restored)}`);
    await page.click('#ov-period-group button[data-period="90"]');
    await page.waitForTimeout(300);

    // ---------- v3.1 の受け入れ検査 ----------
    // A38（v3.1 項目2）: 価格の指数は「期間内で最初に 0 より大きい値の日」が基準。上位10の10系列すべてに null でない点が1つ以上ある（全期間・1年・90日）
    await page.evaluate(() => document.getElementById("ovPriceChart").scrollIntoView({ block: "center" }));
    await page.waitForFunction(() => !!window.FinancieOverview._debug.charts.price, { timeout: 15000 });
    const priceIndex = {};
    for (const p of ["all", "365", "90"]) {
      await page.click(`#ov-period-group button[data-period="${p}"]`);
      await page.waitForFunction(() => {
        const st = window.FinancieOverview._debug.state;
        const ch = window.FinancieOverview._debug.charts.price;
        return ch && ch.data.labels.length === st.endIdx - st.startIdx + 1;
      }, { timeout: 15000 });
      await page.waitForTimeout(300);
      priceIndex[p] = await page.evaluate(() => {
        const ds = window.FinancieOverview._debug.charts.price.data.datasets;
        const empty = ds.filter((d) => !d.data.some((v) => v !== null && Number.isFinite(v))).map((d) => d.label);
        const firstIs100 = ds.filter((d) => { const v = d.data.find((x) => x !== null); return v !== undefined && Math.abs(v - 100) > 1e-9; }).map((d) => d.label);
        return { n: ds.length, empty, firstIs100Bad: firstIs100 };
      });
    }
    // A39（v3.1 項目6）: 表示文言は「全体市況」。タブ・見出しに出て、画面の文字に「総覧」が残っていない（id・URL・記憶のキーは据え置き）
    const naming = await page.evaluate(() => ({
      tab: document.querySelector('.tab-nav-btn[data-tab="overview-tab"]').textContent.trim(),
      h2: document.querySelector("#overview-view h2").textContent.trim(),
      errText: document.getElementById("ov-error-text").textContent,
      leftover: document.body.innerText.includes("総覧") || document.title.includes("総覧")
    }));
    record("A39-name-zentai-shikyo", naming.tab === "全体市況" && naming.h2 === "全体市況" && naming.errText.includes("全体市況") && !naming.leftover, JSON.stringify(naming));
    record("A38-price-index-not-empty", ["all", "365", "90"].every((p) => priceIndex[p].n === 10 && priceIndex[p].empty.length === 0 && priceIndex[p].firstIs100Bad.length === 0), JSON.stringify(priceIndex));
    await page.click('#ov-period-group button[data-period="90"]');
    await page.waitForTimeout(300);

    // ---------- ルク要望3（21:50 決裁）と注記a〜d の受け入れ検査 ----------
    // A34: 名前のリンク＝本家 financie.jp/users/<slug>・新しいタブ・noopener・title に「FiNANCiEで見る」と各案件のデータ取得開始日。名前を押しても個別分析へは飛ばない
    // v3.1 項目5で入れ替え：名前＝個別分析（?project=<folder>・同じタブ）／名前の右の ↗＝本家 financie.jp/users/<slug>（新しいタブ・noopener・title「FiNANCiEで見る」）。行ボタンは置かない
    const links = await page.$$eval("#ov-ranking-tbody tr[data-folder]", (trs) => trs.map((tr) => {
      const name = tr.querySelector("a.ov-pj-link");
      const ext = tr.querySelector("a.ov-ext-link");
      const r = ext ? ext.getBoundingClientRect() : null;
      return {
        folder: tr.getAttribute("data-folder"),
        nameHref: name && name.getAttribute("href"), nameTarget: name && name.getAttribute("target"), nameTitle: name ? name.getAttribute("title") || "" : "",
        extHref: ext && ext.getAttribute("href"), extTarget: ext && ext.getAttribute("target"), extRel: ext ? ext.getAttribute("rel") || "" : "", extTitle: ext ? ext.getAttribute("title") || "" : "",
        extMark: !!(ext && ext.querySelector(".ov-ext")), extRightOfName: !!(name && ext && ext.getBoundingClientRect().left >= name.getBoundingClientRect().right - 1),
        extSize: r ? Math.min(r.width, r.height) : 0, buttons: tr.querySelectorAll("button").length
      };
    }));
    const slugOf = await page.evaluate(() => { const o = {}; window.FinancieOverview._debug.data.volume.projects.forEach((p) => { o[p.folder] = p.slug; }); return o; });
    const badLinks = links.filter((l) => !(
      l.nameHref === `?project=${encodeURIComponent(l.folder)}` && !l.nameTarget && /データ取得開始 20\d\d\/\d\d\/\d\d/.test(l.nameTitle) &&
      l.extHref === `https://financie.jp/users/${encodeURIComponent(slugOf[l.folder])}` && l.extTarget === "_blank" && l.extRel.includes("noopener") && l.extTitle.includes("FiNANCiEで見る") &&
      l.extMark && l.extRightOfName && l.extSize >= 24 && l.buttons === 0
    ));
    // ↗ を押しても行のクリック（個別分析へ）は走らない
    const urlBeforeClick = page.url();
    await page.evaluate(() => { const a = document.querySelector("#ov-ranking-tbody tr[data-folder] a.ov-ext-link"); a.addEventListener("click", (e) => e.preventDefault(), { once: true }); a.click(); });
    await page.waitForTimeout(400);
    const stayed = page.url() === urlBeforeClick && !page.url().includes("project=");
    // 名前のリンク先を開くと、その案件の個別分析が出る
    const firstName = links[0];
    const namePage = await context.newPage();
    await namePage.goto(new URL(firstName.nameHref, BASE_SUB).toString(), { waitUntil: "domcontentloaded" });
    await namePage.waitForFunction(() => { const v = document.getElementById("detail-view"); const n = document.getElementById("detail-name"); return v && !v.classList.contains("hidden-element") && n && n.textContent !== "Project Name"; }, { timeout: 15000 }).catch(() => {});
    const opened = await namePage.evaluate(() => ({ visible: !document.getElementById("detail-view").classList.contains("hidden-element"), name: document.getElementById("detail-name").textContent }));
    await namePage.close();
    record("A34-two-links", links.length >= 10 && badLinks.length === 0 && stayed && opened.visible && opened.name !== "Project Name", `n=${links.length} bad=${JSON.stringify(badLinks.slice(0, 2))} stayed=${stayed} opened=${JSON.stringify(opened)}`);

    // A35: 注記＝記録の開始日（実測の最古日）と「それ以前は持っていない」・許可・参考値・非公式が13px以上の帯にある
    const notes = await page.evaluate(() => {
      const first = window.FinancieOverview._debug.data.market.first_day.replace(/-/g, "/");
      const meta = document.getElementById("ov-meta").textContent;
      const f = document.getElementById("ov-footer");
      return { first, metaOk: meta.includes(first) && meta.includes("それ以前"), footer: f.textContent.replace(/\s+/g, " ").trim(), footerPx: parseFloat(getComputedStyle(f).fontSize) };
    });
    const footerOk = ["非公式", "許可を得て", "参考値", "保証しません", "表示値"].every((w) => notes.footer.includes(w)) && notes.footerPx >= 13;
    record("A35-notes", notes.first === "2023/12/21" && notes.metaOk && footerOk, JSON.stringify({ first: notes.first, metaOk: notes.metaOk, footerPx: notes.footerPx, footerOk }));

    // A32: 背景の白黒＝ヘッダー右のトグルで切替・localStorage に記憶・再読み込みで保たれる・両テーマで文字コントラスト AA
    const contrastCheck = async () => page.evaluate(() => {
      const parse = (c) => { const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(c); return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null; };
      const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const bgOf = (el) => { // 祖先をたどり、半透明は重ねる
        let acc = null; let node = el;
        while (node && node !== document.documentElement.parentNode) {
          const c = parse(getComputedStyle(node).backgroundColor);
          if (c && c[3] > 0) {
            if (!acc) acc = c;
            else { const a = acc[3]; acc = [acc[0] * a + c[0] * (1 - a), acc[1] * a + c[1] * (1 - a), acc[2] * a + c[2] * (1 - a), Math.min(1, a + c[3] * (1 - a))]; }
            if (acc[3] >= 0.999) break;
          }
          node = node.parentElement;
        }
        if (!acc) return [255, 255, 255, 1];
        if (acc[3] < 0.999) { const a = acc[3]; acc = [acc[0] * a + 255 * (1 - a), acc[1] * a + 255 * (1 - a), acc[2] * a + 255 * (1 - a), 1]; }
        return acc;
      };
      const sel = "#overview-view .ov-meta, #overview-view .metric-label, #overview-view .metric-value, #overview-view .metric-sub, #overview-view th, #overview-view td, #overview-view td a, #overview-view .diff-up, #overview-view .diff-down, #overview-view .diff-flat, #overview-view .ov-note, #ov-footer p, #overview-view .sort-tab-btn, #overview-view .ov-control-label, #overview-view .ov-legend-item, #overview-view summary, #overview-view .chart-card-title, #overview-view h2, #overview-view #ov-desc, #overview-view .ov-size-btn, #theme-toggle, .app-footer, .tab-nav-btn";
      const bad = [];
      let n = 0;
      document.querySelectorAll(sel).forEach((el) => {
        if (!el.offsetParent && el.tagName !== "SUMMARY") return; // 非表示は除く
        const cs = getComputedStyle(el);
        const fg = parse(cs.color); if (!fg) return;
        const bg = bgOf(el);
        const L1 = lum(fg), L2 = lum(bg);
        const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
        const px = parseFloat(cs.fontSize); const bold = parseInt(cs.fontWeight, 10) >= 700;
        const large = px >= 24 || (px >= 18.66 && bold);
        const need = large ? 3 : 4.5;
        n++;
        if (ratio < need) bad.push(`${el.tagName}.${(el.className || "").toString().split(" ")[0]}:${ratio.toFixed(2)}<${need}(${cs.color} on rgb(${bg.slice(0, 3).map(Math.round)}))`);
      });
      return { n, bad: [...new Set(bad)].slice(0, 8), theme: document.documentElement.getAttribute("data-theme") || "dark" };
    });
    const darkContrast = await contrastCheck();
    record("A32-contrast-dark", darkContrast.n > 30 && darkContrast.bad.length === 0, JSON.stringify(darkContrast));
    // トグルはヘッダーの右端（ルク要望1「ヘッダー右」）＝右端がヘッダー内側の右端から 40px 以内
    const togglePos = await page.evaluate(() => { const t = document.getElementById("theme-toggle").getBoundingClientRect(); const h = document.querySelector(".app-header").getBoundingClientRect(); return { gap: Math.round(h.right - t.right) }; });
    record("A32-toggle-right", togglePos.gap >= 0 && togglePos.gap <= 40, JSON.stringify(togglePos));
    await page.click("#theme-toggle");
    await page.waitForTimeout(500);
    const lightState = await page.evaluate(() => ({ theme: document.documentElement.getAttribute("data-theme"), stored: localStorage.getItem("ft_theme"), tick: window.FinancieOverview._debug.charts.volume.options.scales.y.ticks.color, bg: getComputedStyle(document.body).backgroundColor }));
    record("A32-theme-toggle", lightState.theme === "light" && lightState.stored === "light" && lightState.tick === "#4b5563" && lightState.bg === "rgb(243, 244, 246)", JSON.stringify(lightState));
    const lightContrast = await contrastCheck();
    record("A32-contrast-light", lightContrast.n > 30 && lightContrast.bad.length === 0, JSON.stringify(lightContrast));
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitOverviewReady(page);
    const persisted = await page.evaluate(() => ({ theme: document.documentElement.getAttribute("data-theme"), label: document.getElementById("theme-toggle").textContent }));
    record("A32-theme-persist", persisted.theme === "light" && persisted.label.includes("ダーク"), JSON.stringify(persisted));
    await page.click("#theme-toggle");
    await page.waitForTimeout(300);
    const backDark = await page.evaluate(() => (document.documentElement.getAttribute("data-theme") || "dark") + "/" + localStorage.getItem("ft_theme"));
    record("A32-theme-back", backDark === "dark/dark", backDark);

    // A33: グラフの高さ＝各グラフ右上の小／中／大（既定＝中）・グラフごとに記憶・再読み込みで保たれる・chartArea が実際に増える
    const sizeBefore = await page.evaluate(() => { const c = window.FinancieOverview._debug.charts.volume; return { area: Math.round(c.chartArea.bottom - c.chartArea.top), h: c.canvas.closest(".chart-wrapper").getBoundingClientRect().height, active: c.canvas.closest(".chart-card").querySelector(".ov-size-btn.active").getAttribute("data-size") }; });
    await page.click('#ov-legend-volume ~ *, #ovVolumeChart ~ *', { trial: true }).catch(() => {});
    await page.evaluate(() => document.querySelector("#ovVolumeChart").closest(".chart-card").querySelector('.ov-size-btn[data-size="l"]').click());
    await page.waitForTimeout(500);
    const sizeAfter = await page.evaluate(() => { const c = window.FinancieOverview._debug.charts.volume; return { area: Math.round(c.chartArea.bottom - c.chartArea.top), h: c.canvas.closest(".chart-wrapper").getBoundingClientRect().height, stored: localStorage.getItem("ft_chart_size"), shareH: window.FinancieOverview._debug.charts.share.canvas.closest(".chart-wrapper").getBoundingClientRect().height }; });
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitOverviewReady(page);
    const sizePersist = await page.evaluate(() => { const c = window.FinancieOverview._debug.charts.volume; return { h: c.canvas.closest(".chart-wrapper").getBoundingClientRect().height, active: c.canvas.closest(".chart-card").querySelector(".ov-size-btn.active").getAttribute("data-size") }; });
    record("A33-chart-size", sizeBefore.active === "m" && sizeBefore.h === 260 && sizeAfter.h === 420 && sizeAfter.area > sizeBefore.area + 100 && sizeAfter.shareH === 260 && JSON.parse(sizeAfter.stored).volume === "l" && sizePersist.h === 420 && sizePersist.active === "l",
      JSON.stringify({ sizeBefore, sizeAfter, sizePersist }));
    await page.evaluate(() => { localStorage.removeItem("ft_chart_size"); localStorage.removeItem("ft_theme"); });

    // A36: シェアの円グラフ（ルク一言 21:56）＝切替でドーナツ・上位10＋その他の11切片・合計＝KPIの全体出来高・上位のシェア＝KPI・記憶
    await page.click('#ov-share-view button[data-view="donut"]');
    await page.waitForTimeout(400);
    const donut = await page.evaluate(() => {
      const c = window.FinancieOverview._debug.charts.share;
      const data = c.data.datasets[0].data;
      const sum = data.reduce((a, b) => a + b, 0);
      const top = data.slice(0, -1).reduce((a, b) => a + b, 0);
      const kpi = Number(document.getElementById("ov-kpi-total").textContent.replace(/[^0-9.]/g, ""));
      const kpiShare = parseFloat(document.getElementById("ov-kpi-share").textContent);
      return { type: c.config.type, n: data.length, labelLast: c.data.labels[data.length - 1], sum: Math.round(sum), kpi, topShare: +((top / sum) * 100).toFixed(1), kpiShare, stored: localStorage.getItem("ft_share_view"), title: document.getElementById("ov-share-title").textContent, legendN: document.querySelectorAll("#ov-legend-share .ov-legend-item").length };
    });
    record("A36-share-donut", donut.type === "doughnut" && donut.n === 11 && donut.labelLast === "その他" && Math.abs(donut.sum - donut.kpi) <= 1 && Math.abs(donut.topShare - donut.kpiShare) <= 0.11 && donut.stored === "donut" && donut.title.includes("円") === false && donut.title.includes("期間合計") && donut.legendN === 11, JSON.stringify(donut));
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitOverviewReady(page);
    const donutPersist = await page.evaluate(() => ({ type: window.FinancieOverview._debug.charts.share.config.type, active: document.querySelector("#ov-share-view button.active").getAttribute("data-view") }));
    await page.click('#ov-share-view button[data-view="stack"]');
    await page.waitForTimeout(400);
    const backStack = await page.evaluate(() => window.FinancieOverview._debug.charts.share.config.type + "/" + localStorage.getItem("ft_share_view"));
    record("A36-share-donut-persist", donutPersist.type === "doughnut" && donutPersist.active === "donut" && backStack === "bar/stack", JSON.stringify({ donutPersist, backStack }));

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

  // ---------- A40（v3.1 項目1）: 個別ページ CNG の 24H 取引量 ----------
  // 直近30日の最大の棒の高さが描画域の10%以上（全期間・1年・90日）。全期間だけ上限がつき注記と▲、「実寸で見る」で上限が外れる
  {
    const consoleErrors = [];
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await installStubs(context);
    const page = await context.newPage();
    page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
    await page.addInitScript(() => { try { localStorage.setItem("sound", "false"); localStorage.setItem("bgm", "false"); } catch (e) {} });
    await page.goto(`${BASE_SUB}?project=cryptoninjagames`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.FinancieAdvanced && window.FinancieAdvanced._debug.charts().volume, { timeout: 15000 });
    const measureVol = () => page.evaluate(() => {
      const ch = window.FinancieAdvanced._debug.charts().volume;
      const vals = ch.data.datasets[0].data;
      const last = vals.slice(-30).filter((v) => typeof v === "number");
      const lastMax = Math.max(...last);
      const area = ch.chartArea;
      const y = ch.scales.y;
      const px = y.getPixelForValue(Math.min(lastMax, y.max));
      const note = document.getElementById("volume-cap-note");
      return {
        n: vals.length, lastMax, yMax: y.max, dataMax: Math.max(...vals.filter((v) => typeof v === "number")),
        ratio: Math.round(((area.bottom - px) / (area.bottom - area.top)) * 1000) / 1000,
        areaH: Math.round(area.bottom - area.top),
        noteShown: !note.hidden, note: note.textContent.trim()
      };
    });
    const vol = {};
    for (const p of ["all", "365", "90"]) {
      await page.click(`.period-btn[data-days="${p}"]`);
      await page.waitForTimeout(400);
      vol[p] = await measureVol();
    }
    record("A40-cng-volume-visible", ["all", "365", "90"].every((p) => vol[p].ratio >= 0.1), JSON.stringify(vol));
    record("A40-cng-cap-note", vol.all.noteShown && vol.all.note.includes("2024/01/22") && vol.all.note.includes("▲") && vol.all.yMax < vol.all.dataMax && !vol["365"].noteShown && !vol["90"].noteShown && vol["90"].yMax >= vol["90"].dataMax, JSON.stringify({ all: vol.all.note, y365: vol["365"].yMax, d365: vol["365"].dataMax, y90: vol["90"].yMax, d90: vol["90"].dataMax }));
    await page.click('.period-btn[data-days="all"]');
    await page.waitForTimeout(300);
    await page.click("#volume-cap-toggle");
    await page.waitForTimeout(400);
    const full = await measureVol();
    await page.click("#volume-cap-toggle");
    await page.waitForTimeout(400);
    const back = await measureVol();
    // 実寸のまま別の案件へ移り、CNG に戻ると上限つきに戻っている（実寸は案件ごと・断 v3.1 中1）
    await page.click("#volume-cap-toggle");
    await page.waitForTimeout(400);
    await page.click('.project-item[data-folder]:not([data-folder="cryptoninjagames"])');
    await page.waitForTimeout(800);
    await page.click('.project-item[data-folder="cryptoninjagames"]');
    await page.waitForFunction(() => document.getElementById("detail-slug").textContent === "@cryptoninjagames", { timeout: 15000 });
    await page.waitForTimeout(600);
    const reset = await measureVol();
    record("A40-full-scale-resets-per-project", reset.yMax < reset.dataMax && reset.note.includes("▲") && reset.n === vol.all.n, JSON.stringify({ yMax: reset.yMax, n: reset.n, note: reset.note.slice(0, 12) }));
    record("A40-cng-full-scale-toggle", full.yMax >= full.dataMax && full.note.includes("実寸") && back.yMax < back.dataMax && back.note.includes("▲"), JSON.stringify({ full: { yMax: full.yMax, ratio: full.ratio, note: full.note.slice(0, 20) }, back: { yMax: back.yMax, ratio: back.ratio } }));
    // A41（v3.1 項目4）: 個別ページのプロジェクト名の横に本家へのリンク（新しいタブ・noopener・「FiNANCiEで見る」＋印）
    const pjLink = await page.evaluate(() => {
      const a = document.getElementById("detail-financie-link");
      const slug = document.getElementById("detail-slug").textContent.replace(/^@/, "");
      const r = a.getBoundingClientRect();
      const nameR = document.getElementById("detail-name").getBoundingClientRect();
      const cs = getComputedStyle(a);
      return { href: a.getAttribute("href"), slug, target: a.getAttribute("target"), rel: a.getAttribute("rel") || "", text: a.textContent.trim(), mark: !!a.querySelector(".ov-ext"), w: Math.round(r.width), h: Math.round(r.height), nearName: Math.abs(r.top - nameR.top) < 80, color: cs.color, display: cs.display };
    });
    record("A41-detail-financie-link", pjLink.href === `https://financie.jp/users/${encodeURIComponent(pjLink.slug)}` && pjLink.slug === "cryptoninjagames" && pjLink.target === "_blank" && pjLink.rel.includes("noopener") && pjLink.text.includes("FiNANCiEで見る") && pjLink.mark && pjLink.h >= 24 && pjLink.nearName && pjLink.color !== "rgb(0, 0, 238)", JSON.stringify(pjLink));
    const noteBox = await page.evaluate(() => {
      const note = document.getElementById("volume-cap-note").getBoundingClientRect();
      const card = document.getElementById("volume-cap-note").closest(".chart-card").getBoundingClientRect();
      const area = window.FinancieAdvanced._debug.charts().volume.chartArea;
      return { noteBottom: Math.round(note.bottom), cardBottom: Math.round(card.bottom), areaH: Math.round(area.bottom - area.top) };
    });
    record("A40-cap-note-inside-card", noteBox.noteBottom <= noteBox.cardBottom && noteBox.areaH >= 160, JSON.stringify(noteBox));
    await page.evaluate(() => document.getElementById("volumeChart").scrollIntoView({ block: "center" }));
    await page.screenshot({ path: path.join(OUT_DIR, "project_cng_volume_all_1280.png"), fullPage: false });
    record("A40-console-errors", consoleErrors.length === 0, `errors=${JSON.stringify(consoleErrors.slice(0, 5))}`);
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

    // A19: 4グラフの描画域（Chart.js の chartArea）の高さ ≥160px（重1）
    const areas = await page.evaluate(() => {
      const c = window.FinancieOverview._debug.charts;
      const o = {};
      for (const k of ["volume", "share", "price", "members"]) {
        const ch = c[k];
        o[k] = ch && ch.chartArea ? Math.round(ch.chartArea.bottom - ch.chartArea.top) : 0;
      }
      return o;
    });
    record(`A19-chartArea-${w}`, Object.values(areas).every((h) => h >= 160), JSON.stringify(areas));

    // A20: ランキング表の全セルに data-label（重2）＝スマホのカード表示で列名が出る
    const dl = await page.$$eval("#ov-ranking-tbody td", (tds) => ({ total: tds.length, missing: tds.filter((td) => !td.getAttribute("data-label")).length }));
    record(`A20-datalabel-${w}`, dl.total > 0 && dl.missing === 0, JSON.stringify(dl));

    if (w <= 768) {
      // A21: 操作帯は横スクロールなしで全グループが画面内・押す部分（釦・日付欄・チェックのラベル）は高さ44px以上（重3）
      const tap = await page.evaluate(() => {
        const bar = document.getElementById("overview-controls");
        const els = [...bar.querySelectorAll("button, input[type=date], label")].concat([...document.querySelectorAll("#ov-metric-group button")]);
        const small = els.filter((el) => el.getBoundingClientRect().height < 44)
          .map((el) => `${el.tagName}:${(el.textContent || el.id).trim().slice(0, 8)}=${Math.round(el.getBoundingClientRect().height)}`);
        const groups = [...bar.querySelectorAll(".ov-control-group")].map((g) => { const r = g.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth; });
        return { n: els.length, small, allGroupsVisible: groups.every(Boolean), noBarScroll: bar.scrollWidth <= bar.clientWidth };
      });
      record(`A21-tap-${w}`, tap.n > 0 && tap.small.length === 0 && tap.allGroupsVisible && tap.noBarScroll, JSON.stringify(tap));

      // A19b: スマホでは凡例はたたまれている（描画域を優先）
      const legendsClosed = await page.$$eval("details.ov-legend", (ds) => ds.every((d) => !d.open));
      record(`A19b-legend-closed-${w}`, legendsClosed, `closed=${legendsClosed}`);
    }

    await page.screenshot({ path: path.join(OUT_DIR, `overview_${w}.png`), fullPage: true });
    await context.close();
  }

  // ---------- A22: 日付欄にキーボードで打っても値が飛ばない（重4） ----------
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ja-JP" });
    await installStubs(context);
    const page = await context.newPage();
    await page.goto(BASE_ROOT, { waitUntil: "domcontentloaded", timeout: 20000 });
    await waitOverviewReady(page);
    const kpiBefore = await page.textContent("#ov-kpi-total");
    await page.focus("#ov-start-date");
    await page.keyboard.type("20260910");
    const typed = await page.evaluate(() => ({ value: document.getElementById("ov-start-date").value, focused: document.activeElement.id }));
    const kpiDuring = await page.textContent("#ov-kpi-total");
    record("A22-date-typing-value", typed.value === "2026-09-10", JSON.stringify(typed));
    record("A22-date-typing-no-jump", kpiDuring === kpiBefore, `before=${kpiBefore} during=${kpiDuring}`);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => {
      const s = window.FinancieOverview._debug.state;
      const d = window.FinancieOverview._debug.data.market.days;
      return { start: d[s.startIdx], end: d[s.endIdx], period: s.period, inputValue: document.getElementById("ov-start-date").value };
    });
    record("A22-date-typing-commit", after.start === "2026-09-10" && after.period === "custom" && after.inputValue === "2026-09-10", JSON.stringify(after));

    // A37（エマ再検収 重1）：終了日を開始日より前に打って Enter → 入れ替え後の値が両方の欄に出て、注記・URL・集計が一致する
    await page.click('#ov-period-group button[data-period="90"]');
    await page.waitForTimeout(300);
    const startShown = await page.inputValue("#ov-start-date"); // 2026-06-15 のはず
    await page.focus("#ov-end-date");
    await page.keyboard.type("20260501");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    const swapEnd = await page.evaluate(() => {
      const s = window.FinancieOverview._debug.state;
      const d = window.FinancieOverview._debug.data.market.days;
      const note = document.getElementById("ov-range-note");
      const url = new URL(window.location.href);
      return {
        inputs: [document.getElementById("ov-start-date").value, document.getElementById("ov-end-date").value],
        state: [d[s.startIdx], d[s.endIdx]], swapped: s.rangeSwapped,
        noteVisible: !note.classList.contains("hidden-element") && note.textContent.includes("入れ替え"),
        url: [url.searchParams.get("ov_s"), url.searchParams.get("ov_e")],
        nDays: s.endIdx - s.startIdx + 1, focused: document.activeElement.id
      };
    });
    const consistent = swapEnd.inputs[0] === "2026-05-01" && swapEnd.inputs[1] === startShown
      && swapEnd.state[0] === swapEnd.inputs[0] && swapEnd.state[1] === swapEnd.inputs[1]
      && swapEnd.url[0] === swapEnd.inputs[0] && swapEnd.url[1] === swapEnd.inputs[1]
      && swapEnd.swapped && swapEnd.noteVisible && swapEnd.focused === "";
    record("A37-swap-typed-end", consistent, `startShown=${startShown} ${JSON.stringify(swapEnd)}`);
    // 同じことを開始日側で（開始に終了より後の日を打つ）
    await page.click('#ov-period-group button[data-period="90"]');
    await page.waitForTimeout(300);
    await page.focus("#ov-start-date");
    await page.keyboard.type("20260912");
    await page.click("#ov-kpi-grid"); // Enter ではなく「別の場所を押す」（フォーカスが外れる）でも確定する
    await page.waitForTimeout(400);
    const tabCommit = await page.evaluate(() => {
      const s = window.FinancieOverview._debug.state;
      const d = window.FinancieOverview._debug.data.market.days;
      return { inputs: [document.getElementById("ov-start-date").value, document.getElementById("ov-end-date").value], state: [d[s.startIdx], d[s.endIdx]], nDays: s.endIdx - s.startIdx + 1 };
    });
    record("A37-blur-commit", tabCommit.inputs[0] === "2026-09-12" && tabCommit.inputs[1] === "2026-09-12" && tabCommit.state[0] === "2026-09-12" && tabCommit.nDays === 1, JSON.stringify(tabCommit));
    await context.close();
  }

  // ---------- A30: 読み込みに失敗したとき、案内と「もう一度読み込む」が出る（軽11） ----------
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await installStubs(context);
    await context.route("**/data/overview/market.json", (route) => route.fulfill({ status: 404, contentType: "text/plain", body: "not found" }));
    const page = await context.newPage();
    await page.goto(BASE_ROOT, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForFunction(() => {
      const e = document.getElementById("ov-error");
      return e && !e.classList.contains("hidden-element");
    }, { timeout: 15000 }).catch(() => {});
    const errUi = await page.evaluate(() => {
      const e = document.getElementById("ov-error");
      const b = document.getElementById("ov-error-reload");
      return {
        visible: !!e && !e.classList.contains("hidden-element") && e.getBoundingClientRect().height > 0,
        hasButton: !!b && b.getBoundingClientRect().height >= 40,
        text: e ? e.textContent.trim().slice(0, 40) : ""
      };
    });
    record("A30-load-error-ui", errUi.visible && errUi.hasButton, JSON.stringify(errUi));
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
