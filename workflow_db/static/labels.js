const labelState = {
  categories: {},
  options: { loras: [] },
  items: [],
  imageRefs: [],
  imageRefResults: [],
  selectedLoras: [],
};

function labelEscapeHtml(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function labelFetchJson(url, options = {}) {
  const response = await fetch(apiUrl(url), options);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.detail || `Request failed: ${response.status}`);
  }
  return response.json();
}

function splitLines(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function fillCategorySelect(select, includeAll) {
  select.innerHTML = includeAll ? '<option value="">全部分类</option>' : "";
  Object.entries(labelState.categories).forEach(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  });
}

// 归一化后端 categories(数组 [{key,label}] 或 Mongo 文档)→ 前端 map {key: label}
function categoriesToMap(list) {
  const map = {};
  (Array.isArray(list) ? list : []).forEach((entry) => {
    if (entry && entry.key) map[entry.key] = entry.label || entry.key;
  });
  return map;
}

function renderCategoryChips() {
  const container = document.getElementById("categoryChips");
  const entries = Object.entries(labelState.categories);
  document.getElementById("categoryCount").textContent = `${entries.length} 个分类`;
  if (!entries.length) {
    container.innerHTML = '<div class="empty compact">暂无分类,可在下方新增。</div>';
    return;
  }
  container.innerHTML = entries
    .map(
      ([key, label]) => `
        <span class="category-chip" title="${labelEscapeHtml(key)}">
          <span class="category-chip-label">${labelEscapeHtml(label)}</span>
          <code class="category-chip-key">${labelEscapeHtml(key)}</code>
          <button type="button" title="删除分类" data-remove-category="${labelEscapeHtml(key)}">×</button>
        </span>`
    )
    .join("");
}

async function loadCategories() {
  const payload = await labelFetchJson("/api/manual-label-categories");
  labelState.categories = categoriesToMap(payload.items);
  fillCategorySelect(document.getElementById("labelCategoryFilter"), true);
  fillCategorySelect(document.getElementById("labelCategoryInput"), false);
  renderCategoryChips();
}

async function addCategory() {
  const key = document.getElementById("categoryKeyInput").value.trim();
  const label = document.getElementById("categoryLabelInput").value.trim();
  await labelFetchJson("/api/manual-label-categories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, label }),
  });
  document.getElementById("categoryKeyInput").value = "";
  document.getElementById("categoryLabelInput").value = "";
  await loadCategories();
  await loadLabels();
}

async function removeCategory(key) {
  if (!window.confirm(`确认删除分类"${labelState.categories[key] || key}"？`)) return;
  await labelFetchJson(`/api/manual-label-categories/${encodeURIComponent(key)}`, { method: "DELETE" });
  await loadCategories();
  await loadLabels();
}

function fillLoraOptions() {
  document.getElementById("labelLoraOptions").innerHTML = (labelState.options.loras || [])
    .map((lora) => `<option value="${labelEscapeHtml(lora)}"></option>`)
    .join("");
}

function normalizeLoraName(value) {
  return String(value || "").trim();
}

function loraAlreadySelected(lora) {
  const needle = normalizeLoraName(lora).toLowerCase();
  return labelState.selectedLoras.some((item) => item.toLowerCase() === needle);
}

function addSelectedLora(lora) {
  const value = normalizeLoraName(lora);
  if (!value || loraAlreadySelected(value)) {
    return;
  }
  labelState.selectedLoras.push(value);
  document.getElementById("labelLoraPickerInput").value = "";
  renderSelectedLoras();
  renderLoraMatches();
}

function mergeImageRefLoras(loras) {
  const added = [];
  (Array.isArray(loras) ? loras : []).forEach((lora) => {
    const value = normalizeLoraName(lora);
    if (!value || loraAlreadySelected(value)) return;
    labelState.selectedLoras.push(value);
    added.push(value);
  });
  if (added.length) {
    document.getElementById("labelLoraPickerInput").value = "";
    renderSelectedLoras();
    renderLoraMatches();
  }
  return added;
}

function removeSelectedLora(index) {
  labelState.selectedLoras.splice(index, 1);
  renderSelectedLoras();
  renderLoraMatches();
}

