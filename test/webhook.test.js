import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb } from '../src/db.js';
import {
  ingestAppEvent, verifySignature, signPayload, computeSignature, validateEvent, parseSecrets,
} from '../src/webhook.js';

const SECRET = 'test-secret';
const NOW = 1_790_000_000;

function fixtureUser(db, userId, email) {
  const p = db.prepare("INSERT INTO profiles (email, is_subscriber, origin) VALUES (?, 1, 'subscribers_csv')").run(email);
  db.prepare("INSERT INTO app_users (user_id, email, created_date, profile_id, origin) VALUES (?, ?, '2026-01-01', ?, 'app_users_csv')")
    .run(userId, email, Number(p.lastInsertRowid));
  return Number(p.lastInsertRowid);
}
const ev = (id, event, user, device, ts, properties) =>
  ({ event_id: id, event, user_id: user, device_id: device, timestamp: ts, ...(properties ? { properties } : {}) });
const row = (db, id) => db.prepare('SELECT * FROM app_events WHERE event_id = ?').get(id);

// ---- signatures --------------------------------------------------------------------------------

test('valid signature is accepted', () => {
  const body = '{"a":1}';
  const { timestamp, signature } = signPayload(SECRET, body, NOW);
  assert.equal(signature, `v1=${computeSignature(SECRET, NOW, body)}`);
  assert.deepEqual(verifySignature({ rawBody: Buffer.from(body), timestamp, signature, secrets: [SECRET], now: NOW }), { ok: true });
});

test('tampered body / wrong secret / missing headers are rejected', () => {
  const body = '{"a":1}';
  const { timestamp, signature } = signPayload(SECRET, body, NOW);
  assert.equal(verifySignature({ rawBody: '{"a":2}', timestamp, signature, secrets: [SECRET], now: NOW }).ok, false);
  assert.equal(verifySignature({ rawBody: body, timestamp, signature, secrets: ['other'], now: NOW }).ok, false);
  assert.equal(verifySignature({ rawBody: body, timestamp, signature: undefined, secrets: [SECRET], now: NOW }).ok, false);
  assert.equal(verifySignature({ rawBody: body, timestamp: undefined, signature, secrets: [SECRET], now: NOW }).ok, false);
  assert.equal(verifySignature({ rawBody: body, timestamp, signature: 'v1=zz', secrets: [SECRET], now: NOW }).ok, false);
  assert.equal(verifySignature({ rawBody: body, timestamp, signature: signature.slice(3), secrets: [SECRET], now: NOW }).ok, false);
  // timestamp is part of the signed payload: changing it breaks the signature
  assert.equal(verifySignature({ rawBody: body, timestamp: String(NOW + 1), signature, secrets: [SECRET], now: NOW }).ok, false);
});

test('expired and future timestamps are rejected (5 min window)', () => {
  const body = '{}';
  const old = signPayload(SECRET, body, NOW - 301);
  const r = verifySignature({ rawBody: body, ...old, secrets: [SECRET], now: NOW });
  assert.deepEqual(r, { ok: false, reason: 'timestamp_out_of_tolerance' });
  const future = signPayload(SECRET, body, NOW + 301);
  assert.equal(verifySignature({ rawBody: body, ...future, secrets: [SECRET], now: NOW }).ok, false);
  const edge = signPayload(SECRET, body, NOW - 299);
  assert.equal(verifySignature({ rawBody: body, ...edge, secrets: [SECRET], now: NOW }).ok, true);
});

test('key rotation: any configured secret is accepted', () => {
  const body = '{}';
  const secrets = parseSecrets('new-secret, old-secret');
  assert.deepEqual(secrets, ['new-secret', 'old-secret']);
  for (const s of ['new-secret', 'old-secret']) {
    const h = signPayload(s, body, NOW);
    assert.equal(verifySignature({ rawBody: body, ...h, secrets, now: NOW }).ok, true);
  }
  // sender mid-rotation may send several v1 entries
  const a = signPayload('retired', body, NOW), b = signPayload('new-secret', body, NOW);
  assert.equal(verifySignature({ rawBody: body, timestamp: a.timestamp, signature: `${a.signature},${b.signature}`, secrets, now: NOW }).ok, true);
});

// ---- validation --------------------------------------------------------------------------------

