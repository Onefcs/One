'use strict';
// Market listing helpers, moved out of server/index.js verbatim.
//
// Pure functions over a MarketListing document: no models, no sockets, no
// session state — same shape as server/inventory.js.
const {
  MARKET_MAX_ACTIVE, MARKET_MAX_ACTIVE_VIP_LEVEL, MARKET_MAX_ACTIVE_VIP,
} = require('./inventory');

// VIP 3+ trades the flat MARKET_MAX_ACTIVE cap for the higher
// MARKET_MAX_ACTIVE_VIP cap. .limit(0) is Mongo's own "no limit" convention,
// used wherever this feeds a query instead of a comparison — no longer hit
// now that both tiers are finite, but harmless to keep.
function _marketMaxActive(vipLevel) {
  return (vipLevel || 0) >= MARKET_MAX_ACTIVE_VIP_LEVEL ? MARKET_MAX_ACTIVE_VIP : MARKET_MAX_ACTIVE;
}

// 10% of what a market BUYER pays counts toward their VIP bar, same deposit
// mechanic gramShopBuy's own pkg.gram uses — see marketBuy below.
const MARKET_VIP_PCT = 0.10;

function _marketListingData(l) {
  return {
    id: l._id.toString(), sellerId: l.sellerId, sellerUsername: l.sellerUsername,
    item: l.item, price: l.price, createdAt: l.createdAt,
  };
}
function _marketHistoryData(l, myId) {
  const asSeller = l.sellerId === myId;
  return {
    id: l._id.toString(),
    item: l.item, price: l.price, status: l.status,
    role: asSeller ? 'sell' : 'buy',
    counterpart: asSeller ? (l.buyerUsername || null) : l.sellerUsername,
    createdAt: l.createdAt, soldAt: l.soldAt,
  };
}

module.exports = { _marketMaxActive, MARKET_VIP_PCT, _marketListingData, _marketHistoryData };
