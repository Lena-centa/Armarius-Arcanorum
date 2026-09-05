const state = {
  options: { base_models: [], loras: [] },
  optionsLoaded: false,
  previewItem: null,
  previewIndex: 0,
  previewDerived: null,
  previewView: "image",
  page: 1,
  pageSize: 50,
  pageCache: new Map(),
  currentItems: new Map(),
  syncVersionSeen: 0,
  syncPollTimer: null,
  selectedLoras: [], // 正向 LoRA 多选名单
  excludedLoras: [], // 排除 LoRA 多选名单
  loraMode: "or", // 正向组合:or(默认,任一命中)/ and(须全含)
  excludeLoraMode: "and", // 排除组合:and(默认,任一命中即排除)/ or(须全含才排除)
  filteredLoras: [], // 正向候选过滤后列表(瞬态)
  loraMenuOpen: false,
  loraActiveIndex: -1,
  excludeFilteredLoras: [], // 排除候选过滤后列表(瞬态)
  excludeLoraMenuOpen: false,
  excludeLoraActiveIndex: -1,
  filteredModels: [],
  modelMenuOpen: false,
  modelActiveIndex: -1,
  manualSyncPolling: false,
  parseImageBusy: false,
  activeListRequestKey: "",
  defaultGroupMode: "recipe",
  tagIndex: new Map(),
  tagCatalogLoaded: false,
  lastPayload: null, // 最近一次成功渲染的 payload(查询失败时回退,避免骨架悬空)
  totalPages: 1,
  favorites: new Set(), // 已收藏图片 sha256 集合(星标/收藏条索引)
  favoriteCount: 0,
  favoriteMeta: new Map(), // sha256 → 收藏快照({filename,batch_key,captured_at,category,note})
  favoriteItems: [], // 收藏筛选视图数据(最近一次 GET /api/favorites)
  favoriteCategories: [], // 收藏分类列表([{key,label}])
  favoritesOnly: false, // 「只看收藏」筛选开关
  favoriteCategoriesSelected: [], // 收藏分类筛选多选名单(分类 key;空 = 全部分类)
  favoriteCategoryMode: "or", // 收藏分类组合方式 or|and(与 LoRA 同款)
  selection: new Set(), // 列表多选:选中行(batch key)集合,跨页/切视图保留
  selectionData: new Map(), // 列表多选:已解析条目快照(key→entry,跨页后批量操作兜底数据)
};

// 动态即时筛选防抖(条件变化 400ms 后自动查询;手动触发时清除待执行任务)
let filterDebounce = null;

function nowStamp() {
  return new Date().toISOString();
}

function perfLog(label, detail = "") {
  const suffix = detail ? ` ${detail}` : "";
  console.log(`[workflow-db][${nowStamp()}] ${label}${suffix}`);
}

async function measureAsync(label, fn) {
  const started = performance.now();
  perfLog(`${label}:start`);
  try {
    const result = await fn();
    perfLog(`${label}:done`, `${(performance.now() - started).toFixed(1)}ms`);
    return result;
  } catch (error) {
    perfLog(`${label}:fail`, `${(performance.now() - started).toFixed(1)}ms ${error?.message || error}`);
    throw error;
  }
}

async function fetchJson(url, options) {
  return measureAsync(`fetch ${url}`, async () => {
    const response = await fetch(apiUrl(url), options);
    if (!response.ok) {
      // 错误信息带响应体 detail(兼容 message/error 字段;非 JSON 体忽略)
      let detail = "";
      try {
        const body = await response.json();
        detail = body?.detail || body?.message || body?.error || "";
      } catch {
        detail = "";
      }
      throw new Error(`Request failed: ${response.status}${detail ? ` ${detail}` : ""}`);
    }
    return response.json();
  });
}

async function loadTagCatalog() {
  try {
    const payload = await fetchJson("/api/manual-labels?limit=200");
    state.tagIndex = buildTagIndex(payload?.items || []);
    state.tagCatalogLoaded = true;
  } catch (error) {
    // 标签库不可用不影响图片列表和预览的基本读取。
    state.tagIndex = new Map();
    state.tagCatalogLoaded = false;
    perfLog("loadTagCatalog:fail", error?.message || error);
  }
}

function setSyncNotice(visible, title = "", text = "") {
  const notice = document.getElementById("syncNotice");
  const titleEl = document.getElementById("syncNoticeTitle");
  const textEl = document.getElementById("syncNoticeText");
  notice.hidden = !visible;
  if (visible) {
    titleEl.textContent = title || "发现新的生成文件";
    textEl.textContent = text || "";
  }
}

/**
 * 本地时区(浏览器)分钟级时间显示:从 captured_at(UTC ISO)换算为
 * 浏览器本地时区的 "YYYY-MM-DD HH:MM"。captured_at 缺失时回退到
 * created_date + created_hour(UTC 小时口径)。
 */
function formatCapturedAt(capturedAt, fallbackDate, fallbackHour) {
  if (capturedAt) {
    const d = new Date(capturedAt);
    if (!Number.isNaN(d.getTime())) {
      const pad = (n) => String(n).padStart(2, "0");
      const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
  }
  const hour = fallbackHour == null ? "" : ` ${String(fallbackHour).padStart(2, "0")}:00`;
  return `${fallbackDate || ""}${hour}`;
}

function formatSyncStatus(status) {
  const progress = status.progress || {};
  if (status.running) {
    const parts = [
      `扫描 ${progress.discovered ?? 0}`,
      `跳过 ${progress.skipped ?? 0}`,
      `新增 ${progress.new ?? 0}`,
      `变更 ${progress.changed ?? 0}`,
      `删除 ${progress.removed ?? 0}`,
      `失败 ${progress.failed ?? 0}`,
    ];
    return {
      state: "扫描中",
      detail: `${progress.stage || "scan"} · ${parts.join(" / ")}`,
    };
  }
  return {
    state: "空闲",
    detail: status.last_finished_at || status.last_checked_at || "未同步",
  };
}

function renderSyncSummary(status) {
  const stateEl = document.getElementById("syncSummaryState");
  const detailEl = document.getElementById("syncSummaryDetail");
  if (!stateEl || !detailEl) {
    return;
  }
  const formatted = formatSyncStatus(status);
  stateEl.textContent = formatted.state;
  detailEl.textContent = formatted.detail;
}

function heatColor(value, max) {
  if (!value || !max) return "var(--heat-low)";
  const ratio = value / max;
  if (ratio > 0.75) return "var(--heat-high)";
  if (ratio > 0.35) return "var(--heat-mid)";
  return "var(--heat-low)";
}

function fillSelect(select, values, placeholder) {
  select.innerHTML = `<option value="">${placeholder}</option>`;
  values.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  });
}

function fillDatalist(datalist, values) {
  datalist.innerHTML = values.map((value) => `<option value="${escapeHtml(value)}"></option>`).join("");
}

// ---- 多选 LoRA combo(正向 include / 排除 exclude / 收藏分类 favcat 共用同一套逻辑)----
// 每字段一个实例,彼此状态隔离;候选源缺省 state.options.loras,
// 可经 getOptions 提供 {key,label} 结构(收藏分类 combo 用,label 展示 key 存值)。
// 提供多选toggle(菜单项打勾)+ chip 回显(× 单个移除)+ 键盘导航。
function createMultiLoraCombo(cfg) {
  const {
    // 瞬态存于闭包,避免跨字段(include/exclude)相互污染
    getList, // () => string[] (state 名单数组)
    setList, // (string[]) => void
    inputId,
    menuId,
    toggleId,
    chipsId, // 分页条上方栈内的 chips 容器
    clearBtnId, // 顶部输入框旁的全清按钮(combo-clear)
    moreId, // 栈内「展开全部」按钮(折叠 >3 时显示)
    stackId, // 栈容器(lora-stack),空名单时隐藏
    andorSide, // 'include' | 'exclude' | 'favcat',对应 data-andor-side 切换组
    modeGet, // () => 'and'|'or'
    modeSet, // (mode) => void
    getOptions, // 可选:() => 候选数组(string[] 或 {key,label}[]);缺省 state.options.loras
    emptyText, // 可选:无匹配提示文案(缺省"没有匹配的 LoRA")
    summaryNoun, // 可选:候选计数名词(缺省 "LoRA")
  } = cfg;
  const t = { filtered: [], open: false, activeIndex: -1, expanded: false };

  const input = () => document.getElementById(inputId);
  const menu = () => document.getElementById(menuId);
  const chips = () => document.getElementById(chipsId);

  function listing() {
    return getList().slice();
  }

  // 候选统一为 {value, label}:字符串候选 value=label;{key,label} 候选 value=key
  function rawOptions() {
    return getOptions ? getOptions() : state.options.loras || [];
  }

  function normalizedOptions() {
    return rawOptions().map((opt) =>
      typeof opt === "string"
        ? { value: opt, label: opt }
        : { value: String(opt?.key ?? ""), label: String(opt?.label || opt?.key || "") },
    );
  }

  // 候选 value → 展示 label(chips/标题用;未命中回退 value 原文)
  function optionLabel(value) {
    const hit = normalizedOptions().find((opt) => opt.value === value);
    return hit ? hit.label : value;
  }

  function open() {
    t.open = true;
    menu().hidden = false;
    render(input().value);
  }

  function close() {
    t.open = false;
    menu().hidden = true;
    t.activeIndex = -1;
  }

  function render(filterValue = "") {
    const normalized = filterValue.trim().toLowerCase();
    const all = normalizedOptions();
    t.filtered = normalized
      ? all.filter((opt) => opt.label.toLowerCase().includes(normalized) || opt.value.toLowerCase().includes(normalized))
      : all.slice();
    const selected = new Set(getList());
    if (!t.filtered.length) {
      menu().innerHTML = `<div class="combo-empty">${escapeHtml(emptyText || "没有匹配的 LoRA")}</div>`;
      t.activeIndex = -1;
      return;
    }
    if (t.activeIndex >= t.filtered.length) t.activeIndex = 0;
    menu().innerHTML =
      '<div class="combo-summary">共 ' +
      all.length +
      ` 个 ${escapeHtml(summaryNoun || "LoRA")} · 输入关键词筛选</div>` +
      t.filtered
        .map(
          (opt, index) => `
          <button
            class="combo-option ${index === t.activeIndex ? "is-active" : ""} ${selected.has(opt.value) ? "is-selected" : ""}"
            type="button"
            data-lora-option="${escapeHtml(opt.value)}"
          >
            ${escapeHtml(opt.label)}
          </button>
        `
        )
        .join("");
  }

  // 分页条上方栈内 chip 渲染:命中选择列表,采用正文 lora-chip 风格,点击即删除该 lora
  const MAX_VISIBLE = 3; // 默认折叠,仅展示前 3 个
  function renderChips() {
    const list = getList();
    const stack = document.getElementById(stackId);
    const moreBtn = document.getElementById(moreId);
    const collapsed = list.length > MAX_VISIBLE && !t.expanded;
    const visible = collapsed ? list.slice(0, MAX_VISIBLE) : list;
    chips().innerHTML = visible
      .map((value) => {
        const label = optionLabel(value);
        return `
        <button class="chip lora-chip lora-stack-chip" type="button" data-remove-lora-value="${escapeHtml(value)}" title="点击移除 ${escapeHtml(label)}">
          <span>${escapeHtml(label)}</span>
        </button>
      `;
      })
      .join("");
    if (stack) stack.hidden = list.length === 0;
    if (moreBtn) {
      moreBtn.hidden = list.length <= MAX_VISIBLE;
      moreBtn.textContent = t.expanded ? "收起" : `展开全部(+${list.length - MAX_VISIBLE})`;
    }
    const clearBtn = document.getElementById(clearBtnId);
    if (clearBtn) clearBtn.hidden = list.length === 0;
  }

  // 切换选中:存在则移除,不存在则追加(多选 toggle)
  function toggle(value) {
    const list = listing();
    const i = list.indexOf(value);
    if (i >= 0) list.splice(i, 1);
    else list.push(value);
    setList(list);
    // 选中后清空输入框,方便继续输入下一个关键词;菜单按空关键字重渲染(保留全量候选)
    input().value = "";
    render("");
    renderChips();
    syncAndorButtons();
    // 多选即时筛选:每次 toggle 立即刷新
    applyFilters().catch((error) => showToast(error.message, { type: "error" }));
  }

  function remove(value) {
    const list = listing();
    const i = list.indexOf(value);
    if (i >= 0) list.splice(i, 1);
    setList(list);
    render(input().value);
    renderChips();
    syncAndorButtons();
    applyFilters().catch((error) => showToast(error.message, { type: "error" }));
  }

  // 绑定 DOM 事件:输入过滤/键盘导航/触发开关/菜单点击/chip 单删
  function bind() {
    const focusHandler = () => {
      ensureOptionsLoaded()
        .then(() => {
          render(input().value);
          open();
        })
        .catch((error) => showToast(error.message, { type: "error" }));
    };
    const inputHandler = () => {
      ensureOptionsLoaded()
        .then(() => {
          render(input().value);
          open();
        })
        .catch((error) => showToast(error.message, { type: "error" }));
    };
    const keydownHandler = (event) => {
      if (!t.open && (event.key === "ArrowDown" || event.key === "Enter")) {
        open();
        render(input().value);
        event.preventDefault();
        return;
      }
      if (!t.open || !t.filtered.length) return;
      if (event.key === "ArrowDown") {
        t.activeIndex = Math.min(t.activeIndex + 1, t.filtered.length - 1);
        render(input().value);
        event.preventDefault();
      } else if (event.key === "ArrowUp") {
        t.activeIndex = Math.max(t.activeIndex - 1, 0);
        render(input().value);
        event.preventDefault();
      } else if (event.key === "Enter") {
        const v = t.filtered[t.activeIndex] ?? t.filtered[0];
        if (v) toggle(v);
        event.preventDefault();
      } else if (event.key === "Escape") {
        close();
      }
    };
    input().addEventListener("focus", focusHandler);
    input().addEventListener("input", inputHandler);
    input().addEventListener("keydown", keydownHandler);
    document.getElementById(toggleId).addEventListener("click", () => {
      ensureOptionsLoaded()
        .then(() => {
          if (t.open) {
            close();
          } else {
            render(input().value);
            open();
            input().focus();
          }
        })
        .catch((error) => showToast(error.message, { type: "error" }));
    });
    document.getElementById(menuId).addEventListener("click", (event) => {
      const trigger = event.target.closest("[data-lora-option]");
      if (!trigger) return;
      toggle(trigger.dataset.loraOption);
    });
    chips().addEventListener("click", (event) => {
      const trigger = event.target.closest("[data-remove-lora-value]");
      if (!trigger) return;
      remove(trigger.dataset.removeLoraValue);
    });
    const moreBtn = document.getElementById(moreId);
    if (moreBtn) {
      moreBtn.addEventListener("click", () => {
        t.expanded = !t.expanded;
        renderChips();
      });
    }
    // 组外点击收起(以当前 combo 所在容器为界)
    document.addEventListener("click", (event) => {
      const box = input().closest(".combo-box");
      if (box && box.contains(event.target)) return;
      close();
    });
  }

  return {
    open,
    close,
    render,
    renderChips,
    toggle,
    remove,
    bind,
    get state() {
      return t;
    },
    modeGet,
    modeSet,
    andorSide,
  };
}

// ---- 正向 LoRA combo 实例(顶层 state.selectedLoras / loraMode)----
const loraComboInclude = createMultiLoraCombo({
  getList: () => state.selectedLoras,
  setList: (v) => { state.selectedLoras = v; },
  inputId: "loraComboboxInput",
  menuId: "loraComboboxMenu",
  toggleId: "loraComboboxToggle",
  chipsId: "loraIncludeChips",
  clearBtnId: "loraClearBtn",
  moreId: "loraIncludeMoreBtn",
  stackId: "loraIncludeStack",
  andorSide: "include",
  modeGet: () => state.loraMode,
  modeSet: (m) => { state.loraMode = m; },
});

// ---- 排除 LoRA combo 实例(顶层 state.excludedLoras / excludeLoraMode)----
const loraComboExclude = createMultiLoraCombo({
  getList: () => state.excludedLoras,
  setList: (v) => { state.excludedLoras = v; },
  inputId: "excludeLoraInput",
  menuId: "excludeLoraMenu",
  toggleId: "excludeLoraToggle",
  chipsId: "loraExcludeChips",
  clearBtnId: "excludeLoraClearBtn",
  moreId: "loraExcludeMoreBtn",
  stackId: "loraExcludeStack",
  andorSide: "exclude",
  modeGet: () => state.excludeLoraMode,
  modeSet: (m) => { state.excludeLoraMode = m; },
});

// ---- 收藏分类多选 combo 实例(顶层 state.favoriteCategoriesSelected / favoriteCategoryMode)----
// 候选源 state.favoriteCategories([{key,label}]),选中值 = 分类 key;
// 选了分类即隐含要看收藏:自动点亮「只看收藏」(combo 常驻筛选区行1)。
const favoriteCategoryCombo = createMultiLoraCombo({
  getList: () => state.favoriteCategoriesSelected,
  setList: (v) => {
    state.favoriteCategoriesSelected = v;
    if (v.length && !state.favoritesOnly) {
      state.favoritesOnly = true;
      const onlyInput = document.getElementById("favoriteOnlyInput");
      if (onlyInput) onlyInput.checked = true;
    }
  },
  inputId: "favoriteCategoryComboInput",
  menuId: "favoriteCategoryMenu",
  toggleId: "favoriteCategoryToggle",
  chipsId: "favoriteCategoryChips",
  clearBtnId: "favoriteCategoryClearBtn",
  moreId: "favoriteCategoryMoreBtn",
  stackId: "favoriteCategoryStack",
  andorSide: "favcat",
  modeGet: () => state.favoriteCategoryMode,
  modeSet: (m) => { state.favoriteCategoryMode = m; },
  getOptions: () => state.favoriteCategories || [],
  emptyText: "没有匹配的收藏分类",
  summaryNoun: "收藏分类",
});

// 旧调用点兼容:正向菜单(applyInlineLoraFilter / 个别处仍引用 renderLoraMenu)
function renderLoraMenu(filterValue = "") {
  loraComboInclude.render(filterValue);
}
function syncLoraInputLabel() {
  loraComboInclude.renderChips();
}
function applyLoraSelection(value) {
  // 单值语义升为多选:value 为空则清空,否则 toggle
  if (value) {
    loraComboInclude.toggle(value);
  } else {
    state.selectedLoras = [];
    loraComboInclude.renderChips();
    syncAndorButtons();
    applyFilters().catch((error) => showToast(error.message, { type: "error" }));
  }
}

// 基座模型筛选:输入即筛选(输入串为子串匹配,多 checkpoint 命中时全部返回,
// 与文件名筛选同节奏);候选下拉仅用于点击精确选择
function openModelMenu() {
  document.getElementById("modelComboboxMenu").hidden = false;
  state.modelMenuOpen = true;
}

function closeModelMenu() {
  document.getElementById("modelComboboxMenu").hidden = true;
  state.modelMenuOpen = false;
  state.modelActiveIndex = -1;
}

function renderModelMenu(filterValue = "") {
  const menu = document.getElementById("modelComboboxMenu");
  const normalizedFilter = filterValue.trim().toLowerCase();
  const models = state.options.base_models || [];
  state.filteredModels = normalizedFilter
    ? models.filter((value) => value.toLowerCase().includes(normalizedFilter))
    : models.slice();

  if (!state.filteredModels.length) {
    menu.innerHTML = '<div class="combo-empty">没有匹配的模型</div>';
    state.modelActiveIndex = -1;
    return;
  }

  if (state.modelActiveIndex >= state.filteredModels.length) {
    state.modelActiveIndex = 0;
  }

  menu.innerHTML = state.filteredModels
    .map(
      (value, index) => `
        <button
          class="combo-option ${index === state.modelActiveIndex ? "is-active" : ""}"
          type="button"
          data-model-option="${escapeHtml(value)}"
        >
          ${escapeHtml(value)}
        </button>
      `
    )
    .join("");
}

function applyModelSelection(value) {
  const input = document.getElementById("modelComboboxInput");
  input.value = value || "";
  closeModelMenu();
  syncFilterClearButtons();
  // 选中/清除立即刷新(取消待执行防抖)
  applyFilters().catch((error) => showToast(error.message, { type: "error" }));
}

function fillLoraSelect(filterValue = "") {
  const normalizedFilter = filterValue.trim().toLowerCase();
  renderLoraMenu(normalizedFilter ? filterValue : (state.selectedLoras[0] || ""));
}

function renderRank(container, rows) {
  container.innerHTML = rows
    .map(
      (row) => `
        <li>
          <span>${row.label}</span>
          <strong>${row.count}</strong>
        </li>`
    )
    .join("");
}

function renderAnalysisList(containerId, rows, emptyText = "暂无数据") {
  const container = document.getElementById(containerId);
  if (!rows || !rows.length) {
    container.innerHTML = `<div class="empty">${emptyText}</div>`;
    return;
  }

  container.innerHTML = rows
    .map(
      (row) => `
        <div class="analysis-item">
          <strong>${escapeHtml(row.label)}</strong>
          <div class="analysis-meta">
            频次 ${row.count ?? row.doc_hits ?? 0} · 文档 ${row.doc_hits ?? 0} · 覆盖率 ${row.percentage ?? 0}% · 密度 ${row.density ?? "-"}
          </div>
        </div>`
    )
    .join("");
}

function renderLoraAnalysis(rows) {
  const container = document.getElementById("loraKeywordList");
  if (!rows || !rows.length) {
    container.innerHTML = '<div class="empty">当前筛选下没有 LoRA 关键词统计。</div>';
    return;
  }

  container.innerHTML = rows
    .map(
      (row) => `
        <div class="lora-analysis-item">
          <strong>${escapeHtml(row.lora)}</strong>
          <div class="lora-analysis-meta">样本 ${row.docs} 张</div>
          <div class="keyword-chip-row">
            ${row.keywords
              .map(
                (keyword) =>
                  `<span class="chip">${escapeHtml(keyword.label)} · ${keyword.percentage}%</span>`
              )
              .join("")}
          </div>
        </div>`
    )
    .join("");
}

function renderAnnotations(rows) {
  const container = document.getElementById("annotationList");
  if (!rows || !rows.length) {
    container.innerHTML = '<div class="empty">当前还没有保存过 prompt 组合注释。</div>';
    return;
  }

  container.innerHTML = rows
    .map(
      (row) => `
        <div class="lora-analysis-item">
          <strong>${escapeHtml(row.name)}</strong>
          <div class="lora-analysis-meta">${escapeHtml(row.note || "无注释")}</div>
          <div class="prompt-cell">${escapeHtml((row.lines || []).join("\n"))}</div>
        </div>`
    )
    .join("");
}

function renderHeatmap(items) {
  const container = document.getElementById("heatmap");
  container.innerHTML = "";

  const max = Math.max(...items.map((item) => item.count), 0);
  items.forEach((item) => {
    const cell = document.createElement("div");
    cell.className = "heat-cell";
    cell.dataset.count = item.count;
    cell.title = `${item.date} ${String(item.hour).padStart(2, "0")}:00`;
    cell.style.background = heatColor(item.count, max);
    container.appendChild(cell);
  });
}

function promptEntryText(prompt) {
  const layers = Array.isArray(prompt?.layers) && prompt.layers.length ? prompt.layers : [prompt];
  return layers
    .map((layer) => Array.isArray(layer?.lines) && layer.lines.length ? layer.lines.join("\n") : layer?.text || "")
    .filter(Boolean)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePromptGraph(rawPrompt) {
  if (rawPrompt && typeof rawPrompt === "object" && !Array.isArray(rawPrompt)) return rawPrompt;
  if (typeof rawPrompt !== "string") return null;
  try {
    const parsed = JSON.parse(rawPrompt);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    // Some ComfyUI prompt metadata serializes JavaScript non-finite numbers
    // (for example NaN), which are not valid JSON. Normalize only bare values,
    // never text inside a JSON string such as a user Prompt.
    let sanitized = "";
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < rawPrompt.length; index += 1) {
      const char = rawPrompt[index];
      if (quoted) {
        sanitized += char;
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') {
        quoted = true;
        sanitized += char;
        continue;
      }
      const literal = rawPrompt.startsWith("-Infinity", index)
        ? "-Infinity"
        : rawPrompt.startsWith("Infinity", index)
          ? "Infinity"
          : rawPrompt.startsWith("NaN", index)
            ? "NaN"
            : "";
      if (literal) {
        sanitized += "null";
        index += literal.length - 1;
        continue;
      }
      sanitized += char;
    }
    try {
      const parsed = JSON.parse(sanitized);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch (_sanitizedError) {
      return null;
    }
  }
}

function isPromptNodeUpstream(graph, startId, expectedId) {
  if (!graph || !startId || !expectedId || String(startId) === String(expectedId)) return false;
  const seen = new Set();
  const queue = [String(startId)];
  while (queue.length) {
    const nodeId = queue.shift();
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    const inputs = graph[nodeId]?.inputs;
    if (!inputs || typeof inputs !== "object") continue;
    for (const value of Object.values(inputs)) {
      if (!Array.isArray(value) || value.length < 2) continue;
      const upstreamId = String(value[0]);
      if (upstreamId === String(expectedId)) return true;
      if (!seen.has(upstreamId)) queue.push(upstreamId);
    }
  }
  return false;
}

function isContainedPromptFragment(text, candidate) {
  if (text.length < 40 || candidate.length <= text.length) return false;
  const offset = candidate.indexOf(text);
  if (offset < 0) return false;
  const before = offset === 0 ? "" : candidate[offset - 1];
  const after = offset + text.length === candidate.length ? "" : candidate[offset + text.length];
  return (!before || /[\s,]/.test(before)) && (!after || /[\s,]/.test(after));
}

function promptEntriesForDisplay(prompts, rawPrompt = null) {
  const entries = Array.isArray(prompts) ? prompts : [];
  const normalized = entries.map(promptEntryText);
  const graph = parsePromptGraph(rawPrompt);
  return entries.filter((entry, index) => {
    const text = normalized[index];
    if (!text) return true;
    return !normalized.some((candidate, candidateIndex) => {
      if (candidateIndex === index || !candidate) return false;
      if (candidate === text) return candidateIndex < index;
      const parent = entries[candidateIndex];
      // Text containment alone is ambiguous across sampler stages. Collapse a
      // fragment only when the graph proves it is an input of this aggregate.
      return /text concatenate/i.test(String(parent?.source_node_type || ""))
        && isPromptNodeUpstream(graph, parent?.source_node_id, entry?.source_node_id)
        && isContainedPromptFragment(text, candidate);
    });
  });
}

function promptSummary(prompts, rawPrompt = null) {
  const displayPrompts = promptEntriesForDisplay(prompts, rawPrompt);
  if (!displayPrompts.length) return '<div class="empty">-</div>';
  return displayPrompts
    .map((prompt, index) => {
      // branch_label 形如 "positive:2"（Combine 槽位）时按条目序号重编号,
      // 避免多个分支同号（"positive:2" 重复）;语义标签（base_prompt/region_1）保留
      const raw = prompt.branch_label || prompt.source_node_type || "prompt";
      const label = /^(positive|negative):\d+$/.test(raw)
        ? `${raw.split(":")[0]}:${index + 1}`
        : raw;
      const sourceLayers = Array.isArray(prompt.layers) && prompt.layers.length
        ? prompt.layers
        : prompt.text
          ? [{ layer_index: 0, text: String(prompt.text), lines: String(prompt.text).split(/\r?\n/) }]
          : [];
      const layers = sourceLayers
        .map((layer) => {
          const lines = layer.lines && layer.lines.length ? layer.lines : [layer.text || ""];
          return `<div class="prompt-layer"><div class="prompt-layer-meta"><button class="prompt-layer-copy" type="button" data-copy-layer aria-label="复制当前 Layer">复制</button><div class="prompt-layer-label" aria-hidden="true">[Layer ${Number(layer.layer_index || 0) + 1}]</div><button class="prompt-layer-toggle" type="button" data-toggle-layer aria-label="折叠/展开当前 Layer" title="折叠/展开">−</button></div><div class="prompt-pre">${highlightPromptText(lines.filter(Boolean).join("\n"))}</div></div>`;
        })
        .join("");
      return `<div class="prompt-entry"><div class="prompt-entry-header"><div class="prompt-entry-label">${escapeHtml(label)}</div><button class="prompt-entry-toggle" type="button" data-toggle-entry aria-label="折叠/展开整体" title="折叠/展开整体">−</button></div><div class="prompt-entry-body">${layers}</div></div>`;
    })
    .join("");
}

function normalizeTagTerm(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase()
    .replace(/\\/g, "") // 剥 ComfyUI 转义反斜杠 \( → (
    .replace(/ /g, "_"); // 查表键层归一:空格→下划线(词表规范形),跨写法命中
}

function tagHash(value) {
  let hash = 0;
  for (const char of String(value ?? "")) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  return Math.abs(hash);
}

function tagTermsFromFragments(fragments) {
  const terms = new Set();
  for (const fragment of Array.isArray(fragments) ? fragments : []) {
    for (const term of String(fragment ?? "").split(/[\r\n,]+/)) {
      const normalized = normalizeTagTerm(term);
      if (normalized) terms.add(normalized);
    }
  }
  return [...terms];
}

function buildTagIndex(items) {
  const index = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const terms = tagTermsFromFragments(item?.prompt_fragments);
    if (!terms.length) continue;
    const identity = item.id || item._id || `${item.category || "tag"}:${item.name || terms[0]}`;
    const tag = {
      key: `tag-${tagHash(identity).toString(36)}`,
      tone: tagHash(identity) % 12,
      name: String(item.name || terms[0]),
      category: String(item.category_label || item.category || "标记"),
      note: String(item.note || ""),
      terms,
    };
    for (const term of terms) {
      // 同一词条有多条标记时保留最新接口结果的第一条，避免重叠染色。
      if (!index.has(term)) index.set(term, tag);
    }
  }
  return index;
}

