'use strict';
// Admin authentication: the blanket per-IP ceiling over every /admin route, the
// login endpoint with its own much stricter brute-force lock, and the adminAuth
// middleware every other group in this directory is handed.
//
// One name comes in. Everything else it needs — the token, the lock, the
// constant-time compare — server/security.js already owned and exported; the
// middleware was simply living in server/index.js away from all of it.
const {
  _adminToken, _verifyAdminToken, _safeEqual,
  _loginLockedUntil, _recordLoginFail, _clearLoginFails, ADMIN_PASSWORD,
} = require('../security');
const REQUIRED_DEPS = ['ADMIN_USERNAME'];

module.exports = function register(app, deps) {
  const missing = REQUIRED_DEPS.filter(k => !deps || deps[k] == null);
  if (missing.length) throw new Error(`auth: missing deps: ${missing.join(', ')}`);
  const { ADMIN_USERNAME } = deps;

  // ── Admin REST API ─────────────────────────────────────────────────────────────
  // Blanket per-IP ceiling over every /admin route. The login endpoint has its
  // own (much stricter) brute-force lock; this covers the rest, where several
  // endpoints run unindexed scans and aggregations — a leaked or brute-forced
  // token shouldn't also be a way to flatten the database. Registered before the
  // routes below so it actually sees them.
  const _ADMIN_RL_WINDOW_MS = 60000;
  const _ADMIN_RL_MAX = 240;
  const _adminHits = new Map(); // ip → { n, resetAt }
  app.use('/admin', (req, res, next) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const e = _adminHits.get(ip);
    if (!e || now > e.resetAt) {
      _adminHits.set(ip, { n: 1, resetAt: now + _ADMIN_RL_WINDOW_MS });
      if (_adminHits.size > 5000) {
        _adminHits.forEach((v, k) => { if (now > v.resetAt) _adminHits.delete(k); });
      }
      return next();
    }
    if (++e.n > _ADMIN_RL_MAX) return res.status(429).json({ error: 'Слишком много запросов' });
    next();
  });

  app.post('/admin/login', (req, res) => {
    if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'Admin disabled' });
    const ip = req.ip || 'unknown';
    const lockedUntil = _loginLockedUntil(ip);
    if (lockedUntil) {
      const mins = Math.ceil((lockedUntil - Date.now()) / 60000);
      return res.status(429).json({ error: `Слишком много попыток. Повторите через ${mins} мин.` });
    }
    const { username, password } = req.body || {};
    // Constant-time compare on both fields so login timing leaks neither.
    const ok = _safeEqual(username, ADMIN_USERNAME) & _safeEqual(password, ADMIN_PASSWORD);
    if (!ok) {
      _recordLoginFail(ip);
      return res.status(401).json({ error: 'Wrong credentials' });
    }
    _clearLoginFails(ip);
    const ts  = Date.now();
    const tok = Buffer.from(JSON.stringify({ ts, sig: _adminToken(ts) })).toString('base64url');
    res.json({ token: tok });
  });


  function adminAuth(req, res, next) {
    const tok = (req.headers.authorization || '').replace('Bearer ', '');
    if (!_verifyAdminToken(tok)) return res.status(401).json({ error: 'Unauthorized' });
    next();
  }

  // Handed to every other group here, so the token check has exactly one
  // implementation and this file is the only place that knows what a valid
  // admin request looks like.
  return { adminAuth };
};
