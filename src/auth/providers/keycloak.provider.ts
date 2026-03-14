// =============================================================================
// src/auth/providers/keycloak.provider.ts — Keycloak OIDC/JWKS AuthProvider
// =============================================================================
// Production-grade provider that delegates JWT validation, token issuance, and
// token refresh to a Keycloak server (or any compatible OIDC provider).
//
// TOKEN VALIDATION:
//   Tokens are validated locally using the provider's JWKS endpoint — no round
//   trip to Keycloak per request.  The remote JWKS is fetched once and cached;
//   it is automatically refreshed when an unknown key ID (kid) is encountered
//   (jose's createRemoteJWKSet handles this transparently).
//
// TOKEN ISSUANCE (M2M):
//   Uses the OAuth 2.0 Client Credentials flow.  Every registered service has
//   its own Keycloak client (clientId + clientSecret).  The platform admin
//   creates these via the Keycloak Admin UI or IaC scripts.
//
// TOKEN REFRESH:
//   Standard OAuth 2.0 refresh_token grant against Keycloak's token endpoint.
//
// PRODUCTION HARDENING:
//   • Run Keycloak behind an Envoy/Nginx ingress that strips or re-validates JWTs
//   • Use Vault (or cloud KMS/HSM) for client-secret storage — load them into
//     process.env via SecretsService at boot time
//   • Enable Redis-backed refresh-token storage for state management
//   • Emit audit events to Kafka on validation failure / token issuance
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import axios from 'axios';
import { AuthProvider, IssuedToken, JwtClaims } from '../auth-provider.interface';
import { ConfigService } from '../../config/config.service';

@Injectable()
export class KeycloakProvider implements AuthProvider, OnModuleInit {
  private readonly logger = new Logger(KeycloakProvider.name);

  /**
   * Remote JWKS key store — fetched lazily by jose and re-fetched whenever an
   * unknown kid is encountered (automatic key rotation support).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private jwks!: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly config: ConfigService) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Initialise the JWKS key store once the module has bootstrapped.
   * Any misconfiguration (missing KEYCLOAK_JWKS_URI) is detected early.
   */
  onModuleInit(): void {
    const jwksUri = this.config.keycloak.jwksUri;
    if (!jwksUri) {
      this.logger.warn(
        'KEYCLOAK_JWKS_URI is not set — Keycloak token validation will fail',
      );
      return;
    }
    // createRemoteJWKSet returns a JWTVerifyGetKey function.
    // It caches keys and re-fetches when it encounters an unknown kid.
    this.jwks = createRemoteJWKSet(new URL(jwksUri));
    this.logger.log(`KeycloakProvider ready — JWKS: ${jwksUri}`);
  }

  // ---------------------------------------------------------------------------
  // AuthProvider implementation
  // ---------------------------------------------------------------------------

  /**
   * Validate an incoming Bearer JWT against Keycloak's JWKS.
   * Verifies signature, expiry, and (optionally) issuer + audience.
   */
  async validateToken(token: string): Promise<JwtClaims> {
    if (!this.jwks) {
      throw new Error('KeycloakProvider not initialised — KEYCLOAK_JWKS_URI missing');
    }

    const { payload } = await jwtVerify(token, this.jwks, {
      // Only enforce issuer when explicitly configured
      ...(this.config.keycloak.issuer ? { issuer: this.config.keycloak.issuer } : {}),
      // Optionally enforce audience (recommended in production)
      ...(this.config.keycloak.audience ? { audience: this.config.keycloak.audience } : {}),
    });

    // Map Keycloak's resource_access / realm_access claims to a flat permissions array
    const realmRoles: string[] =
      (payload['realm_access'] as { roles?: string[] })?.roles ?? [];
    const resourceRoles: string[] = Object.values(
      (payload['resource_access'] as Record<string, { roles?: string[] }>) ?? {},
    ).flatMap((ra) => ra.roles ?? []);

    return {
      sub: payload.sub ?? '',
      tribeId: payload['tribeId'] as string | undefined,
      permissions: [...realmRoles, ...resourceRoles],
      scopes: ((payload['scope'] as string | undefined) ?? '').split(' ').filter(Boolean),
      exp: payload.exp,
      ...payload,
    };
  }

  /**
   * Issue an M2M access token using the OAuth 2.0 Client Credentials flow.
   * The `serviceId` is the Keycloak client ID; its secret comes from config.
   *
   * Custom claims (tribeId, permissions, scopes) are embedded via Keycloak
   * "token mapper" scripts or protocol mappers configured in the Admin UI.
   */
  async issueToken(
    serviceId: string,
    permissions: string[],
    scopes: string[],
  ): Promise<IssuedToken> {
    const { tokenEndpoint, realm } = this.config.keycloak;
    // Build the client secret env-var name following the same naming convention
    // used for tribe secrets: KEYCLOAK_CLIENT_SECRET_{SERVICE_ID_UPPER}
    // Non-alphanumeric characters are replaced with underscores for valid env-var names.
    const clientSecretEnvKey = `KEYCLOAK_CLIENT_SECRET_${serviceId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    const clientSecret = process.env[clientSecretEnvKey] ?? this.config.keycloak.defaultClientSecret;

    if (!clientSecret) {
      throw new Error(
        `No Keycloak client secret found for service '${serviceId}'. ` +
          `Set ${clientSecretEnvKey} or KEYCLOAK_DEFAULT_CLIENT_SECRET.`,
      );
    }

    const endpoint =
      tokenEndpoint ||
      `${this.config.keycloak.baseUrl}/realms/${realm}/protocol/openid-connect/token`;

    // Request scopes include the declared service scopes
    const scopeString = ['openid', ...scopes].join(' ');

    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: serviceId,
      client_secret: clientSecret,
      scope: scopeString,
    });

    const response = await axios.post<{
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    }>(endpoint, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10_000,
    });

    this.logger.log(`M2M token issued for service '${serviceId}' via Keycloak`);

    return {
      accessToken: response.data.access_token,
      refreshToken: response.data.refresh_token ?? null,
      expiresIn: response.data.expires_in,
    };
  }

  /**
   * Exchange a refresh token for a new access token via Keycloak's token
   * endpoint using the standard refresh_token grant.
   */
  async refreshToken(refreshToken: string): Promise<IssuedToken> {
    const { tokenEndpoint, realm, refreshClientId, defaultClientSecret } =
      this.config.keycloak;

    const endpoint =
      tokenEndpoint ||
      `${this.config.keycloak.baseUrl}/realms/${realm}/protocol/openid-connect/token`;

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: refreshClientId || 'api-center',
      ...(defaultClientSecret ? { client_secret: defaultClientSecret } : {}),
    });

    const response = await axios.post<{
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    }>(endpoint, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10_000,
    });

    return {
      accessToken: response.data.access_token,
      refreshToken: response.data.refresh_token ?? null,
      expiresIn: response.data.expires_in,
    };
  }

  /**
   * Keycloak is an external OIDC server — clients fetch the JWKS directly
   * from its well-known URL, so we do not serve an in-process JWKS document.
   */
  getJwksJson(): null {
    return null;
  }
}
