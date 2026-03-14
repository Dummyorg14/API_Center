// =============================================================================
// src/config/config.module.ts — Configuration module
// =============================================================================
// Provides the ConfigService and SecretsService as global singletons.
// SecretsService runs first (OnModuleInit) to load AWS secrets into process.env
// before ConfigService reads them.
// =============================================================================

import { Global, Module } from '@nestjs/common';
import { ConfigService } from './config.service';
import { SecretsService } from './secrets.service';

@Global()
@Module({
  providers: [SecretsService, ConfigService],
  exports: [ConfigService, SecretsService],
})
export class ConfigModule {}