function currentTagIndex() {
  return typeof state !== "undefined" && state.tagIndex instanceof Map ? state.tagIndex : new Map();
}

function tagForSegment(value) {
  return currentTagIndex().get(normalizeTagTerm(value));
}

function highlightPromptText(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .split(/(,|\n)/)
    .map((segment) => {
      if (segment === "," || segment === "\n") return escapeHtml(segment);
      const parts = segment.match(/^(\s*)([\s\S]*?)(\s*)$/);
      const leading = parts?.[1] || "";
      const core = parts?.[2] || "";
      const trailing = parts?.[3] || "";
      const tag = tagForSegment(core);
      if (tag) return `${escapeHtml(leading)}<button class="tag-highlight" type="button" data-tag-key="${escapeHtml(tag.key)}" data-tag-tone="${tag.tone}" data-copy-tag-text="${escapeHtml(core)}" data-danbooru-tag="${escapeHtml(core)}" title="${escapeHtml(`${tag.category} · ${tag.name}${tag.note ? ` · ${tag.note}` : ""} · 点击复制 · 右键/悬停查看 danbooru 关联`)}">${escapeHtml(core)}</button>${escapeHtml(trailing)}`;
      if (!core) return escapeHtml(segment);
      return `${escapeHtml(leading)}<span class="danbooru-seg" data-danbooru-tag="${escapeHtml(core)}">${escapeHtml(core)}</span>${escapeHtml(trailing)}`;
    })
    .join("");
}

function promptTextValues(prompts) {
  const values = [];
  const promptEntries = Array.isArray(prompts)
    ? prompts
    : [...(Array.isArray(prompts?.positive) ? prompts.positive : []), ...(Array.isArray(prompts?.negative) ? prompts.negative : [])];
  for (const prompt of promptEntries) {
    const layers = Array.isArray(prompt?.layers) && prompt.layers.length ? prompt.layers : [prompt];
    for (const layer of layers) {
      values.push(Array.isArray(layer?.lines) && layer.lines.length ? layer.lines.join("\n") : layer?.text || "");
    }
  }
  return values;
}

function matchedTagsForPrompts(prompts) {
  const matches = new Map();
  for (const text of promptTextValues(prompts)) {
    for (const segment of String(text).replace(/\r\n/g, "\n").split(/[\n,]+/)) {
      const tag = tagForSegment(segment);
      if (tag) matches.set(tag.key, tag);
    }
  }
  return [...matches.values()];
}

function tagMatchesHtml(prompts) {
  const matches = matchedTagsForPrompts(prompts);
  if (!matches.length) return "";
  return `<div class="tag-match-panel" aria-label="命中的标记"><span class="tag-match-label">标记</span><div class="tag-match-list">${matches
    .map((tag) => `<button class="tag-match-chip" type="button" data-tag-key="${escapeHtml(tag.key)}" data-tag-tone="${tag.tone}" data-copy-tag-text="${escapeHtml(tag.name)}" title="${escapeHtml(`${tag.category} · ${tag.name}${tag.note ? ` · ${tag.note}` : ""} · 点击复制`)}">${escapeHtml(tag.name)}</button>`)
    .join("")}</div></div>`;
}

function setTagFocus(tagKey) {
  document.querySelectorAll("[data-tag-key]").forEach((element) => {
    element.classList.toggle("is-tag-focus", Boolean(tagKey) && element.dataset.tagKey === tagKey);
  });
  document.body.classList.toggle("has-tag-focus", Boolean(tagKey));
}

function bindTagHoverInteractions() {
  const tagElement = (target) => (target instanceof Element ? target.closest("[data-tag-key]") : null);
  document.addEventListener("pointerover", (event) => {
    const element = tagElement(event.target);
    if (element) setTagFocus(element.dataset.tagKey);
  });
  document.addEventListener("pointerout", (event) => {
    const element = tagElement(event.target);
    const related = tagElement(event.relatedTarget);
    if (element && element !== related && element.dataset.tagKey !== related?.dataset.tagKey) setTagFocus("");
  });
  document.addEventListener("focusin", (event) => {
    const element = tagElement(event.target);
    if (element) setTagFocus(element.dataset.tagKey);
  });
  document.addEventListener("focusout", () => {
    requestAnimationFrame(() => {
      if (!tagElement(document.activeElement)) setTagFocus("");
    });
  });
  document.addEventListener("click", (event) => {
    const trigger = tagElement(event.target)?.closest("[data-copy-tag-text]");
    if (!trigger) return;
    const text = String(trigger.dataset.copyTagText || "").trim();
    if (!text) return;
    navigator.clipboard
      .writeText(text)
      .then(() => showToast("已复制标记文本", { type: "success", duration: 1400 }))
      .catch((error) => showToast(error.message, { type: "error" }));
  });
}

// ============ Danbooru tag 补全参考(查表,可选;未启用静默降级) ============
// 数据源 /api/tag-related,两部分设计:
//   1. traits —— 权威特征(wiki 配图投票优先,共现词形规则兜底);
//   2. categories —— LLR+GNN 融合推荐的语义分类分组(角色/背景/环境/特征/构图)。
// 交互:悬停 [data-danbooru-tag] 300ms → 浮层;右键 → 完整面板;
// chip 单击 = 追加到搜索框(空格形式),与"补全参考"语义贴合。
const danbooruState = {
  enabled: undefined, // undefined 未探测;false 后不再请求
  cache: new Map(),
  hoverTimer: null,
  openEl: null,
  lastQuery: "", // 最近一次窗口查询串(sentence 识别时面板头部"识别自"标注)
  pinned: false, // 面板固定:点击外部/滚动/悬停其他 tag 均不再关闭;Escape 仍可显式关闭
};

const DANBOORU_TYPE_LABELS = {
  general: "特征",
  character: "角色",
  copyright: "作品",
  artist: "画师",
  meta: "元数据",
};

// 语义类别标签(后端 tag_category / wiki_traits 分组键,键序即展示序)
const DANBOORU_CATEGORY_LABELS = {
  character: "角色",
  copyright: "作品",
  composition: "构图",
  background: "背景",
  environment: "环境",
  hair_color: "发色",
  hair_style: "发型",
  eyes: "瞳色",
  clothing: "服饰",
  accessories: "配饰",
  expression: "表情",
  body: "身体",
  action: "动作",
  char: "角色特征",
  other: "其他",
  artist: "画师",
  meta: "元数据",
};

// 面板不展示的类别:
//   meta —— official_art/highres 等站点元信息,对创作参考无用(两区都过滤)
//   hair_color / eyes —— 仅过滤分类推荐区:角色方向已由 wiki 特征区权威覆盖,
//   general 方向相近色推荐信息量低(共现主导,如 white hair 1M 级 hub tag);
//   wiki 特征区自身保留发色/瞳色行(官方特征,非推荐)
const DANBOORU_HIDDEN_CATEGORIES = new Set(["meta"]);
const DANBOORU_RELATED_HIDDEN_CATEGORIES = new Set(["meta", "hair_color", "eyes"]);

// 特征区覆盖的外观类别(与后端 TRAIT_CATEGORY_ORDER 对齐)。角色 tag 有
// wiki 特征时,推荐区隐藏这些方向(已权威展示,重复出现即冗余),只保留
// 角色/作品/构图/背景/环境等探索类;无特征(general/无wiki角色)不隐藏。
const DANBOORU_TRAIT_CATEGORIES = new Set([
  "hair_color", "hair_style", "eyes", "clothing", "accessories",
  "expression", "body", "action", "other",
]);

function danbooruChipHtml(item) {
  const name = String(item.name || "");
  const display = name.replace(/_/g, " ");
  const meta = [item.tag_type, item.count ? item.count.toLocaleString() : ""].filter(Boolean).join(" · ");
  // count 角标(紧凑缩写):推荐条目附帖子数,密度信息一眼可辨,无 count 静默省略
  const countBadge = item.count
    ? `<span class="danbooru-chip-count">${escapeHtml(formatCountCompact(item.count))}</span>`
    : "";
  return `<button class="danbooru-chip" type="button" data-danbooru-pick="${escapeHtml(display)}" data-danbooru-name="${escapeHtml(name)}" title="${escapeHtml(`${name}${meta ? ` · ${meta}` : ""} · 点击加入搜索框`)}">${escapeHtml(display)}${countBadge}</button>`;
}

/** 帖子数紧凑缩写:1_234_567 → 1.2M / 12_345 → 12k / 1_234 → 1.2k。 */
function formatCountCompact(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return String(v);
}

function danbooruSectionHtml(title, items) {
  if (!items || !items.length) return "";
  return `<div class="danbooru-section"><div class="danbooru-section-head">${escapeHtml(title)}</div><div class="danbooru-chips">${items.map(danbooruChipHtml).join("")}</div></div>`;
}

async function danbooruFetchRelated(tag) {
  if (danbooruState.enabled === false) return null;
  const key = normalizeTagTerm(tag); // 键归一:写法变体共享缓存
  if (danbooruState.cache.has(key)) return danbooruState.cache.get(key);
  try {
    const payload = await fetchJson(`/api/tag-related?tag=${encodeURIComponent(tag)}`);
    if (!payload || payload.enabled === false) {
      danbooruState.enabled = false;
      return null;
    }
    danbooruState.enabled = true;
    if (danbooruState.cache.size > 128) danbooruState.cache.clear();
    danbooruState.cache.set(key, payload);
    return payload;
  } catch {
    danbooruState.enabled = false;
    return null;
  }
}

// 特征行:label + 可点击 chip(单击加入搜索框);official_art 图条目 accent 强调。
// 紧凑浮层(full=false)每项默认展示 TRAIT_INLINE_LIMIT 个,多出的隐藏并附
// "展开 +N"按钮(点击展开整行);完整面板(full=true)始终全量渲染。
const TRAIT_INLINE_LIMIT = 5;
function danbooruTraitRowHtml(label, items, full) {
  if (!items || !items.length) return "";
  const limited = !full && items.length > TRAIT_INLINE_LIMIT;
  const chips = items
    .map((t, i) => {
      const name = String(t.name || "");
      const display = name.replace(/_/g, " ");
      const official = Number(t.vote_official || 0);
      const vote = Number(t.vote || 0);
      const meta = official ? `官方图 ×${official}` : vote > 1 ? `参考图 ×${vote}` : "";
      const title = `${name}${meta ? ` · ${meta}` : ""} · 点击加入搜索框`;
      const hidden = limited && i >= TRAIT_INLINE_LIMIT;
      return `<button class="danbooru-trait-chip${official ? " danbooru-trait-chip--official" : ""}${hidden ? " danbooru-trait-chip--more" : ""}" type="button" data-danbooru-pick="${escapeHtml(display)}" data-danbooru-name="${escapeHtml(name)}" title="${escapeHtml(title)}">${escapeHtml(display)}</button>`;
    })
    .join("");
  const expandBtn = limited
    ? `<button class="danbooru-trait-expand" type="button" data-danbooru-expand title="展开此项全部特征">展开 +${items.length - TRAIT_INLINE_LIMIT}</button>`
    : "";
  return `<div class="danbooru-trait-row${limited ? " danbooru-trait-row--collapsed" : ""}"><span class="danbooru-trait-label">${escapeHtml(label)}</span>${chips}${expandBtn}</div>`;
}

// 特征区(两部分设计的第一部分,力求权威可靠):
// 条目来自结构化角色档案(character_profile,基于 MIT 数据集
// Sn0w123/booru-characters);角色无档案时后端回退 wiki 配图投票。
// 紧凑浮层(hover)限高滚动预览,完整面板(右键)全量展开。
// meta 类别(official_art / highres 等站点元信息)对创作参考无用,不展示。
function danbooruTraitsHtml(traits, full) {
  if (!traits || !Array.isArray(traits.rows) || !traits.rows.length) return "";
  const rows = traits.rows
    .filter((row) => !DANBOORU_HIDDEN_CATEGORIES.has(row.category))
    .map((row) => danbooruTraitRowHtml(DANBOORU_CATEGORY_LABELS[row.category] || row.category, row.items, full))
    .join("");
  if (!rows) return "";
  const badge = '<span class="danbooru-traits-badge">特征（结构化档案）</span>';
  return `<div class="danbooru-section danbooru-traits">${badge}${rows}</div>`;
}

// 分类推荐行:label + 标准 chip(与特征行的官方 chip 形成视觉区分)
function danbooruCategoryRowHtml(label, items) {
  return `<div class="danbooru-trait-row"><span class="danbooru-trait-label">${escapeHtml(label)}</span>${items.map(danbooruChipHtml).join("")}</div>`;
}

// 分类推荐区(两部分设计的第二部分):LLR+GNN 融合推荐按语义类别分组
// (角色/作品/构图/背景/环境/发色/服饰/...);紧凑浮层展示前 6 行(密度优先)。
// 发色/瞳色两类恒不展示:角色方向已由 wiki 官方特征权威覆盖,general 方向
// 相近色推荐信息量低(共现主导,如 white hair 1M 级 hub tag),一律过滤。
// hasTraits(角色 tag 且 wiki 特征区已渲染)时,全部外观类别都让位给特征区,
// 推荐区仅保留角色/作品/构图/背景/环境等探索方向,消除两区行级重复。
function danbooruCategoriesHtml(categories, full, hasTraits) {
  if (!categories) return "";
  const hidden = hasTraits
    ? new Set([...DANBOORU_RELATED_HIDDEN_CATEGORIES, ...DANBOORU_TRAIT_CATEGORIES])
    : DANBOORU_RELATED_HIDDEN_CATEGORIES;
  const keys = Object.keys(categories).filter((c) => !hidden.has(c));
  const shown = full ? keys : keys.slice(0, 6);
  const rows = [];
  for (const c of shown) {
    const items = categories[c] || [];
    if (!items.length) continue;
    rows.push(danbooruCategoryRowHtml(DANBOORU_CATEGORY_LABELS[c] || c, items));
  }
  if (!rows.length) return "";
  return `<div class="danbooru-section"><div class="danbooru-section-head">分类推荐</div>${rows.join("")}</div>`;
}

function danbooruPanelHtml(tag, payload, full) {
  const tagMeta = payload.tag || {};
  const tr = tagMeta.zh
    ? `<span class="danbooru-panel-tr">${escapeHtml(tagMeta.zh)}</span>`
    : "";
  // 头部信息密度:类型徽章 + 帖子数(该 tag 在 danbooru 的流行度,悬停看精确值)
  const countChip = tagMeta.count
    ? `<span class="danbooru-panel-count" title="${Number(tagMeta.count).toLocaleString()} 帖">${escapeHtml(formatCountCompact(tagMeta.count))}</span>`
    : "";
  // 标题显示实际索引出的条目名(句子识别时为词表规范名,如
  // "the girl is Yumia Liessfeldt" → "yumia liessfeldt");原始窗口串留在"识别自"标注
  // 来源标注:句子识别显示"识别自 窗口串";模糊匹配(词表外/残缺形态
  // 编辑距离命中)显示"模糊匹配 输入串",与精确命中形成置信区分
  const srcBadge =
    tagMeta.source === "fuzzy" && danbooruState.lastQuery
      ? `<span class="danbooru-panel-from danbooru-panel-from--fuzzy" title="输入为残缺/变体形态,按来源+编辑距离近似匹配">模糊匹配 ${escapeHtml(danbooruState.lastQuery)}</span>`
      : tagMeta.source === "sentence" && danbooruState.lastQuery
        ? `<span class="danbooru-panel-from" title="从句子窗口识别">识别自 ${escapeHtml(danbooruState.lastQuery)}</span>`
        : "";
  const header = `<div class="danbooru-panel-head"><span class="danbooru-panel-tag">${escapeHtml(String(tagMeta.name || tag).replace(/_/g, " "))}</span>${tr}${tagMeta.tag_type ? `<span class="danbooru-panel-type">${escapeHtml(DANBOORU_TYPE_LABELS[tagMeta.tag_type] || tagMeta.tag_type)}</span>` : ""}<span class="danbooru-panel-head-right">${countChip}${srcBadge}</span><button class="danbooru-pin" type="button" data-danbooru-pin title="固定面板:点击外部/滚动/悬停其他 tag 不再关闭" aria-label="固定面板" aria-pressed="false"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/></svg></button></div>`;
  const sections = [];
  const traits = danbooruTraitsHtml(payload.traits, full);
  if (traits) sections.push(traits);
  const cats = danbooruCategoriesHtml(payload.categories, full, Boolean(traits));
  if (cats) sections.push(cats);
  if (!sections.length && Array.isArray(payload.related) && payload.related.length) {
    // 兜底:无特征且无分组数据时退回平铺推荐
    sections.push(danbooruSectionHtml("相关推荐", payload.related.slice(0, full ? 12 : 6)));
  }
  const body = sections.length ? sections.join("") : '<div class="danbooru-empty">无关联结果</div>';
  const canonical = tagMeta.name || tag;
  const foot = `<div class="danbooru-panel-foot"><a class="danbooru-link" href="https://danbooru.donmai.us/wiki_pages/${encodeURIComponent(String(canonical))}" target="_blank" rel="noopener">在 Danbooru 查看</a></div>`;
  // 快速标注工具行:面板内"浮窗之上"的常驻入口,点击展开标注表单(压缩 body)
  const qaBar = `<div class="qa-bar" data-qa-toggle role="button" tabindex="0" title="从当前 tag 快速创建标注库词条"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>快速标注</div>`;
  // 单图收藏工具行:与快速标注并列,收藏当前面板关联的图片(悬停 preview tag 时 = 预览当前图)
  const favBar = `<div class="fav-bar" data-fav-bar role="button" tabindex="0" title="收藏当前图片" aria-label="收藏当前图片" aria-pressed="false"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01Z"/></svg><span data-fav-bar-label>收藏</span></div>`;
  const resizer = `<div class="danbooru-resizer" data-danbooru-resizer title="拖拽调整大小" aria-label="调整大小"><svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor" aria-hidden="true"><path d="M14 14H12V12H14V14ZM14 10H12V8H14V10ZM10 14H8V12H10V14ZM14 6H12V4H14V6ZM10 10H8V8H10V10ZM6 14H4V12H6V14Z"/></svg></div>`;
  return `${header}<div class="danbooru-tools">${qaBar}${favBar}</div><div class="danbooru-panel-body">${body}</div>${foot}${resizer}`;
}

function positionDanbooruPanel(panel, x, y) {
  panel.hidden = false;
  const rect = panel.getBoundingClientRect();
  const maxX = Math.max(8, window.innerWidth - rect.width - 8);
  const maxY = Math.max(8, window.innerHeight - rect.height - 8);
  panel.style.left = `${Math.min(x, maxX)}px`;
  panel.style.top = `${Math.min(y, maxY)}px`;
}

function closeDanbooruPanel() {
  danbooruState.pinned = false;
  if (danbooruState.openEl) {
    danbooruState.openEl.remove();
    danbooruState.openEl = null;
  }
  // 关闭面板时收起选中浮标(残留浮标会挡住后续交互)
  if (qaState.selBtn) qaState.selBtn.hidden = true;
}

function openDanbooruPanel(rect, tag, payload, full, img = null) {
  // 面板固定期间不响应其他 tag 的悬停/右键:固定面板是"钉住"的参考,不允许被替换
  if (danbooruState.pinned) return;
  closeDanbooruPanel();
  const panel = document.createElement("div");
  panel.className = `danbooru-panel${full ? " danbooru-panel--full" : ""}`;
  panel.dataset.qaTag = String(tag || ""); // 面板上下文 tag(快速标注预填用)
  panel._qaImg = img || null; // 快速标注预填的图片上下文
  panel.innerHTML = danbooruPanelHtml(tag, payload, full);
  document.body.appendChild(panel);
  danbooruState.openEl = panel;
  const pinBtn = panel.querySelector("[data-danbooru-pin]");
  pinBtn.addEventListener("click", () => {
    danbooruState.pinned = !danbooruState.pinned;
    pinBtn.setAttribute("aria-pressed", String(danbooruState.pinned));
    pinBtn.title = danbooruState.pinned ? "取消固定" : "固定面板:点击外部/滚动/悬停其他 tag 不再关闭";
    panel.classList.toggle("danbooru-panel--pinned", danbooruState.pinned);
  });
  // 快速标注工具行:展开面板内表单(压缩 body),同时钉选防止移动焦点关面板
  const qaToggle = panel.querySelector("[data-qa-toggle]");
  if (qaToggle) {
    const openQa = () => {
      if (panel.querySelector(".qa-form")) return;
      expandQuickAnnotate(panel, {
        name: String(tag || "").replace(/_/g, " "),
        fragments: String(tag || ""),
        img: panel._qaImg,
      });
    };
    qaToggle.addEventListener("click", openQa);
    qaToggle.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openQa();
      }
    });
  }
  // 单图收藏工具行:点击展开收藏表单(分类 + 备注);无关联图片时置灰
  const favBar = panel.querySelector("[data-fav-bar]");
  if (favBar) {
    const img = panel._qaImg || {};
    if (!img.sha256) {
      favBar.classList.add("is-disabled");
      favBar.title = "无关联图片,无法收藏";
      favBar.setAttribute("aria-disabled", "true");
      favBar.removeAttribute("tabindex");
    } else {
      const openFav = () => {
        if (panel.querySelector(".fav-form")) return;
        expandFavoriteForm(panel);
      };
      favBar.addEventListener("click", openFav);
      favBar.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openFav();
        }
      });
    }
    syncFavBars();
  }
  if (full) {
    // 右键完整面板:锚定鼠标位置(用户主动召唤,大面板随鼠标)
    positionDanbooruPanel(panel, rect.left, rect.top);
  } else {
    placeDanbooruPanelBeside(panel, rect);
  }
  makeDanbooruPanelDraggable(panel);
  makeDanbooruPanelResizable(panel);
}

// 悬停浮层定位:默认贴 tag 右侧(顶对齐);右侧放不下翻左侧,两侧都放不下
// 才退到 tag 下方/上方 —— 任何水平放置都不遮挡当前 tag。
function placeDanbooruPanelBeside(panel, rect) {
  const p = panel.getBoundingClientRect();
  const gap = 8;
  const vpW = window.innerWidth;
  const vpH = window.innerHeight;
  // 垂直:顶对齐 tag;放不下时向上收缩到刚好容纳(水平仍在 tag 外侧)
  const topBeside = Math.max(8, Math.min(rect.top, vpH - p.height - 8));
  const fits = (left, top) =>
    left >= 8 && top >= 8 && left + p.width <= vpW - 8 && top + p.height <= vpH - 8;
  const sides = [
    [rect.right + gap, topBeside], // 右侧(默认)
    [rect.left - gap - p.width, topBeside], // 左侧
    [rect.left, rect.bottom + gap], // 下方
    [rect.left, rect.top - gap - p.height], // 上方
  ];
  for (const [left, top] of sides) {
    if (fits(left, top)) {
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      return;
    }
  }
  positionDanbooruPanel(panel, rect.left, rect.bottom + 4);
}

// 面板头部拖拽移动:pointer capture 让移出面板边界的拖动持续生效;
// 面板关闭(remove)后监听器随元素销毁,无全局泄漏
function makeDanbooruPanelDraggable(panel) {
  const head = panel.querySelector(".danbooru-panel-head");
  if (!head) return;
  let startX = 0;
  let startY = 0;
  let baseLeft = 0;
  let baseTop = 0;
  let dragging = false;
  head.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    const rect = panel.getBoundingClientRect();
    baseLeft = rect.left;
    baseTop = rect.top;
    // 头部按钮(固定)不启动拖拽:pointer capture 会把 click 目标吸到头部,
    // 导致按钮点击永远不触发;按钮上的按下直接放行,让 click 落在按钮自身
    if (event.target instanceof Element && event.target.closest("button")) return;
    head.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  head.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    panel.style.left = `${Math.max(0, baseLeft + event.clientX - startX)}px`;
    panel.style.top = `${Math.max(0, baseTop + event.clientY - startY)}px`;
  });
  head.addEventListener("pointerup", () => {
    dragging = false;
  });
}

// 面板右下角拖拽调整大小:支持自由拉伸宽高并限制极值
function makeDanbooruPanelResizable(panel) {
  const resizer = panel.querySelector("[data-danbooru-resizer]");
  if (!resizer) return;
  let startX = 0;
  let startY = 0;
  let startW = 0;
  let startH = 0;
  let resizing = false;

  resizer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    resizing = true;
    startX = event.clientX;
    startY = event.clientY;
    const rect = panel.getBoundingClientRect();
    startW = rect.width;
    startH = rect.height;
    resizer.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  });

  resizer.addEventListener("pointermove", (event) => {
    if (!resizing) return;
    const newW = Math.max(260, Math.min(window.innerWidth - 32, startW + (event.clientX - startX)));
    const newH = Math.max(160, Math.min(window.innerHeight - 32, startH + (event.clientY - startY)));
    panel.style.width = `${Math.round(newW)}px`;
    panel.style.maxWidth = `${Math.round(newW)}px`;
    panel.style.height = `${Math.round(newH)}px`;
    panel.style.maxHeight = `${Math.round(newH)}px`;
  });

  const stopResize = () => {
    resizing = false;
  };
  resizer.addEventListener("pointerup", stopResize);
  resizer.addEventListener("pointercancel", stopResize);
}

// ============ 快速标注(quick annotate) ============
// 两条入口共用同一表单组件,保存走 POST /api/manual-labels
// (category 白名单 + name 必填,prompt_fragments/note/image_refs 透传):
//   入口一:danbooru 面板内工具行展开表单(压缩 body 约 40%,自动钉选);
//   入口二:prompt 文本选中 → 浮标 → 纯标注面板(仅 head + 表单,自动钉选)。
const QA_CATEGORIES = [
  ["character", "角色"],
  ["style", "风格"],
  ["concept", "概念"],
  ["quality", "质量"],
  ["negative", "负面"],
  ["technique", "技法"],
];
// 快速标注分类:后端 /api/manual-label-categories 驱动,启动时加载;
// 加载失败/未就绪时回退到上面的内置白名单(与标注库页保持一致)。
let qaCategories = QA_CATEGORIES;

// 当前分类列表(动态已加载用动态,否则内置兜底)
function qaCategoryList() {
  return qaCategories.length ? qaCategories : QA_CATEGORIES;
}

// 加载后端分类(异步,失败静默保留兜底)
async function loadQaCategories() {
  try {
    const payload = await fetch(apiUrl("/api/manual-label-categories")).then((r) => r.json());
    const list = Array.isArray(payload.items) ? payload.items : [];
    if (list.length) {
      qaCategories = list.map((entry) => [entry.key, entry.label || entry.key]);
    }
  } catch (error) {
    // 忽略:保留内置兜底
  }
}
const qaState = {
  selBtn: null, // 选中浮标按钮
  selectionText: "", // pointerdown 缓存选区文本(点击浮标不丢选区)
  selImg: null, // 选区关联的图片上下文
  dirty: false, // 表单是否有未保存修改
};

// 解析选区所在位置的图片上下文:详情弹窗 → 当前查看图;列表行 → 行内首图
function qaImageContextFor(el) {
  if (!el) return null;
  const node = el instanceof Element ? el : el.parentElement;
  const previewSide = node?.closest?.(".image-preview-side");
  if (previewSide) {
    const active = state.previewItem?.images?.[state.previewIndex];
    if (active) return { sha256: active.sha256 || "", filename: active.filename || "" };
    return null;
  }
  const row = node?.closest?.("tr");
  const shaEl = row?.querySelector?.("[data-derived-sha]");
  const sha = shaEl?.getAttribute("data-derived-sha") || "";
  if (!sha) return null;
  const filename = row?.querySelector?.(".filename-cell")?.textContent?.trim() || "";
  return { sha256: sha, filename };
}

