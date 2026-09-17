import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'crypto';
import { createReadStream, existsSync } from 'fs';
import { basename } from 'path';
import type Database from 'better-sqlite3';
import { Model } from 'mongoose';
import { Inject } from '@nestjs/common';
import { SQLITE_DB } from '../../sqlite/sqlite.module';
import {
  ImageLineage,
  ImageLineageDocument,
  Images,
  ImagesDocument,
} from '../../schemas';
import { ParseWorkerService } from '../../workers/parse-worker.service';
import type {
  ImageLineageCandidate,
  ImageLineageDownstream,
} from '../../workers/parse-worker';
import { firstAccessiblePath } from '../../lib/paths';
import { escapeRegExp } from '../../utils/escape-regex';

export const LINEAGE_RELATION_TYPES = [
  'i2i',
  'controlnet',
  'mask',
  'reference',
  'auxiliary',
] as const;
export type LineageRelationType = (typeof LINEAGE_RELATION_TYPES)[number];
export type LineageDirection = 'ancestors' | 'descendants' | 'both';

export interface LineageEdge {
  edge_id: string;
  child_sha256: string;
  child_batch_key?: string;
  parent_sha256?: string;
  parent_batch_key?: string;
  relation_type: LineageRelationType;
  origin: 'auto' | 'manual';
  status: 'resolved' | 'unresolved' | 'ambiguous' | 'source_unavailable';
  raw_ref?: string;
  source_node_id?: string;
  source_node_type?: string;
  source_content_sha256?: string;
  match_method?: 'content_hash' | 'exact_path' | 'unique_filename' | 'manual';
  /** 该来源图喂到的 ControlNet 应用(仅 controlnet 关系有值) */
  downstream?: ImageLineageDownstream[];
  active: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * 单图的血缘计数标记(列表页角标用,只统计 i2i)。
 *
 * 命名按"这张图扮演什么角色"而不是边的方向,避免误读:
 *   as_product        —— 本图作为子图的 i2i 边数(这张图是图生图产物)
 *   as_product_linked —— 其中已解析到库内父图的边数(0 = 源图未入库)
 *   as_source         —— 本图作为父图的 i2i 边数(这张图被当作图生图源用过)
 *
 * 实测提醒(2026-09-11 全量回填):现有存档里 i2i 边**全部**是 unresolved /
 * source_unavailable(as_product_linked 恒为 0),因此角标文案要能表达
 * "是产物但源图未入库",不能写成"父图 N"。
 */
export interface LineageMark {
  as_product: number;
  as_product_linked: number;
  as_source: number;
}

/** 血缘批量查询的 sha256 白名单校验与上限(防超长 IN 子句)。 */
const SHA256_RE = /^[0-9a-f]{64}$/;
const LINEAGE_MARKS_MAX = 500;

/**
 * 血缘图规模预算:图查询的 BFS 展开、返回的 nodes/edges 与环检测游走共用。
 * 触顶即截断(getGraph 回 truncated 标记)——是防失控护栏而非完全性保证:
 * hasPath 的环检测同样在此封顶,超深图谱可能漏检环。
 */
const LINEAGE_GRAPH_MAX_NODES = 200;

interface ImageLocator {
  sha256: string;
  batch_key: string;
  filename?: string;
  image_name?: string;
  resolved_path?: string;
  source_path?: string;
  windows_path?: string;
}

/**
 * raw_ref 尾注:ComfyUI 在文件名后附加的来源标记(` [input]` / ` [temp]`)。
 * 只剥 [input] 会漏掉 temp 侧(`ComfyUI_temp_xxx.png [temp]`),剥离后
 * 仍带尾注 → 与库内 filename/image_name 永远比对不上。
 */
const REF_SUFFIX_RE = /\s+\[(?:input|temp)\]$/i;

/**
 * 血缘引用归一化:剥尾注 → 统一分隔符 → 小写。
 *
 * 容器路径(如 /app/comfyui/input/x.png)无需映射到宿主机路径——
 * 匹配策略是"先整串比对,再取 basename 与库内 filename/image_name 比对",
 * basename 在两侧一致,容器前缀不影响命中。
 */
function normalizeRef(value: unknown): string {
  let text = String(value ?? '').trim();
  // 尾注可能多层叠加(如 "x.png [temp] [input]"),循环剥净
  let stripped = text.replace(REF_SUFFIX_RE, '');
  while (stripped !== text) {
    text = stripped;
    stripped = text.replace(REF_SUFFIX_RE, '');
  }
  return text.replace(/[\\/]+/g, '/').toLowerCase();
}

function edgeId(parts: Array<string | undefined>): string {
  return createHash('sha256').update(parts.map((p) => p ?? '').join('|')).digest('hex');
}

async function contentHash(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  return await new Promise((resolve) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', () => resolve(null));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

@Injectable()
export class LineageService {
  private readonly readMode: boolean;
  private readonly writeSqlite: boolean;
  private readonly writeMongo: boolean;
  private contentIndex: Map<string, ImageLocator[]> | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly worker: ParseWorkerService,
    @Inject(SQLITE_DB) private readonly sqliteDb: Database.Database,
    @InjectModel(Images.name) private readonly imagesModel: Model<ImagesDocument>,
    @InjectModel(ImageLineage.name)
    private readonly lineageModel: Model<ImageLineageDocument>,
  ) {
    this.readMode = this.config.get<boolean>('sqlite.readMode') ?? false;
    const dualWrite = this.config.get<boolean>('sqlite.dualWrite') ?? false;
    this.writeSqlite = this.readMode || dualWrite;
    this.writeMongo = !this.readMode;
  }

  /**
   * 写入侧血缘编排入口:归档/扫描每写入一条生成图记录调用一次。
   * 顺序刻意:先按候选落边(此刻源图多半未入库,边落 unresolved/
   * ambiguous)→ 把本图挂进内容哈希索引 → 按本图路径回补挂起边,
   * 源图后到时由这一步把边翻成 resolved。素材登记不走本方法
   * (registerSourceMaterials 独立写库),那边的回路闭合见 resolvePendingForPath。
   *
   * @returns 本图产出的血缘边数(无血缘候选时为 0)
   */
  async refreshRecord(record: Record<string, unknown>): Promise<number> {
    const file = (record.file as Record<string, unknown> | undefined) ?? {};
    const childSha = String(file.sha256 ?? '').trim();
    if (!childSha) return 0;
    const metadata = (record.metadata as Record<string, unknown> | undefined) ?? {};
    const candidates = await this.worker.extractImageLineage(metadata);
    const edges: LineageEdge[] = [];
    for (const candidate of candidates) {
      edges.push(await this.resolveCandidate(childSha, String(record.batch_key ?? ''), candidate));
    }
    await this.replaceAutoEdges(childSha, edges);
    const childLocator: ImageLocator = {
      sha256: childSha,
      batch_key: String(record.batch_key ?? ''),
      filename: typeof file.filename === 'string' ? file.filename : undefined,
      image_name: typeof file.image_name === 'string' ? file.image_name : undefined,
      resolved_path: typeof file.resolved_path === 'string' ? file.resolved_path : undefined,
      source_path: typeof file.source_path === 'string' ? file.source_path : undefined,
      windows_path: typeof file.windows_path === 'string' ? file.windows_path : undefined,
    };
    await this.indexContentHash(childLocator);
    await this.resolvePendingForImage(childLocator);
    return edges.length;
  }

  private async resolveCandidate(
    childSha: string,
    childBatchKey: string,
    candidate: ImageLineageCandidate,
  ): Promise<LineageEdge> {
    const now = new Date().toISOString();
    const match = await this.matchLibraryImage(candidate);
    let status: LineageEdge['status'] = candidate.source_unavailable
      ? 'source_unavailable'
      : 'unresolved';
    if (match.ambiguous) status = 'ambiguous';
    else if (match.parent) status = 'resolved';
    const parent = match.parent;
    const matchMethod = match.matchMethod;
    return {
      edge_id: edgeId([
        childSha,
        candidate.source_node_id,
        candidate.relation_type,
        candidate.raw_ref,
        'auto',
      ]),
      child_sha256: childSha,
      child_batch_key: childBatchKey || undefined,
      parent_sha256: parent?.sha256,
      parent_batch_key: parent?.batch_key,
      relation_type: candidate.relation_type,
      origin: 'auto',
      status,
      raw_ref: candidate.raw_ref,
      source_node_id: candidate.source_node_id,
      source_node_type: candidate.source_node_type,
      source_content_sha256: candidate.source_content_sha256 ?? undefined,
      match_method: matchMethod,
      // 仅 controlnet 关系带下游 CN 信息;空数组等同缺省,不落库空值
      downstream: candidate.downstream?.length ? candidate.downstream : undefined,
      active: candidate.active,
      created_at: now,
      updated_at: now,
    };
  }

  /**
   * 库内父图匹配的三级规则:精确路径 → 内容哈希 → 唯一文件名。
   *
   * 单一实现,两处消费:血缘边解析(resolveCandidate)与 Replay 提交前
   * 的 Upload-if-missing 回填(locateLibraryImage)。两处若各写一套,
   * "血缘能解析"与"能找回源图上传"就会分叉——同一张图一边 resolved
   * 一边上传失败,或反过来上传了血缘却解析不到。
   *
   * @param candidate raw_ref 与可选内容哈希
   * @returns 命中父图 + 匹配方式;多解时 ambiguous(绝不任取一张)
   *
   * 内部逻辑:
   *   1. 按 raw_ref 取候选集(文件名/别名/路径任一命中)
   *   2. 精确路径:raw_ref 与候选的 resolved/source/windows 路径相等
   *   3. 内容哈希:`is_changed` 的真二进制哈希点查(改过名也能找回)
   *   4. 唯一文件名:basename 与 filename/image_name 相等且唯一
   * 边界:任一层命中多个候选即 ambiguous,后续层不再尝试。
   */
  private async matchLibraryImage(candidate: {
    raw_ref: string;
    source_content_sha256?: string | null;
    source_unavailable?: boolean;
  }): Promise<{
    parent?: ImageLocator;
    matchMethod?: LineageEdge['match_method'];
    ambiguous?: boolean;
  }> {
    if (candidate.source_unavailable) return {};
    const matches = await this.findImageCandidates(candidate.raw_ref);
    const raw = normalizeRef(candidate.raw_ref);
    const exactPath = matches.find((item) =>
      [item.resolved_path, item.source_path, item.windows_path]
        .map(normalizeRef)
        .includes(raw),
    );
    if (exactPath) return { parent: exactPath, matchMethod: 'exact_path' };
    if (candidate.source_content_sha256) {
      const hashMatches = await this.findByContentHash(
        candidate.source_content_sha256,
      );
      if (hashMatches.length === 1) {
        return { parent: hashMatches[0], matchMethod: 'content_hash' };
      }
      if (hashMatches.length > 1) return { ambiguous: true };
    }
    const name = normalizeRef(basename(raw));
    const named = matches.filter(
      (item) => normalizeRef(item.filename) === name || normalizeRef(item.image_name) === name,
    );
    if (named.length === 1) return { parent: named[0], matchMethod: 'unique_filename' };
    if (named.length > 1) return { ambiguous: true };
    return {};
  }

  /**
   * 按引用在库内定位一张可读图片(Replay 提交前回填源图用)。
   *
   * 与血缘边解析共用 matchLibraryImage 的三级规则;唯一额外要求是
   * 命中项必须带可用本地路径(没有路径的条目读不出字节,无法上传)。
   *
   * @returns 命中且带 resolved_path 的定位信息;未命中/多解/无路径返回 null
   */
  async locateLibraryImage(candidate: {
    raw_ref: string;
    content_sha256?: string | null;
  }): Promise<ImageLocator | null> {
    const match = await this.matchLibraryImage({
      raw_ref: String(candidate.raw_ref ?? ''),
      source_content_sha256: candidate.content_sha256 ?? null,
    });
    if (!match.parent?.resolved_path) return null;
    return match.parent;
  }

  private async findImageCandidates(rawRef: string): Promise<ImageLocator[]> {
    const cleaned = normalizeRef(rawRef);
    const name = basename(cleaned);
    if (this.readMode) {
      const rows = this.sqliteDb
        .prepare(
          `SELECT bi.batch_key, bi.image_json FROM batch_images bi
           WHERE lower(bi.filename) = ? OR lower(bi.image_name) = ?
              OR lower(replace(bi.resolved_path, '\\', '/')) = ?
              OR lower(replace(COALESCE(bi.source_path,''), '\\', '/')) = ?
           LIMIT 50`,
        )
        .all(name, name.replace(/\.[^.]+$/, ''), cleaned, cleaned) as Array<{
        batch_key: string;
        image_json: string;
      }>;
      return rows.map((row) => this.locatorFromEntry(row.batch_key, JSON.parse(row.image_json)));
    }
    const regexName = escapeRegExp(name);
    const docs = await this.imagesModel.collection
      .find(
        {
          $or: [
            { 'images.file.filename': { $regex: `^${regexName}$`, $options: 'i' } },
            { 'images.file.image_name': { $regex: `^${regexName.replace(/\.[^.]+$/, '')}$`, $options: 'i' } },
            { 'images.file.resolved_path': rawRef },
            { 'images.file.source_path': rawRef },
            { 'images.file.windows_path': rawRef },
          ],
        },
        { projection: { _id: 0, batch_key: 1, images: 1 } },
      )
      .limit(50)
      .toArray();
    return docs.flatMap((doc) =>
      ((doc as { images?: Array<Record<string, unknown>> }).images ?? [])
        .map((entry) => this.locatorFromEntry(String(doc.batch_key ?? ''), entry))
        .filter((item) => {
          const paths = [item.resolved_path, item.source_path, item.windows_path].map(normalizeRef);
          return (
            normalizeRef(item.filename) === name ||
            normalizeRef(item.image_name) === name.replace(/\.[^.]+$/, '') ||
            paths.includes(cleaned)
          );
        }),
    );
  }

  /**
   * 内容哈希匹配父图。
   *
   * SQLite 轨道:直查 batch_images.content_sha256 列(带索引);未命中时做
   * **一次性惰性回填**(把仍为 NULL 的行算出真实内容哈希写回)再查一次。
   * 为什么惰性:入库路径不为每张图算内容哈希(会拖慢主流程),而"每次匹配都
   * 现场流式哈希全表"实测 4.89 GiB / 14s 且阻塞事件循环(原实现隐患)。
   *
   * Mongo 轨道:无派生列,退回进程内内存索引(全量构建一次后复用)。
   */
  private async findByContentHash(hash: string): Promise<ImageLocator[]> {
    const target = hash.toLowerCase();
    if (this.readMode) {
      const direct = this.queryContentHash(target);
      if (direct.length) return direct;
      if ((await this.backfillContentHashes()) === 0) return [];
      return this.queryContentHash(target);
    }
    await this.ensureMemoryContentIndex();
    return this.contentIndex?.get(target) ?? [];
  }

  /** 按 content_sha256 列点查(SQLite 轨道;windows_path 取自 image_json)。 */
  private queryContentHash(digest: string): ImageLocator[] {
    const rows = this.sqliteDb
      .prepare(
        `SELECT batch_key, sha256, filename, image_name, resolved_path, source_path,
                json_extract(image_json, '$.file.windows_path') AS windows_path
           FROM batch_images WHERE content_sha256 = ?`,
      )
      .all(digest) as Array<{
      batch_key: string;
      sha256: string | null;
      filename: string | null;
      image_name: string | null;
      resolved_path: string | null;
      source_path: string | null;
      windows_path: string | null;
    }>;
    return rows.map((row) => ({
      sha256: String(row.sha256 ?? ''),
      batch_key: row.batch_key,
      filename: row.filename ?? undefined,
      image_name: row.image_name ?? undefined,
      resolved_path: row.resolved_path ?? undefined,
      source_path: row.source_path ?? undefined,
      windows_path: row.windows_path ?? undefined,
    }));
  }

  /**
   * content_sha256 惰性回填:对仍为 NULL 的行逐个计算内容哈希并写回。
   * 只做文件级读取(不解码像素);单次全表约十几秒,之后匹配全走索引点查。
   * @returns 写回行数(0 = 无可回填的有效路径)
   */
  private async backfillContentHashes(): Promise<number> {
    const rows = this.sqliteDb
      .prepare(
        `SELECT resolved_path,
                json_extract(image_json, '$.file.windows_path') AS windows_path
           FROM batch_images WHERE content_sha256 IS NULL`,
      )
      .all() as Array<{ resolved_path: string; windows_path: string | null }>;
    if (!rows.length) return 0;
    const update = this.sqliteDb.prepare(
      'UPDATE batch_images SET content_sha256 = ? WHERE resolved_path = ?',
    );
    let filled = 0;
    for (const row of rows) {
      const path = firstAccessiblePath(
        row.resolved_path ?? undefined,
        row.windows_path ?? undefined,
      );
      if (!path) continue;
      const digest = await contentHash(path);
      if (!digest) continue;
      update.run(digest, row.resolved_path);
      filled += 1;
    }
    return filled;
  }

  /**
   * 新入库图的内容哈希落列(SQLite 轨道):单张 ~4ms,只处理刚写的那一行,
   * 不做全表回填,避免拖慢入库主流程。
   */
  private async indexContentHash(item: ImageLocator): Promise<void> {
    if (!this.readMode || !item.resolved_path) return;
    const path = firstAccessiblePath(item.resolved_path, item.windows_path);
    if (!path) return;
    const digest = await contentHash(path);
    if (!digest) return;
    this.sqliteDb
      .prepare('UPDATE batch_images SET content_sha256 = ? WHERE resolved_path = ?')
      .run(digest, item.resolved_path);
  }

  /** Mongo 轨道:进程内内容索引(全量构建一次,进程内复用)。 */
  private async ensureMemoryContentIndex(): Promise<void> {
    if (this.contentIndex !== null) return;
    const index = new Map<string, ImageLocator[]>();
    const docs = (await this.imagesModel.collection
      .find({}, { projection: { _id: 0, batch_key: 1, images: 1 } })
      .toArray()) as Array<{
      batch_key?: string;
      images?: Array<Record<string, unknown>>;
    }>;
    for (const doc of docs) {
      for (const entry of doc.images ?? []) {
        const item = this.locatorFromEntry(String(doc.batch_key ?? ''), entry);
        const path = firstAccessiblePath(item.resolved_path, item.windows_path);
        if (!path) continue;
        const digest = await contentHash(path);
        if (!digest) continue;
        const bucket = index.get(digest) ?? [];
        bucket.push(item);
        index.set(digest, bucket);
      }
    }
    this.contentIndex = index;
  }

  private locatorFromEntry(batchKey: string, entry: Record<string, unknown>): ImageLocator {
    const file = (entry.file as Record<string, unknown> | undefined) ?? {};
    return {
      sha256: String(file.sha256 ?? ''),
      batch_key: batchKey,
      filename: typeof file.filename === 'string' ? file.filename : undefined,
      image_name: typeof file.image_name === 'string' ? file.image_name : undefined,
      resolved_path: typeof file.resolved_path === 'string' ? file.resolved_path : undefined,
      source_path: typeof file.source_path === 'string' ? file.source_path : undefined,
      windows_path: typeof file.windows_path === 'string' ? file.windows_path : undefined,
    };
  }

  private async replaceAutoEdges(childSha: string, edges: LineageEdge[]): Promise<void> {
    if (this.writeSqlite) {
      const run = this.sqliteDb.transaction(() => {
        this.sqliteDb.prepare("DELETE FROM image_lineage_edges WHERE child_sha256 = ? AND origin = 'auto'").run(childSha);
        for (const edge of edges) this.insertSqlite(edge);
      });
      run();
    }
    if (this.writeMongo) {
      await this.lineageModel.collection.deleteMany({ child_sha256: childSha, origin: 'auto' });
      if (edges.length) await this.lineageModel.collection.insertMany(edges as never[]);
    }
  }

  /**
   * SQLite 行 → LineageEdge:active 布尔化,downstream 由 JSON 文本反序列化。
   * 丢弃原始 JSON 文本列,避免 null/字符串形态泄漏到接口响应。
   */
  private edgeFromRow(row: Record<string, unknown>): LineageEdge {
    const { downstream, ...rest } = row;
    const edge = { ...rest, active: Boolean(row.active) } as unknown as LineageEdge;
    const parsed = this.parseDownstream(downstream);
    if (parsed) edge.downstream = parsed;
    return edge;
  }

  /** downstream 列(JSON 文本)容错解析:空值/非数组/坏 JSON 一律按无 downstream 处理。 */
  private parseDownstream(value: unknown): ImageLineageDownstream[] | undefined {
    if (typeof value !== 'string' || !value) return undefined;
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) && parsed.length
        ? (parsed as ImageLineageDownstream[])
        : undefined;
    } catch {
      return undefined;
    }
  }

