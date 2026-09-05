/**
 * 网关启动入口(bootstrap)。
 *
 * 职责:创建 Nest 应用,按配置设置 CORS 白名单、注册优雅停机钩子,
 * 并监听在配置的端口 / 绑定地址上。
 *
 * 被谁使用:进程启动命令(node dist/main.js);启动后由各模块以
 * 内部 setInterval 定时循环与 HTTP 路由对外提供服务。
 *
 * 关键配置(来自 ./config/configuration.ts):
 *   - port      NEST_GATEWAY_PORT(默认 8009)
 *   - bindHost  WORKFLOW_DB_BIND_HOST(默认仅回环 127.0.0.1)
 *   - corsOrigin CORS_ORIGIN(逗号分隔白名单;未设置仅放行同源与 file://)
 */
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { hostname, networkInterfaces } from 'os';
import { AppModule } from './app.module';
import {
  ensureEnvFile,
  migrateUserDataDir,
  runLegacyDataMigration,
} from './bootstrap/data-dir-migration';
import { buildGatewayOrigins } from './common/cors/origins';
import { ParseWorkerService } from './workers/parse-worker.service';
import { GenerateWorkerService } from './workers/generate-worker.service';

async function bootstrap() {
  // 数据目录外置引导(必须先于 NestFactory.create:ConfigModule 读 .env、
  // openSqlite 建库都发生在 create 内部,依赖迁移/生成后的数据目录内容):
  //   1. 用户目录更名平滑迁移:旧 %LOCALAPPDATA%\workflow_db → armarius_arcanorum
  //   2. 冷迁移:旧 <repo>/data 主库 + 仓库根 env 三件套 → 用户数据目录
  //      (幂等;失败自动回退旧库路径启动,详见 bootstrap/data-dir-migration.ts)
  //   3. .env 自动生成:数据目录缺失 .env 时从 .env.example 模板生成
  const userDirMigration = migrateUserDataDir();
  if (userDirMigration.status === 'migrated') {
    console.log(`[data-dir] user data dir renamed: ${userDirMigration.reason}`);
  }
  const migration = runLegacyDataMigration();
  console.log(`[data-dir] legacy migration: ${migration.status} (${migration.reason})`);
  ensureEnvFile();

  // 创建 Nest 应用(根模块见 app.module.ts)
  const app = await NestFactory.create(AppModule);

  // 读取启动相关配置(带默认值兜底,缺 .env 也能正常启动)
  const configService = app.get(ConfigService);
  const port = configService.get<number>('port', 8009);
  const bindHost = configService.get<string>('bindHost', '127.0.0.1');
  const corsOrigin = configService.get<string>('corsOrigin', '');
  // 危险组合启动告警(VULN-01 配套):对外绑定 + 未配 token 时,未挂
  // @RequireAuth 的端点对局域网完全开放 —— 启动即显式提示,消除配置陷阱
  const authToken = configService.get<string>('authToken', '');
  if (bindHost !== '127.0.0.1' && bindHost !== '::1' && !authToken) {
    console.warn(
      `[security] WARNING: gateway is bound to ${bindHost} (non-loopback) without an auth token. ` +
        'Endpoints without @RequireAuth are reachable from the network. ' +
        'Set ARMARIUS_AUTH_TOKEN (or WORKFLOW_DB_AUTH_TOKEN) in .env to enforce token auth.',
    );
  }

  // 同源请求白名单:浏览器对同源 POST 也携带 Origin 头,
  // 网关自身服务地址必须放行,否则同源 POST 会被 CORS 误杀
  const interfaceAddresses = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .map((entry) => entry.address);
  const sameOriginOrigins = buildGatewayOrigins({
    bindHost,
    port,
    hostName: hostname(),
    interfaceAddresses,
  });

  // CORS 白名单回调:
  //   - 无 Origin(同源 GET / 非浏览器请求)或 origin === 'null'(file:// 页面)
  //     一律放行;
  //   - 有 Origin 时与「配置白名单(CORS_ORIGIN 逗号分隔) + 网关自身地址」比对,
  //     命中放行,未命中返回错误(浏览器侧表现为 CORS 拒绝);
  //   - credentials 关闭:跨域请求不携带 Cookie(本项目用 token 头鉴权)
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (!origin || origin === 'null') {
        callback(null, true);
        return;
      }
      const allowed = [
        ...corsOrigin
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
        ...sameOriginOrigins,
      ];
      if (allowed.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`origin not allowed by CORS: ${origin}`), false);
    },
    credentials: false,
  });

  // SIGTERM/SIGINT 时触发 onApplicationShutdown(回收 worker、SQLite checkpoint)
  app.enableShutdownHooks();

  // 两个 python worker 已在各自 onModuleInit 并行发起冷启动(不再在模块
  // 初始化链内串行等握手),此处统一汇合后再 listen:whenReady 永不 reject
  // (失败已在 service 内降级为 error log + 接口 503),等待即代表
  // "已就绪或已定论降级",listen 后端口立即可服务
  await Promise.all([
    app.get(ParseWorkerService).whenReady(),
    app.get(GenerateWorkerService).whenReady(),
  ]);

  // 开始监听(端口 + 绑定地址);失败(如端口占用)会以未捕获异常终止进程
  await app.listen(port, bindHost);
  console.log(`NestJS Gateway running on ${bindHost}:${port}`);
}
// 顶层调用:ESM 下不等待模块副作用,直接触发启动流程
void bootstrap();
