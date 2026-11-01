// Usage counting with write coalescing.
// Writing to DynamoDB on every request would mean thousands of writes per
// second to the same item during a load test (a "hot key"). Instead each
// container counts in memory and flushes the totals every 15 seconds.
// Trade-off: if a container crashes, up to 15 seconds of counts are lost.
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './clients.js';
import { config } from './config.js';

const pending = new Map(); // "hash|2026-10-15" -> { requests, cacheHits, queued }

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function recordUsage(keyHash, { cacheHit = false, queued = false } = {}) {
  const id = `${keyHash}|${today()}`;
  const entry = pending.get(id) ?? { requests: 0, cacheHits: 0, queued: 0 };
  entry.requests += 1;
  if (cacheHit) entry.cacheHits += 1;
  if (queued) entry.queued += 1;
  pending.set(id, entry);
}

export async function flushUsage() {
  const batch = [...pending.entries()];
  pending.clear();

  await Promise.all(batch.map(async ([id, counts]) => {
    const [keyHash, day] = id.split('|');
    try {
      await ddb.send(new UpdateCommand({
        TableName: config.tableName,
        Key: { PK: `USAGE#${keyHash}`, SK: `DAY#${day}` },
        UpdateExpression: 'ADD requests :r, cacheHits :c, queued :q',
        ExpressionAttributeValues: { ':r': counts.requests, ':c': counts.cacheHits, ':q': counts.queued },
      }));
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'usage flush failed', err: err.message }));
    }
  }));
}

let timer;
export function startUsageFlusher() {
  timer = setInterval(() => { flushUsage(); }, 15_000);
  timer.unref();
}
export function stopUsageFlusher() {
  clearInterval(timer);
}
