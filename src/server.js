import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { getDb } from './db.js';
import { authRouter, requireAuth } from './auth.js';
import { apiRouter } from './api.js';            // ingest, lookup, segments, stats
import { webhookRouter } from './webhook.js';    // POST /webhooks/app (HMAC auth, own body parser)
import { assistantRouter } from './assistant.js';// POST /api/assistant, GET /api/assistant/audit

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

getDb();

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'");
  next();
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Webhook is mounted BEFORE json/cookie middleware: it needs the raw body for HMAC.
app.use('/webhooks', webhookRouter);

app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(authRouter);                               // /login, /logout, /api/session

app.use('/api', requireAuth, apiRouter);
app.use('/api/assistant', requireAuth, assistantRouter);

app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'login.html')));
app.get('*', requireAuth, (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Internal error' });
});

const server = app.listen(config.port, () => console.log(`TPO mini CDP on :${config.port} (today=${config.today})`));

// Railway sends SIGTERM when swapping deployments; exit cleanly so it isn't reported as a crash.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => { try { getDb().close(); } catch {} process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
