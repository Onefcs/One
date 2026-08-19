#!/usr/bin/env node
'use strict';
// How much is the socket.io envelope actually costing, on the packet sizes the
// game really produces? The 79% figure in AUDIT-NET.md is for a 12-byte packet
// — but Room.js has since stopped sending those at all (the idle-suppression
// in _tick: an empty cast is skipped, with only a heartbeat every
// IDLE_HEARTBEAT_CASTS). So the question is what the distribution looks like
// NOW, not what it looked like when that number was measured.
//
// Verdict from this tool is written up in AUDIT-NET.md, N4.
//
//   node dev/envelope-cost.js [players] [ticks] [layout]
//     SPREAD=20000   how far apart the players stand (default 5000)

const path = require('path');
const ROOT = path.join(__dirname, '..');
const Room = require(path.join(ROOT, 'server', 'game', 'Room.js'));
const { FLOOR_IDS } = require(path.join(ROOT, 'server', 'game', 'floors.js'));

const N = Number(process.argv[2] || 40);
const TICKS = Number(process.argv[3] || 600);
const LAYOUT = process.argv[4] || 'arm';
const SPREAD = Number(process.env.SPREAD || 5000);
const ENVELOPE = 47;          // 451-["gameState",{"_placeholder":true,"num":0}]
const WS_HDR = 4;             // per-frame WebSocket header, server->client, typical

const sizes = [];
const fakeSocket = {
  connected: true,
  volatile: { emit: (ev, buf) => { if (ev === 'gameState') sizes.push(buf.byteLength || 0); } },
  emit: () => {},
};
const io = { to: () => ({ emit: () => {} }), sockets: { sockets: { get: () => fakeSocket } } };

const room = new Room(LAYOUT === 'arm' ? FLOOR_IDS.top : FLOOR_IDS.hub, io, {}, null);
if (room._interval) { clearInterval(room._interval); room._interval = null; }
const spawn = room._dungeon.spawn;
const enemyMid = (() => {
  const es = room.enemies;
  if (!es.length) return { x: spawn.x, y: spawn.y };
  let sx = 0, sy = 0;
  es.forEach(e => { sx += e.x; sy += e.y; });
  return { x: sx / es.length, y: sy / es.length };
})();

for (let i = 0; i < N; i++) {
  const id = `bot${i}`;
  room.addPlayer(id, `bot${i}`, null, null, 0, String(1000000 + i));
  room.setPlayerChar(id, ['lev', 'mage', 'ranger', 'warlock', 'deathknight'][i % 5], null);
  const p = room.players.get(id);
  if (LAYOUT === 'arm') {
    // Spread wide enough that most players have a FEW neighbours, not a crowd —
    // the ordinary case, which is where a fixed-size envelope hurts most.
    p.x = enemyMid.x + (Math.random() - 0.5) * SPREAD;
    p.y = enemyMid.y + (Math.random() - 0.5) * SPREAD;
  } else {
    p.x = spawn.x + (Math.random() - 0.5) * 520;
    p.y = spawn.y + (Math.random() - 0.5) * 520;
  }
  p._ang = Math.random() * 7;
  p._socket = fakeSocket;
}

for (let t = 0; t < TICKS; t++) {
  room.players.forEach(p => {
    p._ang += (Math.random() - 0.5) * 0.4;
    p.x += Math.cos(p._ang) * 3.2;
    p.y += Math.sin(p._ang) * 3.2;
    p.moving = true;
    p._posAt = Date.now();
  });
  room._tick();
}

sizes.sort((a, b) => a - b);
const pct = q => sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * q))];
const sum = sizes.reduce((a, b) => a + b, 0);
const mean = sum / sizes.length;

// Two frames today (envelope + payload), one frame with a binary-inline parser.
const todayBytes = sizes.length * (ENVELOPE + WS_HDR + WS_HDR) + sum;
// msgpack-style: one frame, packet structure encoded inline. Measured overhead
// for {type, nsp, event name, one binary} in msgpack is ~20 bytes.
const MSGPACK_OVERHEAD = 20;
const parserBytes = sizes.length * (MSGPACK_OVERHEAD + WS_HDR) + sum;

console.log(JSON.stringify({
  layout: LAYOUT, players: N, ticks: TICKS,
  gameStatePackets: sizes.length,
  castsIfNothingSuppressed: Math.floor(TICKS / 2) * N,
  suppressedPct: +((1 - sizes.length / (Math.floor(TICKS / 2) * N)) * 100).toFixed(1),
  payloadBytes: { p1: pct(0.01), p25: pct(0.25), p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), mean: +mean.toFixed(0) },
  envelopeShareOfWire: {
    atP1:  +(ENVELOPE / (ENVELOPE + pct(0.01)) * 100).toFixed(0) + '%',
    atP50: +(ENVELOPE / (ENVELOPE + pct(0.5)) * 100).toFixed(0) + '%',
    atP90: +(ENVELOPE / (ENVELOPE + pct(0.9)) * 100).toFixed(0) + '%',
  },
  totalWireKB: { today: +(todayBytes / 1024).toFixed(0), withInlineParser: +(parserBytes / 1024).toFixed(0) },
  bytesSavedPct: +((todayBytes - parserBytes) / todayBytes * 100).toFixed(1),
  framesSavedPct: 50,
}, null, 2));
process.exit(0);