test('schema validation reports field errors', () => {
  const r = validateEvent({ event_id: '', event: 'purchase', device_id: 'x'.repeat(101), timestamp: 'nope', extra: 1, properties: [] });
  assert.equal(r.ok, false);
  for (const f of ['event_id', 'event', 'device_id', 'timestamp', 'extra', 'properties']) assert.ok(r.errors[f], f);
  assert.equal(validateEvent(ev('e', 'read_story', null, 'd', '2026-09-28T14:22:05Z', { s: 'x'.repeat(9000) })).ok, false);
  const ok = validateEvent(ev('e', 'read_story', null, 'd', '2026-09-28T14:22:05Z', { story: 'a' }));
  assert.equal(ok.ok, true);
  assert.equal(ok.event.timestamp, '2026-09-28T14:22:05.000Z');
  assert.equal(ingestAppEvent(openTestDb(), { event: 'login' }).status, 'invalid');
});

// ---- ingestion ---------------------------------------------------------------------------------

test('duplicate event_id is a no-op', () => {
  const db = openTestDb();
  const e = ev('evt_1', 'app_open', null, 'd1', '2026-09-28T10:00:00Z');
  assert.equal(ingestAppEvent(db, e).status, 'accepted');
  const again = ingestAppEvent(db, { ...e, event: 'read_story' });
  assert.deepEqual(again, { status: 'duplicate', event_id: 'evt_1' });
  assert.equal(db.prepare('SELECT count(*) n FROM app_events').get().n, 1);
  assert.equal(row(db, 'evt_1').event, 'app_open');
});

test('known user_id resolves to existing profile', () => {
  const db = openTestDb();
  const pid = fixtureUser(db, 'u_known', 'a@example.com');
  const r = ingestAppEvent(db, ev('e1', 'read_story', 'u_known', 'd1', '2026-09-28T10:00:00Z', { story: 's' }));
  assert.equal(r.status, 'accepted');
  assert.equal(r.profile_id, pid);
  assert.equal(r.new_profile, false);
  assert.equal(db.prepare('SELECT count(*) n FROM profiles').get().n, 1);
});

test('unknown user_id creates a webhook profile instead of being dropped', () => {
  const db = openTestDb();
  const r = ingestAppEvent(db, ev('e1', 'app_open', 'u_new', 'd1', '2026-09-28T10:00:00Z'));
  assert.equal(r.status, 'accepted');
  assert.equal(r.new_profile, true);
  const p = db.prepare('SELECT * FROM profiles WHERE id = ?').get(r.profile_id);
  assert.equal(p.email, null); assert.equal(p.origin, 'webhook'); assert.equal(p.is_subscriber, 0);
  const au = db.prepare('SELECT * FROM app_users WHERE user_id = ?').get('u_new');
  assert.equal(au.origin, 'webhook'); assert.equal(au.profile_id, r.profile_id);
  // second event for same unknown user reuses the profile
  const r2 = ingestAppEvent(db, ev('e2', 'read_story', 'u_new', 'd1', '2026-09-28T10:05:00Z'));
  assert.equal(r2.profile_id, r.profile_id);
  assert.equal(db.prepare('SELECT count(*) n FROM profiles').get().n, 1);
});

test('anonymous events are back-filled when the device logs in', () => {
  const db = openTestDb();
  const pid = fixtureUser(db, 'u_1', 'a@example.com');
  assert.equal(ingestAppEvent(db, ev('a1', 'app_open', null, 'd1', '2026-09-28T09:00:00Z')).resolved_user_id, null);
  ingestAppEvent(db, ev('a2', 'read_story', null, 'd1', '2026-09-28T09:05:00Z', { story: 'x' }));
  ingestAppEvent(db, ev('other', 'app_open', null, 'd_other', '2026-09-28T09:05:00Z'));
  const login = ingestAppEvent(db, ev('l1', 'login', 'u_1', 'd1', '2026-09-28T09:10:00Z'));
  assert.equal(login.backfilled, 2);
  for (const id of ['a1', 'a2', 'l1']) {
    assert.equal(row(db, id).resolved_user_id, 'u_1');
    assert.equal(row(db, id).profile_id, pid);
  }
  assert.equal(row(db, 'a1').user_id, null, 'raw user_id is preserved as sent');
  assert.equal(row(db, 'other').resolved_user_id, null, 'other devices untouched');
  const dev = db.prepare('SELECT * FROM devices WHERE device_id = ?').get('d1');
  assert.equal(dev.user_id, 'u_1');
  assert.equal(dev.first_seen, '2026-09-28T09:00:00.000Z');
});

test('out-of-order: anonymous event arriving after login is resolved immediately', () => {
  const db = openTestDb();
  const pid = fixtureUser(db, 'u_1', 'a@example.com');
  ingestAppEvent(db, ev('l1', 'login', 'u_1', 'd1', '2026-09-28T09:10:00Z'));
  const late = ingestAppEvent(db, ev('a0', 'app_open', null, 'd1', '2026-09-28T08:00:00Z'));
  assert.equal(late.resolved_user_id, 'u_1');
  assert.equal(late.profile_id, pid);
  assert.equal(db.prepare('SELECT first_seen FROM devices').get().first_seen, '2026-09-28T08:00:00.000Z');
});

