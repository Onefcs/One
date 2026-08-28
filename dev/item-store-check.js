#!/usr/bin/env node
'use strict';
// Regression check for the blob <-> row-per-item projection.
//
//   node dev/item-store-check.js        (no server, no database)
//
// The migration in dev/item-store-migrate.js is only as trustworthy as these
// functions: everything it reports as "round-trips cleanly" is this code
// agreeing with itself. So the cases below are the ones where a projection
// quietly loses something — an item the catalog no longer knows, a stack, an
// enhance level, an equipment slot, a hole in the array.

const path = require('path');

const ROOT = path.join(__dirname, '..');
const {
  projectItems, rowsToBlob, verifyPlayer,
} = require(path.join(ROOT, 'server', 'item-store.js'));
const {
  ITEM_DEF, CRAFT_MATS, isStackableItem, ENHANCEABLE_SLOTS,
} = require(path.join(ROOT, 'shared', 'definitions.js'));

let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
};

// Real catalog entries, so the check breaks if the catalog changes shape
// rather than passing against ids that only exist in this file.
const GEAR = ITEM_DEF.find(d => ENHANCEABLE_SLOTS.has(d.slot) && !isStackableItem(d));
const GEAR2 = ITEM_DEF.find(d => d !== GEAR && !isStackableItem(d));
const STACK = CRAFT_MATS.find(d => isStackableItem(d));
ok(!!GEAR && !!GEAR2 && !!STACK,
  'the catalog still has an enhanceable item, a second item and a stackable one');
if (!GEAR || !GEAR2 || !STACK) process.exit(1);

const TID = '12345';

console.log('\nprojection');

const saved = {
  inventory: [{ ...GEAR, enhance: 3 }, { ...STACK, qty: 40 }],
  storage:   [{ ...GEAR2 }],
  equipment: { [GEAR.slot]: { ...GEAR, enhance: 0 } },
};
const rows = projectItems(TID, saved);
ok(rows.length === 4, 'every container contributes its rows');
ok(rows.every(r => r.telegramId === TID), 'each row carries its owner');
ok(rows.filter(r => r.container === 'inventory').length === 2 &&
   rows.filter(r => r.container === 'storage').length === 1 &&
   rows.filter(r => r.container === 'equipment').length === 1,
  'containers are kept apart');
ok(rows.find(r => r.container === 'equipment').pos === GEAR.slot,
  'an equipment row is positioned by slot name, not by index');
ok(rows.filter(r => r.container === 'inventory').map(r => r.pos).join(',') === '0,1',
  'an array row is positioned by index');
ok(rows.find(r => r.itemId === GEAR.id && r.container === 'inventory').enhance === 3,
  'the enhance level survives the projection');
ok(rows.find(r => r.itemId === STACK.id).qty === 40, 'a stack keeps its quantity');
// Stats are the catalog's, not the row's — an item is a reference, not a copy.
ok(!('atk' in rows[0]) && !('name' in rows[0]), 'no stats are copied into the row');

console.log('\nround trip');

const rebuilt = rowsToBlob(rows);
ok(rebuilt.inventory.length === 2 && rebuilt.storage.length === 1,
  'the arrays come back the same length');
ok(rebuilt.equipment[GEAR.slot] && rebuilt.equipment[GEAR.slot].id === GEAR.id,
  'the equipped item comes back in its slot');
ok(rebuilt.inventory[0].enhance === 3, 'and still enhanced');
ok(rebuilt.inventory[1].qty === 40, 'and the stack is still 40');
ok(typeof rebuilt.inventory[0].atk === 'number' || rebuilt.inventory[0].name !== undefined,
  'stats are restored from the catalog on the way back');
ok(verifyPlayer(saved, rows).ok, 'the verifier agrees the round trip lost nothing');

console.log('\nwhat the projection deliberately drops');

// An id the catalog no longer knows is exactly what _sanitizeSavedStats
// deletes on the account's next save. Importing it would carry a known-dead
// item into the store the cutover is supposed to make canonical.
const withGhost = { ...saved, inventory: [...saved.inventory, { id: 'no_such_item_xyz' }] };
const ghostRows = projectItems(TID, withGhost);
ok(ghostRows.length === rows.length, 'an unknown id produces no row');
ok(!verifyPlayer(withGhost, ghostRows).ok,
  'and the verifier REPORTS it rather than calling the migration clean');

const nulled = { inventory: [null, { ...GEAR }, undefined], storage: null, equipment: null };
const nullRows = projectItems(TID, nulled);
ok(nullRows.length === 1, 'holes and null containers are skipped, not projected');
ok(rowsToBlob(nullRows).inventory.length === 1,
  'and the rebuilt array is dense — no undefined left in the middle');

console.log('\nverifier');

ok(verifyPlayer({}, []).ok, 'an account with nothing verifies clean');
// Position is not an invariant; identity and quantity are. A re-sorted bag
// must not read as a discrepancy or the migration report is all noise.
const resorted = [...rows].reverse().map((r, i) =>
  r.container === 'inventory' ? { ...r, pos: String(i) } : r);
ok(verifyPlayer(saved, resorted).ok, 'a re-ordered store still verifies clean');
// A missing row must be caught, since that is the shape of losing an item.
ok(!verifyPlayer(saved, rows.slice(1)).ok, 'a dropped row is reported');
const short = rows.map(r => r.itemId === STACK.id ? { ...r, qty: 39 } : r);
ok(!verifyPlayer(saved, short).ok, 'one unit missing from a stack is reported');

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
