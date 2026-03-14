// =============================================================================
// src/auth/auth-provider.interface.ts — Pluggable AuthProvider abstraction
// =============================================================================
// Defines the contract that every auth-provider implementation must satisfy.
//
// Two first-class implementations are shipped:
//   • KeycloakProvider  — production-grade, OIDC/JWKS, enterprise-ready
//   • DevJwtProvider    — lightweight RS256 issuer for local dev and CI
//
// Selecting a provider is done via the AUTH_PROVIDER env var:
//   AUTH_PROVIDER=keycloak   → KeycloakProvider
//   AUTH_PROVIDER=dev-jwt    → DevJwtProvider  (default)
//
// To add a new provider, implement this interface, register it in AuthModule,
// and handle the selector in the providerFactory.
// =============================================================================

/** Normalised JWT claims extracted from a validated access token. */
export interface JwtClaims {
  /** Token subject — typically the service/user ID */
  sub: string;
  /** Custom claim: tribe / service identifier embedded in the JWT */
  tribeId?: string;
  /** Permission strings embedded in the token */
  permissions?: string[];
  /** Service scopes embedded in the token */
  scopes?: string[];
  /** Raw expiry epoch (seconds since UNIX epoch) */
  exp?: number;
  /** Pass-through for any additional provider-specific claims */
  [key: string]: unknown;
}

/** Token bundle returned after a successful issuance or refresh */
export interface IssuedToken {
  /** Short-lived access JWT (Bearer token) */
  accessToken: string;
  /** Long-lived refresh token; null when the provider does not issue one */
  refreshToken: string | null;
  /** Seconds until the access token expires */
  expiresIn: number;
}

/**
 * AuthProvider — the single interface all auth back-ends must implement.
 *
 * Responsibilities:
 *  1. validateToken  — verify a Bearer JWT and return normalised claims
 *  2. issueToken     — issue a scoped M2M JWT for a given service
 *  3. refreshToken   — exchange a refresh token for a new access token
 *  4. getJwksJson    — (optional) return an in-process JWKS document for
 *                       providers that self-issue tokens (e.g. DevJwtProvider)
 */
export interface AuthProvider {
  /**
   * Validate an incoming Bearer JWT.
   * Must throw (or reject) on expiry, invalid signature, wrong issuer, etc.
   *
   * @param token — raw JWT string from the Authorization header
   * @returns normalised JwtClaims
   */
  validateToken(token: string): Promise<JwtClaims>;

  /**
   * Issue a scoped M2M access token for a service.
   *
   * @param serviceId   — the service requesting the token
   * @param permissions — permission strings to embed
   * @param scopes      — service scopes to embed
   */
  issueToken(serviceId: string, permissions: string[], scopes: string[]): Promise<IssuedToken>;

  /**
   * Exchange a refresh token for a new access token.
   *
   * @param refreshToken — the refresh token received during initial issuance
   */
  refreshToken(refreshToken: string): Promise<IssuedToken>;

  /**
   * Return the in-process JWKS JSON document (only for self-issuing providers
   * such as DevJwtProvider).  Keycloak-backed deployments return null here
   * because clients fetch the JWKS directly from Keycloak's well-known URL.
   */
  getJwksJson(): Record<string, unknown> | null;
}

/** NestJS injection token for the active AuthProvider */
export const AUTH_PROVIDER = 'AUTH_PROVIDER';
