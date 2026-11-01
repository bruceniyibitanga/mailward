// Public endpoints: reachable from the internet through CloudFront + the load balancer.
import { Router } from 'express';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3 } from '../clients.js';
import { config } from '../config.js';
import { extractDomain } from '../domain.js';
import { parseAddress, withMailbox } from '../mailbox.js';
import { validateKey } from '../keys.js';
import { checkRateLimit } from '../ratelimit.js';
import { recordUsage } from '../usage.js';
import { lookup, getVerdict, getJob } from '../verdicts.js';
import { emitMetrics } from '../metrics.js';

export const publicRouter = Router();

// Load balancer health check. Keep it cheap: no database calls.
publicRouter.get('/healthz', (req, res) => res.json({ ok: true }));

// Middleware: every /v1 route below this (except the list download) needs a valid key.
async function requireApiKey(req, res, next) {
  const key = await validateKey(req.get('x-api-key'));
  if (!key) return res.status(401).json({ error: 'invalid_api_key' });

  const limit = await checkRateLimit(key.hash, key.rateLimitPerMin);
  res.set('X-RateLimit-Limit', String(key.rateLimitPerMin));
  res.set('X-RateLimit-Remaining', String(limit.remaining));
  if (!limit.allowed) {
    res.set('Retry-After', String(limit.resetSeconds));
    return res.status(429).json({ error: 'rate_limited', retryAfterSeconds: limit.resetSeconds });
  }

  req.apiKey = key;
  next();
}

// Public, unauthenticated, and cached at the edge by CloudFront.
publicRouter.get('/v1/lists/latest', async (req, res) => {
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: config.bucketName, Key: 'lists/latest.txt' }));
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    obj.Body.pipe(res);
  } catch (err) {
    if (err.name === 'NoSuchKey') return res.status(404).json({ error: 'list_not_generated_yet' });
    throw err;
  }
});

publicRouter.get('/v1/check', requireApiKey, async (req, res) => {
  const started = Date.now();
  const address = parseAddress(req.query.email ?? req.query.domain);
  if (!address) return res.status(400).json({ error: 'invalid_email_or_domain' });
  const { domain } = address;

  const out = await lookup(domain, `KEY#${req.apiKey.hash}`);
  recordUsage(req.apiKey.hash, { cacheHit: out.cacheHit, queued: out.queued });
  emitMetrics('api', {
    Lookups: 1,
    CacheHit: out.cacheHit ? 1 : 0,
    Enqueued: out.queued ? 1 : 0,
    LookupLatency: Date.now() - started,
  });

  // Authenticated answers must never be cached by CloudFront or browsers.
  res.set('Cache-Control', 'no-store');
  // Domain verdict (cached, shared) + mailbox assessment (computed now, from this request only).
  res.status(out.status).json(withMailbox(out.body, address));
});

publicRouter.post('/v1/check/batch', requireApiKey, async (req, res) => {
  const items = Array.isArray(req.body?.emails) ? req.body.emails : null;
  if (!items || items.length === 0 || items.length > 100) {
    return res.status(400).json({ error: 'send_between_1_and_100_emails' });
  }

  const results = await Promise.all(items.map(async (input) => {
    const address = parseAddress(input);
    if (!address) return { input, error: 'invalid_email_or_domain' };
    const out = await lookup(address.domain, `KEY#${req.apiKey.hash}`);
    recordUsage(req.apiKey.hash, { cacheHit: out.cacheHit, queued: out.queued });
    emitMetrics('api', { Lookups: 1, CacheHit: out.cacheHit ? 1 : 0, Enqueued: out.queued ? 1 : 0 });
    return withMailbox(out.body, address);
  }));

  res.set('Cache-Control', 'no-store');
  res.json({ results });
});

// Polling endpoint for unknown domains (the "request callback / polling" pattern).
publicRouter.get('/v1/domains/:domain', requireApiKey, async (req, res) => {
  const domain = extractDomain(req.params.domain);
  if (!domain) return res.status(400).json({ error: 'invalid_domain' });

  const [found, job] = await Promise.all([getVerdict(domain), getJob(domain)]);
  res.set('Cache-Control', 'no-store');
  if (!found && !job) return res.status(404).json({ error: 'never_checked' });

  res.json({
    domain,
    job: job ? { checkId: job.checkId, status: job.status, queuedAt: job.queuedAt, finishedAt: job.finishedAt } : null,
    result: found?.result ?? null,
  });
});
