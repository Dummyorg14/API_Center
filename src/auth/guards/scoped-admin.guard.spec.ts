// =============================================================================
// Unit tests — ScopedAdminGuard (dual-mode admin authentication)
// =============================================================================
// Tests are provider-agnostic — they mock AuthService, not Descope directly.
// This ensures the guard works identically regardless of whether the active
// provider is KeycloakProvider or DevJwtProvider.
// =============================================================================

import { ExecutionContext } from '@nestjs/common';
import { ScopedAdminGuard } from './scoped-admin.guard';
import { ConfigService } from '../../config/config.service';
import { AuthService } from '../auth.service';
import { LoggerService } from '../../shared/logger.service';
import { UnauthorizedError } from '../../shared/errors';

// ── Mocks ────────────────────────────────────────────────────────────────────
const mockConfig = {
  platformAdminSecret: 'test-secret-123',
} as Partial<ConfigService>;

const mockAuth = {
  validateToken: jest.fn(),
  mergeCallerScopes: jest.fn((claims: Record<string, unknown>) => [
    ...((claims['scopes'] as string[]) ?? []),
    ...((claims['permissions'] as string[]) ?? []),
  ]),
} as Partial<AuthService>;

const mockLogger = {
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as Partial<LoggerService>;

function createMockContext(headers: Record<string, string> = {}): ExecutionContext {
  const request = {
    headers,
    ip: '127.0.0.1',
    path: '/api/v1/registry/services',
  };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

// ── Tests ────────────────────────────────────────────────────────────────────
describe('ScopedAdminGuard', () => {
  let guard: ScopedAdminGuard;

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new ScopedAdminGuard(
      mockConfig as ConfigService,
      mockAuth as AuthService,
      mockLogger as LoggerService,
    );
  });

  // ── Legacy secret path ─────────────────────────────────────────────────

  it('should allow access with valid X-Platform-Secret', async () => {
    const ctx = createMockContext({ 'x-platform-secret': 'test-secret-123' });
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  it('should reject access with invalid X-Platform-Secret and no JWT', async () => {
    const ctx = createMockContext({ 'x-platform-secret': 'wrong-secret' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedError);
  });

  // ── JWT scope path ─────────────────────────────────────────────────────

  it('should allow access with valid JWT containing platform:admin scope', async () => {
    // AuthService.validateToken returns flat JwtClaims (not nested Descope shape)
    (mockAuth.validateToken as jest.Mock).mockResolvedValue({
      sub: 'admin-service',
      tribeId: 'admin-service',
      scopes: ['platform:admin'],
      permissions: [],
    });

    const ctx = createMockContext({ authorization: 'Bearer valid-jwt-token' });
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(mockAuth.validateToken).toHaveBeenCalledWith('valid-jwt-token');
  });

  it('should allow access with platform:admin in permissions (not scopes)', async () => {
    (mockAuth.validateToken as jest.Mock).mockResolvedValue({
      sub: 'admin-service',
      tribeId: 'admin-service',
      scopes: [],
      permissions: ['platform:admin'],
    });

    const ctx = createMockContext({ authorization: 'Bearer valid-jwt-token' });
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  it('should reject JWT without platform:admin scope', async () => {
    (mockAuth.validateToken as jest.Mock).mockResolvedValue({
      sub: 'some-service',
      tribeId: 'some-service',
      scopes: ['tribe:read'],
      permissions: [],
    });

    const ctx = createMockContext({ authorization: 'Bearer limited-jwt' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedError);
  });

  it('should reject expired/invalid JWT', async () => {
    (mockAuth.validateToken as jest.Mock).mockRejectedValue(
      new Error('Token expired'),
    );

    const ctx = createMockContext({ authorization: 'Bearer expired-jwt' });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedError);
  });

  // ── Dual-mode behaviour ────────────────────────────────────────────────

  it('should prefer JWT when both secret and JWT are provided', async () => {
    (mockAuth.validateToken as jest.Mock).mockResolvedValue({
      sub: 'admin-svc',
      tribeId: 'admin-svc',
      scopes: ['platform:admin'],
      permissions: [],
    });

    const ctx = createMockContext({
      'x-platform-secret': 'wrong-secret',
      authorization: 'Bearer valid-admin-jwt',
    });

    // Even with wrong secret, should succeed through JWT path
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  it('should reject when no credentials provided at all', async () => {
    const ctx = createMockContext({});
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedError);
  });

  // ── Edge case: unconfigured secret ─────────────────────────────────────

  it('should not allow empty secret to match unconfigured platformAdminSecret', async () => {
    const guardNoSecret = new ScopedAdminGuard(
      { platformAdminSecret: '' } as ConfigService,
      mockAuth as AuthService,
      mockLogger as LoggerService,
    );

    const ctx = createMockContext({ 'x-platform-secret': '' });
    await expect(guardNoSecret.canActivate(ctx)).rejects.toThrow(UnauthorizedError);
  });
});

