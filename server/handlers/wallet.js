'use strict';
// Кошелёк GRAM and the two shops that spend it — the GRAM shop's packages, the
// seasonal ones, and Special Shop's advanced-skill books "of choice" — plus
// deposits, withdrawals and the VIP bar those purchases feed.
//
// Fifth cut into io.on('connection'), on the same `session` object the market,
// forge, season and clans use. It writes two of its properties: session.gram
// four times and session.nexum twice, each with a value a database operation
// returned, exactly as the closure did.
//
// This is the largest block in the closure that exports NOTHING — everything it
// defines is local to a handler or to the file. It is also where real money
// enters the game, which is why every grant here goes through
// commitServerItems and every spend through withEconLock rather than being
// written straight to the record.
//
// Registered after the season, because a package that carries season points
// awards them through season.addPoints.
const GramTxModel = require('../models/GramTx');
const PlayerModel = require('../models/Player');
const { SERVER_INV_MAX } = require('../anticheat');
const {
  _GRAM_SHOP_PKGS, _SEASON_SHOP_PKGS, _SPECIAL_SHOP_PKGS,
  _SHOP_ARMOR_SETS, _SHOP_CLASS_WEAPONS, _STONE_DEFS, _VIP_BP, _shopNewSlots,
} = require('../shop');
const {
  ITEM_DEF, CRAFT_MATS, BOX_DEF, VIP_THRESHOLDS, GRAM_MIN_WITHDRAW,
} = require('../../shared/definitions');

// See createGuildWar (server/events/guildwar.js) for why this is checked.
const REQUIRED_DEPS = [
  'socket', 'safeOn', 'io', 'activeSessions', 'logPlayer', 'logPlayerErr',
  'session', 'season',
  'itemsBusy', 'beginItemOp', 'endItemOp', 'ITEMS_BUSY_MSG',
  'commitServerItems', 'flushBalances', 'liveGram', 'liveInventory',
  'incBalance', 'spendBalance', 'setVipAura', 'socketForTelegramId',
  'withEconLock', 'txData', 'notifyAdminGram',
];

