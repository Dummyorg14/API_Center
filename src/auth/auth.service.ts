// =============================================================================
// src/auth/auth.service.ts — Provider-agnostic authentication service
// =============================================================================
// Thin orchestration layer that delegates JWT operations to the injected
// AuthProvider (KeycloakProvider or DevJwtProvider) and manages refresh
// token lifecycle via TokenStoreService.
// =============================================================================

import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AUTH_PROVIDER, AuthProvider, IssuedToken, JwtClaims } from './auth-provider.interface';
import { TokenStoreService, RefreshTokenRecord } from './token-store.service';
import { LoggerService } from '../shared/logger.service';
import { ForbiddenError, UnauthorizedError } from '../shared/errors';
import { AuthenticatedRequest } from '../types';

@Injectable()
export class AuthService {
  constructor(
    @Inject(AUTH_PROVIDER) private readonly provider: AuthProvider,
    private readonly tokenStore: TokenStoreService,
    private readonly logger: LoggerService,
  ) {}

  // ---------------------------------------------------------------------------
  // Token validation
  // ---------------------------------------------------------------------------

  async validateToken(token: string): Promise<JwtClaims> {
    return this.provider.validateToken(token);
  }

  // ---------------------------------------------------------------------------
  // Token issuance
  // ---------------------------------------------------------------------------

  /**
   * Issue a scoped M2M token and persist the refresh token in Redis.
   */
  async issueToken(
    serviceId: string,
    permissions: string[] = [],
    scopes: string[] = [],
  ): Promise<IssuedToken> {
    const issued = await this.provider.issueToken(serviceId, permissions, scopes);

    // Persist the refresh token in Redis for revocation support
    if (issued.refreshToken) {
      await this.persistRefreshToken(issued, serviceId, permissions, scopes);
    }

    return issued;
  }

  // ---------------------------------------------------------------------------
  // Token refresh
  // ---------------------------------------------------------------------------

  /**
   * Exchange a refresh token for a new access token.
   * Validates that the refresh token exists in the Redis store (not revoked).
   */
  async refreshToken(refreshToken: string): Promise<IssuedToken> {
    // Extract the JTI from the refresh token claims (best-effort — works for DevJwt)
    let jti: string | undefined;
    let sub: string | undefined;
    try {
      const claims = await this.provider.validateToken(refreshToken);
      jti = claims['jti'] as string | undefined;
      sub = claims.sub;
    } catch {
      // For Keycloak refresh tokens (opaque), we cannot pre-validate here;
      // Keycloak's token endpoint will reject invalid tokens itself.
    }

    // If we have a JTI, verify the token hasn't been revoked in Redis
    if (jti) {
      const valid = await this.tokenStore.isValid(jti);
      if (!valid) {
        throw new UnauthorizedError('Refresh token has been revoked or expired');
      }
    }

    const issued = await this.provider.refreshToken(refreshToken);

    // Rotate: revoke old refresh token, persist new one
    if (jti) {
      await this.tokenStore.revoke(jti);
    }
    if (issued.refreshToken && sub) {
      await this.persistRefreshToken(issued, sub, [], []);
    }

    return issued;
  }

  // ---------------------------------------------------------------------------
  // Token revocation
  // ---------------------------------------------------------------------------

  /**
   * Revoke a refresh token by JTI.
   * When revokeAll=true, revokes all tokens for the subject.
   *
   * @returns number of tokens revoked
   */
  async revokeToken(refreshToken: string, revokeAll = false): Promise<{ revokedCount: number; sub: string }> {
    // Parse the refresh token to extract jti + sub
    let jti: string | undefined;
    let sub: string | undefined;

    try {
      const claims = await this.provider.validateToken(refreshToken);
      jti = claims['jti'] as string | undefined;
      sub = claims.sub;
    } catch {
      // Token may already be expired — attempt lookup by raw value
    }

    if (!sub && !jti) {
      throw new UnauthorizedError('Cannot parse refresh token — it may already be expired or invalid');
    }

    let revokedCount = 0;

    if (revokeAll && sub) {
      revokedCount = await this.tokenStore.revokeAllForSubject(sub);
    } else if (jti) {
      const revoked = await this.tokenStore.revoke(jti);
      revokedCount = revoked ? 1 : 0;
    }

    this.logger.log(
      `Revoked ${revokedCount} token(s) for sub=${sub ?? 'unknown'} (revokeAll=${revokeAll})`,
      'AuthService',
    );

    return { revokedCount, sub: sub ?? 'unknown' };
  }

  // ---------------------------------------------------------------------------
  // Authorisation helpers
  // ---------------------------------------------------------------------------

  async authorize(req: AuthenticatedRequest, requiredPermission: string): Promise<void> {
    const permissions = this.mergeCallerScopes(req.user ?? {});
    if (!permissions.includes(requiredPermission)) {
      throw new ForbiddenError(`Missing permission: '${requiredPermission}'`);
    }
  }

  mergeCallerScopes(claims: Partial<JwtClaims>): string[] {
    return [
      ...(claims.scopes ?? []),
      ...(claims.permissions ?? []),
    ];
  }

  checkScopes(req: AuthenticatedRequest, requiredScopes: string[]): string[] {
    const callerScopes = this.mergeCallerScopes(req.user ?? {});
    return requiredScopes.filter((s) => !callerScopes.includes(s));
  }

  // ---------------------------------------------------------------------------
  // JWKS passthrough (DevJwtProvider only)
  // ---------------------------------------------------------------------------

  getJwksJson(): Record<string, unknown> | null {
    return this.provider.getJwksJson();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async persistRefreshToken(
    issued: IssuedToken,
    sub: string,
    permissions: string[],
    scopes: string[],
  ): Promise<void> {
    if (!issued.refreshToken) return;

    const jti = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    const record: RefreshTokenRecord = {
      jti,
      sub,
      tribeId: sub,
      issuedAt: now,
      expiresAt: now + issued.expiresIn * 24, // refresh lives longer than access
      scopes,
      permissions,
    };

    await this.tokenStore.store(record).catch((err) => {
      this.logger.warn(
        `Failed to persist refresh token for sub=${sub}: ${(err as Error).message}`,
        'AuthService',
      );
    });
  }
}
