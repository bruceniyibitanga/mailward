// Fixed-window rate limiting with Redis: one counter per key per minute.
// INCR is atomic, so this works correctly even with many API containers.
import { safeRedis } from './clients.js';

export async function checkRateLimit(keyHash, limitPerMin) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const minute = Math.floor(nowSeconds / 60);
  const resetSeconds = 60 - (nowSeconds % 60);
  const counterKey = `rl:${keyHash}:${minute}`;

  const count = await safeRedis(async (r) => {
    const n = await r.incr(counterKey);
    if (n === 1) await r.expire(counterKey, 70);
    return n;
  });

  // If Redis is unavailable we "fail open": allow the request rather than
  // blocking every customer. This is a deliberate trade-off (see report).
  if (count === null) return { allowed: true, remaining: limitPerMin, resetSeconds };

  return {
    allowed: count <= limitPerMin,
    remaining: Math.max(0, limitPerMin - count),
    resetSeconds,
  };
}
