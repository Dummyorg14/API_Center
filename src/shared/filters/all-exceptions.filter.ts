// =============================================================================
// src/shared/filters/all-exceptions.filter.ts — Global exception filter
// =============================================================================
// NestJS exception filter that catches all unhandled errors.
//
// REPLACES: Express's errorHandler middleware (must have 4 params).
// NestJS ADVANTAGE: Filters are type-safe, support DI, and can be scoped
// to controllers, methods, or the entire app.
//
// Handles:
//  - AppError subclasses (operational errors we threw intentionally)
//  - NestJS HttpException (from ValidationPipe, ThrottlerGuard, etc.)
//  - Unexpected errors (bugs, unhandled exceptions)
// =============================================================================

import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AppError } from '../errors';
import { LoggerService } from '../logger.service';
import { ConfigService } from '../../config/config.service';
import { AuthenticatedRequest } from '../../types';

@Injectable()
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const correlationId = (request as AuthenticatedRequest).correlationId;

    // --- NestJS HttpException (includes ValidationPipe errors, throttle, etc.) ---
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      // Handle class-validator errors from ValidationPipe
      if (typeof exceptionResponse === 'object' && 'message' in (exceptionResponse as Record<string, unknown>)) {
        const resp = exceptionResponse as Record<string, unknown>;
        const messages = Array.isArray(resp.message) ? resp.message : [resp.message];

        // AppError subclasses have a `code` property
        const code = exception instanceof AppError
          ? exception.code
          : (resp.error as string || 'HTTP_ERROR');

        this.logger.warn(`HTTP ${status}: ${messages.join(', ')}`, 'ExceptionFilter');

        response.status(status).json({
          success: false,
          error: {
            code,
            message: messages.length === 1 ? messages[0] : 'Validation failed',
            ...(messages.length > 1 && { details: messages }),
          },
          meta: { timestamp: new Date().toISOString(), correlationId },
        });
        return;
      }

      response.status(status).json({
        success: false,
        error: {
          code: 'HTTP_ERROR',
          message: exception.message,
        },
        meta: { timestamp: new Date().toISOString(), correlationId },
      });
      return;
    }

    // --- Unexpected errors (bugs) ---
    const err = exception as Error;
    this.logger.error(
      `Unexpected error: ${err?.message || 'Unknown error'}`,
      err?.stack,
      'ExceptionFilter',
    );

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: this.config.isProduction
          ? 'An unexpected error occurred'
          : err?.message || 'Internal server error',
        ...(!this.config.isProduction && { stack: err?.stack }),
      },
      meta: { timestamp: new Date().toISOString(), correlationId },
    });
  }
}
