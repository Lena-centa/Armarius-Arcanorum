/**
 * ============================================================
 * parse.module — 解析 / 缩略图 / ComfyUI 回读接口模块装配(纯 DI 声明)。
 *
 * 文件职责(本文件只做装配,不含业务逻辑):
 *  1. 注册 Mongo 模型:Images(images 集合)供 ParseController 注入
 *     (缩略图源文件定位的 Mongo 侧查询);
 *  2. 引入 WorkersModule:ParseWorkerService 的唯一宿主模块(parse /
 *     orchestration / generate / health 四处共享),本模块不重复注册,
 *     从而切断 ParseModule ⇄ OrchestrationModule 的 forwardRef 循环依赖;
 *  3. 引入 OrchestrationModule:提供 OrchestrationService(内存视图
 *     getMemoryView / findMemoryFileBySha256),作为缩略图源文件定位的
 *     兜底数据源(未入库图片也可出缩略图);
 *  4. 声明唯一控制器 ParseController(路由前缀 /api,实现见
 *     parse.controller.ts)。
 *
 * 装配关系:
 *   AppModule → ParseModule
 *   ParseModule ├─ MongooseModule.forFeature(Images)
 *               ├─ WorkersModule(导出 ParseWorkerService)
 *               └─ OrchestrationModule(导出 OrchestrationService)
 * ParseController 额外注入的 SQLITE_DB(@Global SqliteModule)与
 * ConfigService 无需本模块显式 import。
 *
 * 数据流向:
 *   POST /api/parse-image / parse-comfy-image → ParseController
 *   (入参校验 → 临时目录落盘)→ ParseWorkerService.parseImage(RPC)
 *   → shapeSingleRecordDetail 整形(transient 详情)→ 返回前端;
 *   GET /api/thumb/:sha256 → ThumbCache(命中直回)→ findResolvedPath
 *   (存储层 + 内存视图兜底 + 纯远程透传)→ worker.makeThumb 渲染
 *   → WebP 下发(带 1 天 Cache-Control)。
 * ============================================================
 */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Images, ImagesSchema } from '../../schemas';
import { OrchestrationModule } from '../orchestration/orchestration.module';
import { WorkersModule } from '../../workers/workers.module';
import { ParseController } from './parse.controller';

/**
 * @Module 元数据说明:
 *   imports —— forFeature 注册 Images 模型 + 2 个业务模块
 *     (ParseController 的 worker 与内存视图依赖均来自 imports,
 *     本模块无自有 provider);
 *   controllers —— ParseController(/api/parse-image 等);
 *   providers —— 空:ParseWorkerService 由 WorkersModule 提供。
 */
@Module({
  imports: [
    // images 集合模型注册:ParseController 注入后用于缩略图源文件
    // 定位(findOne 'images.file.sha256' + 位置投影)等查询
    MongooseModule.forFeature([{ name: Images.name, schema: ImagesSchema }]),
    // ParseWorkerService 由 WorkersModule 提供(与 Orchestration 共享,
    // 消除 ParseModule ⇄ OrchestrationModule 循环依赖)
    WorkersModule,
    // 内存视图查询(ParseController 注入 OrchestrationService)
    OrchestrationModule,
  ],
  controllers: [ParseController],
})
export class ParseModule {}
