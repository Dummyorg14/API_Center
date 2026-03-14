// =============================================================================
// src/config/config.service.ts — Centralized application configuration
// =============================================================================

import { Injectable, OnModuleInit } from '@nestjs/common';
import dotenv from 'dotenv';

dotenv.config();

@Injectable()
export class ConfigService implements OnModuleInit {
  readonly port: number = parseInt(process.env.PORT || '3000', 10);
  readonly nodeEnv: string = process.env.NODE_ENV || 'development';

  readonly cors = {
    origin: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',')
      : ('*' as string | string[]),
    credentials: true,
  };

  // AUTH_PROVIDER=keycloak  → KeycloakProvider (production)
  // AUTH_PROVIDER=google    → GoogleProvider   (Google OAuth2 / OIDC)
  // AUTH_PROVIDER=dev-jwt   → DevJwtProvider   (local dev / CI) [default]
  readonly authProvider: string = process.env.AUTH_PROVIDER || 'dev-jwt';

  readonly google = {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    allowedDomains: (process.env.GOOGLE_ALLOWED_DOMAINS ?? '')
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean),
    // Redirect URI registered in Google Cloud Console
    redirectUri: process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:3000/api/v1/auth/google/callback',
  };

  readonly keycloak = {
    baseUrl: process.env.KEYCLOAK_BASE_URL || 'http://localhost:8080',
    realm: process.env.KEYCLOAK_REALM || 'api-center',
    jwksUri:
      process.env.KEYCLOAK_JWKS_URI ||
      `${process.env.KEYCLOAK_BASE_URL || 'http://localhost:8080'}/realms/${process.env.KEYCLOAK_REALM || 'api-center'}/protocol/openid-connect/certs`,
    tokenEndpoint: process.env.KEYCLOAK_TOKEN_ENDPOINT || '',
    issuer: process.env.KEYCLOAK_ISSUER || '',
    audience: process.env.KEYCLOAK_AUDIENCE || '',
    refreshClientId: process.env.KEYCLOAK_REFRESH_CLIENT_ID || 'api-center',
    defaultClientSecret: process.env.KEYCLOAK_DEFAULT_CLIENT_SECRET || '',
    /**
     * When true, trust X-Forwarded-User / X-Forwarded-Roles injected by
     * Envoy/Ingress after edge JWT pre-verification. ONLY enable when the
     * gateway is behind a trusted ingress — never direct internet exposure.
     */
    trustEnvoyHeaders: process.env.ENVOY_TRUST_HEADERS === 'true',
  };

  readonly devJwt = {
    issuer: process.env.DEV_JWT_ISSUER || 'api-center-dev',
    tokenTtlSeconds: parseInt(process.env.DEV_JWT_TTL_SECONDS || '3600', 10),
    refreshTtlMultiplier: parseInt(process.env.DEV_JWT_REFRESH_TTL_MULTIPLIER || '24', 10),
  };

  // HashiCorp Vault — KV v2 secret loading + Transit signing
  readonly vault = {
    addr: process.env.VAULT_ADDR || 'http://localhost:8200',
    token: process.env.VAULT_TOKEN || '',
    roleId: process.env.VAULT_ROLE_ID || '',
    secretId: process.env.VAULT_SECRET_ID || '',
    secretPath: process.env.VAULT_SECRET_PATH || 'secret/api-center',
    transitKey: process.env.VAULT_TRANSIT_KEY || '',
    devMode: process.env.VAULT_DEV_MODE === 'true',
  };

  readonly kafka = {
    clientId: process.env.KAFKA_CLIENT_ID || 'api-center',
    brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
    groupId: process.env.KAFKA_GROUP_ID || 'api-center-group',
  };

  readonly platformAdminSecret: string = process.env.PLATFORM_ADMIN_SECRET || '';

  readonly redis = {
    rateLimitUrl: process.env.REDIS_RATE_LIMIT_URL || 'redis://localhost:6380',
    cacheUrl: process.env.REDIS_CACHE_URL || 'redis://localhost:6381',
    tokenTtlSeconds: parseInt(process.env.REDIS_TOKEN_TTL_SECONDS || '3600', 10),
    sessionTtlSeconds: parseInt(process.env.REDIS_SESSION_TTL_SECONDS || '86400', 10),
  };

  readonly rateLimit = {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
  };

  readonly external = {
    timeout: 10000,
    geolocation: {
      url: process.env.GEOLOCATION_API_URL || 'https://api.ipgeolocation.io',
      key: process.env.GEOLOCATION_API_KEY || '',
    },
    geofencing: {
      url: process.env.GEOFENCING_API_URL || 'https://api.geofencing.example.com',
      key: process.env.GEOFENCING_API_KEY || '',
    },
  };

  readonly tracing = {
    jaegerEndpoint: process.env.JAEGER_ENDPOINT || 'http://localhost:14268/api/traces',
    serviceName: process.env.OTEL_SERVICE_NAME || 'api-center',
  };

  readonly allowedOrigins: string | string[] = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : '*';

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }

  onModuleInit() {
    const warnings: string[] = [];
    const errors: string[] = [];

    if (!this.platformAdminSecret && this.isProduction) {
      errors.push('PLATFORM_ADMIN_SECRET must be set in production');
    }

    const validProviders = ['keycloak', 'google', 'dev-jwt'];
    if (!validProviders.includes(this.authProvider)) {
      errors.push(`AUTH_PROVIDER must be one of: ${validProviders.join(', ')} (got '${this.authProvider}')`);
    }

    if (this.authProvider === 'keycloak') {
      const isLocalhost = (() => {
        try { return new URL(this.keycloak.baseUrl).hostname === 'localhost'; }
        catch { return false; }
      })();
      if (isLocalhost && this.isProduction) errors.push('KEYCLOAK_BASE_URL must be set to a production Keycloak URL');
      if (isLocalhost && !this.isProduction) warnings.push('KEYCLOAK_BASE_URL still points to localhost');
      if (!this.keycloak.issuer && this.isProduction) warnings.push('KEYCLOAK_ISSUER is not set — token issuer validation is disabled');
      if (this.keycloak.trustEnvoyHeaders) warnings.push('ENVOY_TRUST_HEADERS=true — ensure this gateway is never directly internet-exposed');
    }

    if (this.authProvider === 'google') {
      if (!this.google.clientId) warnings.push('GOOGLE_CLIENT_ID is not set — Google auth will fail');
      if (!this.google.clientSecret) warnings.push('GOOGLE_CLIENT_SECRET is not set — Google auth will fail');
      if (this.google.allowedDomains.length === 0 && this.isProduction) {
        warnings.push('GOOGLE_ALLOWED_DOMAINS is not set in production — any Google account can authenticate');
      }
    }

    if (this.authProvider === 'dev-jwt' && this.isProduction) {
      errors.push('AUTH_PROVIDER=dev-jwt must NOT be used in production. Use AUTH_PROVIDER=keycloak');
    }

    if (this.vault.devMode && this.isProduction) {
      errors.push('VAULT_DEV_MODE=true must NOT be used in production');
    }

    if (this.isProduction && !this.vault.token && !this.vault.roleId) {
      warnings.push('No Vault credentials configured — secrets read from process.env only. Set VAULT_ROLE_ID+VAULT_SECRET_ID for production.');
    }

    if (this.isProduction && this.kafka.brokers.includes('localhost:9092')) {
      warnings.push('KAFKA_BROKERS still points to localhost in production');
    }

    if (this.isProduction) {
      if (this.redis.rateLimitUrl.includes('localhost')) warnings.push('REDIS_RATE_LIMIT_URL still points to localhost in production');
      if (this.redis.cacheUrl.includes('localhost')) warnings.push('REDIS_CACHE_URL still points to localhost in production');
    }

    for (const w of warnings) console.warn(`[ConfigService] WARNING: ${w}`);

    if (errors.length > 0) {
      const msg = `[ConfigService] Fatal configuration errors:\n${errors.map((e) => `  - ${e}`).join('\n')}`;
      console.error(msg);
      throw new Error(msg);
    }
  }
}
