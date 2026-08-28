'use strict';
// Item/currency ledger — the writer side of server/models/ItemLedger.js.
//
// Pure over its inputs apart from the one model it owns: no sockets, no
// session state, no other collection. Everything here is either census
// arithmetic (exercised directly by dev/ledger-check.js) or a fire-and-forget
// write that must never be able to fail a game action — a ledger that can
// break a market purchase is worse than no ledger, so every write swallows.

const ItemLedgerModel = require('./models/ItemLedger');

// Per-reason retention, in days. The default covers anything not named here.
//
// The split exists because the volumes differ by three orders of magnitude.
// `mob_loot` fires on a large fraction of every kill in the game; keeping it
// as long as a market trade would make the collection almost entirely loot
// rows and push the interesting ones out of any index that matters. A week is
// enough for the reports it actually answers ("вчера дропнулось и пропало"),
// while anything that moves value between accounts — trades, admin grants,
// withdrawals — is kept long enough to investigate a chargeback.
const LEDGER_TTL_DAYS = {
  default: 90,

  // Fires on a large fraction of every kill in the game, per player. A week
  // covers the reports these actually answer ("вчера выпало и пропало");
  // keeping them at the default would make the collection almost entirely
  // loot rows.
  mob_loot:    7,
  world_drop:  7,
  kill_drop:   7,   // the GRAM/Liberty side of the same kills (_flushBalances)
  equip:       7,
  unequip:     7,
  storage_in:  7,
  storage_out: 7,

  // Value moving between accounts, or in and out of the game entirely. These
  // are the rows a chargeback, a scam report or a dupe hunt is answered from,
  // and they are rare enough to keep for a year.
  market_buy:                 365,
  market_sold:                365,
  market_list:                365,
  market_cancel:              365,
  market_buy_refund:          365,
  market_cross_session_grant: 365,
  market_list_cross_session:  365,
  gram_deposit:               365,
  gram_withdraw:              365,
  gram_withdraw_refund:       365,
  gram_shop:                  365,
  gram_shop_nexum:            365,
  referral:                   365,
  admin:                      365,
  clan_storage_deposit:       365,
  clan_storage_claim:         365,
  clan_storage_return:        365,
};

function _ttlDaysFor(reason) {
  return LEDGER_TTL_DAYS[reason] != null ? LEDGER_TTL_DAYS[reason] : LEDGER_TTL_DAYS.default;
}

function _expiresAt(reason, now) {
  const base = now instanceof Date ? now.getTime() : Date.now();
  return new Date(base + _ttlDaysFor(reason) * 86400000);
}

// ── Census ───────────────────────────────────────────────────────────────────
// A multiset of everything an account owns, keyed by identity rather than by
// position: `id` for a plain item, `id#enhance` for an enhanceable one (a +7
// sword and a +0 sword of the same id are not interchangeable and a ledger
// that merged them would hide the enhance-dupe class of bug entirely).
//
// Position is deliberately NOT part of the key. Inventory, storage and
// equipment go into ONE census, so moving an item between them nets to zero
// and writes no row. What survives a diff is only creation and destruction.
function censusKey(item) {
  if (!item || !item.id) return null;
  const enh = Math.floor(Number(item.enhance));
  return (Number.isFinite(enh) && enh > 0) ? `${item.id}#${enh}` : String(item.id);
}

function _countOf(item) {
  const q = Math.floor(Number(item.qty));
  return (Number.isFinite(q) && q > 0) ? q : 1;
}

// `equipment` is a slot -> item object, the other two are arrays. All three are
// optional: a session that has not selected a character yet has none of them.
function census({ inventory, storage, equipment } = {}) {
  const m = new Map();
  const add = item => {
    const k = censusKey(item);
    if (!k) return;
    m.set(k, (m.get(k) || 0) + _countOf(item));
  };
  if (Array.isArray(inventory)) inventory.forEach(add);
  if (Array.isArray(storage)) storage.forEach(add);
  if (equipment && typeof equipment === 'object') Object.values(equipment).forEach(add);
  return m;
}

// Signed diff between two censuses, newest minus oldest. Returns [] when
// nothing was created or destroyed — which is the common case (an equip, a
// storage move, a re-sort) and the caller's signal to write no row at all.
function censusDiff(before, after) {
  const out = [];
  const keys = new Set([...before.keys(), ...after.keys()]);
  for (const k of keys) {
    const qty = (after.get(k) || 0) - (before.get(k) || 0);
    if (!qty) continue;
    const hash = k.indexOf('#');
    out.push(hash === -1
      ? { id: k, qty }
      : { id: k.slice(0, hash), enhance: Number(k.slice(hash + 1)), qty });
  }
  // Destroyed first, then created: reading a craft or an enhance row top-down
  // then shows what went in before what came out.
  out.sort((a, b) => (a.qty - b.qty) || String(a.id).localeCompare(String(b.id)));
  return out;
}

