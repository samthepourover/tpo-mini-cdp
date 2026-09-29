// POST /webhooks/app — mobile app event ingestion.
//
// Security: Stripe-style HMAC-SHA256 over `${timestamp}.${rawBody}` with a 5-minute replay window,
// constant-time compare, multi-secret rotation, per-IP rate limit, strict schema validation, 64kb cap.
//
// Semantics (see docs/WEBHOOK.md):
//  - Idempotent on event_id (a re-delivery is a 200 no-op).
//  - Unknown user_id -> new profile (email NULL, origin 'webhook') + app_users row. Never dropped.
//  - Identity stitching via device logins: anonymous events on a device are attributed to the user whose
//    login on that device is the latest at-or-before the event ts; if none, the earliest login after it
//    (pre-login anonymous browsing). Re-evaluated whenever a new login for the device arrives, so
//    out-of-order delivery converges to the same answer regardless of arrival order.
import express from 'express';
import crypto from 'node:crypto';
import { config } from './config.js';
import { getDb } from './db.js';
import { normTimestamp, normDate } from './util.js';

export const EVENT_TYPES = ['app_open', 'read_story', 'link_click', 'login'];
export const SIGNATURE_HEADER = 'x-tpo-signature';
export const TIMESTAMP_HEADER = 'x-tpo-timestamp';
export const TOLERANCE_SEC = 5 * 60;
export const MAX_BATCH = 100;
const MAX_ID_LEN = 100;
const MAX_PROPS_BYTES = 8 * 1024;

// ---------------------------------------------------------------------------------------------------
// Signing / verification
// ---------------------------------------------------------------------------------------------------

/** Parse config.webhookSecret (comma-separated list, for zero-downtime rotation). */
export function parseSecrets(value = config.webhookSecret) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Hex HMAC-SHA256 of `${timestamp}.${rawBody}`. */
export function computeSignature(secret, timestamp, rawBody) {
  return crypto.createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody)))
    .digest('hex');
}

/** Build the header values a sender should use. */
export function signPayload(secret, rawBody, timestamp = Math.floor(Date.now() / 1000)) {
  return { timestamp: String(timestamp), signature: `v1=${computeSignature(secret, timestamp, rawBody)}` };
}

function safeHexEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !/^[0-9a-f]+$/i.test(a)) return false;
  const x = Buffer.from(a.toLowerCase(), 'hex'), y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/**
 * Verify a request signature. Returns { ok: true } or { ok: false, reason } (reason is for logs only;
 * never return it to the client).
 * @param {{rawBody: Buffer|string, timestamp?: string, signature?: string, secrets?: string[]|string,
 *          now?: number, toleranceSec?: number}} opts  now = unix seconds
 */
export function verifySignature({ rawBody, timestamp, signature, secrets = parseSecrets(), now, toleranceSec = TOLERANCE_SEC }) {
  const list = Array.isArray(secrets) ? secrets : parseSecrets(secrets);
  if (!list.length) return { ok: false, reason: 'no_secret_configured' };
  if (!timestamp || !/^\d{1,12}$/.test(String(timestamp))) return { ok: false, reason: 'bad_timestamp' };
  if (!signature) return { ok: false, reason: 'missing_signature' };
  const nowSec = now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - Number(timestamp)) > toleranceSec) return { ok: false, reason: 'timestamp_out_of_tolerance' };
  // Header may carry several comma-separated `v1=` entries (sender mid-rotation signs with both keys).
  const provided = String(signature).split(',').map((p) => p.trim())
    .filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!provided.length) return { ok: false, reason: 'no_v1_signature' };
  let match = false;
  for (const secret of list) {
    const expected = computeSignature(secret, timestamp, rawBody);
    for (const p of provided) if (safeHexEq(p, expected)) match = true; // no early exit: uniform timing
  }
  return match ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
}

// ---------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------

const ALLOWED_KEYS = new Set(['event_id', 'event', 'user_id', 'device_id', 'timestamp', 'properties']);
const isId = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_ID_LEN;

