// =============================================================================
// src/external/external.service.ts — External API Manager Service
// =============================================================================
// NestJS injectable service that manages connections to third-party APIs.
//
// REPLACES: Express ExternalApiManager (manager.ts)
// NestJS ADVANTAGE: Dependencies (ConfigService, LoggerService, KafkaService)
// are automatically injected via the DI container. Circuit breakers are created
// per-API. Lifecycle hooks handle init/cleanup.
// =============================================================================

import { Injectable, OnModuleInit } from '@nestjs/common';
import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { ConfigService } from '../config/config.service';
import { LoggerService } from '../shared/logger.service';
import { KafkaService } from '../kafka/kafka.service';
import { MetricsService } from '../metrics/metrics.service';
import { CircuitBreaker, CircuitState } from '../shared/circuit-breaker';
import { BadGatewayError, NotFoundError, ServiceUnavailableError } from '../shared/errors';
import { ExternalApiConfig, ExternalApiConfigMap, ExternalCallOptions } from '../types';
import { buildExternalApis } from './apis';
import { TOPICS } from '../kafka/topics';

@Injectable()
export class ExternalService implements OnModuleInit {
  private readonly clients = new Map<string, AxiosInstance>();
  private readonly breakers = new Map<string, CircuitBreaker>();
  private apis!: ExternalApiConfigMap;

  constructor(
    private readonly config: ConfigService,
    private readonly logger: LoggerService,
    private readonly kafka: KafkaService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit() {
    // Build API configs from centralised ConfigService (no direct process.env)
    this.apis = buildExternalApis(this.config);

    for (const [name, cfg] of Object.entries(this.apis)) {
      this.initClient(name, cfg);
    }
    this.logger.info(`ExternalService: initialised ${this.clients.size} API client(s)`);
  }

  // ─── API Catalogue ───────────────────────────────────────────────────────────
  listApis() {
    return Object.entries(this.apis).map(([key, cfg]) => ({
      name: key,
      displayName: cfg.displayName,
      baseUrl: cfg.baseUrl,
      authType: cfg.authType,
      timeout: cfg.timeout,
      circuitBreakerState: this.breakers.get(key)?.getState() ?? 'unknown',
    }));
  }

  getApiConfig(name: string): ExternalApiConfig | undefined {
    return this.apis[name];
  }

  // ─── Circuit Breaker Management ──────────────────────────────────────────────

  /** Get stats for all circuit breakers (used by /health/ready and admin) */
  getAllBreakerStats() {
    return Array.from(this.breakers.values()).map((b) => b.getStats());
  }

  /** Get a specific circuit breaker by API name (used by admin reset endpoint) */
  getBreaker(apiName: string): CircuitBreaker | undefined {
    return this.breakers.get(apiName);
  }

  // ─── Proxied call ────────────────────────────────────────────────────────────
  async call(apiName: string, options: ExternalCallOptions): Promise<{
    status: number;
    headers: Record<string, unknown>;
    data: unknown;
    duration: number;
  }> {
    const cfg = this.apis[apiName];
    if (!cfg) {
      throw new NotFoundError(`External API '${apiName}' is not configured`);
    }

    const client = this.clients.get(apiName);
    if (!client) {
      throw new ServiceUnavailableError(`Client for '${apiName}' is not initialised`);
    }

    const breaker = this.breakers.get(apiName)!;

    return breaker.execute(async () => {
      const axiosCfg: AxiosRequestConfig = {
        method: options.method || 'GET',
        url: options.path || '/',
        params: options.query,
        data: options.body,
        headers: {
          ...options.headers,
          'X-Forwarded-By': 'apicenter-gateway',
        },
        timeout: options.timeout || cfg.timeout,
      };

      const start = Date.now();

      try {
        const resp = await client.request(axiosCfg);
        const duration = Date.now() - start;

        this.kafka
          .publish(TOPICS.EXTERNAL_REQUEST, {
            api: apiName,
            method: axiosCfg.method,
            path: axiosCfg.url,
            status: resp.status,
            duration,
            timestamp: new Date().toISOString(),
          })
          .catch((err) => {
            this.logger.warn(
              `Kafka publish failed for ${TOPICS.EXTERNAL_REQUEST}: ${(err as Error).message}`,
              'ExternalService',
            );
          });

        return {
          status: resp.status,
          headers: resp.headers,
          data: resp.data,
          duration,
        };
      } catch (error: any) {
        const duration = Date.now() - start;
        this.logger.error(`External call to ${apiName} failed (${duration}ms): ${error.message}`);
        throw new BadGatewayError(`External API '${apiName}' returned an error: ${error.message}`);
      }
    });
  }

  // ─── Private ─────────────────────────────────────────────────────────────────
  private initClient(name: string, cfg: ExternalApiConfig) {
    const headers: Record<string, string> = { 'User-Agent': 'APICenter/1.0' };

    if (cfg.authValue) {
      if (cfg.authType === 'bearer') {
        headers[cfg.authHeader] = `Bearer ${cfg.authValue}`;
      } else if (cfg.authType === 'basic') {
        headers[cfg.authHeader] = `Basic ${Buffer.from(cfg.authValue).toString('base64')}`;
      } else if (cfg.authType === 'apiKey') {
        headers[cfg.authHeader] = cfg.authValue;
      }
    }

    const client = axios.create({
      baseURL: cfg.baseUrl,
      timeout: cfg.timeout,
      headers,
    });

    this.clients.set(name, client);

    const breaker = new CircuitBreaker(name, this.logger, {
      failureThreshold: 5,
      resetTimeoutMs: 30_000,
      onStateChange: (breakerName, from, to) => {
        // Update Prometheus gauge
        this.metrics.setCircuitBreakerState(breakerName, to);

        // Publish Kafka events on OPEN and CLOSED transitions
        if (to === CircuitState.OPEN) {
          this.kafka
            .publish(TOPICS.GATEWAY_ERROR, {
              event: 'circuit_breaker_opened',
              apiName: breakerName,
              previousState: from,
              timestamp: new Date().toISOString(),
            })
            .catch((err) => {
              this.logger.warn(
                `Kafka publish failed for ${TOPICS.GATEWAY_ERROR}: ${(err as Error).message}`,
                'ExternalService',
              );
            });
        } else if (to === CircuitState.CLOSED) {
          this.kafka
            .publish(TOPICS.GATEWAY_RESPONSE, {
              event: 'circuit_breaker_closed',
              apiName: breakerName,
              previousState: from,
              timestamp: new Date().toISOString(),
            })
            .catch((err) => {
              this.logger.warn(
                `Kafka publish failed for ${TOPICS.GATEWAY_RESPONSE}: ${(err as Error).message}`,
                'ExternalService',
              );
            });
        }
      },
    });
    this.breakers.set(name, breaker);

    this.logger.debug(`ExternalService: registered client for '${name}' -> ${cfg.baseUrl}`);
  }
}
