// =============================================================================
// src/metrics/metrics.module.ts — Prometheus metrics module
// =============================================================================
// Integrates @willsoto/nestjs-prometheus to expose a GET /metrics endpoint
// in Prometheus scrape format. Also provides MetricsService for custom
// application-level metrics (HTTP request counts, circuit breaker states, etc.)
// =============================================================================

import { Global, Module } from '@nestjs/common';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';
import { MetricsService } from './metrics.service';
import { MetricsInterceptor } from './metrics.interceptor';

@Global()
@Module({
  imports: [
    PrometheusModule.register({
      // Exposes GET /metrics (no /api/v1 prefix — Prometheus scrapes root)
      path: '/metrics',
      defaultMetrics: {
        enabled: true,
      },
    }),
  ],
  providers: [MetricsService, MetricsInterceptor],
  exports: [MetricsService, MetricsInterceptor],
})
export class MetricsModule {}
