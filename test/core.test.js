import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestDb } from '../src/db.js';
import { ingestCsv, detectColumns, relinkAll, normSource, normPage } from '../src/ingest.js';
import { runSegment, validateSpec, SEGMENT_FIELDS, segmentFields } from '../src/segments.js';
import { searchProfiles, getProfile } from '../src/profiles.js';
import { overview, sourceStats, pageStats, coldBySource } from '../src/stats.js';
import { csvCell } from '../src/api.js';
import { config } from '../src/config.js';
import { generateFixtures } from '../scripts/generate-fake-data.js';

// All data here is synthetic (generated with a seeded PRNG, example.* domains only).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-fixtures-'));
const { files, truth } = generateFixtures(dir, { seed: 7 });
const buf = (k) => fs.readFileSync(files[k]);

function loadAll(order = ['subscribers', 'web_events', 'app_users']) {
  const db = openTestDb();
  const reports = {};
  for (const k of order) reports[k] = ingestCsv(db, k, buf(k), `${k}.csv`);
  return { db, reports };
}

/** Order-independent snapshot keyed by natural identifiers (not autoincrement ids). */
function snapshot(db) {
  const profiles = db.prepare(`SELECT email, is_subscriber, signup_date, status, source, last_open_date, duplicate_count, origin
    FROM profiles WHERE email IS NOT NULL ORDER BY email`).all().map((r) => ({ ...r }));
  const web = db.prepare(`SELECT w.visitor_id, w.page, w.ts, p.email AS pemail FROM web_events w LEFT JOIN profiles p ON p.id = w.profile_id
    ORDER BY w.visitor_id, w.ts, w.page, pemail`).all().map((r) => ({ ...r }));
  const apps = db.prepare(`SELECT a.user_id, a.email, p.email AS pemail FROM app_users a JOIN profiles p ON p.id = a.profile_id ORDER BY a.user_id`)
    .all().map((r) => ({ ...r }));
  const nullProfiles = Number(db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE email IS NULL').get().n);
  return { profiles, web, apps, nullProfiles };
}

describe('detectColumns', () => {
  test('maps messy header names', () => {
    assert.deepEqual(detectColumns('subscribers', ['Email Address', 'Signed Up', 'Status', 'Acquisition Source', 'Last Opened']), {
      email: 'Email Address', signup_date: 'Signed Up', status: 'Status', source: 'Acquisition Source', last_open_date: 'Last Opened',
    });
    const m = detectColumns('subscribers', ['subscriber_email', 'signup_date', 'subscription_status', 'utm_source', 'last_open_at']);
    assert.equal(m.email, 'subscriber_email');
    assert.equal(m.signup_date, 'signup_date');
    assert.equal(m.status, 'subscription_status');
    assert.equal(m.source, 'utm_source');
    assert.equal(m.last_open_date, 'last_open_at');
    const w = detectColumns('web_events', ['visitor_id', 'page', 'timestamp', 'utm_source', 'email']);
    assert.deepEqual(Object.keys(w).sort(), ['email', 'page', 'ts', 'utm_source', 'visitor_id']);
    const a = detectColumns('app_users', ['User ID', 'E-mail', 'Created Date']);
    assert.deepEqual(a, { user_id: 'User ID', email: 'E-mail', created_date: 'Created Date' });
  });

  test('throws 400 listing missing fields and headers seen', () => {
    assert.throws(() => detectColumns('subscribers', ['foo', 'bar']), (e) => e.status === 400 && /email/.test(e.message) && /"foo"/.test(e.message));
    assert.throws(() => detectColumns('nope', ['email']), (e) => e.status === 400);
  });
});

describe('normalizers', () => {
  test('source aliases and page paths', () => {
    assert.equal(normSource(' IG '), 'instagram');
    assert.equal(normSource('Instagram '), 'instagram');
    assert.equal(normSource('FB'), 'facebook');
    assert.equal(normSource('tik  tok'), 'tiktok');
    assert.equal(normSource('Podcast'), 'podcast');
    assert.equal(normSource(''), null);
    assert.equal(normPage('https://www.example.org/Articles/X/?utm=1#top'), '/articles/x');
    assert.equal(normPage('/'), '/');
    assert.equal(normPage('subscribe/'), '/subscribe');
  });
});

describe('subscriber ingest', () => {
  test('dedupes by normalized email and reports counts', () => {
    const { db, reports } = loadAll(['subscribers']);
    const r = reports.subscribers;
    assert.equal(r.rows_loaded, truth.uniqueSubscribers);
    assert.equal(r.duplicates_merged, truth.duplicateRows);
    assert.equal(r.invalid_emails, truth.invalidEmails);
    assert.equal(r.blank_rows, truth.blankRows);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n), truth.uniqueSubscribers);
    assert.equal(Number(db.prepare('SELECT SUM(duplicate_count) AS n FROM profiles').get().n), truth.duplicateRows);
    // Report must not leak emails
    assert.doesNotMatch(JSON.stringify(r), /@/);
    // Sources normalized
    const sources = db.prepare('SELECT DISTINCT source FROM profiles WHERE source IS NOT NULL').all().map((x) => x.source);
    assert.ok(!sources.includes('ig') && !sources.includes('fb') && sources.every((s) => s === s.trim().toLowerCase()));
    // Stored in the imports table
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM imports').get().n), 1);
  });

  test('merge precedence: earliest signup, latest open, suppression status wins', () => {
    const db = openTestDb();
    const csv = [
      '﻿Email Address,Signed Up,Status,Acquisition Source,Last Opened',
      '  Pat@Example.com ,3/5/2026,active,FB,2026-09-01',
      'pat@example.com,2026-02-01,Unsubscribed,Instagram ,1756684800', // 2025-09-01 epoch
      'PAT@EXAMPLE.COM,2026-04-01T10:00:00Z,active,,9/20/2026',
      ',,,,',
      'bad-email,2026-01-01,active,ig,',
    ].join('\r\n');
    const r = ingestCsv(db, 'subscribers', Buffer.from(csv), 't.csv');
    assert.equal(r.rows_loaded, 1);
    assert.equal(r.duplicates_merged, 2);
    assert.equal(r.invalid_emails, 1);
    assert.equal(r.blank_rows, 1);
    const p = db.prepare('SELECT * FROM profiles').get();
    assert.equal(p.email, 'pat@example.com');
    assert.equal(p.signup_date, '2026-02-01');
    assert.equal(p.source, 'instagram'); // from the earliest-signup row
    assert.equal(p.last_open_date, '2026-09-20');
    assert.equal(p.status, 'unsubscribed');
    assert.equal(p.duplicate_count, 2);
    assert.match(p.email_hash, /^sub_[0-9a-f]{12}$/);
  });

  test('re-importing the same file is idempotent', () => {
    const { db } = loadAll();
    const before = snapshot(db);
    for (const k of ['subscribers', 'web_events', 'app_users']) ingestCsv(db, k, buf(k), `${k}.csv`);
    assert.deepEqual(snapshot(db), before);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM web_events').get().n), before.web.length);
  });

  test('unparseable dates are counted, impossible dates rejected', () => {
    const db = openTestDb();
    const csv = 'email,signup_date\na@example.com,13/45/2026\nb@example.com,2026-02-30\nc@example.com,never\nd@example.com,garbage';
    const r = ingestCsv(db, 'subscribers', Buffer.from(csv));
    assert.equal(r.unparseable_dates.signup_date, 3); // "never" is an explicit placeholder, not an error
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE signup_date IS NOT NULL').get().n), 0);
  });
});

