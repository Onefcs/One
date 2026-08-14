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

// Mirrors /dev/init-data's own username -> telegramId derivation (server/
// index.js) so TG_ADMIN_ID below can be set to the id a scenario will
// actually get back from connectAs('harness-admin') — there is no other way
// to know that id ahead of a real login.
const crypto = require('crypto');
function _devTelegramId(username) {
  return '9' + parseInt(crypto.createHash('sha1').update(username).digest('hex').slice(0, 10), 16)
    .toString().slice(0, 9);
}
const HARNESS_ADMIN_NAME = 'harness-admin';

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
  // The one account maintenance mode (server/index.js) must never lock out.
  TG_ADMIN_ID: _devTelegramId(HARNESS_ADMIN_NAME),
  GAME_URL: `http://127.0.0.1:${PORT}`,
  // Keep the movement guard measuring but never acting, so a scenario that
  // teleports a client on purpose isn't fighting it.
  MOVE_GUARD: process.env.MOVE_GUARD || 'log',
});

const BASE = `http://127.0.0.1:${PORT}`;
const io = require('socket.io-client');

// ── Watch for handlers that threw ────────────────────────────────────────────
// safeOn (server/index.js) catches anything a socket handler throws so one bad
// packet can't take the process down. The cost is that a broken handler is
// SILENT to the client: no success, no error, just a reply that never comes —
// which is what a missing import looked like from the outside, twice.
//
// Here it is not silent. Every '[socket:<event>]' the server logs is collected
// and turned into a failure at the end of the run, so any handler a scenario
// happens to touch is also checked for throwing.
const handlerErrors = [];
const _realError = console.error;
console.error = (...args) => {
  const first = String(args[0] || '');
  if (first.startsWith('[socket:')) handlerErrors.push(`${first} ${args[1] && args[1].message ? args[1].message : ''}`.trim());
  _realError.apply(console, args);
};

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

scenario('save: the fields a save still owns round-trip', async () => {
  const c = await connectAs('harness_save');
  await enterWorld(c, 'lev');
  // No gold, no items, no levels: those are the server's now. What is left in
  // the blob is preferences and counters nothing is entitled to.
  c.emit('saveProgress', { stats: {
    type: 'lev', lvl: 1, xp: 0, kills: 7, hp: 100, maxHp: 100,
    hudPotion: 'pt1', lang: 'en', autoHpPct: 0.4,
    savedAt: Date.now(),
  } });
  await sleep(3400);   // the server debounces its write by 3s
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  ok(row, 'the player row exists');
  const sd = (row && row.savedData) || {};
  eq(sd.kills, 7, 'kills reached the database');
  eq(sd.lang, 'en', 'settings reached the database');
  eq(sd.autoHpPct, 0.4, 'preferences reached the database');
  await c.close();
});

scenario('gold: a save cannot set the balance', async () => {
  const c = await connectWithSaved('harness_goldpin', { gold: 500 });
  await enterWorld(c, 'mage');
  c.emit('saveProgress', { stats: {
    type: 'mage', lvl: 1, xp: 0, gold: 999999, kills: 0, hp: 10, maxHp: 10,
    savedAt: Date.now(),
  } });
  await sleep(3400);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  eq(row.savedData.gold, 500, 'the stored balance is the one the server held');
  await c.close();
});

scenario('gold: the merchant charges server-side', async () => {
  const c = await connectWithSaved('harness_merchant', { gold: 100 });
  await enterWorld(c, 'ranger');
  // Both replies land in the same tick, so both listeners go on before the
  // request — subscribing to the second one after awaiting the first misses it.
  const sync = c.wait('goldSync', { timeout: 6000 });
  const bagP = c.wait('potionBag', { timeout: 6000 }).catch(() => null);
  c.emit('buyPotion', { idx: 0, qty: 3 });        // pt1, 5 gold each
  const got = await sync;
  eq(got.gold, 85, 'the price came off the balance');
  const bag = await bagP;
  ok(bag && bag.potionBag && bag.potionBag.pt1 === 3, 'and the potions arrived');
  await sleep(150);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  eq(row.savedData.gold, 85, 'persisted immediately, not on the save debounce');
  await c.close();
});

scenario('gold: a purchase beyond the balance is refused', async () => {
  const c = await connectWithSaved('harness_broke', { gold: 4 });
  await enterWorld(c, 'mage');
  const err = c.wait('goldError', { timeout: 5000 }).catch(() => null);
  c.emit('buyPotion', { idx: 0, qty: 1 });
  ok(await err, 'refused with a message');
  await sleep(150);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  eq(row.savedData.gold, 4, 'and nothing was charged');
  await c.close();
});

scenario('gold: founding a clan charges the fee', async () => {
  const c = await connectWithSaved('harness_clan', { gold: 1000 });
  await enterWorld(c, 'warlock');
  const sync = c.wait('goldSync', { timeout: 6000 }).catch(() => null);
  c.emit('clanCreate', { name: 'Test', icon: 1 });
  const got = await sync;
  ok(got && got.gold === 900, `the founding fee was taken (gold=${got && got.gold})`);
  await c.close();
});

scenario('gold: founding is refused when short, and no clan is made', async () => {
  const c = await connectWithSaved('harness_clanbroke', { gold: 10 });
  await enterWorld(c, 'warlock');
  const err = c.wait('clanError', { timeout: 5000 }).catch(() => null);
  c.emit('clanCreate', { name: 'Broke', icon: 1 });
  ok(await err, 'refused with a message');
  eq(memory.__dump('Clan').filter(x => x.name === 'Broke').length, 0, 'and no clan exists');
  await c.close();
});

scenario('techGift: claims once, grants gold+Liberty, and refuses a second claim', async () => {
  const c = await connectWithSaved('harness_techgift', { gold: 500, nexumBalance: 50 });
  await enterWorld(c, 'ranger');

  const goldP  = c.wait('goldSync', { timeout: 5000 });
  const nexumP = c.wait('nexumBalanceUpdate', { timeout: 5000 });
  const resultP = c.wait('techClaimResult', { timeout: 5000 });
  c.emit('techClaim');
  const [gold, nexum, result] = await Promise.all([goldP, nexumP, resultP]);
  eq(gold.gold, 500 + 1000000, 'the gift adds the gold on top of the existing balance');
  eq(nexum.balance, 50 + 200, 'and the Liberty on top of the existing balance');
  eq(result.gold, 500 + 1000000, 'techClaimResult itself reports the same new gold total');
  eq(result.nexum, 50 + 200, 'and the same new Liberty total');

  await sleep(200); // _persistSavedFields's DB write, and the techClaimed $set before it
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  eq(row.savedData.techClaimed, true, 'the DB row is permanently marked claimed');
  eq(row.savedData.gold, 500 + 1000000, 'and the DB gold matches the live total');

  // A second attempt on the SAME still-connected session is refused —
  // proves the atomic DB guard, not just an in-memory flag, is what's
  // stopping the second claim.
  const err = c.wait('techClaimError', { timeout: 5000 });
  c.emit('techClaim');
  const errBody = await err;
  ok(errBody && errBody.msg, 'the second claim is refused with a message');

  // A save cannot forge the flag back to false either.
  c.emit('saveProgress', { stats: {
    type: 'ranger', lvl: 1, xp: 0, gold: 500 + 1000000, techClaimed: false,
    hp: 100, maxHp: 100, savedAt: Date.now(),
  } });
  await sleep(3400);
  const row2 = memory.__dump('Player').find(p => p.username === c.auth.username);
  eq(row2.savedData.techClaimed, true, 'a save claiming techClaimed:false does not un-claim it');

  await c.close();
});

scenario('level: a save cannot set the level', async () => {
  const c = await connectWithSaved('harness_lvlpin', { lvl: 5, xp: 12 });
  await enterWorld(c, 'mage');
  c.emit('saveProgress', { stats: {
    type: 'mage', lvl: 900, xp: 999999, xpNext: 1, baseAtk: 9999, baseDef: 9999, baseMaxHp: 99999,
    gold: 0, kills: 0, hp: 10, maxHp: 10, savedAt: Date.now(),
  } });
  await sleep(3400);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  const sd = row.savedData || {};
  eq(sd.lvl, 5, 'the stored level is the one the server held');
  eq(sd.xp, 12, 'and so is the xp');
  ok(sd.baseAtk < 9999, `the level-derived stats came with it (baseAtk=${sd.baseAtk})`);
  await c.close();
});

scenario('combat: a hit reaches the server and lowers the real enemy', async () => {
  const c = await connectAs('harness_combat');
  await enterWorld(c, 'deathknight');
  // The hub floor itself has no regular monsters any more — each leveling
  // arm is now its own floor (server/game/floors.js), reached with a real
  // enterLocation transition instead of a same-grid walk.
  const armStart = c.wait('gameStart', { where: `${c.name} enterLocation left` });
  c.emit('enterLocation', { target: 'left' });
  const start = await armStart;
  const target = (start.enemies || []).filter(e => e && (e.hp || 0) > 0).sort((x, y) => x.hp - y.hp)[0];
  ok(target, 'the room has a live enemy');
  if (!target) return c.close();
  // Killing one is not a test: the weakest enemy reachable from spawn has
  // 24,000 HP against a level-1 character. What matters here is that the hit
  // is resolved server-side at all — the damage number, the range check and
  // the enemy's HP all live there.
  c.emit('playerMove', { x: target.x + 20, y: target.y, facing: 1, moving: false });
  await sleep(120);
  const hurt = c.wait('enemyHurt', { timeout: 6000 }).catch(() => null);
  c.emit('attack', { enemyId: target.id });
  const got = await hurt;
  ok(got && got.id === target.id, 'the server resolved the hit');
  ok(got && got.dmg > 0, `and reported the damage it dealt (${got && got.dmg})`);
  ok(got && got.hp < target.hp, 'and the enemy lost health on its side');
  await c.close();
});

scenario('floors: entering an arm is a real floor change, gated server-side, with a working way back', async () => {
  const c = await connectAs('harness_floors');
  const start = await enterWorld(c, 'ranger');
  eq(start.floor, 1, 'a fresh character lands on the hub floor');

  // 'top' requires level 20 (ARM_LEVEL_REQ) — a level-1 character asking for
  // it must be refused server-side, not just hidden behind the pad's own
  // client-side lock icon.
  const denied = c.wait('enterLocationDenied', { timeout: 3000 });
  c.emit('enterLocation', { target: 'top' });
  const denial = await denied;
  eq(denial && denial.reason, 'level', 'a level-gated arm refuses a character who has not reached it');

  // 'left' has no level requirement — the same request should actually move
  // the character onto that arm's own floor, with its own grid/enemies.
  const leftStart = c.wait('gameStart', { where: `${c.name} enters left` });
  c.emit('enterLocation', { target: 'left' });
  const onLeft = await leftStart;
  eq(onLeft.floor, 2, 'entering the left arm switches to its own floor');
  ok((onLeft.enemies || []).length > 0, 'and that floor reports its own regular enemies');

  // The arm's own return pad sends the character back to the hub floor —
  // same round trip a player makes by walking onto it.
  const hubStart = c.wait('gameStart', { where: `${c.name} returns to hub` });
  c.emit('enterLocation', { target: 'hub' });
  const backAtHub = await hubStart;
  eq(backAtHub.floor, 1, 'requesting hub from an arm returns to the hub floor');

  await c.close();
});

