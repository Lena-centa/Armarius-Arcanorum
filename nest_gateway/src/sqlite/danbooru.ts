/**
 * Danbooru tag 补全参考 —— SQLite 查表层(danbooru/danbooru.sqlite3)。
 *
 * 设计原则(与方案 v10 一致):
 *   - 网关运行时零 ML、零嵌入常驻 —— 全部查询走 SQLite 纯查表;
 *   - 查表键层双向归一:输入 `blonde hair`(空格,用户 prompt 主流写法)
 *     归一为词表规范形 `blonde_hair`(下划线);展示/回填由前端用空格形式;
 *   - 转义:前缀联想用范围扫描(tag >= ? AND tag < ?),天然免疫
 *     `_`/`%`/`\` LIKE 通配符(tag 名 85.6% 含下划线);
 *   - 多语言:tag_alias 表(103,571 个去重小写别名,含 CJK)先于字面查询,
 *     精确命中 → 规范 tag;CJK 前缀作为二级兜底;
 *   - 单 tag 索引:LLR 邻居(edges)与 GNN 最近邻(tag_gnn_nn)RRF 融合,
 *     按语义类别分组返回(tag_category 表:角色/背景/环境/特征子类/构图);
 *     角色/条目特征走 wiki_traits 配图投票(权威),共现词形规则兜底。
 *
 * 资产由 tools/build_danbooru_db.py 一次性构建;文件缺失时 openDanbooru
 * 返回 null,调用方(controller)对空响应,前端空即隐藏 —— 全程静默降级。
 */
import { existsSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { REPO_ROOT } from '../config';

/** danbooru 库默认位置(env DANBOORU_DB_PATH 未配置时的自动探测路径)。 */
export const DEFAULT_DANBOORU_DB = join(
  REPO_ROOT,
  'danbooru',
  'danbooru.sqlite3',
);

/** 依赖注入 token:danbooru 只读连接(可能为 null)。定义在此避免
 *  controller↔module 循环导入(module 与 controller 均从这里导入)。 */
export const DANBOORU_DB = Symbol('DANBOORU_DB');

/** 单个 tag 条目(联想 / 推荐共用)。 */
export interface DanbooruTag {
  name: string;
  tag_type: string | null;
  count: number | null;
  /** 命中方式:tag-prefix | alias-exact | alias-prefix | substring */
  source?: string;
  /** 别名来源标注(alias-exact / alias-prefix 时):用户输入的别名原样 */
  alias?: string;
  /** 中文翻译(该 tag 最高频的含汉字别名;无则缺省) */
  zh?: string;
  /** wiki 实际验证条目(has_wiki=1) */
  has_wiki?: number | null;
  score?: number;
}

/** wiki 配图投票特征条目。 */
export interface WikiTraitTag extends DanbooruTag {
  /** wiki 参考图(编辑人工挑选)中携带该 tag 的图数 */
  vote?: number;
  /** 其中 official_art 图的数量(官方立绘/设定,可靠性信号) */
  vote_official?: number;
}

/**
 * 角色/条目特征(两部分设计的第一部分,力求权威可靠):
 * 仅来自 wiki_traits 表 = wiki 参考图(!post #id,编辑人工挑选)实际携带
 * 的 tag 投票,条目数量不定值(有多少张参考图就聚合多少),排序 official
 * 优先、vote 次之;不做共现估计兜底(非 wiki 来源一律不进特征区)。
 * rows 按语义类别分组(发色/发型/瞳色/服饰/...),展示顺序由前端控制。
 */
export interface CharacterTraits {
  rows: Array<{ category: string; items: WikiTraitTag[] }>;
}

/** /api/tag-related 响应:混合推荐 + 语义分类分组索引。 */
export interface RelatedResult {
  tag: DanbooruTag | null;
  related: DanbooruTag[];
  /** 按语义类别分组的推荐(角色/背景/环境/特征子类/构图/...),键序即展示序 */
  categories: Record<string, DanbooruTag[]>;
  /** 主 tag(仅 character 类型)的权威特征(wiki 配图实际条目,数量不定值);
   *  非 character 类型或无 wiki 数据时缺省 */
  traits?: CharacterTraits;
}

/** 输入归一化:小写 + 剥转义反斜杠 + 空格→下划线(查表键层,不碰原文)。 */
export function normTagKey(value: string): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\\/g, '')
    .replace(/\s+/g, '_');
}

/** A1111/ComfyUI 引用块(`<lora:x:1>` / `<embedding:x>`),非 tag 引用。 */
const ANGLE_BLOCK = /<[^<>]{1,120}>/g;

/**
 * 输入分词(L1 语法清洗):剥 `<...>` 引用块 → 按逗号/换行切段 → 取末段。
 * 联想/单 tag 查询语义均为"正在输入的部分";段内空格是 tag 的显示形式
 * (如 `hassan of serenity (fate)`),不切分 —— 前缀扫描天然容忍未闭合
 * 的消歧括号,权重/强调外壳由 tagKeyCandidates 候选链兜底。
 */
export function promptLastSegment(value: string): string {
  const cleaned = String(value ?? '').replace(ANGLE_BLOCK, ' ');
  const segments = cleaned
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return segments[segments.length - 1] ?? '';
}

/** CJK 判定(别名前缀兜底只对非 ASCII 输入启用,ASCII 前缀歧义爆炸)。 */
function isCjk(value: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/.test(value);
}

