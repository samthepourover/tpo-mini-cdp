/**
 * PII scanner / tokenizer used by the AI assistant.
 *
 * No dependencies, no I/O. Three jobs:
 *   1. redactText(text, ctx)  – replace identifiers in free text with typed placeholders ([EMAIL_1]).
 *                               The placeholder -> real value map stays server-side in `ctx`.
 *   2. scanForPII(obj)        – recursively scan any JSON-able payload headed to the model; replace
 *                               anything identifying and count what was found (the last-line guard).
 *   3. sanitizePagePath(page) – page paths/URLs can embed emails or tokens in query strings
 *                               (/welcome?email=jane%40x.com). Strip queries, mask id-like segments.
 *
 * Pseudonyms produced by util.pseudonym() look like `sub_0123456789ab` (prefix + 12 hex). They are
 * deliberately NOT matched by any pattern here, so they can pass through to the model.
 */

/** Order matters: more specific patterns first (url-encoded email before plain email, uuid before hex). */
export const PII_PATTERNS = [
  // jane%40example.com (url-encoded @, common in page paths / query strings)
  { type: 'EMAIL', re: /[a-z0-9._%+'-]+%40[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi },
  // Jane.Doe+promo@Example.co.uk  (any case, plus-addressing, subdomains)
  { type: 'EMAIL', re: /[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi },
  // obfuscated "jane at example dot com"
  { type: 'EMAIL', re: /\b[a-z0-9._%+-]+\s+(?:\[at\]|\(at\)|at)\s+[a-z0-9-]+\s+(?:\[dot\]|\(dot\)|dot)\s+[a-z]{2,}\b/gi },
  // UUIDs (visitor ids, device ids, tokens)
  { type: 'ID', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  // app user ids: u_1a2b3c, usr_..., user-...   (must contain a digit, >= 4 chars, so "user_id" is not hit)
  { type: 'USER_ID', re: /\b(?:u|usr|user)[_-](?=[0-9a-z]*\d)[0-9a-z]{4,}\b/gi },
  // device ids: d_..., dev_..., device-...
  { type: 'DEVICE_ID', re: /\b(?:d|dev|device)[_-](?=[0-9a-z]*\d)[0-9a-z]{4,}\b/gi },
  // web visitor ids: v_..., vis_..., visitor-..., anon_...
  { type: 'VISITOR_ID', re: /\b(?:v|vis|visitor|anon)[_-](?=[0-9a-z]*\d)[0-9a-z]{4,}\b/gi },
  // long hex / base64url-ish tokens (hashes, session tokens). 20+ hex chars; pseudonyms are 12 so pass.
  { type: 'TOKEN', re: /\b[0-9a-f]{20,}\b/gi },
  // phone numbers: +1 (555) 123-4567, 555.123.4567, +44 20 7946 0958. Requires separators or a leading +
  // so plain counts / unix timestamps are not hit.
  { type: 'PHONE', re: /(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b|\+\d{1,3}[\s.-]?\d{2,4}[\s.-]\d{3,4}[\s.-]\d{3,4}\b|\+\d{10,14}\b/g },
];

/** A placeholder we issued ourselves ([EMAIL_1]) – never re-redacted. */
export const PLACEHOLDER_RE = /\[(EMAIL|PHONE|USER_ID|DEVICE_ID|VISITOR_ID|ID|TOKEN)_(\d+)\]/g;

/** Per-request redaction context. `map` is placeholder -> original value (server-side only). */
export function createRedactionContext() {
  return { map: new Map(), reverse: new Map(), counters: {}, findings: 0 };
}

function placeholderFor(ctx, type, value) {
  const key = `${type}:${value.toLowerCase()}`;
  if (ctx.reverse.has(key)) return ctx.reverse.get(key);
  ctx.counters[type] = (ctx.counters[type] || 0) + 1;
  const ph = `[${type}_${ctx.counters[type]}]`;
  ctx.map.set(ph, value);
  ctx.reverse.set(key, ph);
  return ph;
}

/**
 * Replace identifiers in `text` with typed placeholders.
 * Returns { text, findings: [{type, placeholder}], count }. Pass a shared ctx to keep numbering / the
 * reverse map consistent across a whole request (message + history).
 */
export function redactText(text, ctx = createRedactionContext()) {
  if (text == null) return { text, findings: [], count: 0 };
  let out = String(text);
  const findings = [];
  for (const { type, re } of PII_PATTERNS) {
    out = out.replace(re, (m) => {
      const value = type === 'EMAIL' ? m.replace(/%40/gi, '@') : m;
      const placeholder = placeholderFor(ctx, type, value);
      findings.push({ type, placeholder });
      return placeholder;
    });
  }
  ctx.findings += findings.length;
  return { text: out, findings, count: findings.length };
}

/** Count-only report for a string (does not keep the values). */
export function piiReport(text) {
  const { findings } = redactText(text, createRedactionContext());
  const byType = {};
  for (const f of findings) byType[f.type] = (byType[f.type] || 0) + 1;
  return { total: findings.length, byType };
}

/** True if the string contains anything the scanner would redact. */
export function containsPII(text) {
  return piiReport(text).total > 0;
}

/**
 * Recursively scan a JSON-able value. Every string (values AND object keys) is passed through
 * redactText. Returns { value: <redacted deep copy>, count, byType }.
 * `skipKeys`: keys whose values are opaque and must not be altered (e.g. thinking-block signatures,
 * tool_use ids) – they are still counted if they match, but left untouched.
 */
export function scanForPII(obj, { ctx = createRedactionContext(), skipKeys = [] } = {}) {
  const skip = new Set(skipKeys);
  const byType = {};
  let count = 0;
  const note = (findings) => {
    for (const f of findings) { byType[f.type] = (byType[f.type] || 0) + 1; count++; }
  };
  const walk = (v, key) => {
    if (typeof v === 'string') {
      const r = redactText(v, ctx);
      note(r.findings);
      return skip.has(key) ? v : r.text;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, val] of Object.entries(v)) {
        const rk = redactText(k, ctx);
        note(rk.findings);
        o[rk.text] = walk(val, k);
      }
      return o;
    }
    return v;
  };
  const value = walk(obj, null);
  return { value, count, byType };
}

/** Replace our own placeholders in `text` with the original values (for the human only). */
export function rehydrateText(text, ctx) {
  if (!text || !ctx) return text;
  return String(text).replace(PLACEHOLDER_RE, (m) => ctx.map.get(m) ?? m);
}

/**
 * Make a page path safe to show the model:
 *   - drop scheme/host, query string and fragment (utm params, ?email=, ?token=)
 *   - decode %40 etc. then mask any path segment that contains PII or looks like an opaque id
 *   - lowercase, collapse trailing slash
 */
export function sanitizePagePath(page) {
  if (page == null) return null;
  let p = String(page).trim();
  if (!p) return null;
  p = p.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, ''); // strip origin
  p = p.split(/[?#]/)[0];
  if (!p.startsWith('/')) p = '/' + p;
  const segs = p.split('/').map((seg) => {
    if (!seg) return seg;
    let dec = seg;
    try { dec = decodeURIComponent(seg); } catch { /* keep raw */ }
    if (containsPII(dec) || containsPII(seg)) return ':redacted';
    if (/^\d{4,}$/.test(dec) || /^[0-9a-f]{12,}$/i.test(dec)) return ':id';
    if (/[A-Za-z0-9_-]{24,}/.test(dec) && /\d/.test(dec) && /[a-z]/i.test(dec)) return ':token';
    return dec.toLowerCase();
  });
  let out = segs.join('/');
  if (out.length > 1) out = out.replace(/\/+$/, '');
  return out.slice(0, 200) || '/';
}
