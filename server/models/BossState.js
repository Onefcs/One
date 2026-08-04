const mongoose = require('mongoose');

// One doc per (floor, arm) per-arm boss — just the wall-clock deadline it
// respawns at. Written every time one dies (see the onBossDeath hook Room.js
// is given, server/index.js) and read back at server startup so a restart
// mid-cooldown doesn't lose the real remaining time and hand out a fresh
// random 1-2h wait on top of whatever was already ticked down.
const BossStateSchema = new mongoose.Schema({
  floor:     { type: Number, required: true },
  arm:       { type: String, required: true },
  respawnAt: { type: Number, required: true }, // epoch ms
});

BossStateSchema.index({ floor: 1, arm: 1 }, { unique: true });

module.exports = mongoose.model('BossState', BossStateSchema);
