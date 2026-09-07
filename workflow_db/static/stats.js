const statsState = {
  options: { base_models: [], loras: [] },
  filteredModels: [],
  modelMenuOpen: false,
  modelActiveIndex: -1,
  tagIndex: new Map(),
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
                    return `<td>${column.pre ? `<pre class="stats-pre">${statsHighlightPrompt(value)}</pre>` : statsEscapeHtml(value)}</td>`;
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
  // 后端契约参数名为 lora(loraProfile 的 StatsQuery);曾误传 focus_lora
  // (仅缓存键命名),后端不识别导致"搭配 LoRA/搭配 Prompt"恒空
  if (focusLora) {
    profileParams.set("lora", focusLora);
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
  // 标记库先行:Layer 列渲染时需查索引做 tag-highlight 染色
  await loadStatsTagCatalog();
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

  // 焦点 LoRA 统一使用 combo 候选组件
  (window.aaLoraCombo || window.wfdbLoraCombo)({
    input: document.getElementById("statsFocusLoraInput"),
    menu: document.getElementById("statsFocusLoraMenu"),
    toggle: document.getElementById("statsFocusLoraToggle"),
    getOptions: () => statsState.options?.loras || [],
    onSelect: (value) => {
      document.getElementById("statsFocusLoraInput").value = value;
      refresh();
    },
  });

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
  bindStatsDanbooru();
  bindStatsQuickAnnotate();
  void loadStatsQaCategories();
}

// ===== prompt 层标注 + danbooru 悬停浮层 =====
// 与主页 app.js 同源交互的精简版:切段标注(danbooru-seg)与浮层全部复用
// styles.css 现成样式;浮层仅保留 head(名/中文/类型/帖数)+特征摘要+wiki
// 链接,数据来自 /api/tag-related;danbooru 资产未启用时静默降级为纯标注。
// 不含主页的 pin/拖拽/缩放/快速标注/收藏(依赖主页面状态,统计页无此场景)。

const STATS_DANBOORU_TYPE_LABELS = {
  general: "特征",
  character: "角色",
  copyright: "作品",
  artist: "画师",
  meta: "元数据",
};

const STATS_DANBOORU_CATEGORY_LABELS = {
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

const STATS_DANBOORU_HIDDEN_CATEGORIES = new Set(["meta"]);
const STATS_TRAIT_INLINE_LIMIT = 5;

// ===== 标记库标注(与主页 tag-highlight 同源) =====
// 词条归一/索引构建与 app.js 的 normalizeTagTerm/tagHash/tagTermsFromFragments/
// buildTagIndex 逻辑一致;命中标记库的段渲染 tag-highlight 染色按钮
// (tone 色板走 styles.css 的 [data-tag-tone] 变量,零新增样式)。
function statsNormalizeTagTerm(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase()
    .replace(/\\/g, "") // 剥 ComfyUI 转义反斜杠 \( → (
    .replace(/ /g, "_"); // 查表键层归一:空格→下划线(词表规范形),跨写法命中
}

function statsTagHash(value) {
  let hash = 0;
  for (const char of String(value ?? "")) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  return Math.abs(hash);
}

function statsTagTermsFromFragments(fragments) {
  const terms = new Set();
  for (const fragment of Array.isArray(fragments) ? fragments : []) {
    for (const term of String(fragment ?? "").split(/[\r\n,]+/)) {
      const normalized = statsNormalizeTagTerm(term);
      if (normalized) terms.add(normalized);
    }
  }
  return [...terms];
}

function statsBuildTagIndex(items) {
  const index = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item) continue;
    const terms = statsTagTermsFromFragments(item?.prompt_fragments);
    if (!terms.length) continue;
    const identity = item.id || item._id || `${item.category || "tag"}:${item.name || terms[0]}`;
    const tag = {
      key: `tag-${statsTagHash(identity).toString(36)}`,
      tone: statsTagHash(identity) % 12,
      name: String(item.name || terms[0]),
      category: String(item.category_label || item.category || "标记"),
      note: String(item.note || ""),
      terms,
    };
    for (const term of terms) {
      // 同一词条多条标记时保留首条,避免重叠染色(与主页一致)
      if (!index.has(term)) index.set(term, tag);
    }
  }
  return index;
}

