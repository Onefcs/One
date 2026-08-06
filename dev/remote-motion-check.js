#!/usr/bin/env node
'use strict';
// How smooth another player looks while they run.
//
// Two real clients in one browser: one runs in a straight line, the other
// samples what it sees of them every frame — interpolated position, the
// `moving` flag and the animation key. A player running at constant speed
// should read as continuously moving; every flip of `moving` back to false is
// a frame where the interpolation had nothing new to advance towards, which on
// screen is the run cycle restarting from frame 0.
//
//   npm run dev:local     (in another terminal)
//   CHROMIUM_PATH=... node dev/remote-motion-check.js

const { chromium } = require('playwright');
const URL = process.env.URL || 'http://localhost:3000';
const SECS = Number(process.env.SECS || 12);

async function login(browser, who) {
  const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
  await page.goto(`${URL}/?dev=${who}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => typeof state !== 'undefined' && state === 'playing' && typeof player !== 'undefined' && player,
    null, { timeout: 45000 });
  return page;
}

(async () => {
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  // The two seeded accounts (dev/seed.js) — they already have a character, so
  // the run starts in the world instead of on the class-select screen.
  const runner = await login(browser, process.env.RUNNER || 'hero');
  const watcher = await login(browser, process.env.WATCHER || 'rival');

  // Put both in the same spot outside the safe zone, then have one run east.
  const place = (page, dx) => page.evaluate(d => {
    player.x = 700 + d; player.y = 13380;
    camera.x = player.x; camera.y = player.y;
  }, dx);
  await place(runner, 0);
  await place(watcher, 120);
  await new Promise(r => setTimeout(r, 1500));

  await runner.evaluate(() => {
    window.__run = setInterval(() => {
      if (typeof inp !== 'undefined' && inp) { inp.dx = 1; inp.dy = 0; inp.len = 1; }
      if (typeof joy !== 'undefined' && joy) { joy.active = true; joy.dx = 1; joy.dy = 0; }
    }, 16);
  });

  // Sample every animation frame, from inside the page.
  await watcher.evaluate(() => {
    window.__samples = [];
    const tick = () => {
      const op = [...otherPlayers.values()][0];
      if (op) window.__samples.push({
        t: performance.now(), x: op.x, y: op.y,
        moving: !!op.moving, facing: op.facing,
        key: typeof getOtherPlayerAnimKey === 'function' ? getOtherPlayerAnimKey(op) : '',
      });
      window.__raf = requestAnimationFrame(tick);
    };
    tick();
  });

  await new Promise(r => setTimeout(r, SECS * 1000));
  await runner.evaluate(() => clearInterval(window.__run));
  const s = await watcher.evaluate(() => { cancelAnimationFrame(window.__raf); return window.__samples; });
  await browser.close();

  if (s.length < 30) {
    console.log(JSON.stringify({ ok: false, reason: 'the watcher never saw the runner', samples: s.length }));
    process.exit(1);
  }
  // Only look at the stretch where they were actually running.
  const moved = s.filter((p, i) => i > 0 && Math.abs(p.x - s[i - 1].x) > 0.001);
  let movingFlips = 0, keyFlips = 0, facingChanges = 0, stalls = 0;
  for (let i = 1; i < s.length; i++) {
    if (s[i].moving !== s[i - 1].moving) movingFlips++;
    if (s[i].key !== s[i - 1].key) keyFlips++;
    if (s[i].facing !== s[i - 1].facing) facingChanges++;
    if (s[i].x === s[i - 1].x && s[i].y === s[i - 1].y) stalls++;
  }
  const secs = (s[s.length - 1].t - s[0].t) / 1000;
  const dxs = [];
  for (let i = 1; i < s.length; i++) dxs.push(s[i].x - s[i - 1].x);
  const avg = dxs.reduce((a, b) => a + b, 0) / dxs.length;
  console.log(JSON.stringify({
    ok: true,
    seconds: +secs.toFixed(1),
    frames: s.length,
    framesTheRunnerLookedStationary: stalls,
    stallPct: +(stalls / s.length * 100).toFixed(1),
    movingFlagFlipsPerSec: +(movingFlips / secs).toFixed(1),
    animationRestartsPerSec: +(keyFlips / secs).toFixed(1),
    facingChangesPerSec: +(facingChanges / secs).toFixed(1),
    avgPxPerFrame: +avg.toFixed(2),
    distinctFacings: [...new Set(s.map(p => p.facing))],
  }, null, 2));
  process.exit(0);
})();
