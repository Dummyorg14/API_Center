// =============================================================================
// src/shared/errors.ts — Standardized error classes
// =============================================================================
// Custom error classes with consistent shape (statusCode, code, message).
// NestJS has built-in HttpException, but these provide richer semantics
// and are caught by our AllExceptionsFilter.
// =============================================================================

import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Base error class for all API Center errors.
 * Extends NestJS HttpException for seamless integration with filters.
 */
export class AppError extends HttpException {
  public readonly code: string;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode: number, code: string, isOperational = true) {
    super({ message, code }, statusCode);
    this.code = code;
    this.isOperational = isOperational;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 400 — Client sent invalid data */
export class ValidationError extends AppError {
  constructor(message = 'Validation failed') {
    super(message, HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR');
  }
}

/** 401 — Missing or invalid authentication */
export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED');
  }
}

/** 403 — Authenticated but not allowed */
export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, HttpStatus.FORBIDDEN, 'FORBIDDEN');
  }
}

/** 404 — Resource does not exist */
export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, HttpStatus.NOT_FOUND, 'NOT_FOUND');
  }
}

/** 409 — Conflict with current state */
export class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super(message, HttpStatus.CONFLICT, 'CONFLICT');
  }
}

/** 429 — Rate limit exceeded */
export class RateLimitError extends AppError {
  constructor(message = 'Too many requests') {
    super(message, HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMIT_EXCEEDED');
  }
}

/** 502 — Upstream service is down */
export class BadGatewayError extends AppError {
  constructor(message = 'Upstream service unavailable') {
    super(message, HttpStatus.BAD_GATEWAY, 'BAD_GATEWAY');
  }
}

/** 503 — API Center itself is not ready */
export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable') {
    super(message, HttpStatus.SERVICE_UNAVAILABLE, 'SERVICE_UNAVAILABLE');
  }
}
