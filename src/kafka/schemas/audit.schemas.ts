// =============================================================================
// src/kafka/schemas/audit.schemas.ts — Audit log event schema
// =============================================================================

import { z } from 'zod';

export const AuditLogEventSchema = z.object({
  tribeId: z.string(),
  method: z.string(),
  path: z.string(),
  statusCode: z.number(),
  durationMs: z.number(),
  ip: z.string(),
  correlationId: z.string().optional(),
  targetServiceId: z.string().optional(),
});
export type AuditLogEvent = z.infer<typeof AuditLogEventSchema>;
