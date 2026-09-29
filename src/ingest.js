/**
 * CSV ingestion + identity resolution.
 *
 *   detectColumns(kind, headers)            -> { field: originalHeader }   (throws 400 if required missing)
 *   ingestCsv(db, kind, buffer, filename, { relink = true }) -> data-quality report (counts only, no PII)
 *   relinkAll(db)                           -> linking counts
 *
 * Import semantics (all idempotent — re-importing the same file changes nothing):
 *   subscribers : upsert by normalized email. The file is treated as the authoritative snapshot
 *                 for the emails it contains (fields are overwritten, not merged with older imports,
 *                 so a re-subscribe in a newer export is honoured). Profiles absent from the file
 *                 are left untouched.
 *   web_events  : the file REPLACES the whole web_events table (an events export is a full log).
 *   app_users   : upsert by user_id.
 * relinkAll() runs after each import so the final state does not depend on import order.
 */
import { parse } from 'csv-parse/sync';
import { normEmail, normDate, normTimestamp, normCat, pseudonym, httpError } from './util.js';
import { config } from './config.js';

export const KINDS = ['subscribers', 'web_events', 'app_users'];

// ---------------------------------------------------------------------------
// Header auto-detection
// ---------------------------------------------------------------------------

/**
 * Synonyms are compared against headers normalized with normHeader() (lowercase, alnum only).
 * Earlier synonyms score higher. Order of fields matters only for tie-breaks.
 */
const FIELD_SYNONYMS = {
  subscribers: {
    email: { required: true, syn: ['email', 'emailaddress', 'subscriberemail', 'useremail', 'mail', 'emailaddr', 'contactemail'] },
    signup_date: { syn: ['signupdate', 'signedup', 'signedupat', 'signupat', 'signup', 'subscribedat', 'subscribedate', 'datesubscribed',
      'subscriptiondate', 'subscribed', 'optindate', 'joindate', 'joined', 'joinedat', 'createdat', 'created', 'datecreated', 'dateadded', 'added'] },
    status: { syn: ['status', 'subscriptionstatus', 'subscriberstatus', 'emailstatus', 'state'] },
    source: { syn: ['acquisitionsource', 'source', 'signupsource', 'acquisitionchannel', 'channel', 'leadsource', 'utmsource', 'referrer', 'origin', 'medium'] },
    last_open_date: { syn: ['lastopendate', 'lastopen', 'lastopened', 'lastopenedat', 'lastopenedon', 'lastemailopen', 'lastopenat',
      'dateoflastopen', 'lastengaged', 'lastactivity'] },
  },
  web_events: {
    visitor_id: { required: true, syn: ['visitorid', 'visitor', 'anonymousid', 'anonid', 'cookieid', 'clientid', 'browserid', 'deviceid', 'sessionid', 'vid'] },
    page: { required: true, syn: ['page', 'pageurl', 'pagepath', 'path', 'url', 'pageview', 'pagevisited', 'landingpage', 'uri'] },
    ts: { required: true, syn: ['timestamp', 'ts', 'eventtime', 'eventtimestamp', 'time', 'datetime', 'occurredat', 'viewedat', 'visitedat',
      'createdat', 'date', 'eventdate'] },
    utm_source: { syn: ['utmsource', 'source', 'trafficsource', 'referrersource', 'utm', 'campaignsource', 'referrer'] },
    email: { syn: ['email', 'capturedemail', 'emailaddress', 'emailcaptured', 'signupemail', 'useremail', 'mail'] },
  },
  app_users: {
    user_id: { required: true, syn: ['userid', 'appuserid', 'uid', 'user', 'accountid', 'id', 'memberid'] },
    email: { required: true, syn: ['email', 'emailaddress', 'useremail', 'mail', 'accountemail'] },
    created_date: { syn: ['createddate', 'createdat', 'created', 'accountcreated', 'accountcreatedat', 'datecreated', 'signupdate', 'signedup',
      'registeredat', 'registered', 'registrationdate', 'joined', 'joindate', 'installdate'] },
  },
};

