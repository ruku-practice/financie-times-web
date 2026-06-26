document.addEventListener("DOMContentLoaded", () => {
  let projectsList = [];
  let currentProjectFolder = null;
  let currentProjectData = null;
  let currentPeriod = 30; // default 30 days

  // Chart instances
  let priceChart = null;
  let volumeChart = null;
  let combinedChart = null;

  // DOM Elements
  const projectListContainer = document.getElementById("project-list-container");
  const searchInput = document.getElementById("search-input");
  const welcomeView = document.getElementById("welcome-view");
  const detailView = document.getElementById("detail-view");
  
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

    list.forEach(proj => {
      const item = document.createElement("div");
      item.className = `project-item ${currentProjectFolder === proj.folder ? 'active' : ''}`;
      item.setAttribute("data-folder", proj.folder);
      
      const sign = proj.member_change_24h > 0 ? "+" : "";
      const changeColor = proj.member_change_24h > 0 
        ? "var(--accent-success)" 
        : proj.member_change_24h < 0 ? "var(--accent-danger)" : "var(--text-secondary)";

      item.innerHTML = `
        <img class="project-item-logo" src="${proj.logo || defaultLogo}" alt="${proj.name}" onerror="this.src='${defaultLogo}'">
        <div class="project-item-info">
          <div class="project-item-name">${proj.name}</div>
          <div class="project-item-meta">
            <span class="project-item-price">${formatFloat(proj.price, 4)} pt</span>
            <span style="color: ${changeColor}">${sign}${formatNumber(proj.member_change_24h)}人</span>
          </div>
        </div>
      `;

      item.addEventListener("click", () => {
        selectProject(proj.folder);
      });

      projectListContainer.appendChild(item);
    });
  }

  // プロジェクト選択処理
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
      // 最新日から遡ってフィルタリング
      // 日付文字列は "YYYYMMDD"
      // dataはすでに日付昇順にソートされている前提
      const cutoffIndex = Math.max(0, data.length - currentPeriod);
      data = data.slice(cutoffIndex);
    }

    // 日付フォーマット YYYYMMDD -> MM/DD
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

    // 1. 価格チャート (折れ線グラフ、領域グラデーション塗り)
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

    // 2. 出来高チャート (バーチャート)
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

    // 3. メンバー数 ＆ 在庫数チャート (2軸 折れ線)
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
            grid: { display: false }, // グリッドの重複を避ける
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
});
