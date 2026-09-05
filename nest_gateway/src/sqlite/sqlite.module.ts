/**
 * SQLite 全局模块 — 提供数据库单例(依赖注入)。
 *
 * 过渡期与 MongooseModule 并存:写路径按 SQLITE_DUAL_WRITE 双写,
 * 读路径按 SQLITE_READ 切换;阶段 5 移除 Mongoose 后此模块即唯一数据源。
 *
 * 装配关系:
 *   AppModule → SqliteModule(@Global:provider 对所有模块全局可见,
 *   业务模块无需在 imports 里重复引用)
 *   SqliteModule └─ SQLITE_DB(provider token,better-sqlite3 连接单例)
 *   消费方:ImagesController / ParseController(原图、缩略图定位)、
 *   orchestration.service(双写)、sqlite 下的 repo.ts / reader.ts 与
 *   运维脚本(sqlite-backfill / gray-compare)——均以 @Inject(SQLITE_DB)
 *   注入同一连接实例。
 *
 * 数据流向:
 *   useFactory 注入 ConfigService → openSqlite(db.ts)按 sqlite.dbPath
 *   打开/创建数据库(exec SCHEMA_SQL 建表 + 增量迁移)→ 返回就绪连接;
 *   连接由 Nest 容器持有,生命周期与进程一致(不主动 close,
 *   WAL 模式下进程退出自动 checkpoint)。
 */
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Database from 'better-sqlite3';
import { openSqlite } from './db';

// 依赖注入 token:用 Symbol 而非字符串,避免与其他 DI token 同名覆盖;
// Symbol 在同一模块加载后全局唯一,消费方必须 import 此符号
// 才能以 @Inject(SQLITE_DB) 注入(类型标注为 Database.Database)。
export const SQLITE_DB = Symbol('SQLITE_DB');

/**
 * @Global():把本模块的 provider 提升为全局可见 —— 任意模块
 * (含未 import SqliteModule 的模块)都能直接注入 SQLITE_DB,
 * 省去在每个业务模块 imports 里重复声明。
 *
 * @Module 元数据:
 *   providers —— SQLITE_DB 工厂 provider:
 *     useFactory 注入 ConfigService,读取 sqlite.dbPath 配置;
 *     空串/未配置时 better-sqlite3 以临时库兜底(测试与未配置场景);
 *     openSqlite 负责建库 + 基线 schema + 增量迁移,返回就绪连接;
 *   exports —— SQLITE_DB 对外发布(Global 模块仍需显式 exports,
 *     声明后任意模块才可注入该 token)。
 */
@Global()
@Module({
  providers: [
    {
      provide: SQLITE_DB,
      useFactory: (config: ConfigService): Database.Database =>
        openSqlite(config.get<string>('sqlite.dbPath') ?? ''),
      inject: [ConfigService],
    },
  ],
  exports: [SQLITE_DB],
})
export class SqliteModule {}
