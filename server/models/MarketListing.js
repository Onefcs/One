const mongoose = require('mongoose');

const MarketListingSchema = new mongoose.Schema({
  sellerId:       { type: String, required: true },
  sellerUsername: { type: String, default: '' },
  item:           { type: mongoose.Schema.Types.Mixed, required: true },
  price:          { type: Number, required: true }, // GRAM
  status:         { type: String, enum: ['active', 'sold', 'cancelled'], default: 'active' },
  buyerId:        { type: String, default: null },
  buyerUsername:  { type: String, default: null },
  createdAt:      { type: Date, default: Date.now },
  soldAt:         { type: Date, default: null },
});

module.exports = mongoose.model('MarketListing', MarketListingSchema);
