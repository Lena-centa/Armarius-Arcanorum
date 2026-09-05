/**
 * SQLite 灰测轨道 — DDL。
 *
 * 与 docs/archive/NEST_GATEWAY_MIGRATION_PLAN.md 的 Nest 迁移不同,这里不做引擎切换,
 * 而是"双端并行 + 灰测观察":Mongo 仍是唯一生产数据源,SQLite 只作为镜像。
 *
 * 设计原则(详见 SQLite 可行性研究报告):
 *  - 文档整体存 JSON1(doc_json),保证 byte-equal 校验与详情页原样读取;
 *  - 高频查询列物化(batch_key/captured_at/created_date/base_model/...);
 *  - 数组成员(images[]/loras.names[])拆子表;
 *  - FTS5 独立镜像表,只用于灰测信息对照(词级语义差异观察),不改写查询。
 */

/**
 * 数据流向(与 db.ts 的关系):
 *   openSqlite(db.ts)在打开连接后 exec 本文件的两个常量:
 *   1. SCHEMA_SQL —— 全量建表(全部 CREATE IF NOT EXISTS,新库幂等);
 *   2. 随后 db.ts 的 migrateSchema 按 PRAGMA user_version 叠加增量迁移
 *      (SCHEMA_MIGRATIONS:旧库补列),本文件是"新库全量基线",
 *      迁移是"旧库补齐",两者配合保证任意历史版本库都能打开到当前结构。
 *   写路径(sqlite/repo.ts 双写)与运维脚本(sqlite-backfill / gray-compare)
 *   通过该 schema 落地;TRUNCATE_SQL 供重灌前清空使用。
 */