scenario('floors: Guild War is its own floor, window-gated, and force-evicted when it closes', async () => {
  const c = await connectAs('harness_gw');
  await enterWorld(c, 'ranger');

  // The window starts closed — a client that goes straight for it (no pad
  // walk to gate it client-side first) must still be refused server-side.
  const deniedClosed = c.wait('enterLocationDenied', { timeout: 3000 });
  c.emit('enterLocation', { target: 'guildWar' });
  const denial = await deniedClosed;
  eq(denial && denial.reason, 'closed', 'entry is refused while the window is closed');

  // Same force-open the in-game admin panel uses.
  const loginRes = await fetch(`${BASE}/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  const { token } = await loginRes.json();
  const openRes = await fetch(`${BASE}/admin/guildwar/open`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  eq(openRes.status, 200, 'admin can force-open the Guild War window');

  const gwStart = c.wait('gameStart', { where: `${c.name} enters guildWar` });
  c.emit('enterLocation', { target: 'guildWar' });
  const onGw = await gwStart;
  eq(onGw.floor, 6, 'entering guildWar switches to its own floor');
  ok((onGw.enemies || []).some(e => e.eid === 'guildwar_castle'), 'and that floor has its own tower, in view from the spawn ring');

  // Closing the window has to force everyone still inside back out — no pad
  // walk triggers it, so this only works if it can reach the connection from
  // outside (socket.data._forceEnterLocation, server/index.js).
  const hubStart = c.wait('gameStart', { where: `${c.name} force-evicted to hub` });
  const closeRes = await fetch(`${BASE}/admin/guildwar/close`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  eq(closeRes.status, 200, 'admin can force-close the Guild War window');
  const backAtHub = await hubStart;
  eq(backAtHub.floor, 1, 'closing the window sends a still-present player back to the hub floor');

  await c.close();
});

scenario('admin: maintenance mode kicks everyone but TG_ADMIN_ID, and blocks new non-admin logins', async () => {
  const before = await connectAs('harness_maint_before');
  await enterWorld(before, 'ranger');

  const loginRes = await fetch(`${BASE}/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  const { token } = await loginRes.json();

  // A player already in the game when maintenance switches on has to be
  // force-disconnected, not just refused on their next login.
  const kicked = before.wait('kicked', { timeout: 3000 });
  const onRes = await fetch(`${BASE}/admin/maintenance/on`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  eq(onRes.status, 200, 'admin can switch maintenance on');
  const kickMsg = await kicked;
  ok(kickMsg && /технически/i.test(kickMsg.reason || ''), 'a player already online is kicked with a maintenance reason');

  // A normal account cannot log in at all while it's on — same authError
  // path a banned account gets, so no client change was needed for this.
  const { initData: blockedInitData } = await (await fetch(`${BASE}/dev/init-data?dev=harness_maint_blocked`)).json();
  const blockedSock = io(BASE, { transports: ['websocket'], upgrade: false, forceNew: true });
  await waitFor(blockedSock, 'connect', { where: 'maint-blocked connect' });
  const authErrP = waitFor(blockedSock, 'authError', { where: 'maint-blocked authError' });
  blockedSock.emit('loginTelegramWebApp', { initData: blockedInitData });
  const authErr = await authErrP;
  ok(authErr && /технически/i.test(authErr.message || ''), 'a non-admin login is refused with a maintenance message while it is on');
  blockedSock.close();

  // TG_ADMIN_ID itself (see the harness's own env setup) is exempt from both.
  const admin = await connectAs(HARNESS_ADMIN_NAME);
  ok(admin.auth && typeof admin.auth.username === 'string', 'the TG_ADMIN_ID account can still log in while maintenance is on');
  await admin.close();

  const offRes = await fetch(`${BASE}/admin/maintenance/off`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  eq(offRes.status, 200, 'admin can switch maintenance off again');

  const after = await connectAs('harness_maint_after');
  ok(after.auth && typeof after.auth.username === 'string', 'a normal account can log in again once maintenance is off');
  await after.close();

  await before.close();
});

scenario('admin: give-all grants gold+SP to an online account live and an offline account in the DB', async () => {
  const online = await connectWithSaved('harness_giveall_online', { gold: 100, bonusSP: 2 });
  await enterWorld(online, 'ranger');

  // An account that exists but isn't connected right now — the DB-only path.
  const offlineSeed = await connectAs('harness_giveall_offline');
  await offlineSeed.close();
  await sleep(200);

  const loginRes = await fetch(`${BASE}/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  const { token } = await loginRes.json();

  const gave = online.wait('adminGive', { where: 'give-all lands on the online account' });
  const giveRes = await fetch(`${BASE}/admin/give-all`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ gold: 500, sp: 3 }),
  });
  const giveBody = await giveRes.json();
  eq(giveRes.status, 200, 'admin can grant gold+SP to everyone at once');
  ok(giveBody.online >= 1, 'reports at least the one online account it touched');
  ok(giveBody.offline >= 1, 'reports at least the one offline account it touched');

  const onlinePayload = await gave;
  eq(onlinePayload.newGold, 600, 'the online account\'s live session got the new gold total pushed to it');
  eq(onlinePayload.newBonusSP, 5, 'and the new bonusSP total');

  await sleep(150); // _persistSavedFields's DB write
  const onlineRow = memory.__dump('Player').find(p => p.username === online.auth.username);
  eq(onlineRow.savedData.gold, 600, 'the online account\'s DB row matches, not just its live session');
  eq(onlineRow.savedData.bonusSP, 5, 'same for bonusSP');

  const offlineRow = memory.__dump('Player').find(p => p.username === offlineSeed.auth.username);
  eq(offlineRow.savedData.gold, 500, 'the offline account got the gold via a straight DB increment');
  eq(offlineRow.savedData.bonusSP, 3, 'and the SP');

  await online.close();
});

scenario('floors: Фарм-зона is its own floor, gated server-side by level', async () => {
  const low = await connectAs('harness_farm_low');
  await enterWorld(low, 'ranger'); // fresh character, well under FARM_ENTRY_LEVEL (20)

  const denied = low.wait('enterLocationDenied', { timeout: 3000 });
  low.emit('enterLocation', { target: 'farmZone' });
  const denial = await denied;
  eq(denial && denial.reason, 'level', 'a character below FARM_ENTRY_LEVEL is refused, not just hidden behind the pad\'s lock icon');
  await low.close();

  const high = await connectWithSaved('harness_farm_high', { lvl: 20, xp: 0, xpNext: 100 });
  await enterWorld(high, 'ranger');
  const farmStart = high.wait('gameStart', { where: `${high.name} enters farmZone` });
  high.emit('enterLocation', { target: 'farmZone' });
  const onFarm = await farmStart;
  eq(onFarm.floor, 7, 'a character at the level requirement switches to the Фарм-зона floor');
  eq((onFarm.enemies || []).length, 80, 'and that floor reports its own baked-in monsters');

  const hubStart = high.wait('gameStart', { where: `${high.name} returns to hub` });
  high.emit('enterLocation', { target: 'hub' });
  const backAtHub = await hubStart;
  eq(backAtHub.floor, 1, 'the zone\'s own return pad sends the character back to the hub floor');

  await high.close();
});

scenario('floors: the boss arena is its own floor, reachable only while a world boss is up', async () => {
  const c = await connectAs('harness_arena_boss');
  await enterWorld(c, 'ranger');

  const deniedClosed = c.wait('enterLocationDenied', { timeout: 3000 });
  c.emit('enterLocation', { target: 'arena' });
  const denial = await deniedClosed;
  eq(denial && denial.reason, 'closed', 'entry is refused while no world boss is up');

  const loginRes = await fetch(`${BASE}/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  const { token } = await loginRes.json();
  const summonRes = await fetch(`${BASE}/admin/event-boss`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  eq(summonRes.status, 200, 'admin can summon the world boss on the spot');

  const arenaStart = c.wait('gameStart', { where: `${c.name} enters the arena` });
  c.emit('enterLocation', { target: 'arena' });
  const onArena = await arenaStart;
  eq(onArena.floor, 8, 'a summoned boss opens the arena as its own floor');
  ok((onArena.enemies || []).some(e => e.eid === 'demon_event_boss'), 'and that floor has the boss itself');

  const hubStart2 = c.wait('gameStart', { where: `${c.name} returns to hub` });
  c.emit('enterLocation', { target: 'hub' });
  const backAtHub2 = await hubStart2;
  eq(backAtHub2.floor, 1, 'the arena\'s own return pad sends the character back to the hub floor');

  await c.close();
});

scenario('season: hitting the world boss pays its 50 points once, not once per reconnect', async () => {
  // _seasonTrackBossHit (server/index.js) used to remember "already paid for
  // this boss" in a bare in-memory variable scoped to one socket connection —
  // so a reconnect (a page refresh is a brand new connection, same as any
  // ordinary network blip) forgot, and the very next hit on the still-alive
  // boss paid the 50 participation points again. Reproduces that exact
  // sequence: hit once, reconnect, hit the SAME boss id again, and check the
  // stored total only reflects one grant.
  const c1 = await connectAs('harness_bosspts');
  await enterWorld(c1, 'ranger');

  const loginRes = await fetch(`${BASE}/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  const { token } = await loginRes.json();
  // 200 summons a fresh one; 409 means an earlier scenario in this same run
  // (the 'boss arena is its own floor' test above) already has one up and
  // never tore it down — either way there is a live boss to hit afterward,
  // which is all this scenario actually needs.
  const summonRes = await fetch(`${BASE}/admin/event-boss`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  ok(summonRes.status === 200 || summonRes.status === 409, `a world boss is up one way or another (got ${summonRes.status})`);

  const arenaStart = c1.wait('gameStart', { where: `${c1.name} enters the arena` });
  c1.emit('enterLocation', { target: 'arena' });
  const onArena = await arenaStart;
  const boss = (onArena.enemies || []).find(e => e.eid === 'demon_event_boss');
  ok(boss && boss.id, 'the arena floor carries the boss and its live id');

  // The arena's spawn point is well outside melee range of the boss at its
  // centre (same reasoning as the 'combat' scenario's playerMove) — walk
  // over before swinging, or attackEnemy's own range check silently refuses
  // the hit and nothing here ever fires.
  c1.emit('playerMove', { x: boss.x + 20, y: boss.y, facing: 1, moving: false });
  await sleep(120);
  const paid1 = c1.wait('seasonEventDone', { timeout: 5000 });
  c1.emit('attack', { enemyId: boss.id });
  const done1 = await paid1;
  eq(done1.task, 'worldboss', 'the first hit pays the world-boss participation task');
  eq(done1.points, 50, 'for 50 points');

  await c1.close();
  await sleep(500);

  // Reconnect — same account, brand new socket connection, lands back on the
  // hub (the bare _buildSaveStats()-shaped blob every real reconnect sends).
  // Boss is still alive (event bosses live for minutes; summoning it fresh
  // above guarantees it hasn't despawned yet) — walk back in and hit the
  // exact same boss id again.
  const c2 = await connectAs('harness_bosspts');
  const hubStart = c2.wait('gameStart', { where: `${c2.name} reconnects` });
  c2.emit('selectChar', { type: 'ranger', savedStats: {
    type: 'ranger', floor: 1, hp: 100, maxHp: 100, kills: 0,
    hudPotion: 'pt1', autoHpPct: 0.5, autoBuffTypes: {}, lang: 'ru', savedAt: Date.now(),
  } });
  await hubStart;
  const arenaStart2 = c2.wait('gameStart', { where: `${c2.name} re-enters the arena` });
  c2.emit('enterLocation', { target: 'arena' });
  await arenaStart2;

  c2.emit('playerMove', { x: boss.x + 20, y: boss.y, facing: 1, moving: false });
  await sleep(120);
  c2.emit('attack', { enemyId: boss.id });
  await sleep(1000); // give a wrongly-re-awarded grant time to land if the bug is back

  const row = memory.__dump('Player').find(p => p.username === c2.auth.username);
  eq(row.savedData.seasonPoints, 50, 'the stored total reflects exactly one grant, not two');
  eq(row.savedData.seasonBossPaid, boss.id, 'and the paid-boss id is persisted, not just held in memory');
  await c2.close();
});

scenario('floors: Death Battle deploys entrants from wherever they are and returns each one there', async () => {
  const a = await connectAs('harness_db_a');
  const b = await connectAs('harness_db_b');
  const aStart = await enterWorld(a, 'ranger'); // stays on the hub
  await enterWorld(b, 'mage');

  // b heads to the left arm first — registering for the event never required
  // being on any particular floor, so this is the case that actually proves
  // the return trip goes back to where each entrant really was, not always
  // the hub (which is all a single-floor arena could ever have told apart).
  const bOnLeft = b.wait('gameStart', { where: `${b.name} enters left` });
  b.emit('enterLocation', { target: 'left' });
  const bLeftStart = await bOnLeft;
  eq(bLeftStart.floor, 2, 'b moves to the left arm before registering');

  // Registration only accepts entrants while _db.phase === 'reg' — the dev
  // route has to open the window before either of these can register at all.
  const openRes = await fetch(`${BASE}/dev/deathbattle/open?reg=1500`, { method: 'POST' });
  eq(openRes.status, 200, 'the dev route force-opens registration with a short window');

  const aReg = a.wait('deathBattleRegistered', { timeout: 3000 });
  const bReg = b.wait('deathBattleRegistered', { timeout: 3000 });
  a.emit('deathBattleRegister');
  b.emit('deathBattleRegister');
  eq((await aReg)?.registered, true, 'a is registered');
  eq((await bReg)?.registered, true, 'b is registered');

  const aStarted = a.wait('deathBattleStarted', { timeout: 6000 });
  const bStarted = b.wait('deathBattleStarted', { timeout: 6000 });
  await aStarted; await bStarted;
  eq(a.last('gameStart')?.floor, 8, 'a is force-joined onto the arena floor to be deployed');
  eq(b.last('gameStart')?.floor, 8, 'b is force-joined onto the arena floor too, from the left arm');

  // 'respawn' unconditionally counts as an elimination for whoever is still
  // in _db.alive (see _pvpEliminate/_dbEliminate) — a deterministic stand-in
  // for landing a killing PvP blow, without needing real combat, the 500px
  // range check, or the opening freeze timer in a test.
  const aEliminated = a.wait('deathBattleEliminated', { timeout: 3000 });
  a.emit('respawn');
  const aSpot = await aEliminated;
  eq(a.last('gameStart')?.floor, 1, 'the eliminated entrant is returned to the hub floor it actually came from');
  eq(aSpot && aSpot.x, aStart.spawn.x, 'at the exact x it was standing at before deployment');
  eq(aSpot && aSpot.y, aStart.spawn.y, 'at the exact y it was standing at before deployment');

  // Only one entrant is left standing, so _dbEliminate's own alive.size<=1
  // check already finished the round and named b the winner — closing the
  // reward modal is what actually sends the winner home.
  const bReturned = b.wait('deathBattleReturnedPrev', { timeout: 3000 });
  b.emit('deathBattleReturn');
  const bSpot = await bReturned;
  eq(b.last('gameStart')?.floor, 2, 'the winner is returned to the left arm it actually came from, not the hub');
  eq(bSpot && bSpot.x, bLeftStart.spawn.x, 'at the exact x it was standing at before deployment');
  eq(bSpot && bSpot.y, bLeftStart.spawn.y, 'at the exact y it was standing at before deployment');

  await a.close();
  await b.close();
});

scenario('floors: the 3v3 arena deploys a full match and returns an eliminated entrant to the hub', async () => {
  // ARENA3_NEEDED is 6 (two teams of ARENA3_TEAM_SIZE=3) and arena3Register
  // itself tries a deploy the moment the queue reaches it — no separate
  // "start" step to trigger, unlike death battle/race10.
  const openRes = await fetch(`${BASE}/dev/arena3/open`, { method: 'POST' });
  eq(openRes.status, 200, 'the dev route force-opens the 3v3 registration window');

  const players = [];
  for (let i = 0; i < 6; i++) {
    const c = await connectWithSaved(`harness_a3_${i}`, { lvl: 15, xp: 0, xpNext: 100 });
    await enterWorld(c, 'ranger');
    players.push(c);
  }

  const started = players.map(c => c.wait('arena3Started', { timeout: 6000 }));
  players.forEach(c => c.emit('arena3Register'));
  await Promise.all(started);
  players.forEach(c => {
    eq(c.last('gameStart')?.floor, 9, `${c.name} is force-joined onto the pvpArena floor to be deployed`);
  });

  // Same 'respawn' shortcut the death battle test uses — _pvpEliminate tries
  // _a3Eliminate unconditionally for anyone in _a3.alive, no real combat
  // needed to prove the return path works.
  const victim = players[0];
  const eliminated = victim.wait('arena3Eliminated', { timeout: 3000 });
  victim.emit('respawn');
  const spot = await eliminated;
  eq(victim.last('gameStart')?.floor, 1, 'an eliminated entrant is returned to the hub floor');
  ok(spot && spot.x != null && spot.y != null, 'landing at the hub spawn (a real position, not a null placeholder)');

  await Promise.all(players.map(c => c.close()));
});

scenario('floors: Кровавая Башня deploys entrants onto its own floor and an elimination returns them to the hub', async () => {
  const openRes = await fetch(`${BASE}/dev/race10/open?reg=1500`, { method: 'POST' });
  eq(openRes.status, 200, 'the dev route force-opens race10 registration with a short window');

  const a = await connectWithSaved('harness_race10_a', { lvl: 10, xp: 0, xpNext: 100 });
  const b = await connectWithSaved('harness_race10_b', { lvl: 10, xp: 0, xpNext: 100 });
  await enterWorld(a, 'ranger');
  await enterWorld(b, 'mage');

  const aReg = a.wait('race10Registered', { timeout: 3000 });
  const bReg = b.wait('race10Registered', { timeout: 3000 });
  a.emit('race10Register');
  b.emit('race10Register');
  eq((await aReg)?.registered, true, 'a is registered');
  eq((await bReg)?.registered, true, 'b is registered');

  const aStarted = a.wait('race10Started', { timeout: 6000 });
  const bStarted = b.wait('race10Started', { timeout: 6000 });
  await aStarted; await bStarted;
  eq(a.last('gameStart')?.floor, 10, 'a is force-joined onto its own race10 floor to be deployed');
  eq(b.last('gameStart')?.floor, 10, 'b is force-joined onto the same floor, in its own lane');

  // Race10 has no PvP — "eliminated" only ever means a monster kill, reported
  // through the same 'respawn' round trip every death in the game uses. This
  // is exactly the path that used to rely on respawnPlayer's Room-local
  // spawn reset (correct back when race10 shared the hub's own Room, wrong
  // now that it's its own floor with its own default spawn) — _race10Eliminate
  // now does the floor change itself first (see its comment). Eliminating
  // both finishes the race too (no survivors left to hit the boss), so this
  // covers both entrants' return in one pass.
  const aElim = a.wait('race10Eliminated', { timeout: 3000 });
  const bElim = b.wait('race10Eliminated', { timeout: 3000 });
  const aResult = a.wait('race10Result', { timeout: 3000 });
  const bResult = b.wait('race10Result', { timeout: 3000 });
  a.emit('respawn');
  b.emit('respawn');
  await aElim; await bElim;
  eq(a.last('gameStart')?.floor, 1, 'a is returned to the hub floor, not left stranded on race10\'s own');
  eq(b.last('gameStart')?.floor, 1, 'b is returned to the hub floor too');
  const aRes = await aResult, bRes = await bResult;
  eq(aRes?.won, false, 'a\'s result reports a loss (no survivors, nobody won)');
  eq(bRes?.won, false, 'and so does b\'s');

  await a.close();
  await b.close();
});

scenario('floors: Страх deploys into its own floor and a death returns the player to the hub', async () => {
  const c = await connectWithSaved('harness_fear_death', { lvl: 10, xp: 0, xpNext: 100 });
  await enterWorld(c, 'ranger');

  const started = c.wait('fearStarted', { timeout: 3000 });
  c.emit('fearEnter');
  const st = await started;
  eq(c.last('gameStart')?.floor, 11, 'entering Fear force-joins its own floor');
  ok(st && st.x != null && st.y != null, 'and fearDeploy places the player in a lane');

  // Fear has no PvP either — "died mid-run" only ever means a monster kill,
  // reported through the same 'respawn' round trip every death in the game
  // uses. _fearFinish (called via _fearEliminate) has to do its own
  // floor-aware return before the SAME handler's generic respawnPlayer call
  // runs right after it, same class of fix race10Eliminate needed.
  const finished = c.wait('fearFinished', { timeout: 3000 });
  c.emit('respawn');
  const fin = await finished;
  eq(fin?.cleared, false, 'the run ends uncleared (died, not finished the last wave)');
  eq(c.last('gameStart')?.floor, 1, 'and the player is returned to the hub floor, not left on Fear\'s own');

  await c.close();
});

scenario('floors: Страх holds monsters back for FEAR_START_DELAY_MS after entry, then spawns wave 1', async () => {
  // Wave 1 used to spawn (and pre-aggro onto the player) in the same tick as
  // fearDeploy — the exact instant the client was still behind the
  // near-opaque events panel closing itself, or just hadn't finished
  // rendering the new floor. From the player's side that read as "I walked
  // into Страх and the monsters were already on me / invisible", every
  // time. fearEnter now hands out a wave:0 grace record and only calls
  // _fearStartWave 5s later (FEAR_START_DELAY_MS, server/index.js) — this
  // checks both halves: nothing is alive right at entry, and wave 1 really
  // does show up roughly 5s later, not immediately.
  const c = await connectWithSaved('harness_fear_delay', { lvl: 10, xp: 0, xpNext: 100 });
  await enterWorld(c, 'ranger');

  const started = c.wait('fearStarted', { timeout: 3000 });
  const t0 = Date.now();
  c.emit('fearEnter');
  const st = await started;
  ok(st && st.readyAt > t0, 'fearStarted reports when wave 1 will actually spawn');

  const onFear = c.last('gameStart');
  eq(onFear?.floor, 11, 'entering Fear force-joins its own floor');
  eq((onFear?.enemies || []).length, 0, 'and the initial enemy snapshot is empty — nothing has spawned yet');

  // Well inside the grace window — wave 1 must not have fired yet.
  const tooEarly = await c.wait('fearWave', { timeout: 2500 }).catch(() => null);
  eq(tooEarly, null, 'wave 1 does not spawn before the grace window elapses');

  const wave1 = await c.wait('fearWave', { timeout: 4000 });
  const elapsed = Date.now() - t0;
  eq(wave1?.wave, 1, 'wave 1 spawns once the grace window elapses');
  ok(elapsed >= 4500, `and only after roughly FEAR_START_DELAY_MS, not immediately (took ${elapsed}ms)`);

  await c.close();
});

scenario('floors: Страх gives every entrant their own private instance, not shared halls', async () => {
  // The old design stacked a fixed FEAR_LANES rooms into one shared grid —
  // a second entrant landed in lane 1, at a different y-coordinate than
  // lane 0's occupant, and only ever a few lanes were free at once. Every
  // entrant gets a freshly generated, single-lane Room of their own now
  // (_createFearRoom, server/index.js) — two simultaneous entrants are BOTH
  // "lane 0" of their own room, so they land at the exact same (x, y),
  // which could never happen if they were sharing one floor's grid.
  const a = await connectWithSaved('harness_fear_iso_a', { lvl: 10, xp: 0, xpNext: 100 });
  const b = await connectWithSaved('harness_fear_iso_b', { lvl: 10, xp: 0, xpNext: 100 });
  await enterWorld(a, 'ranger');
  await enterWorld(b, 'ranger');

  const aStarted = a.wait('fearStarted', { timeout: 3000 });
  a.emit('fearEnter');
  const aSt = await aStarted;

  const bStarted = b.wait('fearStarted', { timeout: 3000 });
  b.emit('fearEnter');
  const bSt = await bStarted;

  ok(aSt && bSt, 'both entrants were accepted');
  eq(bSt.x, aSt.x, 'two simultaneous entrants land at the same x — each is lane 0 of their OWN room');
  eq(bSt.y, aSt.y, 'and the same y, for the same reason');

  // And they really are isolated, not just coincidentally overlapping:
  // ending a's run must not touch b's.
  const aFin = a.wait('fearFinished', { timeout: 3000 });
  a.emit('respawn');
  const aRes = await aFin;
  eq(aRes?.cleared, false, "a's run ends (died)");

  const bSync = b.wait('fearState', { timeout: 3000 });
  b.emit('fearSync');
  const bSt2 = await bSync;
  eq(bSt2?.inRun, true, "b's own run is completely unaffected by a finishing theirs");

  await a.close();
  await b.close();
});

scenario('floors: Страх never refuses an entrant for lack of space', async () => {
  // The old shared-hall design capped concurrent runs at FEAR_LANES (was 8)
  // and refused anyone past it with "Все N залов заняты". There is no
  // shared pool to exhaust any more — every entrant gets their own Room
  // (_createFearRoom) — so more simultaneous entrants than the old cap must
  // all still be accepted.
  const N = 10;
  const clients = await Promise.all(
    Array.from({ length: N }, (_, i) => connectWithSaved(`harness_fear_volume_${i}`, { lvl: 10, xp: 0, xpNext: 100 })),
  );
  await Promise.all(clients.map(c => enterWorld(c, 'ranger')));

  const waits = clients.map(c => ({
    started: c.wait('fearStarted', { timeout: 6000 }).catch(() => null),
    err: c.wait('fearError', { timeout: 6000 }).catch(() => null),
  }));
  clients.forEach(c => c.emit('fearEnter'));
  const results = await Promise.all(waits.map(w => Promise.race([w.started, w.err])));
  results.forEach((r, i) => ok(r && r.x != null, `entrant ${i + 1}/${N} was accepted, not refused for space${r && r.msg ? ' (' + r.msg + ')' : ''}`));

  await Promise.all(clients.map(c => c.close()));
});

scenario('floors: a mid-run disconnect+reconnect resumes a Fear run on its own floor, not the hub', async () => {
  const a1 = await connectWithSaved('harness_fear_reconnect', { lvl: 10, xp: 0, xpNext: 100 });
  await enterWorld(a1, 'ranger');

  const started = a1.wait('fearStarted', { timeout: 3000 });
  a1.emit('fearEnter');
  await started;
  eq(a1.last('gameStart')?.floor, 11, 'the first session is on the fear floor mid-run');

  // An ordinary disconnect (not a clean exit) — the run is meant to be held
  // open for a possible reconnect (_fearHoldOnDisconnect/_fearGraceStart),
  // not ended outright the way arena3/race10/death battle disconnects are.
  // This also lands well inside FEAR_START_DELAY_MS's grace window, so it
  // doubles as coverage for the reconnect-during-countdown path: the
  // deferred wave-1 setTimeout was scheduled against the now-dead socket
  // and must no-op, with the fearCarry reclaim starting wave 1 itself
  // instead (see its comment in server/index.js).
  await a1.close();

  // Reconnect as the SAME account. Every fresh connection's own currentFloor
  // starts at the hub (see its declaration) — without the reconnect-floor
  // fix (selectChar checking _fearDisconnectGrace before defaulting there),
  // this session would join the hub's Room instead of the fear floor's, and
  // Room.addPlayer's own _fearGraceClaim would check the wrong Room and
  // never find the held hall at all.
  const a2 = await connectAs('harness_fear_reconnect');
  const start2 = await enterWorld(a2, 'ranger');
  eq(start2.floor, 11, 'reconnecting mid-run lands back on the fear floor, not the hub');
  eq(start2.fear && start2.fear.inRun, true, 'and the run itself is reported as still live');
  eq(start2.fear && start2.fear.wave, 1, 'and reconnecting during the countdown starts wave 1 immediately, not a resumed countdown nobody can see');

  await a2.close();
});

scenario('floors: leaving for an arm tells hub-side players you left, not just moved', async () => {
  const a = await connectAs('harness_floors_a');
  const b = await connectAs('harness_floors_b');
  await enterWorld(a, 'ranger');
  await enterWorld(b, 'mage'); // both start on the hub floor

  // A plain in-floor move must NOT look like a departure.
  const noLeaveYet = b.wait('playerLeft', { timeout: 800 }).catch(() => null);
  a.emit('playerMove', { x: 1400, y: 1400, facing: 1, moving: true });
  eq(await noLeaveYet, null, 'moving within the same floor does not fire playerLeft');

  // Leaving for the left arm is a real floor change — b (still on the hub)
  // must be told a left, the same as an actual disconnect would.
  const aLeftForB = b.wait('playerLeft', { timeout: 3000 });
  const aOnLeft = a.wait('gameStart', { where: 'a enters left' });
  a.emit('enterLocation', { target: 'left' });
  await aOnLeft;
  const leftEvt = await aLeftForB;
  eq(leftEvt && leftEvt.id, a.sock.id, 'the hub floor is told a left when they entered the arm');

  await a.close();
  await b.close();
});

scenario('level: a server-granted reward crosses the level threshold', async () => {
  // One XP short of level 2, then claim the first story quest — a flat 50 XP
  // reward, granted and applied entirely server-side.
  // The kills the quest asks for are seeded too: the server checks the claim
  // against its own counters now, so an unfinished quest is refused.
  const c = await connectWithSaved('harness_levelup', {
    lvl: 1, xp: 99, xpNext: 100, questIdx: 0, questKills: { 'Крыса страж': 10 },
  });
  await enterWorld(c, 'mage');
  const claimed = c.wait('questClaimed', { timeout: 6000 }).catch(() => null);
  const synced  = c.wait('xpSync', { timeout: 6000 }).catch(() => null);
  c.emit('claimQuest', { idx: 0 });
  const q = await claimed;
  ok(q && q.xp === 50, `the quest paid its flat XP (${q && q.xp})`);
  const st = await synced;
  ok(st, 'the level state came back from the server');
  eq(st && st.lvl, 2, 'which crossed into level 2');
  ok(st && st.xpNext > 100, 'with the next threshold recomputed');
  ok(st && st.baseAtk > 0 && st.baseMaxHp > 0, 'and the level-derived stats');
  await sleep(200);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  eq(row.savedData.lvl, 2, 'the level up was persisted immediately');
  await c.close();
});

scenario('quests: a claim for an unfinished quest is refused', async () => {
  // The check that was missing entirely: claimQuest verified WHICH quest was
  // being claimed but never whether it had been done, so a client could walk
  // the whole 60-quest chain in one go and collect every reward.
  const c = await connectWithSaved('harness_questcheat', { questIdx: 0, questKills: { 'Крыса страж': 9 } });
  await enterWorld(c, 'mage');
  const err = c.wait('questClaimError', { timeout: 6000 }).catch(() => null);
  c.emit('claimQuest', { idx: 0 });
  ok(await err, 'one kill short is refused');
  await sleep(200);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  eq(row.savedData.questIdx, 0, 'and the chain did not advance');
  await c.close();
});

scenario('quests: a save cannot write the counters', async () => {
  const c = await connectWithSaved('harness_questpin', { questIdx: 0, questKills: {} });
  await enterWorld(c, 'mage');
  c.emit('saveProgress', { stats: {
    type: 'mage', lvl: 1, xp: 0, hp: 10, maxHp: 10,
    questIdx: 42, questKills: { 'Крыса страж': 999 },
    savedAt: Date.now(),
  } });
  await sleep(3400);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  eq(row.savedData.questIdx, 0, 'the stored index is the server\'s');
  eq(Object.keys(row.savedData.questKills || {}).length, 0, 'and so are the counters');
  await c.close();
});

scenario('quests: f1q14 is now a level-15 gate and f1q15 asks to enter Фарм-зона', async () => {
  // QUEST_DEF indices are positional: f1q14 sits at index 12 (after
  // f1..f1q13), f1q15 at index 14 (after f1q9's level-20 quest at 13) — see
  // shared/definitions.js's own comment on why the array position, not the
  // id, is what player progress keys off.
  const F1Q14_IDX = 12, F1Q15_IDX = 14;

  // f1q14: replaced "join a clan" with "reach level 15" — a save already at
  // level 15 should find it claimable immediately, no separate event needed.
  const leveled = await connectWithSaved('harness_quest_lvl15', { lvl: 15, questIdx: F1Q14_IDX, questKills: {} });
  await enterWorld(leveled, 'ranger');
  const claimed14 = leveled.wait('questClaimed', { timeout: 6000 }).catch(() => null);
  leveled.emit('claimQuest', { idx: F1Q14_IDX });
  ok(await claimed14, 'level 15 alone is enough to claim f1q14');
  await leveled.close();

  const short = await connectWithSaved('harness_quest_lvl14', { lvl: 14, questIdx: F1Q14_IDX, questKills: {} });
  await enterWorld(short, 'ranger');
  const err14 = short.wait('questClaimError', { timeout: 6000 }).catch(() => null);
  short.emit('claimQuest', { idx: F1Q14_IDX });
  ok(await err14, 'one level short of 15 is refused');
  await short.close();

  // f1q15: replaced "reach the top corridor" with "enter Фарм-зона" — actually
  // walking through the portal (enterLocation('farmZone')) has to be what
  // completes it, not a kill-triggered proxy (there's no monster-level curve
  // to hook into for a zone outside the arm progression).
  const farmer = await connectWithSaved('harness_quest_farm', { lvl: 25, questIdx: F1Q15_IDX, questKills: {} });
  await enterWorld(farmer, 'ranger');
  const preErr = farmer.wait('questClaimError', { timeout: 3000 }).catch(() => null);
  farmer.emit('claimQuest', { idx: F1Q15_IDX });
  ok(await preErr, 'not claimable before actually entering the zone');

  const farmStart = farmer.wait('gameStart', { where: `${farmer.name} enters farmZone` });
  farmer.emit('enterLocation', { target: 'farmZone' });
  const onFarm = await farmStart;
  eq(onFarm.floor, 7, 'the transition landed on the farm-zone floor');

  const claimed15 = farmer.wait('questClaimed', { timeout: 6000 }).catch(() => null);
  farmer.emit('claimQuest', { idx: F1Q15_IDX });
  ok(await claimed15, 'entering the zone alone made it claimable');
  await farmer.close();
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


// Seeds an account's stored inventory and returns a session that has it.
//
// The two-step connect is not ceremony: authed.savedData is the document as it
// was read AT LOGIN, and selectChar builds the session's item set from that —
// so anything written to the row after the socket authenticated is invisible
// to it until the next login. Granting first and connecting second is what a
// real drop does too (it goes through _commitServerItems on a live session).
async function connectWithSaved(name, saved) {
  const seed = await connectAs(name);           // creates the row
  await seed.close();
  // Long enough for that socket's disconnect flush to land. It writes the
  // session's own view of the character, so seeding before it completes gets
  // silently overwritten — which is a real property of the server, not a quirk
  // of the double.
  await sleep(500);
  const Player = require('../server/models/Player');
  const row = memory.__dump('Player').find(p => p.username === seed.auth.username);
  const set = {};
  for (const [k, v] of Object.entries(saved)) set['savedData.' + k] = v;
  await Player.updateOne({ _id: row._id }, { $set: set });
  await sleep(50);
  return connectAs(name);
}

scenario('items: equipping is performed by the server, not the save', async () => {
  const c = await connectWithSaved('harness_equip', { inventory: [{ id: 'uq_sword_l', enhance: 0 }] });
  await enterWorld(c, 'deathknight');
  const sync = c.wait('inventorySync', { timeout: 6000 });
  c.emit('equipItem', { idx: 0 });
  const got = await sync;
  eq(got.inventory.length, 0, 'the item left the inventory');
  ok(got.equipment && got.equipment.weapon && got.equipment.weapon.id === 'uq_sword_l',
     'and landed in the weapon slot');
  await sleep(120);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  ok(row.savedData.equipment && row.savedData.equipment.weapon, 'and was persisted immediately');
  await c.close();
});

scenario('items: unequip refuses when the inventory is full', async () => {
  const c = await connectWithSaved('harness_unequip', { inventory: [{ id: 'uq_axe_l', enhance: 0 }] });
  await enterWorld(c, 'lev');
  await (async () => { const s = c.wait('inventorySync'); c.emit('equipItem', { idx: 0 }); await s; })();
  // Fill every inventory slot, then try to take the weapon back. Seeded after
  // the session is closed AND its disconnect flush has landed, or that flush
  // writes the session's empty inventory over this.
  await c.close(); await sleep(500);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  const Player = require('../server/models/Player');
  await Player.updateOne({ _id: row._id }, { $set: { 'savedData.inventory':
    Array.from({ length: 150 }, () => ({ id: 'uq_axe_e', enhance: 0 })) } });
  await sleep(80);
  const c2 = await connectAs('harness_unequip');
  await enterWorld(c2, 'lev');
  const err = c2.wait('itemError', { timeout: 5000 }).catch(() => null);
  c2.emit('unequipItem', { slot: 'weapon' });
  ok(await err, 'a full inventory refuses the unequip');
  await c2.close();
});

scenario('items: a save can no longer write the item set', async () => {
  const c = await connectAs('harness_mint');
  await enterWorld(c, 'mage');
  c.emit('saveProgress', { stats: {
    type: 'mage', lvl: 1, xp: 0, gold: 0, kills: 0, hp: 10, maxHp: 10,
    inventory: [{ id: 'uq_sword_l', enhance: 15 }, { id: 'rece', qty: 9999 }],
    storage: [{ id: 'bless_stone', qty: 500 }],
    equipment: { weapon: { id: 'uq_bow_l', enhance: 15 } },
    savedAt: Date.now(),
  } });
  await sleep(3400);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  const sd = row.savedData || {};
  eq((sd.inventory || []).length, 0, 'minted inventory did not persist');
  eq((sd.storage || []).length, 0, 'minted storage did not persist');
  eq(Object.values(sd.equipment || {}).filter(Boolean).length, 0, 'minted equipment did not persist');
  await c.close();
});

scenario('items: a storage move is one server-side operation', async () => {
  const c = await connectWithSaved('harness_storage', { inventory: [{ id: 'rece', qty: 10 }] });
  await enterWorld(c, 'ranger');
  let sync = c.wait('inventorySync', { timeout: 6000 });
  c.emit('storageDeposit', { idx: 0 });
  let got = await sync;
  eq(got.inventory.length, 0, 'deposit removed it from the inventory');
  eq((got.storage || []).length, 1, 'and put it in storage — in the same message');
  sync = c.wait('inventorySync', { timeout: 6000 });
  c.emit('storageWithdraw', { idx: 0 });
  got = await sync;
  eq((got.storage || []).length, 0, 'withdraw took it back out');
  eq(got.inventory.length, 1, 'and returned it to the inventory');
  eq(got.inventory[0].qty, 10, 'with the stack intact');
  await c.close();
});

scenario('rating: bm reflects real gear, not just level and maxHp', async () => {
  // calcBM (server/anticheat.js) reads sd.atk/sd.def — the full, gear-
  // inclusive combat stats — but _buildSaveStats() (js/network.js) never
  // sends those fields in ANY saveProgress call, ever; only baseAtk/baseDef
  // (pre-equipment) ever reach the server. Calling calcBM directly on the
  // saved blob silently treated atk/def as 0 for every player, so the
  // stored bm (what the rating panel sorts by) collapsed to roughly
  // lvl*50 + maxHp*0.5 the moment a real saveProgress landed — discarding
  // gear entirely — while the client's own HUD (recompute()'s real atk/def)
  // kept showing the correct number. That's what made the rating look
  // wrong: two players at the same level with very different gear ended up
  // with nearly-identical stored bm.
  //
  // uq_sword_l is a legendary deathknight weapon worth +130 atk — enough to
  // move calcBM's atk*5 term by 650, an unmissable jump if gear is actually
  // being counted at all.
  const { calcBM } = require('../server/anticheat');
  const RoomClass = require('../server/game/Room');
  const { CHAR_DEF } = require('../shared/definitions');
  const bare = await connectWithSaved('harness_bm_bare', { lvl: 20, type: 'deathknight' });
  await enterWorld(bare, 'deathknight');
  // The exact bare shape _buildSaveStats() sends — no atk/def, ever.
  bare.emit('saveProgress', { stats: {
    type: 'deathknight', floor: 1, hp: 100, maxHp: 100, kills: 0,
    hudPotion: 'pt1', autoHpPct: 0.5, autoBuffTypes: {}, lang: 'ru', savedAt: Date.now(),
  } });
  await sleep(3400);
  const bareRow = memory.__dump('Player').find(p => p.username === bare.auth.username);
  await bare.close();

  const geared = await connectWithSaved('harness_bm_geared', {
    lvl: 20, type: 'deathknight',
    equipment: { weapon: { id: 'uq_sword_l', enhance: 0 } },
  });
  await enterWorld(geared, 'deathknight');
  geared.emit('saveProgress', { stats: {
    type: 'deathknight', floor: 1, hp: 100, maxHp: 100, kills: 0,
    hudPotion: 'pt1', autoHpPct: 0.5, autoBuffTypes: {}, lang: 'ru', savedAt: Date.now(),
  } });
  await sleep(3400);
  const gearedRow = memory.__dump('Player').find(p => p.username === geared.auth.username);
  await geared.close();

  ok(bareRow.bm > 0, 'the bare account still gets a real bm (not zero/undefined)');
  ok(gearedRow.bm >= bareRow.bm + 600,
    `the legendary weapon actually moves bm (bare=${bareRow.bm}, geared=${gearedRow.bm})`);

  // Not just "some number changed" — has to match what Room.computeStats
  // (the same authoritative source combat/publicProfile already trust)
  // derives for this exact level+gear, so a regression that over- or
  // under-counts gear doesn't slip through unnoticed.
  const cd = CHAR_DEF.deathknight;
  const trueStats = RoomClass.computeStats(
    { lvl: 20, baseAtk: cd.baseAtk + 19, baseDef: cd.baseDef + 19, baseMaxHp: cd.baseHP + 19 * 20,
      equipment: { weapon: { atk: 130, def: 0, hp: 1000, critChance: 0.50, enhance: 0 } }, upgrades: {} },
    cd, 'deathknight', 0,
  );
  const expected = calcBM({ lvl: 20, atk: trueStats.atk, def: trueStats.def, maxHp: trueStats.maxHp, upgrades: {} });
  eq(gearedRow.bm, expected, 'the stored bm matches the real computeStats-derived figure exactly');
});

scenario('party: growing an existing party doesn\'t break it for the others', async () => {
  // Investigated a report that a party "breaks apart" when someone else
  // sends a party invite. Covers every shape that report could reasonably
  // mean: an existing member inviting a new one to grow the party, an
  // outsider trying to invite someone who is already partied (must be
  // silently refused, not disrupt anything), and a full party refusing a
  // 6th member — none of these should touch the existing members' rosters.
  const a = await connectAs('harness_party_a');
  const b = await connectAs('harness_party_b');
  const c = await connectAs('harness_party_c');
  const d = await connectAs('harness_party_d');
  await enterWorld(a, 'ranger'); await enterWorld(b, 'ranger');
  await enterWorld(c, 'ranger'); await enterWorld(d, 'ranger');

  // Form a 2-person party: a invites b, b accepts.
  const aUpd1 = a.wait('partyUpdated', { timeout: 4000 });
  const bInv  = b.wait('partyInviteReceived', { timeout: 4000 });
  a.emit('partyInvite', { targetId: b.sock.id });
  const inv1 = await bInv;
  eq(inv1.fromId, a.sock.id, 'b is told who invited them');
  const bUpd1 = b.wait('partyUpdated', { timeout: 4000 });
  b.emit('partyAccept', { fromId: a.sock.id });
  const [au1, bu1] = await Promise.all([aUpd1, bUpd1]);
  eq(au1.members.length, 1, 'a now sees exactly b');
  eq(bu1.members.length, 1, 'b now sees exactly a');

  // An outsider (d) invites a, who is already partied — must be silently
  // refused: d gets nothing back, and — the actual bug shape reported — the
  // party must not dissolve or change for b either.
  const dGotNothing = d.wait('partyInviteReceived', { timeout: 1500 }).then(() => 'got one').catch(() => 'nothing');
  const bGotNothing = b.wait('partyUpdated', { timeout: 1500 }).then(() => 'got one').catch(() => 'nothing');
  d.emit('partyInvite', { targetId: a.sock.id });
  eq(await dGotNothing, 'nothing', 'a, already partied, never sees the outside invite reach them');
  eq(await bGotNothing, 'nothing', 'and b\'s side of the party is never touched by it');

  // b (an existing member, not the one who formed the party) invites c to
  // grow it. a must be told about the new member — that is the actual "does
  // the party survive a new invite" question the report was about.
  const aUpd2 = a.wait('partyUpdated', { timeout: 4000 });
  const cInv  = c.wait('partyInviteReceived', { timeout: 4000 });
  b.emit('partyInvite', { targetId: c.sock.id });
  await cInv;
  const cUpd = c.wait('partyUpdated', { timeout: 4000 });
  const bUpd2 = b.wait('partyUpdated', { timeout: 4000 });
  c.emit('partyAccept', { fromId: b.sock.id });
  const [au2, bu2, cu2] = await Promise.all([aUpd2, bUpd2, cUpd]);
  eq(au2.members.length, 2, 'a sees the party grow to 2 others (b, c) — not dissolve');
  eq(bu2.members.length, 2, 'so does b');
  eq(cu2.members.length, 2, 'and c joined the SAME party (a+b), not a fresh one');
  ok(au2.members.some(m => m.id === c.sock.id), 'a specifically sees c as a new party-mate');

  // c declining a fresh invite tells the inviter, instead of leaving them
  // with no signal at all (partyDecline used to be a pure no-op).
  const e = await connectAs('harness_party_e');
  await enterWorld(e, 'ranger');
  const declineToast = a.wait('partyInviteDeclined', { timeout: 4000 });
  const eInv = e.wait('partyInviteReceived', { timeout: 4000 });
  a.emit('partyInvite', { targetId: e.sock.id });
  await eInv;
  e.emit('partyDecline', { fromId: a.sock.id });
  const declined = await declineToast;
  eq(declined.byName, e.auth.username, 'the inviter is told who declined');

  await Promise.all([a, b, c, d, e].map(x => x.close()));
});

scenario('reconnect: a second socket for the same account kicks the first', async () => {
  const c1 = await connectAs('harness_kick');
  await enterWorld(c1, 'warlock');
  const kicked = c1.wait('kicked', { timeout: 6000 }).catch(() => null);
  const c2 = await connectAs('harness_kick');
  ok(await kicked, 'the first session was told it was replaced');
  await c1.close(); await c2.close();
});

scenario('bundle: the concatenated client parses and declares nothing twice', async () => {
  // The client is 24 files joined into ONE script, so two files declaring the
  // same `const` is a SyntaxError that stops the entire bundle from loading —
  // a total outage, and one no server-side scenario can see. Moving a constant
  // into shared/definitions.js without deleting the old copy does exactly
  // that, and it reached a commit before this check existed.
  const fs = require('fs');
  const files = require('../server/bundle-files');
  ok(files.length > 10, `bundle file list found (${files.length} files)`);
  const bundle = files.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n');
  let err = null;
  try { new (require('vm').Script)(bundle, { filename: 'bundle.js' }); }
  catch (e) { err = e.message; }
  ok(!err, 'the concatenated bundle parses', err);

  // Name the collision rather than only reporting a parse error, so the fix is
  // obvious from the failure line.
  const seen = new Map(), dupes = [];
  for (const f of files) {
    for (const m of fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/^const ([A-Za-z_$][\w$]*)\s*=/gm)) {
      if (seen.has(m[1]) && seen.get(m[1]) !== f) dupes.push(`${m[1]} (${seen.get(m[1])} and ${f})`);
      else seen.set(m[1], f);
    }
  }
  ok(dupes.length === 0, 'no top-level const is declared in two bundle files', dupes.join(', '));
});

scenario('buffs: the x2 multipliers cannot be claimed by a save', async () => {
  // This one is load-bearing: gold and XP read buffs.gold / buffs.exp to apply
  // the x2, so a save able to write a permanently active buff would double
  // every payout for good. Drinking is a request (useBuffPotion) and the timer
  // is the server's.
  const c = await connectWithSaved('harness_buff', { gold: 0, buffs: {} });
  await enterWorld(c, 'mage');
  c.emit('saveProgress', { stats: {
    type: 'mage', lvl: 1, xp: 0, hp: 10, maxHp: 10,
    buffs: { gold: 999999, exp: 999999 }, savedAt: Date.now(),
  } });
  await sleep(3400);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  eq(Object.keys(row.savedData.buffs || {}).length, 0, 'the forged buffs did not persist');
  await c.close();
});

scenario('buffs: drinking one is served by the server', async () => {
  const c = await connectWithSaved('harness_drink', { inventory: [{ id: 'bp_gold', qty: 1 }] });
  await enterWorld(c, 'ranger');
  const sync = c.wait('buffSync', { timeout: 6000 }).catch(() => null);
  const inv  = c.wait('inventorySync', { timeout: 6000 }).catch(() => null);
  c.emit('useBuffPotion', { id: 'bp_gold' });
  const st = await sync;
  ok(st && st.buffs && st.buffs.gold > 0, `the buff started server-side (${st && st.buffs && st.buffs.gold}s)`);
  const iv = await inv;
  eq(iv && iv.inventory.length, 0, 'and the potion was consumed');
  await c.close();
});

scenario('save: a blank save no longer resets anything', async () => {
  // The catastrophic-reset guard used to catch this. It is gone, because every
  // field it protected is taken from the session copy now — so an empty blob
  // has nothing left to overwrite.
  const c = await connectWithSaved('harness_blank', {
    gold: 777, lvl: 4, inventory: [{ id: 'rece', qty: 3 }], questIdx: 2,
  });
  await enterWorld(c, 'lev');
  c.emit('saveProgress', { stats: { type: 'lev', savedAt: Date.now() } });
  await sleep(3400);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  const sd = row.savedData || {};
  eq(sd.gold, 777, 'gold survived a blank save');
  eq(sd.lvl, 4, 'level survived');
  eq((sd.inventory || []).length, 1, 'items survived');
  eq(sd.questIdx, 2, 'quest progress survived');
  await c.close();
});

scenario('market: listing an item and reading my lots back', async () => {
  // VIP 1 is the gate on selling; the item has to be in the SERVER's inventory.
  const c = await connectWithSaved('harness_market', {
    vipLevel: 1, inventory: [{ id: 'uq_sword_l', enhance: 0 }],
  });
  await enterWorld(c, 'deathknight');

  const listed = c.wait('marketListed', { timeout: 8000 }).catch(() => null);
  const err    = c.wait('marketListError', { timeout: 8000 }).catch(() => null);
  const inv    = c.wait('inventorySync', { timeout: 8000 }).catch(() => null);
  c.emit('marketList', { item: { id: 'uq_sword_l', enhance: 0 }, price: 10 });
  const got = await Promise.race([listed, err]);
  ok(got && got.listing, `the listing was created${got && got.msg ? ' — refused: ' + got.msg : ''}`);
  const iv = await inv;
  eq(iv && iv.inventory.length, 0, 'and the item left the server inventory');

  // The tab that is reported as stuck on "loading".
  const mine = c.wait('marketMyListingsData', { timeout: 8000 }).catch(() => null);
  c.emit('marketMyListings', {});
  const rows = await mine;
  ok(rows, 'marketMyListingsData came back at all');
  eq(rows && rows.listings && rows.listings.length, 1, 'and carried the lot');
  await c.close();
});

scenario('market: cancelling a lot returns the item', async () => {
  const c = await connectWithSaved('harness_marketcancel', {
    vipLevel: 1, inventory: [{ id: 'uq_bow_l', enhance: 0 }],
  });
  await enterWorld(c, 'ranger');
  const listed = c.wait('marketListed', { timeout: 8000 }).catch(() => null);
  c.emit('marketList', { item: { id: 'uq_bow_l', enhance: 0 }, price: 10 });
  const l = await listed;
  ok(l && l.listing, 'listed');
  if (!l || !l.listing) return c.close();
  const back = c.wait('inventorySync', { timeout: 8000 }).catch(() => null);
  c.emit('marketCancel', { listingId: l.listing.id });
  const iv = await back;
  eq(iv && iv.inventory.length, 1, 'the item came back to the inventory');
  await c.close();
});

scenario('market: a regular seller is capped at 5 active listings, VIP 3+ is not', async () => {
  // Seeded directly rather than listed one at a time — marketList's own
  // MARKET_LIST_COOLDOWN_MS (3s) would make 5-6 real listings slow, and the
  // cap itself is just a countDocuments comparison, so pre-existing rows are
  // exactly as good a fixture as ones this session created.
  const MarketListing = require('../server/models/MarketListing');
  async function seedActive(telegramId, username, n) {
    for (let i = 0; i < n; i++) {
      await MarketListing.create({
        sellerId: telegramId, sellerUsername: username,
        item: { id: 'rece', qty: 1 }, price: 1, status: 'active',
      });
    }
  }

  const c1 = await connectWithSaved('harness_market_cap5', {
    vipLevel: 1, inventory: [{ id: 'uq_sword_l', enhance: 0 }],
  });
  await enterWorld(c1, 'deathknight');
  const row1 = memory.__dump('Player').find(p => p.username === c1.auth.username);
  await seedActive(row1.telegramId, c1.auth.username, 5);

  const err = c1.wait('marketListError', { timeout: 8000 });
  c1.emit('marketList', { item: { id: 'uq_sword_l', enhance: 0 }, price: 10 });
  const e = await err;
  ok(e && /Максимум 5/.test(e.msg || ''), `a 6th listing is refused below VIP 3 (got: ${e && e.msg})`);
  await c1.close();

  const c2 = await connectWithSaved('harness_market_vip3_cap', {
    vipLevel: 3, inventory: [{ id: 'uq_sword_l', enhance: 0 }],
  });
  await enterWorld(c2, 'deathknight');
  const row2 = memory.__dump('Player').find(p => p.username === c2.auth.username);
  await seedActive(row2.telegramId, c2.auth.username, 5);

  const listed = c2.wait('marketListed', { timeout: 8000 }).catch(() => null);
  const err2 = c2.wait('marketListError', { timeout: 8000 }).catch(() => null);
  c2.emit('marketList', { item: { id: 'uq_sword_l', enhance: 0 }, price: 10 });
  const got = await Promise.race([listed, err2]);
  ok(got && got.listing, `VIP 3 lists a 6th past the 5-listing cap${got && got.msg ? ' — refused: ' + got.msg : ''}`);
  await c2.close();
});

// The in-memory Mongo double (dev/mongo-memory.js) resolves every query
// through a plain Promise with no real I/O behind it — every await in a
// handler settles within the same microtask sweep, all of which drains
// before the event loop looks at the NEXT incoming socket frame. Against a
// real MongoDB (single-digit-to-double-digit milliseconds per round trip)
// that gap is wide open; against the double it's sub-microsecond, too narrow
// for a second client message to land inside no matter how fast it's sent.
// These two races specifically need that gap to be real, so they patch the
// one model call the vulnerable handler awaits to actually take a few
// milliseconds — not to mock server logic (nothing about the handler changes),
// only to give the double the same round-trip shape a production database
// already has. Restored in a `finally` so no later scenario inherits it.
async function _withDbDelay(Model, method, ms, fn) {
  const orig = Model[method].bind(Model);
  Model[method] = async (...args) => { await sleep(ms); return orig(...args); };
  try { await fn(); } finally { Model[method] = orig; }
}

scenario('race: marketList racing equipItem cannot duplicate the item', async () => {
  // marketList re-verifies ownership, then awaits MarketListingModel.create()
  // — a real yield point — and only removes the item from inventory AFTER
  // that resolves. equipItem is fully synchronous: fired into that gap it
  // moves the sword out of plain inventory and into the equipment slot
  // before marketList's own removal runs. The bug this proves fixed: that
  // removal used to fire-and-forget (_invRemove's return value discarded),
  // so it silently found nothing and did nothing — the listing went live
  // for a sword that was ALSO still equipped and usable. The fix checks
  // _invRemove's result and unwinds (deletes) the listing when it fails.
  const c = await connectWithSaved('harness_race_market_equip', {
    vipLevel: 1, inventory: [{ id: 'uq_sword_l', enhance: 0 }],
  });
  await enterWorld(c, 'deathknight');

  const MarketListing = require('../server/models/MarketListing');
  await _withDbDelay(MarketListing, 'create', 60, async () => {
    const listedP = c.wait('marketListed', { timeout: 8000 }).catch(() => null);
    const listErrP = c.wait('marketListError', { timeout: 8000 }).catch(() => null);
    c.emit('marketList', { item: { id: 'uq_sword_l', enhance: 0 }, price: 10 });
    // Sent right as marketList's create() is in flight — see _withDbDelay.
    await sleep(20);
    c.emit('equipItem', { idx: 0 });
    await Promise.race([listedP, listErrP]);
  });
  await sleep(200); // let any trailing inventorySync settle

  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  const listings = memory.__dump('MarketListing')
    .filter(l => l.sellerUsername === c.auth.username && l.status === 'active');
  const invHasSword = (row.savedData.inventory || []).some(i => i && i.id === 'uq_sword_l');
  const eqHasSword = !!(row.savedData.equipment && row.savedData.equipment.weapon
    && row.savedData.equipment.weapon.id === 'uq_sword_l');
  const copies = (invHasSword ? 1 : 0) + (eqHasSword ? 1 : 0) + listings.length;
  eq(copies, 1,
    `exactly one copy of the sword survives the race (inventory:${invHasSword} equipped:${eqHasSword} activeListings:${listings.length})`);

  await c.close();
});

scenario('race: claimVipRewards racing equipItem cannot duplicate or lose the item', async () => {
  // claimVipRewards clones _lastStats.inventory before its DB awaits
  // (findById, updateOne) and commits that clone wholesale at the end via
  // _commitServerItems(inv, null, ...) — which does _lastStats.inventory =
  // inv unconditionally. equipItem is synchronous: fired into that window it
  // moves an item out of the LIVE inventory and into the equipment slot —
  // but the clone still has it, since it was taken before the equip ran. The
  // bug this proves fixed: claimVipRewards' stale-clone commit used to stamp
  // that clone back over the live array, resurrecting the sword in inventory
  // even though it was ALSO now equipped. The fix gates equipItem (and every
  // other synchronous inventory handler) behind _itemOpBusy, which
  // claimVipRewards already raises for the duration of its own await window.
  const c = await connectWithSaved('harness_race_vip_equip', {
    inventory: [{ id: 'uq_sword_l', enhance: 0 }],
    vipPending: [1],
  });
  await enterWorld(c, 'deathknight');

  // Delaying findById (the FIRST await) is too early: the vulnerable
  // inventory snapshot (_liveInventory()) isn't taken until AFTER it
  // resolves, so an equip landing during that particular wait is captured
  // correctly, not lost. The real window is between that snapshot and the
  // handler's LAST await — the same-session PlayerModel.updateOne that
  // commits the snapshot — so that's the one this delays.
  const Player = require('../server/models/Player');
  await _withDbDelay(Player, 'updateOne', 60, async () => {
    const claimedP = c.wait('vipRewardsClaimed', { timeout: 8000 }).catch(() => null);
    c.emit('claimVipRewards');
    // Sent right as claimVipRewards' updateOne is in flight — see _withDbDelay.
    await sleep(20);
    c.emit('equipItem', { idx: 0 });
    await claimedP;
  });
  await sleep(200);

  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  const invCopies = (row.savedData.inventory || []).filter(i => i && i.id === 'uq_sword_l').length;
  const eqHasSword = !!(row.savedData.equipment && row.savedData.equipment.weapon
    && row.savedData.equipment.weapon.id === 'uq_sword_l');
  eq(invCopies + (eqHasSword ? 1 : 0), 1,
    `the original sword survives exactly once (inventoryCopies:${invCopies} equipped:${eqHasSword})`);

  await c.close();
});

scenario('race: spendUpgrade cannot exceed the skill point budget by racing two keys', async () => {
  // Budget/gold were read from _lastStats, then _serverSpendGold was
  // awaited, and only THEN was upgrades[key] written off a `lvl` captured
  // before that await — with nothing serializing two spendUpgrade calls
  // against each other. Racing two DIFFERENT keys let both read the same
  // pre-write "spent" total and both pass the same one-point-left budget
  // check, so both committed — one point over budget, for free. The fix
  // wraps the whole handler in _withEconLock so only one can run at a time.
  //
  // lvl 1 with no rebirths gives a tiny, known budget (skillPointBudget) —
  // seeded with gold to spare so only the point budget, not gold, gates this.
  const c = await connectWithSaved('harness_race_upgrade_budget', {
    lvl: 1, gold: 1_000_000, upgrades: {},
  });
  await enterWorld(c, 'ranger');

  const budget = require('../shared/definitions').skillPointBudget(1, 0);
  if (budget < 1) {
    // Nothing to prove at budget 0 — a fresh level-1 account with no rebirth
    // bonus may simply have none to spend yet.
    ok(true, 'skipped — level 1 has no skill points to budget-test');
    await c.close();
    return;
  }
  // Spend the budget down to exactly one point left, sequentially (each one
  // awaited), so what's left is deterministic before the race below.
  const keys = require('../shared/definitions').UPGRADE_KEYS;
  for (let i = 0; i < budget - 1; i++) {
    const sync = c.wait('progressSync', { timeout: 5000 });
    c.emit('spendUpgrade', { key: keys[0] });
    await sync;
  }

  // Exactly one point of budget left. Race it across two DIFFERENT keys —
  // the bug is specifically a cross-key bypass (same-key racing just
  // double-charges gold for one committed level, which _withEconLock closes
  // too, but this is the one that lets a player exceed their true budget).
  const p1 = c.wait('progressSync', { timeout: 8000 }).catch(() => null);
  c.emit('spendUpgrade', { key: keys[0] });
  c.emit('spendUpgrade', { key: keys[1] });
  await p1;
  await sleep(400);

  const after = memory.__dump('Player').find(p => p.username === c.auth.username);
  const spentAfter = Object.values(after.savedData.upgrades || {})
    .reduce((s, v) => s + (Number(v) || 0), 0);
  ok(spentAfter <= budget,
    `total spent upgrade points (${spentAfter}) never exceeds the real budget (${budget})`);

  await c.close();
});

scenario('market: buying a lot pays the seller', async () => {
  // MARKET_FEE_PCT used to be undefined here (exported from inventory.js but
  // never imported into index.js): price * (1 - undefined) is NaN, and
  // _incBalance refuses a non-finite delta outright, so the seller's payout
  // silently never happened while the buyer still paid and got the item.
  const seller = await connectWithSaved('harness_market_seller', {
    vipLevel: 1, gramBalance: 0, inventory: [{ id: 'uq_sword_l', enhance: 0 }],
  });
  await enterWorld(seller, 'deathknight');
  const listed = seller.wait('marketListed', { timeout: 8000 });
  seller.emit('marketList', { item: { id: 'uq_sword_l', enhance: 0 }, price: 10 });
  const l = await listed;
  ok(l && l.listing, 'listing created');
  if (!l || !l.listing) return seller.close();

  const buyer = await connectWithSaved('harness_market_buyer', { gramBalance: 100 });
  await enterWorld(buyer, 'ranger');

  const sellerCredit = seller.wait('gramBalanceUpdate', { timeout: 8000 });
  const bought = buyer.wait('marketBought', { timeout: 8000 });
  buyer.emit('marketBuy', { listingId: l.listing.id });
  const bo = await bought;
  ok(bo && bo.delivered !== false, 'buyer received the item');

  const credit = await sellerCredit;
  eq(credit.balance, 9, 'seller was credited price minus the 10% fee');

  await seller.close();
  await buyer.close();
});

scenario('reconnect: bonusSP/rebirths/upgrades survive it', async () => {
  // A reconnect's selectChar sends _buildSaveStats() (js/network.js), which
  // never carries lvl/bonusSP/rebirths/upgrades at all — only type, floor,
  // hp/maxHp, kills, potion/buff prefs and lang. The level/XP-become-
  // server-owned change pinned lvl/xp back from the stored record on every
  // selectChar, but left bonusSP/rebirths/upgrades to fall through from
  // that bare blob — so a reconnect zeroed them in memory, and the very next
  // periodic autosave wrote the zero over the real stored totals for good.
  // lvl 35 (past REBIRTH_LEVEL=30) so a rebirth's budget isn't zeroed
  // (skillPointBudget returns 0 below REBIRTH_LEVEL once rebirths > 0).
  const c1 = await connectWithSaved('harness_reconnect_sp', {
    lvl: 35, bonusSP: 15, rebirths: 2, upgrades: { atk: 30 },
  });
  await enterWorld(c1, 'lev');
  await c1.close();
  await sleep(500);

  const c2 = await connectAs('harness_reconnect_sp');
  const sync = c2.wait('progressSync', { timeout: 8000 });
  // The exact shape _buildSaveStats() sends on a real reconnect.
  c2.emit('selectChar', { type: 'lev', savedStats: {
    type: 'lev', floor: 1, hp: 100, maxHp: 100, kills: 0,
    hudPotion: 'pt1', autoHpPct: 0.5, autoBuffTypes: {}, lang: 'ru', savedAt: Date.now(),
  } });
  const ps = await sync;
  eq(ps.upgrades && ps.upgrades.atk, 30, 'progressSync still carries the real upgrades');

  // The periodic autosave the real client fires every few seconds off the
  // same bare _buildSaveStats() shape — this is the write that would make a
  // reconnect's in-memory zeroing permanent.
  c2.emit('saveProgress', { stats: {
    type: 'lev', floor: 1, hp: 100, maxHp: 100, kills: 0,
    hudPotion: 'pt1', autoHpPct: 0.5, autoBuffTypes: {}, lang: 'ru', savedAt: Date.now(),
  } });
  await sleep(3400); // let the debounced write land
  const row = memory.__dump('Player').find(p => p.username === c2.auth.username);
  eq(row.savedData.bonusSP, 15, 'bonusSP was not zeroed by the autosave');
  eq(row.savedData.rebirths, 2, 'rebirths was not zeroed by the autosave');
  eq(row.savedData.upgrades && row.savedData.upgrades.atk, 30, 'upgrades was not zeroed by the autosave');
  await c2.close();
});

scenario('reconnect: potionBag/buffs/techClaimed/specialQuestsDone survive it', async () => {
  // Same failure shape as the bonusSP/rebirths/upgrades bug above, just for
  // four fields that were missed when that fix went in: _buildSaveStats()
  // (js/network.js) never carries potionBag, buffs, techClaimed or
  // specialQuestsDone at all, so a reconnect's bare selectChar blob sanitizes
  // down to an empty bag/no buffs/unclaimed/no-quests-done — and the very
  // next periodic autosave (which pins these straight from _lastStats) wrote
  // that wipe over the real stored values for good. This is what made HP
  // potions "randomly disappear": any ordinary reconnect (a backgrounded
  // mobile tab, a brief network drop) was enough to zero the bag.
  const c1 = await connectWithSaved('harness_reconnect_potions', {
    lvl: 10, potionBag: { pt1: 12, pt2: 3 }, buffs: { gold: 3600 },
    techClaimed: true, specialQuestsDone: ['welcome'],
  });
  await enterWorld(c1, 'ranger');
  await c1.close();
  await sleep(500);

  const c2 = await connectAs('harness_reconnect_potions');
  const sync = c2.wait('potionBag', { timeout: 8000 });
  // The exact shape _buildSaveStats() sends on a real reconnect — no
  // potionBag/buffs/techClaimed/specialQuestsDone field at all.
  c2.emit('selectChar', { type: 'ranger', savedStats: {
    type: 'ranger', floor: 1, hp: 100, maxHp: 100, kills: 0,
    hudPotion: 'pt1', autoHpPct: 0.5, autoBuffTypes: {}, lang: 'ru', savedAt: Date.now(),
  } });
  const bagSync = await sync;
  eq(bagSync.potionBag && bagSync.potionBag.pt1, 12, 'the reconnect is told its real bag right away, not zero');

  // The periodic autosave the real client fires every few seconds off the
  // same bare _buildSaveStats() shape — this is the write that would make a
  // reconnect's in-memory wipe permanent.
  c2.emit('saveProgress', { stats: {
    type: 'ranger', floor: 1, hp: 100, maxHp: 100, kills: 0,
    hudPotion: 'pt1', autoHpPct: 0.5, autoBuffTypes: {}, lang: 'ru', savedAt: Date.now(),
  } });
  await sleep(3400); // let the debounced write land
  const row = memory.__dump('Player').find(p => p.username === c2.auth.username);
  eq(row.savedData.potionBag && row.savedData.potionBag.pt1, 12, 'potionBag.pt1 was not zeroed by the autosave');
  eq(row.savedData.potionBag && row.savedData.potionBag.pt2, 3, 'potionBag.pt2 was not zeroed by the autosave');
  eq(row.savedData.buffs && row.savedData.buffs.gold, 3600, 'buffs was not wiped by the autosave');
  eq(row.savedData.techClaimed, true, 'techClaimed was not reset by the autosave');
  ok((row.savedData.specialQuestsDone || []).includes('welcome'), 'specialQuestsDone was not wiped by the autosave');
  await c2.close();
});

scenario('hp: a save cannot hand the player health', async () => {
  const c = await connectWithSaved('harness_hp', { lvl: 1, hp: 5 });
  await enterWorld(c, 'lev');
  c.emit('saveProgress', { stats: {
    type: 'lev', hp: 99999, maxHp: 99999, kills: 0, savedAt: Date.now(),
  } });
  await sleep(3400);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  ok(row.savedData.hp < 99999, `the stored hp is the server's (${row.savedData.hp})`);
  await c.close();
});

scenario('hp: reconnecting does not full-heal', async () => {
  // setPlayerChar seats the character at the hp selectChar was given, so
  // accepting it from the client meant a free full heal on demand — reconnect
  // with hp at maximum, mid-boss or mid-PvP, and walk away topped up.
  const c = await connectWithSaved('harness_hpheal', { lvl: 1, hp: 7, maxHp: 260 });
  await enterWorld(c, 'lev');
  await c.close();
  await sleep(500);
  const c2 = await connectAs('harness_hpheal');
  await enterWorld(c2, 'lev', { type: 'lev', hp: 99999, maxHp: 99999, savedAt: Date.now() });
  await sleep(300);
  const row = memory.__dump('Player').find(p => p.username === c2.auth.username);
  ok(row.savedData.hp < 100, `the character resumed on its stored hp (${row.savedData.hp})`);
  await c2.close();
});

scenario('handlers: none of the 115 throws on a bare request', async () => {
  // The check the two missing-import regressions needed, and the reason a
  // scenario per handler is not the answer: there are 115 of them and the
  // scenarios cover 17.
  //
  // Both regressions were a symbol moved out of server/index.js with the uses
  // left behind. Neither is a syntax error — a reference that never executes is
  // not one — so they surfaced only when a handler ran. This runs all of them:
  // every safeOn event is emitted once with an empty payload, and the
  // handler-error watch above turns any ReferenceError into a failure.
  //
  // Most will refuse the request on validation, which is the point: a missing
  // constant is usually read BEFORE the payload is looked at (a rate-limit
  // window, a price ceiling, a cap), so an empty payload is enough to find it.
  // What this deliberately does NOT check is that a handler does its job — the
  // scenarios above are for that.
  const fs = require('fs');
  const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  const events = [...new Set([...src.matchAll(/safeOn\('([a-zA-Z0-9_]+)'/g)].map(m => m[1]))]
    // Skip the ones that would end the session out from under the sweep.
    .filter(e => !['disconnect', 'loginTelegram', 'loginTelegramWebApp'].includes(e));
  ok(events.length > 100, `found ${events.length} handlers to sweep`);

  const c = await connectWithSaved('harness_sweep', { vipLevel: 1, gold: 100, inventory: [] });
  await enterWorld(c, 'mage');
  const before = handlerErrors.length;
  for (const ev of events) { c.emit(ev, {}); await sleep(12); }
  await sleep(1200);   // let the async ones settle
  const thrown = handlerErrors.slice(before);
  ok(thrown.length === 0, `no handler threw on an empty payload (${thrown.length} did)`,
     [...new Set(thrown)].slice(0, 10).join(' | '));
  await c.close();
});

scenario('exposure: the repository is not served as static files', async () => {
  // express.static was mounted on the project root, which published every file
  // in it: server/index.js and server/security.js in full, the models, the
  // audit documents, and /.git — from which the whole history, and anything
  // ever committed to it, can be reconstructed. It was the default that came
  // with pointing it at '..', and nothing about the game needed any of it.
  const leaky = ['/server/index.js', '/server/security.js', '/server/anticheat.js',
                 '/server/models/Player.js', '/shared/definitions.js', '/dev/harness.js',
                 '/package.json', '/package-lock.json', '/.git/config', '/.git/HEAD',
                 '/AUDIT.md', '/SCALING.md', '/dev/seed.js'];
  for (const p of leaky) {
    const r = await fetch(BASE + p).catch(() => ({ status: 599 }));
    ok(r.status !== 200, `not public: ${p}`, `served with ${r.status}`);
  }
  // And the things that must stay public still are.
  for (const p of ['/', '/index.html', '/guide.html', '/admin.html', '/css/style.css',
                   '/bundle.js', '/tonconnect-manifest.json', '/js/pixi.min.js']) {
    const r = await fetch(BASE + p).catch(() => ({ status: 599 }));
    eq(r.status, 200, `still public: ${p}`);
  }
});

scenario('potions: buying adds them and persists', async () => {
  const c = await connectWithSaved('harness_potbuy', { gold: 100, potionBag: {} });
  await enterWorld(c, 'mage');
  const gold = c.wait('goldSync', { timeout: 6000 }).catch(() => null);
  const bag  = c.wait('potionBag', { timeout: 6000 }).catch(() => null);
  c.emit('buyPotion', { idx: 0, qty: 4 });     // pt1, 5 gold each
  const g = await gold, b = await bag;
  eq(g && g.gold, 80, 'gold went down by the price');
  eq(b && b.potionBag && b.potionBag.pt1, 4, 'and the potions came back in the same round trip');
  ok(b && b.bought && b.bought.n === 4, 'with what was bought, for the confirmation line');
  await sleep(200);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  eq(row.savedData.potionBag && row.savedData.potionBag.pt1, 4, 'and both were persisted');
  eq(row.savedData.gold, 80, 'gold too');
  await c.close();
});

scenario('potions: drinking one is persisted, not just decremented in memory', async () => {
  // It used to ride "the normal progress save", which stopped carrying
  // potionBag the moment that field was pinned — so a drunk potion came back
  // on the next reconnect.
  const c = await connectWithSaved('harness_potuse', { potionBag: { pt1: 3 }, hp: 10, maxHp: 260, lvl: 1 });
  await enterWorld(c, 'lev');
  const bag = c.wait('potionBag', { timeout: 6000 }).catch(() => null);
  c.emit('usePotion', { id: 'pt1' });
  const b = await bag;
  eq(b && b.potionBag && b.potionBag.pt1, 2, 'the server spent one from its own bag');
  await sleep(250);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  eq(row.savedData.potionBag && row.savedData.potionBag.pt1, 2, 'and wrote it down');
  await c.close();
});

scenario('potions: an empty bag cannot be drunk from', async () => {
  const c = await connectWithSaved('harness_potempty', { potionBag: { pt1: 0 }, hp: 10, maxHp: 260 });
  await enterWorld(c, 'lev');
  const empty = c.wait('potionEmpty', { timeout: 5000 }).catch(() => null);
  c.emit('usePotion', { id: 'pt1' });
  ok(await empty, 'refused');
  await c.close();
});

scenario('build: the launch path is cacheable and the legacy names still answer', async () => {
  const html = await (await fetch(BASE + '/')).text();
  const js  = (html.match(/\/bundle\.[a-f0-9]+\.js/) || [])[0];
  const css = (html.match(/css\/style\.[a-f0-9]+\.css/) || [])[0];
  ok(js,  'index.html points at a content-addressed bundle', html.match(/bundle[^"']*/) || '');
  ok(css, 'and a content-addressed stylesheet');
  if (!js || !css) return;

  // The whole point: these two may be cached forever, so a repeat launch does
  // not go to the network for them at all.
  for (const [p, what] of [[js, 'bundle'], ['/' + css, 'stylesheet']]) {
    const r = await fetch(BASE + p);
    eq(r.status, 200, `the hashed ${what} is served`);
    ok(/immutable/.test(r.headers.get('cache-control') || ''),
       `and may be cached forever`, r.headers.get('cache-control'));
  }
  // index.html itself must never be: it is how a deploy is noticed.
  const idx = await fetch(BASE + '/');
  ok(/no-cache/.test(idx.headers.get('cache-control') || ''),
     'index.html is not cached', idx.headers.get('cache-control'));

  // A page cached from before the change still points at the old names.
  for (const p of ['/bundle.js', '/css/style.css']) {
    eq((await fetch(BASE + p)).status, 200, `the legacy path still answers: ${p}`);
  }

  // Nothing on the launch path comes from a third party any more.
  // Only real script tags count — the markup carries a comment explaining why
  // the CDN was dropped, and matching that would be matching the explanation.
  const tags = [...html.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/g)].map(m => m[1]);
  ok(!tags.some(u => /^https?:\/\/cdn\.socket\.io/.test(u)), 'no script comes from the socket.io CDN', tags.join(' '));
  ok(!tags.some(u => /tonconnect-ui/.test(u)), 'the wallet library is not in the launch path', tags.join(' '));
  ok(/\/socket\.io\/socket\.io\.js/.test(html), 'it is served from our own origin');
  eq((await fetch(BASE + '/js/vendor/tonconnect-ui.min.js')).status, 200,
     'but is still fetchable on demand');
});

scenario('build: the bundle is minified, mapped, and keeps its HTML entry points', async () => {
  const html = await (await fetch(BASE + '/')).text();
  const jsPath = (html.match(/\/bundle\.[a-f0-9]+\.js/) || [])[0];
  ok(jsPath, 'index.html names the bundle');
  if (!jsPath) return;
  const code = await (await fetch(BASE + jsPath)).text();

  // Minified at all: comments gone, and materially smaller than the sources.
  const fs = require('fs');
  const raw = require('../server/bundle-files')
    .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n');
  ok(code.length < raw.length * 0.75,
     `smaller than the sources (${Math.round(raw.length / 1024)}K -> ${Math.round(code.length / 1024)}K)`);

  // The names the minifier cannot see: onclick attributes in index.html and
  // handlers built inside JS strings. Renaming any of them breaks silently.
  const fromHtml = [...html.matchAll(/on\w+="\s*([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]);
  const fromStrings = [...raw.matchAll(/onclick=\\?["'`]\s*([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]);
  const entryPoints = [...new Set([...fromHtml, ...fromStrings])];
  ok(entryPoints.length > 10, `found ${entryPoints.length} names reachable only from markup`);
  // Looked for in the bundle AND in index.html's own inline scripts — some
  // handlers (the chat panel) are defined right there beside their markup and
  // never reach the minifier at all, so searching only the bundle reports them
  // as lost when nothing happened to them.
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
  const reachable = code + '\n' + inline;
  const lost = entryPoints.filter(n => !new RegExp('\\b' + n + '\\b').test(reachable));
  ok(lost.length === 0, 'every one of them is still defined somewhere', lost.join(', '));

  // And a stack trace stays readable.
  ok(/sourceMappingURL=\/bundle\.[a-f0-9]+\.js\.map/.test(code), 'the bundle points at a source map');
  const mapRes = await fetch(BASE + jsPath + '.map');
  eq(mapRes.status, 200, 'which is served');
  const map = await mapRes.json();
  ok(Array.isArray(map.sources) && map.sources.length > 0, 'and carries sources');
  ok(typeof map.mappings === 'string' && map.mappings.length > 1000, 'and real mappings');
});

// ── Browser check ────────────────────────────────────────────────────────────
// Everything above talks to the server over a socket. This drives the actual
// client: real Chromium, the real bundle, real WebGL. It is what makes changes
// to the BUILD checkable at all — a server scenario cannot tell you the page
// loaded, and the concatenated-bundle parse check cannot tell you it ran.
//
// The browser Playwright wants and the one this environment ships are
// different builds, so the path is resolved rather than assumed; if neither is
// there the scenario says so instead of failing the run for the wrong reason.
function chromiumPath() {
  const fs = require('fs');
  const roots = ['/opt/pw-browsers'];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const d of fs.readdirSync(root)) {
      const p = path.join(root, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

scenario('browser: the real client loads and reaches the world', async () => {
  const exe = chromiumPath();
  if (!exe) { ok(true, 'skipped — no chromium in this environment'); return; }
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { ok(true, 'skipped — playwright not installed'); return; }

  const browser = await chromium.launch({ executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
    const errors = [], failed = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
    page.on('pageerror', e => errors.push('pageerror: ' + e.message.slice(0, 200)));
    page.on('response', r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
    page.on('requestfailed', r => failed.push(`${r.failure() && r.failure().errorText} ${r.url()}`));

    // DEV_LOCAL is on in the harness, so /?dev=<name> logs in through the same
    // path the Mini App uses, with locally signed initData.
    await page.goto(`${BASE}/?dev=browsercheck`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(7000);

    // A fresh account lands on character select; pick a class to reach the world.
    // A fresh account lands on the character carousel (#char-select). Picking
    // a class goes through selectChar(), which is what the play button calls.
    const needsClass = await page.evaluate(() => typeof state !== 'undefined' && state === 'select');
    if (needsClass) {
      await page.evaluate(() => selectChar('mage'));
      await page.waitForTimeout(8000);
    }

    const st = await page.evaluate(() => ({
      state: typeof state !== 'undefined' ? state : null,
      hasPlayer: typeof player !== 'undefined' && !!player,
      lvl: typeof player !== 'undefined' && player ? player.lvl : null,
      connected: typeof socket !== 'undefined' && !!(socket && socket.connected),
      // The three shapes the build changes could break: the shared catalog, a
      // late file in the concat order, and the renderer.
      sharedOk: typeof CHAR_DEF !== 'undefined' && typeof skillDamageMult === 'function',
      lateFileOk: typeof openNpc === 'function',
      pixiOk: typeof PIXI !== 'undefined',
    }));

    ok(st.hasPlayer, 'the client built a player');
    eq(st.state, 'playing', 'and reached the world');
    ok(st.connected, 'with a live socket');
    ok(st.sharedOk, 'the shared catalog is in scope for the game code');
    ok(st.lateFileOk, 'so is the last file in the concat order');
    ok(st.pixiOk, 'the renderer loaded');

    // Real floor transition, driven through the actual client code path
    // (netEnterLocation -> _applyGameStart's floorChange branch -> initNpcs/
    // pixiClearEntityPools/_buildArmGates/buildTileCanvas) rather than the
    // raw socket protocol the 'floors:' scenarios already cover — this is
    // the one check that would catch a client-side exception (a null deref
    // in a real PIXI/DOM environment) those can't.
    await page.evaluate(() => netEnterLocation('left'));
    await page.waitForTimeout(2500);
    const onArm = await page.evaluate(() => ({
      floor: typeof dungeonLvl !== 'undefined' ? dungeonLvl : null,
      npcCount: typeof npcs !== 'undefined' ? npcs.length : null,
      overlayHidden: (() => {
        const el = document.getElementById('char-select');
        return !el || el.style.display === 'none';
      })(),
    }));
    eq(onArm.floor, 2, 'the client followed the server onto the arm floor');
    eq(onArm.npcCount, 0, 'and cleared the hub-only NPCs');
    ok(onArm.overlayHidden, 'and hid the floor-loading overlay again');

    await page.evaluate(() => netEnterLocation('hub'));
    await page.waitForTimeout(2500);
    const backHome = await page.evaluate(() => ({
      floor: typeof dungeonLvl !== 'undefined' ? dungeonLvl : null,
      npcCount: typeof npcs !== 'undefined' ? npcs.length : null,
    }));
    eq(backHome.floor, 1, 'and came back from the return pad request');
    eq(backHome.npcCount, 3, 'with the hub NPCs rebuilt');

    // Only same-origin requests are the game's own responsibility. This
    // sandbox's proxy refuses third-party hosts outright, which says nothing
    // about production — and is a large part of why serving socket.io from
    // our own origin is worth doing.
    const ours = failed.filter(f => f.includes(BASE));
    ok(ours.length === 0, 'no same-origin request failed', ours.join(', '));
    const realErrors = errors.filter(e => !/ERR_TUNNEL|ERR_(NAME|CONNECTION|PROXY)|telegram\.org|cdn\.socket\.io/.test(e));
    ok(realErrors.length === 0, 'no console errors of our own', realErrors.slice(0, 4).join(' | '));
  } finally {
    await browser.close();
  }
});

scenario('browser: entering Страх closes the events panel instead of leaving it over the world', async () => {
  // Clicking "Войти" (netFearEnter) teleports the player into Fear and spawns
  // wave 1 immediately — unlike deathBattle/race10/arena3, which all sit
  // behind a registration window that gives the player time to close this
  // panel themselves before anything actually happens. #events-panel is a
  // near-opaque full-screen overlay (97% alpha, z-index 120, see css/
  // style.css) that used to only ever close on its own "✕" button — so a
  // player who entered Fear was dropped into a live run, monsters and all,
  // still looking at a panel reading "Войдите, чтобы начать". Every single
  // entry went through this exact button, which is why it read as "monsters
  // never appear in Страх" for everyone, every time, right on entry.
  const exe = chromiumPath();
  if (!exe) { ok(true, 'skipped — no chromium in this environment'); return; }
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { ok(true, 'skipped — playwright not installed'); return; }

  // Seeded above FEAR_MIN_LEVEL (10) the same way the other 'reconnect:'
  // scenarios seed a save — connectWithSaved creates the DB row and patches
  // it, then closes; the browser page below logs into that same account via
  // the same /dev/init-data route connectAs itself uses.
  const seed = await connectWithSaved('harness_fear_ui', { lvl: 15 });
  await seed.close();

  const browser = await chromium.launch({ executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
    await page.goto(`${BASE}/?dev=harness_fear_ui`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    const needsClass = await page.evaluate(() => typeof state !== 'undefined' && state === 'select');
    if (needsClass) {
      await page.evaluate(() => selectChar('ranger'));
      await page.waitForTimeout(4000);
    }
    ok(await page.evaluate(() => typeof state !== 'undefined' && state === 'playing'), 'reached the world');

    await page.evaluate(() => { openEventsPanel(); switchEventTab('fear'); });
    await page.waitForTimeout(300);
    ok(await page.evaluate(() => document.getElementById('events-panel')?.style.display === 'flex'),
      'the events panel is open, same as a real player checking Страх');

    await page.evaluate(() => netFearEnter());
    // Poll rather than wait on a fixed delay: fearStarted is a single round
    // trip, but no need to hard-code how long that takes.
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(300);
      if (await page.evaluate(() => typeof dungeonLvl !== 'undefined' && dungeonLvl === 11)) break;
    }

    const after = await page.evaluate(() => ({
      floor: typeof dungeonLvl !== 'undefined' ? dungeonLvl : null,
      panelDisplay: document.getElementById('events-panel')?.style.display,
    }));
    eq(after.floor, 11, 'the client followed the server onto the fear floor');
    eq(after.panelDisplay, 'none', 'and the events panel closed itself, uncovering the world');
  } finally {
    await browser.close();
  }
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

  // Any handler that threw during any scenario, however unrelated.
  const uniqueErrors = [...new Set(handlerErrors)];
  if (uniqueErrors.length) {
    failed += uniqueErrors.length;
    console.log('\n✗ socket handlers threw (safeOn swallowed these, the client saw nothing):');
    uniqueErrors.forEach(e => console.log('    ' + e));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error('harness:', err);
  process.exit(1);
});