function filteredLoraMatches() {
  const query = normalizeLoraName(document.getElementById("labelLoraPickerInput").value).toLowerCase();
  const options = labelState.options.loras || [];
  if (!query) {
    return options.filter((lora) => !loraAlreadySelected(lora)).slice(0, 24);
  }
  return options
    .filter((lora) => lora.toLowerCase().includes(query) && !loraAlreadySelected(lora))
    .slice(0, 40);
}

function renderSelectedLoras() {
  const container = document.getElementById("selectedLabelLoras");
  if (!labelState.selectedLoras.length) {
    container.innerHTML = '<div class="empty compact">尚未添加 LoRA。</div>';
    return;
  }
  container.innerHTML = labelState.selectedLoras
    .map(
      (lora, index) => `
        <span class="label-lora-chip">
          <span>${labelEscapeHtml(lora)}</span>
          <button type="button" title="移除" data-remove-lora="${index}">×</button>
        </span>`
    )
    .join("");
}

function renderLoraMatches() {
  const container = document.getElementById("labelLoraMatches");
  const query = normalizeLoraName(document.getElementById("labelLoraPickerInput").value);
  const matches = filteredLoraMatches();
  if (!matches.length) {
    container.innerHTML = query
      ? '<div class="empty compact">无匹配,可输入后点"添加"</div>'
      : '<div class="empty compact">输入关键词筛选或从候选中点击添加</div>';
    return;
  }
  container.innerHTML = matches
    .map((lora) => `<button type="button" class="label-lora-match" data-add-lora="${labelEscapeHtml(lora)}">${labelEscapeHtml(lora)}</button>`)
    .join("");
}

function currentFilters() {
  const params = new URLSearchParams();
  const category = document.getElementById("labelCategoryFilter").value;
  const lora = document.getElementById("labelLoraFilter").value.trim();
  const q = document.getElementById("labelSearchInput").value.trim();
  const from = document.getElementById("labelFromFilter").value;
  const to = document.getElementById("labelToFilter").value;
  if (category) params.set("category", category);
  if (lora) params.set("lora", lora);
  if (q) params.set("q", q);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  return params;
}

function renderSelectedRefs() {
  const container = document.getElementById("selectedImageRefs");
  if (!labelState.imageRefs.length) {
    container.innerHTML = '<div class="empty">尚未添加图片引用。</div>';
    return;
  }
  container.innerHTML = labelState.imageRefs
    .map(
      (ref, index) => `
        <div class="image-ref-chip">
          ${ref.sha256 ? `<img src="${apiUrl(`/api/thumb/${labelEscapeHtml(ref.sha256)}?w=120&h=120`)}" alt="${labelEscapeHtml(ref.filename)}" />` : '<span class="image-ref-placeholder" aria-hidden="true">无预览</span>'}
          <div>
            <strong>${labelEscapeHtml(ref.filename || ref.image_name || ref.sha256 || "未命名图片")}</strong>
            <div class="muted">${labelEscapeHtml(imageRefPath(ref))}</div>
          </div>
          <button type="button" class="action secondary" data-remove-ref="${index}">移除</button>
        </div>`
    )
    .join("");
}

function normalizeImageRefValue(value) {
  return String(value || "").trim().toLowerCase().replace(/[\\/]+/g, "/");
}

function imageRefKey(ref) {
  if (ref.ref_key) return String(ref.ref_key);
  if (ref.sha256) return `sha256:${normalizeImageRefValue(ref.sha256)}`;
  for (const key of ["resolved_path", "windows_path", "source_path"]) {
    if (ref[key]) return `path:${normalizeImageRefValue(ref[key])}`;
  }
  return `legacy:${ref.batch_key || ""}:${normalizeImageRefValue(ref.filename)}:${ref.created_date || ""}`;
}

function imageRefPath(ref) {
  return ref.resolved_path || ref.windows_path || ref.source_path || "路径不可用";
}

function imageRefMatchLabel(type) {
  return {
    sha256_exact: "SHA 精确匹配",
    path_exact: "路径精确匹配",
    filename_exact: "文件名精确匹配",
    filename_partial: "文件名部分匹配",
    path_partial: "路径部分匹配",
    sha256_partial: "SHA 部分匹配",
  }[type] || "匹配";
}