// 分类名 → 中文标签(表单下拉)
function qaFormHtml(prefill) {
  const name = String(prefill.name || "").replace(/\s+/g, " ").trim();
  const fragmentLines = String(prefill.fragments || "")
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const fragmentsText = fragmentLines.join("\n");
  const categoryOptions = qaCategoryList()
    .map(
      ([value, label]) => `<option value="${value}">${label}</option>`,
    )
    .join("");
  const img = prefill.img;
  const imgRefs = img
    ? `<div class="qa-imgrefs"><div class="qa-imgchip"><span class="thumb"></span><span title="${escapeHtml(img.filename || img.sha256 || "")}">${escapeHtml((img.filename || img.sha256 || "当前图片").slice(0, 20))}</span><button class="x" type="button" data-qa-remove-img aria-label="移除关联图片">×</button></div></div>`
    : '<div class="qa-imgrefs"><span class="qa-label">无</span></div>';
  return `<div class="qa-form">
    <div class="qa-field"><label class="qa-label">名称</label><input class="qa-input" data-qa-field="name" value="${escapeHtml(name)}" placeholder="词条名"></div>
    <div class="qa-field"><label class="qa-label">分类</label><select class="qa-select" data-qa-field="category">${categoryOptions}</select></div>
    <div class="qa-field"><label class="qa-label">Prompt 片段</label><textarea class="qa-textarea" data-qa-field="fragments" placeholder="每行一个片段">${escapeHtml(fragmentsText)}</textarea></div>
    <div class="qa-field"><label class="qa-label">备注</label><input class="qa-input" data-qa-field="note" placeholder="可选"></div>
    <div class="qa-field"><div class="qa-label">关联图片</div>${imgRefs}</div>
    <div class="qa-error" data-qa-error>名称不能为空</div>
    <div class="qa-actions"><button class="qa-btn qa-btn--primary" type="button" data-qa-save>保存</button><button class="qa-btn" type="button" data-qa-cancel>取消</button></div>
  </div>`;
}

// 统一钉选状态(表单展开 / 纯标注面板都要求钉选)
function setDanbooruPinned(panel, pinned) {
  danbooruState.pinned = pinned;
  const pinBtn = panel.querySelector("[data-danbooru-pin]");
  if (pinBtn) {
    pinBtn.setAttribute("aria-pressed", String(pinned));
    pinBtn.title = pinned ? "取消固定" : "固定面板:点击外部/滚动/悬停其他 tag 不再关闭";
  }
  panel.classList.toggle("danbooru-panel--pinned", pinned);
}

// 入口一:在已有 danbooru 面板内展开标注表单(压缩 body 40%)
function expandQuickAnnotate(panel, prefill) {
  const wrap = document.createElement("div");
  wrap.innerHTML = qaFormHtml(prefill);
  const form = wrap.firstElementChild;
  const body = panel.querySelector(".danbooru-panel-body");
  if (body) body.before(form);
  panel.classList.add("danbooru-panel--annotating");
  panel._qaImg = prefill.img || panel._qaImg || null;
  setDanbooruPinned(panel, true);
  qaState.dirty = false;
  bindQaForm(panel, form, "tag");
}

// 入口二:文本选中 → 纯标注面板(仅 head + 表单,无 tag body)
function openQuickAnnotateStandalone(text, x, y, img) {
  closeDanbooruPanel();
  const panel = document.createElement("div");
  panel.className = "danbooru-panel danbooru-panel--annotate-only";
  const lines = String(text || "")
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const fragmentText = lines.join("\n");
  const head = `<div class="danbooru-panel-head"><span class="danbooru-panel-tag">快速标注</span>${lines.length ? `<span class="danbooru-panel-count">${lines.length} 片段</span>` : ""}<span class="danbooru-panel-head-right"><button class="danbooru-pin" type="button" data-danbooru-pin title="固定面板" aria-label="固定面板" aria-pressed="true"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/></svg></button></span></div>`;
  panel.innerHTML = head + `<div class="danbooru-panel-body" hidden></div>`;
  document.body.appendChild(panel);
  danbooruState.openEl = panel;
  panel._qaImg = img || null;
  setDanbooruPinned(panel, true);
  // 表单(预填选中片段)
  const wrap = document.createElement("div");
  wrap.innerHTML = qaFormHtml({ name: lines[0] || "", fragments: fragmentText, img });
  const form = wrap.firstElementChild;
  panel.appendChild(form);
  // 钉选按钮
  panel.querySelector("[data-danbooru-pin]").addEventListener("click", () => {
    setDanbooruPinned(panel, !danbooruState.pinned);
  });
  positionDanbooruPanel(panel, x, y);
  makeDanbooruPanelDraggable(panel);
  bindQaForm(panel, form, "standalone");
}

function bindQaForm(panel, form, mode) {
  const inputs = form.querySelectorAll("[data-qa-field]");
  inputs.forEach((el) => el.addEventListener("input", () => (qaState.dirty = true)));
  const removeImg = form.querySelector("[data-qa-remove-img]");
  if (removeImg) {
    removeImg.addEventListener("click", (event) => {
      event.target.closest(".qa-imgrefs").remove();
      qaState.dirty = true;
    });
  }
  form.querySelector("[data-qa-save]").addEventListener("click", () => {
    const nameEl = form.querySelector('[data-qa-field="name"]');
    const name = nameEl.value.trim();
    const errEl = form.querySelector("[data-qa-error]");
    if (!name) {
      errEl.style.display = "block";
      nameEl.focus();
      return;
    }
    errEl.style.display = "none";
    const body = {
      name,
      category: form.querySelector('[data-qa-field="category"]').value,
      prompt_fragments: form
        .querySelector('[data-qa-field="fragments"]')
        .value.split(/[\r\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
      note: form.querySelector('[data-qa-field="note"]').value.trim(),
    };
    const img = panel._qaImg;
    if (img && (img.sha256 || img.filename)) {
      body.image_refs = [{ sha256: img.sha256 || "", filename: img.filename || "" }];
    }
    saveQuickAnnotate(panel, form, mode, body);
  });
  form.querySelector("[data-qa-cancel]").addEventListener("click", () => {
    qaState.dirty = false;
    if (mode === "tag") {
      form.remove();
      panel.classList.remove("danbooru-panel--annotating");
    } else {
      closeDanbooruPanel();
    }
  });
}

async function saveQuickAnnotate(panel, form, mode, body) {
  try {
    const response = await fetch(apiUrl("/api/manual-labels"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(text || `Request failed: ${response.status}`);
    }
    qaState.dirty = false;
    showToast("已保存到标注库", { type: "success", duration: 1600 });
    void loadTagCatalog(); // 刷新 prompt 高亮(新词条立即生效)
    if (mode === "tag") {
      form.remove();
      panel.classList.remove("danbooru-panel--annotating");
    } else {
      closeDanbooruPanel();
    }
  } catch (error) {
    showToast(error.message || "保存失败", { type: "error" });
  }
}

// ---- 选中浮标:prompt 内拖动选中 → 选区旁浮出「标注」按钮 ----
function ensureQaSelButton() {
  if (qaState.selBtn) return qaState.selBtn;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "qa-sel-btn";
  btn.hidden = true;
  btn.textContent = "标注";
  document.body.appendChild(btn);
  // pointerdown 缓存选区与图片上下文(点击按钮会折叠选区,须提前取)
  btn.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const sel = window.getSelection();
    qaState.selectionText = sel && !sel.isCollapsed ? sel.toString().trim() : "";
    qaState.selImg = qaImageContextFor(sel?.anchorNode || null);
  });
  btn.addEventListener("mousedown", (event) => event.preventDefault());
  btn.addEventListener("click", () => {
    const text = qaState.selectionText;
    const rect = btn.getBoundingClientRect();
    btn.hidden = true;
    openQuickAnnotateStandalone(text, rect.left, rect.bottom + 6, qaState.selImg);
  });
  qaState.selBtn = btn;
  return btn;
}

function onQaSelectionChange() {
  const btn = ensureQaSelButton();
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) {
    btn.hidden = true;
    return;
  }
  const node = sel.anchorNode;
  const pre = node instanceof Element ? node.closest(".prompt-pre") : node?.parentElement?.closest(".prompt-pre");
  if (!pre) {
    btn.hidden = true;
    return;
  }
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (!rect.width && !rect.height) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  btn.style.left = `${Math.min(Math.max(4, rect.right + 8), window.innerWidth - 70)}px`;
  btn.style.top = `${Math.max(4, rect.top - 6)}px`;
}

function bindQuickAnnotateInteractions() {
  ensureQaSelButton();
  document.addEventListener("selectionchange", onQaSelectionChange);
  document.addEventListener("mouseup", () => {
    // 选中期间已抑制 hover 面板;松手时清理 pending 计时器并同步浮标
    clearTimeout(danbooruState.hoverTimer);
    onQaSelectionChange();
  });
  window.addEventListener(
    "scroll",
    () => {
      if (qaState.selBtn) qaState.selBtn.hidden = true;
    },
    true,
  );
}

// ============ 收藏夹(favorites) ============
// 一图多分类:同一张图可在多个分类下各存一条((sha256, category) 复合键),
// 经 /api/favorites 幂等 upsert(后端存快照);列表按图聚合返回 categories 全集。
// UI 约定(与用户确认):收藏在图片库主界面只出现在 filters--compact 的
// 「只看收藏 + 收藏分类 combo」筛选里,不占其它 UI 空间(无面板切换按钮/
// 预览头按钮/列表行星标);单图收藏入口:
//   - 预览弹窗「文件名」旁 checkbox:勾选 = 收藏到未分类,取消 = 从全部分类移除
//   - danbooru 弹窗内「快速标注」旁收藏条:展开多分类 checkbox 组 + 备注,
//     保存时 diff 现有分类 vs 新选择(逐分类 upsert / DELETE?category=x)
// 收藏状态索引 state.favorites(Set) + state.favoriteMeta(Map,含 categories
// 数组)由 loadFavoritesIndex 一次拉全,渲染星标/收藏条/表单回填用。

// 收藏分类兜底白名单(与后端默认分类一致;后端加载失败时使用)
const FAVORITE_CATEGORIES = [
  ["character", "人物"],
  ["scene", "场景"],
  ["composition", "构图"],
  ["color", "色彩"],
  ["inspiration", "灵感"],
  ["inbox", "待整理"],
];

// 纯函数:收藏卡片上的星标按钮 HTML(取消收藏用)
function favoriteStarHtml(sha256, isFav) {
  const on = Boolean(isFav);
  return `<button
    class="fav-star${on ? " is-on" : ""}"
    type="button"
    data-fav-toggle="${escapeHtml(sha256)}"
    aria-pressed="${on}"
    title="${on ? "取消收藏" : "收藏这张图"}"
    aria-label="${on ? "取消收藏" : "收藏"}">★</button>`;
}

// 分类 key → 中文标签(无匹配回退 key 原文)
function favoriteCategoryLabel(key) {
  const entry = state.favoriteCategories.find((c) => c.key === key);
  return entry ? entry.label || key : key;
}

// 纯函数:收藏卡片 HTML(缩略图 + 名称 + 分类徽章 + 时间 + 取消收藏星标 + 多选 checkbox)
function favoriteCardHtml(fav, selected = false) {
  const sha = String(fav.sha256 || "");
  const thumb = sha
    ? apiUrl(`/api/thumb/${encodeURIComponent(sha)}?w=420&h=420`)
    : "";
  const name = fav.filename || sha || "未命名图片";
  const time = formatCapturedAt(fav.captured_at || fav.created_at || "");
  // 一图多分类:聚合返回 categories 数组,逐徽章换行排布(空串=未分类不显示)
  const cats = (Array.isArray(fav.categories)
    ? fav.categories
    : fav.category
      ? [fav.category]
      : []
  ).filter(Boolean);
  const cat = cats.length
    ? `<div class="fav-card-cats">${cats
        .map((c) => `<span class="fav-card-cat">${escapeHtml(favoriteCategoryLabel(c))}</span>`)
        .join("")}</div>`
    : "";
  return `
    <div class="fav-card${selected ? " is-selected" : ""}" data-fav-sha="${escapeHtml(sha)}" role="button" tabindex="0" title="${escapeHtml(name)}">
      ${sha ? `<input type="checkbox" class="fav-card-select" data-select-row="${escapeHtml(sha)}" aria-label="选择本卡片"${selected ? " checked" : ""} />` : ""}
      <div class="fav-card-thumb">${thumb ? `<img src="${thumb}" alt="${escapeHtml(name)}" loading="lazy" />` : '<span class="muted">无预览</span>'}</div>
      <div class="fav-card-meta">
        <div class="fav-card-name">${escapeHtml(name)}</div>
        ${cat}
        ${time ? `<div class="fav-card-time muted">${escapeHtml(time)}</div>` : ""}
      </div>
      ${favoriteStarHtml(sha, true)}
    </div>`;
}

// 启动时拉取全部收藏作星标/收藏条索引(失败静默,不阻断列表渲染)
async function loadFavoritesIndex() {
  try {
    const payload = await fetchJson("/api/favorites?limit=10000");
    const items = Array.isArray(payload?.items) ? payload.items : [];
    state.favorites = new Set(items.map((fav) => String(fav.sha256 || "")).filter(Boolean));
    state.favoriteMeta = new Map(
      items.filter((fav) => fav.sha256).map((fav) => [String(fav.sha256), fav]),
    );
    state.favoriteCount = state.favorites.size;
    syncFavoriteStars();
  } catch {
    /* 静默:收藏不可用时星标/收藏条全部为空态 */
  }
}

// 同步「只看收藏 + 收藏分类 combo」筛选区的 UI 态。
// 分类 combo 常驻筛选区行1(选中分类即隐含只看收藏),无显隐切换,仅同步 chips。
function syncFavoriteFilterUi() {
  const onlyInput = document.getElementById("favoriteOnlyInput");
  if (onlyInput) onlyInput.checked = state.favoritesOnly;
  favoriteCategoryCombo.renderChips();
}

// 同步当前 DOM 内全部星标按钮激活态(收藏卡片) + 弹窗收藏条状态
function syncFavoriteStars() {
  document.querySelectorAll("[data-fav-toggle]").forEach((btn) => {
    const sha = String(btn.dataset.favToggle || "");
    const on = Boolean(sha && state.favorites.has(sha));
    btn.classList.toggle("is-on", on);
    btn.setAttribute("aria-pressed", String(on));
    btn.title = on ? "取消收藏" : "收藏这张图";
  });
  syncFavBars();
}

// 弹窗 danbooru 面板内的单图收藏条:按面板关联图片同步 已收藏/收藏
function syncFavBars() {
  document.querySelectorAll("[data-fav-bar]").forEach((bar) => {
    const panel = bar.closest(".danbooru-panel");
    const img = (panel && panel._qaImg) || {};
    const on = Boolean(img.sha256 && state.favorites.has(img.sha256));
    bar.classList.toggle("is-on", on);
    bar.setAttribute("aria-pressed", String(on));
    const label = bar.querySelector("[data-fav-bar-label]");
    if (label) label.textContent = on ? "已收藏" : "收藏";
    bar.title = on ? "取消收藏当前图片" : "收藏当前图片";
  });
}

// 图片当前分类全集(meta.categories 优先,单值 category 兼容;空串=未分类)
function favoriteCategoriesOf(sha) {
  const meta = state.favoriteMeta?.get(sha);
  if (!meta) return [];
  if (Array.isArray(meta.categories)) return meta.categories.filter((c) => typeof c === "string");
  return meta.category ? [String(meta.category)] : [];
}

// 收藏(幂等 upsert,按 (sha256, category) 复合键;空串分类 = 未分类);
// 成功后合并分类进 meta 索引、同步星标,收藏筛选存活时重渲染。
// opts.silent:批量操作逐张调用时静默(不 toast/不重渲染视图,由批量层收口)
async function upsertFavorite(sha, meta = {}, opts = {}) {
  if (!sha) return;
  const category = meta.category || "";
  const response = await fetch(apiUrl("/api/favorites"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sha256: sha,
      filename: meta.filename || "",
      batch_key: meta.batch_key || "",
      captured_at: meta.captured_at || "",
      category,
      note: meta.note || "",
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `收藏失败 (${response.status})`);
  }
  const wasFav = state.favorites.has(sha);
  state.favorites.add(sha);
  // 分类累积:同图已有其它分类时保留,新分类追加(未分类空串也如实记录)
  const cats = favoriteCategoriesOf(sha);
  const nextCats = cats.includes(category) ? cats : [...cats, category];
  state.favoriteMeta.set(sha, {
    ...(state.favoriteMeta.get(sha) || {}),
    sha256: sha,
    filename: meta.filename || "",
    batch_key: meta.batch_key || "",
    captured_at: meta.captured_at || "",
    category,
    categories: nextCats,
    note: meta.note || "",
  });
  state.favoriteCount = state.favorites.size;
  syncFavoriteStars();
  syncFavoriteFilterUi();
  if (opts.silent) return;
  if (state.favoritesOnly) void loadFavoritesView();
  showToast(wasFav ? "已更新收藏" : "已收藏", { type: "success", duration: 1200 });
}

// 取消收藏:不带 category = 删该图全部分类;带 category(含空串=未分类)
// = 仅移出该分类,仍有其它分类保留时收藏关系继续存在。
// opts.silent:批量操作逐张调用时静默(同 upsertFavorite)
async function removeFavorite(sha, category, opts = {}) {
  if (!sha) return;
  const query = category === undefined ? "" : `?category=${encodeURIComponent(category)}`;
  const response = await fetch(apiUrl(`/api/favorites/${encodeURIComponent(sha)}${query}`), {
    method: "DELETE",
  });
  if (!response.ok) throw new Error(`取消收藏失败 (${response.status})`);
  if (category === undefined) {
    state.favorites.delete(sha);
    state.favoriteMeta.delete(sha);
  } else {
    // 移出单分类:meta 剔除该分类;无剩余分类则收藏关系结束
    const cats = favoriteCategoriesOf(sha).filter((c) => c !== category);
    if (cats.length) {
      const meta = state.favoriteMeta.get(sha) || {};
      state.favoriteMeta.set(sha, { ...meta, categories: cats });
    } else {
      state.favorites.delete(sha);
      state.favoriteMeta.delete(sha);
    }
  }
  state.favoriteCount = state.favorites.size;
  syncFavoriteStars();
  syncFavoriteFilterUi();
  if (opts.silent) return;
  if (state.favoritesOnly) void loadFavoritesView();
  showToast(category === undefined ? "已取消收藏" : "已移出该分类", {
    type: "success",
    duration: 1200,
  });
}

// 收藏/取消收藏(按当前态切换);收藏卡片星标/简单入口用
async function toggleFavorite(sha, meta = {}) {
  if (!sha) return;
  try {
    if (state.favorites.has(sha)) {
      await removeFavorite(sha);
    } else {
      await upsertFavorite(sha, meta);
    }
  } catch (error) {
    showToast(error.message || "操作失败", { type: "error" });
  }
}

// 收藏筛选视图:网格渲染(替换主列表);由「只看收藏」开关驱动
async function loadFavoritesView() {
  const container = document.getElementById("resultsList");
  container.innerHTML = '<div class="empty">加载收藏...</div>';
  document.getElementById("resultCount").textContent = "加载中...";
  // 收藏视图无「全选本页」:隐藏标题栏开关,避免残留三态误导
  const selectAllWrap = document.getElementById("selectAllWrap");
  if (selectAllWrap) selectAllWrap.hidden = true;
  let items;
  const categories = state.favoriteCategoriesSelected.slice();
  try {
    const query = new URLSearchParams();
    query.set("limit", "1000");
    // 多分类筛选:重复参数 categories=a&categories=b;mode=and 时须同时归属全部分类
    categories.forEach((value) => query.append("categories", value));
    if (categories.length && state.favoriteCategoryMode === "and") query.set("mode", "and");
    const payload = await fetchJson(`/api/favorites?${query.toString()}`);
    items = Array.isArray(payload?.items) ? payload.items : [];
    // 收藏列表同时回带分类,保持 combo 候选与后端一致(用户可能在其他入口增删分类)
    if (Array.isArray(payload?.categories) && payload.categories.length) {
      state.favoriteCategories = payload.categories;
      renderFavoriteCategoryFilter();
    }
  } catch {
    container.innerHTML = '<div class="empty">收藏加载失败。</div>';
    return;
  }
  state.favoriteItems = items;
  state.favoriteCount = items.length;
  // 收藏视图卡片 key = sha256:不做跨页修剪,选中态与主列表批 key 一并保留(快照兜底)
  cacheSelectionFromList();
  syncBulkUi();
  const pagination = document.getElementById("paginationBar");
  if (pagination) pagination.innerHTML = ""; // 收藏视图不分页
  document.getElementById("resultCount").textContent = `共 ${items.length} 条收藏`;
  if (!items.length) {
    container.innerHTML =
      '<div class="empty">没有匹配的收藏。打开图片预览,悬停 prompt 里的 tag,点「收藏」即可收藏当前图片。</div>';
    return;
  }
  container.innerHTML = `<div class="fav-grid">${items.map((fav) => favoriteCardHtml(fav, state.selection.has(fav.sha256))).join("")}</div>`;
  syncFavoriteStars();
  syncUrlState();
}

// 加载收藏分类(默认 + 用户自定义)填充筛选下拉;失败回退内置白名单
async function loadFavoriteCategories() {
  try {
    const payload = await fetchJson("/api/favorite-categories");
    const items = Array.isArray(payload?.items) ? payload.items : [];
    state.favoriteCategories = items.length ? items : FAVORITE_CATEGORIES.map(([key, label]) => ({ key, label }));
  } catch {
    state.favoriteCategories = FAVORITE_CATEGORIES.map(([key, label]) => ({ key, label }));
  }
  renderFavoriteCategoryFilter();
}

// 分类候选刷新:候选源 state.favoriteCategories 变更后同步 combo
// (chips 的 key→label 映射即时更新;菜单在下次打开时按新候选渲染)
function renderFavoriteCategoryFilter() {
  favoriteCategoryCombo.renderChips();
}

// 从收藏卡片打开完整预览:优先按 batch_key 解析整批(复用 /api/images/details),
// 定位到该收藏图在批次内的索引;无 batch_key 或解析失败时回退轻量视图(仅图)。
async function openFavoritePreview(fav) {
  const sha = String(fav.sha256 || "");
  const filename = fav.filename || "收藏图片";
  if (fav.batch_key) {
    try {
      const payload = await fetchJson("/api/images/details", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batch_keys: [fav.batch_key] }),
      });
      const item = payload?.items?.[0];
      if (item) {
        const images = item.batch?.images || item.images || [];
        const index = Math.max(0, images.findIndex((im) => im.sha256 === sha));
        const active = images[index] || images[0] || {};
        openPreview(
          {
            meta: `收藏 · ${active.filename || filename}`,
            images,
            item,
          },
          index,
        );
        return;
      }
    } catch {
      /* 解析失败走轻量视图 */
    }
  }
  openPreview({
    meta: `收藏 · ${filename}`,
    images: [{ sha256: sha, filename }],
    item: { file: { sha256: sha, filename } },
  });
}

// 收藏表单用分类(动态已加载用动态,否则内置兜底):返回 [key,label] 对
function favoriteCategoryPairs() {
  return state.favoriteCategories.length
    ? state.favoriteCategories.map((c) => [c.key, c.label || c.key])
    : FAVORITE_CATEGORIES;
}

// danbooru 面板内展开单图收藏表单(多分类 checkbox 组 + 备注),与 qa-form 同款视觉。
// 一图多分类:保存时 diff 现有分类 vs 新勾选 —— 新增的逐分类 POST upsert,
// 取消勾选的逐分类 DELETE?category=x(未分类空串无对应 checkbox,不动)
function expandFavoriteForm(panel) {
  const img = panel._qaImg || {};
  const sha = String(img.sha256 || "");
  if (!sha) return;
  const meta = state.favoriteMeta?.get(sha) || {};
  const isFav = Boolean(state.favorites.has(sha));
  const currentCats = favoriteCategoriesOf(sha);
  const checks = favoriteCategoryPairs()
    .map(
      ([value, label]) => `
      <label class="fav-cat-check" title="${escapeHtml(label)}">
        <input type="checkbox" value="${escapeHtml(value)}"${currentCats.includes(value) ? " checked" : ""} />
        <span>${escapeHtml(label)}</span>
      </label>`,
    )
    .join("");
  const wrap = document.createElement("div");
  wrap.innerHTML = `<div class="fav-form">
    <div class="qa-field"><label class="qa-label">收藏分类(可多选)</label><div class="fav-cat-checks" data-fav-field="categories">${checks}</div></div>
    <div class="qa-field"><label class="qa-label">备注</label><input class="qa-input" data-fav-field="note" placeholder="可选"></div>
    <div class="qa-actions">
      <button class="qa-btn qa-btn--primary" type="button" data-fav-save>${isFav ? "保存" : "收藏"}</button>
      <button class="qa-btn qa-btn--danger" type="button" data-fav-remove ${isFav ? "" : "hidden"}>取消收藏</button>
      <button class="qa-btn" type="button" data-fav-cancel>取消</button>
    </div>
  </div>`;
  const form = wrap.firstElementChild;
  const noteInput = form.querySelector('[data-fav-field="note"]');
  if (noteInput && meta.note) noteInput.value = meta.note;
  const body = panel.querySelector(".danbooru-panel-body");
  if (body) body.before(form);
  // 面板关联图片的批次上下文:预览弹窗时取当前查看批次,列表行则留空
  const item = state.previewItem?.item || {};
  const active = state.previewItem?.images?.[state.previewIndex] || {};
  const favMeta = {
    filename: img.filename || active.filename || "",
    batch_key: (state.previewItem && (item.batch_key || item.batch?.key)) || "",
    captured_at: active.captured_at || item.captured_at || "",
  };
  form.querySelector("[data-fav-save]").addEventListener("click", async () => {
    const saveBtn = form.querySelector("[data-fav-save]");
    saveBtn.disabled = true;
    try {
      const note = noteInput.value.trim();
      const nextCats = Array.from(form.querySelectorAll('[data-fav-field="categories"] input:checked')).map(
        (box) => box.value,
      );
      const current = new Set(favoriteCategoriesOf(sha));
      const added = nextCats.filter((cat) => !current.has(cat));
      const removed = Array.from(current).filter((cat) => cat && !nextCats.includes(cat));
      // 新增分类:逐个 upsert(备注/快照随最后一个请求落库)
      for (const cat of added) {
        await upsertFavorite(sha, { ...favMeta, category: cat, note });
      }
      // 取消勾选:逐个移出该分类(空串=未分类无 checkbox,不在此处理)
      for (const cat of removed) {
        await removeFavorite(sha, cat);
      }
      // 无新增分类时,备注/快照修改经首个勾选分类落库(未勾任何显式分类则跳过)
      if (!added.length && nextCats.length) {
        await upsertFavorite(sha, { ...favMeta, category: nextCats[0], note });
      }
      form.remove();
    } catch (error) {
      showToast(error.message || "保存失败", { type: "error" });
    } finally {
      saveBtn.disabled = false;
    }
  });
  const removeBtn = form.querySelector("[data-fav-remove]");
  if (removeBtn) {
    removeBtn.addEventListener("click", async () => {
      try {
        await removeFavorite(sha);
        form.remove();
      } catch (error) {
        showToast(error.message || "操作失败", { type: "error" });
      }
    });
  }
  form.querySelector("[data-fav-cancel]").addEventListener("click", () => {
    form.remove();
  });
}

