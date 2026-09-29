/**
 * PII-safe AI assistant.
 *
 * The model never gets SQL, raw rows, emails or ids. It only gets TOOLS whose results are
 * aggregates or pseudonymized rows, and every byte sent to it passes through the PII guard
 * (src/pii.js) and is logged verbatim in llm_audit. Real emails are joined back in server-side,
 * after the model is done, for the authenticated human only. See docs/PII.md.
 */
import express from 'express';
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { getDb } from './db.js';
import { pseudonym, normEmail, httpError } from './util.js';
import { runSegment, validateSpec, segmentFields } from './segments.js';
import {
  createRedactionContext, redactText, scanForPII, rehydrateText, sanitizePagePath, PII_PATTERNS,
} from './pii.js';

// ---------------------------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------------------------

/**
 * k-anonymity floor for aggregate groups. Groups smaller than this are folded into "(small groups)".
 * Default 1 = no suppression, so every number the Growth team sees is exact. Raise to 5+ if the
 * model / its logs should not be able to learn facts about groups of 1-4 people (see docs/PII.md).
 */
export const MIN_GROUP_SIZE = Number(process.env.ASSISTANT_MIN_GROUP_SIZE || 1);
export const MAX_ITERATIONS = 8;
export const PREVIEW_ROWS = 10;
export const UI_TABLE_ROWS = 200;
const MAX_HISTORY = 20;
const MAX_TEXT = 4000;
const MAX_HANDLES = 500;

/** Columns of a segment row that are safe to show the model (no email, no internal id). */
export const SAFE_SEGMENT_COLUMNS = [
  'source', 'status', 'signup_date', 'last_open_date', 'has_app', 'app_events', 'web_visits', 'engagement',
];

/** Keys inside model-produced content blocks that are opaque and must never be edited. */
const OPAQUE_KEYS = ['signature', 'thinking', 'data', 'id', 'tool_use_id'];

// ---------------------------------------------------------------------------------------------
// Dates (always relative to config.today, never the wall clock)
// ---------------------------------------------------------------------------------------------

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  return { start: iso(new Date(Date.UTC(y, m - 1, 1))), end: iso(new Date(Date.UTC(y, m, 0))) };
}
function previousMonth(today) {
  const d = new Date(today + 'T00:00:00Z');
  const p = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  return iso(p).slice(0, 7);
}
const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isYm = (s) => typeof s === 'string' && /^\d{4}-\d{2}$/.test(s);
const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
};

// ---------------------------------------------------------------------------------------------
// System prompt + tool definitions (static -> cacheable prefix)
// ---------------------------------------------------------------------------------------------

export function buildSystemPrompt(today = config.today) {
  const lastMonth = previousMonth(today);
  const lm = monthRange(lastMonth);
  return `You are the data assistant inside The Pour Over's customer data platform. The Pour Over (TPO) is a
newsletter that covers the news with a calm, faith-informed, fair-minded voice. You help non-technical
teammates on the Growth team understand their readers.

Voice: warm, clear, brief. Plain English, no jargon, no SQL. Lead with the answer (the number or the
list), then one or two sentences on how you got it. Use short bullet lists or a small markdown table when
it helps. Never lecture.

How you work:
- ALWAYS use the tools for any number, list or fact about readers. Never guess, estimate or invent
  numbers. If the tools cannot answer something, say so and suggest the closest thing they can answer.
- Start with describe_data if you are unsure which fields, sources, statuses or event types exist.
- Use count_segment for "how many" questions about people, build_segment when the teammate wants a
  list/audience, and aggregate for breakdowns (by source, page, event type, month).
- When you build a segment, explain its definition in plain English (e.g. "subscribers from Instagram who
  signed up in August 2026 and haven't opened an email in 30+ days"). The teammate will see the full list,
  with real emails and a CSV download, in the app underneath your answer. Mention the segment handle once.
- State the assumptions you made, briefly, in one line.

Definitions and dates:
- Today is ${today}. Do all date math relative to today, never your own sense of the date.
- "Last month" means the previous calendar month: ${lastMonth} (${lm.start} to ${lm.end}). "This month"
  means ${today.slice(0, 7)} up to today. "Recently" defaults to the last 30 days.
- "Cold" means has not opened a newsletter in 30 or more days (or has never opened). "Went cold last
  month" is ambiguous: default to the aggregate cold_by_source with basis "signed_up" for "signups that
  are now cold", and say which reading you used; offer the other reading ("went_cold") in one line.
- "Engaged" / "most engaged" means sort by the engagement score (recent opens + 2x app events in the last
  30 days + web visits in the last 30 days).
- "New subscribers" defaults to subscribers who signed up in the last 30 days.

Privacy (important):
- You never see emails, names or raw ids, by design. Readers appear as pseudonymous tokens like
  sub_1a2b3c4d5e6f. Identifiers the teammate typed are replaced with placeholders like [EMAIL_1].
- To look up one person, pass the placeholder or the sub_ token to lookup_profile_summary. Never ask the
  teammate to paste an email; never try to guess, reconstruct or output an email, name or id.
- Do not single out individuals unless the teammate asked about a specific person.`;
}

