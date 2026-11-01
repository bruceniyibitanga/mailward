// Admin endpoints used only by the dashboard (backend-for-frontend).
// Two layers of protection:
//   1. Network: the public load balancer never forwards /admin/*, so these are
//      only reachable inside the VPC (via the internal load balancer).
//   2. Identity: every call must carry a valid Cognito access token.
import { Router } from 'express';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../clients.js';
import { config } from '../config.js';
import { generateKey, hashKey, forgetKey } from '../keys.js';
import { extractDomain } from '../domain.js';
import { parseAddress, withMailbox } from '../mailbox.js';
import { lookup, getVerdict, getJob, enqueueAnalysis } from '../verdicts.js';
import { processBatch, validateBatchBody } from '../bulk.js';
import { checkRateLimit } from '../ratelimit.js';
import { emitMetrics } from '../metrics.js';
import { getOpsSummary } from '../ops.js';

export const adminRouter = Router();

const verifier = CognitoJwtVerifier.create({
  userPoolId: config.userPoolId,
  tokenUse: 'access',
  clientId: config.cognitoClientId,
});

adminRouter.use(async (req, res, next) => {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing_token' });
  try {
    const payload = await verifier.verify(token);
    req.user = { sub: payload.sub };
    next();
  } catch {
    res.status(401).json({ error: 'invalid_token' });
  }
});

// Create a key. The raw key is returned ONCE and never stored.
adminRouter.post('/keys', async (req, res) => {
  const name = String(req.body?.name ?? 'Untitled key').slice(0, 60);
  const rawKey = generateKey();
  const hash = hashKey(rawKey);
  const now = new Date().toISOString();
  const prefix = rawKey.slice(0, 14);

  // Two items written together (all or nothing):
  // KEY#hash  -> lets the API validate a key in one read
  // USER#sub  -> lets the dashboard list a user's keys without scanning the table
  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName: config.tableName, Item: {
        PK: `KEY#${hash}`, SK: 'META', ownerSub: req.user.sub, name, prefix,
        createdAt: now, revoked: false, rateLimitPerMin: config.defaultRateLimitPerMin,
      } } },
      { Put: { TableName: config.tableName, Item: {
        PK: `USER#${req.user.sub}`, SK: `KEY#${hash}`, hash, name, prefix, createdAt: now, revoked: false,
      } } },
    ],
  }));

  res.status(201).json({ key: rawKey, hash, name, prefix, createdAt: now });
});

adminRouter.get('/keys', async (req, res) => {
  const { Items = [] } = await ddb.send(new QueryCommand({
    TableName: config.tableName,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `USER#${req.user.sub}`, ':sk': 'KEY#' },
  }));
  res.json({ keys: Items.map(({ hash, name, prefix, createdAt, revoked }) => ({ hash, name, prefix, createdAt, revoked })) });
});

adminRouter.delete('/keys/:hash', async (req, res) => {
  const { hash } = req.params;
  const { Item } = await ddb.send(new GetCommand({
    TableName: config.tableName,
    Key: { PK: `KEY#${hash}`, SK: 'META' },
  }));
  if (!Item || Item.ownerSub !== req.user.sub) return res.status(404).json({ error: 'not_found' });

  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      { Update: { TableName: config.tableName, Key: { PK: `KEY#${hash}`, SK: 'META' },
        UpdateExpression: 'SET revoked = :t', ExpressionAttributeValues: { ':t': true } } },
      { Update: { TableName: config.tableName, Key: { PK: `USER#${req.user.sub}`, SK: `KEY#${hash}` },
        UpdateExpression: 'SET revoked = :t', ExpressionAttributeValues: { ':t': true } } },
    ],
  }));
  await forgetKey(hash); // revoke takes effect immediately, not after the cache expires
  res.status(204).end();
});

