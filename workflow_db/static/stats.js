const statsState = {
  options: { base_models: [], loras: [] },
  filteredModels: [],
  modelMenuOpen: false,
  modelActiveIndex: -1,
};

async function statsFetchJson(url) {
  const response = await fetch(apiUrl(url));
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

function statsEscapeHtml(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fillStatsSelect(select, values, placeholder) {
  select.innerHTML = `<option value="">${placeholder}</option>`;
  values.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  });
}

function fillStatsDatalist(datalist, values) {
  datalist.innerHTML = values.map((value) => `<option value="${statsEscapeHtml(value)}"></option>`).join("");
}

function statsElementValue(id) {
  const element = document.getElementById(id);
  if (!element || typeof element.value !== "string") {
    return "";
  }
  return element.value.trim();
}

function statsElementChecked(id) {
  const element = document.getElementById(id);
  return Boolean(element && element.checked);
}

function currentStatsQuery() {
  const params = new URLSearchParams();
  const baseModel = statsElementValue("statsModelComboboxInput");
  const fromDate = statsElementValue("statsFromDate");
  const toDate = statsElementValue("statsToDate");
  if (baseModel) params.set("base_model", baseModel);
  if (fromDate) params.set("from_date", fromDate);
  if (toDate) params.set("to_date", toDate);
  if (statsElementChecked("statsIncludeQualityToggle")) {
    params.set("include_quality", "true");
  }
  return params;
}

function formatStatsSyncStatus(status) {
  const progress = status.progress || {};
  if (status.running) {
    const discovered = progress.discovered == null ? 0 : progress.discovered;
    const skipped = progress.skipped == null ? 0 : progress.skipped;
    const added = progress.new == null ? 0 : progress.new;
    const changed = progress.changed == null ? 0 : progress.changed;
    const removed = progress.removed == null ? 0 : progress.removed;
    const failed = progress.failed == null ? 0 : progress.failed;
    return {
      state: "扫描中",
      detail: `${progress.stage || "scan"} · 扫描 ${discovered} / 跳过 ${skipped} / 新增 ${added} / 变更 ${changed} / 删除 ${removed} / 失败 ${failed}`,
    };
  }
  return {
    state: "空闲",
    detail: status.last_finished_at || status.last_checked_at || "未同步",
  };
}

function renderStatsSyncSummary(status) {
  const stateEl = document.getElementById("syncSummaryState");
  const detailEl = document.getElementById("syncSummaryDetail");
  if (!stateEl || !detailEl) {
    return;
  }
  const formatted = formatStatsSyncStatus(status);
  stateEl.textContent = formatted.state;
  detailEl.textContent = formatted.detail;
}

async function loadStatsSyncStatus() {
  const status = await statsFetchJson("/api/sync-status");
  renderStatsSyncSummary(status);
}

function renderStatsTable(containerId, columns, rows, emptyText) {
  const container = document.getElementById(containerId);
  if (!rows.length) {
    container.innerHTML = `<div class="empty">${emptyText}</div>`;
    return;
  }

  container.innerHTML = `
    <table class="stats-table">
      <thead>
        <tr>${columns.map((column) => `<th>${statsEscapeHtml(column.label)}</th>`).join("")}</tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (row) => `
              <tr>
                ${columns
                  .map((column) => {
                    const value = row[column.key] == null ? "" : row[column.key];
                    return `<td>${column.pre ? `<pre class="stats-pre">${statsEscapeHtml(value)}</pre>` : statsEscapeHtml(value)}</td>`;
                  })
                  .join("")}
              </tr>
            `
          )
          .join("")}
      </tbody>
    </table>
  `;
}

