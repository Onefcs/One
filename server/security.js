'use strict';
// Authentication, identity and abuse limits — the checks that decide whether a
// request is who it claims to be. Split out of server/index.js, verbatim.
//
// Nothing here touches a model, a socket or any game state: it depends only on
// process env and the shared catalog. That self-containment is what made it the
// first thing worth lifting out of an 11,000-line file — it can be read, and
// tested, entirely on its own.
const crypto = require('crypto');
const { CLAN_DESC_MAX_CHARS } = require('../shared/definitions');

const _TG_TOKEN      = process.env.TG_BOT_TOKEN   || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

// A display name is bounded in BOTH characters and bytes: the character limit
// is what a player sees, the byte limit is what stops a name made of 4-byte
// emoji from being twenty times the size the count suggests.
const _USERNAME_MAX_CHARS = 32;
const _USERNAME_MAX_BYTES = 200;

// Per-IP failed-attempt tracker: after LOGIN_MAX_FAILS failures the IP is locked
// out for LOGIN_LOCK_MS. A successful login clears the counter. In-memory (this
// process holds all state anyway); good enough to blunt online password guessing.
const _loginFails = new Map(); // ip → { n, lockedUntil }
const LOGIN_MAX_FAILS = 8;
const LOGIN_LOCK_MS   = 15 * 60 * 1000;

function _sanitizeName(raw) {
  let s = String(raw == null ? '' : raw)
    // Control characters, markup delimiters and quote marks — everything
    // that could either spoof a name visually or break out of an HTML
    // context somewhere downstream.
    .replace(/[\u0000-\u001f\u007f<>&"'`\\]/g, '')
    .trim()
    .slice(0, _USERNAME_MAX_CHARS);
  while (Buffer.byteLength(s, 'utf8') > _USERNAME_MAX_BYTES) s = s.slice(0, -1);
  return s;
}

// Same cleaning, with the "nothing usable left" fallback the login paths need.
// Clan names use _sanitizeName directly instead, so that a clan legitimately
// called "tg_something" isn't mistaken for the fallback.
function _safeUsername(raw, telegramId) {
  return _sanitizeName(raw) || `tg_${telegramId}`;
}

// Same character-stripping as _sanitizeName, but for the clan description
// (CLAN_DESC_MAX_CHARS, well past _sanitizeName's 32-char username cap)
// rather than a display name.
function _sanitizeClanDesc(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f<>&"'`\\]/g, '')
    .trim()
    .slice(0, CLAN_DESC_MAX_CHARS);
}

// Login Widget verification (browser button)
function verifyTelegramAuth(data) {
  const { hash, ...rest } = data;
  if (!hash) return false;
  // No token configured means no signature can be trusted: the HMAC below
  // would be computed with an empty key, which anyone can reproduce, so an
  // unconfigured deployment would accept a forged login for ANY telegramId.
  // Fail closed instead.
  if (!_TG_TOKEN) return false;
  const checkStr = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(_TG_TOKEN).digest();
  const computed = crypto.createHmac('sha256', secret).update(checkStr).digest('hex');
  if (computed !== hash) return false;
  if (Date.now() / 1000 - Number(data.auth_date) > 86400) return false;
  return true;
}

// Mini App verification (opened inside Telegram app) — different secret derivation.
// Returns { user, startParam } — startParam is Telegram's own start_param field,
// present when the app was opened via a t.me/<bot>?startapp=... deep link (the
// Mini App equivalent of a bot's ?start= deep link, but it opens the game
// directly with no intermediate "press START in the bot chat" step — see
// _refLink()/the referral registration in loginTelegramWebApp below).
function verifyTelegramWebApp(initData) {
  try {
    // Fail closed with no token — see the matching guard in verifyTelegramAuth:
    // an HMAC keyed on the empty string is one anybody can compute, so a
    // deployment that forgot TG_BOT_TOKEN would accept a forged login for any
    // account rather than refusing every login.
    if (!_TG_TOKEN) return null;
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const checkStr = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(_TG_TOKEN).digest();
    const computed = crypto.createHmac('sha256', secret).update(checkStr).digest('hex');
    if (computed !== hash) return null;
    if (Date.now() / 1000 - Number(params.get('auth_date')) > 86400) return null;
    const userStr = params.get('user');
    if (!userStr) return null;
    return { user: JSON.parse(userStr), startParam: params.get('start_param') || '' };
  } catch { return null; }
}

// ── Admin auth helpers ─────────────────────────────────────────────────────────
function _adminToken(ts) {
  return crypto.createHmac('sha256', ADMIN_PASSWORD || 'disabled').update(`adm:${ts}`).digest('hex');
}

function _verifyAdminToken(raw) {
  if (!ADMIN_PASSWORD) return false;
  try {
    const { ts, sig } = JSON.parse(Buffer.from(raw, 'base64url').toString());
    if (Date.now() - ts > 7 * 86400000) return false;
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(_adminToken(ts)));
  } catch { return false; }
}

function _loginLockedUntil(ip) {
  const e = _loginFails.get(ip);
  return e && e.lockedUntil > Date.now() ? e.lockedUntil : 0;
}

function _recordLoginFail(ip) {
  const e = _loginFails.get(ip) || { n: 0, lockedUntil: 0 };
  e.n += 1;
  if (e.n >= LOGIN_MAX_FAILS) { e.lockedUntil = Date.now() + LOGIN_LOCK_MS; e.n = 0; }
  _loginFails.set(ip, e);
  // One entry per IP that ever failed a login, kept forever, is a slow leak
  // that a spray across many source addresses turns into a fast one. Drop
  // entries that are neither locked nor recently active whenever the map grows
  // past a sane size.
  if (_loginFails.size > 5000) {
    const now = Date.now();
    _loginFails.forEach((v, k) => { if (v.lockedUntil <= now && v.n === 0) _loginFails.delete(k); });
  }
}

// Constant-time string compare that never throws on length mismatch.
function _safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) { crypto.timingSafeEqual(ba, ba); return false; }
  return crypto.timingSafeEqual(ba, bb);
}

// Everything below sends with parse_mode:'HTML', and several of the values
// interpolated into those messages come from the player — the deposit memo and
// the withdrawal address are typed straight into the client, and a display
// name falls back to Telegram's first_name. Unescaped, a player could close a
// tag and write their own lines into the message the admin reads before
// pressing ✅ — a different amount, a fake "already verified" note — or simply
// break the markup so Telegram rejects the send and the request never appears.
function _tgEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A successful login clears that IP's failure streak. Exported rather than
// letting the caller reach into _loginFails, which is the whole point of the
// map living here.
function _clearLoginFails(ip) { _loginFails.delete(ip); }

module.exports = {
  _sanitizeName, _safeUsername, _sanitizeClanDesc,
  verifyTelegramAuth, verifyTelegramWebApp,
  _adminToken, _verifyAdminToken, _safeEqual,
  _loginLockedUntil, _recordLoginFail, _clearLoginFails, _tgEsc,
  ADMIN_PASSWORD,
};
