#!/usr/bin/env node
'use strict';
// Isolated Room tick benchmark — no sockets, no DB. Instantiates the real
// Room, fills it with N players, runs the real _tick() and reports the time
// distribution. Sockets are stubbed so encode+emit still runs (the encode is
// real work; the emit is a no-op sink).
//
//   node .roombench.js [players] [ticks] [layout]
//     layout: hub (all in the spawn cluster) | spread

const path = require('path');
const Room = require(path.join(__dirname, '..', 'server', 'game', 'Room.js'));

const N = Number(process.argv[2] || 200);
const TICKS = Number(process.argv[3] || 400);
const LAYOUT = process.argv[4] || 'hub';

let emitted = 0, bytes = 0;
const fakeSocket = {
  connected: true,
  volatile: { emit: (ev, buf) => { emitted++; bytes += buf.byteLength || 0; } },
  emit: () => {},
};
const io = {
  to: () => ({ emit: () => {} }),
  sockets: { sockets: { get: () => fakeSocket } },
};

const room = new Room(1, io, {}, null);
const spawn = room._dungeon.spawn;
for (let i = 0; i < N; i++) {
  const id = `bot${i}`;
  room.addPlayer(id, `bot${i}`, null, null, 0, String(1000000 + i));
  room.setPlayerChar(id, ['lev', 'mage', 'ranger', 'warlock', 'deathknight'][i % 5], null);
  const p = room.players.get(id);
  if (LAYOUT === 'arm') {
    // A crowded farming spot inside one arm: outside the safe zone, so the
    // enemy AI actually engages — the state real players spend hours in.
    const b = room._dungeon.armBounds.top;
    p.x = 700 + (Math.random() - 0.5) * 1200;
    p.y = (b.y0 + b.y1) / 2 + (Math.random() - 0.5) * 1200;
  } else {
    const r = LAYOUT === 'hub' ? 260 : 4000;
    p.x = spawn.x + (Math.random() - 0.5) * r * 2;
    p.y = spawn.y + (Math.random() - 0.5) * r * 2;
  }
  p._ang = Math.random() * 7;
  p._ox = p.x; p._oy = p.y;
  p._socket = fakeSocket;
}

const times = [];
for (let t = 0; t < TICKS; t++) {
  room.players.forEach(p => {
    p._ang += (Math.random() - 0.5) * 0.4;
    p.x += Math.cos(p._ang) * 3.2;
    p.y += Math.sin(p._ang) * 3.2;
    const ox = LAYOUT === 'arm' ? p._ox : spawn.x, oy = LAYOUT === 'arm' ? p._oy : spawn.y;
    const dx = p.x - ox, dy = p.y - oy;
    const r = LAYOUT === 'hub' ? 260 : (LAYOUT === 'arm' ? 700 : 4000);
    if (dx * dx + dy * dy > r * r) p._ang += Math.PI;
  });
  const t0 = process.hrtime.bigint();
  room._tick();
  times.push(Number(process.hrtime.bigint() - t0) / 1e6);
}

const sorted = [...times].sort((a, b) => a - b);
const p = q => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
// Casts (the tick half that broadcasts) are every other tick and cost far
// more — report them apart from the AI-only ticks or the average hides it.
const cast = times.filter((_, i) => i % 2 === 1).sort((a, b) => a - b);
const ai = times.filter((_, i) => i % 2 === 0).sort((a, b) => a - b);
const q = (arr, x) => arr.length ? +arr[Math.floor(arr.length * x)].toFixed(2) : 0;
console.log(JSON.stringify({
  players: N, layout: LAYOUT, ticks: TICKS, enemies: room.enemies.length,
  all: { p50: +p(0.5).toFixed(2), p90: +p(0.9).toFixed(2), p99: +p(0.99).toFixed(2), max: +Math.max(...times).toFixed(2) },
  castTicks: { p50: q(cast, 0.5), p90: q(cast, 0.9), max: +Math.max(...cast).toFixed(2) },
  otherTicks: { p50: q(ai, 0.5), p90: q(ai, 0.9), max: +Math.max(...ai).toFixed(2) },
  budgetMs: 25,
  overBudget: times.filter(x => x > 25).length,
  emits: emitted, kbPerCastPerPlayer: +(bytes / emitted / 1024).toFixed(2),
  slowestTicks: times.map((ms, i) => ({ i, ms: +ms.toFixed(1) })).sort((a, b) => b.ms - a.ms).slice(0, 8),
}, null, 2));

process.exit(0);
