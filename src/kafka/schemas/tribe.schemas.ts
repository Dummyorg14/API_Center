// =============================================================================
// src/kafka/schemas/tribe.schemas.ts — Tribe inter-service event schemas
// =============================================================================

import { z } from 'zod';

export const TribeRequestEventSchema = z.object({
  sourceTribeId: z.string(),
  targetServiceId: z.string(),
  method: z.string(),
  path: z.string(),
  /** Routing namespace — 'shared' or 'tribe'. Added when namespace routing was introduced. */
  namespace: z.enum(['shared', 'tribe']).optional(),
  correlationId: z.string().optional(),
  timestamp: z.string().optional(),
});
export type TribeRequestEvent = z.infer<typeof TribeRequestEventSchema>;

export const TribeResponseEventSchema = z.object({
  sourceTribeId: z.string(),
  targetServiceId: z.string(),
  method: z.string(),
  path: z.string(),
  statusCode: z.number(),
  durationMs: z.number(),
  /** Routing namespace — 'shared' or 'tribe'. Added when namespace routing was introduced. */
  namespace: z.enum(['shared', 'tribe']).optional(),
  correlationId: z.string().optional(),
  timestamp: z.string().optional(),
});
export type TribeResponseEvent = z.infer<typeof TribeResponseEventSchema>;
