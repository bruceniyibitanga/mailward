// API keys. We never store the real key, only a SHA-256 hash of it.
// If the database leaked, nobody could use the hashes to call the API.
import crypto from 'node:crypto';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, safeRedis } from './clients.js';
import { config } from './config.js';

export function generateKey() {
  return `xv_live_${crypto.randomBytes(24).toString('base64url')}`;
}

export function hashKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

const KEY_CACHE_SECONDS = 300;
const INVALID_CACHE_SECONDS = 60;

// Returns the key record if the key is valid and not revoked, otherwise null.
// Checks Redis first so most requests never touch DynamoDB for key checks.
export async function validateKey(rawKey) {
  if (!rawKey || typeof rawKey !== 'string' || rawKey.length > 200) return null;
  const hash = hashKey(rawKey);

  const cached = await safeRedis((r) => r.get(`key:${hash}`));
  if (cached === 'invalid') return null;
  if (cached) return JSON.parse(cached);

  const { Item } = await ddb.send(new GetCommand({
    TableName: config.tableName,
    Key: { PK: `KEY#${hash}`, SK: 'META' },
  }));

  if (!Item || Item.revoked) {
    await safeRedis((r) => r.set(`key:${hash}`, 'invalid', 'EX', INVALID_CACHE_SECONDS));
    return null;
  }

  const record = {
    hash,
    ownerSub: Item.ownerSub,
    rateLimitPerMin: Item.rateLimitPerMin ?? config.defaultRateLimitPerMin,
  };
  await safeRedis((r) => r.set(`key:${hash}`, JSON.stringify(record), 'EX', KEY_CACHE_SECONDS));
  return record;
}

// Called when a key is revoked so the revoke takes effect immediately
// instead of after the cache expires.
export async function forgetKey(hash) {
  await safeRedis((r) => r.del(`key:${hash}`));
}
