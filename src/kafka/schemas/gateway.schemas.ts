// =============================================================================
// src/kafka/schemas/gateway.schemas.ts — Gateway event schemas
// =============================================================================

import { z } from 'zod';

export const GatewayRequestEventSchema = z.object({
  method: z.string(),
  path: z.string(),
  tribeId: z.string().optional(),
  ip: z.string().optional(),
  correlationId: z.string().optional(),
  timestamp: z.string().optional(),
});
export type GatewayRequestEvent = z.infer<typeof GatewayRequestEventSchema>;

export const GatewayResponseEventSchema = z.object({
  method: z.string().optional(),
  path: z.string().optional(),
  statusCode: z.number().optional(),
  durationMs: z.number().optional(),
  tribeId: z.string().optional(),
  correlationId: z.string().optional(),
  timestamp: z.string().optional(),
  // Circuit breaker recovery events
  event: z.string().optional(),
  apiName: z.string().optional(),
  previousState: z.string().optional(),
});
export type GatewayResponseEvent = z.infer<typeof GatewayResponseEventSchema>;

export const GatewayErrorEventSchema = z.object({
  method: z.string().optional(),
  path: z.string().optional(),
  error: z.string().optional(),
  statusCode: z.number().optional(),
  tribeId: z.string().optional(),
  correlationId: z.string().optional(),
  timestamp: z.string().optional(),
  // Circuit breaker open events
  event: z.string().optional(),
  apiName: z.string().optional(),
  previousState: z.string().optional(),
});
export type GatewayErrorEvent = z.infer<typeof GatewayErrorEventSchema>;
