import {
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Param,
} from '@nestjs/common';
import { DemandService } from './demand.service';

@Controller()
export class DemandController {
  private readonly demand = new DemandService();

  @Get('health')
  health() {
    return {
      ok: true,
      service: 'demand-service',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('demand/:id')
  async getDemandShipment(
    @Param('id') id: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    try {
      return await this.demand.fetchShipment(id, correlationId);
    } catch (error) {
      const message = (error as Error).message || 'Gateway request failed';
      const statusMatch = message.match(/status\s+(\d{3})/i);
      const status = statusMatch
        ? Number(statusMatch[1])
        : HttpStatus.BAD_GATEWAY;

      throw new HttpException(
        {
          message,
          source: 'demand-service',
        },
        status,
      );
    }
  }
}
