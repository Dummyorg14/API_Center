// =============================================================================
// src/shared/dto/service-manifest.dto.ts — DTO for service registration
// =============================================================================
// Validates service registration manifests using class-validator decorators.
// Replaces the Zod serviceManifestSchema from the Express version.
// =============================================================================

import {
  IsString,
  IsNotEmpty,
  MaxLength,
  IsUrl,
  IsArray,
  ArrayMinSize,
  IsOptional,
  IsIn,
  IsDateString,
  Matches,
} from 'class-validator';

export class ServiceManifestDto {
  @IsString()
  @IsNotEmpty({ message: 'serviceId is required' })
  @MaxLength(64, { message: 'serviceId is too long' })
  @Matches(/^[a-z0-9-]+$/, {
    message: 'serviceId must be lowercase alphanumeric with hyphens only',
  })
  serviceId: string;

  @IsString()
  @IsNotEmpty({ message: 'name is required' })
  @MaxLength(128, { message: 'name is too long' })
  name: string;

  @IsString()
  @IsUrl({}, { message: 'baseUrl must be a valid URL' })
  baseUrl: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'At least one required scope must be defined' })
  @IsString({ each: true })
  requiredScopes: string[];

  @IsArray()
  @ArrayMinSize(1, { message: 'At least one exposed route must be defined' })
  @IsString({ each: true })
  exposes: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  consumes?: string[] = [];

  @IsString()
  @IsOptional()
  healthCheck?: string;

  @IsString()
  @IsOptional()
  @Matches(/^\d+\.\d+\.\d+/, { message: 'version must follow semver (e.g. 1.0.0)' })
  version?: string;

  @IsString()
  @MaxLength(500, { message: 'description is too long' })
  @IsOptional()
  description?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  // ── Governance fields ──────────────────────────────────────────────────────

  @IsString()
  @MaxLength(128)
  @IsOptional()
  ownerTeam?: string;

  @IsString()
  @MaxLength(256, { message: 'contact is too long' })
  @IsOptional()
  contact?: string;

  @IsString()
  @IsIn(['critical', 'standard', 'experimental'], {
    message: 'serviceTier must be critical, standard, or experimental',
  })
  @IsOptional()
  serviceTier?: string;

  @IsString()
  @MaxLength(64)
  @IsOptional()
  costCenter?: string;

  @IsDateString({}, { message: 'sunsetDate must be a valid ISO-8601 date' })
  @IsOptional()
  sunsetDate?: string;

  @IsString()
  @Matches(/^[a-z0-9-]+$/, {
    message: 'replacementService must be a valid serviceId',
  })
  @IsOptional()
  replacementService?: string;

  // ── Routing namespace ──────────────────────────────────────────────────────

  @IsString()
  @IsIn(['shared', 'tribe'], {
    message: 'serviceType must be either shared or tribe',
  })
  @IsOptional()
  serviceType?: string = 'tribe';
}
