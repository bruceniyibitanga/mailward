// Daily ingestion job, triggered by an EventBridge schedule.
// 1. Downloads a public list of disposable email domains
// 2. Adds any new ones to DynamoDB (without overwriting existing verdicts)
// 3. Seeds an allowlist of big legitimate providers
// 4. Writes a combined blocklist file to S3 (served at /v1/lists/latest)
// 5. Records the run, which is our evidence the schedule ran on its own
//
// No npm dependencies: the AWS SDK v3 and fetch are built into the Node.js 22 Lambda runtime.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Resolver } from 'node:dns/promises';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const TABLE = process.env.TABLE_NAME;
const BUCKET = process.env.BUCKET_NAME;
const LIST_URL = process.env.LIST_URL
  ?? 'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf';

const ALLOWLIST = [
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'aol.com',
  'gmx.com', 'zoho.com', 'fastmail.com', 'bigpond.com', 'optusnet.com.au', 'qut.edu.au',
];

const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// Hosts run by big providers say nothing about who else uses them (keep in sync with the worker).
const SHARED_PROVIDER_DOMAINS = [
  'google.com', 'googlemail.com', 'outlook.com', 'zoho.com', 'zoho.eu', 'zoho.com.au',
  'messagingengine.com', 'yahoodns.net', 'icloud.com', 'secureserver.net', 'mimecast.com',
  'pphosted.com', 'mailgun.org', 'registrar-servers.com', 'improvmx.com', 'forwardemail.net',
];
const isSharedProviderMx = (host) => SHARED_PROVIDER_DOMAINS.some((d) => host === d || host.endsWith('.' + d));

// Record the mail servers of newly listed disposable domains, so the workers' "shares a mail
// server with a known disposable domain" signal works. The first big backfill is done by
// services/worker/src/tools/backfill-mx.js; this keeps it current. Stops early if time is short.
async function recordMailServers(domains, context) {
  const resolver = new Resolver({ timeout: 2000, tries: 1 });
  let next = 0;
  let links = 0;
  async function lane() {
    while (next < domains.length && context.getRemainingTimeInMillis() > 30_000) {
      const domain = domains[next++];
      try {
        const records = await resolver.resolveMx(domain);
        const hosts = records.sort((a, b) => a.priority - b.priority)
          .map((r) => r.exchange.toLowerCase().replace(/\.$/, '')).slice(0, 2);
        for (const host of hosts) {
          if (isSharedProviderMx(host)) continue;
          await ddb.send(new PutCommand({
            TableName: TABLE,
            Item: { PK: 'MX#' + host, SK: 'DOMAIN#' + domain, domain, verdict: 'disposable', checkedAt: new Date().toISOString() },
          }));
          links += 1;
        }
      } catch { /* no MX or a DNS error: skip */ }
    }
  }
  await Promise.all(Array.from({ length: 20 }, lane));
  return { looked: next, links };
}

async function runWithConcurrency(items, limit, fn) {
  let next = 0;
  async function lane() {
    while (next < items.length) await fn(items[next++]);
  }
  await Promise.all(Array.from({ length: limit }, lane));
}

// Insert only if the domain isn't already in the table.
async function insertIfNew(item) {
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: item,
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
    return true;
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

export const handler = async (event, context) => {
  const started = Date.now();
  const now = new Date().toISOString();

  // 1. Download and clean the public list
  const res = await fetch(LIST_URL, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`List download failed with status ${res.status}`);
  const publicDomains = [...new Set((await res.text())
    .split('\n')
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line && !line.startsWith('#') && DOMAIN_PATTERN.test(line)))];

  // 2. + 3. Insert new disposable domains and the allowlist
  let inserted = 0;
  let skipped = 0;
  const items = [
    ...publicDomains.map((domain) => ({
      PK: `DOMAIN#${domain}`, SK: 'VERDICT', domain, verdict: 'disposable', confidence: 0.95,
      source: 'public-list', signals: { onPublicList: true }, checkedAt: now,
    })),
    ...ALLOWLIST.map((domain) => ({
      PK: `DOMAIN#${domain}`, SK: 'VERDICT', domain, verdict: 'legitimate', confidence: 0.99,
      source: 'allowlist', signals: { knownProvider: true }, checkedAt: now,
    })),
  ];
  const newDisposable = [];
  await runWithConcurrency(items, 25, async (item) => {
    if (await insertIfNew(item)) {
      inserted += 1;
      if (item.verdict === 'disposable') newDisposable.push(item.domain);
    } else {
      skipped += 1;
    }
  });
  const mx = await recordMailServers(newDisposable, context);

  // 4. Add disposable domains our own workers discovered, then write the list
  const discovered = [];
  let lastKey;
  do {
    const page = await ddb.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: 'SK = :v AND verdict = :d AND #src = :a',
      ProjectionExpression: '#d',
      ExpressionAttributeNames: { '#src': 'source', '#d': 'domain' },
      ExpressionAttributeValues: { ':v': 'VERDICT', ':d': 'disposable', ':a': 'analysis' },
      ExclusiveStartKey: lastKey,
    }));
    discovered.push(...(page.Items ?? []).map((i) => i.domain));
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);

  const list = [...new Set([...publicDomains, ...discovered])].sort();
  const body = `# Xenova Verify disposable domain list, generated ${now}\n${list.join('\n')}\n`;
  const day = now.slice(0, 10);
  for (const key of [`lists/${day}.txt`, 'lists/latest.txt']) {
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: 'text/plain; charset=utf-8' }));
  }

  // 5. Record the run
  const summary = {
    inserted, skipped, publicListSize: publicDomains.length, discovered: discovered.length,
    listSize: list.length, mxLookedUp: mx.looked, mxLinks: mx.links, durationMs: Date.now() - started,
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { PK: 'INGEST#RUN', SK: now, ranAt: now, ...summary } }));

  console.log(JSON.stringify({ level: 'info', msg: 'ingestion complete', ...summary }));
  return summary;
};
