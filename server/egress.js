'use strict';
// Where the outbound bytes actually go.
//
// A hosting bill that says "network egress is the primary driver" names one
// number and nothing else, and from inside the process that number is
// unattributable: a player downloading sprites, a player receiving world
// snapshots, and a save being written to a database in someone else's data
// centre are all just "egress". They have completely different fixes, so the
// first thing needed is the split.
//
// This counts the same bytes in three independent places:
//
//   nic   — everything the container actually put on the wire, read from
//           /proc/net/dev (tx on every non-loopback interface). This is the
//           number the bill is computed from, so it is the one to trust when
//           the others disagree with it.
//   http  — response bytes, grouped by what was asked for. Counted AFTER
//           compression: this middleware installs its hook on res.write/end
//           before compression() installs its own, so compression's output
//           passes through ours on the way out and what we see is what goes
//           on the wire, not what the route handed over.
//   ws    — engine.io write buffers, grouped by socket.io event name. This is
//           the live game stream.
//
// The interesting figure is `nic - (http + ws)`. Everything the process sends
// that is not a player download and not the game stream lands there: MongoDB
// writes, Telegram Bot API calls, TON. A managed database outside the hosting
// network is billed exactly like a player download, and nothing inside the app
// would otherwise show it.
//
// Cost of running this: one addition per response and one per socket flush.
// It is safe to leave on permanently, and it is meant to be — an egress bill
// is a trend, and a trend needs a number that was already being recorded when
// the question got asked.

const fs = require('fs');

// ── accumulators ─────────────────────────────────────────────────────────────
// All are cumulative for the life of the process; deltas are computed by the
// reporter against its own previous snapshot, so several readers (the 5-minute
// log line, /health) can each keep their own window without disturbing anyone
// else's. That is deliberately unlike Room.stats(), which resets on read and
// therefore can only have one reader.
const _http = new Map();   // kind -> { n, body, head }
const _ws = new Map();     // event -> { n, bytes }
const _since = Date.now();

function _bump(map, key, bytes, headBytes) {
  let e = map.get(key);
  if (!e) { e = { n: 0, body: 0, head: 0 }; map.set(key, e); }
  e.n++;
  e.body += bytes;
  e.head += headBytes || 0;
  return e;
}

