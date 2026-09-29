/**
 * Segment builder. The UI and the AI assistant both emit a JSON *spec* (never SQL); this module
 * validates it and turns it into parameterized SQL. User values are ONLY ever bound as parameters —
 * the SQL text is assembled from fixed fragments (plus "?" placeholders whose count depends on array length).
 *
 *   validateSpec(spec)                 -> normalized spec (throws httpError 400)
 *   runSegment(db, spec, {limit, offset}) -> { total, rows }
 *   SEGMENT_FIELDS                     -> static field metadata
 *   segmentFields(db)                  -> SEGMENT_FIELDS with enum options filled from the DB
 *
 * Engagement score (per profile):
 *   engagement = opens_recency_points + 2 * app_events_30d + web_visits_30d
 *   opens_recency_points: last newsletter open <= 7 days ago -> 10, <= 30 days -> 5, <= 90 days -> 2, else/never -> 0
 *   app_events_30d / web_visits_30d: number of app events / web page views in the last 30 days (relative to config.today).
 */
import { config } from './config.js';
import { httpError } from './util.js';
import { normSource, normStatus } from './ingest.js';

export const ENGAGEMENT_FORMULA =
  'engagement = opens_recency_points + 2 × app_events_30d + web_visits_30d, where opens_recency_points is 10 if the last newsletter open ' +
  'was within 7 days, 5 if within 30 days, 2 if within 90 days, otherwise 0; app_events_30d and web_visits_30d count app events and ' +
  'website page views in the last 30 days.';

const MAX_DAYS = 3650;
const MAX_LIMIT = 100000;

export const SEGMENT_FIELDS = [
  { name: 'source', type: 'string[]', label: 'Acquisition source', description: 'Match any of these newsletter acquisition sources (lowercase, e.g. "instagram", "facebook", "tiktok", "organic"). Aliases like "IG" or "FB" are normalized automatically.', options: [] },
  { name: 'status', type: 'string[]', label: 'Subscription status', description: 'Match any of these subscriber statuses (lowercase), e.g. "active", "unsubscribed", "bounced".', options: [] },
  { name: 'is_subscriber', type: 'boolean', label: 'Is newsletter subscriber', description: 'true = only people on the newsletter list; false = only app-only / unknown people who are not on the list.' },
  { name: 'signup_after', type: 'date', label: 'Signed up on or after', description: 'Newsletter signup date on or after this day (inclusive, YYYY-MM-DD).' },
  { name: 'signup_before', type: 'date', label: 'Signed up on or before', description: 'Newsletter signup date on or before this day (inclusive, YYYY-MM-DD).' },
  { name: 'not_opened_in_days', type: 'integer', min: 0, max: MAX_DAYS, label: 'Not opened in N days', description: 'Has NOT opened a newsletter in the last N days (includes people who never opened). "Cold" subscribers are usually not_opened_in_days = 30.' },
  { name: 'opened_within_days', type: 'integer', min: 0, max: MAX_DAYS, label: 'Opened within N days', description: 'Opened a newsletter within the last N days.' },
  { name: 'has_app', type: 'boolean', label: 'Has app account', description: 'true = has at least one app account (app_users row); false = no app account.' },
  { name: 'app_events_min', type: 'integer', min: 0, max: 1000000, label: 'Min app events', description: 'At least this many app events. Combine with app_events_within_days and/or app_event_type to restrict what is counted.' },
  { name: 'app_events_within_days', type: 'integer', min: 0, max: MAX_DAYS, label: 'App events window (days)', description: 'Only count app events from the last N days (applies to app_events_min and the app_events column).' },
  { name: 'app_event_type', type: 'string', label: 'App event type', description: 'Only count app events of this type (e.g. "app_open", "read_story", "link_click", "login").', options: [] },
  { name: 'web_visits_min', type: 'integer', min: 0, max: 1000000, label: 'Min website visits', description: 'At least this many website page views (optionally within web_visits_within_days).' },
  { name: 'web_visits_within_days', type: 'integer', min: 0, max: MAX_DAYS, label: 'Website visits window (days)', description: 'Only count page views from the last N days (applies to web_visits_min and the web_visits column).' },
  { name: 'visited_page', type: 'string', label: 'Visited page containing', description: 'Has viewed at least one website page whose path contains this text (e.g. "/subscribe", "/articles/").' },
  { name: 'sort', type: 'enum', label: 'Sort by', description: `engagement_desc (default) | signup_desc (newest signups first) | last_open_desc (most recent openers first) | web_visits_desc (most website visits first; counts respect web_visits_within_days) | app_events_desc (most app events first; counts respect app_events_within_days/app_event_type). ${ENGAGEMENT_FORMULA}`, options: ['engagement_desc', 'signup_desc', 'last_open_desc', 'web_visits_desc', 'app_events_desc'] },
  { name: 'limit', type: 'integer', min: 1, max: MAX_LIMIT, label: 'Max rows', description: 'Maximum number of rows to return (the total count is always the full segment size).' },
];

