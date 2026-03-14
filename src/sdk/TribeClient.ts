// =============================================================================
// src/sdk/TribeClient.ts — APICenter Shared SDK  (checklist §5, §6, §7)
// =============================================================================
//
// PURPOSE (checklist §5 — SDK foundation):
//   TribeClient is the ONE standard way for any tribe (or external consumer)
//   to interact with the APICenter gateway.  Tribes MUST use this client —
//   building custom HTTP calls to the gateway directly is not allowed.
//
// PUBLISHING (checklist §5 — versioned, centrally maintained):
//   Package name : @apicenter/sdk
//   Version      : driven by package.json "version" field
//   Install      : npm install @apicenter/sdk
//                  (from the internal npm registry — see .npmrc)
//
// USAGE (checklist §7 — standardized tribe onboarding):
//
//   import { TribeClient } from '@apicenter/sdk';
//
//   const client = new TribeClient({
//     gatewayUrl: process.env.APICENTER_URL,   // e.g. http://apicenter:3000
//     tribeId:    'payment-service',
//     secret:     process.env.PAYMENT_SECRET,
//   });
//
//   // Authenticate once — client auto-refreshes before expiry
//   await client.authenticate();
//
//   // Call a tribe service (checklist §7 — all tribe calls go through SDK)
//   const users = await client.callService('user-service', '/users/123');
//
//   // Call a shared platform service
//   const receipt = await client.callSharedService('email-service', '/send',
//     { method: 'POST', data: { to: 'x@y.com', template: 'welcome' } });
//
//   // Call an external API (keys live in APICenter, not in your service)
//   const geo = await client.callExternal('geolocation', '/lookup?ip=1.2.3.4');
//
// WHAT THE SDK STANDARDIZES (checklist §6 — SDK purpose and role):
//   • Authentication      — M2M token issuance + silent refresh
//   • Request format      — consistent headers (Authorization, X-Tribe-Id, X-Correlation-ID)
//   • Response handling   — unwraps the { success, data, meta } envelope
//   • Error handling      — typed error classes, no raw Axios errors leaked
//   • Retries             — exponential backoff for transient 5xx / network failures
//   • Token revocation    — explicit revoke() method for session cleanup
//
// EXTERNAL CONSUMERS (checklist §5):
//   This SDK can be used by non-tribe consumers (partner integrations, etc.)
//   by providing their own tribeId + secret registered in the gateway registry.
//
// GATEWAY URL:
//   Development:  http://localhost:3000   (NGINX port)
//   Production:   https://api.yourplatform.com  (NGINX behind TLS termination)
//
// CORS NOTE:
//   Browser consumers should set { withCredentials: true } (default here).
//   The gateway responds with Access-Control-Allow-Credentials: true and
//   the requesting origin in Access-Control-Allow-Origin.
// =============================================================================

import axios, {
  AxiosInstance,
  AxiosRequestConfig,
  AxiosError,
  isAxiosError,
} from 'axios';

// =============================================================================
// Typed error hierarchy  (checklist §6 — standardized error handling)
// =============================================================================

/** Base error for all SDK-thrown exceptions. Always prefer catching this. */
export class TribeClientError extends Error {
  public readonly statusCode?: number;
  /** Machine-readable error code — safe for programmatic branching. */
  public readonly code: string;

