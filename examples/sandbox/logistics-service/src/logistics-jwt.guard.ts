import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';

@Injectable()
export class LogisticsJwtGuard implements CanActivate {
  private readonly issuer = process.env.JWT_ISSUER || 'api-center-dev';
  private readonly jwksUrl = process.env.JWKS_URL || 'http://nginx/api/v1/auth/.well-known/jwks.json';
  private readonly jwks = createRemoteJWKSet(new URL(this.jwksUrl));

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing Bearer token');
    }

    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) {
      throw new UnauthorizedException('Missing Bearer token');
    }

    try {
      await jwtVerify(token, this.jwks, { issuer: this.issuer });
      return true;
    } catch {
      throw new UnauthorizedException('Invalid token signature or claims');
    }
  }
}
