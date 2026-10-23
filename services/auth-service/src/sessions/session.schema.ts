import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

/** Refresh-token session. Only the SHA-256 of the opaque token is stored. */
@Schema({ timestamps: true, collection: 'refresh_sessions' })
export class RefreshSession {
  @Prop({ type: String, required: true, unique: true })
  tokenHash!: string;

  @Prop({ type: String, required: true, index: true })
  userId!: string;

  /** All tokens descended from one login share a family so reuse of a rotated token revokes the lot. */
  @Prop({ type: String, required: true, index: true })
  familyId!: string;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  @Prop({ type: Date, default: null })
  revokedAt!: Date | null;
}
export const RefreshSessionSchema = SchemaFactory.createForClass(RefreshSession);
RefreshSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86400 * 30 });

export type OneTimePurpose = 'PASSWORD_RESET' | 'EMAIL_VERIFY';

@Schema({ timestamps: true, collection: 'one_time_tokens' })
export class OneTimeToken {
  @Prop({ type: String, required: true, unique: true })
  tokenHash!: string;

  @Prop({ type: String, required: true })
  userId!: string;

  @Prop({ type: String, required: true })
  purpose!: OneTimePurpose;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  @Prop({ type: Date, default: null })
  usedAt!: Date | null;
}
export const OneTimeTokenSchema = SchemaFactory.createForClass(OneTimeToken);
OneTimeTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86400 });
