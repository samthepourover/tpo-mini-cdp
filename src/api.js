/**
 * /api routes (session auth is applied in server.js). /api/assistant* is mounted separately.
 */
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { getDb } from './db.js';
import { config } from './config.js';
import { httpError } from './util.js';
import { ingestCsv, KINDS } from './ingest.js';
import { searchProfiles, getProfile } from './profiles.js';
import { runSegment, segmentFields, validateSpec } from './segments.js';
import { overview, sourceStats, pageStats, coldBySource } from './stats.js';

export const apiRouter = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  // Skip (rather than error on) non-CSV files so multer still drains the request body; the handler then
  // returns a clean 400 instead of the client seeing a connection reset mid-upload.
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname || '').toLowerCase() !== '.csv') { req.rejectedUpload = true; return cb(null, false); }
    cb(null, true);
  },
});

/** Run multer and translate its errors into clean 4xx responses. */
const singleCsv = (req, res, next) =>
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      return next(httpError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
        err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 25 MB)' : `Upload error: ${err.message}`));
    }
    next(err);
  });

const db = () => getDb();

apiRouter.post('/import/:kind', singleCsv, (req, res) => {
  if (!KINDS.includes(req.params.kind)) throw httpError(400, `Unknown import kind. Expected one of: ${KINDS.join(', ')}`);
  if (req.rejectedUpload) throw httpError(400, 'Only .csv files are accepted');
  if (!req.file) throw httpError(400, 'Attach a CSV in the multipart field "file"');
  // ingestCsv runs relinkAll() after loading (report.linking holds the counts)
  const report = ingestCsv(db(), req.params.kind, req.file.buffer, path.basename(req.file.originalname || ''));
  res.json(report);
});

apiRouter.get('/imports', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const rows = db().prepare('SELECT id, kind, filename, rows_in, rows_loaded, report, created_at FROM imports ORDER BY id DESC LIMIT ?').all(limit);
  res.json(rows.map((r) => ({ ...r, report: safeJson(r.report) })));
});

apiRouter.get('/overview', (_req, res) => res.json(overview(db())));

apiRouter.get('/stats/sources', (req, res) => res.json(sourceStats(db(), { coldDays: req.query.coldDays })));
apiRouter.get('/stats/pages', (req, res) => res.json(pageStats(db(), { newSubscribersDays: req.query.days, limit: req.query.limit })));
apiRouter.get('/stats/cold-by-source', (req, res) => res.json(coldBySource(db(), { month: req.query.month, coldDays: req.query.coldDays })));

apiRouter.get('/profiles', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
  res.json(searchProfiles(db(), q, req.query.limit));
});

apiRouter.get('/profiles/:id', (req, res) => {
  if (!/^\d+$/.test(req.params.id)) throw httpError(400, 'Profile id must be numeric');
  const p = getProfile(db(), Number(req.params.id));
  if (!p) throw httpError(404, 'Profile not found');
  res.json(p);
});

apiRouter.post('/segments', (req, res) => {
  const spec = req.body ?? {};
  const { total, rows, spec: normalized } = runSegment(db(), spec, { offset: req.query.offset });
  res.json({ total, rows, spec: normalized });
});

apiRouter.get('/segments/fields', (_req, res) => res.json(segmentFields(db())));

apiRouter.get('/segments/export.csv', (req, res) => {
  let spec = {};
  if (typeof req.query.spec === 'string' && req.query.spec.trim()) {
    try { spec = JSON.parse(req.query.spec); } catch { throw httpError(400, 'spec must be URL-encoded JSON'); }
  }
  const s = validateSpec(spec);
  // Export the whole segment unless the spec itself asked for a limit.
  const { rows } = runSegment(db(), s, { limit: s.limit ?? 100000 });
  const cols = ['id', 'email', 'source', 'status', 'signup_date', 'last_open_date', 'is_subscriber', 'has_app', 'app_events', 'web_visits', 'engagement'];
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvCell(r[c])).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="segment-${config.today}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send('﻿' + lines.join('\r\n') + '\r\n');
});

apiRouter.get('/events/recent', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const rows = db().prepare(`SELECT event_id, event, user_id, device_id, ts, properties, received_at, resolved_user_id, profile_id
    FROM app_events ORDER BY received_at DESC, ts DESC LIMIT ?`).all(limit);
  res.json(rows.map((r) => ({ ...r, properties: safeJson(r.properties) })));
});

function safeJson(s) {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return s; }
}

/**
 * CSV cell escaping with formula-injection guard: values starting with = + - @ (or tab / CR, which some
 * spreadsheet apps also treat as formula starts) are prefixed with a single quote.
 */
export function csvCell(v) {
  if (v == null) return '';
  let s = typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