const SPEC_SCHEMA = {
  type: 'object',
  description: 'Segment definition. All keys optional; combine with AND.',
  additionalProperties: false,
  properties: {
    source: { type: 'array', items: { type: 'string' }, description: 'Acquisition source any-of, lowercase (see describe_data).' },
    status: { type: 'array', items: { type: 'string' }, description: 'Subscription status any-of, e.g. ["active"].' },
    is_subscriber: { type: 'boolean', description: 'true = on the newsletter list (vs app-only people).' },
    signup_after: { type: 'string', description: 'Inclusive YYYY-MM-DD.' },
    signup_before: { type: 'string', description: 'Inclusive YYYY-MM-DD.' },
    not_opened_in_days: { type: 'integer', description: 'Cold: last open is null or older than N days.' },
    opened_within_days: { type: 'integer', description: 'Opened a newsletter in the last N days.' },
    has_app: { type: 'boolean', description: 'Has a TPO app account.' },
    app_events_min: { type: 'integer', description: 'At least N app events (optionally within app_events_within_days).' },
    app_events_within_days: { type: 'integer' },
    app_event_type: { type: 'string', description: 'Restrict the app event count to one type, e.g. read_story.' },
    web_visits_min: { type: 'integer', description: 'At least N website page views (optionally within web_visits_within_days).' },
    web_visits_within_days: { type: 'integer' },
    visited_page: { type: 'string', description: 'Substring of a page path the person visited, e.g. "/subscribe".' },
    sort: { type: 'string', enum: ['engagement_desc', 'signup_desc', 'last_open_desc', 'web_visits_desc', 'app_events_desc'] },
    limit: { type: 'integer', description: 'Cap the segment size (e.g. top 100 most engaged).' },
  },
};

export const AGGREGATE_KINDS = {
  overview: 'Headline totals: profiles, subscribers, active, cold, app users, web and app event counts.',
  source_breakdown: 'Subscribers per acquisition source with active and cold counts. params: signup_after?, signup_before?, cold_days? (30).',
  cold_by_source: 'Cold readers per source for one month. params: month? (YYYY-MM, default last month), basis? ("signed_up" = signed up that month and are cold now [default]; "went_cold" = crossed the cold threshold during that month and have not opened since), cold_days? (30), source? [..].',
  first_pages: 'The first website page new subscribers viewed, ranked. params: signup_after?, signup_before? (default last 30 days), limit? (10).',
  page_popularity: 'Most viewed pages. params: within_days? (30; 0 = all time), limit? (20).',
  app_event_types: 'App events by type (app_open, read_story, ...). params: within_days? (30; 0 = all time).',
  signup_trend: 'New subscribers per month. params: months? (6), by_source? (false).',
  utm_breakdown: 'Website visits per utm_source. params: within_days? (30; 0 = all time).',
};

export const TOOLS = [
  {
    name: 'describe_data',
    description: 'Describe the data you can query: segment fields, allowed values for sources / statuses / app event types, common pages, definitions and today\'s date. Contains no personal data. Call this first when unsure.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'count_segment',
    description: 'Count the people matching a segment definition. Returns only {total}. Use for "how many" questions about people.',
    input_schema: { type: 'object', properties: { spec: SPEC_SCHEMA }, required: ['spec'], additionalProperties: false },
  },
  {
    name: 'build_segment',
    description: 'Build a segment (a list of people) the teammate can view and export. Returns a handle, the total, and a 10-row preview where each person is a pseudonymous token (no emails). The app shows the teammate the full list with real emails.',
    input_schema: {
      type: 'object',
      properties: { spec: SPEC_SCHEMA, name: { type: 'string', description: 'Short human-friendly name, e.g. "Most engaged readers".' } },
      required: ['spec'],
      additionalProperties: false,
    },
  },
  {
    name: 'aggregate',
    description: 'Run a pre-built aggregate report. Returns grouped counts only. Kinds: ' +
      Object.entries(AGGREGATE_KINDS).map(([k, v]) => `${k}: ${v}`).join(' | '),
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: Object.keys(AGGREGATE_KINDS) },
        params: { type: 'object', description: 'Kind-specific parameters (see description).' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
  },
  {
    name: 'lookup_profile_summary',
    description: 'Non-identifying summary of ONE person (source, status, dates, activity counts). ref must be a placeholder from the teammate\'s message like [EMAIL_1] / [USER_ID_1], or a reader token like sub_1a2b3c4d5e6f from a segment preview. Raw emails/ids are rejected.',
    input_schema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false },
  },
];

// ---------------------------------------------------------------------------------------------
// Assistant factory (client + db injectable for tests)
// ---------------------------------------------------------------------------------------------

