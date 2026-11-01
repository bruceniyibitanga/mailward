// The heart of the lookup: cache -> database -> queue.
import crypto from 'node:crypto';
import { GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { ddb, sqs, safeRedis } from './clients.js';
import { config } from './config.js';

const CACHE_SECONDS = 3600;              // keep hot verdicts in Redis for 1 hour
const FRESH_MS = 7 * 24 * 60 * 60 * 1000; // analysed verdicts are re-checked after 7 days
// "unverified" means we found no evidence either way, so look again sooner: the mail-server
// data grows every day and the answer may change.
const UNVERIFIED_FRESH_MS = 24 * 60 * 60 * 1000;
const UNVERIFIED_CACHE_SECONDS = 300;

// Verdicts from the public list or the allowlist never go stale.
// Only verdicts our own workers produced get re-checked.
function isStale(item) {
  if (item.source !== 'analysis') return false;
  const limit = item.verdict === 'unverified' ? UNVERIFIED_FRESH_MS : FRESH_MS;
  return Date.now() - Date.parse(item.checkedAt) > limit;
}

function toResponse(item, source) {
  return {
    domain: item.domain,
    verdict: item.verdict,
    confidence: item.confidence,
    source,
    signals: item.signals ?? {},
    checkedAt: item.checkedAt,
  };
}

// Returns { result, cacheHit } or null if we have never seen this domain.
export async function getVerdict(domain) {
  const cached = await safeRedis((r) => r.get(`verdict:${domain}`));
  if (cached) return { result: { ...JSON.parse(cached), source: 'cache' }, cacheHit: true };

  const { Item } = await ddb.send(new GetCommand({
    TableName: config.tableName,
    Key: { PK: `DOMAIN#${domain}`, SK: 'VERDICT' },
  }));
  if (!Item) return null;

  const result = toResponse(Item, 'store');
  const ttl = Item.verdict === 'unverified' ? UNVERIFIED_CACHE_SECONDS : CACHE_SECONDS;
  await safeRedis((r) => r.set(`verdict:${domain}`, JSON.stringify(result), 'EX', ttl));

  // Stale-while-revalidate: answer now with what we have, refresh in the background.
  if (isStale(Item)) {
    enqueueAnalysis(domain, 'refresh').catch((err) =>
      console.error(JSON.stringify({ level: 'warn', msg: 'refresh enqueue failed', domain, err: err.message })));
  }
  return { result, cacheHit: false };
}

// Queues a domain for analysis. A conditional write on the JOB record makes
// sure the same domain is not queued twice while a job is already pending.
export async function enqueueAnalysis(domain, requestedBy) {
  const checkId = `c_${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();

  try {
    await ddb.send(new PutCommand({
      TableName: config.tableName,
      Item: { PK: `DOMAIN#${domain}`, SK: 'JOB', domain, status: 'queued', checkId, queuedAt: now, attempts: 0 },
      ConditionExpression: 'attribute_not_exists(PK) OR #s IN (:done, :failed)',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':done': 'done', ':failed': 'failed' },
    }));
  } catch (err) {
    if (err.name !== 'ConditionalCheckFailedException') throw err;
    // Already queued or running: hand back the existing job instead.
    const { Item } = await ddb.send(new GetCommand({
      TableName: config.tableName,
      Key: { PK: `DOMAIN#${domain}`, SK: 'JOB' },
    }));
    return { checkId: Item?.checkId, status: Item?.status ?? 'queued', alreadyQueued: true };
  }

  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl: config.queueUrl,
      MessageBody: JSON.stringify({ checkId, domain, requestedBy, enqueuedAt: now }),
    }));
  } catch (err) {
    // The job record says "queued" but the message never made it, so remove
    // the record. Otherwise the domain could never be queued again.
    await ddb.send(new DeleteCommand({
      TableName: config.tableName,
      Key: { PK: `DOMAIN#${domain}`, SK: 'JOB' },
    })).catch(() => {});
    throw err;
  }

  return { checkId, status: 'queued', alreadyQueued: false };
}

export async function getJob(domain) {
  const { Item } = await ddb.send(new GetCommand({
    TableName: config.tableName,
    Key: { PK: `DOMAIN#${domain}`, SK: 'JOB' },
  }));
  return Item ?? null;
}

// Full lookup used by both the public API and the dashboard "try it" box.
// Returns { status, body, cacheHit, queued }.
export async function lookup(domain, requestedBy) {
  const found = await getVerdict(domain);
  if (found) return { status: 200, body: found.result, cacheHit: found.cacheHit, queued: false };

  const job = await enqueueAnalysis(domain, requestedBy);
  return {
    status: 202,
    cacheHit: false,
    queued: !job.alreadyQueued,
    body: {
      domain,
      verdict: 'unknown',
      confidence: 0.3,
      source: 'pending',
      checkId: job.checkId,
      status: job.status,
      pollUrl: `/v1/domains/${domain}`,
    },
  };
}
