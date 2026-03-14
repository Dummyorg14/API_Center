// =============================================================================
// src/shared/dto/token-request.dto.ts — DTO for POST /api/v1/auth/token
// =============================================================================
// NestJS uses class-validator decorators instead of Zod schemas.
// The ValidationPipe automatically validates incoming request bodies
// against these DTOs before the controller method runs.
// =============================================================================

import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class TokenRequestDto {
  @IsString()
  @IsNotEmpty({ message: 'tribeId is required' })
  @MaxLength(50, { message: 'tribeId is too long' })
  tribeId: string;

  @IsString()
  @IsNotEmpty({ message: 'secret is required' })
  secret: string;
}
