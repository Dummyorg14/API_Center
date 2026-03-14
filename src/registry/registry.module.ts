// =============================================================================
// src/registry/registry.module.ts — Registry NestJS Module
// =============================================================================

import { Module, forwardRef } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { RegistryService } from './registry.service';
import { RegistryController } from './registry.controller';
import { HealthMonitorService } from './health-monitor.service';
import { VaultService } from '../auth/vault.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [ScheduleModule.forRoot(), forwardRef(() => AuthModule)],
  controllers: [RegistryController],
  // VaultService is provided here so HealthMonitorService can inject it
  // for the Vault token renewal cron. It is also available for future
  // registry-level secret operations.
  providers: [RegistryService, HealthMonitorService, VaultService],
  exports: [RegistryService],
})
export class RegistryModule {}
