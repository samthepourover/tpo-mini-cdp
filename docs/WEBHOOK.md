# App event webhook — `POST /webhooks/app`

The mobile app (or its event relay) pushes behavioral events here. Events land in SQLite right away,
so they show up in profile lookup and segments on the next query, with no restart or re-import.

Implementation: `src/webhook.js`. Tests: `test/webhook.test.js`. Sender/demo CLI: `scripts/send-webhook.js`.

## Payload

A single event object, or a JSON array of 1–100 events (batch).

```json
{
  "event_id": "evt_9f3a1c",
  "event": "read_story",
  "user_id": "u_2b6447a3",
  "device_id": "d_4b21e8",
  "timestamp": "2026-09-28T14:22:05Z",
  "properties": { "story": "supreme-court-ruling-explained" }
}
```

| Field | Rule |
|---|---|
| `event_id` | required string, 1–100 chars. **Idempotency key.** |
| `event` | required, one of `app_open`, `read_story`, `link_click`, `login` |
| `user_id` | string (≤100) or `null`. `null` until the device logs in. **Required for `login`.** |
| `device_id` | required string, 1–100 chars |
| `timestamp` | required ISO-8601 string (normalized to UTC ms, e.g. `2026-09-28T14:22:05.000Z`) |
| `properties` | optional object, ≤ 8 KB serialized |

Unknown top-level fields are rejected (strict schema). Max request body: 64 KB.

## Authentication (HMAC-SHA256, Stripe-style)

Every request carries two headers:

```
X-TPO-Timestamp: 1790700000            # unix seconds at send time
X-TPO-Signature: v1=<hex>              # hex(HMAC_SHA256(secret, `${timestamp}.${rawBody}`))
```

- The signature covers the **exact raw bytes** of the body. The route uses its own `express.raw` parser
  and is mounted before the global JSON parser, so nothing re-serializes the body.
- **Replay protection:** a request is rejected if `|now − X-TPO-Timestamp| > 300s`. The timestamp is part
  of the signed string, so a captured request can't be re-dated. Inside the window, replays are no-ops
  because of `event_id` idempotency.
- **Constant-time compare** (`crypto.timingSafeEqual`), and every candidate is checked without an early exit.
- **Key rotation:** `WEBHOOK_SECRET` may be a comma-separated list (`new,old`), and a signature from any
  listed secret is accepted. A sender in the middle of a rotation may also send several entries:
  `X-TPO-Signature: v1=<sig_new>,v1=<sig_old>`. To rotate: add the new secret, move senders over, then
  remove the old one.
- Every auth failure returns the same generic `401 {"error":"Invalid or missing signature"}`. The specific
  reason is only logged on the server.
- **Rate limit:** in-memory, per client IP, 600 requests/min by default (`WEBHOOK_RATE_LIMIT`). Over the
  limit you get `429` with `Retry-After`. The limit is checked before the body is parsed or verified.

### curl

```bash
SECRET=dev-webhook-secret
BODY='{"event_id":"evt_9f3a1c","event":"read_story","user_id":"u_2b6447a3","device_id":"d_4b21e8","timestamp":"2026-09-28T14:22:05Z","properties":{"story":"supreme-court-ruling-explained"}}'
TS=$(date +%s)
SIG=$(printf '%s' "$TS.$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
curl -sS -X POST http://localhost:3000/webhooks/app \
  -H 'Content-Type: application/json' \
  -H "X-TPO-Timestamp: $TS" -H "X-TPO-Signature: v1=$SIG" \
  --data "$BODY"
```

`node scripts/send-webhook.js ...` prints a ready-to-paste signed curl for every request it sends.

### Node

```js
import crypto from 'node:crypto';
const body = JSON.stringify(event);
const ts = String(Math.floor(Date.now() / 1000));
const sig = crypto.createHmac('sha256', process.env.WEBHOOK_SECRET).update(`${ts}.${body}`).digest('hex');
await fetch(url, { method: 'POST', body, headers: {
  'Content-Type': 'application/json', 'X-TPO-Timestamp': ts, 'X-TPO-Signature': `v1=${sig}` } });
```

## Responses

