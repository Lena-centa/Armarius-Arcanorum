/**
 * static 模块 —— 静态资源模块装配(static.module.ts)
 *
 * 职责:声明静态目录常量并注册 PagesController。
 * STATIC_DIR 指向静态资源目录:
 *   <repo>/workflow_db/static/*.html|*.js|*.css 及 vendor/ 等第三方资源子目录
 * 目录解析:__dirname(nest_gateway/dist/modules/static)向上 4 级回仓库根
 * (dist/modules/static → dist/modules → dist → nest_gateway → 仓库根)。
 */
import { Module } from '@nestjs/common';
import { join } from 'path';
import { PagesController } from './pages.controller';

/**
 * Static asset layout:
 *   <repo>/workflow_db/static  (pages served by PagesController,
 *    vendor/ subdirs included)
 *
 * PagesController serves extensionless page routes from explicit routes and
 * mounts the whole static dir at /static, including the no-store cache
 * policy on pages.
 */
export const STATIC_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'workflow_db',
  'static',
);

@Module({
  controllers: [PagesController],
})
export class StaticModule {}
