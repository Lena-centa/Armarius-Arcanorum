/**
 * settings 模块 —— 设置服务(settings.service.ts)
 *
 * 职责:负责 .env 配置文件的读写与元信息管理,是设置页 API 的数据层:
 *   1. 元信息:META(全部可配置项定义)与 GROUPS(分组名列表)
 *   2. 平台文件选择:win32 → .env.windows,wsl → .env.wsl;
 *      平台覆盖文件不存在时回退共享 .env(旧部署兼容)
 *   3. 读:平台文件与共享 .env 合并解析,平台值优先
 *   4. 写:白名单 key + 防注入/超长校验 + 原子写入(临时文件 + rename),
 *      值为空串的 key 执行删除
 *
 * 安全设计:
 *   - MAX_VALUE_LENGTH=4096 防超大写入
 *   - 值含换行符(CR/LF)一律拒绝 —— 防 .env 注入新变量
 *   - 非 META 白名单的 key 忽略并告警
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';
import { resolveDataDir } from '../../config/data-dir';

/** 可选注入 token:指定数据目录(env 文件所在,测试用);缺省取 resolveDataDir()。 */
export const SETTINGS_DATA_DIR = 'SETTINGS_DATA_DIR';

/**
 * 单个可配置项的元信息(设置页渲染 + 写入白名单共用):
 *   key          环境变量名(如 NEST_GATEWAY_PORT),即写入 .env 的键
 *   group        所属分组(对应 GROUPS 里的组名)
 *   label        设置页展示名
 *   description  设置页说明文案
 *   type         输入控件类型:text 文本 / number 数字 / boolean 开关
 *   defaultValue 默认值(生效值缺省链的兜底)
 */
export interface SettingsMeta {
  key: string;
  group: string;
  label: string;
  description: string;
  type: 'text' | 'number' | 'boolean';
  defaultValue: string;
}

/**
 * 全部可配置项的静态元信息表 —— 也是 applyValues 的写入白名单
 * (不在表中的 key 一律拒绝写入)。按分组排列,分组名集合与 GROUPS 一致
 * (排列顺序与 GROUPS 数组不同)。
 */
