// =============================================================================
// src/shared/middleware/security.middleware.ts — Security hardening middleware
// =============================================================================
// Express-level middleware that runs BEFORE NestJS guards, interceptors, pipes.
//
// CORS NOTE:
//   This middleware does NOT set CORS headers — that is handled at two layers:
//     1. NGINX (nginx.conf):  OPTIONS preflight answered before Node is called
//     2. NestJS (main.ts):    app.enableCors() adds headers on all responses
//   This middleware only enforces payload size limits and strips leaky headers.
//   Do NOT add Access-Control-* headers here to avoid duplicating with NestJS.
// =============================================================================

import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { LoggerService } from '../logger.service';

/** Maximum accepted Content-Length before rejecting with 413. */
const MAX_REQUEST_BYTES = 5 * 1024 * 1024; // 5 MB

@Injectable()
export class SecurityMiddleware implements NestMiddleware {
  constructor(private readonly logger: LoggerService) {}

  use(req: Request, res: Response, next: NextFunction) {
    // ── Reject oversized payloads early ──────────────────────────────────────
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    if (contentLength > MAX_REQUEST_BYTES) {
      this.logger.warn(
        `Payload too large: ${contentLength} bytes from ${req.ip}`,
        'SecurityMiddleware',
      );
      res.status(413).json({
        success: false,
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request payload exceeds 5 MB limit' },
      });
      return;
    }

    // ── Strip headers that reveal implementation details ──────────────────────
    res.removeHeader('X-Powered-By');
    res.removeHeader('Server');

    // ── Cache control ─────────────────────────────────────────────────────────
    // Prevent API responses from being cached by intermediaries.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma',        'no-cache');
    res.setHeader('Expires',       '0');

    // ── Vary: Origin — required for correct CORS caching ─────────────────────
    // Tells CDNs and proxies that responses vary by Origin header.
    // Essential when Access-Control-Allow-Origin uses the request origin
    // (not a wildcard) so responses for one origin are not served to another.
    res.setHeader('Vary', 'Origin, Accept-Encoding');

    // ── Additional security headers ───────────────────────────────────────────
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options',        'DENY');

    next();
  }
}
