// =============================================================================
// src/shared/proxy-handler.ts — Reusable proxy utility
// =============================================================================
// Extracted from TribesController so both /tribes/* and /shared/* controllers
// can compose the same proxy creation, lifecycle gating, scope checking, and
// metrics recording without code duplication.
//
// RESILIENCE:
//  - Per-service CircuitBreaker: rejects requests fast when upstreams fail.
//  - Hard proxyTimeout (30 s): prevents slow upstreams from exhausting connections.
//  - Cache invalidation: stale proxy instances are dropped on re-registration.
// =============================================================================

import { Response } from 'express';
import { createProxyMiddleware, Options } from 'http-proxy-middleware';
import { RegistryService } from '../registry/registry.service';
import { AuthService } from '../auth/auth.service';
import { LoggerService } from '../shared/logger.service';
import { MetricsService } from '../metrics/metrics.service';
import { CircuitBreaker } from '../shared/circuit-breaker';
import {
  ForbiddenError,
  NotFoundError,
  BadGatewayError,
  ServiceUnavailableError,
} from '../shared/errors';
import { AuthenticatedRequest, ServiceType } from '../types';

/** Default hard timeout for outgoing proxy requests (ms). */
const PROXY_TIMEOUT_MS = 30_000;

/** HTTP status codes that indicate upstream failure for circuit-breaker tracking. */
const UPSTREAM_FAILURE_CODES = new Set([502, 503, 504]);

/** HTTP 410 Gone — service has been retired */
export class GoneError extends NotFoundError {
  constructor(message: string) {
    super(message);
    Object.defineProperty(this, 'status', { value: 410 });
  }
}

export interface ProxyHandlerDeps {
  registry: RegistryService;
  /** Provider-agnostic auth service (replaces DescopeService) */
  auth: AuthService;
  logger: LoggerService;
  metrics: MetricsService;
}

export interface ProxyOptions {
  /** Route namespace for this proxy — 'shared' or 'tribe' */
  namespace: ServiceType;
  /** The URL prefix to strip, e.g. '/api/v1/tribes' or '/api/v1/shared' */
  pathPrefix: string;
  /** Outgoing proxy timeout in ms (default: 30 000) */
  proxyTimeoutMs?: number;
}

/**
 * Reusable proxy handler that both TribesController and SharedServicesController
 * compose for dynamic upstream proxying with lifecycle gating, scope checks,
 * per-service circuit breakers, and cache invalidation.
 */
export class ProxyHandler {
  private readonly proxyCache = new Map<string, ReturnType<typeof createProxyMiddleware>>();
  private readonly circuitBreakers = new Map<string, CircuitBreaker>();
  private readonly proxyTimeoutMs: number;
  private readonly unsubscribeCacheInvalidation: () => void;

  constructor(
    private readonly deps: ProxyHandlerDeps,
    private readonly opts: ProxyOptions,
  ) {
    this.proxyTimeoutMs = opts.proxyTimeoutMs ?? PROXY_TIMEOUT_MS;

    // Subscribe to registry re-registration events so stale proxy instances
    // are dropped automatically when a service's baseUrl changes.
    this.unsubscribeCacheInvalidation = deps.registry.onCacheInvalidation(
      (serviceId) => this.invalidateProxyCache(serviceId),
    );
  }

  /** Clear the entire proxy cache and circuit breakers (call from onModuleDestroy). */
  destroy(): void {
    this.unsubscribeCacheInvalidation();
    this.proxyCache.clear();
    this.circuitBreakers.clear();
  }

  /**
   * Remove the cached proxy middleware for a specific service so the next
   * request creates a fresh instance pointing at the latest baseUrl.
   */
  invalidateProxyCache(serviceId: string): void {
    const existed = this.proxyCache.delete(serviceId);
    if (existed) {
      this.deps.logger.info(`Proxy cache invalidated for '${serviceId}'`, {
        serviceId,
        namespace: this.opts.namespace,
      });
    }
  }

