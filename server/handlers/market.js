'use strict';
// The market's six socket handlers: browse, my listings, history, list, cancel,
// buy.
//
// FIRST cut into io.on('connection'), which is a different job from everything
// under server/events/ and server/admin/. Those were regions of module scope
// that happened to sit in one file. This is per-socket session state, and the
// handlers do not merely read it — they write it. A `let` in the connection
// closure cannot be handed to a module by value without the module getting a
// snapshot, so what crosses the boundary here is accessors and verbs, listed
// below, and server/index.js keeps owning the variables themselves.
//
// Session state, by how it is used:
//
//   session          an object of LIVE accessors over the closure's own
//                    variables — session.authed and session.lastStats read
//                    through getters, session.gram reads and writes. Not a
//                    snapshot, and that is the whole point: both are reassigned
//                    in the closure (on login, on save), and marketList
//                    deliberately re-checks session.lastStats.inventory AFTER
//                    its awaits, which a captured value would silently defeat.
//                    session.gram's setter assigns exactly what the closure's
//                    own code assigned — deliberately NOT the closure's
//                    _setGram, which also writes the balance cache; every write
//                    here already carries a value the database returned, and
//                    routing them through the cache-writing setter would be a
//                    behaviour change this move has no business making.
//   liveGram         the cache-aware read the buy path gates on
//   itemsBusy,       _itemOpBusy is a counter shared with crafting, equipping
//   beginItemOp,     and storage. A verb crosses a module boundary; ++ on
//   endItemOp        someone else's `let` does not.
//
// _lastMarketListAt, the per-seller listing cooldown, is NOT in that list: it
// was declared in the connection closure but nothing outside these six handlers
// ever touched it, so it moves in here as an ordinary local. Registration runs
// once per socket, which is exactly the scope it wants.
// GRAM movement is fully server-authoritative (the same balance/cache pattern
// the wallet uses). The item itself is trusted from the client at the same
// level as the rest of the inventory system — this game doesn't otherwise keep
// a server-side copy of item stats to validate against. This note sat under a
// `// ── Market ──` heading in server/index.js that had drifted 785 lines away
// from the handlers it described; it is next to them now.
const MarketListingModel = require('../models/MarketListing');
const PlayerModel = require('../models/Player');
const { VIP_THRESHOLDS } = require('../../shared/definitions');
const {
  MARKET_MAX_PRICE, MARKET_FEE_PCT, MARKET_LIST_COOLDOWN_MS, MARKET_VIP_PCT,
  _round2, _round7, _canonicalMarketItem, _marketMinPrice,
  _marketMaxActive, _marketListingData, _marketHistoryData,
  _invFindOwned, _invRemove, _invAdd, _invHasRoomFor,
} = require('../inventory');

// See createGuildWar (server/events/guildwar.js) for why this is checked rather
// than assumed. It matters more here: these are per-socket, so a name missed in
// the wiring would not throw until some player happened to open the market.
const REQUIRED_DEPS = [
  'socket', 'safeOn', 'session', 'dbPushInventory',
];

// What this file takes from the shared services object.
const REQUIRED_SVC = [
  'io', 'activeSessions', 'logPlayer', 'logPlayerErr', 'incBalance',
  'spendBalance', 'setVipAura', 'socketForTelegramId',
];

// ...and from the per-socket session. Both are checked below for the same
// reason REQUIRED_DEPS is: a name missing from svc or session destructures to
// undefined, which no linter sees and nothing throws on until that path runs.
const REQUIRED_SESSION = [
  'liveGram', 'itemsBusy', 'beginItemOp', 'endItemOp', 'ITEMS_BUSY_MSG',
  'commitServerItems', 'flushBalances',
];

