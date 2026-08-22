'use strict';
// gram: the safeOn handlers moved out of server/index.js verbatim, with
// the closure helpers only this domain used.
//
// Per-connection, so this takes the session object rather than the plain deps
// bag the server/game/*.js factories use — see server/handlers/market.js for
// the reasoning. `s.*` is every piece of connection state index.js reassigns
// after this module is wired; everything stable is destructured below under
// its original name, which is what keeps the moved bodies byte-identical.
module.exports = function registerGram(s, safeOn, deps) {
  const {
    BOX_DEF, CRAFT_MATS, GRAM_MIN_WITHDRAW, GramTxModel, ITEM_DEF,
    PlayerModel, SERVER_INV_MAX, VIP_THRESHOLDS, _GRAM_SHOP_PKGS,
    _SHOP_ARMOR_SETS, _SHOP_CLASS_WEAPONS, _STONE_DEFS, _VIP_BP, _incBalance,
    _setVipAura, _shopNewSlots, _socketForTelegramId, _spendBalance, _txData,
    activeSessions, io, logPlayer, logPlayerErr, notifyAdminGram, pkgPrice,
    seasonActive, seasonShopPoints,
  } = deps;

  const {
    _ITEMS_BUSY_MSG, _commitServerItems, _flushBalances, _itemsBusy,
    _liveGram, _liveInventory, _seasonAddPoints, _withEconLock, socket,
  } = s;

    // ── GRAM wallet ───────────────────────────────────────────────────────────
    safeOn('gramDepositRequest', async ({ amount, memo }) => {
      if (!s.authed || !amount || amount < 1) return;
      try {
        const tx = await GramTxModel.create({
          telegramId: s.authed.telegramId,
          username:   s.authed.username,
          type: 'deposit',
          amount: Number(amount),
          // Bounded: it is shown to the admin in a Telegram message and stored
          // per request, so there's no reason to accept an arbitrary-length blob.
          memo: String(memo || s.authed.telegramId).slice(0, 64),
        });
        socket.emit('gramTxCreated', { tx: _txData(tx) });
        logPlayer(s.authed.telegramId, s.authed.username, 'gram_deposit_request',
          { amount: Number(amount), tx: tx._id.toString() });
        notifyAdminGram(tx).catch(() => {});
      } catch (err) {
        console.error('gramDepositRequest:', err);
        logPlayerErr(s.authed.telegramId, s.authed.username, 'gram_deposit_request', err, { amount });
      }
    });

    safeOn('gramWithdrawRequest', async ({ amount, address }) => {
      if (!s.authed || !amount || amount < GRAM_MIN_WITHDRAW || !address) return;
      if ((socket.data.vipLevel || 0) < 3) {
        return socket.emit('gramError', { msg: 'Вывод GRAM доступен с VIP 3' });
      }
      try {
        const amt = Number(amount);
        if (!Number.isFinite(amt) || amt <= 0) return;
        // Any pending drop earnings have to reach the database before the balance
        // is tested, or a player could be told they can't afford a withdrawal
        // they've already earned the GRAM for.
        await _flushBalances();

        // The deduction IS the affordability check: _spendBalance only writes if
        // the stored balance covers the amount, so two withdrawal requests sent
        // together can't both succeed against the same funds. Refunded in full if
        // the admin rejects the request (see _handleAdminCallback).
        const newBal = await _spendBalance(s.authed.telegramId, 'gramBalance', amt);
        if (newBal === null) return socket.emit('gramError', { msg: 'Недостаточно средств' });
        s.gramBalance = newBal;

        let tx;
        try {
          tx = await GramTxModel.create({
            telegramId: s.authed.telegramId,
            username:   s.authed.username,
            type: 'withdraw',
            amount: amt,
            address: String(address).slice(0, 128),
          });
        } catch (err) {
          // The money is already out of the account and there is now no request
          // to refund it from — put it back rather than leave the player short.
          const back = await _incBalance(s.authed.telegramId, 'gramBalance', amt);
          if (back !== null) s.gramBalance = back;
          logPlayerErr(s.authed.telegramId, s.authed.username, 'gram_withdraw_request', err, { amount: amt, refunded: true });
          return socket.emit('gramError', { msg: 'Не удалось создать заявку — средства возвращены' });
        }

        socket.emit('gramTxCreated', { tx: _txData(tx), newBalance: s.gramBalance });
        logPlayer(s.authed.telegramId, s.authed.username, 'gram_withdraw_request',
          { amount: amt, newBalance: s.gramBalance, tx: tx._id.toString() });
        notifyAdminGram(tx).catch(() => {});
      } catch (err) {
        console.error('gramWithdrawRequest:', err);
        logPlayerErr(s.authed.telegramId, s.authed.username, 'gram_withdraw_request', err, { amount });
      }
    });

    safeOn('gramGetHistory', async () => {
      if (!s.authed) return;
      try {
        const txs = await GramTxModel.find({ telegramId: s.authed.telegramId })
          .sort({ createdAt: -1 }).limit(30).lean();
        socket.emit('gramHistory', { txs: txs.map(_txData) });
      } catch (err) { console.error('gramGetHistory:', err); }
    });

    safeOn('gramShopBuy', async ({ pkgId, petId } = {}) => {
      if (!s.authed || !pkgId) return;
      // Refuse rather than clone a snapshot that a concurrently-running market
      // op could invalidate — see _itemsBusy's own comment and marketList's
      // busy check, below, for the duplication this closes.
      if (_itemsBusy()) return socket.emit('gramShopError', { msg: _ITEMS_BUSY_MSG });
      s.itemOpBusy++;
      let _ran;
      try {
      _ran = await _withEconLock(async () => {
      try {
        const pkg = _GRAM_SHOP_PKGS.find(p => p.id === pkgId);
        if (!pkg) return socket.emit('gramShopError', { msg: 'Пакет не найден' });
        // One per account — it's a status flag, not a stackable consumable, so
        // a second purchase would just spend GRAM for no additional effect.
        // socket.data.seasonTicketActive is already loaded at login and kept
        // live on every successful purchase (same/cross-session alike), so
        // this needs no extra DB read.
        if (pkg.seasonTicket && socket.data.seasonTicketActive) {
          return socket.emit('gramShopError', { msg: 'Сезонный билет уже куплен' });
        }
        // petChoice packages need a valid pick of the right rarity BEFORE any
        // GRAM is spent — refusing here (rather than after the deduction) means
        // a missing/invalid choice never costs the player anything.
        let _chosenPet = null;
        if (pkg.petChoice) {
          _chosenPet = ITEM_DEF.find(d => d.id === petId && d.slot === 'pet' && d.rarity === pkg.petChoice);
          if (!_chosenPet) return socket.emit('gramShopError', { msg: 'Выберите питомца' });
        }
        const _price = pkgPrice(pkg);
        if (_liveGram() < _price) return socket.emit('gramShopError', { msg: 'Недостаточно GRAM' });

        const doc = await PlayerModel.findById(s.authed._id);
        if (!doc) return;
        // Drop earnings first, so the price is tested against everything the
        // player has actually earned.
        await _flushBalances();
        const saved = doc.savedData || {};
        const charClass = saved.type || 'lev';
        const wepMap = _SHOP_CLASS_WEAPONS[charClass] || _SHOP_CLASS_WEAPONS.lev;
        // Live copy first — a fresh DB read here is up to ~3s behind (the
        // saveProgress debounce), so building the purchase on it rolled back
        // anything picked up in that window.
        const _liveInv = _liveInventory();
        // Entries are CLONED, not just the array. A shallow [...inv] shares every
        // item object with the live inventory, so the `existing.qty += n` merges
        // below were landing in s.lastStats immediately — including on the paths
        // that then bail out with "nothing was consumed" (claimVipRewards'
        // outOfRoom refusal), which left a grant half-applied to a purchase that
        // never happened. Cloning keeps this a scratch copy until it is committed.
        const inv = _liveInv ? _liveInv.map(i => (i && typeof i === 'object' ? { ...i } : i))
          : (Array.isArray(saved.inventory) ? saved.inventory.map(i => (i && typeof i === 'object' ? { ...i } : i)) : []);

        // Room check before anything is deducted. This used to push items in
        // unconditionally, which is how accounts ended up over the 150-slot cap
        // the client enforces — and once over it, invHasSpace() is false forever:
        // drops stop being picked up and every market cancellation destroys its
        // item. Stackables that merge into an existing entry cost no new slot.
        const _newSlots = _shopNewSlots(pkg, inv, charClass);
        if (inv.length + _newSlots > SERVER_INV_MAX) {
          logPlayer(s.authed.telegramId, s.authed.username, 'gram_shop_refused',
            { pkg: pkg.id, need: _newSlots, slots: `${inv.length}/${SERVER_INV_MAX}` });
          return socket.emit('gramShopError', {
            msg: `Нужно ${_newSlots} свободных мест в инвентаре (занято ${inv.length}/${SERVER_INV_MAX})`,
          });
        }

        // The deduction is the affordability check — _spendBalance writes only
        // if the stored balance covers the price (see the balance block at the
        // top of this file), so nothing here can spend GRAM the account doesn't
        // have, whatever the cached figure said a moment ago.
        const _paid = await _spendBalance(s.authed.telegramId, 'gramBalance', _price);
        if (_paid === null) return socket.emit('gramShopError', { msg: 'Недостаточно GRAM' });
        s.gramBalance = _paid;

        // Season points — every GRAM shop purchase counts (packages, pets, the
        // season ticket, ...), scaled by what was actually paid. Not the
        // player-to-player market (marketBuy carries no season award). Direct
        // $inc on s.authed.telegramId, so this is correct whether or not this
        // socket is the account's live session — no need to special-case the
        // cross-session branch below.
        const _seasonShopPts = seasonShopPoints(_price);
        if (_seasonShopPts > 0 && seasonActive()) {
          _seasonAddPoints(_seasonShopPts, 'shop_buy', { pkg: pkg.id, price: _price })
            .then(total => { if (total !== null) socket.emit('seasonEventDone', { task: 'shop_buy', points: _seasonShopPts, total }); });
        }

        // Gold. Defaulted rather than added raw: the season packages carry no
        // gold at all, and `x + undefined` is NaN — which _sanitizeSavedStats
        // then clamps to 0, i.e. buying a stone pack would have wiped the
        // buyer's gold. Same reasoning for the potion count below.
        saved.gold = (saved.gold || 0) + (pkg.gold || 0);

        // Parallel record of every item this purchase grants, as plain
        // {item, qty} deltas — used only if the account turns out to have
        // reconnected on a different socket by the time we're ready to commit
        // (see the cross-session branch below). Kept alongside the existing
        // inv.push/qty+= mutations rather than replacing them, so the normal
        // same-socket path is untouched.
        const _addedItems = [];

        // Buff potions (bp_hp/bp_exp/... — ITEM_DEF slot 'buff_potion') are
        // stackable inventory items, not potionBag entries. potionBag only
        // holds pt1/pt2 HP potions; useBuffPotion() (player.js) looks these up
        // via removeFromInventory() against player.inventory, so writing them
        // into potionBag instead — as this used to — meant they were paid for
        // and deducted but never actually reachable anywhere in the UI.
        if (pkg.potions > 0) _VIP_BP.forEach(bp => {
          const existing = inv.find(i => i.id === bp.id);
          if (existing) existing.qty = (existing.qty || 1) + pkg.potions;
          else inv.push({ ...bp, qty: pkg.potions });
          _addedItems.push({ item: bp, qty: pkg.potions });
        });

        // Armor set
        if (pkg.armor) {
          (_SHOP_ARMOR_SETS[pkg.armor] || []).forEach(id => {
            const base = ITEM_DEF.find(d => d.id === id);
            if (base) { inv.push({ ...base, enhance: pkg.enhance || 0 }); _addedItems.push({ item: { ...base, enhance: pkg.enhance || 0 } }); }
          });
        }

        // Class weapon
        if (pkg.weapon) {
          const wepId = wepMap[pkg.weapon];
          const base = ITEM_DEF.find(d => d.id === wepId);
          if (base) { inv.push({ ...base, enhance: pkg.enhance || 0 }); _addedItems.push({ item: { ...base, enhance: pkg.enhance || 0 } }); }
        }

        // Специальная акция: class-locked artifact/cloak (every entry in
        // ITEM_DEF for these two slots has a forClass, there is no generic
        // version) and, for the buyer's own choice, a specific pet — chosen and
        // validated (_chosenPet) before any GRAM was spent, above. All three
        // take the same pkg.enhance the armor/weapon grants above do (pet/
        // cloak/artifact are all in ENHANCEABLE_SLOTS, shared/definitions.js)
        // — was hardcoded to 0 back when no package used these fields at all.
        if (pkg.classArtifact) {
          const base = ITEM_DEF.find(d => d.slot === 'artifact' && d.rarity === pkg.classArtifact && d.forClass && d.forClass.includes(charClass));
          if (base) { inv.push({ ...base, enhance: pkg.enhance || 0 }); _addedItems.push({ item: { ...base, enhance: pkg.enhance || 0 } }); }
        }
        if (pkg.classCloak) {
          const base = ITEM_DEF.find(d => d.slot === 'cloak' && d.rarity === pkg.classCloak && d.forClass && d.forClass.includes(charClass));
          if (base) { inv.push({ ...base, enhance: pkg.enhance || 0 }); _addedItems.push({ item: { ...base, enhance: pkg.enhance || 0 } }); }
        }
        if (_chosenPet) {
          inv.push({ ..._chosenPet, enhance: pkg.enhance || 0 });
          _addedItems.push({ item: { ..._chosenPet, enhance: pkg.enhance || 0 } });
        }

        // Skill books — for the buyer's own class only (see charClass above)
        if (pkg.skillBooks) {
          const classBooks = CRAFT_MATS.filter(m => m.forClass === charClass && m.skillKey);
          const _addBook = (book, qty) => {
            const existing = inv.find(i => i.id === book.id);
            if (existing) existing.qty = (existing.qty || 1) + qty;
            else inv.push({ ...book, qty });
            _addedItems.push({ item: book, qty });
          };
          if (pkg.skillBooks.each) {
            classBooks.forEach(book => _addBook(book, pkg.skillBooks.each));
          } else if (pkg.skillBooks.random && classBooks.length) {
            for (let i = 0; i < pkg.skillBooks.random; i++) {
              _addBook(classBooks[Math.floor(Math.random() * classBooks.length)], 1);
            }
          }
        }

        // Boxes (BOX_DEF — opened via the forge for random-rarity gear)
        if (pkg.boxes) {
          Object.entries(pkg.boxes).forEach(([boxId, qty]) => {
            const base = BOX_DEF.find(b => b.id === boxId);
            if (!base) return;
            const existing = inv.find(i => i.id === boxId);
            if (existing) existing.qty = (existing.qty || 1) + qty;
            else inv.push({ ...base, qty });
            _addedItems.push({ item: base, qty });
          });
        }

        // Enhance stones (сезонные паки). _STONE_DEFS is the same catalog the
        // loot roll grants them from, so a bought stone is identical to a
        // dropped one.
        if (pkg.stones) {
          Object.entries(pkg.stones).forEach(([sid, qty]) => {
            const base = _STONE_DEFS[sid] || CRAFT_MATS.find(m => m.id === sid);
            if (!base) return;
            const existing = inv.find(i => i.id === sid);
            if (existing) existing.qty = (existing.qty || 1) + qty;
            else inv.push({ ...base, qty });
            _addedItems.push({ item: base, qty });
          });
        }

        // Bonus skill points
        if (pkg.bonusSP > 0) saved.bonusSP = (saved.bonusSP || 0) + pkg.bonusSP;

        // Сезонный билет — no item, just a status flag: server/index.js's
        // combat-reward math (VIP_BONUSES' own xp/drop bonus, plus the Liberty
        // drop roll) reads socket.data.seasonTicketActive directly, gated by
        // seasonActive(). Persisted below the same targeted way vipLevel is.
        if (pkg.seasonTicket) saved.seasonTicket = true;

        // Liberty (Nexum) bonus — atomic, like every other balance move.
        if (pkg.nexum > 0) {
          const _nb = await _incBalance(s.authed.telegramId, 'nexumBalance', pkg.nexum);
          if (_nb !== null) s.nexumBalance = _nb;
        }

        // VIP progress from purchase
        let _vipLvl = saved.vipLevel || 0;
        let _vipDep = saved.vipDeposited || 0;
        const _vipPend = Array.isArray(saved.vipPending) ? [...saved.vipPending] : [];
        const _prevVipLvl = _vipLvl;
        if (_vipLvl < 10) {
          _vipDep += _price;
          while (_vipLvl < 10 && _vipDep >= VIP_THRESHOLDS[_vipLvl + 1]) {
            _vipDep -= VIP_THRESHOLDS[_vipLvl + 1];
            _vipLvl++;
            _vipPend.push(_vipLvl);
          }
          saved.vipLevel = _vipLvl;
          saved.vipDeposited = _vipDep;
          saved.vipPending = _vipPend;
        }

        // Cross-session guard: this handler holds across several awaits
        // (findById, _flushBalances, _spendBalance, an optional nexum grant)
        // before it gets here, and `inv` above was built as a snapshot copy —
        // committing it straight into THIS closure's s.lastStats would write it
        // into whichever session is stale if the account reconnected on a
        // different socket in the meantime. Delegate the grant as a delta
        // (items/gold/bonusSP/VIP) against whichever socket is live now,
        // instead of committing the whole reconstructed inv.
        if (activeSessions.get(s.authed.telegramId) !== socket.id) {
          const _target = _socketForTelegramId(s.authed.telegramId);
          const _result = _target && _target.data._applyGrant
            ? _target.data._applyGrant({
                addItems: _addedItems, goldDelta: pkg.gold || 0, bonusSPDelta: pkg.bonusSP || 0, vipGramDelta: _price,
                seasonTicket: !!pkg.seasonTicket,
              }, 'gram_shop_cross_session', { pkg: pkg.id, gram: pkg.gram })
            : null;
          if (!_result) {
            await PlayerModel.updateOne({ _id: doc._id }, {
              $push: { 'savedData.inventory': { $each: _addedItems.map(({ item, qty }) => ({ ...item, ...(qty != null ? { qty } : {}) })) } },
              $inc: { 'savedData.gold': pkg.gold || 0, ...(pkg.bonusSP > 0 ? { 'savedData.bonusSP': pkg.bonusSP } : {}) },
              ...(pkg.seasonTicket ? { $set: { 'savedData.seasonTicket': true } } : {}),
            }).catch(() => {});
          }
          logPlayer(s.authed.telegramId, s.authed.username, 'gram_shop_cross_session',
            { pkg: pkg.id, gram: pkg.gram, delivered: !!_result, hadLiveSocket: !!_target });
          const _newInv = _target && _target.data._adminReadItems ? _target.data._adminReadItems().inventory : inv;
          const _res = _result || { gold: saved.gold, bonusSP: saved.bonusSP || 0, vipLevel: _vipLvl, vipDeposited: _vipDep, vipPending: _vipPend };
          if (_target) {
            _target.emit('gramShopResult', {
              pkgId, newBalance: s.gramBalance, newGold: _res.gold, newInventory: _newInv,
              newBonusSP: _res.bonusSP, newNexumBalance: s.nexumBalance,
              vipData: { level: _res.vipLevel, deposited: _res.vipDeposited, pending: _res.vipPending },
              leveled: _res.vipLevel > _prevVipLvl,
            });
            if (_res.vipLevel > _prevVipLvl) {
              _target.emit('vipUpdate', { level: _res.vipLevel, deposited: _res.vipDeposited, pending: _res.vipPending });
            }
          }
          io.to(`tg_${s.authed.telegramId}`).emit('gramBalanceUpdate', { balance: s.gramBalance });
          return;
        }

        saved.inventory = inv;
        // Targeted $set on exactly the fields this purchase touched, instead of
        // a full-document save from the doc fetched at the top of this handler
        // — that snapshot can already be stale by the time this lands (this
        // account's own gameplay autosave landing in between), and overwriting
        // the whole savedData blob with it would silently revert whatever else
        // changed (equipment, hp, position...) in that window.
        // No balance fields here: both were already moved with $inc above, and
        // writing an absolute would undo anything that landed in between.
        const _shopSet = {
          'savedData.gold': saved.gold,
          'savedData.inventory': inv,
          'savedData.vipLevel': _vipLvl,
          'savedData.vipDeposited': _vipDep,
          'savedData.vipPending': _vipPend,
        };
        if (pkg.bonusSP > 0) _shopSet['savedData.bonusSP'] = saved.bonusSP;
        if (pkg.seasonTicket) _shopSet['savedData.seasonTicket'] = true;
        await PlayerModel.updateOne({ _id: doc._id }, { $set: _shopSet });

        if (s.lastStats) {
          s.lastStats.gold = saved.gold;
              if (pkg.bonusSP > 0) s.lastStats.bonusSP = saved.bonusSP;
        }
        // Bumps the revision, so a client autosave queued before this purchase
        // can no longer land afterwards and wipe the items out.
        _commitServerItems(inv, null, 'gram_shop', { pkg: pkg.id, gram: pkg.gram });
        socket.data.vipLevel = _vipLvl;
        if (pkg.seasonTicket) socket.data.seasonTicketActive = true;
        _setVipAura(s.authed.username, _vipLvl);

        socket.emit('gramShopResult', {
          pkgId,
          newBalance:  s.gramBalance,
          newGold:     saved.gold,
          newInventory: inv,
          newBonusSP:  saved.bonusSP || 0,
          newNexumBalance: s.nexumBalance,
          vipData: { level: _vipLvl, deposited: _vipDep, pending: _vipPend },
          leveled: _vipLvl > _prevVipLvl,
        });
        io.to(`tg_${s.authed.telegramId}`).emit('gramBalanceUpdate', { balance: s.gramBalance });
        if (_vipLvl > _prevVipLvl) {
          socket.emit('vipUpdate', { level: _vipLvl, deposited: _vipDep, pending: _vipPend });
        }
      } catch (err) {
        console.error('gramShopBuy:', err);
        logPlayerErr(s.authed.telegramId, s.authed.username, 'gram_shop', err, { pkgId });
      }
      });
      } finally {
        s.itemOpBusy--;
      }
      if (!_ran) socket.emit('gramShopError', { msg: 'Покупка уже обрабатывается' });
    });
};