async function loadStatsTagCatalog() {
  try {
    const payload = await statsFetchJson("/api/manual-labels?limit=200");
    statsState.tagIndex = statsBuildTagIndex(payload?.items || []);
  } catch {
    statsState.tagIndex = new Map();
  }
}

function statsTagForSegment(value) {
  return statsState.tagIndex instanceof Map
    ? statsState.tagIndex.get(statsNormalizeTagTerm(value))
    : undefined;
}

// prompt 层文本切段标注:按逗号/换行切分;命中标记库的段渲染 tag-highlight
// 染色按钮,其余段包 danbooru-seg(悬停查关联)。切段与转义规则与主页
// highlightPromptText 一致。
function statsHighlightPrompt(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .split(/(,|\n)/)
    .map((segment) => {
      if (segment === "," || segment === "\n") return statsEscapeHtml(segment);
      const parts = segment.match(/^(\s*)([\s\S]*?)(\s*)$/);
      const core = parts?.[2] || "";
      if (!core) return statsEscapeHtml(segment);
      const tag = statsTagForSegment(core);
      if (tag) {
        const title = `${tag.category} · ${tag.name}${tag.note ? ` · ${tag.note}` : ""} · 悬停查看 danbooru 关联`;
        return `${statsEscapeHtml(parts[1])}<button class="tag-highlight" type="button" data-tag-tone="${tag.tone}" data-danbooru-tag="${statsEscapeHtml(core)}" title="${statsEscapeHtml(title)}">${statsEscapeHtml(core)}</button>${statsEscapeHtml(parts[3])}`;
      }
      return `${statsEscapeHtml(parts[1])}<span class="danbooru-seg" data-danbooru-tag="${statsEscapeHtml(core)}">${statsEscapeHtml(core)}</span>${statsEscapeHtml(parts[3])}`;
    })
    .join("");
}

const statsDanbooru = {
  enabled: true,
  cache: new Map(),
  hoverTimer: null,
  panel: null,
};

async function statsDanbooruFetch(tag) {
  if (!statsDanbooru.enabled) return null;
  const key = String(tag ?? "").trim().toLowerCase();
  if (statsDanbooru.cache.has(key)) return statsDanbooru.cache.get(key);
  try {
    const payload = await statsFetchJson(`/api/tag-related?tag=${encodeURIComponent(String(tag))}`);
    if (!payload || payload.enabled === false) {
      statsDanbooru.enabled = false;
      return null;
    }
    if (statsDanbooru.cache.size > 128) statsDanbooru.cache.clear();
    statsDanbooru.cache.set(key, payload);
    return payload;
  } catch {
    statsDanbooru.enabled = false;
    return null;
  }
}

function statsTraitRowHtml(label, items) {
  if (!items || !items.length) return "";
  const limited = items.length > STATS_TRAIT_INLINE_LIMIT;
  const chips = items
    .map((t, i) => {
      const display = String(t.name || "").replace(/_/g, " ");
      const official = Number(t.vote_official || 0);
      const vote = Number(t.vote || 0);
      const meta = official ? `官方图 ×${official}` : vote > 1 ? `参考图 ×${vote}` : "";
      const hidden = limited && i >= STATS_TRAIT_INLINE_LIMIT;
      return `<button class="danbooru-trait-chip${official ? " danbooru-trait-chip--official" : ""}${hidden ? " danbooru-trait-chip--more" : ""}" type="button" title="${statsEscapeHtml(`${String(t.name || "")}${meta ? ` · ${meta}` : ""}`)}">${statsEscapeHtml(display)}</button>`;
    })
    .join("");
  const expand = limited
    ? `<button class="danbooru-trait-expand" type="button" data-stats-trait-expand title="展开此项全部特征">展开 +${items.length - STATS_TRAIT_INLINE_LIMIT}</button>`
    : "";
  return `<div class="danbooru-trait-row${limited ? " danbooru-trait-row--collapsed" : ""}"><span class="danbooru-trait-label">${statsEscapeHtml(label)}</span>${chips}${expand}</div>`;
}

