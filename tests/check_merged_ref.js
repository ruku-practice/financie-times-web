/**
 * js/merged-core.js を実データ（data/overview schema 2）で動かし、tests/out/reference_merged.json
 * （tests/reference_merged.py＝history.json から別の実装で作った期待値）と突き合わせる。ブラウザ不要。
 * 設計書「契約（手順0）」の M3・M13 の数の土台。
 * 実行: python3 tests/reference_merged.py && node tests/check_merged_ref.js   出力: tests/out/check_merged_ref.json
 */
const path = require("path");
const fs = require("fs");
const C = require(path.join(__dirname, "..", "js", "merged-core.js"));
const read = (p) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", p), "utf-8"));
const v24 = read("data/overview/v24.json");
const members = read("data/overview/members.json");
const ref = JSON.parse(fs.readFileSync(path.join(__dirname, "out", "reference_merged.json"), "utf-8"));
const days = v24.days;
const results = [];
const record = (id, ok, detail) => { results.push({ id, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${id} ${JSON.stringify(detail)}`); };
const near = (a, b) => (a === null || b === null || a === undefined || b === undefined) ? a == b : Math.abs(a - b) < 0.5;

record("R0-same-days", JSON.stringify(days) === JSON.stringify(members.days) && v24.projects.length === 406, { days: days.length, projects: v24.projects.length });

Object.entries(ref.periods).forEach(([key, rp]) => {
  let spec;
  if (key.startsWith("latest_")) spec = { period: Number(key.slice(7)) };
  else if (key === "all") spec = { period: "all" };
  else spec = { period: "custom", start: rp.start, end: rp.end };
  const range = C.computeRange(days, spec);
  record(`R1-range-${key}`, range.startDate === rp.start && range.endDate === rp.end && range.calendarDays === rp.n_days, { mine: [range.startDate, range.endDate, range.calendarDays], ref: [rp.start, rp.end, rp.n_days] });
  const prev = C.prevRange(days, range);
  ["smooth", "raw"].forEach((mode) => {
    const rows = C.volumeRows(v24, mode);
    const totals = C.projectTotals(rows, range.startIdx, range.endIdx);
    const total = C.sumOf(totals);
    const active = C.activeCount(rows, range.startIdx, range.endIdx);
    const top10 = C.rankProjects(v24.projects, totals).slice(0, 10).map((x) => x.folder);
    const refTop = (rp[mode].top10 || []).map((x) => (typeof x === "string" ? x : x.folder));
    const prevTotal = prev ? C.sumOf(C.projectTotals(rows, prev.startIdx, prev.endIdx)) : null;
    record(`R2-volume-${key}-${mode}`, near(total, rp[mode].total) && active === rp[mode].active && JSON.stringify(top10) === JSON.stringify(refTop) && near(prevTotal, rp[mode].prev_total),
      { total: Math.round(total), refTotal: Math.round(rp[mode].total), active, refActive: rp[mode].active, topSame: JSON.stringify(top10) === JSON.stringify(refTop), prev: prevTotal === null ? null : Math.round(prevTotal), refPrev: rp[mode].prev_total === null ? null : Math.round(rp[mode].prev_total) });
  });
  const mp = ref.member_periods[key];
  if (mp) {
    const s = C.membersNet(members, "smooth", range.startIdx, range.endIdx);
    const r = C.membersNet(members, "raw", range.startIdx, range.endIdx);
    record(`R3-members-${key}`, near(s, mp.smooth_net) && near(r, mp.raw_net), { smooth: s, refSmooth: mp.smooth_net, raw: r, refRaw: mp.raw_net });
  }
});

const d0624 = days.indexOf("2026-06-24");
record("R4-members-0624", C.membersNet(members, "smooth", d0624, d0624) === ref.member_net_20260624.smooth && C.membersNet(members, "raw", d0624, d0624) === ref.member_net_20260624.raw,
  { smooth: C.membersNet(members, "smooth", d0624, d0624), raw: C.membersNet(members, "raw", d0624, d0624), ref: ref.member_net_20260624 });
const massMine = C.massDaysIn(members, 0, days.length - 1).map((x) => x.date);
const massRef = (ref.mass_change_days || []).map((x) => x.date);
record("R5-mass-days", JSON.stringify(massMine) === JSON.stringify(massRef), { mine: massMine, ref: massRef });

const allOk = results.every((r) => r.ok);
fs.writeFileSync(path.join(__dirname, "out", "check_merged_ref.json"), JSON.stringify({ allOk, results, at: new Date().toISOString() }, null, 2));
console.log(allOk ? `\nALL PASS (${results.length})` : `\nSOME FAILED (${results.filter((r) => !r.ok).length}/${results.length})`);
process.exit(allOk ? 0 : 1);
