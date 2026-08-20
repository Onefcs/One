'use strict';
// Кузница — the forge's eight socket handlers: crafting stones, gear, boxes,
// pets and class cloaks/artifacts, upgrading materials a tier, opening a loot
// box, and заточка (enhancing).
//
// Second cut into io.on('connection'), on the pattern server/handlers/market.js
// set, and it takes that pattern's `session` object unchanged — one object per
// socket, assembled once in server/index.js, holding LIVE accessors rather than
// copies. Two properties were added for this file: session.nexum, which the
// forge reads and writes exactly as it read and wrote _nexumBalance, and
// session.invRev, which is read-only out here — the inventory revision counter
// is bumped by commitServerItems and handlers only ever put it in a log line so
// a "where did my item go" report can be lined up against the write that moved
// the item.
//
// Everything else is either required directly (the recipe tables, the catalog,
// the season helpers) or handed over as a verb: itemsBusy/beginItemOp/endItemOp
// over the counter this shares with the market and storage, withEconLock for
// the currency-spending crafts, commitServerItems for every inventory write.
const { _catalogBase, SERVER_INV_MAX } = require('../anticheat');
const { _invAdd } = require('../inventory');
const {
  ITEM_DEF, CRAFT_MATS, BOX_DEF, isStackableItem,
  ENHANCE_MAX, ENHANCEABLE_SLOTS,
  GEAR_CRAFT_RECIPES, GEAR_TIER_CRAFT_RECIPES, MAT_UPGRADE_RECIPES,
  PET_CRAFT_RECIPES, UNIQUE_CRAFT_RECIPES, CLASS_GEAR_SALVAGE_RECIPES,
  SEASON_ENHANCE_POINTS, seasonActive,
} = require('../../shared/definitions');

// See createGuildWar (server/events/guildwar.js) for why this is checked rather
// than assumed. As in market.js it matters more here than there: these are
// per-socket, so a name missed in the wiring would not throw until some player
// happened to open the forge.
const REQUIRED_DEPS = [
  'socket', 'safeOn', 'session', 'seasonAddPoints',
];

// What this file takes from the shared services object.
const REQUIRED_SVC = [
  'activeSessions', 'logPlayer', 'logPlayerErr', 'incBalance',
  'spendBalance', 'socketForTelegramId',
];

// ...and from the per-socket session. Both are checked below for the same
// reason REQUIRED_DEPS is: a name missing from svc or session destructures to
// undefined, which no linter sees and nothing throws on until that path runs.
const REQUIRED_SESSION = [
  'itemsBusy', 'beginItemOp', 'endItemOp', 'ITEMS_BUSY_MSG',
  'commitServerItems', 'flushBalances', 'withEconLock',
];