function bindFavoritesInteractions() {
  // 「只看收藏」开关:关闭时清空分类多选,变更后防抖刷新
  const onlyInput = document.getElementById("favoriteOnlyInput");
  if (onlyInput) {
    onlyInput.addEventListener("change", () => {
      state.favoritesOnly = onlyInput.checked;
      if (!state.favoritesOnly) {
        // 分类筛选只在收藏视图内生效:关闭即清空多选名单
        state.favoriteCategoriesSelected = [];
      }
      syncFavoriteFilterUi();
      scheduleFilterApply();
    });
  }
  // 收藏卡片星标点击:只切换收藏,不触发预览
  document.getElementById("resultsList").addEventListener("click", (event) => {
    const favToggle = event.target.closest("[data-fav-toggle]");
    if (favToggle) {
      event.stopPropagation();
      const sha = favToggle.dataset.favToggle;
      if (sha) void toggleFavorite(sha, { filename: favToggle.dataset.favName || "" });
      return;
    }
  });
  // 收藏卡片点击:打开完整预览(星标/多选 checkbox 已拦截,此处不处理)
  document.getElementById("resultsList").addEventListener("click", (event) => {
    if (event.target.closest("[data-fav-toggle], .fav-card-select")) return;
    const favCard = event.target.closest("[data-fav-sha]");
    if (!favCard) return;
    const fav = state.favoriteItems.find((f) => String(f.sha256 || "") === favCard.dataset.favSha);
    if (fav) void openFavoritePreview(fav);
  });
  // 收藏卡片键盘操作(role=button 的可达性;checkbox 自带空格切换,不劫持)
  document.getElementById("resultsList").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.target.closest(".fav-card-select")) return;
    const favCard = event.target.closest("[data-fav-sha]");
    if (!favCard) return;
    event.preventDefault();
    const fav = state.favoriteItems.find((f) => String(f.sha256 || "") === favCard.dataset.favSha);
    if (fav) void openFavoritePreview(fav);
  });
}

function danbooruPickChip(pickValue) {
  const tokens = String(pickValue || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!tokens.length) return;
  const searchInput = document.getElementById("searchInput");
  if (!searchInput) return;
  let current = searchInput.value.trim();
  const existing = new Set(
    current.split(/[\n,]+/).map((t) => t.trim().toLowerCase()),
  );
  const added = [];
  for (const text of tokens) {
    const token = text.replace(/ /g, "_");
    if (!existing.has(token.toLowerCase())) {
      current = current ? `${current}, ${text}` : text;
      existing.add(token.toLowerCase());
      added.push(text);
    }
  }
  if (added.length) {
    searchInput.value = current;
    if (typeof autoResizeSearch === "function") autoResizeSearch();
  }
  showToast(`已加入搜索框: ${tokens.join(", ")}`, { type: "success", duration: 1200 });
}

// 鼠标坐标 → 段内字符偏移(caret 定位,浏览器原生;文本节点一般为首个子节点)
function caretOffsetAt(x, y) {
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    return p ? { startContainer: p.offsetNode, startOffset: p.offset } : null;
  }
  return null;
}

// 悬停窗口:以鼠标所在词为中心,前后各取 3 词(≤7 词)作查询串。
// 短段(≤2 词)无需窗口,原样返回。窗口文本交给后端句子识别
// (子序列词表匹配),如 `the girl is Yumia Liessfeldt` 悬停 Yumia
// → `is Yumia Liessfeldt` → 识别 yumia_liessfeldt。
// 角色形态段 `name (source): ...` 例外:整段发送 —— 后端剥描述尾巴
// 锁定词表规范形;窗口化会把括号组或名字切掉(悬停描述中部时 `archive):
// long wavy ...` 无法锁定角色),且该形态本就带来源约束,不会歧义。
function danbooruQueryFor(el, x, y) {
  const text = String(el.textContent || "").trim();
  if (/\S+\s*\([^)]+\)/.test(text)) return { q: text, windowed: true };
  const words = text.split(/\s+/);
  if (words.length <= 2) return { q: text, windowed: false };
  const caret = caretOffsetAt(x, y);
  let idx = 0;
  if (caret && caret.startContainer === el.firstChild) {
    let pos = 0;
    for (let i = 0; i < words.length; i++) {
      pos += words[i].length + 1;
      if (caret.startOffset <= pos) {
        idx = i;
        break;
      }
    }
    idx = Math.min(idx, words.length - 1);
  }
  const from = Math.max(0, idx - 3);
  const to = Math.min(words.length, idx + 4);
  return { q: words.slice(from, to).join(" "), windowed: true };
}

function bindDanbooruInteractions() {
  const segOf = (target) => (target instanceof Element ? target.closest("[data-danbooru-tag]") : null);
  const queryAndOpen = async (el, x, y, full) => {
    if (danbooruState.pinned) return;
    const { q, windowed } = danbooruQueryFor(el, x, y);
    if (!q) return;
    const payload = await danbooruFetchRelated(q);
    if (!payload) return;
    danbooruState.lastQuery = windowed ? q : "";
    openDanbooruPanel(
      full ? { left: x, top: y, bottom: y + 4 } : el.getBoundingClientRect(),
      q,
      payload,
      full,
      qaImageContextFor(el), // 快速标注预填的图片上下文(行内首图/详情当前图)
    );
  };

  // 悬停 300ms → 浮层(窗口查询:鼠标位置前后扩展识别)
  document.addEventListener("pointerover", (event) => {
    const el = segOf(event.target);
    if (!el) return;
    // 冲突门:prompt 内正在做文本选区(非折叠)时不弹 hover 面板,
    // 避免拖选到 tag 时浮窗中途弹出打断标注流程
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const { clientX, clientY } = event;
    clearTimeout(danbooruState.hoverTimer);
    danbooruState.hoverTimer = setTimeout(() => queryAndOpen(el, clientX, clientY, false), 300);
  });
  document.addEventListener("pointerout", (event) => {
    const el = segOf(event.target);
    const related = segOf(event.relatedTarget);
    if (el && el !== related) clearTimeout(danbooruState.hoverTimer);
    if (!el && !related) clearTimeout(danbooruState.hoverTimer);
  });

  // 右键 → 完整面板(同样按鼠标位置取窗口)
  document.addEventListener("contextmenu", (event) => {
    const el = segOf(event.target);
    if (!el) return;
    event.preventDefault();
    queryAndOpen(el, event.clientX, event.clientY, true);
  });

  // chip 单击 = 追加搜索框;点击面板外关闭浮层
  document.addEventListener("click", (event) => {
    const expandBtn = event.target instanceof Element ? event.target.closest("[data-danbooru-expand]") : null;
    if (expandBtn) {
      // 展开被折叠的特征行:去掉折叠态 class 让 --more chips 显示,并隐藏展开按钮
      const row = expandBtn.closest(".danbooru-trait-row");
      if (row) row.classList.remove("danbooru-trait-row--collapsed");
      expandBtn.remove();
      return;
    }
    const chip = event.target instanceof Element ? event.target.closest("[data-danbooru-pick]") : null;
    if (chip) {
      danbooruPickChip(chip.dataset.danbooruPick);
      return;
    }
    if (danbooruState.openEl && !danbooruState.openEl.contains(event.target) && !segOf(event.target)) {
      if (!danbooruState.pinned) closeDanbooruPanel();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDanbooruPanel();
  });
  // 页面滚动关闭浮层;面板自身滚动(overflow-y:auto 内容滚动,scroll 不冒泡但
  // 捕获阶段 window 可见,target=面板或其内部元素)不关闭——否则滚一下就消失;
  // 固定面板不受滚动影响(用户钉住做参考,页面照常滚动)
  window.addEventListener(
    "scroll",
    (event) => {
      const panel = danbooruState.openEl;
      if (panel && event.target instanceof Node && panel.contains(event.target)) return;
      if (!danbooruState.pinned) closeDanbooruPanel();
    },
    true,
  );
}

// 搜索框联想:输入防抖 150ms → /api/tag-suggest(字面前缀 + 多语言别名)
function bindTagSuggestAutocomplete() {
  const searchInput = document.getElementById("searchInput");
  const menu = document.getElementById("tagSuggestMenu");
  if (!searchInput || !menu) return;
  let debounce = null;
  let enabled;
  const close = () => {
    menu.hidden = true;
  };
  searchInput.addEventListener("input", () => {
    clearTimeout(debounce);
    const value = searchInput.value.trim();
    if (!value || enabled === false) {
      close();
      return;
    }
    debounce = setTimeout(async () => {
      try {
        const payload = await fetchJson(`/api/tag-suggest?q=${encodeURIComponent(value)}&limit=12`);
        if (!payload || payload.enabled === false) {
          enabled = false;
          close();
          return;
        }
        enabled = true;
        const items = payload.items || [];
        if (!items.length) {
          // 字面与别名均无结果 → 关闭(NL 语义搜索已移除,别名层即语义兜底)
          close();
          return;
        }
        menu.innerHTML = items
          .map((it) => {
            const display = String(it.name || "").replace(/_/g, " ");
            const tr = it.zh
              ? `<span class="tag-suggest-tr">${escapeHtml(it.zh)}</span>`
              : "";
            const badge = it.alias
              ? `<span class="tag-suggest-badge">别名 ${escapeHtml(it.alias)}</span>`
              : it.tag_type
                ? `<span class="tag-suggest-type">${escapeHtml(it.tag_type)}</span>`
                : "";
            const count = it.count ? `<span class="tag-suggest-count">${Number(it.count).toLocaleString()}</span>` : "";
            return `<button class="tag-suggest-item" type="button" data-suggest-pick="${escapeHtml(display)}">${escapeHtml(display)}${tr}${badge}${count}</button>`;
          })
          .join("");
        menu.hidden = false;
      } catch {
        enabled = false;
        close();
      }
    }, 150);
  });
  menu.addEventListener("click", (event) => {
    const item = event.target instanceof Element ? event.target.closest("[data-suggest-pick]") : null;
    if (!item) return;
    searchInput.value = item.dataset.suggestPick || "";
    close();
    if (typeof autoResizeSearch === "function") autoResizeSearch();
    searchInput.focus();
  });
  document.addEventListener("click", (event) => {
    if (!menu.hidden && !menu.contains(event.target) && event.target !== searchInput) close();
  });
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      event.stopPropagation();
      close();
    }
  });
}

// 详情页"补全参考"块:按 batch_key 拉导入时预计算的组推荐(需求 2 展示)。
// 空结果/未启用 → 整块隐藏(静默降级)。
const tagSuggestCache = new Map();

function renderTagSuggestionPayload(payload) {
  const parts = [];
  if (Array.isArray(payload.sources) && payload.sources.length) {
    parts.push(
      `<div class="danbooru-section"><div class="danbooru-section-head">输入 tag</div><div class="danbooru-chips">${payload.sources
        .map((s) => `<span class="danbooru-source-chip">${escapeHtml(String(s).replace(/_/g, " "))}</span>`)
        .join("")}</div></div>`,
    );
  }
  if (Array.isArray(payload.tags) && payload.tags.length) {
    parts.push(danbooruSectionHtml("推荐 tag", payload.tags));
  }
  if (Array.isArray(payload.groups) && payload.groups.length) {
    const groupChips = payload.groups
      .map((g) => {
        const tags = Array.isArray(g.tags) ? g.tags : [];
        const label = tags.map((t) => String(t).replace(/_/g, " ")).join(" + ");
        const pick = tags.join(", ");
        return `<button class="danbooru-chip" type="button" data-danbooru-pick="${escapeHtml(pick)}" title="${escapeHtml(label)} · 点击加入搜索框">${escapeHtml(label)}</button>`;
      })
      .join("");
    parts.push(
      `<div class="danbooru-section"><div class="danbooru-section-head">组合推荐</div><div class="danbooru-chips">${groupChips}</div></div>`,
    );
  }
  return parts.join("");
}

async function loadTagSuggestions(batchKey) {
  const section = document.getElementById("tagSuggestSection");
  const body = document.getElementById("tagSuggestBody");
  if (!section || !body) return;
  if (!batchKey) {
    section.hidden = true;
    return;
  }
  try {
    let payload = tagSuggestCache.get(batchKey);
    if (payload === undefined) {
      const resp = await fetchJson(`/api/batch-suggestions?batch_key=${encodeURIComponent(batchKey)}`);
      payload = resp && resp.enabled !== false ? resp.payload : null;
      tagSuggestCache.set(batchKey, payload);
    }
    const hasContent =
      payload &&
      ((Array.isArray(payload.tags) && payload.tags.length) ||
        (Array.isArray(payload.groups) && payload.groups.length));
    if (!hasContent) {
      section.hidden = true;
      return;
    }
    body.innerHTML = renderTagSuggestionPayload(payload);
    section.hidden = false;
  } catch {
    section.hidden = true;
  }
}
// ============ end Danbooru tag 补全参考 ============

function samplerHtml(samplers) {
  if (!samplers || !samplers.length) return '<div class="muted">-</div>';
  return samplers
    .map(
      (sampler, index) => `
        <div class="meta-block">
          <span class="meta-label">Sampler ${index + 1}</span>
          <div>steps ${escapeHtml(linkValueText(sampler.steps))} / cfg ${escapeHtml(linkValueText(sampler.cfg))}</div>
          <div>${escapeHtml(linkValueText(sampler.sampler_name))} / ${escapeHtml(linkValueText(sampler.scheduler))}</div>
          <div>denoise ${escapeHtml(linkValueText(sampler.denoise))}</div>
        </div>`
    )
    .join("");
}

function formatNumericStrength(value) {
  if (value === undefined || value === null || value === "") return "";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  const snapped = Math.round(numeric / 0.05) * 0.05;
  const displayValue = Math.abs(numeric - snapped) < 1e-9 ? snapped : numeric;
  return Number(displayValue.toFixed(4)).toString();
}

function formatLoraStrength(lora) {
  const parts = [];
  const weight = formatNumericStrength(lora.strength);
  const model = formatNumericStrength(lora.strength_model);
  const clip = formatNumericStrength(lora.strength_clip);
  if (weight) {
    parts.push(`W ${weight}`);
  }
  if (model) {
    parts.push(`M ${model}`);
  }
  if (clip) {
    parts.push(`C ${clip}`);
  }
  return parts.join(" / ");
}

function loraChipHtml(lora) {
  const strength = formatLoraStrength(lora);
  const title = [lora.name, lora.source, strength].filter(Boolean).join(" · ");
  return `
    <button class="chip lora-chip chip-button" type="button" data-lora-filter="${escapeHtml(lora.name || "")}" title="${escapeHtml(title)}">
      <span>${escapeHtml(lora.name || "-")}</span>
      ${strength ? `<span class="chip-strength">${escapeHtml(strength)}</span>` : ""}
    </button>
  `;
}

function manualLabelMatchesHtml(matches) {
  if (!matches || !matches.length) {
    return "";
  }
  return `
    <div class="manual-label-matches">
      ${matches
        .map(
          (match) => `
            <div class="manual-label-match" title="${escapeHtml(match.note || "")}">
              <span class="annotation-chip">${escapeHtml(match.category_label || match.category || "标注")}</span>
              <strong>${escapeHtml(match.name || "未命名标注")}</strong>
              ${
                match.prompt_fragments && match.prompt_fragments.length
                  ? `<span class="manual-label-fragments">${escapeHtml(match.prompt_fragments.join(" / "))}</span>`
                  : ""
              }
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function currentGroupMode() {
  return state.defaultGroupMode || "batch";
}

// ============ 列表多选(selection,当前页范围) ============

function rowKeyOf(item) {
  return item?.batch?.key || item?.file?.sha256 || "";
}

// ---- 跨页持久化:选中状态以 cookie 保存,翻页/切视图/刷新后不丢失 ----
const SELECTION_COOKIE = "aa-selection";
const LEGACY_SELECTION_COOKIE = "wfdb-selection";
const SELECTION_COOKIE_DAYS = 30;

function getCookieValue(name) {
  const match = document.cookie ? document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`)) : null;
  return match ? match[1] : "";
}

/** 把 cookie 快照还原为条目(批量收藏/取消收藏只需要 images,其余字段尽力而为) */
function snapshotEntryToEntry(it) {
  const images = (it.i || []).map((pair) => ({ sha256: pair[0], filename: pair[1] || "" }));
  return {
    key: it.k,
    thumbSha: it.t || "",
    count: it.c || images.length || 1,
    filename: it.f || it.k,
    item: { batch: { key: it.k, images } },
    images,
  };
}

/** 选中变化后写 cookie:保存全部选中 key + 解析过的条目快照(便于翻页/刷新后批量操作) */
function persistSelection() {
  try {
    const items = selectionEntries()
      .filter((e) => e.images && e.images.length)
      .map((e) => ({
        k: e.key,
        t: e.thumbSha,
        c: e.count,
        f: e.filename,
        i: e.images.map((img) => [img.sha256, img.filename || ""]),
      }));
    const json = JSON.stringify({ keys: [...state.selection], items });
    document.cookie = `${SELECTION_COOKIE}=${encodeURIComponent(json)}; path=/; max-age=${SELECTION_COOKIE_DAYS * 24 * 3600}; SameSite=Lax`;
  } catch {
    // 写入失败(cookie 过大等)静默降级:选中态仅会话内有效
  }
}

/** boot 时从 cookie 恢复选中态与条目快照 */
function restoreSelectionFromCookie() {
  try {
    const raw = getCookieValue(SELECTION_COOKIE) || getCookieValue(LEGACY_SELECTION_COOKIE);
    if (!raw) {
      state.selection = new Set();
      state.selectionData = new Map();
      return;
    }
    const payload = JSON.parse(decodeURIComponent(raw));
    state.selection = new Set((Array.isArray(payload.keys) ? payload.keys : []).filter(Boolean));
    state.selectionData = new Map();
    for (const it of payload.items || []) {
      if (it && it.k) state.selectionData.set(it.k, snapshotEntryToEntry(it));
    }
  } catch {
    state.selection = new Set();
    state.selectionData = new Map();
  }
}

/** 列表渲染后把当前页已选中条目并入快照(不做跨页修剪):翻页后 selection 仍保留,
    条目数据由快照兜底,批量收藏/移入分类/导出不因离开原页而失效 */
function cacheSelectionFromList() {
  if (!state.selection.size) {
    persistSelection();
    return;
  }
  for (const key of state.selection) {
    const entry = selectionEntry(key);
    if (entry) state.selectionData.set(key, entry);
  }
  persistSelection();
}

/** 全选框三态:全选/全不选/部分选中(indeterminate) */
function syncSelectAllCheckbox() {
  const box = document.getElementById("selectAllRows");
  if (!box) return;
  const keys = [...state.currentItems.keys()].filter(Boolean);
  const selectedCount = keys.filter((key) => state.selection.has(key)).length;
  box.checked = keys.length > 0 && selectedCount === keys.length;
  box.indeterminate = selectedCount > 0 && selectedCount < keys.length;
}

/** 全选/取消全选后,同步全部行 checkbox、行高亮与全选三态 */
function syncRowSelectionUi() {
  document.querySelectorAll("#resultsList [data-select-row]").forEach((box) => {
    const selected = state.selection.has(box.dataset.selectRow);
    box.checked = selected;
    box.closest("tr, .fav-card")?.classList.toggle("is-selected", selected);
  });
  syncSelectAllCheckbox();
}

// ============ 批量操作行 + 左下角选中反馈面板 ============

/**
 * 选中 key → 展示/操作条目解析。
 * 主列表:key = batch key(currentItems);收藏视图:key = sha256(favoriteItems)。
 * 返回 { key, thumbSha, count, filename, item, images }:
 *   images = 参与批量收藏/取消收藏的图片数组([{sha256, filename}])——
 *   主列表行代表一个批次,批次内全部图片都进批量;收藏卡片恒单图。
 */
function selectionEntry(key) {
  const item = state.currentItems.get(key);
  if (item) {
    const batchImages = item.batch?.images || [];
    const first = batchImages[0] || item.file || {};
    const images = batchImages.length
      ? batchImages
      : item.file?.sha256
        ? [item.file]
        : [];
    const entry = {
      key,
      thumbSha: first.sha256 || item.file?.sha256 || "",
      count: item.batch?.count || batchImages.length || 1,
      filename: first.filename || item.file?.filename || key,
      item,
      images,
    };
    // 离开当前页后 item 不再驻留 currentItems,缓存快照供跨页批量操作兜底
    state.selectionData.set(key, entry);
    return entry;
  }
  const fav = state.favoriteItems.find((f) => String(f.sha256 || "") === key);
  if (fav) {
    const entry = {
      key,
      thumbSha: fav.sha256 || "",
      count: 1,
      filename: fav.filename || fav.sha256 || key,
      item: fav,
      images: fav.sha256 ? [{ sha256: fav.sha256, filename: fav.filename }] : [],
    };
    state.selectionData.set(key, entry);
    return entry;
  }
  return state.selectionData.get(key) || null;
}

// 全部选中条目(渲染顺序 = 选中顺序;解析失败的 key 跳过)
function selectionEntries() {
  const entries = [];
  for (const key of state.selection) {
    const entry = selectionEntry(key);
    if (entry) entries.push(entry);
  }
  return entries;
}

// 左下角面板缩略图:批次内 >1 张 = CSS 叠图 + ×N 角标,单张平铺不标
function selectionPanelThumbHtml(entry) {
  const thumb = entry.thumbSha
    ? apiUrl(`/api/thumb/${encodeURIComponent(entry.thumbSha)}?w=160&h=160`)
    : "";
  const stacked = entry.count > 1;
  return `
    <button
      type="button"
      class="sel-thumb${stacked ? " is-stacked" : ""}"
      data-sel-thumb-key="${escapeHtml(entry.key)}"
      title="${escapeHtml(entry.filename)}(点击取消选中)"
      aria-label="取消选中 ${escapeHtml(entry.filename)}"
    >
      ${thumb ? `<img src="${thumb}" alt="${escapeHtml(entry.filename)}" loading="lazy" />` : '<span class="muted">无图</span>'}
      ${stacked ? `<span class="sel-thumb-badge">×${entry.count}</span>` : ""}
    </button>`;
}

// 同步左下角批量操作卡片 + 选中反馈面板(选中变化/列表重渲染后调用)
function syncBulkUi() {
  const count = state.selection.size;
  const hasSelection = count > 0;
  const panel = document.getElementById("selectionPanel");
  if (panel) panel.hidden = !hasSelection;
  const actions = document.getElementById("bulkActions");
  if (actions) actions.hidden = !hasSelection;
  const grid = document.getElementById("selectionPanelGrid");
  const panelCount = document.getElementById("selectionPanelCount");
  // 无选中时也要清空 grid / 计数,确保清空按钮后不留残留内容
  if (panelCount) panelCount.textContent = hasSelection ? `已选 ${count} 项` : "";
  if (!hasSelection) {
    if (grid) grid.innerHTML = "";
    return;
  }
  if (grid) grid.innerHTML = selectionEntries().map(selectionPanelThumbHtml).join("");
}

// 批量收藏:选中条目的全部图片逐张 upsert(多分类时逐分类 × 逐图)
async function bulkApplyFavorites(entries, categories) {
  const cats = categories.filter(Boolean);
  const categoryList = cats.length ? cats : [""];
  let total = 0;
  for (const entry of entries) {
    for (const image of entry.images) {
      for (const category of categoryList) {
        await upsertFavorite(
          image.sha256,
          {
            filename: image.filename || "",
            batch_key: entry.item?.batch?.key || entry.item?.batch_key || "",
            captured_at: entry.item?.captured_at || "",
            category,
          },
          { silent: true },
        );
        total += 1;
      }
    }
  }
  if (state.favoritesOnly) void loadFavoritesView();
  const catText = cats.length ? `到「${cats.map((c) => favoriteCategoryLabel(c)).join("、")}」` : "";
  showToast(`已收藏 ${total} 张${catText}`, { type: "success", duration: 1600 });
}

// 批量取消收藏:选中条目的全部图片逐张删除全部分类
async function bulkRemoveFavorites(entries) {
  let total = 0;
  for (const entry of entries) {
    for (const image of entry.images) {
      await removeFavorite(image.sha256, undefined, { silent: true });
      total += 1;
    }
  }
  if (state.favoritesOnly) void loadFavoritesView();
  showToast(`已取消收藏 ${total} 张`, { type: "success", duration: 1600 });
}

// CSV 字段转义:RFC 4180(引号包裹,内嵌引号翻倍)
function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

// 导出选中条目 CSV(Blob 下载):元数据 + prompt 文本(用户自己的数据导出)
function bulkExportCsv(entries) {
  const header = [
    "文件名",
    "路径",
    "批次Key",
    "时间",
    "模型",
    "LoRA",
    "采样器",
    "种子",
    "张数",
    "尺寸",
    "正向Prompt",
    "负向Prompt",
    "sha256",
  ];
  const rows = entries.map((entry) => {
    const item = entry.item || {};
    const first = item.batch?.images?.[0] || item.file || {};
    const loras = (item.loras?.items || []).map((lora) => lora?.name || lora).filter(Boolean);
    const samplers = (item.samplers || [])
      .map((s) => [s?.sampler_name, s?.scheduler, s?.steps, s?.cfg].filter((v) => v !== undefined && v !== null && v !== "").join("/"))
      .filter(Boolean);
    const prompts = item.prompts || {};
    const promptText = (list) =>
      (Array.isArray(list) ? list : [])
        .map((p) => promptEntryText(p))
        .filter(Boolean)
        .join("; ");
    const dims = first.width && first.height ? `${first.width}×${first.height}` : "";
    return [
      entry.filename,
      first.resolved_path || item.file?.resolved_path || "",
      entry.key,
      item.captured_at || "",
      item.model?.base_model || "",
      loras.join(" | "),
      samplers.join(" | "),
      (item.batch?.seeds || []).join(" / "),
      entry.count,
      dims,
      promptText(prompts.positive),
      promptText(prompts.negative),
      entry.thumbSha || item.file?.sha256 || "",
    ]
      .map(csvCell)
      .join(",");
  });
  // BOM 保证 Excel 正确识别 UTF-8 中文
  const csv = `\uFEFF${[header.map(csvCell).join(","), ...rows].join("\r\n")}`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `selection-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "")}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast(`已导出 ${entries.length} 项 CSV`, { type: "success", duration: 1600 });
}

// 渲染批量移入分类菜单勾选项(候选 = 收藏分类;重开时刷新候选并保留勾选)
function renderBulkCatChecks() {
  const box = document.getElementById("bulkCatChecks");
  if (!box) return;
  const checked = new Set(
    Array.from(box.querySelectorAll("input:checked")).map((input) => input.value),
  );
  box.innerHTML = favoriteCategoryPairs()
    .map(
      ([key, label]) => `
      <label class="bulk-cat-check" title="${escapeHtml(label)}">
        <input type="checkbox" value="${escapeHtml(key)}"${checked.has(key) ? " checked" : ""} />
        <span>${escapeHtml(label)}</span>
      </label>`,
    )
    .join("");
}

// 批量操作行/面板事件绑定(boot 一次性)
function bindBulkActions() {
  const menu = document.getElementById("bulkCatMenu");
  const toggle = document.getElementById("bulkCatToggle");
  // 分类菜单开关(组外点击收起)
  if (toggle && menu) {
    toggle.addEventListener("click", () => {
      menu.hidden = !menu.hidden;
      toggle.setAttribute("aria-expanded", String(!menu.hidden));
      if (!menu.hidden) renderBulkCatChecks();
    });
    document.addEventListener("click", (event) => {
      if (menu.hidden) return;
      if (event.target.closest(".bulk-cat-picker")) return;
      menu.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
    });
  }
  const guard = async (action) => {
    const entries = selectionEntries();
    if (!entries.length) return;
    try {
      await action(entries);
    } catch (error) {
      showToast(error.message || "批量操作失败", { type: "error" });
    }
  };
  document.getElementById("bulkFavoriteBtn")?.addEventListener("click", () => {
    void guard((entries) => bulkApplyFavorites(entries, []));
  });
  document.getElementById("bulkCatApply")?.addEventListener("click", () => {
    const checked = Array.from(
      document.querySelectorAll("#bulkCatChecks input:checked"),
    ).map((box) => box.value);
    if (!checked.length) {
      showToast("请先勾选至少一个分类", { type: "warning" });
      return;
    }
    if (menu) {
      menu.hidden = true;
      document.getElementById("bulkCatToggle")?.setAttribute("aria-expanded", "false");
    }
    void guard((entries) => bulkApplyFavorites(entries, checked));
  });
  document.getElementById("bulkUnfavoriteBtn")?.addEventListener("click", () => {
    void guard((entries) => bulkRemoveFavorites(entries));
  });
  document.getElementById("bulkExportBtn")?.addEventListener("click", () => {
    void guard((entries) => bulkExportCsv(entries));
  });
  // 面板:点击缩略图取消选中;头部清空
  document.getElementById("selectionPanelGrid")?.addEventListener("click", (event) => {
    const thumb = event.target.closest("[data-sel-thumb-key]");
    if (!thumb) return;
    state.selection.delete(thumb.dataset.selThumbKey);
    syncRowSelectionUi();
    if (state.previewItem) renderPreviewStrip(state.previewItem.images || [], state.previewIndex || 0);
    syncBulkUi();
    persistSelection();
  });
  document.getElementById("selectionPanelClear")?.addEventListener("click", () => {
    state.selection.clear();
    state.selectionData.clear();
    syncRowSelectionUi();
    if (state.previewItem) renderPreviewStrip(state.previewItem.images || [], state.previewIndex || 0);
    syncBulkUi();
    persistSelection();
  });
}

