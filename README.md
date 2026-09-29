# TPO Mini CDP

A small customer data platform for The Pour Over's Growth team. It loads newsletter subscribers, website visits and app accounts into one place. It links each visit and app account to a person, takes in live mobile-app events by webhook, and lets a teammate ask plain-English questions of an AI assistant **that never sees PII**.

- **Live app:** `https://tpo-mini-cdp-production.up.railway.app` (password protected)
- **Webhook:** `POST https://tpo-mini-cdp-production.up.railway.app/webhooks/app` (HMAC-signed, see [docs/WEBHOOK.md](docs/WEBHOOK.md))
- **PII design:** [docs/PII.md](docs/PII.md)

## Run it locally

Requires Node ≥ 22.13 (uses the built-in `node:sqlite`; no native modules, no external database).

```bash
npm install
cp .env.example .env        # optional; sensible dev defaults are used if unset
npm run seed                # writes messy SYNTHETIC CSVs to test/fixtures/
APP_PASSWORD=dev ANTHROPIC_API_KEY=sk-... npm run dev
open http://localhost:3000  # password: dev
```

Then:
1. Go to **Import** and upload `subscribers.csv`, `web_events.csv` and `app_users.csv` (any order).
2. Send live app events: `npm run webhook -- --demo` (uses `dev-webhook-secret` locally).
3. Try **Lookup**, **Segments** and **Assistant**.

Tests: `npm test` (58 tests covering ingest/dedupe/linking, segments, webhook signing/idempotency/stitching, and PII redaction; no network calls).

## Features

| Brief requirement | Where |
|---|---|
| 1. Load, link, dedupe | `src/ingest.js` detects columns automatically, normalizes messy values, dedupes by normalized email, links by email and by visitor ID, and relinks after every import so import order doesn't matter |
| 2. Single subscriber view | `src/profiles.js`, **Lookup** tab |
| 3. Segments | `src/segments.js` builds segments from a JSON spec with parameterized SQL. **Segments** tab, CSV export |
| 4. Webhook | `src/webhook.js` handles `POST /webhooks/app` |
| 5. PII-safe AI assistant | `src/assistant.js`, `src/pii.js`, **Assistant** tab, `GET /api/assistant/audit` |

### Handling the messy data
- **Headers** are matched with fuzzy synonyms (`Email Address`, `email`, `Signed Up`, …). A missing field gives a clear 400 listing the headers the file actually has.
- **Emails** are trimmed and lowercased, `mailto:` and stray quotes are stripped, and invalid emails are counted, not loaded.
- **Dates** accept ISO, US `M/D/YYYY`, unix seconds or milliseconds, and ISO with time. Impossible dates such as `2026-02-30` are rejected, not rolled over.
- **Sources and statuses** are normalized for casing and whitespace, with a small documented alias map (`ig`→`instagram`).
- **Duplicate subscribers** are merged into one profile with these rules:
  - Signup date: the earliest.
  - Last open: the latest.
  - Source: taken from the earliest signup.
  - Status precedence is `unsubscribed > bounced > active`, so a merge can never drop an opt-out.
- **Every import** writes a data-quality report with counts only.

### Identity resolution
- **Subscribers and email:** a profile is keyed by normalized email.
- **Web visits:** a visit links to a profile if its email matches. **Visitor stitching:** once any visit from a `visitor_id` carries a matching email, all of that visitor's visits link to the profile.
- **App users:** an app account is linked by email. An app account with no matching subscriber gets its own app-only profile.
- **Unknown webhook `user_id`s:** they get a new profile. If an `app_users.csv` later supplies their email, that profile is merged into the subscriber profile.

### Webhook
- **Auth:** HMAC-SHA256 over `timestamp.rawBody`. The timestamp is sent in `X-TPO-Timestamp` and the signature in `X-TPO-Signature: v1=…`. Requests more than 5 minutes old or ahead are rejected (replay protection), the comparison is constant-time, and several secrets can be active at once so keys can be rotated.
- **Limits:** per-IP rate limit, 64 KB body cap, and strict schema validation.
- **Idempotent:** `event_id` is the key, so a duplicate returns `200 {status:"duplicate"}` with no side effects.
- **Stitching:**
  - Each login is recorded per device.
  - An anonymous event is assigned to whoever was logged in on that device at the event's timestamp. If nobody had logged in yet, it goes to the device's first later login.
  - Every new login re-evaluates the device's anonymous events. This makes out-of-order delivery and shared devices come out right.
- **Freshness:** writes go straight to SQLite, so lookup and segments reflect new events immediately with no restart.

### Keeping PII away from the model (summary; full detail in [docs/PII.md](docs/PII.md))
1. **Tools only.** The model can only call five tools (`describe_data`, `count_segment`, `build_segment`, `aggregate`, `lookup_profile_summary`). It never writes SQL and never receives raw rows.
2. **Pseudonyms.** Any row-level output shows people as keyed HMAC tokens (`sub_3f9a…`). Page paths are sanitized of query strings and ID-like segments.
3. **Your question is redacted before it's sent.** Emails, phone numbers and user, device or visitor IDs typed by the teammate become `[EMAIL_1]`-style placeholders. The server keeps the mapping, so a question about `[EMAIL_1]` still resolves correctly.
4. **Outbound guard and audit.** Every payload sent to the model is re-scanned, cleaned and logged to `llm_audit`. `GET /api/assistant/audit` re-scans those logs and reports `emails_seen_by_model: 0`.
5. **Real emails are filled in for the human only.** The model returns a segment *handle*. The server swaps real emails into the table and CSV for the logged-in user after the model is done.

## Deploy (Railway)

```bash
railway init && railway up
railway volume add --mount-path /data
railway variables --set NODE_ENV=production --set DATA_DIR=/data \
  --set APP_PASSWORD=… --set SESSION_SECRET=… --set WEBHOOK_SECRET=… \
  --set PII_HASH_KEY=… --set ANTHROPIC_API_KEY=…
railway domain
```

In production the app refuses to start if any secret is missing.

## Stack
Node 24, Express, built-in SQLite (WAL) on a Railway volume, and the Anthropic SDK (Claude Sonnet 5.5 with tool use). The frontend is vanilla ES modules with no build step and a strict CSP (`script-src 'self'`). It uses the TPO brand: Poppins, Warm Charcoal `#463F3A` and Coral `#F2827F` for CTAs only.

## Known limitations and next steps
- **Single instance.** SQLite suits ~15k rows and one instance. At TPO scale, move to Postgres, with webhook events going through a queue (SQS/PubSub) and async workers.
- **Segment handles** live in memory, so they are lost on restart.
- **Names typed into a question** aren't detected (regex-based). The dataset has no name fields.
- **Password auth.** A single shared password with an HMAC session cookie. In production, use SSO (Google Workspace) with per-user audit.
