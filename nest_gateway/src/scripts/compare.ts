/**
 * Phase 2 task 2.7 — fixture 双跑对比脚本。
 *
 * 对每个 fixture(旧 parser.parse_image 输出的黄金样本):
 *   1. 取 file.source_path 指向的源图
 *   2. spawn Python parse_worker,调 JSON-RPC `parse_image(path, scan_root)`
 *   3. 将 worker 返回的 record 与 fixture record 做 deep-equal
 *      (忽略时间相关字段 + Mongo 注入字段,见 IGNORE_PATHS)
 *   4. 记录 PASS / FAIL(diff 路径)/ SKIP(源图缺失)
 *
 * 验收口径参照 docs/contracts/parse_worker_protocol.md §9.3
 *   (51 个 fixtures byte-equal,时间字段除外)
 * 与 docs/archive/NEST_GATEWAY_MIGRATION_PLAN.md Phase 2
 *   (50 条 fixtures 全绿):
 *   "51 个 fixtures 喂 parse worker,与旧 FastAPI 输出 byte-equal(时间字段除外)"
 *
 * 用法:
 *   npx ts-node src/scripts/compare.ts [--scan-root PATH] [--fixtures-dir DIR]
 *                                      [--strict] [--json] [--limit N]
 *
 * 退出码:0 = 全部通过(含 SKIP);1 = 至少一个 FAIL;2 = 脚本自身错误。
 *
 * 数据流向:
 *   fixtures/records/*.json(黄金样本)→ compareOne(逐条)→ WorkerClient
 *   (spawn workflow_db.parse_worker,stdin/stdout 走 NDJSON JSON-RPC)
 *   → 返回 record → deepDiff(fixture, record)→ PASS/FAIL 报告。
 */

import { spawn, ChildProcess } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { loadRepoEnv } from './env';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

// 注入数据目录 .env(COMFY_SCAN_ROOT 等),与运行时 gateway 环境统一
loadRepoEnv();

// 仓库根(本文件位于 <root>/nest_gateway/src/scripts/,上溯三级)
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
// 默认 fixture 目录:测试黄金样本所在处
const DEFAULT_FIXTURES_DIR = join(
  REPO_ROOT,
  'nest_gateway',
  'test',
  '__fixtures__',
  'records',
);
// 默认扫描根:来自环境变量(必须配置,否则脚本拒绝运行)
const DEFAULT_SCAN_ROOT = process.env.COMFY_SCAN_ROOT ?? '';
// 默认 python 解释器:优先环境变量,回退到仓库 venv
// (Windows 为 venv/Scripts/python.exe,WSL/Linux 为 venv/bin/python)
const DEFAULT_PYTHON_BIN =
  process.env.WORKER_PYTHON_BIN ??
  join(
    REPO_ROOT,
    'venv',
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python',
  );

/**
 * 深度对比时忽略的字段路径(点号分隔)。
 *
 * - 时间字段:依赖文件 mtime,fixture 抽样后文件可能被 touch/复制,
 *   故一律忽略(协议 §9.3 明确"时间字段除外")。
 * - recipe_key:parser.parse_image 不输出,由 Mongo 层注入(见
 *   collect_fixtures.py to_record),非 parser 行为契约一部分。
 *
 * --strict 模式下置空集合,对时间字段也做严格对比(调试用)。
 */
const IGNORE_PATHS = new Set<string>([
  'captured_at',
  'created_date',
  'created_hour',
  'created_weekday',
  'file.mtime',
  'file.mtime_ns',
  'recipe_key',
]);

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

/**
 * 命令行参数集合:
 *   - fixturesDir:黄金样本目录
 *   - scanRoot:传给 parse_image 的 scan_root
 *   - pythonBin / workerCwd:worker 进程的解释器与工作目录
 *   - strict:不忽略时间字段
 *   - json:输出机器可读 JSON 报告(供 CI 解析)
 *   - limit:只跑前 N 个 fixture(抽样调试)
 */
