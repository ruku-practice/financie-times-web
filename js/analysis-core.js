/* ============================================================
 * FiNANCiE TIMES 「分析」集計コア（純粋関数・v0.1.0／2026-09-13）
 *
 * js/analysis.js から「集計」だけを切り出したもの。DOM・共有状態（anState 等）・
 * localStorage・URL のいずれも触らない。引数で data（series/v24/price/…）と
 * 範囲（indices・startIdx/endIdx・window）を受け取り、戻り値だけを返す。
 *
 * 合体（js/merged.js）からも js/analysis.js（旧タブの包み・AnalysisParts）からも
 * 同じ計算を呼べるようにするための土台。window.FtAnalysisCore に公開する。
 * ============================================================ */

(function () {
  "use strict";

  /* ------------------------------------------------------------
   * 書式（純粋・DOMなし）
   * ------------------------------------------------------------ */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmtInt(v) {
    if (v === null || v === undefined || isNaN(v)) return "-";
    return Math.round(v).toLocaleString("ja-JP");
  }
  // 円 → 読みやすい単位（億円／万円／円）
  function fmtYen(v) {
    if (v === null || v === undefined || isNaN(v)) return "-";
    const a = Math.abs(v);
    if (a >= 1e8) return (v / 1e8).toFixed(2) + "億円";
    if (a >= 1e4) return Math.round(v / 1e4).toLocaleString("ja-JP") + "万円";
    return Math.round(v).toLocaleString("ja-JP") + "円";
  }
  // 軸用の短い表記
  function fmtYenTick(v) {
    const a = Math.abs(v);
    if (a >= 1e8) return (v / 1e8).toFixed(a >= 1e9 ? 0 : 1) + "億";
    if (a >= 1e4) return Math.round(v / 1e4).toLocaleString("ja-JP") + "万";
    return String(Math.round(v));
  }
  function fmtPct(v, digits) {
    if (v === null || v === undefined || isNaN(v) || !isFinite(v)) return "-";
    const d = digits === undefined ? 1 : digits;
    let t = v.toFixed(d);
    if (Number(t) === 0) t = (0).toFixed(d); // 「-0%」を出さない
    return (Number(t) > 0 ? "+" : "") + t + "%";
  }
  function pctChange(now, base) {
    if (base === null || base === undefined || base === 0 || now === null || now === undefined) return null;
    return (now / base - 1) * 100;
  }
  function fmtMD(d) { return d.slice(5, 7).replace(/^0/, "") + "/" + d.slice(8, 10).replace(/^0/, ""); }
  function fmtYMD(d) { return d.replace(/-/g, "/"); }
  function addDays(dateStr, n) {
    const d = new Date(dateStr + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function daysBetween(a, b) {
    return Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000);
  }
  function changeClass(v) { return v === null ? "" : v > 0 ? "an-up" : v < 0 ? "an-down" : ""; }
  function financieUrl(p) { return "https://financie.jp/users/" + encodeURIComponent(p.slug || p.folder); }

  // 日付 → index（無い日は直前／直後）
  function floorIndex(days, target) {
    let lo = 0, hi = days.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (days[mid] <= target) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }
  function ceilIndex(days, target) {
    let lo = 0, hi = days.length - 1, ans = days.length;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (days[mid] >= target) { ans = mid; hi = mid - 1; } else lo = mid + 1; }
    return ans;
  }

  /* ------------------------------------------------------------
   * 期間（overview.js computeRange と同じ index 基準）
   * 戻り値のみ・DOM は触らない（開始欄・終了欄・注記の反映は呼び出し側）
   * ------------------------------------------------------------ */
  function computeRange(days, opts) {
    const o = opts || {};
    const latestIdx = days.length - 1;
    let rangeSwapped = false, startIdx, endIdx;
    if (o.period === "custom") {
      endIdx = o.pendingEnd ? floorIndex(days, o.pendingEnd) : latestIdx;
      if (endIdx < 0) endIdx = 0;
      startIdx = o.pendingStart ? ceilIndex(days, o.pendingStart) : 0;
      if (startIdx >= days.length) startIdx = latestIdx;
      if (startIdx > endIdx) { const t = startIdx; startIdx = endIdx; endIdx = t; rangeSwapped = true; }
    } else if (o.period === "all") {
      startIdx = 0;
      endIdx = latestIdx;
    } else {
      const n = Number(o.period);
      endIdx = latestIdx;
      // 暦日で N 日（記録の欠けがあっても「終了日から N-1 日前」を開始日にする）
      const startDate = addDays(days[latestIdx], -(n - 1));
      startIdx = Math.max(0, ceilIndex(days, startDate));
    }
    return { startIdx, endIdx, rangeSwapped };
  }

  function rangeIndices(startIdx, endIdx) {
    const out = [];
    for (let i = startIdx; i <= endIdx; i++) out.push(i);
    return out;
  }

  // 暦日の窓 [startDate, endDate] に入る index の配列
  function indicesBetween(days, startDate, endDate) {
    const s = ceilIndex(days, startDate);
    const e = floorIndex(days, endDate);
    const out = [];
    for (let i = s; i <= e; i++) out.push(i);
    return out;
  }

  function sumSeries(arr, indices) {
    let s = 0;
    indices.forEach((i) => { const v = arr[i]; if (v !== null && v !== undefined) s += v; });
    return s;
  }

  // 前期間＝同じ長さ（暦日）の直前
  function prevRangeIndices(days, startIdx, endIdx) {
    const len = daysBetween(days[startIdx], days[endIdx]) + 1;
    const prevEnd = addDays(days[startIdx], -1);
    const prevStart = addDays(prevEnd, -(len - 1));
    if (prevEnd < days[0]) return [];
    return indicesBetween(days, prevStart, prevEnd);
  }

  // 週＝期末を末尾にした暦日7日区切り。先頭の端数は捨てる。
  function weeklyBuckets(days, startIdx, endIdx) {
    const endDate = days[endIdx];
    const startDate = days[startIdx];
    const weeks = [];
    let we = endDate;
    while (true) {
      const ws = addDays(we, -6);
      if (ws < startDate) break;
      weeks.push({ start: ws, end: we, indices: indicesBetween(days, ws, we) });
      we = addDays(ws, -1);
    }
    weeks.reverse();
    const dropped = weeks.length ? daysBetween(startDate, weeks[0].start) : daysBetween(startDate, endDate) + 1;
    return { weeks, dropped };
  }

  /* ------------------------------------------------------------
   * 集計（純粋関数・v24/series/price/bundles を渡された indices に対して）
   * ------------------------------------------------------------ */
  function projectTotals(v24, indices) {
    return v24.projects.map((p, pi) => {
      const row = v24.rows[pi];
      let sum = 0;
      indices.forEach((i) => { const x = row[i]; if (x !== null && x !== undefined) sum += x; });
      return { folder: p.folder, slug: p.slug, name: p.name, short: p.short, total: sum };
    });
  }

  function activeCount(v24, indices) {
    const rows = v24.rows;
    let n = 0;
    for (let pi = 0; pi < rows.length; pi++) {
      const row = rows[pi];
      for (let k = 0; k < indices.length; k++) {
        const x = row[indices[k]];
        if (x !== null && x !== undefined && x > 0) { n++; break; }
      }
    }
    return n;
  }

  // 価格指数：期間内で最初に 0 より大きい値の日＝100
  function priceIndexRow(price, priceFolderIndex, folder, indices) {
    const pi = priceFolderIndex[folder];
    if (pi === undefined) return indices.map(() => null);
    const row = price.rows[pi];
    let base = null;
    return indices.map((i) => {
      const v = row[i];
      if (base === null) { if (v !== null && v !== undefined && v > 0) base = v; else return null; }
      if (v === null || v === undefined) return null;
      return (v / base) * 100;
    });
  }

  function priceAt(price, priceFolderIndex, folder, idx) {
    const pi = priceFolderIndex[folder];
    if (pi === undefined) return null;
    const v = price.rows[pi][idx];
    return v === null || v === undefined ? null : v;
  }

  // 30日前の価格（無い／0 なら直前5日で代替）。dayIndex＝日付文字列→series index
  function priceAround(price, priceFolderIndex, dayIndex, folder, dateStr) {
    for (let k = 0; k <= 5; k++) {
      const d = addDays(dateStr, -k);
      const idx = dayIndex[d];
      if (idx === undefined) continue;
      const v = priceAt(price, priceFolderIndex, folder, idx);
      if (v !== null && v > 0) return v;
    }
    return null;
  }

  // 束・単独PJ・その他の区分（レポート§2の7区分）
  function segments(bundles, v24, folderIndex) {
    const segs = bundles.bundles.map((x) => ({ key: x.key, label: x.label, folders: x.folders }));
    bundles.standalone.forEach((f) => {
      const p = v24.projects[folderIndex[f]];
      if (p) segs.push({ key: f, label: p.short, folders: [f] });
    });
    return segs;
  }

  function membersOn(series, days, dateStr) {
    const idx = floorIndex(days, dateStr);
    return idx < 0 ? null : series.members_total[idx];
  }

  // 週ごとの「出来高が立ったPJ数」（期末を末尾にした7日区切り・直近 n 週）
  function weeklyActiveBack(v24, days, endDate, n) {
    const out = [];
    for (let k = 0; k < n; k++) {
      const we = addDays(endDate, -7 * k);
      out.push(activeCount(v24, indicesBetween(days, addDays(we, -6), we)));
    }
    return out;
  }

  /* ------------------------------------------------------------
   * 機運の5指標（期末基準・窓 W 日＝30/90/180・期間ボタンには依存しない）
   * 定義＝分析タブ仕様メモ §6-2＋§5（docs/analysis_code/window_compare.py と同じ式）
   *
   * computeIndicators(data, { endIdx, window })
   *   data = { series, v24, price, priceFolderIndex, config }
   *   config = { thresholds: { volumeChangePct, activeChangePct, priceUpCount }, priceTop }
   * ------------------------------------------------------------ */
  function computeIndicators(data, opts) {
    const S = data.series;
    const v24 = data.v24;
    const price = data.price;
    const priceFolderIndex = data.priceFolderIndex;
    const config = data.config || {};
    const T = config.thresholds || { volumeChangePct: 20, activeChangePct: 10, priceUpCount: 6 };
    const priceTop = config.priceTop || 10;
    const days = S.days;
    const endIdx = opts.endIdx;
    const W = opts.window;
    const endDate = days[endIdx];
    const ra = addDays(endDate, -(W - 1)), rb = endDate;
    const pa = addDays(endDate, -(2 * W - 1)), pb = addDays(endDate, -W);
    const ha = addDays(endDate, -(Math.floor(W / 2) - 1));
    const recIdx = indicesBetween(days, ra, rb), prvIdx = indicesBetween(days, pa, pb);
    const vLast = sumSeries(S.v24_total, recIdx);
    const vPrev = sumSeries(S.v24_total, prvIdx);
    const vChange = pctChange(vLast, vPrev);
    const h2 = sumSeries(S.v24_total, indicesBetween(days, ha, rb));
    const h1 = sumSeries(S.v24_total, indicesBetween(days, ra, addDays(ha, -1)));
    const halfChange = pctChange(h2, h1);

    // 上位2PJを除いた比較
    const totLast = projectTotals(v24, recIdx).sort((x, y) => y.total - x.total);
    const top2 = totLast.slice(0, 2);
    const prevMap = {}; projectTotals(v24, prvIdx).forEach((t) => { prevMap[t.folder] = t.total; });
    const exLast = vLast - top2.reduce((acc, t) => acc + t.total, 0);
    const exPrev = vPrev - top2.reduce((acc, t) => acc + (prevMap[t.folder] || 0), 0);
    const exChange = pctChange(exLast, exPrev);

    // ③ 出来高が立ったPJ数（窓）
    const nRec = activeCount(v24, recIdx), nPrv = activeCount(v24, prvIdx);
    const aChange = pctChange(nRec, nPrv);
    // 参考＝4週vs4週の平均（レポート v1 の定義）
    const wk = weeklyActiveBack(v24, days, endDate, 8);
    const recent4 = wk.slice(0, 4).reduce((x, y) => x + y, 0) / 4;
    const prev4 = wk.slice(4, 8).reduce((x, y) => x + y, 0) / 4;

    // ④ メンバー純増
    const mEnd = membersOn(S, days, rb), mW = membersOn(S, days, pb), m2W = membersOn(S, days, addDays(pa, -1));
    const mLast = mEnd !== null && mW !== null ? mEnd - mW : null;
    const mPrev = mW !== null && m2W !== null ? mW - m2W : null;

    // ⑤ 価格上位10（期末時点）のうち W日前より上昇
    const priceRank = price.projects.map((p) => ({ folder: p.folder, short: p.short, price: priceAt(price, priceFolderIndex, p.folder, endIdx) }))
      .filter((x) => x.price !== null && x.price > 0)
      .sort((x, y) => y.price - x.price)
      .slice(0, priceTop);
    const before = addDays(endDate, -W);
    let upCount = 0;
    const dayIndex = data.dayIndex || buildDayIndex(days);
    priceRank.forEach((x) => {
      const base = priceAround(price, priceFolderIndex, dayIndex, x.folder, before);
      x.base = base;
      x.change = pctChange(x.price, base);
      if (base !== null && x.price > base) upCount++;
    });

    const items = [
      { n: 1, label: `直近${W}日出来高の前${W}日比`, def: `全PJの24H 出来高の合算。${fmtMD(ra)}〜${fmtMD(rb)} ÷ ${fmtMD(pa)}〜${fmtMD(pb)}`,
        threshold: `+${T.volumeChangePct}%以上`, actual: `${fmtYen(vLast)} ÷ ${fmtYen(vPrev)} ＝ ${fmtPct(vChange, 0)}（上位2PJを除くと ${fmtPct(exChange, 0)}）`,
        ok: vChange !== null && vChange >= T.volumeChangePct },
      { n: 2, label: `窓内の後半が前半より多い`, def: `${W}日の窓を前半・後半に割り、出来高合算の 後半（${fmtMD(ha)}〜${fmtMD(rb)}）÷ 前半（${fmtMD(ra)}〜${fmtMD(addDays(ha, -1))}）`,
        threshold: "後半 ＞ 前半", actual: `${fmtYen(h2)} ÷ ${fmtYen(h1)} ＝ ${fmtPct(halfChange, 0)}`,
        ok: h1 > 0 && h2 > h1 },
      { n: 3, label: "出来高が立ったPJ数の広がり", def: `窓に出来高＞0 の日があるPJ数。直近${W}日 ÷ 前${W}日`,
        threshold: `+${T.activeChangePct}%以上`, actual: `${nRec} ÷ ${nPrv} ＝ ${fmtPct(aChange, 1)}`,
        ok: aChange !== null && aChange >= T.activeChangePct },
      { n: 4, label: "メンバー純増の加速", def: `全PJ合計（停止PJは据え置き・0落ちは前値で埋める）の直近${W}日純増 vs 前${W}日純増`,
        threshold: `直近＞前${W}日 かつ 直近＞0`, actual: `${mLast === null ? "-" : (mLast > 0 ? "+" : "") + fmtInt(mLast)}人 vs ${mPrev === null ? "-" : (mPrev > 0 ? "+" : "") + fmtInt(mPrev)}人`,
        ok: mLast !== null && mPrev !== null && mLast > mPrev && mLast > 0 },
      { n: 5, label: "価格上位10PJの反転", def: `${fmtMD(endDate)}時点の価格上位10PJのうち、${W}日前（${fmtMD(before)}・0なら直前5日）より上昇したPJ数`,
        threshold: `${T.priceUpCount}PJ以上`, actual: `${upCount} / ${priceRank.length}`,
        ok: upCount >= T.priceUpCount }
    ];
    const count = items.filter((x) => x.ok).length;
    const band = count >= 4 ? "あり" : count >= 2 ? "兆しあり" : "なし";
    return { items, count, band, W, vLast, vPrev, vChange, exChange, h1, h2, halfChange, top2, nRec, nPrv, aChange, recent4, prev4, mLast, mPrev, priceRank, upCount, endDate };
  }

  // computeIndicators から呼ぶ priceAround 用の簡易 dayIndex（series.dayIndex が無いとき用）
  function buildDayIndex(days) {
    const idx = {};
    days.forEach((d, i) => { idx[d] = i; });
    return idx;
  }

  window.FtAnalysisCore = {
    // 書式
    escapeHtml, fmtInt, fmtYen, fmtYenTick, fmtPct, pctChange, fmtMD, fmtYMD, addDays, daysBetween, changeClass, financieUrl,
    // index
    floorIndex, ceilIndex,
    // 期間
    computeRange, rangeIndices, indicesBetween, prevRangeIndices, weeklyBuckets, sumSeries,
    // 集計
    projectTotals, activeCount, priceIndexRow, priceAt, priceAround, segments, membersOn, weeklyActiveBack,
    // 機運
    computeIndicators,
    buildDayIndex
  };
})();
