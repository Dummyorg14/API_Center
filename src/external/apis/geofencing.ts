// =============================================================================
// src/external/apis/geofencing.ts — Geofencing API Configuration
// =============================================================================

import { ExternalApiConfig } from '../../types';
import { ConfigService } from '../../config/config.service';

export function createGeofencingApi(config: ConfigService): ExternalApiConfig {
  return {
    name: 'geofencing',
    displayName: 'Geofencing API',
    baseUrl: config.external.geofencing.url,
    authType: 'bearer',
    authHeader: 'Authorization',
    authValue: config.external.geofencing.key,
    timeout: 10_000,
    rateLimit: { windowMs: 60_000, max: 50 },
    healthEndpoint: '/health',
  };
}
