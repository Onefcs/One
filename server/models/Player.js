const mongoose = require('mongoose');

const PlayerSchema = new mongoose.Schema({
  telegramId:  { type: String, required: true, unique: true },
  username:    { type: String, required: true },
  savedData:   { type: mongoose.Schema.Types.Mixed, default: null },
  bm:          { type: Number, default: 0 },
  referredBy:  { type: String, default: null },
  banned:      { type: Boolean, default: false },
  // Set once, the first time the "🆕 Новый игрок" message is claimed for this
  // account (see _notifyAdminNewPlayer). Several independent paths can each
  // meet a player for what looks like the first time — the bot's /start, the
  // Mini App's first auth, referral registration — so the flag, not the
  // caller, is what makes that message fire exactly once per account.
  adminNotified: { type: Boolean, default: false },
  createdAt:   { type: Date, default: Date.now },
});

// Leaderboard/admin-stats sort key (server/index.js's getRating/admin tops
// endpoints sort by this on every request) — without an index this is a
// full collection scan every time.
PlayerSchema.index({ bm: -1 });

// _resolveUsername (server/index.js — every privMsg/privMsgHistory lookup)
// used to match this with a case-insensitive ^...$ regex, which Mongo can't
// serve off a plain index (a collection-wide scan on every single call,
// worse than the missing bm index above since this is a social feature
// players trigger far more often). A strength:2 collation index makes
// case-insensitive EQUALITY match usable via an index — it only helps when
// the query itself also requests this exact collation, which is why
// _resolveUsername was switched from the regex to a plain equality match
// with .collation() rather than just adding this index alone.
PlayerSchema.index({ username: 1 }, { collation: { locale: 'en', strength: 2 } });

// The season leaderboard (server/index.js's seasonRating) sorts the whole
// collection by this on every call, and it is a PLAYER-facing handler — any
// client may fire it up to the heavy-event budget (40 per 5s per socket).
// Unindexed that was a full collection scan plus an in-memory sort per
// request, on the same connection pool every progress save shares; past 32MB
// of matched documents MongoDB refuses the sort outright rather than running
// it slowly. Sparse because only players who have scored anything this season
// carry the field, and the query itself only ever asks for { $gt: 0 }.
PlayerSchema.index({ 'savedData.seasonPoints': -1 }, { sparse: true });

// Same reasoning for the admin dashboard's "top by" tables (/admin/stats).
// Fired far less often than the season board, but each one was also a full
// scan with an in-memory sort, and they run against the live pool while
// players are online.
PlayerSchema.index({ 'savedData.lvl': -1 });
PlayerSchema.index({ 'savedData.gold': -1 });
PlayerSchema.index({ 'savedData.nexumBalance': -1 });

module.exports = mongoose.model('Player', PlayerSchema);
