import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { AuditEntry, AuditEntrySchema, AuditService } from './audit/audit';
import { AdminController, AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { ApiExceptionFilter, RequestContextMiddleware } from './common/request-context';
import { config } from './config';
import { HealthController } from './health.controller';
import { Mailer } from './mail/mailer';
import { SeedService } from './seed/seed.service';
import { SellerApplication, SellerApplicationSchema, Store, StoreSchema } from './sellers/seller.schema';
import { OutboxEvent, OutboxEventSchema, SellersService } from './sellers/sellers.service';
import { AuthGuard } from './security/roles';
import { PasswordService } from './security/password.service';
import { TokenService } from './security/token.service';
import { OneTimeToken, OneTimeTokenSchema, RefreshSession, RefreshSessionSchema } from './sessions/session.schema';
import { OneTimeTokensService, SessionsService } from './sessions/sessions.service';
import { User, UserSchema } from './users/user.schema';
import { UsersService } from './users/users.service';

@Module({
  imports: [
    MongooseModule.forRoot(config.mongoUri),
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: RefreshSession.name, schema: RefreshSessionSchema },
      { name: OneTimeToken.name, schema: OneTimeTokenSchema },
      { name: SellerApplication.name, schema: SellerApplicationSchema },
      { name: Store.name, schema: StoreSchema },
      { name: OutboxEvent.name, schema: OutboxEventSchema },
      { name: AuditEntry.name, schema: AuditEntrySchema },
    ]),
  ],
  controllers: [HealthController, AuthController, AdminController],
  providers: [
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    AuthGuard, AuthService, UsersService, SessionsService, OneTimeTokensService, SellersService,
    AuditService, TokenService, PasswordService, Mailer, SeedService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
