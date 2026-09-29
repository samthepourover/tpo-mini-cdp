import crypto from 'node:crypto';
import { config } from './config.js';

/** Normalize an email: trim, lowercase, strip mailto:, reject junk. Returns null if invalid. */
export function normEmail(v) {
  if (v == null) return null;
  let s = String(v).trim().toLowerCase().replace(/^mailto:/, '').replace(/^["'<]+|[">']+$/g, '');
  if (!s || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  return s;
}

/** Keyed pseudonym for an email (or any identifier). Stable, not reversible without the key. */
export function pseudonym(value, prefix = 'p') {
  if (value == null) return null;
  const h = crypto.createHmac('sha256', config.piiHashKey).update(String(value)).digest('hex');
  return `${prefix}_${h.slice(0, 12)}`;
}

/** Parse many date formats to YYYY-MM-DD (UTC). Returns null if unparseable. */
export function normDate(v) {
  const iso = normTimestamp(v);
  return iso ? iso.slice(0, 10) : null;
}

/** Parse many timestamp formats to ISO-8601 UTC. Returns null if unparseable. */
export function normTimestamp(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || /^(null|none|n\/a|na|-|nan|undefined)$/i.test(s)) return null;
  if (/^\d{10}(\.\d+)?$/.test(s)) return new Date(Number(s) * 1000).toISOString();
  if (/^\d{13}$/.test(s)) return new Date(Number(s)).toISOString();
  let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) { // assume US M/D/Y
    let [, mo, d, y, hh = '0', mi = '0', ss = '0'] = m;
    if (y.length === 2) y = '20' + y;
    const dt = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss));
    // Reject impossible dates (e.g. 13/45/2026) instead of letting Date roll them over.
    if (isNaN(dt) || dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d) return null;
    return dt.toISOString();
  }
  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) { // reject impossible Y-M-D (e.g. 2026-02-30) which V8 would roll over
    const probe = new Date(Date.UTC(+ymd[1], +ymd[2] - 1, +ymd[3]));
    if (probe.getUTCMonth() !== +ymd[2] - 1 || probe.getUTCDate() !== +ymd[3]) return null;
  }
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) || /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : s.replace(' ', 'T') + 'Z';
  const dt = new Date(withZone);
  return isNaN(dt) ? null : dt.toISOString();
}

/** Lowercase/trim a categorical value; null for blanks. */
export function normCat(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  return s && !/^(null|none|n\/a|na|-|nan|undefined)$/.test(s) ? s : null;
}

export function httpError(status, message) {
  const e = new Error(message); e.status = status; e.expose = true; return e;
}
