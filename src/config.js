import crypto from 'node:crypto';

const rand = () => crypto.randomBytes(32).toString('hex');
const isProd = process.env.NODE_ENV === 'production';

function secret(name) {
  const v = process.env[name];
  if (v) return v;
  if (isProd) throw new Error(`Missing required env var ${name}`);
  const dev = rand();
  console.warn(`[config] ${name} not set; using an ephemeral dev value`);
  return dev;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  dataDir: process.env.DATA_DIR || './data',
  today: process.env.CDP_TODAY || '2026-09-28',
  appPassword: process.env.APP_PASSWORD || (isProd ? secret('APP_PASSWORD') : 'dev'),
  sessionSecret: secret('SESSION_SECRET'),
  webhookSecret: process.env.WEBHOOK_SECRET || (isProd ? secret('WEBHOOK_SECRET') : 'dev-webhook-secret'),
  piiHashKey: secret('PII_HASH_KEY'),
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  isProd,
};

/** "Today" as a Date at 00:00 UTC. */
export const todayDate = () => new Date(config.today + 'T00:00:00Z');
