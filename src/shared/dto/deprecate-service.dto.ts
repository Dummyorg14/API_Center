// =============================================================================
// src/shared/dto/deprecate-service.dto.ts — DTO for PATCH .../deprecate
// =============================================================================

import { IsString, IsOptional, IsDateString, Matches } from 'class-validator';

export class DeprecateServiceDto {
  @IsDateString({}, { message: 'sunsetDate must be a valid ISO-8601 date' })
  @IsOptional()
  sunsetDate?: string;

  @IsString()
  @Matches(/^[a-z0-9-]+$/, {
    message: 'replacementService must be a valid serviceId',
  })
  @IsOptional()
  replacementService?: string;
}
