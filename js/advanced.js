document.addEventListener("DOMContentLoaded", () => {
  let projectsList = [];
  let currentProjectFolder = null;
  let currentProjectData = null;
  let currentPeriod = 30; // default 30 days
  let currentTab = "single-tab"; // 'single-tab', 'compare-tab', 'daily-tab', 'monthly-tab'

  // 複数比較用の状態
  let selectedCompareFolders = []; // 最大10個
  let comparePeriod = 30;

  // タイムトラベル用の状態
  let travelDate = ""; // "YYYY-MM-DD"
  let travelSort = "volume"; // "volume" or "members"
  let dailyData = []; // 現在ロードされている日の全データ
  let showAllDaily = false;

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
  const sortTabButtons = document.querySelectorAll(".sort-tab-btn");
  const historicRankingTbody = document.getElementById("historic-ranking-tbody");
  const btnLoadMoreDaily = document.getElementById("btn-load-more-daily");

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
    "#3b82f6", // Blue
    "#10b981", // Green
    "#f59e0b", // Yellow
    "#ef4444", // Red
    "#8b5cf6", // Purple
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

  // 差分のフォーマット（+ / - とカラー用クラス）
  const formatDiffText = (diff, isPercent = false, decimals = 0) => {
    if (diff === undefined || diff === null || diff === 0) return "-";
    const sign = diff > 0 ? "+" : "";
    const suffix = isPercent ? "%" : "";
    const val = decimals > 0 ? formatFloat(diff, decimals) : formatNumber(diff);
    return `(${sign}${val}${suffix})`;
  };

  const getDiffClass = (diff) => {
    if (!diff || diff === 0) return "";
    return diff > 0 ? "diff-bg-up" : "diff-bg-down";
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

      // URLパラメータのチェック (?project=...)
      const urlParams = new URLSearchParams(window.location.search);
      const initialProject = urlParams.get('project');
      if (initialProject) {
        selectProject(initialProject);
      }
    })
    .catch(error => {
      console.error("Error loading project summary:", error);
      projectListContainer.innerHTML = `<div style="padding: 1rem; color: var(--accent-danger);">データの読み込みに失敗しました。</div>`;
    });

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
      
      const sign = proj.member_change_24h > 0 ? "+" : "";
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
            <span class="project-item-price">${formatFloat(proj.price, 4)} pt</span>
            <span style="color: ${changeColor}">${sign}${formatNumber(proj.member_change_24h)}人</span>
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
        welcomeView.style.display = "none";
        detailView.style.display = "flex";
        
        // ヘッダー情報セット
        const defaultLogo = 'https://financie.jp/assets/img/ogp.png';
        detailLogo.src = data.logo || defaultLogo;
        detailLogo.onerror = () => { detailLogo.src = defaultLogo; };
        detailName.textContent = data.name;
        detailSlug.textContent = `@${data.slug}`;

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
    metricPrice.textContent = `${formatFloat(latest.price, 4)} pt`;
    
    // 価格変化 (前日比)
    if (history.length > 1) {
      const prev = history[history.length - 2];
      const diff = latest.price - prev.price;
      const pct = prev.price > 0 ? (diff / prev.price) * 100 : 0;
      const sign = diff > 0 ? "+" : "";
      const colorClass = diff > 0 ? "up" : diff < 0 ? "down" : "";
      
      metricPriceSub.className = `metric-sub ${colorClass}`;
      metricPriceSub.textContent = `前日比: ${sign}${formatFloat(diff, 4)} pt (${sign}${pct.toFixed(2)}%)`;
    } else {
      metricPriceSub.className = "metric-sub";
      metricPriceSub.textContent = "前日比: -";
    }

    // 24H 出来高
    metricVolume.textContent = `${formatFloat(latest.volume, 2)} pt`;
    
    // 累計取引量
    metricVolumeSub.textContent = `累計取引量: ${formatFloat(latest.volume, 2)} pt`;

    // メンバー数
    metricMembers.textContent = `${formatNumber(latest.members)} 人`;
    
    // メンバー数変化
    if (history.length > 1) {
      const prev = history[history.length - 2];
      const diff = latest.members - prev.members;
      const sign = diff > 0 ? "+" : "";
      const colorClass = diff > 0 ? "up" : diff < 0 ? "down" : "";
      
      metricMembersSub.className = `metric-sub ${colorClass}`;
      metricMembersSub.textContent = `前日比: ${sign}${formatNumber(diff)} 人 (アクティブ: ${cleanRank(latest.active_ranking)})`;
    } else {
      metricMembersSub.className = "metric-sub";
      metricMembersSub.textContent = `アクティブ: ${cleanRank(latest.active_ranking)}`;
    }

    // トークン在庫
    metricStock.textContent = `${formatNumber(latest.stock)} pt`;
    metricMarketcapSub.textContent = `時価総額: ¥${formatNumber(latest.marketCap)}`;
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
    priceGradient.addColorStop(0, 'rgba(59, 130, 246, 0.4)');
    priceGradient.addColorStop(1, 'rgba(59, 130, 246, 0.0)');

    priceChart = new Chart(priceCtx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: '現在価格',
          data: prices,
          borderColor: '#3b82f6',
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
    volumeGradient.addColorStop(0, '#8b5cf6');
    volumeGradient.addColorStop(1, 'rgba(139, 92, 246, 0.2)');

    volumeChart = new Chart(volumeCtx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: '24H 取引量',
          data: volumes,
          backgroundColor: volumeGradient,
          borderRadius: 4,
          borderWidth: 0
        }]
      },
      options: getCommonOptions()
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
            borderColor: '#10b981',
            borderWidth: 2,
            pointRadius: labels.length > 50 ? 0 : 2,
            pointHoverRadius: 6,
            yAxisID: 'y-members',
            fill: false,
            tension: 0.15
          },
          {
            label: 'トークン在庫 (pt)',
            data: stocks,
            borderColor: '#f59e0b',
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
          legend: {
            position: 'top',
            labels: {
              color: '#9ca3af',
              font: { family: 'Outfit, sans-serif' }
            }
          },
          tooltip: {
            mode: 'index',
            intersect: false
          }
        },
        scales: {
          x: {
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: { color: '#9ca3af', maxTicksLimit: 12 }
          },
          'y-members': {
            type: 'linear',
            position: 'left',
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: { color: '#10b981' },
            title: {
              display: true,
              text: 'メンバー数 (人)',
              color: '#10b981'
            }
          },
          'y-stock': {
            type: 'linear',
            position: 'right',
            grid: { display: false },
            ticks: { color: '#f59e0b' },
            title: {
              display: true,
              text: 'トークン在庫 (pt)',
              color: '#f59e0b'
            }
          }
        }
      }
    });
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
          backgroundColor: 'rgba(19, 26, 38, 0.9)',
          titleColor: '#f3f4f6',
          bodyColor: '#e5e7eb',
          borderColor: 'rgba(255, 255, 255, 0.1)',
          borderWidth: 1,
          padding: 10
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.03)' },
          ticks: { color: '#9ca3af', maxTicksLimit: 12 }
        },
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: '#9ca3af' }
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
      options: getCommonCompareOptions("価格 (pt)")
    });

    const volumeCtx = document.getElementById("compareVolumeChart").getContext("2d");
    if (compareVolumeChart) compareVolumeChart.destroy();
    compareVolumeChart = new Chart(volumeCtx, {
      type: 'line',
      data: { labels: labels, datasets: volumeDatasets },
      options: getCommonCompareOptions("出来高 (pt)")
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
      options: getCommonCompareOptions("トークン在庫 (pt)")
    });
  }

  function getCommonCompareOptions(yTitle) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'top',
          labels: {
            color: '#9ca3af',
            font: { size: 11, family: 'Outfit, sans-serif' },
            boxWidth: 12
          }
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          backgroundColor: 'rgba(19, 26, 38, 0.9)',
          titleColor: '#f3f4f6',
          bodyColor: '#e5e7eb',
          borderColor: 'rgba(255, 255, 255, 0.1)',
          borderWidth: 1,
          padding: 10
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.03)' },
          ticks: { color: '#9ca3af', maxTicksLimit: 12 }
        },
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: '#9ca3af' },
          title: {
            display: true,
            text: yTitle,
            color: '#9ca3af'
          }
        }
      }
    };
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

  function loadDailyData(dateStr) {
    historicRankingTbody.innerHTML = `<tr><td colspan="12" style="text-align: center; padding: 3rem; color: var(--text-secondary);">データ（${dateStr}）を読み込んでいます...</td></tr>`;
    
    fetch(`data/daily/${dateStr}.json`)
      .then(response => {
        if (!response.ok) throw new Error("No data for this date");
        return response.json();
      })
      .then(data => {
        dailyData = data;
        renderDailyTable();
      })
      .catch(error => {
        console.error("Error loading daily data:", error);
        historicRankingTbody.innerHTML = `<tr><td colspan="12" style="text-align: center; padding: 3rem; color: var(--accent-danger);">指定された日付（${dateStr}）のデータが見見つかりません。</td></tr>`;
      });
  }

  function renderDailyTable() {
    historicRankingTbody.innerHTML = "";
    
    if (dailyData.length === 0) {
      historicRankingTbody.innerHTML = `<tr><td colspan="12" style="text-align: center; padding: 3rem; color: var(--text-secondary);">データがありません</td></tr>`;
      return;
    }

    const sorted = [...dailyData];
    if (travelSort === "volume") {
      sorted.sort((a, b) => b.volume_24h - a.volume_24h);
    } else {
      sorted.sort((a, b) => b.members_diff - a.members_diff);
    }

    const limit = showAllDaily ? sorted.length : 20;
    const listToRender = sorted.slice(0, limit);

    if (showAllDaily || sorted.length <= 20) {
      btnLoadMoreDaily.style.display = "none";
    } else {
      btnLoadMoreDaily.style.display = "inline-block";
      btnLoadMoreDaily.textContent = `もっと表示する (全${sorted.length}件)`;
    }

    const defaultLogo = 'https://financie.jp/assets/img/ogp.png';

    listToRender.forEach((item, index) => {
      const tr = document.createElement("tr");
      
      const rank = index + 1;
      const logo = item.logo || defaultLogo;
      
      const basePrice = item.price - item.price_diff;
      const volumeK = Math.round(item.volume_24h / 1000);
      const volumeKDiff = Math.round(item.volume_24h_diff / 1000);
      
      const tdVolumeVal = `<td class="text-right bold-text">${formatNumber(volumeK)}</td>`;
      const tdVolumeDiff = `<td class="text-left ${getDiffClass(volumeKDiff)}">${formatDiffText(volumeKDiff)}</td>`;
      
      const basePriceDiffPct = basePrice > 0 ? (item.price_diff / basePrice) * 100 : 0;
      const tdBasePriceVal = `<td class="text-right bold-text">${formatFloat(basePrice, 2)}</td>`;
      const tdBasePriceDiff = `<td class="text-left ${getDiffClass(item.price_diff)}">${formatDiffText(basePriceDiffPct, true, 2)}</td>`;
      
      const tdPriceVal = `<td class="text-right bold-text">${formatFloat(item.price, 2)}</td>`;
      const tdPriceDiff = `<td class="text-left ${getDiffClass(item.price_diff)}">${formatDiffText(item.price_diff, false, 2)}</td>`;
      
      const tdMembersVal = `<td class="text-right bold-text">${formatNumber(item.members)}</td>`;
      const tdMembersDiff = `<td class="text-left ${getDiffClass(item.members_diff)}">${formatDiffText(item.members_diff)}</td>`;
      
      const tdStockVal = `<td class="text-right bold-text">${formatNumber(item.stock)}</td>`;
      const tdStockDiff = `<td class="text-left ${getDiffClass(item.stock_diff)}">${formatDiffText(item.stock_diff)}</td>`;

      tr.innerHTML = `
        <td class="text-center bold-text">${rank}</td>
        <td class="text-left">
          <a href="advanced.html?project=${item.folder}" class="table-pj-link" data-folder="${item.folder}">
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
        <td class="text-center bold-text" style="font-size: 14px;">${rank}</td>
        <td class="text-left">
          <a href="advanced.html?project=${item.folder}" class="table-pj-link" data-folder="${item.folder}">
            <img class="table-pj-img" src="${logo}" alt="${item.name}" onerror="this.src='${defaultLogo}'">
            <span>${item.name}</span>
          </a>
        </td>
        <td class="text-right bold-text" style="font-size: 14px; padding-right: 2rem;">${formatFloat(item.total_volume, 2)} pt</td>
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

    welcomeView.style.display = "none";
    detailView.style.display = "none";
    compareView.style.display = "none";
    dailyTravelView.style.display = "none";
    monthlyRankingsView.style.display = "none";

    if (tabId === "single-tab") {
      dashboardLayout.classList.remove("no-sidebar");
      compareNotice.classList.add("hidden-element");
      if (currentProjectData) {
        detailView.style.display = "flex";
      } else {
        welcomeView.style.display = "flex";
      }
    } else if (tabId === "compare-tab") {
      dashboardLayout.classList.remove("no-sidebar");
      compareNotice.classList.remove("hidden-element");
      compareView.style.display = "flex";
      updateCompareBadges();
      updateCompareCharts();
    } else if (tabId === "daily-tab") {
      dashboardLayout.classList.add("no-sidebar");
      dailyTravelView.style.display = "flex";
      if (dailyData.length === 0) {
        initDailyTravel();
      }
    } else if (tabId === "monthly-tab") {
      dashboardLayout.classList.add("no-sidebar");
      monthlyRankingsView.style.display = "flex";
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
    btn.addEventListener("click", (e) => {
      sortTabButtons.forEach(b => b.classList.remove("active"));
      e.target.classList.add("active");
      
      travelSort = e.target.getAttribute("data-sort");
      renderDailyTable();
    });
  });

  btnLoadMoreDaily.addEventListener("click", () => {
    showAllDaily = true;
    renderDailyTable();
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
});

