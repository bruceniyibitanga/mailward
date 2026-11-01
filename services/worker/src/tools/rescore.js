// Re-applies the current scoring rules to verdicts the worker produced earlier, using the
// signals saved with each verdict. Use it after changing the rules in score.js.
//   cd services/worker
//   node --env-file=.env src/tools/rescore.js            (dry run: shows what would change)
//   node --env-file=.env src/tools/rescore.js --apply    (writes the changes)
// Only verdicts the worker made itself (source "analysis") are touched. Verdicts that came
// from the public lists or the allowlist are never changed. Nothing is deleted.
// Mail-server links are corrected too, because they feed the "shares a mail server" signal:
// a wrong verdict left in them would push later domains towards the same wrong answer.
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../clients.js';
import { config } from '../config.js';
import { score, isSharedProviderMx } from '../score.js';
import { countDisposableSharingMx } from '../analyse.js';

const apply = process.argv.includes('--apply');

const items = [];
let key;
do {
  const page = await ddb.send(new ScanCommand({
    TableName: config.tableName,
    FilterExpression: 'begins_with(PK, :p) AND SK = :sk AND #src = :a AND attribute_exists(signals)',
    ExpressionAttributeNames: { '#src': 'source' },
    ExpressionAttributeValues: { ':p': 'DOMAIN#', ':sk': 'VERDICT', ':a': 'analysis' },
    ExclusiveStartKey: key,
  }));
  items.push(...page.Items);
  key = page.LastEvaluatedKey;
} while (key);
console.log(`${items.length} analysed verdicts found${apply ? '' : ' (dry run)'}`);

// A correction changes the mail-server links, which can change another domain's count, so
// repeat until nothing moves (a few passes at most).
const changes = new Map();
for (let pass = 1; pass <= 5; pass++) {
  let moved = 0;
  for (const item of items) {
    const signals = { ...item.signals, mxHosts: (item.signals.mxHosts ?? []).filter(Boolean) };
    signals.mxSharedWithDisposable = await countDisposableSharingMx(signals.mxHosts ?? [], item.domain);
    const next = score(signals);
    if (next.verdict === item.verdict) continue;
    changes.set(item.domain, { from: changes.get(item.domain)?.from ?? item.verdict, to: next.verdict });
    item.verdict = next.verdict;
    item.confidence = next.confidence;
    item.signals = signals;
    moved++;
    if (!apply) continue;
    await ddb.send(new UpdateCommand({
      TableName: config.tableName,
      Key: { PK: `DOMAIN#${item.domain}`, SK: 'VERDICT' },
      UpdateExpression: 'SET verdict = :v, confidence = :c, signals.mxSharedWithDisposable = :m, signals.mxHosts = :h, rescoredAt = :t',
      ExpressionAttributeValues: { ':v': next.verdict, ':c': next.confidence, ':m': signals.mxSharedWithDisposable, ':h': signals.mxHosts, ':t': new Date().toISOString() },
    }));
    for (const host of (signals.mxHosts ?? []).slice(0, 2).filter((h) => !isSharedProviderMx(h))) {
      await ddb.send(new UpdateCommand({
        TableName: config.tableName,
        Key: { PK: `MX#${host}`, SK: `DOMAIN#${item.domain}` },
        UpdateExpression: 'SET verdict = :v',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: { ':v': next.verdict },
      }));
    }
  }
  console.log(`pass ${pass}: ${moved} verdicts ${apply ? 'changed' : 'would change'}`);
  // A dry run changes nothing, so a second pass would only repeat the first.
  if (!apply || moved === 0) break;
}

const summary = {};
for (const { from, to } of changes.values()) summary[`${from} -> ${to}`] = (summary[`${from} -> ${to}`] ?? 0) + 1;
console.log(JSON.stringify(summary));
console.log('examples:', [...changes].slice(0, 12).map(([d, c]) => `${d} (${c.from} -> ${c.to})`).join(', '));
console.log('Cached copies in Valkey expire on their own (5 minutes for unverified); nothing was deleted.');
process.exit(0);
