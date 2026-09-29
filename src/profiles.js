/**
 * Profile lookup (single-customer view).
 *   searchProfiles(db, q, limit=20) -> [{ id, email, source, status, is_subscriber, match }]
 *   getProfile(db, id)              -> { profile, app_users, web_events, app_events, timeline } | null
 */
import { config } from './config.js';

const EVENT_CAP = 500; // per-profile cap on returned events (keeps responses bounded)

const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

/**
 * q matches: numeric profile id (exact), user_id (exact), visitor_id (exact), email_hash pseudonym (exact),
 * or email substring (case-insensitive). Exact identifier matches are ranked first.
 * Empty q returns the most recently created profiles.
 */
export function searchProfiles(db, q, limit = 20) {
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 200);
  const s = String(q ?? '').trim();
  if (!s) {
    return db.prepare(`SELECT id, email, source, status, is_subscriber FROM profiles ORDER BY id DESC LIMIT ?`).all(lim).map(plain);
  }
  const idNum = /^\d+$/.test(s) ? Number(s) : -1;
  const lower = s.toLowerCase();
  const rows = db.prepare(`
    SELECT id, email, source, status, is_subscriber,
      CASE
        WHEN id = :id THEN 'id'
        WHEN id IN (SELECT profile_id FROM app_users WHERE user_id = :raw) THEN 'user_id'
        WHEN id IN (SELECT profile_id FROM web_events WHERE visitor_id = :raw) THEN 'visitor_id'
        WHEN email_hash = :raw THEN 'email_hash'
        WHEN email = :lower THEN 'email'
        ELSE 'email_substring'
      END AS match
    FROM profiles
    WHERE id = :id
       OR email LIKE :like ESCAPE '\\'
       OR email_hash = :raw
       OR id IN (SELECT profile_id FROM app_users WHERE user_id = :raw)
       OR id IN (SELECT profile_id FROM web_events WHERE visitor_id = :raw AND profile_id IS NOT NULL)
    ORDER BY CASE WHEN email = :lower OR id = :id OR email_hash = :raw THEN 0
                  WHEN email LIKE :prefix ESCAPE '\\' THEN 1 ELSE 2 END,
             email IS NULL, email, id
    LIMIT :lim`).all({ id: idNum, raw: s, lower, like: `%${likeEscape(lower)}%`, prefix: `${likeEscape(lower)}%`, lim });
  return rows.map(plain);
}

const plain = (r) => ({ ...r });

const daysBetween = (fromYmd, toYmd) =>
  Math.round((Date.parse(toYmd + 'T00:00:00Z') - Date.parse(fromYmd + 'T00:00:00Z')) / 86400000);

function parseProps(p) {
  if (p == null) return null;
  try { return JSON.parse(p); } catch { return p; }
}

export function getProfile(db, id) {
  const pid = Number(id);
  if (!Number.isInteger(pid)) return null;
  const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(pid);
  if (!profile) return null;

  const app_users = db.prepare('SELECT user_id, email, created_date, origin FROM app_users WHERE profile_id = ? ORDER BY user_id').all(pid).map(plain);
  const web_events = db.prepare(`SELECT id, visitor_id, page, ts, utm_source, email FROM web_events WHERE profile_id = ?
    ORDER BY ts IS NULL, ts DESC, id DESC LIMIT ?`).all(pid, EVENT_CAP).map(plain);
  const app_events = db.prepare(`SELECT event_id, event, user_id, device_id, ts, properties, received_at, resolved_user_id
    FROM app_events WHERE profile_id = ? ORDER BY ts DESC, received_at DESC LIMIT ?`).all(pid, EVENT_CAP)
    .map((r) => ({ ...r, properties: parseProps(r.properties) }));

  const counts = {
    web_events: Number(db.prepare('SELECT COUNT(*) AS n FROM web_events WHERE profile_id = ?').get(pid).n),
    app_events: Number(db.prepare('SELECT COUNT(*) AS n FROM app_events WHERE profile_id = ?').get(pid).n),
    web_visitors: Number(db.prepare('SELECT COUNT(DISTINCT visitor_id) AS n FROM web_events WHERE profile_id = ?').get(pid).n),
  };
  const first = db.prepare(`SELECT page, ts FROM web_events WHERE profile_id = ? AND ts IS NOT NULL ORDER BY ts, id LIMIT 1`).get(pid);

  const derived = {
    days_since_open: profile.last_open_date ? daysBetween(profile.last_open_date, config.today) : null,
    days_since_signup: profile.signup_date ? daysBetween(profile.signup_date, config.today) : null,
    first_page_visited: first?.page ?? null,
    first_web_visit_at: first?.ts ?? null,
    has_app: app_users.length > 0,
    counts,
  };

  // Merged, newest-first timeline across all sources.
  const timeline = [];
  if (profile.signup_date) timeline.push({ ts: profile.signup_date + 'T00:00:00.000Z', channel: 'newsletter', type: 'signup', label: `Subscribed${profile.source ? ` via ${profile.source}` : ''}` });
  if (profile.last_open_date) timeline.push({ ts: profile.last_open_date + 'T00:00:00.000Z', channel: 'newsletter', type: 'last_open', label: 'Last newsletter open' });
  for (const u of app_users) if (u.created_date) timeline.push({ ts: u.created_date + 'T00:00:00.000Z', channel: 'app', type: 'app_account_created', label: `App account created (${u.user_id})` });
  for (const w of web_events) if (w.ts) timeline.push({ ts: w.ts, channel: 'web', type: 'page_view', label: `Viewed ${w.page ?? '(unknown page)'}`, detail: { page: w.page, utm_source: w.utm_source, visitor_id: w.visitor_id } });
  for (const e of app_events) timeline.push({ ts: e.ts, channel: 'app', type: e.event, label: appLabel(e), detail: { event_id: e.event_id, device_id: e.device_id, properties: e.properties } });
  timeline.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

  return { profile: { ...profile, ...derived }, app_users, web_events, app_events, timeline };
}

function appLabel(e) {
  const p = e.properties && typeof e.properties === 'object' ? e.properties : {};
  const what = p.story_title || p.title || p.story_id || p.url || p.screen || null;
  const names = { app_open: 'Opened the app', read_story: 'Read a story', link_click: 'Clicked a link', login: 'Logged in' };
  return `${names[e.event] || e.event}${what ? `: ${what}` : ''}`;
}
