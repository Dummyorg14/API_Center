// =============================================================================
// Unit tests — AuthController
// =============================================================================
// Verifies token issuance and refresh endpoints, including the fix
// that both responses now include `refreshToken`.
// Tests are provider-agnostic — they mock AuthService, not Descope directly.
// =============================================================================

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RegistryService } from '../registry/registry.service';
import { LoggerService } from '../shared/logger.service';
import { KafkaService } from '../kafka/kafka.service';
import type { GoogleProvider } from './providers/google.provider';
import { ConfigService } from '../config/config.service';
import { NotFoundError, UnauthorizedError } from '../shared/errors';
import { AuthenticatedRequest } from '../types';

jest.mock('./providers/google.provider', () => {
  class GoogleProvider {
    buildAuthorizationUrl = jest.fn();
    exchangeCode = jest.fn();
  }
  return { GoogleProvider };
});

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockAuth: Partial<AuthService> = {
  issueToken: jest.fn(),
  refreshToken: jest.fn(),
  getJwksJson: jest.fn(),
};

const mockRegistry: Partial<RegistryService> = {
  get: jest.fn(),
  validateSecret: jest.fn(),
};

const mockLogger: Partial<LoggerService> = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

const mockKafka: Partial<KafkaService> = {
  publish: jest.fn().mockResolvedValue(undefined),
};

const mockGoogleProvider: Partial<GoogleProvider> = {
  buildAuthorizationUrl: jest.fn(),
  exchangeCode: jest.fn(),
};

const mockConfig: Partial<ConfigService> = {
  google: {
    redirectUri: 'http://localhost:3000/api/v1/auth/google/callback',
  },
} as ConfigService;

function fakeReq(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return { correlationId: 'corr-1', ...overrides } as AuthenticatedRequest;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AuthController', () => {
  let controller: AuthController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new AuthController(
      mockAuth as AuthService,
      mockRegistry as RegistryService,
      mockLogger as LoggerService,
      mockKafka as KafkaService,
      mockGoogleProvider as GoogleProvider,
      mockConfig as ConfigService,
    );
  });

  // =========================================================================
  // POST /auth/token
  // =========================================================================

  describe('issueToken()', () => {
    const dto = { tribeId: 'svc-alpha', secret: 's3cret' };

    it('returns accessToken AND refreshToken', async () => {
      (mockRegistry.get as jest.Mock).mockReturnValue({
        serviceId: 'svc-alpha',
        requiredScopes: ['read'],
        consumes: [],
      });
      (mockRegistry.validateSecret as jest.Mock).mockResolvedValue(true);
      // AuthService.issueToken returns IssuedToken shape
      (mockAuth.issueToken as jest.Mock).mockResolvedValue({
        accessToken: 'access-jwt',
        refreshToken: 'refresh-jwt',
        expiresIn: 3600,
      });

      const result = await controller.issueToken(dto, fakeReq());

      expect(result.success).toBe(true);
      expect(result.data.accessToken).toBe('access-jwt');
      expect(result.data.refreshToken).toBe('refresh-jwt');
      expect(result.data.expiresIn).toBe(3600);
    });

    it('returns refreshToken as null when provider omits it', async () => {
      (mockRegistry.get as jest.Mock).mockReturnValue({
        serviceId: 'svc-alpha',
        requiredScopes: [],
        consumes: [],
      });
      (mockRegistry.validateSecret as jest.Mock).mockResolvedValue(true);
      (mockAuth.issueToken as jest.Mock).mockResolvedValue({
        accessToken: 'access-jwt',
        refreshToken: null,
        expiresIn: 3600,
      });

      const result = await controller.issueToken(dto, fakeReq());
      expect(result.data.refreshToken).toBeNull();
    });

    it('throws NotFoundError for unknown tribe', async () => {
      (mockRegistry.get as jest.Mock).mockReturnValue(null);

      await expect(controller.issueToken(dto, fakeReq())).rejects.toThrow(NotFoundError);
    });

    it('throws UnauthorizedError for invalid secret', async () => {
      (mockRegistry.get as jest.Mock).mockReturnValue({ serviceId: 'svc-alpha' });
      (mockRegistry.validateSecret as jest.Mock).mockResolvedValue(false);

      await expect(controller.issueToken(dto, fakeReq())).rejects.toThrow(UnauthorizedError);
    });

    it('publishes TOKEN_ISSUED Kafka event (without raw JWT)', async () => {
      (mockRegistry.get as jest.Mock).mockReturnValue({
        serviceId: 'svc-alpha',
        requiredScopes: ['read'],
        consumes: [],
      });
      (mockRegistry.validateSecret as jest.Mock).mockResolvedValue(true);
      (mockAuth.issueToken as jest.Mock).mockResolvedValue({
        accessToken: 'access-jwt',
        refreshToken: 'refresh-jwt',
        expiresIn: 3600,
      });

      await controller.issueToken(dto, fakeReq());

      expect(mockKafka.publish).toHaveBeenCalledTimes(1);
      const [topic, payload, key] = (mockKafka.publish as jest.Mock).mock.calls[0];
      expect(topic).toBe('api-center.auth.token-issued');
      expect(key).toBe('svc-alpha');
      expect(payload.tribeId).toBe('svc-alpha');
      expect(payload.scopes).toEqual(['read']);
      expect(payload.permissions).toEqual(expect.arrayContaining(['tribe:svc-alpha:read']));
      expect(payload.expiresIn).toBe(3600);
      expect(payload.timestamp).toBeDefined();
      // Raw JWT must NEVER appear in the event
      expect(JSON.stringify(payload)).not.toContain('access-jwt');
      expect(JSON.stringify(payload)).not.toContain('refresh-jwt');
    });
  });

  // =========================================================================
  // POST /auth/token/refresh
  // =========================================================================

  describe('refreshToken()', () => {
    it('returns accessToken AND refreshToken', async () => {
      (mockAuth.refreshToken as jest.Mock).mockResolvedValue({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresIn: 3600,
      });

      const result = await controller.refreshToken(
        { refreshToken: 'old-refresh' },
        fakeReq(),
      );

      expect(result.data.accessToken).toBe('new-access');
      expect(result.data.refreshToken).toBe('new-refresh');
    });

    it('returns refreshToken as null when provider omits it', async () => {
      (mockAuth.refreshToken as jest.Mock).mockResolvedValue({
        accessToken: 'new-access',
        refreshToken: null,
        expiresIn: 3600,
      });

      const result = await controller.refreshToken(
        { refreshToken: 'old-refresh' },
        fakeReq(),
      );

      expect(result.data.refreshToken).toBeNull();
    });
  });

  // =========================================================================
  // GET /auth/.well-known/jwks.json
  // =========================================================================

  describe('getJwks()', () => {
    it('returns JWKS when provider supports in-process JWKS (DevJwtProvider)', () => {
      const mockJwks = { keys: [{ kty: 'RSA', kid: 'dev-key-1', use: 'sig', alg: 'RS256' }] };
      (mockAuth.getJwksJson as jest.Mock).mockReturnValue(mockJwks);

      const result = controller.getJwks();
      expect(result).toEqual(mockJwks);
    });

    it('throws NotFoundException when provider does not serve JWKS (KeycloakProvider)', () => {
      (mockAuth.getJwksJson as jest.Mock).mockReturnValue(null);

      expect(() => controller.getJwks()).toThrow();
    });
  });
});