  /**
   * List services visible to a caller, filtered by this handler's namespace.
   */
  listServices(tribeId: string | undefined) {
    const services = this.deps.registry.getByType(this.opts.namespace);

    return services
      .filter((svc) => svc.status !== 'retired')
      .map((svc) => ({
        serviceId: svc.serviceId,
        name: svc.name,
        status: svc.status,
        version: svc.version,
        exposes: svc.exposes,
        serviceType: svc.serviceType ?? 'tribe',
        canAccess: tribeId
          ? this.deps.registry.canConsume(tribeId, svc.serviceId)
          : false,
        ...(svc.status === 'deprecated' && {
          deprecated: true,
          sunsetDate: svc.sunsetDate,
          replacementService: svc.replacementService,
        }),
      }));
  }

  /**
   * Proxy a request to a registered upstream service.
   * Validates namespace, lifecycle status, scope constraints, then forwards.
   */
  async proxyRequest(
    targetServiceId: string,
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> {
    const tribeId = req.tribeId!;
    const correlationId = req.correlationId;

    // ── 1. Resolve upstream ────────────────────────────────────────────────
    const upstream = this.deps.registry.resolveUpstream(targetServiceId, '');
    if (!upstream) {
      throw new NotFoundError(
        `Service '${targetServiceId}' not found or inactive`,
      );
    }

    // ── 1b. Validate namespace ─────────────────────────────────────────────
    const targetEntry = this.deps.registry.get(targetServiceId);
    const targetType = targetEntry?.serviceType ?? 'tribe';
    if (targetType !== this.opts.namespace) {
      const correctPrefix = targetType === 'shared' ? '/shared/' : '/tribes/';
      throw new NotFoundError(
        `Service '${targetServiceId}' is a ${targetType} service. Use ${correctPrefix}${targetServiceId} instead.`,
      );
    }

    // ── 1c. Lifecycle gate ─────────────────────────────────────────────────
    this.enforceLifecycleGate(targetEntry, targetServiceId, res);

    // ── 2. Scope check ─────────────────────────────────────────────────────
    if (!this.deps.registry.canConsume(tribeId, targetServiceId)) {
      throw new ForbiddenError(
        `Tribe '${tribeId}' is not authorised to consume '${targetServiceId}'`,
      );
    }

    const requiredScopes = this.deps.registry.getRequiredScopes(targetServiceId);
    if (requiredScopes.length > 0 && req.user) {
      const missingScopes = this.deps.auth.checkScopes(req, requiredScopes);
      if (missingScopes.length > 0) {
        throw new ForbiddenError(
          `Insufficient scopes for '${targetServiceId}'. Missing: ${missingScopes.join(', ')}`,
        );
      }
    }

    // ── 3. Circuit-breaker gate ────────────────────────────────────────────
    const breaker = this.getOrCreateCircuitBreaker(targetServiceId);
    if (!breaker.tryAcquire()) {
      this.deps.logger.warn(
        `Circuit breaker OPEN for '${targetServiceId}' — rejecting request`,
        'ProxyHandler',
      );
      throw new ServiceUnavailableError(
        `Upstream '${targetServiceId}' is temporarily unavailable (circuit breaker open)`,
      );
    }

    // ── 4. Get or create proxy ─────────────────────────────────────────────
    let proxy = this.proxyCache.get(targetServiceId);

    if (!proxy) {
      const proxyOpts: Options = {
        target: upstream,
        changeOrigin: true,
        proxyTimeout: this.proxyTimeoutMs,
        timeout: this.proxyTimeoutMs,
        pathRewrite: {
          [`^${this.opts.pathPrefix}/${targetServiceId}`]: '',
        },
        on: {
          proxyReq: (proxyReq, _req) => {
            const authReq = _req as unknown as AuthenticatedRequest;
            proxyReq.setHeader('X-Tribe-Id', authReq.tribeId || '');
            proxyReq.setHeader('X-Correlation-ID', authReq.correlationId || '');
            proxyReq.setHeader('X-Forwarded-By', 'apicenter-gateway');
          },
          proxyRes: (proxyRes) => {
            const status = proxyRes.statusCode ?? 0;
            const cb = this.circuitBreakers.get(targetServiceId);
            if (cb) {
              if (UPSTREAM_FAILURE_CODES.has(status)) {
                cb.recordFailure();
                this.deps.logger.warn(
                  `Upstream '${targetServiceId}' returned ${status} — circuit-breaker failure recorded`,
                  'ProxyHandler',
                );
              } else {
                cb.recordSuccess();
              }
            }
          },
          error: (err) => {
            // Record every proxy-level error (timeouts, ECONNREFUSED, etc.)
            const cb = this.circuitBreakers.get(targetServiceId);
            if (cb) cb.recordFailure();
            this.deps.logger.error(
              `Proxy error for ${targetServiceId}: ${err.message}`,
            );
          },
        },
        logger: {
          info: (msg: string) => this.deps.logger.debug(msg),
          warn: (msg: string) => this.deps.logger.warn(msg),
          error: (msg: string) => this.deps.logger.error(msg),
        },
      };

      proxy = createProxyMiddleware(proxyOpts);
      this.proxyCache.set(targetServiceId, proxy);

      this.deps.logger.info('Created proxy instance', {
        targetServiceId,
        upstream,
        namespace: this.opts.namespace,
        proxyTimeoutMs: this.proxyTimeoutMs,
        correlationId,
      });
    }

    // ── 5. Forward the request ─────────────────────────────────────────────
    const proxyStart = Date.now();

    res.on('finish', () => {
      const durationSec = (Date.now() - proxyStart) / 1000;
      this.deps.metrics.recordProxyRequest(
        this.opts.namespace,
        tribeId,
        targetServiceId,
        req.method,
        res.statusCode,
        durationSec,
      );
    });

    try {
      (proxy as any)(req, res, (err?: Error) => {
        if (err) {
          this.deps.logger.error(
            `Proxy callback error [${targetServiceId}]: ${err.message}`,
          );
          throw new BadGatewayError(
            `Upstream '${targetServiceId}' unreachable`,
          );
        }
      });
    } catch (error: any) {
      this.deps.logger.error(
        `Proxy throw error [${targetServiceId}]: ${error.message}`,
      );
      throw new BadGatewayError(`Upstream '${targetServiceId}' unreachable`);
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Return the existing circuit breaker for a service, or create a new one. */
  private getOrCreateCircuitBreaker(serviceId: string): CircuitBreaker {
    let breaker = this.circuitBreakers.get(serviceId);
    if (!breaker) {
      breaker = new CircuitBreaker(`proxy:${serviceId}`, this.deps.logger, {
        failureThreshold: 5,
        resetTimeoutMs: 30_000,
        successThreshold: 2,
      });
      this.circuitBreakers.set(serviceId, breaker);
    }
    return breaker;
  }

  /** Reject retired services (410) and set RFC 8594 deprecation headers. */
  private enforceLifecycleGate(
    entry: {
      status?: string;
      sunsetDate?: string;
      replacementService?: string;
    } | null | undefined,
    serviceId: string,
    res: Response,
  ): void {
    if (entry?.status === 'retired') {
      throw new GoneError(
        `Service '${serviceId}' has been retired` +
          (entry.replacementService
            ? `. Migrate to '${entry.replacementService}'`
            : ''),
      );
    }
    if (entry?.status === 'deprecated') {
      res.setHeader('Deprecation', 'true');
      if (entry.sunsetDate) {
        res.setHeader('Sunset', new Date(entry.sunsetDate).toUTCString());
      }
      if (entry.replacementService) {
        const nsPrefix = this.opts.namespace === 'shared' ? 'shared' : 'tribes';
        res.setHeader(
          'Link',
          `</api/v1/${nsPrefix}/${entry.replacementService}>; rel="successor-version"`,
        );
      }
    }
  }
}