/**
 * 基线建表脚本(全量 DDL)。SQL 内部用 `--` 注释分隔章节(见字符串内容),
 * 本节注释补充 JS 侧的表/列/索引语义总览。
 *
 * 常量语义:
 *  - 全部语句 CREATE ... IF NOT EXISTS,openSqlite 每次启动都会重放,
 *    靠 IF NOT EXISTS 保证幂等、无副作用;
 *  - 与 Mongo 双写的镜像表一一对应:主表存 batch 级/文档级数据,
 *    数组成员拆子表,doc_json 列保存完整原文档 JSON1 快照
 *    (byte-equal 校验与详情页原样读取的唯一可信源,物化列只是查询加速)。
 *
 * ---------------------------------------------------------------
 * 表结构总览(集合名 → 表名 → 字段语义):
 *
 * [1] images 集合 → batches 主表 + batch_images / batch_lora_names 子表
 *   batches(每行一个 batch 文档):
 *     batch_key        TEXT PK    批次唯一键(对应 Mongo 文档键)
 *     captured_at      TEXT       ISO-8601,字典序即时间序 —— 全部列表
 *                                 接口的排序键(降序索引支撑)
 *     created_date     TEXT       YYYY-MM-DD(日期区间筛选列)
 *     created_hour     INTEGER    创建小时(小时维度统计预留)
 *     created_weekday  INTEGER    创建星期几(星期维度统计预留)
 *     recipe_key       TEXT       所属配方键(recipe 聚合的关联键)
 *     batch_count      INTEGER    成员图数量
 *     base_model       TEXT       基础模型名(筛选器选项 / 精确匹配列)
 *     has_positive     INTEGER    0/1:prompts.positive 存在且非空;
 *                                 与 Mongo 查询 $nin:[null,'',[]] 同口径,
 *                                 把"有效性过滤"物化成可索引列
 *     search_text      TEXT       parser 预生成检索串(q 过滤列,
 *                                 与 FTS5 镜像表对应)
 *     doc_json         TEXT NOT NULL  原文档整体 JSON1 快照
 *   batch_images(每行一张图,batch_key 外键级联):
 *     (batch_key, resolved_path) 复合 PK;sha256 / mtime_ns / filename /
 *     image_name / captured_at 物化列(分别支撑原图定位、去重、文件名
 *     筛选);image_json 存完整 image entry(含 file / source 等)
 *   batch_lora_names((batch_key, name) 复合 PK):loras.names 数组成员
 *     展开,name 索引支撑 lora / exclude_lora 的全库筛选
 *
 * [2] stats_docs 集合 → stats_docs 主表 + stats_doc_lora_names 子表
 *   主表以 resolved_path 为 PK(单图统计缓存,每行一张图):
 *     filename / image_name(文件名筛选)、created_date(日期筛选)、
 *     has_parsed_workflow(解析成功标记)、base_model(模型筛选)、
 *     search_text(q 检索)、captured_at(排序)、doc_json(全量快照)
 *
 * [3] recipe_groups 集合 → recipe_groups 主表 + recipe_lora_names 子表
 *   主表以 recipe_key 为 PK(跨批聚合文档):
 *     count        INTEGER   聚合成员图总数
 *     batch_keys   TEXT      JSON array 字符串(全部成员批次键列表)
 *     has_positive INTEGER   首批次 prompts.positive 非空(list 过滤语义)
 *     captured_at / created_date / base_model / search_text / doc_json
 *
 * [4] stats_summaries 集合 → stats_summaries 表
 *     (kind, focus_lora) 复合 PK(kind=聚合类型,focus_lora=可空的
 *     LoRA 维度);total_docs / updated_at 物化;doc_json 快照。
 *     本表无子表、无附加索引(复合 PK 已覆盖查询路径)。
 *
 * [5] comfy_history 集合 → comfy_history 表
 *     prompt_id PK;processed_at 处理时间;doc_json 快照。
 *     由 poller 直接建表写入(无 mongoose schema)。
 *
 * [6] 标注小表(对应两个 Mongo 集合)
 *     manual_lora_prompt_labels: id(ObjectId 字符串化)PK + category /
 *       loras / name 三个筛选列(各建索引) + doc_json;
 *     prompt_annotations: id PK + doc_json(字段稀疏,仅快照)。
 *
 * [7] FTS5 虚拟表(灰测信息对照,不改写查询)
 *     fts_batches / fts_stats_docs / fts_recipe_groups:
 *     仅承载对应主表 search_text 的词级倒排镜像,用于灰度观察
 *     FTS5 与 Mongo $regex 的词级语义差异;线上查询仍走物化列。
 *
 * ---------------------------------------------------------------
 * 索引设计动机(为什么建这些索引):
 *  - 列表/摘要页全部按 captured_at 降序 → 各主表建 captured_at DESC
 *    索引(idx_*_captured_at),避免每页查询都做临时排序;
 *  - recipe 聚合需要按 recipe_key 反查成员批次 → idx_batches_recipe_key
 *    (recipe_key, captured_at DESC) 复合索引,一次定位 + 有序输出;
 *  - created_date 区间筛选与 base_model 精确匹配是列表页高频条件,
 *    独立建索引(idx_*_created_date / idx_*_base_model);
 *  - 原图/缩略图按 sha256 定位、去重按 mtime_ns、文件名/图名筛选
 *    → batch_images 上 sha256 / mtime_ns / filename / image_name 四索引;
 *  - lora 子表 name 索引:lora / exclude_lora 是全库反查(不以主键开头),
 *    无索引会退化全表扫;
 *  - has_parsed_workflow / category / loras / name 等过滤列同样物化索引。
 *
 * 外键与级联:子表 REFERENCES 父表 ON DELETE CASCADE —— 主表行删除时
 * 级联清空子表,保持镜像一致。注意:SQLite 默认不开启外键强制
 * (需 PRAGMA foreign_keys=ON 才生效),代码路径的重灌清理不依赖级联,
 * 而由 TRUNCATE_SQL 按外键依赖倒序显式 DELETE(见下方常量)。
 * ---------------------------------------------------------------
 */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- ---------------------------------------------------------------------------