  private insertSqlite(edge: LineageEdge): void {
    this.sqliteDb.prepare(
      `INSERT OR REPLACE INTO image_lineage_edges(
        edge_id, child_sha256, child_batch_key, parent_sha256, parent_batch_key,
        relation_type, origin, status, raw_ref, source_node_id, source_node_type,
        source_content_sha256, match_method, downstream, active, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      edge.edge_id, edge.child_sha256, edge.child_batch_key ?? null,
      edge.parent_sha256 ?? null, edge.parent_batch_key ?? null,
      edge.relation_type, edge.origin, edge.status, edge.raw_ref ?? null,
      edge.source_node_id ?? null, edge.source_node_type ?? null,
      edge.source_content_sha256 ?? null, edge.match_method ?? null,
      edge.downstream?.length ? JSON.stringify(edge.downstream) : null,
      edge.active ? 1 : 0, edge.created_at, edge.updated_at,
    );
  }

  async setManualParents(
    childSha: string,
    relationType: LineageRelationType,
    parentShas: string[],
  ): Promise<void> {
    if (!LINEAGE_RELATION_TYPES.includes(relationType)) throw new BadRequestException('invalid relation_type');
    if (parentShas.length > 20) throw new BadRequestException('parent_sha256s exceeds limit of 20');
    const child = await this.findImage(childSha);
    if (!child) throw new NotFoundException('Child image not found');
    const unique = [...new Set(parentShas.map((value) => value.trim()).filter(Boolean))];
    const now = new Date().toISOString();
    const edges: LineageEdge[] = [];
    for (const parentSha of unique) {
      if (parentSha === childSha) throw new BadRequestException('lineage cannot reference itself');
      const parent = await this.findImage(parentSha);
      if (!parent) throw new NotFoundException(`Parent image not found: ${parentSha}`);
      if (await this.hasPath(parentSha, childSha)) throw new BadRequestException('manual lineage would create a cycle');
      edges.push({
        edge_id: edgeId([childSha, relationType, parentSha, 'manual']),
        child_sha256: childSha,
        child_batch_key: child.batch_key,
        parent_sha256: parentSha,
        parent_batch_key: parent.batch_key,
        relation_type: relationType,
        origin: 'manual',
        status: 'resolved',
        raw_ref: parent.filename,
        match_method: 'manual',
        active: true,
        created_at: now,
        updated_at: now,
      });
    }
    if (this.writeSqlite) {
      const run = this.sqliteDb.transaction(() => {
        this.sqliteDb.prepare("DELETE FROM image_lineage_edges WHERE child_sha256 = ? AND relation_type = ? AND origin = 'manual'").run(childSha, relationType);
        for (const edge of edges) this.insertSqlite(edge);
      });
      run();
    }
    if (this.writeMongo) {
      await this.lineageModel.collection.deleteMany({ child_sha256: childSha, relation_type: relationType, origin: 'manual' });
      if (edges.length) await this.lineageModel.collection.insertMany(edges as never[]);
    }
  }

  async getGraph(rootSha: string, direction: LineageDirection, depth: number): Promise<Record<string, unknown>> {
    const root = await this.findImage(rootSha);
    if (!root) throw new NotFoundException('Image not found');
    const edges: LineageEdge[] = [];
    const visited = new Set([rootSha]);
    const expanded = new Set<string>();
    let frontier = [rootSha];
    for (let level = 0; level < depth && frontier.length && visited.size < LINEAGE_GRAPH_MAX_NODES; level += 1) {
      frontier.forEach((sha) => expanded.add(sha));
      const found = await this.readEdges(frontier, direction);
      for (const edge of this.applyManualOverrides(found)) {
        if (!edges.some((item) => item.edge_id === edge.edge_id)) edges.push(edge);
        for (const sha of [edge.child_sha256, edge.parent_sha256]) {
          if (sha) visited.add(sha);
        }
      }
      frontier = [...visited].filter((sha) => !expanded.has(sha));
    }
    const nodes = (await Promise.all([...visited].slice(0, LINEAGE_GRAPH_MAX_NODES).map((sha) => this.findImage(sha)))).filter(Boolean);
    return {
      root,
      nodes,
      edges: edges.slice(0, LINEAGE_GRAPH_MAX_NODES),
      unresolved: edges.filter((edge) => edge.status !== 'resolved'),
      direction,
      depth,
      truncated: visited.size >= LINEAGE_GRAPH_MAX_NODES || edges.length > LINEAGE_GRAPH_MAX_NODES,
    };
  }

  /**
   * 批量血缘标记(列表页 i2i 角标的数据源)。
   *
   * 只统计 `relation_type='i2i'` 且 `active=1` 的边,按方向分两个计数:
   * child 侧 = 本图是图生图产物;parent 侧 = 本图被当作图生图源。
   * 两边都查(而不是只查 child)是刻意的:角标要如实区分"产物"与"源",
   * 二者共用同一个 i2i 语义,不做取舍。无边的图不出现在结果里。
   *
   * 性能:readMode 走两条 GROUP BY 的 IN 查询;非 readMode 走两条 $group 聚合。
   * 单次上限 {@link LINEAGE_MARKS_MAX} 个 sha(列表页整页一次调用)。
   *
   * @param shas 待查 sha256 列表(去重、大小写归一、非法值剔除)
   * @returns sha → { i2i_parent, i2i_child };无 i2i 关系时返回空对象
   */
  async marks(shas: string[]): Promise<Record<string, LineageMark>> {
    const unique = [
      ...new Set(
        (Array.isArray(shas) ? shas : [])
          .map((value) => String(value ?? '').trim().toLowerCase())
          .filter((value) => SHA256_RE.test(value)),
      ),
    ].slice(0, LINEAGE_MARKS_MAX);
    const marks: Record<string, LineageMark> = {};
    if (!unique.length) return marks;

    const bump = (sha: unknown, key: keyof LineageMark, by: number): void => {
      const value = String(sha ?? '').trim();
      if (!value || !Number.isFinite(by) || by <= 0) return;
      const entry = (marks[value] ??= {
        as_product: 0,
        as_product_linked: 0,
        as_source: 0,
      });
      entry[key] += by;
    };

    if (this.readMode) {
      const placeholders = unique.map(() => '?').join(',');
      // 方向一:本图作为子图(是 i2i 产物);同时数出其中已关联父图的条数
      const asProduct = this.sqliteDb
        .prepare(
          `SELECT child_sha256 AS sha, COUNT(*) AS n,
                  SUM(CASE WHEN parent_sha256 IS NOT NULL THEN 1 ELSE 0 END) AS linked
             FROM image_lineage_edges
            WHERE active = 1 AND relation_type = 'i2i' AND child_sha256 IN (${placeholders})
            GROUP BY child_sha256`,
        )
        .all(...unique) as Array<{ sha: string; n: number; linked: number }>;
      for (const row of asProduct) {
        bump(row.sha, 'as_product', Number(row.n));
        bump(row.sha, 'as_product_linked', Number(row.linked));
      }
      // 方向二:本图作为父图(被当作 i2i 源;有 parent_sha256 即证明已解析)
      const asSource = this.sqliteDb
        .prepare(
          `SELECT parent_sha256 AS sha, COUNT(*) AS n FROM image_lineage_edges
            WHERE active = 1 AND relation_type = 'i2i'
              AND parent_sha256 IS NOT NULL AND parent_sha256 IN (${placeholders})
            GROUP BY parent_sha256`,
        )
        .all(...unique) as Array<{ sha: string; n: number }>;
      for (const row of asSource) bump(row.sha, 'as_source', Number(row.n));
      return marks;
    }

    const productRows = (await this.lineageModel.collection
      .aggregate([
        { $match: { active: true, relation_type: 'i2i', child_sha256: { $in: unique } } },
        {
          $group: {
            _id: '$child_sha256',
            n: { $sum: 1 },
            linked: {
              $sum: { $cond: [{ $ifNull: ['$parent_sha256', null] }, 1, 0] },
            },
          },
        },
      ])
      .toArray()) as Array<{ _id: string; n: number; linked: number }>;
    for (const row of productRows) {
      bump(row._id, 'as_product', Number(row.n));
      bump(row._id, 'as_product_linked', Number(row.linked));
    }
    const sourceRows = (await this.lineageModel.collection
      .aggregate([
        {
          $match: {
            active: true,
            relation_type: 'i2i',
            parent_sha256: { $in: unique, $ne: null },
          },
        },
        { $group: { _id: '$parent_sha256', n: { $sum: 1 } } },
      ])
      .toArray()) as Array<{ _id: string; n: number }>;
    for (const row of sourceRows) bump(row._id, 'as_source', Number(row.n));
    return marks;
  }

  /**
   * manual 边遮蔽 auto 边:同一 (child, relation_type) 槽位上存在用户手动
   * 指定的边时,自动派生的同槽位边一律不出现(手动钉选不被自动边淹没)。
   * 图视图与环检测(hasPath)都经此取"生效边",两处语义保持一致。
   */
  private applyManualOverrides(edges: LineageEdge[]): LineageEdge[] {
    const manualKeys = new Set(edges.filter((edge) => edge.origin === 'manual').map((edge) => `${edge.child_sha256}|${edge.relation_type}`));
    return edges.filter((edge) => edge.origin === 'manual' || !manualKeys.has(`${edge.child_sha256}|${edge.relation_type}`));
  }

  private async readEdges(shas: string[], direction: LineageDirection): Promise<LineageEdge[]> {
    if (!shas.length) return [];
    if (this.readMode) {
      const placeholders = shas.map(() => '?').join(',');
      const clauses: string[] = [];
      const params: string[] = [];
      if (direction !== 'descendants') { clauses.push(`child_sha256 IN (${placeholders})`); params.push(...shas); }
      if (direction !== 'ancestors') { clauses.push(`parent_sha256 IN (${placeholders})`); params.push(...shas); }
      const rows = this.sqliteDb.prepare(`SELECT * FROM image_lineage_edges WHERE active = 1 AND (${clauses.join(' OR ')})`).all(...params) as Array<Record<string, unknown>>;
      return rows.map((row) => this.edgeFromRow(row));
    }
    const clauses: Array<Record<string, unknown>> = [];
    if (direction !== 'descendants') clauses.push({ child_sha256: { $in: shas } });
    if (direction !== 'ancestors') clauses.push({ parent_sha256: { $in: shas } });
    return (await this.lineageModel.collection.find({ active: true, $or: clauses }, { projection: { _id: 0 } }).toArray()) as unknown as LineageEdge[];
  }

  private async hasPath(fromSha: string, targetSha: string): Promise<boolean> {
    const seen = new Set([fromSha]);
    let frontier = [fromSha];
      while (frontier.length && seen.size < LINEAGE_GRAPH_MAX_NODES) {
      const next: string[] = [];
      for (const edge of this.applyManualOverrides(await this.readEdges(frontier, 'ancestors'))) {
        if (edge.parent_sha256 === targetSha) return true;
        if (edge.parent_sha256 && !seen.has(edge.parent_sha256)) {
          seen.add(edge.parent_sha256);
          next.push(edge.parent_sha256);
        }
      }
      frontier = next;
    }
    return false;
  }

  private async findImage(sha: string): Promise<ImageLocator | null> {
    if (this.readMode) {
      const row = this.sqliteDb.prepare('SELECT batch_key, image_json FROM batch_images WHERE sha256 = ? LIMIT 1').get(sha) as { batch_key: string; image_json: string } | undefined;
      return row ? this.locatorFromEntry(row.batch_key, JSON.parse(row.image_json)) : null;
    }
    const doc = await this.imagesModel.collection.findOne({ 'images.file.sha256': sha }, { projection: { _id: 0, batch_key: 1, images: 1 } });
    if (!doc) return null;
    const entry = ((doc as { images?: Array<Record<string, unknown>> }).images ?? []).find((item) => String((item.file as { sha256?: unknown } | undefined)?.sha256 ?? '') === sha);
    return entry ? this.locatorFromEntry(String(doc.batch_key ?? ''), entry) : null;
  }

  private async resolvePendingForImage(image: ImageLocator): Promise<void> {
    if (!image.filename) return;
    const pending = await this.readUnresolvedByRef(image.filename);
    for (const edge of pending) {
      const replacement = await this.resolveCandidate(edge.child_sha256, edge.child_batch_key ?? '', {
        relation_type: edge.relation_type,
        raw_ref: edge.raw_ref ?? '',
        source_node_id: edge.source_node_id ?? '',
        source_node_type: edge.source_node_type ?? '',
        source_content_sha256: edge.source_content_sha256,
        downstream: edge.downstream,
        active: edge.active,
      });
      replacement.created_at = edge.created_at;
      if (this.writeSqlite) this.insertSqlite(replacement);
      if (this.writeMongo) await this.lineageModel.collection.replaceOne({ edge_id: replacement.edge_id }, replacement as never, { upsert: true });
    }
  }

  /**
   * 按文件名宽捕待回补的挂起边(origin='auto' 且 unresolved/ambiguous)。
   * 匹配刻意从宽(不分大小写的子串包含):raw_ref 是素材入库前的原始引用
   * 形态,可能带路径前缀/大小写差异,精确等值会漏。误捕无害——命中的边
   * 仍走 resolveCandidate 的三级严格匹配,解析不中会原样落回未决态;
   * manual 边不进入本查询,永不被自动改写。
   */
  private async readUnresolvedByRef(filename: string): Promise<LineageEdge[]> {
    if (this.readMode) {
      const rows = this.sqliteDb
        .prepare(
          "SELECT * FROM image_lineage_edges WHERE origin = 'auto' AND status IN ('unresolved','ambiguous') AND lower(raw_ref) LIKE ?",
        )
        .all(`%${filename.toLowerCase()}%`) as Array<Record<string, unknown>>;
      return rows.map((row) => this.edgeFromRow(row));
    }
    return (await this.lineageModel.collection
      .find(
        {
          origin: 'auto',
          status: { $in: ['unresolved', 'ambiguous'] },
          raw_ref: { $regex: escapeRegExp(filename), $options: 'i' },
        },
        { projection: { _id: 0 } },
      )
      .toArray()) as unknown as LineageEdge[];
  }

  async backfill(dryRun = false): Promise<{ scanned: number; edges: number; failed: number }> {
    const records = await this.allImageRecords();
    let edges = 0;
    let failed = 0;
    for (const record of records) {
      try {
        const metadata = (record.metadata as Record<string, unknown> | undefined) ?? {};
        const candidates = await this.worker.extractImageLineage(metadata);
        if (!dryRun) edges += await this.refreshRecord(record);
        else edges += candidates.length;
      } catch {
        failed += 1;
      }
    }
    return { scanned: records.length, edges, failed };
  }

  /**
   * 新到图片按路径回补挂起边(素材登记等"不走 refreshRecord"的入库路径用)。
   *
   * 为什么需要:refreshRecord 只在写入生成图/扫描到新图时被调用,它内部用
   * record.file 构造 locator 再 resolvePendingForImage。源素材经
   * registerSourceMaterials 直接写库(没有 record 流经 refreshRecord),
   * 若不显式触发,素材入库后子图那条 unresolved 边不会被重解析——
   * 素材白入,回路没闭上。
   *
   * @param path 新入库图片的 resolved_path
   * @returns 重解析(命中)的挂起边数;未找到该图片时返回 0
   */
  async resolvePendingForPath(path: string): Promise<number> {
    const normalized = normalizeRef(path);
    if (!normalized) return 0;
    let locator: ImageLocator | null = null;
    if (this.readMode) {
      const row = this.sqliteDb
        .prepare(
          'SELECT batch_key, image_json FROM batch_images WHERE lower(replace(resolved_path, ?, ?)) = ? LIMIT 1',
        )
        .get('\\', '/', normalized) as
        | { batch_key: string; image_json: string }
        | undefined;
      locator = row
        ? this.locatorFromEntry(row.batch_key, JSON.parse(row.image_json))
        : null;
    } else {
      const doc = (await this.imagesModel.collection.findOne(
        { 'images.file.resolved_path': path },
        { projection: { _id: 0, batch_key: 1, images: 1 } },
      )) as { batch_key?: string; images?: Array<Record<string, unknown>> } | null;
      if (doc) {
        locator = this.locatorFromEntry(
          String(doc.batch_key ?? ''),
          (doc.images ?? [])[0] ?? {},
        );
      }
    }
    if (!locator) return 0;
    await this.resolvePendingForImage(locator);
    return 1;
  }

  async removeImageByPath(path: string): Promise<void> {
    let locator: ImageLocator | null = null;
    if (this.readMode) {
      const row = this.sqliteDb
        .prepare('SELECT batch_key, image_json FROM batch_images WHERE resolved_path = ? LIMIT 1')
        .get(path) as { batch_key: string; image_json: string } | undefined;
      locator = row
        ? this.locatorFromEntry(row.batch_key, JSON.parse(row.image_json))
        : null;
    } else {
      const doc = await this.imagesModel.collection.findOne(
        { 'images.file.resolved_path': path },
        { projection: { _id: 0, batch_key: 1, images: 1 } },
      );
      const entry = (
        (doc as { images?: Array<Record<string, unknown>> } | null)?.images ?? []
      ).find(
        (item) =>
          (item.file as { resolved_path?: string } | undefined)
            ?.resolved_path === path,
      );
      locator = entry
        ? this.locatorFromEntry(String(doc?.batch_key ?? ''), entry)
        : null;
    }
    if (!locator?.sha256) return;
    const now = new Date().toISOString();
    if (this.writeSqlite) {
      const run = this.sqliteDb.transaction(() => {
        this.sqliteDb
          .prepare('DELETE FROM image_lineage_edges WHERE child_sha256 = ?')
          .run(locator?.sha256);
        this.sqliteDb
          .prepare(
            "UPDATE image_lineage_edges SET parent_sha256 = NULL, parent_batch_key = NULL, status = 'unresolved', match_method = NULL, updated_at = ? WHERE parent_sha256 = ? AND origin = 'auto'",
          )
          .run(now, locator?.sha256);
        this.sqliteDb
          .prepare(
            "DELETE FROM image_lineage_edges WHERE parent_sha256 = ? AND origin = 'manual'",
          )
          .run(locator?.sha256);
      });
      run();
    }
    if (this.writeMongo) {
      await this.lineageModel.collection.deleteMany({
        $or: [
          { child_sha256: locator.sha256 },
          { parent_sha256: locator.sha256, origin: 'manual' },
        ],
      });
      await this.lineageModel.collection.updateMany(
        { parent_sha256: locator.sha256, origin: 'auto' },
        {
          $set: {
            status: 'unresolved',
            updated_at: now,
          },
          $unset: {
            parent_sha256: '',
            parent_batch_key: '',
            match_method: '',
          },
        },
      );
    }
  }

  private async allImageRecords(): Promise<Array<Record<string, unknown>>> {
    if (this.readMode) {
      const rows = this.sqliteDb.prepare('SELECT batch_key, image_json FROM batch_images').all() as Array<{ batch_key: string; image_json: string }>;
      return rows.map((row) => ({ batch_key: row.batch_key, ...(JSON.parse(row.image_json) as Record<string, unknown>) }));
    }
    const docs = (await this.imagesModel.collection
      .find({}, { projection: { _id: 0, batch_key: 1, images: 1 } })
      .toArray()) as Array<{
      batch_key?: string;
      images?: Array<Record<string, unknown>>;
    }>;
    return docs.flatMap((doc) =>
      (doc.images ?? []).map((entry) => ({
        batch_key: doc.batch_key,
        ...entry,
      })),
    );
  }
}
