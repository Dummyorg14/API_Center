// =============================================================================
// src/tribes/tribes.controller.ts — Dynamic Service Proxy Controller (Tribes)
// =============================================================================
// NestJS controller that proxies requests to registered tribe backend services.
// Only routes to services with serviceType: 'tribe' (the default).
//
// Uses the shared ProxyHandler utility which is also used by
// SharedServicesController for /shared/* routes.
//
// ENDPOINTS:
//  GET /api/v1/tribes           — List available tribe services
//  ALL /api/v1/tribes/:target/* — Proxy to registered upstream service
// =============================================================================

import {
  Controller,
  Get,
  All,
  Req,
  Res,
  Param,
  UseGuards,
  OnModuleDestroy,
} from '@nestjs/common';
import { Response } from 'express';
import { RegistryService } from '../registry/registry.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthService } from '../auth/auth.service';
import { LoggerService } from '../shared/logger.service';
import { MetricsService } from '../metrics/metrics.service';
import { ProxyHandler } from '../shared/proxy-handler';
import { AuthenticatedRequest } from '../types';

@Controller('tribes')
@UseGuards(JwtAuthGuard)
export class TribesController implements OnModuleDestroy {
  private readonly handler: ProxyHandler;

  constructor(
    registry: RegistryService,
    auth: AuthService,
    logger: LoggerService,
    metrics: MetricsService,
  ) {
    this.handler = new ProxyHandler(
      { registry, auth, logger, metrics },
      { namespace: 'tribe', pathPrefix: '/api/v1/tribes' },
    );
  }

  onModuleDestroy() {
    this.handler.destroy();
  }

  // ─── List available tribe services ───────────────────────────────────────────
  @Get()
  listServices(@Req() req: AuthenticatedRequest) {
    const tribeId = req.tribeId;
    const services = this.handler.listServices(tribeId);

    return {
      success: true,
      data: services,
      meta: {
        total: services.length,
        tribeId,
        namespace: 'tribe',
        timestamp: new Date().toISOString(),
        correlationId: req.correlationId,
      },
    };
  }

  // ─── Dynamic Proxy ───────────────────────────────────────────────────────────
  @All(':targetServiceId/*')
  async proxy(
    @Param('targetServiceId') targetServiceId: string,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ) {
    await this.handler.proxyRequest(targetServiceId, req, res);
  }
}

