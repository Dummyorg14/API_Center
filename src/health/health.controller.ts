// =============================================================================
// src/health/health.controller.ts — Health Check Controller
// =============================================================================
// NestJS Terminus-based health checks replacing the Express healthRouter.
//
// ENDPOINTS:
//  GET /api/v1/health/live  — Liveness probe  (always 200 if process is up)
//  GET /api/v1/health/ready — Readiness probe  (checks Kafka connectivity)
// =============================================================================

import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HealthCheckResult,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import { KafkaService } from '../kafka/kafka.service';
import { RegistryService } from '../registry/registry.service';
import { ExternalService } from '../external/external.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly kafka: KafkaService,
    private readonly registry: RegistryService,
    private readonly externalService: ExternalService,
  ) {}

  /**
   * GET /api/v1/health/live — Liveness probe
   */
  @Get('live')
  @HealthCheck()
  liveness(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.processCheck(),
    ]);
  }

  /**
   * GET /api/v1/health/ready — Readiness probe
   */
  @Get('ready')
  @HealthCheck()
  readiness(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.processCheck(),
      () => this.kafkaCheck(),
      () => this.registryCheck(),
      () => this.circuitBreakerCheck(),
    ]);
  }

  // ─── Custom indicators ─────────────────────────────────────────────────────
  private async processCheck(): Promise<HealthIndicatorResult> {
    const uptime = process.uptime();
    const memoryUsage = process.memoryUsage();

    return {
      process: {
        status: 'up',
        uptime: Math.floor(uptime),
        memory: {
          rss: `${Math.round(memoryUsage.rss / 1024 / 1024)}MB`,
          heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`,
          heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)}MB`,
        },
        pid: process.pid,
      },
    };
  }

  private async kafkaCheck(): Promise<HealthIndicatorResult> {
    try {
      const connected = this.kafka.isConnected();
      return {
        kafka: {
          status: connected ? 'up' : 'down',
        },
      };
    } catch {
      return { kafka: { status: 'down' } };
    }
  }

  private async registryCheck(): Promise<HealthIndicatorResult> {
    return {
      registry: {
        status: 'up',
        registeredServices: this.registry.count(),
      },
    };
  }

  private async circuitBreakerCheck(): Promise<HealthIndicatorResult> {
    const stats = this.externalService.getAllBreakerStats();
    const openBreakers = stats.filter((s) => s.state === 'OPEN');

    return {
      circuitBreakers: {
        status: openBreakers.length > 0 ? 'down' : 'up',
        total: stats.length,
        open: openBreakers.length,
        breakers: stats.map((s) => ({
          name: s.name,
          state: s.state,
          failureCount: s.failureCount,
        })),
      },
    };
  }
}
