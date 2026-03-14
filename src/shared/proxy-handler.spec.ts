// =============================================================================
// Unit tests — ProxyHandler
// =============================================================================
// Covers proxy creation/caching, cache invalidation, circuit-breaker gating,
// lifecycle enforcement (deprecated headers, retired rejection), and scope
// checking.
// =============================================================================

import { ProxyHandler, ProxyHandlerDeps, ProxyOptions, GoneError } from './proxy-handler';
import { RegistryService } from '../registry/registry.service';
import { AuthService } from '../auth/auth.service';
import { LoggerService } from '../shared/logger.service';
import { MetricsService } from '../metrics/metrics.service';
import {
  NotFoundError,
  ForbiddenError,
  ServiceUnavailableError,
} from './errors';
import { AuthenticatedRequest } from '../types';

// ---- Mock http-proxy-middleware ----
const mockProxyMiddleware = jest.fn((_req: any, _res: any, _next: any) => {});
jest.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: jest.fn(() => mockProxyMiddleware),
}));
import { createProxyMiddleware } from 'http-proxy-middleware';

// ---- Mock factory helpers ----

function createMockDeps(): ProxyHandlerDeps {
  return {
    registry: {
      resolveUpstream: jest.fn(),
      get: jest.fn(),
      getByType: jest.fn().mockReturnValue([]),
      canConsume: jest.fn().mockReturnValue(true),
      getRequiredScopes: jest.fn().mockReturnValue([]),
      validateSecret: jest.fn(),
      onCacheInvalidation: jest.fn().mockReturnValue(() => {}),
    } as unknown as RegistryService,
    // Use AuthService mock (provider-agnostic, replaces DescopeService)
    auth: {
      checkScopes: jest.fn().mockReturnValue([]),
    } as unknown as AuthService,
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      log: jest.fn(),
    } as unknown as LoggerService,
    metrics: {
      recordProxyRequest: jest.fn(),
    } as unknown as MetricsService,
  };
}

const defaultOpts: ProxyOptions = {
  namespace: 'tribe',
  pathPrefix: '/api/v1/tribes',
};

function fakeReq(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    tribeId: 'svc-alpha',
    correlationId: 'corr-1',
    method: 'GET',
    user: { token: { tribeId: 'svc-alpha', permissions: [], scopes: [] } },
    ...overrides,
  } as unknown as AuthenticatedRequest;
}

function fakeRes() {
  return {
    statusCode: 200,
    setHeader: jest.fn(),
    on: jest.fn(),
  } as any;
}

// =============================================================================
// Tests
// =============================================================================

