import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TribeClient } from '@apicenter/sdk';

@Injectable()
export class DemandService {
  private readonly logger = new Logger(DemandService.name);

  async fetchShipment(shipmentId: string, incomingCorrelationId?: string) {
    const correlationId = incomingCorrelationId || randomUUID();

    const client = new TribeClient({
      gatewayUrl: process.env.APICENTER_URL || 'http://nginx',
      tribeId: process.env.DEMAND_TRIBE_ID || 'demand-service',
      secret: process.env.DEMAND_TRIBE_SECRET || 'demand-secret',
      correlationIdFactory: () => correlationId,
    });

    await client.authenticate();
    const shipment = await client.callService<Record<string, unknown>>(
      'logistics-service',
      `/shipments/${encodeURIComponent(shipmentId)}`,
    );

    this.logger.log(
      JSON.stringify({
        event: 'demand_request',
        shipmentId,
        correlationId,
      }),
    );

    return {
      demandService: 'ok',
      shipment,
      correlationId,
    };
  }
}
