// One-off: record the mail servers used by every domain already marked disposable, so the
// "shares a mail server with a known disposable domain" signal has something to compare with.
// Hosts run by big providers (Google, Outlook...) are skipped on purpose: a disposable domain
// pointing at Gmail must not make every Gmail-hosted domain look suspicious.
//   cd services/worker && node --env-file=.env src/tools/backfill-mx.js
import { Resolver } from 'node:dns/promises';
import { ScanCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../clients.js';
import { config } from '../config.js';
import { isSharedProviderMx } from '../analyse.js';

const resolver = new Resolver({ timeout: 2000, tries: 1 });

// 1. Every domain we already know is disposable
const domains = [];
let lastKey;
do {
  const page = await ddb.send(new ScanCommand({
    TableName: config.tableName,
    FilterExpression: 'SK = :v AND verdict = :d',
    ProjectionExpression: '#d',
    ExpressionAttributeNames: { '#d': 'domain' },
    ExpressionAttributeValues: { ':v': 'VERDICT', ':d': 'disposable' },
    ExclusiveStartKey: lastKey,
  }));
  domains.push(...(page.Items ?? []).map((i) => i.domain));
  lastKey = page.LastEvaluatedKey;
} while (lastKey);
console.log(`${domains.length} disposable domains to look up`);

// 2. Look up their mail servers, 20 at a time, and save the links
let next = 0;
let done = 0;
let written = 0;
let skippedShared = 0;
async function lane() {
  while (next < domains.length) {
    const domain = domains[next++];
    try {
      const records = await resolver.resolveMx(domain);
      const hosts = records
        .sort((a, b) => a.priority - b.priority)
        .map((r) => r.exchange.toLowerCase().replace(/\.$/, ''))
        .slice(0, 2);
      for (const host of hosts) {
        if (isSharedProviderMx(host)) { skippedShared++; continue; }
        await ddb.send(new PutCommand({
          TableName: config.tableName,
          Item: { PK: `MX#${host}`, SK: `DOMAIN#${domain}`, domain, verdict: 'disposable', checkedAt: new Date().toISOString() },
        }));
        written++;
      }
    } catch {
      // no MX record or a DNS error: skip this one
    }
    if (++done % 250 === 0) console.log(`${done}/${domains.length} domains, ${written} links`);
  }
}
await Promise.all(Array.from({ length: 20 }, lane));
console.log(`Finished: ${domains.length} domains, ${written} mail-server links saved, ${skippedShared} shared-provider hosts skipped`);
process.exit(0);
