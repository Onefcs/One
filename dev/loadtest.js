#!/usr/bin/env node
'use strict';
// Synthetic load: N socket.io clients that log in through /dev/init-data,
// pick a class, walk around and fight, and report the latency they see.
// Needs a server started by dev/local.js (the /dev/init-data login route only
// exists there) — see dev/README.md.
//
//   node dev/loadtest.js [count] [seconds] [mode]
//     mode: hub    — everyone piles into the spawn area (default)
//           spread — bots wander over a wide area
//
// Knobs, all env vars, each isolating one cost measured in AUDIT-PERF.md:
//   MOVE_HZ=40   playerMove rate per bot; 0 = never move
//   ATTACK=5     attacks/s per bot (server caps a socket at 20/s)
//   PROJ=0       spawnProj/s per bot — the floor-wide combat visuals
//   MAPVIEW=1    keep the map panel open (subscribes to the mapBlips feed)
//   STAGGER=25   ms between logins; 0 reproduces a post-restart reconnect storm
//   TAG=bot      account name prefix (distinct names = distinct accounts)
//   URL=http://localhost:3000

const { io } = require('socket.io-client');

const URL = process.env.URL || 'http://localhost:3000';
const N = Number(process.argv[2] || 100);
const SECS = Number(process.argv[3] || 30);
const MODE = process.argv[4] || 'hub';
const TAG = process.env.TAG || 'bot';

const TYPES = ['lev', 'deathknight', 'ranger', 'mage', 'warlock'];

const rtts = [];          // every ping sample
const perBot = new Map(); // id -> {samples, max}
let connected = 0, authed = 0, started = 0, errors = 0, gsPackets = 0, gsBytes = 0;
let disconnects = 0;

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

async function initData(name) {
  const r = await fetch(`${URL}/dev/init-data?dev=${name}`);
  const j = await r.json();
  return j.initData;
}

async function makeBot(i) {
  const name = `${TAG}${i}`;
  const initDataStr = await initData(name);
  const socket = io(URL, { transports: ['websocket'], upgrade: false });
  const st = { t0: Date.now(), startMs: -1, samples: [], max: 0, spawn: null, x: 0, y: 0, ang: Math.random() * 7, enemies: new Map() };
  perBot.set(i, st);

  socket.on('connect', () => {
    connected++;
    socket.emit('loginTelegramWebApp', { initData: initDataStr });
  });
  socket.on('connect_error', () => { errors++; });
  socket.on('disconnect', () => { disconnects++; });
  socket.on('authError', m => { errors++; console.error('authError', name, m); });
  socket.on('authOk', () => {
    authed++;
    socket.emit('selectChar', { type: TYPES[i % TYPES.length], savedStats: null });
  });
  socket.on('gameStart', ({ dungeon, enemies }) => {
    started++;
    st.startMs = Date.now() - st.t0;
    st.spawn = dungeon.spawn;
    st.x = dungeon.spawn.x + (Math.random() - 0.5) * (MODE === 'hub' ? 200 : 1200);
    st.y = dungeon.spawn.y + (Math.random() - 0.5) * (MODE === 'hub' ? 200 : 1200);
    (enemies || []).forEach(e => st.enemies.set(e.id, e));
  });
  socket.on('gameState', buf => {
    gsPackets++;
    gsBytes += buf.byteLength || buf.length || 0;
  });
  socket.on('_pong', t0 => {
    const rtt = Date.now() - t0;
    rtts.push(rtt);
    st.samples.push(rtt);
    if (rtt > st.max) st.max = rtt;
  });

  // movement at the same 40Hz cadence the real client uses
  const MOVE_HZ = Number(process.env.MOVE_HZ ?? 40);
  const moveTimer = MOVE_HZ === 0 ? null : setInterval(() => {
    if (!st.spawn) return;
    st.ang += (Math.random() - 0.5) * 0.4;
    const spd = 3.2;
    st.x += Math.cos(st.ang) * spd;
    st.y += Math.sin(st.ang) * spd;
    // keep bots roughly inside their zone
    const r = MODE === 'hub' ? 260 : 1500;
    const dx = st.x - st.spawn.x, dy = st.y - st.spawn.y;
    if (dx * dx + dy * dy > r * r) st.ang += Math.PI;
    socket.emit('playerMove', { x: st.x, y: st.y, facing: 'front', hp: 200 });
  }, 1000 / MOVE_HZ);

  const pingTimer = setInterval(() => socket.volatile.emit('_ping', Date.now()), 1000);

  // Combat: the server caps a socket at 20 attacks/s (_atkAllowed); real
  // players sit near that with auto-attack on. ATTACK=0 disables.
  const ATK_HZ = Number(process.env.ATTACK ?? 5);
  let atkTimer = null;
  if (ATK_HZ > 0) {
    atkTimer = setInterval(() => {
      if (!st.enemies.size) return;
      const ids = [...st.enemies.keys()];
      socket.emit('attack', { enemyId: ids[(Math.random() * ids.length) | 0] });
    }, 1000 / ATK_HZ);
  }
  // Ranged classes emit one spawnProj per auto-attack (js/combat.js fireProj)
  const PROJ_HZ = Number(process.env.PROJ ?? 0);
  let projTimer = null;
  if (PROJ_HZ > 0) {
    projTimer = setInterval(() => {
      socket.emit('spawnProj', { x: st.x, y: st.y, vx: 300, vy: 40, color: '#8fbf5a',
        size: 5, projType: 'arrow', angle: 0.1, life: 1.8 });
    }, 1000 / PROJ_HZ);
  }
  if (process.env.MAPVIEW === '1') socket.on('gameStart', () => socket.emit('mapView', { open: true }));

  return () => {
    if (moveTimer) clearInterval(moveTimer);
    clearInterval(pingTimer);
    if (atkTimer) clearInterval(atkTimer);
    if (projTimer) clearInterval(projTimer);
    socket.disconnect();
  };
}

(async () => {
  const stops = [];
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    stops.push(await makeBot(i));
    await new Promise(r => setTimeout(r, Number(process.env.STAGGER ?? 25)));
  }
  console.log(`[load] ${N} bots up in ${Date.now() - t0}ms — running ${SECS}s`);
  rtts.length = 0; // discard login-storm samples
  await new Promise(r => setTimeout(r, SECS * 1000));

  const bad = [...perBot.entries()]
    .map(([i, s]) => ({ i, p95: pct(s.samples, 0.95), max: s.max, n: s.samples.length }))
    .sort((a, b) => b.p95 - a.p95);

  console.log(JSON.stringify({
    bots: N, mode: MODE, secs: SECS,
    connected, authed, started, errors, disconnects,
    rttSamples: rtts.length,
    rtt: { p50: pct(rtts, 0.5), p90: pct(rtts, 0.9), p99: pct(rtts, 0.99), max: Math.max(...rtts, 0) },
    worstBots: bad.slice(0, 5),
    loginToGameStartMs: (() => {
      const v = [...perBot.values()].map(s => s.startMs).filter(x => x >= 0).sort((a, b) => a - b);
      return v.length ? { p50: v[v.length >> 1], p90: v[Math.floor(v.length * 0.9)], max: v[v.length - 1] } : null;
    })(),
    gameStatePacketsPerSecPerBot: +(gsPackets / SECS / N).toFixed(1),
    gameStateKBsPerSecPerBot: +(gsBytes / 1024 / SECS / N).toFixed(1),
  }, null, 2));
  stops.forEach(f => f());
  process.exit(0);
})();
