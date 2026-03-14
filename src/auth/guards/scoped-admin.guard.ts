// =============================================================================
// src/auth/guards/scoped-admin.guard.ts — JWT-scoped admin guard (transitional)
// =============================================================================
// Dual-mode guard for admin endpoints:
//   1. LEGACY: Accepts `X-Platform-Secret` header (same as PlatformAdminGuard)
//   2. NEW:    Accepts a valid JWT with `platform:admin` scope
//              (validated via the configured AuthProvider — Keycloak or DevJwt)
//
// Both modes run in parallel — either one succeeds, the request is allowed.
// This enables a gradual migration: services switch to JWT-based admin auth
// at their own pace while the shared-secret path remains available during
// the deprecation window.
//
// Once all callers use JWT scopes, PlatformAdminGuard and the legacy branch
// here can be removed, and this guard becomes the sole admin gate.
//
// REPLACES: Descope-specific ScopedAdminGuard (validates via AuthService now)
// =============================================================================

import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { ConfigService } from '../../config/config.service';
import { AuthService } from '../auth.service';
import { LoggerService } from '../../shared/logger.service';
import { UnauthorizedError } from '../../shared/errors';
import { AuthenticatedRequest } from '../../types';

const ADMIN_SCOPE = 'platform:admin';

@Injectable()
export class ScopedAdminGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly auth: AuthService,
    private readonly logger: LoggerService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    // ── Path 1: Legacy shared-secret (deprecated) ──────────────────────────
    const secret = request.headers['x-platform-secret'] as string | undefined;
    if (secret) {
      if (this.config.platformAdminSecret && secret === this.config.platformAdminSecret) {
        this.logger.debug(
          `Admin access via X-Platform-Secret from ${request.ip} (deprecated path)`,
          'ScopedAdminGuard',
        );
        return true;
      }
      // Secret provided but wrong — fall through to JWT check (don't reject yet)
    }

    // ── Path 2: JWT with platform:admin scope ──────────────────────────────
    // Validation is delegated to AuthService → AuthProvider (Keycloak or DevJwt)
    const token = request.headers.authorization?.split(' ')[1];
    if (token) {
      try {
        const claims = await this.auth.validateToken(token);
        // Use AuthService.mergeCallerScopes to avoid duplicating the scopes+permissions merge
        const scopes = this.auth.mergeCallerScopes(claims);

        if (scopes.includes(ADMIN_SCOPE)) {
          // Attach claims to request for downstream use
          (request as AuthenticatedRequest).user = claims;
          (request as AuthenticatedRequest).tribeId = claims.tribeId;
          this.logger.debug(
            `Admin access via JWT scope '${ADMIN_SCOPE}' from ${request.ip}`,
            'ScopedAdminGuard',
          );
          return true;
        }

        this.logger.warn(
          `JWT valid but missing '${ADMIN_SCOPE}' scope from ${request.ip} on ${request.path}`,
          'ScopedAdminGuard',
        );
      } catch {
        this.logger.warn(
          `Admin JWT validation failed from ${request.ip} on ${request.path}`,
          'ScopedAdminGuard',
        );
      }
    }

    // ── Neither path succeeded ─────────────────────────────────────────────
    throw new UnauthorizedError(
      'Admin access requires a valid X-Platform-Secret header or a JWT with platform:admin scope',
    );
  }
}

