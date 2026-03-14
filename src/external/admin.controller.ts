// =============================================================================
// src/external/admin.controller.ts — Circuit Breaker Admin Controller
// =============================================================================
// Protected admin endpoint to view and reset circuit breakers.
//
// ENDPOINTS:
//  GET  /api/v1/admin/circuit-breakers              — List all breaker states
//  POST /api/v1/admin/circuit-breakers/:apiName/reset — Reset a specific breaker
// =============================================================================

import { Controller, Get, Post, Param, UseGuards, Req } from '@nestjs/common';
import { ScopedAdminGuard } from '../auth/guards/scoped-admin.guard';
import { ExternalService } from './external.service';
import { LoggerService } from '../shared/logger.service';
import { NotFoundError } from '../shared/errors';
import { AuthenticatedRequest } from '../types';

@Controller('admin/circuit-breakers')
@UseGuards(ScopedAdminGuard)
export class AdminCircuitBreakerController {
  constructor(
    private readonly externalService: ExternalService,
    private readonly logger: LoggerService,
  ) {}

  /**
   * GET /api/v1/admin/circuit-breakers — List all circuit breakers and their states
   */
  @Get()
  listBreakers() {
    const stats = this.externalService.getAllBreakerStats();
    return {
      success: true,
      data: stats,
      meta: {
        total: stats.length,
        timestamp: new Date().toISOString(),
      },
    };
  }

  /**
   * POST /api/v1/admin/circuit-breakers/:apiName/reset — Reset a breaker to CLOSED
   */
  @Post(':apiName/reset')
  resetBreaker(
    @Param('apiName') apiName: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const breaker = this.externalService.getBreaker(apiName);
    if (!breaker) {
      throw new NotFoundError(`Circuit breaker for '${apiName}' not found`);
    }

    const previousState = breaker.getState();
    breaker.reset();

    this.logger.info(`Circuit breaker '${apiName}' reset by admin`, {
      apiName,
      previousState,
      correlationId: req.correlationId,
    });

    return {
      success: true,
      data: {
        apiName,
        previousState,
        currentState: breaker.getState(),
      },
      meta: {
        timestamp: new Date().toISOString(),
        correlationId: req.correlationId,
      },
    };
  }
}
