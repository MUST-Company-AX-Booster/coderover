import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminConfigController } from './admin-config.controller';
import { AdminConfigService } from './admin-config.service';
import { SettingAudit } from '../entities/setting-audit.entity';
import { SystemSetting } from '../entities/system-setting.entity';
import { AuthModule } from '../auth/auth.module';

/**
 * Global so call sites across the app can inject `AdminConfigService`
 * without each module having to import `AdminConfigModule`. This unblocks
 * Phase 4 call-site migration from `ConfigService.get` → DB-first reads
 * without touching every module's `imports` array.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([SystemSetting, SettingAudit]), AuthModule],
  controllers: [AdminConfigController],
  providers: [AdminConfigService],
  exports: [AdminConfigService],
})
export class AdminConfigModule {}
