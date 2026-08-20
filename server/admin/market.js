'use strict';
// Admin: the player market — listing search, cancelling one lot, cancelling
// every lot. A cancel has to return the item to a seller who may be online, so
// these reach the live session rather than only the database.
const MarketListingModel = require('../models/MarketListing');
const PlayerModel = require('../models/Player');
const { _invAdd, _invHasRoomFor } = require('../inventory');
const REQUIRED_DEPS = ['adminAuth', 'activeSessions', 'io', 'logPlayer'];

module.exports = function register(app, deps) {
  const missing = REQUIRED_DEPS.filter(k => !deps || deps[k] == null);
  if (missing.length) throw new Error(`market: missing deps: ${missing.join(', ')}`);
  const { adminAuth, activeSessions, io, logPlayer } = deps;

  app.get('/admin/market', adminAuth, async (req, res) => {
    try {
      const { page = 1, tab = 'active' } = req.query;
      const filter = tab === 'history' ? { status: { $in: ['sold', 'cancelled'] } } : { status: 'active' };
      const listings = await MarketListingModel.find(filter)
        .sort({ createdAt: -1 }).skip((page - 1) * 50).limit(50).lean();
      // Resolve referrers via sellerId (field name in model)
      const sellerIds = [...new Set(listings.map(l => l.sellerId).filter(Boolean))];
      const sellers = await PlayerModel.find({ telegramId: { $in: sellerIds } }, 'username telegramId referredBy').lean();
      const sellerMap = Object.fromEntries(sellers.map(s => [s.telegramId, s]));
      const refIds = [...new Set(sellers.map(s => s.referredBy).filter(Boolean))];
      const refs = await PlayerModel.find({ telegramId: { $in: refIds } }, 'username telegramId').lean();
      const refMap = Object.fromEntries(refs.map(r => [r.telegramId, r.username]));
      res.json({ listings: listings.map(l => ({
        _id: l._id, status: l.status,
        itemName: l.item?.name || l.item?.id || '?',
        itemRarity: l.item?.rarity || '',
        price: l.price,
        sellerUsername: l.sellerUsername || sellerMap[l.sellerId]?.username || l.sellerId,
        buyerUsername: l.buyerUsername || null,
        referrerUsername: sellerMap[l.sellerId]?.referredBy ? (refMap[sellerMap[l.sellerId].referredBy] || null) : null,
        createdAt: l.createdAt, soldAt: l.soldAt,
      })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Cancels one active listing and returns its item to the seller — same
  // mechanics as the player's own marketCancel (server/index.js), just
  // initiated by an admin and for a seller who is very likely offline. Checks
  // for room BEFORE flipping the listing's status, same "never destroy the
  // item" rule marketCancel follows, so a full inventory refuses the cancel
  // entirely rather than cancelling and losing the item.
  async function _adminCancelListing(listingId) {
    const pre = await MarketListingModel.findOne({ _id: listingId, status: 'active' }).lean();
    if (!pre) return { ok: false, error: 'Лот не найден или уже закрыт' };

    const liveSocket = io.sockets.sockets.get(activeSessions.get(String(pre.sellerId)) || '');
    const live = liveSocket && liveSocket.data && liveSocket.data._adminApplyItems;
    let sellerDoc = null, sellerInv, sellerEq;
    if (live) {
      const base = liveSocket.data._adminReadItems();
      sellerInv = base.inventory.slice();
      sellerEq = base.equipment;
    } else {
      sellerDoc = await PlayerModel.findOne({ telegramId: pre.sellerId });
      if (!sellerDoc) return { ok: false, error: 'Продавец не найден' };
      const saved = sellerDoc.savedData || {};
      sellerInv = Array.isArray(saved.inventory) ? saved.inventory.slice() : [];
    }
    // _invHasRoomFor, not "!stackable && full" — see its own comment: a
    // stackable with no existing stack still needs a slot, and letting it
    // through here cancelled the listing and then destroyed the item.
    if (!_invHasRoomFor(sellerInv, pre.item)) {
      return { ok: false, error: 'У продавца полон инвентарь' };
    }

    const listing = await MarketListingModel.findOneAndUpdate(
      { _id: listingId, status: 'active' },
      { status: 'cancelled', soldAt: new Date() },
      { new: false }, // pre-update doc, still carries the item
    );
    if (!listing) return { ok: false, error: 'Лот не найден или уже закрыт' };

    // A refused live apply (the seller has an item op in flight) is treated as
    // "not delivered", which takes the branch below that puts the LISTING back
    // — the item is never left nowhere.
    let delivered = _invAdd(sellerInv, listing.item);
    if (delivered) {
      if (live) delivered = await liveSocket.data._adminApplyItems(sellerInv, sellerEq);
      else await PlayerModel.updateOne({ _id: sellerDoc._id }, { $set: { 'savedData.inventory': sellerInv } });
    }
    if (!delivered) {
      // The room check above already refused this case, so we only get here if
      // the seller's inventory changed in between. Put the listing back rather
      // than leaving it cancelled with the item nowhere — same reasoning as the
      // player-facing marketCancel handler.
      await MarketListingModel.updateOne(
        { _id: listing._id, status: 'cancelled' }, { status: 'active', soldAt: null },
      ).catch(() => {});
      logPlayer(listing.sellerId, listing.sellerUsername, 'admin_market_cancel_noroom',
        { listingId: String(listing._id), item: listing.item && listing.item.id, listingRestored: true });
      return { ok: false, error: 'У продавца полон инвентарь — лот оставлен активным' };
    }
    io.to(`tg_${listing.sellerId}`).emit('marketCancelled', {
      listingId: String(listing._id), item: listing.item, delivered,
    });
    logPlayer(listing.sellerId, listing.sellerUsername, 'admin_market_cancel',
      { listingId: String(listing._id), item: listing.item && listing.item.id, delivered });
    return { ok: true, delivered };
  }

  app.post('/admin/market/:id/cancel', adminAuth, async (req, res) => {
    try {
      const result = await _adminCancelListing(req.params.id);
      if (!result.ok) return res.status(400).json({ error: result.error });
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Cancels every currently active listing, one at a time — same per-listing
  // safety (room check, item return) as the single-cancel endpoint above, just
  // looped. Not a hot path (an admin action, run rarely), so sequential is
  // fine and keeps each listing's DB round trip isolated from the others.
  // Each iteration is caught on its own: one listing throwing (a malformed
  // item, a lookup failure) used to abort the whole res.json below with a bare
  // 500, silently leaving every listing after it in the list still active with
  // no visible reason why. Now a bad one is just one more "failed" entry and
  // the rest still get processed.
  app.post('/admin/market/cancel-all', adminAuth, async (req, res) => {
    try {
      const listings = await MarketListingModel.find({ status: 'active' }, '_id').lean();
      let delivered = 0, failed = 0;
      const errors = [];
      for (const l of listings) {
        try {
          const result = await _adminCancelListing(l._id);
          if (result.ok && result.delivered) delivered++;
          else { failed++; errors.push({ id: String(l._id), error: result.error || 'Инвентарь полон' }); }
        } catch (e) {
          failed++;
          errors.push({ id: String(l._id), error: e.message });
          console.error('admin_market_cancel_all item failed:', l._id, e);
        }
      }
      // Each successful cancellation already logged itself individually
      // (_adminCancelListing above) against its own seller — nothing aggregate
      // to add here beyond the failures, capped so a bad batch can't bloat the
      // response.
      res.json({ ok: true, total: listings.length, delivered, failed, errors: errors.slice(0, 20) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
