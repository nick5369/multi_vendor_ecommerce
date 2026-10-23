import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';

export type ApplicationStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type StoreStatus = 'ACTIVE' | 'SUSPENDED';

@Schema({ timestamps: true, collection: 'seller_applications' })
export class SellerApplication {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  userId!: string;

  @Prop({ type: String, required: true })
  storeName!: string;

  @Prop({ type: String, default: '' })
  description!: string;

  @Prop({ type: String, default: 'PENDING' })
  status!: ApplicationStatus;

  @Prop({ type: String, default: null })
  reviewedBy!: string | null;

  @Prop({ type: String, default: null })
  rejectionReason!: string | null;

  createdAt!: Date;
}
export const SellerApplicationSchema = SchemaFactory.createForClass(SellerApplication);
// at most one open application per user, enforced by the database
SellerApplicationSchema.index({ userId: 1 }, { unique: true, partialFilterExpression: { status: 'PENDING' }, name: 'one_pending_per_user' });

@Schema({ timestamps: true, collection: 'stores' })
export class Store {
  /** Public store/seller id, referenced by catalog, inventory and orders. */
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true, unique: true })
  ownerUserId!: string;

  @Prop({ type: String, required: true })
  name!: string;

  @Prop({ type: String, default: '' })
  description!: string;

  @Prop({ type: String, default: 'ACTIVE' })
  status!: StoreStatus;

  createdAt!: Date;
}
export const StoreSchema = SchemaFactory.createForClass(Store);
