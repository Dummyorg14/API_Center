// =============================================================================
// src/auth/vault.service.ts — HashiCorp Vault integration (KV v2 + Transit)
// =============================================================================
// Provides two Vault capabilities:
//   1. KV v2 secret reads  — loads secrets into process.env at boot
//   2. Transit engine      — performs RSA signing without exporting the key
//
// AUTHENTICATION MODES (in priority order):
//   1. AppRole  (VAULT_ROLE_ID + VAULT_SECRET_ID) — recommended for production
//   2. Token    (VAULT_TOKEN)                      — simple, good for dev
//   3. Dev mode (VAULT_DEV_MODE=true)              — Vault dev server, no unsealing
//
// When VAULT_DEV_MODE=true OR Vault is unreachable, falls back gracefully
// to process.env so local development works without any Vault setup.
// =============================================================================

import { Injectable, OnModuleInit } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { LoggerService } from '../shared/logger.service';
import { ConfigService } from '../config/config.service';

@Injectable()
export class VaultService implements OnModuleInit {
  private readonly client: AxiosInstance;
  private vaultToken: string | null = null;
  private available = false;

  constructor(
    private readonly config: ConfigService,
    private readonly logger: LoggerService,
  ) {
    this.client = axios.create({
      baseURL: this.config.vault.addr,
      timeout: 5_000,
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async onModuleInit(): Promise<void> {
    if (this.config.vault.devMode) {
      this.logger.warn(
        'VaultService: VAULT_DEV_MODE=true — using root token, no unsealing required. DO NOT use in production.',
        'VaultService',
      );
      // Vault dev server uses "root" as the default root token
      this.vaultToken = this.config.vault.token || 'root';
      this.available = true;
      await this.loadSecrets();
      return;
    }

    if (!this.config.vault.token && (!this.config.vault.roleId || !this.config.vault.secretId)) {
      this.logger.warn(
        'VaultService: No Vault credentials configured (VAULT_TOKEN or VAULT_ROLE_ID+VAULT_SECRET_ID). ' +
          'Skipping Vault — using process.env for secrets.',
        'VaultService',
      );
      return;
    }

    try {
      await this.authenticate();
      this.available = true;
      await this.loadSecrets();
    } catch (err) {
      this.logger.warn(
        `VaultService: Authentication failed — falling back to process.env: ${(err as Error).message}`,
        'VaultService',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  /**
   * Authenticate to Vault.
   * Tries AppRole first (production-recommended), then static token.
   */
  private async authenticate(): Promise<void> {
    const { roleId, secretId, token } = this.config.vault;

    if (roleId && secretId) {
      // AppRole authentication — recommended for production
      const response = await this.client.post<{ auth: { client_token: string } }>(
        '/v1/auth/approle/login',
        { role_id: roleId, secret_id: secretId },
      );
      this.vaultToken = response.data.auth.client_token;
      this.logger.log('VaultService: Authenticated via AppRole', 'VaultService');
      return;
    }

    if (token) {
      // Static token — acceptable for dev/staging, not ideal for production
      this.vaultToken = token;
      this.logger.log('VaultService: Authenticated via static token', 'VaultService');
      return;
    }

    throw new Error('No valid Vault credentials found');
  }

  // ---------------------------------------------------------------------------
  // KV v2 — Secret loading
  // ---------------------------------------------------------------------------

  /**
   * Load secrets from Vault KV v2 and merge into process.env.
   * Explicit env vars are never overridden.
   */
  async loadSecrets(): Promise<void> {
    if (!this.available || !this.vaultToken) return;

    const path = this.config.vault.secretPath;
    if (!path) {
      this.logger.warn(
        'VaultService: VAULT_SECRET_PATH not set — skipping secret load',
        'VaultService',
      );
      return;
    }

    try {
      // KV v2 path format: /v1/{mount}/data/{path}
      const kvPath = this.buildKvPath(path);
      const response = await this.client.get<{ data: { data: Record<string, string> } }>(kvPath, {
        headers: { 'X-Vault-Token': this.vaultToken },
      });

      const secrets = response.data?.data?.data ?? {};
      let loaded = 0;

      for (const [key, value] of Object.entries(secrets)) {
        if (!process.env[key]) {
          process.env[key] = String(value);
          loaded++;
        }
      }

      this.logger.log(
        `VaultService: Loaded ${loaded} secret(s) from ${path} (${Object.keys(secrets).length} total, ${Object.keys(secrets).length - loaded} skipped as already set)`,
        'VaultService',
      );
    } catch (err) {
      this.logger.warn(
        `VaultService: Failed to load secrets from '${path}': ${(err as Error).message}`,
        'VaultService',
      );
    }
  }

  /**
   * Read a single secret value from Vault KV v2.
   * Returns null if Vault is unavailable or the key does not exist.
   */
  async readSecret(path: string, key: string): Promise<string | null> {
    if (!this.available || !this.vaultToken) return null;

    try {
      const kvPath = this.buildKvPath(path);
      const response = await this.client.get<{ data: { data: Record<string, string> } }>(kvPath, {
        headers: { 'X-Vault-Token': this.vaultToken },
      });
      return response.data?.data?.data?.[key] ?? null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Transit engine — signing operations
  // ---------------------------------------------------------------------------

  /**
   * Sign a payload using Vault's Transit engine.
   * The private key never leaves Vault — only the signature is returned.
   *
   * @param input — raw string or Buffer to sign
   * @returns base64-encoded signature
   */
  async sign(input: string | Buffer): Promise<string> {
    if (!this.available || !this.vaultToken) {
      throw new Error('VaultService: Vault is not available for signing operations');
    }

    const keyName = this.config.vault.transitKey;
    if (!keyName) {
      throw new Error('VaultService: VAULT_TRANSIT_KEY is not configured');
    }

    const inputStr = Buffer.isBuffer(input) ? input.toString('base64') : Buffer.from(input).toString('base64');

    const response = await this.client.post<{ data: { signature: string } }>(
      `/v1/transit/sign/${keyName}`,
      { input: inputStr, prehashed: false, hash_algorithm: 'sha2-256' },
      { headers: { 'X-Vault-Token': this.vaultToken } },
    );

    // Vault returns "vault:v1:<base64_sig>" — strip the prefix
    const raw = response.data.data.signature;
    return raw.replace(/^vault:v\d+:/, '');
  }

  /**
   * Verify a signature using Vault's Transit engine.
   *
   * @param input     — the original signed payload
   * @param signature — the signature to verify (base64, without Vault prefix)
   */
  async verify(input: string | Buffer, signature: string): Promise<boolean> {
    if (!this.available || !this.vaultToken) return false;

    const keyName = this.config.vault.transitKey;
    if (!keyName) return false;

    const inputStr = Buffer.isBuffer(input) ? input.toString('base64') : Buffer.from(input).toString('base64');

    try {
      const response = await this.client.post<{ data: { valid: boolean } }>(
        `/v1/transit/verify/${keyName}`,
        { input: inputStr, signature: `vault:v1:${signature}`, hash_algorithm: 'sha2-256' },
        { headers: { 'X-Vault-Token': this.vaultToken } },
      );
      return response.data.data.valid === true;
    } catch {
      return false;
    }
  }

  /**
   * Export the public key from Vault's Transit engine (RSA public key only).
   * Used by DevJwtProvider when VAULT_TRANSIT_KEY is configured — the public
   * key is used locally for JWT verification so Vault is only needed for signing.
   *
   * Returns null if Transit is not configured or Vault is unavailable.
   */
  async getPublicKey(): Promise<string | null> {
    if (!this.available || !this.vaultToken) return null;

    const keyName = this.config.vault.transitKey;
    if (!keyName) return null;

    try {
      const response = await this.client.get<{
        data: { keys: Record<string, { public_key: string }> };
      }>(`/v1/transit/keys/${keyName}`, {
        headers: { 'X-Vault-Token': this.vaultToken },
      });

      // Get the latest key version
      const keys = response.data.data.keys;
      const latestVersion = Object.keys(keys).sort((a, b) => Number(b) - Number(a))[0];
      return keys[latestVersion]?.public_key ?? null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Token renewal (called by cron)
  // ---------------------------------------------------------------------------

  /**
   * Renew the Vault service token before expiry.
   * AppRole tokens are short-lived; this keeps the service authenticated.
   * Called every 30 minutes by the cron job in HealthMonitorService.
   */
  async renewToken(): Promise<void> {
    if (!this.available || !this.vaultToken || this.config.vault.devMode) return;

    try {
      await this.client.post(
        '/v1/auth/token/renew-self',
        {},
        { headers: { 'X-Vault-Token': this.vaultToken } },
      );
      this.logger.log('VaultService: Token renewed', 'VaultService');
    } catch (err) {
      this.logger.warn(
        `VaultService: Token renewal failed — attempting re-authentication: ${(err as Error).message}`,
        'VaultService',
      );
      // Re-authenticate if renewal fails (token may have expired)
      try {
        await this.authenticate();
      } catch (authErr) {
        this.logger.error(
          `VaultService: Re-authentication failed: ${(authErr as Error).message}`,
          (authErr as Error).stack,
          'VaultService',
        );
        this.available = false;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  get isAvailable(): boolean {
    return this.available;
  }

  /**
   * Convert a logical secret path to the KV v2 API path.
   * e.g. "secret/api-center/dev" → "/v1/secret/data/api-center/dev"
   */
  private buildKvPath(logicalPath: string): string {
    // logicalPath format: "{mount}/{secret-path}"
    // API format: /v1/{mount}/data/{secret-path}
    const parts = logicalPath.replace(/^\//, '').split('/');
    const mount = parts[0];
    const secretPath = parts.slice(1).join('/');
    return `/v1/${mount}/data/${secretPath}`;
  }
}
