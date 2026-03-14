// =============================================================================
// src/auth/token-store.service.ts — Redis-backed refresh token store
// =============================================================================
// Persists refresh tokens in Redis with configurable TTL.
// Supports atomic revocation (single token) and session-wide revocation.
//
// KEY PATTERNS:
//   refresh:{jti}       — refresh token payload JSON; TTL = REDIS_TOKEN_TTL_SECONDS
//   session:{sub}       — JSON array of active JTIs for a subject; TTL = REDIS_SESSION_TTL_SECONDS
//
// When Vault is unavailable, the store continues to work — refresh token
// storage is independent of key management.
// =============================================================================

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { LoggerService } from '../shared/logger.service';
import { ConfigService } from '../config/config.service';

/** Stored refresh token payload */
export interface RefreshTokenRecord {
  jti: string;
  sub: string;
  tribeId: string;
  issuedAt: number;
  expiresAt: number;
  scopes: string[];
  permissions: string[];
}

@Injectable()
export class TokenStoreService implements OnModuleInit, OnModuleDestroy {
  private redis: Redis | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly logger: LoggerService,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async onModuleInit(): Promise<void> {
    try {
      this.redis = new Redis(this.config.redis.cacheUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => Math.min(times * 200, 3_000),
      });

      await this.redis.connect();
      this.logger.log('TokenStoreService: Connected to Redis (cache)', 'TokenStoreService');
    } catch (err) {
      this.logger.warn(
        `TokenStoreService: Redis unavailable — refresh token persistence disabled: ${(err as Error).message}`,
        'TokenStoreService',
      );
      this.redis = null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
    }
  }

  // ---------------------------------------------------------------------------
  // Store / retrieve
  // ---------------------------------------------------------------------------

  /**
   * Persist a refresh token record with TTL.
   *
   * @param record — token metadata to store (never the raw JWT)
   */
  async store(record: RefreshTokenRecord): Promise<void> {
    if (!this.redis) return;

    const ttlSeconds = this.config.redis.tokenTtlSeconds;
    const key = this.refreshKey(record.jti);

    await this.redis.setex(key, ttlSeconds, JSON.stringify(record));

    // Update session index so we can revoke all tokens for a subject
    await this.addToSession(record.sub, record.jti, ttlSeconds);

    this.logger.debug(
      `TokenStoreService: Stored refresh token jti=${record.jti} sub=${record.sub} ttl=${ttlSeconds}s`,
      'TokenStoreService',
    );
  }

  /**
   * Look up a refresh token by JTI.
   * Returns null if the token has expired or been revoked.
   */
  async get(jti: string): Promise<RefreshTokenRecord | null> {
    if (!this.redis) return null;

    const raw = await this.redis.get(this.refreshKey(jti));
    if (!raw) return null;

    try {
      return JSON.parse(raw) as RefreshTokenRecord;
    } catch {
      return null;
    }
  }

  /**
   * Check if a JTI is still valid (exists in the store and not expired).
   */
  async isValid(jti: string): Promise<boolean> {
    if (!this.redis) {
      // If Redis is unavailable, allow through (best-effort)
      return true;
    }
    const exists = await this.redis.exists(this.refreshKey(jti));
    return exists === 1;
  }

  // ---------------------------------------------------------------------------
  // Revocation
  // ---------------------------------------------------------------------------

  /**
   * Revoke a single refresh token by JTI.
   * Returns true if the token existed and was revoked, false if not found.
   */
  async revoke(jti: string): Promise<boolean> {
    if (!this.redis) return false;

    const record = await this.get(jti);
    const deleted = await this.redis.del(this.refreshKey(jti));

    if (record && deleted > 0) {
      // Remove from session index
      await this.removeFromSession(record.sub, jti);
      this.logger.log(
        `TokenStoreService: Revoked refresh token jti=${jti} sub=${record.sub}`,
        'TokenStoreService',
      );
      return true;
    }

    return false;
  }

  /**
   * Revoke ALL refresh tokens for a subject (session-wide revocation).
   * Useful for "log out everywhere" scenarios.
   */
  async revokeAllForSubject(sub: string): Promise<number> {
    if (!this.redis) return 0;

    const sessionKey = this.sessionKey(sub);
    const jtiList: string[] = await this.redis.smembers(sessionKey);

    if (jtiList.length === 0) return 0;

    // Delete all refresh token keys
    const pipeline = this.redis.pipeline();
    for (const jti of jtiList) {
      pipeline.del(this.refreshKey(jti));
    }
    pipeline.del(sessionKey);
    await pipeline.exec();

    this.logger.log(
      `TokenStoreService: Revoked ${jtiList.length} refresh token(s) for sub=${sub}`,
      'TokenStoreService',
    );

    return jtiList.length;
  }

  /**
   * List all active JTIs for a subject (for audit / admin purposes).
   */
  async listForSubject(sub: string): Promise<string[]> {
    if (!this.redis) return [];
    return this.redis.smembers(this.sessionKey(sub));
  }

  // ---------------------------------------------------------------------------
  // Session index helpers (private)
  // ---------------------------------------------------------------------------

  private async addToSession(sub: string, jti: string, tokenTtlSeconds: number): Promise<void> {
    if (!this.redis) return;
    const sessionKey = this.sessionKey(sub);
    const sessionTtl = this.config.redis.sessionTtlSeconds;

    await this.redis.sadd(sessionKey, jti);
    // Refresh the session TTL to at least the token TTL
    const currentTtl = await this.redis.ttl(sessionKey);
    if (currentTtl < tokenTtlSeconds) {
      await this.redis.expire(sessionKey, Math.max(sessionTtl, tokenTtlSeconds));
    }
  }

  private async removeFromSession(sub: string, jti: string): Promise<void> {
    if (!this.redis) return;
    await this.redis.srem(this.sessionKey(sub), jti);
  }

  // ---------------------------------------------------------------------------
  // Key helpers (private)
  // ---------------------------------------------------------------------------

  private refreshKey(jti: string): string {
    return `refresh:${jti}`;
  }

  private sessionKey(sub: string): string {
    return `session:${sub}`;
  }
}
