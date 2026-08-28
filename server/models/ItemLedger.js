const mongoose = require('mongoose');

// The item/currency ledger: one row per NET change to what a player owns.
//
// This is not a second copy of PlayerLog. PlayerLog records that something
// happened ('market_sold', 'quest_reward') and is trimmed to the newest
// LOG_KEEP_PER_PLAYER rows per account — a window an active player turns over
// in days, which is why "я фармил и всё пропало" was still unanswerable even
// though every item move was already being logged. This collection records
// WHAT MOVED, keeps it on a retention clock instead of a row count, and is the
// only place that can answer "was this item ever created, and by which
// operation" months after the fact.
//
// Two design decisions worth keeping:
//
//   • Rows carry a NET diff across inventory + storage + equipment together,
//     so moving a sword from the bag to the vault or onto the character
//     produces no row at all. What survives is creation and destruction —
//     exactly the shape a duplication bug has, and the reason the diff is
//     computed from a census rather than trusted from the caller.
//
//   • Retention is per-row (`expiresAt` + a TTL index at 0s), not one global
//     window. Kill loot fires on a large fraction of every kill in the game
//     and would bury everything else under a shared window; it gets days,
//     while a market trade or an admin grant gets months. See LEDGER_TTL_DAYS
//     in server/ledger.js.
const ItemLedgerSchema = new mongoose.Schema({
  telegramId: { type: String, required: true },
  username:   { type: String },
  // 'item' | 'gramBalance' | 'nexumBalance' | 'gold'
  kind:       { type: String, required: true },
  // The operation that caused it — the same reason string _commitServerItems
  // already passes to logPlayer ('craft', 'market_buy', 'admin', ...), so the
  // two collections can be read side by side.
  reason:     { type: String, required: true },

  // kind:'item' — the net diff, qty signed (negative = destroyed/spent).
  items: [{
    _id:     false,
    id:      { type: String, required: true },
    enhance: { type: Number },
    qty:     { type: Number, required: true },
  }],
  // Slot counts either side of the change. Not derivable from `items` (a
  // stack merging into an existing one changes qty without changing slots),
  // and it is the figure the inventory cap is enforced against.
  slotsBefore: { type: Number },
  slotsAfter:  { type: Number },

  // kind:'gramBalance' | 'nexumBalance' | 'gold' — signed movement and the
  // post-write balance the database itself reported (never the caller's
  // arithmetic, same rule as _incBalance's return value).
  delta: { type: Number },
  after: { type: Number },

  // Optional idempotency key for rewards that must be paid exactly once
  // ('season_quest:<id>:<tid>'). Unique where present, so a replayed grant
  // fails on the index instead of paying twice. Nothing is required to use
  // it — the paths that do get exactly-once delivery for free.
  opKey: { type: String },

  at:        { type: Date, default: Date.now },
  // Per-row expiry. TTL index below runs at expireAfterSeconds: 0, so Mongo
  // deletes each row at its own `expiresAt` rather than on one shared clock.
  expiresAt: { type: Date, required: true },
});

// The investigation query: one player, newest first.
ItemLedgerSchema.index({ telegramId: 1, at: -1 });
// The dupe-hunt query: every row that created a given item id, any player.
ItemLedgerSchema.index({ 'items.id': 1, at: -1 });
// Exactly-once delivery. Sparse: only the rows that opted in carry the field.
ItemLedgerSchema.index({ opKey: 1 }, { unique: true, sparse: true });
// Per-row retention.
ItemLedgerSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('ItemLedger', ItemLedgerSchema);
