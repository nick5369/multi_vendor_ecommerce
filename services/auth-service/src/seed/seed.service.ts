import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { logJson } from '../common/request-context';
import { config } from '../config';
import { Store } from '../sellers/seller.schema';
import { PasswordService } from '../security/password.service';
import { UsersService } from '../users/users.service';
import type { Role } from '../security/roles';

/**
 * Fixed store ids so catalog/inventory seed data can reference them.
 * DEMO DATA ONLY: never enable SEED_DEMO_DATA outside a local developer machine.
 */
export const DEMO_STORES = {
  alpha: '11111111-1111-4111-8111-111111111111',
  beta: '22222222-2222-4222-8222-222222222222',
};

const DEMO_USERS: { email: string; name: string; roles: Role[]; store?: keyof typeof DEMO_STORES; storeName?: string }[] = [
  { email: 'seller.alpha@demo.local', name: 'Demo Seller Alpha (NON-PRODUCTION)', roles: ['CUSTOMER', 'SELLER'], store: 'alpha', storeName: 'Alpha Gadgets (demo)' },
  { email: 'seller.beta@demo.local', name: 'Demo Seller Beta (NON-PRODUCTION)', roles: ['CUSTOMER', 'SELLER'], store: 'beta', storeName: 'Beta Home (demo)' },
  { email: 'customer.one@demo.local', name: 'Demo Customer One (NON-PRODUCTION)', roles: ['CUSTOMER'] },
  { email: 'customer.two@demo.local', name: 'Demo Customer Two (NON-PRODUCTION)', roles: ['CUSTOMER'] },
];

@Injectable()
export class SeedService implements OnApplicationBootstrap {
  constructor(
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    @InjectModel(Store.name) private readonly stores: Model<Store>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.seedAdmin();
    if (config.seedDemoData) await this.seedDemo();
  }

  private async seedAdmin(): Promise<void> {
    if (!config.adminSeedEmail || !config.adminSeedPassword) return;
    if (await this.users.findByEmail(config.adminSeedEmail)) return;
    await this.users.create({
      email: config.adminSeedEmail,
      name: 'Local Admin',
      passwordHash: await this.passwords.hash(config.adminSeedPassword),
      roles: ['ADMIN', 'CUSTOMER'],
      emailVerified: true,
    });
    logJson('info', { event: 'ADMIN_SEEDED', email: config.adminSeedEmail });
  }

  private async seedDemo(): Promise<void> {
    if (!config.demoPassword) {
      logJson('warn', { event: 'DEMO_SEED_SKIPPED', reason: 'DEMO_USER_PASSWORD not set' });
      return;
    }
    for (const d of DEMO_USERS) {
      let user = await this.users.findByEmail(d.email);
      if (!user) {
        user = await this.users.create({
          email: d.email, name: d.name, roles: d.roles, emailVerified: true,
          passwordHash: await this.passwords.hash(config.demoPassword),
        });
      }
      if (d.store) {
        const storeId = DEMO_STORES[d.store];
        await this.stores.updateOne(
          { _id: storeId },
          { $setOnInsert: { ownerUserId: user._id, name: d.storeName, description: 'Demo store (non-production)', status: 'ACTIVE' } },
          { upsert: true },
        );
        await this.users.grantSeller(user._id, storeId);
      }
    }
    logJson('info', { event: 'DEMO_DATA_SEEDED', users: DEMO_USERS.length });
  }
}