function renderResults(payload) {
  const renderStarted = performance.now();
  const container = document.getElementById("resultsList");
  const items = payload?.items || [];
  const total = payload?.total || 0;
  const page = payload?.page || 1;
  const limit = payload?.limit || state.pageSize;
  const start = total ? (page - 1) * limit + 1 : 0;
  const end = total ? start + items.length - 1 : 0;
  document.getElementById("resultCount").textContent = `第 ${page} 页 · ${start}-${end} / ${total} 条`;
  if (!items.length) {
    container.innerHTML = '<div class="empty">当前筛选下没有记录。</div>';
    state.currentItems = new Map();
    cacheSelectionFromList();
    syncBulkUi();
    return;
  }

  state.currentItems = new Map(items.map((item) => [item.batch?.key || item.file?.sha256, item]));
  cacheSelectionFromList();

  container.innerHTML = `
    <table class="results-table">
      <thead>
        <tr>
          <th style="width: 28%">文件 / 时间 / 目录 / 预览</th>
          <th style="width: 20%">模型 / LoRA / Sampler / Latent</th>
          <th style="width: 34%">正向 Prompt</th>
          <th style="width: 18%">负向 Prompt</th>
        </tr>
      </thead>
      <tbody>
        ${items
          .map((item) => {
            const samplers = item.samplers || [];
            const latent = item.latent || {};
            const loras = item.loras && item.loras.items ? item.loras.items : [];
            const prompts = item.prompts || { positive: [], negative: [] };
            const batch = item.batch || {};
            const isRecipeGroup = item.group_mode === "recipe";
            const recipe = item.recipe || {};
            const batchImages = batch.images || [];
            const itemFile = item.file || {};
            const firstImage = batchImages[0] || itemFile || {};
            const displayFilename = firstImage.filename || itemFile.filename || "(missing file)";
            const displayPath = firstImage.resolved_path || itemFile.resolved_path || "-";
            const thumbUrl = firstImage.sha256 ? apiUrl(`/api/thumb/${firstImage.sha256}?w=420&h=420`) : "";
            const manualLabelMatches = item.manual_label_matches || [];
            const detailPending = Boolean(item.details_pending);
            const fullFirstImage = Array.isArray(item.images) ? item.images[0] || {} : {};
            const rawPrompt = (fullFirstImage.metadata || item.metadata || {}).raw_prompt;
            const samplerCount = samplers.length;
            const samplerNote = samplerCount ? `${samplerCount} 采样节点 · ` : "";
            const batchSummaryText = isRecipeGroup
              ? `聚合 ${batch.count || 1} 张 · ${recipe.batch_count || batch.batch_count || 1} 批次 · ${samplerNote}种子 ${(batch.seeds || []).join(" / ") || "-"}`
              : `${batch.count || 1} 张 · ${samplerNote}种子 ${(batch.seeds || []).join(" / ") || "-"}`;
            const previewMeta = escapeHtml(
              `${displayFilename} | ${formatCapturedAt(item.captured_at, item.created_date, item.created_hour)} | ${displayPath} | ${batchSummaryText}`
            );
            // 尺寸+扩展名并入文件概览列(文件名下方小字),独立「尺寸」列已移除
            const dimsText = `${firstImage.width || itemFile.width || "?"}×${firstImage.height || itemFile.height || "?"}`;
            const dimsExt = itemFile.extension ? ` · ${itemFile.extension}` : "";
            const rowKey = batch.key || itemFile.sha256 || "";
            const rowSelected = Boolean(rowKey) && state.selection.has(rowKey);
            return `
              <tr data-row-key="${escapeHtml(rowKey)}"${rowSelected ? ' class="is-selected"' : ""}>
                <td class="basic-cell">
                  <span class="filename-row">
                    ${
                      rowKey
                        ? `<input type="checkbox" class="row-check" data-select-row="${escapeHtml(rowKey)}" aria-label="选择本行"${rowSelected ? " checked" : ""} />`
                        : ""
                    }
                    <span class="filename-cell">${escapeHtml(displayFilename)}</span>
                  </span>
                  <div class="file-dims">${escapeHtml(dimsText + dimsExt)}</div>
                  <div class="batch-summary" title="${escapeHtml(batchSummaryText)}">${escapeHtml(batchSummaryText)}</div>
                  <div>${formatCapturedAt(item.captured_at, item.created_date, item.created_hour)}</div>
                  <div class="path-cell">${escapeHtml(displayPath)}</div>
                  ${
                    batch.files_preview?.length
                      ? `<div class="batch-files">${batch.files_preview.map((name) => escapeHtml(name)).join("\n")}</div>`
                      : ""
                  }
                  <div class="thumb-wrap">
                    <button
                      class="thumb-link"
                      type="button"
                      ${thumbUrl ? "" : "disabled"}
                      data-preview-batch-key="${escapeHtml(batch.key || itemFile.sha256 || "")}"
                      data-preview-index="0"
                      data-preview-filename="${escapeHtml(displayFilename)}"
                      data-preview-meta="${previewMeta}"
                    >
                      ${thumbUrl ? `<img src="${thumbUrl}" alt="${escapeHtml(displayFilename)}" loading="lazy" />` : '<span class="muted">无预览</span>'}
                    </button>
                  </div>
                  ${detailPending ? "" : tagMatchesHtml(prompts)}
                </td>
                <td>
                  <div class="meta-stack">
                    <div class="meta-block">
                      <span class="meta-label">Model</span>
                      <div>${escapeHtml(item.model?.base_model) || "-"}</div>
                    </div>
                    <div class="meta-block">
                      <span class="meta-label">LoRA</span>
                      <div class="chip-list">
                        ${detailPending ? '<span class="muted">加载中</span>' : loras.map((lora) => loraChipHtml(lora)).join("") || '<span class="muted">-</span>'}
                      </div>
                    </div>
                    ${detailPending ? '<div class="meta-block"><span class="meta-label">Sampler</span><div class="muted">加载中</div></div>' : samplerHtml(samplers)}
                    <div class="meta-block">
                      <span class="meta-label">Latent</span>
                      <div>${detailPending ? "加载中" : `${linkValueText(latent.width)}×${linkValueText(latent.height)}`}</div>
                      <div>${detailPending ? "" : `batch ${latent.batch_size || 1}`}</div>
                    </div>
                    <div class="derived-summary" data-derived-sha="${escapeHtml(firstImage.sha256 || "")}"></div>
                  </div>
                </td>
                <td class="prompt-cell prompt-cell--positive">
                  ${detailPending ? '<div class="muted">正在加载详细信息...</div>' : `${manualLabelMatchesHtml(manualLabelMatches)}${promptSummary(prompts.positive, rawPrompt)}`}
                </td>
                <td class="prompt-cell prompt-cell--negative">${detailPending ? '<div class="muted">正在加载详细信息...</div>' : promptSummary(prompts.negative, rawPrompt)}</td>
              </tr>
            `;
          })
          .join("")}
      </tbody>
    </table>
  `;
  syncSelectAllCheckbox();
  // 主列表视图显示标题栏「全选本页」开关(收藏视图隐藏)
  const selectAllWrap = document.getElementById("selectAllWrap");
  if (selectAllWrap) selectAllWrap.hidden = false;
  syncBulkUi();
  perfLog("renderResults", `${(performance.now() - renderStarted).toFixed(1)}ms items=${items.length}`);
  balancePromptHeights();
  setupPromptHeightObserver();
  void loadDerivedSummaries(items);
}

/**
 * 列表页派生层摘要(ControlNet chips + 区域徽标):页内批量调 /derived/batch,
 * 失败静默(不阻塞列表渲染)。bypassed 灰显、极性/生效区间徽标。
 */
async function loadDerivedSummaries(items) {
  const shas = [];
  for (const item of items) {
    const batchImages = (item.batch?.images) || [];
    const sha = (batchImages[0]?.file?.sha256) || item.file?.sha256 || "";
    if (sha && !shas.includes(sha)) shas.push(sha);
  }
  if (!shas.length) return;
  let entries = [];
  try {
    const payload = await fetchJson(
      "/api/generate/derived/batch",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shas }) },
    );
    entries = payload?.items || [];
  } catch {
    return; // 失败静默
  }
  const bySha = new Map(entries.map((e) => [e.sha256, e]));
  document.querySelectorAll("[data-derived-sha]").forEach((container) => {
    const sha = container.dataset.derivedSha;
    const entry = bySha.get(sha);
    if (!entry || !entry.ok) return;
    const chips = [];
    for (const cn of entry.controlnets || []) {
      const binds = (cn.bindings || [])
        .map((b) => `${b.polarity || ""}${b.steps != null ? `·${b.steps}步` : ""}`)
        .filter(Boolean)
        .join(",");
      const title = `${cn.node_type || ""} ${cn.name || ""}${binds ? ` [${binds}]` : ""}`.trim();
      chips.push(
        `<span class="chip cn-chip${cn.bypassed ? " cn-chip-bypassed" : ""}" title="${escapeHtml(title)}">` +
          `CN ${escapeHtml((cn.name || cn.node_type || "?").slice(0, 18))}` +
          (cn.bypassed ? " (灰)" : "") +
          `</span>`
      );
    }
    if (entry.region_count) {
      chips.push(`<span class="chip region-chip" title="区域/蒙版节点">区域 ${entry.region_count}</span>`);
    }
    if (chips.length) {
      container.innerHTML = chips.join("");
    }
  });
  balancePromptHeights();
}

let promptResizeObserver = null;

function setupPromptHeightObserver() {
  if (typeof ResizeObserver === "undefined" || typeof document === "undefined") return;
  if (!promptResizeObserver) {
    promptResizeObserver = new ResizeObserver(() => {
      if (typeof requestAnimationFrame !== "undefined") {
        requestAnimationFrame(() => balancePromptHeights());
      } else {
        balancePromptHeights();
      }
    });
  }
  promptResizeObserver.disconnect();
  document.querySelectorAll(".results-table tbody tr").forEach((tr) => {
    promptResizeObserver.observe(tr);
  });
}

/**
 * 动态平衡卡片式布局下的正向/负向 Prompt 高度:
 * 核心规则:
 * 1. 空间足够时: 二者完全自然展开(无滚动条、紧凑贴合、绝不浪费任何卡片空间);
 * 2. 空间受限(二者总高度超出卡片可用空间)时: 正向与负向按 7/3 比例分配可用高度;
 *    若某一侧较短未占满份额,剩余高度全量补偿给另一侧,杜绝留白浪费。
 */
function balancePromptHeights() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const isCardLayout = typeof window.innerWidth === "number" ? window.innerWidth <= 1199 : true;
  const rows = document.querySelectorAll(".results-table tbody tr");
  if (!rows || !rows.length) return;

  for (const tr of rows) {
    const posCell = tr.querySelector(".prompt-cell--positive");
    const negCell = tr.querySelector(".prompt-cell--negative");
    if (!posCell || !negCell) continue;

    // 桌面端(>1199px)并行列不受卡片高度制约
    if (!isCardLayout) {
      posCell.style.maxHeight = "";
      negCell.style.maxHeight = "";
      continue;
    }

    // 测量自然高度前先临时清除内联限制
    posCell.style.maxHeight = "none";
    negCell.style.maxHeight = "none";

    const trHeight = tr.clientHeight;
    if (trHeight <= 0) continue;

    const posScroll = posCell.scrollHeight;
    const negScroll = negCell.scrollHeight;

    // 1. 空间足够时: 二者完全自然展开
    if (posScroll + negScroll <= trHeight) {
      posCell.style.maxHeight = "none";
      negCell.style.maxHeight = "none";
    } else {
      // 2. 空间不够时: 正向负向按 7/3 分配可用空间
      const posQuota = trHeight * 0.7;
      const negQuota = trHeight * 0.3;

      if (negScroll <= negQuota) {
        // 负向 Prompt 较短未占满 30% 份额, 剩余高度全部让给正向
        negCell.style.maxHeight = "none";
        posCell.style.maxHeight = `${Math.max(60, Math.floor(trHeight - negScroll))}px`;
      } else if (posScroll <= posQuota) {
        // 正向 Prompt 较短未占满 70% 份额, 剩余高度全部让给负向
        posCell.style.maxHeight = "none";
        negCell.style.maxHeight = `${Math.max(60, Math.floor(trHeight - posScroll))}px`;
      } else {
        // 二者均超额, 严格按 7:3 限制最大可视高度并在内部滚动
        posCell.style.maxHeight = `${Math.floor(posQuota)}px`;
        negCell.style.maxHeight = `${Math.floor(negQuota)}px`;
      }
    }
  }
}

function renderPagination(payload) {
  const container = document.getElementById("paginationBar");
  const total = payload?.total || 0;
  const page = payload?.page || 1;
  // 后端分页契约:{ items, total, page, limit, group_mode, pages }(pages=总页数)
  const totalPages = payload?.pages || 1;
  state.totalPages = totalPages;
  if (!total) {
    container.innerHTML = "";
    return;
  }
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  container.innerHTML = `
    <div class="pagination-actions">
      <button class="action secondary" type="button" data-page-action="prev" ${hasPrev ? "" : "disabled"}>← 上一页</button>
      <span class="pagination-summary">第 <input class="pagination-jump" type="text" inputmode="numeric" value="${page}" data-page-jump aria-label="跳转到页码,回车确认" /> / ${totalPages} 页 · 共 ${total} 条</span>
      <button class="action secondary" type="button" data-page-action="next" ${hasNext ? "" : "disabled"}>下一页 →</button>
    </div>
  `;
}

/**
 * 列表加载骨架:查询变更/首载时替换旧行,避免"旧查询的行"误导;
 * 由 refreshList 与 boot 在发起请求前调用,成功后 renderResults 覆盖。
 */
function renderSkeletonRows() {
  const container = document.getElementById("resultsList");
  document.getElementById("resultCount").textContent = "加载中...";
  container.innerHTML = `
    <table class="results-table" aria-hidden="true">
      <thead>
        <tr>
          <th style="width: 28%">文件 / 时间 / 目录 / 预览</th>
          <th style="width: 20%">模型 / LoRA / Sampler / Latent</th>
          <th style="width: 34%">正向 Prompt</th>
          <th style="width: 18%">负向 Prompt</th>
        </tr>
      </thead>
      <tbody>
        ${Array.from({ length: 8 }, () => `
          <tr>
            <td><div class="skeleton" style="height: 12px; margin-bottom: 6px"></div><div class="skeleton" style="height: 10px; width: 60%"></div></td>
            <td><div class="skeleton" style="height: 10px; width: 70%"></div></td>
            <td><div class="skeleton" style="height: 10px; width: 90%"></div></td>
            <td><div class="skeleton" style="height: 10px; width: 80%"></div></td>
          </tr>`).join("")}
      </tbody>
    </table>
  `;
}

function updateSummaryFromList(payload) {
  document.getElementById("totalImages").textContent = payload?.total || 0;
  const totalItemsLabel = document.getElementById("totalItemsLabel");
  if (totalItemsLabel) {
    totalItemsLabel.textContent = "批次";
  }
  if (state.activeTool === "none") {
    document.getElementById("dateRange").textContent = "-";
    document.getElementById("avgStats").textContent = "-";
  }
}

function renderPreviewStrip(images, activeIndex) {
  const renderStarted = performance.now();
  const container = document.getElementById("imagePreviewStrip");
  // 行级 key(与列表行 checkbox / 全选共用),同一批内所有图代表同一行待处理
  const rowKey = rowKeyOf(state.previewItem?.item || {});
  const pending = Boolean(rowKey) && state.selection.has(rowKey);
  container.innerHTML = images
    .map((image, index) => {
      const imageUrl = image.object_url || (image.sha256 ? apiUrl(`/api/thumb/${image.sha256}?w=180&h=180`) : "");
      // 左侧竖列每张缩略图旁一个「待处理」checkbox:勾选 = 加入/移出左下角待处理(selection),
      // 不直接收藏;收藏统一走详情里 tag 点击或左下角批量操作。
      return `
        <div class="preview-strip-item ${index === activeIndex ? "is-active" : ""}">
          <button
            class="preview-strip-thumb"
            type="button"
            data-preview-strip-index="${index}"
            title="切换预览"
          >
            <img${imageUrl ? ` src="${escapeHtml(imageUrl)}"` : ""} alt="${escapeHtml(image.filename || `batch-${index + 1}`)}" loading="lazy" />
          </button>
          <div class="preview-strip-meta">
            <button class="preview-strip-name" type="button" data-preview-strip-index="${index}" title="切换预览">${escapeHtml(image.filename || `第 ${index + 1} 张`)}</button>
            ${
              rowKey
                ? `<label class="preview-strip-check" title="${pending ? "移出待处理" : "加入待处理"}">
                     <input type="checkbox" data-preview-strip-fav="${escapeHtml(rowKey)}"${pending ? " checked" : ""} aria-label="加入待处理" />
                     <span class="preview-strip-check-label">待处理</span>
                   </label>`
                : ""
            }
          </div>
        </div>
      `;
    })
    .join("");
  perfLog("renderPreviewStrip", `${(performance.now() - renderStarted).toFixed(1)}ms items=${images.length}`);
}

function linkValueText(value) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  if (typeof value === "object") {
    const nodeType = value.class_type || value.node_type || "节点";
    const nodeId = value.node_id !== undefined && value.node_id !== null ? `#${value.node_id}` : "";
    return `${nodeType}${nodeId}`;
  }
  return String(value);
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "-";
  }
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function previewDetailRow(label, valueHtml) {
  return `<div class="detail-row"><span class="detail-label">${label}</span><div class="detail-value">${valueHtml}</div></div>`;
}

function samplerStageLabel(sampler, index) {
  let label = `阶段 ${index + 1}`;
  const denoise = sampler?.denoise;
  if (denoise !== undefined && denoise !== null && denoise !== "") {
    const value = Number(linkValueText(denoise));
    if (Number.isFinite(value)) {
      label += value >= 0.999 ? ` · 主采样 (denoise ${value})` : ` · 后处理 (denoise ${value})`;
    }
  } else if (index === 0) {
    label += " · 主采样";
  }
  return label;
}

function seedStageRows(samplers, seedImages, previewIndex, item) {
  const normalized = Array.isArray(seedImages) && seedImages.length > 0 ? seedImages : null;
  const batch = item?.batch || {};
  const recipe = item?.recipe || {};
  const members = Array.isArray(recipe.members) && recipe.members.length > 0 ? recipe.members : null;
  const batchSeeds = Array.isArray(batch.seeds) ? batch.seeds : [];
  const imageCount = (state.previewItem?.images || []).length || batch.count || 1;

  return samplers
    .map((sampler, index) => {
      const parts = [];
      let currentValue = null;
      let stageFixed = false;

      if (normalized) {
        const entry = normalized[previewIndex] || {};
        const value = entry.seeds ? entry.seeds[index] : null;
        if (value !== null && value !== undefined) {
          currentValue = value;
          const column = normalized.map((e) => (e.seeds ? e.seeds[index] : null));
          stageFixed =
            column.length > 1 &&
            column.every((v) => v !== null && v !== undefined && String(v) === String(column[0]));
        }
      }

      if (currentValue === null || currentValue === undefined) {
        if (members && members[previewIndex]) {
          const m = members[previewIndex];
          const mSeeds = Array.isArray(m.seeds) ? m.seeds : (m.seeds !== null && m.seeds !== undefined ? [m.seeds] : []);
          const val = mSeeds[index] !== undefined ? mSeeds[index] : mSeeds[0];
          if (val !== null && val !== undefined) {
            currentValue = val;
            const column = members.map((m) => {
              const s = Array.isArray(m.seeds) ? m.seeds : (m.seeds !== null && m.seeds !== undefined ? [m.seeds] : []);
              return s[index] !== undefined ? s[index] : s[0];
            });
            stageFixed =
              column.length > 1 &&
              column.every((v) => v !== null && v !== undefined && String(v) === String(column[0]));
          }
        }
      }

      if (currentValue === null || currentValue === undefined) {
        const seed = sampler.seed;
        if (Array.isArray(seed)) {
          currentValue = seed[previewIndex];
          stageFixed =
            seed.length > 1 &&
            seed.every((s) => s !== null && s !== undefined && String(s) === String(seed[0]));
        } else if (batchSeeds.length > 1 && samplers.length === 1) {
          currentValue = batchSeeds[previewIndex] !== undefined ? batchSeeds[previewIndex] : seed;
          stageFixed =
            batchSeeds.length > 1 &&
            batchSeeds.every((s) => s !== null && s !== undefined && String(s) === String(batchSeeds[0]));
        } else if (seed !== null && seed !== undefined && seed !== "") {
          currentValue = seed;
          stageFixed = imageCount > 1 && batchSeeds.length <= 1;
        }
      }

      if (currentValue === null || currentValue === undefined) {
        parts.push('<span class="detail-mono">-</span>');
      } else {
        parts.push(`<span class="detail-mono">${escapeHtml(linkValueText(currentValue))}</span>`);
        if (stageFixed) {
          parts.push('<span class="muted">固定</span>');
        }
      }
      if (sampler.noise_seed !== undefined && sampler.noise_seed !== null && sampler.noise_seed !== "") {
        parts.push(`<span class="muted">noise ${escapeHtml(linkValueText(sampler.noise_seed))}</span>`);
      }
      if (sampler.seed_source && typeof sampler.seed_source === "object") {
        const source = sampler.seed_source;
        parts.push(
          `<span class="muted">来源 ${escapeHtml(source.node_type || "?")}${source.node_id != null ? ` #${escapeHtml(source.node_id)}` : ""}</span>`
        );
      }
      return previewDetailRow(escapeHtml(samplerStageLabel(sampler, index)), parts.join(" · "));
    })
    .join("");
}

function novelaiRawJsonBlock(label, value) {
  let text = value;
  try {
    text = JSON.stringify(JSON.parse(value), null, 2);
  } catch (_error) {
    // 非 JSON 时保留原文
  }
  return `<details class="detail-enrichment-raw"><summary>${escapeHtml(label)}</summary>
    <div class="detail-enrichment-raw-head"><button type="button" data-copy-raw-json="novelai">复制 JSON</button></div>
    <pre class="detail-enrichment-raw-pre">${escapeHtml(text)}</pre>
  </details>`;
}

function renderPreviewDetails() {
  const container = document.getElementById("imagePreviewDetails");
  const item = state.previewItem?.item;
  if (!container) {
    return;
  }
  if (!item) {
    container.innerHTML = "";
    return;
  }
  const file = state.previewItem.images[state.previewIndex] || {};
  const batch = item.batch || {};
  const latent = item.latent || {};
  const loras = item.loras && item.loras.items ? item.loras.items : [];
  const samplers = item.samplers || [];
  const prompts = item.prompts || { positive: [], negative: [] };
  const matchedTagHtml = tagMatchesHtml([...(prompts.positive || []), ...(prompts.negative || [])]);
  const seeds = batch.seeds || [];
  const imageCount = (state.previewItem.images || []).length;
  // batch.images 为轻量 file 列表;完整 image entry(含 metadata)在 item.images
  const fullImages = Array.isArray(item.images) ? item.images : [];
  const fullFile = fullImages[state.previewIndex] || {};
  const previewMeta = fullFile.metadata || file.metadata || item.metadata || {};
  const displayPositivePrompts = promptEntriesForDisplay(prompts.positive, previewMeta.raw_prompt);
  const displayNegativePrompts = promptEntriesForDisplay(prompts.negative, previewMeta.raw_prompt);
  const enrichmentHtml = (window.aaEnrichmentView || window.wfdbEnrichmentView)?.render(item.enrichment, previewMeta) || "";
  const rawNovelai = previewMeta.raw_novelai || "";
  const novelaiHtml = rawNovelai
    ? `
    <section class="detail-section detail-enrichment">
      <div class="detail-enrichment-head"><h3>来源</h3><span class="detail-enrichment-status">NovelAI</span></div>
      ${novelaiRawJsonBlock("NovelAI 原始元数据", rawNovelai)}
    </section>`
    : "";

  container.innerHTML = `
    ${enrichmentHtml}
    ${novelaiHtml}
    <section class="detail-section">
      <h3>文件</h3>
      ${previewDetailRow("文件名", escapeHtml(file.filename || "-"))}
      ${previewDetailRow("路径", `<span class="detail-mono">${escapeHtml(file.resolved_path || "-")}</span>`)}
      ${previewDetailRow("尺寸", `${escapeHtml(linkValueText(file.width))} × ${escapeHtml(linkValueText(file.height))}`)}
      ${previewDetailRow("大小", formatBytes(file.size_bytes))}
      ${previewDetailRow("格式", escapeHtml([file.format, file.mode].filter(Boolean).join(" · ") || "-"))}
      ${file.source?.instance_id ? previewDetailRow("实例", escapeHtml(file.source.instance_id)) : ""}
    </section>
    <section class="detail-section">
      <h3>批次</h3>
      ${previewDetailRow("张数", String(batch.count || imageCount || 1))}
      ${
        samplers.length
          ? seedStageRows(samplers, batch.seed_images, state.previewIndex, item)
          : previewDetailRow("Seed", `<span class="detail-mono">${escapeHtml(seeds.join(" / ") || "-")}</span>`)
      }
      ${
        samplers.length
          ? '<div class="detail-hint">多 sampler 通常为多次采样(主采样 + 后处理/放大),后处理阶段 seed 常为固定值;批量种子时每张图对应自己的 seed</div>'
          : ""
      }
    </section>
    <section class="detail-section">
      <h3>模型</h3>
      ${previewDetailRow("Base", escapeHtml(item.model?.base_model || "-"))}
      ${previewDetailRow("Latent", `${escapeHtml(linkValueText(latent.width))} × ${escapeHtml(linkValueText(latent.height))} · batch ${escapeHtml(linkValueText(latent.batch_size))}`)}
    </section>
    <section class="detail-section">
      <h3>LoRA</h3>
      <div class="chip-list">${loras.map((lora) => loraChipHtml(lora)).join("") || '<span class="muted">-</span>'}</div>
    </section>
    ${renderDerivedSections(state.previewDerived)}
    <section class="detail-section">
      <h3>Sampler</h3>
      ${
        samplers.length
          ? samplers
              .map(
                (sampler, index) => `
        <div class="detail-sampler">
          <div class="detail-sampler-head">Sampler ${index + 1}</div>
          ${previewDetailRow("Seed", `<span class="detail-mono">${escapeHtml(linkValueText(sampler.seed))}</span>`)}
          ${
            sampler.noise_seed !== undefined && sampler.noise_seed !== null && sampler.noise_seed !== ""
              ? previewDetailRow("Noise Seed", `<span class="detail-mono">${escapeHtml(linkValueText(sampler.noise_seed))}</span>`)
              : ""
          }
          ${previewDetailRow("Steps / CFG", `${escapeHtml(linkValueText(sampler.steps))} / ${escapeHtml(linkValueText(sampler.cfg))}`)}
          ${previewDetailRow("采样器", `${escapeHtml(linkValueText(sampler.sampler_name))} / ${escapeHtml(linkValueText(sampler.scheduler))}`)}
          ${previewDetailRow("Denoise", escapeHtml(linkValueText(sampler.denoise)))}
        </div>`
              )
              .join("")
          : '<div class="muted">-</div>'
      }
    </section>
    <section class="detail-section">
      <h3>正向 Prompt</h3>
      ${promptSummary(displayPositivePrompts)}
    </section>
    <section class="detail-section">
      <h3>负向 Prompt</h3>
      ${promptSummary(displayNegativePrompts)}
    </section>
    <section class="detail-section detail-tag-section" ${matchedTagHtml ? "" : "hidden"}>
      <h3>标记</h3>
      ${matchedTagHtml}
    </section>
    <section class="detail-section detail-tag-suggest" id="tagSuggestSection" hidden>
      <h3>补全参考</h3>
      <div id="tagSuggestBody" class="muted">加载中…</div>
    </section>
  `;
  void loadTagSuggestions(item.batch?.key || item.batch_key || "");
}

function getActiveWorkflowData() {
  if (!state.previewItem) return null;
  const previewFullImages = Array.isArray(state.previewItem.item?.images)
    ? state.previewItem.item.images
    : [];
  const activeImage = (state.previewItem.images || [])[state.previewIndex] || {};
  const activeMeta =
    (previewFullImages[state.previewIndex] || {}).metadata ||
    activeImage.metadata ||
    state.previewItem.item?.metadata ||
    {};
  let wf = activeMeta.raw_workflow || activeMeta.raw_prompt;
  if (!wf) return null;
  if (typeof wf === "string") {
    try {
      wf = JSON.parse(wf);
    } catch {
      return null;
    }
  }
  return wf;
}

