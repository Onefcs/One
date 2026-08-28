'use strict';
// items: the safeOn handlers moved out of server/index.js verbatim, with
// the closure helpers only this domain used.
//
// Per-connection, so this takes the session object rather than the plain deps
// bag the server/game/*.js factories use — see server/handlers/market.js for
// the reasoning. `s.*` is every piece of connection state index.js reassigns
// after this module is wired; everything stable is destructured below under
// its original name, which is what keeps the moved bodies byte-identical.
module.exports = function registerItems(s, safeOn, deps) {
  const {
    CRAFT_MATS, FLOOR_IDS, ITEM_DEF, MERCHANT_SHOP, POTION_CAP,
    SERVER_INV_MAX, TELEPORT_CAST_MS, TELEPORT_STONE_PRICE, _HP_POTION_HEAL,
    _HP_POTION_IDS, _catalogBase, _incBalance, _invAdd, _invHasRoomFor,
    _invRemove, _isStackable, _persistSavedFields, _socketForTelegramId,
    _spendBalance, _teleportCastFrozen, _teleportCasting, activeSessions,
    codexItemMeetsReq, codexSetById, codexTotalBonus, isStackableItem,
    logPlayer, logPlayerErr,
  } = deps;

  const {
    _ITEMS_BUSY_MSG, _commitServerItems, _currentQuest, _doEnterLocation,
    _flushBalances, _goldNow, _itemErr, _itemsBusy, _liveInventory,
    _questBump, _questPush, _resolveInvIdx, _withEconLock, socket,
  } = s;

    // Drinking a buff potion. Client-side until now: it removed the item and
    // wrote the timer into its own save. That was already an item write the
    // census had to cover, and it became load-bearing the moment gold and XP
    // started reading buffs.gold / buffs.exp to apply the x2 — a save claiming a
    // permanently active gold buff would have doubled every payout for good.
    //
    // The timer still ticks down on the client (js/game.js) for the HUD; what
    // matters here is that the server holds its own copy and only ever sets it
    // from a potion it watched being consumed.
    safeOn('useBuffPotion', ({ id } = {}) => {
      if (!s.authed || !_itemsFor()) return;
      if (_itemsBusy()) return _itemErr(_ITEMS_BUSY_MSG);
      const def = ITEM_DEF.find(d => d.id === id);
      if (!def || def.slot !== 'buff_potion' || !def.buffType) return;
      if (!s.lastStats.buffs || typeof s.lastStats.buffs !== 'object') s.lastStats.buffs = {};
      if ((s.lastStats.buffs[def.buffType] || 0) > 0) return _itemErr('Уже активно!');
      const inv = s.lastStats.inventory;
      const beforeLen = inv.length;
      if (!_invRemove(inv, { id, qty: 1, slot: def.slot })) return _itemErr('Нет зелья');
      s.lastStats.buffs[def.buffType] = def.buffDur || 1800;
      _persistSavedFields(s.authed, { buffs: s.lastStats.buffs });
      _commitServerItems(inv, null, 'buff_potion', { id }, { beforeLen });
      logPlayer(s.authed.telegramId, s.authed.username, 'buff_potion', { id, type: def.buffType });
      socket.emit('buffSync', { buffs: s.lastStats.buffs });
    });

    // ── Using a teleport stone (bought from the merchant, see buyTeleportStone
    // above) ─────────────────────────────────────────────────────────────────
    // Always recalls to the hub, after a TELEPORT_CAST_MS channel during which
    // the player is held still — _teleportCasting (module-level, above) is
    // what _pvpFrozen reads to enforce that, so movement/attacks are already
    // refused everywhere else in this file without a change to those handlers.
    // The stone is spent the instant the cast starts (not on completion): a
    // successful cast is the one thing this handler can guarantee, and gating
    // the spend on the setTimeout below firing would let a second tap start a
    // free second cast in the same window if the first stone hadn't been
    // deducted yet.
    safeOn('useTeleportStone', () => {
      if (!s.authed || !_itemsFor()) return;
      if (_itemsBusy()) return _itemErr(_ITEMS_BUSY_MSG);
      if (_teleportCastFrozen(socket.id)) return _itemErr('Уже произносится телепорт');
      if (s.currentFloor === FLOOR_IDS.hub) return _itemErr('Вы уже в зале');
      const inv = s.lastStats.inventory;
      const beforeLen = inv.length;
      if (!_invRemove(inv, { id: 'teleport_stone', qty: 1, slot: 'material' })) {
        return _itemErr('Нет камня телепортации');
      }
      _commitServerItems(inv, null, 'teleport_stone_use', {}, { beforeLen });
      logPlayer(s.authed.telegramId, s.authed.username, 'teleport_stone_use', {});

      _teleportCasting.set(socket.id, Date.now() + TELEPORT_CAST_MS);
      socket.emit('teleportCastStarted', { ms: TELEPORT_CAST_MS });

      if (s.teleportCastTimer) clearTimeout(s.teleportCastTimer);
      s.teleportCastTimer = setTimeout(() => {
        s.teleportCastTimer = null;
        _teleportCasting.delete(socket.id);
        if (!s.authed || !s.currentRoom) return; // disconnected mid-cast
        _doEnterLocation('hub');
      }, TELEPORT_CAST_MS);
    });

    // Merchant: the only shop priced in gold. MERCHANT_SHOP and POTION_CAP are
    // shared (shared/definitions.js) precisely so the price charged here is the
    // one the button showed.
    safeOn('buyPotion', ({ idx, qty } = {}) => {
      if (!s.authed || !s.lastStats) return;
      const entry = MERCHANT_SHOP[Math.floor(Number(idx))];
      if (!entry) return;
      const n = Math.max(1, Math.min(POTION_CAP, Math.floor(Number(qty)) || 1));
      if (!s.lastStats.potionBag || typeof s.lastStats.potionBag !== 'object') s.lastStats.potionBag = {};
      const cur = Math.max(0, Math.floor(Number(s.lastStats.potionBag[entry.itemId])) || 0);
      if (cur + n > POTION_CAP) return socket.emit('goldError', { msg: `Максимум ${POTION_CAP} зелий!` });
      const cost = entry.price * n;
      if (_goldNow() < cost) return socket.emit('goldError', { msg: 'Мало золота!' });
      s.lastStats.gold = _goldNow() - cost;
      s.lastStats.potionBag[entry.itemId] = cur + n;
      _persistSavedFields(s.authed, { gold: s.lastStats.gold, potionBag: s.lastStats.potionBag });
      logPlayer(s.authed.telegramId, s.authed.username, 'buy_potion', { id: entry.itemId, n, cost });
      socket.emit('goldSync', { gold: s.lastStats.gold });
      socket.emit('potionBag', { potionBag: s.lastStats.potionBag, bought: { id: entry.itemId, n } });
      // buy_potion quests count purchases, and this is the only place one happens.
      if (_currentQuest() && _currentQuest().type === 'buy_potion') { _questBump('_potion', n); _questPush(); }
    });

    // ── Buying teleport stones from the merchant (Liberty/Nexum) ───────────────
    // The one merchant purchase NOT priced in gold — Liberty is
    // server-authoritative only (see resetUpgrades/craftPet above for why), so
    // unlike buyPotion the charge and the grant both have to happen here rather
    // than trusting a client-side gold deduction. Mirrors craftPet's shape: an
    // atomic balance spend, then a deterministic item grant (no roll — a
    // purchase always delivers exactly the stones paid for).
    safeOn('buyTeleportStone', async ({ qty } = {}) => {
      if (!s.authed) return;
      const n = Math.max(1, Math.min(99, Math.floor(Number(qty)) || 1));
      s.itemOpBusy++;
      let _ran;
      try {
      // Serialized like craftPet/resetUpgrades — the spend below is a DB round
      // trip, and two purchases overlapping across it would interleave their
      // inventory writes.
      _ran = await _withEconLock(async () => {
      try {
        if (!s.lastStats || !Array.isArray(s.lastStats.inventory)) {
          return socket.emit('teleportStoneError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
        }
        const mat = CRAFT_MATS.find(m => m.id === 'teleport_stone');
        if (!mat) return;
        if (!_invHasRoomFor(s.lastStats.inventory, mat)) {
          return socket.emit('teleportStoneError', { msg: 'Инвентарь полон' });
        }
        const cost = TELEPORT_STONE_PRICE * n;

        // Atomic charge — the grant below only happens if the Liberty was
        // really taken, same reasoning as every other Liberty spend in this file.
        await _flushBalances();
        const _bal = await _spendBalance(s.authed.telegramId, 'nexumBalance', cost, 'teleport_stone_buy');
        if (_bal === null) return socket.emit('teleportStoneError', { msg: `Нужно ${cost} Liberty` });
        s.nexumBalance = _bal;

        // Cross-session guard, same as craftPet's own: the spend above is a DB
        // round trip, and the account may have reconnected on a different
        // socket by the time it resolves.
        if (activeSessions.get(s.authed.telegramId) !== socket.id) {
          const _target = _socketForTelegramId(s.authed.telegramId);
          if (!_target || !_target.data._applyGrant) {
            // Nothing live to grant into. Refund rather than charge for stones
            // that cannot be delivered.
            const back = await _incBalance(s.authed.telegramId, 'nexumBalance', cost, 'teleport_stone_refund');
            if (back !== null) s.nexumBalance = back;
            return socket.emit('teleportStoneError', { msg: 'Сессия недоступна — попробуйте ещё раз' });
          }
          const _res = _target.data._applyGrant(
            { addItems: [{ item: mat, qty: n }] }, 'teleport_stone_buy_cross_session', { qty: n, cost });
          _target.emit('teleportStoneBought', { qty: n, newNexumBalance: s.nexumBalance, delivered: !!_res });
          return;
        }

        const _beforeLen = s.lastStats.inventory.length;
        const _delivered = _invAdd(s.lastStats.inventory, { ...mat, qty: n });
        _commitServerItems(s.lastStats.inventory, null, 'teleport_stone_buy', { qty: n, cost }, { beforeLen: _beforeLen });
        logPlayer(s.authed.telegramId, s.authed.username, 'teleport_stone_buy', { qty: n, cost });
        socket.emit('teleportStoneBought', { qty: n, newNexumBalance: s.nexumBalance, delivered: _delivered });
      } catch (err) {
        console.error('buyTeleportStone:', err);
        logPlayerErr(s.authed.telegramId, s.authed.username, 'teleport_stone_buy', err, { qty: n });
        socket.emit('teleportStoneError', { msg: 'Ошибка сервера' });
      }
      });
      } finally {
        s.itemOpBusy--;
      }
      if (!_ran) socket.emit('teleportStoneError', { msg: 'Секунду, идёт другая операция — повторите' });
    });

    // ── Item placement (equip, unequip, storage) ──────────────────────────────
    // The last four item operations the CLIENT still decided for itself. Loot,
    // sales, crafts, enhancing, boxes, market and potions were already server
    // side; these four moved an item between inventory, an equipment slot and
    // the storage chest by editing the local arrays and letting the next
    // debounced save carry the result.
    //
    // That is what the whole item-census machinery exists to police: because a
    // save could rewrite the item set, the server had to work out afterwards
    // whether the rewrite was legitimate. Moving them here removes the writer,
    // and with it the need to police it — a move is now a request the server
    // performs on its own copy, and answers with inventorySync.
    //
    // Nothing here can create or destroy an item: each one takes it out of one
    // container and puts it in another, refusing when the destination is full.
    const SERVER_STORAGE_MAX = 200;   // matches storageHasSpace() in js/player.js

    function _itemsFor() {
      if (!s.lastStats) return null;
      if (!Array.isArray(s.lastStats.inventory)) s.lastStats.inventory = [];
      if (!Array.isArray(s.lastStats.storage))   s.lastStats.storage = [];
      if (!s.lastStats.equipment || typeof s.lastStats.equipment !== 'object') s.lastStats.equipment = {};
      return s.lastStats;
    }

    safeOn('equipItem', ({ idx } = {}) => {
      if (!s.authed || !_itemsFor()) return;
      if (_itemsBusy()) return _itemErr(_ITEMS_BUSY_MSG);
      const inv = s.lastStats.inventory;
      const i = Math.floor(Number(idx));
      const it = (Number.isInteger(i) && i >= 0) ? inv[i] : null;
      if (!it) return;
      // A stackable or a consumable has no slot to occupy. The client greys
      // these out; that is advice until it is checked here.
      if (_isStackable(it) || it.slot === 'use' || !it.slot) return;
      if (Array.isArray(it.forClass) && s.lastStats.type && !it.forClass.includes(s.lastStats.type)) {
        return _itemErr('Этот предмет не для вашего класса');
      }
      const beforeLen = inv.length;
      const old = s.lastStats.equipment[it.slot] || null;
      s.lastStats.equipment[it.slot] = it;
      inv.splice(i, 1);
      // The displaced item goes back to the slot the new one just freed, so the
      // swap is always net-zero and can never need room it hasn't got.
      if (old) inv.push(old);
      _commitServerItems(inv, s.lastStats.equipment, 'equip', { id: it.id, slot: it.slot }, { beforeLen });
    });

    safeOn('unequipItem', ({ slot } = {}) => {
      if (!s.authed || !_itemsFor()) return;
      if (_itemsBusy()) return _itemErr(_ITEMS_BUSY_MSG);
      const it = s.lastStats.equipment[slot];
      if (!it) return;
      const inv = s.lastStats.inventory;
      if (!_invHasRoomFor(inv, it)) return _itemErr('Инвентарь полон!');
      const beforeLen = inv.length;
      s.lastStats.equipment[slot] = null;
      inv.push(it);
      _commitServerItems(inv, s.lastStats.equipment, 'unequip', { id: it.id, slot }, { beforeLen });
    });

    // { [setId]: boolean[] } — one flag per slot of that set, true once the
    // slot's item has been consumed into it. Sparse: a set the player has never
    // touched simply has no key.
    function _codexFor() {
      if (!s.lastStats) return null;
      if (!s.lastStats.codex || typeof s.lastStats.codex !== 'object' || Array.isArray(s.lastStats.codex)) {
        s.lastStats.codex = {};
      }
      return s.lastStats.codex;
    }

    // Pushes the authoritative codex progress + its resulting stat bonus to the
    // client — same "server decides, client mirrors" shape as _pushProgress.
    function _pushCodex() {
      socket.emit('codexSync', { codex: s.lastStats.codex, bonus: codexTotalBonus(s.lastStats.codex) });
    }

    // Кодекс: наборы предметов. Registering consumes an owned item into ONE
    // specific slot of ONE specific set (see CODEX_SETS, shared/definitions.js)
    // — the same item id can be required by many different sets, and each one
    // needs its own copy, same as a real L2M item collection. Completing every
    // slot in a set folds its flat stat bonus into codexTotalBonus forever,
    // regardless of what's equipped or later sold.
    safeOn('registerCodexSetItem', ({ setId, slotIdx, idx } = {}) => {
      if (!s.authed || !_itemsFor()) return;
      if (_itemsBusy()) return _itemErr(_ITEMS_BUSY_MSG);
      const set = codexSetById(setId);
      if (!set) return;
      const si = Math.floor(Number(slotIdx));
      if (!Number.isInteger(si) || si < 0 || si >= set.slots.length) return;
      const codex = _codexFor();
      let filled = codex[setId];
      if (!Array.isArray(filled) || filled.length !== set.slots.length) filled = set.slots.map(() => false);
      if (filled[si]) return _itemErr('Этот слот набора уже заполнен');
      const inv = s.lastStats.inventory;
      const i = Math.floor(Number(idx));
      const it = (Number.isInteger(i) && i >= 0) ? inv[i] : null;
      if (!it) return;
      if (!codexItemMeetsReq(it, set.slots[si])) return _itemErr('Этот предмет не подходит для выбранного слота набора');
      const beforeLen = inv.length;
      inv.splice(i, 1);
      filled[si] = true;
      codex[setId] = filled;
      _commitServerItems(inv, null, 'codex_register', { setId, slotIdx: si, id: it.id, enhance: it.enhance || 0 }, { beforeLen });
      _persistSavedFields(s.authed, { codex });
      _pushCodex();
    });

    // Inventory -> storage and back. Both are MOVES: the item is spliced out of
    // one array and merged into the other in a single handler, so the two halves
    // can never be observed apart the way they could when a save carried them.
    function _moveBetween(fromArr, toArr, idx, cap) {
      const i = Math.floor(Number(idx));
      const it = (Number.isInteger(i) && i >= 0) ? fromArr[i] : null;
      if (!it) return null;
      if (_isStackable(it)) {
        const existing = toArr.find(e => e && e.id === it.id);
        if (existing) {
          existing.qty = (existing.qty || 1) + (it.qty || 1);
          fromArr.splice(i, 1);
          return it;
        }
      }
      if (toArr.length >= cap) return 'full';
      fromArr.splice(i, 1);
      toArr.push(it);
      return it;
    }

    safeOn('storageDeposit', ({ idx } = {}) => {
      if (!s.authed || !_itemsFor()) return;
      if (_itemsBusy()) return _itemErr(_ITEMS_BUSY_MSG);
      const beforeLen = s.lastStats.inventory.length;
      const res = _moveBetween(s.lastStats.inventory, s.lastStats.storage, idx, SERVER_STORAGE_MAX);
      if (res === 'full') return _itemErr('Хранилище полно!');
      if (!res) return;
      _commitServerItems(s.lastStats.inventory, null, 'storage_in', { id: res.id }, { beforeLen, storage: true });
    });

    safeOn('storageWithdraw', ({ idx } = {}) => {
      if (!s.authed || !_itemsFor()) return;
      if (_itemsBusy()) return _itemErr(_ITEMS_BUSY_MSG);
      const beforeLen = s.lastStats.inventory.length;
      const res = _moveBetween(s.lastStats.storage, s.lastStats.inventory, idx, SERVER_INV_MAX);
      if (res === 'full') return _itemErr('Инвентарь полон!');
      if (!res) return;
      _commitServerItems(s.lastStats.inventory, null, 'storage_out', { id: res.id }, { beforeLen, storage: true });
    });

    // ── Selling a common item to the merchant ─────────────────────────────────
    // Used to be entirely client-side (js/ui.js's sellCommonItem removed the
    // item and added the gold locally, reaching the server only through the
    // next saveProgress). The item half of that was already covered once the
    // save path stopped accepting item growth, but the gold half was a plain
    // faucet — and with the ceiling now bounding gold, a client-side credit
    // would be clamped away and the player would lose the sale. So the whole
    // transaction moves here.
    const SELL_COMMON_PRICE = 100;

    safeOn('sellItem', async ({ idx, id, enhance } = {}) => {
      if (!s.authed) return;
      const _ran = await _withEconLock(async () => {
        try {
          const inv = _liveInventory();
          if (!inv) return socket.emit('sellItemError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
          const _beforeLen = inv.length;
          // By identity rather than by raw index — see _resolveInvIdx. The
          // rarity check below already stopped this selling anything but a
          // common, but "a common, just not the one tapped" was still possible
          // while the two copies were briefly renumbered differently.
          const i = _resolveInvIdx(inv, idx, id, enhance);
          if (i < 0) {
            socket.emit('inventorySync', {
              inventory: inv, equipment: s.lastStats.equipment || {},
            });
            logPlayer(s.authed.telegramId, s.authed.username, 'sell_desync', { idx, id, enhance });
            return socket.emit('sellItemError', { msg: 'Предмет не найден — список обновлён' });
          }
          const it = inv[i];
          if (!it) return;
          // Re-derived from the catalog rather than read off the entry, so the
          // price can't be unlocked for a rarity that isn't actually sellable.
          const base = _catalogBase(it.id);
          if (!base || base.rarity !== 'common' || isStackableItem(base)) {
            return socket.emit('sellItemError', { msg: 'Этот предмет нельзя продать' });
          }
          inv.splice(i, 1);
          if (!s.lastStats) s.lastStats = {};
          s.lastStats.gold = Math.max(0, (s.lastStats.gold || 0) + SELL_COMMON_PRICE);
              _commitServerItems(inv, null, 'sell_common', { itemId: it.id, gold: SELL_COMMON_PRICE }, { beforeLen: _beforeLen });
          await _persistSavedFields(s.authed, { gold: s.lastStats.gold });
          socket.emit('itemSold', { gold: SELL_COMMON_PRICE, newGold: s.lastStats.gold });
        } catch (err) {
          console.error('sellItem:', err);
          logPlayerErr(s.authed.telegramId, s.authed.username, 'sell_common', err, { idx });
          socket.emit('sellItemError', { msg: 'Ошибка сервера' });
        }
      });
      if (!_ran) socket.emit('sellItemError', { msg: _ITEMS_BUSY_MSG });
    });

    // where s.lastStats — the server's own inventory copy — lives; same pattern
    // as the market, so a dropped worldDropTaken event or a disconnect mid-
    // pickup can't lose the item.
    safeOn('pickupWorldDrop', ({ id } = {}) => {
      if (!s.authed || !id || !s.currentRoom) return;
      const p = s.currentRoom.players.get(socket.id);
      if (!p || p.hp <= 0) return;
      // Left on the floor rather than claimed: a clone-and-commit handler
      // (gramShopBuy/specialShopBuy/claimVipRewards) holding a stale inventory
      // snapshot would silently erase this pickup the moment it commits — see
      // _itemsBusy. The drop stays put for the brief window that takes, same
      // as the room-full refusal below.
      if (_itemsBusy()) return socket.emit('worldDropError', { msg: _ITEMS_BUSY_MSG });
      const inv = (s.lastStats && Array.isArray(s.lastStats.inventory)) ? s.lastStats.inventory : null;
      // Peek at the pile first: a full inventory must be rejected BEFORE the
      // claim consumes it, otherwise the item is destroyed instead of staying
      // on the floor for someone else — same ordering as the market's buy path.
      const peek = s.currentRoom.worldDrops.get(id);
      if (!peek) return;
      // Exactly the condition _invAdd would refuse on, checked BEFORE the claim
      // consumes the pile: a stackable only rides in for free when a stack of
      // it already exists, so one with no existing stack needs a slot just like
      // a non-stackable does. Testing only the non-stackable case (as this used
      // to) meant a stackable drop landing on a full inventory was claimed off
      // the floor and then dropped on the way in — destroyed rather than left
      // for someone else. The client used to paper over that by adding it
      // locally on delivered:false, which is precisely the kind of client-side
      // grant the save path no longer accepts.
      //
      // A session with no inventory loaded at all (no selectChar yet) is
      // refused for the same reason rather than being let through: the `inv &&`
      // in front of the old check skipped it, so claimWorldDrop below consumed
      // the pile off the floor — removing it for everyone — and then had
      // nowhere to put it. Leaving the drop where it is costs nothing; there is
      // no second chance once it's claimed.
      if (!inv) return socket.emit('worldDropError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
      if (!_invHasRoomFor(inv, peek.item)) {
        return socket.emit('worldDropError', { msg: 'Инвентарь полон' });
      }
      const drop = s.currentRoom.claimWorldDrop(id, p.x, p.y);
      if (!drop) return;
      const _beforeLen = inv.length;
      const _delivered = _invAdd(inv, drop.item);
      if (_delivered) {
        _commitServerItems(inv, null, 'world_drop', { item: drop.item && drop.item.id }, { beforeLen: _beforeLen });
      } else {
        // Unreachable via the check above; logged rather than silent so that if
        // it ever does happen there is a record naming the item.
        logPlayer(s.authed.telegramId, s.authed.username, 'world_drop_noroom',
          { item: drop.item && drop.item.id, slots: inv.length });
      }
      socket.emit('worldDropPicked', { id: drop.id, item: drop.item, delivered: _delivered });
    });

    // ── HP potion ─────────────────────────────────────────────────────────────
    // `amount` is validated as a real number before it goes anywhere near hp.
    // Math.min('x', 200) is NaN, and NaN assigned to hp is permanent: every
    // damage path writes Math.max(0, NaN - dmg) === NaN back, and `hp <= 0` is
    // false for NaN — so one malformed packet made a player unkillable until
    // respawn, which is worth real money in the death battle/arena/tower.
    //
    // That validation was the whole of it, and it wasn't enough. healPlayer
    // (Room.js) is deliberately NOT gated by MAX_HP_REGEN_PER_SEC — the rate
    // limit that stops a client simply reporting full hp on every movement
    // packet — because real heals are supposed to arrive through here. So this
    // event was a full-heal button with no cooldown, no cost and no proof the
    // player owned a potion, sitting in the loose rate-limit bucket (1500 per
    // 5s). Spamming it made a character unkillable in exactly the modes that
    // pay out real GRAM/Liberty.
    //
    // Three things close it, all server-side:
    //   • POTION_CD_MS, mirroring the client's own 4s potCd with a little slack
    //     for latency — a legitimate client can never exceed it;
    //   • the potion is spent from the server's own copy of potionBag (now
    //     sanitized to real ids and sane counts — see _sanitizeSavedStats);
    //   • the heal is the catalog's value for THAT potion, not a number the
    //     packet chose.
    // `amount` is still accepted and still clamped, but only as the fallback
    // for a client from before this change that sends nothing else — a tab left
    // open across the deploy keeps working instead of losing its potions.
    const POTION_CD_MS = 3500;

    let _lastPotionAt = 0;

    safeOn('usePotion', ({ id, amount } = {}) => {
      if (!s.currentRoom) return;
      const now = Date.now();
      if (now - _lastPotionAt < POTION_CD_MS) return;
      const potId = _HP_POTION_IDS.includes(id) ? id
        : (s.lastStats && _HP_POTION_IDS.includes(s.lastStats.hudPotion) ? s.lastStats.hudPotion : _HP_POTION_IDS[0]);
      const bag = (s.lastStats && s.lastStats.potionBag && typeof s.lastStats.potionBag === 'object')
        ? s.lastStats.potionBag : null;
      // No server-side bag yet (a session that hasn't sent a save since the
      // sanitizer started producing one) — fall back to the old behaviour so
      // nobody is left unable to drink, but the cooldown above still applies.
      if (bag) {
        if (!(bag[potId] > 0)) return socket.emit('potionEmpty', { id: potId });
        bag[potId] -= 1;
      }
      _lastPotionAt = now;
      const _catalogHeal = _HP_POTION_HEAL.get(potId);
      const n = Number(amount);
      const heal = Number.isFinite(_catalogHeal) && _catalogHeal > 0
        ? _catalogHeal
        : (Number.isFinite(n) ? Math.max(0, Math.min(n, 200)) : 60);
      s.currentRoom.healPlayer(socket.id, heal);
      // Persisted here, and this is not optional any more. It used to ride "the
      // normal progress save, and the client's own copy is what the next save
      // carries anyway" — but potionBag is pinned to the server's copy now, so
      // the client's save carries nothing and the decrement never reached the
      // database. Potions came back after every reconnect. One small $set per
      // potion, against a 3.5s cooldown, is the right price for that.
      if (bag) _persistSavedFields(s.authed, { potionBag: bag });
      socket.emit('potionUsed', { id: potId, heal, left: bag ? bag[potId] : null });
      // The authoritative bag, so the shop and the HUD show what is actually
      // left rather than the client's own guess.
      if (bag) socket.emit('potionBag', { potionBag: bag });
    });
};
