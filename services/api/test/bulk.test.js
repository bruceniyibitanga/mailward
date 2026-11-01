// Run with:  cd services/api && npm test
// The bulk module has no AWS dependencies, so these tests use small stand-ins for the
// verdict lookup, the job lookup and the queue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { processBatch, validateBatchBody, MAX_EMAILS_PER_REQUEST } from '../src/bulk.js';
import { parseAddress, withMailbox } from '../src/mailbox.js';

// A stand-in "database": domain -> verdict body. Anything else is unknown.
function makeDeps({ known = {}, jobs = {}, failFor = [], delayMs = 0 } = {}) {
  const calls = { getVerdict: [], getJob: [], enqueue: [] };
  let running = 0;
  let peak = 0;
  const wait = () => new Promise((r) => setTimeout(r, delayMs));
  return {
    calls,
    peakConcurrency: () => peak,
    deps: {
      parseAddress,
      withMailbox,
      async getVerdict(domain) {
        calls.getVerdict.push(domain);
        running++; peak = Math.max(peak, running);
        if (delayMs) await wait();
        running--;
        if (failFor.includes(domain)) throw new Error('database unavailable');
        return known[domain] ? { result: { domain, ...known[domain], source: 'store' }, cacheHit: false } : null;
      },
      async getJob(domain) { calls.getJob.push(domain); return jobs[domain] ?? null; },
      async enqueue(domain) { calls.enqueue.push(domain); return { alreadyQueued: false }; },
    },
  };
}

const GOOD = { verdict: 'legitimate', confidence: 0.99 };
const BAD = { verdict: 'disposable', confidence: 0.95 };

test('results come back in the order of the request', async () => {
  const { deps } = makeDeps({ known: { 'gmail.com': GOOD, 'mailinator.com': BAD } });
  const out = await processBatch({ emails: ['a.person@mailinator.com', 'nonsense', 'jane.doe@gmail.com'], ...deps });
  assert.deepEqual(out.map((r) => r.status), ['done', 'invalid', 'done']);
  assert.equal(out[0].verdict, 'disposable');
  assert.equal(out[0].recommendation, 'block');
  assert.equal(out[2].verdict, 'legitimate');
});

test('one lookup per unique domain, however many addresses share it', async () => {
  const { deps, calls } = makeDeps({ known: { 'gmail.com': GOOD } });
  const emails = Array.from({ length: 30 }, (_, i) => `person.${i}@gmail.com`);
  const out = await processBatch({ emails, ...deps });
  assert.equal(calls.getVerdict.length, 1);
  assert.equal(out.length, 30);
});

test('each address is still assessed on its own, even on a shared domain', async () => {
  const { deps } = makeDeps({ known: { 'gmail.com': GOOD } });
  const out = await processBatch({ emails: ['john.smith@gmail.com', 'admin@gmail.com', 'a@gmail.com'], ...deps });
  assert.equal(out[0].recommendation, 'allow');
  assert.equal(out[1].recommendation, 'review');
  assert.notEqual(out[2].mailboxStatus, 'unverifiable');
});

test('an unknown domain is queued once and reported as pending', async () => {
  const { deps, calls } = makeDeps();
  const out = await processBatch({ emails: ['a.b@newsite.example.org', 'c.d@newsite.example.org'], ...deps });
  assert.deepEqual(calls.enqueue, ['newsite.example.org']);
  assert.deepEqual(out.map((r) => r.status), ['pending', 'pending']);
  assert.equal(out[0].verdict, 'unknown');
  assert.equal(out[0].recommendation, 'review');
});