function sanitizeWorkflowPaths(obj) {
  const jsonStr = JSON.stringify(obj, null, 2);
  // 脱敏盘符绝对路径与常见用户目录
  return jsonStr.replace(
    /([A-Za-z]:[/\\](?:Users[/\\][^\s"\\/]+|[^\s"]+)|\/(?:home|Users)\/[^\s"\\/]+)/g,
    "<path>"
  );
}

function downloadJsonFile(filename, content) {
  const blob = new Blob([content], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function syncPreviewView() {
  const modal = document.getElementById("imagePreviewModal");
  const image = document.getElementById("imagePreviewImg");
  const body = document.getElementById("imagePreviewBody");
  const images = state.previewItem?.images || [];
  const activeImage = images[state.previewIndex];
  if (!state.previewItem || !activeImage) {
    modal.hidden = true;
    document.body.classList.remove("preview-open");
    return;
  }
  document.getElementById("imagePreviewTitle").textContent = activeImage.filename || "图片预览";

  const previewItem = state.previewItem;
  const item = previewItem.item;
  let fullMetaText = "";

  if (item) {
    const isRecipeGroup = Boolean(item.recipe && (item.batch_count || item.recipe.batch_count || 1) > 1);
    const recipe = item.recipe || {};
    const batch = item.batch || {};
    const itemFile = item.file || {};
    const displayFilename = activeImage.filename || itemFile.filename || "(missing file)";
    const displayPath = activeImage.resolved_path || itemFile.resolved_path || "-";
    const timeStr = formatCapturedAt(item.captured_at, item.created_date, item.created_hour);
    const samplers = item.samplers || [];
    const samplerCount = samplers.length;
    const countNote = isRecipeGroup
      ? `聚合 ${batch.count || images.length || 1} 张 · ${recipe.batch_count || batch.batch_count || 1} 批次`
      : `${batch.count || images.length || 1} 张`;
    const samplerNote = samplerCount ? `${samplerCount} 采样节点` : "";
    const indexNote = `第 ${state.previewIndex + 1} / ${images.length || 1} 张`;
    const seeds = Array.isArray(batch.seeds) ? batch.seeds : (item.seed !== undefined && item.seed !== null ? [item.seed] : []);
    const seedsText = seeds.length ? `种子 ${seeds.join(" / ")}` : "";

    const batchSegments = [countNote, samplerNote, indexNote, seedsText].filter(Boolean);
    const batchText = batchSegments.join(" · ");
    fullMetaText = [displayFilename, timeStr, displayPath, batchText].filter(Boolean).join(" | ");
  } else {
    const rawMeta = previewItem.meta || "";
    const indexNote = `第 ${state.previewIndex + 1} / ${images.length || 1} 张`;
    if (rawMeta.includes(" · 种子 ")) {
      const match = rawMeta.match(/^(.*?) · (种子 .*)$/);
      if (match) {
        fullMetaText = `${match[1]} · ${indexNote} · ${match[2]}`;
      } else {
        fullMetaText = `${rawMeta} · ${indexNote}`;
      }
    } else {
      fullMetaText = `${rawMeta} · ${indexNote}`;
    }
  }

  const metaElem = document.getElementById("imagePreviewMeta");
  if (metaElem) {
    metaElem.textContent = fullMetaText;
    metaElem.title = fullMetaText;
  }
  const isTransient = Boolean(
    state.previewItem.transient ||
      activeImage.is_transient_upload ||
      state.previewItem.item?.source_mode === "transient",
  );
  // NovelAI 记录:重放/ComfyUI 打开/顶部复制均无意义(batch.images 为轻量
  // file,完整 entry 含 metadata 在 item.images)
  const previewFullImages = Array.isArray(state.previewItem.item?.images)
    ? state.previewItem.item.images
    : [];
  const activeMeta = (previewFullImages[state.previewIndex] || {}).metadata || activeImage.metadata || {};
  const isNovelai = Boolean(activeMeta.raw_novelai);
  const imageUrl = activeImage.object_url ||
    (activeImage.sha256 ? apiUrl(`/api/image/${activeImage.sha256}`) : "");
  if (imageUrl) {
    image.src = imageUrl;
  } else {
    image.removeAttribute("src");
  }
  image.alt = activeImage.filename || "预览图";
  body.classList.remove("is-zoomed");
  const generateLink = document.getElementById("previewGenerateLink");
  if (generateLink) {
    generateLink.hidden = isTransient || isNovelai || !activeImage.sha256;
    generateLink.href = activeImage.sha256
      ? `/generate?sha256=${encodeURIComponent(activeImage.sha256)}`
      : "/generate";
    generateLink.classList.toggle("is-disabled", !activeImage.sha256);
  }
  const copyButton = document.getElementById("copyPositiveBtn");
  if (copyButton) {
    copyButton.hidden = isNovelai;
  }
  const wfData = getActiveWorkflowData();
  const copyWfBtn = document.getElementById("copyWorkflowBtn");
  if (copyWfBtn) {
    copyWfBtn.hidden = !wfData || isNovelai;
  }
  const exportWfBtn = document.getElementById("exportWorkflowBtn");
  if (exportWfBtn) {
    exportWfBtn.hidden = !wfData || isNovelai;
  }
  renderPreviewStrip(images, state.previewIndex);
  renderPreviewDetails();
  document.getElementById("previewPrevBtn").disabled = state.previewIndex <= 0;
  document.getElementById("previewNextBtn").disabled = state.previewIndex >= images.length - 1;
  modal.hidden = false;
  document.body.classList.add("preview-open");
  // 切图时重置视图为缩略图,异步加载派生层摘要(ControlNet/区域/节点图)
  state.previewView = "image";
  state.previewDerived = null;
  const graphBtn = document.getElementById("previewNodeGraphBtn");
  if (graphBtn) graphBtn.hidden = true;
  renderPreviewStage();
  if (!isTransient && activeImage.sha256) {
    void loadPreviewDerived(activeImage.sha256);
  }
  syncFavoriteStars();
}

/** 加载详情页派生层摘要(/derived/:sha256),失败静默。 */
async function loadPreviewDerived(sha256) {
  if (state.previewItem?.transient) return;
  try {
    const payload = await fetchJson(`/api/generate/derived/${encodeURIComponent(sha256)}`);
    if (!payload || typeof payload !== "object") return;
    if (state.previewItem?.transient) return;
    state.previewDerived = payload;
    renderPreviewDetails();
    const graphBtn = document.getElementById("previewNodeGraphBtn");
    if (graphBtn) {
      graphBtn.hidden = !(payload.node_graph?.nodes?.length);
    }
    // 若已处于节点图视图,数据到达后重渲染
    if (state.previewView === "graph") {
      renderPreviewStage();
    }
  } catch {
    /* 静默 */
  }
}

/** 图区视图:image(默认缩略图) 或 graph(节点图 SVG)。stage 容器按需创建,不 remove。 */
function renderPreviewStage() {
  const body = document.getElementById("imagePreviewBody");
  const image = document.getElementById("imagePreviewImg");
  if (!body || !image) return;
  let stage = document.getElementById("previewNodeGraphStage");
  if (!stage) {
    stage = document.createElement("div");
    stage.id = "previewNodeGraphStage";
    body.appendChild(stage);
  }
  if (state.previewView === "graph") {
    image.style.display = "none";
    stage.style.display = "block";
    stage.innerHTML = renderNodeGraphSVG(state.previewDerived?.node_graph);
    bindNodeGraphZoom(stage);
  } else {
    image.style.display = "";
    stage.style.display = "none";
    stage.innerHTML = "";
  }
}

/**
 * 节点图缩放/平移:滚轮缩放(0.5x-6x)、拖拽平移、控件按钮(+/−/重置)。
 * 每次重建 stage 时重新绑定;transform 作用于 svg,不修改 viewBox。
 */
function bindNodeGraphZoom(stage) {
  const svg = stage.querySelector("svg");
  if (!svg) return;
  let scale = 1;
  let tx = 0;
  let ty = 0;
  const apply = () => {
    svg.style.transformOrigin = "0 0";
    svg.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };
  const clampScale = (s) => Math.min(6, Math.max(0.5, s));

  stage.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
      scale = clampScale(scale * factor);
      apply();
    },
    { passive: false }
  );

  let drag = null;
  stage.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".ng-zoom-controls")) return;
    drag = { x: event.clientX, y: event.clientY, tx, ty };
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener("pointermove", (event) => {
    if (!drag) return;
    tx = drag.tx + (event.clientX - drag.x);
    ty = drag.ty + (event.clientY - drag.y);
    apply();
  });
  stage.addEventListener("pointerup", () => {
    drag = null;
  });
  stage.addEventListener("pointercancel", () => {
    drag = null;
  });

  stage.querySelectorAll("[data-ng-zoom]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.ngZoom === "in") {
        scale = clampScale(scale * 1.25);
      } else if (btn.dataset.ngZoom === "out") {
        scale = clampScale(scale / 1.25);
      } else {
        scale = 1;
        tx = 0;
        ty = 0;
      }
      apply();
    });
  });

  // 缩放控件(浮层)
  const controls = document.createElement("div");
  controls.className = "ng-zoom-controls";
  controls.innerHTML =
    '<button type="button" data-ng-zoom="in" title="放大">+</button>' +
    '<button type="button" data-ng-zoom="out" title="缩小">−</button>' +
    '<button type="button" data-ng-zoom="reset" title="重置">⟳</button>';
  stage.appendChild(controls);
}

/** 派生层详情区块(ControlNet + 区域/蒙版),数据未加载时占位。 */
function renderDerivedSections(derived) {
  if (!derived) return "";
  const sections = [];
  const cns = derived.controlnets || [];
  if (cns.length) {
    sections.push(`<section class="detail-section"><h3>ControlNet <span class="muted">${cns.length}</span></h3>
      ${cns
        .map(
          (cn) => `
        <div class="detail-sampler${cn.bypassed ? " is-muted" : ""}">
          <div class="detail-sampler-head">${escapeHtml(cn.node_type || "?")}${cn.bypassed ? " · 已 bypass" : ""}</div>
          ${previewDetailRow("模型", escapeHtml(cn.name || "-"))}
          ${cn.strength != null ? previewDetailRow("强度", String(cn.strength)) : ""}
          ${cn.start_percent != null ? previewDetailRow("生效范围", `${cn.start_percent} - ${cn.end_percent}`) : ""}
          ${cn.bindings?.length ? previewDetailRow("绑定", cn.bindings.map((b) => `sampler ${b.sampler_id} · ${b.polarity} · steps ${b.steps ?? "-"} · 生效 ${b.effective_start_step ?? "-"}-${b.effective_end_step ?? "-"}`).join("<br>")) : ""}
        </div>`
        )
        .join("")}</section>`);
  }
  const regions = derived.regions || [];
  if (regions.length) {
    sections.push(`<section class="detail-section"><h3>区域 / 蒙版 <span class="muted">${regions.length}</span></h3>
      ${regions
        .map(
          (r) => {
            // 容器节点(AttentionCouple 聚合等):仅结构/参数,不贴重复文本;
            // 叶子节点:完整 cond 文本 + mask 链
            const isContainer = r.kind === "container" || r.node_type === "AttentionCouple" || r.node_type === "AttentionCoupleRegions" || r.node_type === "ConditioningSetPropertiesAndCombine";
            const headSuffix = isContainer ? " <span class=\"muted\">聚合</span>" : "";
            const regionCount = r.params?.region_count;
            return `
        <div class="detail-sampler${isContainer ? " detail-sampler-container" : ""}">
          <div class="detail-sampler-head">${escapeHtml(r.node_type || "?")}${headSuffix}${r.sampler_ids?.length ? ` <span class="muted">sampler ${r.sampler_ids.join("/")}</span>` : ""}</div>
          ${isContainer
            ? (regionCount != null ? previewDetailRow("区域数", String(regionCount)) : "")
            : `
          ${r.mask_source ? previewDetailRow("蒙版", `${escapeHtml(r.mask_source)}${r.mask_slot != null ? ` [槽 ${r.mask_slot}]` : ""}${r.mask_nodes?.length ? ` → ${r.mask_nodes.map((m) => escapeHtml(`${m.node_type}${Object.entries(m.params || {}).map(([k, v]) => `(${k}=${v})`).join("")}`)).join(" → ")}` : ""}`) : ""}
          ${Object.entries(r.params || {}).map(([k, v]) => previewDetailRow(k, escapeHtml(String(v)))).join("")}
          ${r.cond_texts?.length ? `<div class="detail-cond">${escapeHtml(r.cond_texts.join("\n---\n"))}</div>` : ""}
          `}
        </div>`;
          }
        )
        .join("")}</section>`);
  }
  return sections.join("");
}

/**
 * 节点图 SVG 渲染 — DAG 横向分层布局(简化 Sugiyama):
 *   按最长路径分层,层沿水平方向(入度 0 的源在最左,逐层向右到 sampler/输出),
 *   层内按角色排序减少交叉,边用三次贝塞尔曲线(源右缘 → 汇左缘)平滑流向,
 *   sampler 连通分量用半透明背景块分组标注,bypassed 灰显。
 * 纯展示,无交互库依赖。
 */
function renderNodeGraphSVG(graph) {
  if (!graph || !Array.isArray(graph.nodes) || !graph.nodes.length) {
    return '<div class="muted">该工作流无节点图数据。</div>';
  }
  const roleColors = {
    model: "#3b82f6",
    prompt: "#10b981",
    latent: "#f59e0b",
    post: "#a855f7",
    clip: "#06b6d4",
    transparent: "#64748b",
    other: "#64748b",
  };
  const kindColors = {
    model: "#3b82f6",
    positive: "#10b981",
    negative: "#ef4444",
    latent: "#f59e0b",
    image: "#f97316",
    mask: "#ec4899",
    clip: "#06b6d4",
    conditioning: "#14b8a6",
    vae: "#a855f7",
    other: "#64748b",
  };
  const roleOrder = {
    model: 0,
    clip: 1,
    prompt: 2,
    conditioning: 3,
    latent: 4,
    post: 5,
    transparent: 6,
    other: 7,
  };
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const edges = (graph.edges || []).filter((e) => nodeMap.has(e.from) && nodeMap.has(e.to));
  const nodeH = 34;
  const slotH = 50;
  const padLeft = 24;
  const padTop = 36;
  const padBottom = 28;
  const colGap = 84;

  // 1) 分层:最长路径算法
  const depth = new Map();
  for (const n of graph.nodes) depth.set(n.id, 0);
  for (let iter = 0; iter < graph.nodes.length; iter++) {
    let changed = false;
    for (const e of edges) {
      const nd = (depth.get(e.from) ?? 0) + 1;
      if ((depth.get(e.to) ?? 0) < nd) {
        depth.set(e.to, nd);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const layerCount = Math.max(0, ...depth.values()) + 1;

  // 2) 层内排序(角色优先级 + id 数值)
  const idNum = (id) => parseInt(String(id).replace(/[^\d-]/g, ""), 10) || 0;
  const layers = [];
  for (let l = 0; l < layerCount; l++) layers.push([]);
  for (const n of graph.nodes) layers[depth.get(n.id)].push(n);
  for (const layer of layers) {
    layer.sort(
      (a, b) =>
        (roleOrder[a.role] ?? 7) - (roleOrder[b.role] ?? 7) ||
        idNum(a.id) - idNum(b.id)
    );
  }

  // 3) 布局:宽度与坐标
  const labelOf = (n) => {
    const title = n.title || n.class_type;
    return title.length > 26 ? `${title.slice(0, 24)}…` : title;
  };
  const charW = 7;
  const maxLabelLen = Math.max(
    ...graph.nodes.map((n) => labelOf(n).length + String(n.id).length)
  );
  const colW = Math.max(210, Math.min(320, maxLabelLen * charW + 54));
  const maxNodesPerLayer = Math.max(...layers.map((l) => l.length));
  const width = padLeft * 2 + layerCount * colW + (layerCount - 1) * colGap;
  const height = Math.max(padTop + maxNodesPerLayer * slotH + padBottom, 200);

  const nodePos = new Map();
  layers.forEach((layer, li) => {
    const x = padLeft + li * (colW + colGap);
    const yOffset = ((maxNodesPerLayer - layer.length) * slotH) / 2;
    layer.forEach((n, ci) => {
      nodePos.set(n.id, { x, y: padTop + yOffset + ci * slotH, w: colW });
    });
  });

  // 4) 分组背景块(sampler 连通分量 / unattached)
  const groupBlocks = [];
  for (const g of graph.groups || []) {
    const ids = (g.node_ids || []).filter((id) => nodeMap.has(id));
    if (!ids.length) continue;
    const pos = ids.map((id) => nodePos.get(id));
    const minX = Math.min(...pos.map((p) => p.x)) - 10;
    const maxX = Math.max(...pos.map((p) => p.x + p.w)) + 10;
    const minY = Math.min(...pos.map((p) => p.y)) - 26;
    const maxY = Math.max(...pos.map((p) => p.y + nodeH)) + 10;
    const title = `${g.sampler_type || "unattached"}${g.sampler_id ? ` #${g.sampler_id}` : ""}`;
    groupBlocks.push({
      head: title,
      minX,
      maxX,
      minY,
      maxY,
    });
  }

  let svg = `<svg viewBox="0 0 ${width} ${height}" class="node-graph-svg" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<defs>
    <pattern id="ng-grid" width="20" height="20" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1" class="ng-grid-dot"/>
    </pattern>
    <filter id="ng-shadow" x="-5%" y="-10%" width="110%" height="125%" filterUnits="userSpaceOnUse">
      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#000000" flood-opacity="0.3"/>
    </filter>
  </defs>`;
  svg += `<style>
    .ng-grid-dot { fill: var(--muted, #94a3b8); opacity: 0.12; }
    .ng-node { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif; cursor: default; }
    .ng-node text { user-select: none; }
    .ng-edge { stroke-width: 1.8; fill: none; stroke-linecap: round; transition: stroke-width 0.2s, opacity 0.2s; }
    .ng-edge:hover { stroke-width: 3.5; opacity: 1; }
    .ng-port { stroke: var(--surface, #1e293b); stroke-width: 1.5; }
    .ng-group-box { fill: var(--surface-dim, rgba(15, 23, 42, 0.25)); stroke: var(--line, #334155); stroke-dasharray: 4 4; stroke-width: 1; rx: 8px; }
    .ng-group-badge { fill: var(--panel, #1e293b); stroke: var(--line-strong, #475569); stroke-width: 1; rx: 4px; }
    .ng-group-text { font-size: 11px; font-weight: 600; fill: var(--muted, #94a3b8); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .ng-node-card { fill: var(--surface, #1e293b); rx: 6px; transition: stroke-width 0.15s, filter 0.15s; }
    .ng-node:hover .ng-node-card { stroke-width: 2; filter: brightness(1.12); }
    .ng-node-id-badge { fill: var(--panel, rgba(0, 0, 0, 0.12)); stroke: var(--line, rgba(255, 255, 255, 0.1)); stroke-width: 0.8; rx: 3px; }
    .ng-node-id-text { font-size: 10px; font-weight: 700; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; fill: var(--muted, #94a3b8); text-anchor: middle; }
    .ng-node-title { font-size: 12px; font-weight: 600; fill: var(--text, #f8fafc); }
  </style>`;

  // 1. Grid 背景
  svg += `<rect width="100%" height="100%" fill="url(#ng-grid)"/>`;

  // 2. 分组背景块(底层)
  for (const b of groupBlocks) {
    const badgeW = Math.max(70, b.head.length * 6.8 + 16);
    svg += `<g class="ng-group">`;
    svg += `<rect x="${b.minX}" y="${b.minY}" width="${b.maxX - b.minX}" height="${b.maxY - b.minY}" class="ng-group-box"/>`;
    svg += `<rect x="${b.minX + 8}" y="${b.minY + 4}" width="${badgeW}" height="16" class="ng-group-badge"/>`;
    svg += `<text class="ng-group-text" x="${b.minX + 14}" y="${b.minY + 16}">${escapeHtml(b.head)}</text>`;
    svg += `</g>`;
  }

  // 3. 边: 三次贝塞尔曲线(源右缘 → 汇左缘) + 端口小圆点
  for (const e of edges) {
    const f = nodePos.get(e.from);
    const t = nodePos.get(e.to);
    if (!f || !t) continue;
    const x1 = f.x + f.w;
    const y1 = f.y + nodeH / 2;
    const x2 = t.x;
    const y2 = t.y + nodeH / 2;
    const dx = Math.max(32, Math.min(140, (x2 - x1) * 0.45));
    const color = kindColors[e.kind] || kindColors.other;
    svg += `<path class="ng-edge" d="M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}" stroke="${color}" opacity="0.75"/>`;
    svg += `<circle cx="${x1}" cy="${y1}" r="3" fill="${color}" class="ng-port"/>`;
    svg += `<circle cx="${x2}" cy="${y2}" r="3" fill="${color}" class="ng-port"/>`;
  }

  // 4. 节点卡片
  for (const n of graph.nodes) {
    const pos = nodePos.get(n.id);
    const color = n.bypassed ? "#64748b" : (roleColors[n.role] || roleColors.other);
    const idStr = String(n.id);
    const idBadgeW = Math.max(20, idStr.length * 6.5 + 8);
    const titleText = labelOf(n);

    svg += `<g class="ng-node" data-node-id="${escapeHtml(idStr)}">`;
    // 卡片主体(带阴影)
    svg += `<rect x="${pos.x}" y="${pos.y}" width="${pos.w}" height="${nodeH}" stroke="${color}" stroke-width="1.3" filter="url(#ng-shadow)" class="ng-node-card"${n.bypassed ? ' opacity="0.45"' : ""}/>`;
    // 左侧彩色指示条 (圆角胶囊条)
    svg += `<path d="M ${pos.x} ${pos.y + 6} A 6 6 0 0 1 ${pos.x + 6} ${pos.y} L ${pos.x + 4} ${pos.y} L ${pos.x + 4} ${pos.y + nodeH} L ${pos.x + 6} ${pos.y + nodeH} A 6 6 0 0 1 ${pos.x} ${pos.y + nodeH - 6} Z" fill="${color}"${n.bypassed ? ' opacity="0.5"' : ""}/>`;
    // ID 徽章
    svg += `<rect x="${pos.x + 10}" y="${pos.y + 8}" width="${idBadgeW}" height="18" class="ng-node-id-badge"/>`;
    svg += `<text x="${pos.x + 10 + idBadgeW / 2}" y="${pos.y + 21}" class="ng-node-id-text">${escapeHtml(idStr)}</text>`;
    // 节点标题
    svg += `<text x="${pos.x + 16 + idBadgeW}" y="${pos.y + 22}" class="ng-node-title"${n.bypassed ? ' fill="#94a3b8"' : ""}>${escapeHtml(titleText)}</text>`;
    svg += `</g>`;
  }

  svg += `</svg>`;
  return svg;
}

function openPreview(item, index = 0) {
  state.previewItem = item;
  state.previewIndex = index;
  syncPreviewView();
}

function shiftPreview(step) {
  if (!state.previewItem?.images?.length) {
    return;
  }
  const nextIndex = state.previewIndex + step;
  if (nextIndex < 0 || nextIndex >= state.previewItem.images.length) {
    return;
  }
  state.previewIndex = nextIndex;
  syncPreviewView();
}

function closePreview() {
  const modal = document.getElementById("imagePreviewModal");
  const image = document.getElementById("imagePreviewImg");
  const strip = document.getElementById("imagePreviewStrip");
  const details = document.getElementById("imagePreviewDetails");
  const objectUrl = state.previewItem?.objectUrl;
  modal.hidden = true;
  image.removeAttribute("src");
  image.alt = "预览图";
  strip.innerHTML = "";
  if (details) {
    details.innerHTML = "";
  }
  document.getElementById("imagePreviewBody")?.classList.remove("is-zoomed");
  document.getElementById("imagePreviewMeta")?.classList.remove("is-expanded");
  document.body.classList.remove("preview-open");
  state.previewItem = null;
  state.previewIndex = 0;
  state.previewDerived = null;
  state.previewView = "image";
  if (objectUrl && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(objectUrl);
  }
  document.getElementById("previewNodeGraphStage")?.remove();
  const graphBtn = document.getElementById("previewNodeGraphBtn");
  if (graphBtn) {
    graphBtn.hidden = true;
    graphBtn.textContent = "节点图";
  }
  const generateLink = document.getElementById("previewGenerateLink");
  if (generateLink) generateLink.hidden = false;
}

async function parseUploadedImage(file) {
  if (!file || state.parseImageBusy) return;
  const button = document.getElementById("parseImageBtn");
  const label = document.getElementById("parseImageLabel");
  const input = document.getElementById("parseImageInput");
  const objectUrl = URL.createObjectURL(file);
  state.parseImageBusy = true;
  if (button) {
    button.disabled = true;
    button.classList.add("is-loading");
    button.setAttribute("aria-busy", "true");
  }
  if (label) label.textContent = "解析中...";
  let retainedObjectUrl = false;
  try {
    const form = new FormData();
    form.append("file", file, file.name);
    const response = await fetch(apiUrl("/api/parse-image"), { method: "POST", body: form });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.message || payload.detail || `图片解析失败 (${response.status})`);
    }
    const preview = (window.aaTransientPreview || window.wfdbTransientPreview)?.adapt(payload, objectUrl, file.name);
    if (!preview) throw new Error("解析响应缺少可展示的图片信息");
    closePreview();
    openPreview(preview);
    retainedObjectUrl = true;
    showToast("图片解析完成", { type: "success", duration: 1600 });
  } catch (error) {
    showToast(error.message || "图片解析失败", { type: "error" });
  } finally {
    if (!retainedObjectUrl && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(objectUrl);
    }
    if (input) input.value = "";
    state.parseImageBusy = false;
    if (button) {
      button.disabled = false;
      button.classList.remove("is-loading");
      button.removeAttribute("aria-busy");
    }
    if (label) label.textContent = "解析图片";
  }
}


async function copyPromptLayer(trigger) {
  const layer = trigger.closest(".prompt-layer");
  const content = layer?.querySelector(".prompt-pre")?.textContent || "";
  if (!content.trim()) {
    return;
  }
  await navigator.clipboard.writeText(content);
  const originalText = trigger.textContent;
  trigger.textContent = "已复制";
  window.setTimeout(() => {
    trigger.textContent = originalText;
  }, 1200);
}

// 拆词:与搜索框 placeholder 承诺一致(每行一个或用空格/逗号分隔,兼容全角逗号);
// 供排除关键词等词级输入使用,词数组由调用方按需 join 传参
function splitSearchKeywords(value) {
  return value.split(/[\s,，\r\n]+/).filter((w) => w.length > 0);
}

function currentQuery({ includePaging = false } = {}) {
  const params = new URLSearchParams();
  const search = document.getElementById("searchInput").value.trim();
  const filename = document.getElementById("filenameInput").value.trim();
  const model = document.getElementById("modelComboboxInput").value.trim();
  const instance = document.getElementById("instanceSelect").value;
  const loraList = state.selectedLoras;
  const excludeLoraList = state.excludedLoras;
  const excludeKeywords = splitSearchKeywords(document.getElementById("excludeKeywordsInput").value);
  // 本地 "YYYY-MM-DD HH:mm" → UTC ISO("YYYY-MM-DDTHH:mm:ss.000Z"),
  // 与库内 captured_at 字符串比较兼容(时区由 JS Date 本地解析保证)
  const fromDate = toUtcIso(document.getElementById("fromDate").value);
  const toDate = toUtcIso(document.getElementById("toDate").value);
  params.set("group_mode", currentGroupMode());
  if (search) params.set("q", search);
  if (filename) params.set("filename", filename);
  if (model) params.set("base_model", model);
  if (instance) params.set("instance", instance);
  // 正向 LoRA:重复参数 lora=A&lora=B;有名单才带 mode(缺省 or)
  loraList.forEach((value) => params.append("lora", value));
  if (loraList.length && state.loraMode !== "or") params.set("lora_mode", state.loraMode);
  // 排除 LoRA:重复参数 exclude_lora=...;有名单才带 mode(缺省 and)
  excludeLoraList.forEach((value) => params.append("exclude_lora", value));
  if (excludeLoraList.length && state.excludeLoraMode !== "and") params.set("exclude_lora_mode", state.excludeLoraMode);
  // 排除关键词:空格连接传参,后端按空白拆回词数组(命中任一即排除)
  if (excludeKeywords.length) params.set("exclude_q", excludeKeywords.join(" "));
  if (fromDate) params.set("from_date", fromDate);
  if (toDate) params.set("to_date", toDate);
  if (state.favoritesOnly) params.set("fav", "1");
  // 收藏分类多选:重复参数 fav_cat=a&fav_cat=b;有名单才带 mode(缺省 or)
  state.favoriteCategoriesSelected.forEach((value) => params.append("fav_cat", value));
  if (state.favoriteCategoriesSelected.length && state.favoriteCategoryMode !== "or") {
    params.set("fav_cat_mode", state.favoriteCategoryMode);
  }
  if (includePaging) {
    params.set("page", String(state.page));
    params.set("limit", String(state.pageSize));
  }
  return params.toString();
}

function queryCacheKey(page) {
  return `${currentQuery()}::page=${page}::limit=${state.pageSize}`;
}

async function fetchImageSummaryPage(page, requestKey = "") {
  const cacheKey = queryCacheKey(page);
  if (state.pageCache.has(cacheKey)) {
    perfLog("fetchImageSummaryPage:cache-hit", `page=${page}`);
    return state.pageCache.get(cacheKey);
  }
  const query = currentQuery({ includePaging: false });
  const url = `/api/images/summary?${query}${query ? "&" : ""}page=${page}&limit=${state.pageSize}`;
  const payload = await measureAsync(`fetchImageSummaryPage page=${page}`, async () => fetchJson(url));
  // 乱序响应不写缓存:列表已切到新查询/新页(requestKey 由 loadMainList 传入;
  // prefetchNextPage 不带 key,其缓存写入总是安全的——同查询的下一页)
  if (requestKey && state.activeListRequestKey !== requestKey) {
    return payload;
  }
  state.pageCache.set(cacheKey, payload);
  return payload;
}

async function fetchImageDetails(batchKeys) {
  if (!batchKeys.length) {
    return { items: [], count: 0 };
  }
  return measureAsync("fetchImageDetails", async () => {
    const response = await fetch(apiUrl("/api/images/details"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batch_keys: batchKeys }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.detail || "批次详细信息加载失败");
    }
    return response.json();
  });
}

