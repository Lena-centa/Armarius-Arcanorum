(function () {
  "use strict";

  // 灰度切量开关：默认空字符串走相对路径（当前服务）。
  // 双跑切量时由部署层注入 window.__API_BASE__（如 "/v1" 或旧端前缀），
  // 所有 API 请求经 apiUrl() 拼前缀，无需改动各页面代码。
  window.__API_BASE__ = window.__API_BASE__ || "";
  window.apiUrl = function (path) {
    return window.__API_BASE__ + path;
  };

  // UI 偏好:纯前端渲染偏好,localStorage 持久化、即时生效,
  // 与设置页的 .env 服务端配置(需重启)相互独立。
  var UI_PREFS_KEY = "aa-ui-prefs";

  window.uiPrefs = function () {
    try {
      var stored = JSON.parse(window.localStorage.getItem(UI_PREFS_KEY) || "{}");
      return stored && typeof stored === "object" ? stored : {};
    } catch (error) {
      return {};
    }
  };

  window.uiPref = function (key, fallback) {
    var prefs = window.uiPrefs();
    return Object.prototype.hasOwnProperty.call(prefs, key) ? prefs[key] : fallback;
  };

  window.setUiPref = function (key, value) {
    var prefs = window.uiPrefs();
    prefs[key] = value;
    try {
      window.localStorage.setItem(UI_PREFS_KEY, JSON.stringify(prefs));
    } catch (error) {}
  };

  var THEME_KEY = "aa-theme";
  var LEGACY_THEME_KEY = "wfdb-theme";

  var THEME_ICONS = {
    sun: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    moon: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  };

  function currentTheme() {
    return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  }

  function syncThemeToggle() {
    var btn = document.getElementById("themeToggleBtn");
    if (!btn) {
      return;
    }
    var dark = currentTheme() === "dark";
    btn.innerHTML = dark ? THEME_ICONS.sun : THEME_ICONS.moon;
    btn.setAttribute("aria-pressed", dark ? "true" : "false");
    btn.title = dark ? "切换到浅色主题" : "切换到深色主题";
  }

  window.toggleTheme = function () {
    var next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      window.localStorage.setItem(THEME_KEY, next);
      try { window.localStorage.setItem(LEGACY_THEME_KEY, next); } catch (e) {}
    } catch (error) {}
    syncThemeToggle();
  };

  document.addEventListener("DOMContentLoaded", function () {
    syncThemeToggle();
    var btn = document.getElementById("themeToggleBtn");
    if (btn) {
      btn.addEventListener("click", window.toggleTheme);
    }
    initSummaryDrawer();
    // 日期输入空值提示(data-hint 伪元素方案):值变化时同步 is-empty
    document.querySelectorAll("input[type='date'][data-hint]").forEach(function (el) {
      el.classList.toggle("is-empty", !el.value);
      el.addEventListener("change", function () {
        el.classList.toggle("is-empty", !el.value);
      });
    });
  });

  function initSummaryDrawer() {
    var drawer = document.getElementById("summaryDrawer");
    var toggle = document.getElementById("summaryToggleBtn");
    var popover = document.getElementById("summaryPopover");
    if (!drawer || !toggle || !popover) {
      return;
    }

    function setOpen(open) {
      drawer.classList.toggle("is-open", open);
      popover.hidden = !open;
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    }

    toggle.addEventListener("click", function () {
      setOpen(popover.hidden);
    });

    // 扫描中自动展开;回到空闲自动收起
    var stateEl = document.getElementById("syncSummaryState");
    if (stateEl) {
      var lastState = stateEl.textContent;
      var observer = new MutationObserver(function () {
        var state = stateEl.textContent;
        if (state === "扫描中" && lastState !== "扫描中") {
          setOpen(true);
        } else if (state === "空闲" && lastState === "扫描中") {
          setOpen(false);
        }
        lastState = state;
      });
      observer.observe(stateEl, { childList: true, characterData: true, subtree: true });
    }
  }

  var TOAST_ICONS = {
    error: "✕",
    success: "✓",
    warning: "⚠",
    info: "ℹ",
  };

  function ensureToastStack() {
    var existing = document.querySelector(".toast-stack");
    if (existing) {
      return existing;
    }
    var stack = document.createElement("div");
    stack.className = "toast-stack";
    stack.setAttribute("role", "status");
    stack.setAttribute("aria-live", "polite");
    document.body.appendChild(stack);
    return stack;
  }

  function dismissToast(toast) {
    if (!toast || toast.dataset.dismissed === "1") {
      return;
    }
    toast.dataset.dismissed = "1";
    toast.classList.add("is-leaving");
    window.setTimeout(function () {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 200);
  }

  window.showToast = function (message, opts) {
    opts = opts || {};
    var type = opts.type || "error";
    var duration = typeof opts.duration === "number" ? opts.duration : 4200;
    var icon = TOAST_ICONS[type] || TOAST_ICONS.info;

    var stack = ensureToastStack();
    var toast = document.createElement("div");
    toast.className = "toast toast--" + type;

    var iconEl = document.createElement("span");
    iconEl.className = "toast-icon";
    iconEl.textContent = icon;

    var body = document.createElement("div");
    body.className = "toast-body";
    body.textContent = String(message == null ? "" : message);

    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "toast-close";
    closeBtn.setAttribute("aria-label", "关闭通知");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", function () {
      dismissToast(toast);
    });

    toast.appendChild(iconEl);
    toast.appendChild(body);
    toast.appendChild(closeBtn);
    stack.appendChild(toast);

    if (duration > 0) {
      window.setTimeout(function () {
        dismissToast(toast);
      }, duration);
    }
    return toast;
  };

  // 统一错误出口:context 进 console 日志,toast 文案与调用方原样一致
  // (第三参 message 可选;缺省用 error.message)
  window.showError = function (context, error, message) {
    var text =
      message != null
        ? message
        : error instanceof Error
          ? error.message
          : String(error);
    if (window.console && console.error) {
      console.error("[" + context + "]", error);
    }
    window.showToast(text, { type: "error" });
  };

  /**
   * 指标数值显示:清掉浮点噪声(0.6000000000000001 → 0.6、5.0 → 5)。
   * 精度:只改"显示",不改数值本身;大整数(seed 等)原样返回,避免
   * Number/toFixed 往返丢精度;非数值、空值原样返回。
   * @param {unknown} value 原始值(数字或字符串)
   * @param {number} [digits=6] 小数位上限
   */
  window.formatMetric = function (value, digits) {
    if (value === undefined || value === null) {
      return "";
    }
    var raw = String(value).trim();
    if (raw === "") {
      return "";
    }
    var num = Number(raw);
    if (!Number.isFinite(num)) {
      return raw;
    }
    if (Number.isInteger(num) && Math.abs(num) > 1e9) {
      return raw;
    }
    var maxDigits = Number.isFinite(digits) ? Math.max(0, Math.min(10, digits)) : 6;
    return String(Number(num.toFixed(maxDigits)));
  };

  var loadingState = new WeakMap();

  window.setButtonLoading = function (button, loading, loadingText) {
    if (!button) {
      return;
    }
    if (loading) {
      if (!loadingState.has(button)) {
        loadingState.set(button, {
          text: button.textContent,
          disabled: button.disabled,
        });
      }
      button.classList.add("is-loading");
      button.disabled = true;
      if (loadingText) {
        button.classList.remove("is-loading");
        button.textContent = loadingText;
        button.disabled = true;
      }
    } else {
      var prev = loadingState.get(button);
      if (prev) {
        button.classList.remove("is-loading");
        button.textContent = prev.text;
        button.disabled = prev.disabled;
        loadingState.delete(button);
      } else {
        button.classList.remove("is-loading");
        button.disabled = false;
      }
    }
  };

  function loraComboEscapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * 候选下拉组件(统一所有前端 LoRA / Checkpoint 等选择入口)。
   *
   * 依赖 DOM 结构(combo-box 容器):
   *   <div class="combo-box">
   *     <input type="text" autocomplete="off" />
   *     <button type="button" class="combo-toggle">▼</button>
   *     <div class="combo-menu" hidden></div>
   *   </div>
   *
   * @param {object} options
   * @param {HTMLInputElement} options.input
   * @param {HTMLElement} options.menu
   * @param {HTMLElement} options.toggle
   * @param {() => Promise<string[]> | string[]} options.getOptions 候选源(可异步)
   * @param {(value: string) => void} [options.onSelect] 选中回调
   * @param {string} [options.noun] 候选类型名,只用于提示条措辞(默认 LoRA)
   * @returns {{ open: () => void, close: () => void, destroy: () => void }}
   */
  window.aaLoraCombo = window.wfdbLoraCombo = function (options) {
    var input = options.input;
    var menu = options.menu;
    var toggle = options.toggle;
    var getOptions = options.getOptions || function () { return []; };
    var onSelect = options.onSelect || function () {};
    var noun = options.noun ? String(options.noun) : "LoRA";

    var state = { open: false, activeIndex: -1, filtered: [] };

    // 候选统一成 {value, label, state}:字符串候选 value=label、无状态;
    // 结构化候选(value/label/state)用于按远端存在性着色。与 app.js 的
    // multi combo 同一约定({key,label} 先例),两处候选源可互换。
    function normalizeOption(opt) {
      if (typeof opt === "string") {
        return { value: opt, label: opt, state: "" };
      }
      var value = String(opt && opt.value != null ? opt.value : "");
      return {
        value: value,
        label: String((opt && opt.label) || value),
        state: opt && opt.state ? String(opt.state) : "",
      };
    }

    // 状态 → class;缺失项额外带文字标记,不让颜色单独承载语义
    function optionStateClass(optState) {
      if (optState === "missing") return " is-missing";
      if (optState === "unknown") return " is-unknown";
      return "";
    }

    function optionStateFlag(optState) {
      if (optState === "missing") {
        return '<span class="combo-option-flag">远端缺失</span>';
      }
      return "";
    }

    function render(filterValue) {
      Promise.resolve(getOptions())
        .then(function (values) {
          if (!state.open) {
            return;
          }
          var norm = String(filterValue || "").trim().toLowerCase();
          var options = (values || []).map(normalizeOption);
          state.filtered = norm
            ? options.filter(function (opt) {
                return opt.label.toLowerCase().includes(norm);
              })
            : options.slice();
          if (!state.filtered.length) {
            menu.innerHTML = '<div class="combo-empty">没有匹配的 ' + noun + "</div>";
            state.activeIndex = -1;
            return;
          }
          if (state.activeIndex >= state.filtered.length) {
            state.activeIndex = 0;
          }
          // 空输入全量展示:顶部提示条(数量 + 三态计数 + 筛选方式),
          // 避免长列表无上下文;有缺失/未知项时才追加计数
          var summaryHtml = "";
          if (!norm) {
            var counts = state.filtered.reduce(
              function (acc, opt) {
                if (opt.state === "missing") acc.missing += 1;
                else if (opt.state === "unknown") acc.unknown += 1;
                return acc;
              },
              { missing: 0, unknown: 0 },
            );
            var tally = "";
            if (counts.missing) tally += " · " + counts.missing + " 个远端缺失";
            if (counts.unknown) tally += " · " + counts.unknown + " 个远端未知";
            summaryHtml =
              '<div class="combo-summary">共 ' +
              options.length +
              " 个 " +
              noun +
              tally +
              " · 输入关键词筛选</div>";
          }
          menu.innerHTML = summaryHtml + state.filtered
            .map(function (opt, index) {
              return (
                '<button class="combo-option ' +
                (index === state.activeIndex ? "is-active" : "") +
                optionStateClass(opt.state) +
                '" type="button" data-lora-option="' +
                loraComboEscapeHtml(opt.value) +
                '">' +
                loraComboEscapeHtml(opt.label) +
                optionStateFlag(opt.state) +
                "</button>"
              );
            })
            .join("");
        })
        .catch(function () {
          menu.innerHTML = '<div class="combo-empty">候选加载失败</div>';
        });
    }

    function open() {
      state.open = true;
      menu.hidden = false;
      // 聚焦打开显示全量候选;过滤交给 input 事件(避免已有值被过滤成 1 项)
      render("");
    }

    function close() {
      state.open = false;
      menu.hidden = true;
      state.activeIndex = -1;
    }

    function onInputFocus() {
      open();
    }

    function onInputChange() {
      if (state.open) {
        render(input.value);
      }
    }

    function onInputKeydown(event) {
      if (!state.open && (event.key === "ArrowDown" || event.key === "Enter")) {
        open();
        event.preventDefault();
        return;
      }
      if (!state.open || !state.filtered.length) {
        return;
      }
      if (event.key === "ArrowDown") {
        state.activeIndex = Math.min(state.activeIndex + 1, state.filtered.length - 1);
        render(input.value);
        event.preventDefault();
      } else if (event.key === "ArrowUp") {
        state.activeIndex = Math.max(state.activeIndex - 1, 0);
        render(input.value);
        event.preventDefault();
      } else if (event.key === "Enter") {
        // state.filtered 是 {value,label,state} 行 → 选中要取 value 而非整行
        var picked = state.filtered[state.activeIndex] ?? state.filtered[0];
        if (picked) {
          onSelect(picked.value);
        }
        close();
        event.preventDefault();
      } else if (event.key === "Escape") {
        close();
      }
    }

    function onToggleClick() {
      if (state.open) {
        close();
      } else {
        open();
        input.focus();
      }
    }

    function onMenuClick(event) {
      var trigger = event.target.closest("[data-lora-option]");
      if (!trigger) {
        return;
      }
      onSelect(trigger.dataset.loraOption);
      close();
    }

    function onDocumentClick(event) {
      if (!state.open) {
        return;
      }
      if (event.target.closest(".combo-box") === input.closest(".combo-box")) {
        return;
      }
      close();
    }

    input.addEventListener("focus", onInputFocus);
    input.addEventListener("input", onInputChange);
    input.addEventListener("keydown", onInputKeydown);
    if (toggle) {
      toggle.addEventListener("click", onToggleClick);
    }
    menu.addEventListener("click", onMenuClick);
    document.addEventListener("click", onDocumentClick);

    return {
      open: open,
      close: close,
      destroy: function () {
        input.removeEventListener("focus", onInputFocus);
        input.removeEventListener("input", onInputChange);
        input.removeEventListener("keydown", onInputKeydown);
        if (toggle) {
          toggle.removeEventListener("click", onToggleClick);
        }
        menu.removeEventListener("click", onMenuClick);
        document.removeEventListener("click", onDocumentClick);
      },
    };
  };
})();