const normHeader = (h) => String(h ?? '').replace(/^﻿/, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Map canonical fields -> original header text.
 * Scoring: exact normalized match beats "header contains synonym" (synonyms >= 4 chars only),
 * earlier synonyms beat later ones. Pairs are assigned greedily by score so each header is used once.
 */
export function detectColumns(kind, headers) {
  const spec = FIELD_SYNONYMS[kind];
  if (!spec) throw httpError(400, `Unknown import kind "${kind}". Expected one of: ${KINDS.join(', ')}`);
  const normed = headers.map(normHeader);
  const pairs = [];
  for (const [field, { syn }] of Object.entries(spec)) {
    normed.forEach((h, idx) => {
      if (!h) return;
      syn.forEach((s, rank) => {
        if (h === s) pairs.push({ field, idx, score: 1000 - rank });
        else if (s.length >= 4 && h.includes(s)) pairs.push({ field, idx, score: 500 - rank - (h.length - s.length) });
      });
    });
  }
  pairs.sort((a, b) => b.score - a.score || a.idx - b.idx);
  const mapping = {};
  const usedIdx = new Set();
  for (const p of pairs) {
    if (p.field in mapping || usedIdx.has(p.idx)) continue;
    mapping[p.field] = headers[p.idx];
    usedIdx.add(p.idx);
  }
  const missing = Object.entries(spec).filter(([f, s]) => s.required && !(f in mapping)).map(([f]) => f);
  if (missing.length) {
    throw httpError(400, `Could not find required column(s) for ${kind}: ${missing.join(', ')}. ` +
      `Headers seen: ${headers.map((h) => JSON.stringify(String(h))).join(', ') || '(none)'}`);
  }
  return mapping;
}

// ---------------------------------------------------------------------------
// Value normalization
// ---------------------------------------------------------------------------

/**
 * Acquisition-source aliases. Deliberately modest: only unambiguous abbreviations / spellings.
 * Anything not listed is kept as its lowercased, whitespace-collapsed self (so nothing is lost).
 */
export const SOURCE_ALIASES = {
  ig: 'instagram', insta: 'instagram', 'instagram ads': 'instagram', 'instagram.com': 'instagram',
  fb: 'facebook', 'facebook ads': 'facebook', 'facebook.com': 'facebook',
  'tik tok': 'tiktok', tt: 'tiktok', 'tiktok.com': 'tiktok',
  x: 'twitter', 'twitter.com': 'twitter', 'x.com': 'twitter',
  'organic search': 'organic', seo: 'organic',
  'google.com': 'google', 'google search': 'google',
  referal: 'referral', 'word of mouth': 'referral',
};

/** Status aliases -> active | unsubscribed | bounced (others kept as-is, lowercased). */
export const STATUS_ALIASES = {
  subscribed: 'active', subscriber: 'active', confirmed: 'active', opted_in: 'active', 'opted in': 'active',
  unsub: 'unsubscribed', unsubscribe: 'unsubscribed', 'opted out': 'unsubscribed', opted_out: 'unsubscribed', optout: 'unsubscribed',
  bounce: 'bounced', 'hard bounce': 'bounced', hard_bounce: 'bounced', cleaned: 'bounced', invalid: 'bounced',
};

const collapse = (s) => s.replace(/\s+/g, ' ');

export function normSource(v) {
  const c = normCat(v);
  if (!c) return null;
  const s = collapse(c);
  return SOURCE_ALIASES[s] || s;
}

export function normStatus(v) {
  const c = normCat(v);
  if (!c) return null;
  const s = collapse(c);
  return STATUS_ALIASES[s] || s;
}

/** Page URL -> lowercased path, no host/query/hash, no trailing slash (except "/"). */
export function normPage(v) {
  if (v == null) return null;
  let s = String(v).trim();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, ''); // strip scheme + host
  s = s.split(/[?#]/)[0];
  if (!s.startsWith('/')) s = '/' + s;
  s = s.toLowerCase().replace(/\/{2,}/g, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s || '/';
}

/** Date cell -> { value, bad } where bad=true means "non-blank but unparseable". */
function parseDateCell(v, fn) {
  if (v == null || String(v).trim() === '') return { value: null, bad: false };
  const out = fn(v);
  // normCat() returns null for "n/a", "never", etc. — treat those explicit placeholders as blank.
  const placeholder = /^(null|none|n\/?a|na|-|nan|undefined|never|tbd|unknown)$/i.test(String(v).trim());
  return { value: out, bad: out == null && !placeholder };
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

function detectDelimiter(text) {
  const first = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const counts = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  let inQ = false;
  for (const ch of first) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch in counts) counts[ch]++;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ',';
}

/** Returns { headers, records } where records are arrays of trimmed strings. */
export function parseCsvBuffer(buffer) {
  let text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer ?? '');
  text = text.replace(/^﻿/, '');
  if (!text.trim()) throw httpError(400, 'The uploaded file is empty');
  let rows;
  try {
    rows = parse(text, {
      delimiter: detectDelimiter(text),
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    });
  } catch (e) {
    throw httpError(400, `Could not parse CSV: ${e.message}`);
  }
  const hIdx = rows.findIndex((r) => r.some((c) => c !== ''));
  if (hIdx < 0) throw httpError(400, 'The uploaded file has no header row');
  return { headers: rows[hIdx], records: rows.slice(hIdx + 1) };
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

function tx(db, fn) {
  if (db.isTransaction) return fn(); // already inside a caller's transaction
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

const bump = (obj, key) => { obj[key] = (obj[key] || 0) + 1; };

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/**
 * Parse, clean, dedupe and load one CSV. Returns a counts-only data-quality report
 * (never contains emails or other row values besides normalized category labels).
 */
export function ingestCsv(db, kind, buffer, filename = null, { relink = true } = {}) {
  if (!KINDS.includes(kind)) throw httpError(400, `Unknown import kind "${kind}". Expected one of: ${KINDS.join(', ')}`);
  const { headers, records } = parseCsvBuffer(buffer);
  const mapping = detectColumns(kind, headers);
  const idx = Object.fromEntries(Object.entries(mapping).map(([f, h]) => [f, headers.indexOf(h)]));
  const get = (rec, f) => (idx[f] == null || idx[f] < 0 ? null : (rec[idx[f]] ?? null));

  const report = {
    kind,
    filename: filename ? String(filename).slice(0, 200) : null,
    rows_in: records.length,
    rows_loaded: 0,
    blank_rows: 0,
    invalid_emails: 0,
    missing_required: 0,
    duplicates_merged: 0,
    unparseable_dates: {},
    future_dates: 0,
    column_mapping: mapping,
    unmapped_headers: headers.filter((h) => h !== '' && !Object.values(mapping).includes(h)),
    inserted: 0,
    updated: 0,
    warnings: [],
  };

  const nonBlank = records.filter((r) => {
    if (r.every((c) => c === '')) { report.blank_rows++; return false; }
    return true;
  });

  const fn = { subscribers: ingestSubscribers, web_events: ingestWebEvents, app_users: ingestAppUsers }[kind];
  tx(db, () => {
    fn(db, nonBlank, get, report);
    // Drop empty sub-objects for readability
    if (!Object.keys(report.unparseable_dates).length) report.unparseable_dates = {};
    db.prepare('INSERT INTO imports (kind, filename, rows_in, rows_loaded, report) VALUES (?, ?, ?, ?, ?)')
      .run(kind, report.filename, report.rows_in, report.rows_loaded, JSON.stringify(report));
    report.import_id = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
  });

  if (relink) {
    report.linking = relinkAll(db);
    db.prepare('UPDATE imports SET report = ? WHERE id = ?').run(JSON.stringify(report), report.import_id);
  }
  return report;
}

const STATUS_RANK = { unsubscribed: 4, bounced: 3, active: 2 }; // anything else = 1, null = 0
const statusRank = (s) => (s == null ? 0 : STATUS_RANK[s] || 1);

/**
 * Subscribers: dedupe on normalized email.
 *
 * Merge precedence for duplicate rows of the same email (documented choice):
 *   signup_date    = earliest non-null
 *   last_open_date = latest non-null
 *   source         = source of the earliest-signup row that has a source; fallback first non-null
 *   status         = highest precedence: unsubscribed > bounced > active > any other value > blank.
 *                    Rationale: suppression signals must never be lost by a merge — if any row says the
 *                    person unsubscribed or bounced, emailing them is the unsafe mistake. (Dates in the
 *                    exports don't reliably tell us which row is "newer", so recency can't be trusted.)
 *   duplicate_count = rows merged beyond the first
 */
function ingestSubscribers(db, records, get, report) {
  const merged = new Map();
  const sourceValues = {};
  const statusValues = {};
  let aliases = 0;
  const today = config.today;

  for (const rec of records) {
    const rawEmail = get(rec, 'email');
    const email = normEmail(rawEmail);
    if (!email) {
      if (rawEmail == null || rawEmail === '') report.missing_required++; else report.invalid_emails++;
      continue;
    }
    const sd = parseDateCell(get(rec, 'signup_date'), normDate);
    const lo = parseDateCell(get(rec, 'last_open_date'), normDate);
    if (sd.bad) bump(report.unparseable_dates, 'signup_date');
    if (lo.bad) bump(report.unparseable_dates, 'last_open_date');
    if ((sd.value && sd.value > today) || (lo.value && lo.value > today)) report.future_dates++;
    const rawSource = get(rec, 'source');
    const source = normSource(rawSource);
    if (source && collapse(normCat(rawSource)) !== source) aliases++;
    const status = normStatus(get(rec, 'status'));

    const row = { email, signup_date: sd.value, last_open_date: lo.value, source, status };
    const prev = merged.get(email);
    if (!prev) { merged.set(email, { ...row, dup: 0 }); continue; }

    report.duplicates_merged++;
    prev.dup++;
    const rowEarlier = row.signup_date && (!prev.signup_date || row.signup_date < prev.signup_date);
    if (rowEarlier) {
      prev.signup_date = row.signup_date;
      if (row.source) prev.source = row.source;
    }
    if (!prev.source && row.source) prev.source = row.source;
    if (row.last_open_date && (!prev.last_open_date || row.last_open_date > prev.last_open_date)) prev.last_open_date = row.last_open_date;
    if (statusRank(row.status) > statusRank(prev.status)) prev.status = row.status;
  }

  const find = db.prepare('SELECT id FROM profiles WHERE email = ?');
  const ins = db.prepare(`INSERT INTO profiles (email, email_hash, is_subscriber, signup_date, status, source, last_open_date, duplicate_count, origin)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'subscribers_csv')`);
  // origin becomes 'subscribers_csv' once someone is on the list, so the final state doesn't depend on
  // whether the app_users file happened to create the profile first.
  const upd = db.prepare(`UPDATE profiles SET is_subscriber = 1, signup_date = ?, status = ?, source = ?, last_open_date = ?,
    duplicate_count = ?, origin = 'subscribers_csv', email_hash = COALESCE(email_hash, ?) WHERE id = ?`);

  for (const r of merged.values()) {
    if (r.source) bump(sourceValues, r.source); else bump(sourceValues, '(blank)');
    if (r.status) bump(statusValues, r.status); else bump(statusValues, '(blank)');
    const hash = pseudonym(r.email, 'sub');
    const existing = find.get(r.email);
    if (existing) {
      upd.run(r.signup_date, r.status, r.source, r.last_open_date, r.dup, hash, existing.id);
      report.updated++;
    } else {
      ins.run(r.email, hash, r.signup_date, r.status, r.source, r.last_open_date, r.dup);
      report.inserted++;
    }
  }
  report.rows_loaded = merged.size;
  report.unique_emails = merged.size;
  report.source_values = sourceValues;
  report.status_values = statusValues;
  report.source_aliases_applied = aliases;
  if (!('signup_date' in report.column_mapping)) report.warnings.push('No signup date column detected');
  if (!('source' in report.column_mapping)) report.warnings.push('No acquisition source column detected');
  if (!('last_open_date' in report.column_mapping)) report.warnings.push('No last-open column detected');
}

/** Web events: full replace of the table; exact duplicate rows are collapsed. */
function ingestWebEvents(db, records, get, report) {
  const seen = new Set();
  const rows = [];
  const utmValues = {};
  const visitors = new Set();
  let withEmail = 0;
  for (const rec of records) {
    const visitor_id = get(rec, 'visitor_id') || null;
    const page = normPage(get(rec, 'page'));
    const t = parseDateCell(get(rec, 'ts'), normTimestamp);
    if (t.bad) bump(report.unparseable_dates, 'ts');
    const rawEmail = get(rec, 'email');
    let email = null;
    if (rawEmail) {
      email = normEmail(rawEmail);
      if (!email) report.invalid_emails++;
    }
    if (!visitor_id && !email) { report.missing_required++; continue; }
    if (t.value && t.value.slice(0, 10) > config.today) report.future_dates++;
    const utm_source = normSource(get(rec, 'utm_source'));
    const key = `${visitor_id}\u0001${page}\u0001${t.value}\u0001${email}\u0001${utm_source}`;
    if (seen.has(key)) { report.duplicates_merged++; continue; }
    seen.add(key);
    rows.push([visitor_id, page, t.value, utm_source, email]);
    if (visitor_id) visitors.add(visitor_id);
    if (email) withEmail++;
    bump(utmValues, utm_source || '(blank)');
  }
  report.replaced_previous = Number(db.prepare('SELECT COUNT(*) AS n FROM web_events').get().n);
  db.exec('DELETE FROM web_events');
  const ins = db.prepare('INSERT INTO web_events (visitor_id, page, ts, utm_source, email) VALUES (?, ?, ?, ?, ?)');
  for (const r of rows) ins.run(...r);
  report.rows_loaded = rows.length;
  report.inserted = rows.length;
  report.distinct_visitors = visitors.size;
  report.events_with_email = withEmail;
  report.source_values = utmValues;
}

/** App users: upsert by user_id. Duplicate user_id rows: first valid email wins, earliest created_date. */
function ingestAppUsers(db, records, get, report) {
  const merged = new Map();
  for (const rec of records) {
    const user_id = get(rec, 'user_id');
    if (!user_id) { report.missing_required++; continue; }
    const rawEmail = get(rec, 'email');
    const email = normEmail(rawEmail);
    if (rawEmail && !email) report.invalid_emails++;
    const cd = parseDateCell(get(rec, 'created_date'), normDate);
    if (cd.bad) bump(report.unparseable_dates, 'created_date');
    if (cd.value && cd.value > config.today) report.future_dates++;
    const prev = merged.get(user_id);
    if (!prev) { merged.set(user_id, { user_id, email, created_date: cd.value }); continue; }
    report.duplicates_merged++;
    if (!prev.email && email) prev.email = email;
    if (cd.value && (!prev.created_date || cd.value < prev.created_date)) prev.created_date = cd.value;
  }

  const findUser = db.prepare('SELECT user_id FROM app_users WHERE user_id = ?');
  const updUser = db.prepare(`UPDATE app_users SET email = COALESCE(?, email), created_date = COALESCE(?, created_date),
    origin = 'app_users_csv' WHERE user_id = ?`);
  const findProfile = db.prepare('SELECT id FROM profiles WHERE email = ?');
  const insProfile = db.prepare(`INSERT INTO profiles (email, email_hash, is_subscriber, origin) VALUES (?, ?, 0, 'app_users_csv')`);
  const insUser = db.prepare(`INSERT INTO app_users (user_id, email, created_date, profile_id, origin) VALUES (?, ?, ?, ?, 'app_users_csv')`);
  let noEmail = 0;
  for (const u of merged.values()) {
    if (!u.email) noEmail++;
    if (findUser.get(u.user_id)) {
      // Keep the current profile_id; relinkAll() moves it if the (new) email points elsewhere.
      updUser.run(u.email, u.created_date, u.user_id);
      report.updated++;
      continue;
    }
    let pid = u.email ? findProfile.get(u.email)?.id : null;
    if (pid == null) pid = Number(insProfile.run(u.email, u.email ? pseudonym(u.email, 'sub') : null).lastInsertRowid);
    insUser.run(u.user_id, u.email, u.created_date, pid);
    report.inserted++;
  }
  report.rows_loaded = merged.size;
  report.users_without_email = noEmail;
}

// ---------------------------------------------------------------------------
// Identity resolution
// ---------------------------------------------------------------------------

/**
 * Re-derive every link from scratch so that import order never matters. Steps:
 *  1. app_users -> profile by email. If no profile has that email: adopt the user's current profile when it
 *     has no email (webhook-created stub), else create a new app-only profile.
 *     This is also where a webhook stub gets merged into a subscriber profile once app_users.csv
 *     supplies the email: the app_user is repointed and the stub becomes an orphan.
 *  2. Orphans (non-subscriber profiles with no app_users row) are deleted, after clearing references.
 *  3. app_events.profile_id = app_users.profile_id of COALESCE(resolved_user_id, user_id).
 *  4. web_events.profile_id = profile with the same email; then visitor stitching: rows of a visitor_id
 *     without their own email match inherit the profile of that visitor's EARLIEST email-matched event.
 *     (A row whose own captured email matches a profile always keeps that direct match.)
 */
export function relinkAll(db) {
  return tx(db, () => {
    const out = { app_users_repointed: 0, profiles_created: 0, stubs_adopted: 0, orphans_removed: 0 };

    const mismatched = db.prepare(`SELECT a.user_id, a.email, a.profile_id, p.email AS pemail
      FROM app_users a JOIN profiles p ON p.id = a.profile_id
      WHERE a.email IS NOT NULL AND (p.email IS NULL OR p.email <> a.email)`).all();
    const findProfile = db.prepare('SELECT id FROM profiles WHERE email = ?');
    const repoint = db.prepare('UPDATE app_users SET profile_id = ? WHERE user_id = ?');
    const adopt = db.prepare('UPDATE profiles SET email = ?, email_hash = ? WHERE id = ? AND email IS NULL');
    const create = db.prepare(`INSERT INTO profiles (email, email_hash, is_subscriber, origin) VALUES (?, ?, 0, 'app_users_csv')`);
    for (const r of mismatched) {
      const target = findProfile.get(r.email);
      if (target) {
        if (target.id !== r.profile_id) { repoint.run(target.id, r.user_id); out.app_users_repointed++; }
      } else if (r.pemail == null) {
        adopt.run(r.email, pseudonym(r.email, 'sub'), r.profile_id);
        out.stubs_adopted++;
      } else {
        const id = Number(create.run(r.email, pseudonym(r.email, 'sub')).lastInsertRowid);
        repoint.run(id, r.user_id);
        out.profiles_created++;
        out.app_users_repointed++;
      }
    }

    const orphanSql = `SELECT id FROM profiles p WHERE p.is_subscriber = 0
      AND NOT EXISTS (SELECT 1 FROM app_users a WHERE a.profile_id = p.id)`;
    db.exec(`UPDATE app_events SET profile_id = NULL WHERE profile_id IN (${orphanSql})`);
    db.exec(`UPDATE web_events SET profile_id = NULL WHERE profile_id IN (${orphanSql})`);
    out.orphans_removed = Number(db.prepare(`DELETE FROM profiles WHERE id IN (${orphanSql})`).run().changes);

    db.exec(`UPDATE app_events SET profile_id =
      (SELECT a.profile_id FROM app_users a WHERE a.user_id = COALESCE(app_events.resolved_user_id, app_events.user_id))`);

    db.exec(`UPDATE web_events SET profile_id =
      (SELECT p.id FROM profiles p WHERE p.email = web_events.email)`);
    const direct = Number(db.prepare('SELECT COUNT(*) AS n FROM web_events WHERE profile_id IS NOT NULL').get().n);
    db.exec(`UPDATE web_events SET profile_id = (
        SELECT w2.profile_id FROM web_events w2
        WHERE w2.visitor_id = web_events.visitor_id AND w2.profile_id IS NOT NULL
        ORDER BY w2.ts IS NULL, w2.ts, w2.id LIMIT 1)
      WHERE profile_id IS NULL AND visitor_id IS NOT NULL`);
    const linked = Number(db.prepare('SELECT COUNT(*) AS n FROM web_events WHERE profile_id IS NOT NULL').get().n);

    out.web_events_linked_by_email = direct;
    out.web_events_linked_by_visitor = linked - direct;
    out.web_events_unlinked = Number(db.prepare('SELECT COUNT(*) AS n FROM web_events WHERE profile_id IS NULL').get().n);
    out.app_events_linked = Number(db.prepare('SELECT COUNT(*) AS n FROM app_events WHERE profile_id IS NOT NULL').get().n);
    out.app_events_unlinked = Number(db.prepare('SELECT COUNT(*) AS n FROM app_events WHERE profile_id IS NULL').get().n);
    return out;
  });
}
