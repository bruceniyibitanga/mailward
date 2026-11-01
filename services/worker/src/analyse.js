// Works out whether a domain looks disposable.
// This is a simple, explainable rules score, not machine learning.
// Every external call has a timeout so one slow website can't stall a worker.
import { Resolver } from 'node:dns/promises';
import { QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './clients.js';
import { config } from './config.js';
import { CircuitBreaker } from './breaker.js';
import { score, isSharedProviderMx, parseMxRecords } from './score.js';

export { score, isSharedProviderMx };

const resolver = new Resolver({ timeout: 2000, tries: 2 });
const rdapBreaker = new CircuitBreaker('rdap', { failureThreshold: 5, cooldownMs: 60_000 });

const USER_AGENT = 'XenovaVerifyBot/1.0 (university project; polite single-page fetch)';
const KEYWORDS = [
  'temporary email', 'temp mail', 'tempmail', 'disposable email', 'disposable mail',
  '10 minute mail', '10minutemail', 'throwaway email', 'burner email', 'fake email',
  'anonymous email', 'self-destruct', 'inbox will be deleted', 'receive email anonymously',
];

// Returns the mail hosts, [] if DNS says there are none, or null if DNS could not answer.
// Only an authoritative "no such record" proves there is no mail server. A timeout or a
// server failure means we could not look, which is not the same thing.
async function getMxHosts(domain) {
  try {
    const records = await resolver.resolveMx(domain);
    return parseMxRecords(records);
  } catch (err) {
    if (['ENOTFOUND', 'ENODATA', 'ENONAME'].includes(err.code)) return [];
    return null;
  }
}


// How many domains we ALREADY know are disposable use the same mail server?
// Disposable services often run thousands of domains on a few mail servers,
// so this catches brand new domains the public lists haven't seen yet.
export async function countDisposableSharingMx(mxHosts, domain) {
  let total = 0;
  for (const host of mxHosts.slice(0, 2)) {
    if (!host || isSharedProviderMx(host)) continue;
    const { Items = [] } = await ddb.send(new QueryCommand({
      TableName: config.tableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `MX#${host}` },
      Limit: 50,
    }));
    total += Items.filter((i) => i.verdict === 'disposable' && i.domain !== domain).length;
  }
  return total;
}

// Domain age from RDAP (the modern replacement for WHOIS).
async function getDomainAgeDays(domain) {
  return rdapBreaker.call(async () => {
    const res = await fetch(`https://rdap.org/domain/${domain}`, {
      signal: AbortSignal.timeout(3000),
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/rdap+json' },
    });
    if (res.status === 404) return null; // registry has no data: not a breaker failure
    if (!res.ok) throw new Error(`rdap status ${res.status}`);
    const data = await res.json();
    const registered = data.events?.find((e) => e.eventAction === 'registration')?.eventDate;
    if (!registered) return null;
    return Math.floor((Date.now() - Date.parse(registered)) / 86_400_000);
  });
}

// Fetch the homepage (max 200 KB, 3 s) and look for disposable-mail phrases.
async function getHomepageKeywords(domain) {
  try {
    const res = await fetch(`https://${domain}`, {
      signal: AbortSignal.timeout(3000),
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT },
    });
    const finalHost = new URL(res.url).hostname.toLowerCase().replace(/^www\./, '');
    if (!res.ok || !res.body) return { reachable: res.ok, keywords: [], finalHost };

    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    while (size < 200_000) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    reader.cancel().catch(() => {});
    const text = Buffer.concat(chunks).toString('utf8').toLowerCase();
    return { reachable: true, keywords: KEYWORDS.filter((k) => text.includes(k)), finalHost };
  } catch {
    return { reachable: false, keywords: [], finalHost: null };
  }
}

// If the homepage redirects to a different site, is that site a known disposable domain?
// (Temp-mail services often park their spare domains with a redirect to the main site.)
async function redirectsToDisposable(domain, finalHost) {
  if (!finalHost || finalHost === domain) return false;
  const labels = finalHost.split('.');
  const candidates = [...new Set([finalHost, labels.slice(-2).join('.')])].filter((h) => h !== domain);
  for (const host of candidates) {
    const { Item } = await ddb.send(new GetCommand({
      TableName: config.tableName,
      Key: { PK: `DOMAIN#${host}`, SK: 'VERDICT' },
    }));
    if (Item?.verdict === 'disposable') return true;
  }
  return false;
}

// lastAttempt: SQS will not retry this job again, so a DNS failure must become an honest
// "unverified" verdict. Earlier attempts throw instead, because DNS timeouts are often brief.
export async function analyseDomain(domain, { lastAttempt = false } = {}) {
  const started = Date.now();
  const lookedUp = await getMxHosts(domain);
  const mxLookup = lookedUp === null ? 'failed' : 'ok';
  if (mxLookup === 'failed' && !lastAttempt) throw new Error(`mx lookup failed for ${domain}`);
  const mxHosts = lookedUp ?? [];

  const [mxSharedWithDisposable, domainAgeDays, homepage] = mxHosts.length === 0
    ? [0, null, { reachable: false, keywords: [], finalHost: null }]
    : await Promise.all([
      countDisposableSharingMx(mxHosts, domain),
      getDomainAgeDays(domain),
      getHomepageKeywords(domain),
    ]);

  const signals = {
    mxLookup,
    mxHosts,
    mxSharedWithDisposable,
    domainAgeDays,
    homepageReachable: homepage.reachable,
    keywords: homepage.keywords,
    redirectsToDisposable: mxHosts.length > 0 && await redirectsToDisposable(domain, homepage.finalHost),
  };
  return { ...score(signals), signals, durationMs: Date.now() - started };
}
