// =============================================================================
// src/metrics/metrics.service.ts — Prometheus metrics collector
// =============================================================================
// Exposes application-level metrics for Prometheus scraping.
//
// METRICS:
//  - http_requests_total          (counter)   — Total HTTP requests
//  - http_request_duration_seconds (histogram) — Request latency distribution
//  - circuit_breaker_state        (gauge)     — 0=CLOSED 1=OPEN 2=HALF_OPEN
//  - registry_services_total      (gauge)     — Number of registered services
// =============================================================================

import { Injectable, OnModuleInit } from '@nestjs/common';
import { Counter, Histogram, Gauge } from 'prom-client';

@Injectable()
export class MetricsService implements OnModuleInit {
  // ---- HTTP Metrics ----
  readonly httpRequestsTotal: Counter;
  readonly httpRequestDuration: Histogram;

  // ---- Circuit Breaker Metrics ----
  readonly circuitBreakerState: Gauge;

  // ---- Registry Metrics ----
  readonly registryServicesTotal: Gauge;

  // ---- Showback / Usage Metrics ----
  readonly proxyRequestsTotal: Counter;
  readonly proxyRequestDuration: Histogram;

  /** @deprecated Use proxyRequestsTotal — kept as alias for backwards compat */
  readonly tribeRequestsTotal: Counter;
  /** @deprecated Use proxyRequestDuration — kept as alias for backwards compat */
  readonly tribeRequestDuration: Histogram;

  constructor() {
    this.httpRequestsTotal = new Counter({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'route', 'status_code'] as const,
    });

    this.httpRequestDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route'] as const,
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    });

    this.circuitBreakerState = new Gauge({
      name: 'circuit_breaker_state',
      help: 'Circuit breaker state: 0=CLOSED 1=OPEN 2=HALF_OPEN',
      labelNames: ['api_name'] as const,
    });

    this.registryServicesTotal = new Gauge({
      name: 'registry_services_total',
      help: 'Total number of registered services in the registry',
    });

    this.proxyRequestsTotal = new Counter({
      name: 'proxy_requests_total',
      help: 'Total proxy requests for showback attribution (shared + tribe)',
      labelNames: ['namespace', 'source_tribe', 'target_service', 'method', 'status_code'] as const,
    });

    this.proxyRequestDuration = new Histogram({
      name: 'proxy_request_duration_seconds',
      help: 'Proxy request duration in seconds for showback attribution',
      labelNames: ['namespace', 'source_tribe', 'target_service'] as const,
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    });

    // Backwards-compat aliases
    this.tribeRequestsTotal = this.proxyRequestsTotal;
    this.tribeRequestDuration = this.proxyRequestDuration;
  }

  onModuleInit() {
    // Initialize all circuit breaker gauges to 0 (CLOSED)
    this.registryServicesTotal.set(0);
  }

  /**
   * Record an HTTP request.
   */
  recordHttpRequest(method: string, route: string, statusCode: number, durationSec: number) {
    this.httpRequestsTotal.inc({ method, route, status_code: String(statusCode) });
    this.httpRequestDuration.observe({ method, route }, durationSec);
  }

  /**
   * Update circuit breaker state gauge.
   * @param apiName — The external API name
   * @param state   — 'CLOSED' | 'OPEN' | 'HALF_OPEN'
   */
  setCircuitBreakerState(apiName: string, state: string) {
    let stateValue = 0;
    if (state === 'OPEN') stateValue = 1;
    else if (state === 'HALF_OPEN') stateValue = 2;
    this.circuitBreakerState.set({ api_name: apiName }, stateValue);
  }

  /**
   * Update the total number of registered services.
   */
  setRegistryServicesCount(count: number) {
    this.registryServicesTotal.set(count);
  }

  /**
   * Record a proxy request for showback attribution (works for both namespaces).
   */
  recordProxyRequest(
    namespace: string,
    sourceTribe: string,
    targetService: string,
    method: string,
    statusCode: number,
    durationSec: number,
  ) {
    this.proxyRequestsTotal.inc({
      namespace,
      source_tribe: sourceTribe,
      target_service: targetService,
      method,
      status_code: String(statusCode),
    });
    this.proxyRequestDuration.observe(
      { namespace, source_tribe: sourceTribe, target_service: targetService },
      durationSec,
    );
  }

  /**
   * @deprecated Use recordProxyRequest — kept for backwards compatibility.
   */
  recordTribeRequest(
    sourceTribe: string,
    targetService: string,
    method: string,
    statusCode: number,
    durationSec: number,
  ) {
    this.recordProxyRequest('tribe', sourceTribe, targetService, method, statusCode, durationSec);
  }
}