function statsPanelHtml(tag, payload) {
  const tagMeta = payload.tag || {};
  const tr = tagMeta.zh ? `<span class="danbooru-panel-tr">${statsEscapeHtml(tagMeta.zh)}</span>` : "";
  const type = tagMeta.tag_type
    ? `<span class="danbooru-panel-type">${statsEscapeHtml(STATS_DANBOORU_TYPE_LABELS[tagMeta.tag_type] || tagMeta.tag_type)}</span>`
    : "";
  const count = tagMeta.count
    ? `<span class="danbooru-panel-count" title="${Number(tagMeta.count).toLocaleString()} 帖">${statsEscapeHtml(statsFormatCount(tagMeta.count))}</span>`
    : "";
  const header = `<div class="danbooru-panel-head"><span class="danbooru-panel-tag">${statsEscapeHtml(String(tagMeta.name || tag).replace(/_/g, " "))}</span>${tr}${type}<span class="danbooru-panel-head-right">${count}</span></div>`;

  const sections = [];
  const rows = (Array.isArray(payload.traits?.rows) ? payload.traits.rows : [])
    .filter((row) => !STATS_DANBOORU_HIDDEN_CATEGORIES.has(row.category))
    .map((row) => statsTraitRowHtml(STATS_DANBOORU_CATEGORY_LABELS[row.category] || row.category, row.items))
    .filter(Boolean);
  if (rows.length) {
    sections.push(`<div class="danbooru-section danbooru-traits"><span class="danbooru-traits-badge">特征（结构化档案）</span>${rows.join("")}</div>`);
  }
  if (!sections.length && Array.isArray(payload.related) && payload.related.length) {
    sections.push(
      `<div class="danbooru-section"><div class="danbooru-section-head">相关推荐</div><div class="danbooru-trait-row">${payload.related
        .slice(0, 6)
        .map((t) => `<button class="danbooru-trait-chip" type="button">${statsEscapeHtml(String(t.name || "").replace(/_/g, " "))}</button>`)
        .join("")}</div></div>`,
    );
  }
  const body = sections.length ? sections.join("") : '<div class="danbooru-empty">无关联结果</div>';
  const canonical = tagMeta.name || tag;
  const foot = `<div class="danbooru-panel-foot"><a class="danbooru-link" href="https://danbooru.donmai.us/wiki_pages/${encodeURIComponent(String(canonical))}" target="_blank" rel="noopener">在 Danbooru 查看</a></div>`;
  return `${header}<div class="danbooru-panel-body">${body}</div>${foot}`;
}

// 帖子数紧凑显示(与主页 formatCountCompact 同义:1.2w / 3450)
function statsFormatCount(value) {
  const n = Number(value) || 0;
  return n >= 10000 ? `${(n / 10000).toFixed(1)}w` : n.toLocaleString();
}

function statsClosePanel() {
  if (statsDanbooru.panel) {
    statsDanbooru.panel.remove();
    statsDanbooru.panel = null;
  }
}