describe('linking', () => {
  let db;
  before(() => { ({ db } = loadAll()); });

  test('web events link by captured email and are stitched by visitor_id', () => {
    let checked = 0;
    for (const [email, vid] of truth.knownVisitorFor) {
      const p = db.prepare('SELECT id FROM profiles WHERE email = ?').get(email);
      const rows = db.prepare('SELECT profile_id, email FROM web_events WHERE visitor_id = ?').all(vid);
      const captured = rows.some((r) => r.email === email);
      if (!captured) continue; // capture row had an invalid email in the synthetic data
      for (const r of rows) assert.equal(r.profile_id, p.id, 'every event of a stitched visitor points at the profile');
      checked++;
    }
    assert.ok(checked > 100, `checked ${checked} visitors`);
    const stitched = Number(db.prepare(`SELECT COUNT(*) AS n FROM web_events WHERE email IS NULL AND profile_id IS NOT NULL`).get().n);
    assert.ok(stitched > 0, 'some events were linked only via visitor stitching');
    // Events that captured an email matching nobody stay unlinked
    assert.equal(Number(db.prepare(`SELECT COUNT(*) AS n FROM web_events WHERE email LIKE 'stranger%' AND profile_id IS NOT NULL`).get().n), 0);
  });

  test('app users link to subscriber profiles by email; non-matching users get app-only profiles', () => {
    for (const [email, uid] of truth.appUserFor) {
      const row = db.prepare(`SELECT p.email, p.is_subscriber FROM app_users a JOIN profiles p ON p.id = a.profile_id WHERE a.user_id = ?`).get(uid);
      assert.equal(row.email, email);
      assert.equal(row.is_subscriber, 1);
    }
    const appOnly = db.prepare(`SELECT COUNT(*) AS n FROM profiles WHERE is_subscriber = 0 AND origin = 'app_users_csv'`).get();
    assert.ok(Number(appOnly.n) > 50);
    const ov = overview(db);
    assert.equal(ov.subscribers, truth.uniqueSubscribers);
    assert.equal(ov.duplicates_merged, truth.duplicateRows);
    assert.ok(ov.web_linked > 0 && ov.app_users_subscribed > 0);
    assert.doesNotMatch(JSON.stringify(ov), /@/);
  });

  test('import order does not matter', () => {
    const a = snapshot(loadAll(['subscribers', 'web_events', 'app_users']).db);
    const b = snapshot(loadAll(['app_users', 'web_events', 'subscribers']).db);
    const c = snapshot(loadAll(['web_events', 'app_users', 'subscribers']).db);
    assert.deepEqual(b, a);
    assert.deepEqual(c, a);
  });

  test('webhook stub profile merges into the subscriber profile once app_users.csv supplies the email', () => {
    const d = openTestDb();
    ingestCsv(d, 'subscribers', Buffer.from('email,signup_date,status,source\nsam@example.org,2026-01-01,active,instagram\n'));
    // Simulate webhook.js: unknown user_id -> stub profile + app_users row + an event
    const stub = Number(d.prepare(`INSERT INTO profiles (email, is_subscriber, origin) VALUES (NULL, 0, 'webhook')`).run().lastInsertRowid);
    d.prepare(`INSERT INTO app_users (user_id, email, profile_id, origin) VALUES ('u_2b6447a3', NULL, ?, 'webhook')`).run(stub);
    d.prepare(`INSERT INTO app_events (event_id, event, user_id, device_id, ts, resolved_user_id, profile_id)
      VALUES ('e1', 'read_story', NULL, 'dev1', '2026-09-27T10:00:00.000Z', 'u_2b6447a3', ?)`).run(stub);
    // Another stub whose user is not a subscriber: should adopt the email in place
    const stub2 = Number(d.prepare(`INSERT INTO profiles (email, is_subscriber, origin) VALUES (NULL, 0, 'webhook')`).run().lastInsertRowid);
    d.prepare(`INSERT INTO app_users (user_id, email, profile_id, origin) VALUES ('u_00000001', NULL, ?, 'webhook')`).run(stub2);

    const r = ingestCsv(d, 'app_users', Buffer.from('user_id,email,created_at\nu_2b6447a3,SAM@example.org,2026-02-01\nu_00000001,new@example.net,2026-03-01\n'));
    assert.equal(r.updated, 2);
    const sub = d.prepare(`SELECT id FROM profiles WHERE email = 'sam@example.org'`).get().id;
    const au = d.prepare(`SELECT profile_id, origin, email FROM app_users WHERE user_id = 'u_2b6447a3'`).get();
    assert.equal(au.profile_id, sub);
    assert.equal(au.email, 'sam@example.org');
    assert.equal(d.prepare(`SELECT profile_id FROM app_events WHERE event_id = 'e1'`).get().profile_id, sub);
    assert.equal(d.prepare('SELECT id FROM profiles WHERE id = ?').get(stub), undefined, 'orphan stub deleted');
    const adopted = d.prepare('SELECT email, origin FROM profiles WHERE id = ?').get(stub2);
    assert.equal(adopted.email, 'new@example.net');
    // relinkAll is idempotent
    const again = relinkAll(d);
    assert.equal(again.app_users_repointed, 0);
    assert.equal(again.orphans_removed, 0);
  });
});

