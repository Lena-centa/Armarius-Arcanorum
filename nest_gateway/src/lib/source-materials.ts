/**
 * 源素材登记(source-materials.ts)。
 *
 * 解决的问题:ComfyUI 执行 i2i/Inpaint/ControlNet 时,输入素材保存在
 * `input/`、`temp/`、`clipspace/` 下。历史实现只归档 `output` 类型,
 * 输入素材从未进库——生成图入库后其所有上游父节点在数据库中物理不存在,
 * `image_lineage_edges.status` 永远停在 unresolved(实测 230 条边 resolved 恒为 0)。
 *
 * 本模块把 ReplayInputsService 取回的素材(仅存于 ComfyUI、库内没有的源图)
 * 写成可被血缘解析的库内记录,是血缘回路闭合的落地一步。
 *
 * 与主数据流的隔离(素材不是"我的作品",不能混进用户可见面):
 *   - `recipe_key` 写空串:recipe_groups 重建的谓词是
 *     `recipe_key IS NOT NULL AND recipe_key != ''` → 素材不进配方组
 *   - 无 prompt/workflow → `has_positive = 0` → 主列表(`has_positive = 1`)
 *     与统计(`has_parsed_workflow = 1`)都不返回它
 *   - 只写 `batches` + `batch_images` 两张表:不写 stats_docs、不写 FTS,
 *     统计口径与检索面都不受影响
 *
 * 幂等:靠 `content_sha256` 判重——素材是内容寻址落盘的,同一张图被多个
 * 任务引用时内容相同,重复登记会收敛到一行;若放任重复,按内容哈希解析
 * 父图会从"唯一命中"退化成"多解 ambiguous"。
 */

import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import { basename, extname } from 'path';

/** 登记结果计数。 */
export interface RegisterSourceMaterialsResult {
  /** 成功登记(或已存在而跳过写入)的素材数 */
  registered: number;
  /** 跳过数(文件不存在/读取失败/记录无路径) */
  skipped: number;
}

/** 素材批次在库中的标记:素材没有配方,不与任何真实配方归组。 */
const MATERIAL_RECIPE_KEY = '';

/**
 * 登记源素材为可解析的库内记录。
 *
 * @param db        SQLite 库(素材只在 SQLite 侧登记;Mongo 侧由同一记录的
 *                  既有双写路径处理,本函数不直接操作 Mongo)
 * @param paths     素材落盘路径(ReplayInputsService.captureMaterials 产出)
 * @param parseFn   解析函数(与归档同一套;真实实现走 parse worker)
 * @param scanRoot  扫描根(传给 parseFn 作相对路径基准;素材不在扫描根下,
 *                  parser 会回退为文件名)
 * @returns 登记/跳过计数
 *
 * 内部逻辑(逐素材):
 *   1. 文件必须存在且可读,否则跳过
 *   2. 计算真实内容哈希(素材已内容寻址命名,这里重算以对内容负责,
 *      不信任文件名)
 *   3. 库内已有同内容哈希 → 跳过(幂等)
 *   4. parseFn 解析出 record(文件无内嵌元数据时 parser 仍产出 file 字段)
 *   5. 单事务写 batches(recipe_key 空、has_positive 0)+ batch_images
 *      (含 content_sha256 物化列,血缘直接点查得到)
 *
 * 边界:单素材失败只计数不抛出——素材登记是生成流程的收尾增强,
 * 任何失败都不该影响已完成的生成归档。
 */
export async function registerSourceMaterials(
  db: Database.Database,
  paths: string[],
  parseFn: (path: string, scanRoot: string) => Promise<Record<string, unknown>>,
  scanRoot: string,
): Promise<RegisterSourceMaterialsResult> {
  const result: RegisterSourceMaterialsResult = { registered: 0, skipped: 0 };
  const insertBatch = db.prepare(
    `INSERT OR REPLACE INTO batches(
      batch_key, captured_at, created_date, created_hour, created_weekday,
      recipe_key, batch_count, base_model, has_positive, search_text, doc_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insertImage = db.prepare(
    `INSERT OR REPLACE INTO batch_images(
      batch_key, resolved_path, source_path, filename, image_name, sha256,
      content_sha256, mtime_ns, size_bytes, captured_at, image_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );

  for (const path of paths) {
    try {
      if (!path || !existsSync(path) || !statSync(path).isFile()) {
        result.skipped += 1;
        continue;
      }
      const bytes = readFileSync(path);
      const digest = createHash('sha256').update(bytes).digest('hex');
      const known = db
        .prepare('SELECT 1 FROM batch_images WHERE content_sha256 = ? LIMIT 1')
        .get(digest);
      if (known) {
        result.registered += 1; // 已登记:幂等跳过,计成功
        continue;
      }

      const record = await parseFn(path, scanRoot);
      const file = (record.file as Record<string, unknown> | undefined) ?? {};
      const batchKey = String(
        record.batch_key ?? file.resolved_path ?? path,
      ).trim();
      const resolvedPath = String(file.resolved_path ?? path).trim();
      if (!batchKey || !resolvedPath) {
        result.skipped += 1;
        continue;
      }
      const fileInfo = {
        ...file,
        resolved_path: resolvedPath,
        filename: String(file.filename ?? basename(resolvedPath)),
        image_name: String(
          file.image_name ?? basename(resolvedPath, extname(resolvedPath)),
        ),
        content_sha256: digest,
      };

      const insert = db.transaction(() => {
        insertBatch.run(
          batchKey,
          record.captured_at ? String(record.captured_at) : null,
          record.created_date ? String(record.created_date) : null,
          null,
          null,
          MATERIAL_RECIPE_KEY,
          1,
          null,
          0, // has_positive=0:素材无 prompt,主列表过滤条件即把它挡在外面
          null, // search_text 留空:不进 FTS,检索面不受影响
          JSON.stringify({ batch_key: batchKey, file: fileInfo, images: [fileInfo] }),
        );
        insertImage.run(
          batchKey,
          resolvedPath,
          String(file.source_path ?? resolvedPath),
          fileInfo.filename,
          fileInfo.image_name,
          String(file.sha256 ?? ''),
          digest,
          Number(file.mtime_ns ?? 0),
          Number(file.size_bytes ?? 0),
          record.captured_at ? String(record.captured_at) : null,
          JSON.stringify({ file: fileInfo }),
        );
      });
      insert();
      result.registered += 1;
    } catch {
      result.skipped += 1;
    }
  }
  return result;
}
