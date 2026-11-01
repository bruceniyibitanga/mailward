// Measures how well the scoring rules find domains we KNOW are disposable, so a change to the
// rules can be judged on data it was not written against.
//   node --env-file=.env src/tools/evaluate.js <sample-size> <seed>
// Takes a random sample (fixed seed, so the run can be repeated) of domains from the public
// lists, analyses each one as if it were unknown, and scores the same signals with the rules
// from before the "second signal" change and with the current rules.
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../clients.js';
import { config } from '../config.js';
import { analyseDomain } from '../analyse.js';
import { score } from '../score.js';

const N = Number(process.argv[2] ?? 100);
const SEED = Number(process.argv[3] ?? 1);

// The rules as they were before: one weak signal could decide, and an unknown age added 0.05.
function scoreBefore(s) {
  if (s.mxHosts.length === 0) return 'undeliverable';
  let t = 0;
  if (s.mxSharedWithDisposable >= 2) t += 0.5; else if (s.mxSharedWithDisposable === 1) t += 0.3;
  if (s.redirectsToDisposable) t += 0.5;
  t += Math.min(s.keywords.length * 0.2, 0.4);
  if (s.domainAgeDays === null) t += 0.05; else if (s.domainAgeDays < 30) t += 0.2; else if (s.domainAgeDays < 365) t += 0.1;
  return t >= 0.5 ? 'disposable' : 'other';
}

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const known = [];
let key;
do {
  const page = await ddb.send(new ScanCommand({
    TableName: config.tableName,
    FilterExpression: 'begins_with(PK, :p) AND SK = :sk AND verdict = :v AND #src <> :a',
    ExpressionAttributeNames: { '#src': 'source' },
    ExpressionAttributeValues: { ':p': 'DOMAIN#', ':sk': 'VERDICT', ':v': 'disposable', ':a': 'analysis' },
    ExclusiveStartKey: key,
  }));
  known.push(...page.Items.map((i) => i.domain));
  key = page.LastEvaluatedKey;
} while (key);

const rand = mulberry32(SEED);
const sample = [...known].sort(() => rand() - 0.5).slice(0, N);
console.log(`known disposable domains on the lists: ${known.length}; sampling ${sample.length} (seed ${SEED})`);

const rows = [];
let next = 0;
await Promise.all(Array.from({ length: 5 }, async () => {
  while (next < sample.length) {
    const domain = sample[next++];
    try {
      const r = await analyseDomain(domain, { lastAttempt: true });
      rows.push({ domain, before: scoreBefore(r.signals), after: score(r.signals).verdict, s: r.signals });
    } catch (err) {
      rows.push({ domain, error: err.message });
    }
  }
}));

const ok = rows.filter((r) => !r.error);
const count = (f) => ok.filter(f).length;
const pct = (n) => `${n}/${ok.length} (${((100 * n) / ok.length).toFixed(1)}%)`;
console.log(`analysed ${ok.length}, errors ${rows.length - ok.length}`);
console.log(`no mail server (undeliverable, same before and after): ${pct(count((r) => r.s.mxHosts.length === 0))}`);
console.log(`found disposable BEFORE: ${pct(count((r) => r.before === 'disposable'))}`);
console.log(`found disposable AFTER : ${pct(count((r) => r.after === 'disposable'))}`);
const lost = ok.filter((r) => r.before === 'disposable' && r.after !== 'disposable');
console.log(`found before but not after: ${lost.length}`);
for (const r of lost.slice(0, 15)) {
  console.log(`  ${r.domain}  sharedMx=${r.s.mxSharedWithDisposable} kw=${r.s.keywords.length} age=${r.s.domainAgeDays} redirect=${r.s.redirectsToDisposable} reachable=${r.s.homepageReachable}`);
}
process.exit(0);
