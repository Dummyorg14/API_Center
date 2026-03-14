// =============================================================================
// src/shared/interceptors/audit-log.interceptor.ts — Request audit logging
// =============================================================================
// NestJS interceptor that publishes an audit log event to Kafka after
// every response is sent.
//
// REPLACES: Express auditLogger middleware
// NestJS ADVANTAGE: Interceptors can tap into the response observable,
// making it easy to capture response metadata (status, duration).
// =============================================================================

import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { Request, Response } from 'express';
import { KafkaService } from '../../kafka/kafka.service';
import { TOPICS } from '../../kafka/topics';
import { AuthenticatedRequest } from '../../types';
import { LoggerService } from '../logger.service';

@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  constructor(
    private readonly kafka: KafkaService,
    private readonly logger: LoggerService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const start = Date.now();

    return next.handle().pipe(
      tap({
        next: () => this.publishAudit(request, response, start),
        error: () => this.publishAudit(request, response, start),
      }),
    );
  }

  private publishAudit(request: Request, response: Response, start: number) {
    const authReq = request as AuthenticatedRequest;

    // Extract the target service from tribe proxy URLs  /api/v1/tribes/:targetServiceId/*
    const pathParts = request.originalUrl.split('/');
    const tribesIdx = pathParts.indexOf('tribes');
    const targetServiceId = tribesIdx >= 0 ? pathParts[tribesIdx + 1] : undefined;

    this.kafka
      .publish(TOPICS.AUDIT_LOG, {
        tribeId: authReq.tribeId || 'anonymous',
        method: request.method,
        path: request.originalUrl,
        statusCode: response.statusCode,
        durationMs: Date.now() - start,
        ip: request.ip || 'unknown',
        correlationId: authReq.correlationId,
        ...(targetServiceId && { targetServiceId }),
      }, authReq.tribeId)
      .catch((err) => {
        this.logger.debug(
          `Audit log publish failed (non-blocking): ${(err as Error).message}`,
          'AuditLogInterceptor',
        );
      });
  }
}
