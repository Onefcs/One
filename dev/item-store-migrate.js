#!/usr/bin/env node
'use strict';
// Populate and verify the row-per-item store (server/models/PlayerItem.js)
// from the `savedData` blobs that are the source of truth today.
//
//   node dev/item-store-migrate.js --check          report only, writes nothing
//   node dev/item-store-migrate.js --write          project every account into the store
//   node dev/item-store-migrate.js --verify         compare what is already stored to the blobs
//   ... --uri mongodb://...                         explicit database (default: MONGODB_URI)
//   ... --limit 500                                 stop after N accounts
//
// --check is the one to run first, and it is safe against production: it reads
// every account, projects it in memory, and reports what the projection would
// lose. Nothing is written and no game code is loaded.
//
// The report is the point. A migration that "succeeded" while quietly dropping
// items from a few hundred accounts is the failure mode here, so every account
// that does not round-trip is named, with the exact item difference, and the
// exit code is non-zero if any did.

const path = require('path');
const mongoose = require('mongoose');

const ROOT = path.join(__dirname, '..');
const { projectItems, verifyPlayer } = require(path.join(ROOT, 'server', 'item-store.js'));

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i === -1 ? d : argv[i + 1]; };

const MODE = has('--write') ? 'write' : has('--verify') ? 'verify' : 'check';
const LIMIT = Number(val('--limit', 0)) || 0;
const URI = val('--uri', process.env.MONGODB_URI || '');

if (!URI) {
  console.error('No database. Pass --uri mongodb://... or set MONGODB_URI.');
  process.exit(2);
}

// Loaded after the URI check so a mistyped invocation cannot connect anywhere.
const PlayerModel = require(path.join(ROOT, 'server', 'models', 'Player.js'));
const PlayerItemModel = require(path.join(ROOT, 'server', 'models', 'PlayerItem.js'));

const fmt = d => d.map(x => `${x.qty > 0 ? '+' : ''}${x.qty}×${x.id}${x.enhance ? `+${x.enhance}` : ''}`).join(' ');

(async () => {
  await mongoose.connect(URI);
  console.log(`mode: ${MODE}${LIMIT ? `, first ${LIMIT} accounts` : ''}\n`);

  let seen = 0, withItems = 0, rowsTotal = 0, bad = 0, written = 0;

  // A cursor, not find().lean() into an array: this reads every account in the
  // game and the blobs are the biggest documents in the database.
  const cursor = PlayerModel.find({}, 'telegramId username savedData').lean().cursor();

  for await (const p of cursor) {
    if (LIMIT && seen >= LIMIT) break;
    seen++;
    const saved = p.savedData;
    if (!saved || typeof saved !== 'object') continue;

    const rows = projectItems(p.telegramId, saved);
    if (!rows.length) continue;
    withItems++;
    rowsTotal += rows.length;

    if (MODE === 'write') {
      await PlayerItemModel.deleteMany({ telegramId: String(p.telegramId) });
      await PlayerItemModel.insertMany(rows, { ordered: false });
      written++;
    }

    // In --verify the store is read back, so a divergence that appeared AFTER
    // the migration (a shadow write that failed, a handler that bypassed the
    // commit path) shows up. In --check/--write the rows are the ones just
    // projected, so this is purely "is the projection lossless".
    const check = MODE === 'verify'
      ? await PlayerItemModel.find({ telegramId: String(p.telegramId) }).lean()
      : rows;
    const v = verifyPlayer(saved, check);
    if (!v.ok) {
      bad++;
      console.log(`  MISMATCH ${p.username || '?'} (${p.telegramId}): ${fmt(v.diff)}`);
    }
  }

  console.log(`\naccounts read:      ${seen}`);
  console.log(`with items:         ${withItems}`);
  console.log(`item rows:          ${rowsTotal}`);
  if (MODE === 'write') console.log(`accounts written:   ${written}`);
  console.log(`accounts mismatched: ${bad}`);

  if (!bad) {
    console.log('\nEvery account round-trips: the store holds exactly what the blobs do.');
  } else {
    console.log('\nDo not flip reads over while any account mismatches — each line above ' +
      'is items a player would gain or lose at the cutover.');
  }

  await mongoose.disconnect();
  process.exit(bad ? 1 : 0);
})().catch(err => {
  console.error(err);
  process.exit(2);
});
