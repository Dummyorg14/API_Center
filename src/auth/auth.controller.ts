// =============================================================================
// src/auth/auth.controller.ts — Token issuance, refresh, revocation + JWKS
// =============================================================================
// ENDPOINTS:
//   POST /api/v1/auth/token                    — issue a scoped M2M token
//   POST /api/v1/auth/token/refresh            — refresh an expiring token
//   POST /api/v1/auth/token/revoke             — revoke a refresh token (Redis + Kafka)
//   GET  /api/v1/auth/.well-known/jwks.json    — JWKS document (DevJwtProvider only)
// =============================================================================

import {
  Controller, Post, Get, Body, Req, Res, Query, HttpCode,
  UseGuards, NotFoundException, HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RegistryService } from '../registry/registry.service';
import { LoggerService } from '../shared/logger.service';
import { KafkaService } from '../kafka/kafka.service';
import { TOPICS } from '../kafka/topics';
import { NotFoundError, UnauthorizedError } from '../shared/errors';
import { TokenRequestDto } from '../shared/dto/token-request.dto';
import { RefreshTokenDto } from '../shared/dto/refresh-token.dto';
import { RevokeTokenDto } from '../shared/dto/revoke-token.dto';
import { AuthenticatedRequest } from '../types';
import { GoogleProvider } from './providers/google.provider';
import { ConfigService } from '../config/config.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly registry: RegistryService,
    private readonly logger: LoggerService,
    private readonly kafka: KafkaService,
    private readonly googleProvider: GoogleProvider,
    private readonly config: ConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // POST /api/v1/auth/token — Issue M2M JWT
  // ---------------------------------------------------------------------------

  @Post('token')
  async issueToken(@Body() dto: TokenRequestDto, @Req() req: AuthenticatedRequest) {
    const { tribeId, secret } = dto;

    const service = this.registry.get(tribeId);
    if (!service) {
      throw new NotFoundError(`Unknown service: ${tribeId}`);
    }

    const isValid = await this.registry.validateSecret(tribeId, secret);
    if (!isValid) {
      throw new UnauthorizedError('Invalid credentials');
    }

    // Build scopes: own + consumable targets' scopes
    const ownScopes = service.requiredScopes || [];
    const consumableScopes: string[] = [];
    for (const targetId of service.consumes) {
      const target = this.registry.get(targetId);
      if (target) consumableScopes.push(...target.requiredScopes);
    }
    const scopes = [...new Set([...ownScopes, ...consumableScopes])];
    const permissions = [`tribe:${tribeId}:read`, `tribe:${tribeId}:write`, 'external:read'];

    const token = await this.auth.issueToken(tribeId, permissions, scopes);

    this.logger.info('Token issued', { serviceId: tribeId, scopes, correlationId: req.correlationId });

    this.kafka
      .publish(TOPICS.TOKEN_ISSUED, {
        tribeId,
        sub: tribeId,
        scopes,
        permissions,
        expiresIn: token.expiresIn,
        correlationId: req.correlationId,
        timestamp: new Date().toISOString(),
      }, tribeId)
      .catch((err) =>
        this.logger.error(
          `Failed to publish TOKEN_ISSUED: ${(err as Error).message}`,
          (err as Error).stack,
          'AuthController',
        ),
      );

    return {
      success: true,
      data: {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken ?? null,
        expiresIn: token.expiresIn,
        tribeId,
        permissions,
        scopes,
      },
      meta: { timestamp: new Date().toISOString(), correlationId: req.correlationId },
    };
  }

  // ---------------------------------------------------------------------------
  // POST /api/v1/auth/token/refresh — Refresh access token
  // ---------------------------------------------------------------------------

  @Post('token/refresh')
  async refreshToken(@Body() dto: RefreshTokenDto, @Req() req: AuthenticatedRequest) {
    const resp = await this.auth.refreshToken(dto.refreshToken);

    this.logger.info('Token refreshed', { correlationId: req.correlationId });

    this.kafka
      .publish(TOPICS.TOKEN_REFRESHED, {
        sub: 'unknown', // sub extracted inside AuthService; event still useful for audit
        expiresIn: resp.expiresIn,
        correlationId: req.correlationId,
        timestamp: new Date().toISOString(),
      })
      .catch((err) =>
        this.logger.error(
          `Failed to publish TOKEN_REFRESHED: ${(err as Error).message}`,
          (err as Error).stack,
          'AuthController',
        ),
      );

    return {
      success: true,
      data: {
        accessToken: resp.accessToken,
        refreshToken: resp.refreshToken ?? null,
        expiresIn: resp.expiresIn,
      },
      meta: { timestamp: new Date().toISOString(), correlationId: req.correlationId },
    };
  }

  // ---------------------------------------------------------------------------
  // POST /api/v1/auth/token/revoke — Revoke refresh token
  // Requires a valid Bearer access token (JWT guard)
  // ---------------------------------------------------------------------------

  @Post('token/revoke')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeToken(
    @Body() dto: RevokeTokenDto,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const { revokedCount, sub } = await this.auth.revokeToken(
      dto.refreshToken,
      dto.revokeAll ?? false,
    );

    this.logger.info('Token(s) revoked', {
      sub,
      revokedCount,
      revokeAll: dto.revokeAll,
      correlationId: req.correlationId,
    });

    this.kafka
      .publish(TOPICS.TOKEN_REVOKED, {
        sub,
        revokedCount,
        reason: dto.revokeAll ? 'session-wide' : 'explicit',
        correlationId: req.correlationId,
        timestamp: new Date().toISOString(),
      })
      .catch((err) =>
        this.logger.error(
          `Failed to publish TOKEN_REVOKED: ${(err as Error).message}`,
          (err as Error).stack,
          'AuthController',
        ),
      );

    res.status(HttpStatus.NO_CONTENT).send();
  }

  // ---------------------------------------------------------------------------
  // GET /api/v1/auth/google — Initiate Google OAuth2 login (browser redirect)
  // ---------------------------------------------------------------------------
  // Redirects the browser to Google's OAuth2 authorization endpoint.
  // Query params:
  //   redirectUri  (required) — your frontend callback URL
  //   state        (optional) — CSRF state token, echoed back by Google
  //
  // Example:
  //   GET /api/v1/auth/google?redirectUri=http://localhost:4000/callback&state=abc123
  // ---------------------------------------------------------------------------

  @Get('google')
  initiateGoogleLogin(
    @Query('redirectUri') redirectUri: string,
    @Query('state') state: string | undefined,
    @Res() res: Response,
  ): void {
    const uri = redirectUri || this.config.google.redirectUri;
    const url = this.googleProvider.buildAuthorizationUrl(uri, state);
    res.redirect(url);
  }

  // ---------------------------------------------------------------------------
  // POST /api/v1/auth/google/callback — Exchange Google auth code for tokens
  // ---------------------------------------------------------------------------
  // Called by your frontend after Google redirects back with ?code=...
  // Body: { code: string, redirectUri: string }
  //
  // Returns an APICenter-scoped access token wrapping the Google identity.
  //
  // Example:
  //   POST /api/v1/auth/google/callback
  //   { "code": "<code from Google>", "redirectUri": "http://localhost:4000/callback" }
  // ---------------------------------------------------------------------------

  @Post('google/callback')
  async googleCallback(
    @Body() body: { code: string; redirectUri?: string },
    @Req() req: AuthenticatedRequest,
  ) {
    const { code, redirectUri } = body;
    if (!code) {
      throw new UnauthorizedError('Missing authorization code');
    }

    const uri = redirectUri || this.config.google.redirectUri;
    const result = await this.googleProvider.exchangeCode(code, uri);

    // Issue an internal APICenter access token wrapping the Google identity
    const internalToken = await this.auth.issueToken(
      result.userInfo.sub,
      ['openid', 'email', 'profile'],
      ['openid', 'email', 'profile'],
    );

    this.logger.info('Google user authenticated', {
      sub: result.userInfo.sub,
      email: result.userInfo.email,
      hd: result.userInfo.hd,
      correlationId: req.correlationId,
    });

    this.kafka
      .publish(TOPICS.TOKEN_ISSUED, {
        tribeId: result.userInfo.sub,
        sub: result.userInfo.sub,
        scopes: ['openid', 'email', 'profile'],
        permissions: ['openid', 'email', 'profile'],
        expiresIn: internalToken.expiresIn,
        provider: 'google',
        correlationId: req.correlationId,
        timestamp: new Date().toISOString(),
      }, result.userInfo.sub)
      .catch(() => undefined);

    return {
      success: true,
      data: {
        accessToken: internalToken.accessToken,
        refreshToken: result.refreshToken ?? internalToken.refreshToken ?? null,
        expiresIn: internalToken.expiresIn,
        user: {
          sub: result.userInfo.sub,
          email: result.userInfo.email,
          name: result.userInfo.name,
          picture: result.userInfo.picture,
          hd: result.userInfo.hd,
        },
      },
      meta: { timestamp: new Date().toISOString(), correlationId: req.correlationId },
    };
  }

  // ---------------------------------------------------------------------------
  // GET /api/v1/auth/.well-known/jwks.json — JWKS (DevJwtProvider only)
  // ---------------------------------------------------------------------------

  @Get('.well-known/jwks.json')
  getJwks() {
    const jwks = this.auth.getJwksJson();
    if (!jwks) {
      throw new NotFoundException(
        'JWKS is not served by this provider. Fetch from your Keycloak server: ' +
          `${process.env.KEYCLOAK_JWKS_URI || '<KEYCLOAK_JWKS_URI not set>'}`,
      );
    }
    return jwks;
  }
}
