#!/usr/bin/env node
'use strict';
// Prices one player in bytes: boots the real server, loads the real client in
// Chromium, and records everything that leaves the server — HTTP responses
// grouped by type, then the websocket stream once the player is in the world.
//
//   node dev/egress.js [seconds of play]
//
// Two very different costs, reported apart because they scale differently:
// the first-load figure is paid once per fresh device (assets are served
// immutable, so a returning player pays none of it), while the steady-state
// figure is per player-second and scales with how many people are near each
// other. If a hosting bill says egress is the biggest line, this says which
// of the two to go after — and the answer, when this was written, was that
// nine tenths of a first load was UI icons stored at 4-20x their display
// size (see SCALING.md).

const path = require('path');
const Module = require('module');
const ROOT = path.join(__dirname, '..');
const memory = require('./mongo-memory');
const _load = Module._load;
Module._load = function (r, p, i) { if (r === 'mongoose') return memory; return _load.call(this, r, p, i); };

const PORT = Number(process.env.PORT_S || 3444);
Object.assign(process.env, {
  MONGODB_URI: 'mongodb://127.0.0.1:27017/egress', PORT: String(PORT), DEV_LOCAL: '1',
  TG_BOT_TOKEN: 'harness-token', TG_BOT_USERNAME: 'harness_bot',
  ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'admin',
  GAME_URL: `http://127.0.0.1:${PORT}`, MOVE_GUARD: 'off',
});
const BASE = `http://127.0.0.1:${PORT}`;
require(path.join(ROOT, 'server', 'index.js'));