module.exports = function registerMarketHandlers(deps) {
  if (!deps || !deps.svc || !deps.session) throw new Error('market: needs svc and session');
  const { svc, session } = deps;
  const missingSvc = REQUIRED_SVC.filter(k => svc[k] == null);
  if (missingSvc.length) throw new Error(`market: svc missing: ${missingSvc.join(', ')}`);
  const missingSess = REQUIRED_SESSION.filter(k => session[k] == null);
  if (missingSess.length) throw new Error(`market: session missing: ${missingSess.join(', ')}`);
  const missing = REQUIRED_DEPS.filter(k => deps[k] == null);
  if (missing.length) throw new Error(`registerMarketHandlers: missing deps: ${missing.join(', ')}`);
  const {
    socket, safeOn, dbPushInventory,
  } = deps;
  const {
    io, activeSessions, logPlayer, logPlayerErr, incBalance, spendBalance,
    setVipAura, socketForTelegramId,
  } = svc;
  const {
    liveGram, itemsBusy, beginItemOp, endItemOp, ITEMS_BUSY_MSG,
    commitServerItems, flushBalances,
  } = session;

  // Per-seller listing cooldown — see the header for why it lives here now.
  let _lastMarketListAt = 0;

    safeOn('marketBrowse', async () => {
      if (!session.authed) return;
      try {
        const rows = await MarketListingModel.find({ status: 'active', sellerId: { $ne: session.authed.telegramId } })
          .sort({ createdAt: -1 }).limit(700).lean();
        socket.emit('marketBrowseData', { listings: rows.map(_marketListingData) });
      } catch (err) { console.error('marketBrowse:', err); }
    });

    safeOn('marketMyListings', async () => {
      if (!session.authed) return;
      try {
        const cap = _marketMaxActive(socket.data.vipLevel);
        const rows = await MarketListingModel.find({ status: 'active', sellerId: session.authed.telegramId })
          .sort({ createdAt: -1 }).limit(cap === Infinity ? 0 : cap).lean();
        socket.emit('marketMyListingsData', { listings: rows.map(_marketListingData) });
      } catch (err) { console.error('marketMyListings:', err); }
    });

    safeOn('marketHistory', async () => {
      if (!session.authed) return;
      try {
        const rows = await MarketListingModel.find({
          status: { $in: ['sold', 'cancelled'] },
          $or: [{ sellerId: session.authed.telegramId }, { buyerId: session.authed.telegramId }],
        }).sort({ soldAt: -1, createdAt: -1 }).limit(50).lean();
        socket.emit('marketHistoryData', { entries: rows.map(l => _marketHistoryData(l, session.authed.telegramId)) });
      } catch (err) { console.error('marketHistory:', err); }
    });

    // marketList failures use a dedicated event (not the shared marketError) —
    // the client optimistically removes the item from inventory before this
    // round-trip completes, and needs to know specifically that THIS request
    // failed to roll that back, without misfiring on an unrelated buy/cancel
    // error that happens to land while a listing request is in flight.
    safeOn('marketList', async ({ item, price } = {}) => {
      if (!session.authed) return;
      if ((socket.data.vipLevel || 0) < 1) {
        return socket.emit('marketListError', { msg: 'Продажа на маркете доступна с VIP 1' });
      }
      const now = Date.now();
      if (now - _lastMarketListAt < MARKET_LIST_COOLDOWN_MS) {
        return socket.emit('marketListError', { msg: 'Слишком часто — подождите немного' });
      }
      // gramShopBuy/specialShopBuy/claimVipRewards clone _lastStats.inventory
      // before their own DB awaits and stamp that clone back over the live
      // array wholesale when they finally commit — see _itemsBusy's comment.
      // This handler's own removal below runs synchronously once its awaits
      // resolve, so if one of those clone-and-commit handlers is holding a
      // snapshot taken before the removal, its later commit resurrects the
      // item this handler already sold: the listing goes live AND the item
      // reappears in the live array the moment that stale commit lands —
      // exactly the "market clones items" duplication. Refusing up front,
      // before the item is touched at all, is the only way to close it, since
      // the clone was already taken by the time this handler could otherwise
      // detect anything wrong.
      if (itemsBusy()) return socket.emit('marketListError', { msg: ITEMS_BUSY_MSG });
      // Only id + enhance are trusted from the client — every other field
      // (stats, rarity, name, img...) is rebuilt from the canonical catalog.
      // Computed before the price check below: the minimum price depends on
      // which item this actually is (see _marketMinPrice).
      const canonItem = _canonicalMarketItem(item);
      if (!canonItem) {
        return socket.emit('marketListError', { msg: 'Такого предмета не существует' });
      }
      const p = Number(price);
      const minPrice = _marketMinPrice(canonItem);
      if (!Number.isFinite(p) || p < minPrice || p > MARKET_MAX_PRICE) {
        return socket.emit('marketListError', { msg: `Цена должна быть от ${minPrice} до ${MARKET_MAX_PRICE} GRAM` });
      }
      // Claim the cooldown slot BEFORE the first await. Setting it after the
      // countDocuments round-trip let two listings sent back-to-back both read
      // the old timestamp, pass the check and create a listing each — which,
      // with a client that sends the same item twice, minted a duplicate.
      const _prevListAt = _lastMarketListAt;
      _lastMarketListAt = now;
      // The seller must actually own what they're listing. _lastStats is the
      // server's own sanitized copy of the inventory, refreshed on every
      // saveProgress (the client flushes one right before this request, see
      // _confirmMarketList in js/ui.js), so it's the authoritative answer to
      // "does this account hold this item". Without this check any client could
      // list catalog items it never earned and sell them for real GRAM.
      if (!session.lastStats || !Array.isArray(session.lastStats.inventory)) {
        _lastMarketListAt = _prevListAt;
        return socket.emit('marketListError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
      }
      if (_invFindOwned(session.lastStats.inventory, canonItem) < 0) {
        _lastMarketListAt = _prevListAt;
        return socket.emit('marketListError', { msg: 'Предмета нет в инвентаре' });
      }
      // Raised for the rest of this handler: everything from here on runs
      // against _lastStats.inventory across the two awaits below, and every
      // other synchronous item handler (equip/enhance/storage/craft/...)
      // already defers to this flag — this is what makes THAT deference
      // actually protect a listing in flight, not just a clone-and-commit one.
      beginItemOp();
      try {
        const cap = _marketMaxActive(socket.data.vipLevel);
        const activeCount = await MarketListingModel.countDocuments({ sellerId: session.authed.telegramId, status: 'active' });
        if (activeCount >= cap) {
          _lastMarketListAt = _prevListAt;
          return socket.emit('marketListError', { msg: `Максимум ${cap} активных лотов` });
        }
        // Re-check ownership right before the write: the countDocuments await
        // above is a window in which this account's own save (or a concurrent
        // listing of the same item) could have removed it.
        if (_invFindOwned(session.lastStats.inventory, canonItem) < 0) {
          _lastMarketListAt = _prevListAt;
          return socket.emit('marketListError', { msg: 'Предмета нет в инвентаре' });
        }
        const listing = await MarketListingModel.create({
          sellerId: session.authed.telegramId, sellerUsername: session.authed.username,
          item: canonItem, price: _round2(p), status: 'active',
        });
        // Take the item out of the server's copy too, and persist immediately —
        // otherwise the item only left the account once the CLIENT's own save
        // landed, and listing-then-killing-the-app duplicated it.
        //
        // The create() above is itself an await — a second yield point after
        // the ownership re-check just before it. A synchronous handler that
        // moves this SAME item out of plain inventory (equipItem, storageDeposit,
        // enhanceItem's relocation) can run in that gap, and _invRemove then
        // finds nothing to take: the listing is already live in the DB, but the
        // item was never actually removed — still equipped/stored AND for sale.
        // That combination IS the duplication, so the removal's result has to
        // gate the listing rather than be fired and ignored.
        //
        // The account may also have reconnected on a DIFFERENT socket across
        // those same awaits — every other item handler already guards for it
        // (marketCancel/marketBuy/craftGear/gramShopBuy/...), this one did not,
        // and it is the direction that duplicates rather than loses. Removing
        // from THIS closure's _lastStats.inventory once it has been orphaned
        // takes the item off nobody's account: the listing goes live, the live
        // session still holds the item, and its next save writes that inventory
        // — item included — back over the removal this handler just persisted.
        // The lot then sells and the seller keeps both the item and the GRAM.
        // Redirect the removal at whichever socket is live NOW, and undo the
        // listing when there is no live session to take it from.
        if (activeSessions.get(session.authed.telegramId) !== socket.id) {
          const _live = socketForTelegramId(session.authed.telegramId);
          const _res = _live && _live.data._takeMarketItem
            ? _live.data._takeMarketItem(canonItem)
            : null;
          const _took = !!(_res && _res.removed);
          if (!_took) {
            // Nothing was taken from the account, so nothing may be for sale.
            // Dropping the lot costs the player only the request itself — the
            // item is untouched and can be listed again — whereas keeping it
            // is the duplication above.
            await MarketListingModel.deleteOne({ _id: listing._id }).catch(() => {});
          }
          logPlayer(session.authed.telegramId, session.authed.username, 'market_list_cross_session',
            { item: canonItem.id, enhance: canonItem.enhance || 0, qty: canonItem.qty || 1,
              price: _round2(p), hadLiveSocket: !!_live, removed: _took, listingKept: _took });
          if (_live) {
            if (_took) _live.emit('marketListed', { listing: _marketListingData(listing) });
            else _live.emit('marketListError', { msg: 'Предмет переместился — попробуйте снова' });
          }
          return;
        }
        const _beforeLen = session.lastStats.inventory.length;
        const _removed = _invRemove(session.lastStats.inventory, canonItem);
        if (!_removed) {
          await MarketListingModel.deleteOne({ _id: listing._id }).catch(() => {});
          logPlayer(session.authed.telegramId, session.authed.username, 'market_list_vanished',
            { item: canonItem.id, enhance: canonItem.enhance || 0 });
          return socket.emit('marketListError', { msg: 'Предмет переместился — попробуйте снова' });
        }
        commitServerItems(session.lastStats.inventory, null, 'market_list',
          { item: canonItem.id, enhance: canonItem.enhance || 0, qty: canonItem.qty || 1, price: _round2(p) }, { beforeLen: _beforeLen });
        socket.emit('marketListed', { listing: _marketListingData(listing) });
      } catch (err) {
        console.error('marketList:', err);
        _lastMarketListAt = _prevListAt;
        logPlayerErr(session.authed.telegramId, session.authed.username, 'market_list', err,
          { item: canonItem && canonItem.id });
        socket.emit('marketListError', { msg: 'Ошибка сервера' });
      } finally {
        endItemOp();
      }
    });

    safeOn('marketCancel', async ({ listingId } = {}) => {
      if (!session.authed || !listingId) return;
      // See marketList's own busy check: a clone-and-commit handler
      // (gramShopBuy/specialShopBuy/claimVipRewards) mid-flight would have its
      // stale clone stamp back over whatever this returns to the inventory.
      if (itemsBusy()) return socket.emit('marketError', { msg: ITEMS_BUSY_MSG });
      beginItemOp();
      try {
        // Peek at the item before cancelling: if there's nowhere to put it back,
        // the cancellation must not happen at all. Cancelling first and only
        // then discovering the inventory is full destroyed the item — the
        // listing was already gone, so nothing would ever return it.
        const pre = await MarketListingModel.findOne(
          { _id: listingId, sellerId: session.authed.telegramId, status: 'active' }, 'item').lean();
        if (!pre) return socket.emit('marketError', { msg: 'Лот не найден' });
        const _sellerInv = (session.lastStats && Array.isArray(session.lastStats.inventory)) ? session.lastStats.inventory : null;
        // Only gate on THIS socket's inventory while this socket is still the
        // account's live session. If it isn't, the cross-session branch below
        // owns delivery (live socket, or a $push straight to the document) and
        // has its own room handling — refusing here on a stale closure's
        // inventory would block a cancellation that can be delivered fine.
        if (activeSessions.get(session.authed.telegramId) === socket.id) {
          if (!_sellerInv) {
            return socket.emit('marketError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
          }
          // _invHasRoomFor, not "!stackable && full": a stackable with no
          // existing stack needs a slot too, and letting it through here meant
          // the listing was cancelled and then the item destroyed on the way in.
          if (!_invHasRoomFor(_sellerInv, pre.item)) {
            return socket.emit('marketError', { msg: 'Инвентарь полон' });
          }
        }
        const listing = await MarketListingModel.findOneAndUpdate(
          { _id: listingId, sellerId: session.authed.telegramId, status: 'active' },
          { status: 'cancelled', soldAt: new Date() },
          { new: false }, // return the pre-update doc (still has the item)
        );
        if (!listing) return socket.emit('marketError', { msg: 'Лот не найден' });
        // The account may have reconnected on a DIFFERENT socket during the two
        // awaits above — that socket's closure is the live session now, not
        // this one (see _grantMarketItem's comment). Writing through _sellerInv
        // here regardless is exactly the "item vanishes after cancelling" race:
        // the item lands in a _lastStats nobody's client can see, and the next
        // autosave from the REAL live session overwrites it away with no trace.
        if (activeSessions.get(session.authed.telegramId) !== socket.id) {
          const _liveSid = activeSessions.get(session.authed.telegramId);
          const _liveSocket = _liveSid ? io.sockets.sockets.get(_liveSid) : null;
          const _result = _liveSocket && _liveSocket.data._grantMarketItem
            ? _liveSocket.data._grantMarketItem(listing.item)
            : null;
          const _delivered = !!(_result && _result.delivered);
          if (!_delivered) {
            // No live session at all, or its inventory had no room — an atomic
            // push straight to the DB at least keeps the item from being
            // destroyed outright; it'll show up next time the account loads.
            await dbPushInventory(session.authed, listing.item, 'market_cancel_cross_session');
          }
          logPlayer(session.authed.telegramId, session.authed.username, 'market_cancel_cross_session',
            { item: listing.item && listing.item.id, listingId: String(listingId),
              hadLiveSocket: !!_liveSocket, delivered: _delivered });
          if (_liveSocket) _liveSocket.emit('marketCancelled', { listingId, item: listing.item, delivered: true });
          return;
        }
        // Put the item back server-side as well. Relying on the client to do it
        // from the marketCancelled event meant a lost event (or a disconnect in
        // the round trip) destroyed the item — the listing was already
        // cancelled, so nothing would ever return it.
        const _sellerBeforeLen = _sellerInv ? _sellerInv.length : 0;
        const _returned = !!(_sellerInv && _invAdd(_sellerInv, listing.item));
        if (_returned) {
          commitServerItems(_sellerInv, null, 'market_cancel',
            { item: listing.item && listing.item.id, listingId: String(listingId) }, { beforeLen: _sellerBeforeLen });
        } else {
          // Cancelled but not returned. The room check above should have caught
          // this before the listing was touched, so reaching here means the
          // inventory changed underneath us — put the LISTING back rather than
          // leaving the item nowhere. A lot that is active again can be
          // cancelled once there's space; a cancelled lot whose item never
          // arrived is gone for good.
          await MarketListingModel.updateOne(
            { _id: listingId, sellerId: session.authed.telegramId, status: 'cancelled' },
            { status: 'active', soldAt: null },
          ).catch(() => {});
          logPlayer(session.authed.telegramId, session.authed.username, 'market_cancel_noroom',
            { item: listing.item && listing.item.id, listingId: String(listingId),
              slots: _sellerInv ? _sellerInv.length : null, listingRestored: true });
          return socket.emit('marketError', { msg: 'Инвентарь полон — лот остался на маркете' });
        }
        socket.emit('marketCancelled', { listingId, item: listing.item, delivered: _returned });
      } catch (err) {
        console.error('marketCancel:', err);
        logPlayerErr(session.authed.telegramId, session.authed.username, 'market_cancel', err, { listingId: String(listingId) });
      } finally {
        endItemOp();
      }
    });

    // Undoes THIS buyer's claim only. The old unconditional update-by-_id would
    // happily flip a listing back to 'active' regardless of who currently held
    // it, so a release racing another buyer's completed purchase could put an
    // already-paid-for lot back on sale.
    function _releaseClaim(listingId) {
      return MarketListingModel.updateOne(
        { _id: listingId, status: 'sold', buyerId: session.authed.telegramId },
        { status: 'active', buyerId: null, buyerUsername: null, soldAt: null },
      ).catch(err => console.error('marketBuy release claim:', err));
    }

    safeOn('marketBuy', async ({ listingId } = {}) => {
      if (!session.authed || !listingId) return;
      // See marketList's own busy check: a clone-and-commit handler mid-flight
      // would have its stale clone stamp back over the item this hands out.
      if (itemsBusy()) return socket.emit('marketError', { msg: ITEMS_BUSY_MSG });
      beginItemOp();
      try {
        const listing = await MarketListingModel.findOne({ _id: listingId, status: 'active' }, 'sellerId price').lean();
        if (!listing) return socket.emit('marketError', { msg: 'Лот уже продан или снят' });
        if (listing.sellerId === session.authed.telegramId) return socket.emit('marketError', { msg: 'Нельзя купить свой лот' });
        if (listing.price > liveGram()) return socket.emit('marketError', { msg: 'Недостаточно GRAM' });

        // Atomically claim the listing first so two simultaneous buyers can't both win it
        const claimed = await MarketListingModel.findOneAndUpdate(
          { _id: listingId, status: 'active' },
          { status: 'sold', buyerId: session.authed.telegramId, buyerUsername: session.authed.username, soldAt: new Date() },
          { new: true },
        );
        if (!claimed) return socket.emit('marketError', { msg: 'Лот уже продан или снят' });

        // Room for the item BEFORE any money moves. The client used to just
        // report "инвентарь полон, предмет потерян" after the fact — the GRAM
        // was already gone and the item was destroyed with the listing marked
        // sold. Refuse the trade instead and put the lot back up.
        const _buyerInv = (session.lastStats && Array.isArray(session.lastStats.inventory)) ? session.lastStats.inventory : null;
        // Same shape as marketCancel's: gate on this socket's inventory only
        // while it is still the live session (the cross-session branch below
        // owns delivery otherwise), and use _invHasRoomFor rather than
        // "!stackable && full" — a stackable with no existing stack needs a
        // slot, and letting it past here meant the GRAM was spent and the item
        // then dropped on the way in. A missing inventory (a socket that never
        // ran selectChar) refuses for the same reason instead of paying first
        // and discovering there is nowhere to put it.
        if (activeSessions.get(session.authed.telegramId) === socket.id) {
          if (!_buyerInv) {
            await _releaseClaim(listingId);
            return socket.emit('marketError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
          }
          if (!_invHasRoomFor(_buyerInv, claimed.item)) {
            await _releaseClaim(listingId);
            return socket.emit('marketError', { msg: 'Инвентарь полон' });
          }
        }
        // Payment is the affordability check: _spendBalance only writes if the
        // balance covers the price, so two purchases in flight can't be paid for
        // out of the same GRAM. Pending drop earnings are flushed first so the
        // player can spend what they've just farmed.
        await flushBalances();
        const _paid = await spendBalance(session.authed.telegramId, 'gramBalance', claimed.price);
        if (_paid === null) {
          await _releaseClaim(listingId);
          return socket.emit('marketError', { msg: 'Недостаточно GRAM' });
        }
        session.gram = _paid;
        // The account may have reconnected on a DIFFERENT socket during the
        // awaits above (payment already landed — that's account-keyed, not
        // socket-keyed, so it's unaffected) — but _buyerInv is a direct
        // reference into THIS closure's _lastStats.inventory, and writing
        // through it now would land the bought item where the real live
        // session's client can't see it, then get silently overwritten away
        // by that session's next autosave. Same race as marketCancel's, see
        // _grantMarketItem's comment.
        let _delivered;
        if (activeSessions.get(session.authed.telegramId) !== socket.id) {
          const _liveSid = activeSessions.get(session.authed.telegramId);
          const _liveSocket = _liveSid ? io.sockets.sockets.get(_liveSid) : null;
          const _result = _liveSocket && _liveSocket.data._grantMarketItem
            ? _liveSocket.data._grantMarketItem(claimed.item)
            : null;
          _delivered = !!(_result && _result.delivered);
          if (!_delivered) {
            await dbPushInventory(session.authed, claimed.item, 'market_buy_cross_session');
          }
          logPlayer(session.authed.telegramId, session.authed.username, 'market_buy_cross_session',
            { item: claimed.item && claimed.item.id, listingId: String(listingId),
              hadLiveSocket: !!_liveSocket, delivered: _delivered });
          if (_liveSocket) {
            _liveSocket.emit('marketBought', {
              listingId, item: claimed.item, newBalance: _paid, delivered: true,
            });
          }
        } else {
          // The item is delivered server-side so a marketBought event that never
          // reaches the client (disconnect, lost packet) can't leave the buyer
          // having paid for nothing.
          const _buyerBeforeLen = _buyerInv ? _buyerInv.length : 0;
          _delivered = !!(_buyerInv && _invAdd(_buyerInv, claimed.item));
          if (!_delivered) {
            // The room check above already refused this case, so getting here
            // means the inventory changed under us between the two. The GRAM is
            // already gone and the seller has NOT been paid yet (that's below),
            // so unwind the whole trade rather than leaving the buyer charged
            // for an item that has nowhere to go.
            const _back = await incBalance(session.authed.telegramId, 'gramBalance', claimed.price);
            if (_back !== null) { session.gram = _back; socket.emit('gramBalanceUpdate', { balance: _back }); }
            await _releaseClaim(listingId);
            logPlayer(session.authed.telegramId, session.authed.username, 'market_buy_noroom',
              { item: claimed.item && claimed.item.id, listingId: String(listingId),
                price: claimed.price, refunded: _back !== null });
            return socket.emit('marketError', { msg: 'Инвентарь полон — покупка отменена' });
          }
          commitServerItems(_buyerInv, null, 'market_buy',
            { item: claimed.item && claimed.item.id, price: claimed.price,
              seller: claimed.sellerId, listingId: String(listingId) }, { beforeLen: _buyerBeforeLen });
        }

        // VIP progress for the BUYER — 10% of what they actually paid. Read
        // fresh from the DB and $set the result directly, the same way
        // gramShopBuy's own (non-cross-session) VIP write does — NOT through
        // _applyGrant/_lastStats: _sanitizeSavedStats unconditionally deletes
        // vipLevel/vipDeposited/vipPending from any object that passes through
        // it (server/anticheat.js), and every selectChar/reconnect rebuilds
        // _lastStats through exactly that path. _applyGrant's vipGramDelta
        // would have read that wiped (usually 0/undefined) value as the
        // starting point and written it straight back over the account's real
        // VIP progress — which is what reset players' VIP after a purchase.
        // Placed after the no-room unwind above (which refunds the trade
        // outright) so a purchase that never actually completed can't still
        // fill the bar.
        let _vipRes = null;
        const _vipGram = _round2(claimed.price * MARKET_VIP_PCT);
        if (_vipGram > 0) {
          try {
            const _vipDoc = await PlayerModel.findOne(
              { telegramId: session.authed.telegramId },
              'savedData.vipLevel savedData.vipDeposited savedData.vipPending',
            ).lean();
            let _vipLvl = _vipDoc?.savedData?.vipLevel || 0;
            let _vipDep = (_vipDoc?.savedData?.vipDeposited || 0) + _vipGram;
            const _vipPend = Array.isArray(_vipDoc?.savedData?.vipPending) ? [..._vipDoc.savedData.vipPending] : [];
            const _prevVipLvl = _vipLvl;
            while (_vipLvl < 10 && _vipDep >= VIP_THRESHOLDS[_vipLvl + 1]) {
              _vipDep -= VIP_THRESHOLDS[_vipLvl + 1]; _vipLvl++; _vipPend.push(_vipLvl);
            }
            await PlayerModel.updateOne({ telegramId: session.authed.telegramId }, { $set: {
              'savedData.vipLevel': _vipLvl, 'savedData.vipDeposited': _vipDep, 'savedData.vipPending': _vipPend,
            } });
            const _vipLeveled = _vipLvl > _prevVipLvl;
            _vipRes = { vipLevel: _vipLvl, vipDeposited: _vipDep, vipPending: _vipPend, vipLeveled: _vipLeveled };
            const _vipTarget = socketForTelegramId(session.authed.telegramId);
            if (_vipTarget) {
              _vipTarget.data.vipLevel = _vipLvl;
              setVipAura(session.authed.username, _vipLvl);
              if (_vipLeveled) _vipTarget.emit('vipUpdate', { level: _vipLvl, deposited: _vipDep, pending: _vipPend });
            }
          } catch (err) {
            console.error('marketBuy vip progress:', err);
            logPlayerErr(session.authed.telegramId, session.authed.username, 'market_buy_vip', err, { listingId: String(listingId), price: claimed.price });
          }
        }

        // Credit the seller (10% fee burned — not paid to anyone), online or not.
        // A plain "+payout" against the live document: the seller may be farming,
        // spending or being paid by someone else at this very moment, and this is
        // the pattern that stops any of those erasing the sale — the reported
        // "продал лот, а GRAM не пришли / баланс перезаписался".
        const payout = _round7(claimed.price * (1 - MARKET_FEE_PCT));
        try {
          const sellerNewBal = await incBalance(claimed.sellerId, 'gramBalance', payout);
          if (sellerNewBal === null) throw new Error('seller not found');
          io.to(`tg_${claimed.sellerId}`).emit('gramBalanceUpdate', { balance: sellerNewBal });
          io.to(`tg_${claimed.sellerId}`).emit('marketSold', {
            itemName: claimed.item?.name || '', price: claimed.price, payout,
            buyerUsername: session.authed.username, newBalance: sellerNewBal,
          });
          logPlayer(claimed.sellerId, claimed.sellerUsername, 'market_sold',
            { item: claimed.item && claimed.item.id, price: claimed.price, payout,
              buyer: session.authed.username, balance: sellerNewBal });
        } catch (err) {
          console.error('marketBuy seller payout:', err);
          logPlayerErr(claimed.sellerId, claimed.sellerUsername, 'market_sold_payout', err,
            { listingId: String(listingId), payout });
        }

        socket.emit('marketBought', {
          listingId, item: claimed.item, newBalance: session.gram, delivered: _delivered,
          ...(_vipRes ? {
            vipData: { level: _vipRes.vipLevel, deposited: _vipRes.vipDeposited, pending: _vipRes.vipPending },
            leveled: _vipRes.vipLeveled,
          } : {}),
        });
      } catch (err) {
        console.error('marketBuy:', err);
        logPlayerErr(session.authed.telegramId, session.authed.username, 'market_buy', err, { listingId: String(listingId) });
      } finally {
        endItemOp();
      }
    });
};
