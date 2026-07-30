const mongoose = require('mongoose');

const PlayerSchema = new mongoose.Schema({
  telegramId:  { type: String, required: true, unique: true },
  username:    { type: String, required: true },
  savedData:   { type: mongoose.Schema.Types.Mixed, default: null },
  bm:          { type: Number, default: 0 },
  referredBy:  { type: String, default: null },
  banned:      { type: Boolean, default: false },
  createdAt:   { type: Date, default: Date.now },
});

// Leaderboard/admin-stats sort key (server/index.js's getRating/admin tops
// endpoints sort by this on every request) — without an index this is a
// full collection scan every time.
PlayerSchema.index({ bm: -1 });

module.exports = mongoose.model('Player', PlayerSchema);
