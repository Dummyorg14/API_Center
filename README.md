# APICenter — Centralized API Gateway

APICenter is the **single, centralized API gateway** for the platform. Every API call — tribe-to-tribe, shared platform services, and external third-party APIs — routes through APICenter. No tribe calls another tribe directly.

> **For platform operators and contributors:** see [docs/developer/README.md](docs/developer/README.md) for local dev setup, testing, CI/CD, and GCP deployment.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Quick Start — dev-jwt (zero config)](#quick-start--dev-jwt-zero-config)
3. [Auth Providers](#auth-providers)
   - [dev-jwt — Local Dev & CI](#1-dev-jwt--local-dev--ci-default)
   - [Keycloak — Enterprise OIDC](#2-keycloak--enterprise-oidc)
   - [Google OAuth2 / OIDC](#3-google-oauth2--oidc)
4. [Service Registration](#service-registration)
5. [SDK Usage](#sdk-usage)
6. [External APIs](#external-apis)
7. [API Reference](#api-reference)

---

## Architecture Overview

```
Consumer (tribe SDK / browser / external client)
  │
  ▼  :3000  ← ONE entrypoint for everything
┌─────────────────────────────────────────────────┐
│  NGINX Load Balancer                            │
│  • Round-robin across 3 containers              │
│  • Passive health checks (auto remove/re-add)   │
│  • CORS preflight answered at NGINX level       │
└──────────┬──────────────┬──────────────┬────────┘
           │              │              │
  ┌────────▼──────┐ ┌─────▼──────┐ ┌────▼───────┐
  │ api-center-1  │ │api-center-2│ │api-center-3│
  │  (stateless)  │ │ (stateless)│ │ (stateless)│
  └───────────────┘ └────────────┘ └────────────┘
        All 3 share state via Redis (registry, tokens, rate-limit counters)
```

### Route Namespaces

| Path | What it proxies |
|------|----------------|
| `/api/v1/tribes/:serviceId/*` | Tribe-to-tribe calls |
| `/api/v1/shared/:serviceId/*` | Shared platform services (email, SMS, payments) |
| `/api/v1/external/:apiName/*` | Third-party external APIs |
| `/api/v1/auth/*` | Token issuance / refresh / revocation |
| `/api/v1/registry/*` | Service self-registration |
| `/api/v1/health/*` | Liveness + readiness probes |

---

## Quick Start — dev-jwt (zero config)

No external dependencies. All tokens are self-issued by the gateway.

```bash
cp .env.example .env
# AUTH_PROVIDER=dev-jwt is already the default — no changes needed
docker-compose up -d
```

The gateway is available at `http://localhost:3000`. Wait ~30 s for all containers to become healthy:

```bash
docker-compose ps   # all services should show "healthy"
```

---

## Auth Providers

APICenter ships **three fully functional** auth providers. Select one with `AUTH_PROVIDER`.

| Value | Use case | External dependency |
|-------|----------|---------------------|
| `dev-jwt` | Local dev, CI | None |
| `keycloak` | Enterprise SSO, on-prem / cloud Keycloak | Keycloak server |
| `google` | Google Workspace / personal accounts, GCP service accounts | Google Cloud project |

---

### 1. dev-jwt — Local Dev & CI (default)

Self-contained RS256 JWT issuer. No external IdP required.

```bash
AUTH_PROVIDER=dev-jwt
```

**Key source priority:**

| Priority | Source | Config |
|----------|--------|--------|
| 1 | Vault Transit engine | `VAULT_TRANSIT_KEY=<key-name>` |
| 2 | PEM loaded from Vault KV | Vault KV at `VAULT_SECRET_PATH` with `jwt_private_key` |
| 3 | PEM from env vars | `JWT_PRIVATE_KEY` + `JWT_PUBLIC_KEY` |
| 4 | Ephemeral in-memory (default) | — tokens lost on restart |

**Generate a stable local key pair:**
```bash
openssl genrsa 2048 > private.pem
openssl rsa -in private.pem -pubout > public.pem

# Inline into .env (escaping newlines):
JWT_PRIVATE_KEY="$(awk 'NF{printf "%s\\n",$0}' private.pem)"
JWT_PUBLIC_KEY="$(awk 'NF{printf "%s\\n",$0}' public.pem)"
```

**JWKS endpoint (dev-jwt only):**
```
GET http://localhost:3000/api/v1/auth/.well-known/jwks.json
```

---

### 2. Keycloak — Enterprise OIDC

#### Option A — Local Keycloak (dev / CI)

```bash
docker-compose --profile keycloak up -d
```

Add to `.env`:
```bash
AUTH_PROVIDER=keycloak
KEYCLOAK_BASE_URL=http://localhost:8080
KEYCLOAK_REALM=api-center
KEYCLOAK_DEFAULT_CLIENT_SECRET=dev-secret
```

The `keycloak` profile auto-imports `keycloak/realm-api-center.json`, which creates the `api-center` client with secret `dev-secret`.

#### Option B — Org / Production Keycloak

```bash
AUTH_PROVIDER=keycloak
KEYCLOAK_BASE_URL=https://<your-keycloak-host>
KEYCLOAK_REALM=<your-realm>
KEYCLOAK_JWKS_URI=https://<your-keycloak-host>/realms/<realm>/protocol/openid-connect/certs
KEYCLOAK_ISSUER=https://<your-keycloak-host>/realms/<realm>
KEYCLOAK_AUDIENCE=api-center
KEYCLOAK_DEFAULT_CLIENT_SECRET=<client-secret>
```

#### Creating a tribe client in Keycloak Admin UI

1. Log in → select your realm → **Clients → Create client**
2. Client type: **OpenID Connect**, Client ID: `<service-id>` (e.g. `payment-service`)
3. Enable **Client authentication** → Save
4. **Credentials** tab → copy the secret
5. Set in `.env`: `KEYCLOAK_CLIENT_SECRET_PAYMENT_SERVICE=<secret>`

---

### 3. Google OAuth2 / OIDC

Supports two sub-flows running simultaneously:

- **User authentication** — browser login via Google Account (Authorization Code flow)
- **Service-account M2M** — tribe authentication using GCP service accounts (JWT Bearer grant)

#### Step 1 — Create a Google Cloud Project

1. Go to [https://console.cloud.google.com](https://console.cloud.google.com)
2. **Select or create a project**
3. The **Google Identity** API is enabled by default for all projects

#### Step 2 — OAuth2 Consent Screen (User Auth)

1. **APIs & Services → OAuth consent screen**
2. User type: **Internal** (Workspace org, recommended) or **External** (any Google account)
3. Fill in App name, Support email, Developer contact email
4. **Scopes**: add `openid`, `email`, `profile`
5. Save and continue through all steps

#### Step 3 — OAuth2 Credentials (User Auth)

1. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
2. Application type: **Web application**, Name: `APICenter`
3. **Authorized redirect URIs** — add:
   - Dev: `http://localhost:3000/api/v1/auth/google/callback`
   - Prod: `https://api.yourdomain.com/api/v1/auth/google/callback`
4. Click **Create** — copy **Client ID** and **Client Secret**

Set in `.env`:
```bash
AUTH_PROVIDER=google
GOOGLE_CLIENT_ID=<your-client-id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<your-client-secret>
GOOGLE_REDIRECT_URI=http://localhost:3000/api/v1/auth/google/callback

# Restrict to your org's Workspace domain(s) — leave empty to allow all Google accounts
GOOGLE_ALLOWED_DOMAINS=yourcompany.com
```

#### Step 4 — Service Accounts (M2M)

For each tribe service that authenticates as a GCP service account:

1. **IAM & Admin → Service Accounts → Create Service Account**
   - Name: `apicenter-<service-id>` (e.g. `apicenter-payment-service`)
   - Grant required IAM roles → Done
2. Click the service account → **Keys → Add Key → Create new key → JSON** → Download
3. Base64-encode the key file:

```bash
# Linux
base64 -w0 path/to/service-account-key.json

# macOS
base64 -i path/to/service-account-key.json | tr -d '\n'
```

4. Set in `.env` — one variable per service:
```bash
# Pattern: GOOGLE_SA_KEY_<SERVICE_ID_UPPERCASED_AND_UNDERSCORED>
GOOGLE_SA_KEY_PAYMENT_SERVICE=<base64-encoded-json>
GOOGLE_SA_KEY_USER_SERVICE=<base64-encoded-json>
```

---

## Service Registration

Services register themselves at startup:

```bash
curl -s -X POST http://localhost:3000/api/v1/registry/register \
  -H "Content-Type: application/json" \
  -d '{
    "serviceId":      "payment-service",
    "name":           "Payment Service",
    "baseUrl":        "http://payment-service:4001",
    "requiredScopes": ["payments:read", "payments:write"],
    "exposes":        ["payments:read", "payments:write"],
    "consumes":       ["user-service", "email-service"],
    "healthCheck":    "/health",
    "version":        "1.0.0"
  }'
```

After registration the service is immediately routable at `/api/v1/tribes/payment-service/*`.

**Per-service secret** (so the service can authenticate with the gateway):
```bash
# Generate and hash — gateway stores SHA-256, never plaintext
echo -n "my-plaintext-secret" | sha256sum | awk '{print $1}'

# Set in .env:
TRIBE_SECRET_PAYMENT_SERVICE=<sha256-hash>
```

---

## SDK Usage

Every tribe **must** use the shared SDK. Direct HTTP to the gateway is not permitted.

```bash
npm install @apicenter/sdk
```

```typescript
import { TribeClient } from '@apicenter/sdk';

const client = new TribeClient({
  gatewayUrl: process.env.APICENTER_URL,   // http://localhost:3000 (dev)
  tribeId:    'my-service',
  secret:     process.env.MY_SERVICE_SECRET,
});

await client.authenticate();   // auto-refreshes before expiry

// Tribe-to-tribe
const user = await client.callService('user-service', '/users/123');

// Shared platform service
await client.callSharedService('email-service', '/send', {
  method: 'POST',
  data: { to: 'user@example.com', template: 'welcome' },
});

// External API (credentials stay in APICenter — caller never sees them)
const geo = await client.callExternal('geolocation', '/lookup?ip=8.8.8.8');
```

**Error types:**
```typescript
import {
  AuthenticationError,    // 401 — bad credentials
  AuthorizationError,     // 403 — missing scopes
  ServiceNotFoundError,   // 404 — service not in registry
  RateLimitError,         // 429 — slow down (err.retryAfterMs available)
  GatewayTimeoutError,    // 504 — upstream too slow
  ServiceUnavailableError,// 503 — circuit breaker open
  NetworkError,           // no response from gateway
} from '@apicenter/sdk';
```

**Optional constructor options:**

| Option | Default | Description |
|--------|---------|-------------|
| `timeout` | `30000` | Request timeout in ms |
| `maxRetries` | `3` | Retry attempts for transient failures |
| `retryBaseDelayMs` | `500` | Initial backoff delay (doubles each attempt with ±25% jitter) |
| `correlationIdFactory` | — | Factory returning a correlation ID threaded across all requests |

---

## External APIs

External API credentials live **only** in APICenter — tribe services never hold them.

```bash
# ipgeolocation.io — free tier: https://ipgeolocation.io/signup.html
GEOLOCATION_API_KEY=<your-key>

# Replace with your actual geofencing provider
GEOFENCING_API_KEY=<your-key>
```

To add a new external API, create a handler in `src/external/apis/` following the pattern in `geolocation.ts`.

---

## API Reference

### Authentication

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/auth/token` | Issue M2M access + refresh token |
| `POST` | `/api/v1/auth/token/refresh` | Refresh an access token |
| `POST` | `/api/v1/auth/token/revoke` | Revoke a refresh token (or all tokens) |
| `GET` | `/api/v1/auth/google` | Initiate Google OAuth2 flow (browser) |
| `GET` | `/api/v1/auth/google/callback` | Google OAuth2 callback |
| `GET` | `/api/v1/auth/.well-known/jwks.json` | JWKS endpoint (dev-jwt only) |

### Registry

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/registry/register` | Register a service |
| `GET` | `/api/v1/registry/services` | List all services |
| `GET` | `/api/v1/registry/services/:id` | Get a service |
| `PATCH` | `/api/v1/registry/services/:id/deprecate` | Deprecate a service (admin) |
| `DELETE` | `/api/v1/registry/services/:id` | Deregister a service (admin) |

### Routing

| Method | Path | Description |
|--------|------|-------------|
| `*` | `/api/v1/tribes/:serviceId/*` | Proxy to a registered tribe service |
| `*` | `/api/v1/shared/:serviceId/*` | Proxy to a shared platform service |
| `*` | `/api/v1/external/:apiName/*` | Proxy to a configured external API |

### Health

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/health/live` | Liveness — is the process running? |
| `GET` | `/api/v1/health/ready` | Readiness — Redis + Kafka connectivity |
| `GET` | `/nginx-health` | NGINX bypass health check |

---

