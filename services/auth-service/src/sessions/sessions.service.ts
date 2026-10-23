import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { Model } from 'mongoose';
import { config } from '../config';
import { OneTimePurpose, OneTimeToken, RefreshSession } from './session.schema';

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const newSecret = (): string => randomBytes(48).toString('base64url');

@Injectable()
export class SessionsService {
  constructor(@InjectModel(RefreshSession.name) private readonly model: Model<RefreshSession>) {}

  async issue(userId: string, familyId: string = randomUUID()): Promise<{ token: string; familyId: string }> {
    const token = newSecret();
    await this.model.create({
      tokenHash: sha256(token),
      userId,
      familyId,
      expiresAt: new Date(Date.now() + config.refreshTtlSeconds * 1000),
    });
    return { token, familyId };
  }

  /**
   * Atomically consumes a valid refresh token and issues its successor in the same family.
   * Presenting an already-rotated token is treated as theft: the whole family is revoked.
   */
  async rotate(token: string): Promise<{ userId: string; token: string }> {
    const hash = sha256(token);
    const now = new Date();
    const consumed = await this.model
      .findOneAndUpdate({ tokenHash: hash, revokedAt: null, expiresAt: { $gt: now } }, { $set: { revokedAt: now } })
      .lean<RefreshSession>()
      .exec();
    if (!consumed) {
      const stale = await this.model.findOne({ tokenHash: hash }).lean<RefreshSession>().exec();
      if (stale?.revokedAt) await this.revokeFamily(stale.familyId);
      throw new UnauthorizedException('Invalid refresh token');
    }
    const next = await this.issue(consumed.userId, consumed.familyId);
    return { userId: consumed.userId, token: next.token };
  }

  async revokeByToken(token: string): Promise<void> {
    const doc = await this.model.findOne({ tokenHash: sha256(token) }).lean<RefreshSession>().exec();
    if (doc) await this.revokeFamily(doc.familyId);
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.model.updateMany({ familyId, revokedAt: null }, { $set: { revokedAt: new Date() } });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.model.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
  }
}

@Injectable()
export class OneTimeTokensService {
  constructor(@InjectModel(OneTimeToken.name) private readonly model: Model<OneTimeToken>) {}

  async create(userId: string, purpose: OneTimePurpose, ttlSeconds: number): Promise<string> {
    const token = newSecret();
    await this.model.create({ tokenHash: sha256(token), userId, purpose, expiresAt: new Date(Date.now() + ttlSeconds * 1000) });
    return token;
  }

  /** Single use: the conditional update succeeds for exactly one caller. */
  async consume(token: string, purpose: OneTimePurpose): Promise<string> {
    const now = new Date();
    const doc = await this.model
      .findOneAndUpdate({ tokenHash: sha256(token), purpose, usedAt: null, expiresAt: { $gt: now } }, { $set: { usedAt: now } })
      .lean<OneTimeToken>()
      .exec();
    if (!doc) throw new UnauthorizedException('Invalid or expired token');
    return doc.userId;
  }
}
