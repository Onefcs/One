const mongoose = require('mongoose');

const SpecialQuestSchema = new mongoose.Schema({
  title:   { type: String, required: true },
  desc:    { type: String, default: '' },
  type:    { type: String, enum: ['link', 'subscribe', 'custom'], default: 'link' },
  url:     { type: String, default: '' },
  icon:    { type: String, default: '⭐' },
  reward:  {
    gold:  { type: Number, default: 0 },
    xp:    { type: Number, default: 0 },
    nexum: { type: Number, default: 0 },
  },
  active:    { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('SpecialQuest', SpecialQuestSchema);
