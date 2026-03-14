# =============================================================================
# Dockerfile — API Center (Production-Hardened)
# =============================================================================
# MULTI-STAGE BUILD:
#  Stage 1 (builder): Install ALL deps → compile TypeScript → produce JS output
#  Stage 2 (runner):  Install ONLY production deps → copy compiled JS → run
#
# WHY MULTI-STAGE:
#  - Final image is ~80% smaller (no TypeScript, no devDependencies)
#  - Faster deploys (smaller images push/pull faster)
#  - Smaller attack surface (fewer packages = fewer vulnerabilities)
#
# WHY ALPINE:
#  - Alpine Linux is ~5MB vs ~100MB for full Ubuntu
#  - Minimal packages = fewer CVEs to patch
#
# SECURITY:
#  - Runs as non-root user (appuser) — even if exploited, attacker has limited access
#  - No secrets baked into the image — all config comes from env vars at runtime
#  - Uses npm ci (not npm install) for deterministic, reproducible builds
# =============================================================================

# ---- Stage 1: Build ----
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (Docker caches this layer as long as package.json
# doesn't change, making rebuilds much faster)
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source and compile TypeScript (NestJS uses nest build)
COPY tsconfig.json nest-cli.json ./
COPY src/ ./src/
RUN npm run build

# ---- Stage 2: Production ----
FROM node:20-alpine AS runner

# Security: install dumb-init for proper signal handling in containers
# Node.js doesn't handle signals well as PID 1 — dumb-init fixes this
RUN apk add --no-cache dumb-init

WORKDIR /app

# Only install production dependencies (no devDependencies)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output from builder stage
COPY --from=builder /app/dist ./dist

# Create logs directory
RUN mkdir -p logs

# Non-root user for security — NEVER run containers as root in production
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup && \
    chown -R appuser:appgroup /app
USER appuser

# Expose the application port
EXPOSE 3000

# Use dumb-init as PID 1 to properly forward signals (SIGTERM, SIGINT)
# This enables NestJS enableShutdownHooks() to work correctly inside Docker
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
