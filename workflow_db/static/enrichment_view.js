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

  function statusInfo(diagnostics) {
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
    return { key: "unknown", label: "解析状态未知" };
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
    const status = statusInfo(diagnostics);
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
      : status.key === "unavailable"
        ? "未获得可用的工作流语义信息，已保留原始解析结果。"
        : "";
    return `<section class="detail-section detail-enrichment detail-enrichment--${status.key}">
      <div class="detail-enrichment-head"><h3>工作流解析</h3><span class="detail-enrichment-status">${status.label}</span></div>
      ${hint ? `<div class="detail-enrichment-hint">${escapeHtml(hint)}</div>` : ""}
      ${filledHtml}
      ${repairedHtml}
      ${detailHtml}
    </section>`;
  }

  global.aaEnrichmentView = global.wfdbEnrichmentView = { render };
})(typeof window !== "undefined" ? window : globalThis);