interface CliArgs {
  fixturesDir: string;
  scanRoot: string;
  pythonBin: string;
  workerCwd: string;
  strict: boolean;
  json: boolean;
  limit: number | undefined;
}

/**
 * 手动解析 argv(不引入 arg-parser 依赖):支持
 * --fixtures-dir / --scan-root / --python-bin / --worker-cwd(各带一个值)、
 * --strict / --json(布尔)、--limit(数值)、--help / -h。
 * 未知参数输出错误并以退出码 2 结束。
 */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    fixturesDir: DEFAULT_FIXTURES_DIR,
    scanRoot: DEFAULT_SCAN_ROOT,
    pythonBin: DEFAULT_PYTHON_BIN,
    workerCwd: REPO_ROOT,
    strict: false,
    json: false,
    limit: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--fixtures-dir':
        args.fixturesDir = next;
        i += 1; // 消费参数值,跳过下一轮循环
        break;
      case '--scan-root':
        args.scanRoot = next;
        i += 1;
        break;
      case '--python-bin':
        args.pythonBin = next;
        i += 1;
        break;
      case '--worker-cwd':
        args.workerCwd = next;
        i += 1;
        break;
      case '--strict':
        args.strict = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--limit':
        args.limit = Number.parseInt(next, 10);
        i += 1;
        break;
      case '--help':
      case '-h':
        // 用法说明直接输出到 stdout 并正常退出
        process.stdout.write(
          [
            'Usage: compare.ts [options]',
            '  --fixtures-dir DIR   fixture records 目录',
            '  --scan-root PATH     parse_image scan_root 参数',
            '  --python-bin PATH    python 解释器路径',
            '  --worker-cwd DIR     worker 进程 cwd',
            '  --strict             不忽略时间字段',
            '  --json               输出机器可读 JSON 报告',
            '  --limit N            只跑前 N 个 fixture',
            '',
          ].join('\n'),
        );
        process.exit(0);
        break;
      default:
        process.stderr.write(`unknown arg: ${a}\n`);
        process.exit(2);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// 轻量 worker client(不复用 NestJS Supervisor,避免拉起整个 Nest 容器)
// ---------------------------------------------------------------------------

/**
 * JSON-RPC 响应结构:
 *   - id:请求 id(对应请求方生成)
 *   - result:成功负载(parse_image 的 record 在 result.record)
 *   - error:失败负载(code + message)
 */
interface RpcResponse {
  id: string;
  result?: { record?: Record<string, unknown> };
  error?: { code: number; message: string };
}

/**
 * 轻量 worker 客户端:spawn 单个 Python parse_worker 进程,
 * 通过 stdin/stdout 的 NDJSON(每行一个 JSON)做 JSON-RPC 2.0 通信。
 *
 * 为什么不复用 NestJS Supervisor:对比脚本要的是最小依赖、
 * 单进程跑完即退,拉起 Nest 容器会引入 DB/MQ 等无关依赖与启动开销。
 *
 * 协议时序:
 *   1. start():spawn 进程,stdout 行解析等待 `{"type":"ready"}` 握手
 *      (10s 超时)
 *   2. call():写一行 JSON-RPC 请求,登记 pending;响应按 id 回填
 *   3. stop():关闭 stdin 并 SIGTERM
 */
class WorkerClient {
  private child: ChildProcess | null = null;
  // stdout 行缓冲(worker 可能一次写入多条消息,需按 \n 切分)
  private buffer = '';
  // 请求序号:每个请求分配自增 id(格式 cmp_<n>)
  private seq = 0;
  // 在途请求表:id → resolve/reject,响应到达时按 id 精确匹配
  private pending = new Map<
    string,
    { resolve: (v: RpcResponse) => void; reject: (e: Error) => void }
  >();

  constructor(
    private readonly pythonBin: string,
    private readonly cwd: string,
  ) {}