/** 打开 danbooru 库;路径不存在或核心表缺失时返回 null(静默降级)。 */
export function openDanbooru(dbPath: string): Database.Database | null {
  const resolved = dbPath && dbPath.trim() ? dbPath.trim() : DEFAULT_DANBOORU_DB;
  if (!existsSync(resolved)) {
    return null;
  }
  try {
    const db = new Database(resolved, { readonly: true });
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN ('tags', 'tag_alias')`,
      )
      .all() as Array<{ name: string }>;
    if (tables.length < 2) {
      db.close();
      return null;
    }
    // IP→角色索引后台预热(冷缓存全表扫描 ~1-4s,setImmediate 在
    // 事件循环空闲时执行;module init 早于 HTTP listen,预热通常
    // 在开始受理请求前完成,首个 IP 搜索即走内存索引)。
    // WeakMap 按连接去重,重复调用零开销。
    setImmediate(() => {
      try {
        getIpCharIndex(db);
      } catch {
        /* 预热失败不阻塞启动;首次搜索会再试 */
      }
    });
    return db;
  } catch {
    return null;
  }
}

/**
 * 共享连接缓存:resolved 路径 → 连接(或 null,失败结果同样缓存)。
 * 多个消费方(tags / images 模块 provider、parse worker 归属注入)
 * 复用同一只读连接 —— IpCharIndex 内存索引按连接 WeakMap 缓存,
 * 共享连接意味着全进程只构建一次索引。
 */
const sharedByPath = new Map<string, Database.Database | null>();

/** 取(或首次打开)共享 danbooru 只读连接;路径不存在/核心表缺失 → null。 */
export function sharedDanbooru(dbPath: string): Database.Database | null {
  const resolved =
    dbPath && dbPath.trim() ? dbPath.trim() : DEFAULT_DANBOORU_DB;
  if (!sharedByPath.has(resolved)) {
    sharedByPath.set(resolved, openDanbooru(resolved));
  }
  return sharedByPath.get(resolved)!;
}

/** tags 表按 id 批量取条目。 */
function tagsById(
  db: Database.Database,
  ids: number[],
): Map<number, DanbooruTag> {
  const out = new Map<number, DanbooruTag>();
  if (!ids.length) return out;
  const rows = db
    .prepare(
      `SELECT id, name, tag_type, count, has_wiki FROM tags WHERE id IN (${ids
        .map(() => '?')
        .join(',')})`,
    )
    .all(...ids) as Array<{ id: number; name: string; tag_type: string | null; count: number | null; has_wiki: number | null }>;
  for (const r of rows) out.set(r.id, { name: r.name, tag_type: r.tag_type, count: r.count, has_wiki: r.has_wiki });
  return out;
}

/** 语义分组展示顺序 + 每组上限(与前端 app.js 的渲染顺序对齐)。 */
const CATEGORY_ORDER = [
  'character', 'copyright', 'composition', 'background', 'environment',
  'hair_color', 'hair_style', 'eyes', 'clothing', 'accessories',
  'expression', 'body', 'action', 'other', 'artist', 'meta',
];
const CATEGORY_CAPS: Record<string, number> = {
  character: 8, copyright: 5, composition: 5, background: 4, environment: 4,
  hair_color: 4, hair_style: 4, eyes: 4, clothing: 5, accessories: 4,
  expression: 4, body: 4, action: 4, other: 6, artist: 3, meta: 3,
};

/** wiki_traits 特征区的语义类别白名单与顺序:仅外观特征
 *  (发色/发型/瞳色/服饰/配饰/表情/身体/动作/其他)。wiki 配图上的
 *  角色/作品/画师 tag(同图出现的其他角色等)与构图/背景/环境不是
 *  "角色外观特征",混入会与分类推荐区语义重复,一律不进特征区。 */
const TRAIT_CATEGORY_ORDER = [
  'hair_color', 'hair_style', 'eyes', 'clothing', 'accessories',
  'expression', 'body', 'action', 'other',
];

/** 批量查语义分类;tag_category 表缺失时返回空 Map(调用方降级到 tag_type)。 */
function categoriesById(
  db: Database.Database,
  ids: number[],
): Map<number, string> {
  const out = new Map<number, string>();
  if (!ids.length) return out;
  try {
    const rows = db
      .prepare(
        `SELECT tag_id, category FROM tag_category
         WHERE tag_id IN (${ids.map(() => '?').join(',')})`,
      )
      .all(...ids) as Array<{ tag_id: number; category: string }>;
    for (const r of rows) out.set(r.tag_id, r.category);
  } catch {
    // 表缺失(旧库未 patch)→ 空 Map,调用方按 tag_type 降级
  }
  return out;
}

/**
 * wiki 官方特征(权威来源,仅角色 tag 调用):wiki_traits 表 = wiki 页
 * 参考图(!post #id,编辑人工挑选)实际携带的 tag 投票。条目数量不定值:
 * 凡 wiki 参考图中出现的(vote ≥1)全量保留,排序 official 优先、vote 次之。
 * 表缺失或无参考图数据 → undefined(不做共现估计兜底)。
 */
function wikiTraits(
  db: Database.Database,
  tagId: number,
): CharacterTraits | undefined {
  let rows: Array<{
    id: number; vote: number; vote_official: number;
    category: string | null; tag_type: string | null;
  }>;
  try {
    rows = db
      .prepare(
        `SELECT w.trait_id AS id, w.vote, w.vote_official, c.category, t.tag_type
         FROM wiki_traits w
         JOIN tags t ON t.id = w.trait_id
         LEFT JOIN tag_category c ON c.tag_id = w.trait_id
         WHERE w.tag_id = ?`,
      )
      .all(tagId) as typeof rows;
  } catch {
    return undefined; // 表缺失(旧库未 patch)
  }
  // 凡 wiki 参考图中实际出现的条目(vote ≥1)全量保留,数量不定值;
  // 仅 general tag 可作外观特征(同图的角色/作品/画师/meta tag 与
  // 主角外观无关,在查询层排除,防止无分类条目经 'other' 兜底漏入);
  // vote_official 是排序信号(官方立绘优先),不做过滤门槛
  const reliable = rows.filter((r) => (r.vote ?? 0) >= 1 && r.tag_type === 'general');
  if (!reliable.length) return undefined;
  const map = tagsById(db, reliable.map((r) => r.id));
  const zhMap = zhByTagIds(db, reliable.map((r) => r.id));
  const buckets = new Map<string, WikiTraitTag[]>();
  for (const r of reliable) {
    const t = map.get(r.id);
    if (!t) continue;
    const category = r.category ?? 'other';
    if (!buckets.has(category)) buckets.set(category, []);
    const item: WikiTraitTag = {
      ...t,
      vote: r.vote ?? 0,
      vote_official: r.vote_official ?? 0,
      ...(zhMap.has(r.id) ? { zh: zhMap.get(r.id) } : {}),
    };
    buckets.get(category)!.push(item);
  }
  // 不定值:每类有多少 wiki 条目就返回多少,不截断;仅排序 official 优先
  const rowsOut: Array<{ category: string; items: WikiTraitTag[] }> = [];
  for (const c of TRAIT_CATEGORY_ORDER) {
    const bucket = buckets.get(c);
    if (!bucket?.length) continue;
    bucket.sort(
      (a, b) => (b.vote_official ?? 0) - (a.vote_official ?? 0)
        || (b.vote ?? 0) - (a.vote ?? 0),
    );
    rowsOut.push({ category: c, items: bucket });
  }
  if (!rowsOut.length) return undefined;
  return { rows: rowsOut };
}

/**
 * 结构化角色特征(权威来源,仅角色 tag 调用):character_profile 表 =
 * MIT 数据集 Sn0w123/booru-characters 的角色档案(characteristics /
 * clothing / gender / copyright,干净的结构化 tag,无 wiki 配图投票噪声)。
 * 与 wikiTraits 返回同一 CharacterTraits 结构(字段级兼容):
 * 每个 tag 经 tag_category 归类分组,gender 归 body、copyright 归
 * copyright,中文翻译经 zhByTagIds 补齐。表缺失或该角色无档案 → undefined
 * (调用方回退 wikiTraits)。
 */
function characterProfile(
  db: Database.Database,
  tagId: number,
): CharacterTraits | undefined {
  let row: {
    gender: string | null;
    characteristics: string | null;
    clothing: string | null;
    copyright: string | null;
  } | undefined;
  try {
    row = db
      .prepare(
        `SELECT gender, characteristics, clothing, copyright
         FROM character_profile WHERE tag_id = ?`,
      )
      .get(tagId) as typeof row;
  } catch {
    return undefined; // 表缺失(旧库未 patch)
  }
  if (!row) return undefined;

  const nameGroups: Array<[string, string]> = [];
  const pushJson = (key: string, raw: string | null) => {
    if (!raw) return;
    try {
      for (const nm of JSON.parse(raw) as string[]) {
        if (typeof nm === 'string' && nm.trim()) nameGroups.push([nm, key]);
      }
    } catch {
      /* 坏 JSON → 忽略该列 */
    }
  };
  pushJson('gender', row.gender);
  pushJson('characteristics', row.characteristics);
  pushJson('clothing', row.clothing);
  pushJson('copyright', row.copyright);
  if (!nameGroups.length) return undefined;

  // tag 名 → id (character profile 存的是 tag 名,需回查 tags)
  const names = [...new Set(nameGroups.map(([n]) => n))];
  const idByName = new Map<string, number>();
  for (const nm of names) {
    const idRow = db
      .prepare(`SELECT id FROM tags WHERE name = ?`)
      .get(nm) as { id: number } | undefined;
    if (idRow) idByName.set(nm, idRow.id);
  }
  const ids = names
    .filter((n) => idByName.has(n))
    .map((n) => idByName.get(n)!);
  if (!ids.length) return undefined;

  const map = tagsById(db, ids);
  const catMap = categoriesById(db, ids);
  const zhMap = zhByTagIds(db, ids);
  const buckets = new Map<string, WikiTraitTag[]>();
  for (const [nm, sourceKey] of nameGroups) {
    const tid = idByName.get(nm);
    if (tid === undefined) continue;
    const t = map.get(tid);
    if (!t) continue;
    const category =
      sourceKey === 'gender' ? 'body' : (catMap.get(tid) ?? 'other');
    // 收敛到输出白名单:tag_category 可能返回 copyright/meta 等不在
    // TRAIT_CATEGORY_ORDER 的桶(白名单仅 9 个外观类别,见上),此类条目
    // 否则永不呈现 → 统一落入 'other' 兜底桶
    const bucket = TRAIT_CATEGORY_ORDER.includes(category)
      ? category
      : 'other';
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket)!.push({
      ...t,
      ...(zhMap.has(tid) ? { zh: zhMap.get(tid) } : {}),
    });
  }
  const rowsOut: Array<{ category: string; items: WikiTraitTag[] }> = [];
  for (const c of TRAIT_CATEGORY_ORDER) {
    const bucket = buckets.get(c);
    if (!bucket?.length) continue;
    rowsOut.push({ category: c, items: bucket });
  }
  if (!rowsOut.length) return undefined;
  return { rows: rowsOut };
}

/**
 * 中文翻译(zh):取每个 tag 最靠前的"含汉字"别名,作搜索提示的翻译展示。
 * tag_alias 源自 Danbooru wiki other_names,混有日/韩文与事件名等噪音:
 * 两阶段选取 —— 先取纯汉字别名(无假名,最接近中文翻译),没有再放宽到
 * 含汉字混写(如"初音ミク");纯假名/谚文行被汉字条件自然排除。
 * 排序依据 pos(别名在 other_names 列表中的位置,常见译名靠前):
 * freq 在同 tag 内恒为 tag count,无区分度,不能用。
 */
function zhByTagIds(
  db: Database.Database,
  ids: number[],
): Map<number, string> {
  const out = new Map<number, string>();
  if (!ids.length) return out;
  const rows = db
    .prepare(
      `SELECT tag_id, alias FROM tag_alias
       WHERE tag_id IN (${ids.map(() => '?').join(',')})
       ORDER BY pos ASC, alias ASC`,
    )
    .all(...ids) as Array<{ tag_id: number; alias: string }>;
  const usable = rows
    .map((r) => ({ tag_id: r.tag_id, alias: r.alias.trim() }))
    .filter((r) => r.alias && r.alias.length <= 16);
  const hanOnly = usable.filter((r) => /^[\u4e00-\u9fff]+$/.test(r.alias));
  const mixed = usable.filter((r) => /[\u4e00-\u9fff]/.test(r.alias));
  for (const r of [...hanOnly, ...mixed]) {
    if (out.has(r.tag_id)) continue;
    out.set(r.tag_id, r.alias);
  }
  return out;
}

/**
 * 查表键候选链:原键 + 逐层剥壳变体。prompt 里 tag 常带 ComfyUI 语法外壳
 * (权重 `(x:1.2)`、花括号强调 `{{x}}`、方括号 `[x]`、NovelAI 前缀
 * `copyright: x`),剥壳后的规范形才是词表里的 tag;每个变体再经
 * normTagKey 归一(含剥转义反斜杠),按原键→逐层剥壳的顺序去重。
 */
function tagKeyCandidates(key: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [key];
  const pushInner = (v: string) => {
    // 剥壳提取的内容可能残留归一化产生的首尾下划线(如 `copyright: x` → `_x`)
    queue.push(v.replace(/^_+|_+$/g, ''));
  };
  while (queue.length) {
    const cur = queue.shift()!;
    const norm = normTagKey(cur);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
    const weight = norm.match(/^\((.+):[\d.,\s]+\)$/);
    if (weight) pushInner(weight[1]);
    let inner = norm;
    while (inner.startsWith('{') && inner.endsWith('}') && inner.length >= 2) {
      inner = inner.slice(1, -1);
    }
    if (inner !== norm) pushInner(inner);
    const bracket = norm.match(/^\[(.+)\]$/);
    if (bracket) pushInner(bracket[1]);
    const paren = norm.match(/^\((.+)\)$/);
    if (paren) pushInner(paren[1]);
    const prefix = norm.match(/^(rating|copyright|artist|character|quality|general):(.+)$/);
    if (prefix) pushInner(prefix[2]);
    // 残缺形态(2026-08-19 用户场景):尾部残留标点 `hina (blue archive):` 的
    // 悬停窗口、`name (source): desc` 的描述尾巴 —— 剥掉后才是词表规范形;
    // 要求带 `):` 边界,不会误伤 `animal_crossing:_new_horizons`(无括号)
    // 与 NovelAI `copyright: x` 前缀(无括号)。
    const trailing = norm.replace(/[:;,\)\]]+$/, '');
    if (trailing !== norm) pushInner(trailing);
    const descTail = norm.match(/^(.+\([^()]*\)):_(.+)$/);
    if (descTail) pushInner(descTail[1]);
  }
  return out;
}

/**
 * 别名/字面查询 → 候选 tag id 列表(按 freq 降序,最多 3 个)。
 * 顺序:别名精确 → tag 名精确 → CJK 别名前缀;原键 miss 后沿剥壳候选链
 * 重试,剥壳命中 source 追加 `-norm` 便于排查。
 */
function resolveTagIds(
  db: Database.Database,
  raw: string,
): { ids: number[]; source: string } {
  const key = normTagKey(raw);
  if (!key) return { ids: [], source: 'none' };

  for (const [i, candidate] of tagKeyCandidates(key).entries()) {
    const aliasExact = db
      .prepare(
        `SELECT tag_id FROM tag_alias WHERE alias = ? ORDER BY freq DESC LIMIT 3`,
      )
      .all(candidate) as Array<{ tag_id: number }>;
    if (aliasExact.length) {
      return {
        ids: aliasExact.map((r) => r.tag_id),
        source: i ? 'alias-exact-norm' : 'alias-exact',
      };
    }
    const nameExact = db
      .prepare(`SELECT id FROM tags WHERE name = ? LIMIT 1`)
      .get(candidate) as { id: number } | undefined;
    if (nameExact) {
      return { ids: [nameExact.id], source: i ? 'tag-exact-norm' : 'tag-exact' };
    }
    if (isCjk(candidate)) {
      const aliasPrefix = db
        .prepare(
          `SELECT tag_id FROM tag_alias
           WHERE alias >= ? AND alias < ? COLLATE NOCASE
           GROUP BY tag_id ORDER BY MAX(freq) DESC LIMIT 5`,
        )
        .all(candidate, `${candidate}\uffff`) as Array<{ tag_id: number }>;
      if (aliasPrefix.length) {
        return {
          ids: aliasPrefix.map((r) => r.tag_id),
          source: i ? 'alias-prefix-norm' : 'alias-prefix',
        };
      }
    }
  }

  // ---- 括号不敏感兜底:输入剥括号后查 name_pc 列 ----
  // 词表 tag 名带消歧括号(如 hina_(blue_archive)),而句子/窗口输入经
  // 词切分后括号丢失(`hina blue archive`)——name_pc(构建期剥括号列)
  // 让两条路径在括号维度上对齐。112,283 个 tag 剥括号后仅 5 对冲突,
  // 冲突时 character 类型优先、count 决胜。
  const pcKey = key.replace(/[()]/g, '');
  if (pcKey && pcKey !== key) {
    try {
      const row = db
        .prepare(
          `SELECT id FROM tags
           WHERE name_pc = ?
           ORDER BY CASE WHEN tag_type = 'character' THEN 0 ELSE 1 END,
                    count DESC LIMIT 1`,
        )
        .get(pcKey) as { id: number } | undefined;
      if (row) return { ids: [row.id], source: 'paren-norm' };
    } catch {
      // 旧库无 name_pc 列(未 patch)→ 跳过
    }
  }

  // ---- 截断前缀兜底(character 限定)----
  // prompt 截断(`hina (blue arch`)或半成品输入:词表内字符前缀扫描。
  // 裸短名(无括号且 <6 字符,如 `hina`)歧义大(hinanawi_tenshi 等同样
  // 以 hina 开头),不做 —— 宁缺毋错,由用户补充来源。
  if (key.includes('(') || key.length >= 6) {
    const prefix = db
      .prepare(
        `SELECT id, name FROM tags
         WHERE name >= ? AND name < ? AND tag_type = 'character'
         ORDER BY count DESC LIMIT 3`,
      )
      .all(key, `${key}\uffff`) as Array<{ id: number; name: string }>;
    if (prefix.length) return { ids: [prefix[0].id], source: 'prefix' };
  }
  return { ids: [], source: 'none' };
}

/** RRF 融合:list 内 rank i 贡献 1/(60+i)。 */
function rrfMerge(
  lists: Array<Array<{ id: number; score: number }>>,
): Map<number, number> {
  const acc = new Map<number, number>();
  for (const list of lists) {
    list.forEach((item, i) => {
      acc.set(item.id, (acc.get(item.id) ?? 0) + 1 / (60 + i));
    });
  }
  return acc;
}

/** 子序列窗口的词数上限(词表 tag 最多约 5 个下划线词,留余量)。 */
const SENTENCE_MAX_WORDS = 6;

/**
 * 句子识别(子序列词表匹配):自然语言句子 → 词表 tag。
 * 按非字母数字切词,生成全部连续子序列(≤SENTENCE_MAX_WORDS 词)下划线
 * 连接,一次 IN 查询词表;命中按"词数降序、count 降序"排序 —— 长序列
 * 优先,天然免疫停用词(the/is 不在词表)与零碎泛词。零常驻、毫秒级。
 */
function sentenceMatch(
  db: Database.Database,
  text: string,
  limit = 5,
): Array<DanbooruTag & { id: number }> {
  const words = String(text)
    .toLowerCase()
    .match(/[a-z0-9]+/g);
  if (!words?.length) return [];
  const keys = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    const upper = Math.min(words.length, i + SENTENCE_MAX_WORDS);
    for (let end = i + 1; end <= upper; end++) {
      keys.add(words.slice(i, end).join('_'));
    }
  }
  if (!keys.size) return [];
  const keyList = [...keys];
  const rows = db
    .prepare(
      `SELECT id, name, tag_type, count FROM tags
       WHERE name IN (${keyList.map(() => '?').join(',')})`,
    )
    .all(...keyList) as Array<{ id: number; name: string; tag_type: string | null; count: number | null }>;
  // 括号免疫:句子词切分剥掉括号(`manhattan cafe (umamusume)` → 子序列键
  // manhattan_cafe_umamusume),而词表规范形带消歧括号 —— 同键再查
  // name_pc(构建期剥括号键)列,把句子键对齐到带括号 tag(如
  // manhattan_cafe_(umamusume))。旧库无该列 → catch 跳过,行为不变。
  try {
    const pcRows = db
      .prepare(
        `SELECT id, name, tag_type, count FROM tags
         WHERE name_pc IN (${keyList.map(() => '?').join(',')})`,
      )
      .all(...keyList) as typeof rows;
    const seen = new Set(rows.map((r) => r.id));
    for (const r of pcRows) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        rows.push(r);
      }
    }
  } catch {
    // 旧库未 patch(无 name_pc 列)
  }
  const wordCount = (name: string) => name.split('_').length;
  rows.sort(
    (a, b) => wordCount(b.name) - wordCount(a.name) || (b.count ?? 0) - (a.count ?? 0),
  );
  return rows.slice(0, limit).map((r) => ({ ...r, source: 'sentence' }));
}

/** 来源约束的编辑距离模糊角色匹配(最后兜底档)。
 *
 * 场景:输入是词表外角色名变体/错字(`rossi (arknights)` 在词表扩展后
 * 已精确命中,此处兜底真正的别名外变体/错字)。规则(2026-08-19 实测):
 *   1. 提取输入的 (来源) 组,必须是词表内 copyright tag —— 无来源提示
 *      的裸名歧义大(`rossi` 无约束时命中 rosa_(pokemon)),不做;
 *   2. 候选 = 该作品下全部 character tag(剥掉各自的 (来源) 尾巴);
 *   3. LD ≤ 2 且首位严格优于次席 → 锁定(前端 fuzzy 徽标);并列不锁定。
 */
const LD_MAX = 2;

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const prev = new Uint16Array(n + 1);
  const cur = new Uint16Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return prev[n];
}

function fuzzyCharacterMatch(
  db: Database.Database,
  raw: string,
): { id: number } | null {
  // 基名:剥描述尾巴(`name (source): desc` 取冒号前)与全部 (组);
  // 无括号组或基名过短 → 不做(歧义/非角色形态)
  const head = raw.split(':')[0];
  const base = head
    .replace(/\([^()]*\)/g, '')
    .replace(/[^a-z0-9_]+/g, '')
    .toLowerCase();
  const sources = [...head.matchAll(/\(([^()]*)\)/g)].map((m) => m[1].trim());
  if (!base || base.length < 2 || !sources.length) return null;
  // 来源组必须是词表 copyright tag(约束锚点)
  const srcKey = sources[sources.length - 1];
  const srcTag = db
    .prepare(
      `SELECT id FROM tags WHERE name = ? AND tag_type = 'copyright' LIMIT 1`,
    )
    .get(normTagKey(srcKey)) as { id: number } | undefined;
  if (!srcTag) return null;
  const escaped = srcKey.replace(/[\\%_]/g, (m) => `\\${m}`);
  const cand = db
    .prepare(
      `SELECT id, name, count FROM tags
       WHERE tag_type = 'character' AND name LIKE ?`,
    )
    .all(`%(${escaped})%`) as Array<{ id: number; name: string; count: number | null }>;
  const scored: Array<{ id: number; d: number; count: number }> = [];
  for (const c of cand) {
    const cb = c.name.replace(/\([^()]*\)+$/g, '').replace(/_+$/g, '');
    const d = levenshtein(base, cb);
    if (d <= LD_MAX) scored.push({ id: c.id, d, count: c.count ?? 0 });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => a.d - b.d || b.count - a.count);
  // 同距离并列 → 按帖数(流行度)决胜:来源约束已把候选限定在同一作品内,
  // 作品内歧义由流行度消解(`rosi` → rossi 1911 帖 vs rosa 878 帖);
  // 跨作品歧义(裸名无来源)在入口已排除,不会误锁其它作品角色
  return { id: scored[0].id };
}

/** 邻居查询(LLR 与 GNN 各取 top-n),返回带原始排序分的 id 列表。 */
function neighborLists(
  db: Database.Database,
  tagId: number,
  n: number,
): [Array<{ id: number; score: number }>, Array<{ id: number; score: number }>] {
  const llr = (
    db
      .prepare(
        `SELECT dst_id AS id, llr AS score FROM edges
         WHERE src_id = ? ORDER BY llr DESC LIMIT ?`,
      )
      .all(tagId, n) as Array<{ id: number; score: number }>
  );
  const gnn = (
    db
      .prepare(
        `SELECT nn_id AS id, cos AS score FROM tag_gnn_nn
         WHERE tag_id = ? ORDER BY cos DESC LIMIT ?`,
      )
      .all(tagId, n) as Array<{ id: number; score: number }>
  );
  return [llr, gnn];
}

/**
 * /api/tag-related 核心:别名/字面解析 → LLR+GNN 邻居 RRF 融合。
 * 返回混合 top-k(related)、语义分类分组(categories)与权威特征
 * (traits,wiki 配图投票优先、共现词形规则兜底)。
 */
/**
 * 同作品角色兜底:词表外新增角色(rossi_(arknights) 等)没有 LLR/GNN
 * 邻居(无嵌入/共现记录),按主 tag 名的 `(franchise)` 后缀取同作品角色,
 * count 降序。仅当邻居融合为空时使用;source 标注 franchise。
 */
function franchiseCharacters(
  db: Database.Database,
  mainId: number,
  limit: number,
): DanbooruTag[] {
  const main = db
    .prepare(`SELECT name, tag_type FROM tags WHERE id = ?`)
    .get(mainId) as { name: string; tag_type: string | null } | undefined;
  if (!main || main.tag_type !== 'character') return [];
  const m = main.name.match(/\(([^()]*)\)$/);
  if (!m) return [];
  // LIKE 通配符转义:作品名里的 _ 是普通字符,不参与匹配
  const esc = m[1].replace(/[\\%_]/g, (c) => '\\' + c);
  const rows = db
    .prepare(
      `SELECT name, tag_type, count, has_wiki FROM tags
       WHERE tag_type = 'character' AND name LIKE ? ESCAPE '\\'
         AND name != ?
       ORDER BY count DESC LIMIT ?`,
    )
    .all(`%(${esc})%`, main.name, limit) as Array<{
    name: string;
    tag_type: string | null;
    count: number | null;
    has_wiki: number | null;
  }>;
  return rows.map((r) => ({ ...r, score: 0, source: 'franchise' }));
}

/**
 * 系列家族的成员 IP 数上限:fate_(series) 实测 12 成员,上限截断
 * 防御极端长尾(成员按角色数 DESC 排序,截掉的是冷门子作品)。
 */
const FAMILY_MEMBER_CAP = 24;

/**
 * 家族成员判定最小角色数:|chars(X)| ≥ 3 才允许 X 进 S 的家族。
 * 2 角色的跨界联动 IP(如同时挂 honkai 的 fate/unlimited_blade_works
 * 联动角色)会以 100% 共现混入家族,最小角色数把它们挡在门外。
 */
const FAMILY_MIN_CHARS = 3;

/**
 * 按 IP/作品展开角色:主 tag 为 copyright 时,用 character_profile 表的
 * copyright(JSON 数组)反向匹配,结构地带出该作品/系列下的全部角色。
 * 补 franchiseCharacters 只覆盖 character 主 tag 的空档 —— copyright 主 tag(如
 * `atelier_(series)`)之前只靠 LLR/GNN 邻居抽奖,新角色因邻居权重低被挤掉。
 * 来源表缺失(旧库未 patch)时返回空,不破坏现有行为。
 */
function franchiseByCopyright(
  db: Database.Database,
  mainId: number,
  limit: number,
): DanbooruTag[] {
  const main = db
    .prepare(`SELECT name, tag_type FROM tags WHERE id = ?`)
    .get(mainId) as { name: string; tag_type: string | null } | undefined;
  if (!main || main.tag_type !== 'copyright') return [];
  // 匹配键:作品名完整形(`atelier_(series)`);JSON 数组每项带引号,Like 匹配
  // 需转义 `_`/`%`/`\`。括号片段拆出纯名(atelier)作第二键,兼容裸 IP 输入。
  const esc = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);
  const keys = [esc(main.name)];
  const m = main.name.match(/^([^(]+)/);
  if (m && m[1].trim()) keys.push(esc(m[1].trim()));
  let rows: Array<{
    id: number;
    name: string;
    tag_type: string | null;
    count: number | null;
    has_wiki: number | null;
  }> = [];
  try {
    rows = db
      .prepare(
        `SELECT t.id, t.name, t.tag_type, t.count, t.has_wiki
         FROM character_profile cp
         JOIN tags t ON t.id = cp.tag_id
         WHERE t.tag_type = 'character' AND t.id != ?
           AND (${keys.map((k) => `cp.copyright LIKE ? ESCAPE '\\'`).join(' OR ')})
         GROUP BY t.id
         ORDER BY t.count DESC LIMIT ?`,
      )
      .all(mainId, ...keys.map((k) => `%"${k}"%`), limit) as typeof rows;
  } catch {
    // character_profile 表缺失(旧库未 patch)→ 无阵容可展开,空降级
    return [];
  }
  if (!rows.length) return [];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    tag_type: r.tag_type,
    count: r.count,
    has_wiki: r.has_wiki,
    score: 0,
    source: 'franchise',
  }));
}

/**
 * IP→角色 预构建内存索引(进程级缓存,WeakMap 挂连接实例)。
 *
 * 背景:实时展开对大 IP(honkai/genshin 等 200 角色)需逐角色查
 * isUniqueBareName,单次 5~6s;预构建一次全表扫描
 * (character_profile JOIN tags + 全 tags 裸名统计,<1s),之后
 * expandIpChars / appendIpAttribution 纯内存查表(<0.1ms)。
 *
 * 索引内容(两段式设计的两侧):
 *   - 查询侧(IP 遍历,expandIpChars):ipFamily —— IP → 系列家族
 *     (伞标 + 全部成员 IP)。角色→详细 IP(character_profile.copyright
 *     同时挂详细与伞标),详细 IP 的角色几乎全部同时挂伞标(子集共现
 *     ≥90%),据此推导双向映射:伞标→成员(下探)与成员→伞标(上卷,
 *     搜子作品命中全系列)。查询只搜系列 IP 家族词,不向下追溯角色。
 *   - 入库侧(IP 归属,appendIpAttribution):charIps —— 角色全名
 *     (下划线形 lower)→ IP 词集;bareIps —— 全库唯一裸名 → IP 词集。
 *     prompt 文本中的角色名(全名/裸名)换算成 IP 词追加进检索文本,
 *     使"仅搜系列 IP 词"的查询也能命中只写角色名的图(归属召回)。
 */
interface IpCharIndex {
  /** 角色全名(下划线形 lower) → IP 词集(copyright 数组去重) */
  charIps: Map<string, string[]>;
  /** 全库唯一裸名(lower) → IP 词集 */
  bareIps: Map<string, string[]>;
  /** IP → 系列家族(首元素 = 伞标或自身;成员按角色数 DESC) */
  ipFamily: Map<string, string[]>;
}

/** 连接实例 → 索引(danbooru 库只读,数据集静态,进程内无需失效) */
const ipIndexByDb = new WeakMap<Database.Database, IpCharIndex>();

/** tags.name 的裸名(同 bareCharName 规则):首个 `(` 前段剥尾部标点。 */
function bareTagName(name: string): string {
  const head = name.split('(')[0] ?? '';
  return head.replace(/[\W_]+$/, '').trim();
}

/** 一次全表扫描构建索引(约 0.5~1s,懒加载首调触发)。 */
function buildIpCharIndex(db: Database.Database): IpCharIndex {
  // IP → 角色 id 集合(家族推导的基数基础)
  const ipCharIds = new Map<string, Set<number>>();
  // 角色全名(lower) → IP 词集(入库归属 charIps 的原始形态)
  const charIpLists = new Map<string, string[]>();
  // 裸名(lower) → 持有该裸名的角色全名列表(唯一性判定)
  const bareOwners = new Map<string, string[]>();
  // 共现计数:inter[S][X] = 同时挂 S、X 的角色数(对称累计,
  // 家族推导按角色数组内两两配对一次算清,均组 ~1.3 个元素)
  const inter = new Map<string, Map<string, number>>();
  let rows: Array<{
    tag_id: number;
    copyright: string | null;
    name: string;
    tag_type: string | null;
    count: number | null;
  }> = [];
  try {
    rows = db
      .prepare(
        `SELECT cp.tag_id, cp.copyright, t.name, t.tag_type, t.count
         FROM character_profile cp JOIN tags t ON t.id = cp.tag_id`,
      )
      .all() as typeof rows;
  } catch {
    // character_profile 表缺失(旧库未 patch)→ 返回空索引,调用方降级到字面匹配
    return { charIps: new Map(), bareIps: new Map(), ipFamily: new Map() };
  }
  for (const r of rows) {
    // 与 franchiseByCopyright 的 JOIN 过滤一致:仅角色行
    if (r.tag_type !== 'character') continue;
    let arr: unknown;
    try {
      arr = JSON.parse(r.copyright ?? '');
    } catch {
      continue; // 坏 JSON → 跳过该行
    }
    if (!Array.isArray(arr)) continue;
    // 数组去重(同角色重复元素只计一次,共现配对不受重复污染)
    const ips = [
      ...new Set(
        arr.filter(
          (ip): ip is string => typeof ip === 'string' && !!ip.trim(),
        ),
      ),
    ];
    for (const ip of ips) {
      let ids = ipCharIds.get(ip);
      if (!ids) {
        ids = new Set<number>();
        ipCharIds.set(ip, ids);
      }
      ids.add(r.tag_id);
    }
    if (ips.length) charIpLists.set(r.name.toLowerCase(), ips);
    const bare = bareTagName(r.name).toLowerCase();
    if (bare) {
      let owners = bareOwners.get(bare);
      if (!owners) {
        owners = [];
        bareOwners.set(bare, owners);
      }
      owners.push(r.name);
    }
    // 共现配对:数组内任意两个 IP 互记(对称,S≠X)
    for (let i = 0; i < ips.length; i++) {
      for (let j = 0; j < ips.length; j++) {
        if (i === j) continue;
        const s = ips[i];
        const x = ips[j];
        let m = inter.get(s);
        if (!m) {
          m = new Map<string, number>();
          inter.set(s, m);
        }
        m.set(x, (m.get(x) ?? 0) + 1);
      }
    }
  }
  // 全库唯一裸名统计(一次顺序扫描):每个 tag 名归一为裸名计数,
  // 恰 1 次的才算唯一。裸名归属(bareIps)要求全库唯一 —— 跨角色
  // 或与普通 tag 撞名的裸名(如泛名)一律不归属,防误命中。
  const bareCount = new Map<string, number>();
  const names = db.prepare('SELECT name FROM tags').all() as Array<{
    name: string;
  }>;
  for (const r of names) {
    const bare = bareTagName(r.name).toLowerCase();
    if (!bare) continue;
    bareCount.set(bare, (bareCount.get(bare) ?? 0) + 1);
  }
  const uniqueBare = new Set<string>();
  for (const [bare, n] of bareCount) {
    if (n === 1) uniqueBare.add(bare);
  }
  // 入库归属索引:角色全名 → IP 集(直接复用 charIpLists)
  const charIps = charIpLists;
  // 唯一裸名 → IP 集(裸名被多个角色持有或与普通 tag 撞名时不归属)
  const bareIps = new Map<string, string[]>();
  for (const [bare, owners] of bareOwners) {
    if (owners.length !== 1 || !uniqueBare.has(bare)) continue;
    const ips = charIps.get(owners[0].toLowerCase());
    if (ips && ips.length) bareIps.set(bare, ips);
  }
  // 家族推导(下探):members(S) = {X : inter[S][X] ≥ 0.9·|chars(X)|,
  // |chars(X)| ≥ FAMILY_MIN_CHARS};FAMILY_MIN_CHARS 挡住 2 角色的
  // 跨界联动 IP(共现恰好 100% 也不进家族)。
  const ipFamily = new Map<string, string[]>();
  const charCount = (ip: string): number => ipCharIds.get(ip)?.size ?? 0;
  for (const [s, m] of inter) {
    const members: Array<{ ip: string; chars: number }> = [];
    for (const [x, n] of m) {
      if (x === s) continue;
      const xc = charCount(x);
      if (xc < FAMILY_MIN_CHARS) continue;
      if (n / xc >= 0.9) members.push({ ip: x, chars: xc });
    }
    if (members.length > 0) {
      members.sort((a, b) => b.chars - a.chars);
      ipFamily.set(s, [
        s,
        ...members.slice(0, FAMILY_MEMBER_CAP).map((mem) => mem.ip),
      ]);
    }
  }
  // 家族推导(上卷):无成员的 IP(子作品或独立作品)→ 挂到包含它的
  // 伞标家族;多个伞标命中取角色数最大者(跨界联动取主系列)。
  for (const ip of ipCharIds.keys()) {
    if (ipFamily.has(ip)) continue;
    let best: { family: string[]; chars: number } | null = null;
    for (const [s, family] of ipFamily) {
      if (!family.slice(1).includes(ip)) continue;
      const sc = charCount(s);
      if (!best || sc > best.chars) best = { family, chars: sc };
    }
    ipFamily.set(ip, best ? best.family : [ip]);
  }
  return { charIps, bareIps, ipFamily };
}

/** 取(或懒构建)连接对应的 IP 索引。 */
function getIpCharIndex(db: Database.Database): IpCharIndex {
  let index = ipIndexByDb.get(db);
  if (!index) {
    index = buildIpCharIndex(db);
    ipIndexByDb.set(db, index);
  }
  return index;
}

/**
 * IP 遍历展开(系列家族语义):输入 q 解析成唯一 copyright tag 时,
 * 返回其系列家族的搜索词集(家族各 IP 的完整形/空格形/裸形变体),
 * 供正文搜索做 OR 扩展。非 copyright / 解析不定 / 词表无该 IP 的
 * 角色档案 / 库缺失 → null(降级为原字面匹配)。
 *
 * 两段式设计的查询侧(另一半是入库期 appendIpAttribution):
 *   - 入库期把 prompt 里的角色名(全名/唯一裸名)归属成 IP 词追加进
 *     search_text(角色 → 详细 IP);
 *   - 查询期只展开系列家族 IP 词(伞标 ⇄ 子作品双向),不再向下
 *     展开角色名 —— 角色召回已由入库归属完成,查询词表从百级角色
 *     词缩到家族 IP 词(≤ FAMILY_MEMBER_CAP+1 个),FTS MATCH 更快。
 *
 * 性能:家族映射走预构建内存索引(见 IpCharIndex),每次调用仅
 * resolveTagIds + tags 主键查两次库。
 *
 * 解析兜底:精确层完全 miss 的输入(`atelier` / `atelier(series)`)按
 * danbooru 伞标命名惯例补 `_(series)` 后缀或括号前下划线重查,词表
 * 只收录 `atelier_(series)` 而无裸名的系列由此可达;仅完全 miss 时
 * 兜底,裸词已命中其他 tag(同名 artist/character)时不改判。
 *
 * 词形:家族 IP 词同时产出下划线形与空格形(search_text 两种写法
 * 都有;Mongo 正则子串两形都需,FTS phrase 天然等价);带括号后缀
 * 的伞标(如 `honkai_(series)`)另补剥后缀裸形(`honkai`),召回
 * prompt 只写裸 IP 的图。返回词已去重。
 */
const MAX_IP_TERMS = 128;

export function expandIpChars(
  db: Database.Database | null,
  q: string,
): { root: string; terms: string[] } | null {
  if (!db) return null;
  const { ids } = resolveTagIds(db, q);
  let main: { name: string; tag_type: string | null } | undefined;
  if (ids.length === 1) {
    main = db
      .prepare(`SELECT name, tag_type FROM tags WHERE id = ?`)
      .get(ids[0]) as { name: string; tag_type: string | null } | undefined;
  }
  if (!main || main.tag_type !== 'copyright') {
    // 系列伞标兜底:裸词(`atelier`)常被截断前缀兜底劫持成同前缀
    // character tag、或别名/tag 名精确层完全 miss;无下划线括号形
    // (`atelier(series)`)与 name_pc 归一不一致。均按 danbooru 命名
    // 惯例补 `_(series)` 后缀或括号前下划线再精确查一次 —— 大量系列
    // 伞标是 `裸名_(series)` 形态而词表不收录裸名本身。候选须精确
    // 命中 copyright 才改判,否则维持原判(原判非 copyright → null,
    // 与旧版口径一致,零误伤)。
    const norm = normTagKey(q);
    const cands: string[] = [];
    if (norm.includes('(')) {
      const parenFixed = norm.replace('(', '_(');
      if (parenFixed !== norm) cands.push(parenFixed);
    }
    if (!norm.endsWith(')')) cands.push(`${norm}_(series)`);
    const byName = db.prepare(
      `SELECT name, tag_type FROM tags WHERE name = ?`,
    );
    for (const cand of cands) {
      const hit = byName.get(cand) as
        | { name: string; tag_type: string | null }
        | undefined;
      if (hit && hit.tag_type === 'copyright') {
        main = hit;
        break;
      }
    }
  }
  if (!main || main.tag_type !== 'copyright') return null;
  const index = getIpCharIndex(db);
  // 家族查表键:完整名优先;剥括号裸段兜底(数据集里少数角色的
  // copyright 数组只挂裸名,完整名键 miss 时裸名键可能命中)
  const keys = [main.name];
  const m = main.name.match(/^([^(]+)/);
  if (m && m[1].trim()) {
    const bare = m[1].trim().replace(/[\W_]+$/, '').trim();
    if (bare) keys.push(bare);
  }
  let family: string[] | undefined;
  for (const k of keys) {
    family = index.ipFamily.get(k);
    if (family) break;
  }
  // 词表无该 IP 的角色档案(character_profile 未覆盖)→ 无家族可
  // 展开,降级为字面匹配(与旧版"无角色返回 null"同口径)
  if (!family || !family.length) return null;
  const space = (s: string) => s.split('_').join(' ');
  const set = new Set<string>();
  for (const ip of family) {
    // 防御上限:家族构造已截 FAMILY_MEMBER_CAP,这里再兜一层
    if (set.size + 4 > MAX_IP_TERMS) break;
    set.add(ip);
    set.add(space(ip));
    // 伞标剥括号裸形:`honkai_(series)` → `honkai`;`bang_dream!`
    // 这类尾标点形一并剥净,避免干净根词漏检
    const bare = bareCharName(ip);
    if (bare && bare !== ip) {
      set.add(bare);
      set.add(space(bare));
    }
  }
  return { root: main.name, terms: [...set] };
}

/**
 * 角色数组名剥版权后缀 → 裸名:`rossi_(arknights)` / `rossi (arknights)` → `rossi`;
 * `mortis_(costume)_(bang_dream!)` → `mortis`。多重后缀取其首个括号前的段。
 */
function bareCharName(name: string): string {
  const head = name.split('(')[0] ?? '';
  return head.replace(/[\W_]+$/, '').trim();
}

/**
 * 入库期 IP 归属(两段式设计的落库侧):从正向 prompt 文本提取角色名,
 * 返回其所属 IP 词集(下划线形,copyright 数组原样)。匹配口径:
 *   - 段级候选链 tagKeyCandidates(剥权重/强调/NovelAI 前缀外壳)后查
 *     charIps(角色全名,下划线形 lower)→ 命中即归属其全部 IP 词;
 *   - 全名 miss 时剥版权后缀查 bareIps(全库唯一裸名)→ 跨角色
 *     泛名(`saber`/`rossi`)不唯一,不归属,防误命中;
 *   - 段级未命中时句子内嵌兜底:按词滑窗生成连续 n-gram(2~
 *     SENTENCE_MAX_WORDS 词,与 sentenceMatch 同款切词)查 charIps ——
 *     自然语言描述形态("the girl is Yumia Liessfeldt")的名字不在
 *     段首尾整段,段级候选链必然 miss。仅 ≥2 词窗口且只查 charIps
 *     (不查 bareIps):单字泛词(faith/will)即使恰为唯一裸名也不
 *     触发,防句子常用词误归属。
 * 仅扫正向 prompt:负面 prompt 里的角色名是"避免出现"语义,
 * 归属会把无关 IP 灌进检索文本。
 */
function ipAttrWords(
  db: Database.Database | null,
  positiveTexts: string[],
): string[] {
  if (!db || !positiveTexts.length) return [];
  const index = getIpCharIndex(db);
  const words = new Set<string>();
  for (const text of positiveTexts) {
    // 与 promptLastSegment 同款清洗:剥 <lora:...>/<embedding:...> 引用块
    const cleaned = String(text ?? '').replace(ANGLE_BLOCK, ' ');
    for (const segRaw of cleaned.split(/[\n,]+/)) {
      const seg = segRaw.trim();
      if (!seg) continue;
      let resolved = false;
      for (const cand of tagKeyCandidates(seg)) {
        const ips = index.charIps.get(cand);
        if (ips) {
          for (const ip of ips) words.add(ip);
          resolved = true;
          break; // 首个命中候选即该段的规范形,不再沿链下探
        }
        const bare = bareCharName(cand);
        if (bare && bare !== cand) {
          const bareIps = index.bareIps.get(bare);
          if (bareIps) for (const ip of bareIps) words.add(ip);
        }
      }
      if (resolved) continue;
      const ws = seg.toLowerCase().match(/[a-z0-9]+/g);
      if (!ws) continue;
      for (let i = 0; i < ws.length; i++) {
        const upper = Math.min(ws.length, i + SENTENCE_MAX_WORDS);
        for (let end = i + 2; end <= upper; end++) {
          const ips = index.charIps.get(ws.slice(i, end).join('_'));
          if (ips) for (const ip of ips) words.add(ip);
        }
      }
    }
  }
  return [...words];
}

/**
 * 入库期 IP 归属注入:把角色名归属出的 IP 词追加进 prompts.search_text,
 * 使"仅搜系列 IP 词"(expandIpChars 家族展开)也能命中只写角色名的图。
 *
 * 幂等:已在 search_text 中(下划线/空格任一形的子串)的词不重复
 * 追加 —— 回填脚本对同一文档重复执行结果不变。子串判定的语义与
 * 检索一致:词 `honkai` 已能命中含 `honkai_impact_3rd` 的文本
 * (FTS 分词/Mongo 正则均如此),跳过不损失召回。
 *
 * @param db danbooru 连接(null → 直接返回 null,静默降级)
 * @param prompts record/doc 的 prompts 段(positive + search_text)
 * @returns 新 search_text;无需变更(库缺失/无正向/无新词)返回 null
 */
export function appendIpAttribution(
  db: Database.Database | null,
  prompts: { positive?: unknown; search_text?: unknown } | undefined | null,
): string | null {
  if (!db || !prompts) return null;
  const st = typeof prompts.search_text === 'string' ? prompts.search_text : '';
  if (!st.trim()) return null;
  if (!Array.isArray(prompts.positive) || !prompts.positive.length) {
    return null;
  }
  const texts: string[] = [];
  for (const p of prompts.positive) {
    const t = (p as { text?: unknown })?.text;
    if (typeof t === 'string' && t.trim()) texts.push(t);
  }
  if (!texts.length) return null;
  const words = ipAttrWords(db, texts);
  if (!words.length) return null;
  const stLower = st.toLowerCase();
  const space = (s: string) => s.split('_').join(' ');
  const fresh = words.filter(
    (w) =>
      !stLower.includes(w.toLowerCase()) &&
      !stLower.includes(space(w).toLowerCase()),
  );
  if (!fresh.length) return null;
  return `${st}\n\n${fresh.join(', ')}`;
}

export function relatedTags(
  db: Database.Database,
  raw: string,
  limit = 10,
): RelatedResult {
  const last = promptLastSegment(raw);
  let { ids, source } = resolveTagIds(db, last);
  if (!ids.length && last.includes('(')) {
    // 带括号输入是明确的"角色名 (来源)"形态:剥壳链 miss 说明名字是
    // 错字/变体,走来源约束模糊;句子识别会抢跑命中版权词
    // (`rosi (arknights)` → arknights),先模糊再句子
    const hit = fuzzyCharacterMatch(db, last);
    if (hit) {
      ids = [hit.id];
      source = 'fuzzy';
    }
  }
  if (!ids.length) {
    // 字面/剥壳链 miss → 句子识别兜底(悬停窗口/自然语言句子场景),
    // 取最长命中作主 tag,source 标注 sentence 供前端"识别自"展示
    const hit = sentenceMatch(db, last, 1)[0];
    if (hit) {
      ids = [hit.id];
      source = 'sentence';
    }
  }
  if (!ids.length) {
    // 无括号输入(裸名+作品词,`rossi arknights`)无来源约束不做模糊;
    // 此处为无括号时的模糊兜底档(保留:句子 miss 且输入含来源词)
    const hit = fuzzyCharacterMatch(db, last);
    if (hit) {
      ids = [hit.id];
      source = 'fuzzy';
    }
  }
  if (!ids.length) return { tag: null, related: [], categories: {} };
  const byId = tagsById(db, ids);
  const mainId = ids[0];

  const [llrList, gnnList] = neighborLists(db, mainId, 50);
  const fused = rrfMerge([llrList, gnnList]);
  // 词表外新增角色无 LLR/GNN 邻居 → 同作品角色兜底(LLR/GNN 均为空时)
  const franchiseList =
    fused.size === 0 ? franchiseCharacters(db, mainId, limit) : [];
  // IP 遍历:copyright 主 tag → 用 character_profile 结构地带出该作品/系列
  // 全部角色(不再依赖邻居权重抽奖)。character 主 tag 走 franchiseCharacters。
  const ipChars = franchiseByCopyright(db, mainId, limit);

  // 排除已选 tag 自身与别名命中的其它目标
  const exclude = new Set(ids);
  // 排序:角色本身相关 tag(character 类型)且 wiki 实际验证(has_wiki=1)
  // 最优先 —— 浮层只展示一个"相关推荐"区块,优先放权威条目
  const candIds = [...fused.keys()].filter((id) => !exclude.has(id));
  const candMeta = tagsById(db, candIds);
  // 角色类型权重(2)大于 wiki 验证(1):角色本身条目整体优先,
  // 同类型内再按 wiki 实际验证优先。
  const prio = (id: number): number => {
    const t = candMeta.get(id);
    const notChar = t?.tag_type === 'character' ? 0 : 1;
    const noWiki = t?.has_wiki ? 0 : 1;
    return notChar * 2 + noWiki;
  };
  const ranked = [...fused.entries()]
    .filter(([id]) => !exclude.has(id))
    .sort((a, b) => prio(a[0]) - prio(b[0]) || b[1] - a[1])
    .slice(0, limit);

  const tagMap = tagsById(db, ranked.map(([id]) => id));
  // IP 遍历:copyright 主 tag 时,结构化的同作品角色置于 related 最前(增强,
  // 不复盖邻居回点)。character 主 tag 无 ipChars(函数对非 copyright 返空)。
  const rankedTags: DanbooruTag[] = ranked.map(([id, score]) => {
    const t = tagMap.get(id);
    return {
      name: t?.name ?? `#${id}`,
      tag_type: t?.tag_type ?? null,
      count: t?.count ?? null,
      has_wiki: t?.has_wiki ?? null,
      score: Number(score.toFixed(4)),
      source,
    };
  });
  const related: DanbooruTag[] = ipChars.length
    ? [...ipChars, ...rankedTags.filter((t) => !ipChars.some((c) => c.name === t.name))]
    : rankedTags.length
      ? rankedTags
      : franchiseList;

  // 语义分类分组:LLR ∪ GNN 候选按 tag_category 归桶(角色/背景/环境/
  // 特征子类/构图/...),各组按 RRF 分降序取前几;tag_category 表缺失时
  // 降级为 danbooru tag_type(character/copyright/artist/meta/general→other)
  const groupCandidates = rrfMerge([llrList, gnnList]);
  const rankedIds = [...groupCandidates.entries()]
    .filter(([id]) => !exclude.has(id))
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
  const groupTagMap = tagsById(db, rankedIds);
  const catById = categoriesById(db, rankedIds);
  const fallbackCat = (t: DanbooruTag | undefined): string => {
    if (!catById.size) {
      // 旧库未 patch:按 danbooru 类型降级分组
      if (t?.tag_type === 'character') return 'character';
      if (t?.tag_type === 'copyright') return 'copyright';
      if (t?.tag_type === 'artist') return 'artist';
      if (t?.tag_type === 'meta') return 'meta';
      return 'other';
    }
    return 'other';
  };
  const buckets = new Map<string, DanbooruTag[]>();
  for (const id of rankedIds) {
    const t = groupTagMap.get(id);
    if (!t) continue;
    const category = catById.get(id) ?? fallbackCat(t);
    const cap = CATEGORY_CAPS[category] ?? 4;
    if (!buckets.has(category)) buckets.set(category, []);
    if (buckets.get(category)!.length >= cap) continue;
    buckets.get(category)!.push({ ...t, score: Number(groupCandidates.get(id)!.toFixed(4)) });
  }
  const categories: Record<string, DanbooruTag[]> = {};
  for (const c of CATEGORY_ORDER) {
    if (buckets.has(c)) categories[c] = buckets.get(c)!;
  }
  // 无邻居时同作品角色兜底也进分类(character 桶),浮层两个区块都有内容
  if (!categories.character && (franchiseList.length || ipChars.length)) {
    categories.character = ipChars.length ? ipChars : franchiseList;
  }

  const zhMap = zhByTagIds(db, [mainId]);
  const main = byId.get(mainId) ?? { name: raw, tag_type: null, count: null };
  // 官方特征区仅角色 tag:wiki_traits 表对任何 tag 都可能有配图投票行
  // (如 blonde_hair 的 wiki 配图),但特征语义只在"角色→其外观特征"方向成立,
  // general/copyright 等类型不返回 traits;条目仅取 wiki 配图实际出现者
  // (数量不定值),无 wiki 数据不做共现兜底
  return {
    tag: { ...main, source, zh: zhMap.get(mainId) },
    traits:
      main.tag_type === 'character'
        ? characterProfile(db, mainId) ?? wikiTraits(db, mainId)
        : undefined,
    related,
    categories,
  };
}

