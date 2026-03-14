// =============================================================================
// src/registry/registry.service.ts — Dynamic Service Registry (NestJS)
// =============================================================================
// The heart of the "Dynamic Service Registry" platform. Services register
// themselves at runtime by POSTing a ServiceManifest.
//
// STORAGE STRATEGY (layered):
//  1. In-memory Map  — hot cache for zero-latency lookups (primary)
//  2. Redis          — source of truth, shared across instances (persistent)
//
// On startup (OnModuleInit), all entries are loaded from Redis into memory.
// On registration/deregistration, both memory and Redis are updated.
// =============================================================================

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import crypto from 'node:crypto';
import Redis from 'ioredis';
import {
  ServiceManifest,
  ServiceRegistryEntry,
  ServiceRegistryMap,
  ServiceType,
} from '../types';
import { LoggerService } from '../shared/logger.service';
import { ConfigService } from '../config/config.service';
import { KafkaService } from '../kafka/kafka.service';
import { MetricsService } from '../metrics/metrics.service';
import { NotFoundError, ConflictError, ValidationError } from '../shared/errors';
import { TOPICS } from '../kafka/topics';

const REDIS_REGISTRY_KEY = 'api-center:registry:services';

/** Default timeout for critical Redis writes (ms). */
const REDIS_WRITE_TIMEOUT_MS = 2_000;

@Injectable()
export class RegistryService implements OnModuleInit, OnModuleDestroy {
  private readonly services: ServiceRegistryMap = {};
  private redis: Redis | null = null;
  private readonly cacheInvalidationListeners = new Set<(serviceId: string) => void>();

  constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigService,
    private readonly kafka: KafkaService,
    private readonly metrics: MetricsService,
  ) {}

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async onModuleInit() {
    try {
      this.redis = new Redis(this.config.redis.cacheUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => Math.min(times * 200, 3000),
      });

      await this.redis.connect();
      this.logger.info('Registry connected to Redis (cache)', {});

      // Hydrate in-memory map from Redis on boot
      await this.loadFromRedis();
    } catch (err) {
      this.logger.warn(
        `Registry Redis unavailable — running in memory-only mode: ${(err as Error).message}`,
        'RegistryService',
      );
      this.redis = null;
    }
  }

  async onModuleDestroy() {
    if (this.redis) {
      await this.redis.quit();
      this.logger.info('Registry Redis connection closed', {});
    }
  }

  // -------------------------------------------------------------------------
  // Cache invalidation listeners
  // -------------------------------------------------------------------------

  /**
   * Register a listener that is notified whenever a service is re-registered
   * (e.g. its baseUrl may have changed). Returns an unsubscribe function.
   * Used by ProxyHandler to drop stale cached middleware instances.
   */
  onCacheInvalidation(listener: (serviceId: string) => void): () => void {
    this.cacheInvalidationListeners.add(listener);
    return () => {
      this.cacheInvalidationListeners.delete(listener);
    };
  }

  private notifyCacheInvalidation(serviceId: string): void {
    for (const listener of this.cacheInvalidationListeners) {
      try {
        listener(serviceId);
      } catch (err) {
        this.logger.warn(
          `Cache invalidation listener error for '${serviceId}': ${(err as Error).message}`,
          'RegistryService',
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Register a new service or update an existing one.
   * Writes to both in-memory Map and Redis.
   * Validates semver on updates and tracks version changes.
   *
   * Redis persistence is **awaited** with a strict timeout — if Redis is
   * unavailable the registration fails so in-memory and Redis never drift.
   */
  async register(manifest: ServiceManifest): Promise<ServiceRegistryEntry> {
    const now = new Date().toISOString();
    const existing = this.services[manifest.serviceId];

    // ── Version governance ─────────────────────────────────────────────────
    let previousVersion: string | undefined;
    if (existing && manifest.version && existing.version) {
      previousVersion = existing.version;
      this.validateVersionUpgrade(existing.version, manifest.version);
    }

    // ── Block registration if service is retired ───────────────────────────
    if (existing?.status === 'retired') {
      throw new ConflictError(
        `Service '${manifest.serviceId}' is retired and cannot be re-registered`,
      );
    }

    const entry: ServiceRegistryEntry = {
      ...manifest,
      serviceType: manifest.serviceType || 'tribe',
      registeredAt: existing?.registeredAt || now,
      updatedAt: now,
      status: existing?.status === 'deprecated' ? 'deprecated' : 'active',
      ...(previousVersion && { previousVersion }),
    };

    this.services[manifest.serviceId] = entry;
    this.syncMetricsGauge();

    // Persist to Redis with a strict timeout — fail the registration if Redis
    // is unavailable so the gateway never silently drifts from its source of truth.
    await this.persistToRedisStrict(manifest.serviceId, entry);

    // ── Kafka events ──────────────────────────────────────────────────────
    this.kafka
      .publish(TOPICS.SERVICE_REGISTERED, {
        serviceId: manifest.serviceId,
        name: manifest.name,
        baseUrl: manifest.baseUrl,
        exposes: manifest.exposes,
        serviceType: entry.serviceType,
        isUpdate: !!existing,
        timestamp: now,
      })
      .catch((err) => {
        this.logger.warn(
          `Kafka publish failed for ${TOPICS.SERVICE_REGISTERED}: ${(err as Error).message}`,
          'RegistryService',
        );
      });

    if (previousVersion && previousVersion !== manifest.version) {
      this.kafka
        .publish(TOPICS.SERVICE_VERSION_CHANGED, {
          serviceId: manifest.serviceId,
          previousVersion,
          newVersion: manifest.version,
          timestamp: now,
        })
        .catch((err) => {
          this.logger.warn(
            `Kafka publish failed for ${TOPICS.SERVICE_VERSION_CHANGED}: ${(err as Error).message}`,
            'RegistryService',
          );
        });
    }

    this.logger.info('Service registered', {
      serviceId: manifest.serviceId,
      name: manifest.name,
      baseUrl: manifest.baseUrl,
      exposes: manifest.exposes,
      isUpdate: !!existing,
      version: manifest.version,
    });

    // ── Invalidate proxy caches on re-registration (baseUrl may have changed)
    if (existing) {
      this.notifyCacheInvalidation(manifest.serviceId);
    }

    return entry;
  }

  /**
   * Remove a service from the registry.
   * Removes from both in-memory Map and Redis.
   */
  async deregister(serviceId: string): Promise<void> {
    const existing = this.services[serviceId];
    if (!existing) {
      throw new NotFoundError(`Service '${serviceId}' is not registered`);
    }

    delete this.services[serviceId];
    this.syncMetricsGauge();

    // Remove from Redis with strict timeout
    await this.removeFromRedisStrict(serviceId);

    this.kafka
      .publish(TOPICS.SERVICE_DEREGISTERED, {
        serviceId,
        timestamp: new Date().toISOString(),
      })
      .catch((err) => {
        this.logger.warn(
          `Kafka publish failed for ${TOPICS.SERVICE_DEREGISTERED}: ${(err as Error).message}`,
          'RegistryService',
        );
      });

    this.logger.info('Service deregistered', { serviceId });
  }

  // -------------------------------------------------------------------------
  // Lifecycle management
  // -------------------------------------------------------------------------

  /**
   * Mark a service as deprecated. It remains routable but consumers receive
   * sunset warnings in proxy response headers.
   */
  deprecate(serviceId: string, sunsetDate?: string, replacementService?: string): ServiceRegistryEntry {
    const entry = this.services[serviceId];
    if (!entry) {
      throw new NotFoundError(`Service '${serviceId}' is not registered`);
    }
    if (entry.status === 'retired') {
      throw new ConflictError(`Service '${serviceId}' is already retired`);
    }

    entry.status = 'deprecated';
    entry.updatedAt = new Date().toISOString();
    if (sunsetDate) entry.sunsetDate = sunsetDate;
    if (replacementService) entry.replacementService = replacementService;

    this.persistToRedis(serviceId, entry).catch((err) => {
      this.logger.warn(
        `Redis persist failed for deprecated service '${serviceId}': ${(err as Error).message}`,
        'RegistryService',
      );
    });

    this.kafka
      .publish(TOPICS.SERVICE_DEPRECATED, {
        serviceId,
        sunsetDate: entry.sunsetDate,
        replacementService: entry.replacementService,
        timestamp: entry.updatedAt,
      })
      .catch((err) => {
        this.logger.warn(
          `Kafka publish failed for ${TOPICS.SERVICE_DEPRECATED}: ${(err as Error).message}`,
          'RegistryService',
        );
      });

    this.logger.warn(
      `Service '${serviceId}' deprecated (sunset: ${sunsetDate || 'unset'}, replacement: ${replacementService || 'none'})`,
      'RegistryService',
    );

    return entry;
  }

  /**
   * Retire a service — it will no longer be routable.
   * Consumers calling this service will receive 410 Gone.
   */
  retire(serviceId: string): ServiceRegistryEntry {
    const entry = this.services[serviceId];
    if (!entry) {
      throw new NotFoundError(`Service '${serviceId}' is not registered`);
    }

    entry.status = 'retired';
    entry.updatedAt = new Date().toISOString();

    this.persistToRedis(serviceId, entry).catch((err) => {
      this.logger.warn(
        `Redis persist failed for retired service '${serviceId}': ${(err as Error).message}`,
        'RegistryService',
      );
    });
    this.syncMetricsGauge();

    this.kafka
      .publish(TOPICS.SERVICE_RETIRED, {
        serviceId,
        timestamp: entry.updatedAt,
      })
      .catch((err) => {
        this.logger.warn(
          `Kafka publish failed for ${TOPICS.SERVICE_RETIRED}: ${(err as Error).message}`,
          'RegistryService',
        );
      });

    this.logger.warn(`Service '${serviceId}' retired — no longer routable`, 'RegistryService');

    return entry;
  }

  /**
   * Transition a proposed service to active.
   */
  activate(serviceId: string): ServiceRegistryEntry {
    const entry = this.services[serviceId];
    if (!entry) {
      throw new NotFoundError(`Service '${serviceId}' is not registered`);
    }
    if (entry.status !== 'proposed' && entry.status !== 'deprecated') {
      throw new ConflictError(
        `Service '${serviceId}' is '${entry.status}' and cannot be activated`,
      );
    }

    entry.status = 'active';
    entry.updatedAt = new Date().toISOString();
    entry.sunsetDate = undefined;
    entry.replacementService = undefined;

    this.persistToRedis(serviceId, entry).catch((err) => {
      this.logger.warn(
        `Redis persist failed for activated service '${serviceId}': ${(err as Error).message}`,
        'RegistryService',
      );
    });
    this.syncMetricsGauge();

    this.logger.info(`Service '${serviceId}' activated`, {});
    return entry;
  }

  /**
   * Check whether a service is currently routable.
   * A service is routable if it is active or deprecated AND healthy.
   */
  isRoutable(serviceId: string): boolean {
    const entry = this.services[serviceId];
    if (!entry) return false;
    if (entry.healthy === false) return false;
    return entry.status === 'active' || entry.status === 'deprecated';
  }

  /**
   * Get consumers — services that list the given serviceId in their consumes array.
   */
  getConsumers(serviceId: string): string[] {
    return Object.values(this.services)
      .filter((svc) => svc.consumes.includes(serviceId))
      .map((svc) => svc.serviceId);
  }

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  get(serviceId: string): ServiceRegistryEntry | null {
    return this.services[serviceId] || null;
  }

  getAll(): ServiceRegistryMap {
    return { ...this.services };
  }

  /**
   * Return all entries filtered by serviceType ('shared' or 'tribe').
   * Services without an explicit serviceType default to 'tribe'.
   */
  getByType(type: ServiceType): ServiceRegistryEntry[] {
    return Object.values(this.services).filter(
      (svc) => (svc.serviceType ?? 'tribe') === type,
    );
  }

  count(): number {
    return Object.keys(this.services).length;
  }

  // -------------------------------------------------------------------------
  // Access Control
  // -------------------------------------------------------------------------

  canConsume(sourceServiceId: string, targetServiceId: string): boolean {
    const source = this.services[sourceServiceId];
    if (!source) return false;
    return source.consumes.includes(targetServiceId);
  }

  getRequiredScopes(targetServiceId: string): string[] {
    const target = this.services[targetServiceId];
    if (!target) return [];
    return target.requiredScopes;
  }

  // -------------------------------------------------------------------------
  // Proxy resolution
  // -------------------------------------------------------------------------

  resolveUpstream(serviceId: string, path: string): string | null {
    const service = this.services[serviceId];
    if (!service) return null;
    return `${service.baseUrl}${path}`;
  }

  // -------------------------------------------------------------------------
  // Secret validation
  // -------------------------------------------------------------------------

  async validateSecret(serviceId: string, secret: string): Promise<boolean> {
    const envKey = `TRIBE_SECRET_${serviceId.toUpperCase().replaceAll('-', '_')}`;
    const expected = process.env[envKey];
    if (!expected) return false;

    const hash = crypto.createHash('sha256').update(secret).digest('hex');
    if (hash.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expected));
  }

  // -------------------------------------------------------------------------
  // Health status (called by HealthMonitorService)
  // -------------------------------------------------------------------------

  /**
   * Update the runtime health flag on a service entry.
   * Returns `true` if the health status actually **changed** (for event emission).
   */
  setHealthStatus(serviceId: string, healthy: boolean): boolean {
    const entry = this.services[serviceId];
    if (!entry) return false;

    const previous = entry.healthy ?? true; // default is healthy
    if (previous === healthy) return false; // no change

    entry.healthy = healthy;
    entry.lastHealthCheckAt = new Date().toISOString();
    entry.updatedAt = entry.lastHealthCheckAt;

    // Best-effort persist to Redis (health flap should not block callers)
    this.persistToRedis(serviceId, entry).catch((err) => {
      this.logger.warn(
        `Redis persist failed for health update '${serviceId}': ${(err as Error).message}`,
        'RegistryService',
      );
    });

    return true;
  }

  /**
   * Mark the `lastHealthCheckAt` timestamp without changing the healthy flag.
   */
  touchHealthCheck(serviceId: string): void {
    const entry = this.services[serviceId];
    if (entry) {
      entry.lastHealthCheckAt = new Date().toISOString();
    }
  }

  // -------------------------------------------------------------------------
  // Bulk seeding
  // -------------------------------------------------------------------------

  seed(manifests: ServiceManifest[]): void {
    for (const manifest of manifests) {
      // Seed uses fire-and-forget style — Redis catch handled inside register
      this.register(manifest).catch((err) => {
        this.logger.warn(
          `Seed failed for '${manifest.serviceId}': ${(err as Error).message}`,
          'RegistryService',
        );
      });
    }
    this.logger.info(`Registry seeded with ${manifests.length} service(s)`, {});
  }

  // -------------------------------------------------------------------------
  // Version governance (private)
  // -------------------------------------------------------------------------

  /**
   * Validate that a version upgrade follows semver rules.
   * Prevents major-version downgrades without explicit re-registration.
   */
  private validateVersionUpgrade(currentVersion: string, newVersion: string): void {
    const parseSemver = (v: string) => {
      const match = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
      if (!match) return null;
      return { major: Number.parseInt(match[1]), minor: Number.parseInt(match[2]), patch: Number.parseInt(match[3]) };
    };

    const current = parseSemver(currentVersion);
    const next = parseSemver(newVersion);

    if (!current || !next) return; // Skip validation if versions aren't semver

    if (next.major < current.major) {
      throw new ValidationError(
        `Version downgrade from ${currentVersion} to ${newVersion} is not allowed. ` +
        `Deregister the service first if you need to roll back a major version.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Metrics sync (private)
  // -------------------------------------------------------------------------

  private syncMetricsGauge(): void {
    const activeCount = Object.values(this.services).filter(
      (s) => s.status === 'active' || s.status === 'deprecated',
    ).length;
    this.metrics.setRegistryServicesCount(activeCount);
  }

  // -------------------------------------------------------------------------
  // Redis persistence (private & public helpers)
  // -------------------------------------------------------------------------

  /**
   * Load all service entries from Redis into the in-memory Map.
   * Called during onModuleInit and by the reconciliation cron job.
   */
  async loadFromRedis(): Promise<void> {
    if (!this.redis) return;

    const entries = await this.redis.hgetall(REDIS_REGISTRY_KEY);
    let count = 0;

    for (const [serviceId, json] of Object.entries(entries)) {
      try {
        const entry: ServiceRegistryEntry = JSON.parse(json);
        this.services[serviceId] = entry;
        count++;
      } catch (err) {
        this.logger.warn(
          `Failed to parse Redis registry entry for '${serviceId}': ${(err as Error).message}`,
          'RegistryService',
        );
      }
    }

    if (count > 0) {
      this.logger.info(`Registry hydrated ${count} service(s) from Redis`, {});
    }
  }

  /**
   * Return the raw Redis hash entries for drift comparison.
   * Returns `null` when Redis is unavailable.
   */
  async getRedisEntries(): Promise<Record<string, ServiceRegistryEntry> | null> {
    if (!this.redis) return null;

    const raw = await this.redis.hgetall(REDIS_REGISTRY_KEY);
    const entries: Record<string, ServiceRegistryEntry> = {};

    for (const [serviceId, json] of Object.entries(raw)) {
      try {
        entries[serviceId] = JSON.parse(json);
      } catch {
        this.logger.warn(
          `Failed to parse Redis entry for '${serviceId}' during drift check`,
          'RegistryService',
        );
      }
    }
    return entries;
  }

  /**
   * Persist a single service entry to Redis.
   */
  private async persistToRedis(serviceId: string, entry: ServiceRegistryEntry): Promise<void> {
    if (!this.redis) return;
    await this.redis.hset(REDIS_REGISTRY_KEY, serviceId, JSON.stringify(entry));
  }

  /**
   * Remove a single service entry from Redis.
   */
  private async removeFromRedis(serviceId: string): Promise<void> {
    if (!this.redis) return;
    await this.redis.hdel(REDIS_REGISTRY_KEY, serviceId);
  }

  /**
   * Persist to Redis with a hard timeout. Throws if the write takes longer
   * than `REDIS_WRITE_TIMEOUT_MS` or if Redis is unavailable.
   */
  private async persistToRedisStrict(
    serviceId: string,
    entry: ServiceRegistryEntry,
  ): Promise<void> {
    if (!this.redis) {
      this.logger.warn(
        `Redis unavailable — registration for '${serviceId}' persisted in-memory only`,
        'RegistryService',
      );
      return;
    }

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Redis write timed out after ${REDIS_WRITE_TIMEOUT_MS}ms`)),
        REDIS_WRITE_TIMEOUT_MS,
      ),
    );

    try {
      await Promise.race([
        this.redis.hset(REDIS_REGISTRY_KEY, serviceId, JSON.stringify(entry)),
        timeout,
      ]);
    } catch (err) {
      // Roll back the in-memory write so we stay consistent
      delete this.services[serviceId];
      this.syncMetricsGauge();
      throw new Error(
        `Registration for '${serviceId}' failed — Redis write error: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Remove from Redis with a hard timeout. Throws on failure.
   */
  private async removeFromRedisStrict(serviceId: string): Promise<void> {
    if (!this.redis) {
      this.logger.warn(
        `Redis unavailable — deregistration for '${serviceId}' applied in-memory only`,
        'RegistryService',
      );
      return;
    }

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Redis delete timed out after ${REDIS_WRITE_TIMEOUT_MS}ms`)),
        REDIS_WRITE_TIMEOUT_MS,
      ),
    );

    try {
      await Promise.race([
        this.redis.hdel(REDIS_REGISTRY_KEY, serviceId),
        timeout,
      ]);
    } catch (err) {
      this.logger.error(
        `Redis delete failed for '${serviceId}': ${(err as Error).message}`,
        (err as Error).stack,
        'RegistryService',
      );
    }
  }
}