| Code | When | Body |
|---|---|---|
| 202 | single event stored | `{"status":"accepted","event_id","resolved_user_id","profile_id","backfilled","new_profile"}` |
| 200 | `event_id` already stored (retry) | `{"status":"duplicate","event_id"}` (no side effects) |
| 202 | batch, every item accepted or duplicate | `{"summary":{accepted,duplicate,invalid,error},"results":[{index,status,...}]}` |
| 207 | batch where at least one item is invalid or failed | same shape; only the failed items need a resend |
| 400 | bad JSON, schema errors, or empty/oversized batch | `{"error":"Invalid event","fields":{"event":"must be one of ..."}}` |
| 401 | missing, expired, or invalid signature | `{"error":"Invalid or missing signature"}` |
| 413 | body > 64 KB | `{"error":"Payload too large (max 64kb)"}` |
| 415 | Content-Type is not `application/json` | |
| 429 | rate limited | `Retry-After` header |

In `accepted`, `resolved_user_id` / `profile_id` are `null` for an anonymous event on a device that has
never logged in. `backfilled` counts how many earlier events on the device changed attribution because of
this event.

A sender should retry on 5xx, 429, and network errors with backoff, and **keep the same `event_id`**.

## Semantics

Each event is processed in one SQLite transaction (`ingestAppEvent(db, evt)`).

1. **Idempotency.** `INSERT OR IGNORE` into `app_events` keyed by `event_id`. If the id already exists, the
   request is a no-op `duplicate`. The first stored copy wins, even if a later payload differs.
2. **Device.** `devices` row upserted. `first_seen` is the earliest event timestamp, whatever order events
   arrive in.
3. **Identified event (`user_id` present).**
   - If `app_users` has the user, their existing `profile_id` is used.
   - If the user_id has **never been seen**, a new `profiles` row is created (`email NULL`, `is_subscriber 0`,
     `origin 'webhook'`) plus an `app_users` row (`origin 'webhook'`). The event is never dropped. If an
     app_users CSV import later brings that user_id with an email, the import/relink step can attach it.
   - A `login` event, or the first identified event for a (device, user) pair, is written to
     `device_logins(device_id, user_id, ts)`. The table is created lazily by `initWebhookTables`.
     Identified non-login events count as an "implicit login", so stitching still works if the actual
     login event is lost.
   - `devices.user_id` / `linked_at` = the user with the **latest** login on the device (its current owner).
4. **Anonymous event (`user_id` null).** Attributed through the device's login history:
   - the user whose login on that device is the **latest at or before** the event timestamp, otherwise
   - the **earliest login after** it (anonymous browsing before the first login belongs to whoever logs in first).
   - If the device has no logins, the event stays unresolved until one arrives.
5. **Back-fill / re-stitch.** When a new login lands in `device_logins`, *every* anonymous event on that
   device is re-evaluated with the rule above. So:
   - anonymous events that came before the login are attached to the user (`resolved_user_id`, `profile_id`);
   - an anonymous event that arrives **after** the device is already linked (out of order) is resolved
     immediately;
   - on a **shared device** (A logs in at 10:00, B at 12:00), events at 10:30 go to A and events at 12:30 go
     to B. This holds even if B's login is delivered before A's: the result depends only on event
     timestamps, not on arrival order.
6. The raw `user_id` stays exactly as sent. Attribution lives in `resolved_user_id` / `profile_id`, which is
   what lookup and segments read.

Caveat: after a logout, the app sends `user_id: null` again. Those events are attributed to the last user
who logged in on the device until someone else logs in. A `logout` event type would make this exact.

## What I'd add in production

- **Async processing:** verify the signature, write the raw event to a durable queue or outbox (SQS, Kafka,
  Postgres table), return 202, and let workers do the stitching. This decouples request latency from DB
  contention and allows replays.
- **Dead-letter queue** for events that fail processing, with alerting and a replay tool. Store rejected
  payloads (redacted) for debugging.
- **Secrets** in a secret manager, with scheduled rotation using the multi-secret support above. Use a
  separate secret per sender/app so one can be revoked on its own.
- **Network controls:** mTLS or an IP allowlist from the relay, plus a WAF / edge rate limit. The in-memory
  limiter here is per instance and resets on deploy; a shared store (Redis) would fix that.
- **Monitoring:** metrics for accepted, duplicate, invalid, and 401 counts, stitching lag, and
  unknown-user profile creation rate. An alert on a 401 spike can point to a leaked or rotated key.
- **Schema versioning** (`X-TPO-Schema: 1`), and a nonce/`event_id` replay cache if the webhook ever gets
  side effects that are not idempotent.
- **Data retention / PII:** `properties` is free-form, so allowlist its keys per event type, and set a TTL
  for raw events.
