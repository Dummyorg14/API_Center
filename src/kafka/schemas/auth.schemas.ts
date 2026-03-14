// =============================================================================
// src/kafka/schemas/auth.schemas.ts — Auth lifecycle event Zod schemas
// =============================================================================

import { z } from 'zod';

/**
 * TOKEN_ISSUED — emitted after successful M2M token issuance.
 * Raw JWTs are NEVER included in Kafka events.
 */
export const TokenIssuedEventSchema = z.object({
  tribeId: z.string(),
  sub: z.string(),
  scopes: z.array(z.string()),
  permissions: z.array(z.string()),
  expiresIn: z.number(),
  jti: z.string().optional(),
  correlationId: z.string().optional(),
  timestamp: z.string(),
});
export type TokenIssuedEvent = z.infer<typeof TokenIssuedEventSchema>;

/**
 * TOKEN_REFRESHED — emitted after a successful token refresh operation.
 */
export const TokenRefreshedEventSchema = z.object({
  sub: z.string(),
  tribeId: z.string().optional(),
  previousJti: z.string().optional(),
  newJti: z.string().optional(),
  expiresIn: z.number(),
  correlationId: z.string().optional(),
  timestamp: z.string(),
});
export type TokenRefreshedEvent = z.infer<typeof TokenRefreshedEventSchema>;

/**
 * TOKEN_REVOKED — emitted when a refresh token (or session) is revoked.
 */
export const TokenRevokedEventSchema = z.object({
  sub: z.string(),
  jti: z.string().optional(),
  revokedCount: z.number().default(1),
  reason: z.enum(['explicit', 'session-wide', 'expiry']).default('explicit'),
  correlationId: z.string().optional(),
  timestamp: z.string(),
});
export type TokenRevokedEvent = z.infer<typeof TokenRevokedEventSchema>;
