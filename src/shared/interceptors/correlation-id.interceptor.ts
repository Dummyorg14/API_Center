// =============================================================================
// src/shared/interceptors/correlation-id.interceptor.ts — Distributed tracing
// =============================================================================
// NestJS interceptor that assigns a unique correlation ID to every request.
//
// REPLACES: Express correlationId middleware
// NestJS ADVANTAGE: Interceptors wrap the execution pipeline and can modify
// both the request and response. They support DI and are testable.
//
// The correlation ID is:
//  1. Read from incoming X-Correlation-ID header (if the client sent one)
//  2. Or auto-generated as a UUID v4
//  3. Attached to req.correlationId for use in controllers/services
//  4. Set on the response X-Correlation-ID header
// =============================================================================

import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { Request, Response } from 'express';
import crypto from 'node:crypto';
import { trace } from '@opentelemetry/api';
import { AuthenticatedRequest } from '../../types';

@Injectable()
export class CorrelationIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    // Use existing header or generate a new UUID
    const id = (request.headers['x-correlation-id'] as string) || crypto.randomUUID();

    // Attach to request for downstream use
    (request as AuthenticatedRequest).correlationId = id;

    // Set on response so the caller can correlate
    response.setHeader('X-Correlation-ID', id);

    // Attach correlation ID to the active OpenTelemetry span
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      activeSpan.setAttribute('correlation.id', id);
      activeSpan.setAttribute('http.route', request.path);
    }

    return next.handle();
  }
}
