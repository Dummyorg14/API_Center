// =============================================================================
// src/external/external.controller.ts — External API Proxy Controller
// =============================================================================
// NestJS controller that exposes third-party API proxying via circuit breakers.
//
// REPLACES: Express externalRouter (router.ts external routes)
// NestJS ADVANTAGE: @UseGuards(JwtAuthGuard) applied at controller level.
// DTOs validated by the global ValidationPipe.
//
// ENDPOINTS:
//  GET /api/v1/external           — List configured external APIs
//  ALL /api/v1/external/:apiName/* — Proxy call through circuit breaker
// =============================================================================

import { Controller, Get, All, Req, Res, Param, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { ExternalService } from './external.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { LoggerService } from '../shared/logger.service';
import { AuthenticatedRequest } from '../types';

@Controller('external')
@UseGuards(JwtAuthGuard)
export class ExternalController {
  constructor(
    private readonly externalService: ExternalService,
    private readonly logger: LoggerService,
  ) {}

  /**
   * GET /api/v1/external — List available external APIs
   */
  @Get()
  listApis(@Req() req: AuthenticatedRequest) {
    const apis = this.externalService.listApis();

    return {
      success: true,
      data: apis,
      meta: {
        total: apis.length,
        timestamp: new Date().toISOString(),
        correlationId: req.correlationId,
      },
    };
  }

  /**
   * ALL /api/v1/external/:apiName/* — Proxy to external API through circuit breaker
   */
  @All(':apiName/*')
  async proxyCall(
    @Param('apiName') apiName: string,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ) {
    // Strip the /api/v1/external/:apiName prefix to get the downstream path
    const fullPath = req.originalUrl;
    const prefixPattern = new RegExp(`^/api/v1/external/${apiName}/?`);
    const downstreamPath = '/' + fullPath.replace(prefixPattern, '');

    this.logger.info('External proxy call', {
      apiName,
      method: req.method,
      path: downstreamPath,
      correlationId: req.correlationId,
    });

    const result = await this.externalService.call(apiName, {
      method: req.method as any,
      path: downstreamPath,
      query: req.query as Record<string, string>,
      body: req.body,
      headers: {
        'X-Correlation-ID': req.correlationId || '',
        'X-Tribe-Id': req.tribeId || '',
      },
    });

    res.status(result.status).json({
      success: true,
      data: result.data,
      meta: {
        api: apiName,
        duration: result.duration,
        timestamp: new Date().toISOString(),
        correlationId: req.correlationId,
      },
    });
  }
}
