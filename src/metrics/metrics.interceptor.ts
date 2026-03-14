// =============================================================================
// src/metrics/metrics.interceptor.ts — HTTP metrics collection interceptor
// =============================================================================
// NestJS interceptor that records http_requests_total and
// http_request_duration_seconds for every request.
// =============================================================================

import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request, Response } from 'express';
import { MetricsService } from './metrics.service';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const start = Date.now();

    // Normalize the route to avoid high-cardinality labels
    const route = request.route?.path || request.path || 'unknown';
    const method = request.method;

    return next.handle().pipe(
      tap({
        next: () => {
          const durationSec = (Date.now() - start) / 1000;
          this.metrics.recordHttpRequest(method, route, response.statusCode, durationSec);
        },
        error: () => {
          const durationSec = (Date.now() - start) / 1000;
          this.metrics.recordHttpRequest(method, route, response.statusCode || 500, durationSec);
        },
      }),
    );
  }
}
