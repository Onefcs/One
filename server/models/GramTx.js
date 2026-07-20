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

module.exports = mongoose.model('GramTx', GramTxSchema);