function renderImageRefResults(rows) {
  const container = document.getElementById("imageRefResults");
  if (!rows.length) {
    container.innerHTML = '<div class="empty">无匹配图片</div>';
    return;
  }
  container.innerHTML = rows
    .map((row) => {
      const selected = labelState.imageRefs.some((ref) => imageRefKey(ref) === imageRefKey(row));
      const duplicateText = Number(row.duplicate_count || 1) > 1 ? ` · 已折叠 ${row.duplicate_count} 条相同引用` : "";
      const refLoras = Array.isArray(row.loras) ? row.loras.filter(Boolean) : [];
      return `
        <button class="image-ref-result${selected ? " is-selected" : ""}" type="button" data-image-ref="${labelEscapeHtml(encodeURIComponent(JSON.stringify(row)))}" ${selected ? "disabled" : ""}>
          ${row.sha256 ? `<img src="${apiUrl(`/api/thumb/${labelEscapeHtml(row.sha256)}?w=120&h=120`)}" alt="${labelEscapeHtml(row.filename)}" />` : '<span class="image-ref-placeholder" aria-hidden="true">无预览</span>'}
          <span class="image-ref-result-copy">
            <span class="image-ref-result-title">
              <strong>${labelEscapeHtml(row.filename || row.image_name || row.sha256 || "未命名图片")}</strong>
              ${selected ? '<span class="annotation-chip">已添加</span>' : ""}
            </span>
            <span class="image-ref-result-path" title="${labelEscapeHtml(imageRefPath(row))}">${labelEscapeHtml(imageRefPath(row))}</span>
            <span class="muted">${labelEscapeHtml(imageRefMatchLabel(row.match_type))}${row.created_date ? ` · ${labelEscapeHtml(row.created_date)}` : ""}${labelEscapeHtml(duplicateText)}</span>
            <span class="image-ref-result-loras${refLoras.length ? "" : " is-empty"}" title="${labelEscapeHtml(refLoras.join("\n"))}">
              ${refLoras.length ? `关联 LoRA（添加图片时自动合并）：${labelEscapeHtml(refLoras.join("、"))}` : "该图片没有可同步的 LoRA"}
            </span>
          </span>
        </button>`;
    })
    .join("");
}

function renderLabels() {
  const container = document.getElementById("labelList");
  const category = document.getElementById("labelCategoryFilter").value;
  document.getElementById("labelTotal").textContent = labelState.items.length;
  document.getElementById("labelResultCount").textContent = `${labelState.items.length} 条`;
  document.getElementById("labelCategorySummary").textContent = category ? labelState.categories[category] : "全部";
  if (!labelState.items.length) {
    container.innerHTML = '<div class="empty">暂无标注</div>';
    return;
  }
  container.innerHTML = labelState.items
    .map((item) => {
      const categoryLabel = labelState.categories[item.category] || item.category || "";
      return `
        <article class="label-item" data-label-id="${labelEscapeHtml(item.id)}">
          <div class="label-item-head">
            <strong>${labelEscapeHtml(item.name)}</strong>
            <span class="annotation-chip">${labelEscapeHtml(categoryLabel)}</span>
          </div>
          <div class="chip-list">${(item.loras || []).map((lora) => `<span class="chip">${labelEscapeHtml(lora)}</span>`).join("")}</div>
          <pre class="stats-pre">${labelEscapeHtml((item.prompt_fragments || []).join("\n"))}</pre>
          ${item.note ? `<div class="label-note">${labelEscapeHtml(item.note)}</div>` : ""}
          ${
            item.image_refs && item.image_refs.length
              ? `<div class="label-ref-strip">${item.image_refs
                  .map((ref) => (ref.sha256 ? `<img src="${apiUrl(`/api/thumb/${labelEscapeHtml(ref.sha256)}?w=120&h=120`)}" title="${labelEscapeHtml(ref.filename)}" />` : ""))
                  .join("")}</div>`
              : ""
          }
        </article>`;
    })
    .join("");
}

function resetEditor() {
  const firstCategory = Object.keys(labelState.categories)[0] || "";
  document.getElementById("labelIdInput").value = "";
  document.getElementById("labelNameInput").value = "";
  document.getElementById("labelCategoryInput").value = firstCategory;
  document.getElementById("labelLoraPickerInput").value = "";
  document.getElementById("labelPromptsInput").value = "";
  document.getElementById("labelNoteInput").value = "";
  document.getElementById("labelDeleteBtn").disabled = true;
  labelState.selectedLoras = [];
  labelState.imageRefs = [];
  labelState.imageRefResults = [];
  document.getElementById("imageRefResults").innerHTML = "";
  document.getElementById("imageRefSearchStatus").textContent = "";
  renderSelectedLoras();
  renderLoraMatches();
  renderSelectedRefs();
}