// Usage per key per day, for the last N days.
adminRouter.get('/usage', async (req, res) => {
  const days = Math.min(Number(req.query.days ?? 7), 30);
  const from = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);

  const { Items: keys = [] } = await ddb.send(new QueryCommand({
    TableName: config.tableName,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': `USER#${req.user.sub}`, ':sk': 'KEY#' },
  }));

  const usage = await Promise.all(keys.map(async (key) => {
    const { Items = [] } = await ddb.send(new QueryCommand({
      TableName: config.tableName,
      KeyConditionExpression: 'PK = :pk AND SK BETWEEN :from AND :to',
      ExpressionAttributeValues: { ':pk': `USAGE#${key.hash}`, ':from': `DAY#${from}`, ':to': `DAY#${to}` },
    }));
    return {
      name: key.name,
      prefix: key.prefix,
      days: Items.map((d) => ({ day: d.SK.slice(4), requests: d.requests ?? 0, cacheHits: d.cacheHits ?? 0, queued: d.queued ?? 0 })),
    };
  }));

  res.json({ from, to, usage });
});

// "Try it" box in the dashboard. Same lookup logic, no API key needed because
// the user is already signed in.
adminRouter.post('/try', async (req, res) => {
  const address = parseAddress(req.body?.email);
  if (!address) return res.status(400).json({ error: 'invalid_email_or_domain' });
  const out = await lookup(address.domain, `USER#${req.user.sub}`);
  res.status(out.status).json(withMailbox(out.body, address));
});

// Bulk check for the CSV upload page: up to 100 addresses per request, answered in the same
// order. Nothing about an address is stored or logged; only counts are published as metrics.
const BULK_REQUESTS_PER_MIN = 240; // per signed-in user (fails open if the cache is down)

adminRouter.post('/check/batch', async (req, res) => {
  const body = validateBatchBody(req.body);
  if (!body.ok) return res.status(400).json({ error: body.error });

  const limit = await checkRateLimit(`bulk:${req.user.sub}`, BULK_REQUESTS_PER_MIN);
  if (!limit.allowed) {
    res.set('Retry-After', String(limit.resetSeconds));
    return res.status(429).json({ error: 'rate_limited', retryAfterSeconds: limit.resetSeconds });
  }

  const started = Date.now();
  const results = await processBatch({
    emails: body.emails,
    mode: body.mode,
    parseAddress,
    withMailbox,
    getVerdict,
    getJob,
    enqueue: (domain) => enqueueAnalysis(domain, `USER#${req.user.sub}`),
    onError: (domain, err) => console.error(JSON.stringify({ level: 'warn', msg: 'bulk lookup failed', domain, err: `${err?.name}: ${String(err?.message).slice(0, 120)}` })),
  });
  emitMetrics('api', {
    BulkRows: results.length,
    BulkDeferred: results.filter((r) => r.status === 'deferred').length,
    BulkLatency: Date.now() - started,
  });

  res.set('Cache-Control', 'no-store');
  res.json({ results });
});

adminRouter.get('/ops', async (req, res) => {
  res.json(await getOpsSummary());
});

// Lets the try-it box poll for the final verdict of an unknown domain.
adminRouter.get('/domains/:domain', async (req, res) => {
  const domain = extractDomain(req.params.domain);
  if (!domain) return res.status(400).json({ error: 'invalid_domain' });
  const [verdict, job] = await Promise.all([
    ddb.send(new GetCommand({ TableName: config.tableName, Key: { PK: `DOMAIN#${domain}`, SK: 'VERDICT' } })),
    ddb.send(new GetCommand({ TableName: config.tableName, Key: { PK: `DOMAIN#${domain}`, SK: 'JOB' } })),
  ]);
  res.json({ domain, job: job.Item ?? null, verdict: verdict.Item ?? null });
});

// Lets a signed-in user change the rate limit of one of their own API keys.
adminRouter.post('/keys/:hash/limit', async (req, res) => {
  const { hash } = req.params;
  const limit = Math.min(Math.max(Number(req.body?.rateLimitPerMin ?? 600), 1), 1_000_000);
  const { Item } = await ddb.send(new GetCommand({ TableName: config.tableName, Key: { PK: `KEY#${hash}`, SK: 'META' } }));
  if (!Item || Item.ownerSub !== req.user.sub) return res.status(404).json({ error: 'not_found' });
  await ddb.send(new UpdateCommand({
    TableName: config.tableName,
    Key: { PK: `KEY#${hash}`, SK: 'META' },
    UpdateExpression: 'SET rateLimitPerMin = :l',
    ExpressionAttributeValues: { ':l': limit },
  }));
  await forgetKey(hash);
  res.json({ hash, rateLimitPerMin: limit });
});