const PLAY_SECONDS = Number(process.argv[2] || 30);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function chromiumPath() {
  const fs = require('fs');
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  for (const root of ['/opt/pw-browsers']) {
    if (!fs.existsSync(root)) continue;
    for (const d of fs.readdirSync(root)) {
      const p = path.join(root, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

(async () => {
  await sleep(2500);
  const exe = chromiumPath();
  if (!exe) { console.log('no chromium'); process.exit(1); }
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ executablePath: exe });
  const page = await browser.newPage({ viewport: { width: 420, height: 860 } });

  // WIRE bytes, not decoded bytes. response.body() hands back the decompressed
  // payload, so counting it credited gzipped text with its uncompressed size —
  // it reported the JS bundle at 795 KB and pixi at 445 KB when what actually
  // crosses the network is 232 KB and 134 KB. That is a 3x overstatement on
  // exactly the files a bill would send you looking at first. request().sizes()
  // reports what the transport moved, headers included.
  const byUrl = new Map();
  const hits = new Map();
  page.on('response', async r => {
    try {
      const u = r.url().replace(BASE, '');
      let n = 0;
      const s = await r.request().sizes().catch(() => null);
      if (s) n = (s.responseBodySize || 0) + (s.responseHeadersSize || 0);
      else { const buf = await r.body().catch(() => null); n = buf ? buf.length : 0; }
      byUrl.set(u, (byUrl.get(u) || 0) + n);
      hits.set(u, (hits.get(u) || 0) + 1);
    } catch { /* ignore */ }
  });

  // Websocket frames, counted separately — this is the per-second cost that
  // scales with session length rather than with a first visit.
  let wsIn = 0, _wsOut = 0, wsFrames = 0;
  page.on('websocket', ws => {
    ws.on('framereceived', f => { wsIn += (f.payload && f.payload.length) || 0; wsFrames++; });
    ws.on('framesent', f => { _wsOut += (f.payload && f.payload.length) || 0; });
  });

  await page.goto(`${BASE}/?dev=egresscheck`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(9000);
  if (await page.evaluate(() => typeof state !== 'undefined' && state === 'select')) {
    await page.evaluate(() => selectChar('mage'));
    await page.waitForTimeout(7000);
  }

  const httpAtWorld = [...byUrl.values()].reduce((a, b) => a + b, 0);
  const wsAtWorld = wsIn;
  console.log(`\n=== first load, up to standing in the world ===`);
  console.log(`HTTP total: ${(httpAtWorld / 1048576).toFixed(2)} MB   WS so far: ${(wsAtWorld / 1024).toFixed(0)} KB`);

  const groups = new Map();
  for (const [u, n] of byUrl) {
    const g = u.startsWith('/images') ? 'images'
      : u.startsWith('/audio') ? 'audio'
        : /\.js(\?|$)|\.js\.map/.test(u) ? 'js'
          : /\.css/.test(u) ? 'css'
            : u.startsWith('/api/world-map') ? 'world-map'
              : u.startsWith('/socket.io') ? 'socket.io-handshake' : 'other';
    groups.set(g, (groups.get(g) || 0) + n);
  }
  console.log('\nby type:');
  [...groups].sort((a, b) => b[1] - a[1])
    .forEach(([g, n]) => console.log(`  ${g.padEnd(20)} ${(n / 1024).toFixed(0).padStart(7)} KB`));

  // Images are the bulk of a first load, and "images: 2.6 MB" is not
  // actionable on its own — the decision is always per folder, because a
  // folder is one kind of art with one answer (class sprites must stay at
  // native size; UI icons must not).
  const byFolder = new Map();
  for (const [u, n] of byUrl) {
    if (!u.startsWith('/images')) continue;
    const parts = decodeURIComponent(u.split('?')[0]).split('/');
    const f = parts.length > 3 ? `images/${parts[2]}` : 'images/(root)';
    const e = byFolder.get(f) || { n: 0, files: 0 };
    e.n += n; e.files++;
    byFolder.set(f, e);
  }
  if (byFolder.size) {
    console.log('\nimages by folder:');
    [...byFolder].sort((a, b) => b[1].n - a[1].n).forEach(([f, e]) =>
      console.log(`  ${(e.n / 1024).toFixed(0).padStart(7)} KB  ${String(e.files).padStart(3)} files  ${f}`));
  }

  console.log('\ntop 15 single responses:');
  [...byUrl].sort((a, b) => b[1] - a[1]).slice(0, 15)
    .forEach(([u, n]) => console.log(`  ${(n / 1024).toFixed(0).padStart(7)} KB  ${u.slice(0, 72)}`));

  // Anything fetched more than once on a single first load is paying for the
  // same bytes twice — usually one URL referenced from two places (an <img>
  // and a <link rel="icon">, say), which no amount of cache tuning fixes
  // because both requests are in flight before either has an answer.
  const twice = [...hits].filter(([, c]) => c > 1)
    .sort((a, b) => (byUrl.get(b[0]) || 0) - (byUrl.get(a[0]) || 0));
  if (twice.length) {
    console.log('\nfetched more than once in one load:');
    twice.forEach(([u, c]) =>
      console.log(`  ${c}x  ${((byUrl.get(u) || 0) / 1024).toFixed(0).padStart(6)} KB total  ${u.slice(0, 66)}`));
  }

  // Then just stand there and play, to price the steady state.
  const wsBefore = wsIn, framesBefore = wsFrames;
  const t0 = Date.now();
  for (let i = 0; i < PLAY_SECONDS * 4; i++) {
    await page.evaluate(() => {
      if (typeof player !== 'undefined' && player && typeof netSendMove === 'function') {
        player.x += (Math.random() - 0.5) * 40;
        player.y += (Math.random() - 0.5) * 40;
        netSendMove();
      }
    }).catch(() => {});
    await page.waitForTimeout(250);
  }
  const secs = (Date.now() - t0) / 1000;
  const streamed = wsIn - wsBefore;
  console.log(`\n=== steady state, ${secs.toFixed(0)}s of one player moving in the hub ===`);
  console.log(`  down to client: ${(streamed / 1024).toFixed(0)} KB  = ${(streamed / secs / 1024).toFixed(1)} KB/s`);
  console.log(`  frames: ${wsFrames - framesBefore}`);
  console.log(`  -> per player-hour: ${(streamed / secs * 3600 / 1048576).toFixed(0)} MB`);

  await browser.close();
  process.exit(0);
})();
