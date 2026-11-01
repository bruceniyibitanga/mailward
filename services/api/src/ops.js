// Data for the live ops panel in the dashboard.
// Reads live numbers straight from SQS and ECS (they update within seconds),
// and the cache hit rate from CloudWatch (built from our EMF metrics).
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { DescribeServicesCommand } from '@aws-sdk/client-ecs';
import { GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { sqs, ecs, cloudwatch, ddb } from './clients.js';
import { config } from './config.js';

async function queueDepth(queueUrl) {
  if (!queueUrl) return null;
  const { Attributes = {} } = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl: queueUrl,
    AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
  }));
  return {
    waiting: Number(Attributes.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(Attributes.ApproximateNumberOfMessagesNotVisible ?? 0),
  };
}

async function serviceCounts() {
  const names = [config.apiServiceName, config.workerServiceName].filter(Boolean);
  if (!config.ecsCluster || names.length === 0) return {};
  const { services = [] } = await ecs.send(new DescribeServicesCommand({ cluster: config.ecsCluster, services: names }));
  return Object.fromEntries(services.map((s) => [
    s.serviceName === config.apiServiceName ? 'api' : 'worker',
    { running: s.runningCount, desired: s.desiredCount, pending: s.pendingCount },
  ]));
}

async function cacheAndTraffic() {
  const end = new Date();
  const start = new Date(end.getTime() - 10 * 60 * 1000);
  const metric = (id, name, stat) => ({
    Id: id,
    MetricStat: {
      Metric: { Namespace: 'XenovaVerify', MetricName: name, Dimensions: [{ Name: 'Service', Value: 'api' }] },
      Period: 60,
      Stat: stat,
    },
  });
  const { MetricDataResults = [] } = await cloudwatch.send(new GetMetricDataCommand({
    StartTime: start,
    EndTime: end,
    ScanBy: 'TimestampDescending',
    MetricDataQueries: [
      metric('hit', 'CacheHit', 'Average'),
      metric('lookups', 'Lookups', 'Sum'),
      metric('p95', 'LookupLatency', 'p95'),
    ],
  }));
  const latest = (id) => MetricDataResults.find((m) => m.Id === id)?.Values?.[0] ?? null;
  return {
    cacheHitRate: latest('hit'),
    lookupsPerMinute: latest('lookups'),
    latencyP95Ms: latest('p95'),
  };
}

async function lastIngestion() {
  const { Items = [] } = await ddb.send(new QueryCommand({
    TableName: config.tableName,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': 'INGEST#RUN' },
    ScanIndexForward: false,
    Limit: 1,
  }));
  return Items[0] ?? null;
}

// Each part is fetched independently so one failure doesn't blank the whole panel.
export async function getOpsSummary() {
  const settle = async (p) => { try { return await p; } catch (err) { return { error: err.message }; } };
  const [queue, dlq, services, traffic, ingestion] = await Promise.all([
    settle(queueDepth(config.queueUrl)),
    settle(queueDepth(config.dlqUrl)),
    settle(serviceCounts()),
    settle(cacheAndTraffic()),
    settle(lastIngestion()),
  ]);
  return { at: new Date().toISOString(), queue, dlq, services, traffic, ingestion };
}