const supportsAdaptiveThinking = (m) => /claude-(opus|sonnet|fable|mythos)-(5|4-[6-9])/.test(m);
const supportsDefaultFallbacks = (m) => /claude-(sonnet-5-5|opus-5-5|opus-5$|fable-5-1)/.test(m);

export function createAssistant({ client = null, db = getDb(), model = config.anthropicModel, today = config.today, fallbacks } = {}) {
  const handles = new Map();      // seg_xxxx -> { spec, name, total, created_at }
  const pseudoIndex = new Map();  // sub_xxxx -> profile id (only for tokens we have shown the model)
  const useFallbacks = fallbacks ?? (process.env.ASSISTANT_FALLBACKS !== 'off' && supportsDefaultFallbacks(model));

  // SQL helper: page paths are sanitized INSIDE SQLite so grouping happens on the safe value.
  try { db.function('safe_page', { deterministic: true }, (p) => sanitizePagePath(p)); } catch { /* already registered */ }

  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const get = (sql, ...p) => db.prepare(sql).get(...p);

  function readerToken(row) {
    const tok = row.email ? pseudonym(row.email, 'sub') : pseudonym(`profile:${row.id}`, 'sub');
    if (row.id != null) {
      pseudoIndex.set(tok, row.id);
      if (pseudoIndex.size > 50000) pseudoIndex.delete(pseudoIndex.keys().next().value);
    }
    return tok;
  }

  function safeRow(row) {
    const o = { reader: readerToken(row) };
    for (const c of SAFE_SEGMENT_COLUMNS) if (c in row) o[c] = row[c];
    return o;
  }

  function checkSpec(spec) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw httpError(400, 'spec must be an object');
    const r = validateSpec(spec);
    if (r && Array.isArray(r.errors) && r.errors.length) throw httpError(400, r.errors.join('; '));
    if (r && r.ok === false) throw httpError(400, r.error || 'invalid spec');
    return (r && typeof r === 'object' && !('ok' in r) && !('errors' in r)) ? r : spec;
  }

  /** Suppress small groups (k-anonymity) – rows with `countKey` < MIN_GROUP_SIZE are folded together. */
  function kAnon(rows, labelKey, countKey) {
    if (MIN_GROUP_SIZE <= 1) return rows;
    const keep = [], small = { [labelKey]: '(small groups)', [countKey]: 0, groups: 0 };
    for (const r of rows) (r[countKey] >= MIN_GROUP_SIZE ? keep.push(r) : (small[countKey] += r[countKey], small.groups++));
    if (small.groups) keep.push(small);
    return keep;
  }

  const coldCutoff = (days) => addDays(today, -days);

  // ---------------------------- aggregates (SQL owned here; aggregate-only) --------------------
  const aggregates = {
    overview() {
      const cut = coldCutoff(30);
      return {
        ...get(`SELECT COUNT(*) AS profiles,
                  COALESCE(SUM(is_subscriber = 1), 0) AS subscribers,
                  COALESCE(SUM(is_subscriber = 1 AND status = 'active'), 0) AS active_subscribers,
                  COALESCE(SUM(is_subscriber = 1 AND (last_open_date IS NULL OR last_open_date < ?)), 0) AS cold_subscribers_30d
                FROM profiles`, cut),
        app_users: get('SELECT COUNT(*) AS n FROM app_users').n,
        web_events: get('SELECT COUNT(*) AS n FROM web_events').n,
        web_events_linked_to_a_reader: get('SELECT COUNT(*) AS n FROM web_events WHERE profile_id IS NOT NULL').n,
        app_events: get('SELECT COUNT(*) AS n FROM app_events').n,
        today,
      };
    },

    source_breakdown(p = {}) {
      const cold_days = clampInt(p.cold_days, 1, 3650, 30);
      const where = ['is_subscriber = 1'], args = [coldCutoff(cold_days)];
      if (isYmd(p.signup_after)) { where.push('signup_date >= ?'); args.push(p.signup_after); }
      if (isYmd(p.signup_before)) { where.push('signup_date <= ?'); args.push(p.signup_before); }
      const rows = all(`SELECT COALESCE(source, '(unknown)') AS source, COUNT(*) AS subscribers,
                          SUM(status = 'active') AS active,
                          SUM(last_open_date IS NULL OR last_open_date < ?) AS cold
                        FROM profiles WHERE ${where.join(' AND ')}
                        GROUP BY 1 ORDER BY subscribers DESC`, ...args);
      return { cold_days, signup_after: p.signup_after ?? null, signup_before: p.signup_before ?? null,
        rows: kAnon(rows, 'source', 'subscribers') };
    },

    cold_by_source(p = {}) {
      const month = isYm(p.month) ? p.month : previousMonth(today);
      const basis = p.basis === 'went_cold' ? 'went_cold' : 'signed_up';
      const cold_days = clampInt(p.cold_days, 1, 3650, 30);
      const { start, end } = monthRange(month);
      const cut = coldCutoff(cold_days);
      const where = ['is_subscriber = 1'], args = [];
      let definition;
      if (basis === 'signed_up') {
        where.push('signup_date BETWEEN ? AND ?'); args.push(start, end);
        definition = `Subscribers who signed up between ${start} and ${end} and have not opened in ${cold_days}+ days as of ${today} (or never opened).`;
      } else {
        // crossed the threshold during the month: last open + cold_days falls inside the month, and still cold today
        where.push('last_open_date BETWEEN ? AND ?', 'last_open_date < ?');
        args.push(addDays(start, -cold_days), addDays(end, -cold_days), cut);
        definition = `Subscribers whose most recent open was between ${addDays(start, -cold_days)} and ${addDays(end, -cold_days)}, so they hit ${cold_days} days without opening during ${month}, and have not opened since.`;
      }
      if (Array.isArray(p.source) && p.source.length) {
        where.push(`source IN (${p.source.map(() => '?').join(',')})`); args.push(...p.source.map((s) => String(s).toLowerCase()));
      }
      const coldExpr = basis === 'signed_up' ? '(last_open_date IS NULL OR last_open_date < ?)' : '1';
      const rows = all(`SELECT COALESCE(source, '(unknown)') AS source,
                          SUM(${coldExpr}) AS cold, COUNT(*) AS cohort
                        FROM profiles WHERE ${where.join(' AND ')}
                        GROUP BY 1 ORDER BY cold DESC`, ...(basis === 'signed_up' ? [cut] : []), ...args)
        .map((r) => basis === 'signed_up'
          ? { source: r.source, cold: r.cold, signed_up: r.cohort, cold_rate: r.cohort ? +(r.cold / r.cohort).toFixed(3) : 0 }
          : { source: r.source, went_cold: r.cold });
      const countKey = basis === 'signed_up' ? 'cold' : 'went_cold';
      return { month, basis, cold_days, definition,
        total: rows.reduce((a, r) => a + r[countKey], 0), rows: kAnon(rows, 'source', countKey) };
    },

    first_pages(p = {}) {
      const signup_after = isYmd(p.signup_after) ? p.signup_after : addDays(today, -30);
      const signup_before = isYmd(p.signup_before) ? p.signup_before : today;
      const limit = clampInt(p.limit, 1, 50, 10);
      const cohort = get(`SELECT COUNT(*) AS n FROM profiles WHERE is_subscriber = 1 AND signup_date BETWEEN ? AND ?`,
        signup_after, signup_before).n;
      const rows = all(`WITH firsts AS (
                          SELECT we.profile_id, safe_page(we.page) AS page,
                                 ROW_NUMBER() OVER (PARTITION BY we.profile_id ORDER BY we.ts, we.id) AS rn
                          FROM web_events we JOIN profiles p ON p.id = we.profile_id
                          WHERE p.is_subscriber = 1 AND p.signup_date BETWEEN ? AND ? AND we.page IS NOT NULL)
                        SELECT page, COUNT(*) AS readers FROM firsts WHERE rn = 1
                        GROUP BY page ORDER BY readers DESC, page LIMIT ?`, signup_after, signup_before, limit);
      const withWeb = get(`SELECT COUNT(DISTINCT we.profile_id) AS n FROM web_events we JOIN profiles p ON p.id = we.profile_id
                           WHERE p.is_subscriber = 1 AND p.signup_date BETWEEN ? AND ?`, signup_after, signup_before).n;
      return {
        definition: `For each subscriber who signed up between ${signup_after} and ${signup_before}, the earliest website page they viewed (web visits stitched to readers by email and visitor id).`,
        new_subscribers: cohort, new_subscribers_with_web_visits: withWeb,
        rows: kAnon(rows, 'page', 'readers'),
      };
    },

    page_popularity(p = {}) {
      const within = clampInt(p.within_days, 0, 3650, 30);
      const limit = clampInt(p.limit, 1, 100, 20);
      const where = within ? 'WHERE ts >= ?' : '';
      const args = within ? [addDays(today, -within)] : [];
      const rows = all(`SELECT safe_page(page) AS page, COUNT(*) AS views,
                          COUNT(DISTINCT COALESCE('p' || profile_id, 'v' || visitor_id)) AS unique_visitors,
                          COUNT(DISTINCT profile_id) AS known_readers
                        FROM web_events ${where} GROUP BY 1 ORDER BY views DESC, page LIMIT ?`, ...args, limit);
      return { within_days: within || 'all time', rows: kAnon(rows, 'page', 'unique_visitors') };
    },

    app_event_types(p = {}) {
      const within = clampInt(p.within_days, 0, 3650, 30);
      const where = within ? 'WHERE ts >= ?' : '';
      const args = within ? [addDays(today, -within)] : [];
      const rows = all(`SELECT event, COUNT(*) AS events, COUNT(DISTINCT profile_id) AS readers
                        FROM app_events ${where} GROUP BY event ORDER BY events DESC`, ...args);
      return { within_days: within || 'all time', rows: kAnon(rows, 'event', 'readers') };
    },

    signup_trend(p = {}) {
      const months = clampInt(p.months, 1, 36, 6);
      const d = new Date(today + 'T00:00:00Z');
      const from = iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (months - 1), 1)));
      const bySource = !!p.by_source;
      const rows = all(`SELECT substr(signup_date, 1, 7) AS month, ${bySource ? "COALESCE(source, '(unknown)') AS source," : ''}
                          COUNT(*) AS signups
                        FROM profiles WHERE is_subscriber = 1 AND signup_date >= ? AND signup_date <= ?
                        GROUP BY month${bySource ? ', source' : ''} ORDER BY month${bySource ? ', signups DESC' : ''}`, from, today);
      return { from, to: today, rows: bySource ? kAnon(rows, 'source', 'signups') : rows };
    },

    utm_breakdown(p = {}) {
      const within = clampInt(p.within_days, 0, 3650, 30);
      const where = within ? 'WHERE ts >= ?' : '';
      const args = within ? [addDays(today, -within)] : [];
      const rows = all(`SELECT COALESCE(utm_source, '(none)') AS utm_source, COUNT(*) AS visits,
                          COUNT(DISTINCT COALESCE('p' || profile_id, 'v' || visitor_id)) AS visitors
                        FROM web_events ${where} GROUP BY 1 ORDER BY visits DESC LIMIT 50`, ...args);
      return { within_days: within || 'all time', rows: kAnon(rows, 'utm_source', 'visitors') };
    },
  };

  // ---------------------------- profile resolution ---------------------------------------------
  function resolveRef(ref, ctx) {
    ref = String(ref || '').trim();
    const ph = ctx?.map.get(ref);
    if (ph) {
      const type = ref.slice(1).replace(/_\d+\]$/, '');
      const tryEmail = () => get('SELECT id FROM profiles WHERE email = ?', normEmail(ph))?.id;
      const tryUser = () => get('SELECT profile_id AS id FROM app_users WHERE user_id = ?', ph)?.id;
      const tryVisitor = () => get('SELECT profile_id AS id FROM web_events WHERE visitor_id = ? AND profile_id IS NOT NULL LIMIT 1', ph)?.id;
      const tryDevice = () => get(`SELECT au.profile_id AS id FROM devices d JOIN app_users au ON au.user_id = d.user_id WHERE d.device_id = ?`, ph)?.id
        ?? get('SELECT profile_id AS id FROM app_events WHERE device_id = ? AND profile_id IS NOT NULL LIMIT 1', ph)?.id;
      const order = { EMAIL: [tryEmail], USER_ID: [tryUser], VISITOR_ID: [tryVisitor], DEVICE_ID: [tryDevice] }[type]
        || [tryUser, tryVisitor, tryDevice, tryEmail];
      for (const f of order) { const id = f(); if (id != null) return id; }
      return null;
    }
    if (/^sub_[0-9a-f]{12}$/.test(ref)) {
      if (pseudoIndex.has(ref)) return pseudoIndex.get(ref);
      // Fallback: recompute pseudonyms server-side (the model never sees the input to this).
      for (const r of db.prepare('SELECT id, email FROM profiles').iterate()) {
        if (readerToken(r) === ref) return r.id;
      }
      return null;
    }
    throw httpError(400, 'ref must be a placeholder such as [EMAIL_1] from the teammate\'s message or a reader token like sub_1a2b3c4d5e6f. Raw identifiers are not accepted.');
  }

  function profileSummary(id) {
    const p = get('SELECT id, email, is_subscriber, signup_date, status, source, last_open_date, origin FROM profiles WHERE id = ?', id);
    if (!p) return { found: false };
    const d30 = addDays(today, -30);
    const app = get(`SELECT COUNT(*) AS total, COALESCE(SUM(ts >= ?), 0) AS last_30d FROM app_events WHERE profile_id = ?`, d30, id);
    const web = get(`SELECT COUNT(*) AS total, COALESCE(SUM(ts >= ?), 0) AS last_30d, MIN(ts) AS first_visit, MAX(ts) AS last_visit FROM web_events WHERE profile_id = ?`, d30, id);
    return {
      found: true,
      reader: readerToken(p),
      is_subscriber: !!p.is_subscriber,
      source: p.source, status: p.status, signup_date: p.signup_date, last_open_date: p.last_open_date,
      cold_30d: !p.last_open_date || p.last_open_date < d30,
      has_app: !!get('SELECT 1 AS x FROM app_users WHERE profile_id = ? LIMIT 1', id),
      app_events: { total: app.total, last_30d: app.last_30d,
        by_type: all('SELECT event, COUNT(*) AS n FROM app_events WHERE profile_id = ? GROUP BY event ORDER BY n DESC', id) },
      web_visits: { total: web.total, last_30d: web.last_30d, first_visit: web.first_visit?.slice(0, 10) ?? null, last_visit: web.last_visit?.slice(0, 10) ?? null,
        top_pages: all('SELECT safe_page(page) AS page, COUNT(*) AS views FROM web_events WHERE profile_id = ? GROUP BY 1 ORDER BY views DESC LIMIT 5', id) },
    };
  }

  // ---------------------------- tool implementations -------------------------------------------
  const tools = {
    describe_data() {
      const lm = previousMonth(today);
      return {
        today,
        last_month: { month: lm, ...monthRange(lm) },
        definitions: {
          cold: 'No newsletter open in 30+ days (or never opened). Adjustable via not_opened_in_days / cold_days.',
          engagement: 'recent-open points + 2 x app events in last 30 days + web visits in last 30 days (higher = more engaged).',
          new_subscriber: 'Signed up in the last 30 days unless the teammate says otherwise.',
        },
        segment_fields: segmentFields(db),
        values: {
          sources: kAnon(all(`SELECT COALESCE(source, '(unknown)') AS value, COUNT(*) AS people FROM profiles WHERE is_subscriber = 1 GROUP BY 1 ORDER BY 2 DESC LIMIT 50`), 'value', 'people'),
          statuses: kAnon(all(`SELECT COALESCE(status, '(unknown)') AS value, COUNT(*) AS people FROM profiles GROUP BY 1 ORDER BY 2 DESC LIMIT 20`), 'value', 'people'),
          app_event_types: all(`SELECT event AS value, COUNT(*) AS events FROM app_events GROUP BY 1 ORDER BY 2 DESC LIMIT 20`),
          common_pages: all(`SELECT safe_page(page) AS value, COUNT(*) AS views FROM web_events GROUP BY 1 ORDER BY 2 DESC LIMIT 30`),
        },
        aggregate_kinds: AGGREGATE_KINDS,
        signup_date_range: get(`SELECT MIN(signup_date) AS first, MAX(signup_date) AS last FROM profiles WHERE is_subscriber = 1`),
      };
    },

    count_segment({ spec }) {
      const s = checkSpec(spec);
      const { total } = runSegment(db, s, { limit: 1, offset: 0 });
      return s.limit ? { total, capped_to_limit: Math.min(total, s.limit) } : { total };
    },

    build_segment({ spec, name }) {
      const s = checkSpec(spec);
      const { total: matching, rows } = runSegment(db, s, { limit: PREVIEW_ROWS, offset: 0 });
      const total = s.limit ? Math.min(matching, s.limit) : matching; // spec.limit = "top N"
      const handle = 'seg_' + crypto.randomBytes(4).toString('hex');
      handles.set(handle, { spec: s, name: name ? String(name).slice(0, 80) : null, total, created_at: new Date().toISOString() });
      if (handles.size > MAX_HANDLES) handles.delete(handles.keys().next().value);
      return {
        handle, name: name || null, total, ...(s.limit ? { matching_before_limit: matching } : {}),
        preview: rows.slice(0, PREVIEW_ROWS).map(safeRow),
        note: 'Emails are withheld from you by design. The teammate sees the full list with real emails and a CSV download in the app.',
      };
    },

    aggregate({ kind, params }) {
      const fn = aggregates[kind];
      if (!fn) throw httpError(400, `unknown aggregate kind "${kind}". Use one of: ${Object.keys(aggregates).join(', ')}`);
      return { kind, ...fn(params && typeof params === 'object' ? params : {}) };
    },

    lookup_profile_summary({ ref }, ctx) {
      const id = resolveRef(ref, ctx);
      if (id == null) return { found: false, ref: String(ref).slice(0, 40), note: 'No matching reader.' };
      return profileSummary(id);
    },
  };

  /**
   * Run one tool as the model would, returning exactly what the model will receive:
   * { content: <JSON string, PII-guarded>, is_error, findings, raw }.
   */
  function runTool(name, input, ctx = createRedactionContext()) {
    let raw, is_error = false;
    try {
      if (!tools[name]) throw httpError(400, `unknown tool ${name}`);
      raw = tools[name](input || {}, ctx);
    } catch (e) {
      is_error = true;
      raw = { error: e.expose ? e.message : 'Tool failed.' };
      if (!e.expose) console.error('[assistant] tool error', name, e);
    }
    const guarded = scanForPII(raw, { ctx });
    return { content: JSON.stringify(guarded.value), is_error, findings: guarded.count, raw };
  }

  // ---------------------------- audit log ------------------------------------------------------
  const insAudit = db.prepare('INSERT INTO llm_audit (direction, payload, pii_findings) VALUES (?, ?, ?)');
  const audit = (direction, payload, findings) => insAudit.run(direction, JSON.stringify(payload), findings);

  function auditReport(limit = 50) {
    const rows = all('SELECT id, created_at, direction, pii_findings, payload FROM llm_audit ORDER BY id DESC LIMIT ?', clampInt(limit, 1, 500, 50));
    const s = get(`SELECT COUNT(*) AS total_rows, COALESCE(SUM(direction = 'to_model'), 0) AS total_payloads,
                     COALESCE(SUM(direction = 'to_model' AND pii_findings > 0), 0) AS payloads_with_findings_before_redaction,
                     COALESCE(SUM(pii_findings), 0) AS total_findings_redacted
                   FROM llm_audit`);
    // Independent re-scan of what was actually stored as sent: this is the proof, not a constant.
    let emails = 0, otherIds = 0, scanned = 0;
    const emailRes = PII_PATTERNS.filter((p) => p.type === 'EMAIL').map((p) => p.re);
    for (const r of db.prepare(`SELECT payload FROM llm_audit WHERE direction = 'to_model' ORDER BY id DESC LIMIT 5000`).iterate()) {
      scanned++;
      for (const re of emailRes) emails += (r.payload.match(new RegExp(re.source, re.flags)) || []).length;
      otherIds += scanForPII(JSON.parse(r.payload), { skipKeys: OPAQUE_KEYS }).count;
    }
    return {
      summary: { ...s, payloads_rescanned: scanned, emails_seen_by_model: emails, identifiers_seen_by_model: otherIds - emails },
      rows: rows.map((r) => ({
        id: r.id, created_at: r.created_at, direction: r.direction, pii_findings: r.pii_findings,
        bytes: r.payload.length, payload: JSON.parse(r.payload),
      })),
    };
  }

  // ---------------------------- segment rehydration (human only) -------------------------------
  function segmentRows(handle, limit) {
    const h = handles.get(handle);
    if (!h) throw httpError(404, 'Unknown or expired segment handle');
    const cap = h.spec.limit ? Math.min(h.spec.limit, limit) : limit;
    const out = [];
    let total = h.total;
    for (let offset = 0; out.length < cap;) {
      const page = runSegment(db, h.spec, { limit: Math.min(1000, cap - out.length), offset });
      total = h.spec.limit ? Math.min(page.total, h.spec.limit) : page.total;
      out.push(...page.rows);
      if (page.rows.length === 0) break;
      offset += page.rows.length;
      if (offset >= page.total) break;
    }
    return { h, total, rows: out.slice(0, cap) };
  }

  function segmentTable(handle, limit = UI_TABLE_ROWS) {
    const { h, total, rows } = segmentRows(handle, limit);
    const columns = ['email', ...SAFE_SEGMENT_COLUMNS];
    return {
      segment: { handle, name: h.name, spec: h.spec, total, csv_url: `/api/assistant/segment/${handle}.csv` },
      table: { columns, rows: rows.map((r) => columns.map((c) => (c === 'email' ? (r.email ?? '(app-only, no email)') : r[c] ?? null))), truncated: total > rows.length },
    };
  }

  function segmentCsv(handle) {
    const { rows } = segmentRows(handle, 1_000_000);
    const columns = ['email', ...SAFE_SEGMENT_COLUMNS];
    const esc = (v) => {
      if (v == null) return '';
      let s = String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // spreadsheet formula injection
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
  }

  // ---------------------------- the tool-use loop ----------------------------------------------
  const system = [{ type: 'text', text: buildSystemPrompt(today), cache_control: { type: 'ephemeral' } }];

  function prepareHistory(history, ctx) {
    const out = [];
    let findings = 0;
    for (const m of (Array.isArray(history) ? history : []).slice(-MAX_HISTORY)) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content.trim()) continue;
      const r = redactText(m.content.slice(0, MAX_TEXT), ctx);
      findings += r.count;
      out.push({ role: m.role, content: r.text });
    }
    while (out.length && out[0].role !== 'user') out.shift();
    return { messages: out, findings };
  }

  /** Final guard over the whole request: redact user-side content; count-only for model-authored turns. */
  function guardRequest(body, ctx) {
    let count = scanForPII(body.system, { ctx }).count + scanForPII(body.tools, { ctx }).count;
    body.messages = body.messages.map((m) => {
      const r = scanForPII(m.content, { ctx, skipKeys: OPAQUE_KEYS });
      count += r.count;
      // Never edit the model's own earlier turns (thinking signatures / preserved-thinking checks);
      // they can only contain what we already sent, which was guarded.
      return m.role === 'assistant' ? m : { ...m, content: r.value };
    });
    return count;
  }

  async function ask({ message, history } = {}) {
    if (!client) throw httpError(503, 'The AI assistant is not configured: set ANTHROPIC_API_KEY on the server.');
    if (typeof message !== 'string' || !message.trim()) throw httpError(400, 'message is required');
    const ctx = createRedactionContext();
    const hist = prepareHistory(history, ctx);
    const q = redactText(message.slice(0, MAX_TEXT), ctx);
    const messages = [...hist.messages, { role: 'user', content: q.text }];
    let pending = hist.findings + q.count;
    const trace = [];
    const built = [];
    let lastAggregate = null;
    let finalText = '';
    let stop = null;
    let payloads = 0;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const body = {
        model, max_tokens: 16000, system, tools: TOOLS, messages,
        ...(supportsAdaptiveThinking(model) ? { thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } } : {}),
      };
      pending += guardRequest(body, ctx);
      audit('to_model', body, pending);
      payloads++;
      pending = 0;

      const response = useFallbacks
        ? await client.beta.messages.create({ ...body, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
        : await client.messages.create(body);
      audit('from_model', { id: response.id, model: response.model, stop_reason: response.stop_reason, content: response.content, usage: response.usage },
        scanForPII(response.content, { skipKeys: OPAQUE_KEYS }).count);

      stop = response.stop_reason;
      messages.push({ role: 'assistant', content: response.content });
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (text) finalText = text;

      if (stop === 'refusal') { finalText = "Sorry, I can't help with that one. Try rephrasing it as a question about reader counts, lists or trends."; break; }
      if (stop === 'pause_turn') continue;
      const uses = response.content.filter((b) => b.type === 'tool_use');
      if (stop !== 'tool_use' || !uses.length) break;

      const results = [];
      for (const u of uses) {
        const r = runTool(u.name, u.input, ctx);
        pending += r.findings;
        results.push({ type: 'tool_result', tool_use_id: u.id, content: r.content, ...(r.is_error ? { is_error: true } : {}) });
        trace.push({ tool: u.name, input: u.input, output_summary: r.content.length > 4000 ? r.content.slice(0, 4000) + '…' : r.content, is_error: r.is_error });
        if (!r.is_error && u.name === 'build_segment') built.push(r.raw.handle);
        if (!r.is_error && u.name === 'aggregate' && Array.isArray(r.raw.rows) && r.raw.rows.length) lastAggregate = r.raw;
      }
      messages.push({ role: 'user', content: results });
      if (i === MAX_ITERATIONS - 1) finalText ||= 'I needed more steps than I am allowed for that question. Could you narrow it down a little?';
    }

    const out = {
      // Placeholders the teammate typed ([EMAIL_1]) are swapped back for the human only.
      answer: rehydrateText(finalText || 'I could not produce an answer.', ctx),
      trace,
      privacy: { payloads_sent: payloads, identifiers_redacted_from_input: hist.findings + q.count },
    };
    const mentioned = [...(finalText.match(/seg_[0-9a-f]{8}/g) || [])].filter((h) => handles.has(h));
    const handle = mentioned.at(-1) || built.at(-1);
    if (handle) Object.assign(out, segmentTable(handle));
    else if (lastAggregate) {
      const columns = Object.keys(lastAggregate.rows[0]);
      out.table = { columns, rows: lastAggregate.rows.map((r) => columns.map((c) => r[c] ?? null)), title: lastAggregate.kind };
    }
    return out;
  }

  return { ask, runTool, tools, aggregates, auditReport, segmentTable, segmentCsv, handles, systemPrompt: system[0].text, get client() { return client; } };
}

