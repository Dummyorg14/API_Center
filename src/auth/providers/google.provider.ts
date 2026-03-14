// =============================================================================
// src/auth/providers/google.provider.ts — Google OAuth2 / OIDC AuthProvider
// =============================================================================
//
// Supports two distinct use-cases:
//
//   1. USER AUTHENTICATION (browser / OAuth2 code flow)
//      Users log in with their Google Account. The gateway receives an
//      Authorization Code, exchanges it for Google tokens, verifies the
//      id_token via Google's JWKS, and issues an internal APICenter JWT.
//      Entry point: POST /api/v1/auth/google/callback  { code, redirectUri }
//
//   2. SERVICE ACCOUNTS (M2M — server-to-server)
//      Tribe services authenticate using a Google Service Account JSON key.
//      The gateway signs a JWT assertion and exchanges it for a Google
//      access token via the OAuth2 token endpoint. This access token is then
//      wrapped in an APICenter-scoped internal token.
//      Entry point: POST /api/v1/auth/token  { serviceId, secret }
//      The "secret" field must be the base64-encoded service account JSON.
//
// TOKEN VALIDATION:
//   Google id_tokens are RS256 JWTs signed by Google's JWKS. The JWKS endpoint
//   is fetched once and cached; keys are auto-refreshed on unknown kid.
//   Reference: https://accounts.google.com/.well-known/openid-configuration
//
// PRODUCTION REQUIREMENTS (see ENV VARS section below):
//   GOOGLE_CLIENT_ID      — OAuth2 client ID (from Google Cloud Console)
//   GOOGLE_CLIENT_SECRET  — OAuth2 client secret
//   GOOGLE_ALLOWED_DOMAINS — comma-separated list of allowed hd (hosted domain)
//                            values; leave empty to allow any Google account
//   GOOGLE_SA_KEY_<SERVICE_ID_UPPER> — base64(service-account-key.json)
//                                       per-service SA key for M2M auth
//
// OBTAINING CREDENTIALS:
//   User OAuth2:
//     1. Go to https://console.cloud.google.com/apis/credentials
//     2. Create → OAuth client ID → Web application
//     3. Add authorized redirect URI: https://<your-domain>/api/v1/auth/google/callback
//     4. Copy Client ID and Client Secret into env vars
//
//   Service Account (M2M):
//     1. Go to https://console.cloud.google.com/iam-admin/serviceaccounts
//     2. Create a service account for each tribe
//     3. Create a JSON key → download
//     4. Base64-encode: base64 -w0 service-account.json
//     5. Set GOOGLE_SA_KEY_<SERVICE_ID_UPPER>=<base64-encoded-json>
//
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, SignJWT, importPKCS8 } from 'jose';
import axios from 'axios';
import { AuthProvider, IssuedToken, JwtClaims } from '../auth-provider.interface';
import { ConfigService } from '../../config/config.service';

// Google's OIDC discovery / JWKS endpoints (stable, documented)
const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_ISSUER_ACCOUNTS = 'accounts.google.com';
const GOOGLE_ISSUER_HTTPS = 'https://accounts.google.com';

// Internal token TTL when wrapping a Google token
const INTERNAL_TOKEN_TTL_SECONDS = 3_600;

// ---------------------------------------------------------------------------
// Minimal shape of a Google Service Account JSON key file
// ---------------------------------------------------------------------------
interface ServiceAccountKey {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  token_uri: string;
}

// ---------------------------------------------------------------------------
// Google userinfo shape (subset)
// ---------------------------------------------------------------------------
interface GoogleUserInfo {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
  hd?: string; // hosted domain (Workspace accounts only)
}

@Injectable()
export class GoogleProvider implements AuthProvider, OnModuleInit {
  private readonly logger = new Logger(GoogleProvider.name);

  /** Remote JWKS — auto-refreshed by jose on unknown kid */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private jwks!: ReturnType<typeof createRemoteJWKSet>;

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly allowedDomains: string[];

  constructor(private readonly config: ConfigService) {
    this.clientId = process.env.GOOGLE_CLIENT_ID ?? '';
    this.clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? '';
    this.allowedDomains = (process.env.GOOGLE_ALLOWED_DOMAINS ?? '')
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  onModuleInit(): void {
    if (!this.clientId) {
      this.logger.warn('GOOGLE_CLIENT_ID is not set — Google auth will not work');
    }
    if (!this.clientSecret) {
      this.logger.warn('GOOGLE_CLIENT_SECRET is not set — Google auth will not work');
    }

    // Initialise the JWKS key store for id_token verification
    this.jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URI));

