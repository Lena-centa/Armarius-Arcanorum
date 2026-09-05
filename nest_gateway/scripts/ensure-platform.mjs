#!/usr/bin/env node
// ============================================================================
// ensure-platform.mjs — npm 平台目录方案的自愈/守卫脚本
//
// 背景:nest_gateway/node_modules 是平台激活链接 → node_modules.win / .linux
// (平台目录各含 .platform 标记,由对应平台 start.* setup 安装)。npm 本身不知道
// 这个方案:直接 npm install 可能写穿链接污染他平台目录,npm ci 会删除链接
// 生成真实目录(旧布局残留),导致 ABI 错配与启动被拒。
//
// 本脚本挂在 package.json 的 preinstall / postinstall 上,让任何 npm 安装
// 都被纳入方案:
//   preinstall  守卫:移除链接/junction,防止安装穿透或写穿他平台目录。
//               注意 npm v11 时序:顶层包 preinstall 在 reify 之后运行,
//               npm install 的 reify 对链接只删链接本身(不穿透,安全),
//               故守卫主要兜底 npm install 失败/中断后的状态;真正会被
//               preinstall 拦截的是"链接指向他平台时被 npm 替换/写穿"。
//               ⚠ npm ci 例外:npm ci 在 reify 前有预清理(readdir +
//               逐个 rm 条目),它会跟随链接清空链接指向的目录 —— 链接
//               指向他平台时 = 清空他平台安装,任何钩子都拦不住。
//               规避:切换平台后先运行 start.*(自动改链)
//               再执行 npm ci;npm install 无此预清理,安全。
//   postinstall 自愈:真实目录迁移为平台目录 + 重建激活链接(WSL 优先
//               Windows junction,双平台可读)、写 .platform 标记与安装戳、
//               better-sqlite3 ABI 探测(失败即非零退出,让安装当场失败
//               而非启动时裸奔);全新安装与平台目录树一致时复用原目录
//
// 安装戳 = sha256(package.json) + sha256(package-lock.json),与
// start.ps1/.sh 的 setup 计算方式一致,供其判断依赖是否过期(目录存在 ≠ 依赖最新)。
//
// 纯 Node 内置模块、零依赖(安装前 node_modules 可能尚不存在)。
// 用法:node scripts/ensure-platform.mjs preinstall|postinstall
// ============================================================================
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

// nest_gateway/ (本脚本位于 scripts/ 下)
const BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM = path.join(BASE, 'node_modules');
// 目录后缀(win/linux)与 .platform 标记内容(windows/linux)是两套命名:
// 平台目录叫 node_modules.win / node_modules.linux,标记内容为 windows / linux
const SUFFIX = process.platform === 'win32' ? 'win' : 'linux';
const PLATFORM = process.platform === 'win32' ? 'windows' : 'linux';
const PLAT_DIR = path.join(BASE, `node_modules.${SUFFIX}`);
const MARKER = '.platform';
const STAMP = '.npm-stamp';

const MODE = process.argv[2];

function ok(msg) { console.log(`  OK: ${msg}`); }
function warn(msg) { console.log(`  WARN: ${msg}`); }
function fail(msg) { console.log(`  FAIL: ${msg}`); }

// 状态判定:链接(junction/symlink)/ 真实目录 / 缺失
function lstatType(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink() ? 'link' : 'dir';
  } catch {
    return 'missing';
  }
}

