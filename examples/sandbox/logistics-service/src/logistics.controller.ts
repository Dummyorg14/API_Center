import {
  Controller,
  Get,
  Headers,
  Logger,
  Param,
  UseGuards,
} from '@nestjs/common';
import { hostname } from 'node:os';
import { LogisticsJwtGuard } from './logistics-jwt.guard';

@Controller()
export class LogisticsController {
  private readonly logger = new Logger(LogisticsController.name);

  @Get('health')
  health() {
    return {
      ok: true,
      service: 'logistics-service',
      instance: hostname(),
      timestamp: new Date().toISOString(),
    };
  }

  @UseGuards(LogisticsJwtGuard)
  @Get('shipments/:id')
  getShipment(
    @Param('id') id: string,
    @Headers('x-correlation-id') correlationId?: string,
    @Headers('x-tribe-id') callerTribeId?: string,
  ) {
    this.logger.log(
      JSON.stringify({
        event: 'logistics_request',
        instance: hostname(),
        shipmentId: id,
        correlationId: correlationId || null,
        callerTribeId: callerTribeId || null,
      }),
    );

    return {
      shipmentId: id,
      status: 'in_transit',
      etaMinutes: 42,
      warehouse: 'WH-A1',
      handledBy: hostname(),
      correlationId: correlationId || null,
    };
  }
}
