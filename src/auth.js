import express from 'express';
import crypto from 'node:crypto';
import { config } from './config.js';

const COOKIE = 'tpo_session';
const TTL_MS = 12 * 60 * 60 * 1000;

const sign = (v) => crypto.createHmac('sha256', config.sessionSecret).update(v).digest('base64url');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function issue(res) {
  const exp = String(Date.now() + TTL_MS);
  res.cookie(COOKIE, `${exp}.${sign(exp)}`, {
    httpOnly: true, sameSite: 'strict', secure: config.isProd, maxAge: TTL_MS, path: '/',
  });
}

function valid(req) {
  const raw = req.cookies?.[COOKIE];
  if (!raw) return false;
  const [exp, mac] = raw.split('.');
  return !!exp && !!mac && safeEq(mac, sign(exp)) && Number(exp) > Date.now();
}

// naive in-memory login throttle
const attempts = new Map();
function throttled(ip) {
  const now = Date.now();
  const a = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  attempts.set(ip, a);
  return a.length >= 10;
}

export const authRouter = express.Router();

authRouter.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  if (throttled(req.ip)) {
    if (req.is('application/json')) return res.status(429).json({ error: 'Too many attempts, try later' });
    return res.redirect('/login?error=2');
  }
  const pw = req.body?.password ?? '';
  if (!safeEq(pw, config.appPassword)) {
    attempts.get(req.ip).push(Date.now());
    if (req.is('application/json')) return res.status(401).json({ error: 'Wrong password' });
    return res.redirect('/login?error=1');
  }
  issue(res);
  if (req.is('application/json')) return res.json({ ok: true });
  res.redirect('/');
});

authRouter.post('/logout', (_req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.redirect('/login'); });
authRouter.get('/api/session', (req, res) => res.json({ authenticated: valid(req) }));

export function requireAuth(req, res, next) {
  if (valid(req)) return next();
  if (req.path.startsWith('/api') || req.originalUrl.startsWith('/api')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
}
