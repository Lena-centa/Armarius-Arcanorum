(function attachEnrichmentView(global) {
  "use strict";

  const FIELD_LABELS = {
    samplers: "Sampler",
    "prompts.positive": "正向 Prompt",
    "prompts.negative": "负向 Prompt",
    "model.base_model": "基座模型",
    "loras.items": "LoRA",
    latent: "Latent",
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function pathLabel(path) {
    return FIELD_LABELS[path] || path;
  }

  function statusInfo(diagnostics, hasComfyGraph = true) {
    const semantic = String(diagnostics?.semantic_parse || "").toLowerCase();
    if (semantic === "complete") {
      return { key: "complete", label: "完整解析" };
    }
    if (["partial", "missing"].includes(semantic)) {
      return { key: "partial", label: "部分解析" };
    }
    if (semantic === "unavailable" || diagnostics?.outcome === "unavailable") {
      return { key: "unavailable", label: "无法完整解析" };
    }
    // 非 ComfyUI 来源(NovelAI / A1111 等)本就没有节点工作流,不存在"节点定义"
    // 可缺——报"未能判定(缺节点定义)"会读成解析故障。按"不适用"陈述(muted 描边)。
    if (!hasComfyGraph) {
      return { key: "unavailable", label: "不适用(无 ComfyUI 工作流)" };
    }
    // 兜底:缺 semantic_parse(典型原因 = ComfyUI 未安装该节点、拿不到节点定义,
    // 或该记录早于诊断层)。文案点明"为什么判不了",不写含糊的"解析状态未知"。
    return { key: "unknown", label: "未能判定(缺节点定义)" };
  }

  function unknownNodeLabel(node) {
    if (node && typeof node === "object") {
      const type = node.class_type || node.node_type || node.type || "未知节点";
      const id = node.node_id ?? node.id;
      return id === undefined || id === null || id === "" ? String(type) : `${type} #${id}`;
    }
    return String(node || "未知节点");
  }

  function rawJsonText(value) {
    if (value === undefined || value === null || value === "") {
      return "";
    }
    if (typeof value === "string") {
      try {
        return JSON.stringify(JSON.parse(value), null, 2);
      } catch (_error) {
        return value;
      }
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch (_error) {
      return String(value);
    }
  }

  function rawJsonBlock(label, kind, value) {
    const text = rawJsonText(value);
    if (!text) {
      return "";
    }
    return `<details class="detail-enrichment-raw"><summary>${escapeHtml(label)}</summary>
      <div class="detail-enrichment-raw-head"><button type="button" data-copy-raw-json="${escapeHtml(kind)}">复制 JSON</button></div>
      <pre class="detail-enrichment-raw-pre">${escapeHtml(text)}</pre>
    </details>`;
  }

  function render(enrichment, metadata = {}) {
    const safeEnrichment = enrichment && typeof enrichment === "object" ? enrichment : {};
    const safeMetadata = metadata && typeof metadata === "object" ? metadata : {};
    const diagnostics = safeEnrichment.diagnostics && typeof safeEnrichment.diagnostics === "object"
      ? safeEnrichment.diagnostics
      : {};
    const provenance = safeEnrichment.provenance && typeof safeEnrichment.provenance === "object"
      ? safeEnrichment.provenance
      : {};
    // 是否有 ComfyUI 节点图证据(prompt/workflow 元数据或非空 enrichment)。
    // NovelAI / A1111 的原始元数据不算图证据——它们本就没有节点工作流。
    const hasComfyGraph = Boolean(safeMetadata.raw_prompt || safeMetadata.raw_workflow)
      || Object.keys(safeEnrichment).length > 0;
    const status = statusInfo(diagnostics, hasComfyGraph);
    const filled = Array.isArray(diagnostics.filled_fields) ? diagnostics.filled_fields : [];
    const repaired = Array.isArray(diagnostics.repaired_fields) ? diagnostics.repaired_fields : [];
    const samplerGraph = diagnostics.sampler_graph && typeof diagnostics.sampler_graph === "object"
      ? diagnostics.sampler_graph
      : null;
    const unknownNodes = Array.isArray(diagnostics.unknown_nodes) ? diagnostics.unknown_nodes : [];
    const coverageFields = diagnostics.coverage_after?.fields && typeof diagnostics.coverage_after.fields === "object"
      ? diagnostics.coverage_after.fields
      : {};
    const incompleteCoverage = Object.entries(coverageFields)
      .filter(([, entry]) => entry && ["missing", "partial"].includes(entry.status))
      .map(([path, entry]) => `${pathLabel(path)}${entry.expected_count ? ` (${entry.observed_count || 0}/${entry.expected_count})` : ""}`);
    const providers = Array.isArray(diagnostics.providers) ? diagnostics.providers.filter(Boolean) : [];
    const outcome = String(diagnostics.outcome || "");
    const rawGraphBlocks = [
      rawJsonBlock("prompt (API)", "prompt", safeMetadata.raw_prompt),
      rawJsonBlock("workflow (UI)", "workflow", safeMetadata.raw_workflow),
    ].filter(Boolean);
    // A1111 and older records may not embed a ComfyUI graph. Keep their source
    // metadata visible as JSON as well, so every detail has inspectable evidence.
    const rawJsonHtml = rawGraphBlocks.length
      ? rawGraphBlocks.join("")
      : rawJsonBlock("原始元数据", "metadata", safeMetadata);
    const hasDiagnostics = unknownNodes.length > 0 || incompleteCoverage.length > 0 ||
      Boolean(samplerGraph) || Boolean(rawJsonHtml) ||
      (Array.isArray(diagnostics.warnings) && diagnostics.warnings.length > 0) ||
      (Array.isArray(diagnostics.conflicts) && diagnostics.conflicts.length > 0);
    const filledHtml = filled.length
      ? `<div class="detail-enrichment-filled"><span class="detail-enrichment-label">已补全</span><span>${filled.map((path) => {
          const source = provenance[path]?.provider;
          return `<span class="detail-enrichment-field">${escapeHtml(pathLabel(path))}${source ? ` · ${escapeHtml(source)}` : ""}</span>`;
        }).join("")}</span></div>`
      : "";
    const repairedHtml = repaired.length
      ? `<div class="detail-enrichment-filled"><span class="detail-enrichment-label">已纠正</span><span>${repaired.map((path) => `<span class="detail-enrichment-field">${escapeHtml(pathLabel(path))}</span>`).join("")}</span></div>`
      : "";
    const detailHtml = hasDiagnostics
      ? `<details class="detail-enrichment-diagnostics"><summary>查看解析诊断</summary>
          ${incompleteCoverage.length ? `<div><span class="detail-enrichment-label">未覆盖字段</span>${incompleteCoverage.map((value) => `<span class="detail-enrichment-item">${escapeHtml(value)}</span>`).join("")}</div>` : ""}
          ${unknownNodes.length ? `<div><span class="detail-enrichment-label">未知节点</span>${unknownNodes.map((node) => `<span class="detail-enrichment-item">${escapeHtml(unknownNodeLabel(node))}</span>`).join("")}</div>` : ""}
          ${providers.length ? `<div><span class="detail-enrichment-label">来源</span>${providers.map((provider) => `<span class="detail-enrichment-item">${escapeHtml(provider)}</span>`).join("")}</div>` : ""}
          ${samplerGraph ? `<div><span class="detail-enrichment-label">Sampler 图</span><span class="detail-enrichment-item">${escapeHtml(`${samplerGraph.root_count || 0} 根 · ${samplerGraph.traversed_node_count || 0} 节点 · ${samplerGraph.traversed_edge_count || 0} 条连线 · ${samplerGraph.direction || ""}`)}</span></div>` : ""}
          ${rawJsonHtml}
        </details>`
      : "";
    const hint = outcome === "enriched"
      ? "补全字段仅用于当前展示，原始解析记录未被修改。"
      : !hasComfyGraph
        ? "该记录来自 NovelAI / A1111 等外部元数据，不含 ComfyUI 节点工作流，因此没有节点级解析诊断。"
        : status.key === "unavailable"
          ? "未获得可用的工作流语义信息，已保留原始解析结果。"
          : status.key === "unknown"
            ? "缺少节点定义或诊断信息（常见原因：ComfyUI 未安装该自定义节点），无法判定解析完整度；原始解析结果不受影响，展开诊断可见未覆盖字段与未知节点。"
            : "";
    // 默认折叠:复用列表 negative 区块同一套机制(.prompt-entry + data-toggle-entry +
    // is-collapsed),交互与按钮样式由其既有处理器与样式承载,此处只负责结构。
    return `<section class="detail-section detail-enrichment detail-enrichment--${status.key} prompt-entry is-collapsed">
      <div class="detail-enrichment-head prompt-entry-header">
        <h3>工作流解析</h3>
        <div class="prompt-entry-actions">
          <span class="detail-enrichment-status">${status.label}</span>
          <button class="prompt-entry-toggle" type="button" data-toggle-entry aria-label="展开/折叠工作流解析详情" title="展开/折叠工作流解析详情">+</button>
        </div>
      </div>
      <div class="prompt-entry-body">
        ${hint ? `<div class="detail-enrichment-hint">${escapeHtml(hint)}</div>` : ""}
        ${filledHtml}
        ${repairedHtml}
        ${detailHtml}
      </div>
    </section>`;
  }

  global.aaEnrichmentView = global.wfdbEnrichmentView = { render };
})(typeof window !== "undefined" ? window : globalThis);