describe('ProxyHandler', () => {
  let deps: ProxyHandlerDeps;
  let handler: ProxyHandler;

  beforeEach(() => {
    jest.clearAllMocks();
    deps = createMockDeps();
    handler = new ProxyHandler(deps, defaultOpts);
  });

  afterEach(() => {
    handler.destroy();
  });

  // =========================================================================
  // Proxy creation & caching
  // =========================================================================
  describe('proxy creation and caching', () => {
    beforeEach(() => {
      (deps.registry.resolveUpstream as jest.Mock).mockReturnValue('http://localhost:3001');
      (deps.registry.get as jest.Mock).mockReturnValue({
        serviceId: 'user-svc',
        serviceType: 'tribe',
        status: 'active',
        requiredScopes: [],
        consumes: [],
      });
    });

    it('creates a proxy middleware on first request to a service', async () => {
      const req = fakeReq();
      const res = fakeRes();

      await handler.proxyRequest('user-svc', req, res);

      expect(createProxyMiddleware).toHaveBeenCalledTimes(1);
      expect(mockProxyMiddleware).toHaveBeenCalledWith(req, res, expect.any(Function));
    });

    it('reuses the cached proxy on subsequent requests', async () => {
      const req = fakeReq();
      const res = fakeRes();

      await handler.proxyRequest('user-svc', req, res);
      await handler.proxyRequest('user-svc', req, fakeRes());

      // createProxyMiddleware should only be called once (cached)
      expect(createProxyMiddleware).toHaveBeenCalledTimes(1);
      // but the actual proxy function is invoked twice
      expect(mockProxyMiddleware).toHaveBeenCalledTimes(2);
    });

    it('creates separate proxy instances per service', async () => {
      (deps.registry.resolveUpstream as jest.Mock)
        .mockReturnValueOnce('http://localhost:3001')
        .mockReturnValueOnce('http://localhost:3002');
      (deps.registry.get as jest.Mock).mockReturnValue({
        serviceId: 'other-svc',
        serviceType: 'tribe',
        status: 'active',
        requiredScopes: [],
        consumes: [],
      });

      await handler.proxyRequest('user-svc', fakeReq(), fakeRes());
      await handler.proxyRequest('other-svc', fakeReq(), fakeRes());

      expect(createProxyMiddleware).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // Cache invalidation
  // =========================================================================
  describe('invalidateProxyCache()', () => {
    beforeEach(() => {
      (deps.registry.resolveUpstream as jest.Mock).mockReturnValue('http://localhost:3001');
      (deps.registry.get as jest.Mock).mockReturnValue({
        serviceId: 'user-svc',
        serviceType: 'tribe',
        status: 'active',
        requiredScopes: [],
        consumes: [],
      });
    });

    it('drops cached instance so a new one is created on next request', async () => {
      await handler.proxyRequest('user-svc', fakeReq(), fakeRes());
      expect(createProxyMiddleware).toHaveBeenCalledTimes(1);

      handler.invalidateProxyCache('user-svc');

      await handler.proxyRequest('user-svc', fakeReq(), fakeRes());
      // Should have created a *new* proxy after invalidation
      expect(createProxyMiddleware).toHaveBeenCalledTimes(2);
    });

    it('logs when an existing proxy is invalidated', () => {
      // Manually populate cache
      (handler as any).proxyCache.set('user-svc', jest.fn());

      handler.invalidateProxyCache('user-svc');

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('invalidated'),
        expect.objectContaining({ serviceId: 'user-svc' }),
      );
    });

    it('does nothing for an uncached service', () => {
      handler.invalidateProxyCache('nonexistent-svc');

      // No log about invalidation (only logs when existed=true)
      expect(deps.logger.info).not.toHaveBeenCalledWith(
        expect.stringContaining('invalidated'),
        expect.anything(),
      );
    });
  });

  // =========================================================================
  // Registry subscription for auto-invalidation
  // =========================================================================
  describe('auto-invalidation via registry events', () => {
    it('subscribes to registry onCacheInvalidation on construction', () => {
      expect(deps.registry.onCacheInvalidation).toHaveBeenCalledTimes(1);
      expect(deps.registry.onCacheInvalidation).toHaveBeenCalledWith(expect.any(Function));
    });

    it('calls invalidateProxyCache when registry fires re-registration', () => {
      // Capture the callback passed to onCacheInvalidation
      const callback = (deps.registry.onCacheInvalidation as jest.Mock).mock.calls[0][0];
      (handler as any).proxyCache.set('payment-svc', jest.fn());

      callback('payment-svc');

      expect((handler as any).proxyCache.has('payment-svc')).toBe(false);
    });
  });

  // =========================================================================
  // Circuit breaker gating
  // =========================================================================
  describe('circuit breaker', () => {
    beforeEach(() => {
      (deps.registry.resolveUpstream as jest.Mock).mockReturnValue('http://localhost:3001');
      (deps.registry.get as jest.Mock).mockReturnValue({
        serviceId: 'user-svc',
        serviceType: 'tribe',
        status: 'active',
        requiredScopes: [],
        consumes: [],
      });
    });

    it('rejects with ServiceUnavailableError when circuit breaker is OPEN', async () => {
      // First, make a successful request so the breaker is created
      await handler.proxyRequest('user-svc', fakeReq(), fakeRes());

      // Force the circuit breaker into OPEN state
      const breaker = (handler as any).circuitBreakers.get('user-svc');
      // Trip the breaker by recording enough failures
      for (let i = 0; i < 5; i++) {
        breaker.recordFailure();
      }

      await expect(
        handler.proxyRequest('user-svc', fakeReq(), fakeRes()),
      ).rejects.toThrow(ServiceUnavailableError);
    });

    it('allows requests through when circuit breaker is CLOSED', async () => {
      await handler.proxyRequest('user-svc', fakeReq(), fakeRes());

      expect(mockProxyMiddleware).toHaveBeenCalledTimes(1);
    });

    it('creates a circuit breaker per service', async () => {
      (deps.registry.get as jest.Mock).mockImplementation((id: string) => ({
        serviceId: id,
        serviceType: 'tribe',
        status: 'active',
        requiredScopes: [],
        consumes: [],
      }));
      (deps.registry.resolveUpstream as jest.Mock).mockReturnValue('http://localhost:3001');

      await handler.proxyRequest('svc-a', fakeReq(), fakeRes());
      await handler.proxyRequest('svc-b', fakeReq(), fakeRes());

      const breakers = (handler as any).circuitBreakers;
      expect(breakers.has('svc-a')).toBe(true);
      expect(breakers.has('svc-b')).toBe(true);
    });
  });

  // =========================================================================
  // Lifecycle gate — retired and deprecated services
  // =========================================================================
  describe('lifecycle gate', () => {
    it('throws GoneError (410) for retired service', async () => {
      (deps.registry.resolveUpstream as jest.Mock).mockReturnValue('http://localhost:3001');
      (deps.registry.get as jest.Mock).mockReturnValue({
        serviceId: 'old-svc',
        serviceType: 'tribe',
        status: 'retired',
        replacementService: 'new-svc',
      });

      await expect(
        handler.proxyRequest('old-svc', fakeReq(), fakeRes()),
      ).rejects.toThrow(GoneError);
    });

    it('sets Deprecation and Sunset headers for deprecated service', async () => {
      (deps.registry.resolveUpstream as jest.Mock).mockReturnValue('http://localhost:3001');
      (deps.registry.get as jest.Mock).mockReturnValue({
        serviceId: 'dep-svc',
        serviceType: 'tribe',
        status: 'deprecated',
        sunsetDate: '2025-12-31',
        replacementService: 'new-svc',
        requiredScopes: [],
        consumes: [],
      });

      const res = fakeRes();
      await handler.proxyRequest('dep-svc', fakeReq(), res);

      expect(res.setHeader).toHaveBeenCalledWith('Deprecation', 'true');
      expect(res.setHeader).toHaveBeenCalledWith(
        'Sunset',
        new Date('2025-12-31').toUTCString(),
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        'Link',
        expect.stringContaining('new-svc'),
      );
    });
  });

  // =========================================================================
  // Scope / access checks
  // =========================================================================
  describe('scope and access checks', () => {
    beforeEach(() => {
      (deps.registry.resolveUpstream as jest.Mock).mockReturnValue('http://localhost:3001');
      (deps.registry.get as jest.Mock).mockReturnValue({
        serviceId: 'locked-svc',
        serviceType: 'tribe',
        status: 'active',
        requiredScopes: ['admin'],
        consumes: [],
      });
    });

    it('throws NotFoundError when service is not in the registry', async () => {
      (deps.registry.resolveUpstream as jest.Mock).mockReturnValue(null);

      await expect(
        handler.proxyRequest('ghost-svc', fakeReq(), fakeRes()),
      ).rejects.toThrow(NotFoundError);
    });

    it('throws ForbiddenError when tribe cannot consume target service', async () => {
      (deps.registry.canConsume as jest.Mock).mockReturnValue(false);

      await expect(
        handler.proxyRequest('locked-svc', fakeReq(), fakeRes()),
      ).rejects.toThrow(ForbiddenError);
    });

    it('throws ForbiddenError when caller lacks required scopes', async () => {
      (deps.registry.getRequiredScopes as jest.Mock).mockReturnValue(['admin']);
      (deps.auth.checkScopes as jest.Mock).mockReturnValue(['admin']);

      await expect(
        handler.proxyRequest('locked-svc', fakeReq(), fakeRes()),
      ).rejects.toThrow(ForbiddenError);
    });

    it('allows request when caller has all required scopes', async () => {
      (deps.registry.getRequiredScopes as jest.Mock).mockReturnValue(['read']);
      (deps.auth.checkScopes as jest.Mock).mockReturnValue([]); // no missing scopes

      await handler.proxyRequest('locked-svc', fakeReq(), fakeRes());

      expect(mockProxyMiddleware).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Namespace validation
  // =========================================================================
  describe('namespace validation', () => {
    it('throws NotFoundError when service type does not match handler namespace', async () => {
      (deps.registry.resolveUpstream as jest.Mock).mockReturnValue('http://localhost:3001');
      (deps.registry.get as jest.Mock).mockReturnValue({
        serviceId: 'email-svc',
        serviceType: 'shared', // handler uses 'tribe' namespace
        status: 'active',
        requiredScopes: [],
      });

      await expect(
        handler.proxyRequest('email-svc', fakeReq(), fakeRes()),
      ).rejects.toThrow(NotFoundError);
    });
  });

  // =========================================================================
  // listServices()
  // =========================================================================
  describe('listServices()', () => {
    it('filters out retired services', () => {
      (deps.registry.getByType as jest.Mock).mockReturnValue([
        { serviceId: 'active-svc', name: 'Active', status: 'active', version: '1.0', exposes: [], serviceType: 'tribe' },
        { serviceId: 'retired-svc', name: 'Retired', status: 'retired', version: '0.1', exposes: [], serviceType: 'tribe' },
      ]);
      (deps.registry.canConsume as jest.Mock).mockReturnValue(true);

      const result = handler.listServices('svc-alpha');

      expect(result).toHaveLength(1);
      expect(result[0].serviceId).toBe('active-svc');
    });

    it('includes deprecation info for deprecated services', () => {
      (deps.registry.getByType as jest.Mock).mockReturnValue([
        {
          serviceId: 'dep-svc',
          name: 'Deprecated',
          status: 'deprecated',
          version: '1.0',
          exposes: [],
          serviceType: 'tribe',
          sunsetDate: '2025-12-31',
          replacementService: 'new-svc',
        },
      ]);
      (deps.registry.canConsume as jest.Mock).mockReturnValue(true);

      const result = handler.listServices('svc-alpha');

      expect(result[0].deprecated).toBe(true);
      expect(result[0].sunsetDate).toBe('2025-12-31');
      expect(result[0].replacementService).toBe('new-svc');
    });
  });

  // =========================================================================
  // destroy()
  // =========================================================================
  describe('destroy()', () => {
    it('clears proxy cache and circuit breakers', async () => {
      (deps.registry.resolveUpstream as jest.Mock).mockReturnValue('http://localhost:3001');
      (deps.registry.get as jest.Mock).mockReturnValue({
        serviceId: 'user-svc',
        serviceType: 'tribe',
        status: 'active',
        requiredScopes: [],
      });

      await handler.proxyRequest('user-svc', fakeReq(), fakeRes());

      expect((handler as any).proxyCache.size).toBe(1);
      expect((handler as any).circuitBreakers.size).toBe(1);

      handler.destroy();

      expect((handler as any).proxyCache.size).toBe(0);
      expect((handler as any).circuitBreakers.size).toBe(0);
    });
  });
});
