/* ============================================================
 * FiNANCiE TIMES 合体 v3.2.0｜集計の共通部品（純粋関数・DOM なし）
 *
 * 設計書 docs/2026-09-13_合体_設計.md の「契約（手順0）」B・C・D の式をここ1か所に置く。
 *  - 期間は暦日で数える（D）。前期間＝同じ暦日数の直前。週＝期末を末尾にした暦日7日（先頭の端数は捨てる）。
 *  - 出来高（B・C）：v24.rows は生の値。smooth＝v24.gap の日を「値なし」にする／raw＝生の値。
 *  - メンバー（C）：smooth＝①「直前が100人以上で0が続き、後で正に戻った区間」を前の値で埋める
 *                  ②「100人以上動いたPJが20件以上の日」は、その向きに動いた全PJの増減を0（逆向きは残す）。
 *    日次の純増 d → 期間の純増（KPI）・窓Wの純増（機運④）。水準＝初日から d を積み上げる（新しいPJは初回の人数で加わる・止まったPJは据え置き）。
 *  - JSON の読み込み（通信中の Promise を共有）と、描画の世代番号もここに置く。
 * ブラウザでは window.FtMergedCore、node の検査では require() で使う。
 * ============================================================ */
(function (root) {
  "use strict";

  const DAY_MS = 86400000;
  const GAP_ZERO_MIN = 100;  // ① 0落ちを埋める直前の人数の下限
  const GAP_MASS_MIN = 20;   // ② 一斉変動とみなす PJ 数
  const GAP_MASS_STEP = 100; // ② 一斉変動の判定に使う1日の増減の大きさ

  /* ---------------- 日付 ---------------- */
  function toUTC(d) { return Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)); }
  function addDays(d, n) { return new Date(toUTC(d) + n * DAY_MS).toISOString().slice(0, 10); }
  function daysBetween(a, b) { return Math.round((toUTC(b) - toUTC(a)) / DAY_MS); }

  // days は "YYYY-MM-DD" の昇順。target 以下の最後の番号（無ければ -1）
  function floorIndex(days, target) {
    let lo = 0, hi = days.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (days[mid] <= target) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }
  // target 以上の最初の番号（無ければ days.length）
  function ceilIndex(days, target) {
    let lo = 0, hi = days.length - 1, ans = days.length;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (days[mid] >= target) { ans = mid; hi = mid - 1; } else lo = mid + 1; }
    return ans;
  }

  /* ---------------- 期間（暦日） ---------------- */
  // spec = { period: 7|30|90|365|"all"|"custom", start?: "YYYY-MM-DD", end?: "YYYY-MM-DD" }
  // 戻り値 = { startIdx, endIdx, startDate, endDate, calendarDays, swapped, empty }
  function computeRange(days, spec) {
    const last = days.length - 1;
    if (last < 0) return { startIdx: 0, endIdx: -1, startDate: null, endDate: null, calendarDays: 0, swapped: false, empty: true };
    const period = spec && spec.period !== undefined ? spec.period : 90;
    let startIdx, endIdx, startDate, endDate, swapped = false;
    if (period === "custom") {
      endIdx = spec.end ? floorIndex(days, spec.end) : last;
      if (endIdx < 0) endIdx = 0;
      startIdx = spec.start ? ceilIndex(days, spec.start) : 0;
      if (startIdx > last) startIdx = last;
      if (startIdx > endIdx) { const t = startIdx; startIdx = endIdx; endIdx = t; swapped = true; }
      startDate = days[startIdx];
      endDate = days[endIdx];
    } else if (period === "all") {
      startIdx = 0; endIdx = last; startDate = days[0]; endDate = days[last];
    } else {
      const n = Number(period);
      endIdx = last;
      endDate = days[last];
      startDate = addDays(endDate, -(n - 1));
      startIdx = Math.min(ceilIndex(days, startDate), last);
      if (startDate < days[0]) startDate = days[0];
    }
    return { startIdx, endIdx, startDate, endDate, calendarDays: daysBetween(startDate, endDate) + 1, swapped, empty: false };
  }

  // 前期間＝同じ暦日数の直前。記録の初日より前にかかれば partial、全く無ければ null
  function prevRange(days, range) {
    if (!range || range.empty) return null;
    const len = range.calendarDays;
    const prevEnd = addDays(range.startDate, -1);
    if (prevEnd < days[0]) return null;
    const prevStart = addDays(prevEnd, -(len - 1));
    const startIdx = ceilIndex(days, prevStart);
    const endIdx = floorIndex(days, prevEnd);
    if (endIdx < startIdx) return null;
    return { startIdx, endIdx, startDate: prevStart, endDate: prevEnd, calendarDays: len, partial: prevStart < days[0], empty: false };
  }

  // 窓：期末から暦日 w 日（機運の指標用）。offset=1 でその直前の w 日
  function windowRange(days, endDate, w, offset) {
    const e = addDays(endDate, -(w * (offset || 0)));
    const s = addDays(e, -(w - 1));
    return { startIdx: ceilIndex(days, s), endIdx: floorIndex(days, e), startDate: s, endDate: e, calendarDays: w, partial: s < days[0] };
  }

  /* ---------------- 粒度のまとまり ---------------- */
  // 週＝期末を末尾にした暦日7日。先頭の7日に満たない端数は捨てる（dropped に日数）
  function weekBuckets(days, range) {
    const out = [];
    let we = range.endDate;
    while (true) {
      const ws = addDays(we, -6);
      if (ws < range.startDate) break;
      out.push({ key: ws, start: ws, end: we, startIdx: ceilIndex(days, ws), endIdx: floorIndex(days, we) });
      we = addDays(ws, -1);
    }
    out.reverse();
    const dropped = out.length ? daysBetween(range.startDate, out[0].start) : range.calendarDays;
    return { buckets: out, dropped };
  }

  function dayBuckets(days, range) {
    const out = [];
    for (let i = range.startIdx; i <= range.endIdx; i++) out.push({ key: days[i], start: days[i], end: days[i], startIdx: i, endIdx: i });
    return { buckets: out, dropped: 0 };
  }

  function monthBuckets(days, range) {
    const out = [];
    let cur = null;
    for (let i = range.startIdx; i <= range.endIdx; i++) {
      const k = days[i].slice(0, 7);
      if (!cur || cur.key !== k) { cur = { key: k, start: days[i], end: days[i], startIdx: i, endIdx: i }; out.push(cur); }
      cur.end = days[i]; cur.endIdx = i;
    }
    return { buckets: out, dropped: 0 };
  }

  function buckets(days, range, granularity) {
    if (granularity === "week") return weekBuckets(days, range);
    if (granularity === "month") return monthBuckets(days, range);
    return dayBuckets(days, range);
  }

  /* ---------------- 出来高（v24） ---------------- */
  const smoothCache = new WeakMap();

  // mode="raw" は生の rows、"smooth" は gap の日を null にした rows（1回だけ作って覚える）
  function volumeRows(v24, mode) {
    if (mode === "raw") return v24.rows;
    let rows = smoothCache.get(v24);
    if (!rows) {
      rows = v24.rows.map((r) => r.slice());
      (v24.gap || []).forEach((pd) => { const r = rows[pd[0]]; if (r) r[pd[1]] = null; });
      smoothCache.set(v24, rows);
    }
    return rows;
  }

  const isNum = (v) => typeof v === "number" && isFinite(v);

  // PJごとの期間合計（数値の日だけ足す）
  function projectTotals(rows, startIdx, endIdx) {
    const out = new Array(rows.length).fill(0);
    for (let p = 0; p < rows.length; p++) {
      const r = rows[p];
      let s = 0;
      for (let d = startIdx; d <= endIdx; d++) if (isNum(r[d])) s += r[d];
      out[p] = s;
    }
    return out;
  }

  // 日ごとの全PJ合計（その日に数値が1つも無ければ null）
  function dailyTotals(rows, startIdx, endIdx) {
    const out = [];
    for (let d = startIdx; d <= endIdx; d++) {
      let s = 0, has = false;
      for (let p = 0; p < rows.length; p++) { const v = rows[p][d]; if (isNum(v)) { s += v; has = true; } }
      out.push(has ? s : null);
    }
    return out;
  }

  const sumOf = (arr) => arr.reduce((a, v) => a + (isNum(v) ? v : 0), 0);

  // 期間に出来高＞0 の日があるPJ数
  function activeCount(rows, startIdx, endIdx) {
    let n = 0;
    for (let p = 0; p < rows.length; p++) {
      const r = rows[p];
      for (let d = startIdx; d <= endIdx; d++) if (isNum(r[d]) && r[d] > 0) { n++; break; }
    }
    return n;
  }

  // 期間合計の順位（大きい順・同じ値は PJ の並び順）
  function rankProjects(projects, totals) {
    return projects.map((p, i) => ({ index: i, folder: p.folder, total: totals[i] }))
      .sort((a, b) => (b.total - a.total) || (a.index - b.index));
  }

  /* ---------------- メンバー ---------------- */
  const membersCache = new WeakMap();

  function membersInfo(members) {
    let info = membersCache.get(members);
    if (info) return info;
    const rows = members.rows;
    const n = members.days.length;
    // ① 0落ちで後に戻った区間だけ前の値で埋める
    const filled = rows.map((row) => {
      const out = row.slice();
      let d = 1;
      while (d < n) {
        const prev = out[d - 1];
        if (out[d] === 0 && isNum(prev) && prev >= GAP_ZERO_MIN) {
          let e = d;
          while (e < n && out[e] === 0) e++;
          if (e < n && isNum(out[e]) && out[e] > 0) for (let k = d; k < e; k++) out[k] = prev;
          d = e;
        } else {
          d++;
        }
      }
      return out;
    });
    // ② 一斉変動の日（生の値で判定）
    const massDays = {};
    for (let d = 1; d < n; d++) {
      let down = 0, up = 0;
      for (let p = 0; p < rows.length; p++) {
        const a = rows[p][d - 1], b = rows[p][d];
        if (!isNum(a) || !isNum(b)) continue;
        if (b - a <= -GAP_MASS_STEP) down++; else if (b - a >= GAP_MASS_STEP) up++;
      }
      if (down >= GAP_MASS_MIN) massDays[d] = { count: down, sign: -1 };
      else if (up >= GAP_MASS_MIN) massDays[d] = { count: up, sign: 1 };
    }
    info = { filled, massDays, diff: {}, level: {} };
    membersCache.set(members, info);
    return info;
  }

  // 日次の増え方 inc[pj][d]（水準の積み上げ用）：前日も当日も数値なら差。前日が数値でなく当日が数値なら、
  //   それまでに数値があれば「最後の値からの差」（欠けた日をはさんでも二重に数えない）・初めてなら「加わった人数」。当日が数値でなければ 0（据え置き）。
  // net[pj][d]（純増）は前日も当日も数値のときだけ数える（欠けた日の翌日と、加わった日は純増に入れない）
  function membersDaily(members, mode) {
    const info = membersInfo(members);
    if (info.diff[mode]) return info.diff[mode];
    const base = mode === "raw" ? members.rows : info.filled;
    const raw = members.rows;
    const n = members.days.length;
    const net = [], inc = [];
    for (let p = 0; p < base.length; p++) {
      const r = base[p];
      const netRow = new Array(n).fill(null);
      const incRow = new Array(n).fill(0);
      let lastKnown = null;
      for (let d = 0; d < n; d++) {
        const b = r[d];
        const a = d > 0 ? r[d - 1] : null;
        if (!isNum(b)) continue;
        if (!isNum(a)) { incRow[d] = lastKnown === null ? b : b - lastKnown; lastKnown = b; continue; }
        lastKnown = b;
        let diff = b - a;
        if (mode !== "raw" && info.massDays[d]) {
          const ra = raw[p][d - 1], rb = raw[p][d];
          const sign = info.massDays[d].sign;
          if (isNum(ra) && isNum(rb) && (sign < 0 ? rb - ra < 0 : rb - ra > 0)) diff = 0;
        }
        netRow[d] = diff;
        incRow[d] = diff;
      }
      net.push(netRow);
      inc.push(incRow);
    }
    info.diff[mode] = { net, inc };
    return info.diff[mode];
  }

  // 期間の純増（全PJ）＝期間の各日の前日比の合計
  function membersNet(members, mode, startIdx, endIdx) {
    const { net } = membersDaily(members, mode);
    let s = 0;
    for (let p = 0; p < net.length; p++) for (let d = Math.max(1, startIdx); d <= endIdx; d++) if (isNum(net[p][d])) s += net[p][d];
    return s;
  }

  // 全PJの水準（初日から積み上げ）＝raw は「数値のあるPJは最後の値を据え置き」と同じ値になる
  function membersLevel(members, mode) {
    const info = membersInfo(members);
    if (info.level[mode]) return info.level[mode];
    const { inc } = membersDaily(members, mode);
    const n = members.days.length;
    const level = new Array(n).fill(0);
    let acc = 0;
    for (let d = 0; d < n; d++) {
      for (let p = 0; p < inc.length; p++) acc += inc[p][d];
      level[d] = acc;
    }
    info.level[mode] = level;
    return level;
  }

  // 期間内の一斉変動の日（注記用）
  function massDaysIn(members, startIdx, endIdx) {
    const info = membersInfo(members);
    return Object.keys(info.massDays).map(Number).filter((d) => d >= startIdx && d <= endIdx).sort((a, b) => a - b)
      .map((d) => ({ dayIndex: d, date: members.days[d], count: info.massDays[d].count, sign: info.massDays[d].sign }));
  }

  /* ---------------- 月次（束） ---------------- */
  // 期末までに確定した分だけ積む（採用日が期末より後の PJ は入れず、その月を provisional にする）
  function monthlyUpTo(monthly, endIdx) {
    return monthly.months.map((m, j) => {
      let total = 0, provisional = false;
      const perProject = monthly.rows.map((row, p) => {
        const day = monthly.picked_day ? monthly.picked_day[p][j] : null;
        if (day !== null && day !== undefined && day > endIdx) { provisional = true; return 0; }
        const v = isNum(row[j]) ? row[j] : 0;
        total += v;
        return v;
      });
      return { month: m, total, perProject, provisional };
    });
  }

  /* ---------------- 読み込みと世代 ---------------- */
  // 通信中の Promise も共有する（同時に呼ばれても1回だけ取りに行く）。失敗したら覚えを消して再試行できる
  function createLoader(fetchJson) {
    const cache = new Map();
    return {
      load(path) {
        if (!cache.has(path)) {
          const pr = Promise.resolve().then(() => fetchJson(path)).catch((err) => { cache.delete(path); throw err; });
          cache.set(path, pr);
        }
        return cache.get(path);
      },
      has(path) { return cache.has(path); },
      clear() { cache.clear(); }
    };
  }

  // 描画の世代番号：状態が変わるたびに next()、非同期の描画は終わったときに isCurrent(gen) を確かめて古ければ捨てる
  function createGeneration() {
    let gen = 0;
    return { next() { gen += 1; return gen; }, current() { return gen; }, isCurrent(g) { return g === gen; } };
  }

  const api = {
    GAP_ZERO_MIN, GAP_MASS_MIN, GAP_MASS_STEP,
    addDays, daysBetween, floorIndex, ceilIndex,
    computeRange, prevRange, windowRange, buckets, weekBuckets, dayBuckets, monthBuckets,
    volumeRows, projectTotals, dailyTotals, sumOf, activeCount, rankProjects,
    membersInfo, membersDaily, membersNet, membersLevel, massDaysIn,
    monthlyUpTo, createLoader, createGeneration
  };
  root.FtMergedCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
