#!/usr/bin/env node
'use strict';
// Browser smoke test: loads the real client against a dev server, logs in,
// picks a class if needed, plays for a few seconds and reports what the page
// actually did — console errors, whether the world map arrived, whether the
// player is moving and receiving world updates.
//
//   npm run dev:local          (in another terminal)
//   node dev/smoke.js [?dev=name]
//
// Exits non-zero if the client failed to reach a playable state.

const { chromium } = require('playwright');

const URL = process.env.URL || 'http://localhost:3000';
const WHO = process.argv[2] || 'hero';

(async () => {
  // CHROMIUM_PATH covers environments that ship a browser at a fixed location
  // rather than the versioned directory this Playwright build looks for.
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
  const errors = [];
  const mapRequests = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('request', r => { if (r.url().includes('/api/world-map/')) mapRequests.push(r.url()); });
  const failed = [];
  page.on('response', r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });

  await page.goto(`${URL}/?dev=${WHO}`, { waitUntil: 'domcontentloaded' });

  // Character select shows for a fresh account; click the first class.
  await page.waitForTimeout(6000);
  const needsClass = await page.evaluate(() => typeof state !== 'undefined' && state === 'select');
  if (needsClass) {
    await page.evaluate(() => {
      const card = document.querySelector('#charselect .cs-card, #charselect [data-type]');
      if (card) card.click();
    });
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /играть|start|в игру/i.test(b.textContent || ''));
      if (btn) btn.click();
    });
    await page.waitForTimeout(4000);
  }

  const before = await page.evaluate(() => ({
    state: typeof state !== 'undefined' ? state : null,
    hasDungeon: !!(typeof dungeon !== 'undefined' && dungeon && dungeon.grid),
    gridRows: (typeof dungeon !== 'undefined' && dungeon && dungeon.grid) ? dungeon.grid.length : 0,
    enemies: typeof serverEnemies !== 'undefined' ? serverEnemies.length : -1,
    x: typeof player !== 'undefined' && player ? Math.round(player.x) : null,
    y: typeof player !== 'undefined' && player ? Math.round(player.y) : null,
    ping: typeof _pingMs !== 'undefined' ? _pingMs : null,
  }));

  // Drive the character with the joystick's input vector for a few seconds.
  await page.evaluate(() => {
    window.__smokeMove = setInterval(() => {
      if (typeof joy !== 'undefined' && joy) { joy.active = true; joy.dx = 1; joy.dy = 0; }
    }, 16);
  });
  await page.waitForTimeout(5000);
  await page.evaluate(() => clearInterval(window.__smokeMove));

  // Reconnect: the case the map change is actually for. selectChar re-runs on
  // every socket.io reconnect, so this is what used to cost a fresh 132KB
  // download and a full world rebuild. The map must NOT be re-fetched, and the
  // world must still be there afterwards.
  const mapReqsBeforeReconnect = mapRequests.length;
  await page.evaluate(() => { socket.disconnect(); socket.connect(); });
  await page.waitForTimeout(5000);
  const reconnect = await page.evaluate(() => ({
    state: typeof state !== 'undefined' ? state : null,
    connected: socket.connected,
    hasDungeon: !!(typeof dungeon !== 'undefined' && dungeon && dungeon.grid),
    gridRows: (typeof dungeon !== 'undefined' && dungeon && dungeon.grid) ? dungeon.grid.length : 0,
    x: typeof player !== 'undefined' && player ? Math.round(player.x) : null,
  }));
  reconnect.refetchedMap = mapRequests.length - mapReqsBeforeReconnect;

  const after = await page.evaluate(() => ({
    state: typeof state !== 'undefined' ? state : null,
    x: typeof player !== 'undefined' && player ? Math.round(player.x) : null,
    y: typeof player !== 'undefined' && player ? Math.round(player.y) : null,
    enemies: typeof serverEnemies !== 'undefined' ? serverEnemies.length : -1,
    others: typeof otherPlayers !== 'undefined' ? otherPlayers.size : -1,
    ping: typeof _pingMs !== 'undefined' ? _pingMs : null,
    connected: typeof socket !== 'undefined' && socket ? socket.connected : null,
  }));

  await page.screenshot({ path: process.env.SHOT || 'dev-smoke.png' });
  await browser.close();

  const moved = before.x !== null && after.x !== null && (before.x !== after.x || before.y !== after.y);
  const ok = after.state === 'playing' && before.hasDungeon && after.connected && moved &&
    reconnect.state === 'playing' && reconnect.connected && reconnect.hasDungeon &&
    reconnect.refetchedMap === 0;
  console.log(JSON.stringify({
    ok, account: WHO, before, after, moved, reconnect,
    worldMapRequests: mapRequests.length, failedRequests: failed.slice(0, 10),
    consoleErrors: errors.slice(0, 6),
  }, null, 2));
  process.exit(ok ? 0 : 1);
})();
