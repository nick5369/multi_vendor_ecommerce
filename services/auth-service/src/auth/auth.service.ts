import { ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { config } from '../config';
import { Mailer } from '../mail/mailer';
import { SellersService } from '../sellers/sellers.service';
import { PasswordService } from '../security/password.service';
import { TokenService } from '../security/token.service';
import { OneTimeTokensService, SessionsService } from '../sessions/sessions.service';
import { User } from '../users/user.schema';
import { PublicUser, toPublic, UsersService } from '../users/users.service';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  user: PublicUser;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionsService,
    private readonly oneTime: OneTimeTokensService,
    private readonly sellers: SellersService,
    private readonly mailer: Mailer,
  ) {}

  async register(input: { email: string; password: string; name: string }): Promise<PublicUser> {
    const user = await this.users.create({ email: input.email, name: input.name, passwordHash: await this.passwords.hash(input.password) });
    const token = await this.oneTime.create(user._id, 'EMAIL_VERIFY', config.verifyTtlSeconds);
    this.mailer.send(user.email, 'Verify your email', `Verification token: ${token}`);
    return toPublic(user);
  }

  async login(email: string, password: string): Promise<TokenPair> {
    const user = await this.users.findByEmail(email);
    const ok = await this.passwords.verify(password, user?.passwordHash ?? null);
    if (!user || !ok) throw new UnauthorizedException('Invalid credentials');
    if (user.status !== 'ACTIVE') throw new ForbiddenException('Account disabled');
    const { token } = await this.sessions.issue(user._id);
    return this.pair(user, token);
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const { userId, token } = await this.sessions.rotate(refreshToken);
    const user = await this.users.findById(userId);
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException('Invalid refresh token');
    return this.pair(user, token);
  }

  logout(refreshToken: string): Promise<void> {
    return this.sessions.revokeByToken(refreshToken);
  }

  async profile(userId: string): Promise<PublicUser> {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundException('User not found');
    return toPublic(user);
  }

  async changePassword(userId: string, current: string, next: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user || !(await this.passwords.verify(current, user.passwordHash))) throw new UnauthorizedException('Current password is incorrect');
    await this.users.setPasswordHash(userId, await this.passwords.hash(next));
    await this.sessions.revokeAllForUser(userId);
  }

  /** Always succeeds from the caller's view so registered emails cannot be enumerated. */
  async forgotPassword(email: string): Promise<void> {
    const user = await this.users.findByEmail(email);
    if (!user || user.status !== 'ACTIVE') return;
    const token = await this.oneTime.create(user._id, 'PASSWORD_RESET', config.resetTtlSeconds);
    this.mailer.send(user.email, 'Reset your password', `Reset token: ${token}`);
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const userId = await this.oneTime.consume(token, 'PASSWORD_RESET');
    await this.users.setPasswordHash(userId, await this.passwords.hash(newPassword));
    await this.sessions.revokeAllForUser(userId);
  }

  async verifyEmail(token: string): Promise<void> {
    await this.users.markEmailVerified(await this.oneTime.consume(token, 'EMAIL_VERIFY'));
  }

  private async pair(user: User, refreshToken: string): Promise<TokenPair> {
    // the store id claim is only issued while the store is ACTIVE
    let storeId: string | undefined;
    if (user.roles.includes('SELLER')) {
      const store = await this.sellers.findByOwner(user._id);
      if (store?.status === 'ACTIVE') storeId = store._id;
    }
    const accessToken = this.tokens.signAccess({ id: user._id, roles: user.roles, storeId });
    return { accessToken, refreshToken, tokenType: 'Bearer', expiresIn: this.tokens.accessTtl, user: toPublic(user) };
  }
}
