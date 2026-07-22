const mongoose = require('mongoose');

const PlayerLogSchema = new mongoose.Schema({
  telegramId: { type: String, required: true, index: true },
  username:   { type: String },
  event:      { type: String, required: true },
  meta:       { type: mongoose.Schema.Types.Mixed },
  at:         { type: Date, default: Date.now, index: true },
});

module.exports = mongoose.model('PlayerLog', PlayerLogSchema);
