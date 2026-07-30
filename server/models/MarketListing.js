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

// marketBrowse/marketHistory/admin market tab all filter by status and sort
// by createdAt; marketMyListings filters by {sellerId, status} — without
// these it's a full collection scan on every listing/browse/history request.
MarketListingSchema.index({ status: 1, createdAt: -1 });
MarketListingSchema.index({ sellerId: 1, status: 1 });

module.exports = mongoose.model('MarketListing', MarketListingSchema);