describe('segments', () => {
  let db;
  before(() => {
    ({ db } = loadAll());
    // a few synthetic app events for engagement / app filters
    const uid = [...truth.appUserFor.values()][0];
    const ins = db.prepare(`INSERT INTO app_events (event_id, event, user_id, ts, resolved_user_id) VALUES (?, ?, ?, ?, ?)`);
    for (let i = 0; i < 6; i++) ins.run(`ev${i}`, i % 2 ? 'read_story' : 'app_open', uid, `2026-09-2${i}T12:00:00.000Z`, uid);
    ins.run('ev-future', 'read_story', uid, '2026-09-29T08:00:00.000Z', uid); // a day after "today": still counted
    relinkAll(db);
  });

  test('instagram & not opened in 30 days', () => {
    const { total, rows } = runSegment(db, { source: ['Instagram'], not_opened_in_days: 30, limit: 5000 });
    const cutoff = '2026-08-29';
    const expected = Number(db.prepare(`SELECT COUNT(*) AS n FROM profiles WHERE source = 'instagram' AND (last_open_date IS NULL OR last_open_date < ?)`).get(cutoff).n);
    assert.equal(total, expected);
    assert.ok(total > 0);
    assert.equal(rows.length, total);
    for (const r of rows) {
      assert.equal(r.source, 'instagram');
      assert.ok(r.last_open_date == null || r.last_open_date < cutoff);
      assert.deepEqual(Object.keys(r).sort(), ['app_events', 'email', 'engagement', 'has_app', 'id', 'is_subscriber', 'last_open_date', 'signup_date', 'source', 'status', 'web_visits'].sort());
    }
  });

  test('other filters, sort and pagination', () => {
    const all = runSegment(db, {});
    assert.equal(all.total, Number(db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n));
    assert.equal(all.rows.length, 100);
    const sorted = all.rows.map((r) => r.engagement);
    assert.deepEqual(sorted, [...sorted].sort((x, y) => y - x));

    const app = runSegment(db, { has_app: true, app_events_min: 5, app_event_type: 'read_story', app_events_within_days: 30 });
    assert.equal(app.total, 0); // only 4 read_story events
    const app2 = runSegment(db, { has_app: true, app_events_min: 7, app_events_within_days: 30 });
    assert.equal(app2.total, 1);
    assert.ok(app2.rows[0].engagement >= 14);

    const page = runSegment(db, { visited_page: '/SUBSCRIBE', is_subscriber: true, signup_after: '2026-08-01', signup_before: '2026-08-31', sort: 'signup_desc' });
    assert.ok(page.total > 0);
    for (const r of page.rows) assert.ok(r.signup_date >= '2026-08-01' && r.signup_date <= '2026-08-31');
    const p2 = runSegment(db, { visited_page: '/subscribe' }, { limit: 10, offset: 10 });
    const p1 = runSegment(db, { visited_page: '/subscribe' }, { limit: 20 });
    assert.deepEqual(p2.rows.map((r) => r.id), p1.rows.slice(10).map((r) => r.id));

    const opened = runSegment(db, { opened_within_days: 7, status: 'active', sort: 'last_open_desc' });
    for (const r of opened.rows) assert.ok(r.last_open_date >= '2026-09-21' && r.status === 'active');
  });

  test('validateSpec rejects unknown keys and wrong types', () => {
    const bad = [
      { foo: 1 },
      { source: 5 },
      { source: [1, 2] },
      { not_opened_in_days: 'abc' },
      { not_opened_in_days: -1 },
      { not_opened_in_days: 1.5 },
      { has_app: 'yes' },
      { signup_after: '2026-13-01' },
      { signup_after: '08/01/2026' },
      { sort: 'random' },
      { limit: 0 },
      { visited_page: 42 },
      { signup_after: '2026-09-01', signup_before: '2026-08-01' },
      [],
      'source=instagram',
      { source: ["instagram'); DROP TABLE profiles; --"], limit: "1; DROP TABLE profiles" },
    ];
    for (const spec of bad) assert.throws(() => validateSpec(spec), (e) => e.status === 400, JSON.stringify(spec));
    assert.deepEqual(validateSpec({ source: 'IG', has_app: 'true', limit: '10', status: null, visited_page: '' }), { source: ['instagram'], has_app: true, limit: 10 });
  });

  test('injection attempts are inert values', () => {
    const r = runSegment(db, { source: ["instagram' OR 1=1 --"], visited_page: "%' OR '1'='1" });
    assert.equal(r.total, 0);
    assert.ok(Number(db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n) > 0);
  });

  test('SEGMENT_FIELDS metadata', () => {
    const names = SEGMENT_FIELDS.map((f) => f.name).sort();
    assert.deepEqual(names, ['app_event_type', 'app_events_min', 'app_events_within_days', 'has_app', 'is_subscriber', 'limit', 'not_opened_in_days',
      'opened_within_days', 'signup_after', 'signup_before', 'sort', 'source', 'status', 'visited_page', 'web_visits_min', 'web_visits_within_days'].sort());
    for (const f of SEGMENT_FIELDS) assert.ok(f.label && f.description && f.type);
    const live = segmentFields(db);
    assert.ok(live.find((f) => f.name === 'source').options.includes('instagram'));
    assert.ok(live.find((f) => f.name === 'app_event_type').options.includes('read_story'));
  });
});

