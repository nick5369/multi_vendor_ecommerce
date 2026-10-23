import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { Role } from '../security/roles';
import { User, UserStatus } from './user.schema';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  roles: Role[];
  status: UserStatus;
  emailVerified: boolean;
  storeId: string | null;
  createdAt: Date;
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** Never exposes the password hash. */
export function toPublic(u: User): PublicUser {
  return {
    id: u._id,
    email: u.email,
    name: u.name,
    roles: u.roles,
    status: u.status,
    emailVerified: u.emailVerified,
    storeId: u.storeId,
    createdAt: u.createdAt,
  };
}

@Injectable()
export class UsersService {
  constructor(@InjectModel(User.name) private readonly model: Model<User>) {}

  async create(input: { email: string; name: string; passwordHash: string; roles?: Role[]; emailVerified?: boolean }): Promise<User> {
    try {
      const doc = await this.model.create({ ...input, email: normalizeEmail(input.email) });
      return doc.toObject();
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw new ConflictException('Email already registered');
      throw e;
    }
  }

  findByEmail(email: string): Promise<User | null> {
    return this.model.findOne({ email: normalizeEmail(email) }).lean<User>().exec();
  }

  findById(id: string): Promise<User | null> {
    return this.model.findById(id).lean<User>().exec();
  }

  async list(page: number, size: number): Promise<{ items: PublicUser[]; page: number; size: number; total: number }> {
    const [rows, total] = await Promise.all([
      this.model.find().sort({ createdAt: -1 }).skip(page * size).limit(size).lean<User[]>().exec(),
      this.model.countDocuments(),
    ]);
    return { items: rows.map(toPublic), page, size, total };
  }

  async setPasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.model.updateOne({ _id: id }, { $set: { passwordHash } });
  }

  async setStatus(id: string, status: UserStatus): Promise<User | null> {
    return this.model.findByIdAndUpdate(id, { $set: { status } }, { new: true }).lean<User>().exec();
  }

  async markEmailVerified(id: string): Promise<void> {
    await this.model.updateOne({ _id: id }, { $set: { emailVerified: true } });
  }

  /** Idempotent: $addToSet keeps SELLER single even if the approval is retried. */
  async grantSeller(id: string, storeId: string): Promise<void> {
    await this.model.updateOne({ _id: id }, { $addToSet: { roles: 'SELLER' }, $set: { storeId } });
  }
}
