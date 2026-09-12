/* ============================================================
 * FiNANCiE TIMES 総覧タブ（Dune型ダッシュボード） v3.0.0
 *
 * advanced.js が読み込まれたあとに読み込まれる想定（同じドキュメント内の
 * 別スクリプトなので、トップレベルの let/const は共有される）。
 * advanced.js 側からは window.FinancieOverview.onShow() を1回だけ呼んでもらう。
 * ============================================================ */

(function () {
  "use strict";

  const OV_APP_VERSION = "3.0.0";

  // 🔴 出来高の単位はルク確認待ち。ラベルの定義はここ1か所だけ（A12）。
  //    切り替えるときはこの1行だけ直せばよい。
  const OVERVIEW_CONFIG = {
    volumeUnitLabel: "volume（単位は確認待ち）",
    dataFiles: {
      market: "data/overview/market.json",
      volume: "data/overview/v24.json",
      price: "data/overview/price.json",
      members: "data/overview/members.json",
      stock: "data/overview/stock.json",
      mcap: "data/overview/mcap.json"
    },
    defaultTopN: 10,
    defaultPeriod: 90
  };

  const METRIC_LABELS = {
    volume: "出来高",
    price: "価格",
    members: "メンバー数",
    stock: "在庫",
    mcap: "時価総額"
  };

  // 上位10まで区別できる色（advanced.js の比較色パレットに合わせる）＋不足分は循環。
  const OV_COLORS = [
    "#2563eb", "#10b981", "#f59e0b", "#f87171", "#7c3aed",
    "#ec4899", "#06b6d4", "#f97316", "#14b8a6", "#a3e635",
    "#38bdf8", "#e879f9"
  ];
  const OV_OTHER_COLOR = "#6b7280";

  function ovColor(i) {
    return OV_COLORS[i % OV_COLORS.length];
  }

  /* ------------------------------------------------------------
   * 状態
   * ------------------------------------------------------------ */
  const ovState = {
    initialized: false,
    period: OVERVIEW_CONFIG.defaultPeriod, // 7|30|90|365|'all'
    granularity: "day", // 'day'|'week'|'month'
    granularityManual: false,
    topN: OVERVIEW_CONFIG.defaultTopN,
    metric: "volume",
    showOthers: true,
    startIdx: 0,
    endIdx: 0,
    // パネルD/Eは画面に出てくるまでデータを読まない（初回読み込みを market+v24 だけに絞るため）
    panelDReady: false,
    panelEReady: false
  };

  const ovData = {}; // { volume: {days,projects,rows,folderIndex}, market: {...}, ... }
  const ovCharts = { volume: null, share: null, price: null, members: null };

  window.__ovLoadedFiles = window.__ovLoadedFiles || [];

  /* ------------------------------------------------------------
   * DOM
   * ------------------------------------------------------------ */
  let dom = null;

  function bindDom() {
    dom = {
      periodGroup: document.getElementById("ov-period-group"),
      granularityGroup: document.getElementById("ov-granularity-group"),
      topnGroup: document.getElementById("ov-topn-group"),
      metricGroup: document.getElementById("ov-metric-group"),
      startInput: document.getElementById("ov-start-date"),
      endInput: document.getElementById("ov-end-date"),
      showOthers: document.getElementById("ov-show-others"),
      kpiTotal: document.getElementById("ov-kpi-total"),
      kpiTotalSub: document.getElementById("ov-kpi-total-sub"),
      kpiAvg: document.getElementById("ov-kpi-avg"),
      kpiActive: document.getElementById("ov-kpi-active"),
      kpiActiveSub: document.getElementById("ov-kpi-active-sub"),
      kpiShare: document.getElementById("ov-kpi-share"),
      kpiShareSub: document.getElementById("ov-kpi-share-sub"),
      rankingTitle: document.getElementById("ov-ranking-title"),
      rankingThead: document.getElementById("ov-ranking-thead"),
      rankingTbody: document.getElementById("ov-ranking-tbody")
    };
  }

  /* ------------------------------------------------------------
   * ユーティリティ
   * ------------------------------------------------------------ */
  const fmtInt = (n) => (n === null || n === undefined || isNaN(n)) ? "-" : Math.round(n).toLocaleString("ja-JP");
  const fmtFloat = (n, d = 2) => (n === null || n === undefined || isNaN(n)) ? "-" : Number(n).toLocaleString("ja-JP", { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtPercent = (n, d = 1) => (n === null || n === undefined || isNaN(n)) ? "-" : `${(n * 100).toFixed(d)}%`;

  function fetchOverviewFile(path) {
    window.__ovLoadedFiles.push(path);
    return fetch(path).then((res) => {
      if (!res.ok) throw new Error(`failed to load ${path}`);
      return res.json();
    });
  }

  function indexMetricPayload(payload) {
    payload.folderIndex = {};
    payload.projects.forEach((p, i) => { payload.folderIndex[p.folder] = i; });
    return payload;
  }

  function ensureMetricLoaded(metricKey) {
    if (ovData[metricKey]) return Promise.resolve(ovData[metricKey]);
    return fetchOverviewFile(OVERVIEW_CONFIG.dataFiles[metricKey]).then((payload) => {
      ovData[metricKey] = metricKey === "market" ? payload : indexMetricPayload(payload);
      return ovData[metricKey];
    });
  }

  // 日付配列に対する二分探索（days は "YYYY-MM-DD" の昇順文字列）
  function floorIndex(days, target) {
    let lo = 0, hi = days.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (days[mid] <= target) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return ans;
  }

  function ceilIndex(days, target) {
    let lo = 0, hi = days.length - 1, ans = days.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (days[mid] >= target) { ans = mid; hi = mid - 1; } else { lo = mid + 1; }
    }
    return ans;
  }

  function periodSum(metricKey, folder, startIdx, endIdx) {
    const payload = ovData[metricKey];
    const idx = payload.folderIndex[folder];
    if (idx === undefined) return 0;
    const row = payload.rows[idx];
    let sum = 0;
    for (let i = startIdx; i <= endIdx; i++) {
      const v = row[i];
      if (v !== null && v !== undefined) sum += v;
    }
    return sum;
  }

  function firstLastValid(row, startIdx, endIdx) {
    let first = null, last = null;
    for (let i = startIdx; i <= endIdx; i++) {
      if (row[i] !== null && row[i] !== undefined) { first = row[i]; break; }
    }
    for (let i = endIdx; i >= startIdx; i--) {
      if (row[i] !== null && row[i] !== undefined) { last = row[i]; break; }
    }
    return { first, last };
  }

  /* ------------------------------------------------------------
   * 期間・粒度の計算
   * ------------------------------------------------------------ */
  function computeRange() {
    const days = ovData.market.days;
    const latestIdx = days.length - 1;

    if (ovState.period === "custom") {
      const startVal = dom.startInput.value;
      const endVal = dom.endInput.value;
      let endIdx = endVal ? floorIndex(days, endVal) : latestIdx;
      if (endIdx < 0) endIdx = latestIdx;
      let startIdx = startVal ? ceilIndex(days, startVal) : 0;
      if (startIdx >= days.length) startIdx = 0;
      if (startIdx > endIdx) startIdx = endIdx;
      ovState.startIdx = startIdx;
      ovState.endIdx = endIdx;
    } else if (ovState.period === "all") {
      ovState.startIdx = 0;
      ovState.endIdx = latestIdx;
    } else {
      const n = Number(ovState.period);
      ovState.endIdx = latestIdx;
      ovState.startIdx = Math.max(0, latestIdx - (n - 1));
    }

    dom.startInput.value = days[ovState.startIdx];
    dom.endInput.value = days[ovState.endIdx];
  }

  function autoAdjustGranularity() {
    const nDays = ovState.endIdx - ovState.startIdx + 1;
    if (!ovState.granularityManual) {
      ovState.granularity = nDays > 365 ? "week" : "day";
      dom.granularityGroup.querySelectorAll("button").forEach((btn) => {
        btn.classList.toggle("active", btn.getAttribute("data-granularity") === ovState.granularity);
      });
    }
  }

  function isoWeekKey(dateStr) {
    const d = new Date(dateStr + "T00:00:00Z");
    const dayNum = (d.getUTCDay() + 6) % 7; // Monday=0
    d.setUTCDate(d.getUTCDate() - dayNum + 3);
    const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    const week = 1 + Math.round(((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  }

  // 期間内の日付インデックスを、粒度に応じたバケツへまとめる。
  // 戻り値: [{ label, indices: [dayIdx, ...] }, ...]（時系列順）
  function buildBuckets() {
    const days = ovData.market.days;
    const buckets = [];
    const bucketMap = {};
    for (let i = ovState.startIdx; i <= ovState.endIdx; i++) {
      const dstr = days[i];
      let key;
      if (ovState.granularity === "day") key = dstr;
      else if (ovState.granularity === "week") key = isoWeekKey(dstr);
      else key = dstr.slice(0, 7); // YYYY-MM

      if (!bucketMap[key]) {
        bucketMap[key] = { label: key, indices: [] };
        buckets.push(bucketMap[key]);
      }
      bucketMap[key].indices.push(i);
    }
    return buckets;
  }

  /* ------------------------------------------------------------
   * 上位N（常に「出来高」の期間合計で決める・パネルA/B/D/Eで共通）
   * ------------------------------------------------------------ */
  function computeTopNVolumeFolders() {
    const payload = ovData.volume;
    const totals = payload.projects.map((p, i) => {
      let sum = 0;
      const row = payload.rows[i];
      for (let d = ovState.startIdx; d <= ovState.endIdx; d++) {
        if (row[d] !== null && row[d] !== undefined) sum += row[d];
      }
      return { folder: p.folder, slug: p.slug, name: p.name, total: sum };
    });
    totals.sort((a, b) => b.total - a.total);
    return totals;
  }

  /* ------------------------------------------------------------
   * KPI
   * ------------------------------------------------------------ */
  function prevPeriodRange() {
    const len = ovState.endIdx - ovState.startIdx + 1;
    const prevEnd = ovState.startIdx - 1;
    const prevStart = Math.max(0, prevEnd - (len - 1));
    if (prevEnd < 0) return null;
    return { startIdx: prevStart, endIdx: prevEnd };
  }

  function sumMarketV24(startIdx, endIdx) {
    const arr = ovData.market.v24_total;
    let sum = 0, hasAny = false;
    for (let i = startIdx; i <= endIdx; i++) {
      if (arr[i] !== null && arr[i] !== undefined) { sum += arr[i]; hasAny = true; }
    }
    return hasAny ? sum : 0;
  }

  function renderKPIs(topRanked) {
    const total = sumMarketV24(ovState.startIdx, ovState.endIdx);
    const nDays = ovState.endIdx - ovState.startIdx + 1;
    const avg = nDays > 0 ? total / nDays : 0;

    const prev = prevPeriodRange();
    let subText = "比較できる前期間がありません";
    if (prev) {
      const prevTotal = sumMarketV24(prev.startIdx, prev.endIdx);
      if (prevTotal > 0) {
        const diffPct = (total - prevTotal) / prevTotal;
        const sign = diffPct >= 0 ? "多い" : "少ない";
        subText = `前の${nDays}日より${fmtPercent(Math.abs(diffPct))}${sign}`;
      }
    }

    dom.kpiTotal.textContent = `${fmtInt(total)}`;
    dom.kpiTotalSub.textContent = `${subText}（${OVERVIEW_CONFIG.volumeUnitLabel}）`;
    dom.kpiAvg.textContent = `${fmtInt(avg)}`;

    const activeCount = ovData.volume.projects.filter((p, i) => {
      const row = ovData.volume.rows[i];
      let s = 0;
      for (let d = ovState.startIdx; d <= ovState.endIdx; d++) {
        if (row[d] !== null && row[d] !== undefined) s += row[d];
      }
      return s > 0;
    }).length;
    dom.kpiActive.textContent = `${activeCount}`;
    dom.kpiActiveSub.textContent = `/ 全${ovData.volume.projects.length}プロジェクト`;

    const topN = topRanked.slice(0, ovState.topN);
    const topSum = topN.reduce((s, x) => s + x.total, 0);
    const share = total > 0 ? topSum / total : 0;
    dom.kpiShare.textContent = fmtPercent(share);
    dom.kpiShareSub.textContent = `上位${ovState.topN}`;
  }

  /* ------------------------------------------------------------
   * パネル A / B: 全体出来高（積み上げ）・シェア（100%積み上げ）
   * ------------------------------------------------------------ */
  function buildSeriesForBuckets(buckets, topFolders) {
    const payload = ovData.volume;
    const series = topFolders.map((tf) => {
      const idx = payload.folderIndex[tf.folder];
      const row = idx !== undefined ? payload.rows[idx] : null;
      const data = buckets.map((b) => {
        if (!row) return 0;
        let s = 0;
        b.indices.forEach((di) => { if (row[di] !== null && row[di] !== undefined) s += row[di]; });
        return s;
      });
      return { folder: tf.folder, name: tf.name, data };
    });

    // その他 = market の合計 - 上位N合計
    const othersData = buckets.map((b, bi) => {
      let bucketTotal = 0;
      b.indices.forEach((di) => {
        const v = ovData.market.v24_total[di];
        if (v !== null && v !== undefined) bucketTotal += v;
      });
      const topSumThisBucket = series.reduce((s, ser) => s + ser.data[bi], 0);
      return Math.max(0, bucketTotal - topSumThisBucket);
    });

    return { series, othersData };
  }

  function renderPanelAB(topFolders) {
    const buckets = buildBuckets();
    const topN = topFolders.slice(0, ovState.topN);
    const { series, othersData } = buildSeriesForBuckets(buckets, topN);
    const labels = buckets.map((b) => b.label);

    const datasetsA = series.map((s, i) => ({
      label: s.name,
      data: s.data,
      backgroundColor: ovColor(i),
      stack: "vol"
    }));
    datasetsA.push({
      label: "その他",
      data: othersData,
      backgroundColor: OV_OTHER_COLOR,
      stack: "vol",
      hidden: !ovState.showOthers
    });

    if (ovCharts.volume) ovCharts.volume.destroy();
    const volCtx = document.getElementById("ovVolumeChart").getContext("2d");
    ovCharts.volume = new Chart(volCtx, {
      type: "bar",
      data: { labels, datasets: datasetsA },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom", labels: { color: "#9ca3af", boxWidth: 10, font: { size: 10 } } },
          tooltip: { mode: "index", intersect: false }
        },
        scales: {
          x: { stacked: true, ticks: { color: "#9ca3af", maxTicksLimit: 12 }, grid: { color: "rgba(255,255,255,0.03)" } },
          y: { stacked: true, ticks: { color: "#9ca3af" }, grid: { color: "rgba(255,255,255,0.05)" } }
        }
      }
    });

    // シェア（100%積み上げ）: バケツごとの合計（上位N + その他）でパーセント化
    const bucketTotals = labels.map((_, bi) => {
      let t = othersData[bi];
      series.forEach((s) => { t += s.data[bi]; });
      return t;
    });
    const shareDatasets = series.map((s, i) => ({
      label: s.name,
      data: s.data.map((v, bi) => bucketTotals[bi] > 0 ? (v / bucketTotals[bi]) * 100 : 0),
      backgroundColor: ovColor(i),
      stack: "share"
    }));
    shareDatasets.push({
      label: "その他",
      data: othersData.map((v, bi) => bucketTotals[bi] > 0 ? (v / bucketTotals[bi]) * 100 : 0),
      backgroundColor: OV_OTHER_COLOR,
      stack: "share",
      hidden: !ovState.showOthers
    });

    if (ovCharts.share) ovCharts.share.destroy();
    const shareCtx = document.getElementById("ovShareChart").getContext("2d");
    ovCharts.share = new Chart(shareCtx, {
      type: "bar",
      data: { labels, datasets: shareDatasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom", labels: { color: "#9ca3af", boxWidth: 10, font: { size: 10 } } },
          tooltip: { mode: "index", intersect: false }
        },
        scales: {
          x: { stacked: true, ticks: { color: "#9ca3af", maxTicksLimit: 12 }, grid: { color: "rgba(255,255,255,0.03)" } },
          y: { stacked: true, min: 0, max: 100, ticks: { color: "#9ca3af", callback: (v) => v + "%" }, grid: { color: "rgba(255,255,255,0.05)" } }
        }
      }
    });
  }

  /* ------------------------------------------------------------
   * パネル C: 指標ランキング表
   * ------------------------------------------------------------ */
  function renderRankingHeader(metric) {
    const cols = {
      volume: ["順位", "プロジェクト", `期間合計（${OVERVIEW_CONFIG.volumeUnitLabel}）`, "前期間比", "シェア", "順位変化"],
      price: ["順位", "プロジェクト", "期末値", "期間の変化率"],
      members: ["順位", "プロジェクト", "期末値（人）", "期間純増（人）※購入者数ではない"],
      stock: ["順位", "プロジェクト", "期末値", "期間の減り ※販売数ではない・売り戻しと差し引き"],
      mcap: ["順位", "プロジェクト", "期末値", "期間の変化率"]
    };
    const list = cols[metric] || cols.volume;
    dom.rankingThead.innerHTML = `<tr>${list.map((c) => `<th>${c}</th>`).join("")}</tr>`;
    return list.length;
  }

  function rankingRowsForMetric(metric) {
    if (metric === "volume") {
      const ranked = computeTopNVolumeFolders(); // already sorted desc by period total (全409件)
      const prev = prevPeriodRange();
      let prevRankedMap = {};
      if (prev) {
        const payload = ovData.volume;
        const prevTotals = payload.projects.map((p, i) => {
          let s = 0;
          const row = payload.rows[i];
          for (let d = prev.startIdx; d <= prev.endIdx; d++) {
            if (row[d] !== null && row[d] !== undefined) s += row[d];
          }
          return { folder: p.folder, total: s };
        });
        prevTotals.sort((a, b) => b.total - a.total);
        prevTotals.forEach((r, i) => { prevRankedMap[r.folder] = i + 1; });
      }
      const grandTotal = ranked.reduce((s, r) => s + r.total, 0);
      return { ranked, extra: { prevRankedMap, grandTotal } };
    }

    // 出来高以外の指標: 選んだ指標そのものの値で並べ替え
    const payload = ovData[metric];
    const rows = payload.projects.map((p, i) => {
      const row = payload.rows[i];
      const { first, last } = firstLastValid(row, ovState.startIdx, ovState.endIdx);
      let changeAbs = null, changePct = null;
      if (first !== null && last !== null) {
        changeAbs = last - first;
        changePct = first !== 0 ? changeAbs / first : null;
      }
      // 並べ替え基準: stock は「減り」を大きい順（減少が大きいほど上位）、それ以外は変化率降順。
      let sortValue;
      if (metric === "stock") sortValue = changeAbs === null ? -Infinity : -changeAbs; // 減少(負)ほど大きい正値に
      else if (metric === "members") sortValue = changeAbs === null ? -Infinity : changeAbs;
      else sortValue = changePct === null ? -Infinity : changePct;
      return { folder: p.folder, name: p.name, last, changeAbs, changePct, sortValue };
    });
    rows.sort((a, b) => b.sortValue - a.sortValue);
    return { ranked: rows, extra: {} };
  }

  function renderPanelC() {
    const metric = ovState.metric;
    dom.rankingTitle.textContent = `指標ランキング（${METRIC_LABELS[metric]}）`;
    const colCount = renderRankingHeader(metric);

    ensureMetricLoaded(metric).then(() => {
      const { ranked, extra } = rankingRowsForMetric(metric);
      const topN = ranked.slice(0, ovState.topN);
      const restCount = ranked.length - topN.length;

      let rowsHtml = "";
      if (metric === "volume") {
        topN.forEach((r, i) => {
          const prevRank = extra.prevRankedMap[r.folder];
          const rankChange = prevRank ? prevRank - (i + 1) : null;
          const share = extra.grandTotal > 0 ? r.total / extra.grandTotal : 0;
          rowsHtml += `<tr class="ov-ranking-row" data-folder="${r.folder}">
            <td class="text-center">${i + 1}</td>
            <td class="text-left"><a class="table-pj-link" href="?project=${r.folder}">${r.name}</a></td>
            <td class="text-right">${fmtInt(r.total)}</td>
            <td class="text-right">-</td>
            <td class="text-right">${fmtPercent(share)}</td>
            <td class="text-right">${rankChange === null ? "-" : (rankChange > 0 ? `▲${rankChange}` : (rankChange < 0 ? `▼${Math.abs(rankChange)}` : "-"))}</td>
          </tr>`;
        });
        if (!ovState.showOthers) {
          // 表示切替: その他行を隠す
        } else if (restCount > 0) {
          const othersSum = ranked.slice(ovState.topN).reduce((s, r) => s + r.total, 0);
          rowsHtml += `<tr class="ov-ranking-row ov-others-row"><td class="text-center">-</td><td class="text-left">その他（${restCount}件）</td><td class="text-right">${fmtInt(othersSum)}</td><td class="text-right">-</td><td class="text-right">-</td><td class="text-right">-</td></tr>`;
        }
      } else if (metric === "price" || metric === "mcap") {
        topN.forEach((r, i) => {
          rowsHtml += `<tr class="ov-ranking-row" data-folder="${r.folder}">
            <td class="text-center">${i + 1}</td>
            <td class="text-left"><a class="table-pj-link" href="?project=${r.folder}">${r.name}</a></td>
            <td class="text-right">${fmtFloat(r.last, 4)}</td>
            <td class="text-right ${r.changePct === null ? "" : (r.changePct >= 0 ? "diff-up" : "diff-down")}">${r.changePct === null ? "-" : fmtPercent(r.changePct)}</td>
          </tr>`;
        });
        if (ovState.showOthers && restCount > 0) {
          rowsHtml += `<tr class="ov-ranking-row ov-others-row"><td class="text-center">-</td><td class="text-left">その他（${restCount}件）</td><td class="text-right">-</td><td class="text-right">-</td></tr>`;
        }
      } else if (metric === "members") {
        topN.forEach((r, i) => {
          rowsHtml += `<tr class="ov-ranking-row" data-folder="${r.folder}">
            <td class="text-center">${i + 1}</td>
            <td class="text-left"><a class="table-pj-link" href="?project=${r.folder}">${r.name}</a></td>
            <td class="text-right">${fmtInt(r.last)}</td>
            <td class="text-right ${r.changeAbs === null ? "" : (r.changeAbs >= 0 ? "diff-up" : "diff-down")}">${r.changeAbs === null ? "-" : fmtInt(r.changeAbs)}</td>
          </tr>`;
        });
        if (ovState.showOthers && restCount > 0) {
          rowsHtml += `<tr class="ov-ranking-row ov-others-row"><td class="text-center">-</td><td class="text-left">その他（${restCount}件）</td><td class="text-right">-</td><td class="text-right">-</td></tr>`;
        }
      } else if (metric === "stock") {
        topN.forEach((r, i) => {
          rowsHtml += `<tr class="ov-ranking-row" data-folder="${r.folder}">
            <td class="text-center">${i + 1}</td>
            <td class="text-left"><a class="table-pj-link" href="?project=${r.folder}">${r.name}</a></td>
            <td class="text-right">${fmtInt(r.last)}</td>
            <td class="text-right ${r.changeAbs === null ? "" : (r.changeAbs <= 0 ? "diff-down" : "diff-up")}">${r.changeAbs === null ? "-" : fmtInt(r.changeAbs)}</td>
          </tr>`;
        });
        if (ovState.showOthers && restCount > 0) {
          rowsHtml += `<tr class="ov-ranking-row ov-others-row"><td class="text-center">-</td><td class="text-left">その他（${restCount}件）</td><td class="text-right">-</td><td class="text-right">-</td></tr>`;
        }
      }

      dom.rankingTbody.innerHTML = rowsHtml || `<tr><td colspan="${colCount}" class="text-center">データがありません</td></tr>`;

      dom.rankingTbody.querySelectorAll(".ov-ranking-row[data-folder]").forEach((tr) => {
        tr.addEventListener("click", () => {
          window.location.href = `?project=${tr.getAttribute("data-folder")}`;
        });
      });
    });
  }

  /* ------------------------------------------------------------
   * パネル D: 価格の推移（上位N・期間初日=100の指数）
   * ------------------------------------------------------------ */
  function renderPanelD(topFolders) {
    ensureMetricLoaded("price").then((payload) => {
      const days = ovData.market.days;
      const labels = days.slice(ovState.startIdx, ovState.endIdx + 1);
      const topN = topFolders.slice(0, ovState.topN);

      const datasets = topN.map((tf, i) => {
        const idx = payload.folderIndex[tf.folder];
        const row = idx !== undefined ? payload.rows[idx] : null;
        let base = null;
        const data = [];
        for (let d = ovState.startIdx; d <= ovState.endIdx; d++) {
          const v = row ? row[d] : null;
          if (v !== null && v !== undefined && base === null) base = v;
          if (v === null || v === undefined || base === null || base === 0) {
            data.push(null);
          } else {
            data.push((v / base) * 100);
          }
        }
        return {
          label: tf.name,
          data,
          borderColor: ovColor(i),
          backgroundColor: "transparent",
          borderWidth: 2,
          pointRadius: 0,
          spanGaps: true,
          tension: 0.1
        };
      });

      if (ovCharts.price) ovCharts.price.destroy();
      const ctx = document.getElementById("ovPriceChart").getContext("2d");
      ovCharts.price = new Chart(ctx, {
        type: "line",
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: "bottom", labels: { color: "#9ca3af", boxWidth: 10, font: { size: 10 } } },
            tooltip: { mode: "index", intersect: false }
          },
          scales: {
            x: { ticks: { color: "#9ca3af", maxTicksLimit: 12 }, grid: { color: "rgba(255,255,255,0.03)" } },
            y: { ticks: { color: "#9ca3af" }, grid: { color: "rgba(255,255,255,0.05)" } }
          }
        }
      });
    });
  }

  /* ------------------------------------------------------------
   * パネル E: メンバー数の増減（日ごとの純増・上位N＋その他の積み上げ）
   * ------------------------------------------------------------ */
  function renderPanelE(topFolders) {
    ensureMetricLoaded("members").then((payload) => {
      const buckets = buildBuckets();
      const topN = topFolders.slice(0, ovState.topN);

      // 期間開始日の1日前が要る（純増の差分計算のため）。無ければ最初の日はnull扱い。
      function netAddRow(folder) {
        const idx = payload.folderIndex[folder];
        if (idx === undefined) return {};
        const row = payload.rows[idx];
        const net = {};
        for (let d = ovState.startIdx; d <= ovState.endIdx; d++) {
          if (d === 0 || row[d] === null || row[d - 1] === null || row[d] === undefined || row[d - 1] === undefined) {
            net[d] = null;
          } else {
            net[d] = row[d] - row[d - 1];
          }
        }
        return net;
      }

      const series = topN.map((tf) => {
        const net = netAddRow(tf.folder);
        const data = buckets.map((b) => {
          let s = 0, has = false;
          b.indices.forEach((di) => { if (net[di] !== null && net[di] !== undefined) { s += net[di]; has = true; } });
          return has ? s : 0;
        });
        return { name: tf.name, data };
      });

      // その他 = 上位N以外の全プロジェクトの純増合計
      const topFolderSet = new Set(topN.map((t) => t.folder));
      const otherFolders = payload.projects.filter((p) => !topFolderSet.has(p.folder)).map((p) => p.folder);
      const othersData = buckets.map((b, bi) => {
        let s = 0;
        otherFolders.forEach((folder) => {
          const net = netAddRow(folder);
          b.indices.forEach((di) => { if (net[di] !== null && net[di] !== undefined) s += net[di]; });
        });
        return s;
      });

      const labels = buckets.map((b) => b.label);
      const datasets = series.map((s, i) => ({
        label: s.name,
        data: s.data,
        backgroundColor: ovColor(i),
        stack: "members"
      }));
      datasets.push({
        label: "その他",
        data: othersData,
        backgroundColor: OV_OTHER_COLOR,
        stack: "members",
        hidden: !ovState.showOthers
      });

      if (ovCharts.members) ovCharts.members.destroy();
      const ctx = document.getElementById("ovMembersChart").getContext("2d");
      ovCharts.members = new Chart(ctx, {
        type: "bar",
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: "bottom", labels: { color: "#9ca3af", boxWidth: 10, font: { size: 10 } } },
            tooltip: { mode: "index", intersect: false }
          },
          scales: {
            x: { stacked: true, ticks: { color: "#9ca3af", maxTicksLimit: 12 }, grid: { color: "rgba(255,255,255,0.03)" } },
            y: { stacked: true, ticks: { color: "#9ca3af" }, grid: { color: "rgba(255,255,255,0.05)" } }
          }
        }
      });
    });
  }

  /* ------------------------------------------------------------
   * 全体の再描画
   * ------------------------------------------------------------ */
  function recomputeAll() {
    computeRange();
    autoAdjustGranularity();
    const topFolders = computeTopNVolumeFolders();
    renderKPIs(topFolders);
    renderPanelAB(topFolders);
    renderPanelC();
    // パネルD/Eは、画面に一度出てくるまでは描画（＝price.json/members.jsonの取得）を遅らせる。
    // （初回読み込みを market.json + v24.json だけに絞るため。一度出たら以降は追随する）
    if (ovState.panelDReady) renderPanelD(topFolders);
    if (ovState.panelEReady) renderPanelE(topFolders);
  }

  // パネルD/Eが画面に入って初めて、それぞれの指標データを読んで描画する。
  function setupLazyPanels() {
    const dCard = document.getElementById("ovPriceChart").closest(".chart-card");
    const eCard = document.getElementById("ovMembersChart").closest(".chart-card");

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        if (entry.target === dCard && !ovState.panelDReady) {
          ovState.panelDReady = true;
          renderPanelD(computeTopNVolumeFolders());
          observer.unobserve(dCard);
        }
        if (entry.target === eCard && !ovState.panelEReady) {
          ovState.panelEReady = true;
          renderPanelE(computeTopNVolumeFolders());
          observer.unobserve(eCard);
        }
      });
    }, { root: null, threshold: 0.05 });

    observer.observe(dCard);
    observer.observe(eCard);
  }

  /* ------------------------------------------------------------
   * イベント登録
   * ------------------------------------------------------------ */
  function attachEvents() {
    dom.periodGroup.querySelectorAll("button[data-period]").forEach((btn) => {
      btn.addEventListener("click", () => {
        dom.periodGroup.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const val = btn.getAttribute("data-period");
        ovState.period = val === "all" ? "all" : Number(val);
        ovState.granularityManual = false;
        recomputeAll();
      });
    });

    [dom.startInput, dom.endInput].forEach((input) => {
      input.addEventListener("change", () => {
        dom.periodGroup.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
        ovState.period = "custom";
        ovState.granularityManual = false;
        recomputeAll();
      });
    });

    dom.granularityGroup.querySelectorAll("button[data-granularity]").forEach((btn) => {
      btn.addEventListener("click", () => {
        dom.granularityGroup.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        ovState.granularity = btn.getAttribute("data-granularity");
        ovState.granularityManual = true;
        const topFolders = computeTopNVolumeFolders();
        renderPanelAB(topFolders);
        if (ovState.panelEReady) renderPanelE(topFolders);
      });
    });

    dom.topnGroup.querySelectorAll("button[data-topn]").forEach((btn) => {
      btn.addEventListener("click", () => {
        dom.topnGroup.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        ovState.topN = Number(btn.getAttribute("data-topn"));
        recomputeAll();
      });
    });

    dom.metricGroup.querySelectorAll("button[data-metric]").forEach((btn) => {
      btn.addEventListener("click", () => {
        dom.metricGroup.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        ovState.metric = btn.getAttribute("data-metric");
        renderPanelC();
      });
    });

    dom.showOthers.addEventListener("change", () => {
      ovState.showOthers = dom.showOthers.checked;
      const topFolders = computeTopNVolumeFolders();
      renderPanelAB(topFolders);
      if (ovState.panelEReady) renderPanelE(topFolders);
      renderPanelC();
    });
  }

  /* ------------------------------------------------------------
   * 初回表示
   * ------------------------------------------------------------ */
  function init() {
    bindDom();
    attachEvents();
    setupLazyPanels();

    Promise.all([
      ensureMetricLoaded("market"),
      ensureMetricLoaded("volume")
    ]).then(() => {
      ovState.initialized = true;
      recomputeAll();
    }).catch((err) => {
      console.error("Overview load error:", err);
      dom.rankingTbody.innerHTML = `<tr><td colspan="6" class="text-center">総覧データの読み込みに失敗しました。</td></tr>`;
    });
  }

  function onShow() {
    if (!ovState.initialized) {
      init();
    }
  }

  console.info("FiNANCiE TIMES overview v" + OV_APP_VERSION);
  window.FinancieOverview = {
    onShow,
    OVERVIEW_CONFIG,
    // 検査用（tests/check_overview.js から参照）。本番の見た目には影響しない。
    _debug: { state: ovState, charts: ovCharts, data: ovData }
  };
})();