const META: SettingsMeta[] = [
  {
    key: 'NEST_GATEWAY_PORT',
    group: '服务端口',
    label: 'Gateway 端口',
    description: 'NestJS Gateway 监听端口',
    type: 'number',
    defaultValue: '8009',
  },
  {
    key: 'MONGODB_URI',
    group: 'MongoDB',
    label: '连接串',
    description: '留空=SQLite;点"检测连接并切换"验证',
    type: 'text',
    defaultValue: '',
  },
  {
    key: 'MONGODB_DB',
    group: 'MongoDB',
    label: '数据库',
    description: '数据库名',
    type: 'text',
    defaultValue: 'comfy_workflow_archive',
  },
  {
    key: 'MONGODB_COLLECTION',
    group: 'MongoDB',
    label: 'images 集合',
    description: '图片记录集合',
    type: 'text',
    defaultValue: 'images',
  },
  {
    key: 'MONGODB_RECIPE_GROUPS_COLLECTION',
    group: 'MongoDB',
    label: 'recipe_groups 集合',
    description: '聚合结果集合',
    type: 'text',
    defaultValue: 'recipe_groups',
  },
  {
    key: 'MONGODB_STATS_DOC_CACHE_COLLECTION',
    group: 'MongoDB',
    label: 'stats_docs 集合',
    description: '统计文档缓存集合',
    type: 'text',
    defaultValue: 'stats_docs',
  },
  {
    key: 'MONGODB_STATS_SUMMARY_CACHE_COLLECTION',
    group: 'MongoDB',
    label: 'stats_summaries 集合',
    description: '统计摘要缓存集合',
    type: 'text',
    defaultValue: 'stats_summaries',
  },
  {
    key: 'COMFY_SCAN_ROOT',
    group: '扫描与 ComfyUI',
    label: '扫描根目录',
    description: '归档根目录,如 D:/erxx 或 /mnt/d/erxx',
    type: 'text',
    defaultValue: '',
  },
  {
    key: 'COMFYUI_BASE_URL',
    group: '扫描与 ComfyUI',
    label: 'ComfyUI 地址',
    description: 'ComfyUI 服务地址',
    type: 'text',
    defaultValue: 'http://127.0.0.1:8188',
  },
  {
    key: 'WORKFLOW_DB_SYNC_INTERVAL_SECONDS',
    group: '同步 / 备份',
    label: '同步周期(秒)',
    description: '后台全量扫描周期',
    type: 'number',
    defaultValue: '300',
  },
  {
    key: 'WORKFLOW_DB_INITIAL_SYNC',
    group: '同步 / 备份',
    label: '启动即同步',
    description: '启动触发一次同步,0 关闭',
    type: 'boolean',
    defaultValue: '1',
  },
  {
    key: 'WORKFLOW_DB_BACKUP_DIR',
    group: '同步 / 备份',
    label: '备份目录',
    description:
      '默认 SQLite 轨道用 VACUUM INTO 备份;Mongo 引擎则在该目录跑 mongodump。留空停用',
    type: 'text',
    defaultValue: '',
  },
  {
    key: 'WORKFLOW_DB_BACKUP_INTERVAL_DAYS',
    group: '同步 / 备份',
    label: '备份间隔(天)',
    description: '快照间隔,默认每周',
    type: 'number',
    defaultValue: '7',
  },
  {
    key: 'WORKFLOW_DB_COMFY_POLL_SECONDS',
    group: '近实时入库',
    label: 'ComfyUI 轮询(秒)',
    description: '轮询新生成的间隔,0 关闭',
    type: 'number',
    defaultValue: '3',
  },
  {
    key: 'WORKFLOW_DB_FLUSH_SECONDS',
    group: '近实时入库',
    label: '缓冲入库周期(秒)',
    description: '缓冲批量入库间隔',
    type: 'number',
    defaultValue: '15',
  },
  {
    key: 'COMFY_OUTPUT_DIR',
    group: '近实时入库',
    label: 'ComfyUI 输出目录',
    description: '留空自动探测;输出在扫描根之外时配置',
    type: 'text',
    defaultValue: '',
  },
  {
    key: 'WORKFLOW_DB_FS_WATCH',
    group: '近实时入库',
    label: '递归文件监听',
    description: 'Windows 原生递归监听,其他自动降级',
    type: 'boolean',
    defaultValue: '1',
  },
  {
    key: 'WORKFLOW_DB_ROOT',
    group: '部署 / Worker',
    label: '部署根目录',
    description: '部署根目录,留空自动探测',
    type: 'text',
    defaultValue: '',
  },
  {
    key: 'WORKER_PYTHON_BIN',
    group: '部署 / Worker',
    label: 'Python 解释器',
    description: '留空自动探测 venv 解释器',
    type: 'text',
    defaultValue: '',
  },
  {
    key: 'WORKER_CWD',
    group: '部署 / Worker',
    label: 'Worker 工作目录',
    description: '留空 = 部署根目录',
    type: 'text',
    defaultValue: '',
  },
  {
    key: 'WORKER_SPAWN_TIMEOUT_MS',
    group: '部署 / Worker',
    label: 'Worker 握手超时(ms)',
    description: 'worker ready 握手超时',
    type: 'number',
    defaultValue: '10000',
  },
  {
    key: 'WORKER_MAX_RESTARTS',
    group: '部署 / Worker',
    label: '重启上限',
    description: '连续失败重启上限',
    type: 'number',
    defaultValue: '3',
  },
  {
    key: 'SQLITE_DB_PATH',
    group: 'SQLite 主用化',
    label: '主库路径',
    description:
      '留空默认用户数据目录内 gray_workflow.sqlite3(设置页「数据目录」面板可查看)',
    type: 'text',
    defaultValue: '',
  },
  {
    key: 'SQLITE_DUAL_WRITE',
    group: 'SQLite 主用化',
    label: '双写开关',
    description: '写路径同时落 Mongo 与 SQLite',
    type: 'boolean',
    defaultValue: '0',
  },
  {
    key: 'SQLITE_READ',
    group: 'SQLite 主用化',
    label: '切读开关',
    description: '读路径走 SQLite',
    type: 'boolean',
    defaultValue: '0',
  },
  {
    key: 'WORKFLOW_DB_REMOTE',
    group: '多网关',
    label: '纯远程模式',
    description: '仅连远端 MongoDB,不建本地库、不扫描',
    type: 'boolean',
    defaultValue: '0',
  },
  {
    key: 'WORKFLOW_DB_INSTANCE_ID',
    group: '多网关',
    label: '实例标识',
    description: '多网关下的实例标识,留空默认主机名',
    type: 'text',
    defaultValue: '',
  },
  {
    key: 'WORKFLOW_DB_BASE_URL',
    group: '多网关',
    label: '对外访问地址',
    description: '对外地址,留空不参与图片透传',
    type: 'text',
    defaultValue: '',
  },
  {
    key: 'WORKFLOW_DB_PROXY_ALLOW_HOSTS',
    group: '多网关',
    label: '代理私网白名单',
    description: '允许图片代理访问的私网主机/IP,逗号分隔且不支持通配符',
    type: 'text',
    defaultValue: '',
  },
];