// A diff can in principle be as large as the whole inventory (an admin
// wholesale replace, a first login). Rows are for reading, so cap the array
// and record that it was cut rather than storing an unbounded document.
const LEDGER_MAX_ITEMS = 40;

// ── Write buffer ─────────────────────────────────────────────────────────────
// The ledger sees a row on most kills in the game, per player. One create()
// each would put a round trip on the same connection pool every progress save
// shares — the exact cost pattern AUDIT-PERF.md already went after elsewhere —
// for rows nobody reads until an investigation weeks later.
//
// So ordinary rows are buffered and go out as one insertMany. The window is
// short and the batch is capped, so the most that can be lost to a hard crash
// is a couple of seconds of history, which is the right trade for a collection
// whose job is forensic rather than transactional. Rows carrying an `opKey`
// are the exception: the caller is asking "has this been paid already?", and
// an answer that arrives two seconds later is not an answer.
const LEDGER_FLUSH_MS = 2000;
const LEDGER_FLUSH_MAX = 200;
let _buffer = [];
let _flushTimer = null;

async function ledgerFlush() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  if (!_buffer.length) return 0;
  const batch = _buffer;
  // Swapped out before the await so rows arriving during the write join the
  // next batch instead of being written twice or dropped.
  _buffer = [];
  try {
    // ordered:false so one malformed row cannot discard the rest of the batch.
    await ItemLedgerModel.insertMany(batch, { ordered: false });
    return batch.length;
  } catch (err) {
    console.error('[ledger] batch write failed:', err && err.message);
    return 0;
  }
}

function _queue(row) {
  _buffer.push(row);
  if (_buffer.length >= LEDGER_FLUSH_MAX) { ledgerFlush(); return; }
  if (!_flushTimer) {
    _flushTimer = setTimeout(ledgerFlush, LEDGER_FLUSH_MS);
    // Never hold the process open for the ledger — a shutdown should not wait
    // on it, and the exit hook in server/index.js flushes what is left.
    if (_flushTimer.unref) _flushTimer.unref();
  }
}

// Written immediately rather than buffered, and the duplicate-key answer is
// returned to the caller. Only used by rows that carry an opKey.
async function _writeNow(row) {
  try {
    await ItemLedgerModel.create(row);
    return true;
  } catch (err) {
    // A duplicate opKey is the mechanism working, not a failure: the caller
    // asked for exactly-once and this is the second attempt. Distinguish it so
    // a caller that cares can refuse to pay out, and stay quiet in the log.
    if (err && err.code === 11000) return false;
    console.error('[ledger] write failed:', err && err.message);
    return false;
  }
}

// ── Writers ──────────────────────────────────────────────────────────────────
// Both return a promise that always resolves. A buffered row resolves true as
// soon as it is queued; only an opKey row waits for the database, because only
// an opKey row has an answer worth waiting for.

async function ledgerItems({ telegramId, username, reason, items, slotsBefore, slotsAfter, opKey }) {
  if (!telegramId || !Array.isArray(items) || !items.length) return false;
  const _reason = reason || 'change';
  const row = {
    telegramId: String(telegramId),
    username,
    kind: 'item',
    reason: _reason,
    items: items.slice(0, LEDGER_MAX_ITEMS),
    slotsBefore, slotsAfter,
    opKey: opKey || undefined,
    at: new Date(),
    expiresAt: _expiresAt(_reason),
  };
  if (opKey) return _writeNow(row);
  _queue(row);
  return true;
}

async function ledgerBalance({ telegramId, username, field, reason, delta, after, opKey }) {
  if (!telegramId || !Number.isFinite(delta) || delta === 0) return false;
  const _reason = reason || 'change';
  const row = {
    telegramId: String(telegramId),
    username,
    kind: field,
    reason: _reason,
    delta,
    after: Number.isFinite(after) ? after : undefined,
    opKey: opKey || undefined,
    at: new Date(),
    expiresAt: _expiresAt(_reason),
  };
  if (opKey) return _writeNow(row);
  _queue(row);
  return true;
}

module.exports = {
  census, censusDiff, censusKey,
  ledgerItems, ledgerBalance, ledgerFlush,
  LEDGER_TTL_DAYS, LEDGER_MAX_ITEMS, LEDGER_FLUSH_MS, _ttlDaysFor, _expiresAt,
};
