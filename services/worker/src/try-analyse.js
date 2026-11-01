// Run the analysis on one domain from your laptop, without SQS:
//   npm run analyse -- mailinator.com
import { analyseDomain } from './analyse.js';
import { redis } from './clients.js';

const domain = process.argv[2];
if (!domain) {
  console.error('Usage: npm run analyse -- example.com');
  process.exit(1);
}
console.log(JSON.stringify(await analyseDomain(domain), null, 2));
await redis.quit().catch(() => {});
