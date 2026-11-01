// The AWS and cache clients, created once and shared by the worker's modules. A cache problem is
// logged and does not stop the worker, because the cache only makes things faster.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SQSClient } from '@aws-sdk/client-sqs';
import { S3Client } from '@aws-sdk/client-s3';
import { Redis, Cluster } from 'ioredis';
import { config } from './config.js';

export const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: config.region }),
  { marshallOptions: { removeUndefinedValues: true } },
);
export const sqs = new SQSClient({ region: config.region });
export const s3 = new S3Client({ region: config.region });

function createRedis() {
  const common = { commandTimeout: 500, maxRetriesPerRequest: 1 };
  if (!config.redisCluster) return new Redis(config.redisUrl, common);
  const { hostname, port } = new URL(config.redisUrl);
  return new Cluster([{ host: hostname, port: Number(port || 6379) }], {
    dnsLookup: (address, callback) => callback(null, address),
    redisOptions: { ...common, tls: {} },
    slotsRefreshTimeout: 2000,
  });
}

export const redis = createRedis();
redis.on('error', (err) => console.error(JSON.stringify({ level: 'error', msg: 'redis error', err: err.message })));
