// =============================================================================
// src/main.ts — APICenter Gateway Bootstrap
// =============================================================================
//
// FOUNDATION ROLE (checklist §1, §4, §8):
//   APICenter is the SINGLE centralized API gateway for the entire platform.
//
//   All traffic — without exception — routes through here:
//     ┌─────────────────────────────────────────────────────────┐
//     │  consumer (tribe SDK / browser / external client)       │
//     │    ↓                                                     │
//     │  NGINX  :3000  (round-robin across 3 containers)        │
//     │    ↓                                                     │
//     │  APICenter container  ← this process                    │
//     │    ↓                                                     │
//     │  target upstream  (tribe API / shared service / ext)    │
//     └─────────────────────────────────────────────────────────┘
//
//   Route namespaces:
//     /api/v1/tribes/:serviceId/*    — tribe-to-tribe calls
//     /api/v1/shared/:serviceId/*    — shared platform services
//     /api/v1/external/:apiName/*    — third-party external APIs
//     /api/v1/auth/*                 — token issuance / refresh / revoke
//     /api/v1/registry/*             — service self-registration
//     /api/v1/health/*               — liveness + readiness probes
//
// STATELESS DESIGN (checklist §1, §8):
//   No local mutable state. All shared state lives in Redis:
//     • registry entries  — survives container restart
//     • refresh tokens    — revocable across any container
//     • rate-limit counters — enforced consistently across all 3 containers
//   This means every container is interchangeable and any can be restarted
//   without disrupting inflight requests on the other two.
//
// CORS (checklist §8 — "foundation is ready for future … policies"):
//   Enabled globally here via NestJS app.enableCors().
//   ALLOWED_ORIGINS controls which origins receive the
//   Access-Control-Allow-Origin header. In development use * (default).
//   In production, set a comma-separated list of allowed origins.
//   NGINX also handles OPTIONS preflight at the load-balancer level
//   (zero Node process overhead) with matching settings.
// =============================================================================

// OTel MUST be initialized first — patches http/express before any require
import { initTracing } from './tracing';
initTracing();

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { LoggerService } from './shared/logger.service';
import { ConfigService } from './config/config.service';
import { AllExceptionsFilter } from './shared/filters/all-exceptions.filter';
import { CorrelationIdInterceptor } from './shared/interceptors/correlation-id.interceptor';
import { AuditLogInterceptor } from './shared/interceptors/audit-log.interceptor';
import { MetricsInterceptor } from './metrics/metrics.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  const logger = app.get(LoggerService);
  const config = app.get(ConfigService);
  app.useLogger(logger);

  // ── Security headers ──────────────────────────────────────────────────────
  app.use(
    helmet({
      // Allow cross-origin resource loading (CDN assets, tribe frontends)
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      // CSP not set here — each tribe's frontend should set its own policy
      contentSecurityPolicy: false,
    }),
  );

  // ── CORS ──────────────────────────────────────────────────────────────────
  // This config MUST match the NGINX CORS block in nginx.conf so that direct
  // container calls (CI, health checks, local dev) and load-balanced calls
  // both honour the same CORS policy.
  //
  // Configuration:
  //   ALLOWED_ORIGINS=*                            → dev / permissive
  //   ALLOWED_ORIGINS=https://app.acme.com,https://admin.acme.com  → prod
  app.enableCors({
    origin: config.cors.origin,           // driven by ALLOWED_ORIGINS env var
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Correlation-ID',
      'X-Platform-Secret',
      'X-Tribe-Id',
    ],
    exposedHeaders: [
      'X-Correlation-ID',   // trace requests across services
      'Deprecation',        // RFC 8594 — service lifecycle signal
      'Sunset',             // RFC 8594 — deadline for migration
      'Link',               // points to replacement service
      'Retry-After',        // rate-limit backoff
    ],
    credentials: true,    // allow Authorization header from browsers
    maxAge: 86_400,       // cache preflight for 24 h — reduces OPTIONS volume
  });

  // ── Request validation ────────────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,              // strip unknown properties from DTOs
      forbidNonWhitelisted: true,   // reject requests with unknown properties
      transform: true,              // auto-coerce strings to numbers/booleans
    }),
  );

  // ── Global interceptors ───────────────────────────────────────────────────
  // Run on every request, in this order:
  //   1. CorrelationId — assign / propagate X-Correlation-ID
  //   2. AuditLog      — publish Kafka audit event after response
  //   3. Metrics       — record Prometheus counter + histogram
  app.useGlobalInterceptors(
    app.get(CorrelationIdInterceptor),
    app.get(AuditLogInterceptor),
    app.get(MetricsInterceptor),
  );

  // ── Global exception filter ───────────────────────────────────────────────
  app.useGlobalFilters(app.get(AllExceptionsFilter));

  // ── API versioning ────────────────────────────────────────────────────────
  // All routes are prefixed /api/v1/ — version bumps get a new prefix.
  app.setGlobalPrefix('api/v1');

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  // On SIGTERM/SIGINT, NestJS calls onModuleDestroy() on all modules before
  // the process exits — allowing Kafka, Redis, and proxy connections to close.
  app.enableShutdownHooks();

  await app.listen(config.port);

  logger.log(`────────────────────────────────────────────────────`, 'Bootstrap');
  logger.log(`  APICenter gateway  |  port: ${config.port}`,        'Bootstrap');
  logger.log(`  environment        |  ${config.nodeEnv}`,           'Bootstrap');
  logger.log(`  auth provider      |  ${config.authProvider}`,      'Bootstrap');
  logger.log(`  CORS origins       |  ${JSON.stringify(config.cors.origin)}`, 'Bootstrap');
  logger.log(`  stateless          |  Redis shared state enabled`,  'Bootstrap');
  logger.log(`  flow               |  consumer → NGINX → container → upstream`, 'Bootstrap');
  logger.log(`────────────────────────────────────────────────────`, 'Bootstrap');
}

bootstrap();
