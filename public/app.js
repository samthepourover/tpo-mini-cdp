// The Pour Over CDP — single-page frontend.
// Security note: every piece of data from the server is rendered with textContent
// (via the h() helper below). We never assign server data to innerHTML.

/* ------------------------------------------------------------------ *
 * Small DOM + formatting helpers
 * ------------------------------------------------------------------ */

/** Create an element. attrs: class, text, style, dataset, on<Event> fns, anything else via setAttribute. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'style') el.setAttribute('style', v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden' || k === 'open' || k === 'multiple') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Escape helper for the rare case a string must be treated as HTML. (We prefer textContent.) */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nf = new Intl.NumberFormat('en-US');
const fmtNum = (n) => (typeof n === 'number' && Number.isFinite(n) ? nf.format(n) : String(n));

// Business "today" for the CDP. The server may override this via /api/overview { today }.
let TODAY = '2026-09-28';

const LABELS = {
  profiles: 'People in the CDP',
  subscribers: 'Newsletter subscribers',
  active_subscribers: 'Active subscribers',
  active: 'Active',
  unsubscribed: 'Unsubscribed',
  bounced: 'Bounced',
  duplicates_merged: 'Duplicate rows merged',
  duplicate_rows: 'Duplicate rows merged',
  duplicates: 'Duplicates merged',
  web_events: 'Website visits',
  web_linked: 'Visits matched to a person',
  web_unlinked: 'Anonymous visits',
  web_visitors: 'Unique website visitors',
  visitors: 'Unique visitors',
  app_users: 'App users',
  app_events: 'App events',
  app_only: 'App-only people',
  app_only_profiles: 'App-only people',
  webhook_profiles: 'People first seen in the app',
  webhook_events: 'Webhook events',
  stitched_events: 'Events stitched to a user',
  devices: 'Devices seen',
  imports: 'Imports',
  rows_in: 'Rows in file',
  rows_loaded: 'Rows loaded',
  rows_skipped: 'Rows skipped',
  rows_rejected: 'Rows rejected',
  inserted: 'New records',
  updated: 'Updated records',
  merged: 'Merged records',
  invalid_email: 'Invalid emails',
  invalid_emails: 'Invalid emails',
  missing_email: 'Rows without an email',
  missing_emails: 'Rows without an email',
  blank_rows: 'Blank rows',
  empty_rows: 'Blank rows',
  bad_dates: 'Unreadable dates',
  invalid_dates: 'Unreadable dates',
  bad_timestamps: 'Unreadable timestamps',
  linked: 'Linked to a person',
  linked_profiles: 'Linked to a person',
  unlinked: 'Not linked yet',
  stitched_by_visitor: 'Stitched via visitor ID',
  new_profiles: 'New people created',
  profiles_created: 'New people created',
  column_mapping: 'Columns we detected',
  mapping: 'Columns we detected',
  columns: 'Columns',
  unmapped_columns: 'Columns we ignored',
  unmapped: 'Columns we ignored',
  missing_columns: 'Columns we couldn’t find',
  warnings: 'Heads-ups',
  errors: 'Problems',
  filename: 'File',
  kind: 'Type',
  created_at: 'When',
  signup_date: 'Signed up',
  last_open_date: 'Last opened',
  source: 'Source',
  status: 'Status',
  email: 'Email',
  has_app: 'Has the app',
  engagement: 'Engagement',
  web_visits: 'Website visits',
  is_subscriber: 'Subscriber',
  user_id: 'User ID',
  device_id: 'Device',
  visitor_id: 'Visitor ID',
  received_at: 'Received',
  ts: 'Time',
  event: 'Event',
  total_payloads: 'Payloads sent to or from the AI',
  payloads: 'Payloads logged',
  findings: 'PII findings',
  pii_findings: 'PII findings',
  emails_seen_by_model: 'Emails seen by the model',
  emails_seen: 'Emails seen by the model',
  to_model: 'Sent to the model',
  cold_30d: 'Active but cold (30+ days)',
  profiles_with_duplicates: 'People with merged duplicates',
  web_visitors_linked: 'Visitors matched to a person',
  subscribers_with_web: 'Subscribers seen on the website',
  app_users_subscribed: 'App users on the newsletter',
  app_events_linked: 'App events matched to a person',
  total_rows: 'AI log entries',
  payloads_with_findings_before_redaction: 'Payloads that needed masking',
  total_findings_redacted: 'Items masked before sending',
  payloads_rescanned: 'Payloads re-scanned',
  identifiers_seen_by_model: 'Other identifiers seen by the model',
  first_page_visited: 'First page visited',
  from_model: 'Received from the model',
};

const KIND_LABELS = { subscribers: 'Subscribers', web_events: 'Web events', app_users: 'App users' };

