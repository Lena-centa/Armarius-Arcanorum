/**
 * settings 模块 —— 设置页 API 控制器(settings.controller.ts)
 *
 * 职责:提供设置页(.env 管理)与 MongoDB 连接切换能力:
 *   GET  /api/settings        设置元信息 + 文件现值 + 生效值(脱敏)
 *   GET  /api/settings/raw    .env 原始内容(脱敏凭据)
 *   PUT  /api/settings        合并写回 .env(白名单 key,防注入校验)
 *   POST /api/settings/test-mongo  MongoDB 连接检测 → 通过则写入配置切换引擎
 *   GET  /api/settings/data-status 数据目录与迁移可用性状态
 *   POST /api/settings/migrate     在线迁移主库到数据目录默认位置(通道 B)
 *
 * 类级 @RequireAuth:整个控制器所有端点都要求登录,
 * 因为 .env 内容属于敏感配置。
 *
 * 脱敏策略:所有输出路径都对 mongodb 连接串做凭据打码,
 * 避免 user:pass 泄露到前端日志与响应。
 */
import { Body, Controller, Get, Inject, Post, Put } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongoClient } from 'mongodb';
import { existsSync, mkdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { RequireAuth } from '../../common/auth';
import { DB_FILENAME, REPO_ROOT, resolveDataDir } from '../../config';
import {
  copyLegacyEnvFiles,
  stripSqliteDbPathKey,
} from '../../bootstrap/data-dir-migration';
import { SQLITE_DB } from '../../sqlite/sqlite.module';
import { SettingsService } from './settings.service';

/** MongoDB 连接串 scheme 白名单正则(仅接受 mongodb:// 与 mongodb+srv://)。 */
const MONGO_SCHEME_RE = /^mongodb(?:\+srv)?:\/\//;

/**
 * 脱敏形如 mongodb://user:pass@host 的凭据,保留 host 可读:
 * mongodb://user:pass@db.example.com:27017 → mongodb://***@db.example.com:27017。
 * 正则说明:(mongodb(?:\+srv)?://) 锚定 scheme,`[^@\s]+@` 匹配
 * "user:pass@"(不含 @ 与空白的整段),整体替换为 `$1***@`(大小写不敏感)。
 * @param text 原始文本(可能含多个连接串)
 * @returns 凭据打码后的文本
 */
export function sanitizeMongoCredentials(text: string): string {
  return text.replace(/(mongodb(?:\+srv)?:\/\/)[^@\s]+@/gi, '$1***@');
}

@RequireAuth()
@Controller('api/settings')
export class SettingsController {
  /** 运行态迁移进行中标记(防双击/并发触发)。 */
  private migrating = false;

  constructor(
    private readonly settings: SettingsService,
    private readonly config: ConfigService,
    @Inject(SQLITE_DB) private readonly db: Database.Database,
  ) {}

  /**
   * GET /api/settings — 设置页全量数据。
   * 组装四类信息:
   *   values:.env 文件现值(脱敏,空 key 不出现)
   *   effective:进程生效值(优先环境变量,缺省用元信息 defaultValue)
   *   meta:全部可配置项元信息(键/分组/说明/默认值/类型)
   *   groups:分组名列表;engine:当前数据引擎
   * @returns 设置页渲染所需的完整结构
   */
  @Get()
  get(): {
    file_path: string;
    file_exists: boolean;
    values: Record<string, string>;
    effective: Record<string, string>;
    meta: ReturnType<SettingsService['getMeta']>;
    groups: string[];
    /** 当前数据引擎:sqlite(SQLite 单引擎) | mongo | remote-pending(纯远程待配库) */
    engine: string;
  } {
    const file = this.settings.getEnvFile();
    // 文件现值:逐 key 脱敏(防凭据泄露到前端)
    const values: Record<string, string> = {};
    for (const [key, val] of Object.entries(file.values)) {
      values[key] = sanitizeMongoCredentials(val);
    }
    // 生效值:优先进程环境变量(启动时已加载),否则元信息默认值
    const effective: Record<string, string> = {};
    for (const item of this.settings.getMeta()) {
      const val = process.env[item.key];
      effective[item.key] = val == null ? item.defaultValue : val;
    }
    return {
      file_path: this.settings.getFilePath(),
      file_exists: file.exists,
      values,
      effective,
      meta: this.settings.getMeta(),
      groups: this.settings.getGroups(),
      engine: this.config.get<string>('engine') ?? 'sqlite',
    };
  }

  /**
   * GET /api/settings/raw — .env 原始文件内容(脱敏凭据)。
   * 供"查看文件"类 UI 使用;返回整体内容字符串而非逐行解析。
   * @returns { content, file_path }
   */
  @Get('raw')
  raw(): { content: string; file_path: string } {
    const file = this.settings.getEnvFile();
    return {
      content: sanitizeMongoCredentials(file.content),
      file_path: this.settings.getFilePath(),
    };
  }

  /**
   * PUT /api/settings — 批量写回 .env。
   * values 非对象时按空集处理(静默);写操作委托 SettingsService.applyValues
   * (内部做 key 白名单 / 换行注入 / 超长校验)。
   * restart_required 恒为 true:环境变量只在进程启动时读取,改 .env 必须重启。
   * @param body { values?: { KEY: value } }
   * @returns { ok, written, removed, file_path, restart_required }
   */
  @Put()
  put(@Body() body: { values?: Record<string, string> }): {
    ok: boolean;
    written: string[];
    removed: string[];
    file_path: string;
    restart_required: boolean;
  } {
    // 防御:body.values 非对象(如数组/字符串)时按空对象处理
    const values =
      body?.values && typeof body.values === 'object' ? body.values : {};
    // 委托 service 执行合并写(含校验与原子写)
    const result = this.settings.applyValues(values);
    return {
      ok: true,
      written: result.written,
      removed: result.removed,
      file_path: this.settings.getFilePath(),
      // 环境变量在进程启动时读取,修改 .env 后需重启才生效
      restart_required: true,
    };
  }

  /**
   * POST /api/settings/test-mongo — MongoDB 连接检测 + 引擎切换。
   * 完整流程:
   *   1. 取 uri/db:body 优先,缺省回退环境配置(mongo.uri / mongo.db)
   *   2. 前置校验:uri 必填、scheme 白名单(mongodb/mongodb+srv)、
   *      db 名禁止为 admin
   *   3. 真实连接 + ping(serverSelectionTimeoutMS 4s)
   *   4. 在目标库建临时集合并读写后删除 —— 验证"连接通畅且可新建库"
   *      (库不存在时 createCollection 即建库,等价验证建库权限)
   *   5. 通过 → 写 MONGODB_URI / MONGODB_DB / SQLITE_READ=0,
   *      重启后切换为 MongoDB;失败 → 保持 SQLite 单引擎
   * 全程 try/finally 关闭 client;失败返回 ok=false 而非抛异常。
   * @param body { uri?, db? } 待检测连接串与库名(可省略走环境值)
   * @returns { ok, message, latency_ms, written?, restart_required? }
   */
  @Post('test-mongo')
  async testMongo(@Body() body: { uri?: string; db?: string }): Promise<{
    ok: boolean;
    message: string;
    latency_ms: number;
    written?: string[];
    restart_required?: boolean;
  }> {
    // 参数回退链:body.uri → 环境 mongo.uri;body.db → 环境 mongo.db → 默认库名
    const uri =
      String(body?.uri ?? '').trim() ||
      (this.config.get<string>('mongo.uri') ?? '').trim();
    const dbName =
      String(body?.db ?? '').trim() ||
      (this.config.get<string>('mongo.db') ?? 'comfy_workflow_archive');
    // uri 缺失:当前即 SQLite 单引擎,直接返回说明(不执行检测)
    if (!uri) {
      return {
        ok: false,
        message:
          '未提供 uri 且环境未配置 MongoDB 连接串,当前使用 SQLite 单引擎',
        latency_ms: 0,
      };
    }
    // scheme 白名单:拒绝非 mongodb 协议(防任意连接串注入)
    if (!MONGO_SCHEME_RE.test(uri)) {
      return {
        ok: false,
        message: '仅支持 mongodb:// 或 mongodb+srv:// 连接串',
        latency_ms: 0,
      };
    }
    // admin 库禁止作为业务库(防误用系统库)
    if (dbName.toLowerCase() === 'admin') {
      return {
        ok: false,
        message: '数据库名禁止为 admin',
        latency_ms: 0,
      };
    }
    const t0 = Date.now();
    let client: MongoClient | null = null;
    try {
      // 带超时构造并连接(4s 内选主失败即判不可达)
      client = new MongoClient(uri, {
        serverSelectionTimeoutMS: 4000,
        connectTimeoutMS: 4000,
      });
      await client.connect();
      // ping 验证连通性(admin 库的 ping 命令)
      await client.db('admin').command({ ping: 1 });

      // 建临时集合读写删:证明目标库可新建(不存在则 createCollection 建库)
      const probe = `__conn_probe_${Date.now().toString(36)}`;
      const target = client.db(dbName);
      await target.createCollection(probe);
      await target.collection(probe).insertOne({ probe: true });
      await target.collection(probe).deleteOne({ probe: true });
      // 清理临时集合(失败忽略 —— drop 不存在会抛错,这里静默)
      await target.dropCollection(probe).catch(() => undefined);

      const latencyMs = Date.now() - t0;
      // 检测通过:写入切换配置(重启后生效)
      const applied = this.settings.applyValues({
        MONGODB_URI: uri,
        MONGODB_DB: dbName,
        // 关闭单引擎强制开关,重启后真正切换为 MongoDB
        SQLITE_READ: '0',
      });
      return {
        ok: true,
        message: `连接通畅,可新建库(延迟 ${latencyMs}ms);已写入配置,重启服务后切换为 MongoDB`,
        latency_ms: latencyMs,
        written: applied.written,
        restart_required: true,
      };
    } catch (err) {
      // 任一环节失败:保持 SQLite 单引擎,返回失败原因(截断 300 字符)
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        message: `检测未通过,保持 SQLite 单引擎: ${msg.slice(0, 300)}`,
        latency_ms: Date.now() - t0,
      };
    } finally {
      // 无论成败都要关闭 client(防连接泄漏)
      await client?.close().catch(() => undefined);
    }
  }

  /**
   * GET /api/settings/data-status — 数据目录与迁移可用性状态。
   * 供设置页「数据目录」面板展示:当前数据目录 / env 文件 / 主库位置与
   * 大小,以及旧仓库 data/ 是否仍有待迁移数据。
   */
  @Get('data-status')
  dataStatus(): {
    data_dir: string;
    env_file: { path: string; exists: boolean };
    db_path: string;
    db_exists: boolean;
    db_size_bytes: number;
    legacy: {
      data_dir: string;
      db_path: string;
      db_exists: boolean;
      db_size_bytes: number;
      env_exists: boolean;
    };
    engine: string;
  } {
    const sizeOf = (filePath: string): number => {
      try {
        return statSync(filePath).size;
      } catch {
        return 0;
      }
    };
    const dataDir = this.config.get<string>('dataDir') ?? resolveDataDir();
    const dbPath = this.config.get<string>('sqlite.dbPath') ?? '';
    const envPath = this.settings.getFilePath();
    const repoRoot = this.config.get<string>('repoRoot') ?? REPO_ROOT;
    const legacyDataDir = join(repoRoot, 'data');
    const legacyDb = join(legacyDataDir, DB_FILENAME);
    const dbExists = !!dbPath && dbPath !== ':memory:' && existsSync(dbPath);
    return {
      data_dir: dataDir,
      env_file: { path: envPath, exists: existsSync(envPath) },
      db_path: dbPath,
      db_exists: dbExists,
      db_size_bytes: dbExists ? sizeOf(dbPath) : 0,
      legacy: {
        data_dir: legacyDataDir,
        db_path: legacyDb,
        db_exists: existsSync(legacyDb),
        db_size_bytes: sizeOf(legacyDb),
        env_exists: existsSync(join(repoRoot, '.env')),
      },
      engine: this.config.get<string>('engine') ?? 'sqlite',
    };
  }

  /**
   * POST /api/settings/migrate — 运行态手动迁移(通道 B)。
   *
   * 经 better-sqlite3 backup(VACUUM INTO 语义)把当前主库安全复制到
   * 数据目录默认位置 —— 在线执行、无需停服、天然规避 -wal/-shm 手工搬运。
   * 随后把旧仓库根 env 三件套复制到数据目录(缺失才复制),并清除数据目录
   * 内生效的 SQLITE_DB_PATH 键 —— 否则重启后仍指向旧路径,等于没迁完。
   * 原库全程只读不受影响;失败时清理半成品目标文件。
   */
  @Post('migrate')
  async migrate(): Promise<{
    ok: boolean;
    message: string;
    restart_required?: boolean;
  }> {
    if (this.migrating) {
      return { ok: false, message: '迁移正在进行中,请稍候' };
    }
    const dataDir = resolveDataDir();
    const targetDb = join(dataDir, DB_FILENAME);
    const currentDbPath = this.config.get<string>('sqlite.dbPath') ?? '';
    const norm = (value: string): string =>
      value.replace(/[\\/]+$/, '').toLowerCase();
    if (!currentDbPath || currentDbPath === ':memory:') {
      return { ok: false, message: '纯远程模式无本地主库可迁移' };
    }
    if (norm(currentDbPath) === norm(targetDb)) {
      return { ok: false, message: '主库已在数据目录默认位置,无需迁移' };
    }
    if (!existsSync(currentDbPath)) {
      return { ok: false, message: `当前主库不存在: ${currentDbPath}` };
    }
    if (existsSync(targetDb)) {
      return {
        ok: false,
        message: `数据目录已存在主库(${targetDb}),拒绝覆盖;确认无用后手动清理再试`,
      };
    }

    this.migrating = true;
    try {
      mkdirSync(dataDir, { recursive: true });
      // 在线备份:输出自包含快照(WAL 内容一并折叠),原库继续服务
      await this.db.backup(targetDb);
      const check = new Database(targetDb);
      const quick = check.pragma('quick_check(1)', { simple: true });
      check.close();
      if (quick !== 'ok') {
        throw new Error(`quick_check failed: ${quick}`);
      }
      copyLegacyEnvFiles(REPO_ROOT, dataDir);
      for (const name of ['.env', '.env.windows', '.env.wsl']) {
        stripSqliteDbPathKey(join(dataDir, name));
      }
      const osExplicit = process.env.SQLITE_DB_PATH?.trim();
      return {
        ok: true,
        restart_required: true,
        message: osExplicit
          ? `已迁移至 ${targetDb};注意进程环境变量 SQLITE_DB_PATH 仍显式指旧路径,重启前请移除该环境变量`
          : `已迁移至数据目录(${targetDb}),重启服务后生效`,
      };
    } catch (err) {
      // 失败清理半成品目标(主库 + 校验期可能产生的伴生文件)
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          if (existsSync(targetDb + suffix)) {
            unlinkSync(targetDb + suffix);
          }
        } catch {
          /* 清理失败不掩盖原始错误 */
        }
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        message: `迁移失败: ${msg.slice(0, 300)}(原库未受影响)`,
      };
    } finally {
      this.migrating = false;
    }
  }
}
