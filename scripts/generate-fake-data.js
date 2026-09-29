#!/usr/bin/env node
/**
 * Deterministic, deliberately messy SYNTHETIC data for dev/test.
 *
 * Writes subscribers.csv, web_events.csv and app_users.csv (default: test/fixtures/).
 * Only reserved example domains are used (example.com / example.org / example.net),
 * so nothing here is real PII.
 *
 * Mess we inject on purpose (mirrors what the real exports are likely to contain):
 *  - UTF-8 BOM at file start, CRLF line endings
 *  - human-ish header names ("Email Address", "Signed Up", "Captured Email", ...)
 *  - duplicate subscribers with different casing / whitespace / conflicting fields
 *  - blank lines and all-comma "blank" rows
 *  - invalid emails, impossible and unparseable dates
 *  - mixed date formats: 2026-03-01, 3/1/2026, ISO with time, unix epoch (s and ms)
 *  - inconsistent category casing ("Instagram", "instagram ", "IG", "FB", "tik tok")
 *  - quoted fields containing commas
 *  - web events: visitor_ids reused across rows, email only on the signup row,
 *    full URLs vs paths, trailing slashes, exact duplicate rows
 *  - app users: most emails match subscribers (with case noise), some don't, a few blank,
 *    a few duplicate user_id rows
 *
 * Usage: node scripts/generate-fake-data.js [outDir] [--seed=42]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TODAY = Date.UTC(2026, 8, 28); // 2026-09-28, matches config.today
const DAY = 86400000;

/** mulberry32: tiny seeded PRNG so fixtures are byte-for-byte reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateFixtures(outDir, { seed = 42, scale = 1 } = {}) {
  const rnd = mulberry32(seed);
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const chance = (p) => rnd() < p;
  const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[int(0, 15)]).join('');
  const weighted = (pairs) => { // [[value, weight], ...]
    const total = pairs.reduce((s, [, w]) => s + w, 0);
    let r = rnd() * total;
    for (const [v, w] of pairs) { if ((r -= w) < 0) return v; }
    return pairs[pairs.length - 1][0];
  };
  const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

  /** Render a date in one of several formats. */
  const fmtDate = (ms, { allowGarbage = true } = {}) => {
    const d = new Date(ms);
    const f = weighted([['ymd', 50], ['us', 25], ['iso', 12], ['epoch', 8], ['garbage', allowGarbage ? 1.5 : 0]]);
    if (f === 'ymd') return ymd(ms);
    if (f === 'us') return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
    if (f === 'iso') return d.toISOString().replace('.000', '');
    if (f === 'epoch') return String(Math.floor(ms / 1000));
    return pick(['sometime in March', '13/45/2026', '2026-02-30', 'TBD']);
  };
  const fmtTs = (ms) => {
    const d = new Date(ms);
    const f = weighted([['iso', 55], ['sql', 25], ['epoch', 10], ['epochms', 7], ['garbage', 0.5]]);
    if (f === 'iso') return d.toISOString();
    if (f === 'sql') return d.toISOString().slice(0, 19).replace('T', ' ');
    if (f === 'epoch') return String(Math.floor(ms / 1000));
    if (f === 'epochms') return String(ms);
    return 'not a time';
  };
  /** Case / whitespace noise on an email. */
  const noisyEmail = (e) => {
    const v = weighted([['same', 3], ['upper', 2], ['title', 2], ['space', 2], ['mailto', 0.3]]);
    if (v === 'upper') return e.toUpperCase();
    if (v === 'title') return e[0].toUpperCase() + e.slice(1).replace('@e', '@E');
    if (v === 'space') return `  ${e} `;
    if (v === 'mailto') return `mailto:${e}`;
    return e;
  };

  const SOURCES = {
    instagram: ['instagram', 'Instagram', 'instagram ', 'INSTAGRAM', 'IG', 'ig', 'Insta'],
    facebook: ['facebook', 'Facebook', 'FB', 'fb '],
    tiktok: ['tiktok', 'TikTok', 'tik tok'],
    organic: ['organic', 'Organic', 'organic search'],
    referral: ['referral', 'Referral'],
    google: ['google', 'Google'],
    podcast: ['podcast', 'Podcast'],
    twitter: ['twitter', 'Twitter', 'X'],
  };
  const SOURCE_WEIGHTS = [['instagram', 30], ['facebook', 14], ['organic', 20], ['referral', 10],
    ['tiktok', 10], ['google', 8], ['podcast', 5], ['twitter', 3]];
  const STATUS = { active: ['active', 'Active', 'ACTIVE', 'subscribed'], unsubscribed: ['unsubscribed', 'Unsubscribed', 'unsub'], bounced: ['bounced', 'Bounced'] };
  const WORDS = ['maple', 'river', 'cedar', 'harbor', 'fox', 'otter', 'pine', 'lark', 'finch', 'quill', 'birch',
    'ember', 'meadow', 'stone', 'willow', 'aspen', 'brook', 'coral', 'dune', 'fern'];
  const DOMAINS = ['example.com', 'example.org', 'example.net'];
  const ARTICLES = ['why-sleep-matters', 'how-inflation-works', 'election-explainer', 'ai-and-you', 'rest-is-resistance',
    'water-crisis', 'faith-and-news', 'screen-time', 'climate-basics', 'housing-market', 'good-news-roundup', 'weekly-recap'];

  // ---------- people / subscribers ----------
  const nPeople = Math.round(2850 * scale);
  const people = [];
  const usedEmails = new Set();
  for (let i = 0; i < nPeople; i++) {
    let email;
    do { email = `${pick(WORDS)}.${pick(WORDS)}${int(1, 9999)}@${pick(DOMAINS)}`; } while (usedEmails.has(email));
    usedEmails.add(email);
    // signups skew recent: 2025-01-01 .. 2026-09-27
    const start = Date.UTC(2025, 0, 1);
    const span = TODAY - DAY - start;
    const signup = start + Math.floor(Math.pow(rnd(), 0.6) * span);
    const status = weighted([['active', 82], ['unsubscribed', 12], ['bounced', 6]]);
    let lastOpen = null;
    if (status === 'active' ? chance(0.88) : chance(0.5)) {
      const bucket = weighted([['hot', 45], ['warm', 20], ['cold', 35]]);
      const back = bucket === 'hot' ? int(0, 7) : bucket === 'warm' ? int(8, 30) : int(31, 240);
      lastOpen = Math.max(signup, TODAY - back * DAY);
    }
    const source = weighted(SOURCE_WEIGHTS);
    people.push({ email, signup, status, lastOpen, source });
  }

  const subRows = [];
  const subRow = (p, overrides = {}) => {
    const q = { ...p, ...overrides };
    return [
      noisyEmail(q.email),
      fmtDate(q.signup),
      chance(0.02) ? '' : pick(STATUS[q.status]),
      chance(0.03) ? '' : pick(SOURCES[q.source]),
      q.lastOpen == null ? pick(['', '', 'never', 'N/A']) : fmtDate(q.lastOpen),
      pick(['weekly', 'weekly, promo', 'weekly, events, promo', '', 'podcast, weekly']),
    ];
  };
  for (const p of people) subRows.push(subRow(p));
  // Duplicates: same person, noisy email, conflicting fields.
  let dupes = 0;
  for (const p of people) {
    if (!chance(0.05)) continue;
    dupes++;
    const earlier = chance(0.5) ? { signup: p.signup - int(1, 60) * DAY } : {};
    subRows.push(subRow(p, { ...earlier, lastOpen: p.lastOpen && chance(0.5) ? p.lastOpen - int(1, 20) * DAY : p.lastOpen, source: p.source }));
  }
  const invalid = ['not-an-email', 'jane@', '@example.com', 'foo bar@example.com', 'someone(at)example.org', 'x@y', '???'];
  let invalidCount = 0;
  for (let i = 0; i < Math.round(18 * scale); i++) {
    invalidCount++;
    subRows.push([pick(invalid), fmtDate(TODAY - int(1, 300) * DAY), 'active', 'Instagram', '', '']);
  }
  let blankCount = 0;
  for (let i = 0; i < Math.round(12 * scale); i++) { blankCount++; subRows.push(['', '', '', '', '', '']); }
  shuffle(subRows, rnd);

  // ---------- web events ----------
  const webRows = [];
  const PATHS = () => weighted([['/', 20], [`/articles/${pick(ARTICLES)}`, 55], ['/subscribe', 8], ['/about', 5], ['/podcast', 7], ['/donate', 5]]);
  const renderPage = (p) => {
    const v = weighted([['plain', 80], ['url', 10], ['slash', 5], ['upper', 3], ['query', 2]]);
    if (v === 'url') return `https://www.example.org${p}`;
    if (v === 'slash' && p !== '/') return `${p}/`;
    if (v === 'upper') return p.toUpperCase();
    if (v === 'query') return `${p}?utm_source=ig&ref=story`;
    return p;
  };
  const utm = (src) => (chance(0.55) ? '' : pick(SOURCES[src] || ['newsletter']));
  const knownVisitorFor = new Map(); // email -> visitor_id (ground truth for tests)
  const targetWeb = Math.round(10000 * scale);
  // Known visitors: a subset of subscribers who signed up via the site.
  for (const p of people) {
    if (webRows.length > targetWeb * 0.55) break;
    if (!chance(0.45)) continue;
    const vid = `v_${hex(10)}`;
    knownVisitorFor.set(p.email, vid);
    const pre = int(0, 3);
    for (let k = pre; k > 0; k--) {
      webRows.push([vid, renderPage(PATHS()), fmtTs(p.signup - k * int(1, 5) * DAY + int(0, 86399) * 1000), utm(p.source), '']);
    }
    // the signup page view captures the email (sometimes with noise, rarely invalid)
    const cap = chance(0.02) ? 'bad-email@' : noisyEmail(p.email);
    webRows.push([vid, renderPage('/subscribe'), fmtTs(p.signup + int(0, 86399) * 1000), utm(p.source), cap]);
    for (let k = 0, n = int(0, 4); k < n; k++) {
      const t = p.signup + int(1, Math.max(1, Math.floor((TODAY - p.signup) / DAY))) * DAY;
      webRows.push([vid, renderPage(PATHS()), fmtTs(Math.min(t, TODAY - 1000)), '', '']);
    }
  }
  // A few captured emails that match nobody.
  for (let i = 0; i < Math.round(40 * scale); i++) {
    webRows.push([`v_${hex(10)}`, '/subscribe', fmtTs(TODAY - int(1, 200) * DAY), '', `stranger${i}@example.net`]);
  }
  // Anonymous visitors fill the rest.
  while (webRows.length < targetWeb - Math.round(60 * scale)) {
    const vid = `v_${hex(10)}`;
    for (let k = 0, n = int(1, 6); k < n; k++) {
      webRows.push([vid, renderPage(PATHS()), fmtTs(TODAY - int(0, 500) * DAY - int(0, 86399) * 1000), utm(weighted(SOURCE_WEIGHTS)), '']);
    }
  }
  // Exact duplicate rows (tracker double-fire) and blank rows.
  for (let i = 0; i < Math.round(45 * scale); i++) webRows.push([...pick(webRows)]);
  for (let i = 0; i < Math.round(8 * scale); i++) webRows.push(['', '', '', '', '']);
  shuffle(webRows, rnd);

  // ---------- app users ----------
  const appRows = [];
  const usedIds = new Set();
  const newUid = () => { let u; do { u = `u_${hex(8)}`; } while (usedIds.has(u)); usedIds.add(u); return u; };
  const appUserFor = new Map(); // email -> user_id
  const nApp = Math.round(900 * scale);
  const nMatched = Math.round(nApp * 0.86);
  const candidates = shuffle(people.filter((p) => p.status === 'active'), rnd).slice(0, nMatched);
  for (const p of candidates) {
    const uid = newUid();
    appUserFor.set(p.email, uid);
    const created = Math.min(TODAY - DAY, p.signup + int(-30, 200) * DAY);
    appRows.push([uid, noisyEmail(p.email), fmtDate(created, { allowGarbage: false })]);
  }
  let appOnly = 0;
  while (appRows.length < nApp - Math.round(10 * scale)) {
    appOnly++;
    appRows.push([newUid(), `appfan${appOnly}@example.net`, fmtDate(TODAY - int(1, 400) * DAY, { allowGarbage: false })]);
  }
  for (let i = 0; i < Math.round(4 * scale); i++) appRows.push([newUid(), '', fmtDate(TODAY - int(1, 100) * DAY)]);
  for (let i = 0; i < Math.round(5 * scale); i++) { const r = pick(appRows); appRows.push([r[0], r[1], r[2]]); }
  for (let i = 0; i < Math.round(3 * scale); i++) appRows.push(['', '', '']);
  shuffle(appRows, rnd);

  fs.mkdirSync(outDir, { recursive: true });
  const files = {
    subscribers: path.join(outDir, 'subscribers.csv'),
    web_events: path.join(outDir, 'web_events.csv'),
    app_users: path.join(outDir, 'app_users.csv'),
  };
  writeCsv(files.subscribers, ['Email Address', 'Signed Up', 'Status', 'Acquisition Source', 'Last Opened', 'Tags'], subRows);
  writeCsv(files.web_events, ['Visitor ID', 'Page URL', 'Timestamp', 'UTM Source', 'Captured Email'], webRows);
  writeCsv(files.app_users, ['User ID', 'E-mail', 'Account Created'], appRows);

  // Ground truth (synthetic, safe to expose to tests).
  return {
    files,
    truth: {
      uniqueSubscribers: nPeople,
      subscriberRows: subRows.length,
      duplicateRows: dupes,
      invalidEmails: invalidCount,
      blankRows: blankCount,
      webRows: webRows.length,
      appRows: appRows.length,
      people,
      knownVisitorFor,
      appUserFor,
    },
  };
}

function shuffle(arr, rnd) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(file, header, rows) {
  const lines = [header.map(csvCell).join(',')];
  rows.forEach((r, i) => {
    lines.push(r.map(csvCell).join(','));
    if (i % 997 === 500) lines.push(''); // occasional truly empty line
  });
  fs.writeFileSync(file, '﻿' + lines.join('\r\n') + '\r\n');
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const seedArg = args.find((a) => a.startsWith('--seed='));
  const outDir = args.find((a) => !a.startsWith('--')) ||
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
  const { files, truth } = generateFixtures(outDir, { seed: seedArg ? Number(seedArg.slice(7)) : 42 });
  console.log('Wrote synthetic fixtures:');
  for (const [k, f] of Object.entries(files)) console.log(`  ${k.padEnd(12)} ${f}`);
  console.log(`  subscribers: ${truth.subscriberRows} rows (${truth.uniqueSubscribers} unique, ${truth.duplicateRows} dupes, ${truth.invalidEmails} invalid, ${truth.blankRows} blank)`);
  console.log(`  web_events:  ${truth.webRows} rows; app_users: ${truth.appRows} rows`);
}
