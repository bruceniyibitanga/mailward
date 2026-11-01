// Creates an API key directly in DynamoDB, for testing before the dashboard exists.
//   node --env-file=.env src/tools/create-key.js "laptop test" 600
// The second argument is the rate limit per minute (default 600).
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../clients.js';
import { config } from '../config.js';
import { generateKey, hashKey } from '../keys.js';

const name = process.argv[2] ?? 'cli test key';
const rateLimitPerMin = Number(process.argv[3] ?? 600);
const rawKey = generateKey();
const hash = hashKey(rawKey);

await ddb.send(new PutCommand({
  TableName: config.tableName,
  Item: {
    PK: `KEY#${hash}`, SK: 'META', ownerSub: 'cli', name, prefix: rawKey.slice(0, 14),
    createdAt: new Date().toISOString(), revoked: false, rateLimitPerMin,
  },
}));

console.log(`Created key "${name}" (limit ${rateLimitPerMin}/min):\n\n${rawKey}\n\nCopy it now. Only its hash was stored.`);
process.exit(0);