function mergeSummaryWithDetails(summaryPayload, detailPayload) {
  const detailsByKey = new Map((detailPayload?.items || []).map((item) => [item.batch?.key || item.batch_key, item]));
  const mergedItems = (summaryPayload?.items || []).map((item) => detailsByKey.get(item.batch?.key || item.batch_key) || item);
  return {
    ...summaryPayload,
    items: mergedItems,
  };
}

function mergeRecipeSummaryWithBatchDetails(summaryPayload, detailPayload) {
  const detailsByBatchKey = new Map((detailPayload?.items || []).map((item) => [item.batch?.key || item.batch_key, item]));
  const mergedItems = (summaryPayload?.items || []).map((summaryItem) => {
    const recipeBatchKeys = summaryItem.recipe?.batch_keys || summaryItem.batch?.batch_keys || [];
    const memberDetails = recipeBatchKeys.map((key) => detailsByBatchKey.get(key)).filter(Boolean);
    if (!memberDetails.length) {
      return summaryItem;
    }
    const representative = memberDetails[0];
    return {
      ...summaryItem,
      model: representative.model || summaryItem.model,
      loras: representative.loras || summaryItem.loras,
      prompts: representative.prompts || summaryItem.prompts,
      samplers: representative.samplers || summaryItem.samplers,
      latent: representative.latent || summaryItem.latent,
      images: representative.images || summaryItem.images,
      manual_label_matches: representative.manual_label_matches || [],
      details_pending: false,
    };
  });
  return {
    ...summaryPayload,
    items: mergedItems,
  };
}

async function prefetchNextPage(payload) {
  const page = payload?.page || 1;
  const pages = payload?.pages || 0;
  if (page >= pages) {
    return;
  }
  const nextPage = page + 1;
  const cacheKey = queryCacheKey(nextPage);
  if (state.pageCache.has(cacheKey)) {
    return;
  }
  fetchImageSummaryPage(nextPage).catch(() => {});
}

// tag 目录加载中的 promise(boot 置入):loadMainList 渲染前等待它,
// 保证任何一次渲染都发生在 tagIndex 就绪之后(highlightPromptText 消费
// 目录做高亮;目录与列表并行拉取时,缓存命中的秒回渲染可能先于目录到达)
let tagCatalogLoadPromise = null;

async function loadMainList() {
  // 「只看收藏」筛选开启:主区切到收藏网格视图(分类下拉决定范围)
  if (state.favoritesOnly) {
    return loadFavoritesView();
  }
  return measureAsync(`loadMainList page=${state.page}`, async () => {
    if (tagCatalogLoadPromise) await tagCatalogLoadPromise;
    const requestKey = `${currentQuery()}::page=${state.page}::limit=${state.pageSize}::${Date.now()}`;
    state.activeListRequestKey = requestKey;
    let summaryPayload;
    try {
      summaryPayload = await fetchImageSummaryPage(state.page, requestKey);
    } catch (error) {
      // 查询失败:回退上次成功渲染(骨架/旧内容不悬空),随后向上抛出由调用方 toast
      if (state.activeListRequestKey === requestKey && state.lastPayload) {
        renderResults(state.lastPayload);
        renderPagination(state.lastPayload);
        updateSummaryFromList(state.lastPayload);
      }
      throw error;
    }
    if (state.activeListRequestKey !== requestKey) {
      return summaryPayload;
    }
    state.page = summaryPayload.page || state.page;
    state.pageSize = summaryPayload.limit || state.pageSize;
    state.lastPayload = summaryPayload;
    renderResults(summaryPayload);
    renderPagination(summaryPayload);
    updateSummaryFromList(summaryPayload);
    syncUrlState();
    prefetchNextPage(summaryPayload);
    await acknowledgeSyncUpdates();
    const batchKeys =
      currentGroupMode() === "recipe"
        ? Array.from(
            new Set(
              (summaryPayload.items || [])
                .flatMap((item) => item.recipe?.batch_keys || item.batch?.batch_keys || [])
                .filter(Boolean)
            )
          )
        : (summaryPayload.items || []).map((item) => item.batch?.key || item.batch_key).filter(Boolean);
    fetchImageDetails(batchKeys)
      .then((detailPayload) => {
        if (state.activeListRequestKey !== requestKey) {
          return;
        }
        const mergedPayload =
          currentGroupMode() === "recipe"
            ? mergeRecipeSummaryWithBatchDetails(summaryPayload, detailPayload)
            : mergeSummaryWithDetails(summaryPayload, detailPayload);
        state.lastPayload = mergedPayload;
        state.pageCache.set(queryCacheKey(summaryPayload.page || state.page), mergedPayload);
        renderResults(mergedPayload);
        renderPagination(mergedPayload);
        updateSummaryFromList(mergedPayload);
      })
      .catch((error) => {
        perfLog("fetchImageDetails:fail", error.message || error);
      });
    return summaryPayload;
  });
}

async function loadToolData() {
  return;
}

// 统一筛选刷新:重置页码 + 读取条数 + 清请求缓存 + 骨架占位 + 重载列表
async function refreshList() {
  state.page = 1;
  state.pageSize = Number(document.getElementById("pageSizeSelect").value) || 50;
  state.pageCache.clear();
  renderSkeletonRows();
  await loadMainList();
}

/**
 * 筛选状态 ↔ URL:图片库刷新/分享/回退后保持筛选上下文。
 * 写入:每次列表加载成功后 replaceState(不产生历史条目),参数与 API query 同构
 *  (group_mode 恒在;空筛选时 URL 不带 ?)。
 * 恢复:boot 时读取;日期参数存 UTC ISO(currentQuery 产物),经 formatCapturedAt
 *  转本地显示串回填输入框——flatpickr 创建时会读取 input 现有值作为初始日期。
 */
function syncUrlState() {
  const params = currentQuery({ includePaging: true });
  history.replaceState(null, "", params ? `${location.pathname}?${params}` : location.pathname);
}

function restoreFiltersFromUrl() {
  const params = new URLSearchParams(location.search);
  if (!params.size) {
    return;
  }
  applyFilterParams(params);
}

// 将查询参数回填到筛选 UI/状态(URL 恢复与命名视图共用;仅回填出现的字段)
function applyFilterParams(params) {
  const search = params.get("q");
  if (search) {
    const searchInput = document.getElementById("searchInput");
    searchInput.value = search;
    document.getElementById("searchTopField").hidden = false;
    const searchTopBtn = document.getElementById("searchTopBtn");
    if (searchTopBtn) {
      searchTopBtn.classList.add("is-active");
      searchTopBtn.setAttribute("aria-expanded", "true");
    }
    // 与 autoResizeSearch 同逻辑:单行保持默认居中,多行关键词展开高度避免 rows=1 内滚动
    searchInput.style.height = "auto";
    if (searchInput.scrollHeight <= 24) {
      searchInput.style.height = "";
    } else {
      searchInput.style.height = `${Math.min(searchInput.scrollHeight, 160)}px`;
    }
  }
  const filename = params.get("filename");
  if (filename) document.getElementById("filenameInput").value = filename;
  const model = params.get("base_model");
  if (model) document.getElementById("modelComboboxInput").value = model;
  const instance = params.get("instance");
  if (instance) document.getElementById("instanceSelect").value = instance;
  const lora = params.getAll("lora");
  if (lora.length) {
    state.selectedLoras = lora;
    loraComboInclude.renderChips();
  }
  const loraMode = params.get("lora_mode");
  if (loraMode === "and" || loraMode === "or") state.loraMode = loraMode;
  const excludeLora = params.getAll("exclude_lora");
  if (excludeLora.length) {
    state.excludedLoras = excludeLora;
    loraComboExclude.renderChips();
  }
  const excludeLoraMode = params.get("exclude_lora_mode");
  if (excludeLoraMode === "and" || excludeLoraMode === "or") state.excludeLoraMode = excludeLoraMode;
  // exclude_q 是空格连接的词串(currentQuery 产物),原样回填并同步清除按钮显隐
  const excludeQ = params.get("exclude_q");
  if (excludeQ) {
    const input = document.getElementById("excludeKeywordsInput");
    input.value = excludeQ;
    document.getElementById("excludeKeywordsClearBtn").hidden = false;
    const searchAdvBtn = document.getElementById("searchAdvBtn");
    if (searchAdvBtn) searchAdvBtn.classList.add("has-filter");
    document.getElementById("searchTopField").hidden = false;
    const searchTopBtn = document.getElementById("searchTopBtn");
    if (searchTopBtn) {
      searchTopBtn.classList.add("is-active");
      searchTopBtn.setAttribute("aria-expanded", "true");
    }
  }
  const fromDate = params.get("from_date");
  if (fromDate) document.getElementById("fromDate").value = formatCapturedAt(fromDate);
  const toDate = params.get("to_date");
  if (toDate) document.getElementById("toDate").value = formatCapturedAt(toDate);
  const page = Number(params.get("page"));
  if (Number.isInteger(page) && page > 0) state.page = page;
  const limit = Number(params.get("limit"));
  if (Number.isInteger(limit) && limit > 0) {
    state.pageSize = limit;
    document.getElementById("pageSizeSelect").value = String(limit);
  }
  // 收藏筛选:fav 开关 + fav_cat 重复参数(多分类)+ fav_cat_mode(缺省 or)。
  // 带分类名单即隐含只看收藏(combo 交互同语义)。
  const favCats = params.getAll("fav_cat").filter(Boolean);
  if (params.get("fav") || favCats.length) {
    state.favoritesOnly = true;
    const onlyInput = document.getElementById("favoriteOnlyInput");
    if (onlyInput) onlyInput.checked = true;
  }
  if (favCats.length) {
    state.favoriteCategoriesSelected = favCats;
    favoriteCategoryCombo.renderChips();
  }
  const favCatMode = params.get("fav_cat_mode");
  if (favCatMode === "and" || favCatMode === "or") state.favoriteCategoryMode = favCatMode;
  syncFilterClearButtons();
  syncAndorButtons();
}

// ============ 筛选视图(命名视图,localStorage 持久化) ============
// 常用筛选(关键词+模型+LoRA+日期+收藏等)存为命名视图,一键回填并刷新;
// 视图快照 = currentQuery 产物(与 URL/查询参数同构)+ limit(条数),不含页码。
const FILTER_VIEWS_KEY = "aa_filter_views";
const LEGACY_FILTER_VIEWS_KEY = "wfdb_filter_views";
const FILTER_VIEWS_MAX = 12;

function loadFilterViews() {
  try {
    const raw = localStorage.getItem(FILTER_VIEWS_KEY) || localStorage.getItem(LEGACY_FILTER_VIEWS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list)
      ? list.filter((v) => v && typeof v.name === "string" && typeof v.query === "string" && v.name.trim() && v.query)
      : [];
  } catch {
    return [];
  }
}

function saveFilterViewsList(list) {
  try {
    localStorage.setItem(FILTER_VIEWS_KEY, JSON.stringify(list.slice(0, FILTER_VIEWS_MAX)));
  } catch {
    /* localStorage 不可用(隐私模式等)时静默放弃,不影响主流程 */
  }
}

// 渲染视图下拉(索引为 value);选中具体视图时显示删除按钮
function renderFilterViewSelect() {
  const select = document.getElementById("filterViewSelect");
  if (!select) return;
  const views = loadFilterViews();
  const current = select.value;
  select.innerHTML = `<option value="">常用视图…</option>${views
    .map((view, index) => `<option value="${index}">${escapeHtml(view.name)}</option>`)
    .join("")}`;
  select.value = views[Number(current)] ? current : "";
  syncFilterViewDeleteBtn();
}

function syncFilterViewDeleteBtn() {
  const select = document.getElementById("filterViewSelect");
  const deleteBtn = document.getElementById("filterViewDeleteBtn");
  if (!select || !deleteBtn) return;
  deleteBtn.hidden = !(select.value !== "" && loadFilterViews()[Number(select.value)]);
}

// 保存当前筛选为命名视图:同名覆盖(确认),新名置顶;上限 12 条淘汰最旧
function saveCurrentFilterView() {
  const params = new URLSearchParams(currentQuery());
  params.set("limit", String(state.pageSize));
  const query = params.toString();
  const name = window.prompt("视图名称:", "");
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) {
    showToast("视图名称不能为空", { type: "warning" });
    return;
  }
  const list = loadFilterViews();
  const existing = list.findIndex((view) => view.name === trimmed);
  if (existing >= 0) {
    if (!window.confirm(`已存在同名视图「${trimmed}」,覆盖保存?`)) return;
    list[existing] = { name: trimmed, query };
  } else {
    list.unshift({ name: trimmed, query });
  }
  saveFilterViewsList(list);
  renderFilterViewSelect();
  showToast(`视图「${trimmed}」已保存`, { type: "success", duration: 1200 });
}

function deleteFilterView(index) {
  const view = loadFilterViews()[index];
  if (!view) return;
  if (!window.confirm(`删除视图「${view.name}」?`)) return;
  saveFilterViewsList(loadFilterViews().filter((_, i) => i !== index));
  renderFilterViewSelect();
  showToast(`视图「${view.name}」已删除`, { type: "success", duration: 1200 });
}

// 应用命名视图:先清空全部筛选输入(视图快照未必覆盖所有字段),
// 再回填视图参数并从第 1 页刷新
function applyFilterView(view) {
  resetFilterInputs();
  applyFilterParams(new URLSearchParams(view.query));
  state.page = 1;
  applyFilters().catch((error) => showToast(error.message, { type: "error" }));
}

// 清空全部筛选输入与相关状态(应用视图前的基底)
function resetFilterInputs() {
  const searchInput = document.getElementById("searchInput");
  if (searchInput.value) {
    searchInput.value = "";
    searchInput.style.height = "";
    document.getElementById("searchTopField").hidden = true;
    const searchTopBtn = document.getElementById("searchTopBtn");
    if (searchTopBtn) {
      searchTopBtn.classList.remove("is-active");
      searchTopBtn.setAttribute("aria-expanded", "false");
    }
  }
  document.getElementById("filenameInput").value = "";
  document.getElementById("modelComboboxInput").value = "";
  document.getElementById("instanceSelect").value = "";
  state.selectedLoras = [];
  state.excludedLoras = [];
  loraComboInclude.renderChips();
  loraComboExclude.renderChips();
  state.loraMode = "or";
  state.excludeLoraMode = "and";
  document.getElementById("excludeKeywordsInput").value = "";
  document.getElementById("excludeKeywordsClearBtn").hidden = true;
  const searchAdvBtn = document.getElementById("searchAdvBtn");
  if (searchAdvBtn) {
    searchAdvBtn.classList.remove("has-filter");
  }
  document.getElementById("fromDate").value = "";
  document.getElementById("toDate").value = "";
  state.favoritesOnly = false;
  state.favoriteCategoriesSelected = [];
  state.favoriteCategoryMode = "or";
  syncFavoriteFilterUi();
  syncFilterClearButtons();
  syncAndorButtons();
}

function bindFilterViews() {
  const select = document.getElementById("filterViewSelect");
  if (select) {
    select.addEventListener("change", () => {
      syncFilterViewDeleteBtn();
      if (select.value === "") return;
      const view = loadFilterViews()[Number(select.value)];
      if (view) applyFilterView(view);
    });
  }
  document.getElementById("filterViewSaveBtn")?.addEventListener("click", saveCurrentFilterView);
  document.getElementById("filterViewDeleteBtn")?.addEventListener("click", () => {
    const select = document.getElementById("filterViewSelect");
    if (select && select.value !== "") deleteFilterView(Number(select.value));
  });
}

// 本地 "YYYY-MM-DD HH:mm"(air-datepicker 显示值)→ UTC ISO;空/非法返回空串
function toUtcIso(value) {
  const v = (value || "").trim();
  if (!v) return "";
  const d = new Date(v.includes("T") ? v : v.replace(" ", "T"));
  return isNaN(d.getTime()) ? "" : d.toISOString();
}

// 防抖即时筛选:条件变化(delay 后)自动查询;手动触发(applyFilters)会清掉待执行任务
function scheduleFilterApply(delay = 400) {
  clearTimeout(filterDebounce);
  filterDebounce = setTimeout(() => {
    applyFilters().catch((error) => showToast(error.message, { type: "error" }));
  }, delay);
}

// 按当前筛选值同步 x 清除按钮显隐(无筛选时隐藏)
function syncFilterClearButtons() {
  document.getElementById("loraClearBtn").hidden = state.selectedLoras.length === 0;
  document.getElementById("modelClearBtn").hidden = !document.getElementById("modelComboboxInput").value.trim();
  document.getElementById("excludeLoraClearBtn").hidden = state.excludedLoras.length === 0;
  document.getElementById("fromDateClearBtn").hidden = !document.getElementById("fromDate").value;
  document.getElementById("toDateClearBtn").hidden = !document.getElementById("toDate").value;
}

// 同步三组「任一/全部」与或按钮的 is-active(依据各实例 mode)
function syncAndorButtons() {
  const mark = (side, mode) => {
    const group = document.querySelector(`[data-andor-side="${side}"]`);
    if (!group) return;
    group.querySelectorAll("[data-andor-val]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.andorVal === mode);
    });
  };
  mark("include", state.loraMode);
  mark("exclude", state.excludeLoraMode);
  mark("favcat", state.favoriteCategoryMode);
}

async function applyFilters() {
  clearTimeout(filterDebounce);
  const button = document.getElementById("applyBtn");
  setButtonLoading(button, true);
  try {
    await refreshList();
  } finally {
    setButtonLoading(button, false);
  }
}

async function applyInlineLoraFilter(value) {
  applyLoraSelection(value || "");
}

async function changePage(direction) {
  if (direction === "prev" && state.page > 1) {
    state.page -= 1;
  }
  if (direction === "next") {
    state.page += 1;
  }
  await loadMainList();
}

// 页码跳转:clamp 到 [1, totalPages];与当前页相同仅还原输入值
async function jumpToPage(page) {
  const target = Math.max(1, Math.min(Number(page) || 1, state.totalPages));
  const input = document.querySelector("[data-page-jump]");
  if (target === state.page) {
    if (input) input.value = String(state.page);
    return;
  }
  state.page = target;
  await loadMainList();
}

async function ensureOptionsLoaded() {
  if (state.optionsLoaded) {
    return;
  }
  state.options = await fetchJson("/api/options");
  loraComboInclude.renderChips();
  loraComboExclude.renderChips();
  renderLoraMenu("");
  state.optionsLoaded = true;
}

// 多网关共享库:实例筛选器填充;单机 SQLite/纯远程无实例概念
// (后端 engine 非 mongo 时 /api/instances 返回空数组)直接隐藏该字段
async function loadInstances() {
  try {
    const instances = await fetchJson("/api/instances");
    fillSelect(document.getElementById("instanceSelect"), instances.items || [], "全部实例");
    const field = document.getElementById("instanceFilterField");
    if (field) {
      field.hidden = !instances.items || instances.items.length === 0;
    }
  } catch (error) {
    perfLog("loadInstances:fail", error.message);
  }
}

async function pollSyncStatus() {
  const status = await fetchJson("/api/sync-status");
  renderSyncSummary(status);
  const manualSyncBtn = document.getElementById("manualSyncBtn");
  if (manualSyncBtn) {
    manualSyncBtn.disabled = Boolean(status.running);
    manualSyncBtn.textContent = status.running ? "扫描中" : "扫描新文件";
  }
  if (typeof status.change_version === "number" && state.syncVersionSeen === 0) {
    state.syncVersionSeen = status.change_version;
  }
  if (status.running) {
    setSyncNotice(true, "正在扫描新文件", status.message || "");
    return;
  }
  if (status.has_updates && status.change_version > state.syncVersionSeen) {
    setSyncNotice(true, "发现新的生成文件", status.message || "");
    return;
  }
  if (!status.has_updates) {
    setSyncNotice(false);
  }
}

// 列表加载后的同步状态汇合:单次 /api/sync-status 同时完成摘要渲染、扫描
// 按钮态、版本号初始化与"有更新"确认(原先 boot 末尾的 pollSyncStatus 与
// 此处背靠背打了两次同接口,合并为一次;60s 周期轮询仍走 pollSyncStatus)。
// running 时只提示不 ack:等扫描结束由周期轮询/下次列表加载再确认。
async function acknowledgeSyncUpdates() {
  const status = await fetchJson("/api/sync-status");
  renderSyncSummary(status);
  const manualSyncBtn = document.getElementById("manualSyncBtn");
  if (manualSyncBtn) {
    manualSyncBtn.disabled = Boolean(status.running);
    manualSyncBtn.textContent = status.running ? "扫描中" : "扫描新文件";
  }
  if (typeof status.change_version === "number" && state.syncVersionSeen === 0) {
    state.syncVersionSeen = status.change_version;
  }
  if (status.running) {
    setSyncNotice(true, "正在扫描新文件", status.message || "");
    return;
  }
  state.syncVersionSeen = status.change_version || state.syncVersionSeen;
  if (!status.has_updates) {
    setSyncNotice(false);
    return;
  }
  await fetch(apiUrl("/api/sync-status/ack"), { method: "POST" });
  state.syncVersionSeen = status.change_version || state.syncVersionSeen;
  setSyncNotice(false);
}

async function triggerManualSync() {
  // 同步置位:首个 await 前锁定,双触发的第二次调用直接返回(防御双轮询链)
  if (state.manualSyncPolling) {
    return;
  }
  state.manualSyncPolling = true;
  const button = document.getElementById("manualSyncBtn");
  button.disabled = true;
  button.textContent = "扫描中";
  setSyncNotice(true, "正在扫描新文件", "");

  try {
    const response = await fetch(apiUrl("/api/sync-now"), { method: "POST" });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.detail || "扫描启动失败");
    }

    const payload = await response.json();
    setSyncNotice(true, payload.accepted ? "已开始扫描" : "扫描进行中", payload.message || "");
    const pollUntilFinished = async () => {
      const status = await fetchJson("/api/sync-status");
      if (status.running) {
        window.setTimeout(() => {
          pollUntilFinished().catch((error) => {
            state.manualSyncPolling = false;
            showToast(error.message, { type: "error" });
          });
        }, 2000);
        return;
      }
      state.manualSyncPolling = false;
      await pollSyncStatus();
    };
    await pollUntilFinished();
  } catch (error) {
    state.manualSyncPolling = false;
    throw error;
  }
}

// 标题反映当前数据库状态:引擎 + 全库图片数(状态获取失败保持默认标题)。
// 注:total 必须取自 /api/images(batch 口径的"批次"数);列表页 recipe
// 模式 summary 的 total 是记录数(口径不同),不可复用。本函数为
// fire-and-forget,不阻塞首屏关键路径。
async function updateDbTitle() {
  try {
    const [health, page] = await Promise.all([
      fetchJson("/api/health"),
      fetchJson(apiUrl("/api/images?limit=1")),
    ]);
    const engine =
      health?.database?.engine === "mongo"
        ? "MongoDB"
        : health?.database?.engine === "remote"
          ? "远程待配库"
          : "SQLite";
    const total = Number(page?.total ?? 0);
    document.title = `${engine} · ${total.toLocaleString()} 批次`;
  } catch {
    // 静默失败:保持默认标题
  }
}

