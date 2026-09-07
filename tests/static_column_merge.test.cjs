const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(
  path.join(__dirname, "..", "workflow_db", "static", "app.js"),
  "utf8",
);
const start = source.indexOf("function renderResults");
const end = source.indexOf("async function loadDerivedSummaries", start);
assert.ok(start >= 0 && end > start, "renderResults 函数未找到");
const block = source.slice(start, end);

test("results table header has 4 data columns (select column merged into file column)", () => {
  const thead = block.match(/<thead>[\s\S]*?<\/thead>/);
  assert.ok(thead, "表头应存在");
  const thCount = (thead[0].match(/<th\b/g) || []).length;
  assert.equal(thCount, 4, "表头应为 4 数据列(选择列已并入文件概览列,尺寸列也已并入)");
  assert.match(thead[0], /width: 34%">正向 Prompt/, "正向 Prompt 列应扩到 34%");
});

test("index.css enforces 7:3 vertical ratio for positive vs negative prompts in card layout", () => {
  const indexCss = fs.readFileSync(
    path.join(__dirname, "..", "workflow_db", "static", "index.css"),
    "utf8",
  );
  assert.match(indexCss, /grid-template-rows:\s*auto\s+auto/);
  assert.match(indexCss, /\.results-table \.prompt-cell--positive[\s\S]*?max-height:\s*28em/);
  assert.match(indexCss, /\.results-table \.prompt-cell--negative[\s\S]*?max-height:\s*12em/);
});

test("balancePromptHeights balances prompt heights based on actual card space", () => {
  assert.match(source, /function balancePromptHeights/);
  assert.match(source, /posScroll \+ negScroll <= trHeight/);
  assert.match(source, /trHeight \* 0\.7/);
  assert.match(source, /trHeight \* 0\.3/);
  assert.match(source, /trHeight - negScroll/);
});

test("row template renders dims as small text under the filename", () => {
  assert.match(block, /file-dims/, "行模板应包含 file-dims 小字");
  const filenameIdx = block.indexOf("filename-cell");
  const dimsIdx = block.indexOf("file-dims");
  const batchIdx = block.indexOf("batch-summary");
  assert.ok(filenameIdx >= 0 && dimsIdx > filenameIdx, "尺寸小字应在文件名之后");
  assert.ok(batchIdx > dimsIdx, "尺寸小字应在批次摘要之前(紧贴文件名下方)");
});

test("row template drops the dimension cell entirely", () => {
  assert.ok(!/dimension-cell/.test(block), "不应再有 dimension-cell 单元格");
});

test("tag matches move below the thumbnail inside the file cell", () => {
  const thumbIdx = block.indexOf('class="thumb-wrap"');
  const tagIdx = block.indexOf("tagMatchesHtml(prompts)");
  const fileCellEnd = block.indexOf("</td>", thumbIdx);
  assert.ok(thumbIdx >= 0 && tagIdx > thumbIdx, "tag matches 应位于缩略图之后");
  assert.ok(
    fileCellEnd > tagIdx,
    "tag matches 应落在文件概览单元格内(缩略图下方)",
  );
  // 唯一一次调用(不再出现在独立的尺寸单元格中)
  assert.equal((block.match(/tagMatchesHtml\(prompts\)/g) || []).length, 1);
});

test("styles.css replaces dimension-cell with file-dims", () => {
  const css = fs.readFileSync(
    path.join(__dirname, "..", "workflow_db", "static", "styles.css"),
    "utf8",
  );
  assert.ok(!/\.dimension-cell/.test(css), "dimension-cell 样式应已移除");
  assert.match(css, /\.file-dims\s*\{/, "file-dims 样式应存在");
});

test("batch-summary is constrained to 4 lines with ellipsis", () => {
  const css = fs.readFileSync(
    path.join(__dirname, "..", "workflow_db", "static", "styles.css"),
    "utf8",
  );
  const match = css.match(/\.batch-summary\s*\{([^}]+)\}/);
  assert.ok(match, "batch-summary 样式定义应存在");
  const rules = match[1];
  assert.match(rules, /-webkit-line-clamp:\s*4/, "应限制最多 4 行 (-webkit-line-clamp: 4)");
  assert.match(rules, /overflow:\s*hidden/, "超出部分应隐藏 (overflow: hidden)");
  assert.match(rules, /text-overflow:\s*ellipsis/, "多余部分应使用省略号 (text-overflow: ellipsis)");
  assert.match(block, /class="batch-summary"\s+title=/, "模板应保留 title 属性以便悬停查看完整内容");
});

test("seedStageRows correctly resolves seed for single previewed image and only marks fixed when identical across batch", () => {
  const funcStart = source.indexOf("function seedStageRows(");
  const funcEnd = source.indexOf("function novelaiRawJsonBlock(", funcStart);
  assert.ok(funcStart >= 0 && funcEnd > funcStart, "seedStageRows 函数未找到");
  const funcCode = source.slice(funcStart, funcEnd);

  const vm = require("node:vm");
  const ctx = {
    state: { previewItem: { images: [{ filename: "a.png" }, { filename: "b.png" }] } },
    samplerStageLabel: () => "阶段 1",
    linkValueText: (v) => String(v),
    escapeHtml: (s) => String(s),
    previewDetailRow: (label, val) => `<div class="row">${label}:${val}</div>`,
  };
  vm.runInNewContext(`${funcCode}; this.seedStageRows = seedStageRows;`, ctx);
  const { seedStageRows } = ctx;

  // Case 1: Recipe group with different seeds per image (e.g. member 0: 624833582555828, member 1: 975956295808038)
  const samplers = [{ seed: 624833582555828 }];
  const item = {
    batch: { count: 2, seeds: [624833582555828, 975956295808038] },
    recipe: {
      members: [
        { seeds: [624833582555828] },
        { seeds: [975956295808038] },
      ],
    },
  };
  const html0 = seedStageRows(samplers, null, 0, item);
  const html1 = seedStageRows(samplers, null, 1, item);
  assert.match(html0, /624833582555828/, "第 0 张图应匹配 seed 624833582555828");
  assert.ok(!html0.includes("固定"), "多 seed 批次第 0 张图不应标为固定");
  assert.match(html1, /975956295808038/, "第 1 张图应匹配 seed 975956295808038");
  assert.ok(!html1.includes("固定"), "多 seed 批次第 1 张图不应标为固定");

  // Case 2: Batch with truly fixed seed
  const fixedItem = {
    batch: { count: 2, seeds: [12345] },
  };
  const htmlFixed = seedStageRows([{ seed: 12345 }], null, 0, fixedItem);
  assert.match(htmlFixed, /12345/);
  assert.ok(htmlFixed.includes("固定"), "全批共享单一 seed 应标为固定");
});

test("imagePreviewMeta is constrained to 2 lines with ellipsis and toggleable expansion", () => {
  const css = fs.readFileSync(
    path.join(__dirname, "..", "workflow_db", "static", "styles.css"),
    "utf8",
  );
  assert.match(css, /#imagePreviewMeta\s*\{[^}]*-webkit-line-clamp:\s*2/);
  assert.match(css, /#imagePreviewMeta\s*\{[^}]*overflow:\s*hidden/);
  assert.match(css, /#imagePreviewMeta\.is-expanded\s*\{[^}]*-webkit-line-clamp:\s*unset/);
});

test("syncPreviewView formats imagePreviewMeta placing seeds at the very end", () => {
  const funcStart = source.indexOf("function syncPreviewView(");
  const funcEnd = source.indexOf("async function loadPreviewDerived(", funcStart);
  assert.ok(funcStart >= 0 && funcEnd > funcStart, "syncPreviewView 函数未找到");
  const funcCode = source.slice(funcStart, funcEnd);

  const vm = require("node:vm");
  const metaElem = { textContent: "", title: "" };
  const titleElem = { textContent: "" };
  const mockModal = { hidden: false };
  const mockImage = { setAttribute: () => {}, removeAttribute: () => {}, style: {} };
  const mockBody = { classList: { remove: () => {} } };

  const ctx = {
    document: {
      getElementById: (id) => {
        if (id === "imagePreviewModal") return mockModal;
        if (id === "imagePreviewImg") return mockImage;
        if (id === "imagePreviewBody") return mockBody;
        if (id === "imagePreviewTitle") return titleElem;
        if (id === "imagePreviewMeta") return metaElem;
        return { style: {}, classList: { toggle: () => {} } };
      },
      body: { classList: { add: () => {}, remove: () => {} } },
    },
    formatCapturedAt: () => "2026-08-17 23:14",
    renderPreviewStrip: () => {},
    renderPreviewDetails: () => {},
    renderPreviewStage: () => {},
    loadPreviewDerived: () => {},
    syncFavoriteStars: () => {},
    getActiveWorkflowData: () => null,
    fetchJson: () => Promise.resolve({}),
    apiUrl: (url) => url,
    state: {
      previewIndex: 0,
      previewItem: {
        images: [{ filename: "ComfyUI_06990_.png", resolved_path: "D:\\example\\issues\\0817\\ComfyUI_06990_.png", sha256: "abc" }],
        item: {
          captured_at: 1723907640,
          samplers: [{}, {}, {}],
          batch: {
            count: 1,
            batch_count: 1,
            seeds: ["351933138679982", "975956295808038", "767734512190112"],
          },
          recipe: {
            batch_count: 1,
          },
        },
      },
    },
  };

  vm.runInNewContext(`${funcCode}; this.syncPreviewView = syncPreviewView;`, ctx);
  ctx.syncPreviewView();

  const expectedEnding = "第 1 / 1 张 · 种子 351933138679982 / 975956295808038 / 767734512190112";
  assert.ok(metaElem.textContent.endsWith(expectedEnding), `imagePreviewMeta 应以 [${expectedEnding}] 结尾，实际为 [${metaElem.textContent}]`);
});



