// =============================================================================
// src/external/external.module.ts — External API NestJS Module
// =============================================================================

import { Module } from '@nestjs/common';
import { ExternalService } from './external.service';
import { ExternalController } from './external.controller';
import { AdminCircuitBreakerController } from './admin.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [ExternalController, AdminCircuitBreakerController],
  providers: [ExternalService],
  exports: [ExternalService],
})
export class ExternalModule {}
