/**
 * js/merged-core.js（合体 v3.2.0 の集計の共通部品）の単体検査。ブラウザ不要（node だけ）。
 * 小さな作り物のデータで、設計書「契約（手順0）」C・D の式を1つずつ確かめる。
 * 実データとの突き合わせ（tests/out/reference_merged.json）は check_merged.js 側で行う。
 *
 * 実行: node tests/check_merged_core.js   出力: tests/out/check_merged_core.json
 */
const path = require("path");
const fs = require("fs");
const C = require(path.join(__dirname, "..", "js", "merged-core.js"));

const results = [];
function record(id, ok, detail) {
  results.push({ id, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}
const days = (start, n, skip) => {
  const out = [];
  for (let i = 0; i < n; i++) { const d = C.addDays(start, i); if (!(skip || []).includes(d)) out.push(d); }
  return out;
};

// K1 期間は暦日：記録の欠けた日があっても 7日＝期末から暦日7日
{
  const ds = days("2026-09-01", 13, ["2026-09-08", "2026-09-09"]); // 9/1〜9/13 のうち 8・9日が欠け
  const r = C.computeRange(ds, { period: 7 });
  record("K1-calendar-7", r.startDate === "2026-09-07" && r.endDate === "2026-09-13" && ds[r.startIdx] === "2026-09-07" && r.calendarDays === 7 && (r.endIdx - r.startIdx + 1) === 5, r);
  const p = C.prevRange(ds, r);
  record("K1-prev-same-calendar", p && p.startDate === "2026-08-31" && p.endDate === "2026-09-06" && p.partial === true && ds[p.startIdx] === "2026-09-01", p);
  const all = C.computeRange(ds, { period: "all" });
  record("K1-prev-none-for-all", C.prevRange(ds, all) === null, "全期間の前期間は無い");
  const sw = C.computeRange(ds, { period: "custom", start: "2026-09-12", end: "2026-09-03" });
  record("K1-custom-swap", sw.swapped && ds[sw.startIdx] === "2026-09-03" && ds[sw.endIdx] === "2026-09-12", sw);
}

// K2 週＝期末を末尾にした暦日7日・先頭の端数は捨てる
{
  const ds = days("2026-08-01", 20); // 8/1〜8/20
  const r = C.computeRange(ds, { period: "all" });
  const w = C.weekBuckets(ds, r);
  const last = w.buckets[w.buckets.length - 1];
  record("K2-week-trailing", w.buckets.length === 2 && last.end === "2026-08-20" && last.start === "2026-08-14" && w.buckets[0].start === "2026-08-07" && w.dropped === 6, { n: w.buckets.length, first: w.buckets[0], last, dropped: w.dropped });
  const m = C.monthBuckets(days("2026-07-25", 12), { startIdx: 0, endIdx: 11 });
  record("K2-month", m.buckets.length === 2 && m.buckets[0].key === "2026-07" && m.buckets[1].key === "2026-08", m.buckets.map((b) => b.key));
}

// K3 出来高：smooth は gap の日を値なしに・raw は生の値
{
  const v24 = { days: days("2026-09-01", 3), rows: [[100, 200, 300], [0, 50, 50]], gap: [[1, 2]] };
  const sm = C.volumeRows(v24, "smooth"), rw = C.volumeRows(v24, "raw");
  const tS = C.projectTotals(sm, 0, 2), tR = C.projectTotals(rw, 0, 2);
  record("K3-volume-modes", tS[0] === 600 && tS[1] === 50 && tR[1] === 100 && sm[1][2] === null && rw[1][2] === 50 && v24.rows[1][2] === 50, { tS, tR });
  record("K3-active", C.activeCount(sm, 0, 0) === 1 && C.activeCount(sm, 1, 2) === 2, "0 は取引なし");
}

// K4 メンバー ①：直前100人以上で0が続き、後で正に戻った区間だけ埋める（戻らない0・直前100未満・null を挟むは埋めない）
{
  const members = { days: days("2026-09-01", 6), rows: [
    [500, 0, 0, 510, 520, 530],     // 戻る → 埋める
    [500, 0, 0, 0, 0, 0],           // 戻らない → 埋めない
    [50, 0, 60, 60, 60, 60],        // 直前100未満 → 埋めない
    [300, 0, null, 310, 310, 310]   // null を挟む → 区間が切れて埋めない
  ] };
  const f = C.membersInfo(members).filled;
  record("K4-fill-rule", JSON.stringify(f[0]) === "[500,500,500,510,520,530]" && JSON.stringify(f[1]) === "[500,0,0,0,0,0]" && f[2][1] === 0 && f[3][1] === 0, f);
}

// K5 メンバー ②：100人以上動いたPJが20件以上の日は、同じ向きの増減（小さいものも）を0・逆向きは残す
{
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push([1000, 850]);  // −150 × 20件 → 一斉変動の日
  rows.push([1000, 990]);  // −10（同じ向き・小さい）→ 0
  rows.push([1000, 1040]); // +40（逆向き）→ 残す
  const members = { days: days("2026-06-23", 2), rows };
  const mass = C.massDaysIn(members, 0, 1);
  const netS = C.membersNet(members, "smooth", 0, 1);
  const netR = C.membersNet(members, "raw", 0, 1);
  record("K5-mass-day", mass.length === 1 && mass[0].date === "2026-06-24" && mass[0].count === 20 && mass[0].sign === -1 && netS === 40 && netR === -3000 - 10 + 40, { mass, netS, netR });
}

// K6 水準：初日から積み上げ・新しいPJは初回の人数で加わる・止まったPJは据え置き。raw の水準＝「最後の値を据え置いた合計」
{
  const members = { days: days("2026-09-01", 4), rows: [
    [100, 110, null, 130],   // 3日目が欠け＝据え置き
    [null, null, 50, 55]     // 3日目から加わる
  ] };
  const lvR = C.membersLevel(members, "raw");
  const lastKept = [100, 110, 110 + 50, 130 + 55];
  record("K6-level-raw", JSON.stringify(lvR) === JSON.stringify(lastKept), { lvR, lastKept });
  const netR = C.membersNet(members, "raw", 0, 3); // 前日も当日も数値の日だけ＝+10（2日目）と +5（4日目のPJ2）。1PJ目の 3→4日目は前日 null なので純増に入れない
  record("K6-net-excludes-entry", netR === 15, { netR });
}

// K7 月次：採用日が期末より後の PJ は入れず、その月を暫定に
{
  const monthly = { months: ["2026-07", "2026-08"], rows: [[10, 20], [5, 7]], picked_day: [[3, 34], [4, 36]] };
  const up = C.monthlyUpTo(monthly, 35);
  record("K7-monthly-no-lookahead", up[0].total === 15 && !up[0].provisional && up[1].total === 20 && up[1].provisional, up.map((x) => ({ m: x.month, t: x.total, p: x.provisional })));
}

// K8 読み込み：通信中の Promise を共有・失敗したら再試行できる
(async () => {
  let calls = 0, fail = true;
  const loader = C.createLoader(async (p) => { calls++; await new Promise((r) => setTimeout(r, 20)); if (p === "bad" && fail) throw new Error("x"); return { p }; });
  const [a, b] = await Promise.all([loader.load("a.json"), loader.load("a.json")]);
  let firstFailed = false;
  try { await loader.load("bad"); } catch (e) { firstFailed = true; }
  fail = false;
  const again = await loader.load("bad");
  record("K8-loader-share-and-retry", a === b && firstFailed && again.p === "bad" && calls === 3, { calls, same: a === b });
  const g = C.createGeneration();
  const g1 = g.next(); const g2 = g.next();
  record("K8-generation", !g.isCurrent(g1) && g.isCurrent(g2), { g1, g2 });

  const allOk = results.every((r) => r.ok);
  fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "out", "check_merged_core.json"), JSON.stringify({ allOk, results, at: new Date().toISOString() }, null, 2));
  console.log(allOk ? `\nALL PASS (${results.length})` : `\nSOME FAILED (${results.filter((r) => !r.ok).length}/${results.length})`);
  process.exit(allOk ? 0 : 1);
})();
