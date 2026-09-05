(function () {
  "use strict";

  const COLLAPSE_KEY = "aa-settings-collapsed";
  const LEGACY_COLLAPSE_KEY = "wfdb-settings-collapsed";

  const state = {
    meta: [],
    groups: [],
    values: {}, // .env 文件中的值
    effective: {}, // 当前进程生效值
    dirty: {}, // 用户修改过的 key
    filePath: "",
    fileExists: false,
    rawContent: "",
    collapsed: {},
  };

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(apiUrl(url), options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.message || payload.detail || `Request failed: ${response.status}`);
    }
    return payload;
  }

  function loadCollapseState() {
    try {
      const stored = JSON.parse((window.localStorage.getItem(COLLAPSE_KEY) || window.localStorage.getItem(LEGACY_COLLAPSE_KEY)) || "{}");
      if (stored && typeof stored === "object") {
        state.collapsed = stored;
      }
    } catch (error) {}
  }

  function persistCollapseState() {
    try {
      window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(state.collapsed));
    } catch (error) {}
  }

  function markDirty(key) {
    const input = document.getElementById(`setting_${key}`);
    state.dirty[key] = input.value.trim();
    input.classList.add("is-dirty");
    updateDirtyUI();
  }

  function clearDirty(key) {
    delete state.dirty[key];
    const input = document.getElementById(`setting_${key}`);
    if (input) {
      input.classList.remove("is-dirty");
    }
    updateDirtyUI();
  }

  function updateDirtyUI() {
    const count = Object.keys(state.dirty).length;
    document.getElementById("settingsDirtyCount").textContent = count;
    document.getElementById("settingsSaveBtn").disabled = count === 0;
    document.getElementById("settingsRevertBtn").disabled = count === 0;
    const hint = document.getElementById("settingsActionHint");
    if (hint) {
      hint.textContent =
        count > 0 ? `${count} 项未保存,保存后重启服务生效` : "已同步,保存后重启生效";
    }
  }

  function renderGroups() {
    const container = document.getElementById("settingsGroups");
    container.innerHTML = "";
    state.groups.forEach((group) => {
      const items = state.meta.filter((item) => item.group === group);
      if (items.length === 0) {
        return;
      }
      const panel = document.createElement("section");
      panel.className = "panel settings-panel";
      if (state.collapsed[group]) {
        panel.classList.add("is-collapsed");
      }

      const head = document.createElement("div");
      head.className = "settings-panel-head";
      head.setAttribute("role", "button");
      head.setAttribute("tabindex", "0");
      head.setAttribute("aria-expanded", String(!state.collapsed[group]));

      const title = document.createElement("h2");
      title.textContent = group;

      const count = document.createElement("span");
      count.className = "group-count";
      count.textContent = `${items.length} 项`;

      const chevron = document.createElement("span");
      chevron.className = "group-chevron";
      chevron.textContent = "▾";

      head.appendChild(title);
      head.appendChild(count);
      head.appendChild(chevron);
      panel.appendChild(head);

      const grid = document.createElement("div");
      grid.className = "settings-grid";
      for (const item of items) {
        grid.appendChild(renderField(item));
      }
      panel.appendChild(grid);
      container.appendChild(panel);

      const toggle = () => {
        const collapsed = panel.classList.toggle("is-collapsed");
        state.collapsed[group] = collapsed;
        head.setAttribute("aria-expanded", String(!collapsed));
        persistCollapseState();
      };
      head.addEventListener("click", toggle);
      head.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggle();
        }
      });
    });
  }

  function renderField(item) {
    const wrapper = document.createElement("div");
    wrapper.className = "field settings-field";

    const label = document.createElement("label");
    label.htmlFor = `setting_${item.key}`;
    label.textContent = item.label;
    label.title = item.description;
    wrapper.appendChild(label);

    const fileValue = state.values[item.key];
    const effectiveValue = state.effective[item.key];
    const hasDiff = fileValue != null && effectiveValue != null && String(fileValue) !== String(effectiveValue);

    if (item.type === "boolean") {
      const select = document.createElement("select");
      select.id = `setting_${item.key}`;
      select.dataset.key = item.key;
      select.dataset.default = effectiveValue;
      const yes = document.createElement("option");
      yes.value = "1";
      yes.textContent = "开 (1)";
      const no = document.createElement("option");
      no.value = "0";
      no.textContent = "关 (0)";
      select.appendChild(yes);
      select.appendChild(no);
      select.value = fileValue == null ? String(effectiveValue) : String(fileValue);
      select.addEventListener("change", () => markDirty(item.key));
      wrapper.appendChild(select);
    } else {
      const input = document.createElement("input");
      input.id = `setting_${item.key}`;
      input.dataset.key = item.key;
      input.dataset.default = effectiveValue;
      input.type = item.type === "number" ? "number" : "text";
      input.placeholder = item.defaultValue || "未配置";
      input.value = fileValue == null ? "" : String(fileValue);
      input.autocomplete = "off";
      input.spellcheck = false;
      input.addEventListener("input", () => {
        if (input.value.trim() === String(input.dataset.default === undefined ? "" : input.dataset.default)) {
          clearDirty(item.key);
        } else {
          markDirty(item.key);
        }
      });
      wrapper.appendChild(input);
    }

    const hint = document.createElement("p");
    hint.className = "muted settings-hint";
    hint.textContent = item.description;
    wrapper.appendChild(hint);

    if (hasDiff) {
      const diff = document.createElement("p");
      diff.className = "settings-effective-note";
      diff.textContent = `当前生效: ${effectiveValue === "" ? "(空)" : effectiveValue}(环境变量)`;
      wrapper.appendChild(diff);
    }
    return wrapper;
  }

  function collectValues() {
    const values = { ...state.values };
    for (const item of state.meta) {
      const input = document.getElementById(`setting_${item.key}`);
      if (!input) {
        continue;
      }
      values[item.key] = input.value.trim();
    }
    return values;
  }

  function updateStateCard() {
    const textEl = document.getElementById("settingsEffectiveText");
    const dot = document.querySelector("#settingsEffectiveState .state-dot");
    if (!textEl || !dot) {
      return;
    }
    if (state.fileExists) {
      dot.className = "state-dot is-ok";
      textEl.textContent = "已加载 .env";
    } else {
      dot.className = "state-dot is-warn";
      textEl.textContent = "文件不存在,保存时创建";
    }
  }

  /** 当前数据引擎徽标(MongoDB 组字段下方)。 */
  function engineBadge() {
    const span = document.createElement("span");
    span.className = "settings-engine-badge";
    span.textContent =
      state.engine === "mongo"
        ? "当前引擎: MongoDB"
        : "当前引擎: SQLite";
    span.classList.add(state.engine === "mongo" ? "is-mongo" : "is-sqlite");
    return span;
  }

  /** 在 MONGODB_URI 字段下方注入"检测连接并切换"按钮。 */
  function renderMongoTestButton() {
    const field = document
      .getElementById("setting_MONGODB_URI")
      ?.closest(".settings-field");
    if (!field) {
      return;
    }
    const existing = document.getElementById("mongoTestRow");
    if (existing) {
      existing.remove();
    }
    const row = document.createElement("div");
    row.id = "mongoTestRow";
    row.className = "settings-mongo-test";
    row.appendChild(engineBadge());

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "action secondary";
    btn.textContent = "检测连接并切换";
    btn.addEventListener("click", async () => {
      const uriEl = document.getElementById("setting_MONGODB_URI");
      const dbEl = document.getElementById("setting_MONGODB_DB");
      const uri = (uriEl?.value || "").trim();
      const db = (dbEl?.value || "").trim();
      const result = document.getElementById("mongoTestResult");
      if (result) {
        result.textContent = "";
        result.classList.remove("is-ok", "is-err");
      }
      setButtonLoading(btn, true, "检测中…");
      try {
        const payload = await fetchJson("/api/settings/test-mongo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uri, db }),
        });
        if (result) {
          result.textContent = payload.message || "";
          result.classList.add(payload.ok ? "is-ok" : "is-err");
        }
        if (payload.ok) {
          showToast("已写入,重启后生效", {
            type: "success",
            duration: 6000,
          });
          await loadSettings();
        } else {
          showToast("检测未通过,保持 SQLite", { type: "error" });
        }
      } catch (error) {
        if (result) {
          result.textContent = `检测请求失败: ${error.message}`;
          result.classList.add("is-err");
        }
      } finally {
        setButtonLoading(btn, false);
      }
    });
    row.appendChild(btn);

    const result = document.createElement("p");
    result.id = "mongoTestResult";
    result.className = "muted settings-hint";
    row.appendChild(result);
    field.appendChild(row);
  }

  /** 字节数人性化(主库/文件体积展示用)。 */
  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n <= 0) {
      return "0 B";
    }
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
    return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  /** 数据目录面板内的一行状态(label + 带状态点的值 + extra 标签 + hint)。 */
  function dataDirRow(labelText, valueText, dotClass, hintText, extraText) {
    const wrapper = document.createElement("div");
    wrapper.className = "field settings-field";
    const label = document.createElement("label");
    label.textContent = labelText;
    wrapper.appendChild(label);

    const valueLine = document.createElement("div");
    valueLine.className = "settings-value-line";
    if (dotClass) {
      const dot = document.createElement("span");
      dot.className = `state-dot ${dotClass}`;
      dot.style.marginRight = "6px";
      valueLine.appendChild(dot);
    }
    const code = document.createElement("code");
    code.textContent = valueText;
    code.title = valueText;
    valueLine.appendChild(code);

    if (extraText) {
      const extra = document.createElement("span");
      extra.className = "settings-value-extra";
      extra.textContent = extraText;
      valueLine.appendChild(extra);
    }

    wrapper.appendChild(valueLine);

    if (hintText) {
      const hint = document.createElement("p");
      hint.className = "muted settings-hint";
      hint.textContent = hintText;
      wrapper.appendChild(hint);
    }
    return wrapper;
  }

  /**
   * 「数据目录」面板:数据外置存储的状态总览 + 旧数据迁移入口 + 备份状态。
   * 挂载为设置页第一个面板(数据安全信息优先);复用 test-mongo 的
   * 按钮/结果行/反馈范式,样式全部走既有类,不新增 CSS 结构。
   */
  function renderDataDirPanel(status, backup) {
    const container = document.getElementById("settingsGroups");
    if (!container || !status) {
      return;
    }
    const existing = document.getElementById("dataDirPanel");
    if (existing) {
      existing.remove();
    }

    const panel = document.createElement("section");
    panel.id = "dataDirPanel";
    panel.className = "panel settings-panel";

    const head = document.createElement("div");
    head.className = "settings-panel-head";
    head.setAttribute("role", "button");
    head.setAttribute("tabindex", "0");
    const title = document.createElement("h2");
    title.textContent = "数据目录";
    const count = document.createElement("span");
    count.className = "group-count";
    count.textContent = status.env_file.exists ? "已就绪" : "未初始化";
    const chevron = document.createElement("span");
    chevron.className = "group-chevron";
    chevron.textContent = "▾";
    head.append(title, count, chevron);
    panel.appendChild(head);

    const grid = document.createElement("div");
    grid.className = "settings-grid";

    grid.appendChild(
      dataDirRow(
        "数据目录",
        status.data_dir,
        status.env_file.exists ? "is-ok" : "is-warn",
        ".env 与主库的外置存放点(用户目录,代码树外);更新 / 重装不丢失",
      ),
    );
    grid.appendChild(
      dataDirRow(
        "配置文件 (.env)",
        status.env_file.path,
        status.env_file.exists ? "is-ok" : "is-warn",
        status.env_file.exists ? undefined : "缺失时网关启动会自动生成默认配置",
      ),
    );
    grid.appendChild(
      dataDirRow(
        "主库",
        status.db_path,
        status.db_exists ? "is-ok" : "is-warn",
        status.db_exists ? undefined : "尚未创建;首次启动自动建库或迁移",
        status.db_exists ? formatBytes(status.db_size_bytes) : undefined,
      ),
    );

    // 备份状态行(backup_dir 为空 = 备份循环停用)
    const backupConfigured = !!(backup && backup.backup_dir);
    const backupValue = backupConfigured
      ? backup.backup_dir
      : "未配置";
    const backupExtra = backupConfigured
      ? (backup.last_run_at ? `最近快照: ${String(backup.last_run_at).replace("T", " ").slice(0, 19)}` : "尚无快照")
      : "备份循环停用";
    const backupHint = backup && backup.error
      ? `最近一次失败: ${backup.error}`
      : (backupConfigured ? undefined : "ARMARIUS_BACKUP_DIR / WORKFLOW_DB_BACKUP_DIR 留空;需要备份时在下方配置目录并重启");
    grid.appendChild(
      dataDirRow(
        "自动备份",
        backupValue,
        backupConfigured ? "is-ok" : "is-warn",
        backupHint,
        backupExtra,
      ),
    );

    // 操作行:旧数据迁移(仅当旧仓库 data/ 仍有主库且当前主库不在其中)
    const actions = document.createElement("div");
    actions.className = "settings-mongo-test";
    const norm = (v) => String(v || "").replace(/[\\/]+$/, "").toLowerCase();
    const legacyMigratable =
      status.legacy &&
      status.legacy.db_exists &&
      norm(status.db_path) !== norm(status.legacy.db_path);
    if (legacyMigratable) {
      const migrateBtn = document.createElement("button");
      migrateBtn.type = "button";
      migrateBtn.className = "action secondary";
      migrateBtn.textContent = `迁移旧数据(${formatBytes(status.legacy.db_size_bytes)})`;
      migrateBtn.addEventListener("click", async () => {
        const result = document.getElementById("dataDirResult");
        if (result) {
          result.textContent = "";
          result.classList.remove("is-ok", "is-err");
        }
        if (!window.confirm(
          `将把旧主库复制到数据目录并清除旧路径配置(原库保留不动),重启服务后生效。\n\n旧库:${status.legacy.db_path}\n目标:${joinDataDir(status.data_dir)}\n\n继续?`,
        )) {
          return;
        }
        setButtonLoading(migrateBtn, true, "迁移中…");
        try {
          const payload = await fetchJson("/api/settings/migrate", {
            method: "POST",
          });
          if (result) {
            result.textContent = payload.message || "";
            result.classList.add(payload.ok ? "is-ok" : "is-err");
          }
          showToast(payload.ok ? "迁移完成,重启后生效" : "迁移未执行", {
            type: payload.ok ? "success" : "error",
            duration: 6000,
          });
          await loadSettings();
        } catch (error) {
          if (result) {
            result.textContent = `迁移请求失败: ${error.message}`;
            result.classList.add("is-err");
          }
        } finally {
          setButtonLoading(migrateBtn, false);
        }
      });
      actions.appendChild(migrateBtn);
    }

    // 手动触发一次备份(备份停用时按钮禁用并说明原因)
    const backupBtn = document.createElement("button");
    backupBtn.type = "button";
    backupBtn.className = "action secondary";
    backupBtn.textContent = "立即备份";
    backupBtn.disabled = !backupConfigured;
    backupBtn.title = backupConfigured ? "" : "先在下方配置 ARMARIUS_BACKUP_DIR 并重启";
    backupBtn.addEventListener("click", async () => {
      setButtonLoading(backupBtn, true, "备份中…");
      try {
        const payload = await fetchJson("/api/backup/trigger", {
          method: "POST",
        });
        showToast(payload.error ? `备份失败: ${payload.error}` : "备份完成", {
          type: payload.error ? "error" : "success",
          duration: 6000,
        });
        await loadSettings();
      } catch (error) {
        showToast(`备份请求失败: ${error.message}`, { type: "error" });
      } finally {
        setButtonLoading(backupBtn, false);
      }
    });
    actions.appendChild(backupBtn);

    const result = document.createElement("p");
    result.id = "dataDirResult";
    result.className = "muted settings-hint";
    actions.appendChild(result);
    grid.appendChild(actions);

    panel.appendChild(grid);
    container.prepend(panel);

    const toggle = () => {
      const collapsed = panel.classList.toggle("is-collapsed");
      state.collapsed["数据目录"] = collapsed;
      persistCollapseState();
    };
    head.addEventListener("click", toggle);
    head.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    });
  }

  /** 数据目录内主库路径拼接(与后端 DB_FILENAME 约定一致)。 */
  function joinDataDir(dataDir) {
    const dir = String(dataDir || "").replace(/[\\/]+$/, "");
    const sep = dir.includes("\\") ? "\\" : "/";
    return `${dir}${sep}gray_workflow.sqlite3`;
  }

  async function loadSettings() {
    try {
      // 设置全量 + 数据目录状态 + 备份状态并行拉取;后两者失败不阻塞主表单
      const [payload, dataStatus, backupStatus] = await Promise.all([
        fetchJson("/api/settings"),
        fetchJson("/api/settings/data-status").catch(() => null),
        fetchJson("/api/backup/status").catch(() => null),
      ]);
      state.meta = payload.meta || [];
      state.groups = payload.groups || [];
      state.values = payload.values || {};
      state.effective = payload.effective || {};
      state.filePath = payload.file_path || "";
      state.fileExists = payload.file_exists;
      state.rawContent = "";
      state.dirty = {};
      state.engine = payload.engine || "sqlite";
      const pathEl = document.getElementById("settingsFilePath");
      pathEl.textContent = state.filePath.split("/").pop() || state.filePath;
      pathEl.title = state.filePath;
      updateStateCard();
      renderGroups();
      renderMongoTestButton();
      renderDataDirPanel(dataStatus, backupStatus);
      updateDirtyUI();
    } catch (error) {
      showToast(`加载设置失败: ${error.message}`, { type: "error" });
    }
  }

  async function saveSettings() {
    const btn = document.getElementById("settingsSaveBtn");
    setButtonLoading(btn, true, "保存中…");
    try {
      const payload = await fetchJson("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: collectValues() }),
      });
      state.dirty = {};
      updateDirtyUI();
      const written = (payload.written || []).length;
      const removed = (payload.removed || []).length;
      showToast(`已保存 ${written} 项,删除 ${removed} 项,重启后生效。`, {
        type: "success",
        duration: 6000,
      });
      await loadSettings();
    } catch (error) {
      showToast(`保存失败: ${error.message}`, { type: "error" });
    } finally {
      setButtonLoading(btn, false);
    }
  }

  function revertDirty() {
    for (const key of Object.keys(state.dirty)) {
      const input = document.getElementById(`setting_${key}`);
      if (!input) {
        continue;
      }
      const defaultValue = state.values[key];
      input.value = defaultValue == null ? "" : String(defaultValue);
      input.classList.remove("is-dirty");
    }
    state.dirty = {};
    updateDirtyUI();
  }

  async function toggleRawView() {
    const view = document.getElementById("settingsRawView");
    const btn = document.getElementById("settingsRawToggleBtn");
    if (!view.hidden) {
      view.hidden = true;
      btn.textContent = "查看原始文件";
      return;
    }
    if (!state.rawContent) {
      try {
        const payload = await fetchJson("/api/settings/raw");
        state.rawContent = payload.content || "";
      } catch (error) {
        showToast(`读取原始文件失败: ${error.message}`, { type: "error" });
        return;
      }
    }
    view.textContent = state.rawContent || "(空)";
    view.hidden = false;
    btn.textContent = "收起原始文件";
  }

  document.addEventListener("DOMContentLoaded", function () {
    loadCollapseState();
    document.getElementById("settingsSaveBtn").addEventListener("click", saveSettings);
    document.getElementById("settingsRevertBtn").addEventListener("click", revertDirty);
    document.getElementById("settingsRawToggleBtn").addEventListener("click", toggleRawView);
    loadSettings();
  });
})();
