import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res, UnauthorizedException, UseGuards, NotFoundException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { config } from '../config';
import { AuditService } from '../audit/audit';
import { SellersService } from '../sellers/sellers.service';
import { AuthGuard, AuthUser, CurrentUser, Roles } from '../security/roles';
import { TokenService } from '../security/token.service';
import { PublicUser, UsersService } from '../users/users.service';
import { AuthService, TokenPair } from './auth.service';
import {
  ApplyAsSellerDto, ChangePasswordDto, ForgotPasswordDto, LoginDto, PageQuery, RefreshDto, RegisterDto,
  RejectDto, ResetPasswordDto, StoreStatusDto, UserStatusDto, VerifyEmailDto,
} from './dto';

const COOKIE = 'refresh_token';
// Browser-visible path (the gateway mounts this service under /api/auth), so the cookie only travels to auth routes.
const COOKIE_PATH = '/api/auth';

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie ?? '';
  const hit = raw.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : undefined;
}

/**
 * Refresh token delivery: always an HttpOnly SameSite=Lax cookie (not readable by page scripts).
 * API/test clients may opt in to receiving it in the JSON body with `X-Token-Delivery: body`.
 * `Secure` is off because local dev runs on plain http://localhost; enable it behind HTTPS.
 */
function deliver(req: Request, res: Response, pair: TokenPair): Partial<TokenPair> {
  res.cookie(COOKIE, pair.refreshToken, {
    httpOnly: true, sameSite: 'lax', secure: false, path: COOKIE_PATH, maxAge: config.refreshTtlSeconds * 1000,
  });
  if (req.header('x-token-delivery') === 'body') return pair;
  const { refreshToken: _omit, ...rest } = pair;
  return rest;
}

function presented(req: Request, body: RefreshDto): string {
  const token = body.refreshToken ?? readCookie(req, COOKIE);
  if (!token) throw new UnauthorizedException('Missing refresh token');
  return token;
}

@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly sellers: SellersService,
  ) {}

  @Get('.well-known/jwks.json')
  jwks() {
    return this.tokens.jwks();
  }

  @Post('register')
  register(@Body() dto: RegisterDto): Promise<PublicUser> {
    return this.auth.register(dto);
  }

  @Post('verify-email') @HttpCode(204)
  verifyEmail(@Body() dto: VerifyEmailDto): Promise<void> {
    return this.auth.verifyEmail(dto.token);
  }

  @Post('login') @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return deliver(req, res, await this.auth.login(dto.email, dto.password));
  }

  @Post('refresh') @HttpCode(200)
  async refresh(@Body() dto: RefreshDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return deliver(req, res, await this.auth.refresh(presented(req, dto)));
  }

  @Post('logout') @HttpCode(204)
  async logout(@Body() dto: RefreshDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = dto.refreshToken ?? readCookie(req, COOKIE);
    if (token) await this.auth.logout(token);
    res.clearCookie(COOKIE, { path: COOKIE_PATH });
  }

  @Get('profile') @UseGuards(AuthGuard)
  profile(@CurrentUser() user: AuthUser): Promise<PublicUser> {
    return this.auth.profile(user.id);
  }

  @Post('change-password') @HttpCode(204) @UseGuards(AuthGuard)
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto): Promise<void> {
    return this.auth.changePassword(user.id, dto.currentPassword, dto.newPassword);
  }

  @Post('forgot-password') @HttpCode(202)
  async forgot(@Body() dto: ForgotPasswordDto): Promise<{ message: string }> {
    await this.auth.forgotPassword(dto.email);
    return { message: 'If the account exists, a reset message has been sent.' };
  }

  @Post('reset-password') @HttpCode(204)
  reset(@Body() dto: ResetPasswordDto): Promise<void> {
    return this.auth.resetPassword(dto.token, dto.newPassword);
  }

  // ---- seller onboarding (any authenticated user) ----
  @Post('apply-as-seller') @UseGuards(AuthGuard)
  apply(@CurrentUser() user: AuthUser, @Body() dto: ApplyAsSellerDto) {
    return this.sellers.apply(user.id, dto);
  }

  @Get('seller/application') @UseGuards(AuthGuard)
  async myApplication(@CurrentUser() user: AuthUser) {
    const app = await this.sellers.myApplication(user.id);
    if (!app) throw new NotFoundException('No application');
    return app;
  }

  @Get('stores/:storeId')
  async store(@Param('storeId', ParseUUIDPipe) storeId: string) {
    const store = await this.sellers.getStore(storeId);
    if (!store || store.status !== 'ACTIVE') throw new NotFoundException('Store not found');
    return { storeId: store._id, name: store.name, description: store.description };
  }
}

/** Every route below requires the ADMIN role. */
@Controller('admin')
@UseGuards(AuthGuard)
export class AdminController {
  constructor(
    private readonly users: UsersService,
    private readonly sellers: SellersService,
    private readonly audit: AuditService,
  ) {}

  @Get('users') @Roles('ADMIN')
  listUsers(@Query() q: PageQuery) {
    return this.users.list(q.page, q.size);
  }

  @Post('users/:id/status') @HttpCode(200) @Roles('ADMIN')
  async setUserStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UserStatusDto, @CurrentUser() admin: AuthUser) {
    const user = await this.users.setStatus(id, dto.status);
    if (!user) throw new NotFoundException('User not found');
    await this.audit.record(admin.id, `USER_${dto.status}`, 'user', id);
    return { id, status: user.status };
  }

  @Get('seller-applications') @Roles('ADMIN')
  listApplications(@Query() q: PageQuery) {
    return this.sellers.listApplications(q.status, q.page, q.size);
  }

  @Post('seller-applications/:id/approve') @HttpCode(200) @Roles('ADMIN')
  approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() admin: AuthUser) {
    return this.sellers.approve(id, admin.id);
  }

  @Post('seller-applications/:id/reject') @HttpCode(200) @Roles('ADMIN')
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectDto, @CurrentUser() admin: AuthUser) {
    return this.sellers.reject(id, admin.id, dto.reason);
  }

  @Get('stores') @Roles('ADMIN')
  listStores(@Query() q: PageQuery) {
    return this.sellers.listStores(q.page, q.size);
  }

  @Post('stores/:id/status') @HttpCode(200) @Roles('ADMIN')
  setStoreStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: StoreStatusDto, @CurrentUser() admin: AuthUser) {
    return this.sellers.setStoreStatus(id, dto.status, admin.id);
  }

  @Get('audit') @Roles('ADMIN')
  auditLog(@Query() q: PageQuery) {
    return this.audit.list(q.page, q.size);
  }
}