-- images 集合:batch 级文档 + images[] 子表 + loras 子表
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS batches (
  batch_key       TEXT PRIMARY KEY,
  captured_at     TEXT,                -- ISO-8601,字典序即时间序
  created_date    TEXT,
  created_hour    INTEGER,
  created_weekday INTEGER,
  recipe_key      TEXT,
  batch_count     INTEGER,
  base_model      TEXT,
  has_positive    INTEGER,             -- prompts.positive 存在且非空
  search_text     TEXT,
  doc_json        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_batches_captured_at ON batches(captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_batches_recipe_key ON batches(recipe_key, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_batches_created_date ON batches(created_date DESC);
CREATE INDEX IF NOT EXISTS idx_batches_base_model ON batches(base_model);

CREATE TABLE IF NOT EXISTS batch_images (
  batch_key      TEXT NOT NULL REFERENCES batches(batch_key) ON DELETE CASCADE,
  resolved_path  TEXT NOT NULL,
  source_path    TEXT,
  filename       TEXT,
  image_name     TEXT,
  sha256         TEXT,
  mtime_ns       INTEGER,
  size_bytes     INTEGER,
  captured_at    TEXT,
  image_json     TEXT NOT NULL,
  PRIMARY KEY (batch_key, resolved_path)
);
CREATE INDEX IF NOT EXISTS idx_batch_images_sha256 ON batch_images(sha256);
CREATE INDEX IF NOT EXISTS idx_batch_images_mtime_ns ON batch_images(mtime_ns);
CREATE INDEX IF NOT EXISTS idx_batch_images_filename ON batch_images(filename);
CREATE INDEX IF NOT EXISTS idx_batch_images_image_name ON batch_images(image_name);

CREATE TABLE IF NOT EXISTS batch_lora_names (
  batch_key TEXT NOT NULL REFERENCES batches(batch_key) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  PRIMARY KEY (batch_key, name)
);
CREATE INDEX IF NOT EXISTS idx_batch_lora_name ON batch_lora_names(name);

-- ---------------------------------------------------------------------------
-- stats_docs 集合
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stats_docs (
  resolved_path       TEXT PRIMARY KEY,
  filename            TEXT,
  image_name          TEXT,
  created_date        TEXT,
  has_parsed_workflow INTEGER,
  base_model          TEXT,
  search_text         TEXT,
  captured_at         TEXT,
  doc_json            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stats_docs_created_date ON stats_docs(created_date DESC);
CREATE INDEX IF NOT EXISTS idx_stats_docs_captured_at ON stats_docs(captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_stats_docs_has_parsed ON stats_docs(has_parsed_workflow);
CREATE INDEX IF NOT EXISTS idx_stats_docs_base_model ON stats_docs(base_model);
CREATE INDEX IF NOT EXISTS idx_stats_docs_filename ON stats_docs(filename);
CREATE INDEX IF NOT EXISTS idx_stats_docs_image_name ON stats_docs(image_name);

CREATE TABLE IF NOT EXISTS stats_doc_lora_names (
  resolved_path TEXT NOT NULL REFERENCES stats_docs(resolved_path) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  PRIMARY KEY (resolved_path, name)
);
CREATE INDEX IF NOT EXISTS idx_stats_doc_lora_name ON stats_doc_lora_names(name);

-- ---------------------------------------------------------------------------
-- recipe_groups 集合
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recipe_groups (
  recipe_key   TEXT PRIMARY KEY,
  captured_at  TEXT,
  created_date TEXT,
  base_model   TEXT,
  search_text  TEXT,
  count        INTEGER,
  batch_keys   TEXT,                   -- JSON array
  has_positive INTEGER,                -- 首批次 prompts.positive 非空(list 过滤)
  doc_json     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recipe_captured_at ON recipe_groups(captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_recipe_created_date ON recipe_groups(created_date DESC);
CREATE INDEX IF NOT EXISTS idx_recipe_base_model ON recipe_groups(base_model);

CREATE TABLE IF NOT EXISTS recipe_lora_names (
  recipe_key TEXT NOT NULL REFERENCES recipe_groups(recipe_key) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  PRIMARY KEY (recipe_key, name)
);
CREATE INDEX IF NOT EXISTS idx_recipe_lora_name ON recipe_lora_names(name);

-- ---------------------------------------------------------------------------
-- stats_summaries 集合
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stats_summaries (
  kind       TEXT NOT NULL,
  focus_lora TEXT,
  total_docs INTEGER,
  updated_at TEXT,
  doc_json   TEXT NOT NULL,
  PRIMARY KEY (kind, focus_lora)
);

-- ---------------------------------------------------------------------------
-- comfy_history 集合(poller 直接建,无 mongoose schema)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS comfy_history (
  prompt_id    TEXT PRIMARY KEY,
  processed_at TEXT,
  doc_json     TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 标注小表
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS manual_lora_prompt_labels (
  id       TEXT PRIMARY KEY,          -- ObjectId 字符串化
  category TEXT,
  loras    TEXT,
  name     TEXT,
  doc_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_manual_label_category ON manual_lora_prompt_labels(category);
CREATE INDEX IF NOT EXISTS idx_manual_label_loras ON manual_lora_prompt_labels(loras);
CREATE INDEX IF NOT EXISTS idx_manual_label_name ON manual_lora_prompt_labels(name);

CREATE TABLE IF NOT EXISTS prompt_annotations (
  id       TEXT PRIMARY KEY,
  doc_json TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 标注分类(manual_label_categories):key PK + label 展示名 + doc_json 快照。
-- 默认分类随建表种子写入(INSERT OR IGNORE,幂等),用户可在标注库页增删。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS manual_label_categories (
  key      TEXT PRIMARY KEY,
  label    TEXT NOT NULL,
  doc_json TEXT NOT NULL
);
INSERT OR IGNORE INTO manual_label_categories(key, label, doc_json) VALUES
('character', '角色', '{"key":"character","label":"角色"}'),
('style', '风格', '{"key":"style","label":"风格"}'),
('concept', '概念', '{"key":"concept","label":"概念"}'),
('quality', '质量', '{"key":"quality","label":"质量"}'),
('negative', '负面', '{"key":"negative","label":"负面"}'),
('technique', '技法', '{"key":"technique","label":"技法"}');

-- ---------------------------------------------------------------------------
-- favorites 集合(图片收藏):(sha256, category) 复合 PK + doc_json 快照。
-- 一图多分类:同一张图在每个分类下至多一条收藏;category 物化为列,
-- 空串 = 未分类(参与复合键)。旧库(sha256 单列 PK)由 db.ts version 2 迁移重建。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS favorites (
  sha256   TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  doc_json TEXT NOT NULL,
  PRIMARY KEY (sha256, category)
);

-- ---------------------------------------------------------------------------
-- 收藏分类(favorite_categories):key PK + label 展示名 + doc_json 快照。
-- 默认分类随建表种子写入(INSERT OR IGNORE,幂等),用户在筛选区收藏分类处增删。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS favorite_categories (
  key      TEXT PRIMARY KEY,
  label    TEXT NOT NULL,
  doc_json TEXT NOT NULL
);
INSERT OR IGNORE INTO favorite_categories(key, label, doc_json) VALUES
('character', '人物', '{"key":"character","label":"人物"}'),
('scene', '场景', '{"key":"scene","label":"场景"}'),
('composition', '构图', '{"key":"composition","label":"构图"}'),
('color', '色彩', '{"key":"color","label":"色彩"}'),
('inspiration', '灵感', '{"key":"inspiration","label":"灵感"}'),
('inbox', '待整理', '{"key":"inbox","label":"待整理"}');

-- ---------------------------------------------------------------------------
-- Danbooru tag 补全参考(可选功能,见 docs/tag_suggest.md)
-- 导入时预计算的组推荐结果:batch_key → payload JSON
-- (tags: 单 tag 推荐 / groups: 组合推荐 / sources: 输入 tag 溯源)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS batch_tag_suggestions (
  batch_key  TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at TEXT
);

-- ---------------------------------------------------------------------------
-- FTS5 独立镜像(灰测信息对照,不改写查询)
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS fts_batches USING fts5(search_text);
CREATE VIRTUAL TABLE IF NOT EXISTS fts_stats_docs USING fts5(search_text);
CREATE VIRTUAL TABLE IF NOT EXISTS fts_recipe_groups USING fts5(search_text);
`;

/**
 * 镜像表清空(重灌前调用,按外键依赖倒序)。
 *
 * 使用场景:全量重灌 / 灰度重灌前的准备动作,由运维脚本调用。
 *
 * 为什么按"外键依赖倒序"排列:
 *  先删子表、再删父表 —— batch_lora_names / batch_images 先于 batches,
 *  stats_doc_lora_names 先于 stats_docs,recipe_lora_names 先于
 *  recipe_groups;这样即使 SQLite 外键强制未开启(默认关闭),也不会
 *  出现"父行已删、子行残留"的孤儿数据。
 *
 * 其余表的相对顺序无依赖约束:stats_summaries / comfy_history /
 * manual_lora_prompt_labels / prompt_annotations 相互独立;
 * FTS5 虚拟表放最后统一 DELETE(FTS5 默认 content 模式支持 DELETE
 * 清空行,与各主表 search_text 的重灌节奏保持一致)。
 *
 * 语义:DELETE 而非 DROP —— 保留表结构,只清数据,重灌后直接写入;
 * 对空库执行无副作用(空 DELETE 是 no-op)。
 */
export const TRUNCATE_SQL = `
DELETE FROM batch_lora_names;
DELETE FROM batch_images;
DELETE FROM batches;
DELETE FROM stats_doc_lora_names;
DELETE FROM stats_docs;
DELETE FROM recipe_lora_names;
DELETE FROM recipe_groups;
DELETE FROM stats_summaries;
DELETE FROM comfy_history;
DELETE FROM manual_lora_prompt_labels;
DELETE FROM prompt_annotations;
DELETE FROM manual_label_categories;
DELETE FROM favorites;
DELETE FROM favorite_categories;
DELETE FROM batch_tag_suggestions;
DELETE FROM fts_batches;
DELETE FROM fts_stats_docs;
DELETE FROM fts_recipe_groups;
`;
