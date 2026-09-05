/**
 * static 模块 —— 静态页面控制器(pages.controller.ts)
 *
 * 职责:镜像旧版 FastAPI 的页面路由与 /static 资源路由:
 *   GET /                     → index.html(首页/列表)
 *   GET /generate             → generate.html(生成/重放页)
 *   GET /stats                → stats.html(统计页)
 *   GET /labels               → labels.html(标注页)
 *   GET /settings             → settings.html(设置页)
 *   GET /static/*splat     → 静态资源(支持子目录,root 限 STATIC_DIR,防路径穿越)
 *
 * 缓存策略:页面统一 Cache-Control: no-store —— UI 迭代后立即生效,
 * 避免浏览器缓存旧版静态文件。
 */
import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { join } from 'path';
import { STATIC_DIR } from './static.module';

/**
 * Extensionless page routes + /static asset route, mirroring the legacy
 * FastAPI handlers (app.mount("/static", ...) + the four page handlers in
 * app.py), including the no-store cache policy on pages so UI iterations
 * are immediately visible.
 */
@Controller()
export class PagesController {
  /** GET / — 首页(图片列表入口)。 */
  @Get('/')
  index(@Res() res: Response): void {
    this.sendPage(res, 'index.html');
  }

  /** GET /generate — 生成/重放页。 */
  @Get('/generate')
  generate(@Res() res: Response): void {
    this.sendPage(res, 'generate.html');
  }

  /** GET /stats — 统计页。 */
  @Get('/stats')
  stats(@Res() res: Response): void {
    this.sendPage(res, 'stats.html');
  }

  /** GET /labels — 手动标注页。 */
  @Get('/labels')
  labels(@Res() res: Response): void {
    this.sendPage(res, 'labels.html');
  }

  /** GET /settings — 设置页。 */
  @Get('/settings')
  settings(@Res() res: Response): void {
    this.sendPage(res, 'settings.html');
  }

  /** GET /favicon.ico — 空 Favicon(204 No Content),避免浏览器 404 与默认地球图标。 */
  @Get('/favicon.ico')
  favicon(@Res() res: Response): void {
    res.status(204).end();
  }

  /**
   * GET /static/*splat — 静态资源(js/css/图片,支持 vendor/ 等子目录)。
   * 安全:express sendFile 的 root 选项限制在 STATIC_DIR 内,
   * 传入路径含 ../ 会被拒绝(防路径穿越)。
   * @param path 资源相对路径(可含子目录,如 vendor/air-datepicker/xxx.js)
   * @param res Express 响应(错误回调中 404)
   */
  @Get('/static/*splat')
  asset(@Req() req: Request, @Res() res: Response): void {
    // 通配参数 @Param('splat') 在 NestJS + path-to-regexp v8 下取不到值,
    // 改用 originalUrl 提取 /static/ 之后的相对路径(去 query 与解码)
    const raw = req.originalUrl.split('?')[0];
    const rel = raw.startsWith('/static/') ? raw.slice('/static/'.length) : raw;
    const decoded = decodeURIComponent(rel);
    // express' root option blocks path traversal.
    // sendFile 失败(文件不存在/路径越界)时回 404;若响应已发出则不再覆盖
    res.sendFile(decoded, { root: STATIC_DIR }, (err: unknown) => {
      if (err && !res.headersSent) {
        res.status(404).end();
      }
    });
  }

  /**
   * 页面发送公共路径:设 no-store 缓存头后 sendFile(相对 STATIC_DIR 取文件名)。
   * @param res Express 响应
   * @param page HTML 文件名(如 index.html)
   */
  private sendPage(res: Response, page: string): void {
    // 页面禁用缓存:UI 迭代立即可见
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(join(STATIC_DIR, page));
  }
}