/** 分组名列表(设置页分组渲染顺序;与 META 中 group 值对应)。 */
const GROUPS = [
  '服务端口',
  'MongoDB',
  'SQLite 主用化',
  '扫描与 ComfyUI',
  '同步 / 备份',
  '近实时入库',
  '部署 / Worker',
  '多网关',
];

/** 单个配置值最大长度(防 .env 注入与超大写入)。 */
export const MAX_VALUE_LENGTH = 4096;

/**
 * 设置服务:.env 文件读写 + 元信息访问。
 * 字段说明:
 *   dataDir         用户数据目录(env 文件外置存放点;可选注入 SETTINGS_DATA_DIR)
 *   platformEnvFile 平台覆盖文件名(.env.windows / .env.wsl)
 *   envPath         实际读写目标:平台文件存在则用它,否则共享 .env
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private readonly envPath: string;
  private readonly dataDir: string;
  /** 平台覆盖文件名(.env.windows / .env.wsl),由 GPT 补丁引入的平台隔离机制。 */
  private readonly platformEnvFile: string;

  constructor(@Optional() @Inject(SETTINGS_DATA_DIR) dataDir?: string) {
    this.dataDir = dataDir ?? resolveDataDir();
    // 平台文件:win32 → .env.windows,其他(WSL) → .env.wsl
    this.platformEnvFile =
      process.platform === 'win32' ? '.env.windows' : '.env.wsl';
    // 平台覆盖文件存在时优先读写它;否则回退共享 .env
    this.envPath = existsSync(join(this.dataDir, this.platformEnvFile))
      ? join(this.dataDir, this.platformEnvFile)
      : join(this.dataDir, '.env');
  }

  /** 返回全部可配置项元信息(设置页渲染用,与白名单同源)。 */
  getMeta(): SettingsMeta[] {
    return META;
  }

  /** 返回分组名列表(设置页分组导航用)。 */
  getGroups(): string[] {
    return GROUPS;
  }

  /** 返回当前实际读写 .env 文件的绝对路径(供前端展示)。 */
  getFilePath(): string {
    return this.envPath;
  }

  /**
   * 平台覆盖文件与共享 .env 合并读取,平台值优先。
   * 返回值语义:
   *   exists  平台覆盖文件是否存在
   *   content 平台覆盖文件原始内容(不存在时为空串,供 /raw 展示)
   *   values  合并后的键值对(共享 .env 为底,平台文件覆盖同名 key)
   * @returns { exists, content, values }
   */
  getEnvFile(): {
    exists: boolean;
    content: string;
    values: Record<string, string>;
  } {
    // 共享 .env 始终作为底(不存在时为空对象)
    const sharedPath = join(this.dataDir, '.env');
    const shared = existsSync(sharedPath)
      ? parseEnvContent(readFileSync(sharedPath, 'utf8'))
      : {};
    let content = '';
    let values: Record<string, string> = shared;
    // 平台文件存在:合并覆盖(平台值优先)
    if (existsSync(this.envPath)) {
      content = readFileSync(this.envPath, 'utf8');
      values = { ...shared, ...parseEnvContent(content) };
    }
    return { exists: existsSync(this.envPath), content, values };
  }

  /**
   * 合并写入 .env:保留注释与未修改行;values 中值为空串的 key 会被删除;
   * 新 key 追加到文件末尾。原子写入(临时文件 + rename)。
   * 安全校验:值含换行符(防 .env 注入)或超长(>4096)一律拒绝并跳过。
   *
   * 处理步骤:
   *   1. 白名单过滤 + 逐值校验(换行 / 超长),空串进 removals
   *   2. 逐行重写:命中更新 key 的行替换为新值(保留原始行位置),
   *      命中删除 key 的行整体丢弃(含行内注释)
   *   3. 未出现过的新 key 追加到文件末尾
   *   4. 写临时文件 → rename 原子替换
   * @param values { KEY: value }(空串 = 删除该 key)
   * @returns { written: 写入的 key 列表, removed: 删除的 key 列表 }
   */
  applyValues(values: Record<string, string>): {
    written: string[];
    removed: string[];
  } {
    // 白名单:仅 META 中声明的 key 可写,未知 key 忽略并告警
    const allowed = new Set(META.map((m) => m.key));
    const updates: Record<string, string> = {};
    const removals: string[] = [];
    for (const [key, value] of Object.entries(values)) {
      if (!allowed.has(key)) {
        this.logger.warn(`ignored unknown settings key: ${key}`);
        continue;
      }
      const trimmed = String(value).trim();
      // 防 .env 注入:值里不允许出现换行(否则可借机写入新变量/注释)
      if (/[\r\n]/.test(trimmed)) {
        this.logger.warn(
          `ignored ${key}: value contains newline characters (possible .env injection)`,
        );
        continue;
      }
      // 防超大写入
      if (trimmed.length > MAX_VALUE_LENGTH) {
        this.logger.warn(
          `ignored ${key}: value exceeds ${MAX_VALUE_LENGTH} characters`,
        );
        continue;
      }
      // 空串语义 = 删除该 key;否则进更新集
      if (trimmed === '') {
        removals.push(key);
      } else {
        updates[key] = trimmed;
      }
    }

    // 读现有内容逐行处理(文件不存在视为空)
    const prev = existsSync(this.envPath)
      ? readFileSync(this.envPath, 'utf8')
      : '';
    const lines = prev.split('\n');
    // seen:本次已写入的新值 key(判断是否需要追加)
    const seen = new Set<string>();
    const out: string[] = [];

    // 第一遍:逐行保留/替换/删除
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, '');
      // 仅匹配 `KEY=value` 形态的行(注释与空行原样保留)
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m && (m[1] in updates || removals.includes(m[1]))) {
        if (m[1] in updates) {
          // 替换:保持该 key 在文件中的原有位置
          out.push(`${m[1]}=${updates[m[1]]}`);
          seen.add(m[1]);
        }
        // 删除:整行(含行内注释)丢弃
        continue;
      }
      out.push(line);
    }

    // 第二遍:补追加 —— 本次写入但文件里原本没有的 key 追加到末尾
    for (const key of Object.keys(updates)) {
      if (!seen.has(key)) {
        out.push(`${key}=${updates[key]}`);
      }
    }

    // 原子写入:先写 .tmp 再 rename(避免写一半损坏 .env);
    // 规范化:去末尾多余换行后统一补一个 \n
    const tmpPath = `${this.envPath}.tmp`;
    writeFileSync(tmpPath, out.join('\n').replace(/\n$/, '') + '\n', 'utf8');
    renameSync(tmpPath, this.envPath);

    return { written: Object.keys(updates), removed: removals };
  }
}

/**
 * 解析 .env 文本为键值对:
 *   - 忽略空行 / # 注释行 / 不含 = 的行
 *   - 首个 = 分割 key 与 value(值里的 = 保留)
 *   - 首尾引号(单/双,成对)剥除 —— 兼容 .env 引号包裹的值
 *   - 不做 ${} 插值/转义展开(仅读取原始文本)
 * @param content .env 原始文本
 * @returns 解析出的键值对(保留文件出现顺序)
 */
export function parseEnvContent(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) {
      continue;
    }
    // 首个 = 为分隔点(key 无 = 约束)
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // 成对引号剥除(如 VALUE="foo bar" → foo bar)
    if (
      value.length >= 2 &&
      value[0] === value[value.length - 1] &&
      (value[0] === '"' || value[0] === "'")
    ) {
      value = value.slice(1, -1);
    }
    if (key) {
      values[key] = value;
    }
  }
  return values;
}
