'use strict';
// skills: the safeOn handlers moved out of server/index.js verbatim, with
// the closure helpers only this domain used.
//
// Per-connection, so this takes the session object rather than the plain deps
// bag the server/game/*.js factories use — see server/handlers/market.js for
// the reasoning. `s.*` is every piece of connection state index.js reassigns
// after this module is wired; everything stable is destructured below under
// its original name, which is what keeps the moved bodies byte-identical.
module.exports = function registerSkills(s, safeOn, deps) {
  const {
    ADV_SKILL_STUDY_COST, BOX_DEF, CHAR_DEF, CRAFT_MATS, FLOOR_IDS, ITEM_DEF,
    PASSIVE_MAX_LEVEL, REBIRTH_BONUS_SP, REBIRTH_LEVEL,
    SEASON_REBIRTH_POINTS, SKILL_MAX_LEVEL, SKILL_SLOTS, SKILL_STUDY_COST,
    SKILL_UPGRADE_CHANCE, SKILL_UPGRADE_COST, UPGRADE_KEYS,
    UPGRADE_RESET_COST, _persistSavedFields, _spendBalance, advSkillBookId,
    availableSkillPoints, logPlayer, logPlayerErr, passiveBookId, passiveDefById,
    rebirthCostFor, seasonActive, skillBookId, skillPointBudget, spentSkillPoints,
    upgradeCost, xpToNext,
  } = deps;

  const {
    _ITEMS_BUSY_MSG, _commitServerItems, _flushBalances, _itemsBusy,
    _liveInventory, _seasonAddPoints, _serverSpendGold, _withEconLock,
    socket,
  } = s;

    // ── Reset stat upgrades (Улучшения → Сбросить) ─────────────────────────────
    // Costs Liberty, so the charge has to happen here: Liberty is the one
    // currency the client doesn't own the source of truth for (see craftPet
    // below for the same reasoning).
    //
    // Clearing player.upgrades is all a "refund" needs to be — spent points are
    // never stored, they're derived as skillPointBudget(lvl, rebirths) +
    // bonusSP minus the sum of the upgrade levels (getAvailableSkillPoints,
    // js/player.js). Emptying the map therefore hands back every point ever
    // put into it, however many that was.
    // Gold spent on those upgrades is deliberately not refunded.
    safeOn('resetUpgrades', async () => {
      if (!s.authed) return;
      s.itemOpBusy++;
      let _ran;
      try {
      // Serialized like gramShopBuy/craftGear — spent is read here and the
      // upgrades map is only cleared after two awaits, so two resets sent in
      // the same tick both saw a nonzero spent, both charged UPGRADE_RESET_COST
      // (each atomically affordable on its own), and both then cleared the same
      // already-empty map: a real double-charge for a single reset. See
      // _withEconLock.
      _ran = await _withEconLock(async () => {
      try {
        const cur = (s.lastStats && s.lastStats.upgrades) || {};
        const spent = Object.values(cur).reduce((s, v) => s + (Number(v) || 0), 0);
        if (spent <= 0) {
          return socket.emit('resetUpgradesError', { msg: 'Улучшений нет — сбрасывать нечего' });
        }
        await _flushBalances();
        // Charged atomically: the write only happens if the balance covers the
        // cost, so the upgrades below are never cleared for free.
        const _bal = await _spendBalance(s.authed.telegramId, 'nexumBalance', UPGRADE_RESET_COST);
        if (_bal === null) {
          return socket.emit('resetUpgradesError', { msg: `Нужно ${UPGRADE_RESET_COST} Liberty` });
        }
        s.nexumBalance = _bal;
        // A reset gives back every point in the map — all `spent` of them,
        // whatever paid for them. Clearing the map alone does not do that for a
        // character carrying points across a rebirth: keptSP is the part of the
        // spend the rebirth carried, availableSkillPoints subtracts it from
        // both sides of the sum, and ending the commitment with the map takes
        // the carried points with it. That is what returned 30 of 120 points to
        // a character freshly out of a rebirth.
        //
        // So the carried part is banked into bonusSP on the way out — but only
        // the share the current level curve does NOT already cover. Past that
        // the curve pays for those points itself, and banking them as well
        // would hand the same points over twice. With the split done this way
        // the answer is exactly `spent` at every level, which is the whole
        // point: what went in comes back out.
        const _budget = skillPointBudget(
          s.lastStats && s.lastStats.lvl, s.lastStats && s.lastStats.rebirths);
        const _kept = Math.min(
          Math.max(0, Math.floor(Number(s.lastStats && s.lastStats.keptSP)) || 0), spent);
        const _bonusSP = Math.max(0, Math.floor(Number(s.lastStats && s.lastStats.bonusSP)) || 0)
          + Math.max(0, _kept - _budget);
        const _before = availableSkillPoints(s.lastStats);
        if (s.lastStats) {
          s.lastStats.upgrades = {};
          s.lastStats.keptSP = 0;
          s.lastStats.bonusSP = _bonusSP;
        }
        // Still measured rather than assumed: this is what the character can
        // actually spend now, and it is `spent` because of the bank above.
        const _returned = Math.max(0, availableSkillPoints(s.lastStats) - _before);
        // Keep the room's anti-cheat baseline in step, or its computeStats would
        // go on crediting the cleared upgrades until the next saveProgress.
        if (s.currentRoom) s.currentRoom.updatePlayerSavedData(socket.id, s.lastStats);
        _persistSavedFields(s.authed, { upgrades: {}, keptSP: 0, bonusSP: _bonusSP });
        logPlayer(s.authed.telegramId, s.authed.username, 'upgrades_reset',
          { pointsReturned: _returned, spent, cost: UPGRADE_RESET_COST, bonusSP: _bonusSP });
        socket.emit('upgradesReset', {
          pointsReturned: _returned, keptSP: 0, bonusSP: _bonusSP,
          newNexumBalance: s.nexumBalance,
        });
      } catch (err) {
        console.error('resetUpgrades:', err);
        socket.emit('resetUpgradesError', { msg: 'Ошибка сервера' });
      }
      });
      } finally {
        s.itemOpBusy--;
      }
      if (!_ran) socket.emit('resetUpgradesError', { msg: 'Операция уже выполняется' });
    });

    // ── Learned progression (skills, passives, "вторая профессия") ────────────
    // These used to be decided entirely by the client: it checked the books,
    // removed them, rolled the upgrade chance, wrote the new level into
    // player.skillLevels/passiveLevels and let the next debounced saveProgress
    // carry the result. The server's only involvement was accepting whatever
    // arrived. That is what every rollback report traced back to — a save
    // composed before a study landing after it, a save dropped while an item op
    // held the inventory, a reconnect resending a stale in-memory blob — and it
    // also meant a modified client could simply write itself max levels.
    //
    // Now the client asks and the server decides: it counts the books out of its
    // own inventory copy, rolls the chance itself, applies the level and answers
    // with progressSync (plus the inventorySync _commitServerItems already
    // sends). Nothing about the outcome is ever read back off the save blob —
    // see _sanitizeSavedStats, which pins these fields to the server's copy.
    function _learnedMaps() {
      if (!s.lastStats) return null;
      if (!s.lastStats.skillLevels    || typeof s.lastStats.skillLevels    !== 'object') s.lastStats.skillLevels = {};
      if (!s.lastStats.passiveLevels  || typeof s.lastStats.passiveLevels  !== 'object') s.lastStats.passiveLevels = {};
      if (!s.lastStats.advSkillLearned|| typeof s.lastStats.advSkillLearned!== 'object') s.lastStats.advSkillLearned = {};
      if (!s.lastStats.advSkillActive || typeof s.lastStats.advSkillActive !== 'object') s.lastStats.advSkillActive = {};
      return s.lastStats;
    }

    // Pushes the authoritative maps to the client. The client merges them
    // forward and never writes them itself any more, so this is the only way a
    // studied level ever reaches the character sheet.
    function _pushProgress() {
      socket.emit('progressSync', {
        upgrades:        s.lastStats.upgrades,
        skillLevels:     s.lastStats.skillLevels,
        passiveLevels:   s.lastStats.passiveLevels,
        advSkillLearned: s.lastStats.advSkillLearned,
        advSkillActive:  s.lastStats.advSkillActive,
      });
    }

    // Counts, then spends, `need` copies of a book. Returns false (and changes
    // nothing) when the player hasn't got them, so every caller can check and
    // charge in one step and can't half-apply.
    function _spendBooks(bookId, need) {
      const inv = _liveInventory();
      if (!Array.isArray(inv)) return false;
      const have = inv.reduce((s, i) => s + (i && i.id === bookId ? (i.qty || 1) : 0), 0);
      if (have < need) return false;
      const beforeLen = inv.length;
      let left = need;
      for (let i = inv.length - 1; i >= 0 && left > 0; i--) {
        const e = inv[i];
        if (!e || e.id !== bookId) continue;
        const q = e.qty || 1;
        if (q > left) { e.qty = q - left; left = 0; }
        else { left -= q; inv.splice(i, 1); }
      }
      _commitServerItems(inv, null, 'books', { book: bookId, n: need }, { beforeLen });
      return true;
    }

    function _progressErr(msg) { socket.emit('progressError', { msg }); }

    // Persist just the progression fields. Cheap enough to do per action — these
    // are a handful of small maps, and an action the player paid books for must
    // not wait on the 3s save debounce to become durable.
    function _persistLearned() {
      _persistSavedFields(s.authed, {
        skillLevels: s.lastStats.skillLevels, passiveLevels: s.lastStats.passiveLevels,
        advSkillLearned: s.lastStats.advSkillLearned, advSkillActive: s.lastStats.advSkillActive,
      });
      if (s.currentRoom) s.currentRoom.updatePlayerSavedData(socket.id, s.lastStats);
    }

    safeOn('learnSkill', ({ key } = {}) => {
      if (!s.authed || !_learnedMaps()) return;
      if (!SKILL_SLOTS.includes(key)) return;
      const cls = s.lastStats.type;
      if (!CHAR_DEF[cls]) return _progressErr('Класс не выбран');
      if ((s.lastStats.skillLevels[key] || 0) > 0) return;   // already studied
      if (!_spendBooks(skillBookId(cls, key), SKILL_STUDY_COST)) return _progressErr('Нужна книга навыка!');
      s.lastStats.skillLevels[key] = 1;
      _persistLearned();
      logPlayer(s.authed.telegramId, s.authed.username, 'skill_study', { key });
      _pushProgress();
    });

    safeOn('upgradeSkill', ({ key } = {}) => {
      if (!s.authed || !_learnedMaps()) return;
      if (!SKILL_SLOTS.includes(key)) return;
      const cls = s.lastStats.type;
      if (!CHAR_DEF[cls]) return _progressErr('Класс не выбран');
      const lvl = s.lastStats.skillLevels[key] || 0;
      if (lvl <= 0) return _progressErr('Сначала изучите навык!');
      if (lvl >= SKILL_MAX_LEVEL) return;
      if (!_spendBooks(skillBookId(cls, key), SKILL_UPGRADE_COST)) return _progressErr('Не хватает книг!');
      // Rolled HERE, not on the client. A client-side roll is a client-side
      // decision: re-rolling until it succeeds costs nothing to implement.
      const ok = Math.random() < SKILL_UPGRADE_CHANCE;
      if (ok) s.lastStats.skillLevels[key] = lvl + 1;
      _persistLearned();
      logPlayer(s.authed.telegramId, s.authed.username, 'skill_upgrade', { key, from: lvl, ok });
      socket.emit('upgradeRolled', { kind: 'skill', key, ok, level: s.lastStats.skillLevels[key] });
      _pushProgress();
    });

    safeOn('learnPassive', ({ id } = {}) => {
      if (!s.authed || !_learnedMaps()) return;
      const cls = s.lastStats.type;
      if (!passiveDefById(cls, id)) return;                 // not a passive this class has
      if ((s.lastStats.passiveLevels[id] || 0) > 0) return;  // already studied
      if (!_spendBooks(passiveBookId(id), SKILL_STUDY_COST)) return _progressErr('Нужна книга этой пассивки!');
      s.lastStats.passiveLevels[id] = 1;
      _persistLearned();
      logPlayer(s.authed.telegramId, s.authed.username, 'passive_study', { id });
      _pushProgress();
    });

    safeOn('upgradePassive', ({ id } = {}) => {
      if (!s.authed || !_learnedMaps()) return;
      const cls = s.lastStats.type;
      if (!passiveDefById(cls, id)) return;
      const lvl = s.lastStats.passiveLevels[id] || 0;
      if (lvl <= 0) return _progressErr('Сначала изучите пассивку!');
      if (lvl >= PASSIVE_MAX_LEVEL) return;
      if (!_spendBooks(passiveBookId(id), SKILL_UPGRADE_COST)) return _progressErr('Не хватает книг!');
      const ok = Math.random() < SKILL_UPGRADE_CHANCE;
      if (ok) s.lastStats.passiveLevels[id] = lvl + 1;
      _persistLearned();
      logPlayer(s.authed.telegramId, s.authed.username, 'passive_upgrade', { id, from: lvl, ok });
      socket.emit('upgradeRolled', { kind: 'passive', id, ok, level: s.lastStats.passiveLevels[id] });
      _pushProgress();
    });

    safeOn('learnAdvSkill', ({ key } = {}) => {
      if (!s.authed || !_learnedMaps()) return;
      if (!SKILL_SLOTS.includes(key)) return;
      const cls = s.lastStats.type;
      if (!CHAR_DEF[cls]) return _progressErr('Класс не выбран');
      // The slot has to be maxed first — the client greys the button out, but
      // that is advice, not a rule, until it is checked here.
      if ((s.lastStats.skillLevels[key] || 0) < SKILL_MAX_LEVEL) return _progressErr('Навык не прокачан до максимума');
      if (s.lastStats.advSkillLearned[key]) return;
      if (!_spendBooks(advSkillBookId(cls, key), ADV_SKILL_STUDY_COST)) return _progressErr('Не хватает книг!');
      s.lastStats.advSkillLearned[key] = true;
      _persistLearned();
      logPlayer(s.authed.telegramId, s.authed.username, 'adv_skill_learn', { key });
      _pushProgress();
    });

    // Free either way — but it decides which variant's damage the server applies
    // (_skillMultFor, server/game/Room.js), so it has to be the server's copy
    // that changes, not a field the client writes into its next save.
    safeOn('toggleAdvSkill', ({ key } = {}) => {
      if (!s.authed || !_learnedMaps()) return;
      if (!SKILL_SLOTS.includes(key)) return;
      if (!s.lastStats.advSkillLearned[key]) return;
      s.lastStats.advSkillActive[key] = !s.lastStats.advSkillActive[key];
      _persistLearned();
      _pushProgress();
    });

    // A stat upgrade: one skill point and some gold for one point in a stat.
    // Same reasoning as the learn/upgrade handlers above — this used to be a
    // purely client-side deduction (upgradeStats, js/player.js) carried by the
    // next save, so both the point and the gold were whatever the client said
    // they were. The budget check that existed server-side (_sanitizeSavedStats)
    // could only drop the WHOLE upgrades map after the fact when the totals
    // stopped adding up; this refuses the individual purchase instead.
    safeOn('spendUpgrade', async ({ key } = {}) => {
      if (!s.authed || !s.lastStats) return;
      if (!UPGRADE_KEYS.includes(key)) return;
      s.itemOpBusy++;
      let _ran;
      try {
      // Serialized — the budget/gold checks below read s.lastStats.upgrades,
      // then `await _serverSpendGold`, and only THEN write upgrades[key] off a
      // `lvl` captured before that await. Nothing previously stopped a second
      // spendUpgrade (any key) from starting in that window: it would read the
      // exact same pre-write upgrades map, so the SAME budget check passed
      // twice for keys A and B that individually fit but together exceed it —
      // a free stat point past skillPointBudget. Racing the SAME key instead
      // just double-charged gold for one committed level, since both writers
      // computed `lvl+1` off the same stale `lvl`. See _withEconLock.
      _ran = await _withEconLock(async () => {
        if (!s.lastStats.upgrades || typeof s.lastStats.upgrades !== 'object') s.lastStats.upgrades = {};
        const u = s.lastStats.upgrades;
        const lvl = Math.max(0, Math.floor(Number(u[key])) || 0);
        const cost = upgradeCost(lvl);
        // Exactly the number getAvailableSkillPoints (js/player.js) shows, from
        // the same shared function — so the button and the rule cannot disagree.
        if (availableSkillPoints(s.lastStats) < 1) {
          return socket.emit('progressError', { msg: 'Мало очков навыка!' });
        }
        if ((Math.floor(Number(s.lastStats.gold)) || 0) < cost) {
          return socket.emit('progressError', { msg: 'Мало золота!' });
        }
        // Charges, persists the new balance and pushes goldSync.
        await _serverSpendGold(cost, 'upgrade:' + key);
        if (!s.lastStats.upgrades || typeof s.lastStats.upgrades !== 'object') s.lastStats.upgrades = {};
        s.lastStats.upgrades[key] = lvl + 1;
        _persistSavedFields(s.authed, { upgrades: s.lastStats.upgrades });
        if (s.currentRoom) s.currentRoom.updatePlayerSavedData(socket.id, s.lastStats);
        logPlayer(s.authed.telegramId, s.authed.username, 'stat_upgrade', { key, to: lvl + 1, cost });
        socket.emit('progressSync', { upgrades: s.lastStats.upgrades });
      });
      } finally {
        s.itemOpBusy--;
      }
      if (!_ran) socket.emit('progressError', { msg: 'Секунду, повторите' });
    });

    // ── Перерождение (Rebirth) ──────────────────────────────────────────────
    // Level REBIRTH_LEVEL+ only: resets level/xp back to a fresh character —
    // player.upgrades (stat points already spent) is deliberately left alone,
    // see the bonusSP banking below — in exchange for a flat, permanent
    // REBIRTH_BONUS_SP. skillPointBudget (shared/definitions.js) is what then
    // keeps levelling from handing out NEW points again until level
    // REBIRTH_LEVEL is reached a second time (getAvailableSkillPoints/the
    // upgrades-budget check above both call it, so client and server can't
    // disagree on the result).
    //
    // Pure item cost (REBIRTH_COST) — no Liberty spend — so unlike craftGear/
    // resetUpgrades this never awaits a balance call: everything here runs off
    // s.lastStats in one synchronous pass, which is also why it needs none of
    // their cross-session-during-an-await machinery (nothing yields between
    // the mat check and the mutation, so activeSessions/s.lastStats can't have
    // moved out from under it). The materials themselves can also be bought
    // outright with GRAM from the shop's own Перерождение tab (rmat1-3 in
    // _GRAM_SHOP_PKGS below, via the ordinary gramShopBuy) — that only grants
    // items into the inventory, it never performs the rebirth itself.
    safeOn('rebirth', () => {
      if (!s.authed) return;
      try {
        if (!s.lastStats || !Array.isArray(s.lastStats.inventory)) {
          return socket.emit('rebirthError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
        }
        const lvl = Math.floor(Number(s.lastStats.lvl)) || 1;
        if (lvl < REBIRTH_LEVEL) {
          return socket.emit('rebirthError', { msg: `Нужен ${REBIRTH_LEVEL} уровень` });
        }
        // Hub-only, same as the teleport-home check above (:7303) reads
        // s.currentFloor against this exact constant. Keeps a rebirth from firing
        // mid-run in a dungeon/instance — a boss pull, a party mid-fight, an
        // event zone — where a level-1 reset lands the player (and whoever they
        // were with) somewhere they can no longer survive or belong.
        if (s.currentFloor !== FLOOR_IDS.hub) {
          return socket.emit('rebirthError', { msg: 'Перерождение доступно только в Зале' });
        }
        if (_itemsBusy()) return socket.emit('rebirthError', { msg: _ITEMS_BUSY_MSG });
        const inv = s.lastStats.inventory;
        const _beforeLen = inv.length;
        const matCount = id => inv.reduce((s, i) => s + (i && i.id === id ? (i.qty || 1) : 0), 0);
        const matName = id => (ITEM_DEF.find(i => i.id === id) || CRAFT_MATS.find(i => i.id === id) || BOX_DEF.find(i => i.id === id) || {}).name || id;
        // Every 5th rebirth costs double (rebirthCostFor, shared/definitions.js)
        // — based on the rebirth about to happen (current rebirths + 1), not
        // the count already banked.
        const _cost = rebirthCostFor(s.lastStats.rebirths || 0);
        for (const [id, need] of Object.entries(_cost)) {
          const have = matCount(id);
          if (have < need) {
            return socket.emit('rebirthError', { msg: `Нужно ${need} × ${matName(id)} (есть ${have})` });
          }
        }
        // All four cost items stack (BOX_DEF/CRAFT_MATS' box/recipe slots —
        // isStackableItem, shared/definitions.js), so a plain qty-decrement
        // pass covers every one of them — no enhanced-item matching needed,
        // unlike craftGear's mats (which can carry a minEnhance).
        for (const [id, need] of Object.entries(_cost)) {
          let left = need;
          for (let i = inv.length - 1; i >= 0 && left > 0; i--) {
            const e = inv[i];
            if (!e || e.id !== id) continue;
            const have = e.qty || 1;
            if (have > left) { e.qty = have - left; left = 0; }
            else { left -= have; inv.splice(i, 1); }
          }
        }

        // Улучшения (player.upgrades) are kept, not cleared — only the level
        // curve resets. Two things have to be true for that to work, and
        // keptSP is what makes them both true at once (the whole rule is
        // written out in shared/definitions.js's skill point accounting
        // block):
        //
        //  • The anti-cheat upgrades check (_sanitizeSavedStats) must not wipe
        //    the map on the very next save. It drops the WHOLE map the instant
        //    spent exceeds the ceiling, and a level-1 character's own curve is
        //    0 until REBIRTH_LEVEL again — so the kept spend is recorded in
        //    keptSP, which skillPointCeiling adds to that ceiling.
        //
        //  • A rebirth must be worth exactly REBIRTH_BONUS_SP, no more. That
        //    is what bonusSP alone could not do: topping it up to cover the
        //    kept spend (Math.max(oldBonus, spentSP) + REBIRTH_BONUS_SP, as
        //    this line did until now) left the banked spend sitting in a
        //    credit line that availableSkillPoints reads as capacity — so once
        //    REBIRTH_LEVEL was re-climbed the curve paid for those same points
        //    a SECOND time (a free 90 at level 30, on top of the 15), and a
        //    single Улучшения → Сбросить handed the whole banked total over as
        //    spendable. Earlier versions were worse still: one summed the
        //    spend on top of a bonus that already covered it, and the first
        //    banked the entire pre-reset BUDGET, unspent points included.
        //    bonusSP now only ever grows by the flat reward.
        //
        // keptSP is capped at what the ending life's own level curve was
        // worth: past that, the spend was paid for out of bonusSP, which
        // survives the reset on its own and must not be shielded twice. The
        // clamp also means a bad stored map can never mint capacity here.
        const _oldBonus  = Math.max(0, Math.floor(Number(s.lastStats.bonusSP)) || 0);
        const _oldKept   = Math.max(0, Math.floor(Number(s.lastStats.keptSP)) || 0);
        const _oldBudget = skillPointBudget(lvl, s.lastStats.rebirths || 0);
        const _spentSP = Math.min(
          spentSkillPoints(s.lastStats.upgrades),
          _oldBudget + _oldBonus + _oldKept);
        const _cd = CHAR_DEF[s.lastStats.type] || CHAR_DEF.lev;
        s.lastStats.lvl = 1;
        s.lastStats.xp = 0;
        s.lastStats.xpNext = xpToNext(1);
        // Same derivation _sanitizeSavedStats uses for baseAtk/baseDef/
        // baseMaxHp at any level — here that's simply the class's own raw
        // CHAR_DEF numbers, since lvl-1 is 0 at level 1.
        s.lastStats.baseAtk = _cd.baseAtk;
        s.lastStats.baseDef = _cd.baseDef;
        s.lastStats.baseMaxHp = _cd.baseHP;
        s.lastStats.bonusSP = _oldBonus + REBIRTH_BONUS_SP;
        s.lastStats.keptSP = Math.min(_spentSP, _oldBudget);
        s.lastStats.rebirths = (s.lastStats.rebirths || 0) + 1;
        s.lastStats.inventory = inv;

        // Keep the room's anti-cheat baseline in step, or its computeStats
        // would go on crediting the pre-rebirth level until the next
        // saveProgress (same reasoning as resetUpgrades above).
        if (s.currentRoom) s.currentRoom.updatePlayerSavedData(socket.id, s.lastStats);
        // Emits inventorySync with the post-cost inventory —
        // rebirthDone below deliberately carries no inventory field of its own,
        // same "already landed via inventorySync" shape as craftGear/boxOpened.
        _commitServerItems(inv, null, 'rebirth', { rebirths: s.lastStats.rebirths }, { beforeLen: _beforeLen });
        _persistSavedFields(s.authed, {
          lvl: 1, xp: 0, xpNext: s.lastStats.xpNext,
          baseAtk: s.lastStats.baseAtk, baseDef: s.lastStats.baseDef, baseMaxHp: s.lastStats.baseMaxHp,
          bonusSP: s.lastStats.bonusSP, keptSP: s.lastStats.keptSP, rebirths: s.lastStats.rebirths,
        });
        logPlayer(s.authed.telegramId, s.authed.username, 'rebirth', {
          rebirths: s.lastStats.rebirths, fromLvl: lvl,
          // What the rebirth actually cost and paid in points — the one line
          // that makes a later "my skill points changed" report answerable.
          spentSP: _spentSP, keptSP: `${_oldKept} -> ${s.lastStats.keptSP}`,
          bonusSP: `${_oldBonus} -> ${s.lastStats.bonusSP}`,
          availableSP: availableSkillPoints(s.lastStats),
        });
        socket.emit('rebirthDone', {
          lvl: 1, xp: 0, xpNext: s.lastStats.xpNext,
          baseAtk: s.lastStats.baseAtk, baseDef: s.lastStats.baseDef, baseMaxHp: s.lastStats.baseMaxHp,
          upgrades: s.lastStats.upgrades || {}, bonusSP: s.lastStats.bonusSP,
          keptSP: s.lastStats.keptSP, rebirths: s.lastStats.rebirths,
        });
        if (seasonActive()) {
          _seasonAddPoints(SEASON_REBIRTH_POINTS, 'rebirth', { rebirths: s.lastStats.rebirths })
            .then(total => { if (total !== null) socket.emit('seasonEventDone', { task: 'rebirth', points: SEASON_REBIRTH_POINTS, total }); });
        }
      } catch (err) {
        console.error('rebirth:', err);
        logPlayerErr(s.authed.telegramId, s.authed.username, 'rebirth', err, {});
        socket.emit('rebirthError', { msg: 'Ошибка сервера' });
      }
    });
};
