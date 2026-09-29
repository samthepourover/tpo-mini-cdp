/**
 * Aggregate statistics. Every function returns plain JSON with counts / categories only — no emails or
 * other identifiers — so the AI assistant can use them as tools without exposing PII.
 *
 *   overview(db)
 *   sourceStats(db, { coldDays = 30 })
 *   pageStats(db, { newSubscribersDays = 30, limit = 20 })
 *   coldBySource(db, { month = <previous month>, coldDays = 30 })
 *
 * "Cold" = an active subscriber whose last newsletter open is older than coldDays days before today
 * (or who has never opened).
 */
import { config } from './config.js';
import { httpError } from './util.js';

const n = (db, sql, ...params) => Number(db.prepare(sql).get(...params)?.n ?? 0);
const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : 0);
const cutoffDate = (days) => new Date(Date.parse(config.today + 'T00:00:00Z') - days * 86400000).toISOString().slice(0, 10);
const intIn = (v, def, lo, hi) => {
  const x = v == null || v === '' ? def : Number(v);
  if (!Number.isInteger(x) || x < lo || x > hi) throw httpError(400, `Expected an integer between ${lo} and ${hi}`);
  return x;
};

export function overview(db) {
  const webEvents = n(db, 'SELECT COUNT(*) AS n FROM web_events');
  const webLinked = n(db, 'SELECT COUNT(*) AS n FROM web_events WHERE profile_id IS NOT NULL');
  const appEvents = n(db, 'SELECT COUNT(*) AS n FROM app_events');
  const appEventsLinked = n(db, 'SELECT COUNT(*) AS n FROM app_events WHERE profile_id IS NOT NULL');
  const subscribers = n(db, 'SELECT COUNT(*) AS n FROM profiles WHERE is_subscriber = 1');
  const lastImports = {};
  for (const r of db.prepare(`SELECT kind, MAX(created_at) AS at, COUNT(*) AS c FROM imports GROUP BY kind`).all()) {
    lastImports[r.kind] = { last_at: r.at, count: Number(r.c) };
  }
  return {
    today: config.today,
    profiles: n(db, 'SELECT COUNT(*) AS n FROM profiles'),
    subscribers,
    active_subscribers: n(db, `SELECT COUNT(*) AS n FROM profiles WHERE is_subscriber = 1 AND status = 'active'`),
    unsubscribed: n(db, `SELECT COUNT(*) AS n FROM profiles WHERE is_subscriber = 1 AND status = 'unsubscribed'`),
    bounced: n(db, `SELECT COUNT(*) AS n FROM profiles WHERE is_subscriber = 1 AND status = 'bounced'`),
    cold_30d: n(db, `SELECT COUNT(*) AS n FROM profiles WHERE is_subscriber = 1 AND status = 'active'
                     AND (last_open_date IS NULL OR last_open_date < ?)`, cutoffDate(30)),
    duplicates_merged: n(db, 'SELECT COALESCE(SUM(duplicate_count), 0) AS n FROM profiles'),
    profiles_with_duplicates: n(db, 'SELECT COUNT(*) AS n FROM profiles WHERE duplicate_count > 0'),
    web_events: webEvents,
    web_linked: webLinked,
    web_linked_pct: pct(webLinked, webEvents),
    web_visitors: n(db, 'SELECT COUNT(DISTINCT visitor_id) AS n FROM web_events'),
    web_visitors_linked: n(db, 'SELECT COUNT(DISTINCT visitor_id) AS n FROM web_events WHERE profile_id IS NOT NULL'),
    subscribers_with_web: n(db, `SELECT COUNT(DISTINCT w.profile_id) AS n FROM web_events w JOIN profiles p ON p.id = w.profile_id WHERE p.is_subscriber = 1`),
    app_users: n(db, 'SELECT COUNT(*) AS n FROM app_users'),
    app_users_subscribed: n(db, `SELECT COUNT(*) AS n FROM app_users a JOIN profiles p ON p.id = a.profile_id WHERE p.is_subscriber = 1`),
    app_only_profiles: n(db, `SELECT COUNT(*) AS n FROM profiles WHERE is_subscriber = 0`),
    webhook_profiles: n(db, `SELECT COUNT(*) AS n FROM profiles WHERE origin = 'webhook'`),
    app_events: appEvents,
    app_events_linked: appEventsLinked,
    app_events_linked_pct: pct(appEventsLinked, appEvents),
    imports: lastImports,
  };
}

