import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, createPublicKey } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { config } from '../config';
import type { AuthUser, Role } from './roles';

@Injectable()
export class TokenService {
  private readonly kid = createHash('sha256').update(config.publicKey).digest('hex').slice(0, 16);

  signAccess(user: AuthUser): string {
    return jwt.sign({ roles: user.roles, storeId: user.storeId }, config.privateKey, {
      algorithm: 'RS256',
      subject: user.id,
      issuer: config.issuer,
      audience: config.audience,
      expiresIn: config.accessTtlSeconds,
      keyid: this.kid,
    });
  }

  verifyAccess(token: string): AuthUser {
    try {
      const p = jwt.verify(token, config.publicKey, {
        algorithms: ['RS256'],
        issuer: config.issuer,
        audience: config.audience,
      }) as jwt.JwtPayload & { roles?: Role[]; storeId?: string };
      if (!p.sub || !Array.isArray(p.roles)) throw new Error('malformed claims');
      return { id: p.sub, roles: p.roles, storeId: p.storeId };
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  jwks(): { keys: Record<string, unknown>[] } {
    const jwk = createPublicKey(config.publicKey).export({ format: 'jwk' });
    return { keys: [{ ...jwk, kid: this.kid, use: 'sig', alg: 'RS256' }] };
  }

  get accessTtl(): number {
    return config.accessTtlSeconds;
  }
}