const FIELD_BY_NAME = Object.fromEntries(SEGMENT_FIELDS.map((f) => [f.name, f]));

/** SEGMENT_FIELDS with enum-ish options populated from current data (sources, statuses, app event types). */
export function segmentFields(db) {
  const col = (sql) => db.prepare(sql).all().map((r) => r.v);
  const opts = {
    source: col(`SELECT source AS v FROM profiles WHERE source IS NOT NULL GROUP BY source ORDER BY COUNT(*) DESC LIMIT 50`),
    status: col(`SELECT status AS v FROM profiles WHERE status IS NOT NULL GROUP BY status ORDER BY COUNT(*) DESC LIMIT 50`),
    app_event_type: col(`SELECT event AS v FROM app_events GROUP BY event ORDER BY COUNT(*) DESC LIMIT 50`),
  };
  return SEGMENT_FIELDS.map((f) => (opts[f.name] ? { ...f, options: opts[f.name] } : { ...f }));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isYmd = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
};

/**
 * Validate + normalize. Lenient only where unambiguous (UI forms): null/"" = absent, a single string
 * for an array field becomes [string], "true"/"false" and integer strings are accepted.
 * Everything else that doesn't match the declared type -> 400.
 */
export function validateSpec(spec) {
  if (spec == null) return {};
  if (typeof spec !== 'object' || Array.isArray(spec)) throw httpError(400, 'Segment spec must be a JSON object');
  const out = {};
  const errors = [];
  for (const [key, raw] of Object.entries(spec)) {
    const f = FIELD_BY_NAME[key];
    if (!f) { errors.push(`unknown key "${key}"`); continue; }
    if (raw == null || raw === '') continue;
    let v = raw;
    switch (f.type) {
      case 'string[]': {
        if (typeof v === 'string') v = [v];
        if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) { errors.push(`${key} must be an array of strings`); break; }
        if (v.length > 100) { errors.push(`${key} has too many values`); break; }
        const norm = key === 'source' ? normSource : normStatus;
        const vals = [...new Set(v.map(norm).filter(Boolean))];
        if (vals.length) out[key] = vals;
        break;
      }
      case 'boolean':
        if (v === 'true') v = true; else if (v === 'false') v = false;
        if (typeof v !== 'boolean') { errors.push(`${key} must be true or false`); break; }
        out[key] = v;
        break;
      case 'date':
        if (!isYmd(v)) { errors.push(`${key} must be a date in YYYY-MM-DD format`); break; }
        out[key] = v;
        break;
      case 'integer':
        if (typeof v === 'string' && /^\d+$/.test(v.trim())) v = Number(v.trim());
        if (typeof v !== 'number' || !Number.isInteger(v) || v < f.min || v > f.max) {
          errors.push(`${key} must be an integer between ${f.min} and ${f.max}`); break;
        }
        out[key] = v;
        break;
      case 'string':
        if (typeof v !== 'string' || v.length > 200) { errors.push(`${key} must be a string (max 200 chars)`); break; }
        if (v.trim()) out[key] = key === 'visited_page' ? v.trim().toLowerCase() : v.trim();
        break;
      case 'enum':
        if (!f.options.includes(v)) { errors.push(`${key} must be one of: ${f.options.join(', ')}`); break; }
        out[key] = v;
        break;
    }
  }
  if (out.signup_after && out.signup_before && out.signup_after > out.signup_before) errors.push('signup_after is later than signup_before');
  if (errors.length) throw httpError(400, `Invalid segment spec: ${errors.join('; ')}`);
  return out;
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

/** ISO timestamp for the start of (today - n days). */
const cutoffTs = (n) => new Date(Date.parse(config.today + 'T00:00:00Z') - n * 86400000).toISOString();
const cutoffDate = (n) => cutoffTs(n).slice(0, 10);

/**
 * Build the segment query. Returns { sql, params } for the base CTE (one row per matching profile)
 * with computed columns; callers wrap it for COUNT / page.
 */
