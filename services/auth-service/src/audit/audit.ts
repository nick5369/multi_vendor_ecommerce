import { Injectable } from '@nestjs/common';
import { InjectModel, Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Model } from 'mongoose';

@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'audit_entries' })
export class AuditEntry {
  @Prop({ type: String, required: true })
  actorId!: string;

  @Prop({ type: String, required: true, index: true })
  action!: string;

  @Prop({ type: String, required: true })
  targetType!: string;

  @Prop({ type: String, required: true })
  targetId!: string;

  @Prop({ type: Object, default: {} })
  details!: Record<string, unknown>;

  createdAt!: Date;
}
export const AuditEntrySchema = SchemaFactory.createForClass(AuditEntry);

@Injectable()
export class AuditService {
  constructor(@InjectModel(AuditEntry.name) private readonly model: Model<AuditEntry>) {}

  async record(actorId: string, action: string, targetType: string, targetId: string, details: Record<string, unknown> = {}): Promise<void> {
    await this.model.create({ actorId, action, targetType, targetId, details });
  }

  async list(page: number, size: number): Promise<{ items: AuditEntry[]; page: number; size: number; total: number }> {
    const [items, total] = await Promise.all([
      this.model.find().sort({ createdAt: -1 }).skip(page * size).limit(size).lean<AuditEntry[]>().exec(),
      this.model.countDocuments(),
    ]);
    return { items, page, size, total };
  }
}
