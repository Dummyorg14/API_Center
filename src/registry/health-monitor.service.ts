// =============================================================================
// src/registry/health-monitor.service.ts — Active Health Checking & Redis Drift
// =============================================================================
// Two scheduled jobs that keep the registry accurate at runtime:
//
//  1. HEALTH CHECK (every 30 s)
//     For every registered service that declares a `healthCheck` path, send an
//     HTTP GET to `baseUrl + healthCheck`.  On failure, mark the service as
//     unhealthy so the proxy stops routing traffic to it.  When the service
//     recovers, mark it healthy again.  Every transition emits a
//     SERVICE_HEALTH_CHANGED Kafka event.
//
//  2. REDIS DRIFT RECONCILIATION (every 5 min)
//     Compare the in-memory registry with the Redis source of truth.  If any
//     discrepancy is found (missing keys in either direction), resync the local
//     memory from Redis and log a warning so operators can investigate.
// =============================================================================

import { Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { VaultService } from '../auth/vault.service';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';
import { RegistryService } from './registry.service';
import { LoggerService } from '../shared/logger.service';
import { KafkaService } from '../kafka/kafka.service';
import { TOPICS } from '../kafka/topics';

/** Timeout for individual upstream health check requests (ms). */
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

@Injectable()
export class HealthMonitorService implements OnModuleDestroy {
  /** Tracks whether a health-check sweep is already in progress. */
  private healthCheckRunning = false;
  /** Tracks whether a reconciliation sweep is already in progress. */
  private reconciliationRunning = false;

  constructor(
    private readonly registry: RegistryService,
    private readonly logger: LoggerService,
    private readonly kafka: KafkaService,
    @Optional() private readonly vault?: VaultService,
  ) {}

  onModuleDestroy() {
    // Nothing to tear down — cron jobs stop with the NestJS app lifecycle.
  }

  // =========================================================================
  // CRON 1 — Active upstream health checking (every 30 seconds)
  // =========================================================================

  @Cron(CronExpression.EVERY_30_SECONDS)
  async handleHealthChecks(): Promise<void> {
    // Guard against overlapping sweeps if a previous one is still running.
    if (this.healthCheckRunning) return;
    this.healthCheckRunning = true;

    try {
      const allServices = this.registry.getAll();
      const entries = Object.values(allServices);

      // Build a list of services that have a healthCheck endpoint defined
      const checkable = entries.filter(
        (svc) =>
          svc.healthCheck &&
          svc.status !== 'retired' &&
          svc.status !== 'proposed',
      );

      if (checkable.length === 0) return;

      // Fire all health checks concurrently (each has its own timeout)
      const results = await Promise.allSettled(
        checkable.map(async (svc) => {
          const url = `${svc.baseUrl}${svc.healthCheck}`;
          try {
            const response = await axios.get(url, {
              timeout: HEALTH_CHECK_TIMEOUT_MS,
              validateStatus: (status) => status < 500, // 2xx–4xx = alive
            });

            // Mark healthy
            const changed = this.registry.setHealthStatus(svc.serviceId, true);
            if (changed) {
              this.logger.info(
                `Service '${svc.serviceId}' recovered — marked healthy`,
                { serviceId: svc.serviceId, url, status: response.status },
              );
              await this.emitHealthChanged(svc.serviceId, true, false, 'Health check succeeded');
            } else {
              // No state change — just touch the timestamp
              this.registry.touchHealthCheck(svc.serviceId);
            }
          } catch (err) {
            const reason = (err as Error).message || 'Unknown error';

            // Mark unhealthy
            const changed = this.registry.setHealthStatus(svc.serviceId, false);
            if (changed) {
              this.logger.warn(
                `Service '${svc.serviceId}' is unreachable — marked unhealthy: ${reason}`,
                'HealthMonitor',
              );
              await this.emitHealthChanged(svc.serviceId, false, true, reason);
            } else {
              this.registry.touchHealthCheck(svc.serviceId);
            }
          }
        }),
      );

      // Log any unexpected promise rejections (should not happen, but belt & suspenders)
      const failures = results.filter((r) => r.status === 'rejected');
      if (failures.length > 0) {
        this.logger.warn(
          `${failures.length} health check(s) threw unexpected errors`,
          'HealthMonitor',
        );
      }
    } finally {
      this.healthCheckRunning = false;
    }
  }

  // =========================================================================
  // CRON 2 — Redis drift reconciliation (every 5 minutes)
  // =========================================================================

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleRedisDriftReconciliation(): Promise<void> {
    if (this.reconciliationRunning) return;
    this.reconciliationRunning = true;

    try {
      const redisEntries = await this.registry.getRedisEntries();

      // Redis unavailable — nothing to reconcile against
      if (redisEntries === null) {
        this.logger.debug(
          'Redis unavailable — skipping drift reconciliation',
        );
        return;
      }

      const memoryEntries = this.registry.getAll();

      const redisKeys = new Set(Object.keys(redisEntries));
      const memoryKeys = new Set(Object.keys(memoryEntries));

      // Keys present in Redis but missing from local memory
      const missingInMemory = [...redisKeys].filter((k) => !memoryKeys.has(k));

      // Keys present in memory but missing from Redis
      const missingInRedis = [...memoryKeys].filter((k) => !redisKeys.has(k));

      // Check for data divergence (same key, different updatedAt — simple heuristic)
      const diverged: string[] = [];
      for (const key of redisKeys) {
        if (
          memoryKeys.has(key) &&
          redisEntries[key].updatedAt !== memoryEntries[key].updatedAt
        ) {
          diverged.push(key);
        }
      }

      const hasDrift =
        missingInMemory.length > 0 ||
        missingInRedis.length > 0 ||
        diverged.length > 0;

      if (!hasDrift) {
        this.logger.debug('Redis drift check passed — no discrepancies');
        return;
      }

      // ── Drift detected — log details and resync ──────────────────────────
      this.logger.warn(
        `Redis drift detected — ` +
          `missingInMemory=${missingInMemory.length}, ` +
          `missingInRedis=${missingInRedis.length}, ` +
          `diverged=${diverged.length}. ` +
          `Resyncing local memory from Redis.`,
        'HealthMonitor',
      );

      if (missingInMemory.length > 0) {
        this.logger.warn(
          `Services in Redis but missing locally: ${missingInMemory.join(', ')}`,
          'HealthMonitor',
        );
      }
      if (missingInRedis.length > 0) {
        this.logger.warn(
          `Services in memory but missing from Redis: ${missingInRedis.join(', ')}`,
          'HealthMonitor',
        );
      }
      if (diverged.length > 0) {
        this.logger.warn(
          `Services with diverged state: ${diverged.join(', ')}`,
          'HealthMonitor',
        );
      }

      // Resync: reload the authoritative Redis state into local memory
      await this.registry.loadFromRedis();

      this.logger.info(
        'Registry resynced from Redis after drift detection',
        {},
      );
    } catch (err) {
      this.logger.error(
        `Redis drift reconciliation failed: ${(err as Error).message}`,
        (err as Error).stack,
        'HealthMonitor',
      );
    } finally {
      this.reconciliationRunning = false;
    }
  }

  // =========================================================================
  // Private helpers
  // =========================================================================


  // =========================================================================
  // CRON 3 — Vault token renewal (every 30 minutes)
  // =========================================================================
  // Renews the Vault service token before it expires (AppRole tokens are
  // short-lived). This keeps the gateway authenticated to Vault without
  // requiring a restart.
  // =========================================================================

  @Cron('0 */30 * * * *')
  async handleVaultTokenRenewal(): Promise<void> {
    if (!this.vault) return;
    try {
      await this.vault.renewToken();
    } catch (err) {
      this.logger.error(
        `Vault token renewal failed: ${(err as Error).message}`,
        (err as Error).stack,
        'HealthMonitor',
      );
    }
  }

  private async emitHealthChanged(
    serviceId: string,
    healthy: boolean,
    previousHealthy: boolean,
    reason: string,
  ): Promise<void> {
    try {
      await this.kafka.publish(TOPICS.SERVICE_HEALTH_CHANGED, {
        serviceId,
        healthy,
        previousHealthy,
        reason,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      this.logger.warn(
        `Kafka publish failed for ${TOPICS.SERVICE_HEALTH_CHANGED}: ${(err as Error).message}`,
        'HealthMonitor',
      );
    }
  }
}