describe('profiles & stats', () => {
  let db;
  before(() => { ({ db } = loadAll()); });

  test('search by email substring, user_id, visitor_id, id', () => {
    const [email, uid] = [...truth.appUserFor.entries()][0];
    const byEmail = searchProfiles(db, email.slice(0, 8).toUpperCase());
    assert.ok(byEmail.length > 0 && byEmail.every((r) => r.email.includes(email.slice(0, 8))));
    const byUid = searchProfiles(db, uid);
    assert.equal(byUid[0].email, email);
    const [vEmail, vid] = [...truth.knownVisitorFor.entries()].find(([e, v]) =>
      db.prepare('SELECT 1 FROM web_events WHERE visitor_id = ? AND profile_id IS NOT NULL').get(v));
    assert.equal(searchProfiles(db, vid)[0].email, vEmail);
    const id = byUid[0].id;
    assert.equal(searchProfiles(db, String(id))[0].id, id);
    assert.deepEqual(searchProfiles(db, '%'), []); // LIKE wildcards are escaped
  });

  test('getProfile returns linked data and timeline', () => {
    const vid = [...truth.knownVisitorFor.values()].find((v) => db.prepare('SELECT 1 FROM web_events WHERE visitor_id = ? AND profile_id IS NOT NULL').get(v));
    const pid = db.prepare('SELECT profile_id FROM web_events WHERE visitor_id = ? AND profile_id IS NOT NULL').get(vid).profile_id;
    const p = getProfile(db, pid);
    assert.ok(p.web_events.length > 0);
    for (let i = 1; i < p.web_events.length; i++) assert.ok((p.web_events[i - 1].ts ?? '') >= (p.web_events[i].ts ?? ''));
    assert.ok(p.timeline.length >= p.web_events.filter((w) => w.ts).length);
    assert.ok(p.profile.first_page_visited);
    assert.equal(typeof p.profile.days_since_open === 'number' || p.profile.days_since_open === null, true);
    assert.equal(getProfile(db, 99999999), null);
  });

  test('stats are aggregate-only', () => {
    const s = sourceStats(db);
    assert.ok(s.sources.find((x) => x.source === 'instagram').subscribers > 0);
    const pg = pageStats(db, { newSubscribersDays: 60 });
    assert.ok(pg.top_pages.length > 0);
    assert.ok(pg.new_subscribers.count > 0 && pg.new_subscribers.first_page.length > 0);
    const c = coldBySource(db, { month: '2026-08' });
    assert.equal(c.signup_to, '2026-08-31');
    assert.ok(c.sources.length > 0);
    assert.throws(() => coldBySource(db, { month: 'August' }), (e) => e.status === 400);
    for (const o of [s, pg, c]) assert.doesNotMatch(JSON.stringify(o), /@/);
    assert.equal(config.today, '2026-09-28');
  });
});

describe('CSV export escaping', () => {
  test('formula injection guard and quoting', () => {
    assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
    assert.equal(csvCell('+1'), "'+1");
    assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
    assert.equal(csvCell('-2'), "'-2");
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(true), 'true');
    assert.equal(csvCell(12), '12');
  });
});
