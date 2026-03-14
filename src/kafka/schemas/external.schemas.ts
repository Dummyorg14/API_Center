// =============================================================================
// src/kafka/schemas/external.schemas.ts — External API event schemas
// =============================================================================

import { z } from 'zod';

export const ExternalRequestEventSchema = z.object({
  api: z.string(),
  method: z.string(),
  path: z.string(),
  status: z.number(),
  duration: z.number(),
  timestamp: z.string(),
});
export type ExternalRequestEvent = z.infer<typeof ExternalRequestEventSchema>;
