// =============================================================================
// src/auth/guards/platform-admin.guard.ts — Platform admin secret guard
// =============================================================================
// NestJS guard that validates the X-Platform-Secret header.
// Protects registry management endpoints from unauthorized access.
//
// REPLACES: Express requirePlatformAdmin middleware
// =============================================================================

import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { ConfigService } from '../../config/config.service';
import { LoggerService } from '../../shared/logger.service';
import { UnauthorizedError } from '../../shared/errors';

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly logger: LoggerService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const secret = request.headers['x-platform-secret'] as string;

    if (!this.config.platformAdminSecret) {
      this.logger.error(
        'PLATFORM_ADMIN_SECRET is not configured — registry endpoints are disabled',
        undefined,
        'PlatformAdminGuard',
      );
      throw new UnauthorizedError('Registry management is not configured');
    }

    if (!secret || secret !== this.config.platformAdminSecret) {
      this.logger.warn(
        `Invalid platform admin secret from ${request.ip} on ${request.path}`,
        'PlatformAdminGuard',
      );
      throw new UnauthorizedError('Invalid or missing X-Platform-Secret header');
    }

    return true;
  }
}
