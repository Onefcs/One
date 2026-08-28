'use strict';
// The market handlers (marketBrowse/MyListings/History/List/Cancel/Buy), moved
// out of server/index.js verbatim.
//
// Unlike server/game/*.js, this is NOT a module-level factory: every other
// split so far moved a singleton state machine (one _a3, one _race10 per
// process), while these handlers are per-connection — they run against the
// session's own `authed` and `lastStats`. So what they get is a session
// object, built once per socket in index.js, rather than a `deps` bag that
// tries to describe one connection's whole closure.
//
// Two kinds of dependency, and the difference is the point:
//
//   - `s` — the live session. `s.authed` and `s.lastStats` are getters,
//     because index.js reassigns both after this module is wired (selectChar
//     and saveProgress replace them wholesale); reading them off the session
//     each time is what keeps this module looking at the CURRENT values
//     instead of a stale snapshot taken at wiring time. Everything else on
//     `s` is stable for the life of the connection and is destructured below
//     under its original name, which is what keeps the moved bodies
//     byte-identical to what they were in index.js.
//
//   - `deps` — module-level things (models, io, the balance helpers, the
//     inventory helpers, the market constants). Same shape as the existing
//     game-mode factories.
//
// _lastMarketListAt moved in here with the handlers: it is the listing
// cooldown and nothing outside the market ever read it, so it belongs to this
// module's own per-session scope now rather than to index.js's closure.
module.exports = function registerMarket(s, safeOn, deps) {
  const {
    MarketListingModel, PlayerModel, io, activeSessions,
    logPlayer, logPlayerErr,
    _marketListingData, _marketHistoryData, _marketMaxActive, _marketMinPrice,
    _canonicalMarketItem, _round2, _round7,
    _incBalance, _spendBalance, _socketForTelegramId, _setVipAura, _dbPushInventory,
    _invFindOwned, _invHasRoomFor, _invAdd, _invRemove,
    MARKET_MAX_PRICE, MARKET_LIST_COOLDOWN_MS, MARKET_FEE_PCT, MARKET_VIP_PCT,
    VIP_THRESHOLDS,
  } = deps;

  // Stable for the life of the connection — see the note above on why these
  // keep their original names while authed/lastStats are read through `s`.
  // The reassigned ones (authed, lastStats, gramBalance, itemOpBusy) are NOT
  // here: they are reached through `s` so this module keeps seeing the live
  // variable rather than a copy taken at wiring time.
  const {
    socket, _commitServerItems, _itemsBusy, _liveGram, _flushBalances, _ITEMS_BUSY_MSG,
  } = s;

  // The listing cooldown, per session (see the note above).
  let _lastMarketListAt = 0;

  safeOn('marketBrowse', async () => {
    if (!s.authed) return;
    try {
      const rows = await MarketListingModel.find({ status: 'active', sellerId: { $ne: s.authed.telegramId } })
        .sort({ createdAt: -1 }).limit(700).lean();
      socket.emit('marketBrowseData', { listings: rows.map(_marketListingData) });
    } catch (err) { console.error('marketBrowse:', err); }
  });

  safeOn('marketMyListings', async () => {
    if (!s.authed) return;
    try {
      const cap = _marketMaxActive(socket.data.vipLevel);
      const rows = await MarketListingModel.find({ status: 'active', sellerId: s.authed.telegramId })
        .sort({ createdAt: -1 }).limit(cap === Infinity ? 0 : cap).lean();
      socket.emit('marketMyListingsData', { listings: rows.map(_marketListingData) });
    } catch (err) { console.error('marketMyListings:', err); }
  });

  safeOn('marketHistory', async () => {
    if (!s.authed) return;
    try {
      const rows = await MarketListingModel.find({
        status: { $in: ['sold', 'cancelled'] },
        $or: [{ sellerId: s.authed.telegramId }, { buyerId: s.authed.telegramId }],
      }).sort({ soldAt: -1, createdAt: -1 }).limit(50).lean();
      socket.emit('marketHistoryData', { entries: rows.map(l => _marketHistoryData(l, s.authed.telegramId)) });
    } catch (err) { console.error('marketHistory:', err); }
  });

  // marketList failures use a dedicated event (not the shared marketError) —
  // the client optimistically removes the item from inventory before this
  // round-trip completes, and needs to know specifically that THIS request
  // failed to roll that back, without misfiring on an unrelated buy/cancel
  // error that happens to land while a listing request is in flight.
  safeOn('marketList', async ({ item, price } = {}) => {
    if (!s.authed) return;
    if ((socket.data.vipLevel || 0) < 1) {
      return socket.emit('marketListError', { msg: 'Продажа на маркете доступна с VIP 1' });
    }
    const now = Date.now();
    if (now - _lastMarketListAt < MARKET_LIST_COOLDOWN_MS) {
      return socket.emit('marketListError', { msg: 'Слишком часто — подождите немного' });
    }
    // gramShopBuy/specialShopBuy/claimVipRewards clone s.lastStats.inventory
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
    if (_itemsBusy()) return socket.emit('marketListError', { msg: _ITEMS_BUSY_MSG });
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
    // The seller must actually own what they're listing. s.lastStats is the
    // server's own sanitized copy of the inventory, refreshed on every
    // saveProgress (the client flushes one right before this request, see
    // _confirmMarketList in js/ui.js), so it's the authoritative answer to
    // "does this account hold this item". Without this check any client could
    // list catalog items it never earned and sell them for real GRAM.
    if (!s.lastStats || !Array.isArray(s.lastStats.inventory)) {
      _lastMarketListAt = _prevListAt;
      return socket.emit('marketListError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
    }
    if (_invFindOwned(s.lastStats.inventory, canonItem) < 0) {
      _lastMarketListAt = _prevListAt;
      return socket.emit('marketListError', { msg: 'Предмета нет в инвентаре' });
    }
    // Raised for the rest of this handler: everything from here on runs
    // against s.lastStats.inventory across the two awaits below, and every
    // other synchronous item handler (equip/enhance/storage/craft/...)
    // already defers to this flag — this is what makes THAT deference
    // actually protect a listing in flight, not just a clone-and-commit one.
    s.itemOpBusy++;
    try {
      const cap = _marketMaxActive(socket.data.vipLevel);
      const activeCount = await MarketListingModel.countDocuments({ sellerId: s.authed.telegramId, status: 'active' });
      if (activeCount >= cap) {
        _lastMarketListAt = _prevListAt;
        return socket.emit('marketListError', { msg: `Максимум ${cap} активных лотов` });
      }
      // Re-check ownership right before the write: the countDocuments await
      // above is a window in which this account's own save (or a concurrent
      // listing of the same item) could have removed it.
      if (_invFindOwned(s.lastStats.inventory, canonItem) < 0) {
        _lastMarketListAt = _prevListAt;
        return socket.emit('marketListError', { msg: 'Предмета нет в инвентаре' });
      }
      const listing = await MarketListingModel.create({
        sellerId: s.authed.telegramId, sellerUsername: s.authed.username,
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
      // from THIS closure's s.lastStats.inventory once it has been orphaned
      // takes the item off nobody's account: the listing goes live, the live
      // session still holds the item, and its next save writes that inventory
      // — item included — back over the removal this handler just persisted.
      // The lot then sells and the seller keeps both the item and the GRAM.
      // Redirect the removal at whichever socket is live NOW, and undo the
      // listing when there is no live session to take it from.
      if (activeSessions.get(s.authed.telegramId) !== socket.id) {
        const _live = _socketForTelegramId(s.authed.telegramId);
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
        logPlayer(s.authed.telegramId, s.authed.username, 'market_list_cross_session',
          { item: canonItem.id, enhance: canonItem.enhance || 0, qty: canonItem.qty || 1,
            price: _round2(p), hadLiveSocket: !!_live, removed: _took, listingKept: _took });
        if (_live) {
          if (_took) _live.emit('marketListed', { listing: _marketListingData(listing) });
          else _live.emit('marketListError', { msg: 'Предмет переместился — попробуйте снова' });
        }
        return;
      }
      const _beforeLen = s.lastStats.inventory.length;
      const _removed = _invRemove(s.lastStats.inventory, canonItem);
      if (!_removed) {
        await MarketListingModel.deleteOne({ _id: listing._id }).catch(() => {});
        logPlayer(s.authed.telegramId, s.authed.username, 'market_list_vanished',
          { item: canonItem.id, enhance: canonItem.enhance || 0 });
        return socket.emit('marketListError', { msg: 'Предмет переместился — попробуйте снова' });
      }
      _commitServerItems(s.lastStats.inventory, null, 'market_list',
        { item: canonItem.id, enhance: canonItem.enhance || 0, qty: canonItem.qty || 1, price: _round2(p) }, { beforeLen: _beforeLen });
      socket.emit('marketListed', { listing: _marketListingData(listing) });
    } catch (err) {
      console.error('marketList:', err);
      _lastMarketListAt = _prevListAt;
      logPlayerErr(s.authed.telegramId, s.authed.username, 'market_list', err,
        { item: canonItem && canonItem.id });
      socket.emit('marketListError', { msg: 'Ошибка сервера' });
    } finally {
      s.itemOpBusy--;
    }
  });

  safeOn('marketCancel', async ({ listingId } = {}) => {
    if (!s.authed || !listingId) return;
    // See marketList's own busy check: a clone-and-commit handler
    // (gramShopBuy/specialShopBuy/claimVipRewards) mid-flight would have its
    // stale clone stamp back over whatever this returns to the inventory.
    if (_itemsBusy()) return socket.emit('marketError', { msg: _ITEMS_BUSY_MSG });
    s.itemOpBusy++;
    try {
      // Peek at the item before cancelling: if there's nowhere to put it back,
      // the cancellation must not happen at all. Cancelling first and only
      // then discovering the inventory is full destroyed the item — the
      // listing was already gone, so nothing would ever return it.
      const pre = await MarketListingModel.findOne(
        { _id: listingId, sellerId: s.authed.telegramId, status: 'active' }, 'item').lean();
      if (!pre) return socket.emit('marketError', { msg: 'Лот не найден' });
      const _sellerInv = (s.lastStats && Array.isArray(s.lastStats.inventory)) ? s.lastStats.inventory : null;
      // Only gate on THIS socket's inventory while this socket is still the
      // account's live session. If it isn't, the cross-session branch below
      // owns delivery (live socket, or a $push straight to the document) and
      // has its own room handling — refusing here on a stale closure's
      // inventory would block a cancellation that can be delivered fine.
      if (activeSessions.get(s.authed.telegramId) === socket.id) {
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
        { _id: listingId, sellerId: s.authed.telegramId, status: 'active' },
        { status: 'cancelled', soldAt: new Date() },
        { new: false }, // return the pre-update doc (still has the item)
      );
      if (!listing) return socket.emit('marketError', { msg: 'Лот не найден' });
      // The account may have reconnected on a DIFFERENT socket during the two
      // awaits above — that socket's closure is the live session now, not
      // this one (see _grantMarketItem's comment). Writing through _sellerInv
      // here regardless is exactly the "item vanishes after cancelling" race:
      // the item lands in a s.lastStats nobody's client can see, and the next
      // autosave from the REAL live session overwrites it away with no trace.
      if (activeSessions.get(s.authed.telegramId) !== socket.id) {
        const _liveSid = activeSessions.get(s.authed.telegramId);
        const _liveSocket = _liveSid ? io.sockets.sockets.get(_liveSid) : null;
        const _result = _liveSocket && _liveSocket.data._grantMarketItem
          ? _liveSocket.data._grantMarketItem(listing.item)
          : null;
        const _delivered = !!(_result && _result.delivered);
        if (!_delivered) {
          // No live session at all, or its inventory had no room — an atomic
          // push straight to the DB at least keeps the item from being
          // destroyed outright; it'll show up next time the account loads.
          await _dbPushInventory(s.authed, listing.item, 'market_cancel_cross_session');
        }
        logPlayer(s.authed.telegramId, s.authed.username, 'market_cancel_cross_session',
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
        _commitServerItems(_sellerInv, null, 'market_cancel',
          { item: listing.item && listing.item.id, listingId: String(listingId) }, { beforeLen: _sellerBeforeLen });
      } else {
        // Cancelled but not returned. The room check above should have caught
        // this before the listing was touched, so reaching here means the
        // inventory changed underneath us — put the LISTING back rather than
        // leaving the item nowhere. A lot that is active again can be
        // cancelled once there's space; a cancelled lot whose item never
        // arrived is gone for good.
        await MarketListingModel.updateOne(
          { _id: listingId, sellerId: s.authed.telegramId, status: 'cancelled' },
          { status: 'active', soldAt: null },
        ).catch(() => {});
        logPlayer(s.authed.telegramId, s.authed.username, 'market_cancel_noroom',
          { item: listing.item && listing.item.id, listingId: String(listingId),
            slots: _sellerInv ? _sellerInv.length : null, listingRestored: true });
        return socket.emit('marketError', { msg: 'Инвентарь полон — лот остался на маркете' });
      }
      socket.emit('marketCancelled', { listingId, item: listing.item, delivered: _returned });
    } catch (err) {
      console.error('marketCancel:', err);
      logPlayerErr(s.authed.telegramId, s.authed.username, 'market_cancel', err, { listingId: String(listingId) });
    } finally {
      s.itemOpBusy--;
    }
  });

  // Undoes THIS buyer's claim only. The old unconditional update-by-_id would
  // happily flip a listing back to 'active' regardless of who currently held
  // it, so a release racing another buyer's completed purchase could put an
  // already-paid-for lot back on sale.
  function _releaseClaim(listingId) {
    return MarketListingModel.updateOne(
      { _id: listingId, status: 'sold', buyerId: s.authed.telegramId },
      { status: 'active', buyerId: null, buyerUsername: null, soldAt: null },
    ).catch(err => console.error('marketBuy release claim:', err));
  }

  safeOn('marketBuy', async ({ listingId } = {}) => {
    if (!s.authed || !listingId) return;
    // See marketList's own busy check: a clone-and-commit handler mid-flight
    // would have its stale clone stamp back over the item this hands out.
    if (_itemsBusy()) return socket.emit('marketError', { msg: _ITEMS_BUSY_MSG });
    s.itemOpBusy++;
    try {
      const listing = await MarketListingModel.findOne({ _id: listingId, status: 'active' }, 'sellerId price').lean();
      if (!listing) return socket.emit('marketError', { msg: 'Лот уже продан или снят' });
      if (listing.sellerId === s.authed.telegramId) return socket.emit('marketError', { msg: 'Нельзя купить свой лот' });
      if (listing.price > _liveGram()) return socket.emit('marketError', { msg: 'Недостаточно GRAM' });

      // Atomically claim the listing first so two simultaneous buyers can't both win it
      const claimed = await MarketListingModel.findOneAndUpdate(
        { _id: listingId, status: 'active' },
        { status: 'sold', buyerId: s.authed.telegramId, buyerUsername: s.authed.username, soldAt: new Date() },
        { new: true },
      );
      if (!claimed) return socket.emit('marketError', { msg: 'Лот уже продан или снят' });

      // Room for the item BEFORE any money moves. The client used to just
      // report "инвентарь полон, предмет потерян" after the fact — the GRAM
      // was already gone and the item was destroyed with the listing marked
      // sold. Refuse the trade instead and put the lot back up.
      const _buyerInv = (s.lastStats && Array.isArray(s.lastStats.inventory)) ? s.lastStats.inventory : null;
      // Same shape as marketCancel's: gate on this socket's inventory only
      // while it is still the live session (the cross-session branch below
      // owns delivery otherwise), and use _invHasRoomFor rather than
      // "!stackable && full" — a stackable with no existing stack needs a
      // slot, and letting it past here meant the GRAM was spent and the item
      // then dropped on the way in. A missing inventory (a socket that never
      // ran selectChar) refuses for the same reason instead of paying first
      // and discovering there is nowhere to put it.
      if (activeSessions.get(s.authed.telegramId) === socket.id) {
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
      await _flushBalances();
      const _paid = await _spendBalance(s.authed.telegramId, 'gramBalance', claimed.price, 'market_buy');
      if (_paid === null) {
        await _releaseClaim(listingId);
        return socket.emit('marketError', { msg: 'Недостаточно GRAM' });
      }
      s.gramBalance = _paid;
      // The account may have reconnected on a DIFFERENT socket during the
      // awaits above (payment already landed — that's account-keyed, not
      // socket-keyed, so it's unaffected) — but _buyerInv is a direct
      // reference into THIS closure's s.lastStats.inventory, and writing
      // through it now would land the bought item where the real live
      // session's client can't see it, then get silently overwritten away
      // by that session's next autosave. Same race as marketCancel's, see
      // _grantMarketItem's comment.
      let _delivered;
      if (activeSessions.get(s.authed.telegramId) !== socket.id) {
        const _liveSid = activeSessions.get(s.authed.telegramId);
        const _liveSocket = _liveSid ? io.sockets.sockets.get(_liveSid) : null;
        const _result = _liveSocket && _liveSocket.data._grantMarketItem
          ? _liveSocket.data._grantMarketItem(claimed.item)
          : null;
        _delivered = !!(_result && _result.delivered);
        if (!_delivered) {
          await _dbPushInventory(s.authed, claimed.item, 'market_buy_cross_session');
        }
        logPlayer(s.authed.telegramId, s.authed.username, 'market_buy_cross_session',
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
          const _back = await _incBalance(s.authed.telegramId, 'gramBalance', claimed.price, 'market_buy_refund');
          if (_back !== null) { s.gramBalance = _back; socket.emit('gramBalanceUpdate', { balance: _back }); }
          await _releaseClaim(listingId);
          logPlayer(s.authed.telegramId, s.authed.username, 'market_buy_noroom',
            { item: claimed.item && claimed.item.id, listingId: String(listingId),
              price: claimed.price, refunded: _back !== null });
          return socket.emit('marketError', { msg: 'Инвентарь полон — покупка отменена' });
        }
        _commitServerItems(_buyerInv, null, 'market_buy',
          { item: claimed.item && claimed.item.id, price: claimed.price,
            seller: claimed.sellerId, listingId: String(listingId) }, { beforeLen: _buyerBeforeLen });
      }

      // VIP progress for the BUYER — 10% of what they actually paid. Read
      // fresh from the DB and $set the result directly, the same way
      // gramShopBuy's own (non-cross-session) VIP write does — NOT through
      // _applyGrant/s.lastStats: _sanitizeSavedStats unconditionally deletes
      // vipLevel/vipDeposited/vipPending from any object that passes through
      // it (server/anticheat.js), and every selectChar/reconnect rebuilds
      // s.lastStats through exactly that path. _applyGrant's vipGramDelta
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
            { telegramId: s.authed.telegramId },
            'savedData.vipLevel savedData.vipDeposited savedData.vipPending',
          ).lean();
          let _vipLvl = _vipDoc?.savedData?.vipLevel || 0;
          let _vipDep = (_vipDoc?.savedData?.vipDeposited || 0) + _vipGram;
          const _vipPend = Array.isArray(_vipDoc?.savedData?.vipPending) ? [..._vipDoc.savedData.vipPending] : [];
          const _prevVipLvl = _vipLvl;
          while (_vipLvl < 10 && _vipDep >= VIP_THRESHOLDS[_vipLvl + 1]) {
            _vipDep -= VIP_THRESHOLDS[_vipLvl + 1]; _vipLvl++; _vipPend.push(_vipLvl);
          }
          await PlayerModel.updateOne({ telegramId: s.authed.telegramId }, { $set: {
            'savedData.vipLevel': _vipLvl, 'savedData.vipDeposited': _vipDep, 'savedData.vipPending': _vipPend,
          } });
          const _vipLeveled = _vipLvl > _prevVipLvl;
          _vipRes = { vipLevel: _vipLvl, vipDeposited: _vipDep, vipPending: _vipPend, vipLeveled: _vipLeveled };
          const _vipTarget = _socketForTelegramId(s.authed.telegramId);
          if (_vipTarget) {
            _vipTarget.data.vipLevel = _vipLvl;
            _setVipAura(s.authed.username, _vipLvl);
            if (_vipLeveled) _vipTarget.emit('vipUpdate', { level: _vipLvl, deposited: _vipDep, pending: _vipPend });
          }
        } catch (err) {
          console.error('marketBuy vip progress:', err);
          logPlayerErr(s.authed.telegramId, s.authed.username, 'market_buy_vip', err, { listingId: String(listingId), price: claimed.price });
        }
      }

      // Credit the seller (10% fee burned — not paid to anyone), online or not.
      // A plain "+payout" against the live document: the seller may be farming,
      // spending or being paid by someone else at this very moment, and this is
      // the pattern that stops any of those erasing the sale — the reported
      // "продал лот, а GRAM не пришли / баланс перезаписался".
      const payout = _round7(claimed.price * (1 - MARKET_FEE_PCT));
      try {
        const sellerNewBal = await _incBalance(claimed.sellerId, 'gramBalance', payout, 'market_sold');
        if (sellerNewBal === null) throw new Error('seller not found');
        io.to(`tg_${claimed.sellerId}`).emit('gramBalanceUpdate', { balance: sellerNewBal });
        io.to(`tg_${claimed.sellerId}`).emit('marketSold', {
          itemName: claimed.item?.name || '', price: claimed.price, payout,
          buyerUsername: s.authed.username, newBalance: sellerNewBal,
        });
        logPlayer(claimed.sellerId, claimed.sellerUsername, 'market_sold',
          { item: claimed.item && claimed.item.id, price: claimed.price, payout,
            buyer: s.authed.username, balance: sellerNewBal });
      } catch (err) {
        console.error('marketBuy seller payout:', err);
        logPlayerErr(claimed.sellerId, claimed.sellerUsername, 'market_sold_payout', err,
          { listingId: String(listingId), payout });
      }

      socket.emit('marketBought', {
        listingId, item: claimed.item, newBalance: s.gramBalance, delivered: _delivered,
        ...(_vipRes ? {
          vipData: { level: _vipRes.vipLevel, deposited: _vipRes.vipDeposited, pending: _vipRes.vipPending },
          leveled: _vipRes.vipLeveled,
        } : {}),
      });
    } catch (err) {
      console.error('marketBuy:', err);
      logPlayerErr(s.authed.telegramId, s.authed.username, 'market_buy', err, { listingId: String(listingId) });
    } finally {
      s.itemOpBusy--;
    }
  });
};