/** Strictly validate one event. Returns { ok: true, event } (normalized) or { ok: false, errors }. */
export function validateEvent(e) {
  const errors = {};
  if (!e || typeof e !== 'object' || Array.isArray(e)) return { ok: false, errors: { _: 'event must be a JSON object' } };
  for (const k of Object.keys(e)) if (!ALLOWED_KEYS.has(k)) errors[k] = 'unknown field';
  if (!isId(e.event_id)) errors.event_id = `required non-empty string, max ${MAX_ID_LEN} chars`;
  if (!EVENT_TYPES.includes(e.event)) errors.event = `must be one of ${EVENT_TYPES.join(', ')}`;
  if (!(e.user_id === null || e.user_id === undefined || isId(e.user_id))) errors.user_id = `string (max ${MAX_ID_LEN}) or null`;
  if (!isId(e.device_id)) errors.device_id = `required non-empty string, max ${MAX_ID_LEN} chars`;
  const ts = typeof e.timestamp === 'string' ? normTimestamp(e.timestamp) : null;
  if (!ts) errors.timestamp = 'required ISO-8601 timestamp string';
  let props = null;
  if (e.properties !== undefined && e.properties !== null) {
    if (typeof e.properties !== 'object' || Array.isArray(e.properties)) errors.properties = 'must be an object';
    else {
      props = JSON.stringify(e.properties);
      if (Buffer.byteLength(props) > MAX_PROPS_BYTES) errors.properties = `max ${MAX_PROPS_BYTES} bytes serialized`;
    }
  }
  if (e.event === 'login' && !e.user_id) errors.user_id = 'required for login events';
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    event: {
      event_id: e.event_id.trim(), event: e.event, user_id: e.user_id ? e.user_id.trim() : null,
      device_id: e.device_id.trim(), timestamp: ts, properties: props,
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Ingestion (pure w.r.t. HTTP; takes a db handle)
// ---------------------------------------------------------------------------------------------------

const initialized = new WeakSet();
/** Lazily create webhook-owned tables. Safe to call repeatedly. */
export function initWebhookTables(db) {
  if (initialized.has(db)) return;
  db.exec(`
    -- Login history per device: the source of truth for attributing anonymous events on shared devices.
    CREATE TABLE IF NOT EXISTS device_logins (
      device_id TEXT NOT NULL,
      user_id   TEXT NOT NULL,
      ts        TEXT NOT NULL,          -- ISO-8601 UTC, event time of the login (or first identified event)
      event_id  TEXT,
      implicit  INTEGER NOT NULL DEFAULT 0, -- 1 = inferred from a non-login event carrying user_id
      PRIMARY KEY (device_id, user_id, ts)
    );
    CREATE INDEX IF NOT EXISTS ix_device_logins_dev_ts ON device_logins(device_id, ts);
  `);
  initialized.add(db);
}

function ensureAppUser(db, userId, ts) {
  const row = db.prepare('SELECT profile_id FROM app_users WHERE user_id = ?').get(userId);
  if (row) return { profileId: row.profile_id, created: false };
  const p = db.prepare(
    "INSERT INTO profiles (email, email_hash, is_subscriber, origin) VALUES (NULL, NULL, 0, 'webhook')").run();
  const profileId = Number(p.lastInsertRowid);
  db.prepare("INSERT INTO app_users (user_id, email, created_date, profile_id, origin) VALUES (?, NULL, ?, ?, 'webhook')")
    .run(userId, normDate(ts), profileId);
  return { profileId, created: true };
}

/** Which user does an anonymous event on `deviceId` at `ts` belong to? null if the device never logged in. */
function resolveAnonymous(db, deviceId, ts) {
  const before = db.prepare(
    'SELECT user_id FROM device_logins WHERE device_id = ? AND ts <= ? ORDER BY ts DESC, rowid DESC LIMIT 1').get(deviceId, ts);
  if (before) return before.user_id;
  const after = db.prepare(
    'SELECT user_id FROM device_logins WHERE device_id = ? AND ts > ? ORDER BY ts ASC, rowid ASC LIMIT 1').get(deviceId, ts);
  return after ? after.user_id : null;
}

const profileFor = (db, userId) =>
  userId ? db.prepare('SELECT profile_id FROM app_users WHERE user_id = ?').get(userId)?.profile_id ?? null : null;

/** Re-attribute every anonymous event of a device. Returns the number of rows whose attribution changed. */
function restitchDevice(db, deviceId) {
  const rows = db.prepare(
    'SELECT event_id, ts, resolved_user_id FROM app_events WHERE device_id = ? AND user_id IS NULL').all(deviceId);
  const upd = db.prepare('UPDATE app_events SET resolved_user_id = ?, profile_id = ? WHERE event_id = ?');
  let changed = 0;
  for (const r of rows) {
    const uid = resolveAnonymous(db, deviceId, r.ts);
    if (uid !== r.resolved_user_id) { upd.run(uid, profileFor(db, uid), r.event_id); changed++; }
  }
  return changed;
}

/**
 * Ingest one raw app event (as received in the webhook body; validated here) in a single transaction.
 * @returns {{status:'duplicate', event_id} | {status:'accepted', event_id, resolved_user_id, profile_id,
 *           backfilled:number, new_profile:boolean} | {status:'invalid', errors}}
 */
export function ingestAppEvent(db, evt) {
  const v = validateEvent(evt);
  if (!v.ok) return { status: 'invalid', errors: v.errors };
  const e = v.event;
  initWebhookTables(db);

  const ownTx = !db.isTransaction;
  if (ownTx) db.exec('BEGIN IMMEDIATE');
  try {
    // 1. Idempotency
    const ins = db.prepare(
      'INSERT OR IGNORE INTO app_events (event_id, event, user_id, device_id, ts, properties) VALUES (?, ?, ?, ?, ?, ?)')
      .run(e.event_id, e.event, e.user_id, e.device_id, e.timestamp, e.properties);
    if (ins.changes === 0) {
      if (ownTx) db.exec('COMMIT');
      return { status: 'duplicate', event_id: e.event_id };
    }

    // 2. Device row (first_seen = earliest event ts seen, regardless of arrival order)
    db.prepare(`INSERT INTO devices (device_id, first_seen) VALUES (?, ?)
      ON CONFLICT(device_id) DO UPDATE SET first_seen = min(coalesce(first_seen, excluded.first_seen), excluded.first_seen)`)
      .run(e.device_id, e.timestamp);

    let resolvedUser = null, profileId = null, backfilled = 0, newProfile = false;
    if (e.user_id) {
      // 3. Identified event: make sure the user has a profile, record the device<->user observation.
      const au = ensureAppUser(db, e.user_id, e.timestamp);
      profileId = au.profileId; newProfile = au.created; resolvedUser = e.user_id;
      const hasLoginForPair = db.prepare('SELECT 1 FROM device_logins WHERE device_id = ? AND user_id = ? LIMIT 1')
        .get(e.device_id, e.user_id);
      let loginsChanged = false;
      if (e.event === 'login' || !hasLoginForPair) {
        const r = db.prepare('INSERT OR IGNORE INTO device_logins (device_id, user_id, ts, event_id, implicit) VALUES (?, ?, ?, ?, ?)')
          .run(e.device_id, e.user_id, e.timestamp, e.event_id, e.event === 'login' ? 0 : 1);
        loginsChanged = r.changes > 0;
      }
      if (loginsChanged) {
        // devices.user_id = current owner = user with the latest login on this device.
        const latest = db.prepare('SELECT user_id, ts FROM device_logins WHERE device_id = ? ORDER BY ts DESC, rowid DESC LIMIT 1')
          .get(e.device_id);
        db.prepare('UPDATE devices SET user_id = ?, linked_at = ? WHERE device_id = ?').run(latest.user_id, latest.ts, e.device_id);
        backfilled = restitchDevice(db, e.device_id);
      }
      db.prepare('UPDATE app_events SET resolved_user_id = ?, profile_id = ? WHERE event_id = ?')
        .run(e.user_id, profileId, e.event_id);
    } else {
      // Anonymous: resolve immediately if the device already has login history (out-of-order arrival).
      resolvedUser = resolveAnonymous(db, e.device_id, e.timestamp);
      profileId = profileFor(db, resolvedUser);
      if (resolvedUser) db.prepare('UPDATE app_events SET resolved_user_id = ?, profile_id = ? WHERE event_id = ?')
        .run(resolvedUser, profileId, e.event_id);
    }

    if (ownTx) db.exec('COMMIT');
    return { status: 'accepted', event_id: e.event_id, resolved_user_id: resolvedUser, profile_id: profileId, backfilled, new_profile: newProfile };
  } catch (err) {
    if (ownTx && db.isTransaction !== false) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } }
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------------
// Rate limiting (in-memory fixed window per IP; per-instance — use Redis/edge limits in prod)
// ---------------------------------------------------------------------------------------------------

export function createRateLimiter({ limit = 600, windowMs = 60_000 } = {}) {
  const hits = new Map();
  let lastSweep = Date.now();
  return function rateLimit(req, res, next) {
    const now = Date.now();
    if (now - lastSweep > windowMs) {
      for (const [k, v] of hits) if (now - v.start >= windowMs) hits.delete(k);
      lastSweep = now;
    }
    const key = req.ip || 'unknown';
    let h = hits.get(key);
    if (!h || now - h.start >= windowMs) { h = { start: now, count: 0 }; hits.set(key, h); }
    h.count++;
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - h.count)));
    if (h.count > limit) {
      res.setHeader('Retry-After', String(Math.ceil((h.start + windowMs - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests' });
    }
    next();
  };
}

// ---------------------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------------------

export const webhookRouter = express.Router();
const rawJson = express.raw({ type: 'application/json', limit: '64kb' });
const rateLimit = createRateLimiter({ limit: Number(process.env.WEBHOOK_RATE_LIMIT || 600) });

webhookRouter.post('/app', rateLimit, rawJson, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!Buffer.isBuffer(req.body)) return res.status(415).json({ error: 'Content-Type must be application/json' });

  const auth = verifySignature({
    rawBody: req.body, timestamp: req.get(TIMESTAMP_HEADER), signature: req.get(SIGNATURE_HEADER),
  });
  if (!auth.ok) {
    console.warn(`[webhook] rejected request from ${req.ip}: ${auth.reason}`);
    return res.status(401).json({ error: 'Invalid or missing signature' });
  }

  let payload;
  try { payload = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).json({ error: 'Body is not valid JSON' }); }

  const db = getDb();
  if (Array.isArray(payload)) {
    if (payload.length === 0 || payload.length > MAX_BATCH) {
      return res.status(400).json({ error: `Batch must contain 1-${MAX_BATCH} events` });
    }
    const results = payload.map((raw, index) => {
      const v = validateEvent(raw);
      if (!v.ok) return { index, event_id: typeof raw?.event_id === 'string' ? raw.event_id : null, status: 'invalid', errors: v.errors };
      try { return { index, ...ingestAppEvent(db, raw) }; } catch (err) {
        console.error('[webhook] ingest error', err);
        return { index, event_id: v.event.event_id, status: 'error' };
      }
    });
    const summary = { accepted: 0, duplicate: 0, invalid: 0, error: 0 };
    for (const r of results) summary[r.status]++;
    // 207 when some items need the sender's attention; 202 otherwise.
    const code = summary.invalid || summary.error ? 207 : 202;
    return res.status(code).json({ summary, results });
  }

  const v = validateEvent(payload);
  if (!v.ok) return res.status(400).json({ error: 'Invalid event', fields: v.errors });
  const result = ingestAppEvent(db, payload);
  return res.status(result.status === 'duplicate' ? 200 : 202).json(result);
});

// JSON errors for this router (e.g. 413 from the body parser) so the SPA error handler never sees them.
webhookRouter.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status === 413) return res.status(413).json({ error: 'Payload too large (max 64kb)' });
  if (status >= 400 && status < 500) return res.status(status).json({ error: 'Bad request' });
  console.error('[webhook] error', err);
  return res.status(500).json({ error: 'Internal error' });
});
