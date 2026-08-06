#!/usr/bin/env node
'use strict';
// Functional check for the AOI-scoped combat visuals: a player standing next
// to the shooter must still see the projectile, and a player on the far side
// of the world must not. Guards the optimisation in server/index.js
// (_emitNearby) against silently deleting other people's effects.
//
//   npm run dev:local     (in another terminal)
//   node dev/fanout-check.js

const { io } = require('socket.io-client');
const URL = process.env.URL || 'http://localhost:3000';

async function bot(name) {
  const { initData } = await (await fetch(`${URL}/dev/init-data?dev=${name}`)).json();
  const s = io(URL, { transports: ['websocket'], upgrade: false });
  const got = { proj: 0, aoe: 0 };
  s.on('spawnProj', () => got.proj++);
  s.on('spawnAoe', () => got.aoe++);
  const spawn = await new Promise(resolve => {
    s.on('connect', () => s.emit('loginTelegramWebApp', { initData }));
    s.on('authOk', () => s.emit('selectChar', { type: 'ranger', savedStats: null }));
    s.on('gameStart', async ({ mapVersion }) => {
      const buf = await (await fetch(`${URL}/api/world-map/${mapVersion}`)).arrayBuffer();
      const jsonLen = new DataView(buf).getUint32(0, true);
      resolve(JSON.parse(Buffer.from(buf, 4, jsonLen).toString('utf8')).spawn);
    });
  });
  return { s, got, spawn, moveTo(x, y) { s.emit('playerMove', { x, y, facing: 'front', hp: 200 }); } };
}

(async () => {
  const shooter = await bot('fanShooter');
  const near    = await bot('fanNear');
  const far     = await bot('fanFar');
  const { x, y } = shooter.spawn;

  // Out of the safe zone (monsters and PvP are disabled inside it, but the
  // visual path does not care — this just puts them in ordinary world space).
  shooter.moveTo(x, y + 12000);
  near.moveTo(x + 200, y + 12000);          // same screen
  far.moveTo(x, y + 30000);                 // another arm entirely
  await new Promise(r => setTimeout(r, 1500));

  for (let i = 0; i < 10; i++) {
    shooter.s.emit('spawnProj', { x, y: y + 12000, vx: 300, vy: 0, color: '#8fbf5a',
      size: 5, projType: 'arrow', angle: 0, life: 1.8 });
    shooter.s.emit('spawnAoe', { x, y: y + 12000, r: 110 });
  }
  await new Promise(r => setTimeout(r, 1500));

  const ok = near.got.proj === 10 && near.got.aoe === 10 && far.got.proj === 0 && far.got.aoe === 0;
  console.log(JSON.stringify({
    ok,
    sent: { proj: 10, aoe: 10 },
    nearbyPlayerReceived: near.got,
    distantPlayerReceived: far.got,
    shooterEcho: shooter.got,
  }, null, 2));
  [shooter, near, far].forEach(b => b.s.disconnect());
  process.exit(ok ? 0 : 1);
})();
