// =============================================================================
// src/config/secrets.service.ts — Runtime secrets management
// =============================================================================
// Attempts to load secrets from AWS Secrets Manager when AWS_SECRET_NAME is
// set. Falls back gracefully to process.env for local development.
//
// HOW IT WORKS:
//  1. On module init, checks for AWS_SECRET_NAME env var
//  2. If present, fetches the JSON secret from AWS Secrets Manager
//  3. Merges fetched key/value pairs into process.env
//  4. If AWS is not configured or fails, logs a warning and continues
//
// This runs BEFORE ConfigService reads env vars, so the rest of the app
// is unaffected — it just sees process.env with secrets already populated.
// =============================================================================

import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { LoggerService } from '../shared/logger.service';

@Injectable()
export class SecretsService implements OnModuleInit {
  constructor(private readonly logger: LoggerService) {}

  async onModuleInit() {
    const secretName = process.env.AWS_SECRET_NAME;
    const region = process.env.AWS_REGION || 'us-east-1';

    if (!secretName) {
      this.logger.info(
        'AWS_SECRET_NAME not set — using process.env for secrets (local dev mode)',
        {},
      );
      return;
    }

    try {
      this.logger.info(`Loading secrets from AWS Secrets Manager: ${secretName}`, {});

      const client = new SecretsManagerClient({ region });
      const command = new GetSecretValueCommand({ SecretId: secretName });
      const response = await client.send(command);

      if (!response.SecretString) {
        this.logger.warn(
          `AWS secret '${secretName}' returned empty — falling back to process.env`,
          'SecretsService',
        );
        return;
      }

      const secrets: Record<string, string> = JSON.parse(response.SecretString);
      let count = 0;

      for (const [key, value] of Object.entries(secrets)) {
        // Only set if not already overridden by explicit env var
        if (!process.env[key]) {
          process.env[key] = value;
          count++;
        }
      }

      this.logger.info(
        `Loaded ${count} secret(s) from AWS Secrets Manager (${Object.keys(secrets).length} total, ${Object.keys(secrets).length - count} skipped as already set)`,
        {},
      );
    } catch (err) {
      this.logger.warn(
        `AWS Secrets Manager unavailable — falling back to process.env: ${(err as Error).message}`,
        'SecretsService',
      );
    }
  }
}