test('shared device: anonymous events attach to the user logged in at that time', () => {
  const db = openTestDb();
  fixtureUser(db, 'u_a', 'a@example.com');
  fixtureUser(db, 'u_b', 'b@example.com');
  // deliberately delivered out of order
  ingestAppEvent(db, ev('x2', 'app_open', null, 'shared', '2026-09-28T12:30:00Z')); // after B's login
  ingestAppEvent(db, ev('lb', 'login', 'u_b', 'shared', '2026-09-28T12:00:00Z'));
  assert.equal(row(db, 'x2').resolved_user_id, 'u_b');
  ingestAppEvent(db, ev('x0', 'app_open', null, 'shared', '2026-09-28T08:00:00Z')); // before any login
  ingestAppEvent(db, ev('x1', 'app_open', null, 'shared', '2026-09-28T10:30:00Z')); // between logins
  const la = ingestAppEvent(db, ev('la', 'login', 'u_a', 'shared', '2026-09-28T10:00:00Z'));
  assert.equal(row(db, 'x0').resolved_user_id, 'u_a', 'pre-login browsing -> earliest subsequent login');
  assert.equal(row(db, 'x1').resolved_user_id, 'u_a');
  assert.equal(row(db, 'x2').resolved_user_id, 'u_b');
  assert.equal(la.backfilled, 2); // x0 and x1 moved from u_b to u_a
  assert.equal(db.prepare('SELECT user_id FROM devices WHERE device_id = ?').get('shared').user_id, 'u_b', 'latest login owns the device');
});

test('batch of events via ingestAppEvent loop yields per-event results', () => {
  const db = openTestDb();
  const batch = [
    ev('b1', 'app_open', null, 'd9', '2026-09-28T09:00:00Z'),
    ev('b1', 'app_open', null, 'd9', '2026-09-28T09:00:00Z'),
    { event_id: 'b2', event: 'bogus', device_id: 'd9', timestamp: '2026-09-28T09:00:00Z' },
    ev('b3', 'login', 'u_batch', 'd9', '2026-09-28T09:01:00Z'),
  ];
  const statuses = batch.map((e) => ingestAppEvent(db, e).status);
  assert.deepEqual(statuses, ['accepted', 'duplicate', 'invalid', 'accepted']);
  assert.equal(row(db, 'b1').resolved_user_id, 'u_batch');
});

// ---- HTTP (end-to-end through the router) ------------------------------------------------------

test('HTTP: signature, validation, duplicate, batch, 413', async () => {
  process.env.DATA_DIR = ':memory:';
  const express = (await import('express')).default;
  const { getDb } = await import('../src/db.js');
  getDb(':memory:');
  const { webhookRouter } = await import('../src/webhook.js');
  const { config } = await import('../src/config.js');
  const app = express();
  app.use('/webhooks', webhookRouter);
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}/webhooks/app`;
  const secret = config.webhookSecret.split(',')[0];
  const send = (payload, { sign = true, body } = {}) => {
    const raw = body ?? JSON.stringify(payload);
    const h = signPayload(secret, raw);
    return fetch(url, {
      method: 'POST', body: raw,
      headers: { 'content-type': 'application/json', ...(sign ? { 'x-tpo-timestamp': h.timestamp, 'x-tpo-signature': h.signature } : {}) },
    });
  };
  try {
    const e = ev('http_1', 'read_story', null, 'd_http', '2026-09-28T14:22:05Z', { story: 's' });
    assert.equal((await send(e, { sign: false })).status, 401);
    const r1 = await send(e);
    assert.equal(r1.status, 202);
    assert.equal((await r1.json()).status, 'accepted');
    const r2 = await send(e);
    assert.equal(r2.status, 200);
    assert.equal((await r2.json()).status, 'duplicate');
    const bad = await send({ event_id: 'x', event: 'nope', device_id: 'd', timestamp: 't' });
    assert.equal(bad.status, 400);
    assert.ok((await bad.json()).fields.event);
    const batch = await send([ev('http_2', 'login', 'u_http', 'd_http', '2026-09-28T14:30:00Z'), { event_id: 'bad' }]);
    assert.equal(batch.status, 207);
    const bj = await batch.json();
    assert.deepEqual(bj.summary, { accepted: 1, duplicate: 0, invalid: 1, error: 0 });
    assert.equal(bj.results[0].backfilled, 1);
    assert.equal((await send(null, { body: JSON.stringify({ p: 'x'.repeat(70_000) }) })).status, 413);
    assert.equal((await send(null, { body: '{not json' })).status, 400);
  } finally {
    server.close();
  }
});
