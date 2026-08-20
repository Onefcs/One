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
  // Seller payout, recorded on the sale itself.
  //
  // marketBuy is a claim-check-compensate sequence: the listing is claimed by
  // an atomic status flip, the buyer's GRAM by a conditional $inc, and every
  // failure after that point compensates the step before it. The seller's
  // payout is the last leg and the only one with nothing after it to undo — a
  // failed $inc there used to be logged and swallowed, leaving the buyer with
  // the item, the buyer's GRAM spent, and the seller unpaid.
  //
  // The log was the only trace, and PlayerLog is trimmed to the newest 100 rows
  // per player, so a busy account's evidence rotated out. These two fields put
  // the debt on the sale, where nothing trims it: payoutAt is set once the
  // seller is actually paid, payoutOwed carries what is still owed if that
  // never happened. A sale with payoutOwed > 0 and no payoutAt is a real,
  // queryable debt rather than a line in a log that may be gone.
  payoutAt:       { type: Date, default: null },
  payoutOwed:     { type: Number, default: 0 },
});

// marketBrowse/marketHistory/admin market tab all filter by status and sort
// by createdAt; marketMyListings filters by {sellerId, status} — without
// these it's a full collection scan on every listing/browse/history request.
MarketListingSchema.index({ status: 1, createdAt: -1 });
MarketListingSchema.index({ sellerId: 1, status: 1 });
// Unsettled payouts — a tiny, usually empty set, but the admin panel has to be
// able to find it without scanning every sale ever made.
MarketListingSchema.index({ payoutOwed: 1 });

module.exports = mongoose.model('MarketListing', MarketListingSchema);