/** Per acquisition source: subscribers, active, cold, with app, share. */
export function sourceStats(db, { coldDays = 30 } = {}) {
  const cd = intIn(coldDays, 30, 0, 3650);
  const rows = db.prepare(`
    SELECT COALESCE(p.source, '(unknown)') AS source,
      COUNT(*) AS subscribers,
      SUM(p.status = 'active') AS active,
      SUM(p.status = 'active' AND (p.last_open_date IS NULL OR p.last_open_date < ?)) AS cold,
      SUM(p.status = 'unsubscribed') AS unsubscribed,
      SUM(EXISTS (SELECT 1 FROM app_users a WHERE a.profile_id = p.id)) AS with_app,
      SUM(EXISTS (SELECT 1 FROM web_events w WHERE w.profile_id = p.id)) AS with_web
    FROM profiles p WHERE p.is_subscriber = 1
    GROUP BY 1 ORDER BY subscribers DESC`).all(cutoffDate(cd));
  const total = rows.reduce((s, r) => s + Number(r.subscribers), 0);
  return {
    today: config.today,
    cold_definition: `active subscriber with no newsletter open in the last ${cd} days (or never opened)`,
    total_subscribers: total,
    sources: rows.map((r) => ({
      source: r.source,
      subscribers: Number(r.subscribers),
      share_pct: pct(Number(r.subscribers), total),
      active: Number(r.active),
      cold: Number(r.cold),
      cold_pct_of_active: pct(Number(r.cold), Number(r.active)),
      unsubscribed: Number(r.unsubscribed),
      with_app: Number(r.with_app),
      with_web: Number(r.with_web),
    })),
  };
}

/**
 * Page stats: top pages overall, plus the FIRST page viewed by each recently-signed-up subscriber
 * (earliest web event of each linked profile with signup_date within newSubscribersDays of today).
 */
export function pageStats(db, { newSubscribersDays = 30, limit = 20 } = {}) {
  const days = intIn(newSubscribersDays, 30, 0, 3650);
  const lim = intIn(limit, 20, 1, 200);
  const since = cutoffDate(days);
  const top = db.prepare(`SELECT page, COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors
    FROM web_events WHERE page IS NOT NULL GROUP BY page ORDER BY views DESC, page LIMIT ?`).all(lim);
  const newSubs = n(db, `SELECT COUNT(*) AS n FROM profiles WHERE is_subscriber = 1 AND signup_date >= ? AND signup_date <= ?`, since, config.today);
  const first = db.prepare(`
    WITH firsts AS (
      SELECT w.profile_id, w.page,
             ROW_NUMBER() OVER (PARTITION BY w.profile_id ORDER BY w.ts, w.id) AS rn
      FROM web_events w JOIN profiles p ON p.id = w.profile_id
      WHERE p.is_subscriber = 1 AND p.signup_date >= ? AND p.signup_date <= ? AND w.ts IS NOT NULL
    )
    SELECT page, COUNT(*) AS subscribers FROM firsts WHERE rn = 1
    GROUP BY page ORDER BY subscribers DESC, page LIMIT ?`).all(since, config.today, lim);
  const withWeb = first.reduce((s, r) => s + Number(r.subscribers), 0);
  // exact total (the LIMIT above may truncate the list)
  const withWebTotal = n(db, `SELECT COUNT(DISTINCT w.profile_id) AS n FROM web_events w JOIN profiles p ON p.id = w.profile_id
    WHERE p.is_subscriber = 1 AND p.signup_date >= ? AND p.signup_date <= ? AND w.ts IS NOT NULL`, since, config.today);
  return {
    today: config.today,
    top_pages: top.map((r) => ({ page: r.page, views: Number(r.views), visitors: Number(r.visitors) })),
    new_subscribers: {
      window_days: days,
      signup_from: since,
      signup_to: config.today,
      count: newSubs,
      with_web_activity: withWebTotal,
      first_page: first.map((r) => ({ page: r.page, subscribers: Number(r.subscribers), share_pct: pct(Number(r.subscribers), withWebTotal || withWeb) })),
    },
  };
}

/** Month string 'YYYY-MM' for the month before today. */
const previousMonth = () => {
  const d = new Date(config.today + 'T00:00:00Z');
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};

/**
 * For subscribers who signed up in `month` (YYYY-MM): per source, how many signed up and how many are now
 * cold (no open in coldDays, or never opened). Only currently-active subscribers count as "cold";
 * unsubscribed/bounced are reported separately.
 */
export function coldBySource(db, { month, coldDays = 30 } = {}) {
  const m = month || previousMonth();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw httpError(400, 'month must be YYYY-MM');
  const cd = intIn(coldDays, 30, 0, 3650);
  const start = `${m}-01`;
  const endD = new Date(start + 'T00:00:00Z'); endD.setUTCMonth(endD.getUTCMonth() + 1); endD.setUTCDate(0);
  const end = endD.toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT COALESCE(source, '(unknown)') AS source,
      COUNT(*) AS signups,
      SUM(status = 'active') AS active,
      SUM(status = 'active' AND (last_open_date IS NULL OR last_open_date < ?)) AS cold,
      SUM(status IN ('unsubscribed', 'bounced')) AS lost
    FROM profiles WHERE is_subscriber = 1 AND signup_date >= ? AND signup_date <= ?
    GROUP BY 1 ORDER BY cold DESC, signups DESC`).all(cutoffDate(cd), start, end);
  return {
    today: config.today,
    month: m,
    signup_from: start,
    signup_to: end,
    cold_definition: `active subscriber with no newsletter open in the last ${cd} days (or never opened)`,
    sources: rows.map((r) => ({
      source: r.source,
      signups: Number(r.signups),
      active: Number(r.active),
      cold: Number(r.cold),
      cold_pct_of_signups: pct(Number(r.cold), Number(r.signups)),
      unsubscribed_or_bounced: Number(r.lost),
    })),
  };
}
