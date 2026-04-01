# APICenter — Centralized API Gateway

APICenter is the **single, centralized API gateway** for the platform. Every API call — tribe-to-tribe, shared platform services, and external third-party APIs — routes through APICenter. No tribe calls another tribe directly.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Quick Start — dev-jwt (zero config)](#quick-start--dev-jwt--zero-config)
3. [Auth Providers](#auth-providers)
   - [dev-jwt — Local Dev & CI](#1-dev-jwt--local-dev--ci-default)
   - [Keycloak — Enterprise OIDC](#2-keycloak--enterprise-oidc)
   - [Google OAuth2 / OIDC (gauth)](#3-google-oauth2--oidc-gauth)
4. [Service Registration](#service-registration)
5. [SDK Usage](#sdk-usage)
6. [External APIs](#external-apis)
7. [Infrastructure Ports](#infrastructure-ports)
8. [Horizontal Scaling](#horizontal-scaling)
9. [Testing All Functionality](#testing-all-functionality)
   - [Health & Readiness](#health--readiness)
   - [dev-jwt Auth Flow](#dev-jwt-auth-flow)
   - [Keycloak Auth Flow](#keycloak-auth-flow)
   - [Google Auth Flow — User (Browser)](#google-auth-flow--user-browser)
   - [Google Auth Flow — M2M (Service Account)](#google-auth-flow--m2m-service-account)
   - [Service Registry](#service-registry-1)
   - [Tribe-to-Tribe Calls](#tribe-to-tribe-calls)
   - [Shared Services](#shared-services)
   - [External API Proxy](#external-api-proxy)
   - [Rate Limiting](#rate-limiting)
   - [Circuit Breaker](#circuit-breaker)
   - [Observability Stack](#observability-stack)
10. [Environment Variables Reference](#environment-variables-reference)
11. [Production Hardening Checklist](#production-hardening-checklist)
12. [GCP Deployment — Cloud Run + Secret Manager + Cloud Build](#gcp-deployment--cloud-run--secret-manager--cloud-build)

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

### 3. Google OAuth2 / OIDC (gauth)

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

## Infrastructure Ports

| Service | Port | URL | Purpose |
|---------|------|-----|---------|
| **NGINX** | **3000** | `http://localhost:3000` | **Consumer entrypoint — use this** |
| Vault UI | 8200 | `http://localhost:8200/ui` | Secrets (Token: `root`) |
| Kafka UI | 8080 | `http://localhost:8080` | Browse Kafka topics & messages |
| Prometheus | 9090 | `http://localhost:9090` | Metrics |
| Grafana | 3001 | `http://localhost:3001` | Dashboards (admin / admin) |
| Jaeger | 16686 | `http://localhost:16686` | Distributed tracing |

---

## Horizontal Scaling

Two edits to add a 4th container:

**`docker-compose.yml`** — copy the `api-center-3` block:
```yaml
api-center-4:
  <<: *api-center-common
  container_name: api-center-4
```

**`nginx.conf`** — add one line to the upstream block:
```nginx
server api-center-4:3000 max_fails=3 fail_timeout=20s;
```

Apply:
```bash
docker-compose up -d api-center-4 && docker-compose restart nginx
```

---

## Testing All Functionality

### Prerequisites

```bash
# jq for pretty JSON (optional but recommended)
brew install jq          # macOS
apt-get install jq       # Ubuntu/Debian

# Start the full stack
cp .env.example .env
docker-compose up -d

# Wait for all services to become healthy (~30–60 s)
watch docker-compose ps
```

---

### Health & Readiness

```bash
# Liveness — is the process running?
curl -s http://localhost:3000/api/v1/health/live | jq .
# → { "status": "ok" }

# Readiness — can the process serve traffic? (checks Redis, Kafka)
curl -s http://localhost:3000/api/v1/health/ready | jq .
# → { "status": "ok", "details": { ... } }

# NGINX health (bypasses NestJS entirely)
curl -s http://localhost:3000/nginx-health
# → healthy
```

---

### dev-jwt Auth Flow

```bash
# 1. Register a test service
curl -s -X POST http://localhost:3000/api/v1/registry/register \
  -H "Content-Type: application/json" \
  -d '{
    "serviceId": "test-service",
    "name": "Test Service",
    "baseUrl": "http://test-service:9999",
    "requiredScopes": ["test:read"],
    "exposes": ["test:read"],
    "consumes": [],
    "healthCheck": "/health",
    "version": "1.0.0"
  }' | jq .

# 2. Add the service secret to .env and restart (or export for this session)
#    Hash: echo -n "test-secret" | sha256sum | awk '{print $1}'
export TRIBE_SECRET_TEST_SERVICE=$(echo -n "test-secret" | sha256sum | awk '{print $1}')

# 3. Issue a token
RESPONSE=$(curl -s -X POST http://localhost:3000/api/v1/auth/token \
  -H "Content-Type: application/json" \
  -d '{"tribeId": "test-service", "secret": "test-secret"}')
echo $RESPONSE | jq .

export ACCESS_TOKEN=$(echo $RESPONSE | jq -r '.data.accessToken')
export REFRESH_TOKEN=$(echo $RESPONSE | jq -r '.data.refreshToken')

# 4. Inspect the JWKS (dev-jwt only — not available with Keycloak or Google)
curl -s http://localhost:3000/api/v1/auth/.well-known/jwks.json | jq .

# 5. Refresh the token
curl -s -X POST http://localhost:3000/api/v1/auth/token/refresh \
  -H "Content-Type: application/json" \
  -d "{\"refreshToken\": \"$REFRESH_TOKEN\"}" | jq .

# 6. Revoke the refresh token (requires valid access token)
curl -s -o /dev/null -w "%{http_code}" \
  -X POST http://localhost:3000/api/v1/auth/token/revoke \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -d "{\"refreshToken\": \"$REFRESH_TOKEN\"}"
# → 204

# 7. Revoke all tokens for a subject
curl -s -o /dev/null -w "%{http_code}" \
  -X POST http://localhost:3000/api/v1/auth/token/revoke \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -d "{\"refreshToken\": \"$REFRESH_TOKEN\", \"revokeAll\": true}"
# → 204
```

---

### Keycloak Auth Flow

```bash
# Start Keycloak alongside the gateway
docker-compose --profile keycloak up -d

# Wait for Keycloak (~30 s)
until curl -sf http://localhost:8080/health/ready > /dev/null; do
  echo "Waiting for Keycloak..."; sleep 3
done
echo "Keycloak ready"

# Update .env and restart gateway containers
# (or export inline for a quick test)
export AUTH_PROVIDER=keycloak
export KEYCLOAK_BASE_URL=http://localhost:8080
export KEYCLOAK_REALM=api-center
export KEYCLOAK_DEFAULT_CLIENT_SECRET=dev-secret
docker-compose up -d api-center-1 api-center-2 api-center-3

# Get a token directly from Keycloak (M2M client credentials)
KC_RESPONSE=$(curl -s -X POST \
  "http://localhost:8080/realms/api-center/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=api-center&client_secret=dev-secret")
echo $KC_RESPONSE | jq .

export KC_TOKEN=$(echo $KC_RESPONSE | jq -r '.access_token')

# Use the Keycloak token against the gateway
curl -s http://localhost:3000/api/v1/registry/services \
  -H "Authorization: Bearer $KC_TOKEN" | jq .

# Or let the gateway issue a token via APICenter's /auth/token endpoint
curl -s -X POST http://localhost:3000/api/v1/auth/token \
  -H "Content-Type: application/json" \
  -d '{"tribeId": "api-center", "secret": "dev-secret"}' | jq .
```

---

### Google Auth Flow — User (Browser)

> **Requires:** `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` set in `.env`, and the redirect URI registered in Google Cloud Console.

```bash
# Step 1: Build the authorization URL and open it in a browser
REDIRECT_URI="http://localhost:3000/api/v1/auth/google/callback"
STATE="csrf-$(date +%s)"

open "http://localhost:3000/api/v1/auth/google?redirectUri=${REDIRECT_URI}&state=${STATE}"
# Alternatively, hit the URL with curl and follow the Location header:
# curl -sv "http://localhost:3000/api/v1/auth/google?redirectUri=${REDIRECT_URI}" 2>&1 | grep Location

# Google will redirect your browser to:
#   http://localhost:3000/api/v1/auth/google/callback?code=<CODE>&state=<STATE>
#
# Copy the value of the `code` query parameter from the redirect URL.

# Step 2: Exchange the code for tokens
GOOGLE_CODE="<paste-code-here>"

curl -s -X POST http://localhost:3000/api/v1/auth/google/callback \
  -H "Content-Type: application/json" \
  -d "{
    \"code\": \"$GOOGLE_CODE\",
    \"redirectUri\": \"$REDIRECT_URI\"
  }" | jq .

# Expected response:
# {
#   "success": true,
#   "data": {
#     "accessToken": "<internal-apicenter-jwt>",
#     "refreshToken": "<google-refresh-token-or-null>",
#     "expiresIn": 3600,
#     "user": {
#       "sub": "1234567890",
#       "email": "user@yourcompany.com",
#       "name": "Jane Doe",
#       "picture": "https://...",
#       "hd": "yourcompany.com"
#     }
#   }
# }

# Step 3: Use the returned accessToken in subsequent calls
export ACCESS_TOKEN="<accessToken-from-response>"

curl -s http://localhost:3000/api/v1/registry/services \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq .

# Step 4: Refresh using the Google refresh token (if returned)
export GOOGLE_REFRESH="<refreshToken-from-response>"

curl -s -X POST http://localhost:3000/api/v1/auth/token/refresh \
  -H "Content-Type: application/json" \
  -d "{\"refreshToken\": \"$GOOGLE_REFRESH\"}" | jq .
```

**Testing domain restriction:**
```bash
# With GOOGLE_ALLOWED_DOMAINS=yourcompany.com in .env,
# logging in with a personal @gmail.com account will return:
# {
#   "statusCode": 401,
#   "message": "Google account domain 'personal' is not in the allowed list: yourcompany.com"
# }
```

---

### Google Auth Flow — M2M (Service Account)

> **Requires:** A GCP service account JSON key, base64-encoded, set as `GOOGLE_SA_KEY_<SERVICE_ID_UPPER>`.

```bash
# Encode your service account key (run once, then set in .env)
SA_B64=$(base64 -w0 /path/to/service-account-key.json)
# macOS: SA_B64=$(base64 -i /path/to/service-account-key.json | tr -d '\n')

# For a service called "analytics-service":
export GOOGLE_SA_KEY_ANALYTICS_SERVICE=$SA_B64

# Register the service
curl -s -X POST http://localhost:3000/api/v1/registry/register \
  -H "Content-Type: application/json" \
  -d '{
    "serviceId": "analytics-service",
    "name": "Analytics Service",
    "baseUrl": "http://analytics-service:5001",
    "requiredScopes": ["https://www.googleapis.com/auth/bigquery.readonly"],
    "exposes": [],
    "consumes": [],
    "healthCheck": "/health",
    "version": "1.0.0"
  }' | jq .

# Issue a token — the gateway uses the SA key internally to get a Google access token
SA_SECRET="analytics-sa-secret"
export TRIBE_SECRET_ANALYTICS_SERVICE=$(echo -n "$SA_SECRET" | sha256sum | awk '{print $1}')

curl -s -X POST http://localhost:3000/api/v1/auth/token \
  -H "Content-Type: application/json" \
  -d "{\"tribeId\": \"analytics-service\", \"secret\": \"$SA_SECRET\"}" | jq .

# Expected: { "data": { "accessToken": "<google-access-token>", "expiresIn": 3600, ... } }
```

---

### Service Registry

```bash
# List all registered services
curl -s http://localhost:3000/api/v1/registry/services | jq .

# Get a specific service
curl -s http://localhost:3000/api/v1/registry/services/payment-service | jq .

# Register from an example manifest file
curl -s -X POST http://localhost:3000/api/v1/registry/register \
  -H "Content-Type: application/json" \
  -d @examples/payment-manifest.json | jq .

# Deprecate a service (requires platform admin secret)
curl -s -X PATCH \
  http://localhost:3000/api/v1/registry/services/payment-service/deprecate \
  -H "Content-Type: application/json" \
  -H "X-Platform-Admin-Secret: change-me-in-production" \
  -d '{"reason": "Replaced by payments-v2", "sunsetDate": "2025-12-31"}' | jq .

# Deregister a service
curl -s -X DELETE \
  http://localhost:3000/api/v1/registry/services/payment-service \
  -H "X-Platform-Admin-Secret: change-me-in-production" | jq .
```

---

### Tribe-to-Tribe Calls

```bash
# Prerequisites: both services registered; caller has a valid token

# GET through the gateway to a tribe service
curl -s "http://localhost:3000/api/v1/tribes/user-service/users/123" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq .

# POST to a tribe service
curl -s -X POST "http://localhost:3000/api/v1/tribes/payment-service/payments" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"amount": 100, "currency": "USD"}' | jq .

# Verify the X-Correlation-ID header is injected
curl -sv "http://localhost:3000/api/v1/tribes/user-service/health" \
  -H "Authorization: Bearer $ACCESS_TOKEN" 2>&1 | grep -i "x-correlation"

# Supply your own correlation ID (traces the full request chain)
curl -s "http://localhost:3000/api/v1/tribes/user-service/users" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "X-Correlation-ID: my-trace-id-abc123" | jq .
```

---

### Shared Services

```bash
# Register a shared service (email, SMS, payments platform, etc.)
curl -s -X POST http://localhost:3000/api/v1/registry/register \
  -H "Content-Type: application/json" \
  -d @examples/email-manifest.json | jq .

# Call a shared service
curl -s -X POST "http://localhost:3000/api/v1/shared/email-service/send" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"to": "user@example.com", "template": "welcome"}' | jq .

# SMS shared service
curl -s -X POST "http://localhost:3000/api/v1/shared/sms-service/send" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"to": "+1234567890", "message": "Your code is 123456"}' | jq .
```

---

### External API Proxy

```bash
# Geolocation lookup — requires GEOLOCATION_API_KEY
# Free tier signup: https://ipgeolocation.io/signup.html
curl -s "http://localhost:3000/api/v1/external/geolocation/lookup?ip=8.8.8.8" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq .

# The API key is injected server-side — never exposed to the caller

# List configured external APIs (platform admin only)
curl -s http://localhost:3000/api/v1/external/admin/apis \
  -H "X-Platform-Admin-Secret: change-me-in-production" | jq .
```

---

### Rate Limiting

Default: **100 requests per 60 seconds** per service. Both limits are configurable.

```bash
# Hammer the health endpoint to trigger rate limiting
for i in $(seq 1 115); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    http://localhost:3000/api/v1/health/live)
  echo "Request $i: HTTP $STATUS"
  [ "$STATUS" = "429" ] && echo "  ^^^ Rate limited — Retry-After header present" && break
done

# Inspect rate limit headers
curl -sv http://localhost:3000/api/v1/health/live \
  -H "Authorization: Bearer $ACCESS_TOKEN" 2>&1 \
  | grep -i "x-ratelimit\|retry-after"
```

Change limits in `.env`:
```bash
RATE_LIMIT_WINDOW_MS=60000   # 60 second window
RATE_LIMIT_MAX=100           # max requests per window per service
```

---

### Circuit Breaker

```bash
# Register a service pointing to a non-existent host
curl -s -X POST http://localhost:3000/api/v1/registry/register \
  -H "Content-Type: application/json" \
  -d '{
    "serviceId": "broken-service",
    "name": "Broken Service",
    "baseUrl": "http://does-not-exist:9999",
    "requiredScopes": [],
    "exposes": [],
    "consumes": [],
    "healthCheck": "/health",
    "version": "1.0.0"
  }' | jq .

# First calls return 504 (upstream timeout)
for i in 1 2 3 4 5 6; do
  echo -n "Request $i: "
  curl -s -o /dev/null -w "HTTP %{http_code}\n" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    "http://localhost:3000/api/v1/tribes/broken-service/anything"
done

# After the threshold: 503 with circuit breaker open message
curl -s "http://localhost:3000/api/v1/tribes/broken-service/anything" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq .
# → { "statusCode": 503, "message": "Circuit breaker open for broken-service" }
```

---

### Observability Stack

#### Prometheus metrics

```bash
# Raw metrics scrape (all request counters, durations, active connections)
curl -s http://localhost:3000/metrics | grep api_center

# Open Prometheus expression browser
open http://localhost:9090

# Useful queries:
# api_center_requests_total
# rate(api_center_requests_total[1m])
# api_center_request_duration_seconds_bucket
# api_center_active_requests
```

#### Grafana dashboards

```bash
open http://localhost:3001   # admin / admin
```

1. **Configuration → Data Sources → Add data source**
   - Type: Prometheus, URL: `http://prometheus:9090` → Save & Test
2. **+ → Import** → enter dashboard ID `1860` (Node.js metrics) → Import
3. Or create a custom dashboard using the `api_center_*` metrics

#### Distributed tracing (Jaeger)

```bash
# Make some varied requests first
for path in health/live health/ready registry/services; do
  curl -s "http://localhost:3000/api/v1/$path" \
    -H "Authorization: Bearer $ACCESS_TOKEN" > /dev/null
done

open http://localhost:16686
# Service → api-center → Find Traces
# Click any trace to see the full request waterfall
```

#### Kafka audit trail

```bash
open http://localhost:8080
# Cluster: api-center-local → Topics

# Key topics to inspect:
# api-center.audit.log            — every proxied request
# api-center.auth.token-issued    — M2M token issued
# api-center.auth.token-refreshed — token refreshed
# api-center.auth.token-revoked   — token revoked
# api-center.registry.registered  — service registered
# api-center.gateway.circuit-open — circuit breaker opened
```

#### Vault secrets browser

```bash
open http://localhost:8200/ui   # Token: root

# Or via CLI inside the container:
docker exec vault vault kv list secret/api-center
docker exec vault vault kv get secret/api-center/dev
```

---

## Environment Variables Reference

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | NestJS listener port (inside container) |
| `NODE_ENV` | `development` | `development` or `production` |
| `ALLOWED_ORIGINS` | `*` | CORS origins — comma-separated or `*` |
| `PLATFORM_ADMIN_SECRET` | `change-me-in-production` | Required for admin endpoints |

### Auth provider selection

| Variable | Default | Values |
|----------|---------|--------|
| `AUTH_PROVIDER` | `dev-jwt` | `dev-jwt` · `keycloak` · `google` |

### dev-jwt

| Variable | Default | Description |
|----------|---------|-------------|
| `DEV_JWT_ISSUER` | `api-center-dev` | JWT `iss` claim |
| `DEV_JWT_TTL_SECONDS` | `3600` | Access token TTL (seconds) |
| `DEV_JWT_REFRESH_TTL_MULTIPLIER` | `24` | Refresh TTL = access TTL × this |
| `JWT_PRIVATE_KEY` | — | PEM private key (optional, for persistence) |
| `JWT_PUBLIC_KEY` | — | PEM public key (required when `JWT_PRIVATE_KEY` is set) |

### Google

| Variable | Default | Description |
|----------|---------|-------------|
| `GOOGLE_CLIENT_ID` | — | OAuth2 client ID (`*.apps.googleusercontent.com`) |
| `GOOGLE_CLIENT_SECRET` | — | OAuth2 client secret |
| `GOOGLE_REDIRECT_URI` | `http://localhost:3000/api/v1/auth/google/callback` | Must match Google Cloud Console exactly |
| `GOOGLE_ALLOWED_DOMAINS` | — | Comma-separated Workspace `hd` values — empty = any Google account |
| `GOOGLE_SA_KEY_<SERVICE_ID_UPPER>` | — | base64(service-account.json) for M2M |

### Keycloak

| Variable | Default | Description |
|----------|---------|-------------|
| `KEYCLOAK_BASE_URL` | `http://localhost:8080` | Keycloak server URL |
| `KEYCLOAK_REALM` | `api-center` | Realm name |
| `KEYCLOAK_JWKS_URI` | auto-derived | Override for non-standard deployments |
| `KEYCLOAK_ISSUER` | — | Expected `iss` claim — recommended in production |
| `KEYCLOAK_AUDIENCE` | — | Expected `aud` claim — recommended in production |
| `KEYCLOAK_DEFAULT_CLIENT_SECRET` | — | Default M2M secret |
| `KEYCLOAK_CLIENT_SECRET_<SERVICE_ID_UPPER>` | — | Per-service Keycloak client secret |
| `ENVOY_TRUST_HEADERS` | `false` | Trust Envoy/Ingress pre-verified JWT headers |

### Infrastructure

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_CACHE_URL` | `redis://localhost:6381` | Registry + token store |
| `REDIS_RATE_LIMIT_URL` | `redis://localhost:6380` | Rate-limit counters |
| `REDIS_TOKEN_TTL_SECONDS` | `3600` | Token TTL in Redis |
| `KAFKA_BROKERS` | `localhost:9092` | Comma-separated broker list |
| `VAULT_ADDR` | `http://localhost:8200` | Vault server |
| `VAULT_TOKEN` | — | Root/dev token (dev only) |
| `VAULT_ROLE_ID` / `VAULT_SECRET_ID` | — | AppRole credentials (production) |
| `VAULT_DEV_MODE` | `true` | Set `false` in production |
| `JAEGER_ENDPOINT` | `http://localhost:14268/api/traces` | Jaeger HTTP collector |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Window in milliseconds |
| `RATE_LIMIT_MAX` | `100` | Max requests per window per service |

### Per-service tribe secrets

```bash
# Format: TRIBE_SECRET_<SERVICE_ID_UPPER_SNAKE>=<sha256-hash-of-plaintext-secret>
# Hash:   echo -n "my-plaintext-secret" | sha256sum | awk '{print $1}'
TRIBE_SECRET_PAYMENT_SERVICE=<sha256hash>
TRIBE_SECRET_USER_SERVICE=<sha256hash>
TRIBE_SECRET_EMAIL_SERVICE=<sha256hash>
```

### External APIs

```bash
GEOLOCATION_API_URL=https://api.ipgeolocation.io   # Free tier available
GEOLOCATION_API_KEY=<your-key>
GEOFENCING_API_URL=https://api.geofencing.example.com
GEOFENCING_API_KEY=<your-key>
```

---

## Production Hardening Checklist

- [ ] `NODE_ENV=production`
- [ ] `AUTH_PROVIDER` set to `keycloak` or `google` — **never** `dev-jwt`
- [ ] `PLATFORM_ADMIN_SECRET` — generate with `openssl rand -hex 32`
- [ ] `ALLOWED_ORIGINS` — explicit whitelist, **not** `*`
- [ ] **Vault**: `VAULT_DEV_MODE=false`, AppRole credentials (`VAULT_ROLE_ID` + `VAULT_SECRET_ID`)
- [ ] **Redis**: sentinel or cluster URLs with TLS (`rediss://`)
- [ ] **Kafka**: internal broker addresses, SASL/TLS enabled
- [ ] **Keycloak**: set `KEYCLOAK_ISSUER` and `KEYCLOAK_AUDIENCE`
- [ ] **Google**: set `GOOGLE_ALLOWED_DOMAINS` to your Workspace domain(s)
- [ ] TLS terminated at NGINX or upstream ingress — **never** expose port 3000 directly
- [ ] Rotate `TRIBE_SECRET_*` secrets regularly
- [ ] Change Grafana default password (`GF_SECURITY_ADMIN_PASSWORD`)
- [ ] Restrict Vault UI, Kafka UI, and Prometheus to internal networks only
- [ ] `ENVOY_TRUST_HEADERS=false` unless behind a verified Envoy sidecar

---

## Vault Init (first run, dev only)

```bash
npm run vault:init
```

Enables the KV v2 and Transit secrets engines and creates a signing key.

---

## GCP Deployment — Cloud Run + Secret Manager + Cloud Build

This section covers a complete, production-ready deployment of APICenter on Google Cloud Platform using **Cloud Run** (serverless containers), **Secret Manager** (runtime secrets), and **Cloud Build** (CI/CD). All steps below assume you have the [Google Cloud SDK (`gcloud`)](https://cloud.google.com/sdk/docs/install) installed and authenticated.

---

### One-time Setup

#### 1. Create (or select) a GCP project

```bash
# Create a new project
gcloud projects create MY_PROJECT_ID --name="APICenter"
gcloud config set project MY_PROJECT_ID

# Enable billing (required for Cloud Run, Artifact Registry, etc.)
# https://console.cloud.google.com/billing
```

#### 2. Enable required APIs

```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com \
  iam.googleapis.com
```

#### 3. Create an Artifact Registry repository

```bash
gcloud artifacts repositories create api-center \
  --repository-format=docker \
  --location=us-central1 \
  --description="APICenter container images"
```

#### 4. Create a dedicated Cloud Run service account

```bash
gcloud iam service-accounts create api-center-cloudrun \
  --display-name="APICenter Cloud Run SA"

export SA_EMAIL="api-center-cloudrun@MY_PROJECT_ID.iam.gserviceaccount.com"
```

#### 5. Grant required IAM roles

| Role | Purpose |
|------|---------|
| `roles/secretmanager.secretAccessor` | Read secrets at runtime |
| `roles/run.invoker` | Allow authenticated callers (if not public) |

```bash
# Allow the Cloud Run SA to read secrets
gcloud projects add-iam-policy-binding MY_PROJECT_ID \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/secretmanager.secretAccessor"

# Grant the Cloud Build SA permission to deploy to Cloud Run and act as the Cloud Run SA
export BUILD_SA="$(gcloud projects describe MY_PROJECT_ID \
  --format='value(projectNumber)')@cloudbuild.gserviceaccount.com"

gcloud projects add-iam-policy-binding MY_PROJECT_ID \
  --member="serviceAccount:${BUILD_SA}" \
  --role="roles/run.admin"

gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" \
  --member="serviceAccount:${BUILD_SA}" \
  --role="roles/iam.serviceAccountUser"

gcloud projects add-iam-policy-binding MY_PROJECT_ID \
  --member="serviceAccount:${BUILD_SA}" \
  --role="roles/artifactregistry.writer"
```

#### 6. Create the application secret in Secret Manager

The secret must be a JSON object whose keys map to environment variable names.

```bash
# Create the secret (initially empty)
gcloud secrets create api-center-prod \
  --replication-policy=automatic

# Add the first version — create a JSON file with your env vars:
cat > /tmp/api-center-secrets.json <<'EOF'
{
  "PLATFORM_ADMIN_SECRET": "change-me-generate-with-openssl-rand-hex-32",
  "JWT_PRIVATE_KEY": "-----BEGIN RSA PRIVATE KEY-----\n...",
  "JWT_PUBLIC_KEY": "-----BEGIN PUBLIC KEY-----\n...",
  "REDIS_CACHE_URL": "redis://10.x.x.x:6379",
  "REDIS_RATE_LIMIT_URL": "redis://10.x.x.x:6380",
  "KAFKA_BROKERS": "broker1:9092,broker2:9092",
  "TRIBE_SECRET_USER_SERVICE": "<sha256hash>",
  "TRIBE_SECRET_PAYMENT_SERVICE": "<sha256hash>"
}
EOF

gcloud secrets versions add api-center-prod \
  --data-file=/tmp/api-center-secrets.json

# Remove the temp file immediately
rm /tmp/api-center-secrets.json
```

> **Note:** Any key present in the JSON secret will be merged into `process.env` at startup. Keys already set as Cloud Run env vars take precedence (they are not overridden).

#### 7. Grant the Cloud Run SA access to the specific secret

```bash
gcloud secrets add-iam-policy-binding api-center-prod \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/secretmanager.secretAccessor"
```

---

### CI/CD Flow (Cloud Build)

The `cloudbuild.yaml` at the repository root defines the pipeline:

1. **`test`** — Install deps, lint, run unit tests
2. **`build`** — Build the Docker image from `docker/Dockerfile.gcp`
3. **`push`** — Push the image to Artifact Registry (tagged with `SHORT_SHA` and `latest`)
4. **`deploy`** — Deploy the new image to Cloud Run

#### Create a Cloud Build trigger

```bash
# Via gcloud (adjust --repo-name and --branch-pattern as needed)
gcloud builds triggers create github \
  --repo-name=API_Center \
  --repo-owner=YOUR_GITHUB_ORG \
  --branch-pattern="^main$" \
  --build-config=cloudbuild.yaml \
  --substitutions=\
_REGION=us-central1,\
_SERVICE_NAME=api-center,\
_GCP_PROJECT_ID=MY_PROJECT_ID,\
_IMAGE_REPO=us-central1-docker.pkg.dev/MY_PROJECT_ID/api-center
```

Or configure the trigger in [Cloud Build → Triggers](https://console.cloud.google.com/cloud-build/triggers) in the console, setting the same substitutions.

---

### Manual Cloud Run Deploy

To deploy without Cloud Build (e.g. from your local machine):

```bash
# Authenticate Docker with Artifact Registry
gcloud auth configure-docker us-central1-docker.pkg.dev

# Build and push
docker build -f docker/Dockerfile.gcp \
  -t us-central1-docker.pkg.dev/MY_PROJECT_ID/api-center/api-center:latest .
docker push us-central1-docker.pkg.dev/MY_PROJECT_ID/api-center/api-center:latest

# Deploy
gcloud run deploy api-center \
  --image=us-central1-docker.pkg.dev/MY_PROJECT_ID/api-center/api-center:latest \
  --region=us-central1 \
  --platform=managed \
  --service-account="${SA_EMAIL}" \
  --set-env-vars=NODE_ENV=production \
  --set-env-vars=GCP_PROJECT_ID=MY_PROJECT_ID \
  --set-env-vars=GCP_SECRET_NAME=api-center-prod \
  --allow-unauthenticated
```

Or use the declarative YAML definition:

```bash
# Fill in placeholders in gcp/cloudrun.yaml first, then:
gcloud run services replace gcp/cloudrun.yaml --region=us-central1
```

---

### Environment Variable Setup

Set non-sensitive env vars directly on the Cloud Run service. Sensitive values go into Secret Manager (see above).

| Variable | Where to set |
|----------|-------------|
| `NODE_ENV=production` | Cloud Run env var |
| `GCP_PROJECT_ID` | Cloud Run env var |
| `GCP_SECRET_NAME` | Cloud Run env var |
| `AUTH_PROVIDER` | Cloud Run env var |
| `PLATFORM_ADMIN_SECRET` | Secret Manager JSON |
| `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` | Secret Manager JSON |
| `REDIS_CACHE_URL` | Secret Manager JSON |
| `KAFKA_BROKERS` | Secret Manager JSON |
| `TRIBE_SECRET_*` | Secret Manager JSON |

```bash
# Update Cloud Run env vars without redeploying the image
gcloud run services update api-center \
  --region=us-central1 \
  --set-env-vars=AUTH_PROVIDER=google,GOOGLE_ALLOWED_DOMAINS=yourcompany.com
```

---

### Adding Per-Service Secrets

To add or update a tribe secret without modifying other secrets:

1. Download the current secret version:
   ```bash
   gcloud secrets versions access latest \
     --secret=api-center-prod > /tmp/current.json
   ```

2. Edit `/tmp/current.json` — add or update the `TRIBE_SECRET_<NAME>` key.

3. Push as a new version:
   ```bash
   gcloud secrets versions add api-center-prod \
     --data-file=/tmp/current.json
   rm /tmp/current.json
   ```

4. The next container startup (or redeployment) will pick up the new version automatically. To force a reload without a new image:
   ```bash
   gcloud run services update api-center \
     --region=us-central1 \
     --set-env-vars=_FORCE_REDEPLOY="$(date +%s)"
   ```

---

### Secret Rotation

1. Create a new version of the secret (the old version remains accessible until you disable/destroy it):
   ```bash
   gcloud secrets versions add api-center-prod \
     --data-file=/tmp/new-secrets.json
   ```

2. Redeploy or restart the Cloud Run service so containers pick up `latest`:
   ```bash
   gcloud run services update api-center \
     --region=us-central1 \
     --image=us-central1-docker.pkg.dev/MY_PROJECT_ID/api-center/api-center:latest
   ```

3. After confirming the new version works, disable the old version:
   ```bash
   gcloud secrets versions disable OLD_VERSION_NUMBER \
     --secret=api-center-prod
   ```

4. To pin a specific version instead of always using `latest`, set `GCP_SECRET_VERSION=<version_number>` as a Cloud Run env var.

---

### Local Dev Notes

- Do **not** set `GCP_SECRET_NAME` in your local `.env` — leave it blank to use `process.env` directly (populated from `.env` via dotenv).
- To test Secret Manager locally, set `GCP_SECRET_NAME`, `GCP_PROJECT_ID`, and authenticate with:
  ```bash
  gcloud auth application-default login
  ```
  The GCP client library picks up Application Default Credentials automatically.
- The `docker/Dockerfile.gcp` image exposes port `8080` (Cloud Run default). The root `Dockerfile` and `docker-compose.yml` still use port `3000` for local development — nothing changes for local dev.

---

### Required IAM Roles — Summary

| Principal | Role | Purpose |
|-----------|------|---------|
| Cloud Run SA | `roles/secretmanager.secretAccessor` | Read secrets at runtime |
| Cloud Build SA | `roles/run.admin` | Deploy Cloud Run services |
| Cloud Build SA | `roles/iam.serviceAccountUser` | Act as Cloud Run SA during deploy |
| Cloud Build SA | `roles/artifactregistry.writer` | Push Docker images |