// 视口内夹紧定位:优先出现在鼠标右下,越界翻转到左上(tag 浮层与标注面板共用)
function statsPositionPanel(panel, x, y) {
  const rect = panel.getBoundingClientRect();
  const flipX = x + 12 + rect.width > window.innerWidth - 8;
  const flipY = y + 14 + rect.height > window.innerHeight - 8;
  const left = Math.max(8, Math.min(flipX ? x - rect.width - 12 : x + 12, window.innerWidth - rect.width - 8));
  const top = Math.max(8, Math.min(flipY ? y - rect.height - 14 : y + 14, window.innerHeight - rect.height - 8));
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

function statsOpenPanel(x, y, html) {
  statsClosePanel();
  const panel = document.createElement("div");
  panel.className = "danbooru-panel";
  panel.innerHTML = html;
  document.body.appendChild(panel);
  statsPositionPanel(panel, x, y);
  statsDanbooru.panel = panel;
}

function statsSegOf(target) {
  return target instanceof Element ? target.closest("[data-danbooru-tag]") : null;
}

function bindStatsDanbooru() {
  // 悬停 300ms → 浮层;文本选区中不弹(与主页冲突门一致)
  document.addEventListener("pointerover", (event) => {
    const el = statsSegOf(event.target);
    if (!el) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const { clientX, clientY } = event;
    clearTimeout(statsDanbooru.hoverTimer);
    statsDanbooru.hoverTimer = setTimeout(async () => {
      const tag = el.dataset.danbooruTag;
      const payload = await statsDanbooruFetch(tag);
      if (!payload) return;
      statsOpenPanel(clientX, clientY, statsPanelHtml(tag, payload));
    }, 300);
  });
  document.addEventListener("pointerout", (event) => {
    if (statsSegOf(event.target) !== statsSegOf(event.relatedTarget)) {
      clearTimeout(statsDanbooru.hoverTimer);
    }
  });
  document.addEventListener("click", (event) => {
    const expand = event.target instanceof Element ? event.target.closest("[data-stats-trait-expand]") : null;
    if (expand) {
      const row = expand.closest(".danbooru-trait-row");
      if (row) row.classList.remove("danbooru-trait-row--collapsed");
      expand.remove();
      return;
    }
    if (statsDanbooru.panel && !statsDanbooru.panel.contains(event.target) && !statsSegOf(event.target)) {
      statsClosePanel();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      statsClosePanel();
      statsQaClosePanel();
    }
  });
  // 页面滚动关闭;面板自身滚动不关闭(捕获阶段区分,与主页一致)
  window.addEventListener(
    "scroll",
    (event) => {
      const panel = statsDanbooru.panel;
      if (panel && event.target instanceof Node && panel.contains(event.target)) return;
      statsClosePanel();
    },
    true,
  );
}

// ===== 快速标注(选中 prompt 文本 → 浮标 → 标注表单) =====
// 与主页入口二(文本选中 → 纯标注面板)同源的精简版:无图片上下文行
// (统计页无图);分类走 /api/manual-label-categories,失败用内置兜底;
// 样式类(qa-sel-btn/qa-form/danbooru-panel--annotate-only)全部复用
// styles.css。钉选语义与主页一致:外点不关(防误触丢表单),Escape/保存/取消关。

const STATS_QA_CATEGORIES = [
  ["character", "角色"],
  ["style", "风格"],
  ["concept", "概念"],
  ["quality", "质量"],
  ["negative", "负面"],
  ["technique", "技法"],
];

const statsQaState = {
  selBtn: null, // 选中浮标按钮
  selectionText: "", // pointerdown 缓存选区文本(点击浮标会折叠选区)
  panel: null,
};

let statsQaCategories = [];

function statsQaCategoryList() {
  return statsQaCategories.length ? statsQaCategories : STATS_QA_CATEGORIES;
}

async function loadStatsQaCategories() {
  try {
    const payload = await statsFetchJson("/api/manual-label-categories");
    const list = Array.isArray(payload.items) ? payload.items : [];
    if (list.length) {
      statsQaCategories = list.map((entry) => [entry.key, entry.label || entry.key]);
    }
  } catch {
    // 忽略:保留内置兜底
  }
}

function statsQaFormHtml(prefill) {
  const name = String(prefill.name || "").replace(/\s+/g, " ").trim();
  const fragmentsText = String(prefill.fragments || "")
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n");
  const options = statsQaCategoryList()
    .map(([value, label]) => `<option value="${statsEscapeHtml(value)}">${statsEscapeHtml(label)}</option>`)
    .join("");
  return `<div class="qa-form">
    <div class="qa-field"><label class="qa-label">名称</label><input class="qa-input" data-qa-field="name" value="${statsEscapeHtml(name)}" placeholder="词条名"></div>
    <div class="qa-field"><label class="qa-label">分类</label><select class="qa-select" data-qa-field="category">${options}</select></div>
    <div class="qa-field"><label class="qa-label">Prompt 片段</label><textarea class="qa-textarea" data-qa-field="fragments" placeholder="每行一个片段">${statsEscapeHtml(fragmentsText)}</textarea></div>
    <div class="qa-field"><label class="qa-label">备注</label><input class="qa-input" data-qa-field="note" placeholder="可选"></div>
    <div class="qa-error" data-qa-error>名称不能为空</div>
    <div class="qa-actions"><button class="qa-btn qa-btn--primary" type="button" data-qa-save>保存</button><button class="qa-btn" type="button" data-qa-cancel>取消</button></div>
  </div>`;
}

function statsQaClosePanel() {
  if (statsQaState.panel) {
    statsQaState.panel.remove();
    statsQaState.panel = null;
  }
}

function statsQaOpenPanel(text, x, y) {
  statsClosePanel(); // 关掉 tag 悬停浮层,避免叠放
  statsQaClosePanel();
  const lines = String(text || "")
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const panel = document.createElement("div");
  panel.className = "danbooru-panel danbooru-panel--annotate-only";
  const head = `<div class="danbooru-panel-head"><span class="danbooru-panel-tag">快速标注</span>${lines.length ? `<span class="danbooru-panel-count">${lines.length} 片段</span>` : ""}</div>`;
  panel.innerHTML = head + '<div class="danbooru-panel-body" hidden></div>';
  document.body.appendChild(panel);
  const wrap = document.createElement("div");
  wrap.innerHTML = statsQaFormHtml({ name: lines[0] || "", fragments: lines.join("\n") });
  const form = wrap.firstElementChild;
  panel.appendChild(form);
  statsPositionPanel(panel, x, y);
  statsQaState.panel = panel;

  form.querySelector("[data-qa-cancel]").addEventListener("click", statsQaClosePanel);
  form.querySelector("[data-qa-save]").addEventListener("click", async () => {
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
      showToast("已保存到标注库", { type: "success", duration: 1600 });
      statsQaClosePanel();
      // 刷新标记索引并重渲染,新词条染色立即生效(与主页 saveQuickAnnotate 一致)
      await loadStatsTagCatalog();
      await loadStatsPage();
    } catch (error) {
      showToast(error.message || "保存失败", { type: "error" });
    }
  });
}

