// Bulk checking for the dashboard's CSV upload.
// Pure on purpose: everything it needs is passed in, so it can be tested without AWS.
//
// Rules that keep a big upload safe:
//  - One lookup per unique domain, however many addresses share it.
//  - A fixed number of lookups at once, and a deadline: anything not started in time is
//    returned as "deferred" so the caller can send it again, instead of the request failing.
//  - One failing domain never fails the others.
//  - The reply is in the same order as the request and never repeats an input back, so an
//    email address (which identifies a person) is not carried in the response.

export const MAX_EMAILS_PER_REQUEST = 100;
export const MAX_INPUT_LENGTH = 320; // longest valid email address

const DEFAULT_CONCURRENCY = 10;
const DEFAULT_DEADLINE_MS = 12_000;

// "submit" looks the domain up and queues it for analysis if it is new (same as a single check).
// "peek" never queues anything: it only reports what is already known. It is used to follow up
// on domains that are being analysed, so repeating it cannot create jobs or re-queue failed ones.
const MODES = ['submit', 'peek'];

export function validateBatchBody(body) {
  const emails = body?.emails;
  const mode = body?.mode ?? 'submit';
  if (!Array.isArray(emails) || emails.length < 1 || emails.length > MAX_EMAILS_PER_REQUEST) {
    return { ok: false, error: `send_between_1_and_${MAX_EMAILS_PER_REQUEST}_emails` };
  }
  if (!emails.every((e) => typeof e === 'string' && e.length <= MAX_INPUT_LENGTH)) {
    return { ok: false, error: 'emails_must_be_short_strings' };
  }
  if (!MODES.includes(mode)) return { ok: false, error: 'invalid_mode' };
  return { ok: true, emails, mode };
}

// What the caller sees for a domain that is not decided yet.
const PENDING_BODY = { verdict: 'unknown', confidence: 0.3, source: 'pending' };

async function resolveDomain(domain, mode, { getVerdict, getJob, enqueue, onError }) {
  try {
    const found = await getVerdict(domain);
    if (found) return { status: 'done', body: found.result };

    if (mode === 'peek') {
      const job = await getJob(domain);
      if (!job) return { status: 'deferred' }; // nothing queued yet: the caller should submit it
      if (job.status === 'failed') return { status: 'error', error: 'analysis_failed' };
      return { status: 'pending', body: PENDING_BODY };
    }

    await enqueue(domain);
    return { status: 'pending', body: PENDING_BODY };
  } catch (err) {
    onError(domain, err); // the caller decides how to log it; only the domain is passed, never an address
    return { status: 'error', error: 'lookup_failed' };
  }
}

// Keeps only what the page needs. No signals, mail hosts or job ids.
function toItem(status, body, address, withMailbox) {
  const full = withMailbox({
    domain: address.domain, verdict: body.verdict, confidence: body.confidence, source: body.source,
  }, address);
  return {
    status,
    domain: address.domain,
    verdict: full.verdict,
    confidence: full.confidence,
    source: full.source,
    recommendation: full.recommendation,
    reasons: (full.recommendationReasons ?? []).slice(0, 3),
    mailboxStatus: full.mailbox?.status ?? null,
  };
}

export async function processBatch({
  emails,
  mode = 'submit',
  parseAddress,
  withMailbox,
  getVerdict,
  getJob,
  enqueue,
  onError = () => {},
  concurrency = DEFAULT_CONCURRENCY,
  deadlineMs = DEFAULT_DEADLINE_MS,
  now = Date.now,
}) {
  const started = now();
  const addresses = emails.map((e) => parseAddress(e));

  const domains = [];
  const seen = new Set();
  for (const a of addresses) {
    if (a && !seen.has(a.domain)) { seen.add(a.domain); domains.push(a.domain); }
  }

  // A small pool of lanes sharing one index. The deadline is checked before each pick-up,
  // so a slow cache or database cannot make the whole request run past the caller's timeout.
  const outcome = new Map();
  let next = 0;
  async function lane() {
    while (now() - started < deadlineMs) {
      const i = next++;
      if (i >= domains.length) return;
      outcome.set(domains[i], await resolveDomain(domains[i], mode, { getVerdict, getJob, enqueue, onError }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, domains.length) }, lane));

  return addresses.map((address) => {
    if (!address) return { status: 'invalid', error: 'invalid_email_or_domain' };
    const result = outcome.get(address.domain);
    if (!result || result.status === 'deferred') return { status: 'deferred' };
    if (result.status === 'error') return { status: 'error', error: result.error };
    return toItem(result.status, result.body, address, withMailbox);
  });
}
