// The worker: pulls jobs from SQS (worker-pull), analyses each domain,
// writes the results, then deletes the message.
// If anything fails, the message is NOT deleted. SQS makes it visible again
// after the visibility timeout and another worker retries it. After
// MAX_ATTEMPTS failures SQS moves it to the dead-letter queue.
import { ReceiveMessageCommand, DeleteMessageBatchCommand } from '@aws-sdk/client-sqs';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, sqs, s3, redis } from './clients.js';
import { config } from './config.js';
import { analyseDomain, isSharedProviderMx } from './analyse.js';

let running = true;
const abort = new AbortController();

function log(level, msg, extra = {}) {
  console.log(JSON.stringify({ level, msg, ...extra }));
}

function emitMetrics(values) {
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: 'XenovaVerify',
        Dimensions: [['Service']],
        Metrics: Object.keys(values).map((n) => ({ Name: n, Unit: n === 'JobDuration' ? 'Milliseconds' : 'Count' })),
      }],
    },
    Service: 'worker',
    ...values,
  }));
}

async function setJob(domain, fields) {
  const names = {};
  const values = {};
  const sets = Object.entries(fields).map(([k, v]) => {
    names[`#${k}`] = k;
    values[`:${k}`] = v;
    return `#${k} = :${k}`;
  });
  await ddb.send(new UpdateCommand({
    TableName: config.tableName,
    Key: { PK: `DOMAIN#${domain}`, SK: 'JOB' },
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

async function processMessage(message) {
  const attempt = Number(message.Attributes?.ApproximateReceiveCount ?? 1);

  // An unreadable message can never succeed, so retrying cannot help. It is not deleted: after
  // the normal number of attempts the queue moves it to the dead-letter queue, where it raises
  // the alarm and can be inspected. Parsing happens here, outside the job's try block, so a
  // bad message must be handled explicitly or it would throw out of the whole batch.
  let domain;
  try {
    domain = JSON.parse(message.Body).domain;
  } catch {
    domain = undefined;
  }
  if (typeof domain !== 'string' || domain === '') {
    log('error', 'unreadable message, leaving it for the dead-letter queue', { attempt, messageId: message.MessageId });
    emitMetrics({ JobsFailed: 1 });
    return false;
  }

  try {
    await setJob(domain, { status: 'running', attempts: attempt, startedAt: new Date().toISOString() });

    const result = await analyseDomain(domain, { lastAttempt: attempt >= config.maxAttempts });
    const checkedAt = new Date().toISOString();

    // 1. Raw evidence to S3 (unstructured storage, expires after 30 days)
    const evidenceKey = `evidence/${domain}/${Date.now()}.json`;
    await s3.send(new PutObjectCommand({
      Bucket: config.bucketName,
      Key: evidenceKey,
      ContentType: 'application/json',
      Body: JSON.stringify({ domain, checkedAt, ...result }, null, 2),
    }));

    // 2. The verdict. Never overwrite a public-list or allowlist verdict.
    let storedVerdict = result.verdict;
    try {
      await ddb.send(new PutCommand({
        TableName: config.tableName,
        Item: {
          PK: `DOMAIN#${domain}`, SK: 'VERDICT', domain,
          verdict: result.verdict, confidence: result.confidence,
          source: 'analysis', signals: result.signals, checkedAt, evidenceKey,
        },
        ConditionExpression: 'attribute_not_exists(PK) OR #src = :analysis',
        ExpressionAttributeNames: { '#src': 'source' },
        ExpressionAttributeValues: { ':analysis': 'analysis' },
      }));
    } catch (err) {
      if (err.name !== 'ConditionalCheckFailedException') throw err;
      // A list verdict already exists: the mail-server links must use THAT verdict, not ours.
      const { Item } = await ddb.send(new GetCommand({
        TableName: config.tableName,
        Key: { PK: `DOMAIN#${domain}`, SK: 'VERDICT' },
      }));
      if (Item?.verdict) storedVerdict = Item.verdict;
    }

    // 3. Remember which mail servers this domain uses (feeds future MX checks)
    // Hosts of big shared providers are skipped: they say nothing about who else is on them.
    await Promise.all(result.signals.mxHosts.slice(0, 2).filter((host) => !isSharedProviderMx(host)).map((host) => ddb.send(new PutCommand({
      TableName: config.tableName,
      Item: { PK: `MX#${host}`, SK: `DOMAIN#${domain}`, domain, verdict: storedVerdict, checkedAt },
    }))));

    // 4. Mark the job done and refresh the cache
    await setJob(domain, { status: 'done', finishedAt: checkedAt });
    await redis.del(`verdict:${domain}`).catch(() => {});

    emitMetrics({ JobsProcessed: 1, JobDuration: result.durationMs });
    log('info', 'analysed', { domain, verdict: result.verdict, confidence: result.confidence, ms: result.durationMs });
    return true;
  } catch (err) {
    log('error', 'job failed', { domain, attempt, err: err.message });
    emitMetrics({ JobsFailed: 1 });
    // Last attempt: tell polling clients it failed (SQS will move the message to the DLQ)
    if (attempt >= config.maxAttempts) {
      await setJob(domain, { status: 'failed', finishedAt: new Date().toISOString() }).catch(() => {});
    }
    return false;
  }
}

// Run up to `limit` promises at once.
async function runWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

async function pollForever() {
  log('info', 'worker started', { concurrency: config.concurrency });
  while (running) {
    let messages = [];
    try {
      const res = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: config.queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20,      // long polling: cheaper and quicker than polling in a tight loop
        VisibilityTimeout: 60,    // how long we have to finish before SQS hands it to someone else
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }), { abortSignal: abort.signal });
      messages = res.Messages ?? [];
    } catch (err) {
      if (!running) break;
      log('error', 'receive failed, backing off', { err: err.message });
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    if (messages.length === 0) continue;

    const ok = await runWithConcurrency(messages, config.concurrency, processMessage);
    const toDelete = messages.filter((_, i) => ok[i]);
    if (toDelete.length > 0) {
      await sqs.send(new DeleteMessageBatchCommand({
        QueueUrl: config.queueUrl,
        Entries: toDelete.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle })),
      }));
    }
  }
  log('info', 'worker stopped cleanly');
  await redis.quit().catch(() => {});
  process.exit(0);
}

// When ECS scales in, it sends SIGTERM. We stop asking for new messages and
// let the current batch finish. Unfinished messages simply reappear later.
function shutdown() {
  log('info', 'SIGTERM received, finishing current batch');
  running = false;
  abort.abort();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

pollForever();
