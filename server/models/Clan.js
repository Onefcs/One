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

const clanSchema = new mongoose.Schema({
  name:         { type: String, required: true, unique: true, maxlength: 10 },
  icon:         { type: Number, required: true, min: 1, max: 30 },
  description:  { type: String, default: '', maxlength: 200 },
  members:      [memberSchema],
  applications: [applicationSchema],
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
