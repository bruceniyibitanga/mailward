// All settings come from environment variables, so the same container image
// works locally and in ECS. Nothing secret is hard-coded here.

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  region: process.env.AWS_REGION ?? 'ap-southeast-2',

  tableName: required('TABLE_NAME'),
  queueUrl: required('QUEUE_URL'),
  dlqUrl: process.env.DLQ_URL ?? '',
  bucketName: required('BUCKET_NAME'),

  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  redisCluster: process.env.REDIS_CLUSTER === 'true',

  userPoolId: required('COGNITO_USER_POOL_ID'),
  cognitoClientId: required('COGNITO_CLIENT_ID'),

  // Used only by the ops panel endpoint
  ecsCluster: process.env.ECS_CLUSTER ?? '',
  apiServiceName: process.env.API_SERVICE_NAME ?? '',
  workerServiceName: process.env.WORKER_SERVICE_NAME ?? '',

  defaultRateLimitPerMin: Number(process.env.DEFAULT_RATE_LIMIT ?? 600),
};
