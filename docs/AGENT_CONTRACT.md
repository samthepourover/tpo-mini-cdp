# Internal build contract (for parallel implementation)

Stack: Node >=22.13 ESM, Express 4, built-in `node:sqlite` (DatabaseSync, synchronous API), no frontend build step
(vanilla ES modules in /public). Deployed to Railway with a volume at /data. Tests: `node --test test/`.

Already written (do not rewrite; small additive edits OK): src/config.js, src/db.js (schema: read it!), src/server.js,
src/auth.js, src/util.js (normEmail, pseudonym, normDate, normTimestamp, normCat, httpError).

"Today" = config.today ('2026-09-28'). Never use the real current date for business logic.

**The real CSVs contain PII and must never be read by developers/agents.** Build and test using the synthetic fixture
generator `scripts/generate-fake-data.js` (writes to test/fixtures/). Never commit real CSVs.

## Module ownership

| File | Owner | Exports |
|---|---|---|
| src/ingest.js | core | `ingestCsv(db, kind, buffer, filename) -> report`, `detectColumns(kind, headers) -> mapping`, `relinkAll(db)` |
| src/profiles.js | core | `searchProfiles(db, q, limit=20)`, `getProfile(db, id)` |
| src/segments.js | core | `runSegment(db, spec, {limit, offset}) -> {total, rows}`, `SEGMENT_FIELDS`, `validateSpec(spec)` |
| src/stats.js | core | `overview(db)` counts, `pageStats`, `sourceStats` (aggregate helpers) |
| src/api.js | core | `apiRouter` (routes below) |
| src/webhook.js | webhook | `webhookRouter`, `ingestAppEvent(db, evt) -> {status}` (pure fn, testable) |
| src/assistant.js, src/pii.js | ai | `assistantRouter`, PII scanner/tokenizer |
| public/* | frontend | index.html, login.html, app.js, styles.css, logo.svg |
| scripts/generate-fake-data.js | core | messy synthetic CSVs for dev/test |
| scripts/send-webhook.js | webhook | signs + sends an event |

## Identity rules
- Subscriber dedupe: normalize email (normEmail). Multiple rows -> one profile. Merge: earliest signup_date,
  latest last_open_date, source from the earliest-signup row (fallback first non-null), status precedence
  unsubscribed > bounced > active > other? -> use the row with the most recent evidence; document choice. Count
  merged rows in duplicate_count.
- web_events.profile_id: email match to profile. ALSO stitch by visitor_id: if any event for a visitor_id has an
  email that matches a profile, all events of that visitor_id get that profile_id.
- app_users.profile_id: email match -> existing profile; else create profile (is_subscriber=0, origin app_users_csv).
- Webhook unknown user_id -> create profiles row (email NULL, origin 'webhook') + app_users row (origin 'webhook').
- Import order must not matter: `relinkAll(db)` re-runs linking (web + app_users + app_events) after every import.

## Segment spec (shared by UI and AI assistant — the AI NEVER writes SQL, it only emits a spec)
```json
{
  "source": ["instagram"],            // any-of, acquisition source (normalized lowercase)
  "status": ["active"],               // any-of
  "is_subscriber": true,
  "signup_after": "2026-08-01",       // inclusive YYYY-MM-DD
  "signup_before": "2026-08-31",      // inclusive
  "not_opened_in_days": 30,           // last_open_date null OR < today - N
  "opened_within_days": 7,            // last_open_date >= today - N
  "has_app": true,                    // has an app_users row
  "app_events_min": 5,                // count of app_events (optionally within app_events_within_days)
  "app_events_within_days": 30,
  "app_event_type": "read_story",     // restrict the app_events count to one type
  "web_visits_min": 3,
  "web_visits_within_days": 30,
  "visited_page": "/subscribe",       // substring match on any web_events.page
  "sort": "engagement_desc" | "signup_desc" | "last_open_desc",
  "limit": 100
}
```
All keys optional; unknown keys -> 400 from validateSpec. Engagement score (define in segments.js, document it):
`opens_recency_points + 2*app_events_30d + web_visits_30d`.
runSegment rows: `{ id, email, source, status, signup_date, last_open_date, has_app, app_events, web_visits, engagement }`.

## HTTP API (all under /api require the session cookie)
- POST /api/import/:kind  (multipart field `file`; kind = subscribers|web_events|app_users) -> report JSON
- GET  /api/imports -> recent import reports
- GET  /api/overview -> { profiles, subscribers, duplicates_merged, web_events, web_linked, app_users, app_events, ... }
- GET  /api/profiles?q=  -> [{id, email, source, status, is_subscriber}]  (q matches email substring, user_id, visitor_id)
- GET  /api/profiles/:id -> { profile, app_users:[...], web_events:[...], app_events:[...], timeline:[...] }
- POST /api/segments  body = spec -> { total, rows }
- GET  /api/segments/fields -> field metadata for building the UI form
- GET  /api/segments/export.csv?spec=<urlencoded json> -> CSV download
- GET  /api/events/recent -> last 50 app_events (for the live webhook feed)
- POST /api/assistant  { message, history? } -> { answer, table?: {columns, rows}, segment?: {spec,total}, trace }
- GET  /api/assistant/audit -> recent llm_audit rows + pii scan summary
- POST /webhooks/app  (NOT session auth; HMAC auth, see webhook.js)

## Brand (frontend)
Poppins; Warm Charcoal #463F3A (text, nav); Coral #F2827F (primary CTAs ONLY, sparingly, never bg/text);
Light Gray #E6E6E6 (cards/dividers); White #FFF surfaces; page bg #F7F6F4. Muted text = charcoal at 60% opacity.
No shadows (borders instead), no dark mode, no pure black, warm & calm editorial feel.
