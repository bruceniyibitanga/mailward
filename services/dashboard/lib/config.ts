// Settings are read when they're used (not when the file loads), so
// `next build` works without any secrets present. ECS provides them at runtime.

export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

// The public address people use, e.g. https://d1234abcd.cloudfront.net
// We can't trust the request's own host because the request reaches us
// through CloudFront and the load balancer.
export function appUrl(): string {
  return env("APP_URL").replace(/\/$/, "");
}
