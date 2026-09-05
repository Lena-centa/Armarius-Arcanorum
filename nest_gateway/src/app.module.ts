/**
 * 网关根模块:装配配置 / 定时任务 / Mongo 连接与全部业务模块。
 *
 * 职责:
 *   - 注册全局配置(ConfigModule,配置工厂见 ./config/configuration.ts)
 *   - 注册全局定时任务基础设施(ScheduleModule)
 *   - 注册 Mongo 连接(MongooseModule;SQLite 单引擎下为惰性占位连接)
 *   - 挂载业务模块:health(健康检查)/ static(静态资源)/
 *     parse(解析)/ generate(生成)/ stats(统计)/ orchestration(编排)/
 *     images(批次查询)/ labels(标注)/ settings(设置)/
 *     tags(tag 补全参考)/ sqlite(本地 SQLite 引擎)
 *
 * 环境文件来源(按优先级):数据目录内平台专属文件(.env.windows /
 * .env.wsl)→ 数据目录 .env。数据目录外置代码树(见 config/data-dir.ts),
 * 文件本体在 NestFactory.create 之前由 main.ts 的冷迁移/生成逻辑保证存在;
 * 旧仓库根 .env 由冷迁移复制过来,更新/重装配置不丢。
 */
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { join } from 'path';
import { configuration, resolveDataDir } from './config';
import { GenerateModule } from './modules/generate/generate.module';
import { HealthModule } from './modules/health/health.module';
import { ImagesModule } from './modules/images/images.module';
import { LabelsModule } from './modules/labels/labels.module';
import { FavoritesModule } from './modules/favorites/favorites.module';
import { OrchestrationModule } from './modules/orchestration/orchestration.module';
import { ParseModule } from './modules/parse/parse.module';
import { SettingsModule } from './modules/settings/settings.module';
import { StaticModule } from './modules/static/static.module';
import { StatsModule } from './modules/stats/stats.module';
import { TagsModule } from './modules/tags/tags.module';
import { SqliteModule } from './sqlite/sqlite.module';

// 数据目录(env 与主库的外置存放点);平台专属环境文件优先于共享 .env
// (Windows 原生进程读 .env.windows,WSL / Linux 读 .env.wsl,
// 两平台可各自维护一套路径 / 开关配置,避免互相污染)
const DATA_DIR = resolveDataDir();
const platformEnvFile = join(
  DATA_DIR,
  process.platform === 'win32' ? '.env.windows' : '.env.wsl',
);

@Module({
  imports: [
    ConfigModule.forRoot({
      // 全局生效:所有模块均可直接注入 ConfigService
      isGlobal: true,
      // 加载自定义配置工厂(合并环境变量,输出统一的配置对象)
      load: [configuration],
      // 统一配置来源:数据目录内的平台覆盖文件 + 共享 .env
      envFilePath: [platformEnvFile, join(DATA_DIR, '.env')],
    }),
    // 注册调度基础设施(当前各循环实际使用 setInterval)
    ScheduleModule.forRoot(),
    // Mongo 连接:异步工厂,注入 ConfigService 读取 mongo.uri / mongo.db
    MongooseModule.forRootAsync({
      useFactory: (configService: ConfigService) => {
        const mongoUri = configService.get<string>('mongo.uri')?.trim() ?? '';
        return {
          // MONGODB_URI 留空时用占位 URI; SQLite 单引擎不依赖 Mongo。
          uri: mongoUri || 'mongodb://127.0.0.1:27017',
          dbName: configService.get<string>('mongo.db'),
          // 惰性连接:SQLite 单引擎模式不依赖 Mongo 可用(写路径已跳过)
          lazyConnection: true,
          // 缩短连接建立超时:占位连接(无 Mongo)时快速失败,避免启动卡顿
          serverSelectionTimeoutMS: 3000,
          connectionFactory: (connection: {
            on: (event: string, fn: (err: Error | null) => void) => void;
          }) => {
            // 必须监听 error 防止后台连接失败触发 unhandled error。
            // 未配置 Mongo 时该连接只是占位,不向 stderr 输出可忽略的拒绝错误。
            connection.on('error', (err: Error | null) => {
              if (mongoUri && err) {
                console.error(`[mongo] connection error: ${err.message}`);
              }
            });
            return connection;
          },
        };
      },
      inject: [ConfigService],
    }),
    // ---- 业务模块 ----
    HealthModule,
    StaticModule,
    ParseModule,
    GenerateModule,
    StatsModule,
    OrchestrationModule,
    ImagesModule,
    LabelsModule,
    FavoritesModule,
    SettingsModule,
    TagsModule,
    SqliteModule,
  ],
})
export class AppModule {}
