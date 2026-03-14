// =============================================================================
// Unit tests — MetricsService
// =============================================================================
// Covers: showback metrics (tribeRequestsTotal, tribeRequestDuration)
// and the setRegistryServicesCount method.
// =============================================================================

import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  let service: MetricsService;

  beforeEach(() => {
    // prom-client registers metrics globally; reset between tests
    const { register: promRegister } = require('prom-client');
    promRegister.clear();
    service = new MetricsService();
    service.onModuleInit();
  });

  describe('recordTribeRequest()', () => {
    it('does not throw when recording valid request data', () => {
      expect(() =>
        service.recordTribeRequest('svc-alpha', 'svc-beta', 'GET', 200, 0.05),
      ).not.toThrow();
    });

    it('increments the counter for each call', async () => {
      service.recordTribeRequest('svc-a', 'svc-b', 'POST', 201, 0.1);
      service.recordTribeRequest('svc-a', 'svc-b', 'POST', 201, 0.2);

      const metric = await service.tribeRequestsTotal.get();
      const value = metric.values.find(
        (v) =>
          v.labels.source_tribe === 'svc-a' &&
          v.labels.target_service === 'svc-b' &&
          v.labels.method === 'POST',
      );
      expect(value?.value).toBe(2);
    });
  });

  describe('setRegistryServicesCount()', () => {
    it('updates the gauge', async () => {
      service.setRegistryServicesCount(5);
      const metric = await service.registryServicesTotal.get();
      expect(metric.values[0].value).toBe(5);
    });

    it('can reset to zero', async () => {
      service.setRegistryServicesCount(10);
      service.setRegistryServicesCount(0);
      const metric = await service.registryServicesTotal.get();
      expect(metric.values[0].value).toBe(0);
    });
  });
});