function statsEnsureQaSelButton() {
  if (statsQaState.selBtn) return statsQaState.selBtn;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "qa-sel-btn";
  btn.hidden = true;
  btn.textContent = "标注";
  document.body.appendChild(btn);
  // pointerdown 缓存选区(点击浮标会折叠选区,与主页一致)
  btn.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const sel = window.getSelection();
    statsQaState.selectionText = sel && !sel.isCollapsed ? sel.toString().trim() : "";
  });
  btn.addEventListener("mousedown", (event) => event.preventDefault());
  btn.addEventListener("click", () => {
    const text = statsQaState.selectionText;
    const rect = btn.getBoundingClientRect();
    btn.hidden = true;
    statsQaOpenPanel(text, rect.left, rect.bottom + 6);
  });
  statsQaState.selBtn = btn;
  return btn;
}

function statsOnSelectionChange() {
  const btn = statsEnsureQaSelButton();
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) {
    btn.hidden = true;
    return;
  }
  // 容器门:仅统计表 prompt 层(.stats-pre)内的选区浮出标注浮标
  const node = sel.anchorNode;
  const pre = node instanceof Element ? node.closest(".stats-pre") : node?.parentElement?.closest(".stats-pre");
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

function bindStatsQuickAnnotate() {
  statsEnsureQaSelButton();
  document.addEventListener("selectionchange", statsOnSelectionChange);
  document.addEventListener("mouseup", () => {
    clearTimeout(statsDanbooru.hoverTimer);
    statsOnSelectionChange();
  });
  window.addEventListener(
    "scroll",
    () => {
      if (statsQaState.selBtn) statsQaState.selBtn.hidden = true;
    },
    true,
  );
}

bootStats().catch((error) => {
  const container = document.getElementById("statsLoraFrequency");
  if (container) {
    container.innerHTML = `<div class="empty">加载失败: ${statsEscapeHtml(error.message)}</div>`;
  }
  showToast(error.message, { type: "error" });
});
