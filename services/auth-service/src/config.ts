function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env ${key}`);
  return value;
}

function decodeKey(key: string): string {
  return Buffer.from(required(key), 'base64').toString('utf8');
}

const int = (key: string, fallback: number): number => Number(process.env[key] ?? fallback);

export const config = {
  port: int('PORT', 3001),
  mongoUri: required('MONGODB_URI'),
  privateKey: decodeKey('JWT_PRIVATE_KEY_BASE64'),
  publicKey: decodeKey('JWT_PUBLIC_KEY_BASE64'),
  issuer: process.env.JWT_ISSUER ?? 'mve-auth',
  audience: process.env.JWT_AUDIENCE ?? 'mve-api',
  accessTtlSeconds: int('JWT_ACCESS_TTL_SECONDS', 900),
  refreshTtlSeconds: int('REFRESH_TTL_SECONDS', 1209600),
  resetTtlSeconds: int('RESET_TTL_SECONDS', 1800),
  verifyTtlSeconds: int('VERIFY_TTL_SECONDS', 86400),
  adminSeedEmail: process.env.ADMIN_SEED_EMAIL ?? '',
  adminSeedPassword: process.env.ADMIN_SEED_PASSWORD ?? '',
  seedDemoData: process.env.SEED_DEMO_DATA === 'true',
  demoPassword: process.env.DEMO_USER_PASSWORD ?? '',
  mailMode: process.env.MAIL_MODE ?? 'log',
  corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').filter(Boolean),
};
