const generateState = {
  source: null,
  activePromptId: "",
  pollTimer: null,
  queueOpen: false,
  previewImages: [],
  previewIndex: 0,
  historyItems: [],
  editorMode: "replay",
  embedOpenedForSha: "",
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

// build_replay_source 实测远端模型清单后标记 exists_on_remote;
// false = 文件不在远端 ComfyUI 模型列表中(仅记录快照值),填表时提示。
function generateRemoteMissingBadge() {
  return '<span class="generate-remote-missing" title="该文件不在远端 ComfyUI 模型列表中">远端缺失</span>';
}

// 卡片副标题:节点名已按原始类型名展示(worker 侧不再用工作流里的本地化
// title),副标题里与主标题相同、或彼此重复的片段一律略去,避免同一名字
// 显示多遍。LoRA 的 label 是「节点名 #槽位」,比对时剥掉槽位后缀。
function generateCardSub(parts, label) {
  const main = String(label == null ? "" : label);
  const seen = new Set([main, main.replace(/\s*#\d+$/, "")]);
  const kept = [];
  for (const raw of parts || []) {
    const part = String(raw == null ? "" : raw);
    if (!part || seen.has(part)) {
      continue;
    }
    seen.add(part);
    kept.push(part);
  }
  const text = kept.join(" · ");
  return text ? `<span class="generate-card-sub">${generateEscapeHtml(text)}</span>` : "";
}

// ============ 模型候选三态着色(存在 / 缺失 / 未知) ============
// 基准:worker 回传的 options.remote_present(远端 ComfyUI 实际存在的模型名),
// 可能是 null = 不可判定。null 必须映射为 unknown 而非 missing —— 远端离线或
// 未安装该类型模型时若判成缺失,整列候选会被误涂成缺失。
//
// 网关兜底也依赖这个基准:worker 返回空 options 时网关用归档库填充
// (generate.controller.getSource),那条路径上网关没有远端清单,只能由前端
// 用基准自行判定,故基准必须随 payload 回传而不是只回传逐项布尔。

/** 模型引用归一:与 worker 的 _normalize_model_ref 同口径(剥空白 + 反斜杠转正斜杠)。 */
function normalizeModelRef(value) {
  return String(value == null ? "" : value)
    .trim()
    .replace(/\\/g, "/");
}

/** 基准清单 → Set;null/非数组 → null(未知)。 */
function buildRemotePresentSet(presentList) {
  if (!Array.isArray(presentList)) return null;
  return new Set(presentList.map(normalizeModelRef));
}

/** 单个候选的三态:'present' | 'missing' | 'unknown'。 */
function modelOptionState(name, presentSet) {
  if (!presentSet) return "unknown";
  return presentSet.has(normalizeModelRef(name)) ? "present" : "missing";
}

/** 候选名列表 → 供 combo 工厂消费的 {value,label,state} 行。 */
function buildModelOptions(names, presentList) {
  const presentSet = buildRemotePresentSet(presentList);
  return (names || []).map((name) => ({
    value: name,
    label: name,
    state: modelOptionState(name, presentSet),
  }));
}

/**
 * Checkpoint 卡片的候选与基准,**成对取用**:
 * worker 已按卡的节点类型给出各自文件夹的清单(item.candidates + 同文件夹的
 * candidates_baseline);该字段缺省(远端与 object_info 都拿不到,或该文件夹为空)
 * 时,清单与基准一起回退整表并集 options.checkpoints / remote_present.checkpoints
 * ——网关用归档库兜底填充的正是并集。不混用两者,避免拿 A 卡的基准给 B 卡着色。
 */
function buildCheckpointCardOptions(item, source) {
  const options = (source && source.options) || {};
  if (item && Array.isArray(item.candidates) && item.candidates.length) {
    return buildModelOptions(item.candidates, item.candidates_baseline);
  }
  return buildModelOptions(options.checkpoints, options.remote_present?.checkpoints);
}

/** 按 node_id(+field) 找到当前卡片对应的 editable 行。 */
function findEditableRow(group, input) {
  const rows = (generateState.source && generateState.source.editable?.[group]) || [];
  const nodeId = input.dataset.nodeId || "";
  const field = input.dataset.field || "";
  return (
    rows.find((row) => String(row.node_id || "") === nodeId && String(row.field || "") === field) || null
  );
}

/** 可编辑标量:连线派生的对象值(width 来自 Get Image Size 等)不可直接编辑,置空。 */
function generateEditableScalar(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "object") return "";
  return value;
}

/**
 * 来源身份两段:绝对路径为主,哈希另起一段弱化显示(括号在渲染层加)。
 * 路径按 resolved_path → source_path → filename 回退(远端/未解析来源)。
 */
function sourceIdentityParts(image) {
  const row = image || {};
  const pick = (value) => String(value == null ? "" : value).trim();
  return {
    path: pick(row.resolved_path) || pick(row.source_path) || pick(row.filename),
    hash: pick(row.sha256),
  };
}

/** 来源身份:绝对路径为主,哈希以低字重弱色括号补后;两者都缺时返回空串。 */
function sourceIdentityHtml(image) {
  const { path, hash } = sourceIdentityParts(image);
  if (!path && !hash) {
    return "";
  }
  const hashHtml = hash ? `<span class="source-identity-hash">(${generateEscapeHtml(hash)})</span>` : "";
  return `<span class="source-identity-path">${generateEscapeHtml(path)}</span>${hashHtml}`;
}

/** 顶栏只读身份块:第一行绝对路径,第二行浅色小字 sha(不带括号)。 */
function sourceIdentityBlockHtml(image) {
  const { path, hash } = sourceIdentityParts(image);
  if (!path && !hash) {
    return "";
  }
  const hashHtml = hash
    ? `<span class="source-identity-hash">${generateEscapeHtml(hash)}</span>`
    : "";
  return `<span class="source-identity-path">${generateEscapeHtml(path)}</span>${hashHtml}`;
}

/**
 * 顶栏来源身份是**只读展示**:来源只能从图库带入(带 ?sha256= 打开或
 * 由图库跳转),没有输入框与载入按钮。未载入时显示弱提示。
 */
function syncSourceIdentityField(source) {
  const box = document.getElementById("sourceIdentity");
  if (!box) {
    return;
  }
  const image = (source && source.source_image) || null;
  const html = image ? sourceIdentityBlockHtml(image) : "";
  if (!html) {
    box.classList.add("is-empty");
    box.innerHTML = "从图库选择图片后自动带入";
    box.title = "";
    return;
  }
  const { path, hash } = sourceIdentityParts(image);
  box.classList.remove("is-empty");
  box.innerHTML = html;
  box.title = [path, hash].filter(Boolean).join("\n");
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
      // Nest 异常体的文案在 message(FastAPI 风格才是 detail);error 只是
      // 短语("Not Found"),先取它会把"缺内嵌工作流"显示成误导性的 404 短语
      detail = payload.detail || payload.message || payload.error || JSON.stringify(payload);
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

// ---------------------------------------------------------------------------
// 编辑器模式开关(重放编辑器 ⇄ 内嵌 ComfyUI)
//
// 持久化走 uiPref(localStorage、即时生效,与设置页 .env 双轨无关)。
// 内嵌画布 iframe 与 #generateEditor 是兄弟节点、常驻 DOM:模式切换只切
// 可见性,绝不移动 iframe(DOM 移动会触发整页重载);懒创建——首次切入
// 内嵌模式才设置 src(ComfyUI 前端是重资源)。
// ---------------------------------------------------------------------------

function currentEditorMode() {
  return generateState.editorMode === "embedded" ? "embedded" : "replay";
}

/** 来源是否可内嵌。判据来自 /api/generate/source 的 replay.embedded_supported
 * (嵌入方案 §3.1:前端不做元数据嗅探);旧 worker 无该字段时回退为
 * "UI 节点图存在"——仅 API 格式/A1111/NovelAI/无元数据均不可进画布。 */
function isSourceEmbeddable(source) {
  if (!source) {
    return false;
  }
  if (source.replay && typeof source.replay.embedded_supported === "boolean") {
    return source.replay.embedded_supported;
  }
  const nodes =
    source.workflow && source.workflow.raw_workflow
      ? source.workflow.raw_workflow.nodes
      : null;
  return Array.isArray(nodes) && nodes.length > 0;
}

/** 来源门禁:内嵌开关只对有 ComfyUI 节点图的来源开放;A1111 / NovelAI /
 * 无元数据 / 仅 API 格式一律置灰并说明。未载入来源时开放——内嵌 ComfyUI
 * 可作独立编辑器用(此时画布内容与库内图片无关联,无串图风险)。 */
function syncEmbedGate() {
  const embedBtn = document.getElementById("editorModeEmbedBtn");
  const blocked = Boolean(generateState.source) && !isSourceEmbeddable(generateState.source);
  embedBtn.disabled = blocked;
  embedBtn.title = blocked
    ? "该来源没有可进画布的 ComfyUI 节点图(A1111 / NovelAI / 无元数据),内嵌模式不可用"
    : "";
}

/** 清掉 ComfyUI 前端存在本页 origin 下的画布草稿。
 *
 * `/comfy/` 与生成页同源(经同源反向代理),草稿键
 * `Comfy.Workflow.Draft*` 与 `Comfy.Workflow.Last*` 就在本页 localStorage 里
 * ——不必等 iframe 文档就绪即可清理。ComfyUI 启动时会**自动恢复最后一份草稿**,
 * 画布即将被归档工作流接管时必须先清,否则旧工作流会把新灌入的挤掉(实测事故:
 * 直接以 ?sha256= 打开生成页时画布仍显示上一张图的工作流)。
 * 尽力而为:键名随上游版本可能变化,清不掉时退化为"画布显示旧草稿"。
 */
function clearComfyDrafts() {
  try {
    const store = window.localStorage;
    const doomed = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (
        key &&
        (key.indexOf("Comfy.Workflow.Draft") === 0 ||
          key.indexOf("Comfy.Workflow.Last") === 0)
      ) {
        doomed.push(key);
      }
    }
    doomed.forEach((key) => store.removeItem(key));
    return doomed.length;
  } catch (error) {
    /* 私有模式等 localStorage 不可用:忽略 */
    return 0;
  }
}

/** 清空内嵌画布:换 URL 强制重载 iframe,防止上一来源的工作流残留被误
 * Queue。注意只重载不够——ComfyUI 前端会从本地草稿自动恢复上次画布
 * (实测复现),重载前先清草稿;就绪等待缓存一并作废。 */
function resetEmbeddedCanvas() {
  const frame = document.getElementById("comfyEmbedFrame");
  if (!frame.getAttribute("src")) {
    return;
  }
  clearComfyDrafts();
  comfyEmbedReadyCache = null;
  // 代际令牌:重载进行中旧文档的 app 仍短暂存活,等待方据此放弃旧代际,
  // 防止把工作流注入到即将销毁的旧文档、或旧文档恢复后误判就绪
  frame.dataset.embedGeneration = String(Date.now());
  frame.setAttribute("src", `/comfy/?reload=${frame.dataset.embedGeneration}`);
}

function syncSubmitButtons() {
  const embedded = currentEditorMode() === "embedded";
  // 内嵌模式禁用「开始生成」:提交路径 collectGenerateEdits 读的是重放
  // 编辑器的 [data-generate-*] 输入框,内嵌下会提交空 edits
  const disable = embedded || !generateState.source;
  const hint = embedded ? "内嵌模式下请在 ComfyUI 画布中点击 Queue 提交" : "";
  const submitButton = document.getElementById("submitGenerateBtn");
  const inlineSubmitButton = document.getElementById("submitGenerateInlineBtn");
  submitButton.disabled = disable;
  inlineSubmitButton.disabled = disable;
  submitButton.title = hint;
  inlineSubmitButton.title = hint;
  // 预检只读当前表单值,不提交;有来源即可用(内嵌模式下同样可查)
  const preflightButton = document.getElementById("preflightBtn");
  if (preflightButton) {
    preflightButton.disabled = !generateState.source;
  }
}

function syncEditorModeDom() {
  const embedded = currentEditorMode() === "embedded";
  const editor = document.getElementById("generateEditor");
  const frame = document.getElementById("comfyEmbedFrame");
  editor.hidden = embedded;
  frame.hidden = !embedded;
  if (embedded && !frame.getAttribute("src")) {
    // 代际令牌:就绪等待以它为准(重载时由 resetEmbeddedCanvas 换新值)
    frame.dataset.embedGeneration = String(Date.now());
    frame.setAttribute("src", "/comfy/");
  }
  // 生成历史列在内嵌模式下让位:历史/队列用 ComfyUI 自带的侧边栏,
  // 布局收为单列让内嵌画布占满整行;重放模式恢复我们的历史列
  const layout = document.querySelector(".generate-layout");
  const historyPanel = document.querySelector(".generate-history-panel");
  if (layout) {
    layout.classList.toggle("mode-embedded", embedded);
  }
  if (historyPanel) {
    historyPanel.hidden = embedded;
  }
  const replayBtn = document.getElementById("editorModeReplayBtn");
  const embedBtn = document.getElementById("editorModeEmbedBtn");
  replayBtn.classList.toggle("is-active", !embedded);
  replayBtn.setAttribute("aria-pressed", String(!embedded));
  embedBtn.classList.toggle("is-active", embedded);
  embedBtn.setAttribute("aria-pressed", String(embedded));
  syncSubmitButtons();
  if (embedded) {
    openSourceInEmbeddedComfy();
  }
}

function setEditorMode(mode) {
  const next = mode === "embedded" ? "embedded" : "replay";
  if (generateState.editorMode === next) {
    return;
  }
  generateState.editorMode = next;
  window.setUiPref("generateEditorMode", next);
  syncEditorModeDom();
}

// ---------------------------------------------------------------------------
// 归档工作流灌入内嵌画布
//
// 数据已就绪:source.workflow.raw_workflow 即 UI 格式工作流(载入来源时
// build_replay_source 已带回),无需新后端。流程:
//   1) POST /api/image/:sha/open-comfyui 把 UI workflow 推进 ComfyUI
//      userdata(Workflows 侧边栏可见,幂等覆盖;失败不阻断自动打开)
//   2) 等 iframe 里的 window.app 就绪后 loadGraphData 自动打开
// 防御式:window.app / loadGraphData 是上游前端 1.51.10 的内部 API,升级
// 改名时降级为提示用户从侧边栏打开,不抛错中断(嵌入方案 §5 风险 4)。
// ---------------------------------------------------------------------------

let comfyEmbedReadyCache = null; // { generation, promise }

function embeddedComfyApp() {
  const frame = document.getElementById("comfyEmbedFrame");
  try {
    return (frame.contentWindow && frame.contentWindow.app) || null;
  } catch (error) {
    return null;
  }
}

function waitForComfyEmbedReady(generation) {
  if (comfyEmbedReadyCache && comfyEmbedReadyCache.generation === generation) {
    return comfyEmbedReadyCache.promise;
  }
  const frame = document.getElementById("comfyEmbedFrame");
  const startedAt = Date.now();
  const promise = new Promise((resolve) => {
    const timer = setInterval(() => {
      // 等待期间画布又被重置(代际变化):立即放弃,由最新代际重新等待
      if ((frame.dataset.embedGeneration || "") !== generation) {
        clearInterval(timer);
        resolve(false);
        return;
      }
      const app = embeddedComfyApp();
      if (app && typeof app.loadGraphData === "function") {
        clearInterval(timer);
        resolve(true);
        return;
      }
      // 上限 30s:ComfyUI 前端重资源冷加载;超时按不可用降级
      if (Date.now() - startedAt > 30000) {
        clearInterval(timer);
        resolve(false);
      }
    }, 300);
  });
  comfyEmbedReadyCache = { generation, promise };
  return promise;
}

async function openSourceInEmbeddedComfy() {
  const source = generateState.source;
  if (!source || currentEditorMode() !== "embedded") {
    return;
  }
  // 门禁兜底:正常路径由 syncEmbedGate 挡住,这里防绕行后把不可内嵌
  // 来源的残留状态灌进画布
  if (!isSourceEmbeddable(source)) {
    return;
  }
  // 同一张图只自动灌一次:重复灌入会覆盖用户在内嵌画布里的编辑
  const sha = source.source_image.sha256;
  if (generateState.embedOpenedForSha === sha) {
    return;
  }
  const uiWorkflow = source.workflow && source.workflow.raw_workflow;
  if (!uiWorkflow || !Array.isArray(uiWorkflow.nodes) || !uiWorkflow.nodes.length) {
    showToast("该图未内嵌可打开的 UI workflow,无法自动灌入画布", { type: "error", duration: 5000 });
    return;
  }
  generateState.embedOpenedForSha = sha;
  // 推 userdata(侧边栏可见;幂等覆盖),不等待结果、失败不影响下一步
  generateFetchJson(
    `/api/image/${encodeURIComponent(sha)}/open-comfyui`,
    { method: "POST" }
  ).catch(() => {});
  const frame = document.getElementById("comfyEmbedFrame");
  const ready = await waitForComfyEmbedReady(frame.dataset.embedGeneration || "");
  const app = embeddedComfyApp();
  if (!ready || !app || typeof app.loadGraphData !== "function") {
    showToast("内嵌 ComfyUI 未能自动打开工作流,请从 Workflows 侧边栏手动打开", { type: "error", duration: 6000 });
    return;
  }
  try {
    app.loadGraphData(uiWorkflow, true, true);
    showToast("已将归档工作流载入内嵌画布", { type: "success", duration: 2500 });
  } catch (error) {
    showToast(`自动载入失败(${error.message});请从 Workflows 侧边栏打开`, { type: "error", duration: 6000 });
  }
}

function renderGenerateEditor() {
  const container = document.getElementById("generateEditor");
  const meta = document.getElementById("generateSourceMeta");
  const source = generateState.source;
  const submitButton = document.getElementById("submitGenerateBtn");
  const inlineSubmitButton = document.getElementById("submitGenerateInlineBtn");
  syncEmbedGate();
  if (!source) {
    meta.textContent = "未载入来源";
    container.className = "generate-editor empty";
    container.textContent = "请选择一张带工作流的图片";
    const preflightBox = document.getElementById("preflightResult");
    if (preflightBox) {
      preflightBox.hidden = true;
    }
    submitButton.disabled = true;
    inlineSubmitButton.disabled = true;
    return;
  }

  syncSubmitButtons();
  const replayMode = source.replay && source.replay.mode === "exact_api_prompt"
    ? "原始 API prompt"
    : "由 UI workflow 重建";
  const replayWarnings = ((source.replay && source.replay.warnings) || [])
    .map((warning) => `<div class="generate-replay-warning">${generateEscapeHtml(warning)}</div>`)
    .join("");
  meta.textContent =
    `${source.source_image.filename} · ${formatGenerateCapturedAt(source.source_image.captured_at, source.source_image.created_date, source.source_image.created_hour)} · batch ${source.batch.count}`;

  container.className = "generate-editor";
  container.innerHTML = `
    <section class="generate-section">
      <h3>来源</h3>
      <div class="generate-source-card">
        <img src="${apiUrl(`/api/thumb/${generateEscapeHtml(source.source_image.sha256)}?w=360&h=360`)}" alt="${generateEscapeHtml(source.source_image.filename)}" />
        <div class="generate-source-meta">
          <div class="generate-source-identity" title="${generateEscapeHtml(sourceIdentityParts(source.source_image).path)}&#10;${generateEscapeHtml(source.source_image.sha256 || "")}">${sourceIdentityHtml(source.source_image)}</div>
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
      <h3>输入图 <span class="generate-section-count">${(source.editable.image_loaders || []).length}</span></h3>
      <div class="generate-grid">
        ${(source.editable.image_loaders || [])
          .map(
            (item) => {
              const title = item.label || item.node_type || "LoadImage";
              return `
              <div class="generate-card generate-image-ref">
                <div class="generate-card-title">${generateEscapeHtml(title)}${generateCardSub([item.node_type, item.field || "image"], title)}</div>
                <label class="generate-card-field">
                  <span>引用</span>
                  <input
                    type="text"
                    autocomplete="off"
                    data-generate-image-ref="true"
                    data-node-id="${generateEscapeHtml(item.node_id || "")}"
                    data-field="${generateEscapeHtml(item.field || "image")}"
                    value="${generateEscapeHtml(item.value || "")}"
                  />
                </label>
                <div class="generate-image-picker">
                  <div class="generate-row">
                    <label>
                      <span>从图库换图</span>
                      <input type="text" data-generate-image-query="true" placeholder="文件名 / 关键词" />
                    </label>
                    <button type="button" class="ghost-btn" data-generate-image-search="true">搜索</button>
                  </div>
                  <div class="generate-image-results" data-generate-image-results="true"></div>
                </div>
              </div>
            `;
            }
          )
          .join("") || '<div class="muted">当前工作流未引用输入图。</div>'}
      </div>
    </section>

    <section class="generate-section">
      <h3>Checkpoint <span class="generate-section-count">${(source.editable.checkpoints || []).length}</span></h3>
      <div class="generate-grid">
        ${(source.editable.checkpoints || [])
          .map(
            (item) => `
              <div class="generate-card">
                <span class="generate-card-title">${generateEscapeHtml(item.label)}${generateCardSub([item.field], item.label)}${item.exists_on_remote === false ? generateRemoteMissingBadge() : ""}</span>
                <div class="combo-box generate-checkpoint-combo">
                  <input
                    type="text"
                    autocomplete="off"
                    data-generate-checkpoint="true"
                    data-node-id="${generateEscapeHtml(item.node_id)}"
                    data-field="${generateEscapeHtml(item.field)}"
                    value="${generateEscapeHtml(item.value || "")}"
                  />
                  <button type="button" class="combo-toggle" data-generate-checkpoint-combo-toggle="true" aria-label="选择 Checkpoint">▼</button>
                  <div class="combo-menu" data-generate-checkpoint-combo-menu="true" hidden></div>
                </div>
              </div>
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
                  <span class="generate-card-title">${generateEscapeHtml(item.label)}${generateCardSub([item.source, item.node_type], item.label)}${item.exists_on_remote === false ? generateRemoteMissingBadge() : ""}</span>
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
                <span class="generate-card-title">${generateEscapeHtml(item.branch_label || item.label)}${generateCardSub([item.node_id, item.polarity], item.branch_label || item.label)}</span>
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
                  <div class="generate-card-title">${generateEscapeHtml(item.label)}${generateCardSub([item.node_type], item.label)}</div>
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
                            value="${generateEscapeHtml(formatMetric(generateEditableScalar(value)))}"
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
                <div class="generate-card-title">${generateEscapeHtml(item.label)}${generateCardSub([item.node_type], item.label)}</div>
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
                  <div class="generate-card-title">${generateEscapeHtml(item.label)}${generateCardSub([item.node_type, item.bypassed ? "已 bypass" : ""], item.label)}${item.exists_on_remote === false ? generateRemoteMissingBadge() : ""}</div>
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
                <div class="generate-card-title">${generateEscapeHtml(item.label)}${generateCardSub([item.node_type, `sampler ${(item.sampler_ids || [item.sampler_id]).filter(Boolean).join("/") || "-"}`], item.label)}</div>
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

  // 模型候选下拉统一使用 combo 候选组件(每次渲染后重建绑定)。
  // 候选带三态标记:基准取 worker 回传的远端存在清单(null = 未知,不着色为缺失)。
  // 网关用归档库兜底填充 options 时基准同样可用 —— 这正是回传基准而非
  // 逐项布尔的原因(见文件头「模型候选三态着色」段)。
  // Checkpoint 原先用原生 <datalist>:其候选弹层由浏览器绘制、无法着色,
  // 故与 LoRA 同用 combo(输入仍可自由填写,datalist 的输入语义未丢)。
  const comboFactory = window.aaLoraCombo || window.wfdbLoraCombo;
  // 存在性守卫(FE-01):工厂缺失(如旧缓存 common.js)时跳过绑定,
  // 避免 TypeError 中断整页 boot
  if (typeof comboFactory !== "function") {
    return;
  }
  [
    {
      root: ".generate-lora-combo",
      input: "[data-generate-lora-name='true']",
      menu: "[data-generate-lora-combo-menu='true']",
      toggle: "[data-generate-lora-combo-toggle='true']",
      noun: "LoRA",
      getOptions: () =>
        buildModelOptions(
          generateState.source?.options?.loras,
          generateState.source?.options?.remote_present?.loras,
        ),
    },
    {
      root: ".generate-checkpoint-combo",
      input: "[data-generate-checkpoint='true']",
      menu: "[data-generate-checkpoint-combo-menu='true']",
      toggle: "[data-generate-checkpoint-combo-toggle='true']",
      noun: "Checkpoint",
      // 候选按卡的节点类型取各自文件夹(worker 已按文件夹给好清单与基准);
      // 字段缺省时清单与基准成对回退整表并集
      getOptions: (input) =>
        buildCheckpointCardOptions(findEditableRow("checkpoints", input), generateState.source),
    },
  ].forEach((spec) => {
    document.querySelectorAll(spec.root).forEach((box) => {
      const input = box.querySelector(spec.input);
      const menu = box.querySelector(spec.menu);
      const toggle = box.querySelector(spec.toggle);
      if (!input || !menu || !toggle) {
        return;
      }
      comboFactory({
        input,
        menu,
        toggle,
        noun: spec.noun,
        getOptions: () => spec.getOptions(input),
        onSelect: (value) => {
          input.value = value;
        },
      });
    });
  });
}

/** 预检判定:值 + 基准清单 → present | missing | unknown | empty。 */
function modelValueState(value, baselineList) {
  const text = String(value == null ? "" : value).trim();
  if (!text) {
    return "empty";
  }
  return modelOptionState(text, buildRemotePresentSet(baselineList));
}

/**
 * 生成前预检(零副作用:不提交、不写任何状态)。
 *
 * 只核"远端模型是否齐备"这一层:值与基准都取自 worker 快照
 * (editable[].candidates_baseline / options.remote_present),判定与候选下拉
 * 的三态着色同源,所以结论一致;节点定义、图结构、输入图落地等更深校验
 * 仍由提交时的服务端执行(面板里写明)。
 */
function runGeneratePreflight() {
  const box = document.getElementById("preflightResult");
  const source = generateState.source;
  if (!box || !source) {
    return;
  }
  const options = source.options || {};
  const remote = options.remote_present || {};
  const edits = collectGenerateEdits();
  const items = [];

  const checkpointRows = (source.editable && source.editable.checkpoints) || [];
  edits.checkpoints.forEach((row) => {
    const owner = checkpointRows.find(
      (r) => String(r.node_id) === String(row.node_id) && String(r.field || "") === String(row.field || ""),
    );
    const baseline =
      owner && Array.isArray(owner.candidates_baseline) ? owner.candidates_baseline : remote.checkpoints;
    items.push({
      group: "Checkpoint",
      label: `${row.node_id} · ${row.field || "ckpt_name"}`,
      value: row.value,
      state: modelValueState(row.value, baseline),
    });
  });

  const loraRows = edits.loras || [];
  loraRows
    .filter((row) => row.enabled !== false)
    .forEach((row) => {
      items.push({
        group: "LoRA",
        label: `${row.node_id}${row.slot != null ? ` #${row.slot}` : ""}`,
        value: row.name,
        state: modelValueState(row.name, remote.loras),
      });
    });
  const disabledLoras = loraRows.filter((row) => row.enabled === false).length;

  const missing = items.filter((item) => item.state === "missing");
  const unknown = items.filter((item) => item.state === "unknown");
  const blank = items.filter((item) => item.state === "empty");

  const rowsHtml = items
    .map((item) => {
      const cls =
        item.state === "missing"
          ? "is-missing"
          : item.state === "unknown"
            ? "is-unknown"
            : item.state === "empty"
              ? "is-empty"
              : "";
      const flag =
        item.state === "missing"
          ? "远端缺失"
          : item.state === "unknown"
            ? "无法判定"
            : item.state === "empty"
              ? "未填写"
              : "存在";
      return `<div class="preflight-row ${cls}"><span class="preflight-group">${generateEscapeHtml(item.group)}</span><span class="preflight-label">${generateEscapeHtml(item.label)}</span><span class="preflight-value" title="${generateEscapeHtml(item.value || "")}">${generateEscapeHtml(item.value || "-")}</span><span class="preflight-flag">${flag}</span></div>`;
    })
    .join("");

  const summary = `检查 ${items.length} 项 · 远端缺失 ${missing.length} · 无法判定 ${unknown.length}${blank.length ? ` · 未填写 ${blank.length}` : ""}${disabledLoras ? ` · 跳过已禁用 LoRA ${disabledLoras}` : ""}`;
  const verdict =
    missing.length || blank.length
      ? '<div class="preflight-verdict is-bad">有缺失或未填项:按当前值提交大概率会被 ComfyUI 拒绝</div>'
      : unknown.length
        ? '<div class="preflight-verdict is-warn">未发现缺失;部分项远端未列出、无法判定,以提交时服务端校验为准</div>'
        : '<div class="preflight-verdict is-ok">未发现缺失项(节点定义/图结构等更深校验仍在提交时执行)</div>';
  box.hidden = false;
  box.innerHTML =
    `<div class="preflight-head"><span>预检结果</span><span class="preflight-summary">${summary}</span>` +
    '<button type="button" class="ghost-btn" data-preflight-close="true">收起</button></div>' +
    verdict +
    rowsHtml;
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
    image_loaders: [],
  };

  const imageRows = [];
  document.querySelectorAll("[data-generate-image-ref='true']").forEach((input) => {
    imageRows.push({
      node_id: input.dataset.nodeId,
      field: input.dataset.field || "image",
      value: input.value.trim(),
    });
  });
  edits.image_loaders = imageRows;

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
  const value = String(sha256 || "").trim();
  if (!value) {
    showToast("来源只能带 sha256 打开生成页(图库「去生成」会自动带入)", { type: "error" });
    return;
  }
  try {
    const payload = await generateFetchJson(`/api/generate/source/${encodeURIComponent(value)}`);
    generateState.source = payload;
    syncSourceIdentityField(payload);
    // 新来源允许重新自动灌入内嵌画布(同一张图仍只灌一次)
    generateState.embedOpenedForSha = "";
    renderGenerateEditor();
    if (currentEditorMode() === "embedded") {
      if (isSourceEmbeddable(payload)) {
        openSourceInEmbeddedComfy();
      } else {
        // 门禁:不可内嵌来源(A1111/NovelAI/无元数据/仅 API 格式)不动画布,
        // 顺带清空画布(连同 ComfyUI 本地草稿,防稍后独立使用时复活旧图),
        // 自动退回重放编辑器。不持久化:用户的模式偏好不因单张不兼容图被改写
        resetEmbeddedCanvas();
        generateState.editorMode = "replay";
        syncEditorModeDom();
        showToast("该来源没有 ComfyUI 节点图,已退回重放编辑器", { type: "error", duration: 5000 });
      }
    }
  } catch (error) {
    // 载入失败必须清掉上一来源的状态:source 残留会让门禁放行、内嵌画布
    // 继承旧图(跨图污染,验收反馈 ①)
    const wasEmbedded = currentEditorMode() === "embedded";
    generateState.source = null;
    generateState.embedOpenedForSha = "";
    syncSourceIdentityField(null);
    renderGenerateEditor();
    if (wasEmbedded) {
      resetEmbeddedCanvas();
      showToast("来源载入失败,内嵌画布已清空(原内容属于上一来源)", { type: "error", duration: 5000 });
    }
    throw error;
  }
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
  document.getElementById("preflightBtn").addEventListener("click", () => {
    runGeneratePreflight();
  });
  document.getElementById("preflightResult").addEventListener("click", (event) => {
    if (event.target.closest("[data-preflight-close]")) {
      document.getElementById("preflightResult").hidden = true;
    }
  });
  document.getElementById("editorModeReplayBtn").addEventListener("click", () => {
    setEditorMode("replay");
  });
  document.getElementById("editorModeEmbedBtn").addEventListener("click", () => {
    setEditorMode("embedded");
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

/**
 * 输入图换图:从图库搜索一张图,把结果文件名写进引用输入框。
 *
 * 提交时后端据此在库内定位该图(内容哈希/文件名同一套匹配)并回填到
 * ComfyUI input/;引用值只填 basename 之外的相对形式由后端归一,
 * 因此这里写回搜索结果的文件名即可。
 * 事件用委托绑定:输入图区块随 renderGenerateEditor 整体重绘。
 */
function bindGenerateImagePicker() {
  const editor = document.getElementById("generateEditor");
  editor.addEventListener("click", (event) => {
    const searchBtn = event.target.closest("[data-generate-image-search='true']");
    if (searchBtn) {
      const card = searchBtn.closest(".generate-image-ref");
      const query = card?.querySelector("[data-generate-image-query='true']")?.value?.trim();
      const results = card?.querySelector("[data-generate-image-results='true']");
      if (!query || !results) {
        return;
      }
      results.textContent = "搜索中…";
      generateFetchJson(`/api/image-refs?q=${encodeURIComponent(query)}&limit=8`)
        .then((payload) => {
          results.innerHTML = (payload.items || [])
            .map(
              (item) => `<button type="button" class="generate-image-result" data-generate-image-pick="${generateEscapeHtml(item.filename || "")}">${generateEscapeHtml(item.filename || item.sha256 || "-")}</button>`
            )
            .join("") || '<span class="muted">无匹配图片</span>';
        })
        .catch((error) => {
          results.textContent = error.message;
        });
      return;
    }
    const pick = event.target.closest("[data-generate-image-pick]");
    if (!pick) {
      return;
    }
    const card = pick.closest(".generate-image-ref");
    const input = card?.querySelector("[data-generate-image-ref='true']");
    if (!input) {
      return;
    }
    input.value = pick.dataset.generateImagePick || "";
    const results = card.querySelector("[data-generate-image-results='true']");
    if (results) {
      results.innerHTML = "";
    }
  });
}

async function initGeneratePage() {
  bindGenerateEvents();
  bindGenerateRandomizeFeedback();
  bindGenerateImagePicker();
  // 恢复持久化的编辑器模式(重放编辑 ⇄ 内嵌 ComfyUI)
  generateState.editorMode =
    window.uiPref("generateEditorMode") === "embedded" ? "embedded" : "replay";
  const params = new URLSearchParams(window.location.search);
  const sha256 = params.get("sha256");
  // 带 sha 直接落到内嵌模式:画布即将承载这张归档图的工作流,启动前先清草稿
  // ——ComfyUI 前端会恢复最后一份草稿,清了它,随后灌入的新工作流才不会被旧图挤掉
  if (sha256 && generateState.editorMode === "embedded") {
    clearComfyDrafts();
  }
  syncEditorModeDom();
  // 只读来源块:未载入时先摆弱提示(载入成功后由 loadGenerateSource 填充)
  syncSourceIdentityField(null);
  startGeneratePolling();
  await refreshQueueAndHistory();
  if (sha256) {
    await loadGenerateSource(sha256);
  }
}

initGeneratePage().catch((error) => {
  document.getElementById("generateEditor").textContent = `初始化失败: ${error.message}`;
  showError("初始化生成页", error);
});
