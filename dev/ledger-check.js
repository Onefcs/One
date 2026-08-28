#!/usr/bin/env node
'use strict';
// Regression check for the item/currency ledger.
//
//   node dev/ledger-check.js        (no server, no database)
//
// The ledger exists to answer one question months after the fact: was this
// item created, and by which operation. Everything it can get wrong is in the
// census arithmetic — if a move between containers reads as creation, or a +7
// sword reads as a +0 one, the collection fills with noise and the one row
// that mattered is unfindable. So that arithmetic is what this covers.
//
// server/ledger.js is a plain module with no side effects on require (unlike
// server/index.js, which opens a listener — see dev/xp-ledger-check.js for how
// the other checks work around that), so it is required directly and the real
// shipped functions are exercised. The retention map is checked against the
// reason strings the live handlers actually pass, lifted from their source.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const {
  census, censusDiff, censusKey, LEDGER_TTL_DAYS, _ttlDaysFor, _expiresAt,
} = require(path.join(ROOT, 'server', 'ledger.js'));

let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
};
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${name}${JSON.stringify(a) === JSON.stringify(b) ? '' : ` — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`}`);

// ── Census keys ──────────────────────────────────────────────────────────────
console.log('\ncensus keys');

ok(censusKey({ id: 'sword' }) === 'sword', 'a plain item keys on its id');
ok(censusKey({ id: 'sword', enhance: 0 }) === 'sword', 'enhance 0 is the same key as no enhance');
ok(censusKey({ id: 'sword', enhance: 7 }) === 'sword#7', 'an enhanced item keys separately');
ok(censusKey({ id: 'sword', enhance: 7 }) !== censusKey({ id: 'sword' }),
  '+7 and +0 of one id are not interchangeable');
ok(censusKey(null) === null && censusKey({}) === null, 'a malformed entry has no key');
// slot is position, not identity — an item that moved slots must not read as a
// different item, or every re-sort would write a create+destroy pair.
ok(censusKey({ id: 'sword', slot: 3 }) === censusKey({ id: 'sword', slot: 9 }),
  'slot is not part of the key');

// ── Container moves net to zero ──────────────────────────────────────────────
console.log('\nmoves between containers');

const bagOnly = census({ inventory: [{ id: 'sword' }, { id: 'shard', qty: 5 }] });
const vaulted = census({ inventory: [{ id: 'shard', qty: 5 }], storage: [{ id: 'sword' }] });
eq(censusDiff(bagOnly, vaulted), [], 'inventory -> storage writes no row');

const worn = census({ inventory: [{ id: 'shard', qty: 5 }], equipment: { weapon: { id: 'sword' } } });
eq(censusDiff(bagOnly, worn), [], 'inventory -> equipment writes no row');
eq(censusDiff(vaulted, worn), [], 'storage -> equipment writes no row');

const resorted = census({ inventory: [{ id: 'shard', qty: 5, slot: 0 }, { id: 'sword', slot: 1 }] });
eq(censusDiff(bagOnly, resorted), [], 'a re-sort writes no row');

// ── Creation and destruction ─────────────────────────────────────────────────
console.log('\ncreation and destruction');

const looted = census({ inventory: [{ id: 'sword' }, { id: 'shard', qty: 5 }, { id: 'key_rare' }] });
eq(censusDiff(bagOnly, looted), [{ id: 'key_rare', qty: 1 }], 'a drop is one positive row');

const spent = census({ inventory: [{ id: 'sword' }, { id: 'shard', qty: 2 }] });
eq(censusDiff(bagOnly, spent), [{ id: 'shard', qty: -3 }],
  'spending 3 of a stack of 5 is -3, not -1 slot');

// A craft: mats in, gear out. Destroyed rows sort first so the row reads in
// the order the operation happened.
const crafted = census({ inventory: [{ id: 'sword' }, { id: 'blade', enhance: 0 }] });
eq(censusDiff(bagOnly, crafted),
  [{ id: 'shard', qty: -5 }, { id: 'blade', qty: 1 }],
  'a craft records what went in and what came out');

// The one that a slot-count-only ledger cannot see at all: a stack merging
// into an existing one changes qty without changing the number of slots.
const merged = census({ inventory: [{ id: 'sword' }, { id: 'shard', qty: 9 }] });
eq(censusDiff(bagOnly, merged), [{ id: 'shard', qty: 4 }],
  'a stack merge is visible even though the slot count did not move');

// An enhance destroys the +0 and creates the +1 — the shape a forged enhance
// level would also have, which is why the level is part of the key.
const enhanced = census({ inventory: [{ id: 'sword', enhance: 1 }, { id: 'shard', qty: 5 }] });
eq(censusDiff(bagOnly, enhanced),
  [{ id: 'sword', qty: -1 }, { id: 'sword', enhance: 1, qty: 1 }],
  'an enhance is a destroy of +0 and a create of +1');

// ── Malformed input ──────────────────────────────────────────────────────────
console.log('\nmalformed input');

eq([...census({}).entries()], [], 'an empty session censuses to nothing');
eq([...census({ inventory: null, storage: undefined, equipment: 0 }).entries()], [],
  'null containers are not an error');
eq([...census({ inventory: [null, { }, { id: 'sword' }] }).entries()], [['sword', 1]],
  'entries without an id are skipped, not counted');
eq([...census({ inventory: [{ id: 'shard', qty: 'x' }] }).entries()], [['shard', 1]],
  'a non-numeric qty counts as one, never NaN');
eq([...census({ inventory: [{ id: 'shard', qty: -4 }] }).entries()], [['shard', 1]],
  'a negative qty cannot subtract from the census');

// ── Retention ────────────────────────────────────────────────────────────────
console.log('\nretention');

ok(_ttlDaysFor('mob_loot') < _ttlDaysFor('market_buy'),
  'kill loot expires sooner than a trade');
ok(_ttlDaysFor('completely_new_reason') === LEDGER_TTL_DAYS.default,
  'an unmapped reason falls back to the default window');
const _now = new Date('2026-01-01T00:00:00Z');
ok(_expiresAt('mob_loot', _now).getTime() - _now.getTime() === 7 * 86400000,
  'expiresAt is now plus the reason window');
ok(_expiresAt('market_buy', _now) > _expiresAt('mob_loot', _now),
  'the two windows really differ per row');

// Every reason the live code files a LONG-lived movement under has to be in
// the map — a value transfer silently inheriting the 90-day default is the
// failure this catches, and it is invisible until the row is wanted and gone.
console.log('\nreasons the handlers actually pass');
const SRC = ['server/index.js', 'server/handlers/market.js', 'server/handlers/gram.js',
  'server/telegram-bot.js', 'server/routes/admin.js', 'server/handlers/clan.js']
  .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
const VALUE_TRANSFER = [
  'market_buy', 'market_sold', 'market_list', 'gram_deposit', 'gram_withdraw',
  'gram_shop', 'referral', 'admin',
];
for (const r of VALUE_TRANSFER) {
  ok(LEDGER_TTL_DAYS[r] >= 365, `${r} is kept a year`);
  ok(SRC.includes(`'${r}'`), `${r} is a reason the shipped code really passes`);
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