  /**
   * 启动 worker 进程并等待 ready 握手。
   * @throws worker 启动失败 / 10s 内未收到 ready 时 reject
   */
  async start(): Promise<void> {
    // 通过 `python -m workflow_db.parse_worker` 启动(cwd 决定模块可见性)
    this.child = spawn(this.pythonBin, ['-m', 'workflow_db.parse_worker'], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.onData(chunk));
    this.child.stderr?.on('data', () => {
      /* worker 日志忽略,不打扰对比输出 */
    });
    await this.waitReady();
  }

  /**
   * 等待 ready 握手:挂载 readyProbe 钩子,10s 超时 reject。
   * 钩子被 onData 在收到 `{"type":"ready"}` 时触发并清空。
   */
  private waitReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyProbe = null;
        reject(new Error('worker ready handshake timed out (10s)'));
      }, 10_000);
      this.readyProbe = (msg: Record<string, unknown>) => {
        if (msg.type === 'ready') {
          clearTimeout(timer);
          this.readyProbe = null;
          resolve();
        }
      };
    });
  }

  // ready 探测钩子(仅握手阶段挂载,收到 ready 后置空)
  private readyProbe: ((msg: Record<string, unknown>) => void) | null = null;

  /**
   * stdout 行分发:缓冲 → 按 \n 切完整行 → JSON.parse → 分发。
   * 分发规则:
   *   - ready 消息:交给 readyProbe(仅握手期)
   *   - 其余(带 id 或 type=rpc):当作 RPC 响应,按 id 匹配 pending,
   *     命中则 resolve 并移出在途表
   * 非 JSON 行(如 worker 的 print 污染)静默跳过,不影响对比。
   */
  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl < 0) break; // 行不完整,留在缓冲等下次 data
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // 非 JSON 行(日志/异常栈),忽略
      }
      if (msg.type === 'ready' && this.readyProbe) {
        this.readyProbe(msg);
        this.readyProbe = null;
        continue;
      }
      if (msg.type === 'rpc' || msg.id) {
        const resp = msg as unknown as RpcResponse;
        const id = String(resp.id);
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          p.resolve(resp);
        }
      }
    }
  }

  /**
   * 发送一个 JSON-RPC 调用。
   *
   * @param method 方法名(如 parse_image / ping)
   * @param params 参数对象
   * @returns 响应 Promise;超时(parse_image 30s / ping 2s)reject,
   *          响应已返回的请求不受超时影响(超时先查在途表)
   */
  call(method: string, params: Record<string, unknown>): Promise<RpcResponse> {
    this.seq += 1;
    const id = `cmp_${this.seq}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child?.stdin?.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
      );
      // 超时保护:parse_image 单图解析上限 30s(首次冷启动更慢),
      // ping 用于探活只需 2s;超时只 reject 仍悬挂的请求
      setTimeout(
        () => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            reject(new Error(`rpc timeout: ${method}`));
          }
        },
        method === 'ping' ? 2_000 : 30_000,
      );
    });
  }

  /** 关闭 worker:先关 stdin(通知 worker EOF),再 SIGTERM 兜底。 */
  stop(): void {
    this.child?.stdin?.end();
    this.child?.kill('SIGTERM');
    this.child = null;
  }
}

// ---------------------------------------------------------------------------
// deep-equal(带忽略路径)
// ---------------------------------------------------------------------------

/**
 * 对比结果:
 *   - equal:是否一致
 *   - diffs:差异明细(path 为点号/下标路径,expected/actual 为两侧值)
 */
interface DiffResult {
  equal: boolean;
  diffs: Array<{ path: string; expected: unknown; actual: unknown }>;
}

/**
 * 递归 deep-compare(带忽略路径集合)。
 *
 * 判定顺序:
 *   1. 路径在 ignore 集合 → 视为相等
 *   2. typeof 不同 → 不等(如 string vs number)
 *   3. null/undefined 参与比较(用 !== 判定)
 *   4. 双方数组 → 长度不等即报差异(元素级对比带 [i] 下标路径)
 *   5. 双方对象 → 键并集遍历;仅一侧存在的键报 <missing>;值递归
 *   6. 标量 → 数值有浮点容差(见下),其余用 !==
 *
 * 浮点容差:与 parser.py LORA_STRENGTH_EPSILON = 1e-9 对齐——
 * fixture 来自 Mongo BSON double 序列化,机器 epsilon 级漂移
 * (如 0.15 vs 0.1499999999999998,diff ≈ 2e-16)不算行为差异。
 * NaN 与 NaN 视为相等。
 */
function deepDiff(
  expected: unknown,
  actual: unknown,
  path: string,
  ignore: Set<string>,
): DiffResult {
  if (ignore.has(path)) {
    return { equal: true, diffs: [] };
  }
  // 类型不同
  if (typeof expected !== typeof actual) {
    return { equal: false, diffs: [{ path, expected, actual }] };
  }
  // null / undefined
  if (
    expected === null ||
    actual === null ||
    expected === undefined ||
    actual === undefined
  ) {
    if (expected !== actual) {
      return { equal: false, diffs: [{ path, expected, actual }] };
    }
    return { equal: true, diffs: [] };
  }
  // 数组
  if (Array.isArray(expected) && Array.isArray(actual)) {
    // 长度不同直接报差(展示长度摘要,不逐元素对齐)
    if (expected.length !== actual.length) {
      return {
        equal: false,
        diffs: [
          {
            path,
            expected: `[len=${expected.length}]`,
            actual: `[len=${actual.length}]`,
          },
        ],
      };
    }
    const diffs: DiffResult['diffs'] = [];
    for (let i = 0; i < expected.length; i += 1) {
      const sub = deepDiff(expected[i], actual[i], `${path}[${i}]`, ignore);
      if (!sub.equal) diffs.push(...sub.diffs);
    }
    return { equal: diffs.length === 0, diffs };
  }
  // 对象
  if (typeof expected === 'object' && typeof actual === 'object') {
    const expObj = expected as Record<string, unknown>;
    const actObj = actual as Record<string, unknown>;
    // 键并集遍历:同时覆盖"预期多键 / 实际多键"两种情况
    const keys = new Set([...Object.keys(expObj), ...Object.keys(actObj)]);
    const diffs: DiffResult['diffs'] = [];
    for (const k of keys) {
      const childPath = path ? `${path}.${k}` : k;
      if (ignore.has(childPath)) continue;
      if (!(k in expObj)) {
        diffs.push({
          path: childPath,
          expected: '<missing>',
          actual: actObj[k],
        });
        continue;
      }
      if (!(k in actObj)) {
        diffs.push({
          path: childPath,
          expected: expObj[k],
          actual: '<missing>',
        });
        continue;
      }
      const sub = deepDiff(expObj[k], actObj[k], childPath, ignore);
      if (!sub.equal) diffs.push(...sub.diffs);
    }
    return { equal: diffs.length === 0, diffs };
  }
  // 标量
  if (typeof expected === 'number' && typeof actual === 'number') {
    // 浮点容差:与 parser.py LORA_STRENGTH_EPSILON = 1e-9 对齐。
    // 双跑对比中 fixture 来自 Mongo BSON double 存储,经序列化后
    // 可能出现机器 epsilon 级漂移(如 0.15 vs 0.1499999999999998,
    // diff ≈ 2e-16),这不是 parser 行为差异,应容忍。
    if (Number.isNaN(expected) && Number.isNaN(actual)) {
      return { equal: true, diffs: [] };
    }
    if (Math.abs(expected - actual) <= 1e-9) {
      return { equal: true, diffs: [] };
    }
  }
  if (expected !== actual) {
    return { equal: false, diffs: [{ path, expected, actual }] };
  }
  return { equal: true, diffs: [] };
}

// ---------------------------------------------------------------------------
// 单个 fixture 比对
// ---------------------------------------------------------------------------

/** 单个 fixture 的结论:PASS = 一致,FAIL = 有差异/调用失败,SKIP = 无法执行。 */
type Outcome = 'PASS' | 'FAIL' | 'SKIP';

/**
 * 单个 fixture 的结果记录:
 *   - file:fixture 文件路径
 *   - outcome:结论
 *   - imagePath:源图路径(可缺)
 *   - skipReason:SKIP 原因
 *   - diffCount / diffs:差异统计与明细(FAIL 时)
 *   - error:调用层错误(FAIL 时)
 */
interface FixtureResult {
  file: string;
  outcome: Outcome;
  imagePath?: string;
  skipReason?: string;
  diffCount?: number;
  diffs?: Array<{ path: string; expected: unknown; actual: unknown }>;
  error?: string;
}

/**
 * 比对单个 fixture:
 *   1. 读 fixture JSON,取 file.source_path(回退 resolved_path)
 *   2. 源图缺失 → SKIP(可能已归档/移动,不视为行为差异)
 *   3. RPC 调 parse_image(超时/异常 → FAIL)
 *   4. worker 返回 error 或缺 record → FAIL
 *   5. deepDiff(fixture, record) → PASS/FAIL,diff 明细截断 20 条
 */
async function compareOne(
  fixturePath: string,
  worker: WorkerClient,
  args: CliArgs,
): Promise<FixtureResult> {
  const raw = readFileSync(fixturePath, 'utf8');
  const fixture = JSON.parse(raw) as Record<string, unknown>;
  const file = fixture.file as
    | { source_path?: string; resolved_path?: string; sha256?: string }
    | undefined;
  const imagePath = file?.source_path ?? file?.resolved_path;

  // 无路径字段:fixture 形态异常,不可执行 → SKIP
  if (!imagePath) {
    return {
      file: fixturePath,
      outcome: 'SKIP',
      skipReason: 'fixture 缺少 file.source_path/resolved_path',
    };
  }
  // 源图不存在(可能已归档/移动):跳过,不污染对比结论
  if (!existsSync(imagePath) || !statSync(imagePath).isFile()) {
    return {
      file: fixturePath,
      outcome: 'SKIP',
      imagePath,
      skipReason: '源图不存在(可能已归档/移动)',
    };
  }

  let resp: RpcResponse;
  try {
    resp = await worker.call('parse_image', {
      path: imagePath,
      scan_root: args.scanRoot,
    });
  } catch (e) {
    // RPC 层失败(超时/IO):算 FAIL,记为调用错误
    return {
      file: fixturePath,
      outcome: 'FAIL',
      imagePath,
      error: `rpc 调用失败: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // worker 侧显式报错(解析异常等)
  if (resp.error) {
    return {
      file: fixturePath,
      outcome: 'FAIL',
      imagePath,
      error: `worker error ${resp.error.code}: ${resp.error.message}`,
    };
  }

  const actual = resp.result?.record;
  if (!actual) {
    // 协议违约:成功响应但没有 record
    return {
      file: fixturePath,
      outcome: 'FAIL',
      imagePath,
      error: 'worker 响应缺少 result.record',
    };
  }

  // --strict 时清空忽略集,时间字段也参与严格对比
  const ignore = args.strict ? new Set<string>() : IGNORE_PATHS;
  const { equal, diffs } = deepDiff(fixture, actual, '', ignore);
  return {
    file: fixturePath,
    outcome: equal ? 'PASS' : 'FAIL',
    imagePath,
    diffCount: diffs.length,
    diffs: equal ? undefined : diffs.slice(0, 20), // 截断,避免报告爆炸
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * 主流程:
 *   0. 解析参数,校验 fixtures 目录 / scan_root(缺失即退出码 2)
 *   1. 收集 .json fixture 文件(按名排序,可选 --limit 截断)
 *   2. 启动 worker(失败退出码 2)
 *   3. 逐条 compareOne,进度打到 stderr(--json 时静默)
 *   4. 汇总 PASS/FAIL/SKIP:
 *      - --json:stdout 输出完整 JSON 报告
 *      - 否则:汇总行 + 失败详情(每条最多 20 个 diff,值截断 200 字符)
 *   5. 退出码:FAIL > 0 → 1;全 PASS/SKIP → 0
 */
async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(args.fixturesDir)) {
    process.stderr.write(`fixtures 目录不存在: ${args.fixturesDir}\n`);
    return 2;
  }
  if (!args.scanRoot) {
    // scan_root 必须提供:解析依赖它做路径归一,缺失会解析失败
    process.stderr.write(
      'scan_root 未配置:请在数据目录 .env 设置 COMFY_SCAN_ROOT(与运行时 gateway 同一来源),或用 --scan-root PATH\n',
    );
    return 2;
  }
  let files = readdirSync(args.fixturesDir)
    .filter((f) => f.endsWith('.json'))
    .sort(); // 排序保证 --limit N 是"字典序前 N 个",可复现
  if (args.limit) files = files.slice(0, args.limit);
  if (files.length === 0) {
    process.stderr.write(`fixtures 目录为空: ${args.fixturesDir}\n`);
    return 2;
  }

  const worker = new WorkerClient(args.pythonBin, args.workerCwd);
  try {
    await worker.start();
  } catch (e) {
    process.stderr.write(
      `worker 启动失败: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 2;
  }

  const results: FixtureResult[] = [];
  if (!args.json) {
    process.stderr.write(
      `开始双跑对比: ${files.length} 个 fixtures (scan_root=${args.scanRoot})\n`,
    );
  }

  // 逐条执行(worker 串行处理;如需提速可批量并发,但会放大 RPC 超时面)
  for (let i = 0; i < files.length; i += 1) {
    const f = files[i];
    const fp = join(args.fixturesDir, f);

    const r = await compareOne(fp, worker, args);
    results.push(r);
    if (!args.json) {
      const tag =
        r.outcome === 'PASS' ? 'PASS' : r.outcome === 'SKIP' ? 'SKIP' : 'FAIL';
      // 失败行附差异数/错误摘要,跳过行附原因
      const extra =
        r.outcome === 'FAIL'
          ? ` (diffs=${r.diffCount}${r.error ? ` err=${r.error}` : ''})`
          : r.skipReason
            ? ` (${r.skipReason})`
            : '';
      process.stderr.write(`[${i + 1}/${files.length}] ${tag} ${f}${extra}\n`);
    }
  }

  worker.stop();

  const pass = results.filter((r) => r.outcome === 'PASS').length;
  const fail = results.filter((r) => r.outcome === 'FAIL').length;
  const skip = results.filter((r) => r.outcome === 'SKIP').length;

  if (args.json) {
    // 机器可读输出走 stdout(进度信息在 stderr,不污染管道)
    process.stdout.write(
      `${JSON.stringify(
        { total: results.length, pass, fail, skip, results },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stderr.write(
      `\n汇总: total=${results.length} pass=${pass} fail=${fail} skip=${skip}\n`,
    );
    if (fail > 0) {
      process.stderr.write('\n失败详情(前 20 条 diff 每个):\n');
      for (const r of results.filter((x) => x.outcome === 'FAIL')) {
        process.stderr.write(`\n--- ${r.file} ---\n`);
        if (r.error) {
          process.stderr.write(`  error: ${r.error}\n`);
        }
        if (r.diffs) {
          for (const d of r.diffs) {
            const exp = truncate(JSON.stringify(d.expected));
            const act = truncate(JSON.stringify(d.actual));
            process.stderr.write(
              `  ${d.path}\n    exp: ${exp}\n    act: ${act}\n`,
            );
          }
        }
      }
    }
  }

  return fail > 0 ? 1 : 0;
}

/**
 * 长值截断:超过 max 字符时保留头部并标注原始长度,
 * 防止单个大字段撑爆终端/日志。
 */
function truncate(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max)}…(${s.length}b)` : s;
}

// 入口:正常路径 exit(code),未捕获异常统一 exit(2)
main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(
      `未捕获异常: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
    );
    process.exit(2);
  });
