const mongoose = require('mongoose');

// Singleton doc (key: 'castle') tracking who owns the Guild War tower. HP is
// deliberately NOT persisted here — it lives only in Room.js's in-memory
// enemy list, same as every other boss in this game, so a restart mid-fight
// resets the tower to full HP but never touches ownership. Only ownership is
// written here, and only on capture / clan disband — never per-hit.
const GuildWarStateSchema = new mongoose.Schema({
  key:           { type: String, required: true, default: 'castle' },
  ownerClanId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Clan', default: null },
  ownerClanName: { type: String, default: null },
  ownerClanIcon: { type: Number, default: null },
  capturedAt:    { type: Number, default: 0 }, // epoch ms
});

GuildWarStateSchema.index({ key: 1 }, { unique: true });

module.exports = mongoose.model('GuildWarState', GuildWarStateSchema);
