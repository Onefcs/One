#!/usr/bin/env node
'use strict';

// Local dev launcher: the real server, a throwaway MongoDB.
//
//   npm run dev:local            in-memory DB, wiped on exit
//   npm run dev:local -- --persist   keep the data in .dev-mongo/ between runs
//   npm run dev:local -- --reseed    rebuild the dev accounts from dev/seed.js
//   npm run dev:local -- --port 4000
//   npm run dev:local -- --uri mongodb://localhost:27017/liberty-dev
//
// It starts a private mongod (mongodb-memory-server, dev dependency), seeds a
// few accounts, then requires server/index.js unchanged — so what runs locally
// is the production server, just pointed at a database nobody else shares.
// Nothing here can reach the live database: the URI is generated here, and the
// launcher refuses to start if it is handed a remote one.
//
// Logging in is covered too. Outside Telegram there is no initData, so the
// server (only when DEV_LOCAL=1, see /dev/init-data in server/index.js) signs
// one locally with the dev bot token set below, and the browser goes through
// the ordinary loginTelegramWebApp path with it. See dev/README.md.

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const seed = require('./seed');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, '.dev-mongo');

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return (i >= 0 && argv[i + 1]) ? argv[i + 1] : d; };

if (has('--help') || has('-h')) {
  // The header comment above IS the usage text — print it rather than keep a
  // second copy of the same flags in sync with it.
  const lines = fs.readFileSync(__filename, 'utf8').split('\n');
  const start = lines.findIndex(l => l.startsWith('//'));
  const end = lines.findIndex((l, i) => i > start && !l.startsWith('//'));
  console.log(lines.slice(start, end).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const PERSIST = has('--persist');
const RESEED  = has('--reseed');
const PORT    = val('--port', process.env.PORT || '3000');
const EXT_URI = val('--uri', '');

// The one thing this script must never do is run the seed (which deletes
// collections on --reseed) against a real deployment.
function assertLocal(uri) {
  const host = (uri.match(/^mongodb(?:\+srv)?:\/\/(?:[^@]*@)?([^/?,]+)/) || [])[1] || '';
  const name = host.split(':')[0];
  if (!['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(name)) {
    console.error(`\n  dev/local.js отказывается работать с не-локальной базой: ${host}\n` +
                  '  Этот скрипт пересоздаёт данные — направьте его только на localhost.\n');
    process.exit(1);
  }
}

(async () => {
  let uri = EXT_URI || '';

  if (!uri) {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    if (PERSIST) fs.mkdirSync(DB_PATH, { recursive: true });
    // The default (no dbPath) storage lives in a temp dir that goes away with
    // the process; --persist pins it to .dev-mongo/ so progress survives a
    // restart, which is what you want when testing anything save-related.
    const mongod = await MongoMemoryServer.create({
      instance: PERSIST
        ? { dbName: 'liberty', dbPath: DB_PATH, storageEngine: 'wiredTiger' }
        : { dbName: 'liberty' },
    });
    uri = mongod.getUri('liberty');
  }
  assertLocal(uri);

  // Seed on our own connection and close it before the server opens its own:
  // server/index.js loads the chat history and the boss respawn timers the
  // moment it connects, so anything seeded after that would be invisible
  // until the next restart.
  await mongoose.connect(uri);
  const { skipped, players } = await seed({ force: RESEED });
  await mongoose.disconnect();

  // Defaults for local play — anything already exported in the environment
  // wins, so `TG_BOT_TOKEN=... npm run dev:local` still works.
  const defaults = {
    MONGODB_URI: uri,
    PORT,
    DEV_LOCAL: '1',
    // Never a real token: it is only ever used to sign and verify the local
    // initData handed out by /dev/init-data.
    TG_BOT_TOKEN: 'dev-local-token',
    TG_BOT_USERNAME: 'dev_local_bot',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'admin',
    GAME_URL: `http://localhost:${PORT}`,
  };
  for (const [k, v] of Object.entries(defaults)) if (!process.env[k]) process.env[k] = v;

  const base = `http://localhost:${process.env.PORT}`;
  console.log('');
  console.log(`  mongo:   ${uri}${PERSIST ? '  (.dev-mongo/)' : '  (in-memory, стирается при выходе)'}`);
  console.log(`  seed:    ${skipped ? 'пропущен — в базе уже есть игроки (--reseed чтобы пересобрать)' : 'создан'}`);
  console.log(`  админка: ${base}/admin.html  (${process.env.ADMIN_USERNAME} / ${process.env.ADMIN_PASSWORD})`);
  console.log('  войти в игру:');
  for (const u of players) {
    console.log(`    ${base}/?dev=${u.username}`.padEnd(48) + `${u.username} — ${u.note}`);
  }
  console.log('');

  require(path.join(ROOT, 'server', 'index.js'));
})().catch(err => {
  console.error('dev/local.js:', err);
  process.exit(1);
});