function dirExists(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// 链接是否可穿透解析(Windows Node 无法解析 Git-Bash 创建的 /c/... 目标等)
function linkResolves(p) {
  try { fs.statSync(p); return true; } catch { return false; }
}

// 从链接目标字符串提取平台名(node_modules.win / node_modules.linux 即可
// 识别,不依赖真实解析,兼容 MSYS 路径目标)
function linkPlatform(p) {
  try {
    const m = fs.readlinkSync(p).match(/node_modules\.(win|linux)(?:[\\/]|$)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function writeMarker(dir) {
  fs.writeFileSync(path.join(dir, MARKER), PLATFORM, 'utf8');
}

// 读取文件内容;缺失/读取失败返回 null
function safeRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

// 安装戳:sha256(package.json) + sha256(package-lock.json)(小写 hex,
// 与 start.ps1/.sh 的 setup 计算方式一致)
function computeStamp() {
  const h = (f) => {
    try { return createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }
    catch { return ''; }
  };
  return h(path.join(BASE, 'package.json')) + h(path.join(BASE, 'package-lock.json'));
}

function writeStamp(dir) {
  fs.writeFileSync(path.join(dir, STAMP), computeStamp(), 'utf8');
}

// 平台目录就位后:写标记 + 写安装戳
function finalize(dir) {
  writeMarker(dir);
  writeStamp(dir);
}

// WSL 内 /mnt/<drive>/... → D:\... (供 cmd.exe mklink / rmdir 使用)
function winPath(p) {
  return p.replace(/^\/mnt\/([A-Za-z])\//, (_, d) => `${d.toUpperCase()}:\\`).replace(/\//g, '\\');
}

// 安全移除激活链接(仅删链接本身,绝不触碰目标内容)。
// WSL 下 npm 会把 junction 当作目录递归删除(穿透清空他平台目录),所以
// npm 安装前必须先把链接移除;unlinkSync 对某些 junction 可能失败,
// 回退 cmd.exe rmdir(junction 语义,不递归)。
function removeLinkLike() {
  try {
    fs.unlinkSync(NM);
    return;
  } catch (e) {
    if (BASE.startsWith('/mnt/')) {
      const r = spawnSync('cmd.exe', ['/c', `rmdir "${winPath(NM)}"`], { encoding: 'utf8' });
      if (r.status === 0) return;
      fail(`移除链接失败(unlink: ${e.message}; rmdir: ${(r.stderr || r.stdout || '').trim()})`);
    } else {
      fail(`移除链接 ${NM} 失败: ${e.message}`);
    }
    process.exit(1);
  }
}

// 创建激活链接 node_modules → node_modules.<平台>。
// Windows:junction(免管理员,Windows 原生可读)。
// WSL(/mnt 下):优先 cmd.exe mklink /J 建 Windows junction —— 双平台可读可穿透;
// WSL 原生 symlink 是 LXSS reparse point,Windows 进程无法穿透(EACCES),
// 仅作为 mklink 不可用时的回退(纯 Linux 环境无 Windows 侧,无此顾虑)。
// 调用方须保证 PLAT_DIR 已存在(junction 目标必须存在)。
function createLink() {
  if (process.platform === 'win32') {
    fs.symlinkSync(path.resolve(PLAT_DIR), NM, 'junction');
    return;
  }
  if (BASE.startsWith('/mnt/')) {
    const r = spawnSync(
      'cmd.exe',
      ['/c', `mklink /J "${winPath(NM)}" "${winPath(PLAT_DIR)}"`],
      { encoding: 'utf8' },
    );
    if (r.status === 0) return;
    console.log(`  WARN: mklink /J 失败(${(r.stderr || r.stdout || '').trim()}),回退符号链接`);
  }
  try {
    fs.symlinkSync(`node_modules.${SUFFIX}`, NM, 'dir'); // 相对目标,与 ln -s 约定一致
  } catch (e) {
    fail(`创建符号链接失败: ${e.message}(WSL 需启用 drvfs metadata: /etc/wsl.conf [automount] options=metadata)`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- 守卫 ----
function guard() {
  const cmd = process.env.npm_command || '';
  const type = lstatType(NM);
  if (type === 'missing') {
    // Windows:npm 对 junction 处理安全,重建链接让安装失败时运行时仍可用;
    // WSL:不重建(避免 npm 穿透 junction),npm 全新安装后由 postinstall 迁移
    if (PLATFORM === 'windows' && dirExists(PLAT_DIR)) {
      createLink();
      ok(`激活链接 node_modules → node_modules.${SUFFIX}`);
    }
    return; // 全新安装:npm 建真实目录,postinstall 迁移
  }
  if (type === 'dir') return; // 真实目录:npm 增量/重建均安全,postinstall 迁移
  // 链接/junction:任何安装(install/ci/update/rebuild)都会重建 node_modules,
  // 一律先安全移除 —— npm 会把根链接替换为真实目录(全量重装),且 npm ci
  // 的预清理会跟随链接清空目标目录(链接指向他平台时 = 清空他平台安装),
  // 保留无益;postinstall 负责重建
  const targetPlat = linkPlatform(NM);
  removeLinkLike();
  if (cmd === 'ci') return; // ci 整体重建,postinstall 收尾
  if (PLATFORM === 'windows') {
    // Windows:npm 对 junction 处理安全,重建链接(原目标信息仅提示用)
    if (dirExists(PLAT_DIR)) {
      createLink();
      ok(`修复激活链接 node_modules → node_modules.${SUFFIX}(原目标 ${targetPlat ? `node_modules.${targetPlat}` : '损坏'})`);
    } else {
      warn(`已移除链接;node_modules.${SUFFIX} 不存在,本次将全新安装(由 postinstall 迁移为平台目录)`);
    }
  } else {
    // WSL:不重建链接,避免 npm 穿透 junction 清空他平台目录;
    // 全新安装后由 postinstall 迁移/复用(树一致时快速复用)
    warn(`已移除平台链接;npm 将全新安装,postinstall 迁移为 node_modules.${SUFFIX}`);
  }
}

// ---------------------------------------------------------------- 自愈 ----
function heal() {
  const type = lstatType(NM);
  if (type === 'link') {
    const targetPlat = linkPlatform(NM);
    const resolves = linkResolves(NM);
    if (targetPlat === SUFFIX && dirExists(PLAT_DIR) && resolves) {
      finalize(PLAT_DIR); // 幂等:确认标记/安装戳
      return;
    }
    removeLinkLike();
    if (dirExists(PLAT_DIR)) {
      createLink();
      finalize(PLAT_DIR);
      warn(`链接目标异常,已重建 node_modules → node_modules.${SUFFIX}`);
      return;
    }
    warn(`链接已移除,但 node_modules.${SUFFIX} 不存在 — 请运行 start.sh / start.ps1 setup 初始化`);
    return;
  }
  if (type === 'dir') {
    // 真实目录 = 本次全新安装(或旧布局残留):迁移为平台目录。
    // 注意:npm(≥7)在 Windows 上会把根 node_modules 链接/junction 替换为
    // 真实目录后全量重装,故每次 npm install 都可能走到这里(空跑重装)。
    if (dirExists(PLAT_DIR)) {
      // 快速路径:全新安装与平台目录树一致(.package-lock.json 相同)时,
      // 直接丢弃重复的新目录并复用原平台目录,避免 .old 迁移舞步
      const freshLock = safeRead(path.join(NM, '.package-lock.json'));
      const oldLock = safeRead(path.join(PLAT_DIR, '.package-lock.json'));
      if (freshLock !== null && freshLock === oldLock) {
        try {
          fs.rmSync(NM, { recursive: true, force: true });
          createLink();
          finalize(PLAT_DIR);
          ok('全新安装与平台目录一致,复用原平台目录(丢弃重复安装)');
          return;
        } catch (e) {
          // 删除失败(被占用)→ 走常规替换迁移
        }
      }
      const old = `${PLAT_DIR}.old`;
      try {
        if (dirExists(old)) fs.rmSync(old, { recursive: true, force: true }); // 清理陈旧残留
        fs.renameSync(PLAT_DIR, old);
        fs.rmSync(old, { recursive: true, force: true }); // 尽力删除(进程占用时可能失败)
      } catch (e) {
        // 平台目录被占用(同平台网关运行中):保留真实目录,写标记让守卫放行
        finalize(NM);
        warn(`迁移平台目录失败(可能被运行中进程占用): ${e.message} — 本次安装保留在真实目录,停止网关后运行 start.sh / start.ps1 setup 归一化`);
        return;
      }
    }
    try {
      fs.renameSync(NM, PLAT_DIR);
    } catch (e) {
      finalize(NM);
      warn(`迁移 node_modules → node_modules.${SUFFIX} 失败: ${e.message}`);
      return;
    }
    createLink();
    finalize(PLAT_DIR);
    ok(`node_modules 迁移为平台目录 + 激活链接 node_modules → node_modules.${SUFFIX}`);
    return;
  }
  // missing:理论上 npm 安装后必产出 node_modules;防御处理
  if (dirExists(PLAT_DIR)) {
    createLink();
    finalize(PLAT_DIR);
    warn('node_modules 缺失,已重建激活链接');
  } else {
    warn('node_modules 缺失(安装异常)— 请运行 start.sh / start.ps1 setup 初始化');
  }
}

// ------------------------------------------------------------ ABI 探测 ----
function probeAbi() {
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (e) {
    fail(`加载 better-sqlite3 失败: ${e.message}`);
    fail('依赖安装可能不完整 — 请重试 npm install,或运行对应平台 start.sh / start.ps1 setup');
    process.exit(1);
  }
  try {
    const db = new Database(':memory:');
    db.close();
  } catch (e) {
    fail(`better-sqlite3 与当前 node(${process.version}) 不匹配: ${e.message}`);
    fail(`ABI 错配 — 请使用 Node 22-26(推荐便携 node22),删除 node_modules.${SUFFIX} 后重新安装,或运行对应平台 start.sh / start.ps1 setup`);
    process.exit(1);
  }
  ok(`better-sqlite3 ABI 校验通过(node ${process.version})`);
}

function main() {
  if (MODE === 'preinstall') { guard(); return; }
  if (MODE === 'postinstall') {
    heal();
    probeAbi();
    return;
  }
  console.error('usage: node scripts/ensure-platform.mjs preinstall|postinstall');
  process.exit(2);
}

main();
