// One place to create every client the API needs. Clients are created once
// per container and reused, which is much faster than creating one per request.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SQSClient } from '@aws-sdk/client-sqs';
import { S3Client } from '@aws-sdk/client-s3';
import { ECSClient } from '@aws-sdk/client-ecs';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { Redis, Cluster } from 'ioredis';
import { config } from './config.js';

export const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: config.region }),
  { marshallOptions: { removeUndefinedValues: true } },
);
export const sqs = new SQSClient({ region: config.region });
export const s3 = new S3Client({ region: config.region });
export const ecs = new ECSClient({ region: config.region });
export const cloudwatch = new CloudWatchClient({ region: config.region });

function createRedis() {
  const common = {
    // If Redis is slow or down, give up quickly instead of making the user wait.
    commandTimeout: 250,
    maxRetriesPerRequest: 1,
  };

  if (!config.redisCluster) {
    // Local development: a plain Redis container on localhost.
    return new Redis(config.redisUrl, common);
  }

  // ElastiCache Serverless: cluster mode + TLS. The dnsLookup line is needed
  // so TLS certificate checks use the real hostname.
  const { hostname, port } = new URL(config.redisUrl);
  return new Cluster([{ host: hostname, port: Number(port || 6379) }], {
    dnsLookup: (address, callback) => callback(null, address),
    redisOptions: { ...common, tls: {} },
    slotsRefreshTimeout: 2000,
  });
}

export const redis = createRedis();
redis.on('error', (err) => console.error(JSON.stringify({ level: 'error', msg: 'redis error', err: err.message })));

// Run a Redis command but never let a Redis failure break the request.
// The cache is an optimisation, not the source of truth.
export async function safeRedis(fn, fallback = null) {
  try {
    return await fn(redis);
  } catch (err) {
    console.error(JSON.stringify({ level: 'warn', msg: 'redis command failed, continuing without cache', err: err.message }));
    return fallback;
  }
}
