// =============================================================================
// src/config/secrets.service.ts — Runtime secrets management
// =============================================================================
// Attempts to load secrets from GCP Secret Manager when GCP_SECRET_NAME is
// set. Falls back gracefully to process.env for local development.
//
// HOW IT WORKS:
//  1. On module init, checks for GCP_SECRET_NAME env var
//  2. Resolves the GCP project from GCP_PROJECT_ID or GOOGLE_CLOUD_PROJECT
//  3. Fetches the specified secret version (GCP_SECRET_VERSION, default: latest)
//  4. Parses the JSON payload and merges keys into process.env
//     (existing env vars are NOT overridden — explicit env always wins)
//  5. If GCP is not configured or the fetch fails, logs a warning and continues
//
// This runs BEFORE ConfigService reads env vars, so the rest of the app
// is unaffected — it just sees process.env with secrets already populated.
// =============================================================================

import { Injectable, OnModuleInit } from "@nestjs/common";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { LoggerService } from "../shared/logger.service";

@Injectable()
export class SecretsService implements OnModuleInit {
  constructor(private readonly logger: LoggerService) {}

  async onModuleInit() {
    const secretName = process.env.GCP_SECRET_NAME;
    const projectId =
      process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
    const version = process.env.GCP_SECRET_VERSION || "latest";

    if (!secretName) {
      this.logger.info(
        "GCP_SECRET_NAME not set — using process.env for secrets (local dev mode)",
        {},
      );
      return;
    }

    if (!projectId) {
      this.logger.warn(
        "GCP_SECRET_NAME is set but GCP_PROJECT_ID / GOOGLE_CLOUD_PROJECT is missing — skipping GCP Secret Manager",
        "SecretsService",
      );
      return;
    }

    try {
      const resourceName = `projects/${projectId}/secrets/${secretName}/versions/${version}`;
      this.logger.info(
        `Loading secrets from GCP Secret Manager: ${resourceName}`,
        {},
      );

      const client = new SecretManagerServiceClient();
      const [response] = await client.accessSecretVersion({
        name: resourceName,
      });

      const payload = response.payload?.data;
      if (!payload) {
        this.logger.warn(
          `GCP secret '${secretName}' returned empty payload — falling back to process.env`,
          "SecretsService",
        );
        return;
      }

      const raw = Buffer.isBuffer(payload)
        ? payload.toString("utf8")
        : String(payload);
      const secrets: Record<string, string> = JSON.parse(raw);
      let count = 0;

      for (const [key, value] of Object.entries(secrets)) {
        // Only set if not already overridden by an explicit env var
        if (!process.env[key]) {
          process.env[key] = value;
          count++;
        }
      }

      this.logger.info(
        `Loaded ${count} secret(s) from GCP Secret Manager (${Object.keys(secrets).length} total, ${Object.keys(secrets).length - count} skipped as already set)`,
        {},
      );
    } catch (err) {
      this.logger.warn(
        `GCP Secret Manager unavailable — falling back to process.env: ${(err as Error).message}`,
        "SecretsService",
      );
    }
  }
}
