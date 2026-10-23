import { CanActivate, createParamDecorator, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { TokenService } from './token.service';

export type Role = 'CUSTOMER' | 'SELLER' | 'ADMIN';
export interface AuthUser {
  id: string;
  roles: Role[];
  storeId?: string;
}

const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest<{ user: AuthUser }>().user,
);

/** Authenticates every request that reaches it; @Roles() additionally restricts by role. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly tokens: TokenService, private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const header = req.header('authorization') ?? '';
    if (!header.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token');
    req.user = this.tokens.verifyAccess(header.slice(7));
    const required = this.reflector.get<Role[] | undefined>(ROLES_KEY, ctx.getHandler());
    if (required?.length && !required.some((r) => req.user!.roles.includes(r))) {
      throw new ForbiddenException('Insufficient role');
    }
    return true;
  }
}