test('a failed lookup is reported to the logger with the domain only', async () => {
  const { deps } = makeDeps({ failFor: ['broken.example.org'] });
  const seen = [];
  await processBatch({ emails: ['zqxjkw7721unique@broken.example.org'], ...deps, onError: (...args) => seen.push(args) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 'broken.example.org');
  assert.ok(!JSON.stringify(seen[0][0]).includes('zqxjkw7721unique'));
});

test('one failing domain does not fail the others', async () => {
  const { deps } = makeDeps({ known: { 'gmail.com': GOOD }, failFor: ['broken.example.org'] });
  const out = await processBatch({ emails: ['x.y@broken.example.org', 'jane.doe@gmail.com', 'p.q@broken.example.org'], ...deps });
  assert.deepEqual(out.map((r) => r.status), ['error', 'done', 'error']);
  assert.equal(out[0].error, 'lookup_failed');
});

test('never more lookups at once than the concurrency limit', async () => {
  const known = {};
  const emails = Array.from({ length: 40 }, (_, i) => { known[`site${i}.example.org`] = GOOD; return `a.b@site${i}.example.org`; });
  const { deps, peakConcurrency } = makeDeps({ known, delayMs: 5 });
  await processBatch({ emails, concurrency: 4, ...deps });
  assert.ok(peakConcurrency() <= 4, `peak was ${peakConcurrency()}`);
  assert.ok(peakConcurrency() > 1, 'lookups should overlap');
});

test('after the deadline, unstarted domains are deferred, not failed', async () => {
  const known = {};
  const emails = Array.from({ length: 10 }, (_, i) => { known[`s${i}.example.org`] = GOOD; return `a.b@s${i}.example.org`; });
  const { deps } = makeDeps({ known, delayMs: 10 });
  // One lane, deadline of 25 ms: only the first few domains can start.
  const out = await processBatch({ emails, concurrency: 1, deadlineMs: 25, ...deps });
  const statuses = out.map((r) => r.status);
  assert.ok(statuses.includes('done'));
  assert.ok(statuses.includes('deferred'));
  assert.ok(!statuses.includes('error'));
  assert.equal(statuses.indexOf('deferred') > statuses.lastIndexOf('done'), true, 'later rows are the deferred ones');
});

test('peek mode never queues anything', async () => {
  const { deps, calls } = makeDeps({ jobs: { 'queued.example.org': { status: 'queued' } } });
  await processBatch({ emails: ['a.b@queued.example.org', 'c.d@nothing.example.org'], mode: 'peek', ...deps });
  assert.equal(calls.enqueue.length, 0);
});

test('peek mode: running job is pending, failed job is an error, no job is deferred', async () => {
  const { deps } = makeDeps({
    jobs: { 'running.example.org': { status: 'running' }, 'failed.example.org': { status: 'failed' } },
  });
  const out = await processBatch({
    emails: ['a.b@running.example.org', 'a.b@failed.example.org', 'a.b@none.example.org'], mode: 'peek', ...deps,
  });
  assert.deepEqual(out.map((r) => r.status), ['pending', 'error', 'deferred']);
  assert.equal(out[1].error, 'analysis_failed');
});

test('peek mode returns the verdict as soon as it exists', async () => {
  const { deps } = makeDeps({ known: { 'ready.example.org': GOOD } });
  const [row] = await processBatch({ emails: ['a.b@ready.example.org'], mode: 'peek', ...deps });
  assert.equal(row.status, 'done');
});

test('privacy: the reply never contains the part of an address before the @', async () => {
  const { deps } = makeDeps({ known: { 'gmail.com': GOOD, 'mailinator.com': BAD } });
  // Role accounts get a generic message ("such as admin or info"), so use ones it does not mention.
  const locals = ['zqxjkw7721unique', 'support', 'noreply', 'asdfghjkl', 'a', 'jane.doe', 'xkcdqpwoeiruty'];
  const emails = locals.flatMap((l) => [`${l}@gmail.com`, `${l}@mailinator.com`, `${l}@pending.example.org`]);
  const text = JSON.stringify(await processBatch({ emails, ...deps }));
  for (const l of locals.filter((x) => x.length > 4)) assert.ok(!text.includes(l), `reply leaked "${l}"`);
});

test('the reply carries only the fields the page needs', async () => {
  const { deps } = makeDeps({ known: { 'gmail.com': { ...GOOD, signals: { knownProvider: true }, checkId: 'x' } } });
  const [row] = await processBatch({ emails: ['jane.doe@gmail.com'], ...deps });
  assert.deepEqual(Object.keys(row).sort(), [
    'confidence', 'domain', 'mailboxStatus', 'reasons', 'recommendation', 'source', 'status', 'verdict',
  ]);
});

test('reasons are limited to three', async () => {
  const { deps } = makeDeps({ known: { 'gmail.com': { verdict: 'unverified', confidence: 0.5 } } });
  const [row] = await processBatch({ emails: ['test123@gmail.com'], ...deps });
  assert.ok(row.reasons.length <= 3);
});

test('request validation', () => {
  assert.equal(validateBatchBody({ emails: ['a@b.com'] }).ok, true);
  assert.equal(validateBatchBody({ emails: ['a@b.com'], mode: 'peek' }).mode, 'peek');
  assert.equal(validateBatchBody({ emails: [] }).ok, false);
  assert.equal(validateBatchBody({}).ok, false);
  assert.equal(validateBatchBody(null).ok, false);
  assert.equal(validateBatchBody({ emails: 'a@b.com' }).ok, false);
  assert.equal(validateBatchBody({ emails: [42] }).ok, false);
  assert.equal(validateBatchBody({ emails: ['x'.repeat(321)] }).ok, false);
  assert.equal(validateBatchBody({ emails: ['a@b.com'], mode: 'enqueue-everything' }).ok, false);
  assert.equal(validateBatchBody({ emails: new Array(MAX_EMAILS_PER_REQUEST).fill('a@b.com') }).ok, true);
  assert.equal(validateBatchBody({ emails: new Array(MAX_EMAILS_PER_REQUEST + 1).fill('a@b.com') }).ok, false);
});
