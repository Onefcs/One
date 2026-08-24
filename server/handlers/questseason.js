'use strict';
// questseason: the safeOn handlers moved out of server/index.js verbatim, with
// the closure helpers only this domain used.
//
// Per-connection, so this takes the session object rather than the plain deps
// bag the server/game/*.js factories use — see server/handlers/market.js for
// the reasoning. `s.*` is every piece of connection state index.js reassigns
// after this module is wired; everything stable is destructured below under
// its original name, which is what keeps the moved bodies byte-identical.
module.exports = function registerQuestseason(s, safeOn, deps) {
  const {
    BOX_DEF, CRAFT_MATS, GramTxModel, ITEM_DEF, PVP_HISTORY_KEEP,
    PlayerModel, PvpHistoryModel, QUEST_DEF, SEASON_ADV_BOOK_POINTS,
    SEASON_BOOK_BURN_POINTS, SEASON_BURN_POINTS, SEASON_END_AT,
    SEASON_ENHANCE_GEAR_POINTS, SEASON_ENHANCE_SPECIAL_POINTS,
    SEASON_ENHANCE_SPECIAL_SLOTS, SEASON_PRIZES, SEASON_RATING_MIN_POINTS,
    SEASON_REBIRTH_POINTS, SEASON_REF_LEVEL, SEASON_REF_POINTS,
    SEASON_SHOP_POINTS_PER_GRAM, SEASON_VIP_PRIZE, SERVER_INV_MAX,
    SpecialQuestModel, _catalogBase, _incBalance, _invAdd, _isStackable,
    _persistSavedFields, _ratingClans, _ratingPlayers, _refLink,
    _socketForTelegramId, _vipGoldReward, _vipLevelItems, activeSessions,
    isStackableItem, logPlayer, logPlayerErr, questComplete, seasonActive,
  } = deps;

  const {
    _ITEMS_BUSY_MSG, _commitServerItems, _goldNow, _grantGold, _grantXp,
    _itemErr, _itemsBusy, _liveInventory, _questKills, _resolveInvIdx,
    _seasonAddPoints, _withEconLock, socket,
  } = s;

    function _seasonPublicState() {
      return {
        endAt: SEASON_END_AT,
        active: seasonActive(),
        points: s.seasonPoints,
        minRatingPoints: SEASON_RATING_MIN_POINTS,
        prizes: SEASON_PRIZES,
        vipPrize: SEASON_VIP_PRIZE,
        enhanceSpecialSlots: [...SEASON_ENHANCE_SPECIAL_SLOTS],
        enhanceSpecial: SEASON_ENHANCE_SPECIAL_POINTS,
        enhanceGear: SEASON_ENHANCE_GEAR_POINTS,
        advBookPoints: SEASON_ADV_BOOK_POINTS,
        burn: SEASON_BURN_POINTS,
        bookBurnPoints: SEASON_BOOK_BURN_POINTS,
        ref: { points: SEASON_REF_POINTS, level: SEASON_REF_LEVEL },
        rebirthPoints: SEASON_REBIRTH_POINTS,
        shopPointsPerGram: SEASON_SHOP_POINTS_PER_GRAM,
      };
    }

    // Re-reads the running total from the database. Points can now be added by
    // somebody ELSE's session — the referral bonus is paid to the referrer, who
    // may well be online at the time — so the closure copy is no longer the only
    // writer and a stale one would show the panel a number that is too low.
    async function _seasonReloadPoints() {
      if (!s.authed) return s.seasonPoints;
      try {
        const doc = await PlayerModel.findById(s.authed._id, 'savedData.seasonPoints2').lean();
        const total = Math.max(0, Math.floor(Number(doc?.savedData?.seasonPoints2) || 0));
        s.seasonPoints = total;
      } catch (err) { console.error('_seasonReloadPoints:', err); }
      return s.seasonPoints;
    }

    safeOn('seasonSync', async () => {
      if (!s.authed) return;
      await _seasonReloadPoints();
      socket.emit('seasonState', _seasonPublicState());
    });

    // Top 50 by points, plus this player's own rank when they are not in it —
    // same shape (and same reasoning) as the BM rating above. Only players who
    // have cleared SEASON_RATING_MIN_POINTS show up at all — below that, `me`
    // comes back with place 0 rather than a real rank, since there isn't one to
    // show.
    safeOn('seasonRating', async () => {
      if (!s.authed) return;
      try {
        const rows = await PlayerModel.find(
          { 'savedData.seasonPoints2': { $gte: SEASON_RATING_MIN_POINTS } },
          'username savedData.seasonPoints2',
        ).sort({ 'savedData.seasonPoints2': -1 }).limit(50).lean();
        const list = rows.map((p, i) => ({
          place: i + 1, username: p.username,
          points: Math.max(0, Math.floor(Number(p.savedData?.seasonPoints2) || 0)),
        }));
        const mine = s.seasonPoints;
        let myPlace = list.findIndex(r => r.username === s.authed.username) + 1;
        if (!myPlace && mine >= SEASON_RATING_MIN_POINTS) {
          myPlace = await PlayerModel.countDocuments({ 'savedData.seasonPoints2': { $gt: mine } }) + 1;
        }
        socket.emit('seasonRatingData', {
          list, me: { username: s.authed.username, points: mine, place: myPlace || 0 },
          minPoints: SEASON_RATING_MIN_POINTS,
          endAt: SEASON_END_AT, active: seasonActive(), prizes: SEASON_PRIZES, vipPrize: SEASON_VIP_PRIZE,
        });
      } catch (err) { console.error('seasonRating:', err); }
    });

    // ── Сжигание ──────────────────────────────────────────────────────────────
    // Destroys gear outright for points — no gold, no materials back. Only the
    // rarities in SEASON_BURN_POINTS can be burned, and the rarity is re-read
    // from the catalog rather than taken from the entry, so a crafted request
    // cannot claim a common item is worth an uncommon's points.
    function _burnValue(it) {
      const base = it && _catalogBase(it.id);
      if (!base || isStackableItem(base)) return 0;
      return SEASON_BURN_POINTS[base.rarity] || 0;
    }

    safeOn('seasonBurn', async ({ idx, id, enhance } = {}) => {
      if (!s.authed) return;
      // _seasonAddPoints below is an await, and the re-check after it only
      // re-resolves the index WITHIN `inv` — it can't notice `inv` itself going
      // stale. A saveProgress landing in that window replaces s.lastStats (and
      // its inventory array) wholesale; this handler is still holding the OLD
      // array, and the eventual _commitServerItems(inv, ...) would stamp it
      // back over the save's real one, discarding whatever the save legitimately
      // changed. Same hazard s.itemOpBusy already closes for craftGear/etc.
      s.itemOpBusy++;
      let _ran;
      try {
      _ran = await _withEconLock(async () => {
        try {
          if (!seasonActive()) return socket.emit('seasonBurnError', { msg: 'Сезон завершён' });
          const inv = _liveInventory();
          if (!inv) return socket.emit('seasonBurnError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
          const _beforeLen = inv.length;
          // By identity, not by raw index — see _resolveInvIdx. Burning is
          // irreversible, so addressing the wrong slot destroys the wrong item.
          const i = _resolveInvIdx(inv, idx, id, enhance);
          if (i < 0) {
            socket.emit('inventorySync', {
              inventory: inv, equipment: s.lastStats.equipment || {},
            });
            logPlayer(s.authed.telegramId, s.authed.username, 'season_burn_desync', { idx, id, enhance });
            return socket.emit('seasonBurnError', { msg: 'Предмет не найден — список обновлён' });
          }
          const pts = _burnValue(inv[i]);
          if (!pts) return socket.emit('seasonBurnError', { msg: 'Этот предмет нельзя сжечь' });
          const burned = inv[i];
          // Points FIRST. The destruction used to be committed (and persisted)
          // before this await, so a failed points write — a DB blip, an
          // exhausted connection pool — burned the item for nothing. Awarding
          // first means the worst case is points credited for a burn that then
          // didn't happen, which the player can simply redo.
          const total = await _seasonAddPoints(pts, 'burn', { itemId: burned.id, n: 1 });
          if (total === null) {
            return socket.emit('seasonBurnError', { msg: 'Не удалось начислить очки — попробуйте ещё раз' });
          }
          // Re-resolve after the await: the inventory can have moved under us.
          const j = _resolveInvIdx(inv, i, burned.id, burned.enhance);
          if (j < 0) return socket.emit('seasonBurnError', { msg: 'Предмет не найден — список обновлён' });
          inv.splice(j, 1);
          _commitServerItems(inv, null, 'season_burn', { itemId: burned.id, points: pts }, { beforeLen: _beforeLen });
          socket.emit('seasonBurned', { burned: 1, points: pts, total });
        } catch (err) {
          console.error('seasonBurn:', err);
          logPlayerErr(s.authed.telegramId, s.authed.username, 'season_burn', err, { idx });
          socket.emit('seasonBurnError', { msg: 'Ошибка сервера' });
        }
      });
      } finally {
        s.itemOpBusy--;
      }
      if (!_ran) socket.emit('seasonBurnError', { msg: _ITEMS_BUSY_MSG });
    });

    // Bulk form — burning a full inventory one tap at a time is not a real
    // option. Equipped items are untouched: this only ever walks the inventory.
    safeOn('seasonBurnAll', async ({ rarity } = {}) => {
      if (!s.authed) return;
      // Same hazard as seasonBurn above: a saveProgress landing during the
      // _seasonAddPoints await would replace s.lastStats.inventory wholesale,
      // and this handler is still holding the OLD array in `inv` — closing the
      // window with s.itemOpBusy is what makes the "re-checked because the await
      // above is a window" comment below actually complete, rather than only
      // covering moves within the same array.
      s.itemOpBusy++;
      let _ran;
      try {
      _ran = await _withEconLock(async () => {
        try {
          if (!seasonActive()) return socket.emit('seasonBurnError', { msg: 'Сезон завершён' });
          if (!SEASON_BURN_POINTS[rarity]) return socket.emit('seasonBurnError', { msg: 'Эту редкость нельзя сжечь' });
          const inv = _liveInventory();
          if (!inv) return socket.emit('seasonBurnError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
          const _beforeLen = inv.length;
          // Counted first, destroyed only once the points have actually landed —
          // same reasoning as the single burn above, and it matters more here
          // because one call can consume a whole rarity's worth of gear.
          const _victims = [];
          let pts = 0;
          for (let i = inv.length - 1; i >= 0; i--) {
            const it = inv[i];
            const base = it && _catalogBase(it.id);
            if (!base || base.rarity !== rarity) continue;
            const v = _burnValue(it);
            if (!v) continue;
            _victims.push(i); pts += v;
          }
          if (!_victims.length) return socket.emit('seasonBurnError', { msg: 'Нечего сжигать' });
          const total = await _seasonAddPoints(pts, 'burn_all', { rarity, n: _victims.length });
          if (total === null) {
            return socket.emit('seasonBurnError', { msg: 'Не удалось начислить очки — попробуйте ещё раз' });
          }
          // Indices were collected high-to-low, so splicing in that order stays
          // valid. Each one is re-checked because the await above is a window in
          // which the inventory can have changed.
          let burned = 0;
          for (const i of _victims) {
            const it = inv[i];
            const base = it && _catalogBase(it.id);
            if (!base || base.rarity !== rarity) continue;
            inv.splice(i, 1);
            burned++;
          }
          _commitServerItems(inv, null, 'season_burn_all', { rarity, burned, points: pts }, { beforeLen: _beforeLen });
          socket.emit('seasonBurned', { burned, points: pts, total });
        } catch (err) {
          console.error('seasonBurnAll:', err);
          logPlayerErr(s.authed.telegramId, s.authed.username, 'season_burn_all', err, { rarity });
          socket.emit('seasonBurnError', { msg: 'Ошибка сервера' });
        }
      });
      } finally {
        s.itemOpBusy--;
      }
      if (!_ran) socket.emit('seasonBurnError', { msg: _ITEMS_BUSY_MSG });
    });

    // Burning a book (skill / passive / advanced-skill) — a flat rate per copy,
    // regardless of which one. Books are stackable materials, so unlike
    // seasonBurn above this addresses a whole stack by id/qty rather than an
    // index+enhance identity (stackables have no enhance to disambiguate).
    safeOn('seasonBurnBook', async ({ id, qty } = {}) => {
      if (!s.authed) return;
      s.itemOpBusy++;
      let _ran;
      try {
      _ran = await _withEconLock(async () => {
        try {
          if (!seasonActive()) return socket.emit('seasonBurnError', { msg: 'Сезон завершён' });
          const base = id && _catalogBase(id);
          if (!base || !(base.skillKey || base.passiveId || base.advSkillKey)) {
            return socket.emit('seasonBurnError', { msg: 'Эту вещь нельзя сжечь' });
          }
          const inv = _liveInventory();
          if (!inv) return socket.emit('seasonBurnError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
          const _beforeLen = inv.length;
          const idx = inv.findIndex(it => it && it.id === id);
          if (idx < 0) return socket.emit('seasonBurnError', { msg: 'Предмет не найден — список обновлён' });
          const have = inv[idx].qty || 1;
          const n = Math.max(1, Math.min(Math.floor(Number(qty)) || 1, have));
          const pts = n * SEASON_BOOK_BURN_POINTS;
          // Points FIRST — same reasoning as seasonBurn above.
          const total = await _seasonAddPoints(pts, 'burn_book', { itemId: id, n });
          if (total === null) {
            return socket.emit('seasonBurnError', { msg: 'Не удалось начислить очки — попробуйте ещё раз' });
          }
          // Re-resolve after the await: the inventory can have moved under us.
          const j = inv.findIndex(it => it && it.id === id);
          if (j < 0) return socket.emit('seasonBurnError', { msg: 'Предмет не найден — список обновлён' });
          const cur = inv[j].qty || 1;
          if (cur > n) inv[j].qty = cur - n;
          else inv.splice(j, 1);
          _commitServerItems(inv, null, 'season_burn_book', { itemId: id, n, points: pts }, { beforeLen: _beforeLen });
          socket.emit('seasonBurned', { burned: n, points: pts, total });
        } catch (err) {
          console.error('seasonBurnBook:', err);
          logPlayerErr(s.authed.telegramId, s.authed.username, 'season_burn_book', err, { id, qty });
          socket.emit('seasonBurnError', { msg: 'Ошибка сервера' });
        }
      });
      } finally {
        s.itemOpBusy--;
      }
      if (!_ran) socket.emit('seasonBurnError', { msg: _ITEMS_BUSY_MSG });
    });

    // ── Story quest reward ────────────────────────────────────────────────────
    // The reward used to be handed out entirely client-side (js/quests.js's
    // claimQuest added the gold and pushed the items into its own inventory,
    // reaching the server only through the next saveProgress). That stopped
    // working the moment the save path refused to let a client's item list
    // grow — the reward potions were rejected as forged and the player simply
    // lost them, which is what the save_items_forged entries for bp_hp were.
    //
    // Progress itself stays client-tracked (questKills lives in the save blob
    // and nothing server-side counts it), so this is not a completion check —
    // it is a grant. What it does own is the part that mints value: the reward
    // comes from QUEST_DEF here, not from the client, and questIdx is what
    // makes it once-only. A client can still claim a quest it hasn't finished,
    // exactly as before; it cannot claim one twice, claim out of order, or
    // choose its own reward.
    safeOn('claimQuest', ({ idx } = {}) => {
      if (!s.authed) return;
      if (!s.lastStats || !Array.isArray(s.lastStats.inventory)) {
        return socket.emit('questClaimError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
      }
      if (_itemsBusy()) return socket.emit('questClaimError', { msg: _ITEMS_BUSY_MSG });
      const cur = Math.max(0, Math.floor(Number(s.lastStats.questIdx)) || 0);
      // The claim names the quest it means, so a save still in flight can't
      // make this grant the NEXT quest's reward by accident.
      //
      // A mismatch is NOT necessarily an attempt at anything — the usual cause
      // is the client never hearing the questClaimed that advanced this
      // counter (a disconnect right after the grant, a reload mid-flight). The
      // client then sits on the old index and re-sends it forever, and refusing
      // without saying what the real index is left the player permanently
      // unable to claim anything again. So the refusal carries the
      // authoritative counter and the client catches up from it.
      const want = Math.floor(Number(idx));
      if (!Number.isFinite(want) || want !== cur) {
        socket.emit('questSync', { questIdx: cur, questKills: s.lastStats.questKills || {} });
        logPlayer(s.authed.telegramId, s.authed.username, 'quest_claim_desync', { sent: want, server: cur });
        return socket.emit('questClaimError', {
          msg: want < cur ? 'Награда уже получена — список обновлён' : 'Прогресс квестов обновлён — попробуйте снова',
        });
      }
      const q = QUEST_DEF[cur];
      if (!q) return socket.emit('questClaimError', { msg: 'Квест не найден' });
      // Was it actually done? This is the check that was missing: the index said
      // WHICH quest, never whether it had been finished, so a client could claim
      // the whole chain in sequence without playing it.
      if (!questComplete(q, _questKills(), s.lastStats.lvl)) {
        logPlayer(s.authed.telegramId, s.authed.username, 'quest_claim_incomplete', { questId: q.id, idx: cur });
        socket.emit('questSync', { questIdx: cur, questKills: s.lastStats.questKills || {} });
        return socket.emit('questClaimError', { msg: 'Квест ещё не выполнен' });
      }

      const inv = s.lastStats.inventory;
      const _beforeLen = inv.length;
      const rewardIds = Array.isArray(q.reward.items) ? q.reward.items : [];
      const rewardDefs = rewardIds
        .map(id => ITEM_DEF.find(d => d.id === id) || CRAFT_MATS.find(d => d.id === id) || BOX_DEF.find(d => d.id === id))
        .filter(Boolean);
      // Room for the WHOLE reward before anything is claimed. This used to push
      // each item with _invAdd and ignore the refusal — on a full inventory the
      // reward items were dropped one by one while questIdx advanced anyway,
      // which made them unrecoverable (the claim can never be replayed: see the
      // index check above). Same "refuse up front" rule the crafts and the shop
      // already follow. Stackables that merge into an existing entry cost no
      // slot, so they are counted the way _invAdd would actually place them.
      {
        let _need = 0;
        const _willStack = new Set();
        for (const def of rewardDefs) {
          if (_isStackable(def) && (inv.some(i => i && i.id === def.id) || _willStack.has(def.id))) {
            _willStack.add(def.id);
            continue;
          }
          if (_isStackable(def)) _willStack.add(def.id);
          _need++;
        }
        if (inv.length + _need > SERVER_INV_MAX) {
          logPlayer(s.authed.telegramId, s.authed.username, 'quest_reward_refused',
            { questId: q.id, idx: cur, need: _need, slots: `${inv.length}/${SERVER_INV_MAX}` });
          return socket.emit('questClaimError', {
            msg: `Нужно ${_need} свободных мест в инвентаре (занято ${inv.length}/${SERVER_INV_MAX})`,
          });
        }
      }
      const items = [];
      rewardDefs.forEach(def => {
        if (_invAdd(inv, { ...def, qty: 1 })) items.push({ id: def.id, name: def.name, rarity: def.rarity });
      });
      const gold = Math.max(0, Math.floor(Number(q.reward.gold)) || 0);
      if (gold) s.lastStats.gold = Math.max(0, (s.lastStats.gold || 0) + gold);
      // Advancing here is what closes the replay: a second claim finds
      // questIdx already past this quest and is refused above. questKills is
      // reset for the same reason the client resets it — the next quest counts
      // from zero.
      s.lastStats.questIdx = cur + 1;
      s.lastStats.questKills = {};
      _commitServerItems(inv, null, 'quest_reward', { questId: q.id, idx: cur, gold, items: items.map(i => i.id) }, { beforeLen: _beforeLen });
      _persistSavedFields(s.authed, { gold: s.lastStats.gold, questIdx: s.lastStats.questIdx, questKills: {} });
      logPlayer(s.authed.telegramId, s.authed.username, 'quest_reward', { questId: q.id, idx: cur, gold, xp: q.reward.xp || 0 });
      // Quest XP is a fixed reward, so it is granted flat: the kill multipliers
      // (clan, potion, death penalty) deliberately do not apply to it, exactly as
      // gainXP's old `flat` path did not apply them client-side.
      const _qxp = _grantXp(Math.max(0, Math.floor(Number(q.reward.xp)) || 0), { flat: true });
      socket.emit('questClaimed', {
        idx: cur, questId: q.id, gold, xp: _qxp ? _qxp.gained : 0,
        items, newGold: s.lastStats.gold, questIdx: s.lastStats.questIdx,
      });
      if (_qxp) socket.emit('xpSync', _qxp);
    });

    safeOn('getPvpHistory', async () => {
      if (!s.authed) return;
      try {
        const rows = await PvpHistoryModel.find({ telegramId: s.authed.telegramId })
          .sort({ at: -1 }).limit(PVP_HISTORY_KEEP).lean();
        socket.emit('pvpHistoryResult', {
          history: rows.map(r => ({ kind: r.kind, mode: r.mode, opponent: r.opponent, at: r.at })),
        });
      } catch (err) { console.error('getPvpHistory:', err); }
    });

    safeOn('getReferrals', async () => {
      if (!s.authed) return;
      try {
        const referrals = await PlayerModel.find({ referredBy: s.authed.telegramId }, 'username telegramId').lean();
        // Sum bonuses paid to this referrer from GramTx (confirmed deposits of their referrals × 5%)
        const bonusMap = {};
        if (referrals.length) {
          const refIds = referrals.map(r => r.telegramId);
          const deposits = await GramTxModel.find({
            telegramId: { $in: refIds },
            type: 'deposit',
            status: 'confirmed',
          }, 'telegramId amount').lean();
          for (const d of deposits) {
            bonusMap[d.telegramId] = (bonusMap[d.telegramId] || 0) + Math.round(d.amount * 0.05 * 100) / 100;
          }
        }
        const friends = referrals.map(r => ({ username: r.username, bonus: bonusMap[r.telegramId] || 0 }));
        socket.emit('refData', { friends, refLink: _refLink(s.authed.telegramId) });
      } catch (err) { console.error('getReferrals:', err); }
    });

    safeOn('getRating', async ({ tab }) => {
      try {
        if (tab === 'players') {
          const rows = (await _ratingPlayers()).slice();
          // If current player not in top-50, find their rank and append. Not
          // part of the shared cached table — it is this player's own row.
          const myUsername = s.authed?.username;
          const inTop = rows.some(r => r.username === myUsername);
          if (!inTop && s.authed) {
            const myRank = await PlayerModel.countDocuments({ bm: { $gt: s.authed.bm || 0 } }) + 1;
            rows.push({
              username: myUsername,
              bm: s.authed.bm || 0,
              level: (s.lastStats?.lvl) || s.authed.savedData?.lvl || s.authed.savedData?.level || 1,
              rank: myRank,
              isSelf: true,
              gap: true,
            });
          }
          socket.emit('ratingData', { tab: 'players', rows });
        } else {
          socket.emit('ratingData', { tab: 'clans', rows: await _ratingClans() });
        }
      } catch (err) { console.error('getRating:', err); }
    });

    safeOn('claimVipRewards', async () => {
      if (!s.authed) return;
      if (_itemsBusy()) return _itemErr(_ITEMS_BUSY_MSG);
      s.itemOpBusy++;
      let _ran;
      try {
      // Serialized: vipPending is read here and only cleared after an await, so
      // two claims in one tick both saw the same pending list and each handed
      // out the full item set. See _withEconLock.
      _ran = await _withEconLock(async () => {
      try {
        const doc = await PlayerModel.findById(s.authed._id);
        if (!doc) return;
        const saved = doc.savedData || {};
        const pending = Array.isArray(saved.vipPending) ? [...saved.vipPending] : [];
        if (!pending.length) return;
        const charClass = saved.type || 'lev';
        // Live copy first, same reason as gramShopBuy: a fresh DB read lags the
        // saveProgress debounce by up to ~3s and would roll back recent pickups.
        const _liveInv = _liveInventory();
        // Entries are CLONED, not just the array. A shallow [...inv] shares every
        // item object with the live inventory, so the `existing.qty += n` merges
        // below were landing in s.lastStats immediately — including on the paths
        // that then bail out with "nothing was consumed" (claimVipRewards'
        // outOfRoom refusal), which left a grant half-applied to a purchase that
        // never happened. Cloning keeps this a scratch copy until it is committed.
        const inv = _liveInv ? _liveInv.map(i => (i && typeof i === 'object' ? { ...i } : i))
          : (Array.isArray(saved.inventory) ? saved.inventory.map(i => (i && typeof i === 'object' ? { ...i } : i)) : []);
        let goldReward = 0;
        let outOfRoom = false;
        // Mirrors what actually gets pushed/merged into inv below — used to
        // replay the same grant against a different socket if the account
        // reconnected elsewhere during the DB awaits above (see below).
        const _addedItems = [];
        for (const vipLvl of pending) {
          const items = _vipLevelItems(vipLvl, charClass);
          for (const item of items) {
            if (item.slot === 'weapon') {
              // Room check — this used to push unconditionally, which is how
              // accounts got pushed over the client's 150-slot cap; past it
              // invHasSpace() is false forever, so drops stop being picked up
              // and market cancellations start destroying their item.
              if (inv.length >= SERVER_INV_MAX) { outOfRoom = true; break; }
              inv.push({ ...item });
              _addedItems.push({ item });
            } else {
              const ex = inv.find(i => i.id === item.id);
              if (ex) ex.qty = (ex.qty || 1) + (item.qty || 1);
              else {
                if (inv.length >= SERVER_INV_MAX) { outOfRoom = true; break; }
                inv.push({ ...item });
              }
              _addedItems.push({ item, qty: item.qty || 1 });
            }
          }
          if (outOfRoom) break;
          goldReward += _vipGoldReward(vipLvl);
        }
        // Nothing is consumed on failure: vipPending is left intact so the
        // rewards stay claimable once the player frees up space.
        if (outOfRoom) {
          logPlayer(s.authed.telegramId, s.authed.username, 'vip_rewards_refused',
            { levels: pending, slots: `${inv.length}/${SERVER_INV_MAX}` });
          return socket.emit('gramShopError', {
            msg: `Инвентарь полон (${inv.length}/${SERVER_INV_MAX}) — освободите место и заберите награды снова`,
          });
        }
        // The account may have reconnected on a different socket during the
        // findById/updateOne awaits above — inv here was built off a snapshot
        // that predates whatever the REAL live session has done since. Same
        // race as marketCancel/marketBuy (see _applyGrant's comment): replay
        // the same additions against whichever socket is live now instead of
        // writing this stale snapshot through a dead one.
        const _liveSid = activeSessions.get(s.authed.telegramId);
        if (_liveSid !== socket.id) {
          const _target = _socketForTelegramId(s.authed.telegramId);
          const _result = _target && _target.data._applyGrant
            ? _target.data._applyGrant(
                { addItems: _addedItems, goldDelta: goldReward, clearVipPending: true },
                'vip_rewards', { levels: pending, gold: goldReward })
            : null;
          if (!_result) {
            // Gold and the vipPending reset stay in one update with the items:
            // clearing pending separately would risk clearing it for a push that
            // never landed. The over-cap check _dbPushInventory does for the
            // other fallbacks is run after it, on the same figure.
            await PlayerModel.updateOne({ _id: s.authed._id }, {
              $push: { 'savedData.inventory': { $each: _addedItems.map(({ item, qty }) => ({ ...item, ...(qty != null ? { qty } : {}) })) } },
              ...(goldReward > 0 ? { $inc: { 'savedData.gold': goldReward } } : {}),
              $set: { 'savedData.vipPending': [] },
            }).catch(() => {});
            const _after = await PlayerModel.findById(s.authed._id, { 'savedData.inventory': 1 }).lean().catch(() => null);
            const _len = Array.isArray(_after?.savedData?.inventory) ? _after.savedData.inventory.length : null;
            if (_len !== null && _len > SERVER_INV_MAX) {
              logPlayer(s.authed.telegramId, s.authed.username, 'inv_over_cap',
                { reason: 'vip_rewards_cross_session', slots: _len, cap: SERVER_INV_MAX, added: _addedItems.length });
            }
          }
          logPlayer(s.authed.telegramId, s.authed.username, 'vip_rewards_cross_session',
            { levels: pending, gold: goldReward, delivered: !!_result, hadLiveSocket: !!_target });
          if (_target) _target.emit('vipRewardsClaimed', { newInventory: inv, goldAdded: goldReward, vipPending: [] });
          return;
        }
        // Credited on top of the LIVE total, not the one that came back from
        // the findById above — the same reason the inventory came from
        // _liveInventory(). Gold rides the save debounce, so the stored figure
        // is a few seconds behind whatever the player has actually killed for,
        // and adding the reward to it wrote that stale number back as the new
        // balance.
        if (goldReward > 0) saved.gold = (s.lastStats ? _goldNow() : (saved.gold || 0)) + goldReward;
        saved.inventory  = inv;
        saved.vipPending = [];
        // Targeted $set (see the matching comment in gramShopBuy) — a full
        // savedData overwrite here would revert any other field this account's
        // own gameplay autosave wrote in the same window.
        const _vipSet = { 'savedData.inventory': inv, 'savedData.vipPending': [] };
        if (goldReward > 0) _vipSet['savedData.gold'] = saved.gold;
        await PlayerModel.updateOne({ _id: doc._id }, { $set: _vipSet });
        if (s.lastStats && goldReward > 0) {
          s.lastStats.gold = saved.gold;
          // The client expects the balance as a total here (see its
          // vipRewardsClaimed handler, js/network.js) and was never sent one:
          // the HUD kept the pre-claim figure until some unrelated kill or
          // purchase pushed a goldSync, which reads exactly like the reward
          // never arrived.
          socket.emit('goldSync', { gold: _goldNow() });
        }
        _commitServerItems(inv, null, 'vip_rewards', { levels: pending, gold: goldReward });
        socket.emit('vipRewardsClaimed', { newInventory: inv, goldAdded: goldReward, vipPending: [] });
      } catch (err) {
        console.error('claimVipRewards:', err);
        logPlayerErr(s.authed.telegramId, s.authed.username, 'vip_rewards', err);
      }
      });
      } finally {
        s.itemOpBusy--;
      }
      if (!_ran) _itemErr(_ITEMS_BUSY_MSG);
    });

    // ── Special Quests ────────────────────────────────────────────────────────
    safeOn('completeSpecialQuest', async ({ questId } = {}) => {
      if (!s.authed || !questId) return;
      try {
        const quest = await SpecialQuestModel.findById(questId).lean();
        if (!quest || !quest.active) {
          socket.emit('specialQuestError', { questId: String(questId), reason: 'not_found' });
          return;
        }
        const done = (s.authed.savedData?.specialQuestsDone) || [];
        if (done.includes(String(questId))) {
          // Client is out of sync — re-send done so UI corrects itself
          socket.emit('specialQuestDone', { questId: String(questId), reward: { gold: 0, xp: 0, nexum: 0 }, alreadyDone: true });
          return;
        }
        const newDone = [...done, String(questId)];
        // THE CLAIM, AND ONLY THE CLAIM. Gold and XP used to ride in this same
        // write, computed as `s.authed.savedData.<field> + reward`. s.authed is
        // the document as it was read AT LOGIN and nothing ever refreshes it
        // (see _sessionBase, server/handlers/auth.js) — so that arithmetic put a
        // login-time total into the database, and then copied it into the live
        // session and the player's HUD as the new balance. Finish a special
        // quest after an hour of farming and the hour's gold was simply gone;
        // the XP half wrote the same stale figure and was only ever repaired by
        // whatever save happened to land next. Neither number belongs in a
        // claim: the rewards are applied below the way every other credit in
        // this game is applied, against the session that is actually current.
        //
        // The Liberty reward already worked that way — its own $inc after the
        // claim, so it adds to whatever the account holds. The claim itself is
        // what makes all three once-only.
        //
        // savedData null (a brand-new player who has never saved) needs the
        // whole object written rather than a dotted path, or Mongo refuses the
        // write outright ("cannot traverse null element") and silently eats the
        // completion.
        if (s.authed.savedData) {
          // The `$ne` on the filter is what makes the reward once-only. The
          // `done.includes` check above reads s.authed.savedData, which is only
          // updated after this await — so two completions sent in the same tick
          // both passed it and both paid out. Here the database decides: the
          // second write matches nothing and modifiedCount is 0.
          const _claim = await PlayerModel.updateOne(
            { telegramId: s.authed.telegramId, 'savedData.specialQuestsDone': { $ne: String(questId) } },
            { $set: { 'savedData.specialQuestsDone': newDone } },
          );
          if (!_claim.modifiedCount) {
            socket.emit('specialQuestDone', { questId: String(questId), reward: { gold: 0, xp: 0, nexum: 0 }, alreadyDone: true });
            return;
          }
          s.authed.savedData.specialQuestsDone = newDone;
        } else {
          // Same once-only guard as the branch above, expressed against the null
          // savedData this branch exists for.
          const freshData = { specialQuestsDone: newDone };
          const _claimNew = await PlayerModel.updateOne(
            { telegramId: s.authed.telegramId, savedData: null },
            { $set: { savedData: freshData } },
          );
          if (!_claimNew.modifiedCount) {
            socket.emit('specialQuestDone', { questId: String(questId), reward: { gold: 0, xp: 0, nexum: 0 }, alreadyDone: true });
            return;
          }
          s.authed.savedData = freshData;
        }
        // Credited only after the claim above succeeded, so a duplicate request
        // that lost the race pays nothing.
        if (quest.reward.nexum) {
          const _qb = await _incBalance(s.authed.telegramId, 'nexumBalance', quest.reward.nexum);
          if (_qb !== null) {
            s.nexumBalance = _qb;
            socket.emit('nexumBalanceUpdate', { balance: _qb });
          }
        }
        // Where gold and XP land. The account may have reconnected on another
        // socket across the awaits above — the same race claimVipRewards and
        // marketCancel delegate for — and crediting this closure's session then
        // means writing a stale total through a socket nobody is playing on,
        // which is the rollback all over again, one step further along.
        const _sqLive = activeSessions.get(s.authed.telegramId) === socket.id && !!s.lastStats;
        const _sqTarget = _sqLive ? null : _socketForTelegramId(s.authed.telegramId);
        let _sqxp = null;
        if (_sqLive) {
          s.lastStats.specialQuestsDone = newDone;
          // Flat, like the story-quest reward above: a fixed reward does not take
          // the kill multipliers. Both helpers push the resulting total to the
          // client themselves.
          if (quest.reward.gold) {
            _grantGold(quest.reward.gold, 'special_quest');
            _persistSavedFields(s.authed, { gold: _goldNow() });
          }
          if (quest.reward.xp) {
            _sqxp = _grantXp(quest.reward.xp, { flat: true });
            // _grantXp only writes on a level-up; a reward that does not cross
            // the curve would otherwise sit in memory until the next save, and
            // the point of this whole path is that a claimed reward is banked
            // the moment it is claimed.
            if (_sqxp) {
              _persistSavedFields(s.authed, {
                xp: _sqxp.xp, lvl: _sqxp.lvl, xpNext: _sqxp.xpNext,
                baseAtk: _sqxp.baseAtk, baseDef: _sqxp.baseDef, baseMaxHp: _sqxp.baseMaxHp,
              });
            }
          }
        } else if (_sqTarget && _sqTarget.data._applyGrant) {
          if (quest.reward.gold) {
            _sqTarget.data._applyGrant({ goldDelta: quest.reward.gold }, 'special_quest',
              { questId: String(questId) });
          }
          if (quest.reward.xp && _sqTarget.data._grantXp) {
            const _xp = _sqTarget.data._grantXp(quest.reward.xp, { flat: true });
            if (_xp) _sqTarget.emit('xpSync', _xp);
          }
        } else if (quest.reward.gold || quest.reward.xp) {
          // Nobody is holding this account right now, so there is no live total
          // to add to and nothing that can overwrite the record: $inc it
          // directly, for the same reason the offline paths elsewhere do.
          const _inc = {};
          if (quest.reward.gold) _inc['savedData.gold'] = quest.reward.gold;
          if (quest.reward.xp)   _inc['savedData.xp']   = quest.reward.xp;
          await PlayerModel.updateOne({ _id: s.authed._id }, { $inc: _inc }).catch(() => {});
        }
        logPlayer(s.authed.telegramId, s.authed.username, 'special_quest', { questId, title: quest.title, reward: quest.reward });
        socket.emit('specialQuestDone', { questId: String(questId), reward: quest.reward });
        if (_sqxp) socket.emit('xpSync', _sqxp);
      } catch(e) {
        console.error('completeSpecialQuest error:', e);
        socket.emit('specialQuestError', { questId: String(questId || ''), reason: 'server_error' });
      }
    });
};