function loadItemToEditor(item) {
  document.getElementById("labelIdInput").value = item.id;
  document.getElementById("labelNameInput").value = item.name || "";
  document.getElementById("labelCategoryInput").value = item.category || "";
  document.getElementById("labelLoraPickerInput").value = "";
  labelState.selectedLoras = [...(item.loras || [])];
  document.getElementById("labelPromptsInput").value = (item.prompt_fragments || []).join("\n");
  document.getElementById("labelNoteInput").value = item.note || "";
  document.getElementById("labelDeleteBtn").disabled = false;
  labelState.imageRefs = item.image_refs || [];
  renderSelectedLoras();
  renderLoraMatches();
  renderSelectedRefs();
  renderImageRefResults(labelState.imageRefResults);
}

async function loadLabels() {
  const params = currentFilters();
  const payload = await labelFetchJson(`/api/manual-labels?${params}`);
  labelState.items = payload.items || [];
  if (Array.isArray(payload.categories)) {
    labelState.categories = categoriesToMap(payload.categories);
  }
  renderLabels();
}

async function saveLabel() {
  const id = document.getElementById("labelIdInput").value;
  const payload = {
    name: document.getElementById("labelNameInput").value.trim(),
    category: document.getElementById("labelCategoryInput").value,
    loras: [...labelState.selectedLoras],
    prompt_fragments: splitLines(document.getElementById("labelPromptsInput").value),
    note: document.getElementById("labelNoteInput").value.trim(),
    image_refs: labelState.imageRefs,
  };
  const url = id ? `/api/manual-labels/${id}` : "/api/manual-labels";
  const method = id ? "PUT" : "POST";
  const result = await labelFetchJson(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  loadItemToEditor(result.item);
  await loadLabels();
}

async function deleteLabel() {
  const id = document.getElementById("labelIdInput").value;
  if (!id || !window.confirm("确认删除该标注？")) {
    return;
  }
  await labelFetchJson(`/api/manual-labels/${id}`, { method: "DELETE" });
  resetEditor();
  await loadLabels();
}

async function searchImageRefs() {
  const q = document.getElementById("imageRefSearchInput").value.trim();
  const status = document.getElementById("imageRefSearchStatus");
  if (!q) {
    status.textContent = "请输入文件名、路径或 SHA-256。";
    labelState.imageRefResults = [];
    document.getElementById("imageRefResults").innerHTML = "";
    return;
  }
  const payload = await labelFetchJson(`/api/image-refs?q=${encodeURIComponent(q)}&limit=20`);
  const rows = payload.items || [];
  labelState.imageRefResults = rows;
  status.textContent = rows.length ? `找到 ${rows.length} 个唯一图片引用；点击结果即可添加。` : "未找到匹配的图片引用。";
  renderImageRefResults(rows);
}

async function bootLabels() {
  const [options, labels, categories] = await Promise.all([
    labelFetchJson("/api/options"),
    labelFetchJson("/api/manual-labels"),
    labelFetchJson("/api/manual-label-categories").catch(() => null),
  ]);
  labelState.options = options;
  labelState.categories = categoriesToMap(
    (categories && categories.items) ||
      (Array.isArray(labels.categories) ? labels.categories : [])
  );
  labelState.items = labels.items || [];
  fillCategorySelect(document.getElementById("labelCategoryFilter"), true);
  fillCategorySelect(document.getElementById("labelCategoryInput"), false);
  fillLoraOptions();
  renderCategoryChips();
  resetEditor();
  renderLabels();

  document.getElementById("labelSearchBtn").addEventListener("click", () => {
    const button = document.getElementById("labelSearchBtn");
    setButtonLoading(button, true);
    loadLabels()
      .catch((error) => showToast(error.message, { type: "error" }))
      .finally(() => setButtonLoading(button, false));
  });
  ["labelCategoryFilter", "labelLoraFilter", "labelSearchInput"].forEach((id) => {
    document.getElementById(id).addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        loadLabels().catch((error) => showToast(error.message, { type: "error" }));
      }
    });
  });
  document.getElementById("labelCategoryFilter").addEventListener("change", () => loadLabels().catch((error) => showToast(error.message, { type: "error" })));
  ["labelFromFilter", "labelToFilter"].forEach((id) => {
    document.getElementById(id).addEventListener("change", () => loadLabels().catch((error) => showToast(error.message, { type: "error" })));
  });
  document.getElementById("labelSaveBtn").addEventListener("click", () => {
    const button = document.getElementById("labelSaveBtn");
    setButtonLoading(button, true, "保存中");
    saveLabel()
      .then(() => showToast("标注已保存", { type: "success", duration: 2500 }))
      .catch((error) => showToast(error.message, { type: "error" }))
      .finally(() => setButtonLoading(button, false));
  });
  document.getElementById("labelDeleteBtn").addEventListener("click", () => deleteLabel().catch((error) => showToast(error.message, { type: "error" })));
  document.getElementById("labelResetBtn").addEventListener("click", resetEditor);
  document.getElementById("labelLoraPickerInput").addEventListener("input", renderLoraMatches);
  document.getElementById("labelLoraPickerInput").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const firstMatch = filteredLoraMatches()[0];
    addSelectedLora(firstMatch || event.currentTarget.value);
  });
  document.getElementById("labelLoraAddBtn").addEventListener("click", () => {
    const firstMatch = filteredLoraMatches()[0];
    addSelectedLora(firstMatch || document.getElementById("labelLoraPickerInput").value);
  });
  document.getElementById("labelLoraMatches").addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-add-lora]");
    if (!trigger) return;
    addSelectedLora(trigger.dataset.addLora);
  });
  document.getElementById("selectedLabelLoras").addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-remove-lora]");
    if (!trigger) return;
    removeSelectedLora(Number(trigger.dataset.removeLora));
  });
  document.getElementById("imageRefSearchBtn").addEventListener("click", () => {
    const button = document.getElementById("imageRefSearchBtn");
    setButtonLoading(button, true, "搜索中");
    searchImageRefs()
      .catch((error) => showToast(error.message, { type: "error" }))
      .finally(() => setButtonLoading(button, false));
  });
  document.getElementById("imageRefSearchInput").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    document.getElementById("imageRefSearchBtn").click();
  });
  document.getElementById("imageRefResults").addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-image-ref]");
    if (!trigger) return;
    const result = JSON.parse(decodeURIComponent(trigger.dataset.imageRef));
    const { match_type, duplicate_count, ...ref } = result;
    if (!labelState.imageRefs.some((item) => imageRefKey(item) === imageRefKey(ref))) {
      labelState.imageRefs.push(ref);
      const addedLoras = mergeImageRefLoras(ref.loras);
      renderSelectedRefs();
      renderImageRefResults(labelState.imageRefResults);
      showToast(
        addedLoras.length
          ? `已添加图片引用，并补入 ${addedLoras.length} 个 LoRA`
          : "已添加图片引用；没有新的 LoRA 需要补入",
        { type: "success", duration: 3000 }
      );
    }
  });
  document.getElementById("selectedImageRefs").addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-remove-ref]");
    if (!trigger) return;
    labelState.imageRefs.splice(Number(trigger.dataset.removeRef), 1);
    renderSelectedRefs();
    renderImageRefResults(labelState.imageRefResults);
  });
  document.getElementById("labelList").addEventListener("click", (event) => {
    const itemEl = event.target.closest("[data-label-id]");
    if (!itemEl) return;
    const item = labelState.items.find((entry) => entry.id === itemEl.dataset.labelId);
    if (item) loadItemToEditor(item);
  });
  document.getElementById("categoryAddBtn").addEventListener("click", () => {
    const button = document.getElementById("categoryAddBtn");
    setButtonLoading(button, true, "新增中");
    addCategory()
      .then(() => showToast("分类已新增", { type: "success", duration: 2500 }))
      .catch((error) => showToast(error.message, { type: "error" }))
      .finally(() => setButtonLoading(button, false));
  });
  ["categoryKeyInput", "categoryLabelInput"].forEach((id) => {
    document.getElementById(id).addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        document.getElementById("categoryAddBtn").click();
      }
    });
  });
  document.getElementById("categoryChips").addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-remove-category]");
    if (!trigger) return;
    removeCategory(trigger.dataset.removeCategory).catch((error) => showToast(error.message, { type: "error" }));
  });
}

bootLabels().catch((error) => {
  document.getElementById("labelList").innerHTML = `<div class="empty">加载失败: ${labelEscapeHtml(error.message)}</div>`;
  showToast(error.message, { type: "error" });
});
