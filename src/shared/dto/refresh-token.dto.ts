// =============================================================================
// src/shared/dto/refresh-token.dto.ts — DTO for POST /api/v1/auth/token/refresh
// =============================================================================

import { IsString, IsNotEmpty } from 'class-validator';

export class RefreshTokenDto {
  @IsString()
  @IsNotEmpty({ message: 'refreshToken is required' })
  refreshToken: string;
}
