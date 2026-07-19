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
  members:      [memberSchema],
  applications: [applicationSchema],
  level:        { type: Number, default: 1, min: 1, max: 10 },
  xp:           { type: Number, default: 0 },
  createdAt:    { type: Date, default: Date.now },
});

module.exports = mongoose.model('Clan', clanSchema);
