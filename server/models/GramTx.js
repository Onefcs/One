const mongoose = require('mongoose');

const GramTxSchema = new mongoose.Schema({
  telegramId: { type: String, required: true },
  username:   { type: String, default: '' },
  type:       { type: String, enum: ['deposit', 'withdraw'], required: true },
  amount:     { type: Number, required: true },
  address:    { type: String, default: '' },  // withdraw destination
  memo:       { type: String, default: '' },  // deposit identifier
  status:     { type: String, enum: ['pending', 'confirmed', 'rejected'], default: 'pending' },
  adminMsgId: { type: Number, default: null },
  createdAt:  { type: Date, default: Date.now },
});

// Per-user transaction history (gramGetHistory) filters by telegramId and
// sorts by createdAt on every request — without this it's a full scan.
GramTxSchema.index({ telegramId: 1, createdAt: -1 });

module.exports = mongoose.model('GramTx', GramTxSchema);