async function boot() {
  document.getElementById("pageSizeSelect").value = String(state.pageSize);
  perfLog("boot", `pageSize=${state.pageSize}`);
  renderSkeletonRows();
  void updateDbTitle();
  // URL 筛选恢复:model/instance 下拉选项为懒加载,先补齐再回填值
  // (恢复失败不阻断启动,仅该字段回退为空)
  const urlParams = new URLSearchParams(location.search);
  if (urlParams.get("base_model")) {
    await ensureOptionsLoaded().catch(() => {});
  }
  if (urlParams.get("instance")) {
    await loadInstances().catch(() => {});
  } else {
    void loadInstances(); // 填充实例下拉;非 Mongo 引擎(空结果)时隐藏该筛选字段
  }
  restoreFiltersFromUrl();
  syncFavoriteFilterUi();
  renderFilterViewSelect();
  bindFilterViews();
  // tag 目录与主列表并行拉取:首屏关键路径从"串行相加"降为"取较慢者"。
  // 列表渲染消费 tagIndex(highlightPromptText 的 tag 高亮),渲染侧通过
  // tagCatalogLoadPromise(loadMainList 内)等待目录,与抓取并行不冲突;
  // 各 bind* 均为 document 委托/静态元素监听,与渲染时序无关。
  tagCatalogLoadPromise = loadTagCatalog();
  const mainListReady = loadMainList();
  void loadQaCategories();
  await tagCatalogLoadPromise;
  bindTagHoverInteractions();
  bindDanbooruInteractions();
  bindQuickAnnotateInteractions();
  bindFavoritesInteractions();
  bindBulkActions();
  void loadFavoritesIndex();
  void loadFavoriteCategories();
  bindTagSuggestAutocomplete();
  await mainListReady;
  // 从 cookie 恢复跨页选中态:主列表渲染完成后回填 selection 与条目快照
  restoreSelectionFromCookie();
  syncRowSelectionUi();
  syncBulkUi();
  document.getElementById("applyBtn").addEventListener("click", () => {
    applyFilters().catch((error) => showToast(error.message, { type: "error" }));
  });
  document.getElementById("parseImageBtn").addEventListener("click", () => {
    if (!state.parseImageBusy) document.getElementById("parseImageInput").click();
  });
  document.getElementById("parseImageInput").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (file) void parseUploadedImage(file);
  });
  document.getElementById("syncRefreshBtn").addEventListener("click", () => {
    applyFilters().catch((error) => showToast(error.message, { type: "error" }));
  });
  // 动态即时筛选:条件变化(输入/选择)防抖自动查询,x 按钮显隐即时同步;
  // 文本输入清空立即刷新(与顶部搜索清空行为一致),其余走 400ms 防抖
  const bindLiveFilter = (id, eventName, immediateWhenEmpty = false) => {
    document.getElementById(id).addEventListener(eventName, () => {
      syncFilterClearButtons();
      const el = document.getElementById(id);
      if (immediateWhenEmpty && !el.value.trim()) {
        applyFilters().catch((error) => showToast(error.message, { type: "error" }));
        return;
      }
      scheduleFilterApply();
    });
  };
  bindLiveFilter("filenameInput", "input", true);
  bindLiveFilter("modelComboboxInput", "input", true);
  bindLiveFilter("instanceSelect", "change");
  syncFilterClearButtons();
  document.getElementById("loraClearBtn").addEventListener("click", () => {
    applyLoraSelection("");
  });
  document.getElementById("modelClearBtn").addEventListener("click", () => {
    applyModelSelection("");
  });
  // 开始/结束时间(flatpickr):日历 + 时间选择,输入框可手动键入
  // "YYYY-MM-DD HH:mm"(Enter/失焦解析);中文 locale;24 小时制;
  // 主题由 CSS 变量定制,随页面深浅色自动切换
  const datePickerOpts = {
    dateFormat: "Y-m-d H:i",
    enableTime: true,
    time_24hr: true,
    minuteIncrement: 5,
    locale: flatpickr.l10ns.zh,
    allowInput: true,
    // 选择中不刷新列表,避免用户尚在调整时间时日历被异步请求打断。
    onChange: () => {
      syncFilterClearButtons();
    },
    onClose: () => {
      syncFilterClearButtons();
      scheduleFilterApply();
    },
    onReady: (_selectedDates, _dateString, picker) => {
      const footer = document.createElement("div");
      footer.className = "date-picker-footer";
      const clearButton = document.createElement("button");
      clearButton.type = "button";
      clearButton.className = "date-picker-footer-clear";
      clearButton.textContent = "清除";
      clearButton.addEventListener("click", () => picker.clear());
      const doneButton = document.createElement("button");
      doneButton.type = "button";
      doneButton.className = "date-picker-footer-done";
      doneButton.textContent = "完成";
      doneButton.addEventListener("click", () => picker.close());
      footer.append(clearButton, doneButton);
      picker.calendarContainer.appendChild(footer);
    },
  };
  const fromPicker = flatpickr("#fromDate", datePickerOpts);
  const toPicker = flatpickr("#toDate", datePickerOpts);
  const bindDatePickerOpen = (buttonId, inputId, picker) => {
    document.getElementById(buttonId).addEventListener("click", () => {
      picker.open();
      document.getElementById(inputId).focus();
    });
  };
  bindDatePickerOpen("fromDatePickerBtn", "fromDate", fromPicker);
  bindDatePickerOpen("toDatePickerBtn", "toDate", toPicker);
  const bindDateTextInput = (inputId) => {
    const input = document.getElementById(inputId);
    input.addEventListener("input", syncFilterClearButtons);
    input.addEventListener("blur", () => {
      syncFilterClearButtons();
      scheduleFilterApply();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      }
    });
  };
  bindDateTextInput("fromDate");
  bindDateTextInput("toDate");
  const bindFieldClear = (clearBtnId, inputId, picker) => {
    document.getElementById(clearBtnId).addEventListener("click", () => {
      if (picker) picker.clear();
      else document.getElementById(inputId).value = "";
      syncFilterClearButtons();
      applyFilters().catch((error) => showToast(error.message, { type: "error" }));
    });
  };
  bindFieldClear("fromDateClearBtn", "fromDate", fromPicker);
  bindFieldClear("toDateClearBtn", "toDate", toPicker);
  // 排除 LoRA「全部清除」:清名单(多选)并同步 chips/菜单/即时刷新
  document.getElementById("excludeLoraClearBtn").addEventListener("click", () => {
    state.excludedLoras = [];
    loraComboExclude.renderChips();
    syncAndorButtons();
    applyFilters().catch((error) => showToast(error.message, { type: "error" }));
  });
  // 顶部左侧搜索(Google 式):按钮展开输入区;输入防抖即时搜索;
  // 失焦且为空收起(聚焦期间删光不收起,可直接续打新查询);
  // 高级面板(#searchAdvMenu)打开期间搜索框"锁定":清空/失焦不收起,
  // 仅 Enter(完成搜索)或关闭面板才允许隐藏;
  // 搜索历史(Google 式,最多 5 条):localStorage 持久化,聚焦自动弹出,
  // 每次实际执行的搜索(防抖触发或回车)记录一条;与高级面板互斥展开
  const searchTopBtn = document.getElementById("searchTopBtn");
  const searchTopField = document.getElementById("searchTopField");
  const searchInput = document.getElementById("searchInput");
  const searchAdvBtn = document.getElementById("searchAdvBtn");
  const searchAdvMenu = document.getElementById("searchAdvMenu");
  const excludeKeywordsInput = document.getElementById("excludeKeywordsInput");
  const searchHistoryMenu = document.getElementById("searchHistoryMenu");
  const searchHistoryItems = document.getElementById("searchHistoryItems");
  const SEARCH_HISTORY_KEY = "aa_search_history";
  const LEGACY_SEARCH_HISTORY_KEY = "wfdb_search_history";
  const SEARCH_HISTORY_MAX = 5;
  let searchDebounce = null;
  let searchAdvOpen = false;
  let searchHistoryOpen = false;
  const loadSearchHistory = () => {
    try {
      const raw = localStorage.getItem(SEARCH_HISTORY_KEY) || localStorage.getItem(LEGACY_SEARCH_HISTORY_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list)
        ? list.filter((s) => typeof s === "string" && s.trim())
        : [];
    } catch {
      return [];
    }
  };
  const saveSearchHistory = (list) => {
    try {
      localStorage.setItem(
        SEARCH_HISTORY_KEY,
        JSON.stringify(list.slice(0, SEARCH_HISTORY_MAX)),
      );
    } catch {
      // localStorage 不可用(隐私模式等)时静默放弃,不影响搜索
    }
  };
  // 记录一条历史:去重后置顶,超出上限淘汰最旧(最多 5 条)
  const pushSearchHistory = (q) => {
    const text = q.trim();
    if (!text) return;
    const list = loadSearchHistory().filter((s) => s !== text);
    list.unshift(text);
    saveSearchHistory(list);
  };
  const renderSearchHistory = () => {
    searchHistoryItems.textContent = "";
    for (const text of loadSearchHistory()) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "search-history-item";
      item.textContent = text;
      item.title = text;
      // 点击历史项=完成一次搜索:填入并执行,随后收起(与 Enter 语义一致)
      item.addEventListener("click", () => {
        searchInput.value = text;
        autoResizeSearch();
        closeSearchHistory({ collapse: false });
        collapseSearch();
        applyFilters().catch((error) => showToast(error.message, { type: "error" }));
      });
      searchHistoryItems.appendChild(item);
    }
  };
  const closeSearchHistory = ({ collapse = true } = {}) => {
    searchHistoryOpen = false;
    searchHistoryMenu.hidden = true;
    if (collapse && !searchInput.value.trim()) {
      collapseSearch();
    }
  };
  const openSearchHistory = () => {
    if (!loadSearchHistory().length) return;
    if (searchAdvOpen) {
      closeSearchAdv({ collapse: false });
    }
    renderSearchHistory();
    searchHistoryOpen = true;
    searchHistoryMenu.hidden = false;
  };
  const autoResizeSearch = () => {
    if (!searchInput.value.trim()) {
      searchInput.style.height = "";
      return;
    }
    searchInput.style.height = "auto";
    if (searchInput.scrollHeight <= 24) {
      searchInput.style.height = "";
    } else {
      searchInput.style.height = `${Math.min(searchInput.scrollHeight, 160)}px`;
    }
  };
  const collapseSearch = () => {
    if (!searchInput.value.trim()) {
      searchInput.style.height = "";
    }
    searchTopField.hidden = true;
    if (searchTopBtn) {
      searchTopBtn.classList.remove("is-active");
      searchTopBtn.setAttribute("aria-expanded", "false");
    }
  };
  // 关闭高级面板:解除锁定,主输入与排除词均为空则顺带收起(关闭面板是允许隐藏的时机之一);
  // collapse:false 用于与历史面板互斥切换时,避免误收起搜索框
  const closeSearchAdv = ({ collapse = true } = {}) => {
    searchAdvOpen = false;
    searchAdvMenu.hidden = true;
    searchAdvBtn.setAttribute("aria-expanded", "false");
    if (collapse && !searchInput.value.trim() && !excludeKeywordsInput.value.trim()) {
      collapseSearch();
    }
  };
  const openSearchAdv = () => {
    if (searchHistoryOpen) {
      closeSearchHistory({ collapse: false });
    }
    searchAdvOpen = true;
    searchAdvMenu.hidden = false;
    searchAdvBtn.setAttribute("aria-expanded", "true");
    excludeKeywordsInput.focus();
  };
  const syncExcludeKeywordsClear = () => {
    const hasValue = !!excludeKeywordsInput.value.trim();
    document.getElementById("excludeKeywordsClearBtn").hidden = !hasValue;
    if (searchAdvBtn) {
      searchAdvBtn.classList.toggle("has-filter", hasValue);
    }
  };
  if (searchTopBtn && searchTopField && searchInput) {
    searchTopBtn.addEventListener("click", () => {
      if (!searchTopField.hidden) {
        collapseSearch();
        return;
      }
      searchTopBtn.classList.add("is-active");
      searchTopBtn.setAttribute("aria-expanded", "true");
      searchTopField.hidden = false;
      searchInput.focus();
      autoResizeSearch();
      // 用户主动展开搜索:直接弹出历史(程序性 focus 不触发下面的 focus 处理器)
      openSearchHistory();
    });
    // 聚焦且输入为空时自动弹出历史(有历史才显示,Google 式);
    // 仅限用户真实点击聚焦(isTrusted),Escape 关闭面板后的程序性 focus 不重开
    searchInput.addEventListener("focus", (event) => {
      if (event.isTrusted && !searchInput.value.trim()) {
        openSearchHistory();
      }
    });
    searchInput.addEventListener("input", () => {
      if (searchHistoryOpen) {
        closeSearchHistory({ collapse: false });
      }
      autoResizeSearch();
      clearTimeout(searchDebounce);
      if (!searchInput.value.trim()) {
        // 清空:立即恢复全部列表;聚焦期间保持展开(删光后直接续打新查询,
        // 无需重开搜索框),失焦时由 blur 处理器收起
        applyFilters().catch((error) => showToast(error.message, { type: "error" }));
        return;
      }
      // 防抖即时搜索(复用 pageCache 查询串缓存,防抖期间重复查询零请求)
      searchDebounce = setTimeout(() => {
        pushSearchHistory(searchInput.value.trim());
        applyFilters().catch((error) => showToast(error.message, { type: "error" }));
      }, 400);
    });
    searchInput.addEventListener("blur", (event) => {
      // 若焦点转移到了搜索组件内部(高级设置、排除词输入框、历史记录等),不要收起
      if (event.relatedTarget && event.relatedTarget.closest("#searchTopField, #searchTopBtn")) {
        return;
      }
      setTimeout(() => {
        if (document.activeElement && document.activeElement.closest("#searchTopField, #searchTopBtn")) {
          return;
        }
        if (!searchInput.value.trim() && !excludeKeywordsInput.value.trim() && !searchAdvOpen && !searchHistoryOpen) {
          collapseSearch();
        }
      }, 150);
    });
    // Escape:先关历史面板,再关高级面板;Enter(非 Shift)=完成搜索:
    // 记录历史 + 立即查询并收起搜索框、关两个面板
    searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (searchHistoryOpen) {
          event.preventDefault();
          closeSearchHistory();
          return;
        }
        if (searchAdvOpen) {
          event.preventDefault();
          closeSearchAdv();
        }
        return;
      }
      if (event.key !== "Enter" || event.shiftKey) {
        return;
      }
      event.preventDefault();
      clearTimeout(searchDebounce);
      if (searchHistoryOpen) {
        closeSearchHistory({ collapse: false });
      }
      if (searchAdvOpen) {
        closeSearchAdv();
      }
      pushSearchHistory(searchInput.value.trim());
      collapseSearch();
      applyFilters().catch((error) => showToast(error.message, { type: "error" }));
    });
  }
  // 高级面板交互:图标按钮 toggle;面板内 Escape 关闭;点击面板外关闭
  if (searchAdvBtn && searchAdvMenu && excludeKeywordsInput) {
    searchAdvBtn.addEventListener("mousedown", (event) => {
      // 阻止 mousedown 默认行为,避免 searchInput 触发 blur 导致搜索框被提前收起
      event.preventDefault();
    });
    searchAdvBtn.addEventListener("click", () => {
      if (searchAdvOpen) {
        closeSearchAdv();
      } else {
        openSearchAdv();
      }
    });
    searchAdvMenu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeSearchAdv();
        searchInput.focus();
      }
    });
    document.addEventListener("click", (event) => {
      // 搜索入口按钮与胶囊是兄弟元素(不在 #searchTopField 内),点击它属于"搜索 UI 内部",
      // 否则展开逻辑刚弹起面板,同一次点击冒泡到这里又被收起(栏闪开即收)
      if (event.target.closest("#searchTopField, #searchTopBtn")) {
        return;
      }
      if (searchHistoryOpen) {
        closeSearchHistory({ collapse: false });
      }
      if (searchAdvOpen) {
        closeSearchAdv({ collapse: false });
      }
      if (!searchInput.value.trim() && !excludeKeywordsInput.value.trim()) {
        collapseSearch();
      }
    });
    // 排除词输入:防抖即时搜索(面板保持打开,结果即时生效)
    excludeKeywordsInput.addEventListener("input", () => {
      syncExcludeKeywordsClear();
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        applyFilters().catch((error) => showToast(error.message, { type: "error" }));
      }, 400);
    });
    document.getElementById("excludeKeywordsClearBtn").addEventListener("click", () => {
      excludeKeywordsInput.value = "";
      syncExcludeKeywordsClear();
      applyFilters().catch((error) => showToast(error.message, { type: "error" }));
    });
  }
  // 历史面板交互:面板内 Escape 关闭;清空按钮清除全部记录
  if (searchHistoryMenu && searchHistoryItems) {
    searchHistoryMenu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeSearchHistory();
        searchInput.focus();
      }
    });
    document.getElementById("searchHistoryClearBtn").addEventListener("click", () => {
      try {
        localStorage.removeItem(SEARCH_HISTORY_KEY);
        try { localStorage.removeItem(LEGACY_SEARCH_HISTORY_KEY); } catch (e) {}
      } catch {
        // localStorage 不可用,忽略
      }
      closeSearchHistory({ collapse: false });
    });
  }
  document.getElementById("manualSyncBtn").addEventListener("click", () => {
    triggerManualSync().catch((error) => {
      const button = document.getElementById("manualSyncBtn");
      button.disabled = false;
      button.textContent = "扫描新文件";
      showToast(error.message, { type: "error" });
    });
  });
  document.getElementById("pageSizeSelect").addEventListener("change", () => {
    applyFilters().catch((error) => showToast(error.message, { type: "error" }));
  });
  // 基座模型筛选:输入即筛选(输入串为子串匹配,多 checkpoint 命中全部返回);
  // 候选下拉仅用于点击精确选择;Enter/Escape/外部点击仅收拢菜单不还原输入
  document.getElementById("modelComboboxInput").addEventListener("focus", () => {
    ensureOptionsLoaded()
      .then(() => {
        renderModelMenu(document.getElementById("modelComboboxInput").value);
        openModelMenu();
      })
      .catch((error) => showToast(error.message, { type: "error" }));
  });
  document.getElementById("modelComboboxInput").addEventListener("input", () => {
    ensureOptionsLoaded()
      .then(() => {
        renderModelMenu(document.getElementById("modelComboboxInput").value);
        openModelMenu();
      })
      .catch((error) => showToast(error.message, { type: "error" }));
  });
  document.getElementById("modelComboboxInput").addEventListener("keydown", (event) => {
    if (!state.modelMenuOpen && (event.key === "ArrowDown" || event.key === "Enter")) {
      openModelMenu();
      renderModelMenu(document.getElementById("modelComboboxInput").value);
      event.preventDefault();
      return;
    }
    if (!state.modelMenuOpen || !state.filteredModels.length) {
      return;
    }
    if (event.key === "ArrowDown") {
      state.modelActiveIndex = Math.min(state.modelActiveIndex + 1, state.filteredModels.length - 1);
      renderModelMenu(document.getElementById("modelComboboxInput").value);
      event.preventDefault();
    } else if (event.key === "ArrowUp") {
      state.modelActiveIndex = Math.max(state.modelActiveIndex - 1, 0);
      renderModelMenu(document.getElementById("modelComboboxInput").value);
      event.preventDefault();
    } else if (event.key === "Enter") {
      // 提交当前输入串(子串匹配,不折叠为单个候选);立即刷新取消防抖
      closeModelMenu();
      applyFilters().catch((error) => showToast(error.message, { type: "error" }));
      event.preventDefault();
    } else if (event.key === "Escape") {
      closeModelMenu();
    }
  });
  document.getElementById("modelComboboxToggle").addEventListener("click", () => {
    ensureOptionsLoaded()
      .then(() => {
        if (state.modelMenuOpen) {
          closeModelMenu();
          return;
        }
        renderModelMenu(document.getElementById("modelComboboxInput").value);
        openModelMenu();
        document.getElementById("modelComboboxInput").focus();
      })
      .catch((error) => showToast(error.message, { type: "error" }));
  });
  document.getElementById("modelComboboxMenu").addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-model-option]");
    if (!trigger) {
      return;
    }
    applyModelSelection(trigger.dataset.modelOption);
  });
  document.addEventListener("click", (event) => {
    if (event.target.closest("#modelCombobox")) {
      return;
    }
    closeModelMenu();
  });
  // 正向/排除 LoRA + 收藏分类:多选 combo 绑定(输入过滤/键盘导航/触发开关/点击勾选/chip 单删)
  loraComboInclude.bind();
  loraComboExclude.bind();
  favoriteCategoryCombo.bind();
  // 「任一/全部」与或切换:点击设置对应实例 mode 并即时刷新
  document.querySelectorAll("[data-andor-side]").forEach((group) => {
    group.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-andor-val]");
      if (!btn) return;
      const mode = btn.dataset.andorVal;
      if (mode !== "and" && mode !== "or") return;
      const side = group.dataset.andorSide;
      const combo =
        side === "include"
          ? loraComboInclude
          : side === "exclude"
            ? loraComboExclude
            : favoriteCategoryCombo;
      combo.modeSet(mode);
      syncAndorButtons();
      applyFilters().catch((error) => showToast(error.message, { type: "error" }));
    });
  });
  syncAndorButtons();
  document.getElementById("paginationBar").addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-page-action]");
    if (!trigger) {
      return;
    }
    changePage(trigger.dataset.pageAction).catch((error) => showToast(error.message, { type: "error" }));
  });
  // 页码跳转:输入框内回车确认(委托,翻页后重建的输入框自动生效)
  document.getElementById("paginationBar").addEventListener("keydown", (event) => {
    const input = event.target.closest("[data-page-jump]");
    if (!input || event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    jumpToPage(input.value).catch((error) => showToast(error.message, { type: "error" }));
  });
  // 全选本页(面板标题栏静态控件,不随 renderResults 重建):切换后同步行/三态/批量UI
  document.getElementById("selectAllRows").addEventListener("change", (event) => {
    const keys = [...state.currentItems.keys()].filter(Boolean);
    if (event.target.checked) {
      keys.forEach((key) => state.selection.add(key));
    } else {
      keys.forEach((key) => state.selection.delete(key));
    }
    syncRowSelectionUi();
    syncBulkUi();
    persistSelection();
  });
  // 列表多选(委托:行 checkbox 勾选/取消,翻页重建后自动生效)
  document.getElementById("resultsList").addEventListener("change", (event) => {
    const rowBox = event.target.closest("[data-select-row]");
    if (!rowBox) {
      return;
    }
    const rowKey = rowBox.dataset.selectRow;
    if (rowBox.checked) {
      state.selection.add(rowKey);
      const entry = selectionEntry(rowKey);
      if (entry) state.selectionData.set(rowKey, entry);
    } else {
      state.selection.delete(rowKey);
    }
    rowBox.closest("tr, .fav-card")?.classList.toggle("is-selected", rowBox.checked);
    syncSelectAllCheckbox();
    syncBulkUi();
    persistSelection();
  });
  document.getElementById("resultsList").addEventListener("click", (event) => {
    // 整体折叠/展开(prompt-entry 级)
    const entryToggle = event.target.closest("[data-toggle-entry]");
    if (entryToggle) {
      const entry = entryToggle.closest(".prompt-entry");
      if (entry) {
        const collapsed = entry.classList.toggle("is-collapsed");
        entryToggle.textContent = collapsed ? "+" : "−";
      }
      return;
    }
    // 单行折叠/展开(prompt-layer 级)
    const layerToggle = event.target.closest("[data-toggle-layer]");
    if (layerToggle) {
      const layer = layerToggle.closest(".prompt-layer");
      if (layer) {
        const collapsed = layer.classList.toggle("is-collapsed");
        layerToggle.textContent = collapsed ? "+" : "−";
      }
      return;
    }
    const copyTrigger = event.target.closest("[data-copy-layer]");
    if (copyTrigger) {
      copyPromptLayer(copyTrigger).catch((error) => showToast(error.message, { type: "error" }));
      return;
    }
    const loraTrigger = event.target.closest("[data-lora-filter]");
    if (loraTrigger) {
      applyInlineLoraFilter(loraTrigger.dataset.loraFilter).catch((error) => showToast(error.message, { type: "error" }));
      return;
    }
    const trigger = event.target.closest("[data-preview-batch-key]");
    if (!trigger) {
      return;
    }
    const batchKey = trigger.dataset.previewBatchKey;
    const index = Number(trigger.dataset.previewIndex || "0");
    const item = state.currentItems.get(batchKey);
    if (!item) {
      return;
    }
    openPreview(
      {
        meta: trigger.dataset.previewMeta,
        images: item.batch?.images || [],
        item,
      },
      index
    );
  });
  document.getElementById("closeImagePreviewBtn").addEventListener("click", closePreview);
  document.getElementById("previewPrevBtn").addEventListener("click", () => shiftPreview(-1));
  document.getElementById("previewNextBtn").addEventListener("click", () => shiftPreview(1));
  document.getElementById("imagePreviewModal").addEventListener("click", (event) => {
    if (event.target.closest("[data-preview-close='true']")) {
      closePreview();
      return;
    }
    const rawJsonTrigger = event.target.closest("[data-copy-raw-json]");
    if (rawJsonTrigger) {
      const content = rawJsonTrigger.closest(".detail-enrichment-raw")?.querySelector(".detail-enrichment-raw-pre")?.textContent || "";
      navigator.clipboard
        .writeText(content)
        .then(() => showToast("已复制 JSON 原文", { type: "success", duration: 1600 }))
        .catch((error) => showToast(error.message, { type: "error" }));
      return;
    }
    // 整体折叠/展开(prompt-entry 级)
    const entryToggle = event.target.closest("[data-toggle-entry]");
    if (entryToggle) {
      const entry = entryToggle.closest(".prompt-entry");
      if (entry) {
        const collapsed = entry.classList.toggle("is-collapsed");
        entryToggle.textContent = collapsed ? "+" : "−";
      }
      return;
    }
    // 单行折叠/展开(prompt-layer 级)
    const layerToggle = event.target.closest("[data-toggle-layer]");
    if (layerToggle) {
      const layer = layerToggle.closest(".prompt-layer");
      if (layer) {
        const collapsed = layer.classList.toggle("is-collapsed");
        layerToggle.textContent = collapsed ? "+" : "−";
      }
      return;
    }
    const copyTrigger = event.target.closest("[data-copy-layer]");
    if (copyTrigger) {
      copyPromptLayer(copyTrigger).catch((error) => showToast(error.message, { type: "error" }));
      return;
    }
    const loraTrigger = event.target.closest("[data-lora-filter]");
    if (loraTrigger) {
      closePreview();
      applyInlineLoraFilter(loraTrigger.dataset.loraFilter).catch((error) => showToast(error.message, { type: "error" }));
      return;
    }
    const stripTrigger = event.target.closest("[data-preview-strip-index]");
    if (!stripTrigger) {
      return;
    }
    state.previewIndex = Number(stripTrigger.dataset.previewStripIndex || "0");
    syncPreviewView();
  });
  // 预览左侧竖列每张缩略图旁的「待处理」checkbox(委托 change):勾选 = 加入左下角待处理,
  // 取消 = 移出;不直接收藏,收藏走详情 tag 点击或左下角批量操作。
  document.getElementById("imagePreviewModal").addEventListener("change", (event) => {
    const check = event.target instanceof Element ? event.target.closest("[data-preview-strip-fav]") : null;
    if (!check) {
      return;
    }
    const rowKey = String(check.dataset.previewStripFav || "");
    if (!rowKey) {
      return;
    }
    if (check.checked) {
      state.selection.add(rowKey);
      // 用行级 key 走 selectionEntry,缓存整行条目;collection 批量按行解析,避免与单图 key 混存导致重复
      const entry = selectionEntry(rowKey);
      if (entry) state.selectionData.set(rowKey, entry);
    } else {
      state.selection.delete(rowKey);
    }
    const label = check.closest(".preview-strip-check");
    if (label) label.title = check.checked ? "移出待处理" : "加入待处理";
    // 同步列表行 checkbox / 全选三态,并回显当前 strip(选中态可能影响其他条目显示)
    syncRowSelectionUi();
    renderPreviewStrip(state.previewItem?.images || [], state.previewIndex || 0);
    syncBulkUi();
    persistSelection();
  });
  document.getElementById("imagePreviewImg").addEventListener("click", () => {
    document.getElementById("imagePreviewBody").classList.toggle("is-zoomed");
  });
  document.getElementById("imagePreviewMeta")?.addEventListener("click", (event) => {
    event.currentTarget.classList.toggle("is-expanded");
  });
  document.getElementById("copyPositiveBtn").addEventListener("click", () => {
    const item = state.previewItem?.item;
    const fullFile = Array.isArray(item?.images) ? item.images[state.previewIndex] || {} : {};
    const previewFile = state.previewItem?.images?.[state.previewIndex] || {};
    const rawPrompt = (fullFile.metadata || previewFile.metadata || item?.metadata || {}).raw_prompt;
    const positive = promptEntriesForDisplay(item?.prompts?.positive || [], rawPrompt);
    const text = positive
      .map((prompt) => {
        const layerText = (prompt.layers || [])
          .map((layer) => (layer.lines && layer.lines.length ? layer.lines.join("\n") : layer.text || ""))
          .filter(Boolean)
          .join("\n");
        return layerText || prompt.text || "";
      })
      .filter(Boolean)
      .join("\n");
    if (!text.trim()) {
      showToast("当前记录没有可复制的正向 Prompt", { type: "warning" });
      return;
    }
    navigator.clipboard
      .writeText(text)
      .then(() => showToast("已复制正向 Prompt", { type: "success", duration: 1600 }))
      .catch((error) => showToast(error.message, { type: "error" }));
  });
  const copyWfBtn = document.getElementById("copyWorkflowBtn");
  if (copyWfBtn) {
    copyWfBtn.addEventListener("click", () => {
      const wf = getActiveWorkflowData();
      if (!wf) {
        showToast("当前记录没有可导出的工作流数据", { type: "warning" });
        return;
      }
      const text = JSON.stringify(wf, null, 2);
      navigator.clipboard
        .writeText(text)
        .then(() => showToast("已复制工作流 JSON（可在 ComfyUI 画布中直接 Ctrl+V 粘贴）", { type: "success", duration: 2000 }))
        .catch((error) => showToast(error.message, { type: "error" }));
    });
  }
  const exportWfBtn = document.getElementById("exportWorkflowBtn");
  if (exportWfBtn) {
    exportWfBtn.addEventListener("click", () => {
      const wf = getActiveWorkflowData();
      if (!wf) {
        showToast("当前记录没有可导出的工作流数据", { type: "warning" });
        return;
      }
      const sanitized = sanitizeWorkflowPaths(wf);
      const activeImage = (state.previewItem?.images || [])[state.previewIndex] || {};
      const baseName = (activeImage.filename || "workflow").replace(/\.[^/.]+$/, "");
      downloadJsonFile(`${baseName}_workflow.json`, sanitized);
      showToast("已导出脱敏工作流 JSON", { type: "success", duration: 1800 });
    });
  }
  document.getElementById("previewNodeGraphBtn").addEventListener("click", () => {
    state.previewView = state.previewView === "graph" ? "image" : "graph";
    renderPreviewStage();
    const btn = document.getElementById("previewNodeGraphBtn");
    if (btn) btn.textContent = state.previewView === "graph" ? "缩略图" : "节点图";
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !document.getElementById("imagePreviewModal").hidden) {
      closePreview();
      return;
    }
    if (event.key === "ArrowLeft" && !document.getElementById("imagePreviewModal").hidden) {
      shiftPreview(-1);
    }
    if (event.key === "ArrowRight" && !document.getElementById("imagePreviewModal").hidden) {
      shiftPreview(1);
    }
  });
  window.addEventListener("resize", () => {
    balancePromptHeights();
  });
  state.syncPollTimer = window.setInterval(() => {
    pollSyncStatus().catch((error) => perfLog("pollSyncStatus:fail", error.message));
  }, 60000);
}

boot().catch((error) => {
  document.getElementById("resultsList").innerHTML = `<div class="empty">加载失败: ${escapeHtml(error.message)}</div>`;
  showToast(error.message, { type: "error" });
});
