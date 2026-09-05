/**
 * 跨平台路径工具。
 *
 * 历史数据在 WSL 时代入库,file.resolved_path 为 `/mnt/d/erxx/...` 格式;
 * Windows 原生运行时代码解析该路径会得到 `C:\mnt\d\erxx\...`(不存在)。
 * 所有基于 resolved_path 的文件系统访问都应经过 firstAccessiblePath,
 * 按 [原路径, 归一化路径, windows_path] 顺序取第一个真实存在的文件。
 *
 * 数据流:被 lib/ingest.ts(移动/重命名识别的 isAccessiblePath 守卫)、
 * lib/archive.ts(upsert 移动自愈守卫)、sqlite/repo.ts(路径归一化索引)调用,
 * 是"WSL 时代存量路径"与"Windows 原生路径"两套表示互通的唯一出口。
 * 注意:本模块只做字符串/文件系统层面的互转,不修改库中存储值。
 */

import { existsSync, statSync } from 'fs';
import { isAbsolute, relative, resolve } from 'path';

/**
 * WSL 路径 <-> Windows 路径互转(当前平台视角)。
 *
 * @param p 库中或扫描产出的任意形式路径(/mnt/d/...、D:\...、D:/...)
 * @returns 当前平台规范形式;平台自身形式原样返回(不改变大小写/分隔符以外的内容)
 *
 * 内部逻辑:
 *   1. 空串/非路径输入直接透传(调用方多处用返回值做 Map key,必须保持稳定)
 *   2. win32 平台:/mnt/<盘符>/<余下> → `<盘符大写>:\<余下>`
 *      (WSL 挂载路径转 Windows 原生盘符)
 *   3. 非 win32 平台(WSL/Linux):`<盘符>:[\\/]<余下>` → `/mnt/<盘符小写>/<余下>`
 *      (Windows 路径转 WSL 挂载路径)
 *   4. 均不匹配则视为已规范,原样返回
 *
 * 边界:函数是"规范化投影"而非双射——同一文件两种形式投影到同一条
 * 归一化路径(如 /mnt/d/x 与 D:\x 在 win32 下都归一化为 D:\x),
 * ingest.ts 的双形式存储去重正是依赖这个投影性质。
 */
export function normalizePathForPlatform(p: string): string {
  if (!p) {
    return p;
  }
  if (process.platform === 'win32') {
    // /mnt/d/erxx/... -> D:\erxx\...
    const m = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(p);
    if (m) {
      return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
    }
    return p;
  }
  // D:\erxx\... 或 D:/erxx/... -> /mnt/d/erxx/...
  const m = /^([a-zA-Z]):[\\/](.*)$/.exec(p);
  if (m) {
    return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
  }
  return p;
}

/**
 * 返回第一个真实存在的文件路径(含归一化尝试)。
 * 顺序:原路径 → 平台归一化路径 → windows_path 原样 → 归一化 windows_path。
 *
 * @param paths 候选取值列表(通常依次传 [resolved_path, windows_path]),
 *              允许 null/undefined 占位,内部自动跳过
 * @returns 第一个 existsSync 且 isFile 的绝对路径;全部不可达返回 null
 *
 * 内部逻辑:
 *   1. 逐候选串处理;空串跳过(调用方常传可选字段,避免判空样板)
 *   2. 每个候选串再展开为 {原串, 归一化串} 两个变体(Set 去重防重复 stat)
 *      —— 同一文件可能只以另一平台形式存在,必须两种形式都试
 *   3. try/catch 包裹 stat:路径含非法字符/权限不足时抛异常,跳过继续,
 *      不因单条坏路径中断整个遍历
 *
 * 边界:目录及指向目录的符号链接不算命中(指向普通文件的符号链接经 stat 解引用后计中);
 * 返回命中变体本身(可能返回归一化后的路径),供上层做文件 IO。
 */
export function firstAccessiblePath(
  ...paths: Array<string | null | undefined>
): string | null {
  for (const p of paths) {
    if (!p) {
      continue;
    }
    for (const candidate of new Set([p, normalizePathForPlatform(p)])) {
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // 继续尝试下一个候选
      }
    }
  }
  return null;
}

/**
 * 判断文件路径当前平台是否可访问(目录或文件均可)。
 *
 * @param p 库中存储的任意形式路径
 * @returns 原路径或归一化路径任一存在即 true
 *
 * 用途:ingest.ts / archive.ts 的"移动/重命名识别"守卫——同指纹
 * (size+mtime)但路径不同的元素,只有旧位置确认已不在磁盘(isAccessiblePath
 * 为 false)才判定为"移动",否则视为"保留 mtime 的拷贝"必须两条并存。
 * 与 firstAccessiblePath 的区别:不要求 isFile(目录存在也算可达),且不返回路径。
 */
export function isAccessiblePath(p: string): boolean {
  for (const candidate of new Set([p, normalizePathForPlatform(p)])) {
    try {
      if (existsSync(candidate)) {
        return true;
      }
    } catch {
      // 忽略
    }
  }
  return false;
}

/**
 * 判断目标路径是否位于允许的根目录集合内(子路径或根自身)。
 *
 * @param target 待检目标路径(任意平台形式,内部先 resolve)
 * @param roots  允许的根目录列表(逐个 resolve 后比对)
 * @returns 位于任一根内(含等于根)返回 true
 *
 * 用途:原图下发(GW-09)的库记录投毒防线 —— file.resolved_path 来自库,
 * 被篡改记录可能携带扫描根之外的任意路径;相对路径比较法避免字符串前缀
 * 误判(如 D:\erxx2 是 D:\erxx 的前缀但并非其子目录)。
 * 注:win32 下 path.relative 对盘符与路径分量大小写不敏感。
 */
export function isPathUnderRoots(target: string, roots: string[]): boolean {
  const abs = resolve(target);
  return roots.some((root) => {
    const rel = relative(resolve(root), abs);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}