// ---------------------------------------------------------------------------------------------
// Router (mounted at /api/assistant behind requireAuth)
// ---------------------------------------------------------------------------------------------

export function createAssistantRouter(getAssistant) {
  const r = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  r.post('/', wrap(async (req, res) => {
    const a = getAssistant();
    if (!a.client) return res.status(503).json({ error: 'The AI assistant is not configured yet. Ask an admin to set ANTHROPIC_API_KEY on the server; everything else in the CDP works without it.' });
    try {
      res.json(await a.ask({ message: req.body?.message, history: req.body?.history }));
    } catch (e) {
      if (e instanceof Anthropic.APIError) {
        console.error('[assistant] Anthropic API error', e.status, e.message);
        const status = e.status === 429 ? 429 : 502;
        return res.status(status).json({ error: status === 429 ? 'The assistant is busy, try again in a moment.' : 'The AI service had a problem. Please try again.' });
      }
      throw e;
    }
  }));

  r.get('/audit', (req, res) => res.json(getAssistant().auditReport(req.query.limit)));

  r.get('/segment/:handle.csv', (req, res) => {
    const csv = getAssistant().segmentCsv(req.params.handle);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.handle}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(csv);
  });

  r.get('/segment/:handle', (req, res) => res.json(getAssistant().segmentTable(req.params.handle, Number(req.query.limit) || UI_TABLE_ROWS)));

  return r;
}

let defaultAssistant;
function getDefaultAssistant() {
  if (!defaultAssistant) {
    defaultAssistant = createAssistant({
      db: getDb(),
      client: config.anthropicKey ? new Anthropic({ apiKey: config.anthropicKey }) : null,
    });
  }
  return defaultAssistant;
}

export const assistantRouter = createAssistantRouter(getDefaultAssistant);
