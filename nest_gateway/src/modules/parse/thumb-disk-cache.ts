/**
 * 缩略图磁盘缓存(跨进程持久化)。
 *
 * 背景:ThumbCache 是内存 LRU(500 条),网关重启即全失——重启后首批列表请求
 * 会把整页缩略图重新交给 Python worker 渲染(每次冷渲染数百 ms),是冷启动
 * 最重的一段开销。这里把渲染结果按内容寻址落盘
 * (`<dataDir>/thumbnails/<sha256>_<w>x<h>.webp`),重启后直接命中。
 *
 * 设计要点:
 *   - 键 = sha256 + 尺寸(与内存缓存同口径);渲染产物由这两者决定,不可变;
 *   - 读写失败一律**软失败**(缓存不可用不影响服务):读 miss / 写失败静默;
 *   - 不做 TTL:内容寻址 + 不可变;磁盘占用与图库同量级(单文件 KB 级);
 *   - 目录为空串(纯远程模式/内存库)时整体停用。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export class ThumbDiskCache {
  private readonly dir: string;

  /**
   * @param dir 缓存目录;空串 = 停用(读恒 miss、写恒 false)
   */
  constructor(dir: string) {
    this.dir = dir;
  }

  /** 是否启用(目录已配置)。 */
  get available(): boolean {
    return Boolean(this.dir);
  }

  private fileOf(sha256: string, w: number, h: number): string {
    return join(this.dir, `${sha256}_${w}x${h}.webp`);
  }

  /** 读缓存;未命中/不可用/读失败一律返回 null。 */
  read(sha256: string, w: number, h: number): Buffer | null {
    if (!this.dir) return null;
    try {
      const file = this.fileOf(sha256, w, h);
      if (!existsSync(file)) return null;
      return readFileSync(file);
    } catch {
      return null;
    }
  }

  /** 写缓存;成功返回 true,失败静默返回 false(不影响主链路)。 */
  write(sha256: string, w: number, h: number, data: Buffer): boolean {
    if (!this.dir) return false;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.fileOf(sha256, w, h), data);
      return true;
    } catch {
      return false;
    }
  }
}