  constructor(message: string, code: string, statusCode?: number) {
    super(message);
    this.name = 'TribeClientError';
    this.code = code;
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 401 — token missing, expired, or invalid. */
export class AuthenticationError extends TribeClientError {
  constructor(message = 'Authentication failed — check your tribeId and secret') {
    super(message, 'AUTHENTICATION_ERROR', 401);
    this.name = 'AuthenticationError';
  }
}

/** 403 — authenticated but missing required scopes / permissions. */
export class AuthorizationError extends TribeClientError {
  constructor(message = 'Forbidden — insufficient scopes for this operation') {
    super(message, 'AUTHORIZATION_ERROR', 403);
    this.name = 'AuthorizationError';
  }
}

/** 404 — target service or resource not found in the gateway registry. */
export class ServiceNotFoundError extends TribeClientError {
  constructor(serviceId?: string) {
    super(
      serviceId
        ? `Service '${serviceId}' not found in the gateway registry. Is it registered?`
        : 'Resource not found',
      'SERVICE_NOT_FOUND',
      404,
    );
    this.name = 'ServiceNotFoundError';
  }
}

/** 429 — rate limit exceeded. Check retryAfterMs before retrying. */
export class RateLimitError extends TribeClientError {
  public readonly retryAfterMs?: number;
  constructor(retryAfterMs?: number) {
    super('Rate limit exceeded. Slow down and retry.', 'RATE_LIMIT_EXCEEDED', 429);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** 504 / timeout — the gateway or upstream service took too long. */
export class GatewayTimeoutError extends TribeClientError {
  constructor(message = 'Gateway or upstream service timed out') {
    super(message, 'GATEWAY_TIMEOUT', 504);
    this.name = 'GatewayTimeoutError';
  }
}

/** 502 — upstream service is unreachable or returned a bad response. */
export class BadGatewayError extends TribeClientError {
  constructor(message = 'Upstream service unreachable') {
    super(message, 'BAD_GATEWAY', 502);
    this.name = 'BadGatewayError';
  }
}

/** 503 — service temporarily unavailable (circuit breaker open, gateway restarting). */
export class ServiceUnavailableError extends TribeClientError {
  constructor(message = 'Service temporarily unavailable — retry shortly') {
    super(message, 'SERVICE_UNAVAILABLE', 503);
    this.name = 'ServiceUnavailableError';
  }
}

/** Network failure — DNS, ECONNREFUSED, socket hang-up, no HTTP response. */
export class NetworkError extends TribeClientError {
  constructor(message = 'Network error — could not reach the APICenter gateway') {
    super(message, 'NETWORK_ERROR');
    this.name = 'NetworkError';
  }
}

// =============================================================================
// Retry internals
// =============================================================================

const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const RETRYABLE_CODES    = new Set([
  'ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'ERR_NETWORK',
]);

function isRetryable(err: AxiosError): boolean {
  if (err.response && RETRYABLE_STATUSES.has(err.response.status)) return true;
  if (err.code     && RETRYABLE_CODES.has(err.code))                return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function wrapAxiosError(err: AxiosError): TribeClientError {
  const status = err.response?.status;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body   = err.response?.data as any;
  const detail = body?.error?.message ?? body?.message ?? err.message;

  if (!err.response) {
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') return new GatewayTimeoutError(detail);
    return new NetworkError(detail);
  }

  switch (status) {
    case 401:  return new AuthenticationError(detail);
    case 403:  return new AuthorizationError(detail);
    case 404:  return new ServiceNotFoundError();
    case 429: {
      const ra = Number(err.response.headers?.['retry-after']) || undefined;
      return new RateLimitError(ra ? ra * 1000 : undefined);
    }
    case 502:  return new BadGatewayError(detail);
    case 503:  return new ServiceUnavailableError(detail);
    case 504:  return new GatewayTimeoutError(detail);
    default:   return new TribeClientError(detail, 'GATEWAY_ERROR', status);
  }
}

// =============================================================================
// SDK options
// =============================================================================

export interface TribeClientOptions {
  /**
   * Base URL of the APICenter gateway.
   * Always point to the NGINX load-balancer address, NOT a specific container.
   * Dev:  http://localhost:3000
   * Prod: https://api.yourplatform.com
   */
  gatewayUrl: string;

  /** Your tribe's registered serviceId (e.g. 'payment-service'). */
  tribeId: string;

  /** The shared M2M secret provisioned when your service was registered. */
  secret: string;

  /** Request timeout in ms (default: 30 000). */
  timeout?: number;

  /** Max retry attempts for transient failures (default: 3). */
  maxRetries?: number;

  /** Initial backoff delay in ms — doubles each attempt with ±25% jitter (default: 500). */
  retryBaseDelayMs?: number;

  /**
   * Optional correlation ID factory.
   * When provided, the returned value is sent as X-Correlation-ID on every request.
   * This lets you thread a single trace ID across multiple SDK calls in one
   * business operation (e.g. request-scoped UUID from your own middleware).
   */
  correlationIdFactory?: () => string;
}

// =============================================================================
// TribeClient  (checklist §5, §6, §7)
// =============================================================================

export class TribeClient {
  /** Package version — baked in at publish time. */
  static readonly SDK_VERSION = '1.0.0';

  private readonly http:             AxiosInstance;
  private readonly tribeId:          string;
  private readonly secret:           string;
  private readonly maxRetries:       number;
  private readonly retryBaseDelayMs: number;
  private readonly correlationIdFactory?: () => string;

  private accessToken:  string | null = null;
  private refreshToken: string | null = null;
  private tokenExpiry:  number        = 0;   // ms epoch

  constructor(opts: TribeClientOptions) {
    this.tribeId              = opts.tribeId;
    this.secret               = opts.secret;
    this.maxRetries           = opts.maxRetries       ?? 3;
    this.retryBaseDelayMs     = opts.retryBaseDelayMs ?? 500;
    this.correlationIdFactory = opts.correlationIdFactory;

    this.http = axios.create({
      baseURL: opts.gatewayUrl,
      timeout: opts.timeout ?? 30_000,
      headers: {
        'Content-Type':    'application/json',
        'X-SDK-Version':   TribeClient.SDK_VERSION,
        'X-SDK-Tribe-Id':  opts.tribeId,
      },
      // Needed for browser CORS requests with Authorization header
      withCredentials: true,
    });
  }

  // ── Authentication (checklist §6 — standardized auth) ─────────────────────

  /**
   * Obtain an M2M access token from APICenter.
   * Call once at startup — the SDK auto-refreshes before expiry.
   * Throws AuthenticationError if credentials are invalid.
   */
  async authenticate(): Promise<void> {
    try {
      const res = await this.http.post('/api/v1/auth/token', {
        tribeId: this.tribeId,
        secret:  this.secret,
      });
      this.applyToken(res.data?.data);
    } catch (err) {
      throw isAxiosError(err) ? wrapAxiosError(err) : err;
    }
  }

  /**
   * Refresh the access token using the stored refresh token.
   * Falls back to full re-authentication if the refresh token is missing or expired.
   */
  async refresh(): Promise<void> {
    if (!this.refreshToken) return this.authenticate();
    try {
      const res = await this.http.post('/api/v1/auth/token/refresh', {
        refreshToken: this.refreshToken,
      });
      this.applyToken(res.data?.data);
    } catch {
      return this.authenticate();
    }
  }

  /**
   * Revoke the current refresh token (e.g. on logout or key rotation).
   * Pass revokeAll=true to invalidate ALL sessions for this tribe.
   */
  async revoke(revokeAll = false): Promise<void> {
    if (!this.refreshToken) return;
    await this.ensureAuth();
    try {
      await this.http.post(
        '/api/v1/auth/token/revoke',
        { refreshToken: this.refreshToken, revokeAll },
        { headers: { Authorization: `Bearer ${this.accessToken}` } },
      );
    } finally {
      this.accessToken  = null;
      this.refreshToken = null;
      this.tokenExpiry  = 0;
    }
  }

  // ── Service calls (checklist §7 — all tribe calls go through SDK) ──────────

  /**
   * Call a registered TRIBE service through the APICenter gateway.
   *
   * Maps to:  GET /api/v1/tribes/:serviceId/:path
   *
   * All tribe-to-tribe communication MUST use this method.
   * Direct calls to a tribe's baseUrl are not permitted.
   *
   * @param serviceId  Registered service ID  (e.g. 'user-service')
   * @param path       Downstream path        (e.g. '/users/123')
   * @param options    Optional Axios overrides (method, data, params, headers)
   *
   * @example
   *   const user = await client.callService('user-service', '/users/42');
   *   const order = await client.callService('order-service', '/orders',
   *     { method: 'POST', data: { items: [...] } });
   */
  async callService<T = unknown>(
    serviceId: string,
    path: string,
    options?: AxiosRequestConfig,
  ): Promise<T> {
    await this.ensureAuth();
    return this.request<T>({
      ...options,
      method: options?.method ?? 'GET',
      url: `/api/v1/tribes/${serviceId}${path}`,
    });
  }

  /**
   * Call a registered SHARED PLATFORM service through the APICenter gateway.
   *
   * Maps to:  GET /api/v1/shared/:serviceId/:path
   *
   * Use for platform-owned services (email, SMS, notifications, payments).
   *
   * @example
   *   await client.callSharedService('email-service', '/send', {
   *     method: 'POST',
   *     data: { to: 'user@example.com', template: 'welcome' },
   *   });
   */
  async callSharedService<T = unknown>(
    serviceId: string,
    path: string,
    options?: AxiosRequestConfig,
  ): Promise<T> {
    await this.ensureAuth();
    return this.request<T>({
      ...options,
      method: options?.method ?? 'GET',
      url: `/api/v1/shared/${serviceId}${path}`,
    });
  }

  /**
   * Call an EXTERNAL THIRD-PARTY API through the APICenter gateway.
   *
   * Maps to:  GET /api/v1/external/:apiName/:path
   *
   * API credentials (keys, tokens) live only in APICenter — your service
   * never needs to know the external API key.
   * Calls are protected by per-API circuit breakers inside the gateway.
   *
   * @example
   *   const geo = await client.callExternal('geolocation', '/lookup?ip=8.8.8.8');
   */
  async callExternal<T = unknown>(
    apiName: string,
    path: string,
    options?: AxiosRequestConfig,
  ): Promise<T> {
    await this.ensureAuth();
    return this.request<T>({
      ...options,
      method: options?.method ?? 'GET',
      url: `/api/v1/external/${apiName}${path}`,
    });
  }

  // ── Discovery ─────────────────────────────────────────────────────────────

  /** List all tribe services visible to this caller. */
  async listServices(): Promise<unknown[]> {
    await this.ensureAuth();
    const res = await this.request<{ data: unknown[] }>({ method: 'GET', url: '/api/v1/tribes' });
    return (res as any).data ?? res;
  }

  /** List all shared platform services visible to this caller. */
  async listSharedServices(): Promise<unknown[]> {
    await this.ensureAuth();
    const res = await this.request<{ data: unknown[] }>({ method: 'GET', url: '/api/v1/shared' });
    return (res as any).data ?? res;
  }

  /** Return the current access token (for manual use — prefer the call methods). */
  getAccessToken(): string | null {
    return this.accessToken;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private applyToken(data: { accessToken: string; refreshToken?: string; expiresIn?: number }) {
    this.accessToken  = data.accessToken;
    this.refreshToken = data.refreshToken ?? null;
    this.tokenExpiry  = Date.now() + (data.expiresIn ?? 3_600) * 1_000;
  }

  /** Ensure a valid token is present, auto-refreshing 30 s before expiry. */
  private async ensureAuth(): Promise<void> {
    if (!this.accessToken || Date.now() >= this.tokenExpiry - 30_000) {
      if (this.refreshToken) {
        await this.refresh();
      } else {
        await this.authenticate();
      }
    }
  }

  /**
   * Execute a request with automatic retries + exponential backoff.
   * Injects Authorization header, X-Tribe-Id, and optional X-Correlation-ID.
   */
  private async request<T>(config: AxiosRequestConfig): Promise<T> {
    const headers: Record<string, string> = {
      ...(config.headers as Record<string, string> ?? {}),
      Authorization: `Bearer ${this.accessToken}`,
      'X-Tribe-Id':  this.tribeId,
    };

    if (this.correlationIdFactory) {
      headers['X-Correlation-ID'] = this.correlationIdFactory();
    }

    const finalConfig: AxiosRequestConfig = { ...config, headers };
    let lastError: AxiosError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res  = await this.http.request<T>(finalConfig);
        // Unwrap the standard { success, data, meta } envelope when present
        const body = res.data as any;
        return (body && typeof body === 'object' && 'data' in body && 'success' in body)
          ? body.data
          : res.data;
      } catch (err) {
        if (!isAxiosError(err)) throw err;
        lastError = err;

        // Immediate throw for non-retryable errors
        if (!isRetryable(err) || attempt === this.maxRetries) throw wrapAxiosError(err);

        // Exponential backoff with ±25% jitter
        const base  = this.retryBaseDelayMs * Math.pow(2, attempt);
        const jitter = base * 0.25 * (Math.random() * 2 - 1);
        await sleep(Math.max(0, Math.round(base + jitter)));
      }
    }

    throw lastError ? wrapAxiosError(lastError) : new NetworkError();
  }
}

// =============================================================================
// Re-export all error classes for consumers who want to catch specific types
// =============================================================================
export {
  TribeClientError as SDKError,
};
