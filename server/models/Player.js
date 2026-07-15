const mongoose = require('mongoose');

const PlayerSchema = new mongoose.Schema({
  username:     { type: String, required: true, unique: true, trim: true },
  passwordHash: { type: String, required: true },
  savedData:    { type: mongoose.Schema.Types.Mixed, default: null },
  createdAt:    { type: Date, default: Date.now },
});

module.exports = mongoose.model('Player', PlayerSchema);
