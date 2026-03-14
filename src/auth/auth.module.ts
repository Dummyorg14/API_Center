// =============================================================================
// src/auth/auth.module.ts — Authentication module
// =============================================================================
// Wires the pluggable AuthProvider, VaultService, and TokenStoreService.
//
// PROVIDER SELECTION (AUTH_PROVIDER env var):
//   keycloak  → KeycloakProvider  — production-grade OIDC/JWKS
//   dev-jwt   → DevJwtProvider    — ephemeral RS256 for local dev / CI [default]
// =============================================================================

import { Module, forwardRef } from '@nestjs/common';
import { AUTH_PROVIDER } from './auth-provider.interface';
import { KeycloakProvider } from './providers/keycloak.provider';
import { DevJwtProvider } from './providers/dev-jwt.provider';
import { GoogleProvider } from './providers/google.provider';
import { VaultService } from './vault.service';
import { TokenStoreService } from './token-store.service';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PlatformAdminGuard } from './guards/platform-admin.guard';
import { ScopedAdminGuard } from './guards/scoped-admin.guard';
import { AuthController } from './auth.controller';
import { RegistryModule } from '../registry/registry.module';
import { ConfigService } from '../config/config.service';

const authProviderFactory = {
  provide: AUTH_PROVIDER,
  inject: [ConfigService, KeycloakProvider, DevJwtProvider, GoogleProvider],
  useFactory: (
    config: ConfigService,
    keycloak: KeycloakProvider,
    devJwt: DevJwtProvider,
    google: GoogleProvider,
  ) => {
    if (config.authProvider === 'keycloak') return keycloak;
    if (config.authProvider === 'google') return google;
    return devJwt;
  },
};

@Module({
  imports: [forwardRef(() => RegistryModule)],
  controllers: [AuthController],
  providers: [
    // Vault — secret loading + Transit signing (used by providers + AuthService)
    VaultService,
    // Token store — Redis-backed refresh token lifecycle
    TokenStoreService,
    // Concrete auth providers (all instantiated; factory picks the active one)
    KeycloakProvider,
    DevJwtProvider,
    GoogleProvider,
    authProviderFactory,
    AuthService,
    JwtAuthGuard,
    PlatformAdminGuard,
    ScopedAdminGuard,
  ],
  exports: [
    AuthService,
    VaultService,
    TokenStoreService,
    JwtAuthGuard,
    PlatformAdminGuard,
    ScopedAdminGuard,
  ],
})
export class AuthModule {}
