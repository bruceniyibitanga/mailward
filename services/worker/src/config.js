// Settings for the worker, read from environment variables so the same image runs anywhere.
// A missing required setting stops the worker at start-up with a clear message, instead of failing later.

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const config = {
  region: process.env.AWS_REGION ?? 'ap-southeast-2',
  tableName: required('TABLE_NAME'),
  queueUrl: required('QUEUE_URL'),
  bucketName: required('BUCKET_NAME'),
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  redisCluster: process.env.REDIS_CLUSTER === 'true',
  // How many domains one worker container analyses at the same time.
  concurrency: Number(process.env.CONCURRENCY ?? 5),
  maxAttempts: Number(process.env.MAX_ATTEMPTS ?? 3), // must match the queue's maxReceiveCount
};