module.exports = function registerWalletHandlers(deps) {
  const missing = REQUIRED_DEPS.filter(k => !deps || deps[k] == null);
  if (missing.length) throw new Error(`registerWalletHandlers: missing deps: ${missing.join(', ')}`);
  const {
    socket, safeOn, io, activeSessions, logPlayer, logPlayerErr,
    session, season,
    itemsBusy, beginItemOp, endItemOp, ITEMS_BUSY_MSG,
    commitServerItems, flushBalances, liveGram, liveInventory,
    incBalance, spendBalance, setVipAura, socketForTelegramId,
    withEconLock, txData, notifyAdminGram,
  } = deps;

    // ── GRAM wallet ───────────────────────────────────────────────────────────
    safeOn('gramDepositRequest', async ({ amount, memo }) => {
      if (!session.authed || !amount || amount < 1) return;
      try {
        const tx = await GramTxModel.create({
          telegramId: session.authed.telegramId,
          username:   session.authed.username,
          type: 'deposit',
          amount: Number(amount),
          // Bounded: it is shown to the admin in a Telegram message and stored
          // per request, so there's no reason to accept an arbitrary-length blob.
          memo: String(memo || session.authed.telegramId).slice(0, 64),
        });
        socket.emit('gramTxCreated', { tx: txData(tx) });
        logPlayer(session.authed.telegramId, session.authed.username, 'gram_deposit_request',
          { amount: Number(amount), tx: tx._id.toString() });
        notifyAdminGram(tx).catch(() => {});
      } catch (err) {
        console.error('gramDepositRequest:', err);
        logPlayerErr(session.authed.telegramId, session.authed.username, 'gram_deposit_request', err, { amount });
      }
    });

    safeOn('gramWithdrawRequest', async ({ amount, address }) => {
      if (!session.authed || !amount || amount < GRAM_MIN_WITHDRAW || !address) return;
      if ((socket.data.vipLevel || 0) < 3) {
        return socket.emit('gramError', { msg: 'Вывод GRAM доступен с VIP 3' });
      }
      try {
        const amt = Number(amount);
        if (!Number.isFinite(amt) || amt <= 0) return;
        // Any pending drop earnings have to reach the database before the balance
        // is tested, or a player could be told they can't afford a withdrawal
        // they've already earned the GRAM for.
        await flushBalances();

        // The deduction IS the affordability check: _spendBalance only writes if
        // the stored balance covers the amount, so two withdrawal requests sent
        // together can't both succeed against the same funds. Refunded in full if
        // the admin rejects the request (see _handleAdminCallback).
        const newBal = await spendBalance(session.authed.telegramId, 'gramBalance', amt);
        if (newBal === null) return socket.emit('gramError', { msg: 'Недостаточно средств' });
        session.gram = newBal;

        let tx;
        try {
          tx = await GramTxModel.create({
            telegramId: session.authed.telegramId,
            username:   session.authed.username,
            type: 'withdraw',
            amount: amt,
            address: String(address).slice(0, 128),
          });
        } catch (err) {
          // The money is already out of the account and there is now no request
          // to refund it from — put it back rather than leave the player short.
          const back = await incBalance(session.authed.telegramId, 'gramBalance', amt);
          if (back !== null) session.gram = back;
          logPlayerErr(session.authed.telegramId, session.authed.username, 'gram_withdraw_request', err, { amount: amt, refunded: true });
          return socket.emit('gramError', { msg: 'Не удалось создать заявку — средства возвращены' });
        }

        socket.emit('gramTxCreated', { tx: txData(tx), newBalance: session.gram });
        logPlayer(session.authed.telegramId, session.authed.username, 'gram_withdraw_request',
          { amount: amt, newBalance: session.gram, tx: tx._id.toString() });
        notifyAdminGram(tx).catch(() => {});
      } catch (err) {
        console.error('gramWithdrawRequest:', err);
        logPlayerErr(session.authed.telegramId, session.authed.username, 'gram_withdraw_request', err, { amount });
      }
    });

    safeOn('gramGetHistory', async () => {
      if (!session.authed) return;
      try {
        const txs = await GramTxModel.find({ telegramId: session.authed.telegramId })
          .sort({ createdAt: -1 }).limit(30).lean();
        socket.emit('gramHistory', { txs: txs.map(txData) });
      } catch (err) { console.error('gramGetHistory:', err); }
    });

    safeOn('gramShopBuy', async ({ pkgId, petId } = {}) => {
      if (!session.authed || !pkgId) return;
      // Refuse rather than clone a snapshot that a concurrently-running market
      // op could invalidate — see _itemsBusy's own comment and marketList's
      // busy check, below, for the duplication this closes.
      if (itemsBusy()) return socket.emit('gramShopError', { msg: ITEMS_BUSY_MSG });
      beginItemOp();
      let _ran;
      try {
      _ran = await withEconLock(async () => {
      try {
        const pkg = _GRAM_SHOP_PKGS.find(p => p.id === pkgId)
                  || _SEASON_SHOP_PKGS.find(p => p.id === pkgId);
        if (!pkg) return socket.emit('gramShopError', { msg: 'Пакет не найден' });
        // petChoice packages need a valid pick of the right rarity BEFORE any
        // GRAM is spent — refusing here (rather than after the deduction) means
        // a missing/invalid choice never costs the player anything.
        let _chosenPet = null;
        if (pkg.petChoice) {
          _chosenPet = ITEM_DEF.find(d => d.id === petId && d.slot === 'pet' && d.rarity === pkg.petChoice);
          if (!_chosenPet) return socket.emit('gramShopError', { msg: 'Выберите питомца' });
        }
        if (liveGram() < pkg.gram) return socket.emit('gramShopError', { msg: 'Недостаточно GRAM' });

        const doc = await PlayerModel.findById(session.authed._id);
        if (!doc) return;
        // Drop earnings first, so the price is tested against everything the
        // player has actually earned.
        await flushBalances();
        const saved = doc.savedData || {};
        const charClass = saved.type || 'lev';
        const wepMap = _SHOP_CLASS_WEAPONS[charClass] || _SHOP_CLASS_WEAPONS.lev;
        // Live copy first — a fresh DB read here is up to ~3s behind (the
        // saveProgress debounce), so building the purchase on it rolled back
        // anything picked up in that window.
        const _liveInv = liveInventory();
        // Entries are CLONED, not just the array. A shallow [...inv] shares every
        // item object with the live inventory, so the `existing.qty += n` merges
        // below were landing in _lastStats immediately — including on the paths
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
          logPlayer(session.authed.telegramId, session.authed.username, 'gram_shop_refused',
            { pkg: pkg.id, need: _newSlots, slots: `${inv.length}/${SERVER_INV_MAX}` });
          return socket.emit('gramShopError', {
            msg: `Нужно ${_newSlots} свободных мест в инвентаре (занято ${inv.length}/${SERVER_INV_MAX})`,
          });
        }

        // The deduction is the affordability check — _spendBalance writes only
        // if the stored balance covers the price (see the balance block at the
        // top of this file), so nothing here can spend GRAM the account doesn't
        // have, whatever the cached figure said a moment ago.
        const _paid = await spendBalance(session.authed.telegramId, 'gramBalance', pkg.gram);
        if (_paid === null) return socket.emit('gramShopError', { msg: 'Недостаточно GRAM' });
        session.gram = _paid;

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

        // Liberty (Nexum) bonus — atomic, like every other balance move.
        if (pkg.nexum > 0) {
          const _nb = await incBalance(session.authed.telegramId, 'nexumBalance', pkg.nexum);
          if (_nb !== null) session.nexum = _nb;
        }

        // VIP progress from purchase
        let _vipLvl = saved.vipLevel || 0;
        let _vipDep = saved.vipDeposited || 0;
        const _vipPend = Array.isArray(saved.vipPending) ? [...saved.vipPending] : [];
        const _prevVipLvl = _vipLvl;
        if (_vipLvl < 10) {
          _vipDep += pkg.gram;
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
        // committing it straight into THIS closure's _lastStats would write it
        // into whichever session is stale if the account reconnected on a
        // different socket in the meantime. Delegate the grant as a delta
        // (items/gold/bonusSP/VIP) against whichever socket is live now,
        // instead of committing the whole reconstructed inv.
        if (activeSessions.get(session.authed.telegramId) !== socket.id) {
          const _target = socketForTelegramId(session.authed.telegramId);
          const _result = _target && _target.data._applyGrant
            ? _target.data._applyGrant({
                addItems: _addedItems, goldDelta: pkg.gold || 0, bonusSPDelta: pkg.bonusSP || 0, vipGramDelta: pkg.gram,
              }, 'gram_shop_cross_session', { pkg: pkg.id, gram: pkg.gram })
            : null;
          if (!_result) {
            await PlayerModel.updateOne({ _id: doc._id }, {
              $push: { 'savedData.inventory': { $each: _addedItems.map(({ item, qty }) => ({ ...item, ...(qty != null ? { qty } : {}) })) } },
              $inc: { 'savedData.gold': pkg.gold || 0, ...(pkg.bonusSP > 0 ? { 'savedData.bonusSP': pkg.bonusSP } : {}) },
            }).catch(() => {});
          }
          logPlayer(session.authed.telegramId, session.authed.username, 'gram_shop_cross_session',
            { pkg: pkg.id, gram: pkg.gram, delivered: !!_result, hadLiveSocket: !!_target });
          const _newInv = _target && _target.data._adminReadItems ? _target.data._adminReadItems().inventory : inv;
          const _res = _result || { gold: saved.gold, bonusSP: saved.bonusSP || 0, vipLevel: _vipLvl, vipDeposited: _vipDep, vipPending: _vipPend };
          if (_target) {
            _target.emit('gramShopResult', {
              pkgId, newBalance: session.gram, newGold: _res.gold, newInventory: _newInv,
              newBonusSP: _res.bonusSP, newNexumBalance: session.nexum,
              vipData: { level: _res.vipLevel, deposited: _res.vipDeposited, pending: _res.vipPending },
              leveled: _res.vipLevel > _prevVipLvl,
            });
            if (_res.vipLevel > _prevVipLvl) {
              _target.emit('vipUpdate', { level: _res.vipLevel, deposited: _res.vipDeposited, pending: _res.vipPending });
            }
          }
          io.to(`tg_${session.authed.telegramId}`).emit('gramBalanceUpdate', { balance: session.gram });
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
        await PlayerModel.updateOne({ _id: doc._id }, { $set: _shopSet });

        if (session.lastStats) {
          session.lastStats.gold = saved.gold;
              if (pkg.bonusSP > 0) session.lastStats.bonusSP = saved.bonusSP;
        }
        // Bumps the revision, so a client autosave queued before this purchase
        // can no longer land afterwards and wipe the items out.
        commitServerItems(inv, null, 'gram_shop', { pkg: pkg.id, gram: pkg.gram });
        socket.data.vipLevel = _vipLvl;
        setVipAura(session.authed.username, _vipLvl);

        socket.emit('gramShopResult', {
          pkgId,
          newBalance:  session.gram,
          newGold:     saved.gold,
          newInventory: inv,
          newBonusSP:  saved.bonusSP || 0,
          newNexumBalance: session.nexum,
          vipData: { level: _vipLvl, deposited: _vipDep, pending: _vipPend },
          leveled: _vipLvl > _prevVipLvl,
        });
        io.to(`tg_${session.authed.telegramId}`).emit('gramBalanceUpdate', { balance: session.gram });
        if (_vipLvl > _prevVipLvl) {
          socket.emit('vipUpdate', { level: _vipLvl, deposited: _vipDep, pending: _vipPend });
        }
      } catch (err) {
        console.error('gramShopBuy:', err);
        logPlayerErr(session.authed.telegramId, session.authed.username, 'gram_shop', err, { pkgId });
      }
      });
      } finally {
        endItemOp();
      }
      if (!_ran) socket.emit('gramShopError', { msg: 'Покупка уже обрабатывается' });
    });

    // ── Special Shop (advanced-skill books "of choice") ────────────────────────
    // Same GRAM-purchase shape as gramShopBuy above (atomic spend, room check,
    // one commit, VIP progress), kept as its own handler rather than folded
    // into that one: this is the only package type where the BUYER decides the
    // item split, and threading that through gramShopBuy's already-large
    // branch-per-reward-kind body risked the two kinds of packages interfering.
    safeOn('specialShopBuy', async ({ pkgId, books, petId } = {}) => {
      if (!session.authed || !pkgId) return;
      if (itemsBusy()) return socket.emit('specialShopError', { msg: ITEMS_BUSY_MSG });
      beginItemOp();
      let _ran;
      try {
      _ran = await withEconLock(async () => {
      try {
        const pkg = _SPECIAL_SHOP_PKGS.find(p => p.id === pkgId);
        if (!pkg) return socket.emit('specialShopError', { msg: 'Пакет не найден' });

        // books: { Q, W, E, R } — how the buyer wants pkg.bookCount split
        // across their class's four advanced-skill slots. Validated in full
        // BEFORE any GRAM moves: every key must be one of the four slot
        // letters, every value a non-negative integer, and the sum must be
        // exactly pkg.bookCount — no more, no less. A missing/invalid split
        // never costs the player anything.
        const SLOTS = ['Q', 'W', 'E', 'R'];
        if (!books || typeof books !== 'object' || Array.isArray(books)) {
          return socket.emit('specialShopError', { msg: 'Выберите книги' });
        }
        if (Object.keys(books).some(k => !SLOTS.includes(k))) {
          return socket.emit('specialShopError', { msg: 'Некорректный выбор' });
        }
        const dist = {};
        let sum = 0;
        for (const k of SLOTS) {
          const n = Math.floor(Number(books[k]));
          if (!Number.isFinite(n) || n < 0) return socket.emit('specialShopError', { msg: 'Некорректный выбор' });
          dist[k] = n;
          sum += n;
        }
        if (sum !== pkg.bookCount) {
          return socket.emit('specialShopError', { msg: `Выберите ровно ${pkg.bookCount} книг` });
        }

        // petChoice (special270): same rule as gramShopBuy's own — a valid
        // pick of the right rarity BEFORE any GRAM is spent, so a missing/
        // invalid choice never costs the player anything.
        let _chosenPet = null;
        if (pkg.petChoice) {
          _chosenPet = ITEM_DEF.find(d => d.id === petId && d.slot === 'pet' && d.rarity === pkg.petChoice);
          if (!_chosenPet) return socket.emit('specialShopError', { msg: 'Выберите питомца' });
        }

        if (liveGram() < pkg.gram) return socket.emit('specialShopError', { msg: 'Недостаточно GRAM' });

        const doc = await PlayerModel.findById(session.authed._id);
        if (!doc) return;
        // Drop earnings first, so the price is tested against everything the
        // player has actually earned — same reasoning as gramShopBuy.
        await flushBalances();
        const saved = doc.savedData || {};
        const charClass = saved.type || 'lev';
        const classAdvBooks = {};
        CRAFT_MATS.forEach(m => { if (m.forClass === charClass && m.advSkillKey) classAdvBooks[m.advSkillKey] = m; });

        // Live copy first — a fresh DB read here is up to ~3s behind (the
        // saveProgress debounce), so building the purchase on it rolled back
        // anything picked up in that window. Same pattern as gramShopBuy.
        const _liveInv = liveInventory();
        // Entries are CLONED, not just the array. A shallow [...inv] shares every
        // item object with the live inventory, so the `existing.qty += n` merges
        // below were landing in _lastStats immediately — including on the paths
        // that then bail out with "nothing was consumed" (claimVipRewards'
        // outOfRoom refusal), which left a grant half-applied to a purchase that
        // never happened. Cloning keeps this a scratch copy until it is committed.
        const inv = _liveInv ? _liveInv.map(i => (i && typeof i === 'object' ? { ...i } : i))
          : (Array.isArray(saved.inventory) ? saved.inventory.map(i => (i && typeof i === 'object' ? { ...i } : i)) : []);

        // Room check before anything is deducted. Books and the safe stone all
        // stack, so this is at most one new slot per book slot the buyer
        // actually put a nonzero count in, plus one for bless_stone — plus
        // whatever the higher special270 tier's extra armor/weapon/potions
        // fields need (_shopNewSlots, shared with gramShopBuy — none of the
        // fields it looks at overlap with the book/bless count just above).
        const has = id => inv.some(i => i && i.id === id);
        let _newSlots = 0;
        SLOTS.forEach(k => { if (dist[k] > 0 && classAdvBooks[k] && !has(classAdvBooks[k].id)) _newSlots++; });
        if (pkg.bless > 0 && !has('bless_stone')) _newSlots++;
        _newSlots += _shopNewSlots(pkg, inv, charClass);
        if (inv.length + _newSlots > SERVER_INV_MAX) {
          logPlayer(session.authed.telegramId, session.authed.username, 'special_shop_refused',
            { pkg: pkg.id, need: _newSlots, slots: `${inv.length}/${SERVER_INV_MAX}` });
          return socket.emit('specialShopError', {
            msg: `Нужно ${_newSlots} свободных мест в инвентаре (занято ${inv.length}/${SERVER_INV_MAX})`,
          });
        }

        // The deduction is the affordability check — same _spendBalance rule as
        // every other GRAM purchase in this file.
        const _paid = await spendBalance(session.authed.telegramId, 'gramBalance', pkg.gram);
        if (_paid === null) return socket.emit('specialShopError', { msg: 'Недостаточно GRAM' });
        session.gram = _paid;

        // Parallel record of every item this purchase grants, as plain
        // {item, qty} deltas — same shape/reasoning as gramShopBuy's own
        // _addedItems: only consumed by the cross-session branch further down.
        const _addedItems = [];
        const _addStack = (base, qty) => {
          if (!base || qty <= 0) return;
          const existing = inv.find(i => i.id === base.id);
          if (existing) existing.qty = (existing.qty || 1) + qty;
          else inv.push({ ...base, qty });
          _addedItems.push({ item: base, qty });
        };
        SLOTS.forEach(k => { if (dist[k] > 0) _addStack(classAdvBooks[k], dist[k]); });
        if (pkg.bless > 0) _addStack(CRAFT_MATS.find(m => m.id === 'bless_stone'), pkg.bless);

        // Extra rewards on the higher special270 tier — same fields/grant
        // shape gramShopBuy uses for pkg.potions/armor/weapon/bonusSP/nexum,
        // just also wired up here so one buyer-picked-books package can carry
        // them too, instead of forcing a second purchase through the other shop.
        if (pkg.potions > 0) _VIP_BP.forEach(bp => _addStack(bp, pkg.potions));
        if (pkg.armor) {
          (_SHOP_ARMOR_SETS[pkg.armor] || []).forEach(id => {
            const base = ITEM_DEF.find(d => d.id === id);
            if (base) { inv.push({ ...base, enhance: pkg.enhance || 0 }); _addedItems.push({ item: { ...base, enhance: pkg.enhance || 0 } }); }
          });
        }
        if (pkg.weapon) {
          // uniqueWeapon (special270): the buyer's class's own UNIQUE_WEAPONS
          // entry (unique:true on the merged ITEM_DEF copy — shared/
          // definitions.js) instead of the plain epic-tier weapon `weapon`
          // would otherwise resolve to via _SHOP_CLASS_WEAPONS.
          const base = pkg.uniqueWeapon
            ? ITEM_DEF.find(d => d.unique && d.forClass && d.forClass.includes(charClass))
            : ITEM_DEF.find(d => d.id === (_SHOP_CLASS_WEAPONS[charClass] || _SHOP_CLASS_WEAPONS.lev)[pkg.weapon]);
          if (base) { inv.push({ ...base, enhance: pkg.enhance || 0 }); _addedItems.push({ item: { ...base, enhance: pkg.enhance || 0 } }); }
        }
        // Class-locked cloak/artifact + the buyer's chosen pet — same fields/
        // grant shape gramShopBuy uses for these three.
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
        if (pkg.bonusSP > 0) saved.bonusSP = (saved.bonusSP || 0) + pkg.bonusSP;
        // Liberty (Nexum) — an atomic $inc via _incBalance, safe regardless of
        // which socket ends up "live" by the time this lands (unlike the
        // inventory/bonusSP writes below, which is exactly what the
        // cross-session branch further down exists to protect).
        if (pkg.nexum > 0) {
          const _nb = await incBalance(session.authed.telegramId, 'nexumBalance', pkg.nexum);
          if (_nb !== null) session.nexum = _nb;
        }

        // VIP progress from purchase — identical rule to gramShopBuy, GRAM is
        // GRAM regardless of which shop it was spent in.
        let _vipLvl = saved.vipLevel || 0;
        let _vipDep = saved.vipDeposited || 0;
        const _vipPend = Array.isArray(saved.vipPending) ? [...saved.vipPending] : [];
        const _prevVipLvl = _vipLvl;
        if (_vipLvl < 10) {
          _vipDep += pkg.gram;
          while (_vipLvl < 10 && _vipDep >= VIP_THRESHOLDS[_vipLvl + 1]) {
            _vipDep -= VIP_THRESHOLDS[_vipLvl + 1];
            _vipLvl++;
            _vipPend.push(_vipLvl);
          }
          saved.vipLevel = _vipLvl;
          saved.vipDeposited = _vipDep;
          saved.vipPending = _vipPend;
        }

        // Cross-session guard — same reasoning/shape as gramShopBuy's own:
        // this handler holds across several awaits (findById, _flushBalances,
        // _spendBalance, an optional nexum grant) before it gets here, and the
        // `inv`/`saved.bonusSP` built above are a snapshot that a reconnect on
        // a different socket in the meantime would make stale. Delegate the
        // grant as a delta against whichever socket is live now instead of
        // committing straight into this (possibly dead) closure's _lastStats.
        // Only added once special270 started carrying real value beyond books/
        // bless/season points (epic gear, 10000 Liberty) — the three original
        // packages never needed it.
        if (activeSessions.get(session.authed.telegramId) !== socket.id) {
          const _target = socketForTelegramId(session.authed.telegramId);
          const _result = _target && _target.data._applyGrant
            ? _target.data._applyGrant({
                addItems: _addedItems, bonusSPDelta: pkg.bonusSP || 0, vipGramDelta: pkg.gram,
              }, 'special_shop_cross_session', { pkg: pkg.id, gram: pkg.gram })
            : null;
          if (!_result) {
            await PlayerModel.updateOne({ _id: doc._id }, {
              $push: { 'savedData.inventory': { $each: _addedItems.map(({ item, qty }) => ({ ...item, ...(qty != null ? { qty } : {}) })) } },
              ...(pkg.bonusSP > 0 ? { $inc: { 'savedData.bonusSP': pkg.bonusSP } } : {}),
            }).catch(() => {});
          }
          logPlayer(session.authed.telegramId, session.authed.username, 'special_shop_cross_session',
            { pkg: pkg.id, gram: pkg.gram, delivered: !!_result, hadLiveSocket: !!_target });
          const _newInv = _target && _target.data._adminReadItems ? _target.data._adminReadItems().inventory : inv;
          const _res = _result || { bonusSP: saved.bonusSP || 0, vipLevel: _vipLvl, vipDeposited: _vipDep, vipPending: _vipPend };
          const _seasonTotalX = await season.addPoints(pkg.seasonPoints, 'special_shop', { pkg: pkg.id });
          if (_target) {
            _target.emit('specialShopResult', {
              pkgId, newBalance: session.gram, newInventory: _newInv,
              newBonusSP: _res.bonusSP, newNexumBalance: session.nexum,
              vipData: { level: _res.vipLevel, deposited: _res.vipDeposited, pending: _res.vipPending },
              leveled: _res.vipLevel > _prevVipLvl, seasonTotal: _seasonTotalX,
            });
            if (_res.vipLevel > _prevVipLvl) {
              _target.emit('vipUpdate', { level: _res.vipLevel, deposited: _res.vipDeposited, pending: _res.vipPending });
            }
          }
          io.to(`tg_${session.authed.telegramId}`).emit('gramBalanceUpdate', { balance: session.gram });
          return;
        }

        saved.inventory = inv;
        // Targeted $set, same reasoning as gramShopBuy's own — a full-document
        // save from the doc fetched at the top of this handler could already be
        // stale by the time this lands.
        const _specialSet = {
          'savedData.inventory':    inv,
          'savedData.vipLevel':     _vipLvl,
          'savedData.vipDeposited': _vipDep,
          'savedData.vipPending':   _vipPend,
        };
        if (pkg.bonusSP > 0) _specialSet['savedData.bonusSP'] = saved.bonusSP;
        await PlayerModel.updateOne({ _id: doc._id }, { $set: _specialSet });

        if (session.lastStats && pkg.bonusSP > 0) session.lastStats.bonusSP = saved.bonusSP;

        // Bumps the revision, so a client autosave queued before this purchase
        // can no longer land afterwards and wipe the items out.
        commitServerItems(inv, null, 'special_shop', { pkg: pkg.id, gram: pkg.gram, books: dist });
        socket.data.vipLevel = _vipLvl;
        setVipAura(session.authed.username, _vipLvl);

        // Season points — best-effort. The rest of the purchase (books, safe
        // stones, VIP progress) is real value already paid for and granted;
        // not letting a season that happens to be over right now undo any of
        // that, same as every other season-adjacent grant in this file.
        const _seasonTotal = await season.addPoints(pkg.seasonPoints, 'special_shop', { pkg: pkg.id });

        socket.emit('specialShopResult', {
          pkgId,
          newBalance: session.gram,
          newInventory: inv,
          newBonusSP: saved.bonusSP || 0,
          newNexumBalance: session.nexum,
          vipData: { level: _vipLvl, deposited: _vipDep, pending: _vipPend },
          leveled: _vipLvl > _prevVipLvl,
          seasonTotal: _seasonTotal,
        });
        io.to(`tg_${session.authed.telegramId}`).emit('gramBalanceUpdate', { balance: session.gram });
        if (_vipLvl > _prevVipLvl) {
          socket.emit('vipUpdate', { level: _vipLvl, deposited: _vipDep, pending: _vipPend });
        }
      } catch (err) {
        console.error('specialShopBuy:', err);
        logPlayerErr(session.authed.telegramId, session.authed.username, 'special_shop', err, { pkgId });
      }
      });
      } finally {
        endItemOp();
      }
      if (!_ran) socket.emit('specialShopError', { msg: 'Покупка уже обрабатывается' });
    });

};