function buildQuery(s) {
  const params = [];
  const p = (v) => { params.push(v); return '?'; };

  // Filtered app-event count (respects app_events_within_days / app_event_type).
  const aeWhere = ['e.profile_id = pr.id'];
  if (s.app_events_within_days != null) aeWhere.push(`julianday(e.ts) >= julianday(${p(cutoffTs(s.app_events_within_days))})`);
  if (s.app_event_type) aeWhere.push(`e.event = ${p(s.app_event_type)}`);
  const wvWhere = ['w.profile_id = pr.id'];
  if (s.web_visits_within_days != null) wvWhere.push(`julianday(w.ts) >= julianday(${p(cutoffTs(s.web_visits_within_days))})`);

  const c30 = cutoffTs(30);
  const today = config.today;
  const base = `
    SELECT pr.id, pr.email, pr.source, pr.status, pr.signup_date, pr.last_open_date, pr.is_subscriber,
      EXISTS (SELECT 1 FROM app_users a WHERE a.profile_id = pr.id) AS has_app,
      (SELECT COUNT(*) FROM app_events e WHERE ${aeWhere.join(' AND ')}) AS app_events,
      (SELECT COUNT(*) FROM web_events w WHERE ${wvWhere.join(' AND ')}) AS web_visits,
      (CASE
         WHEN pr.last_open_date IS NULL THEN 0
         WHEN julianday(${p(today)}) - julianday(pr.last_open_date) <= 7 THEN 10
         WHEN julianday(${p(today)}) - julianday(pr.last_open_date) <= 30 THEN 5
         WHEN julianday(${p(today)}) - julianday(pr.last_open_date) <= 90 THEN 2
         ELSE 0 END)
       + 2 * (SELECT COUNT(*) FROM app_events e WHERE e.profile_id = pr.id AND julianday(e.ts) >= julianday(${p(c30)}))
       + (SELECT COUNT(*) FROM web_events w WHERE w.profile_id = pr.id AND julianday(w.ts) >= julianday(${p(c30)}))
       AS engagement
    FROM profiles pr`;

  const where = [];
  if (s.source?.length) where.push(`source IN (${s.source.map(p).join(', ')})`);
  if (s.status?.length) where.push(`status IN (${s.status.map(p).join(', ')})`);
  if (s.is_subscriber != null) where.push(`is_subscriber = ${p(s.is_subscriber ? 1 : 0)}`);
  if (s.signup_after) where.push(`signup_date >= ${p(s.signup_after)}`);
  if (s.signup_before) where.push(`signup_date <= ${p(s.signup_before)}`);
  if (s.not_opened_in_days != null) where.push(`(last_open_date IS NULL OR last_open_date < ${p(cutoffDate(s.not_opened_in_days))})`);
  if (s.opened_within_days != null) where.push(`last_open_date >= ${p(cutoffDate(s.opened_within_days))}`);
  if (s.has_app != null) where.push(`has_app = ${p(s.has_app ? 1 : 0)}`);
  if (s.app_events_min != null) where.push(`app_events >= ${p(s.app_events_min)}`);
  if (s.web_visits_min != null) where.push(`web_visits >= ${p(s.web_visits_min)}`);
  if (s.visited_page) {
    where.push(`EXISTS (SELECT 1 FROM web_events vw WHERE vw.profile_id = seg.id AND vw.page LIKE ${p(`%${likeEscape(s.visited_page)}%`)} ESCAPE '\\')`);
  }

  const order = {
    engagement_desc: 'engagement DESC, last_open_date DESC NULLS LAST, id',
    signup_desc: 'signup_date DESC NULLS LAST, id',
    last_open_desc: 'last_open_date DESC NULLS LAST, id',
    web_visits_desc: 'web_visits DESC, engagement DESC, id',
    app_events_desc: 'app_events DESC, engagement DESC, id',
  }[s.sort || 'engagement_desc'];

  const sql = `SELECT * FROM (${base}) AS seg ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
  return { sql, params, order };
}

export function runSegment(db, spec, { limit, offset = 0 } = {}) {
  const s = validateSpec(spec);
  const lim = Math.min(Math.max(Number(limit ?? s.limit ?? 100) || 100, 1), MAX_LIMIT);
  const off = Math.max(Number(offset) || 0, 0);
  const { sql, params, order } = buildQuery(s);
  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).get(...params).n);
  const rows = db.prepare(`${sql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, lim, off).map((r) => ({
    id: r.id,
    email: r.email,
    source: r.source,
    status: r.status,
    signup_date: r.signup_date,
    last_open_date: r.last_open_date,
    is_subscriber: !!r.is_subscriber,
    has_app: !!r.has_app,
    app_events: r.app_events,
    web_visits: r.web_visits,
    engagement: r.engagement,
  }));
  return { total, rows, spec: s };
}

