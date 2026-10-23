import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel, Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
import { Model } from 'mongoose';
import { AuditService } from '../audit/audit';
import { SessionsService } from '../sessions/sessions.service';
import { UsersService } from '../users/users.service';
import { ApplicationStatus, SellerApplication, Store, StoreStatus } from './seller.schema';

/** Event rows are written here and relayed to RabbitMQ by the outbox publisher (see PROGRESS.md). */
@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'outbox_events' })
export class OutboxEvent {
  @Prop({ type: String, required: true, unique: true })
  eventId!: string;

  /** Natural idempotency key so a retried business operation never emits a second event. */
  @Prop({ type: String, required: true, unique: true })
  dedupeKey!: string;

  @Prop({ type: String, required: true })
  eventType!: string;

  @Prop({ type: String, required: true })
  routingKey!: string;

  @Prop({ type: Object, required: true })
  payload!: Record<string, unknown>;

  @Prop({ type: Date, default: null })
  publishedAt!: Date | null;
}
export const OutboxEventSchema = SchemaFactory.createForClass(OutboxEvent);

interface Page<T> {
  items: T[];
  page: number;
  size: number;
  total: number;
}

@Injectable()
export class SellersService {
  constructor(
    @InjectModel(SellerApplication.name) private readonly applications: Model<SellerApplication>,
    @InjectModel(Store.name) private readonly stores: Model<Store>,
    @InjectModel(OutboxEvent.name) private readonly outbox: Model<OutboxEvent>,
    private readonly users: UsersService,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
  ) {}

  async apply(userId: string, input: { storeName: string; description?: string }): Promise<SellerApplication> {
    if (await this.stores.exists({ ownerUserId: userId })) throw new ConflictException('User already owns a store');
    try {
      const doc = await this.applications.create({ userId, storeName: input.storeName, description: input.description ?? '' });
      return doc.toObject();
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw new ConflictException('A seller application is already pending');
      throw e;
    }
  }

  myApplication(userId: string): Promise<SellerApplication | null> {
    return this.applications.findOne({ userId }).sort({ createdAt: -1 }).lean<SellerApplication>().exec();
  }

  async listApplications(status: ApplicationStatus | undefined, page: number, size: number): Promise<Page<SellerApplication>> {
    const filter = status ? { status } : {};
    const [items, total] = await Promise.all([
      this.applications.find(filter).sort({ createdAt: -1 }).skip(page * size).limit(size).lean<SellerApplication[]>().exec(),
      this.applications.countDocuments(filter),
    ]);
    return { items, page, size, total };
  }

  /**
   * Approval is a sequence of idempotent steps (Mongo standalone has no multi-document transactions):
   * claim PENDING->APPROVED, upsert the store, grant the role, upsert the outbox event.
   * Re-approving an APPROVED application safely repairs a half-finished earlier attempt.
   */
  async approve(applicationId: string, adminId: string): Promise<Store> {
    const app = await this.applications.findById(applicationId).lean<SellerApplication>().exec();
    if (!app) throw new NotFoundException('Application not found');
    if (app.status === 'REJECTED') throw new ConflictException('Application was rejected');
    if (app.status === 'PENDING') {
      const claimed = await this.applications.findOneAndUpdate(
        { _id: applicationId, status: 'PENDING' },
        { $set: { status: 'APPROVED', reviewedBy: adminId } },
      );
      if (claimed) await this.audit.record(adminId, 'SELLER_APPROVED', 'seller_application', applicationId, { userId: app.userId });
    }
    const store = await this.stores
      .findOneAndUpdate(
        { ownerUserId: app.userId },
        { $setOnInsert: { _id: randomUUID(), name: app.storeName, description: app.description, status: 'ACTIVE' } },
        { upsert: true, new: true },
      )
      .lean<Store>()
      .exec();
    await this.users.grantSeller(app.userId, store._id);
    await this.outbox.updateOne(
      { dedupeKey: `SellerApproved:${applicationId}` },
      {
        $setOnInsert: {
          eventId: randomUUID(),
          eventType: 'SellerApproved',
          routingKey: 'seller.approved.v1',
          payload: { storeId: store._id, ownerUserId: app.userId, name: store.name, occurredAt: new Date().toISOString() },
        },
      },
      { upsert: true },
    );
    return store;
  }

  async reject(applicationId: string, adminId: string, reason: string): Promise<SellerApplication> {
    const doc = await this.applications
      .findOneAndUpdate(
        { _id: applicationId, status: 'PENDING' },
        { $set: { status: 'REJECTED', reviewedBy: adminId, rejectionReason: reason } },
        { new: true },
      )
      .lean<SellerApplication>()
      .exec();
    if (!doc) throw new ConflictException('Application is not pending');
    await this.audit.record(adminId, 'SELLER_REJECTED', 'seller_application', applicationId, { reason });
    return doc;
  }

  async setStoreStatus(storeId: string, status: StoreStatus, adminId: string): Promise<Store> {
    const store = await this.stores.findByIdAndUpdate(storeId, { $set: { status } }, { new: true }).lean<Store>().exec();
    if (!store) throw new NotFoundException('Store not found');
    // a suspended seller must stop receiving new tokens that carry the store id
    if (status === 'SUSPENDED') await this.sessions.revokeAllForUser(store.ownerUserId);
    await this.audit.record(adminId, `STORE_${status}`, 'store', storeId);
    return store;
  }

  getStore(storeId: string): Promise<Store | null> {
    return this.stores.findById(storeId).lean<Store>().exec();
  }

  findByOwner(ownerUserId: string): Promise<Store | null> {
    return this.stores.findOne({ ownerUserId }).lean<Store>().exec();
  }

  async listStores(page: number, size: number): Promise<Page<Store>> {
    const [items, total] = await Promise.all([
      this.stores.find().sort({ createdAt: -1 }).skip(page * size).limit(size).lean<Store[]>().exec(),
      this.stores.countDocuments(),
    ]);
    return { items, page, size, total };
  }
}
