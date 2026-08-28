'use strict';
// Projection between the `savedData` blob and the row-per-item store
// (server/models/PlayerItem.js), plus the verifier that says whether the two
// agree.
//
// The projection functions are pure and take no model — dev/item-store-check.js
// exercises them directly, and dev/item-store-migrate.js runs them over every
// account in the database before anything is switched over. Only syncPlayer
// touches Mongo.
//
// Read server/models/PlayerItem.js first for why this is a shadow rather than
// the source of truth yet.

const { _canonSavedItem } = require('./anticheat');
const { census, censusDiff } = require('./ledger');

// Writing the shadow costs a bulkWrite per item commit, which is not free on a
// server that commits on most kills. Off unless asked for, so the shadow can
// be turned on for a day to gather evidence and turned off again without a
// deploy.
const ITEM_SHADOW = process.env.ITEM_SHADOW === '1';

// ── Blob -> rows ─────────────────────────────────────────────────────────────
// `pos` is the array index for the two array containers and the slot name for
// equipment. Entries with no catalog id are dropped rather than projected:
// they are exactly what _sanitizeSavedStats would delete on the next save, and
// carrying them into a store whose whole point is a canonical item set would
// import the problem instead of leaving it behind.
function projectItems(telegramId, saved) {
  const rows = [];
  const push = (container, pos, raw) => {
    if (!raw || typeof raw !== 'object' || raw.id == null) return;
    const canon = _canonSavedItem(raw);
    if (!canon) return;
    const enh = Math.floor(Number(canon.enhance));
    const qty = Math.floor(Number(canon.qty));
    rows.push({
      telegramId: String(telegramId),
      container, pos: String(pos),
      itemId: String(canon.id),
      enhance: (Number.isFinite(enh) && enh > 0) ? enh : 0,
      qty: (Number.isFinite(qty) && qty > 0) ? qty : 1,
    });
  };
  if (Array.isArray(saved?.inventory)) saved.inventory.forEach((it, i) => push('inventory', i, it));
  if (Array.isArray(saved?.storage)) saved.storage.forEach((it, i) => push('storage', i, it));
  const eq = saved?.equipment;
  if (eq && typeof eq === 'object' && !Array.isArray(eq)) {
    for (const [slot, it] of Object.entries(eq)) push('equipment', slot, it);
  }
  return rows;
}

// ── Rows -> blob ─────────────────────────────────────────────────────────────
// The read side the cutover will use. Stats come from the catalog, never from
// the row — see the itemId comment in the model.
//
// Array containers are rebuilt in `pos` order and then RE-INDEXED, so a store
// with a hole in it (pos 0,1,3) produces a dense array rather than one with an
// undefined in the middle. The order is preserved; the numbering is not
// meaningful beyond it.
function rowsToBlob(rows) {
  const inventory = [], storage = [], equipment = {};
  const byPos = (a, b) => Number(a.pos) - Number(b.pos);
  const build = row => {
    const item = _canonSavedItem({ id: row.itemId, enhance: row.enhance, qty: row.qty });
    return item || null;
  };
  for (const r of (rows || []).filter(r => r.container === 'inventory').sort(byPos)) {
    const it = build(r); if (it) inventory.push(it);
  }
  for (const r of (rows || []).filter(r => r.container === 'storage').sort(byPos)) {
    const it = build(r); if (it) storage.push(it);
  }
  for (const r of (rows || []).filter(r => r.container === 'equipment')) {
    const it = build(r); if (it) equipment[r.pos] = it;
  }
  return { inventory, storage, equipment };
}

// ── Verifier ─────────────────────────────────────────────────────────────────
// Does the store hold the same items as the blob it was projected from?
//
// Compared as a census (server/ledger.js) rather than element by element, and
// deliberately so: position is not an invariant — a re-index, an equip, a
// stack merge all move things around without changing what is owned — while
// identity and quantity are. A non-empty `diff` is a real discrepancy;
// `positionsDiffer` is worth reporting but is not a loss.
function verifyPlayer(saved, rows) {
  const fromBlob = census({
    inventory: saved?.inventory, storage: saved?.storage, equipment: saved?.equipment,
  });
  const rebuilt = rowsToBlob(rows);
  const fromRows = census(rebuilt);
  const diff = censusDiff(fromBlob, fromRows);
  return {
    ok: diff.length === 0,
    // Signed the same way a ledger row is: positive means the store holds
    // something the blob does not.
    diff,
    positionsDiffer:
      (Array.isArray(saved?.inventory) ? saved.inventory.length : 0) !== rebuilt.inventory.length ||
      (Array.isArray(saved?.storage) ? saved.storage.length : 0) !== rebuilt.storage.length,
  };
}

// ── Write side ───────────────────────────────────────────────────────────────
// Replace an account's rows with the projection of its current blob. One
// deleteMany + one insertMany rather than a per-row diff: an inventory is tens
// of rows, the whole thing is being rewritten on the blob side anyway, and a
// diff would need the previous state read back first.
//
// Never throws and never blocks the caller — the shadow must not be able to
// fail a game action. Returns false when it did nothing.
async function syncPlayer(PlayerItemModel, telegramId, saved) {
  if (!telegramId || !saved) return false;
  try {
    const rows = projectItems(telegramId, saved);
    await PlayerItemModel.deleteMany({ telegramId: String(telegramId) });
    if (rows.length) await PlayerItemModel.insertMany(rows, { ordered: false });
    return true;
  } catch (err) {
    console.error('[item-store] sync failed:', err && err.message);
    return false;
  }
}

module.exports = { ITEM_SHADOW, projectItems, rowsToBlob, verifyPlayer, syncPlayer };
