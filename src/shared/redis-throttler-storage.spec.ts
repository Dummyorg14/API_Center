// =============================================================================
// Unit tests — RedisThrottlerStorage (in-memory fallback path)
// =============================================================================

import { RedisThrottlerStorage } from './redis-throttler-storage';
import { ConfigService } from '../config/config.service';
import { LoggerService } from './logger.service';

const mockConfig = {
  redis: { rateLimitUrl: 'redis://localhost:6380' },
} as Partial<ConfigService>;

const mockLogger = {
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as Partial<LoggerService>;

describe('RedisThrottlerStorage (in-memory fallback)', () => {
  let storage: RedisThrottlerStorage;

  beforeEach(() => {
    storage = new RedisThrottlerStorage(
      mockConfig as ConfigService,
      mockLogger as LoggerService,
    );
    // Don't call onModuleInit — this simulates Redis being unavailable
  });

  it('should allow requests within the limit', async () => {
    const result = await storage.increment('test-key', 60000, 5, 0, 'default');
    expect(result.totalHits).toBe(1);
    expect(result.isBlocked).toBe(false);
  });

  it('should count multiple hits', async () => {
    await storage.increment('counter-key', 60000, 5, 0, 'default');
    await storage.increment('counter-key', 60000, 5, 0, 'default');
    const result = await storage.increment('counter-key', 60000, 5, 0, 'default');
    expect(result.totalHits).toBe(3);
    expect(result.isBlocked).toBe(false);
  });

  it('should block when limit exceeded with blockDuration', async () => {
    const limit = 2;
    const blockDuration = 10000;

    await storage.increment('block-key', 60000, limit, blockDuration, 'default');
    await storage.increment('block-key', 60000, limit, blockDuration, 'default');
    const result = await storage.increment('block-key', 60000, limit, blockDuration, 'default');

    expect(result.totalHits).toBeGreaterThan(limit);
    expect(result.isBlocked).toBe(true);
    expect(result.timeToBlockExpire).toBe(blockDuration);
  });

  it('should track different keys independently', async () => {
    await storage.increment('key-a', 60000, 5, 0, 'default');
    await storage.increment('key-a', 60000, 5, 0, 'default');
    const resultA = await storage.increment('key-a', 60000, 5, 0, 'default');
    const resultB = await storage.increment('key-b', 60000, 5, 0, 'default');

    expect(resultA.totalHits).toBe(3);
    expect(resultB.totalHits).toBe(1);
  });
});