async function loadStatsPage() {
  const params = currentStatsQuery();
  const limit = statsElementValue("statsLimitSelect") || "50";
  const focusLora = statsElementValue("statsFocusLoraInput");

  const frequencyParams = new URLSearchParams(params);
  frequencyParams.set("limit", limit);

  const profileParams = new URLSearchParams(params);
  profileParams.set("limit", limit);
  if (focusLora) {
    profileParams.set("focus_lora", focusLora);
  }

  const [frequency, profile] = await Promise.all([
    statsFetchJson(`/api/stats/lora-frequency?${frequencyParams}`),
    focusLora
      ? statsFetchJson(`/api/stats/lora-profile?${profileParams}`)
      : Promise.resolve({ co_loras: [], prompts: [], total_docs: 0 }),
  ]);

  document.getElementById("statsTotalDocs").textContent = frequency.total_docs || 0;
  document.getElementById("statsFocusDocs").textContent = profile.total_docs || 0;
  document.getElementById("statsTargetDocs").textContent = (profile.prompts || []).length || 0;

  renderStatsTable(
    "statsLoraFrequency",
    [
      { key: "label", label: "LoRA" },
      { key: "doc_hits", label: "次数" },
      { key: "percentage", label: "使用率 %" },
    ],
    frequency.items || [],
    "暂无数据"
  );

  renderStatsTable(
    "statsLoraCooccurrence",
    [
      { key: "label", label: "LoRA" },
      { key: "doc_hits", label: "次数" },
      { key: "percentage", label: "搭配率 %" },
    ],
    profile.co_loras || [],
    focusLora ? "暂无数据" : "请选择焦点 LoRA"
  );

  renderStatsTable(
    "statsPromptLayers",
    [
      { key: "label", label: "Layer", pre: true },
      { key: "count", label: "出现次数" },
      { key: "doc_hits", label: "文档数" },
      { key: "percentage", label: "使用率 %" },
      { key: "density", label: "密度" },
    ],
    profile.prompts || [],
    focusLora ? "暂无数据" : "请选择焦点 LoRA"
  );
}

