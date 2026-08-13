#!/usr/bin/env node
'use strict';
// Boots the REAL server against the in-memory mongoose double (dev/mongo-memory.js)
// and drives it with real socket.io clients.
//
//   node dev/harness.js            run every scenario
//   node dev/harness.js login      run the ones whose name contains "login"
//
// dev/local.js is the launcher for playing locally; this is the one for
// checking that a change did what it was supposed to. It exists because
// mongodb-memory-server cannot fetch a mongod binary in every environment (a
// locked-down runner, an agent sandbox, no network), and without it the server
// is never once started before a change ships — which is not a defensible way
// to touch an economy.
//
// Nothing is mocked except the database and the clock-free bits of Telegram:
// server/index.js is required unmodified, the socket handlers are the real
// ones, the room simulation really ticks, and the clients speak the real
// protocol over a real websocket.

const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const memory = require('./mongo-memory');

// ── Install the double before anything requires mongoose ─────────────────────
// The models call require('mongoose') at load time, so the interception has to
// be in place before server/index.js is pulled in.
const _load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'mongoose') return memory;
  return _load.call(this, request, parent, isMain);
};

const PORT = Number(process.env.HARNESS_PORT || 3111);
Object.assign(process.env, {
  MONGODB_URI: 'mongodb://127.0.0.1:27017/harness',
  PORT: String(PORT),
  DEV_LOCAL: '1',
  // Never a real token — it only signs the initData that /dev/init-data hands
  // out, and is verified by the same secret on the way back in.
  TG_BOT_TOKEN: 'harness-token',
  TG_BOT_USERNAME: 'harness_bot',
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'admin',
  GAME_URL: `http://127.0.0.1:${PORT}`,
  // Keep the movement guard measuring but never acting, so a scenario that
  // teleports a client on purpose isn't fighting it.
  MOVE_GUARD: process.env.MOVE_GUARD || 'log',
});

const BASE = `http://127.0.0.1:${PORT}`;
const io = require('socket.io-client');

// ── Tiny assertion kit ───────────────────────────────────────────────────────
let passed = 0, failed = 0;
const results = [];
function ok(cond, msg, detail) {
  if (cond) { passed++; results.push(['PASS', msg, '']); }
  else { failed++; results.push(['FAIL', msg, detail === undefined ? '' : String(detail)]); }
}
const eq = (got, want, msg) => ok(got === want, msg, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Waits for one event, or rejects with something readable rather than a bare
// timeout — a scenario that hangs should say which message never arrived.
function waitFor(sock, event, { timeout = 8000, where = '' } = {}) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      sock.off(event, on);
      reject(new Error(`timed out after ${timeout}ms waiting for '${event}'${where ? ' (' + where + ')' : ''}`));
    }, timeout);
    const on = payload => { clearTimeout(t); sock.off(event, on); resolve(payload); };
    sock.on(event, on);
  });
}

