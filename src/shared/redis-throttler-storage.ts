// =============================================================================
// src/shared/redis-throttler-storage.ts — Redis-backed ThrottlerStorage
// =============================================================================
// Implements the @nestjs/throttler ThrottlerStorage interface using ioredis.
// Allows distributed rate limiting across multiple API Center instances.
//
// STORAGE DESIGN:
//  Each throttle key uses two Redis keys:
//    - `throttle:{key}:hits`  — counter with TTL for request count
//    - `throttle:{key}:block` — flag key set when limit is exceeded
//
// Falls back to a simple in-memory Map if Redis is unavailable.
// =============================================================================

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import Redis from 'ioredis';
import { ConfigService } from '../config/config.service';
import { LoggerService } from './logger.service';

interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage, OnModuleInit, OnModuleDestroy {
  private redis: Redis | null = null;
  /** Fallback in-memory store when Redis is unavailable */
  private readonly memoryStore = new Map<string, { hits: number; expiresAt: number; blockedUntil: number }>();

  constructor(
    private readonly config: ConfigService,
    private readonly logger: LoggerService,
  ) {}

  async onModuleInit() {
    try {
      this.redis = new Redis(this.config.redis.rateLimitUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => Math.min(times * 200, 3000),
        enableOfflineQueue: false,
      });

      await this.redis.connect();
      this.logger.log('Throttler connected to Redis (rate-limit)', 'RedisThrottlerStorage');
    } catch (err) {
      this.logger.warn(
        `Throttler Redis unavailable — falling back to in-memory storage: ${(err as Error).message}`,
        'RedisThrottlerStorage',
      );
      this.redis = null;
    }
  }

  async onModuleDestroy() {
    if (this.redis) {
      await this.redis.quit();
    }
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    _throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    if (this.redis) {
      return this.redisIncrement(key, ttl, limit, blockDuration);
    }
    return this.memoryIncrement(key, ttl, limit, blockDuration);
  }

  // ── Redis implementation ─────────────────────────────────────────────────

  private async redisIncrement(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
  ): Promise<ThrottlerStorageRecord> {
    const hitsKey = `throttle:${key}:hits`;
    const blockKey = `throttle:${key}:block`;
    const ttlSec = Math.ceil(ttl / 1000);

    // Check if currently blocked
    const blockTtl = await this.redis!.ttl(blockKey);
    if (blockTtl > 0) {
      return {
        totalHits: limit + 1,
        timeToExpire: blockTtl * 1000,
        isBlocked: true,
        timeToBlockExpire: blockTtl * 1000,
      };
    }

    // Increment hit counter
    const hits = await this.redis!.incr(hitsKey);
    if (hits === 1) {
      await this.redis!.expire(hitsKey, ttlSec);
    }

    const remainingTtl = await this.redis!.ttl(hitsKey);

    // Block if limit exceeded
    if (hits > limit && blockDuration > 0) {
      const blockSec = Math.ceil(blockDuration / 1000);
      await this.redis!.setex(blockKey, blockSec, '1');
      return {
        totalHits: hits,
        timeToExpire: remainingTtl * 1000,
        isBlocked: true,
        timeToBlockExpire: blockDuration,
      };
    }

    return {
      totalHits: hits,
      timeToExpire: remainingTtl * 1000,
      isBlocked: false,
      timeToBlockExpire: 0,
    };
  }

  // ── In-memory fallback ───────────────────────────────────────────────────

  private memoryIncrement(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
  ): ThrottlerStorageRecord {
    const now = Date.now();

    // Clean expired entry
    const existing = this.memoryStore.get(key);
    if (existing && existing.expiresAt <= now) {
      this.memoryStore.delete(key);
    }

    // Check if blocked
    if (existing && existing.blockedUntil > now) {
      return {
        totalHits: limit + 1,
        timeToExpire: existing.blockedUntil - now,
        isBlocked: true,
        timeToBlockExpire: existing.blockedUntil - now,
      };
    }

    const entry = this.memoryStore.get(key) || { hits: 0, expiresAt: now + ttl, blockedUntil: 0 };
    entry.hits++;

    if (entry.hits > limit && blockDuration > 0) {
      entry.blockedUntil = now + blockDuration;
      this.memoryStore.set(key, entry);
      return {
        totalHits: entry.hits,
        timeToExpire: entry.expiresAt - now,
        isBlocked: true,
        timeToBlockExpire: blockDuration,
      };
    }

    this.memoryStore.set(key, entry);
    return {
      totalHits: entry.hits,
      timeToExpire: entry.expiresAt - now,
      isBlocked: false,
      timeToBlockExpire: 0,
    };
  }
}
