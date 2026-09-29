#!/usr/bin/env node
// Sign and send app events to POST /webhooks/app.
//
//   node scripts/send-webhook.js --url http://localhost:3000/webhooks/app --secret X \
//        [--event read_story] [--user u_123] [--device d_abc] [--story slug] [--id evt_...] [--ts ISO]
//   node scripts/send-webhook.js --demo          # live identity-stitching walkthrough
//   node scripts/send-webhook.js --demo --curl   # also print a copy-pasteable signed curl per request
//
// Env fallbacks: WEBHOOK_URL, WEBHOOK_SECRET (first entry used if it is a comma-separated list).
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string' }, secret: { type: 'string' },
    event: { type: 'string', default: 'read_story' }, user: { type: 'string' }, device: { type: 'string' },
    story: { type: 'string' }, id: { type: 'string' }, ts: { type: 'string' },
    demo: { type: 'boolean', default: false }, curl: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  console.log('Usage: node scripts/send-webhook.js [--url U] [--secret S] [--event E] [--user U] [--device D] [--story slug] [--id ID] [--ts ISO] [--demo] [--curl]');
  process.exit(0);
}

const url = args.url || process.env.WEBHOOK_URL || 'http://localhost:3000/webhooks/app';
const secret = (args.secret || process.env.WEBHOOK_SECRET || 'dev-webhook-secret').split(',')[0].trim();
const rid = (p, n = 6) => `${p}_${crypto.randomBytes(n).toString('hex').slice(0, n)}`;

function sign(body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const hex = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return { timestamp, signature: `v1=${hex}` };
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

async function send(payload, label, { showCurl = args.curl } = {}) {
  const body = JSON.stringify(payload);
  const { timestamp, signature } = sign(body);
  console.log(`\n\x1b[1m▶ ${label}\x1b[0m`);
  console.log(`  ${body}`);
  if (showCurl) {
    console.log('  curl (valid for 5 minutes):');
    console.log(`  curl -sS -X POST ${shq(url)} -H 'Content-Type: application/json' \\\n` +
      `    -H ${shq(`X-TPO-Timestamp: ${timestamp}`)} -H ${shq(`X-TPO-Signature: ${signature}`)} \\\n    --data ${shq(body)}`);
  }
  const res = await fetch(url, {
    method: 'POST', body,
    headers: { 'Content-Type': 'application/json', 'X-TPO-Timestamp': timestamp, 'X-TPO-Signature': signature },
  });
  const text = await res.text();
  let out; try { out = JSON.stringify(JSON.parse(text)); } catch { out = text; }
  console.log(`  ← HTTP ${res.status} ${out}`);
  return { status: res.status, body: out };
}

const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

async function demo() {
  const device = args.device || rid('d');
  const user = args.user || rid('u', 8);
  const t0 = Date.now() - 10 * 60 * 1000;
  const at = (min) => iso(new Date(t0 + min * 60 * 1000));
  const e1 = { event_id: rid('evt'), event: 'app_open', user_id: null, device_id: device, timestamp: at(1), properties: {} };
  const e2 = { event_id: rid('evt'), event: 'read_story', user_id: null, device_id: device, timestamp: at(2),
    properties: { story: 'supreme-court-ruling-explained' } };
  console.log(`Demo against ${url}\n  device=${device}  user=${user}`);
  await send(e1, '1. Anonymous app_open on a brand-new device (no user yet → unresolved)', { showCurl: true });
  await send(e2, '2. Anonymous read_story on the same device');
  await send(e2, '3. Same event_id re-delivered (retry) → 200 duplicate, no side effects');
  await send({ event_id: rid('evt'), event: 'login', user_id: user, device_id: device, timestamp: at(5), properties: {} },
    '4. Device logs in as a never-seen user_id → new profile + earlier anonymous events back-filled');
  await send({ event_id: rid('evt'), event: 'link_click', user_id: null, device_id: device, timestamp: at(0),
    properties: { url: 'https://thepourover.org/subscribe' } },
  '5. Late-arriving anonymous event stamped BEFORE the login (out of order) → resolved immediately');
  await send({ event_id: rid('evt'), event: 'read_story', user_id: user, device_id: device, timestamp: at(6),
    properties: { story: 'fed-rate-decision' } }, '6. Identified read_story after login');
  // Negative case: bad signature
  console.log('\n\x1b[1m▶ 7. Tampered signature → 401\x1b[0m');
  const body = JSON.stringify(e1);
  const r = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json',
    'X-TPO-Timestamp': String(Math.floor(Date.now() / 1000)), 'X-TPO-Signature': 'v1=' + '0'.repeat(64) } });
  console.log(`  ← HTTP ${r.status} ${await r.text()}`);
  console.log(`\nLook up user_id ${user} (or device ${device}) in the CDP to see the stitched timeline.`);
}

async function single() {
  const payload = {
    event_id: args.id || rid('evt'),
    event: args.event,
    user_id: args.user || null,
    device_id: args.device || rid('d'),
    timestamp: args.ts || iso(new Date()),
    properties: args.story ? { story: args.story } : {},
  };
  await send(payload, `Sending ${payload.event}`, { showCurl: true });
}

(args.demo ? demo() : single()).catch((err) => {
  console.error(`Request failed: ${err.cause?.code || err.message} (is the server running at ${url}?)`);
  process.exit(1);
});