async function bootStats() {
  const options = await statsFetchJson("/api/options");
  statsState.options = options;
  await loadStatsSyncStatus();
  await loadStatsPage();

  const refresh = () => {
    const button = document.getElementById("statsApplyBtn");
    setButtonLoading(button, true);
    loadStatsPage()
      .catch((error) => {
        showToast(error.message, { type: "error" });
      })
      .finally(() => {
        setButtonLoading(button, false);
      });
  };

  document.getElementById("statsApplyBtn").addEventListener("click", () => {
    refresh();
  });
  document.getElementById("statsIncludeQualityToggle").addEventListener("change", () => {
    refresh();
  });
  ["statsFocusLoraInput", "statsFromDate", "statsToDate"].forEach((id) => {
    const element = document.getElementById(id);
    if (!element) {
      return;
    }
    element.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        refresh();
      }
    });
  });
  ["statsLimitSelect"].forEach((id) => {
    const element = document.getElementById(id);
    if (!element) {
      return;
    }
    element.addEventListener("change", () => {
      refresh();
    });
  });

  // 焦点 LoRA 统一使用 combo 候选组件(存在性守卫:工厂缺失时跳过绑定,
  // 避免 TypeError 中断整页 boot)
  const statsComboFactory = window.aaLoraCombo || window.wfdbLoraCombo;
  if (typeof statsComboFactory === "function") {
    statsComboFactory({
      input: document.getElementById("statsFocusLoraInput"),
      menu: document.getElementById("statsFocusLoraMenu"),
      toggle: document.getElementById("statsFocusLoraToggle"),
      getOptions: () => statsState.options?.loras || [],
      onSelect: (value) => {
        document.getElementById("statsFocusLoraInput").value = value;
        refresh();
      },
    });
  }

  // 基座模型筛选:输入即筛选(输入串为子串匹配,多 checkpoint 命中全部返回);
  // 候选下拉仅用于点击精确选择;Enter/Escape/外部点击仅收拢菜单不还原输入
  function openStatsModelMenu() {
    document.getElementById("statsModelComboboxMenu").hidden = false;
    statsState.modelMenuOpen = true;
  }
  function closeStatsModelMenu() {
    document.getElementById("statsModelComboboxMenu").hidden = true;
    statsState.modelMenuOpen = false;
    statsState.modelActiveIndex = -1;
  }
  function renderStatsModelMenu(filterValue = "") {
    const menu = document.getElementById("statsModelComboboxMenu");
    const normalizedFilter = filterValue.trim().toLowerCase();
    const models = statsState.options.base_models || [];
    statsState.filteredModels = normalizedFilter
      ? models.filter((value) => value.toLowerCase().includes(normalizedFilter))
      : models.slice();
    if (!statsState.filteredModels.length) {
      menu.innerHTML = '<div class="combo-empty">没有匹配的模型</div>';
      statsState.modelActiveIndex = -1;
      return;
    }
    if (statsState.modelActiveIndex >= statsState.filteredModels.length) {
      statsState.modelActiveIndex = 0;
    }
    menu.innerHTML = statsState.filteredModels
      .map(
        (value, index) => `
          <button
            class="combo-option ${index === statsState.modelActiveIndex ? "is-active" : ""}"
            type="button"
            data-stats-model-option="${statsEscapeHtml(value)}"
          >
            ${statsEscapeHtml(value)}
          </button>
        `
      )
      .join("");
  }
  function applyStatsModelSelection(value) {
    statsModelInput.value = value || "";
    document.getElementById("statsModelClearBtn").hidden = !statsModelInput.value.trim();
    closeStatsModelMenu();
    refresh();
  }
  const statsModelInput = document.getElementById("statsModelComboboxInput");
  statsModelInput.addEventListener("focus", () => {
    renderStatsModelMenu(statsModelInput.value);
    openStatsModelMenu();
  });
  statsModelInput.addEventListener("input", () => {
    document.getElementById("statsModelClearBtn").hidden = !statsModelInput.value.trim();
    renderStatsModelMenu(statsModelInput.value);
    openStatsModelMenu();
  });
  statsModelInput.addEventListener("keydown", (event) => {
    if (!statsState.modelMenuOpen && (event.key === "ArrowDown" || event.key === "Enter")) {
      openStatsModelMenu();
      renderStatsModelMenu(statsModelInput.value);
      event.preventDefault();
      return;
    }
    if (!statsState.modelMenuOpen || !statsState.filteredModels.length) {
      return;
    }
    if (event.key === "ArrowDown") {
      statsState.modelActiveIndex = Math.min(statsState.modelActiveIndex + 1, statsState.filteredModels.length - 1);
      renderStatsModelMenu(statsModelInput.value);
      event.preventDefault();
    } else if (event.key === "ArrowUp") {
      statsState.modelActiveIndex = Math.max(statsState.modelActiveIndex - 1, 0);
      renderStatsModelMenu(statsModelInput.value);
      event.preventDefault();
    } else if (event.key === "Enter") {
      // 提交当前输入串(子串匹配,不折叠为单个候选)
      closeStatsModelMenu();
      refresh();
      event.preventDefault();
    } else if (event.key === "Escape") {
      closeStatsModelMenu();
    }
  });
  document.getElementById("statsModelComboboxToggle").addEventListener("click", () => {
    if (statsState.modelMenuOpen) {
      closeStatsModelMenu();
      return;
    }
    renderStatsModelMenu(statsModelInput.value);
    openStatsModelMenu();
    statsModelInput.focus();
  });
  document.getElementById("statsModelComboboxMenu").addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-stats-model-option]");
    if (!trigger) {
      return;
    }
    applyStatsModelSelection(trigger.dataset.statsModelOption);
  });
  document.getElementById("statsModelClearBtn").addEventListener("click", () => {
    applyStatsModelSelection("");
  });
  document.addEventListener("click", (event) => {
    if (event.target.closest("#statsModelCombobox")) {
      return;
    }
    closeStatsModelMenu();
  });
  window.setInterval(() => {
    loadStatsSyncStatus().catch(() => {});
  }, 5000);
}

bootStats().catch((error) => {
  const container = document.getElementById("statsLoraFrequency");
  if (container) {
    container.innerHTML = `<div class="empty">加载失败: ${statsEscapeHtml(error.message)}</div>`;
  }
  showToast(error.message, { type: "error" });
});
