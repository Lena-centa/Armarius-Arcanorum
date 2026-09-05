/**
 * settings 模块 —— 设置模块装配(settings.module.ts)
 *
 * 职责:注册 SettingsController(/api/settings 全部端点,类级 @RequireAuth)
 * 与 SettingsService(.env 读写 / 元信息 / 平台文件选择)。
 * 无外部 imports(SettingsService 只依赖可选的 SETTINGS_DATA_DIR token)。
 */
import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({
  controllers: [SettingsController],
  providers: [SettingsService],
})
export class SettingsModule {}
