const mongoose = require('mongoose');

// One row per item an account owns — the shape every server-authoritative MMO
// converges on (AzerothCore's item_instance + character_inventory, Kaetram's
// containers, rsc-server's player_items) and the one this game does not have
// yet: today an inventory is an array inside the `savedData` blob, rewritten
// whole on every save.
//
// WHAT THIS IS RIGHT NOW: a shadow. Nothing reads from it. It is populated by
// dev/item-store-migrate.js and, when ITEM_SHADOW=1 is set, kept in step by
// the same commit path that writes the blob. That is deliberate — the point of
// the shadow phase is to prove the projection is lossless against real player
// data, on a live server, before anything depends on it. Flipping reads over
// is a separate change; see ARCH-PERSISTENCE.md for what it involves.
//
// WHAT IT BUYS once reads do flip:
//   • a save stops rewriting the whole inventory to move one item,
//   • the market moves a row instead of copying an item into a listing,
//   • `{ owner, container, pos }` unique means a duplicate is an index
//     violation rather than an extra element nobody notices.
const PlayerItemSchema = new mongoose.Schema({
  telegramId: { type: String, required: true },

  // 'inventory' | 'storage' | 'equipment'. The three containers the census in
  // server/ledger.js already treats as one pool.
  container: { type: String, required: true },
  // Position within the container: the array index for inventory/storage, the
  // equipment slot name ('weapon', 'armor', ...) for equipment. A string
  // either way so one field covers both without a type union.
  //
  // NOT to be confused with an item definition's own `slot` field, which says
  // what kind of gear it is, not where it is being kept.
  pos: { type: String, required: true },

  // Catalog id. Stats are NOT stored: they are rebuilt from shared/definitions
  // on read, the same rule _canonSavedItem already applies to anything a
  // client sends. An item's stats belong to its definition, not to the copy in
  // someone's bag, and storing them again is how two players end up holding
  // the "same" sword with different numbers.
  itemId:  { type: String, required: true },
  enhance: { type: Number, default: 0 },
  qty:     { type: Number, default: 1 },

  updatedAt: { type: Date, default: Date.now },
});

// Read a player's whole item set — the query that replaces reading the blob.
PlayerItemSchema.index({ telegramId: 1, container: 1, pos: 1 }, { unique: true });
// Find every copy of an item across all accounts: the dupe hunt, and the
// reason a row-per-item store is worth the migration at all.
PlayerItemSchema.index({ itemId: 1 });

module.exports = mongoose.model('PlayerItem', PlayerItemSchema);
