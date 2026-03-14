// =============================================================================
// src/kafka/topics.ts — Centralized Kafka topic definitions
// =============================================================================

export const TOPICS = {
  // ---- API Gateway lifecycle events ----
  GATEWAY_REQUEST: 'api-center.gateway.request',
  GATEWAY_RESPONSE: 'api-center.gateway.response',
  GATEWAY_ERROR: 'api-center.gateway.error',

  // ---- Tribe-to-tribe communication ----
  TRIBE_REQUEST: 'api-center.tribe.request',
  TRIBE_RESPONSE: 'api-center.tribe.response',

  // ---- External API events ----
  EXTERNAL_REQUEST: 'api-center.external.request',

  // ---- Audit / Observability ----
  AUDIT_LOG: 'api-center.audit.log',

  // ---- Service Registry events ----
  SERVICE_REGISTERED: 'api-center.registry.service-registered',
  SERVICE_DEREGISTERED: 'api-center.registry.service-deregistered',
  SERVICE_DEPRECATED: 'api-center.registry.service-deprecated',
  SERVICE_RETIRED: 'api-center.registry.service-retired',
  SERVICE_VERSION_CHANGED: 'api-center.registry.service-version-changed',
  SERVICE_HEALTH_CHANGED: 'api-center.registry.service-health-changed',

  // ---- Auth lifecycle events ----
  /** Emitted on successful M2M token issuance (raw JWT never included) */
  TOKEN_ISSUED: 'api-center.auth.token-issued',
  /** Emitted on successful token refresh */
  TOKEN_REFRESHED: 'api-center.auth.token-refreshed',
  /** Emitted on token revocation (single or session-wide) */
  TOKEN_REVOKED: 'api-center.auth.token-revoked',

  // ---- Reserved (defined but not yet wired) ----
  /** @reserved Cross-tribe pub/sub events (planned) */
  TRIBE_EVENT: 'api-center.tribe.event',
  /** @reserved External API response logging (planned) */
  EXTERNAL_RESPONSE: 'api-center.external.response',
  /** @reserved Inbound webhook forwarding (planned) */
  EXTERNAL_WEBHOOK: 'api-center.external.webhook',
} as const;

export type TopicName = (typeof TOPICS)[keyof typeof TOPICS];