function humanize(key) {
  if (LABELS[key]) return LABELS[key];
  const s = String(key).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

function fmtDate(v) {
  if (!v) return '—';
  const s = String(v);
  if (DATE_RE.test(s)) {
    const d = new Date(s + 'T00:00:00Z');
    return isNaN(d) ? s : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  }
  if (/^\d{4}-\d{2}-\d{2}T00:00:00(\.0+)?Z$/.test(s)) return fmtDate(s.slice(0, 10));
  if (TS_RE.test(s)) {
    // SQLite datetime('now') has no timezone marker; it is UTC.
    const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s.replace(' ', 'T') : s.replace(' ', 'T') + 'Z';
    const d = new Date(iso);
    return isNaN(d) ? s : d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  return s;
}

function fmtTime(v) {
  if (!v) return '—';
  const s = String(v);
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s.replace(' ', 'T') : s.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  return isNaN(d) ? s : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function daysBetween(fromYmd, toYmd) {
  const a = Date.parse(String(fromYmd).slice(0, 10) + 'T00:00:00Z');
  const b = Date.parse(String(toYmd).slice(0, 10) + 'T00:00:00Z');
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

function parseMaybeJson(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return v;
  try { return JSON.parse(t); } catch { return v; }
}

/** Accept either an array or an object wrapping an array under a common key. */
function asList(data, ...keys) {
  if (Array.isArray(data)) return data;
  if (isPlainObject(data)) {
    for (const k of [...keys, 'items', 'rows', 'results', 'data']) if (Array.isArray(data[k])) return data[k];
  }
  return [];
}

/** Only allow same-origin relative API paths as hrefs coming from the server. */
function safeApiHref(u) {
  return typeof u === 'string' && /^\/api\/[A-Za-z0-9/_\-.%?=&]*$/.test(u) ? u : null;
}

const profileHref = (id) => `#/lookup?id=${encodeURIComponent(id)}`;

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

class ApiError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}

async function api(path, opts = {}) {
  const init = { credentials: 'same-origin', headers: { Accept: 'application/json' }, ...opts };
  if (opts.json !== undefined) {
    init.method = init.method || 'POST';
    init.headers = { ...init.headers, 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opts.json);
    delete init.json;
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError('We couldn’t reach the server. Check your connection and try again.', 0);
  }
  if (res.status === 401) {
    location.href = '/login';
    throw new ApiError('Your session has ended. Taking you to sign in…', 401);
  }
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('application/json') ? await res.json().catch(() => null) : await res.text().catch(() => '');
  if (!res.ok) {
    const msg = (isPlainObject(body) && (body.error || body.message)) || `Something went wrong (error ${res.status}).`;
    throw new ApiError(String(msg), res.status, body);
  }
  return body;
}

/* ------------------------------------------------------------------ *
 * Shared UI pieces
 * ------------------------------------------------------------------ */

const loading = (text = 'Pouring a fresh cup…') => h('p', { class: 'loading', role: 'status' }, text);
const empty = (text, extra) => h('div', { class: 'empty' }, h('p', {}, text), extra || null);
const errorNotice = (err) => h('p', { class: 'notice notice-error', role: 'alert' }, err?.message || String(err));

function pageHead(title, intro) {
  return h('div', { class: 'page-head' }, h('h1', {}, title), intro ? h('p', { class: 'lede' }, intro) : null);
}

function statusPill(status) {
  if (!status) return h('span', { class: 'pill pill-quiet' }, 'No status');
  const s = String(status).toLowerCase();
  const cls = s === 'active' ? 'pill pill-active' : (s === 'unsubscribed' || s === 'bounced') ? 'pill pill-off' : 'pill';
  return h('span', { class: cls }, h('span', { class: 'pill-dot', 'aria-hidden': 'true' }), humanize(s));
}

/** Render any value in a friendly way. Nested objects/arrays become small tables. */
function renderValue(v, key) {
  if (v === null || v === undefined || v === '') return h('span', { class: 'muted' }, '—');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return fmtNum(v);
  if (typeof v === 'string') {
    const p = parseMaybeJson(v);
    if (p !== v) return renderValue(p, key);
    if (key && /(_at|_date|^ts$|date$|time$)/.test(key)) return fmtDate(v);
    return v;
  }
  if (Array.isArray(v)) {
    if (!v.length) return h('span', { class: 'muted' }, 'None');
    if (v.every((x) => x === null || typeof x !== 'object')) return v.map((x) => String(x)).join(', ');
    if (v.every(isPlainObject)) return dataTable(v, { small: true });
    return h('pre', { class: 'code small' }, JSON.stringify(v, null, 2));
  }
  if (isPlainObject(v)) return kvTable(v, { small: true });
  return String(v);
}

function kvTable(obj, { small = false } = {}) {
  const entries = Object.entries(obj || {});
  if (!entries.length) return h('span', { class: 'muted' }, 'Nothing to show');
  return h('div', { class: 'table-wrap' },
    h('table', { class: small ? 'kv kv-small' : 'kv' },
      h('tbody', {}, entries.map(([k, v]) => h('tr', {}, h('th', { scope: 'row' }, humanize(k)), h('td', {}, renderValue(v, k)))))));
}

/** Generic table from an array of objects (or {columns, rows} arrays). */
function dataTable(rows, { columns, small = false, cell, caption } = {}) {
  let cols = columns;
  if (!cols) {
    const seen = new Set();
    for (const r of rows) if (isPlainObject(r)) Object.keys(r).forEach((k) => seen.add(k));
    cols = [...seen];
  }
  const getCell = (r, c, i) => (Array.isArray(r) ? r[i] : r?.[c]);
  return h('div', { class: 'table-wrap' },
    h('table', { class: small ? 'data data-small' : 'data' },
      caption ? h('caption', { class: 'sr-only' }, caption) : null,
      h('thead', {}, h('tr', {}, cols.map((c) => h('th', { scope: 'col' }, humanize(c))))),
      h('tbody', {}, rows.map((r) => h('tr', {}, cols.map((c, i) => {
        const custom = cell ? cell(c, r) : undefined;
        return h('td', {}, custom !== undefined ? custom : renderValue(getCell(r, c, i), c));
      }))))));
}

function statGrid(entries, { compact = false } = {}) {
  return h('div', { class: compact ? 'stats stats-compact' : 'stats' },
    entries.map(([k, v, sub]) => h('div', { class: 'stat' },
      h('p', { class: 'stat-value' }, fmtNum(v)),
      h('p', { class: 'stat-label' }, humanize(k)),
      sub ? h('p', { class: 'stat-sub' }, sub) : null)));
}

/** Split a report object into headline numbers + everything else. */
function renderReport(report) {
  const r = parseMaybeJson(report);
  if (!isPlainObject(r)) return h('p', {}, renderValue(r));
  const nums = [], rest = {};
  for (const [k, v] of Object.entries(r)) {
    if (typeof v === 'number') nums.push([k, v]);
    else rest[k] = v;
  }
  return h('div', { class: 'report' },
    nums.length ? statGrid(nums, { compact: true }) : null,
    Object.keys(rest).length ? kvTable(rest) : null);
}

function copyButton(getText, label = 'Copy') {
  const btn = h('button', { type: 'button', class: 'btn btn-quiet btn-sm' }, label);
  btn.addEventListener('click', async () => {
    const text = getText();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = h('textarea', { class: 'sr-only', 'aria-hidden': 'true' });
      ta.value = text; document.body.append(ta); ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
    }
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = label; }, 1600);
  });
  return btn;
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ------------------------------------------------------------------ *
 * Overview
 * ------------------------------------------------------------------ */

const OVERVIEW_ORDER = ['profiles', 'subscribers', 'active_subscribers', 'cold_30d', 'duplicates_merged', 'web_linked', 'app_users', 'app_events', 'web_events', 'web_visitors', 'web_visitors_linked', 'subscribers_with_web', 'app_users_subscribed', 'app_events_linked', 'app_only_profiles', 'webhook_profiles', 'unsubscribed', 'bounced', 'profiles_with_duplicates'];

async function viewOverview(root) {
  root.append(pageHead('Overview', 'A quick look at everyone we know across the newsletter, the website, and the app.'));
  const statsBox = h('section', { class: 'section', 'aria-label': 'Key numbers' }, loading());
  const importsBox = h('section', { class: 'section' }, h('h2', {}, 'Recent imports'), loading('Checking the latest uploads…'));
  root.append(statsBox, importsBox);

  api('/api/overview').then((data) => {
    clear(statsBox);
    if (!isPlainObject(data)) { statsBox.append(empty('No numbers to show yet.')); return; }
    if (typeof data.today === 'string' && DATE_RE.test(data.today)) TODAY = data.today;
    const nums = Object.entries(data).filter(([k, v]) => typeof v === 'number' && !k.endsWith('_pct'));
    nums.sort(([a], [b]) => {
      const ia = OVERVIEW_ORDER.indexOf(a), ib = OVERVIEW_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    const total = nums.reduce((s, [, v]) => s + v, 0);
    if (!nums.length || total === 0) {
      statsBox.append(empty('No subscribers yet — start by importing your CSVs.',
        h('a', { class: 'btn btn-primary', href: '#/import' }, 'Import your first file')));
    } else {
      const withSub = nums.map(([k, v]) => {
        let sub = null;
        if (typeof data[`${k}_pct`] === 'number') sub = `${data[`${k}_pct`]}% of the total`;
        else if (k === 'web_linked' && data.web_events) sub = `${Math.round((v / data.web_events) * 100)}% of all visits`;
        if (k === 'subscribers' && data.profiles) sub = `${Math.round((v / data.profiles) * 100)}% of everyone`;
        return [k, v, sub];
      });
      const HEADLINE = 8;
      statsBox.append(statGrid(withSub.slice(0, HEADLINE)));
      if (withSub.length > HEADLINE) {
        statsBox.append(h('details', { class: 'details' }, h('summary', {}, `More numbers (${withSub.length - HEADLINE})`),
          statGrid(withSub.slice(HEADLINE), { compact: true })));
      }
    }
    // Nested breakdowns such as { sources: { instagram: 120, ... } }
    const breakdowns = Object.entries(data).filter(([, v]) => isPlainObject(v) && Object.values(v).some((x) => typeof x === 'number'));
    const listBreakdowns = Object.entries(data).filter(([, v]) => Array.isArray(v) && v.length && v.every(isPlainObject));
    if (breakdowns.length || listBreakdowns.length) {
      statsBox.append(h('div', { class: 'grid-2' },
        breakdowns.map(([k, v]) => h('div', { class: 'card' }, h('h3', {}, humanize(k)), barList(v))),
        listBreakdowns.map(([k, v]) => h('div', { class: 'card' }, h('h3', {}, humanize(k)), dataTable(v, { small: true })))));
    }
  }).catch((err) => { clear(statsBox).append(errorNotice(err)); });

  api('/api/imports').then((data) => {
    const list = asList(data, 'imports');
    clear(importsBox).append(h('h2', {}, 'Recent imports'));
    if (!list.length) {
      importsBox.append(empty('Nothing imported yet. Head to Import to upload subscribers, web events, or app users.'));
      return;
    }
    importsBox.append(h('div', { class: 'stack' }, list.slice(0, 10).map(importCard)));
  }).catch((err) => { clear(importsBox).append(h('h2', {}, 'Recent imports'), errorNotice(err)); });
}

function barList(obj) {
  const entries = Object.entries(obj).filter(([, v]) => typeof v === 'number').sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  return h('ul', { class: 'bars' }, entries.slice(0, 12).map(([k, v]) => h('li', {},
    h('div', { class: 'bar-row' }, h('span', { class: 'bar-label' }, k === '' || k === 'null' ? 'Unknown' : k), h('span', { class: 'bar-num' }, fmtNum(v))),
    h('div', { class: 'bar-track', 'aria-hidden': 'true' }, h('div', { class: 'bar-fill', style: `width:${Math.max(2, (v / max) * 100).toFixed(1)}%` })))));
}

function importCard(imp) {
  const report = parseMaybeJson(imp.report) || {};
  const counts = isPlainObject(report) ? Object.entries(report).filter(([, v]) => typeof v === 'number') : [];
  const rowsIn = imp.rows_in ?? report.rows_in;
  const rowsLoaded = imp.rows_loaded ?? report.rows_loaded;
  return h('article', { class: 'card import-card' },
    h('div', { class: 'import-head' },
      h('div', {},
        h('p', { class: 'eyebrow' }, KIND_LABELS[imp.kind] || humanize(imp.kind || 'Import')),
        h('p', { class: 'import-file' }, imp.filename || 'Untitled file')),
      h('p', { class: 'muted small' }, fmtDate(imp.created_at))),
    (rowsIn !== undefined || rowsLoaded !== undefined)
      ? h('p', { class: 'import-summary' }, `${fmtNum(rowsLoaded ?? 0)} of ${fmtNum(rowsIn ?? 0)} rows loaded`)
      : null,
    counts.length ? h('ul', { class: 'chips' }, counts.filter(([k]) => !['rows_in', 'rows_loaded', 'import_id', 'id'].includes(k)).map(([k, v]) =>
      h('li', { class: 'chip' }, h('strong', {}, fmtNum(v)), ' ', humanize(k).toLowerCase()))) : null,
    isPlainObject(report) && Object.keys(report).length
      ? h('details', { class: 'details' }, h('summary', {}, 'Full data-quality report'), renderReport(report))
      : null);
}

/* ------------------------------------------------------------------ *
 * Import
 * ------------------------------------------------------------------ */

const IMPORT_KINDS = [
  { kind: 'subscribers', title: 'Subscribers', blurb: 'Your newsletter list export: emails, signup dates, source, status, last open.' },
  { kind: 'web_events', title: 'Web events', blurb: 'Website page views with visitor IDs, pages, UTM source, and any captured email.' },
  { kind: 'app_users', title: 'App users', blurb: 'People with an app account: user ID, email, and when they joined.' },
];

function viewImport(root) {
  root.append(pageHead('Import', 'Upload a CSV and we’ll tidy it up: matching columns, merging duplicates, and flagging anything odd. Import in any order — we re-link everyone after each upload.'));
  root.append(h('p', { class: 'notice' },
    h('strong', {}, 'Your data stays put. '),
    'Files are processed on the server. Nothing you upload is sent to the AI assistant — it only sees masked data.'));
  root.append(h('div', { class: 'grid-3' }, IMPORT_KINDS.map(uploadCard)));
}

function uploadCard({ kind, title, blurb }) {
  const inputId = `file-${kind}`;
  const input = h('input', { type: 'file', id: inputId, name: 'file', accept: '.csv,text/csv', class: 'file-input', required: true });
  const fileName = h('span', { class: 'file-name muted' }, 'No file chosen');
  const button = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Upload');
  const result = h('div', { class: 'upload-result', 'aria-live': 'polite' });
  input.addEventListener('change', () => { fileName.textContent = input.files?.[0]?.name || 'No file chosen'; });

  const form = h('form', { class: 'card upload-card', novalidate: true },
    h('h2', { class: 'h3' }, title),
    h('p', { class: 'muted small' }, blurb),
    h('div', { class: 'file-picker' },
      h('label', { for: inputId, class: 'btn btn-quiet' }, 'Choose CSV'),
      input, fileName),
    button,
    result);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = input.files?.[0];
    clear(result);
    if (!file) { result.append(h('p', { class: 'notice notice-error' }, 'Pick a CSV file first.')); return; }
    const fd = new FormData();
    fd.append('file', file);
    button.disabled = true;
    button.textContent = 'Uploading…';
    result.append(loading(`Reading ${file.name}…`));
    try {
      const report = await api(`/api/import/${encodeURIComponent(kind)}`, { method: 'POST', body: fd });
      clear(result).append(
        h('p', { class: 'notice notice-ok' }, h('strong', {}, 'All done. '), `Here’s what we found in ${file.name}.`),
        renderReport(report));
      input.value = '';
      fileName.textContent = 'No file chosen';
    } catch (err) {
      clear(result).append(errorNotice(err));
    } finally {
      button.disabled = false;
      button.textContent = 'Upload';
    }
  });
  return form;
}

/* ------------------------------------------------------------------ *
 * Lookup
 * ------------------------------------------------------------------ */

let lastLookupQuery = '';

function viewLookup(root, params) {
  root.append(pageHead('Lookup', 'Find anyone by email, app user ID, or website visitor ID, and see everything we know in one place.'));
  const input = h('input', { type: 'search', id: 'lookup-q', placeholder: 'Try an email, a user ID, or a visitor ID', autocomplete: 'off', value: lastLookupQuery });
  const results = h('div', { class: 'results', 'aria-live': 'polite' });
  const profileBox = h('div', { class: 'profile-box' });
  root.append(
    h('form', { class: 'search', role: 'search', onSubmit: (e) => { e.preventDefault(); search(input.value); } },
      h('label', { for: 'lookup-q', class: 'sr-only' }, 'Search people'), input),
    results, profileBox);

  let seq = 0;
  async function search(q) {
    q = q.trim();
    lastLookupQuery = q;
    const mine = ++seq;
    clear(results);
    if (q.length < 2) {
      if (!params.get('id')) results.append(h('p', { class: 'muted small' }, 'Type at least two characters to search.'));
      return;
    }
    results.append(loading('Looking…'));
    try {
      const data = asList(await api(`/api/profiles?q=${encodeURIComponent(q)}`), 'profiles');
      if (mine !== seq) return;
      clear(results);
      if (!data.length) { results.append(empty(`No one matches “${q}”. Check the spelling, or try part of the email.`)); return; }
      results.append(h('ul', { class: 'result-list' }, data.map((p) => h('li', {},
        h('a', { href: profileHref(p.id), class: `result${String(p.id) === params.get('id') ? ' is-current' : ''}` },
          h('span', { class: 'result-main' }, p.email || (p.user_id ? `App user ${p.user_id}` : p.match === 'user_id' ? `App user ${q}` : `App-only person #${p.id}`)),
          h('span', { class: 'result-meta' },
            p.status ? statusPill(p.status) : null,
            p.source ? h('span', { class: 'muted small' }, p.source) : null,
            p.is_subscriber === 0 || p.is_subscriber === false ? h('span', { class: 'muted small' }, 'Not a subscriber') : null))))));
    } catch (err) {
      if (mine === seq) clear(results).append(errorNotice(err));
    }
  }

  input.addEventListener('input', debounce(() => search(input.value), 250));
  if (lastLookupQuery) search(lastLookupQuery);
  else results.append(h('p', { class: 'muted small' }, 'Start typing to search.'));

  const id = params.get('id');
  if (id) loadProfile(profileBox, id);
  else setTimeout(() => input.focus(), 0);
}

async function loadProfile(box, id) {
  clear(box).append(loading('Gathering their story…'));
  try {
    const data = await api(`/api/profiles/${encodeURIComponent(id)}`);
    clear(box).append(renderProfile(data));
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    clear(box).append(err.status === 404 ? empty('We couldn’t find that person. They may have been merged into another profile.') : errorNotice(err));
  }
}

function eventProps(v) {
  const p = parseMaybeJson(v);
  if (!p || (isPlainObject(p) && !Object.keys(p).length)) return h('span', { class: 'muted' }, '—');
  if (!isPlainObject(p)) return String(p);
  const preferred = ['story_title', 'title', 'story_id', 'story', 'url', 'link', 'screen'];
  const keys = Object.keys(p).sort((a, b) => {
    const ia = preferred.indexOf(a), ib = preferred.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return h('span', { class: 'props' }, keys.map((k) => h('span', { class: 'prop' },
    h('span', { class: 'prop-k' }, `${k}: `), typeof p[k] === 'object' ? JSON.stringify(p[k]) : String(p[k]))));
}

function renderProfile(data) {
  const p = data.profile || data;
  const appUsers = asList(data.app_users);
  const web = asList(data.web_events);
  const app = asList(data.app_events);
  const userIds = appUsers.map((u) => u.user_id).filter(Boolean);
  const title = p.email || (userIds.length ? `App user ${userIds[0]}` : `Person #${p.id}`);
  const since = p.days_since_open ?? (p.last_open_date ? daysBetween(p.last_open_date, TODAY) : null);

  const facts = [
    ['Source', p.source || '—'],
    ['Signed up', fmtDate(p.signup_date)],
    ['Last opened', fmtDate(p.last_open_date)],
    ['Days since last open', since === null || since === undefined ? '—' : fmtNum(since)],
  ];
  if (p.duplicate_count) facts.push(['Duplicate rows merged', fmtNum(p.duplicate_count)]);
  if (userIds.length) facts.push(['App user ID', userIds.join(', ')]);
  if (p.first_page_visited) facts.push(['First page visited', p.first_page_visited]);
  if (p.origin) facts.push(['First seen in', humanize(String(p.origin).replace(/_csv$/, ''))]);

  const header = h('section', { class: 'card profile-head' },
    h('div', { class: 'profile-title' },
      h('div', {},
        h('p', { class: 'eyebrow' }, p.is_subscriber ? 'Newsletter subscriber' : (p.email ? 'Known reader' : 'App-only reader')),
        h('h2', { class: 'profile-name' }, title),
        !p.email ? h('p', { class: 'muted small' }, 'We don’t have an email for this person yet. They came in through the app.') : null),
      statusPill(p.status)),
    h('dl', { class: 'facts' }, facts.map(([k, v]) => h('div', { class: 'fact' }, h('dt', {}, k), h('dd', {}, v)))));

  const newsletter = h('section', { class: 'card' },
    h('h3', {}, 'Newsletter'),
    p.is_subscriber
      ? h('p', {}, `Status: ${humanize(p.status || 'unknown')}. Joined ${fmtDate(p.signup_date)} via ${p.source || 'an unknown source'}. `,
        p.last_open_date ? `Last opened an email on ${fmtDate(p.last_open_date)}${since !== null && since !== undefined ? ` (${fmtNum(since)} days ago)` : ''}.` : 'We haven’t seen them open an email yet.')
      : h('p', { class: 'muted' }, 'Not on the newsletter list.'));

  const webSection = h('section', { class: 'card' },
    h('h3', {}, 'Website visits', h('span', { class: 'count' }, fmtNum(web.length))),
    web.length
      ? dataTable(web, {
        columns: ['ts', 'page', 'utm_source', 'visitor_id'],
        cell: (c, r) => (c === 'ts' ? fmtDate(r.ts) : c === 'utm_source' ? (r.utm_source || h('span', { class: 'muted' }, 'direct')) : undefined),
      })
      : empty('No website visits linked to this person yet.'));

  const appSection = h('section', { class: 'card' },
    h('h3', {}, 'App activity', h('span', { class: 'count' }, fmtNum(app.length))),
    app.length
      ? dataTable(app, {
        columns: ['ts', 'event', 'properties', 'device_id', 'user_id'],
        cell: (c, r) => {
          if (c === 'ts') return fmtDate(r.ts);
          if (c === 'event') return humanize(r.event || '');
          if (c === 'properties') return eventProps(r.properties);
          if (c === 'user_id') {
            if (r.user_id) return r.user_id;
            if (r.resolved_user_id || r.profile_id) return h('span', { class: 'tag' }, 'Stitched from anonymous');
            return h('span', { class: 'muted' }, 'anonymous');
          }
          return undefined;
        },
      })
      : empty('No app activity yet.'));

  const timeline = buildTimeline(data, p, web, app);
  const timelineSection = h('section', { class: 'card' },
    h('h3', {}, 'Timeline'),
    timeline.length
      ? h('ol', { class: 'timeline' }, timeline.map((t) => h('li', {},
        h('span', { class: 'tl-when' }, fmtDate(t.ts)),
        h('span', { class: 'tl-kind' }, t.kind),
        h('span', { class: 'tl-what' }, t.what))))
      : empty('Nothing on the timeline yet.'));

  return h('div', { class: 'profile stack' }, header,
    h('div', { class: 'grid-profile' }, newsletter, appUsers.length ? h('section', { class: 'card' },
      h('h3', {}, 'App account'), dataTable(appUsers, { small: true, columns: ['user_id', 'email', 'created_date', 'origin'].filter((c) => appUsers.some((u) => c in u)) })) : null),
    webSection, appSection, timelineSection);
}

function buildTimeline(data, p, web, app) {
  const server = asList(data.timeline);
  if (server.length) {
    return server.map((t) => {
      const ts = t.ts || t.time || t.at || t.date || t.timestamp;
      const kind = humanize(t.channel || t.kind || t.source || t.type || 'Activity');
      let what = t.label || t.summary || t.description || t.detail || t.title || t.event || t.page;
      if (what === undefined) {
        const rest = { ...t };
        ['ts', 'time', 'at', 'date', 'timestamp', 'kind', 'type', 'channel', 'source'].forEach((k) => delete rest[k]);
        what = Object.entries(rest).map(([k, v]) => `${humanize(k)}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
      }
      if (typeof what === 'object') what = JSON.stringify(what);
      return { ts, kind, what: String(what) };
    }).sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  }
  const items = [];
  if (p.signup_date) items.push({ ts: p.signup_date, kind: 'Newsletter', what: `Subscribed${p.source ? ` via ${p.source}` : ''}` });
  if (p.last_open_date) items.push({ ts: p.last_open_date, kind: 'Newsletter', what: 'Last opened an email' });
  web.forEach((w) => items.push({ ts: w.ts, kind: 'Website', what: `Visited ${w.page || 'a page'}${w.utm_source ? ` from ${w.utm_source}` : ''}` }));
  app.forEach((a) => items.push({ ts: a.ts, kind: 'App', what: humanize(a.event || 'event') }));
  return items.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
}

/* ------------------------------------------------------------------ *
 * Segments
 * ------------------------------------------------------------------ */

const FALLBACK_FIELDS = [
  { name: 'source', type: 'list', label: 'Signed up via', description: 'Acquisition source, e.g. instagram, facebook, organic. Separate several with commas.' },
  { name: 'status', type: 'multi', label: 'Newsletter status', options: ['active', 'unsubscribed', 'bounced'] },
  { name: 'is_subscriber', type: 'boolean', label: 'Is a newsletter subscriber' },
  { name: 'signup_after', type: 'date', label: 'Signed up on or after' },
  { name: 'signup_before', type: 'date', label: 'Signed up on or before' },
  { name: 'not_opened_in_days', type: 'number', label: 'Hasn’t opened in (days)' },
  { name: 'opened_within_days', type: 'number', label: 'Opened within (days)' },
  { name: 'has_app', type: 'boolean', label: 'Has the app' },
  { name: 'app_events_min', type: 'number', label: 'At least this many app events' },
  { name: 'app_events_within_days', type: 'number', label: '…within the last (days)' },
  { name: 'app_event_type', type: 'enum', label: 'Count only this app event', options: ['app_open', 'read_story', 'link_click', 'login'] },
  { name: 'web_visits_min', type: 'number', label: 'At least this many website visits' },
  { name: 'web_visits_within_days', type: 'number', label: '…within the last (days)' },
  { name: 'visited_page', type: 'string', label: 'Visited a page containing', description: 'For example /subscribe' },
  { name: 'sort', type: 'enum', label: 'Sort by', options: [{ value: 'engagement_desc', label: 'Most engaged first' }, { value: 'signup_desc', label: 'Newest signups first' }, { value: 'last_open_desc', label: 'Most recent opens first' }, { value: 'web_visits_desc', label: 'Most website visits first' }, { value: 'app_events_desc', label: 'Most app activity first' }] },
  { name: 'limit', type: 'number', label: 'Show at most' },
];

const SINGLE_VALUE_FIELDS = new Set(['sort', 'app_event_type']);

// Friendly copy for the form. The server's field descriptions are written for the AI; these are for people.
const FIELD_COPY = {
  source: ['Signed up via', 'Pick one or more places people found us.'],
  status: ['Newsletter status', null],
  is_subscriber: ['On the newsletter list', null],
  signup_after: ['Signed up on or after', null],
  signup_before: ['Signed up on or before', null],
  not_opened_in_days: ['Hasn\u2019t opened in (days)', 'Includes people who never opened. 30 is a good \u201cgone cold\u201d mark.'],
  opened_within_days: ['Opened within the last (days)', null],
  has_app: ['Has the app', null],
  app_events_min: ['At least this many app actions', null],
  app_events_within_days: ['\u2026counting only the last (days)', 'Leave blank to count all time.'],
  app_event_type: ['Only count this app action', null],
  web_visits_min: ['At least this many website visits', null],
  web_visits_within_days: ['\u2026counting only the last (days)', 'Leave blank to count all time.'],
  visited_page: ['Visited a page containing', 'For example /subscribe or /articles/'],
  sort: ['Sort by', 'Engagement blends recent opens, app activity, and website visits.'],
  limit: ['Show at most (people)', 'The total count always covers everyone who matches.'],
};
const OPTION_COPY = {
  engagement_desc: 'Most engaged first', signup_desc: 'Newest signups first', last_open_desc: 'Most recent opens first', web_visits_desc: 'Most website visits first', app_events_desc: 'Most app activity first',
  app_open: 'Opened the app', read_story: 'Read a story', link_click: 'Clicked a link', login: 'Logged in',
};

const PRESETS = [
  { label: 'Instagram, not opened in 30 days', spec: { source: ['instagram'], not_opened_in_days: 30 } },
  { label: 'Most engaged readers', spec: { sort: 'engagement_desc', limit: 100 } },
  { label: 'App users who read 5+ stories', spec: { has_app: true, app_event_type: 'read_story', app_events_min: 5 } },
];

const optValue = (o) => (isPlainObject(o) ? o.value ?? o.name ?? o.id : o);
const optLabel = (o) => (isPlainObject(o) ? o.label ?? o.name ?? String(optValue(o)) : OPTION_COPY[o] || humanize(String(o)));

function isMultiField(f) {
  if (f.multiple !== undefined) return !!f.multiple;
  if (f.multi !== undefined) return !!f.multi;
  const t = String(f.type || '').toLowerCase();
  if (/multi|array|list|\[\]/.test(t)) return true;
  if (SINGLE_VALUE_FIELDS.has(f.name)) return false;
  return false;
}

/** Build one form control for a field. Returns { el, get(), set(v) }. */
function fieldControl(f) {
  const id = `seg-${f.name}`;
  const type = String(f.type || 'string').toLowerCase();
  const copy = FIELD_COPY[f.name];
  const label = copy ? copy[0] : (f.label || humanize(f.name));
  const helpText = copy ? copy[1] : f.description;
  const desc = helpText ? h('span', { class: 'field-help' }, helpText) : null;
  const opts = Array.isArray(f.options) && f.options.length ? f.options : null;
  const multi = isMultiField(f);

  if (opts && multi) {
    const group = h('div', { class: 'checks' });
    const boxes = [];
    const addBox = (o) => {
      const cb = h('input', { type: 'checkbox', value: String(optValue(o)) });
      boxes.push(cb);
      group.append(h('label', { class: 'check' }, cb, h('span', {}, optLabel(o))));
    };
    opts.forEach(addBox);
    return {
      name: f.name,
      el: h('fieldset', { class: 'field' }, h('legend', { class: 'field-label' }, label), desc, group),
      get: () => { const v = boxes.filter((b) => b.checked).map((b) => b.value); return v.length ? v : undefined; },
      set: (v) => {
        const want = new Set((Array.isArray(v) ? v : v === undefined ? [] : [v]).map(String));
        want.forEach((w) => { if (!boxes.some((b) => b.value === w)) addBox(w); });
        boxes.forEach((b) => { b.checked = want.has(b.value); });
      },
    };
  }

  if (opts) {
    const sel = h('select', { id }, h('option', { value: '' }, 'Any'), opts.map((o) => h('option', { value: String(optValue(o)) }, optLabel(o))));
    return {
      name: f.name,
      el: h('label', { class: 'field', for: id }, h('span', { class: 'field-label' }, label), desc, sel),
      get: () => sel.value || undefined,
      set: (v) => {
        const s = v === undefined ? '' : String(v);
        if (s && ![...sel.options].some((o) => o.value === s)) sel.append(h('option', { value: s }, humanize(s)));
        sel.value = s;
      },
    };
  }

  if (type === 'boolean' || type === 'bool') {
    const sel = h('select', { id }, h('option', { value: '' }, 'Any'), h('option', { value: 'true' }, 'Yes'), h('option', { value: 'false' }, 'No'));
    return {
      name: f.name,
      el: h('label', { class: 'field', for: id }, h('span', { class: 'field-label' }, label), desc, sel),
      get: () => (sel.value === '' ? undefined : sel.value === 'true'),
      set: (v) => { sel.value = v === undefined ? '' : String(!!v); },
    };
  }

  const inputType = /number|int|float|integer/.test(type) ? 'number' : type === 'date' ? 'date' : 'text';
  const input = h('input', { id, type: inputType, placeholder: inputType === 'text' ? (multi ? 'e.g. instagram, facebook' : 'Any') : null, min: inputType === 'number' ? (f.min ?? 0) : null, max: f.max ?? null, step: inputType === 'number' ? 1 : null });
  return {
    name: f.name,
    el: h('label', { class: 'field', for: id }, h('span', { class: 'field-label' }, label), desc, input),
    get: () => {
      const raw = input.value.trim();
      if (raw === '') return undefined;
      if (inputType === 'number') { const n = Number(raw); return Number.isFinite(n) ? n : undefined; }
      if (multi) { const parts = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean); return parts.length ? parts : undefined; }
      return raw;
    },
    set: (v) => { input.value = v === undefined || v === null ? '' : Array.isArray(v) ? v.join(', ') : String(v); },
  };
}

async function viewSegments(root) {
  root.append(pageHead('Segments', 'Build a list of readers by mixing and matching filters. Leave anything blank to ignore it.'));
  const presetBar = h('div', { class: 'presets' }, h('span', { class: 'muted small' }, 'Quick starts:'));
  const formBox = h('div', {}, loading('Setting out the filters…'));
  const resultBox = h('section', { class: 'section', 'aria-live': 'polite' });
  root.append(h('section', { class: 'card' }, presetBar, formBox), resultBox);

  let fields;
  try {
    const data = await api('/api/segments/fields');
    fields = asList(data, 'fields');
    if (!fields.length && isPlainObject(data)) {
      fields = Object.entries(data).filter(([, v]) => isPlainObject(v)).map(([name, v]) => ({ name, ...v }));
    }
  } catch (err) {
    if (err.status === 401) return;
    fields = [];
  }
  if (!fields.length) fields = FALLBACK_FIELDS;

  const controls = fields.filter((f) => f && f.name).map(fieldControl);
  const collect = () => {
    const spec = {};
    for (const c of controls) { const v = c.get(); if (v !== undefined) spec[c.name] = v; }
    return spec;
  };
  const runBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Run segment');
  const resetBtn = h('button', { type: 'button', class: 'btn btn-quiet' }, 'Clear filters');
  const form = h('form', { class: 'seg-form' },
    h('div', { class: 'field-grid' }, controls.map((c) => c.el)),
    h('div', { class: 'actions' }, runBtn, resetBtn));
  clear(formBox).append(form);

  const applySpec = (spec) => { for (const c of controls) c.set(spec[c.name]); };
  resetBtn.addEventListener('click', () => { applySpec({}); clear(resultBox); });
  PRESETS.forEach((pr) => presetBar.append(h('button', {
    type: 'button', class: 'btn btn-chip',
    onClick: () => { applySpec(pr.spec); run(pr.spec); },
  }, pr.label)));

  async function run(spec) {
    runBtn.disabled = true;
    clear(resultBox).append(loading('Finding your readers…'));
    try {
      const data = await api('/api/segments', { json: spec });
      clear(resultBox).append(segmentResult(isPlainObject(data?.spec) ? data.spec : spec, data));
    } catch (err) {
      clear(resultBox).append(errorNotice(err));
    } finally { runBtn.disabled = false; }
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); run(collect()); });
}

const SEGMENT_COLUMNS = ['email', 'source', 'status', 'signup_date', 'last_open_date', 'has_app', 'app_events', 'web_visits', 'engagement'];

function segmentResult(spec, data) {
  const rows = asList(data, 'rows');
  const total = typeof data?.total === 'number' ? data.total : rows.length;
  const csvHref = `/api/segments/export.csv?spec=${encodeURIComponent(JSON.stringify(spec))}`;
  const present = new Set(rows.flatMap((r) => Object.keys(r || {})));
  const cols = SEGMENT_COLUMNS.filter((c) => present.has(c));
  for (const k of present) if (!cols.includes(k) && k !== 'id') cols.push(k);

  return h('div', { class: 'stack' },
    h('div', { class: 'result-head' },
      h('div', {},
        h('p', { class: 'big-number' }, fmtNum(total)),
        h('p', { class: 'muted' }, total === 1 ? 'person matches' : 'people match',
          rows.length && rows.length < total ? ` · showing the first ${fmtNum(rows.length)}` : '')),
      h('a', { class: 'btn btn-quiet', href: csvHref, download: 'segment.csv' }, 'Download CSV')),
    rows.length
      ? h('div', { class: 'card card-flush' }, dataTable(rows, {
        columns: cols.length ? cols : undefined,
        cell: (c, r) => {
          if (c === 'email') return r.id !== undefined ? h('a', { href: profileHref(r.id) }, r.email || `Person #${r.id}`) : (r.email || '—');
          if (c === 'status') return statusPill(r.status);
          if (c === 'has_app') return r.has_app ? 'Yes' : 'No';
          if (c === 'engagement' && typeof r.engagement === 'number') return fmtNum(Math.round(r.engagement * 10) / 10);
          return undefined;
        },
      }))
      : empty('No one matches those filters. Try loosening one or two.'),
    h('details', { class: 'details' }, h('summary', {}, 'Show the segment spec (JSON)'),
      h('div', { class: 'code-wrap' }, h('pre', { class: 'code' }, JSON.stringify(spec, null, 2)), copyButton(() => JSON.stringify(spec, null, 2)))));
}

/* ------------------------------------------------------------------ *
 * Assistant
 * ------------------------------------------------------------------ */

const EXAMPLE_PROMPTS = [
  'How many Instagram signups went cold last month?',
  'Build me a list of our most engaged readers',
  'Which pages do new subscribers hit first?',
];

const chat = { history: [], messages: [] };

/** Tiny, safe formatter: paragraphs, line breaks, bullet/numbered lists, **bold**, `code`. */
function richText(text) {
  const frag = document.createDocumentFragment();
  const lines = String(text ?? '').split(/\r?\n/);
  let para = null, list = null, listType = null;
  const inline = (line) => {
    const out = [];
    const re = /\*\*(.+?)\*\*|`([^`]+)`/g;
    let last = 0, m;
    while ((m = re.exec(line))) {
      if (m.index > last) out.push(line.slice(last, m.index));
      out.push(m[1] !== undefined ? h('strong', {}, m[1]) : h('code', {}, m[2]));
      last = re.lastIndex;
    }
    if (last < line.length) out.push(line.slice(last));
    return out;
  };
  const endPara = () => { para = null; };
  const endList = () => { list = null; listType = null; };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const num = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (!line.trim()) { endPara(); endList(); continue; }
    if (bullet || num) {
      endPara();
      const t = bullet ? 'ul' : 'ol';
      if (!list || listType !== t) { list = h(t, {}); listType = t; frag.append(list); }
      list.append(h('li', {}, inline((bullet || num)[1])));
      continue;
    }
    endList();
    if (heading) { endPara(); frag.append(h('p', { class: 'rt-heading' }, inline(heading[1]))); continue; }
    if (!para) { para = h('p', {}); frag.append(para); } else para.append(h('br'));
    append(para, inline(line));
  }
  return frag;
}

function assistantTable(t) {
  if (!t) return null;
  if (Array.isArray(t)) return t.length ? dataTable(t, { small: true }) : null;
  const rows = asList(t.rows);
  if (!rows.length) return h('p', { class: 'muted small' }, 'The table came back empty.');
  let cols = Array.isArray(t.columns) ? t.columns.map((c) => (isPlainObject(c) ? c.name ?? c.key ?? c.label : c)) : undefined;
  return dataTable(rows, { small: true, columns: cols });
}

function assistantSegment(seg) {
  if (!seg || !isPlainObject(seg)) return null;
  const handle = seg.handle ?? seg.id ?? seg.segment_id;
  const href = safeApiHref(seg.csv_url || seg.download_url)
    || (handle !== undefined && handle !== null ? `/api/assistant/segment/${encodeURIComponent(handle)}.csv` : null)
    || (seg.spec ? `/api/segments/export.csv?spec=${encodeURIComponent(JSON.stringify(seg.spec))}` : null);
  return h('div', { class: 'segment-card' },
    h('div', {},
      h('p', { class: 'eyebrow' }, 'Segment ready'),
      h('p', { class: 'segment-total' }, typeof seg.total === 'number' ? `${fmtNum(seg.total)} ${seg.total === 1 ? 'person' : 'people'}` : 'Your list'),
      seg.spec ? h('details', { class: 'details details-inline' }, h('summary', {}, 'Filters used'), h('pre', { class: 'code small' }, JSON.stringify(seg.spec, null, 2))) : null),
    href ? h('a', { class: 'btn btn-quiet', href, download: 'segment.csv' }, 'Download CSV') : null);
}

function summarize(v, max = 1200) {
  if (v === undefined) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  return s.length > max ? s.slice(0, max) + `\n… (${fmtNum(s.length - max)} more characters)` : s;
}

function tracePanel(trace) {
  if (!trace || (Array.isArray(trace) && !trace.length)) return null;
  const list = Array.isArray(trace) ? trace : asList(trace, 'steps', 'entries', 'tools');
  const body = list.length
    ? h('ol', { class: 'trace' }, list.map((t, i) => {
      if (!isPlainObject(t)) return h('li', {}, h('pre', { class: 'code small' }, summarize(t)));
      const tool = t.tool || t.name || t.type || `Step ${i + 1}`;
      const input = t.input ?? t.args ?? t.arguments;
      const output = t.output_summary ?? t.summary ?? t.output ?? t.result;
      const extra = { ...t };
      ['tool', 'name', 'type', 'input', 'args', 'arguments', 'output_summary', 'summary', 'output', 'result'].forEach((k) => delete extra[k]);
      return h('li', { class: 'trace-item' },
        h('p', { class: 'trace-tool' }, h('code', {}, String(tool))),
        input !== undefined ? h('div', {}, h('p', { class: 'trace-label' }, 'Model asked for'), h('pre', { class: 'code small' }, summarize(input))) : null,
        output !== undefined ? h('div', {}, h('p', { class: 'trace-label' }, 'Model was shown'), h('pre', { class: 'code small' }, summarize(output))) : null,
        Object.keys(extra).length ? h('div', {}, h('p', { class: 'trace-label' }, 'Also logged'), h('pre', { class: 'code small' }, summarize(extra))) : null);
    }))
    : h('pre', { class: 'code small' }, summarize(trace, 4000));
  return h('details', { class: 'details trace-panel' },
    h('summary', {}, 'What the AI saw'),
    h('p', { class: 'small muted' }, 'This is exactly what went back and forth with the model. Emails and names are swapped for masked tokens before anything leaves our server.'),
    body);
}

function renderChatMessage(m) {
  if (m.role === 'user') return h('div', { class: 'msg msg-user' }, h('p', {}, m.content));
  if (m.pending) return h('div', { class: 'msg msg-bot' }, loading('Thinking it through…'));
  if (m.error) return h('div', { class: 'msg msg-bot' }, m.error);
  const r = m.response || {};
  return h('div', { class: 'msg msg-bot' },
    h('div', { class: 'rt' }, richText(r.answer || 'I don’t have an answer for that one.')),
    assistantTable(r.table),
    assistantSegment(r.segment),
    tracePanel(r.trace));
}

function viewAssistant(root) {
  root.append(pageHead('Assistant', 'Ask questions in plain English. The assistant builds segments and pulls numbers for you, and it only ever sees masked data, never real emails.'));
  const log = h('div', { class: 'chat-log', 'aria-live': 'polite' });
  const input = h('textarea', { id: 'chat-input', rows: 2, placeholder: 'Ask about readers, segments, or engagement…', maxlength: 2000 });
  const send = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Ask');
  const chips = h('div', { class: 'presets' }, h('span', { class: 'muted small' }, 'Try:'),
    EXAMPLE_PROMPTS.map((p) => h('button', { type: 'button', class: 'btn btn-chip', onClick: () => ask(p) }, p)));
  const auditBox = h('div', { class: 'audit-box' });
  const auditLink = h('button', { type: 'button', class: 'link-button small' }, 'PII audit: check what the model has seen');

  const form = h('form', { class: 'chat-form' },
    h('label', { for: 'chat-input', class: 'sr-only' }, 'Your question'), input, send);

  root.append(h('section', { class: 'card chat' }, log, chips, form),
    h('div', { class: 'section' }, auditLink, auditBox));

  const renderLog = () => {
    clear(log);
    if (!chat.messages.length) {
      log.append(h('div', { class: 'chat-empty' },
        h('p', { class: 'h3' }, 'What would you like to know?'),
        h('p', { class: 'muted' }, 'Pick one of the examples below or type your own question.')));
      return;
    }
    chat.messages.forEach((m) => log.append(renderChatMessage(m)));
    log.scrollTop = log.scrollHeight;
  };

  async function ask(text) {
    const message = String(text || '').trim();
    if (!message || send.disabled) return;
    input.value = '';
    const history = chat.history.slice(-12);
    chat.messages.push({ role: 'user', content: message });
    const pending = { role: 'assistant', pending: true };
    chat.messages.push(pending);
    renderLog();
    send.disabled = true;
    try {
      const res = await api('/api/assistant', { json: { message, history } });
      pending.pending = false;
      pending.response = isPlainObject(res) ? res : { answer: String(res) };
      chat.history.push({ role: 'user', content: message }, { role: 'assistant', content: String(pending.response.answer || '') });
    } catch (err) {
      pending.pending = false;
      pending.error = err.status === 503
        ? h('div', { class: 'notice' }, h('strong', {}, 'The assistant is resting. '),
          'It hasn’t been switched on yet: an Anthropic API key needs to be added on the server. Everything else in the CDP works without it, and Segments can build the same lists by hand.')
        : errorNotice(err);
    } finally {
      send.disabled = false;
      renderLog();
      input.focus();
    }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); ask(input.value); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(input.value); }
  });

  auditLink.addEventListener('click', async () => {
    clear(auditBox).append(loading('Scanning the AI log for personal data…'));
    try {
      clear(auditBox).append(renderAudit(await api('/api/assistant/audit')));
    } catch (err) {
      clear(auditBox).append(errorNotice(err));
    }
  });

  renderLog();
}

function renderAudit(data) {
  const summary = isPlainObject(data?.summary) ? data.summary : isPlainObject(data) ? Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v === 'number' || typeof v === 'boolean')) : {};
  const nums = Object.entries(summary).filter(([, v]) => typeof v === 'number');
  const rows = asList(data, 'rows', 'recent', 'audit', 'entries');
  const emails = summary.emails_seen_by_model ?? summary.emails_seen ?? summary.findings;
  const ids = summary.identifiers_seen_by_model ?? 0;
  const clean = (emails === 0 || emails === undefined) && !ids;
  const other = isPlainObject(summary) ? Object.fromEntries(Object.entries(summary).filter(([, v]) => typeof v !== 'number')) : {};
  return h('div', { class: 'card stack' },
    h('h2', { class: 'h3' }, 'PII audit'),
    h('p', { class: clean ? 'notice notice-ok' : 'notice notice-error' },
      clean ? 'All clear: we re-scanned everything sent to the model and found no emails or other personal identifiers.' : 'Heads up: the scanner flagged something in the AI log. Take a look below.'),
    nums.length ? statGrid(nums, { compact: true }) : null,
    Object.keys(other).length ? kvTable(other) : null,
    rows.length ? h('details', { class: 'details' }, h('summary', {}, `Recent AI log entries (${fmtNum(rows.length)})`),
      dataTable(rows.slice(0, 50), {
        small: true,
        columns: ['created_at', 'direction', 'pii_findings', 'payload'].filter((c) => rows.some((r) => isPlainObject(r) && c in r)),
        cell: (c, r) => (c === 'payload' ? h('details', { class: 'details-inline' }, h('summary', {}, 'View'), h('pre', { class: 'code small' }, summarize(parseMaybeJson(r.payload), 3000)))
          : c === 'direction' ? humanize(r.direction) : undefined),
      })) : null);
}

/* ------------------------------------------------------------------ *
 * Webhooks
 * ------------------------------------------------------------------ */

function viewWebhooks(root) {
  const endpoint = `${location.origin}/webhooks/app`;
  const signing = [
    `POST ${endpoint}`,
    'Content-Type: application/json',
    'X-TPO-Timestamp: <unix seconds>',
    'X-TPO-Signature: v1=<hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>',
  ].join('\n');
  const demo = 'npm run webhook -- --demo';

  root.append(pageHead('Webhooks', 'The app sends events here as they happen. New ones show up below within a few seconds.'));
  root.append(h('div', { class: 'grid-2' },
    h('section', { class: 'card stack' },
      h('h2', { class: 'h3' }, 'Endpoint'),
      h('div', { class: 'code-wrap' }, h('pre', { class: 'code' }, endpoint), copyButton(() => endpoint)),
      h('p', { class: 'small' }, 'Every request must be signed so we know it really came from our app. Send two headers:'),
      h('ul', { class: 'small plain-list' },
        h('li', {}, h('code', {}, 'X-TPO-Timestamp'), ': the current time in unix seconds.'),
        h('li', {}, h('code', {}, 'X-TPO-Signature'), ': ', h('code', {}, 'v1='), ' followed by the hex HMAC-SHA256 of ', h('code', {}, '${timestamp}.${rawBody}'), ' using the shared webhook secret.')),
      h('div', { class: 'code-wrap' }, h('pre', { class: 'code small' }, signing), copyButton(() => signing))),
    h('section', { class: 'card stack' },
      h('h2', { class: 'h3' }, 'Try it'),
      h('p', { class: 'small' }, 'From the project folder, send a batch of realistic demo events (an anonymous visit, a login that stitches the device to a user, and some story reads):'),
      h('div', { class: 'code-wrap' }, h('pre', { class: 'code' }, demo), copyButton(() => demo)),
      h('p', { class: 'small muted' }, 'Events sent before someone logs in are linked to them automatically once their device logs in. That’s the “stitched” label you’ll see in Lookup.'))));

  const status = h('p', { class: 'live small' }, h('span', { class: 'live-dot', 'aria-hidden': 'true' }), h('span', { class: 'live-text' }, 'Connecting…'));
  const pauseBtn = h('button', { type: 'button', class: 'btn btn-quiet btn-sm' }, 'Pause');
  const feed = h('div', {}, loading('Listening for events…'));
  root.append(h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', {}, 'Live feed'), h('div', { class: 'row' }, status, pauseBtn)),
    h('div', { class: 'card card-flush' }, feed)));

  const seen = new Set();
  let first = true, paused = false, busy = false, stopped = false;

  async function poll() {
    if (stopped || paused || busy || document.hidden) return;
    busy = true;
    try {
      const list = asList(await api('/api/events/recent'), 'events');
      if (stopped) return;
      clear(feed);
      if (!list.length) {
        feed.append(empty('No events yet. Run the demo command above and they’ll appear here.'));
      } else {
        const table = dataTable(list, {
          columns: ['received_at', 'event', 'user_id', 'device_id', 'resolved_user_id', 'profile_id'],
          cell: (c, r) => {
            if (c === 'received_at') return fmtDate(r.received_at || r.ts);
            if (c === 'event') return humanize(r.event || '');
            if (c === 'user_id') return r.user_id ? r.user_id : h('span', { class: 'muted' }, 'anonymous');
            if (c === 'device_id') return r.device_id || h('span', { class: 'muted' }, '—');
            if (c === 'resolved_user_id') {
              if (!r.resolved_user_id) return h('span', { class: 'muted' }, 'not yet');
              return !r.user_id ? h('span', {}, r.resolved_user_id, ' ', h('span', { class: 'tag' }, 'stitched')) : r.resolved_user_id;
            }
            if (c === 'profile_id') return r.profile_id ? h('a', { href: profileHref(r.profile_id) }, 'View profile') : h('span', { class: 'muted' }, '—');
            return undefined;
          },
        });
        const trs = table.querySelectorAll('tbody tr');
        list.forEach((r, i) => {
          const key = r.event_id || `${r.received_at}|${r.event}|${r.device_id}`;
          if (!first && !seen.has(key) && trs[i]) trs[i].classList.add('is-new');
          seen.add(key);
        });
        feed.append(table);
      }
      first = false;
      status.querySelector('.live-text').textContent = `Live · checked at ${fmtTime(new Date().toISOString())}`;
      status.classList.remove('is-off');
    } catch (err) {
      if (!stopped) {
        clear(feed).append(errorNotice(err));
        status.querySelector('.live-text').textContent = 'Having trouble connecting. Retrying…';
        status.classList.add('is-off');
      }
    } finally { busy = false; }
  }

  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    status.classList.toggle('is-off', paused);
    status.querySelector('.live-text').textContent = paused ? 'Paused' : 'Resuming…';
    if (!paused) poll();
  });
  const onVisible = () => { if (!document.hidden) poll(); };
  document.addEventListener('visibilitychange', onVisible);
  const timer = setInterval(poll, 3000);
  poll();

  return () => { stopped = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

const ROUTES = {
  overview: { title: 'Overview', view: viewOverview },
  import: { title: 'Import', view: viewImport },
  lookup: { title: 'Lookup', view: viewLookup },
  segments: { title: 'Segments', view: viewSegments },
  assistant: { title: 'Assistant', view: viewAssistant },
  webhooks: { title: 'Webhooks', view: viewWebhooks },
};

let cleanup = null;
let currentRoute = null;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const name = (path || 'overview').split('/')[0];
  return { name: ROUTES[name] ? name : 'overview', params: new URLSearchParams(query) };
}

async function render() {
  const { name, params } = parseHash();
  const main = document.getElementById('main');
  if (!main) return;
  if (typeof cleanup === 'function') { try { cleanup(); } catch { /* ignore */ } }
  cleanup = null;

  document.querySelectorAll('#nav a').forEach((a) => {
    if (a.dataset.route === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.title = `${ROUTES[name].title} · The Pour Over CDP`;

  const changedPage = currentRoute !== name;
  currentRoute = name;
  clear(main);
  const page = h('div', { class: `page page-${name}` });
  main.append(page);
  try {
    const result = ROUTES[name].view(page, params);
    const out = result instanceof Promise ? await result : result;
    if (typeof out === 'function') cleanup = out;
  } catch (err) {
    page.append(errorNotice(err));
  }
  if (changedPage) {
    window.scrollTo(0, 0);
    const active = document.querySelector('#nav a[aria-current="page"]');
    active?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }
}

window.addEventListener('hashchange', render);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
else render();
