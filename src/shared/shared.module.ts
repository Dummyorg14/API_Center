// =============================================================================
// src/shared/shared.module.ts — Shared utilities module
// =============================================================================
// Provides cross-cutting utilities (logger, filters, interceptors) to all
// feature modules via NestJS dependency injection.
// =============================================================================

import { Global, Module } from '@nestjs/common';
import { LoggerService } from './logger.service';
import { AllExceptionsFilter } from './filters/all-exceptions.filter';
import { CorrelationIdInterceptor } from './interceptors/correlation-id.interceptor';
import { AuditLogInterceptor } from './interceptors/audit-log.interceptor';
import { SecurityMiddleware } from './middleware/security.middleware';
import { MorganMiddleware } from './middleware/morgan.middleware';
import { RedisThrottlerStorage } from './redis-throttler-storage';

@Global()
@Module({
  providers: [
    LoggerService,
    AllExceptionsFilter,
    CorrelationIdInterceptor,
    AuditLogInterceptor,
    SecurityMiddleware,
    MorganMiddleware,
    RedisThrottlerStorage,
  ],
  exports: [
    LoggerService,
    AllExceptionsFilter,
    CorrelationIdInterceptor,
    AuditLogInterceptor,
    SecurityMiddleware,
    MorganMiddleware,
    RedisThrottlerStorage,
  ],
})
export class SharedModule {}
