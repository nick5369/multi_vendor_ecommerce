import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

const COST = 12;

@Injectable()
export class PasswordService {
  // compared against when the account does not exist, so login timing does not reveal registered emails
  private readonly decoy = bcrypt.hashSync('decoy-password-not-used', COST);

  hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, COST);
  }

  async verify(plain: string, hash: string | null): Promise<boolean> {
    const ok = await bcrypt.compare(plain, hash ?? this.decoy);
    return ok && hash !== null;
  }
}
