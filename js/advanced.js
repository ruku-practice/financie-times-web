
  const APP_VERSION = "3.2.4";
  console.info("FiNANCiE TIMES v" + APP_VERSION);

  let projectsList = [];
  let currentProjectFolder = null;
  let currentProjectData = null;
  let currentPeriod = 30; // default 30 days
  let volumeFullScale = false; // 24H 取引量グラフを実寸（縦軸の上限なし）で見るか

  // 検査用（tests/check_overview.js から参照）。本番の見た目には影響しない。
  window.FinancieAdvanced = { _debug: { charts: () => ({ price: priceChart, volume: volumeChart, combined: combinedChart, compareVolume: compareVolumeChart }) } };
  let currentTab = "overview-tab"; // 'overview-tab', 'single-tab', 'compare-tab', 'daily-tab', 'monthly-tab'

  // 複数比較用の状態
  let selectedCompareFolders = []; // 最大10個
  let comparePeriod = 30;

  // タイムトラベル用の状態
  let travelDate = ""; // "YYYY-MM-DD"
  let travelSort = "volume"; // DAILY_SORTS のキー＝"volume" / "members" / "price_rate" / "price_diff"
  let dailyData = []; // 現在ロードされている日の全データ
  let showAllDaily = false;
  let dailyCollectedMap = {}; // { "YYYYMMDD": "ISO日時" } 各日の取得日時
  let latestCollectedMeta = null; // history_meta.json の latest_collected（最新日の取得日時フォールバック）

  // 月次ランキング用の状態
  let monthlyPeriod = "all_time"; // YYYYMM or "all_time"
  let monthlyData = [];
  let showAllMonthly = false;

  // Chart instances
  let priceChart = null;
  let volumeChart = null;
  let combinedChart = null;

  let comparePriceChart = null;
  let compareVolumeChart = null;
  let compareMembersChart = null;
  let compareStockChart = null;

  // DOM Elements
  const projectListContainer = document.getElementById("project-list-container");
  const searchInput = document.getElementById("search-input");
  const welcomeView = document.getElementById("welcome-view");
  const detailView = document.getElementById("detail-view");
  const compareView = document.getElementById("compare-view");
  const dailyTravelView = document.getElementById("daily-travel-view");
  const monthlyRankingsView = document.getElementById("monthly-rankings-view");
  const overviewView = document.getElementById("overview-view");
  const analysisView = document.getElementById("analysis-view"); // 分析タブ（js/analysis.js）
  const dashboardLayout = document.querySelector(".dashboard-layout");

  // タブボタン
  const tabButtons = document.querySelectorAll(".tab-nav-btn");

  // 比較モード用 DOM
  const compareNotice = document.getElementById("compare-notice");
  const selectedCompareBadges = document.getElementById("selected-compare-badges");
  const compareChartsArea = document.getElementById("compare-charts-area");
  const comparePeriodButtons = document.querySelectorAll(".compare-period-btn");

  // タイムトラベル用 DOM
  const btnPrevDay = document.getElementById("btn-prev-day");
  const btnNextDay = document.getElementById("btn-next-day");
  const btnLatestDay = document.getElementById("btn-latest-day");
  const travelDatePicker = document.getElementById("travel-date-picker");
  // 日付別ランキングの並べ替え釦だけを拾う（全体市況の期間・粒度・上位・指標の釦も .sort-tab-btn を持つため、
  // クラスだけで拾うと全体市況で押したときに travelSort が null になり、並びがメンバー増加数順に落ちていた＝2026-09-13 ルク 08:36）
  const sortTabButtons = document.querySelectorAll(".sort-criteria-group .sort-tab-btn[data-sort]");
  const historicRankingTbody = document.getElementById("historic-ranking-tbody");
  const dailySortNote = document.getElementById("daily-sort-note");
  const btnLoadMoreDaily = document.getElementById("btn-load-more-daily");
  const travelInfo = document.getElementById("travel-info");

  // 月次用 DOM
  const monthlySelect = document.getElementById("monthly-select");
  const monthlyRankingTbody = document.getElementById("monthly-ranking-tbody");
  const btnLoadMoreMonthly = document.getElementById("btn-load-more-monthly");

  // Metric card elements
  const metricPrice = document.getElementById("metric-price");
  const metricPriceSub = document.getElementById("metric-price-sub");
  const metricVolume = document.getElementById("metric-volume");
  const metricVolumeSub = document.getElementById("metric-volume-sub");
  const metricMembers = document.getElementById("metric-members");
  const metricMembersSub = document.getElementById("metric-members-sub");
  const metricStock = document.getElementById("metric-stock");
  const metricMarketcapSub = document.getElementById("metric-marketcap-sub");

  // Detail header elements
  const detailLogo = document.getElementById("detail-logo");
  const detailName = document.getElementById("detail-name");
  const detailSlug = document.getElementById("detail-slug");
  const periodButtons = document.querySelectorAll(".period-btn");

  // Pinned slugs
  const PINNED_SLUGS = [
    "cryptoninjagames",
    "tmaz",
    "cnpninjadao",
    "gachiho",
    "orochi_cnp",
    "ninjadaoplus",
    "nagisa",
    "kiyoshi_token"
  ];

  // カラーパレット (最大10個)
  const COMPARE_COLORS = [
    "#2563eb", // Blue
    "#10b981", // Green
    "#f59e0b", // Yellow
    "#f87171", // Red
    "#7c3aed", // Purple
    "#ec4899", // Pink
    "#06b6d4", // Cyan
    "#f97316", // Orange
    "#14b8a6", // Teal
    "#64748b"  // Slate
  ];

  // 数値フォーマッタ
  const formatNumber = (num) => {
    if (num === undefined || num === null) return "-";
    return Number(num).toLocaleString('ja-JP');
  };

  const formatFloat = (num, decimals = 4) => {
    if (num === undefined || num === null) return "-";
    return Number(num).toLocaleString('ja-JP', { 
      minimumFractionDigits: decimals, 
      maximumFractionDigits: decimals 
    });
  };

  // 差分のフォーマット＝日本の会計表記（上昇「+」・下落「▲」・表示の桁で0になるものは「±0」・値が無いときは「-」）
  // ▲を上昇に使うとマイナスに読める（ルク 2026-09-13 13:27）。符号は表示する桁で丸めた値から決める（「+0.00%」を出さない）
  const roundForDisplay = (diff, decimals) => {
    const f = Math.pow(10, decimals);
    return Math.round(Math.abs(diff) * f) / f;
  };
  const formatDiffText = (diff, isPercent = false, decimals = 0) => {
    if (typeof diff !== "number" || !isFinite(diff)) return "-";
    const suffix = isPercent ? "%" : "";
    if (diff === 0) return `±0${suffix}`;
    const mark = diff > 0 ? "+" : "▲";
    const shown = roundForDisplay(diff, decimals);
    // 動いたのに表示の桁では0になるもの＝「±0」にすると動かなかったように読める→「+0.01%未満」（Astra 相談 2026-09-13）
    if (shown === 0) return `${mark}${decimals > 0 ? formatFloat(Math.pow(10, -decimals), decimals) : "1"}${suffix}未満`;
    return `${mark}${decimals > 0 ? formatFloat(shown, decimals) : formatNumber(shown)}${suffix}`;
  };

  // 価格の桁：1円未満は小数4桁（0.0317→0.0335円が両方「0.03」に見えて +5.7% が不自然になるのを防ぐ）・1円以上は2桁
  const priceDecimals = (v) => (typeof v === "number" && isFinite(v) && Math.abs(v) < 1 ? 4 : 2);

  // グラフの文字色（背景の白黒に合わせる。トグルは overview.js）
  // 色の正本は css/advanced.css の CSS 変数（js/theme.js の FtTheme で読む・読めないときは既定値）＝v3.2.0
  const themeColor = (name, fallback) => (window.FtTheme ? window.FtTheme.color(name, fallback) : fallback);
  const chartTextColor = () => themeColor("--chart-tick", document.documentElement.getAttribute("data-theme") === "dark" ? "#9ca3af" : "#4b5563");

  const getDiffClass = (diff) => {
    if (typeof diff !== "number" || !isFinite(diff) || diff === 0) return "diff-flat";
    return diff > 0 ? "diff-up" : "diff-down";
  };

  // 価格の前日比［％］＝前日差 ÷ 前日価格（前日価格＝現在価格−前日差）。前日価格が0以下・値が無いときは null
  const priceRateOf = (item) => {
    const p = item.price, d = item.price_diff;
    if (typeof p !== "number" || typeof d !== "number" || !isFinite(p) || !isFinite(d)) return null;
    const base = p - d;
    return base > 0 ? (d / base) * 100 : null;
  };

  // 日付別ランキングの並べ替え（v3.2.4 で価格の2つを追加・ルク 2026-09-13 13:27）。
  // 価格の2つは足切り＝24H出来高1,000円以上かつ前日価格が分かる PJ だけ。価格の下限は置かない
  // （Astra 相談 13:34：出来高100円の売買で +5.7% のような順位を外す。0.1円の下限は根拠が弱く件数もほぼ変わらない）
  const DAILY_PRICE_MIN_VOLUME = 1000;
  const isPriceRankable = (item) => typeof item.volume_24h === "number" && item.volume_24h >= DAILY_PRICE_MIN_VOLUME && priceRateOf(item) !== null;
  const DAILY_SORTS = {
    volume: { value: (item) => item.volume_24h },
    members: { value: (item) => item.members_diff },
    price_rate: { value: priceRateOf, rankable: isPriceRankable },
    price_diff: { value: (item) => item.price_diff, rankable: isPriceRankable }
  };

  // 指標カードの補足を「まとまり」ごとの span にする（span の中は折り返さない＝css/layout.css の .metric-sub .nw）
  const setSubParts = (el, parts) => {
    el.textContent = "";
    parts.forEach((text) => {
      const span = document.createElement("span");
      span.className = "nw";
      span.textContent = text;
      el.appendChild(span);
    });
  };

  // N/A対応
  const cleanRank = (rank) => {
    if (!rank || rank === "-") return "圏外";
    return `${rank}位`;
  };

  // プロジェクト概要ロード
  fetch('data/projects_summary.json')
    .then(response => {
      if (!response.ok) throw new Error("Failed to load project summary");
      return response.json();
    })
    .then(data => {
      projectsList = data;
      renderProjectList(projectsList);
      lucide.createIcons();

      // URLパラメータのチェック (?project=...) があるときだけ個別分析タブへ。
      // 無ければ初期タブ＝日付別ランキング（projectsList 読込完了後に切り替える）
      const urlParams = new URLSearchParams(window.location.search);
      const initialProject = urlParams.get('project');
      if (initialProject) {
        switchTab("single-tab");
        selectProject(initialProject);
      } else {
        // 旧「分析」タブ（?tab=analysis）は合体 v3.2.3 で全体市況に入った＝全体市況を出し、URL から tab だけ消す（ほかのキーは残す・ルク決裁 12:33）
        if (urlParams.get('tab') === 'analysis' && window.history && window.history.replaceState) {
          urlParams.delete('tab');
          const qs = urlParams.toString();
          window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`);
        }
        switchTab("overview-tab");
      }
    })
    .catch(error => {
      console.error("Error loading project summary:", error);
      projectListContainer.innerHTML = `<div style="padding: 1rem; color: var(--accent-danger);">データの読み込みに失敗しました。</div>`;
    });

  // 各日の取得日時マップ（新パイプラインが出力。無ければ空でフォールバック）
  fetch('data/daily_collected.json')
    .then(r => r.ok ? r.json() : {})
    .then(m => { dailyCollectedMap = m || {}; updateTravelInfo(travelDate ? travelDate.replace(/-/g, "") : null); })
    .catch(() => { dailyCollectedMap = {}; });

  // 最新日の取得日時フォールバック（history_meta.json）
  fetch('data/history_meta.json')
    .then(r => r.ok ? r.json() : null)
    .then(meta => { latestCollectedMeta = meta && meta.latest_collected ? meta.latest_collected : null; updateTravelInfo(travelDate ? travelDate.replace(/-/g, "") : null); })
    .catch(() => { latestCollectedMeta = null; });

  // 運用からのお知らせ（新プロジェクト発見・更新エラー）→ 日付別ランキング上部
  fetch('data/site_notices.json')
    .then(r => r.ok ? r.json() : null)
    .then(d => renderSiteNotices(d && Array.isArray(d.notices) ? d.notices : []))
    .catch(() => {});

  // 検索イベント
  searchInput.addEventListener("input", (e) => {
    const query = e.target.value.toLowerCase().trim();
    const filtered = projectsList.filter(proj => 
      proj.name.toLowerCase().includes(query) || 
      proj.slug.toLowerCase().includes(query)
    );
    renderProjectList(filtered);
  });

  // 期間選択イベント
  periodButtons.forEach(btn => {
    btn.addEventListener("click", (e) => {
      periodButtons.forEach(b => b.classList.remove("active"));
      e.target.classList.add("active");
      
      const days = e.target.getAttribute("data-days");
      currentPeriod = days === "all" ? "all" : parseInt(days);
      
      if (currentProjectData) {
        updateCharts();
      }
    });
  });

  // 24H 取引量グラフの「実寸で見る／上限をつけて見る」
  const volumeCapToggle = document.getElementById("volume-cap-toggle");
  if (volumeCapToggle) {
    volumeCapToggle.addEventListener("click", () => {
      volumeFullScale = !volumeFullScale;
      if (currentProjectData) updateCharts();
    });
  }

  // プロジェクトリストレンダリング
  function renderProjectList(list) {
    projectListContainer.innerHTML = "";

    if (list.length === 0) {
      projectListContainer.innerHTML = `<div style="padding: 1rem; text-align: center; color: var(--text-secondary);">該当するプロジェクトが見つかりません</div>`;
      return;
    }

    const defaultLogo = 'https://financie.jp/assets/img/ogp.png';

    // ピン留めとその他に分類
    const pinnedList = [];
    const otherList = [];

    list.forEach(proj => {
      if (PINNED_SLUGS.includes(proj.slug.toLowerCase())) {
        pinnedList.push(proj);
      } else {
        otherList.push(proj);
      }
    });

    // 描画ヘルパー
    const appendProjectItem = (proj, isPinned) => {
      const item = document.createElement("div");
      
      const isSelected = selectedCompareFolders.includes(proj.folder);
      const isActive = currentProjectFolder === proj.folder;
      
      let itemClass = "project-item";
      if (isPinned) itemClass += " pinned";
      if (currentTab === "compare-tab") {
        if (isSelected) itemClass += " selected";
      } else {
        if (isActive) itemClass += " active";
      }
      item.className = itemClass;
      item.setAttribute("data-folder", proj.folder);
      
      const changeColor = proj.member_change_24h > 0 
        ? "var(--accent-success)" 
        : proj.member_change_24h < 0 ? "var(--accent-danger)" : "var(--text-secondary)";

      // チェックボックス領域（比較モード時のみ表示）
      const checkboxHtml = currentTab === "compare-tab" 
        ? `<div class="project-item-checkbox"></div>` 
        : "";

      // 📌アイコン（ピン留め時のみ表示）
      const pinnedIconHtml = isPinned 
        ? `<i data-lucide="pin" class="pinned-icon"></i>` 
        : "";

      item.innerHTML = `
        ${checkboxHtml}
        <img class="project-item-logo" src="${proj.logo || defaultLogo}" alt="${proj.name}" onerror="this.src='${defaultLogo}'">
        <div class="project-item-info">
          <div class="project-item-name">${proj.name}</div>
          <div class="project-item-meta">
            <span class="project-item-price">${formatFloat(proj.price, 4)} 円</span>
            <span style="color: ${changeColor}">${formatDiffText(proj.member_change_24h)}人</span>
          </div>
        </div>
        ${pinnedIconHtml}
      `;

      item.addEventListener("click", () => {
        if (currentTab === "compare-tab") {
          toggleCompareProject(proj.folder);
        } else {
          selectProject(proj.folder);
        }
      });

      projectListContainer.appendChild(item);
    };

    // ピン留めプロジェクトの描画
    if (pinnedList.length > 0) {
      const title = document.createElement("div");
      title.className = "project-group-title";
      title.innerHTML = `<i data-lucide="pin" style="width: 14px; height: 14px;"></i> 注目プロジェクト`;
      projectListContainer.appendChild(title);
      pinnedList.forEach(proj => appendProjectItem(proj, true));
    }

    // その他のプロジェクトの描画
    if (otherList.length > 0) {
      const title = document.createElement("div");
      title.className = "project-group-title all-projects";
      title.textContent = "プロジェクト一覧";
      projectListContainer.appendChild(title);
      otherList.forEach(proj => appendProjectItem(proj, false));
    }

    lucide.createIcons();
  }

  // プロジェクト選択処理 (個別モード用)
  function selectProject(folder) {
    currentProjectFolder = folder;
    volumeFullScale = false; // 「実寸で見る」は案件ごと（別の案件へ移ったら上限つきに戻す・断 v3.1 中1）
    
    // サイドバーのactive切り替え
    const items = projectListContainer.querySelectorAll(".project-item");
    items.forEach(item => {
      if (item.getAttribute("data-folder") === folder) {
        item.classList.add("active");
      } else {
        item.classList.remove("active");
      }
    });

    // プロジェクト詳細データ取得
    fetch(`data/projects/${folder}.json`)
      .then(response => {
        if (!response.ok) throw new Error("Failed to load project details");
        return response.json();
      })
      .then(data => {
        currentProjectData = data;
        welcomeView.classList.add("hidden-element");
        detailView.classList.remove("hidden-element");
        
        // ヘッダー情報セット
        const defaultLogo = 'https://financie.jp/assets/img/ogp.png';
        detailLogo.src = data.logo || defaultLogo;
        detailLogo.onerror = () => { detailLogo.src = defaultLogo; };
        detailName.textContent = data.name;
        detailSlug.textContent = `@${data.slug}`;
        // 本家 FiNANCiE のプロジェクトページ（新しいタブ・v3.1 項目4）
        const detailFinancieLink = document.getElementById("detail-financie-link");
        if (detailFinancieLink) {
          detailFinancieLink.href = `https://financie.jp/users/${encodeURIComponent(data.slug)}`;
          detailFinancieLink.setAttribute("aria-label", `${data.name} を FiNANCiEで見る（新しいタブ）`);
        }
        // データ取得開始日（その案件の最古の記録日）＝それ以前のデータは持っていない
        const detailFirst = document.getElementById("detail-first");
        if (detailFirst) {
          const firstRec = (data.history || []).reduce((m, r) => (r && r.date && (!m || r.date < m)) ? r.date : m, null);
          detailFirst.textContent = firstRec ? `データ取得開始 ${firstRec.slice(0, 4)}/${firstRec.slice(4, 6)}/${firstRec.slice(6, 8)}（それ以前の記録は持っていません）` : "";
        }

        // 指標カードセット
        updateMetrics();
        // チャート描画
        updateCharts();
      })
      .catch(error => {
        console.error("Error loading project details:", error);
      });
  }

  // 指標カードの更新
  function updateMetrics() {
    if (!currentProjectData || currentProjectData.history.length === 0) return;
    
    const history = currentProjectData.history;
    const latest = history[history.length - 1];
    
    // 現在価格
    metricPrice.textContent = `${formatFloat(latest.price, 4)} 円`;
    
    // 価格変化（円の差＝前日差・％＝前日比。記号は日付別ランキングと同じ「+」「▲」＝v3.2.4）
    if (history.length > 1) {
      const prev = history[history.length - 2];
      const diff = latest.price - prev.price;
      const pct = prev.price > 0 ? (diff / prev.price) * 100 : null;
      const colorClass = diff > 0 ? "up" : diff < 0 ? "down" : "";

      metricPriceSub.className = `metric-sub ${colorClass}`;
      // 語の途中で折り返さないよう、まとまりごとに span（エマ v3.2.4 中2・軽2＝単位の前に空白なし・括弧は全角）
      setSubParts(metricPriceSub, [`前日差: ${formatDiffText(diff, false, 4)}円`, `（前日比 ${formatDiffText(pct, true, 2)}）`]);
    } else {
      metricPriceSub.className = "metric-sub";
      metricPriceSub.textContent = "前日差: -";
    }

    // 24H 出来高
    metricVolume.textContent = `${formatFloat(latest.volume, 2)} 円`;
    
    // 累計取引量
    metricVolumeSub.textContent = `累計出来高: ${formatFloat(latest.volume, 2)} 円`;

    // メンバー数
    metricMembers.textContent = `${formatNumber(latest.members)} 人`;
    
    // メンバー数変化
    if (history.length > 1) {
      const prev = history[history.length - 2];
      const diff = latest.members - prev.members;
      const colorClass = diff > 0 ? "up" : diff < 0 ? "down" : "";

      metricMembersSub.className = `metric-sub ${colorClass}`;
      setSubParts(metricMembersSub, [`前日差: ${formatDiffText(diff)}人`, `（アクティブ: ${cleanRank(latest.active_ranking)}）`]);
    } else {
      metricMembersSub.className = "metric-sub";
      metricMembersSub.textContent = `アクティブ: ${cleanRank(latest.active_ranking)}`;
    }

    // トークン在庫
    metricStock.textContent = `${formatNumber(latest.stock)} 円`;
    metricMarketcapSub.textContent = `時価総額: ¥${formatNumber(latest.marketCap)}`;
  }

  // "YYYYMMDD" → "YYYY/MM/DD"
  const fmtYmd = (s) => (s && s.length === 8 ? `${s.slice(0, 4)}/${s.slice(4, 6)}/${s.slice(6, 8)}` : s);

  // 24H 取引量の縦軸：期間内の最大が p95 の VOLUME_CAP_RATIO 倍を超えるときだけ、上限＝ceil(p95×VOLUME_CAP_MULT)。
  // 値の根拠＝Astra（Codex）の実測（2026-09-13・全409件）：CNG 全期間は28.0倍で切り、1年・90日（4.2倍・2.7倍）は切らない。
  // p95 が 0 の案件（まれにしか取引が無い）は切らない（上限が 0 になり棒が全部消えるため）。データは直さない（v3.1 項目1）。
  const VOLUME_CAP_RATIO = 20;
  const VOLUME_CAP_MULT = 1.5;
  function volumeAxisCap(values) {
    const v = values.filter(x => typeof x === "number" && isFinite(x) && x >= 0).sort((a, b) => a - b);
    if (v.length < 2) return null;
    const max = v[v.length - 1];
    const pos = (v.length - 1) * 0.95;
    const lo = Math.floor(pos);
    const p95 = v[lo] + (v[Math.min(lo + 1, v.length - 1)] - v[lo]) * (pos - lo);
    if (!(p95 > 0) || max <= VOLUME_CAP_RATIO * p95) return null;
    const cap = Math.ceil(VOLUME_CAP_MULT * p95);
    return { cap, max, maxIndex: values.indexOf(max), overCount: values.filter(x => typeof x === "number" && x > cap).length };
  }

  // 上限を超えた棒の上端に ▲ を描く（Chart.js のインラインプラグイン）
  function capMarkerPlugin(cap) {
    return {
      id: "ftVolumeCapMarks",
      afterDatasetsDraw(chart) {
        const meta = chart.getDatasetMeta(0);
        const values = chart.data.datasets[0].data;
        const { ctx, chartArea } = chart;
        ctx.save();
        ctx.fillStyle = themeColor("--cap-marker", "#f59e0b");
        meta.data.forEach((bar, i) => {
          if (!(values[i] > cap)) return;
          const top = chartArea.top + 1;
          ctx.beginPath();
          ctx.moveTo(bar.x, top);
          ctx.lineTo(bar.x - 5, top + 8);
          ctx.lineTo(bar.x + 5, top + 8);
          ctx.closePath();
          ctx.fill();
        });
        ctx.restore();
      }
    };
  }

  function renderVolumeCapNote(capInfo, rows) {
    const box = document.getElementById("volume-cap-note");
    if (!box) return;
    if (!capInfo) { box.hidden = true; return; }
    const text = document.getElementById("volume-cap-text");
    const btn = document.getElementById("volume-cap-toggle");
    const maxDay = rows[capInfo.maxIndex] ? fmtYmd(rows[capInfo.maxIndex].date) : "";
    const maxYen = Math.round(capInfo.max).toLocaleString("ja-JP");
    box.hidden = false;
    if (volumeFullScale) {
      text.textContent = `実寸で表示中です（いちばん大きい日 ${maxDay} の ${maxYen} 円に縦軸を合わせているため、ほかの日の棒は低く見えます）。`;
      btn.textContent = "上限をつけて見る";
    } else {
      // 「▲」は増減の下落の記号なので使わない（エマ v3.2.4 軽3）＝棒の上端に描く三角の印を言葉で呼ぶ
      text.textContent = `棒の上端の印＝縦軸の上限（${Math.round(capInfo.cap).toLocaleString("ja-JP")} 円）を超えた日（${capInfo.overCount}日・棒は上端で切れています）。いちばん大きい日：${maxDay} ${maxYen} 円。`;
      btn.textContent = "実寸で見る";
    }
    btn.setAttribute("aria-pressed", String(volumeFullScale));
  }

  // チャートの更新
  function updateCharts() {
    if (!currentProjectData || currentProjectData.history.length === 0) return;

    let data = [...currentProjectData.history];
    
    // 期間フィルタリング
    if (currentPeriod !== "all") {
      const cutoffIndex = Math.max(0, data.length - currentPeriod);
      data = data.slice(cutoffIndex);
    }

    const labels = data.map(d => {
      const dateStr = d.date;
      if (dateStr.length === 8) {
        return `${dateStr.substring(4, 6)}/${dateStr.substring(6, 8)}`;
      }
      return dateStr;
    });

    const prices = data.map(d => d.price);
    const volumes = data.map(d => d.volume);
    const members = data.map(d => d.members);
    const stocks = data.map(d => d.stock);

    // 1. 価格チャート
    const priceCtx = document.getElementById("priceChart").getContext("2d");
    if (priceChart) priceChart.destroy();
    
    const priceGradient = priceCtx.createLinearGradient(0, 0, 0, 300);
    priceGradient.addColorStop(0, themeColor("--price-gradient-top", 'rgba(37, 99, 235, 0.4)'));
    priceGradient.addColorStop(1, themeColor("--price-gradient-bottom", 'rgba(37, 99, 235, 0.0)'));

    priceChart = new Chart(priceCtx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: '現在価格',
          data: prices,
          borderColor: '#2563eb',
          borderWidth: 2,
          pointRadius: labels.length > 50 ? 0 : 2,
          pointHoverRadius: 6,
          backgroundColor: priceGradient,
          fill: true,
          tension: 0.15
        }]
      },
      options: getCommonOptions()
    });

    // 2. 出来高チャート
    const volumeCtx = document.getElementById("volumeChart").getContext("2d");
    if (volumeChart) volumeChart.destroy();

    const volumeGradient = volumeCtx.createLinearGradient(0, 0, 0, 300);
    volumeGradient.addColorStop(0, themeColor("--volume-gradient-top", 'rgba(37, 99, 235, 0.65)'));
    volumeGradient.addColorStop(1, themeColor("--volume-gradient-bottom", 'rgba(37, 99, 235, 0.15)'));

    // 期間の中に突出があるときだけ縦軸に上限（v3.1 項目1）。上限を超えた棒は上端で切り、▲と注記で実値を示す
    const volumeCap = volumeAxisCap(volumes);
    const capOn = volumeCap !== null && !volumeFullScale;
    const volumeOptions = getCommonOptions();
    volumeOptions.plugins.tooltip.callbacks = {
      title: (items) => (items.length && data[items[0].dataIndex] ? fmtYmd(data[items[0].dataIndex].date) : ""),
      label: (item) => `24H 出来高: ${formatFloat(item.raw, 2)} 円${capOn && item.raw > volumeCap.cap ? "（縦軸の上限を超えています）" : ""}`
    };
    if (capOn) {
      volumeOptions.scales.y.min = 0;
      volumeOptions.scales.y.max = volumeCap.cap;
    }
    renderVolumeCapNote(volumeCap, data); // 注記でカードの高さが変わるので、グラフより先に出す

    volumeChart = new Chart(volumeCtx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: '24H 出来高',
          data: volumes,
          backgroundColor: volumeGradient,
          borderRadius: 4,
          borderWidth: 0
        }]
      },
      options: volumeOptions,
      plugins: capOn ? [capMarkerPlugin(volumeCap.cap)] : []
    });

    // 3. メンバー数 ＆ 在庫数チャート
    const combinedCtx = document.getElementById("combinedChart").getContext("2d");
    if (combinedChart) combinedChart.destroy();

    combinedChart = new Chart(combinedCtx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'メンバー数 (人)',
            data: members,
            borderColor: themeColor("--series-members", '#10b981'),
            borderWidth: 2,
            pointRadius: labels.length > 50 ? 0 : 2,
            pointHoverRadius: 6,
            yAxisID: 'y-members',
            fill: false,
            tension: 0.15
          },
          {
            label: 'トークン在庫 (個)',
            data: stocks,
            borderColor: themeColor("--series-stock", '#f59e0b'),
            borderWidth: 2,
            pointRadius: labels.length > 50 ? 0 : 2,
            pointHoverRadius: 6,
            yAxisID: 'y-stock',
            fill: false,
            tension: 0.15
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }, // 凡例はカードの下のHTML（js/chart-legend.js・v3.1 項目3）
          tooltip: {
            mode: 'index',
            intersect: false
          }
        },
        scales: {
          x: {
            grid: { color: themeColor("--chart-grid-y", 'rgba(255, 255, 255, 0.05)') },
            ticks: { color: chartTextColor(), maxTicksLimit: 12 }
          },
          'y-members': {
            type: 'linear',
            position: 'left',
            grid: { color: themeColor("--chart-grid-y", 'rgba(255, 255, 255, 0.05)') },
            ticks: { color: themeColor("--series-members", '#10b981') },
            title: {
              display: true,
              text: 'メンバー数 (人)',
              color: themeColor("--series-members", '#10b981')
            }
          },
          'y-stock': {
            type: 'linear',
            position: 'right',
            grid: { display: false },
            ticks: { color: themeColor("--series-stock", '#f59e0b') },
            title: {
              display: true,
              text: 'トークン在庫 (個)',
              color: themeColor("--series-stock", '#f59e0b')
            }
          }
        }
      }
    });
    if (window.FtLegend) window.FtLegend.render(combinedChart, document.getElementById("legend-combined"), "single:combined");
  }

  // 共通のグラフ設定オプション
  function getCommonOptions() {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false,
          backgroundColor: themeColor("--tooltip-bg", 'rgba(19, 26, 38, 0.9)'),
          titleColor: themeColor("--tooltip-text", '#f3f4f6'),
          bodyColor: themeColor("--tooltip-text", '#e5e7eb'),
          borderColor: themeColor("--tooltip-border", 'rgba(255, 255, 255, 0.1)'),
          borderWidth: 1,
          padding: 10
        }
      },
      scales: {
        x: {
          grid: { color: themeColor("--chart-grid-x", 'rgba(255, 255, 255, 0.03)') },
          ticks: { color: chartTextColor(), maxTicksLimit: 12 }
        },
        y: {
          grid: { color: themeColor("--chart-grid-y", 'rgba(255, 255, 255, 0.05)') },
          ticks: { color: chartTextColor() }
        }
      }
    };
  }

  /* -------------------------------------------------------------
   * 複数プロジェクト比較機能
   * ------------------------------------------------------------- */
  function toggleCompareProject(folder) {
    const idx = selectedCompareFolders.indexOf(folder);
    if (idx > -1) {
      selectedCompareFolders.splice(idx, 1);
    } else {
      if (selectedCompareFolders.length >= 10) {
        alert("比較できるプロジェクトは最大10個までです。");
        return;
      }
      selectedCompareFolders.push(folder);
    }

    // リストのクラス更新
    const items = projectListContainer.querySelectorAll(".project-item");
    items.forEach(item => {
      const f = item.getAttribute("data-folder");
      if (selectedCompareFolders.includes(f)) {
        item.classList.add("selected");
      } else {
        item.classList.remove("selected");
      }
    });

    updateCompareBadges();
    updateCompareCharts();
  }

  function updateCompareBadges() {
    selectedCompareBadges.innerHTML = "";
    
    if (selectedCompareFolders.length === 0) {
      selectedCompareBadges.innerHTML = `<div class="no-selection-placeholder">左側のリストから比較するプロジェクトを選択してください（最大10個）</div>`;
      return;
    }

    selectedCompareFolders.forEach((folder, index) => {
      const proj = projectsList.find(p => p.folder === folder);
      if (!proj) return;

      const badge = document.createElement("div");
      badge.className = "compare-badge";
      badge.innerHTML = `
        <span class="compare-badge-color" style="background-color: ${COMPARE_COLORS[index % COMPARE_COLORS.length]}"></span>
        <span>${proj.name}</span>
        <span class="compare-badge-remove">&times;</span>
      `;

      badge.querySelector(".compare-badge-remove").addEventListener("click", (e) => {
        e.stopPropagation();
        toggleCompareProject(folder);
      });

      selectedCompareBadges.appendChild(badge);
    });
  }

  function updateCompareCharts() {
    if (selectedCompareFolders.length === 0) {
      compareChartsArea.style.display = "none";
      return;
    }
    compareChartsArea.style.display = "grid";

    // プロジェクトデータを並列ロード
    const promises = selectedCompareFolders.map(folder => 
      fetch(`data/projects/${folder}.json`).then(r => r.json())
    );

    Promise.all(promises)
      .then(datasetsData => {
        renderCompareCharts(datasetsData);
      })
      .catch(err => {
        console.error("Error loading comparison data:", err);
      });
  }

  function renderCompareCharts(dataList) {
    if (dataList.length === 0) return;

    // 最もデータ数が多いヒストリデータから日付を取得する
    const longestHistory = dataList.reduce((max, d) => d.history.length > max.history.length ? d : max, dataList[0]);
    let referenceHistory = [...longestHistory.history];

    if (comparePeriod !== "all") {
      const cutoffIndex = Math.max(0, referenceHistory.length - comparePeriod);
      referenceHistory = referenceHistory.slice(cutoffIndex);
    }

    const labels = referenceHistory.map(d => {
      const dateStr = d.date;
      if (dateStr.length === 8) {
        return `${dateStr.substring(4, 6)}/${dateStr.substring(6, 8)}`;
      }
      return dateStr;
    });

    // 各PJのデータセット作成
    const priceDatasets = [];
    const volumeDatasets = [];
    const membersDatasets = [];
    const stockDatasets = [];

    dataList.forEach((projData, index) => {
      const color = COMPARE_COLORS[index % COMPARE_COLORS.length];
      
      const historyMap = {};
      projData.history.forEach(h => {
        historyMap[h.date] = h;
      });

      const prices = [];
      const volumes = [];
      const members = [];
      const stocks = [];

      referenceHistory.forEach(ref => {
        const h = historyMap[ref.date];
        if (h) {
          prices.push(h.price);
          volumes.push(h.volume);
          members.push(h.members);
          stocks.push(h.stock);
        } else {
          prices.push(null);
          volumes.push(null);
          members.push(null);
          stocks.push(null);
        }
      });

      const commonConfig = {
        label: projData.name,
        ftId: projData.folder || selectedCompareFolders[index], // 凡例の記憶の識別子（同名の案件があるため名前では区別しない）
        borderColor: color,
        backgroundColor: color,
        borderWidth: 2,
        pointRadius: labels.length > 50 ? 0 : 2,
        pointHoverRadius: 6,
        fill: false,
        tension: 0.15
      };

      priceDatasets.push({ ...commonConfig, data: prices });
      volumeDatasets.push({ ...commonConfig, data: volumes });
      membersDatasets.push({ ...commonConfig, data: members });
      stockDatasets.push({ ...commonConfig, data: stocks });
    });

    // グラフ生成
    const priceCtx = document.getElementById("comparePriceChart").getContext("2d");
    if (comparePriceChart) comparePriceChart.destroy();
    comparePriceChart = new Chart(priceCtx, {
      type: 'line',
      data: { labels: labels, datasets: priceDatasets },
      options: getCommonCompareOptions("価格 (円)")
    });

    const volumeCtx = document.getElementById("compareVolumeChart").getContext("2d");
    if (compareVolumeChart) compareVolumeChart.destroy();
    compareVolumeChart = new Chart(volumeCtx, {
      type: 'line',
      data: { labels: labels, datasets: volumeDatasets },
      options: getCommonCompareOptions("出来高 (円)")
    });

    const membersCtx = document.getElementById("compareMembersChart").getContext("2d");
    if (compareMembersChart) compareMembersChart.destroy();
    compareMembersChart = new Chart(membersCtx, {
      type: 'line',
      data: { labels: labels, datasets: membersDatasets },
      options: getCommonCompareOptions("メンバー数 (人)")
    });

    const stockCtx = document.getElementById("compareStockChart").getContext("2d");
    if (compareStockChart) compareStockChart.destroy();
    compareStockChart = new Chart(stockCtx, {
      type: 'line',
      data: { labels: labels, datasets: stockDatasets },
      options: getCommonCompareOptions("トークン在庫 (個)")
    });
    renderCompareLegends();
  }

  // 比較の4枚は同じ案件の集まりなので、凡例の記憶キーを1つ共有する＝1枚で消すと4枚とも消える（v3.1 項目3）
  function renderCompareLegends() {
    if (!window.FtLegend) return;
    const pairs = [
      [comparePriceChart, "legend-comparePriceChart"],
      [compareVolumeChart, "legend-compareVolumeChart"],
      [compareMembersChart, "legend-compareMembersChart"],
      [compareStockChart, "legend-compareStockChart"]
    ];
    const syncAll = () => pairs.forEach(([ch, id]) => window.FtLegend.render(ch, document.getElementById(id), "compare", { onChange: syncAll }));
    syncAll();
  }

  function getCommonCompareOptions(yTitle) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }, // 凡例はカードの下のHTML（js/chart-legend.js・v3.1 項目3）
        tooltip: {
          mode: 'index',
          intersect: false,
          backgroundColor: themeColor("--tooltip-bg", 'rgba(19, 26, 38, 0.9)'),
          titleColor: themeColor("--tooltip-text", '#f3f4f6'),
          bodyColor: themeColor("--tooltip-text", '#e5e7eb'),
          borderColor: themeColor("--tooltip-border", 'rgba(255, 255, 255, 0.1)'),
          borderWidth: 1,
          padding: 10
        }
      },
      scales: {
        x: {
          grid: { color: themeColor("--chart-grid-x", 'rgba(255, 255, 255, 0.03)') },
          ticks: { color: chartTextColor(), maxTicksLimit: 12 }
        },
        y: {
          grid: { color: themeColor("--chart-grid-y", 'rgba(255, 255, 255, 0.05)') },
          ticks: { color: chartTextColor() },
          title: {
            display: true,
            text: yTitle,
            color: chartTextColor()
          }
        }
      }
    };
  }

  /* -------------------------------------------------------------
   * 運用からのお知らせ（日付別ランキング上部のバナー）
   * ------------------------------------------------------------- */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function renderSiteNotices(notices) {
    const box = document.getElementById("site-notices");
    if (!box) return;
    // JSTの今日 (YYYY-MM-DD)。期限当日までは表示する
    const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const active = (notices || []).filter(n => {
      if (n.type === "error") return true; // エラーは成功時に消えるまで出し続ける
      return n.expires && n.expires >= today;
    });
    if (!active.length) { box.classList.add("hidden-element"); return; }
    box.innerHTML = active.map(n => {
      if (n.type === "error") {
        const link = n.run_url ? ` <a href="${escapeHtml(n.run_url)}" target="_blank" rel="noopener">実行ログ ↗</a>` : "";
        return `<div class="site-notice notice-error">⚠ データ更新エラー（${escapeHtml(n.date || "")}）: ${escapeHtml(n.message || "")}${link}</div>`;
      }
      const links = (n.projects || []).map(p =>
        `<a class="notice-project-link" href="https://financie.jp/users/${encodeURIComponent(p.slug)}" target="_blank" rel="noopener">${escapeHtml(p.name || p.slug)}</a>`
      ).join("・");
      return `<div class="site-notice notice-new">🎉 新しいプロジェクトを見つけました（${escapeHtml(n.date || "")}）: ${links}</div>`;
    }).join("");
    box.classList.remove("hidden-element");
  }

  /* -------------------------------------------------------------
   * 日付別ランキング (タイムトラベル)
   * ------------------------------------------------------------- */
  function initDailyTravel() {
    if (projectsList.length > 0 && projectsList[0].latest_date) {
      const d = projectsList[0].latest_date;
      travelDate = `${d.substring(0, 4)}-${d.substring(4, 6)}-${d.substring(6, 8)}`;
      travelDatePicker.value = travelDate;
      loadDailyData(d);
    } else {
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(today.getDate()).padStart(2, '0');
      travelDate = `${yyyy}-${mm}-${dd}`;
      travelDatePicker.value = travelDate;
      loadDailyData(`${yyyy}${mm}${dd}`);
    }
  }

  const WEEKDAYS_JP = ["日", "月", "火", "水", "木", "金", "土"];

  // "YYYYMMDD" → "YYYY/MM/DD(曜)"
  function fmtDateKeyJp(dateKey) {
    if (!dateKey || dateKey.length !== 8) return dateKey || "";
    const y = dateKey.slice(0, 4), m = dateKey.slice(4, 6), d = dateKey.slice(6, 8);
    const w = new Date(`${y}-${m}-${d}T00:00:00+09:00`).getDay();
    return `${y}/${m}/${d}(${WEEKDAYS_JP[w]})`;
  }

  // "YYYYMMDD" の前日を "YYYYMMDD" で返す
  function prevDateKey(dateKey) {
    if (!dateKey || dateKey.length !== 8) return dateKey || "";
    const y = +dateKey.slice(0, 4), m = +dateKey.slice(4, 6), d = +dateKey.slice(6, 8);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - 1);
    const p = (n) => String(n).padStart(2, "0");
    return `${dt.getUTCFullYear()}${p(dt.getUTCMonth() + 1)}${p(dt.getUTCDate())}`;
  }

  // 指定日(取得日)の取得日時を "YYYY/MM/DD(曜) HH:MM" で返す。時刻不明なら日付のみ。
  function collectedLabel(dateKey) {
    // ISO文字列(+09:00付き)から日付・時刻をそのまま切り出す（既にJST）
    const isoToLabel = (iso) => {
      if (!iso || iso.length < 10) return "";
      const key = iso.slice(0, 10).replace(/-/g, "");
      const hhmm = iso.length >= 16 ? iso.slice(11, 16) : "";
      return `${fmtDateKeyJp(key)}${hhmm ? " " + hhmm : ""}`;
    };
    if (dailyCollectedMap && dailyCollectedMap[dateKey]) return isoToLabel(dailyCollectedMap[dateKey]);
    if (latestCollectedMeta && latestCollectedMeta.date_key === dateKey && latestCollectedMeta.updated_at) {
      return isoToLabel(latestCollectedMeta.updated_at);
    }
    return fmtDateKeyJp(dateKey); // 過去日で時刻未記録 → 取得日(=選択日)のみ
  }

  // タイムトラベルの取得日時・対象日の注記を更新する。
  // FiNANCiE は「選択した日付＝取得日、内容はその前日の結果」。
  function updateTravelInfo(dateKey) {
    if (!travelInfo || !dateKey) return;
    const resultDay = fmtDateKeyJp(prevDateKey(dateKey));
    const collected = collectedLabel(dateKey);
    travelInfo.innerHTML =
      `<span class="travel-info-result">📊 内容は <b>${resultDay}</b> の結果です</span>` +
      `<span class="travel-info-sep">／</span>` +
      `<span class="travel-info-collected">🕐 取得日時: <b>${collected}</b></span>` +
      `<span class="travel-info-note">※ 24時間出来高・各差分は取得時点の前日集計値です</span>`;
  }

  function loadDailyData(dateStr) {
    historicRankingTbody.innerHTML = `<tr><td colspan="12" style="text-align: center; padding: 3rem; color: var(--text-secondary);">データ（${dateStr}）を読み込んでいます...</td></tr>`;
    updateTravelInfo(dateStr);

    fetch(`data/daily/${dateStr}.json`)
      .then(response => {
        if (!response.ok) throw new Error("No data for this date");
        return response.json();
      })
      .then(data => {
        dailyData = data;
        renderDailyTable();
        updateTravelInfo(dateStr);
      })
      .catch(error => {
        console.error("Error loading daily data:", error);
        dailyData = []; // 失敗後に並べ替えを押しても、前に開いていた日の表を出さない（Astra 相談の落とし穴）
        updateDailySortNote(DAILY_SORTS.volume, 0, 0);
        btnLoadMoreDaily.style.display = "none";
        historicRankingTbody.innerHTML = `<tr><td colspan="12" style="text-align: center; padding: 3rem; color: var(--accent-danger);">指定された日付（${dateStr}）のデータが見つかりません。</td></tr>`;
      });
  }

  // 価格の2つの並べ替えのときだけ、足切りの注記と件数を出す（v3.2.4）
  function updateDailySortNote(sortDef, rankedCount, totalCount) {
    if (!dailySortNote) return;
    if (!sortDef.rankable || totalCount === 0) {
      dailySortNote.hidden = true;
      dailySortNote.textContent = "";
      return;
    }
    // 釦の名前を縮めて呼ばない（エマ v3.2.4 軽1）＝「この並べ替えは」
    dailySortNote.textContent = `この並べ替えは、24H 出来高が 1,000円以上で前日価格が分かる PJ だけを、横ばい・下落も含めて並べています（この日 ${rankedCount}件／全${totalCount}件）。`;
    dailySortNote.hidden = false;
  }

  // 並べ替え中の列の見出しに印（aria-sort＝descending・↓は CSS）＝どの列で並んでいるか表から分かる（エマ 日付別 軽3）
  function syncSortHeader() {
    document.querySelectorAll("#daily-travel-view th[data-sort-col]").forEach(th => {
      if (th.getAttribute("data-sort-col") === travelSort) th.setAttribute("aria-sort", "descending");
      else th.removeAttribute("aria-sort");
    });
  }

  function renderDailyTable() {
    syncSortHeader();
    historicRankingTbody.innerHTML = "";
    
    if (dailyData.length === 0) {
      historicRankingTbody.innerHTML = `<tr><td colspan="12" style="text-align: center; padding: 3rem; color: var(--text-secondary);">データがありません</td></tr>`;
      return;
    }

    // 価格の2つは足切りを通った PJ だけを並べる（対象外は表から外し、注記に件数を出す＝Astra 相談の案A）
    const sortDef = DAILY_SORTS[travelSort] || DAILY_SORTS.volume;
    const sorted = sortDef.rankable ? dailyData.filter(sortDef.rankable) : [...dailyData];
    updateDailySortNote(sortDef, sorted.length, dailyData.length);
    if (sorted.length === 0) {
      btnLoadMoreDaily.style.display = "none";
      historicRankingTbody.innerHTML = `<tr><td colspan="12" style="text-align: center; padding: 3rem; color: var(--text-secondary);">この日は並べ替えの対象になる PJ（24H 出来高 1,000円以上）がありません</td></tr>`;
      return;
    }
    // 数でない値（null・文字列）は最後へ。NaN で並びが崩れないように比較する。比べるのは丸める前の値
    const num = (v) => (typeof v === "number" && isFinite(v) ? v : Number.NEGATIVE_INFINITY);
    sorted.sort((a, b) => {
      const x = num(sortDef.value(a)), y = num(sortDef.value(b));
      return x === y ? 0 : (y > x ? 1 : -1);
    });

    const limit = showAllDaily ? sorted.length : 20;
    const listToRender = sorted.slice(0, limit);

    if (showAllDaily || sorted.length <= 20) {
      btnLoadMoreDaily.style.display = "none";
    } else {
      btnLoadMoreDaily.style.display = "inline-block";
      btnLoadMoreDaily.textContent = sortDef.rankable ? `もっと表示する (対象${sorted.length}件)` : `もっと表示する (全${sorted.length}件)`;
    }

    const defaultLogo = 'https://financie.jp/assets/img/ogp.png';

    listToRender.forEach((item, index) => {
      const tr = document.createElement("tr");
      
      const rank = index + 1;
      const logo = item.logo || defaultLogo;
      
      const basePrice = item.price - item.price_diff;
      const volumeK = Math.round(item.volume_24h / 1000);
      const volumeKDiff = typeof item.volume_24h_diff === "number" ? item.volume_24h_diff / 1000 : null; // 丸めは formatDiffText が表示の桁で行う

      // 並べ替え中の列のセルに印（スマホのカードは見出しが無いので、項目名の横に ↓ を出す＝エマ v3.2.4 軽4）
      const sortedAttr = (key) => (key === travelSort ? ' data-sorted="true"' : "");
      const tdVolumeVal = `<td class="text-right bold-text" data-label="24H 出来高［千円］"${sortedAttr("volume")}>${formatNumber(volumeK)}</td>`;
      // 語の使い分け（ルク 2026-09-13 13:27）：％の増減＝「前日比」、差の増減＝「前日差」
      const tdVolumeDiff = `<td class="text-left ${getDiffClass(volumeKDiff)}" data-label="前日差">${formatDiffText(volumeKDiff)}</td>`;

      const basePriceDiffPct = priceRateOf(item);
      const tdBasePriceVal = `<td class="text-right bold-text" data-label="前日価格［円］">${formatFloat(basePrice, priceDecimals(basePrice))}</td>`;
      const tdBasePriceDiff = `<td class="text-left ${getDiffClass(basePriceDiffPct)}" data-label="前日比"${sortedAttr("price_rate")}>${formatDiffText(basePriceDiffPct, true, 2)}</td>`;

      const tdPriceVal = `<td class="text-right bold-text" data-label="現在価格［円］">${formatFloat(item.price, priceDecimals(item.price))}</td>`;
      const tdPriceDiff = `<td class="text-left ${getDiffClass(item.price_diff)}" data-label="前日差"${sortedAttr("price_diff")}>${formatDiffText(item.price_diff, false, priceDecimals(Math.min(item.price, basePrice)))}</td>`;

      const tdMembersVal = `<td class="text-right bold-text" data-label="メンバー数［人］">${formatNumber(item.members)}</td>`;
      const tdMembersDiff = `<td class="text-left ${getDiffClass(item.members_diff)}" data-label="前日差"${sortedAttr("members")}>${formatDiffText(item.members_diff)}</td>`;

      const tdStockVal = `<td class="text-right bold-text" data-label="トークン在庫［個］">${formatNumber(item.stock)}</td>`;
      const tdStockDiff = `<td class="text-left ${getDiffClass(item.stock_diff)}" data-label="前日差">${formatDiffText(item.stock_diff)}</td>`;

      tr.innerHTML = `
        <td class="text-center bold-text" data-label="順位">${rank}</td>
        <td class="text-left" data-label="プロジェクト">
          <a href="?project=${item.folder}" class="table-pj-link" data-folder="${item.folder}">
            <img class="table-pj-img" src="${logo}" alt="${item.name}" onerror="this.src='${defaultLogo}'">
            <span>${item.name}</span>
          </a>
        </td>
        ${tdVolumeVal}
        ${tdVolumeDiff}
        ${tdBasePriceVal}
        ${tdBasePriceDiff}
        ${tdPriceVal}
        ${tdPriceDiff}
        ${tdMembersVal}
        ${tdMembersDiff}
        ${tdStockVal}
        ${tdStockDiff}
      `;

      tr.querySelector(".table-pj-link").addEventListener("click", (e) => {
        e.preventDefault();
        const folder = e.currentTarget.getAttribute("data-folder");
        switchTab("single-tab");
        selectProject(folder);
      });

      historicRankingTbody.appendChild(tr);
    });
  }

  function changeDay(offset) {
    if (!travelDate) return;
    const current = new Date(travelDate);
    current.setDate(current.getDate() + offset);
    
    const yyyy = current.getFullYear();
    const mm = String(current.getMonth() + 1).padStart(2, '0');
    const dd = String(current.getDate()).padStart(2, '0');
    
    travelDate = `${yyyy}-${mm}-${dd}`;
    travelDatePicker.value = travelDate;
    
    showAllDaily = false;
    loadDailyData(`${yyyy}${mm}${dd}`);
  }

  /* -------------------------------------------------------------
   * 月次・累計取引量ランキング
   * ------------------------------------------------------------- */
  function initMonthlyRankings() {
    fetch('data/monthly/list.json')
      .then(response => response.json())
      .then(months => {
        monthlySelect.innerHTML = `<option value="all_time">全期間 (累積出来高ランキング)</option>`;
        
        const sortedMonths = [...months].reverse();
        sortedMonths.forEach(m => {
          const yyyy = m.substring(0, 4);
          const mm = m.substring(4, 6);
          const option = document.createElement("option");
          option.value = m;
          option.textContent = `${yyyy}年${parseInt(mm)}月`;
          monthlySelect.appendChild(option);
        });

        loadMonthlyData();
      })
      .catch(err => {
        console.error("Error loading monthly list:", err);
        loadMonthlyData();
      });
  }

  function loadMonthlyData() {
    monthlyRankingTbody.innerHTML = `<tr><td colspan="3" style="text-align: center; padding: 3rem; color: var(--text-secondary);">ランキングを読み込んでいます...</td></tr>`;
    
    const url = monthlyPeriod === "all_time" 
      ? "data/monthly/all_time.json" 
      : `data/monthly/${monthlyPeriod}.json`;

    fetch(url)
      .then(response => {
        if (!response.ok) throw new Error("Failed to load rankings");
        return response.json();
      })
      .then(data => {
        monthlyData = data;
        renderMonthlyTable();
      })
      .catch(error => {
        console.error("Error loading monthly data:", error);
        monthlyRankingTbody.innerHTML = `<tr><td colspan="3" style="text-align: center; padding: 3rem; color: var(--accent-danger);">データの読み込みに失敗しました。</td></tr>`;
      });
  }

  function renderMonthlyTable() {
    monthlyRankingTbody.innerHTML = "";

    if (monthlyData.length === 0) {
      monthlyRankingTbody.innerHTML = `<tr><td colspan="3" style="text-align: center; padding: 3rem; color: var(--text-secondary);">データがありません</td></tr>`;
      return;
    }

    const limit = showAllMonthly ? monthlyData.length : 20;
    const listToRender = monthlyData.slice(0, limit);

    if (showAllMonthly || monthlyData.length <= 20) {
      btnLoadMoreMonthly.style.display = "none";
    } else {
      btnLoadMoreMonthly.style.display = "inline-block";
      btnLoadMoreMonthly.textContent = `もっと表示する (全${monthlyData.length}件)`;
    }

    const defaultLogo = 'https://financie.jp/assets/img/ogp.png';

    listToRender.forEach((item, index) => {
      const tr = document.createElement("tr");
      const rank = index + 1;
      const logo = item.logo || defaultLogo;

      tr.innerHTML = `
        <td class="text-center bold-text" style="font-size: 14px;" data-label="順位">${rank}</td>
        <td class="text-left" data-label="プロジェクト">
          <a href="?project=${item.folder}" class="table-pj-link" data-folder="${item.folder}">
            <img class="table-pj-img" src="${logo}" alt="${item.name}" onerror="this.src='${defaultLogo}'">
            <span>${item.name}</span>
          </a>
        </td>
        <td class="text-right bold-text" style="font-size: 14px; padding-right: 2rem;" data-label="期間総出来高［円］">${formatFloat(item.total_volume, 2)} 円</td>
      `;

      tr.querySelector(".table-pj-link").addEventListener("click", (e) => {
        e.preventDefault();
        const folder = e.currentTarget.getAttribute("data-folder");
        switchTab("single-tab");
        selectProject(folder);
      });

      monthlyRankingTbody.appendChild(tr);
    });
  }

  /* -------------------------------------------------------------
   * タブ切り替え制御
   * ------------------------------------------------------------- */
  function switchTab(tabId) {
    currentTab = tabId;
    
    tabButtons.forEach(btn => {
      if (btn.getAttribute("data-tab") === tabId) {
        btn.classList.add("active");
      } else {
        btn.classList.remove("active");
      }
    });

    welcomeView.classList.add("hidden-element");
    detailView.classList.add("hidden-element");
    compareView.classList.add("hidden-element");
    dailyTravelView.classList.add("hidden-element");
    monthlyRankingsView.classList.add("hidden-element");
    overviewView.classList.add("hidden-element");
    if (analysisView) analysisView.classList.add("hidden-element");

    if (tabId === "overview-tab" || tabId === "analysis-tab") { // 旧「分析」タブは外した（v3.2.3）＝来ても全体市況
      dashboardLayout.classList.add("no-sidebar");
      overviewView.classList.remove("hidden-element");
      if (window.FinancieOverview && typeof window.FinancieOverview.onShow === "function") {
        window.FinancieOverview.onShow();
      }
    } else if (tabId === "single-tab") {
      dashboardLayout.classList.remove("no-sidebar");
      compareNotice.classList.add("hidden-element");
      if (currentProjectData) {
        detailView.classList.remove("hidden-element");
        if (singleChartsThemeStale) { singleChartsThemeStale = false; updateCharts(); } // 隠れている間にテーマが変わった
      } else {
        welcomeView.classList.remove("hidden-element");
      }
    } else if (tabId === "compare-tab") {
      dashboardLayout.classList.remove("no-sidebar");
      compareNotice.classList.remove("hidden-element");
      compareView.classList.remove("hidden-element");
      updateCompareBadges();
      updateCompareCharts();
    } else if (tabId === "daily-tab") {
      dashboardLayout.classList.add("no-sidebar");
      dailyTravelView.classList.remove("hidden-element");
      if (dailyData.length === 0) {
        initDailyTravel();
      }
    } else if (tabId === "monthly-tab") {
      dashboardLayout.classList.add("no-sidebar");
      monthlyRankingsView.classList.remove("hidden-element");
      if (monthlyData.length === 0) {
        initMonthlyRankings();
      }
    }

    renderProjectList(projectsList);
  }

  tabButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.getAttribute("data-tab");
      switchTab(tab);
    });
  });

  // 比較タブ内の期間選択
  comparePeriodButtons.forEach(btn => {
    btn.addEventListener("click", (e) => {
      comparePeriodButtons.forEach(b => b.classList.remove("active"));
      e.target.classList.add("active");
      
      const days = e.target.getAttribute("data-days");
      comparePeriod = days === "all" ? "all" : parseInt(days);
      
      if (selectedCompareFolders.length > 0) {
        updateCompareCharts();
      }
    });
  });

  // タイムトラベル用のイベント登録
  btnPrevDay.addEventListener("click", () => changeDay(-1));
  btnNextDay.addEventListener("click", () => changeDay(1));
  btnLatestDay.addEventListener("click", () => {
    if (projectsList.length > 0 && projectsList[0].latest_date) {
      const d = projectsList[0].latest_date;
      travelDate = `${d.substring(0, 4)}-${d.substring(4, 6)}-${d.substring(6, 8)}`;
      travelDatePicker.value = travelDate;
      showAllDaily = false;
      loadDailyData(d);
    }
  });

  travelDatePicker.addEventListener("change", (e) => {
    travelDate = e.target.value;
    if (travelDate) {
      const dateStr = travelDate.replace(/-/g, "");
      showAllDaily = false;
      loadDailyData(dateStr);
    }
  });

  sortTabButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      // 押した釦そのもの（e.target は中の要素になりうる）・値は DAILY_SORTS のキーだけ受け付ける
      const key = btn.getAttribute("data-sort");
      travelSort = Object.prototype.hasOwnProperty.call(DAILY_SORTS, key) ? key : "volume";
      sortTabButtons.forEach(b => {
        const on = b.getAttribute("data-sort") === travelSort;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", String(on));
      });
      syncSortHeader();
      renderDailyTable();
    });
  });

  btnLoadMoreDaily.addEventListener("click", () => {
    showAllDaily = true;
    renderDailyTable();
  });

  // テーマの切替（js/theme.js が投げる）＝見えている個別・比較のグラフだけ描き直す。
  // 隠れている個別のグラフは、次にタブを開いたときに描き直す（比較はタブを開くたびに描くので不要）＝v3.2.0
  let singleChartsThemeStale = false;
  window.addEventListener("ft-theme-change", () => {
    if (currentTab === "single-tab" && currentProjectData) updateCharts();
    else if (currentTab === "compare-tab") updateCompareCharts();
    else if (currentProjectData) singleChartsThemeStale = true;
  });

  // 月次用のイベント登録
  monthlySelect.addEventListener("change", (e) => {
    monthlyPeriod = e.target.value;
    showAllMonthly = false;
    loadMonthlyData();
  });

  btnLoadMoreMonthly.addEventListener("click", () => {
    showAllMonthly = true;
    renderMonthlyTable();
  });


