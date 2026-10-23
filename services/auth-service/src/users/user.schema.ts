import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
import type { Role } from '../security/roles';

export type UserStatus = 'ACTIVE' | 'DISABLED';

@Schema({ timestamps: true, collection: 'users' })
export class User {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  /** Normalized (trimmed, lower-cased). Unique index prevents duplicate registrations atomically. */
  @Prop({ type: String, required: true, unique: true })
  email!: string;

  @Prop({ type: String, required: true })
  name!: string;

  @Prop({ type: String, required: true })
  passwordHash!: string;

  @Prop({ type: [String], default: ['CUSTOMER'] })
  roles!: Role[];

  @Prop({ type: String, default: 'ACTIVE' })
  status!: UserStatus;

  @Prop({ type: Boolean, default: false })
  emailVerified!: boolean;

  /** Set when the user's seller application is approved. Also the seller id used across services. */
  @Prop({ type: String, default: null })
  storeId!: string | null;

  createdAt!: Date;
}

export const UserSchema = SchemaFactory.createForClass(User);
