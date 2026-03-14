// =============================================================================
// src/registry/registry.controller.ts — Service Registry API endpoints
// =============================================================================
// NestJS controller for managing the Dynamic Service Registry.
//
// REPLACES: Express registryRouter (routes.ts)
// NestJS ADVANTAGE: @UseGuards(PlatformAdminGuard) replaces the manual
// requirePlatformAdmin middleware. DTOs are auto-validated by the global
// ValidationPipe.
//
// ENDPOINTS:
//  POST   /api/v1/registry/register          — Register a new service
//  GET    /api/v1/registry/services           — List all services
//  GET    /api/v1/registry/services/:serviceId — Get a specific service
//  DELETE /api/v1/registry/services/:serviceId — Deregister a service
// =============================================================================

import { Controller, Post, Get, Delete, Patch, Body, Param, UseGuards, Req } from '@nestjs/common';
import { RegistryService } from './registry.service';
import { ScopedAdminGuard } from '../auth/guards/scoped-admin.guard';
import { LoggerService } from '../shared/logger.service';
import { ServiceManifestDto } from '../shared/dto/service-manifest.dto';
import { DeprecateServiceDto } from '../shared/dto/deprecate-service.dto';
import { NotFoundError } from '../shared/errors';
import { AuthenticatedRequest, ServiceTier, ServiceType } from '../types';

@Controller('registry')
@UseGuards(ScopedAdminGuard)
export class RegistryController {
  constructor(
    private readonly registry: RegistryService,
    private readonly logger: LoggerService,
  ) {}

  /**
   * POST /api/v1/registry/register
   */
  @Post('register')
  async register(@Body() dto: ServiceManifestDto, @Req() req: AuthenticatedRequest) {
    const manifest = {
      ...dto,
      consumes: dto.consumes ?? [],
      serviceTier: dto.serviceTier as ServiceTier | undefined,
      serviceType: (dto.serviceType ?? 'tribe') as ServiceType,
    };
    const entry = await this.registry.register(manifest);

    this.logger.info('Service registered via API', {
      serviceId: entry.serviceId,
      correlationId: req.correlationId,
    });

    return {
      success: true,
      data: entry,
      meta: {
        timestamp: new Date().toISOString(),
        correlationId: req.correlationId,
      },
    };
  }

  /**
   * GET /api/v1/registry/services
   */
  @Get('services')
  listServices() {
    const all = this.registry.getAll();

    return {
      success: true,
      data: Object.values(all).map((svc) => ({
        serviceId: svc.serviceId,
        name: svc.name,
        baseUrl: svc.baseUrl,
        status: svc.status,
        serviceType: svc.serviceType ?? 'tribe',
        exposes: svc.exposes,
        requiredScopes: svc.requiredScopes,
        consumes: svc.consumes,
        version: svc.version,
        previousVersion: svc.previousVersion,
        ownerTeam: svc.ownerTeam,
        contact: svc.contact,
        serviceTier: svc.serviceTier,
        costCenter: svc.costCenter,
        sunsetDate: svc.sunsetDate,
        replacementService: svc.replacementService,
        registeredAt: svc.registeredAt,
        updatedAt: svc.updatedAt,
      })),
      meta: {
        total: this.registry.count(),
        timestamp: new Date().toISOString(),
      },
    };
  }

  /**
   * GET /api/v1/registry/services/:serviceId
   */
  @Get('services/:serviceId')
  getService(@Param('serviceId') serviceId: string) {
    const entry = this.registry.get(serviceId);
    if (!entry) {
      throw new NotFoundError(`Service '${serviceId}' is not registered`);
    }

    return {
      success: true,
      data: entry,
      meta: { timestamp: new Date().toISOString() },
    };
  }

  /**
   * DELETE /api/v1/registry/services/:serviceId
   */
  @Delete('services/:serviceId')
  async deregister(@Param('serviceId') serviceId: string, @Req() req: AuthenticatedRequest) {
    await this.registry.deregister(serviceId);

    this.logger.info('Service deregistered via API', {
      serviceId,
      correlationId: req.correlationId,
    });

    return {
      success: true,
      data: { serviceId, message: `Service '${serviceId}' has been deregistered` },
      meta: { timestamp: new Date().toISOString(), correlationId: req.correlationId },
    };
  }

  // ─── Lifecycle management ────────────────────────────────────────────────────

  /**
   * PATCH /api/v1/registry/services/:serviceId/deprecate
   * Mark a service as deprecated. Consumers will receive Sunset headers.
   */
  @Patch('services/:serviceId/deprecate')
  deprecate(
    @Param('serviceId') serviceId: string,
    @Body() dto: DeprecateServiceDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const entry = this.registry.deprecate(
      serviceId,
      dto.sunsetDate,
      dto.replacementService,
    );

    const consumers = this.registry.getConsumers(serviceId);

    this.logger.warn(
      `Service '${serviceId}' deprecated via API — ${consumers.length} consumer(s) affected`,
      'RegistryController',
    );

    return {
      success: true,
      data: {
        ...entry,
        affectedConsumers: consumers,
      },
      meta: { timestamp: new Date().toISOString(), correlationId: req.correlationId },
    };
  }

  /**
   * POST /api/v1/registry/services/:serviceId/retire
   * Permanently retire a service — it will return 410 Gone to callers.
   */
  @Post('services/:serviceId/retire')
  retire(@Param('serviceId') serviceId: string, @Req() req: AuthenticatedRequest) {
    const consumers = this.registry.getConsumers(serviceId);
    const entry = this.registry.retire(serviceId);

    this.logger.warn(
      `Service '${serviceId}' retired via API — ${consumers.length} consumer(s) affected`,
      'RegistryController',
    );

    return {
      success: true,
      data: {
        ...entry,
        affectedConsumers: consumers,
      },
      meta: { timestamp: new Date().toISOString(), correlationId: req.correlationId },
    };
  }

  /**
   * PATCH /api/v1/registry/services/:serviceId/activate
   * Re-activate a proposed or deprecated service.
   */
  @Patch('services/:serviceId/activate')
  activate(@Param('serviceId') serviceId: string, @Req() req: AuthenticatedRequest) {
    const entry = this.registry.activate(serviceId);

    this.logger.info(`Service '${serviceId}' activated via API`, {
      correlationId: req.correlationId,
    });

    return {
      success: true,
      data: entry,
      meta: { timestamp: new Date().toISOString(), correlationId: req.correlationId },
    };
  }

  /**
   * GET /api/v1/registry/services/:serviceId/consumers
   * List services that consume the given service.
   */
  @Get('services/:serviceId/consumers')
  getConsumers(@Param('serviceId') serviceId: string) {
    const entry = this.registry.get(serviceId);
    if (!entry) {
      throw new NotFoundError(`Service '${serviceId}' is not registered`);
    }

    const consumers = this.registry.getConsumers(serviceId);

    return {
      success: true,
      data: { serviceId, consumers },
      meta: { total: consumers.length, timestamp: new Date().toISOString() },
    };
  }
}
