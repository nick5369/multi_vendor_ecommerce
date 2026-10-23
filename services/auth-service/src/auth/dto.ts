import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsInt, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const PASSWORD = { min: 10, max: 128 };

export class RegisterDto {
  @Transform(trim) @IsEmail() @MaxLength(254)
  email!: string;

  @IsString() @Length(PASSWORD.min, PASSWORD.max)
  password!: string;

  @Transform(trim) @IsString() @Length(1, 100)
  name!: string;
}

export class LoginDto {
  @Transform(trim) @IsEmail()
  email!: string;

  @IsString() @MaxLength(PASSWORD.max)
  password!: string;
}

export class RefreshDto {
  @IsOptional() @IsString() @MaxLength(200)
  refreshToken?: string;
}

export class ChangePasswordDto {
  @IsString() @MaxLength(PASSWORD.max)
  currentPassword!: string;

  @IsString() @Length(PASSWORD.min, PASSWORD.max)
  newPassword!: string;
}

export class ForgotPasswordDto {
  @Transform(trim) @IsEmail()
  email!: string;
}

export class ResetPasswordDto {
  @IsString() @Length(20, 200)
  token!: string;

  @IsString() @Length(PASSWORD.min, PASSWORD.max)
  newPassword!: string;
}

export class VerifyEmailDto {
  @IsString() @Length(20, 200)
  token!: string;
}

export class ApplyAsSellerDto {
  @Transform(trim) @IsString() @Length(2, 100)
  storeName!: string;

  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000)
  description?: string;
}

export class RejectDto {
  @Transform(trim) @IsString() @Length(1, 500)
  reason!: string;
}

export class UserStatusDto {
  @IsIn(['ACTIVE', 'DISABLED'])
  status!: 'ACTIVE' | 'DISABLED';
}

export class StoreStatusDto {
  @IsIn(['ACTIVE', 'SUSPENDED'])
  status!: 'ACTIVE' | 'SUSPENDED';
}

export class PageQuery {
  @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(0)
  page: number = 0;

  @IsOptional() @Transform(({ value }) => Number(value)) @IsInt() @Min(1) @Max(100)
  size: number = 20;

  @IsOptional() @IsIn(['PENDING', 'APPROVED', 'REJECTED'])
  status?: 'PENDING' | 'APPROVED' | 'REJECTED';
}
