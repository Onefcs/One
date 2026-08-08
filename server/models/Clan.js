const mongoose = require('mongoose');

const memberSchema = new mongoose.Schema({
  telegramId: String,
  username:   String,
  role:       { type: String, enum: ['leader', 'member'], default: 'member' },
  joinedAt:   { type: Date, default: Date.now },
}, { _id: false });

const applicationSchema = new mongoose.Schema({
  telegramId: String,
  username:   String,
  appliedAt:  { type: Date, default: Date.now },
}, { _id: false });

// Clan storage — a shared pool of Осколки. Members put shards in, the leader
// decides who gets them. Only shard ids ever land here (the deposit handler
// checks against UNIQUE_SHARDS), so one entry per kind with a running count is
// the whole of it — no enhance level, no per-item identity.
const clanStorageSchema = new mongoose.Schema({
  id:  { type: String, required: true },
  qty: { type: Number, default: 0, min: 0 },
}, { _id: false });

// A leader's allocation, waiting for its recipient to collect it. Shards move
// storage → allocation → the member's inventory rather than straight into it,
// because the recipient is usually offline when the leader hands them out:
// writing to an offline account's saved inventory races their next login, and
// an online member claiming for themselves goes through the same
// _commitServerItems path every other server-side grant uses.
const clanAllocSchema = new mongoose.Schema({
  telegramId: { type: String, required: true },
  username:   String,
  id:         { type: String, required: true },
  qty:        { type: Number, default: 0, min: 0 },
  byUsername: String,                              // who allocated it
  at:         { type: Date, default: Date.now },
}, { _id: false });

const clanSchema = new mongoose.Schema({
  name:         { type: String, required: true, unique: true, maxlength: 10 },
  icon:         { type: Number, required: true, min: 1, max: 30 },
  description:  { type: String, default: '', maxlength: 200 },
  members:      [memberSchema],
  applications: [applicationSchema],
  // Storage is off until the leader buys it (CLAN_STORAGE_UNLOCK_GOLD). Absent
  // on every clan that existed before the feature, which reads as false — so
  // they all start locked, which is what a paid unlock has to mean.
  storageUnlocked: { type: Boolean, default: false },
  storage:      [clanStorageSchema],
  allocations:  [clanAllocSchema],
  level:        { type: Number, default: 1, min: 1, max: 10 },
  xp:           { type: Number, default: 0 },
  createdAt:    { type: Date, default: Date.now },
});

// Practically every clan read starts from "which clan is this player in?" —
// findOne({ 'members.telegramId': ... }) — and without a multikey index on the
// embedded member array that is a full collection scan every time. It ran on
// every single monster kill (clan XP), so at a few hundred players farming it
// was scanning the whole clan collection hundreds of times a second and
// starving the connection pool that ordinary progress saves share.
clanSchema.index({ 'members.telegramId': 1 });
// Same for the join flow, which looks a player up by pending application.
clanSchema.index({ 'applications.telegramId': 1 });

module.exports = mongoose.model('Clan', clanSchema);
