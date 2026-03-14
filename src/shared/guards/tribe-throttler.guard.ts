// =============================================================================
// src/shared/guards/tribe-throttler.guard.ts — Per-Tribe Rate Limiting
// =============================================================================
// Custom ThrottlerGuard that buckets rate-limit counters by **tribe ID**
// instead of by client IP.  This prevents a "noisy neighbor" tribe from
// exhausting the global rate-limit pool and starving other tribes.
//
// Tracker resolution order:
//  1. `x-tribe-id` request header  (set by gateway / proxy)
//  2. `req.user.tribeId`           (from JWT claims via req.user after JwtAuthGuard)
//  3. Client IP                    (anonymous / unauthenticated fallback)
// =============================================================================

import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

@Injectable()
export class TribeThrottlerGuard extends ThrottlerGuard {
  /**
   * Return a unique key that the throttler uses to bucket request counts.
   * By keying on the tribe ID we isolate each tribe's rate-limit pool.
   */
  protected async getTracker(req: Record<string, any>): Promise<string> {
    // 1. Explicit header (already set by the proxy layer for downstream calls)
    const headerTribeId = req.headers?.['x-tribe-id'];
    if (headerTribeId) return String(headerTribeId);

    // 2. tribeId claim attached by JwtAuthGuard → req.user (JwtClaims shape)
    const user = req.user as Record<string, any> | undefined;
    if (user?.tribeId) return String(user.tribeId);

    // 3. Fallback to IP for unauthenticated or anonymous callers
    return req.ip ?? req.connection?.remoteAddress ?? 'unknown';
  }
}
