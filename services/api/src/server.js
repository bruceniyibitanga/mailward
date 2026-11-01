// Entry point of the API service. It serves the public lookup routes (protected by API keys) and the
// private /admin routes used only by the dashboard (protected by a sign-in token), and it shuts down
// cleanly when the platform stops it. All settings come from environment variables (see config.js).

import express from 'express';
import { config } from './config.js';
import { redis } from './clients.js';
import { publicRouter } from './routes/public.js';
import { adminRouter } from './routes/admin.js';
import { startUsageFlusher, stopUsageFlusher, flushUsage } from './usage.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

app.use(publicRouter);
app.use('/admin', adminRouter); // every route in admin.js is under /admin

app.use((req, res) => res.status(404).json({ error: 'not_found' }));

// Express 5 sends errors from async handlers here automatically.
app.use((err, req, res, next) => {
  console.error(JSON.stringify({ level: 'error', msg: 'unhandled error', path: req.path, err: err.message }));
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal_error' });
});

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(JSON.stringify({ level: 'info', msg: `api listening on ${config.port}` }));
});
startUsageFlusher();

// ECS sends SIGTERM before stopping a task (for example when scaling in).
// Stop taking new requests, save pending usage counts, then exit.
async function shutdown() {
  console.log(JSON.stringify({ level: 'info', msg: 'SIGTERM received, shutting down' }));
  stopUsageFlusher();
  server.close();
  await flushUsage();
  await redis.quit().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
