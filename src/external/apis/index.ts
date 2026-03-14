// =============================================================================
// src/external/apis/index.ts — External API Config Barrel
// =============================================================================
// Only true third-party APIs (geolocation, geofencing) remain here.
// Payment, SMS, and Email are now platform-owned shared services registered
// via the service registry and routed through /api/v1/shared/*.
// =============================================================================

import { ConfigService } from '../../config/config.service';
import { ExternalApiConfigMap } from '../../types';
import { createGeolocationApi } from './geolocation';
import { createGeofencingApi } from './geofencing';

/**
 * Build the external API config map from centralised ConfigService.
 * Called once during ExternalService.onModuleInit().
 */
export function buildExternalApis(config: ConfigService): ExternalApiConfigMap {
  return {
    geolocation: createGeolocationApi(config),
    geofencing: createGeofencingApi(config),
  };
}

export { createGeolocationApi, createGeofencingApi };
