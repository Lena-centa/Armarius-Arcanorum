const generateState = {
  source: null,
  activePromptId: "",
  pollTimer: null,
  queueOpen: false,
  previewImages: [],
  previewIndex: 0,
  historyItems: [],
};

function parseOptionalNumber(value) {
  if (value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function formatGenerateStrength(value) {
  if (value === undefined || value === null || value === "") return "";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  const snapped = Math.round(numeric / 0.05) * 0.05;
  const displayValue = Math.abs(numeric - snapped) < 1e-9 ? snapped : numeric;
  return Number(displayValue.toFixed(4)).toString();
}

function generateEscapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 可编辑标量:连线派生的对象值(width 来自 Get Image Size 等)不可直接编辑,置空。 */
function generateEditableScalar(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "object") return "";
  return value;
}

/**
 * 本地时区(浏览器)分钟级时间显示:从 captured_at(UTC ISO)换算为
 * 浏览器本地时区的 "YYYY-MM-DD HH:MM"。captured_at 缺失时回退到
 * created_date + created_hour(UTC 小时口径)。
 */
function formatGenerateCapturedAt(capturedAt, fallbackDate, fallbackHour) {
  if (capturedAt) {
    const d = new Date(capturedAt);
    if (!Number.isNaN(d.getTime())) {
      const pad = (n) => String(n).padStart(2, "0");
      const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
  }
  const hour =
    fallbackHour == null ? "" : ` ${String(fallbackHour).padStart(2, "0")}:00`;
  return `${fallbackDate || ""}${hour}`;
}

async function generateFetchJson(url, options) {
  const response = await fetch(apiUrl(url), options || {});
  if (!response.ok) {
    let detail = "request failed";
    try {
      const payload = await response.json();
      detail = payload.detail || payload.error || JSON.stringify(payload);
    } catch (error) {
      detail = response.statusText || detail;
    }
    throw new Error(detail);
  }
  return response.json();
}

function comfyViewUrl(image) {
  const params = new URLSearchParams();
  params.set("filename", image.filename || "");
  params.set("subfolder", image.subfolder || "");
  params.set("type", image.type || "output");
  return apiUrl(`/api/generate/view?${params.toString()}`);
}

function preferredHistoryImages(images) {
  const items = Array.isArray(images) ? images : [];
  const outputs = items.filter((image) => image && image.type === "output");
  return outputs.length ? outputs : items;
}

function queueTotalCount(payload) {
  return (payload.running || []).length + (payload.pending || []).length;
}

function renderQueueToggle(payload) {
  const button = document.getElementById("queueToggleBtn");
  const count = queueTotalCount(payload);
  button.textContent = count ? `队列 ${count}` : "队列";
  // 摘要 popover 计数(与浮动面板 queueSummary 同源)
  const runningEl = document.getElementById("queueRunningCount");
  const pendingEl = document.getElementById("queuePendingCount");
  if (runningEl) runningEl.textContent = String((payload.running || []).length);
  if (pendingEl) pendingEl.textContent = String((payload.pending || []).length);
}

function setQueueOpen(open) {
  generateState.queueOpen = Boolean(open);
  const panel = document.getElementById("queueFloatPanel");
  const button = document.getElementById("queueToggleBtn");
  panel.hidden = !generateState.queueOpen;
  button.setAttribute("aria-expanded", generateState.queueOpen ? "true" : "false");
}

function renderGenerateEditor() {
  const container = document.getElementById("generateEditor");
  const meta = document.getElementById("generateSourceMeta");
  const source = generateState.source;
  const submitButton = document.getElementById("submitGenerateBtn");
  const inlineSubmitButton = document.getElementById("submitGenerateInlineBtn");
  if (!source) {
    meta.textContent = "未载入来源";
    container.className = "generate-editor empty";
    container.textContent = "请选择一张带工作流的图片";
    submitButton.disabled = true;
    inlineSubmitButton.disabled = true;
    return;
  }

  submitButton.disabled = false;
  inlineSubmitButton.disabled = false;
  const replayMode = source.replay && source.replay.mode === "exact_api_prompt"
    ? "原始 API prompt"
    : "由 UI workflow 重建";
  const replayWarnings = ((source.replay && source.replay.warnings) || [])
    .map((warning) => `<div class="generate-replay-warning">${generateEscapeHtml(warning)}</div>`)
    .join("");
  meta.textContent =
    `${source.source_image.filename} · ${formatGenerateCapturedAt(source.source_image.captured_at, source.source_image.created_date, source.source_image.created_hour)} · batch ${source.batch.count}`;

  const checkpointOptions = (source.options.checkpoints || [])
    .map((value) => `<option value="${generateEscapeHtml(value)}"></option>`)
    .join("");

  container.className = "generate-editor";
  container.innerHTML = `
    <datalist id="generateCheckpointOptions">${checkpointOptions}</datalist>

    <section class="generate-section">
      <h3>来源</h3>
      <div class="generate-source-card">
        <img src="${apiUrl(`/api/thumb/${generateEscapeHtml(source.source_image.sha256)}?w=360&h=360`)}" alt="${generateEscapeHtml(source.source_image.filename)}" />
        <div class="generate-source-meta">
          <div><strong>文件</strong> <span>${generateEscapeHtml(source.source_image.filename)}</span></div>
          <div><strong>路径</strong> <span>${generateEscapeHtml(source.source_image.resolved_path || "-")}</span></div>
          <div><strong>SHA256</strong> <span>${generateEscapeHtml(source.source_image.sha256)}</span></div>
          <div><strong>工作流</strong> <span>id ${generateEscapeHtml(source.workflow.id || "-")} · prompt 节点 ${source.workflow.node_count} · ui 节点 ${source.workflow.workflow_node_count}</span></div>
          <div><strong>重放来源</strong> <span>${generateEscapeHtml(replayMode)}</span></div>
          ${replayWarnings}
        </div>
      </div>
    </section>

    <section class="generate-section">
      <h3>保存前缀</h3>
      <div class="field wide">
        <input id="generateFilenamePrefix" type="text" value="${generateEscapeHtml(new Date().toISOString().slice(0, 10) + "/Replay")}">
      </div>
    </section>

    <section class="generate-section">
      <h3>Checkpoint <span class="generate-section-count">${(source.editable.checkpoints || []).length}</span></h3>
      <div class="generate-grid">
        ${(source.editable.checkpoints || [])
          .map(
            (item) => `
              <label class="generate-card">
                <span class="generate-card-title">${generateEscapeHtml(item.label)}<span class="generate-card-sub">${generateEscapeHtml(item.field)}</span></span>
                <input
                  type="text"
                  list="generateCheckpointOptions"
                  data-generate-checkpoint="true"
                  data-node-id="${generateEscapeHtml(item.node_id)}"
                  data-field="${generateEscapeHtml(item.field)}"
                  value="${generateEscapeHtml(item.value || "")}"
                />
              </label>
            `
          )
          .join("") || '<div class="muted">当前工作流未解析出 checkpoint 节点。</div>'}
      </div>
    </section>

    <section class="generate-section">
      <h3>LoRA <span class="generate-section-count">${(source.editable.loras || []).length}</span></h3>
      <div class="generate-grid">
        ${(source.editable.loras || [])
          .map(
            (item) => `
              <div class="generate-card">
                <div class="generate-card-head">
                  <span class="generate-card-title">${generateEscapeHtml(item.label)}<span class="generate-card-sub">${generateEscapeHtml(item.source || item.node_type || "")}</span></span>
                  <label class="inline-toggle">
                    <input type="checkbox" data-generate-lora-enabled="true" data-node-id="${generateEscapeHtml(item.node_id)}" data-slot="${item.slot == null ? "" : generateEscapeHtml(item.slot)}" ${item.enabled ? "checked" : ""}>
                    启用
                  </label>
                </div>
                <div class="combo-box generate-lora-combo">
                  <input
                    type="text"
                    autocomplete="off"
                    data-generate-lora-name="true"
                    data-node-id="${generateEscapeHtml(item.node_id)}"
                    data-slot="${item.slot == null ? "" : generateEscapeHtml(item.slot)}"
                    data-source="${generateEscapeHtml(item.source || item.node_type || "")}"
                    value="${generateEscapeHtml(item.name || "")}"
                  />
                  <button type="button" class="combo-toggle" data-generate-lora-combo-toggle="true" aria-label="选择 LoRA">▼</button>
                  <div class="combo-menu" data-generate-lora-combo-menu="true" hidden></div>
                </div>
                <div class="generate-row">
                  <label>
                    <span>Model</span>
                    <input type="number" step="0.05" data-generate-lora-model="true" data-node-id="${generateEscapeHtml(item.node_id)}" data-slot="${item.slot == null ? "" : generateEscapeHtml(item.slot)}" value="${generateEscapeHtml(formatGenerateStrength(item.strength_model))}">
                  </label>
                  <label>
                    <span>CLIP</span>
                    <input type="number" step="0.05" data-generate-lora-clip="true" data-node-id="${generateEscapeHtml(item.node_id)}" data-slot="${item.slot == null ? "" : generateEscapeHtml(item.slot)}" value="${generateEscapeHtml(formatGenerateStrength(item.strength_clip))}">
                  </label>
                  <label>
                    <span>Weight</span>
                    <input type="number" step="0.05" data-generate-lora-weight="true" data-node-id="${generateEscapeHtml(item.node_id)}" data-slot="${item.slot == null ? "" : generateEscapeHtml(item.slot)}" value="${generateEscapeHtml(formatGenerateStrength(item.strength))}">
                  </label>
                </div>
              </div>
            `
          )
          .join("") || '<div class="muted">当前工作流未解析出 LoRA 节点。</div>'}
      </div>
    </section>

    <section class="generate-section">
      <h3>Prompt <span class="generate-section-count">${(source.editable.prompts || []).length}</span></h3>
      <div class="generate-prompt-stack">
        ${(source.editable.prompts || [])
          .map(
            (item) => `
              <label class="generate-card generate-prompt-card">
                <span class="generate-card-title">${generateEscapeHtml(item.branch_label || item.label)}<span class="generate-card-sub">${generateEscapeHtml(item.node_id)} · ${generateEscapeHtml(item.polarity)}</span></span>
                <textarea rows="10" data-generate-prompt="true" data-node-id="${generateEscapeHtml(item.node_id)}" data-field="${generateEscapeHtml(item.field || "text")}">${generateEscapeHtml(item.text || "")}</textarea>
              </label>
            `
          )
          .join("") || '<div class="muted">当前工作流未解析出可编辑的文本节点。</div>'}
      </div>
    </section>

    <section class="generate-section">
      <h3>KSampler <span class="generate-section-count">${(source.editable.samplers || []).length}</span></h3>
      <div class="generate-grid generate-grid-sampler">
        ${(source.editable.samplers || [])
          .map(
            (item) => `
              <div class="generate-card">
                <div class="generate-card-head">
                  <div class="generate-card-title">${generateEscapeHtml(item.label)}<span class="generate-card-sub">${generateEscapeHtml(item.node_type)}</span></div>
                  <label class="inline-toggle">
                    <input
                      type="checkbox"
                      data-generate-sampler-randomize="true"
                      data-node-id="${generateEscapeHtml(item.node_id)}"
                      ${item.seed_randomize ? "checked" : ""}
                    />
                    随机种子
                  </label>
                </div>
                <div class="generate-row sampler-row">
                  ${["seed", "steps", "cfg", "sampler_name", "scheduler", "denoise", "preview_method", "vae_decode"]
                    .map((field) => {
                      const value = item[field];
                      return `
                        <label>
                          <span>${field}</span>
                          <input
                            type="${field === "seed" || field === "steps" ? "number" : "text"}"
                            ${field === "cfg" || field === "denoise" ? 'step="0.05"' : ""}
                            data-generate-sampler="${generateEscapeHtml(field)}"
                            data-node-id="${generateEscapeHtml(item.node_id)}"
                            value="${generateEscapeHtml(generateEditableScalar(value))}"
                          />
                        </label>
                      `;
                    })
                    .join("")}
                </div>
              </div>
            `
          )
          .join("") || '<div class="muted">当前工作流未解析出 sampler 节点。</div>'}
      </div>
    </section>

    <section class="generate-section">
      <h3>Latent <span class="generate-section-count">${(source.editable.latents || []).length}</span></h3>
      <div class="generate-grid generate-grid-compact">
        ${(source.editable.latents || [])
          .map(
            (item) => `
              <div class="generate-card">
                <div class="generate-card-title">${generateEscapeHtml(item.label)}<span class="generate-card-sub">${generateEscapeHtml(item.node_type)}</span></div>
                <div class="generate-row">
                  ${["width", "height", "batch_size"]
                    .map(
                      (field) => `
                        <label>
                          <span>${field}</span>
                          <input
                            type="number"
                            data-generate-latent="${generateEscapeHtml(field)}"
                            data-node-id="${generateEscapeHtml(item.node_id)}"
                            value="${generateEscapeHtml(generateEditableScalar(item[field]))}"
                          />
                        </label>
                      `
                    )
                    .join("")}
                </div>
              </div>
            `
          )
          .join("") || '<div class="muted">当前工作流未解析出 latent 节点。</div>'}
      </div>
    </section>

    <section class="generate-section">
      <h3>ControlNet <span class="generate-section-count">${(source.editable.controlnets || []).length}</span></h3>
      <div class="generate-grid">
        ${(source.editable.controlnets || [])
          .map(
            (item) => `
              <div class="generate-card${item.bypassed ? " generate-card-muted" : ""}">
                <div class="generate-card-head">
                  <div class="generate-card-title">${generateEscapeHtml(item.label)}<span class="generate-card-sub">${generateEscapeHtml(item.node_type || "")}${item.bypassed ? " · 已 bypass" : ""}</span></div>
                  <label class="inline-toggle">
                    <input
                      type="checkbox"
                      data-generate-cn-enabled="true"
                      data-node-id="${generateEscapeHtml(item.node_id || "")}"
                      ${item.enabled ? "checked" : ""}
                      ${item.bypassed ? "disabled" : ""}
                    />
                    启用
                  </label>
                </div>
                <label class="generate-card-field">
                  <span>模型</span>
                  <input
                    type="text"
                    data-generate-cn-name="true"
                    data-node-id="${generateEscapeHtml(item.node_id || "")}"
                    data-loader-node-id="${generateEscapeHtml(item.loader_node_id || "")}"
                    value="${generateEscapeHtml(item.name || "")}"
                    ${item.bypassed ? "disabled" : ""}
                  />
                </label>
                <div class="generate-row">
                  <label>
                    <span>强度</span>
                    <input type="number" step="0.05" min="0" max="2"
                      data-generate-cn-strength="true"
                      data-node-id="${generateEscapeHtml(item.node_id || "")}"
                      value="${generateEscapeHtml(item.strength == null ? "" : item.strength)}"
                      ${item.bypassed ? "disabled" : ""} />
                  </label>
                  <label>
                    <span>Start %</span>
                    <input type="number" step="0.05" min="0" max="1"
                      data-generate-cn-start="true"
                      data-node-id="${generateEscapeHtml(item.node_id || "")}"
                      value="${generateEscapeHtml(item.start_percent == null ? "" : item.start_percent)}"
                      ${item.bypassed ? "disabled" : ""} />
                  </label>
                  <label>
                    <span>End %</span>
                    <input type="number" step="0.05" min="0" max="1"
                      data-generate-cn-end="true"
                      data-node-id="${generateEscapeHtml(item.node_id || "")}"
                      value="${generateEscapeHtml(item.end_percent == null ? "" : item.end_percent)}"
                      ${item.bypassed ? "disabled" : ""} />
                  </label>
                </div>
                ${(item.bindings || []).length
                  ? `
                    <div class="generate-card-meta">
                      ${(item.bindings || [])
                        .map(
                          (b) =>
                            `sampler ${generateEscapeHtml(b.sampler_id)} · ${generateEscapeHtml(b.polarity)} · steps ${b.steps ?? "-"} · 生效 ${b.effective_start_step ?? "-"}-${b.effective_end_step ?? "-"}`
                        )
                        .join("<br>")}
                    </div>`
                  : ""}
              </div>
            `
          )
          .join("") || '<div class="muted">当前工作流未解析出 ControlNet 节点。</div>'}
      </div>
    </section>

    <section class="generate-section">
      <h3>区域 / 蒙版 <span class="generate-section-count">${(source.editable.regions || []).length}</span></h3>
      <div class="generate-grid generate-grid-compact">
        ${(source.editable.regions || [])
          .map(
            (item) => `
              <div class="generate-card">
                <div class="generate-card-title">${generateEscapeHtml(item.label)}<span class="generate-card-sub">${generateEscapeHtml(item.node_type)} · sampler ${(item.sampler_ids || [item.sampler_id]).filter(Boolean).join("/") || "-"}</span></div>
                <div class="generate-card-meta">
                  ${Object.entries(item.params || {})
                    .map(([k, v]) => `<span class="generate-param-chip">${generateEscapeHtml(k)}: ${generateEscapeHtml(v)}</span>`)
                    .join("")}
                  ${item.mask_source
                    ? `<div class="generate-mask-chain">蒙版: ${generateEscapeHtml(item.mask_source)}${item.mask_slot != null ? ` [槽 ${item.mask_slot}]` : ""}${(item.mask_nodes || []).length ? ` → ${(item.mask_nodes || []).map((m) => `${m.node_id}:${m.node_type}${Object.entries(m.params || {}).map(([k, v]) => `(${k}=${v})`).join("")}`).join(" → ")}` : ""}</div>`
                    : ""}
                </div>
                ${(item.cond_texts || []).length
                  ? `<details class="generate-region-detail"><summary>区域 Prompt</summary><pre>${generateEscapeHtml((item.cond_texts || []).join("\n---\n"))}</pre></details>`
                  : ""}
              </div>
            `
          )
          .join("") || '<div class="muted">当前工作流未解析出区域节点。</div>'}
      </div>
    </section>
  `;

  // LoRA 名称选择统一使用 combo 候选组件(每次渲染后重建绑定)
  document.querySelectorAll(".generate-lora-combo").forEach((box) => {
    const input = box.querySelector("[data-generate-lora-name='true']");
    const menu = box.querySelector("[data-generate-lora-combo-menu='true']");
    const toggle = box.querySelector("[data-generate-lora-combo-toggle='true']");
    if (!input || !menu || !toggle) {
      return;
    }
    const comboFactory = window.aaLoraCombo || window.wfdbLoraCombo;
    // 存在性守卫(FE-01):工厂缺失(如旧缓存 common.js)时跳过绑定,
    // 避免 TypeError 中断整页 boot
    if (typeof comboFactory !== "function") {
      return;
    }
    comboFactory({
      input,
      menu,
      toggle,
      getOptions: () => generateState.source?.options?.loras || [],
      onSelect: (value) => {
        input.value = value;
      },
    });
  });
}

function collectGenerateEdits() {
  const edits = {
    filename_prefix: document.getElementById("generateFilenamePrefix").value.trim(),
    checkpoints: [],
    loras: [],
    prompts: [],
    samplers: [],
    latents: [],
    controlnets: [],
  };

  document.querySelectorAll("[data-generate-checkpoint='true']").forEach((input) => {
    edits.checkpoints.push({
      node_id: input.dataset.nodeId,
      field: input.dataset.field,
      value: input.value.trim(),
    });
  });

  const loraRows = new Map();
  document.querySelectorAll("[data-generate-lora-name='true']").forEach((input) => {
    const key = `${input.dataset.nodeId}::${input.dataset.slot || ""}`;
    loraRows.set(key, {
      node_id: input.dataset.nodeId,
      slot: input.dataset.slot ? Number(input.dataset.slot) : null,
      source: input.dataset.source || "",
      name: input.value.trim(),
    });
  });
  document.querySelectorAll("[data-generate-lora-enabled='true']").forEach((input) => {
    const key = `${input.dataset.nodeId}::${input.dataset.slot || ""}`;
    const row = loraRows.get(key) || { node_id: input.dataset.nodeId, slot: input.dataset.slot ? Number(input.dataset.slot) : null };
    row.enabled = input.checked;
    loraRows.set(key, row);
  });
  document.querySelectorAll("[data-generate-lora-model='true']").forEach((input) => {
    const key = `${input.dataset.nodeId}::${input.dataset.slot || ""}`;
    const row = loraRows.get(key) || { node_id: input.dataset.nodeId, slot: input.dataset.slot ? Number(input.dataset.slot) : null };
    row.strength_model = input.value === "" ? null : Number(input.value);
    loraRows.set(key, row);
  });
  document.querySelectorAll("[data-generate-lora-clip='true']").forEach((input) => {
    const key = `${input.dataset.nodeId}::${input.dataset.slot || ""}`;
    const row = loraRows.get(key) || { node_id: input.dataset.nodeId, slot: input.dataset.slot ? Number(input.dataset.slot) : null };
    row.strength_clip = input.value === "" ? null : Number(input.value);
    loraRows.set(key, row);
  });
  document.querySelectorAll("[data-generate-lora-weight='true']").forEach((input) => {
    const key = `${input.dataset.nodeId}::${input.dataset.slot || ""}`;
    const row = loraRows.get(key) || { node_id: input.dataset.nodeId, slot: input.dataset.slot ? Number(input.dataset.slot) : null };
    row.strength = input.value === "" ? null : Number(input.value);
    loraRows.set(key, row);
  });
  edits.loras = Array.from(loraRows.values());

  document.querySelectorAll("[data-generate-prompt='true']").forEach((textarea) => {
    edits.prompts.push({
      node_id: textarea.dataset.nodeId,
      field: textarea.dataset.field || "text",
      text: textarea.value,
    });
  });

  const samplerRows = new Map();
  document.querySelectorAll("[data-generate-sampler]").forEach((input) => {
    const nodeId = input.dataset.nodeId;
    const field = input.dataset.generateSampler;
    const row = samplerRows.get(nodeId) || { node_id: nodeId };
    row[field] =
      input.value === ""
        ? null
        : (field === "seed" || field === "steps" || field === "cfg" || field === "denoise"
            ? parseOptionalNumber(input.value)
            : input.value);
    samplerRows.set(nodeId, row);
  });
  document.querySelectorAll("[data-generate-sampler-randomize='true']").forEach((input) => {
    const nodeId = input.dataset.nodeId;
    const row = samplerRows.get(nodeId) || { node_id: nodeId };
    row.seed_randomize = input.checked;
    samplerRows.set(nodeId, row);
  });
  edits.samplers = Array.from(samplerRows.values());

  const latentRows = new Map();
  document.querySelectorAll("[data-generate-latent]").forEach((input) => {
    const nodeId = input.dataset.nodeId;
    const field = input.dataset.generateLatent;
    const row = latentRows.get(nodeId) || { node_id: nodeId };
    row[field] = parseOptionalNumber(input.value);
    latentRows.set(nodeId, row);
  });
  edits.latents = Array.from(latentRows.values());

  const cnRows = new Map();
  document.querySelectorAll("[data-generate-cn-name='true']").forEach((input) => {
    const nodeId = input.dataset.nodeId;
    const row = cnRows.get(nodeId) || {
      node_id: nodeId,
      loader_node_id: input.dataset.loaderNodeId || "",
    };
    row.name = input.value.trim();
    cnRows.set(nodeId, row);
  });
  document.querySelectorAll("[data-generate-cn-strength='true']").forEach((input) => {
    const row = cnRows.get(input.dataset.nodeId) || { node_id: input.dataset.nodeId, loader_node_id: "" };
    row.strength = input.value === "" ? null : Number(input.value);
    cnRows.set(input.dataset.nodeId, row);
  });
  document.querySelectorAll("[data-generate-cn-start='true']").forEach((input) => {
    const row = cnRows.get(input.dataset.nodeId) || { node_id: input.dataset.nodeId, loader_node_id: "" };
    row.start_percent = input.value === "" ? null : Number(input.value);
    cnRows.set(input.dataset.nodeId, row);
  });
  document.querySelectorAll("[data-generate-cn-end='true']").forEach((input) => {
    const row = cnRows.get(input.dataset.nodeId) || { node_id: input.dataset.nodeId, loader_node_id: "" };
    row.end_percent = input.value === "" ? null : Number(input.value);
    cnRows.set(input.dataset.nodeId, row);
  });
  document.querySelectorAll("[data-generate-cn-enabled='true']").forEach((input) => {
    if (input.disabled) {
      return;
    }
    const row = cnRows.get(input.dataset.nodeId) || { node_id: input.dataset.nodeId, loader_node_id: "" };
    row.enabled = input.checked;
    cnRows.set(input.dataset.nodeId, row);
  });
  edits.controlnets = Array.from(cnRows.values());

  return edits;
}

async function loadGenerateSource(sha256) {
  const value = (sha256 || document.getElementById("sourceShaInput").value || "").trim();
  if (!value) {
    showToast("请输入来源图片 SHA256", { type: "error" });
    return;
  }
  document.getElementById("sourceShaInput").value = value;
  const payload = await generateFetchJson(`/api/generate/source/${encodeURIComponent(value)}`);
  generateState.source = payload;
  renderGenerateEditor();
}

function renderQueuePanel(payload) {
  const container = document.getElementById("queuePanel");
  const summary = document.getElementById("queueSummary");
  const running = payload.running || [];
  const pending = payload.pending || [];
  renderQueueToggle(payload);
  summary.textContent = `运行中 ${running.length} · 排队中 ${pending.length}`;
  if (!running.length && !pending.length) {
    container.className = "stack-list empty";
    container.textContent = "当前队列为空";
    return;
  }
  container.className = "stack-list";
  container.innerHTML = `
    ${running
      .map(
        (item) => `
          <div class="stack-card generate-queue-card">
            <div class="stack-card-head">
              <span class="generate-queue-status generate-queue-status-running"><span class="status-dot"></span>运行中</span>
              <span class="muted generate-queue-id">${generateEscapeHtml(item.prompt_id || "-")}</span>
            </div>
            <div class="muted generate-queue-meta">nodes ${item.node_count} · ${generateEscapeHtml((item.node_types || []).join(", "))}</div>
          </div>
        `
      )
      .join("")}
    ${pending
      .map(
        (item) => `
          <div class="stack-card generate-queue-card">
            <div class="stack-card-head">
              <span class="generate-queue-status generate-queue-status-pending"><span class="status-dot"></span>排队中</span>
              <span class="muted generate-queue-id">${generateEscapeHtml(item.prompt_id || "-")}</span>
            </div>
            <div class="muted generate-queue-meta">nodes ${item.node_count} · ${generateEscapeHtml((item.node_types || []).join(", "))}</div>
          </div>
        `
      )
      .join("")}
  `;
}

function generateHistoryStatusText(item) {
  if (item.error || item.status === "error") return "失败";
  if (item.archived) return "已归档";
  return item.completed ? "已完成" : "处理中";
}

function generateHistoryStatusChip(item) {
  const cls = item.archived
    ? "status-chip--archived"
    : item.error || item.status === "error"
      ? "status-chip--error"
    : item.completed
      ? "status-chip-done"
      : "status-chip-pending";
  return `<span class="status-chip ${cls}">${generateEscapeHtml(generateHistoryStatusText(item))}</span>`;
}

function renderHistoryPanel(payload) {
  const container = document.getElementById("historyPanel");
  const items = (payload.items || []).slice(0, 5);
  generateState.historyItems = items;
  if (!items.length) {
    container.className = "stack-list empty";
    container.textContent = "暂无生成记录";
    return;
  }
  container.className = "stack-list";
  container.innerHTML = items
    .map((item, index) => {
      const images = preferredHistoryImages(item.images || []);
      const firstImage = images[0];
      const errorMessage = item.error && item.error.message
        ? `<div class="generate-history-file"><strong>错误</strong><span class="generate-history-value">${generateEscapeHtml(item.error.message)}</span></div>`
        : "";
      const thumbMarkup = firstImage
        ? `
            <button class="generate-history-thumb" type="button" data-history-open="${index}">
              <img src="${generateEscapeHtml(comfyViewUrl(firstImage))}" alt="${generateEscapeHtml(firstImage.filename || "result")}" loading="lazy" />
            </button>
          `
        : '<div class="generate-history-thumb empty"><span>暂无输出</span></div>';
      return `
        <article class="stack-card generate-history-card">
          <div class="stack-card-head">
            <strong>${generateEscapeHtml(item.prompt_id || "-")}</strong>
            ${generateHistoryStatusChip(item)}
          </div>
          <div class="generate-history-batch">
            ${thumbMarkup}
            <div class="generate-history-meta">
              <div><strong>图片数</strong><span class="generate-history-value">${images.length}</span></div>
              <div><strong>状态</strong><span class="generate-history-value">${generateHistoryStatusText(item)}</span></div>
              ${errorMessage}
              <div class="generate-history-file"><strong>输出</strong><span class="generate-history-value">${generateEscapeHtml((firstImage && firstImage.filename) || "-")}</span></div>
              <div class="generate-history-actions">
                <button class="action secondary" type="button" data-history-open="${index}" ${images.length ? "" : "disabled"}>查看详情</button>
              </div>
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderGeneratePreview() {
  const images = generateState.previewImages || [];
  const image = images[generateState.previewIndex];
  const title = document.getElementById("generatePreviewTitle");
  const meta = document.getElementById("generatePreviewMeta");
  const previewImg = document.getElementById("generatePreviewImg");
  const strip = document.getElementById("generatePreviewStrip");
  const prevBtn = document.getElementById("generatePreviewPrevBtn");
  const nextBtn = document.getElementById("generatePreviewNextBtn");

  if (!image) {
    title.textContent = "生成结果预览";
    meta.textContent = "暂无图片";
    previewImg.removeAttribute("src");
    strip.innerHTML = "";
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    return;
  }

  title.textContent = image.filename || "生成结果预览";
  meta.textContent = `${generateState.previewIndex + 1} / ${images.length}`;
  previewImg.src = comfyViewUrl(image);
  previewImg.alt = image.filename || "生成结果";
  prevBtn.disabled = images.length <= 1;
  nextBtn.disabled = images.length <= 1;
  strip.innerHTML = images
    .map(
      (item, index) => `
        <button class="preview-strip-item ${index === generateState.previewIndex ? "is-active" : ""}" type="button" data-generate-preview-index="${index}">
          <img src="${generateEscapeHtml(comfyViewUrl(item))}" alt="${generateEscapeHtml(item.filename || "result")}" loading="lazy" />
          <span>${generateEscapeHtml(item.filename || "-")}</span>
        </button>
      `
    )
    .join("");
}

function openGeneratePreview(images, index = 0) {
  generateState.previewImages = images || [];
  generateState.previewIndex = index;
  document.getElementById("generatePreviewModal").hidden = false;
  renderGeneratePreview();
}

function closeGeneratePreview() {
  document.getElementById("generatePreviewModal").hidden = true;
  generateState.previewImages = [];
  generateState.previewIndex = 0;
}

async function refreshQueueAndHistory() {
  const queuePayload = await generateFetchJson("/api/generate/queue");
  generateState.lastQueue = queuePayload;
  renderQueuePanel(queuePayload);
  const historyPayload = await generateFetchJson("/api/generate/history?limit=5");
  renderHistoryPanel(historyPayload);
}

async function submitGenerate() {
  if (!generateState.source) {
    return;
  }
  const payload = await generateFetchJson("/api/generate/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sha256: generateState.source.source_image.sha256,
      edits: collectGenerateEdits(),
    }),
  });
  generateState.activePromptId = payload.prompt_id || "";
  generateState.awaitingArchiveRounds = 0;
  showToast("已提交生成", { type: "success", duration: 2500 });
  document.getElementById("generateSourceMeta").textContent =
    `已提交 ${payload.prompt_id || "-"}`;
  setQueueOpen(true);
  await refreshQueueAndHistory();
}

function startGeneratePolling() {
  if (generateState.pollTimer) {
    clearInterval(generateState.pollTimer);
  }
  generateState.pollTimer = setInterval(() => {
    refreshQueueAndHistory().catch(() => {});
    const promptId = generateState.activePromptId;
    if (!promptId) {
      return;
    }
    generateFetchJson(`/api/generate/history/${encodeURIComponent(promptId)}`)
      .then((payload) => {
        const meta = document.getElementById("generateSourceMeta");
        const id = generateState.activePromptId;
        if (!id) {
          return;
        }
        // 已归档(后端 archived 标记):终态,结果已进入主列表,停止轮询
        if (payload.archived) {
          generateState.activePromptId = "";
          meta.textContent = `已提交 ${id} · 已归档,已进入主列表`;
          return;
        }
        if (
          payload.found &&
          payload.item &&
          (payload.item.error || payload.item.status === "error")
        ) {
          generateState.activePromptId = "";
          const detail = payload.item.error && payload.item.error.message
            ? `: ${payload.item.error.message}`
            : "";
          meta.textContent = `已提交 ${id} · 生成失败${detail}`;
          showToast(`生成失败${detail}`, { type: "error", duration: 6000 });
          return;
        }
        if (payload.found && payload.item && payload.item.completed) {
          // 已完成但归档尚未落定:继续等待,上限 12 轮(≈60s)
          // 防归档失败时无限轮询;超时后提示未知态
          generateState.awaitingArchiveRounds =
            (generateState.awaitingArchiveRounds || 0) + 1;
          if (generateState.awaitingArchiveRounds >= 12) {
            generateState.activePromptId = "";
            meta.textContent = `已提交 ${id} · 已完成(归档状态未知)`;
            return;
          }
          meta.textContent = `已提交 ${id} · 已完成,归档中…`;
          return;
        }
        // 未完成:按队列位置展示 排队中/运行中
        const inQueue = (list) =>
          Array.isArray(list) &&
          list.some((entry) => entry && entry.prompt_id === id);
        if (inQueue(generateState.lastQueue?.running)) {
          meta.textContent = `已提交 ${id} · 运行中`;
        } else if (inQueue(generateState.lastQueue?.pending)) {
          meta.textContent = `已提交 ${id} · 排队中`;
        }
      })
      .catch(() => {});
  }, 5000);
}

function bindGenerateEvents() {
  document.getElementById("loadSourceBtn").addEventListener("click", () => {
    loadGenerateSource("").catch((error) => {
      showError("载入来源", error, `载入失败: ${error.message}`);
    });
  });
  document.getElementById("submitGenerateInlineBtn").addEventListener("click", () => {
    submitGenerate().catch((error) => {
      showError("提交生成", error, `提交失败: ${error.message}`);
    });
  });
  document.getElementById("submitGenerateBtn").addEventListener("click", () => {
    submitGenerate().catch((error) => {
      showError("提交生成", error, `提交失败: ${error.message}`);
    });
  });
  document.getElementById("refreshQueueBtn").addEventListener("click", () => {
    refreshQueueAndHistory().catch((error) => {
      showError("刷新队列", error, `刷新队列失败: ${error.message}`);
    });
  });
  document.getElementById("refreshHistoryBtn").addEventListener("click", () => {
    refreshQueueAndHistory().catch((error) => {
      showError("刷新结果", error, `刷新结果失败: ${error.message}`);
    });
  });
  document.getElementById("queueToggleBtn").addEventListener("click", () => {
    setQueueOpen(!generateState.queueOpen);
  });
  // 摘要 popover 内的"查看完整队列":打开浮动队列面板并刷新
  document.getElementById("queueOpenFromSummary").addEventListener("click", () => {
    setQueueOpen(true);
    refreshQueueAndHistory().catch((error) => {
      showError("刷新队列", error, `刷新队列失败: ${error.message}`);
    });
  });
  document.getElementById("closeQueueBtn").addEventListener("click", () => {
    setQueueOpen(false);
  });
  document.getElementById("historyPanel").addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-history-open]");
    if (!trigger) {
      return;
    }
    const index = Number(trigger.dataset.historyOpen);
    const item = generateState.historyItems[index];
    const images = preferredHistoryImages(item && item.images);
    if (!item || !images.length) {
      return;
    }
    openGeneratePreview(images, 0);
  });
  document.getElementById("closeGeneratePreviewBtn").addEventListener("click", closeGeneratePreview);
  document.getElementById("generatePreviewPrevBtn").addEventListener("click", () => {
    const total = generateState.previewImages.length;
    if (!total) {
      return;
    }
    generateState.previewIndex = (generateState.previewIndex - 1 + total) % total;
    renderGeneratePreview();
  });
  document.getElementById("generatePreviewNextBtn").addEventListener("click", () => {
    const total = generateState.previewImages.length;
    if (!total) {
      return;
    }
    generateState.previewIndex = (generateState.previewIndex + 1) % total;
    renderGeneratePreview();
  });
  document.getElementById("generatePreviewOpenBtn").addEventListener("click", () => {
    const image = generateState.previewImages[generateState.previewIndex];
    if (!image) {
      return;
    }
    window.open(comfyViewUrl(image), "_blank", "noreferrer");
  });
  document.getElementById("generatePreviewStrip").addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-generate-preview-index]");
    if (!trigger) {
      return;
    }
    generateState.previewIndex = Number(trigger.dataset.generatePreviewIndex || 0);
    renderGeneratePreview();
  });
  document.querySelectorAll("[data-generate-preview-close='true']").forEach((node) => {
    node.addEventListener("click", closeGeneratePreview);
  });
  document.addEventListener("click", (event) => {
    if (!generateState.queueOpen) {
      return;
    }
    const panel = document.getElementById("queueFloatPanel");
    const button = document.getElementById("queueToggleBtn");
    if (panel.contains(event.target) || button.contains(event.target)) {
      return;
    }
    setQueueOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!document.getElementById("generatePreviewModal").hidden) {
        closeGeneratePreview();
        return;
      }
      if (generateState.queueOpen) {
        setQueueOpen(false);
      }
    }
  });
}

/**
 * 勾选「随机 seed」立即在 seed 输入框给出随机值(视觉反馈;
 * 提交时后端仍会重新生成随机 seed 覆盖)。
 */
function bindGenerateRandomizeFeedback() {
  document.getElementById("generateEditor").addEventListener("change", (event) => {
    const checkbox = event.target.closest("[data-generate-sampler-randomize='true']");
    if (!checkbox || !checkbox.checked) {
      return;
    }
    const nodeId = checkbox.dataset.nodeId;
    const seedInput = document.querySelector(
      `[data-generate-sampler='seed'][data-node-id='${CSS.escape(nodeId)}']`
    );
    if (seedInput) {
      seedInput.value = String(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
    }
  });
}

async function initGeneratePage() {
  bindGenerateEvents();
  bindGenerateRandomizeFeedback();
  startGeneratePolling();
  await refreshQueueAndHistory();
  const params = new URLSearchParams(window.location.search);
  const sha256 = params.get("sha256");
  if (sha256) {
    document.getElementById("sourceShaInput").value = sha256;
    await loadGenerateSource(sha256);
  }
}

initGeneratePage().catch((error) => {
  document.getElementById("generateEditor").textContent = `初始化失败: ${error.message}`;
  showError("初始化生成页", error);
});
