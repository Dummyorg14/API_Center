// =============================================================================
// src/shared/dto/revoke-token.dto.ts — DTO for POST /api/v1/auth/token/revoke
// =============================================================================

import { IsString, IsNotEmpty, IsOptional, IsBoolean } from 'class-validator';

export class RevokeTokenDto {
  @IsString()
  @IsNotEmpty({ message: 'refreshToken is required' })
  refreshToken: string;

  /**
   * When true, revokes ALL refresh tokens for the subject (session-wide).
   * Defaults to false (revokes only the provided refreshToken).
   */
  @IsOptional()
  @IsBoolean()
  revokeAll?: boolean;
}