module.exports = function registerForgeHandlers(deps) {
  if (!deps || !deps.svc || !deps.session) throw new Error('forge: needs svc and session');
  const { svc, session } = deps;
  const missingSvc = REQUIRED_SVC.filter(k => svc[k] == null);
  if (missingSvc.length) throw new Error(`forge: svc missing: ${missingSvc.join(', ')}`);
  const missingSess = REQUIRED_SESSION.filter(k => session[k] == null);
  if (missingSess.length) throw new Error(`forge: session missing: ${missingSess.join(', ')}`);
  const missing = REQUIRED_DEPS.filter(k => deps[k] == null);
  if (missing.length) throw new Error(`registerForgeHandlers: missing deps: ${missing.join(', ')}`);
  const {
    socket, safeOn, seasonAddPoints,
  } = deps;
  const {
    activeSessions, logPlayer, logPlayerErr, incBalance, spendBalance,
    socketForTelegramId,
  } = svc;
  const {
    itemsBusy, beginItemOp, endItemOp, ITEMS_BUSY_MSG, commitServerItems,
    flushBalances, withEconLock,
  } = session;

    // ── Enchant stone crafting — REMOVED ──────────────────────────────────────
    // Stones are no longer craftable at the forge: the recipes are gone from
    // shared/definitions.js and the craftsman UI no longer lists them. The
    // handler stays registered on purpose — a client running a cached bundle
    // still shows the old cell, and answering it with a clear message beats
    // leaving its craft button spinning forever. It grants nothing and charges
    // nothing.
    //
    // Stones themselves are untouched: they still drop from monsters
    // (roomEnchantStoneChance), come with VIP level rewards and are sold in the
    // season packs — only this one route is closed.
    safeOn('craftStone', ({ matId } = {}) => {
      if (!session.authed) return;
      logPlayer(session.authed.telegramId, session.authed.username, 'stone_craft_removed', { matId });
      socket.emit('craftStoneError', { msg: 'Камни заточки больше не создаются в кузнице' });
    });

    // ── Gear crafting (Кузнец → Предметы → все тиры) ───────────────────────────
    // Covers both GEAR_TIER_CRAFT_RECIPES (uncommon/rare — materials only, no
    // nexumCost) and GEAR_CRAFT_RECIPES (epic/legendary — same shape plus a
    // Liberty cost). The uncommon/rare tiers used to be entirely client-
    // computed (js/npc.js's craftSpecificItem rolled the chance and granted the
    // result itself, only ever reaching the server via the next saveProgress
    // blob) — exactly the "items appearing out of nowhere" hole this closes:
    // _canonSavedItem trusts any valid id+enhance on save, no matter how it got
    // there. Unlike stones (chance:1.0), these can genuinely roll a failure —
    // on a miss the mats (and Liberty, where the recipe has one) are still
    // spent, same "materials lost" rule every recipe already applies, only the
    // item isn't granted.
    safeOn('craftGear', async ({ itemId } = {}) => {
      if (!session.authed) return;
      beginItemOp();
      let _ran;
      try {
      _ran = await withEconLock(async () => {
      try {
        const rec = GEAR_CRAFT_RECIPES.find(r => r.itemId === itemId)
                 || GEAR_TIER_CRAFT_RECIPES.find(r => r.itemId === itemId)
                 || UNIQUE_CRAFT_RECIPES.find(r => r.itemId === itemId);
        if (!rec) return socket.emit('craftGearError', { msg: 'Неизвестный рецепт' });
        const resultDef = ITEM_DEF.find(i => i.id === rec.itemId);
        if (!resultDef) return socket.emit('craftGearError', { msg: 'Предмет не найден' });
        if (!session.lastStats || !Array.isArray(session.lastStats.inventory)) {
          return socket.emit('craftGearError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
        }
        const inv = session.lastStats.inventory;
        const _beforeLen = inv.length;
        // A full inventory dooms the craft regardless of how the roll lands —
        // refuse up front rather than spend mats/Liberty on an attempt that
        // could never have delivered the item.
        if (inv.length >= SERVER_INV_MAX) {
          return socket.emit('craftGearError', { msg: 'Инвентарь полон' });
        }
        // Enhanced-gear mats (minEnhance set) are non-stackable items matched
        // by id+enhance, like removeEnhancedItem/countEnhancedItem client-side
        // (js/player.js); plain mats (recipe scrolls) are counted by qty like
        // craftStone's countOf above.
        const matCount = m => m.minEnhance != null
          ? inv.reduce((s, i) => s + (i && i.id === m.id && (i.enhance || 0) >= m.minEnhance ? 1 : 0), 0)
          : inv.reduce((s, i) => s + (i && i.id === m.id ? (i.qty || 1) : 0), 0);
        const matName = id => (ITEM_DEF.find(i => i.id === id) || CRAFT_MATS.find(i => i.id === id) || {}).name || id;
        for (const m of rec.mats) {
          if (matCount(m) < m.n) {
            return socket.emit('craftGearError', { msg: `Нужно ${m.n} × ${matName(m.id)} (есть ${matCount(m)})` });
          }
        }
        // Charged before anything is consumed, and atomically — see craftStone.
        // Uncommon/rare recipes have no nexumCost, so this (and the re-check
        // right after) is skipped entirely for them — nothing to charge.
        if (rec.nexumCost) {
          await flushBalances();
          const _bal = await spendBalance(session.authed.telegramId, 'nexumBalance', rec.nexumCost);
          if (_bal === null) {
            return socket.emit('craftGearError', { msg: `Нужно ${rec.nexumCost} Liberty` });
          }
          session.nexum = _bal;
        }
        // Re-checked after the await, same reasoning as craftStone.
        for (const m of rec.mats) {
          if (matCount(m) < m.n) {
            if (rec.nexumCost) {
              const back = await incBalance(session.authed.telegramId, 'nexumBalance', rec.nexumCost);
              if (back !== null) session.nexum = back;
            }
            return socket.emit('craftGearError', { msg: `Нужно ${m.n} × ${matName(m.id)} (есть ${matCount(m)})` });
          }
        }
        // Result enhance mirrors _craftResultEnhance (js/npc.js): comes out 2
        // levels below whatever the consumed base item was required to be.
        const baseMat = rec.mats.find(m => m.minEnhance != null);
        const resultEnhance = baseMat ? Math.max(0, baseMat.minEnhance - 2) : 0;
        const success = Math.random() < rec.chance;
        const resultItem = success
          ? (resultEnhance > 0 ? { ...resultDef, enhance: resultEnhance } : { ...resultDef })
          : null;
        const _removeMats = (liveInv) => {
          for (const m of rec.mats) {
            let left = m.n;
            for (let i = liveInv.length - 1; i >= 0 && left > 0; i--) {
              const e = liveInv[i];
              if (!e || e.id !== m.id) continue;
              if (m.minEnhance != null) {
                if ((e.enhance || 0) < m.minEnhance) continue;
                liveInv.splice(i, 1); left--;
              } else {
                const have = e.qty || 1;
                if (have > left) { e.qty = have - left; left = 0; }
                else { left -= have; liveInv.splice(i, 1); }
              }
            }
          }
        };

        // Cross-session guard: the nexumCost path above awaits a balance spend
        // — if the account reconnected on a different socket during that gap,
        // this closure's inv is orphaned. Redirect mat consumption + result
        // grant at whichever socket is live now.
        if (rec.nexumCost && activeSessions.get(session.authed.telegramId) !== socket.id) {
          const _target = socketForTelegramId(session.authed.telegramId);
          const _items = _target && _target.data._adminReadItems ? _target.data._adminReadItems().inventory : null;
          if (!_target || !Array.isArray(_items)) {
            const back = await incBalance(session.authed.telegramId, 'nexumBalance', rec.nexumCost);
            if (back !== null) session.nexum = back;
            return socket.emit('craftGearError', { msg: 'Сессия недоступна — попробуйте ещё раз' });
          }
          for (const m of rec.mats) {
            const _cnt = m.minEnhance != null
              ? _items.reduce((s, i) => s + (i && i.id === m.id && (i.enhance || 0) >= m.minEnhance ? 1 : 0), 0)
              : _items.reduce((s, i) => s + (i && i.id === m.id ? (i.qty || 1) : 0), 0);
            if (_cnt < m.n) {
              const back = await incBalance(session.authed.telegramId, 'nexumBalance', rec.nexumCost);
              if (back !== null) session.nexum = back;
              return socket.emit('craftGearError', { msg: `Нужно ${m.n} × ${matName(m.id)} (есть ${_cnt})` });
            }
          }
          const _res = _target.data._applyCraftResult(_removeMats, resultItem,
            'gear_craft_cross_session', { itemId, cost: rec.nexumCost, success });
          _target.emit('gearCrafted', {
            itemId, success, resultEnhance: success ? resultEnhance : 0,
            newNexumBalance: session.nexum, delivered: _res ? _res.delivered : false,
          });
          return;
        }

        _removeMats(inv);
        if (success) {
          // Space was already guaranteed above, so this can only fail if the
          // check there and this add somehow disagree — treat as the same
          // "inventory's full, but the roll already happened" edge case
          // craftStone accepts rather than trying to re-roll or fabricate a
          // refund policy for a case that shouldn't be reachable.
          _invAdd(inv, resultItem);
        }
        commitServerItems(inv, null, 'gear_craft', { itemId, cost: rec.nexumCost, success }, { beforeLen: _beforeLen });
        socket.emit('gearCrafted', { itemId, success, resultEnhance: success ? resultEnhance : 0, newNexumBalance: session.nexum });
      } catch (err) {
        console.error('craftGear:', err);
        logPlayerErr(session.authed.telegramId, session.authed.username, 'gear_craft', err, { itemId });
        socket.emit('craftGearError', { msg: 'Ошибка сервера' });
      }
      });
      } finally {
        endItemOp();
      }
      // The lock was already held, so the body above never ran. Saying so is
      // what the client needs: netCraftGear waits for gearCrafted OR
      // craftGearError and shows a spinner until one arrives — dropping both
      // left the craft dialog spinning forever on a tap that did nothing.
      if (!_ran) socket.emit('craftGearError', { msg: ITEMS_BUSY_MSG });
    });

    // ── Enhance / заточка (inventory item modal + equipped item modal) ─────────
    // Used to be entirely client-computed (js/ui.js's enhanceItem/enhanceEqItem
    // rolled the success chance themselves and only ever reached the server via
    // the next saveProgress blob) — which is exactly the "items appearing out
    // of nowhere" hole: _canonSavedItem (above) trusts any enhance 0..
    // ENHANCE_MAX on a valid item id, so a modified client could just claim any
    // item already at max enhance without ever spending a stone. The roll, the
    // stone spend and the mutation all happen here now; the client only shows
    // what this event reports.
    //
    // No DB round trip happens before the mutation (stones are paid for out of
    // the in-memory _lastStats.inventory, not a server-tracked balance), so
    // unlike the Liberty-spending crafts above this handler never awaits — it
    // runs start to finish in one tick, which rules out the same-account double
    // -submit race those needed _withEconLock for.
    //
    // Target identity: an equipped slot is unambiguous, but a non-stackable
    // inventory item has no id of its own — id+current-enhance is the same
    // matching scheme craftGear already uses for its minEnhance-gated mats
    // (two copies of the same weapon at the same enhance are interchangeable,
    // so matching the first one found is correct either way).
    safeOn('enhanceItem', ({ id, enhance, stoneType, slot } = {}) => {
      if (!session.authed) return;
      if (!session.lastStats || !Array.isArray(session.lastStats.inventory)) {
        return socket.emit('enhanceError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
      }
      if (itemsBusy()) return socket.emit('enhanceError', { msg: ITEMS_BUSY_MSG });
      const inv = session.lastStats.inventory;
      const _beforeLen = inv.length;
      const curEnh = Math.max(0, Math.floor(Number(enhance)) || 0);
      if (curEnh >= ENHANCE_MAX) return socket.emit('enhanceError', { msg: 'Уже максимальная заточка' });

      // "Предмет не найден" means the client is holding something this server
      // does not have — the two inventories have drifted apart. Erroring and
      // stopping there leaves the player stuck on a dead end they cannot clear
      // themselves (every retry re-reads the same stale item), so push the
      // authoritative set back at the same time: the UI corrects itself and a
      // retry works. The log records what the server actually holds for that
      // id, which is what makes the drift diagnosable rather than a guess.
      const _enhNotFound = where => {
        logPlayer(session.authed.telegramId, session.authed.username, 'enhance_not_found', {
          id, wantEnhance: curEnh, where, rev: session.invRev, invLen: inv.length,
          serverHas: inv.filter(i => i && i.id === id).map(i => i.enhance || 0),
        });
        socket.emit('inventorySync', {
          inventory: inv, equipment: session.lastStats.equipment || {},
        });
        return socket.emit('enhanceError', { msg: 'Предмет не найден' });
      };

      // Where the item currently sits can legitimately differ between the two
      // sides. equip/unequip only move it in the CLIENT's copy and reach the
      // server on a save — and in the hub, with nothing to kill, that save may
      // be seconds away or (on an older client, which never saved on equip at
      // all) not coming. Trusting the client's `slot` and stopping there is
      // exactly what made enhancing a just-crafted, just-equipped pet fail with
      // "Предмет не найден" every single time.
      //
      // So resolve by IDENTITY first — id + current enhance, the same matching
      // scheme used above — and reconcile the location afterwards. Relocating an
      // item between the inventory and an equip slot creates and destroys
      // nothing, so this stays inside the census invariant saveProgress enforces
      // (both containers are the server's); it cannot be used to conjure or
      // upgrade anything, only to agree on where a thing already owned is kept.
      const eq = session.lastStats.equipment || {};
      const _matches = it => it && it.id === id && (it.enhance || 0) === curEnh;

      let target = null, targetIdx = -1, targetSlot = null;
      if (slot && _matches(eq[slot])) {
        target = eq[slot];
        targetSlot = slot;
      } else {
        targetIdx = inv.findIndex(_matches);
        if (targetIdx >= 0) {
          target = inv[targetIdx];
        } else {
          // Mirror image: the client has it loose, the server still has it
          // equipped — an unequip that has not been saved yet.
          const found = Object.keys(eq).find(sl => _matches(eq[sl]));
          if (found) { target = eq[found]; targetSlot = found; }
        }
      }
      if (!target) return _enhNotFound(slot ? 'equipped:' + slot : 'inventory');

      // An item may only ever be enhanced in its OWN slot. Without this the
      // relocation below would honour whatever slot name the request carried and
      // file, say, a pet under `weapon` — and since a client sums the stats of
      // every equipment entry regardless of which key it sits under, that is a
      // way to wear one item twice over.
      if (slot && target.slot !== slot) {
        logPlayer(session.authed.telegramId, session.authed.username, 'enhance_slot_mismatch',
          { id, claimed: slot, actual: target.slot });
        return _enhNotFound('slot_mismatch:' + slot);
      }

      // Can this thing be enhanced at all? Checked HERE — before the relocation
      // below — rather than after it. Refusing afterwards left the item already
      // moved between the inventory and an equip slot inside _lastStats with no
      // _commitServerItems behind it: no revision bump, no persist, no
      // inventorySync, so the session and the stored record disagreed about
      // where the item lived until some later save happened to paper over it.
      // Nothing was created or destroyed by that, but a request that is about to
      // be refused has no business moving anything.
      //
      // Pets are enhanceable and always have been — the client has offered it
      // for every slot since long before this handler existed (canEnh in
      // js/ui.js is a pure enhance < max test), and players hold pets at +3
      // and above that were enhanced back when the roll happened client-side.
      // Excluding them here made every one of those attempts fail, which is
      // the regression behind the reports about enhancing suddenly breaking.
      if (!ENHANCEABLE_SLOTS.has(target.slot)) {
        return socket.emit('enhanceError', { msg: 'Этот предмет нельзя точить' });
      }

      // The client's placement wins where the two disagree — it is the one the
      // player is looking at — so move the item before the roll below writes the
      // result back. Only the inventory <-> equip-slot direction is reconciled:
      // an item found in a DIFFERENT equip slot than the one named is left where
      // it is (there is nothing sensible to swap it with, and the sync below
      // corrects the client either way). Every move here is one item out of one
      // place and into another, so the totals are unchanged.
      if (slot && targetIdx >= 0) {
        const displaced = eq[slot];
        eq[slot] = target;
        inv.splice(targetIdx, 1);
        if (displaced) inv.push(displaced);   // straight swap, so no slot growth
        session.lastStats.equipment = eq;
        targetIdx = -1;
        targetSlot = slot;
      } else if (!slot && targetSlot && inv.length < SERVER_INV_MAX) {
        eq[targetSlot] = null;
        inv.push(target);
        session.lastStats.equipment = eq;
        targetIdx = inv.length - 1;
        targetSlot = null;
      }

      const stoneId = stoneType === 'bless' ? 'bless_stone' : 'norm_stone';
      const stoneIdx = inv.findIndex(s => s && s.id === stoneId && (s.qty || 1) > 0);
      if (stoneIdx < 0) return socket.emit('enhanceError', { msg: 'Нет камня заточки' });

      const stoneItem = inv[stoneIdx];
      if ((stoneItem.qty || 1) <= 1) {
        inv.splice(stoneIdx, 1);
        if (!targetSlot && stoneIdx < targetIdx) targetIdx--;
      } else {
        stoneItem.qty--;
      }

      // Mirrors _enhSuccessRate (js/ui.js) exactly.
      const rate = Math.max(10, 80 - curEnh * 10);
      const success = Math.random() * 100 < rate;
      let outcome, newEnhance = curEnh;
      if (success) {
        target.enhance = curEnh + 1;
        newEnhance = curEnh + 1;
        outcome = 'success';
      } else if (stoneType === 'bless') {
        outcome = 'fail'; // safe stone: item survives a miss
      } else {
        outcome = 'burned'; // normal stone: item is destroyed on a miss
        if (targetSlot) session.lastStats.equipment[targetSlot] = null;
        else inv.splice(targetIdx, 1);
      }

      // Equipment goes along unconditionally: the reconciliation above can have
      // moved the item even when the roll targeted a loose one, and the client
      // rebuilds both halves from this sync — sending only the inventory would
      // leave the two disagreeing again the moment they were made to agree.
      commitServerItems(inv, session.lastStats.equipment || {}, 'enhance',
        { id, stoneType, outcome, fromEnhance: curEnh, slot: targetSlot || null }, { beforeLen: _beforeLen });
      // Season points for a successful enhance. The rarity is re-read from the
      // catalog rather than taken off the entry, so a crafted request cannot
      // claim a common item is worth an uncommon's points. A miss pays nothing.
      if (outcome === 'success') {
        const _eb = _catalogBase(id);
        const _ep = _eb ? (SEASON_ENHANCE_POINTS[_eb.rarity] || 0) : 0;
        if (_ep > 0 && seasonActive()) {
          seasonAddPoints(_ep, 'enhance', { id, rarity: _eb.rarity, to: newEnhance })
            .then(total => socket.emit('seasonEventDone', { task: 'enhance', points: _ep, total: total ?? null }));
        }
      }
      // targetSlot, not the requested slot: it names where the item actually
      // ended up, which is what the client reopens the modal on.
      socket.emit('enhanceResult', { id, slot: targetSlot || null, outcome, newEnhance });
    });

    // ── Box crafting (Кузнец → Материалы → Боксы, e.g. box_rare from key_rare) ──
    // No currency involved — just an exchange of keys for a box, 100% success —
    // but this was still entirely client-computed (js/npc.js's craftBox),
    // reaching the server only via the next saveProgress blob. Synchronous, no
    // await anywhere, so — like enhanceItem above — there's no window for a
    // double-submit race to land in.
    safeOn('craftBox', ({ boxId } = {}) => {
      if (!session.authed) return;
      const box = BOX_DEF.find(b => b.id === boxId);
      if (!box) return socket.emit('craftBoxError', { msg: 'Неизвестный бокс' });
      if (!session.lastStats || !Array.isArray(session.lastStats.inventory)) {
        return socket.emit('craftBoxError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
      }
      if (itemsBusy()) return socket.emit('craftBoxError', { msg: ITEMS_BUSY_MSG });
      const inv = session.lastStats.inventory;
      const _beforeLen = inv.length;
      const countOf = id => inv.reduce((s, i) => s + (i && i.id === id ? (i.qty || 1) : 0), 0);
      const have = countOf(box.keyId);
      if (have < box.keyCost) {
        const keyName = (CRAFT_MATS.find(m => m.id === box.keyId) || {}).name || box.keyId;
        return socket.emit('craftBoxError', { msg: `Нужно ${box.keyCost} × ${keyName} (есть ${have})` });
      }
      // A box stacks into an existing entry for free — a new slot is only
      // needed for the first one, same rule _shopNewSlots uses.
      const hasBoxAlready = inv.some(i => i && i.id === box.id);
      if (!hasBoxAlready && inv.length >= SERVER_INV_MAX) {
        return socket.emit('craftBoxError', { msg: 'Инвентарь полон' });
      }
      let left = box.keyCost;
      for (let i = inv.length - 1; i >= 0 && left > 0; i--) {
        const e = inv[i];
        if (!e || e.id !== box.keyId) continue;
        const qty = e.qty || 1;
        if (qty > left) { e.qty = qty - left; left = 0; }
        else { left -= qty; inv.splice(i, 1); }
      }
      _invAdd(inv, { ...box, qty: 1 });
      commitServerItems(inv, null, 'box_craft', { boxId }, { beforeLen: _beforeLen });
      socket.emit('boxCrafted', { boxId });
    });

    // ── Material tier-up (Кузнец → Материалы → Рецепты, e.g. recu→recr) ────────
    // 20 of the lower recipe scroll → 80% chance at 1 of the next tier —
    // MAT_UPGRADE_RECIPES, shared/definitions.js. Same closing as craftBox
    // above: was entirely client-computed (js/npc.js's craftMatUpgrade), no
    // currency involved, synchronous handler so no double-submit race window.
    safeOn('craftMatUpgrade', ({ from } = {}) => {
      if (!session.authed) return;
      const rec = MAT_UPGRADE_RECIPES.find(r => r.from === from);
      if (!rec) return socket.emit('craftMatUpgradeError', { msg: 'Неизвестный рецепт' });
      const toMat = CRAFT_MATS.find(m => m.id === rec.to);
      if (!toMat) return socket.emit('craftMatUpgradeError', { msg: 'Материал не найден' });
      if (!session.lastStats || !Array.isArray(session.lastStats.inventory)) {
        return socket.emit('craftMatUpgradeError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
      }
      if (itemsBusy()) return socket.emit('craftMatUpgradeError', { msg: ITEMS_BUSY_MSG });
      const inv = session.lastStats.inventory;
      const _beforeLen = inv.length;
      const countOf = id => inv.reduce((s, i) => s + (i && i.id === id ? (i.qty || 1) : 0), 0);
      const have = countOf(rec.from);
      if (have < rec.count) {
        const fromMat = CRAFT_MATS.find(m => m.id === rec.from);
        return socket.emit('craftMatUpgradeError', {
          msg: `Нужно ${rec.count} × ${fromMat ? fromMat.name : rec.from} (есть ${have})`,
        });
      }
      const hasToAlready = inv.some(i => i && i.id === toMat.id);
      if (!hasToAlready && inv.length >= SERVER_INV_MAX) {
        return socket.emit('craftMatUpgradeError', { msg: 'Инвентарь полон' });
      }
      let left = rec.count;
      for (let i = inv.length - 1; i >= 0 && left > 0; i--) {
        const e = inv[i];
        if (!e || e.id !== rec.from) continue;
        const qty = e.qty || 1;
        if (qty > left) { e.qty = qty - left; left = 0; }
        else { left -= qty; inv.splice(i, 1); }
      }
      const success = Math.random() < rec.chance;
      if (success) _invAdd(inv, { ...toMat, qty: 1 });
      commitServerItems(inv, null, 'mat_upgrade', { from: rec.from, to: rec.to, success }, { beforeLen: _beforeLen });
      socket.emit('matUpgraded', { from: rec.from, to: rec.to, success });
    });

    // ── Loot box opening (inventory item modal → "Открыть") ─────────────────────
    // Rolls a rarity off the box's own odds table, then a random gear item
    // within that rarity — the exact two-step roll js/ui.js's openLootBox used
    // to do itself (weighted rarity, then uniform pick among that rarity's
    // craft-only gear pool), reaching the server only via the next saveProgress
    // blob. The server now owns both rolls and the grant; the pool mirrors
    // _boxCandidates (js/ui.js) exactly — no cloak/artifact (craft-only), and a
    // weapon only comes up for the buyer's own class.
    safeOn('openLootBox', ({ id } = {}) => {
      if (!session.authed) return;
      const boxDef = BOX_DEF.find(b => b.id === id);
      if (!boxDef) return socket.emit('openBoxError', { msg: 'Неизвестный бокс' });
      if (!session.lastStats || !Array.isArray(session.lastStats.inventory)) {
        return socket.emit('openBoxError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
      }
      // The one synchronous item handler that never got this check. Both halves
      // of an open — spending the box and adding the prize — land in the LIVE
      // inventory, so a clone-and-commit handler holding a snapshot from before
      // them stamps BOTH away when it commits: the box comes back (openable
      // again, for another free roll) and the prize the client was already told
      // about is gone. See _itemsBusy.
      if (itemsBusy()) return socket.emit('openBoxError', { msg: ITEMS_BUSY_MSG });
      const inv = session.lastStats.inventory;
      const _beforeLen = inv.length;
      const boxIdx = inv.findIndex(i => i && i.id === id);
      if (boxIdx < 0) return socket.emit('openBoxError', { msg: 'Бокс не найден' });

      // The box is spent whether or not the pool below turns out to have
      // anything in it — same "spent regardless of outcome" rule every other
      // recipe here follows.
      const boxItem = inv[boxIdx];
      if ((boxItem.qty || 1) <= 1) inv.splice(boxIdx, 1);
      else boxItem.qty--;

      const r = Math.random();
      let acc = 0, resultRarity = boxDef.odds[boxDef.odds.length - 1].rarity;
      for (const o of boxDef.odds) {
        acc += o.chance;
        if (r < acc) { resultRarity = o.rarity; break; }
      }

      const charClass = session.lastStats.type || 'lev';
      const gearSlots = ['weapon', 'helmet', 'body', 'gloves', 'boots', 'ring', 'belt'];
      const cands = ITEM_DEF.filter(d => d.rarity === resultRarity && !d.noDrop && gearSlots.includes(d.slot) &&
        (d.slot !== 'weapon' || (d.forClass && d.forClass.includes(charClass))));
      const wonItem = cands.length ? cands[Math.floor(Math.random() * cands.length)] : null;
      const granted = wonItem ? _invAdd(inv, { ...wonItem }) : false;

      commitServerItems(inv, null, 'box_open', { boxId: id, wonItemId: wonItem ? wonItem.id : null, granted }, { beforeLen: _beforeLen });
      socket.emit('boxOpened', { boxId: id, item: granted ? wonItem : null });
    });

    // ── Pet crafting (Кузнец → Материалы → Питомцы) ────────────────────────────
    // Costs Liberty (Nexum), which — unlike gold — is server-granted/server-
    // authoritative only (see _nexumBalanceCache above), so unlike every other
    // craft in this game this can't be a client-computed spend: the client
    // would just be trusted to decrement a balance it doesn't actually own the
    // source of truth for. Mirrors gramShopBuy below: server checks the live
    // balance, deducts it, and picks+returns the random result itself — the
    // client only ever displays what this event reports back.
    safeOn('craftPet', async ({ rarity } = {}) => {
      if (!session.authed) return;
      // _itemOpBusy, like every other handler that holds an inventory across an
      // await: this one was the only craft without it, so a saveProgress landing
      // between the balance spend and the commit below could replace _lastStats
      // wholesale and have the grant stamped back over it.
      beginItemOp();
      let _ran;
      try {
      // Serialized like the other spend handlers — the charge below is a DB
      // round trip, and two crafts overlapping across it would interleave their
      // inventory writes.
      _ran = await withEconLock(async () => {
      try {
        const rec = PET_CRAFT_RECIPES.find(r => r.rarity === rarity);
        if (!rec) return socket.emit('petCraftError', { msg: 'Неизвестная редкость питомца' });
        if (!session.lastStats || !Array.isArray(session.lastStats.inventory)) {
          return socket.emit('petCraftError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
        }
        if (session.lastStats.inventory.length >= SERVER_INV_MAX) {
          return socket.emit('petCraftError', { msg: 'Инвентарь полон' });
        }
        const _beforeLen = session.lastStats.inventory.length;
        const candidates = ITEM_DEF.filter(d => d.slot === 'pet' && d.rarity === rarity);
        if (!candidates.length) return socket.emit('petCraftError', { msg: 'Питомцы этой редкости не найдены' });

        // Atomic charge — the roll below only happens if the Liberty was really
        // taken. A failed craft (rec.chance) still costs, as it always has.
        await flushBalances();
        const _bal = await spendBalance(session.authed.telegramId, 'nexumBalance', rec.nexumCost);
        if (_bal === null) return socket.emit('petCraftError', { msg: 'Недостаточно Liberty' });
        session.nexum = _bal;

        let resultPet = null;
        if (Math.random() < rec.chance) {
          resultPet = { ...candidates[Math.floor(Math.random() * candidates.length)] };
        }

        // Cross-session guard, same as craftGear/craftClassGear already have and
        // this one was missing: the Liberty spend above is a DB round trip, and
        // if the account reconnected on a different socket during it, this
        // closure's _lastStats belongs to a session nobody's client can see.
        // Committing through it would drop the pet into the void AND — via
        // _commitServerItems' unconditional persist — write this dead session's
        // inventory over whatever the live one has saved since.
        if (activeSessions.get(session.authed.telegramId) !== socket.id) {
          const _target = socketForTelegramId(session.authed.telegramId);
          if (!_target || !_target.data._applyGrant) {
            // Nothing live to grant into. Refund rather than charge for a pet
            // that cannot be delivered — the roll is re-done on the retry.
            const back = await incBalance(session.authed.telegramId, 'nexumBalance', rec.nexumCost);
            if (back !== null) session.nexum = back;
            return socket.emit('petCraftError', { msg: 'Сессия недоступна — попробуйте ещё раз' });
          }
          const _res = _target.data._applyGrant(
            resultPet ? { addItems: [{ item: resultPet }] } : {},
            'pet_craft_cross_session', { rarity, cost: rec.nexumCost, got: resultPet ? resultPet.id : null });
          _target.emit('petCrafted', {
            pet: resultPet, newNexumBalance: session.nexum, delivered: !!_res && !!resultPet,
          });
          return;
        }

        const _delivered = resultPet ? _invAdd(session.lastStats.inventory, resultPet) : false;
        commitServerItems(session.lastStats.inventory, null, 'pet_craft',
          { rarity, cost: rec.nexumCost, got: resultPet ? resultPet.id : null }, { beforeLen: _beforeLen });

        socket.emit('petCrafted', {
          pet: resultPet, newNexumBalance: session.nexum, delivered: _delivered,
        });
      } catch (err) {
        console.error('craftPet:', err);
        logPlayerErr(session.authed.telegramId, session.authed.username, 'pet_craft', err, { rarity });
        socket.emit('petCraftError', { msg: 'Ошибка сервера' });
      }
      });
      } finally {
        endItemOp();
      }
      if (!_ran) socket.emit('petCraftError', { msg: ITEMS_BUSY_MSG });
    });

    // ── Class cloak/artifact crafting (Кузнец → Материалы → Плащи и артефакты
    // классов) ──────────────────────────────────────────────────────────────
    // Costs Liberty on top of salvaging junk gear of the target rarity
    // (CLASS_GEAR_SALVAGE_RECIPES, shared/definitions.js) — same reasoning as
    // craftStone/craftGear above: Liberty is server-authoritative, so the whole
    // exchange (material count + Liberty charge + random item grant) has to
    // happen here rather than being client-computed.
    safeOn('craftClassGear', async ({ slot, rarity } = {}) => {
      if (!session.authed) return;
      beginItemOp();
      let _ran;
      try {
      _ran = await withEconLock(async () => {
      try {
        const rec = CLASS_GEAR_SALVAGE_RECIPES.find(r => r.resultSlot === slot && r.resultRarity === rarity);
        if (!rec) return socket.emit('craftClassGearError', { msg: 'Неизвестный рецепт' });
        const candidates = ITEM_DEF.filter(d => d.classItem && d.slot === rec.resultSlot && d.rarity === rec.resultRarity);
        if (!candidates.length) return socket.emit('craftClassGearError', { msg: 'Предметы этой редкости не найдены' });
        if (!session.lastStats || !Array.isArray(session.lastStats.inventory)) {
          return socket.emit('craftClassGearError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
        }
        const inv = session.lastStats.inventory;
        const _beforeLen = inv.length;
        if (inv.length >= SERVER_INV_MAX) {
          return socket.emit('craftClassGearError', { msg: 'Инвентарь полон' });
        }
        // Salvage material: any non-stackable item of the matching rarity —
        // same "junk gear" definition the client's inventory panel uses.
        const matCount = () => inv.reduce((s, i) => s + (i && !isStackableItem(i) && i.rarity === rec.costRarity ? 1 : 0), 0);
        if (matCount() < rec.costCount) {
          return socket.emit('craftClassGearError', { msg: `Нужно ${rec.costCount} предметов редкости «${rec.costRarity}» (есть ${matCount()})` });
        }
        // Charged before anything is consumed, and atomically — see craftStone.
        await flushBalances();
        const _bal = await spendBalance(session.authed.telegramId, 'nexumBalance', rec.nexumCost);
        if (_bal === null) {
          return socket.emit('craftClassGearError', { msg: `Нужно ${rec.nexumCost} Liberty` });
        }
        session.nexum = _bal;
        // Re-checked after the await, same reasoning as craftStone/craftGear.
        if (matCount() < rec.costCount) {
          const back = await incBalance(session.authed.telegramId, 'nexumBalance', rec.nexumCost);
          if (back !== null) session.nexum = back;
          return socket.emit('craftClassGearError', { msg: `Нужно ${rec.costCount} предметов редкости «${rec.costRarity}» (есть ${matCount()})` });
        }
        const resultItem = { ...candidates[Math.floor(Math.random() * candidates.length)] };
        const _removeMats = (liveInv) => {
          let left = rec.costCount;
          for (let i = liveInv.length - 1; i >= 0 && left > 0; i--) {
            const e = liveInv[i];
            if (e && !isStackableItem(e) && e.rarity === rec.costRarity) { liveInv.splice(i, 1); left--; }
          }
        };

        // Cross-session guard, same reasoning as craftGear above: the nexumCost
        // spend just awaited may have outlasted this socket's session.
        if (activeSessions.get(session.authed.telegramId) !== socket.id) {
          const _target = socketForTelegramId(session.authed.telegramId);
          const _items = _target && _target.data._adminReadItems ? _target.data._adminReadItems().inventory : null;
          if (!_target || !Array.isArray(_items)) {
            const back = await incBalance(session.authed.telegramId, 'nexumBalance', rec.nexumCost);
            if (back !== null) session.nexum = back;
            return socket.emit('craftClassGearError', { msg: 'Сессия недоступна — попробуйте ещё раз' });
          }
          const _cnt = _items.reduce((s, i) => s + (i && !isStackableItem(i) && i.rarity === rec.costRarity ? 1 : 0), 0);
          if (_cnt < rec.costCount) {
            const back = await incBalance(session.authed.telegramId, 'nexumBalance', rec.nexumCost);
            if (back !== null) session.nexum = back;
            return socket.emit('craftClassGearError', { msg: `Нужно ${rec.costCount} предметов редкости «${rec.costRarity}» (есть ${_cnt})` });
          }
          const _res = _target.data._applyCraftResult(_removeMats, resultItem,
            'class_gear_craft_cross_session', { slot: rec.resultSlot, rarity: rec.resultRarity, cost: rec.nexumCost, got: resultItem.id });
          _target.emit('classGearCrafted', {
            item: resultItem, newNexumBalance: session.nexum, delivered: _res ? _res.delivered : false,
          });
          return;
        }

        _removeMats(inv);
        const _delivered = _invAdd(inv, resultItem);
        commitServerItems(inv, null, 'class_gear_craft',
          { slot: rec.resultSlot, rarity: rec.resultRarity, cost: rec.nexumCost, got: resultItem.id }, { beforeLen: _beforeLen });
        socket.emit('classGearCrafted', { item: resultItem, newNexumBalance: session.nexum, delivered: _delivered });
      } catch (err) {
        console.error('craftClassGear:', err);
        logPlayerErr(session.authed.telegramId, session.authed.username, 'class_gear_craft', err, { slot, rarity });
        socket.emit('craftClassGearError', { msg: 'Ошибка сервера' });
      }
      });
      } finally {
        endItemOp();
      }
      if (!_ran) socket.emit('craftClassGearError', { msg: ITEMS_BUSY_MSG });
    });

};
