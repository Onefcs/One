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
  const start = await enterWorld(c, 'deathknight');
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
  const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  const list = src.slice(src.indexOf('const BUNDLE_FILES = ['), src.indexOf("].map(f => path.join(ROOT, f));"));
  const files = [...list.matchAll(/'([^']+)'/g)].map(m => m[1]);
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
