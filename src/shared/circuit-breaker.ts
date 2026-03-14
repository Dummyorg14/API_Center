// =============================================================================
// src/shared/circuit-breaker.ts — Circuit Breaker pattern
// =============================================================================
// Fault tolerance for external API calls in distributed systems.
//
// STATES:
//  CLOSED    → Normal operation. Requests pass through.
//  OPEN      → Too many failures. Requests are rejected instantly (fail-fast).
//  HALF_OPEN → After cooldown, one test request is allowed through.
//
// OBSERVABILITY:
//  - onStateChange callback is invoked on every transition (used for Kafka
//    events and Prometheus gauge updates).
// =============================================================================

import { LoggerService } from './logger.service';

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export type CircuitStateChangeHandler = (
  name: string,
  from: CircuitState,
  to: CircuitState,
) => void;

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
  successThreshold?: number;
  onStateChange?: CircuitStateChangeHandler;
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private readonly name: string;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly successThreshold: number;
  private readonly logger: LoggerService;
  private readonly onStateChange?: CircuitStateChangeHandler;

  constructor(name: string, logger: LoggerService, options: CircuitBreakerOptions = {}) {
    this.name = name;
    this.logger = logger;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30000;
    this.successThreshold = options.successThreshold ?? 2;
    this.onStateChange = options.onStateChange;
  }

  getName(): string {
    return this.name;
  }

  getState(): CircuitState {
    return this.state;
  }

  /**
   * Manually reset the circuit breaker back to CLOSED.
   * Used by the admin endpoint POST /admin/circuit-breakers/:apiName/reset.
   */
  reset(): void {
    const previous = this.state;
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
    this.logger.log(`Circuit breaker [${this.name}] manually RESET to CLOSED`, 'CircuitBreaker');
    if (previous !== CircuitState.CLOSED && this.onStateChange) {
      this.onStateChange(this.name, previous, CircuitState.CLOSED);
    }
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
        const previous = this.state;
        this.state = CircuitState.HALF_OPEN;
        this.successCount = 0;
        this.logger.log(`Circuit breaker [${this.name}] transitioning to HALF_OPEN`, 'CircuitBreaker');
        if (this.onStateChange) {
          this.onStateChange(this.name, previous, CircuitState.HALF_OPEN);
        }
      } else {
        throw new Error(`Circuit breaker [${this.name}] is OPEN — request rejected`);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  /**
   * Check whether a request can proceed through the circuit breaker.
   * Returns `false` when the circuit is OPEN and the cooldown has not elapsed
   * (fail-fast). Transitions OPEN → HALF_OPEN when the cooldown period passes.
   *
   * Use this instead of `execute()` for event-based / streaming flows
   * (e.g. http-proxy-middleware) where the operation cannot be wrapped in a
   * single Promise.
   */
  tryAcquire(): boolean {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
        const previous = this.state;
        this.state = CircuitState.HALF_OPEN;
        this.successCount = 0;
        this.logger.log(
          `Circuit breaker [${this.name}] transitioning to HALF_OPEN`,
          'CircuitBreaker',
        );
        if (this.onStateChange) {
          this.onStateChange(this.name, previous, CircuitState.HALF_OPEN);
        }
        return true;
      }
      return false;
    }
    return true;
  }

  /** Record a successful upstream response (use with `tryAcquire`). */
  recordSuccess(): void {
    this.onSuccess();
  }

  /** Record a failed upstream response — timeout, 502/503/504, connection error (use with `tryAcquire`). */
  recordFailure(): void {
    this.onFailure();
  }

  private onSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        const previous = this.state;
        this.state = CircuitState.CLOSED;
        this.failureCount = 0;
        this.successCount = 0;
        this.logger.log(`Circuit breaker [${this.name}] CLOSED (recovered)`, 'CircuitBreaker');
        if (this.onStateChange) {
          this.onStateChange(this.name, previous, CircuitState.CLOSED);
        }
      }
    } else {
      this.failureCount = 0;
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === CircuitState.HALF_OPEN) {
      const previous = this.state;
      this.state = CircuitState.OPEN;
      this.logger.warn(`Circuit breaker [${this.name}] re-OPENED from HALF_OPEN`);
      if (this.onStateChange) {
        this.onStateChange(this.name, previous, CircuitState.OPEN);
      }
    } else if (this.failureCount >= this.failureThreshold) {
      const previous = this.state;
      this.state = CircuitState.OPEN;
      this.logger.warn(`Circuit breaker [${this.name}] OPENED after ${this.failureCount} failures`);
      if (this.onStateChange) {
        this.onStateChange(this.name, previous, CircuitState.OPEN);
      }
    }
  }

  getStats() {
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime
        ? new Date(this.lastFailureTime).toISOString()
        : null,
    };
  }
}
