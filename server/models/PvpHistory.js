const mongoose = require('mongoose');

// One row per PvP-relevant outcome for a single account — a kill, a death,
// or a match win/lose — shown in the profile's История tab. Kept as its own
// collection rather than folded into PlayerLog: that log is shared with
// high-frequency diagnostic events (inventory ops, market, errors) and only
// keeps the newest 100 rows per player, which would push PvP history out
// within a day for anyone playing normally.
const PvpHistorySchema = new mongoose.Schema({
  telegramId: { type: String, required: true, index: true },
  // 'kill' | 'death' | 'win' | 'lose'
  kind:       { type: String, required: true },
  // 'death_battle' | 'arena3' | 'race10'
  mode:       { type: String, required: true },
  // The other account involved, when one is known — always set for a
  // kill/death (that's who did it/who it was done to); a match-level
  // win/lose from a multi-entrant mode may not point at one specific person.
  opponent:   { type: String, default: null },
  at:         { type: Date, default: Date.now },
});

PvpHistorySchema.index({ telegramId: 1, at: -1 });

module.exports = mongoose.model('PvpHistory', PvpHistorySchema);