// ── nic ──────────────────────────────────────────────────────────────────────
// Linux only, and absent in some sandboxes — every caller treats null as "not
// available" rather than as zero, because a silent zero here would make the
// unaccounted column read as "nothing else is sending", which is the single
// most misleading thing this file could say.
function nicTx() {
  let raw;
  try { raw = fs.readFileSync('/proc/net/dev', 'utf8'); } catch { return null; }
  let tx = 0;
  for (const line of raw.split('\n')) {
    const m = /^\s*([^:]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const iface = m[1].trim();
    if (iface === 'lo') continue;          // loopback never leaves the box
    const cols = m[2].trim().split(/\s+/);
    // /proc/net/dev columns: 8 receive fields, then 8 transmit; tx bytes is
    // the 9th number on the line.
    const v = Number(cols[8]);
    if (Number.isFinite(v)) tx += v;
  }
  return tx;
}

// ── http ─────────────────────────────────────────────────────────────────────
function httpKind(p) {
  if (p.startsWith('/images')) return 'images';
  if (p.startsWith('/audio')) return 'audio';
  if (p.startsWith('/socket.io')) return 'socket.io-client';
  if (p.startsWith('/api/world-map')) return 'world-map';
  if (p.startsWith('/api') || p.startsWith('/dev') || p.startsWith('/tg-')) return 'api';
  if (p.endsWith('.css')) return 'css';
  if (/\.js(\.map)?$/.test(p) || p.startsWith('/bundle')) return 'js';
  if (p === '/' || p.endsWith('.html')) return 'html';
  return 'other';
}

// Headers are real bytes and a 304 is nothing but headers, so counting only
// bodies would report a revalidation storm as zero traffic — the exact case
// where an immutable-caching mistake hides. Approximate (the real wire form
// depends on the HTTP version and any proxy in front), and kept in its own
// column so it can never be mistaken for measured body bytes.
function _headerBytes(res) {
  let n = 40;                                  // status line + blank line + slack
  const h = res.getHeaders ? res.getHeaders() : {};
  for (const k of Object.keys(h)) n += k.length + String(h[k]).length + 4;
  return n;
}

function httpMiddleware(req, res, next) {
  const kind = httpKind(req.path || req.url || '');
  const _write = res.write;
  const _end = res.end;
  let body = 0;
  const add = (chunk, enc) => {
    if (!chunk || typeof chunk === 'function') return;
    body += Buffer.isBuffer(chunk)
      ? chunk.length
      : Buffer.byteLength(String(chunk), typeof enc === 'string' ? enc : 'utf8');
  };
  res.write = function (chunk, enc, cb) { add(chunk, enc); return _write.call(this, chunk, enc, cb); };
  res.end = function (chunk, enc, cb) {
    add(chunk, enc);
    // Read the headers here rather than on 'finish': by then Node has already
    // released them on some paths and getHeaders() comes back empty.
    _bump(_http, kind, body, _headerBytes(res));
    return _end.call(this, chunk, enc, cb);
  };
  next();
}

// ── websocket ────────────────────────────────────────────────────────────────
// Hooked at the engine.io level, not at socket.io's emit: emit is called with
// objects, and what the bill counts is the encoded form after socket.io has
// serialized it. 'flush' fires with the exact packet list about to be written,
// which is as close to the wire as this can get without patching the transport.
//
// Binary events arrive as two packets — a JSON envelope naming the event with
// placeholders, then the attachment(s) — so the attachment has no name of its
// own. It is charged to the last named event on that same socket, which is
// correct because socket.io writes them back to back and never interleaves.
const _EVENT_RE = /\["([A-Za-z0-9_.:-]+)"/;
// Packets that carry no event name: socket.io's own handshake and teardown.
// Named rather than lumped into 'unnamed', because a connect/disconnect pair
// per socket is precisely the signature of a reconnect loop, and this counter
// would otherwise be the one place it hides.
const _CTRL = { 0: '_connect', 1: '_disconnect', 4: '_error', 6: '_ack' };

function attachSockets(io) {
  io.engine.on('connection', es => {
    let last = 'binary';
    es.on('flush', packets => {
      if (!Array.isArray(packets)) return;
      for (const p of packets) {
        const d = p && p.data;
        if (d == null) { _bump(_ws, `_${p && p.type || 'empty'}`, 1); continue; }
        if (typeof d === 'string') {
          // +1 for the engine.io packet-type character that precedes it.
          const n = Buffer.byteLength(d) + 1;
          if (p.type !== 'message') { _bump(_ws, `_${p.type}`, n); continue; }
          const m = _EVENT_RE.exec(d.length > 96 ? d.slice(0, 96) : d);
          if (m) last = m[1];
          _bump(_ws, m ? m[1] : (_CTRL[d[0]] || 'unnamed'), n);
        } else {
          _bump(_ws, last, d.byteLength || d.length || 0);
        }
      }
    });
  });
}

// ── reading it ───────────────────────────────────────────────────────────────
function _flatten(map) {
  const out = {};
  for (const [k, v] of map) out[k] = { n: v.n, bytes: v.body + v.head, head: v.head };
  return out;
}

function snapshot() {
  return {
    at: Date.now(),
    sinceMs: Date.now() - _since,
    nicTx: nicTx(),
    http: _flatten(_http),
    ws: _flatten(_ws),
  };
}

const _sum = o => Object.values(o).reduce((a, e) => a + e.bytes, 0);

// Difference between two snapshots, with the sums already worked out. `nic`
// is null when /proc/net/dev is unreadable, and `other` is null with it —
// there is no honest way to state what is unaccounted for without a total.
function diff(prev, now) {
  const d = { ms: now.at - prev.at, http: {}, ws: {} };
  for (const [k, v] of Object.entries(now.http)) {
    const p = prev.http[k] || { n: 0, bytes: 0 };
    if (v.bytes > p.bytes || v.n > p.n) d.http[k] = { n: v.n - p.n, bytes: v.bytes - p.bytes };
  }
  for (const [k, v] of Object.entries(now.ws)) {
    const p = prev.ws[k] || { n: 0, bytes: 0 };
    if (v.bytes > p.bytes || v.n > p.n) d.ws[k] = { n: v.n - p.n, bytes: v.bytes - p.bytes };
  }
  d.httpBytes = _sum(d.http);
  d.wsBytes = _sum(d.ws);
  d.nic = (now.nicTx != null && prev.nicTx != null) ? now.nicTx - prev.nicTx : null;
  // Framing and TCP/TLS overhead are not counted above, so this can go
  // slightly negative on a quiet window. Clamped, because a small negative
  // number here means "nothing unaccounted", not "the database received
  // bytes from us".
  d.other = d.nic == null ? null : Math.max(0, d.nic - d.httpBytes - d.wsBytes);
  return d;
}

const mb = n => (n / 1048576).toFixed(1);

// One line, ordered by size, naming only what actually moved. Written for
// someone scrolling a deploy log at speed: the three totals first, then the
// breakdown, so the question "assets, game, or database?" is answered by the
// first half of the line and the follow-up by the second.
function format(d) {
  const top = (o, k) => Object.entries(o).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, k)
    .filter(([, v]) => v.bytes > 0)
    .map(([n, v]) => `${n} ${mb(v.bytes)}`).join(', ');
  const mins = Math.round(d.ms / 60000);
  const parts = [
    d.nic == null ? 'nic n/a' : `nic ${mb(d.nic)}MB`,
    `http ${mb(d.httpBytes)}MB`,
    `ws ${mb(d.wsBytes)}MB`,
  ];
  if (d.other != null) parts.push(`other ${mb(d.other)}MB`);
  let line = `[egress] ${mins}min — ${parts.join(' | ')}`;
  const h = top(d.http, 4), w = top(d.ws, 4);
  if (h) line += `\n          http: ${h}`;
  if (w) line += `\n          ws:   ${w}`;
  if (d.other != null && d.other > d.httpBytes + d.wsBytes) {
    line += '\n          other > http+ws — that is the database and the Telegram API, not players.';
  }
  return line;
}

module.exports = { httpMiddleware, attachSockets, snapshot, diff, format, nicTx };