// ── A logged-in client ───────────────────────────────────────────────────────
// Goes through the same path a browser does: ask the dev route for signed
// initData, then loginTelegramWebApp with it.
async function connectAs(name) {
  const res = await fetch(`${BASE}/dev/init-data?dev=${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`/dev/init-data ${res.status} for ${name}`);
  const { initData, user } = await res.json();

  const sock = io(BASE, { transports: ['websocket'], upgrade: false, forceNew: true });
  const seen = new Map();          // event -> last payload, for assertions after the fact
  const counts = new Map();
  sock.onAny((ev, payload) => {
    seen.set(ev, payload);
    counts.set(ev, (counts.get(ev) || 0) + 1);
  });

  await waitFor(sock, 'connect', { where: `connect ${name}` });
  const authOk = waitFor(sock, 'authOk', { where: `authOk ${name}` });
  sock.emit('loginTelegramWebApp', { initData });
  const auth = await authOk;

  return {
    name, sock, user, auth, seen, counts,
    last: ev => seen.get(ev),
    count: ev => counts.get(ev) || 0,
    wait: (ev, opts) => waitFor(sock, ev, { where: name, ...opts }),
    emit: (ev, payload) => sock.emit(ev, payload),
    close: () => new Promise(r => { sock.close(); setTimeout(r, 50); }),
  };
}

// Joins the world and waits for the server to actually place the character.
async function enterWorld(c, type, savedStats) {
  const start = c.wait('gameStart', { where: `${c.name} gameStart` });
  c.emit('selectChar', { type, savedStats: savedStats || null });
  return start;
}

// ── Scenarios ────────────────────────────────────────────────────────────────
const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

scenario('login: a fresh account authenticates and is told it is new', async () => {
  const c = await connectAs('harness_new');
  ok(c.auth && typeof c.auth.username === 'string', 'authOk carries a username');
  eq(c.auth.isNewAccount, true, 'a first login reports isNewAccount');
  eq(typeof c.auth.gramBalance, 'number', 'authOk carries a GRAM balance');
  await c.close();
});

scenario('login: the second login of the same account is not new', async () => {
  const c1 = await connectAs('harness_repeat');
  await c1.close();
  await sleep(120);
  const c2 = await connectAs('harness_repeat');
  eq(c2.auth.isNewAccount, false, 'a returning account is not reported as new');
  await c2.close();
});

scenario('world: selectChar places the character and sends the map', async () => {
  const c = await connectAs('harness_world');
  const start = await enterWorld(c, 'mage');
  // The map itself is fetched over HTTP and cached by the browser — only its
  // version travels on gameStart. See the emit in server/index.js.
  ok(start && typeof start.mapVersion === 'string', 'gameStart carries the map version');
  ok(start.spawn && Number.isFinite(start.spawn.x), 'gameStart carries a server-side spawn');
  ok(Array.isArray(start.enemies), 'gameStart carries an enemy snapshot');
  await c.close();
});

scenario('world: the room ticks, and goes quiet when nothing is happening', async () => {
  const c = await connectAs('harness_tick');
  await enterWorld(c, 'ranger');
  await c.wait('gameState', { timeout: 4000 });
  // Deliberately NOT "arrives repeatedly": a player alone with nothing in
  // range gets one packet and then silence until something changes (see the
  // idle-cast skip in Room.js). Asserting a steady stream here would be
  // asserting that the interest management is broken.
  const idle = c.count('gameState');
  await sleep(600);
  ok(c.count('gameState') - idle <= 2, `an idle client is not spammed (${c.count('gameState') - idle} in 600ms)`);
  // Moving is a change, so the stream resumes.
  for (let i = 0; i < 12; i++) { c.emit('playerMove', { x: 1380 + i * 6, y: 1380, facing: 1, moving: true }); await sleep(45); }
  await sleep(400);
  ok(c.count('gameState') > idle, 'state resumes once the player moves');
  await c.close();
});

scenario('save: progress round-trips through the database', async () => {
  const c = await connectAs('harness_save');
  await enterWorld(c, 'lev');
  // Level stays at 1 on purpose: the XP ledger only credits what the server
  // itself granted, so claiming a level here would (correctly) be capped and
  // the scenario would be testing the cap rather than the round trip. Gold sits
  // inside GOLD_GROWTH_SLACK for the same reason.
  c.emit('saveProgress', { stats: {
    type: 'lev', lvl: 1, xp: 0, gold: 250, kills: 7,
    hp: 100, maxHp: 100, inventory: [], storage: [], equipment: {},
    hudPotion: 'pt1', lang: 'en',
    savedAt: Date.now(), invRev: 0,
  } });
  await sleep(3400);   // the server debounces its write by 3s
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  ok(row, 'the player row exists');
  const sd = (row && row.savedData) || {};
  eq(sd.gold, 250, 'gold reached the database');
  eq(sd.kills, 7, 'kills reached the database');
  eq(sd.lang, 'en', 'settings reached the database');
  await c.close();
});

scenario('anti-cheat: the XP ledger is armed, not silently disabled', async () => {
  // Regression guard. _xpCeilingFor once returned NaN because its constants
  // lived in another module, and every comparison against NaN is false — so the
  // ledger accepted any level at all and said nothing. A cap that is off is
  // indistinguishable from a cap that passes unless something asserts the
  // entitlement is a real number.
  const { _xpCeilingFor, XP_JOIN_SLACK_KILLS } = require('../server/anticheat');
  ok(Number.isFinite(_xpCeilingFor(100)), `_xpCeilingFor returns a number (${_xpCeilingFor(100)})`);
  ok(_xpCeilingFor(100) > 100, 'and it is a ceiling above the raw figure');
  ok(Number.isFinite(XP_JOIN_SLACK_KILLS), 'the join slack is a number');
});

scenario('anti-cheat: a save claiming impossible level is capped', async () => {
  const c = await connectAs('harness_forge');
  await enterWorld(c, 'mage');
  const sync = c.wait('xpSync', { timeout: 5000 }).catch(() => null);
  c.emit('saveProgress', { stats: {
    type: 'mage', lvl: 900, xp: 0, gold: 0, kills: 0, hp: 10, maxHp: 10,
    inventory: [], storage: [], equipment: {}, savedAt: Date.now(), invRev: 0,
  } });
  const got = await sync;
  ok(got && got.lvl < 900, `a forged level is corrected (xpSync lvl=${got && got.lvl})`);
  await c.close();
});

scenario('progression: learning a passive without the book is refused', async () => {
  const c = await connectAs('harness_passive');
  await enterWorld(c, 'mage');
  const err = c.wait('progressError', { timeout: 5000 }).catch(() => null);
  c.emit('learnPassive', { id: 'allhp' });
  const got = await err;
  ok(got && got.msg, `refused with a message (${got && got.msg})`);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  const lvl = row && row.savedData && row.savedData.passiveLevels && row.savedData.passiveLevels.allhp;
  ok(!lvl, 'and nothing was written to the database');
  await c.close();
});

scenario('progression: a save cannot write passive levels the server did not grant', async () => {
  const c = await connectAs('harness_pin');
  await enterWorld(c, 'mage');
  c.emit('saveProgress', { stats: {
    type: 'mage', lvl: 1, xp: 0, gold: 0, kills: 0, hp: 10, maxHp: 10,
    inventory: [], storage: [], equipment: {},
    passiveLevels: { allhp: 5 }, skillLevels: { Q: 10 }, upgrades: { atk: 50 },
    savedAt: Date.now(), invRev: 0,
  } });
  await sleep(3400);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  const sd = (row && row.savedData) || {};
  ok(!(sd.passiveLevels && sd.passiveLevels.allhp), 'forged passive level did not persist');
  ok(!(sd.skillLevels && sd.skillLevels.Q), 'forged skill level did not persist');
  ok(!(sd.upgrades && sd.upgrades.atk), 'forged stat upgrades did not persist');
  await c.close();
});

scenario('reconnect: a second socket for the same account kicks the first', async () => {
  const c1 = await connectAs('harness_kick');
  await enterWorld(c1, 'warlock');
  const kicked = c1.wait('kicked', { timeout: 6000 }).catch(() => null);
  const c2 = await connectAs('harness_kick');
  ok(await kicked, 'the first session was told it was replaced');
  await c1.close(); await c2.close();
});

// ── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  const filter = process.argv[2] || '';
  console.log('booting the real server against the in-memory database...\n');
  require(path.join(ROOT, 'server', 'index.js'));
  // Give the HTTP listener and the room loops a moment to come up.
  await sleep(900);

  for (const s of scenarios) {
    if (filter && !s.name.includes(filter)) continue;
    const before = results.length;
    try {
      await s.fn();
      const mine = results.slice(before);
      const bad = mine.filter(r => r[0] === 'FAIL');
      console.log(`${bad.length ? '✗' : '✓'} ${s.name}`);
      mine.forEach(([st, msg, detail]) => {
        if (st === 'FAIL') console.log(`    FAIL ${msg}${detail ? ' — ' + detail : ''}`);
      });
    } catch (err) {
      failed++;
      console.log(`✗ ${s.name}\n    THREW ${err.message}`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error('harness:', err);
  process.exit(1);
});