/**
 * /api/tag-suggest 核心:字面前缀联想(范围扫描,免疫通配符)+ 别名层前置。
 * 返回顺序:别名精确 > tag 名前缀 > CJK 别名前缀 > 子串兜底。
 * 输入先经分词(L1 剥 `<...>` 块/切段取末段),再沿剥壳候选链逐键联想
 * —— 权重外壳 `(masterpiece:1.2)` 也能联想出词表规范形。
 */
export function suggestPrefix(
  db: Database.Database,
  raw: string,
  limit = 20,
): DanbooruTag[] {
  const candidates = tagKeyCandidates(normTagKey(promptLastSegment(raw)));
  if (!candidates.length) return [];
  const out: Array<{ id: number; t: DanbooruTag }> = [];
  const seen = new Set<string>();
  const pushItem = (id: number, t: DanbooruTag) => {
    if (seen.has(t.name)) return false;
    seen.add(t.name);
    out.push({ id, t });
    return true;
  };

  // 1) 别名精确(多语言 tag 名,如"初音ミク")
  for (const key of candidates) {
    if (out.length >= limit) break;
    for (const { tag_id, alias } of db
      .prepare(`SELECT tag_id, alias FROM tag_alias WHERE alias = ? ORDER BY freq DESC LIMIT 5`)
      .all(key) as Array<{ tag_id: number; alias: string }>) {
      const t = tagsById(db, [tag_id]).get(tag_id);
      if (!t) continue;
      pushItem(tag_id, { ...t, source: 'alias-exact', alias });
      if (out.length >= limit) break;
    }
  }
  // 2) tag 名前缀(范围扫描)
  if (out.length < limit) {
    for (const key of candidates) {
      if (out.length >= limit) break;
      for (const r of db
        .prepare(
          `SELECT id, name, tag_type, count FROM tags
           WHERE name >= ? AND name < ?
           ORDER BY count DESC LIMIT ?`,
        )
        .all(key, `${key}\uffff`, limit) as Array<{ id: number; name: string; tag_type: string | null; count: number | null }>) {
        pushItem(r.id, { name: r.name, tag_type: r.tag_type, count: r.count, source: 'tag-prefix' });
        if (out.length >= limit) break;
      }
    }
  }
  // 3) CJK 别名前缀
  if (out.length < limit) {
    for (const key of candidates) {
      if (!isCjk(key) || out.length >= limit) continue;
      for (const { tag_id, alias } of db
        .prepare(
          `SELECT tag_id, MIN(alias) AS alias FROM tag_alias
           WHERE alias >= ? AND alias < ?
           GROUP BY tag_id ORDER BY MAX(freq) DESC LIMIT ?`,
        )
        .all(key, `${key}\uffff`, limit - out.length) as Array<{ tag_id: number; alias: string }>) {
        const t = tagsById(db, [tag_id]).get(tag_id);
        if (!t) continue;
        pushItem(tag_id, { ...t, source: 'alias-prefix', alias });
        if (out.length >= limit) break;
      }
    }
  }
  // 4) 子串兜底(带转义;全表扫 112k 行毫秒级)
  if (out.length < limit) {
    for (const key of candidates) {
      if (out.length >= limit) break;
      const escaped = key.replace(/[\\%_]/g, (m) => `\\${m}`);
      for (const r of db
        .prepare(
          `SELECT id, name, tag_type, count FROM tags
           WHERE name LIKE ? ESCAPE '\\'
           ORDER BY count DESC LIMIT ?`,
        )
        .all(`%${escaped}%`, limit - out.length) as Array<{ id: number; name: string; tag_type: string | null; count: number | null }>) {
        pushItem(r.id, { name: r.name, tag_type: r.tag_type, count: r.count, source: 'substring' });
        if (out.length >= limit) break;
      }
    }
  }
  // 5) 句子识别兜底(子序列词表匹配):粘贴自然语言句子场景,
  // 前缀/子串均空时识别句中 tag,如 `the girl is Yumia Liessfeldt`
  if (out.length < limit) {
    for (const hit of sentenceMatch(db, promptLastSegment(raw), limit - out.length)) {
      pushItem(hit.id, hit);
      if (out.length >= limit) break;
    }
  }
  // 统一补充中文翻译(zh):每 tag 一条,无则缺省
  const zhMap = zhByTagIds(db, out.map((x) => x.id));
  return out.map(({ id, t }) => (zhMap.has(id) ? { ...t, zh: zhMap.get(id) } : t));
}
