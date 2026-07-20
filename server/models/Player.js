const mongoose = require('mongoose');

const PlayerSchema = new mongoose.Schema({
  telegramId:  { type: String, required: true, unique: true },
  username:    { type: String, required: true },
  savedData:   { type: mongoose.Schema.Types.Mixed, default: null },
  bm:          { type: Number, default: 0 },
  referredBy:  { type: String, default: null },  // telegramId of who referred this player
  createdAt:   { type: Date, default: Date.now },
});

module.exports = mongoose.model('Player', PlayerSchema);
