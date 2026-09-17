/**
 * comfy-proxy 模块 —— 注册 ComfyProxyController(/comfy/* 同源反向代理)。
 *
 * HTTP 流量走控制器转发;WebSocket 升级不经过 Nest 路由,由 main.ts 在
 * getHttpServer() 上挂 attachComfyWsBridge 分流(见 comfy-proxy.ts)。
 *
 * GenerateModule 提供 ComfyProxyHookService(POST /comfy/prompt 的提交
 * 钩子:探活/回填 + 完成态素材捕获)。
 */
import { Module } from '@nestjs/common';
import { GenerateModule } from '../../modules/generate/generate.module';
import { ComfyProxyController } from './comfy-proxy.controller';

@Module({
  imports: [GenerateModule],
  controllers: [ComfyProxyController],
})
export class ComfyProxyModule {}
