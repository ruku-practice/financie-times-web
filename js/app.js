document.addEventListener("DOMContentLoaded", () => {
  const pageType = window.PAGE_TYPE || 'volume'; // 'volume' or 'members'
  let rankingData = null;
  let projectMap = {};
  let showAll = false;

  // DOM Elements
  const loader = document.getElementById("loader-container");
  const dashboard = document.getElementById("dashboard-content");
  const rankingTbody = document.getElementById("ranking-tbody");
  const toggle30Btn = document.getElementById("toggle-30");
  const toggleAllBtn = document.getElementById("toggle-all");

  const headerTitleEl = document.getElementById("header-title");
  const headerDateEl = document.getElementById("header-date");
  const headerTimeEl = document.getElementById("header-time");

  // Normalize project names for safe mapping
  const normalizeProjectName = (name) => {
    if (!name) return "";
    return name.replace(/&amp;/g, "&")
               .replace(/&lt;/g, "<")
               .replace(/&gt;/g, ">")
               .replace(/&quot;/g, '"')
               .replace(/&#39;/g, "'")
               .replace(/\s+/g, "")
               .toLowerCase();
  };

  // Fetch projects summary first, then fetch rankings
  Promise.all([
    fetch('data/projects_summary.json').then(res => res.json()),
    fetch('data/ranking_daily.json').then(res => res.json())
  ])
  .then(([summaryList, dailyData]) => {
    // 1. Build Project map for logo & links lookup
    summaryList.forEach(proj => {
      const norm = normalizeProjectName(proj.name);
      projectMap[norm] = {
        folder: proj.folder,
        slug: proj.slug,
        logo: proj.logo,
        name: proj.name
      };
    });

    rankingData = dailyData;

    const htmlData = pageType === 'volume' ? rankingData.html1 : rankingData.html2;

    // 2. Setup Header Metadata (Extracted dynamically from Sheet Row 2 & Row 3)
    if (htmlData && htmlData.length > 2) {
      // Row 2 Title e.g. "FiNANCiE TIMES -出来高(24h)順-"
      const sheetTitle = htmlData[0][2] || (pageType === 'volume' ? "FiNANCiE TIMES -出来高(24h)順-" : "FiNANCiE TIMES -メンバー数増順-");
      if (headerTitleEl) headerTitleEl.textContent = sheetTitle;

      // Row 2 date value (e.g. "20260626" at index 18)
      const dateVal = htmlData[0][18] || rankingData.latest_date || "";
      if (headerDateEl && dateVal) {
        headerDateEl.textContent = dateVal;
      }

      // Row 3 time value (e.g. "00:04" at index 18)
      const timeVal = htmlData[1][18] || "0:00";
      if (headerTimeEl) {
        headerTimeEl.textContent = timeVal;
      }
    }

    // Hide loader and show dashboard
    loader.classList.add("hidden");
    dashboard.classList.remove("hidden");

    render();
  })
  .catch(error => {
    console.error("Data loading error:", error);
    loader.innerHTML = `
      <div style="color: var(--bg-red); font-size: 40px; margin-bottom: 10px;">⚠️</div>
      <p style="color: var(--bg-red); font-weight: bold;">データの読み込みに失敗しました。</p>
      <p style="color: #666; font-size: 12px; margin-top: 5px;">${error.message}</p>
    `;
  });

  // Toggle events
  if (toggle30Btn && toggleAllBtn) {
    toggle30Btn.addEventListener("click", () => {
      if (showAll) {
        showAll = false;
        toggle30Btn.classList.add("active");
        toggleAllBtn.classList.remove("active");
        render();
      }
    });

    toggleAllBtn.addEventListener("click", () => {
      if (!showAll) {
        showAll = true;
        toggleAllBtn.classList.add("active");
        toggle30Btn.classList.remove("active");
        render();
      }
    });
  }

  // Render main times-table content
  function render() {
    if (!rankingData) return;
    rankingTbody.innerHTML = "";

    const htmlData = pageType === 'volume' ? rankingData.html1 : rankingData.html2;
    if (!htmlData || htmlData.length <= 4) {
      rankingTbody.innerHTML = `
        <tr>
          <td colspan="13" style="text-align: center; padding: 2rem;">表示可能なデータが存在しません。</td>
        </tr>
      `;
      return;
    }

    // Skip first 4 rows (Row 2, Row 3 title metadata, Row 5, Row 6 header labels) and get data rows
    const dataRows = htmlData.slice(4);
    const limit = showAll ? dataRows.length : Math.min(30, dataRows.length);
    const visibleRows = dataRows.slice(0, limit);

    visibleRows.forEach(row => {
      // Row formatting matching HTML1 / HTML2 arrays (19 elements)
      const tr = document.createElement("tr");

      // 1. Rank (index 0)
      const tdRank = document.createElement("td");
      tdRank.className = "text-center bold";
      tdRank.textContent = row[0] || "";
      tr.appendChild(tdRank);

      // 2. PJ Cell (index 2)
      const tdPj = document.createElement("td");
      tdPj.className = "label-cell";
      
      const container = document.createElement("div");
      container.className = "pj-name-container";
      
      const rawName = row[2] || "";
      const norm = normalizeProjectName(rawName);
      const projInfo = projectMap[norm];

      // PJのアイコン画像を表示
      if (projInfo && projInfo.logo) {
        const logoImg = document.createElement("img");
        logoImg.src = projInfo.logo;
        logoImg.alt = rawName;
        logoImg.className = "pj-img";
        logoImg.onerror = () => {
          logoImg.style.display = "none";
        };
        container.appendChild(logoImg);
      }
      
      const link = document.createElement("a");
      link.className = "pj-name-txt";
      if (projInfo) {
        const slugRaw = projInfo.slug || projInfo.folder || "";
        const cleanSlug = slugRaw.replace(/^\d+_/, "");
        if (cleanSlug) {
          // PJのリンクを押すと FiNANCiE のそれぞれのPJプロフィール画面に飛ぶようにする
          link.href = `https://financie.jp/users/${cleanSlug}`;
          link.target = "_blank";
          link.rel = "noopener";
        } else {
          link.href = "#";
          link.style.pointerEvents = "none";
        }
      } else {
        link.href = "#";
        link.style.pointerEvents = "none";
      }
      link.textContent = rawName;

      container.appendChild(link);
      tdPj.appendChild(container);
      tr.appendChild(tdPj);

      // Helper to add classes (+ / - background coloring)
      // Excludes pure 0 updates like (0.0), (0) from coloring
      const setDiffClass = (el, text) => {
        const trimmed = text ? text.trim() : "";
        if (trimmed === "" || trimmed === "0" || trimmed === "(0)" || trimmed === "(0.0)") {
          return; // No color for flat changes
        }
        if (trimmed.startsWith("+") || trimmed.startsWith("(+")) {
          el.classList.add("up");
        } else if (trimmed.startsWith("-") || trimmed.startsWith("(-")) {
          el.classList.add("down");
        }
      };

      // 4. Vol 24h Val (index 3)
      const tdVol24Val = document.createElement("td");
      tdVol24Val.className = "value-cell";
      tdVol24Val.textContent = row[3] || "";
      tr.appendChild(tdVol24Val);

      // 5. Vol 24h Diff (index 4)
      const tdVol24Diff = document.createElement("td");
      tdVol24Diff.className = "diff-cell";
      tdVol24Diff.textContent = row[4] || "";
      setDiffClass(tdVol24Diff, row[4]);
      tr.appendChild(tdVol24Diff);

      // 6. Base Price Val (index 10)
      const tdBasePriceVal = document.createElement("td");
      tdBasePriceVal.className = "value-cell";
      tdBasePriceVal.textContent = row[10] || "";
      tr.appendChild(tdBasePriceVal);

      // 7. Base Price Diff (index 11)
      const tdBasePriceDiff = document.createElement("td");
      tdBasePriceDiff.className = "diff-cell";
      tdBasePriceDiff.textContent = row[11] || "";
      setDiffClass(tdBasePriceDiff, row[11]);
      tr.appendChild(tdBasePriceDiff);

      // 8. Current Price Val (index 12)
      const tdCurrPriceVal = document.createElement("td");
      tdCurrPriceVal.className = "value-cell";
      tdCurrPriceVal.textContent = row[12] || "";
      tr.appendChild(tdCurrPriceVal);

      // 9. Current Price Diff (index 13)
      const tdCurrPriceDiff = document.createElement("td");
      tdCurrPriceDiff.className = "diff-cell";
      tdCurrPriceDiff.textContent = row[13] || "";
      setDiffClass(tdCurrPriceDiff, row[13]);
      tr.appendChild(tdCurrPriceDiff);

      // 10. Members Val (index 15)
      const tdMembersVal = document.createElement("td");
      tdMembersVal.className = "value-cell";
      tdMembersVal.textContent = row[15] || "";
      tr.appendChild(tdMembersVal);

      // 11. Members Diff (index 16)
      const tdMembersDiff = document.createElement("td");
      tdMembersDiff.className = "diff-cell";
      tdMembersDiff.textContent = row[16] || "";
      setDiffClass(tdMembersDiff, row[16]);
      tr.appendChild(tdMembersDiff);

      // 12. Token Stock Val (index 17)
      const tdStockVal = document.createElement("td");
      tdStockVal.className = "value-cell";
      tdStockVal.textContent = row[17] || "";
      tr.appendChild(tdStockVal);

      // 13. Token Stock Diff (index 18)
      const tdStockDiff = document.createElement("td");
      tdStockDiff.className = "diff-cell";
      tdStockDiff.textContent = row[18] || "";
      setDiffClass(tdStockDiff, row[18]);
      tr.appendChild(tdStockDiff);

      rankingTbody.appendChild(tr);
    });
  }
});