    if (this.allowedDomains.length > 0) {
      this.logger.log(
        `GoogleProvider ready — allowed domains: ${this.allowedDomains.join(', ')}`,
      );
    } else {
      this.logger.log('GoogleProvider ready — all Google domains allowed (no domain restriction)');
    }
  }

  // ---------------------------------------------------------------------------
  // AuthProvider: validateToken
  // ---------------------------------------------------------------------------

  /**
   * Validate a Google id_token (from user auth flow) OR an internal APICenter
   * JWT that wraps Google identity (issued by this provider).
   *
   * Google id_tokens are RS256, signed by Google's JWKS.
   */
  async validateToken(token: string): Promise<JwtClaims> {
    if (!this.jwks) {
      throw new Error('GoogleProvider not initialised — GOOGLE_CLIENT_ID missing');
    }

    const { payload } = await jwtVerify(token, this.jwks, {
      // Google uses both issuer values — accept either
      issuer: [GOOGLE_ISSUER_ACCOUNTS, GOOGLE_ISSUER_HTTPS],
      audience: this.clientId || undefined,
    });

    const userInfo = payload as unknown as GoogleUserInfo & Record<string, unknown>;

    // Enforce hosted-domain restriction if configured
    if (this.allowedDomains.length > 0) {
      const hd = userInfo.hd ?? '';
      if (!this.allowedDomains.includes(hd)) {
        throw new Error(
          `Google account domain '${hd || 'personal'}' is not in the allowed list: ` +
            this.allowedDomains.join(', '),
        );
      }
    }

    return {
      sub: payload.sub ?? '',
      email: userInfo.email,
      name: userInfo.name,
      picture: userInfo.picture,
      hd: userInfo.hd,
      tribeId: undefined, // Google user tokens don't carry a tribeId
      permissions: [],
      scopes: ['openid', 'email', 'profile'],
      exp: payload.exp,
      provider: 'google',
      ...payload,
    };
  }

  // ---------------------------------------------------------------------------
  // AuthProvider: issueToken  (M2M via Service Account)
  // ---------------------------------------------------------------------------

  /**
   * Issue an M2M token using a Google Service Account key.
   *
   * The service account JSON key is read from the env var:
   *   GOOGLE_SA_KEY_<SERVICE_ID_UPPER>
   * where SERVICE_ID_UPPER is the serviceId with non-alphanumeric chars
   * replaced by underscores and uppercased, e.g.:
   *   payment-service → GOOGLE_SA_KEY_PAYMENT_SERVICE
   *
   * Flow:
   *   1. Decode + parse the SA JSON key from env
   *   2. Build a signed JWT assertion (RS256, short-lived)
   *   3. POST to Google token endpoint (urn:...jwt-bearer grant)
   *   4. Receive a Google access_token
   *   5. Return an IssuedToken wrapping the Google access_token
   */
  async issueToken(
    serviceId: string,
    permissions: string[],
    scopes: string[],
  ): Promise<IssuedToken> {
    const saKey = this.loadServiceAccountKey(serviceId);

    if (!saKey) {
      throw new Error(
        `No Google Service Account key found for service '${serviceId}'. ` +
          `Set GOOGLE_SA_KEY_${serviceId.toUpperCase().replace(/[^A-Z0-9]/g, '_')} ` +
          `to base64-encoded service-account.json.`,
      );
    }

    // Build the signed JWT assertion for the SA grant
    const now = Math.floor(Date.now() / 1000);
    const scope = scopes.length > 0 ? scopes.join(' ') : 'https://www.googleapis.com/auth/cloud-platform';

    const privateKey = await importPKCS8(saKey.private_key, 'RS256');

    const assertion = await new SignJWT({
      scope,
    })
      .setProtectedHeader({ alg: 'RS256', kid: saKey.private_key_id })
      .setIssuer(saKey.client_email)
      .setSubject(saKey.client_email)
      .setAudience(saKey.token_uri || GOOGLE_TOKEN_ENDPOINT)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);

    // Exchange assertion for an access token
    const params = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });

    const response = await axios.post<{
      access_token: string;
      expires_in: number;
      token_type: string;
    }>(saKey.token_uri || GOOGLE_TOKEN_ENDPOINT, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10_000,
    });

    this.logger.log(`M2M token issued for service '${serviceId}' via Google SA`);

    return {
      accessToken: response.data.access_token,
      refreshToken: null, // SA tokens are short-lived; just re-issue
      expiresIn: response.data.expires_in ?? INTERNAL_TOKEN_TTL_SECONDS,
    };
  }

  // ---------------------------------------------------------------------------
  // AuthProvider: refreshToken
  // ---------------------------------------------------------------------------

  /**
   * Exchange a Google refresh_token for a new access token.
   * Only available when a refresh_token was obtained during the user OAuth2
   * code flow (access_type=offline).
   */
  async refreshToken(refreshToken: string): Promise<IssuedToken> {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    const response = await axios.post<{
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    }>(GOOGLE_TOKEN_ENDPOINT, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10_000,
    });

    return {
      accessToken: response.data.access_token,
      refreshToken: response.data.refresh_token ?? null,
      expiresIn: response.data.expires_in ?? INTERNAL_TOKEN_TTL_SECONDS,
    };
  }

  // ---------------------------------------------------------------------------
  // AuthProvider: getJwksJson
  // ---------------------------------------------------------------------------

  /**
   * Google uses its own JWKS — consumers fetch it from GOOGLE_JWKS_URI.
   * We do not serve an in-process JWKS document.
   */
  getJwksJson(): null {
    return null;
  }

  // ---------------------------------------------------------------------------
  // Additional helper: exchangeCode
  // ---------------------------------------------------------------------------

  /**
   * Exchange an OAuth2 authorization code for Google tokens.
   * Called by the auth controller's /google/callback endpoint.
   *
   * @returns Google token bundle including id_token
   */
  async exchangeCode(
    code: string,
    redirectUri: string,
  ): Promise<{
    accessToken: string;
    refreshToken: string | null;
    idToken: string;
    expiresIn: number;
    userInfo: GoogleUserInfo;
  }> {
    const params = new URLSearchParams({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    const response = await axios.post<{
      access_token: string;
      refresh_token?: string;
      id_token: string;
      expires_in: number;
    }>(GOOGLE_TOKEN_ENDPOINT, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10_000,
    });

    const { access_token, refresh_token, id_token, expires_in } = response.data;

    // Fetch userinfo from Google
    const userInfoRes = await axios.get<GoogleUserInfo>(
      'https://www.googleapis.com/oauth2/v3/userinfo',
      {
        headers: { Authorization: `Bearer ${access_token}` },
        timeout: 10_000,
      },
    );

    // Enforce domain restriction on userinfo result
    if (this.allowedDomains.length > 0) {
      const hd = userInfoRes.data.hd ?? '';
      if (!this.allowedDomains.includes(hd)) {
        throw new Error(
          `Google account domain '${hd || 'personal'}' is not allowed. ` +
            `Permitted: ${this.allowedDomains.join(', ')}`,
        );
      }
    }

    return {
      accessToken: access_token,
      refreshToken: refresh_token ?? null,
      idToken: id_token,
      expiresIn: expires_in,
      userInfo: userInfoRes.data,
    };
  }

  /**
   * Build the Google OAuth2 authorization URL for the browser redirect.
   */
  buildAuthorizationUrl(redirectUri: string, state?: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'offline',   // request refresh_token
      prompt: 'consent',         // always show consent → ensures refresh_token
      ...(state ? { state } : {}),
      ...(this.allowedDomains.length === 1 ? { hd: this.allowedDomains[0] } : {}),
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private loadServiceAccountKey(serviceId: string): ServiceAccountKey | null {
    const envKey = `GOOGLE_SA_KEY_${serviceId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    const encoded = process.env[envKey];
    if (!encoded) return null;

    try {
      const json = Buffer.from(encoded, 'base64').toString('utf-8');
      const parsed = JSON.parse(json) as ServiceAccountKey;
      if (parsed.type !== 'service_account') {
        throw new Error(`Expected type=service_account, got ${parsed.type}`);
      }
      return parsed;
    } catch (err) {
      this.logger.error(
        `Failed to parse service account key from ${envKey}: ${(err as Error).message}`,
      );
      return null;
    }
  }
}
