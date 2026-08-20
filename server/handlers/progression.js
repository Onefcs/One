'use strict';
// Learned progression — skills, passives, the "вторая профессия" advanced
// skills — and Перерождение (rebirth), which trades a level-60 character for
// bonus skill points and starts it over.
//
// Seventh cut into io.on('connection'), on the same `session` object as the
// rest. It reads session.lastStats 96 times, more than any other module: every
// skill level, passive level and upgrade point lives in that blob, and
// saveProgress replaces it wholesale, so a captured copy would go stale on the
// player's next autosave rather than at some exotic race.
//
// Exports nothing.
const {
  ITEM_DEF, CRAFT_MATS, BOX_DEF, CHAR_DEF,
  SKILL_MAX_LEVEL, PASSIVE_MAX_LEVEL, passiveDefById,
  SKILL_STUDY_COST, SKILL_UPGRADE_COST, SKILL_UPGRADE_CHANCE, ADV_SKILL_STUDY_COST,
  skillBookId, advSkillBookId, passiveBookId, UPGRADE_KEYS, upgradeCost,
  skillPointBudget, xpToNext,
  REBIRTH_LEVEL, REBIRTH_BONUS_SP, REBIRTH_COST,
} = require('../../shared/definitions');

// The four ability slots every class has (SKILL_DEF, js/definitions.js).
const SKILL_SLOTS = ['Q', 'W', 'E', 'R'];

// See createGuildWar (server/events/guildwar.js) for why this is checked.
const REQUIRED_DEPS = [
  'socket', 'safeOn', 'logPlayer', 'logPlayerErr', 'session',
  'itemsBusy', 'beginItemOp', 'endItemOp', 'ITEMS_BUSY_MSG',
  'commitServerItems', 'liveInventory', 'persistSavedFields',
  'serverSpendGold', 'withEconLock',
];

module.exports = function registerProgressionHandlers(deps) {
  const missing = REQUIRED_DEPS.filter(k => !deps || deps[k] == null);
  if (missing.length) throw new Error(`registerProgressionHandlers: missing deps: ${missing.join(', ')}`);
  const {
    socket, safeOn, logPlayer, logPlayerErr, session,
    itemsBusy, beginItemOp, endItemOp, ITEMS_BUSY_MSG,
    commitServerItems, liveInventory, persistSavedFields,
    serverSpendGold, withEconLock,
  } = deps;

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
      if (!session.lastStats) return null;
      if (!session.lastStats.skillLevels    || typeof session.lastStats.skillLevels    !== 'object') session.lastStats.skillLevels = {};
      if (!session.lastStats.passiveLevels  || typeof session.lastStats.passiveLevels  !== 'object') session.lastStats.passiveLevels = {};
      if (!session.lastStats.advSkillLearned|| typeof session.lastStats.advSkillLearned!== 'object') session.lastStats.advSkillLearned = {};
      if (!session.lastStats.advSkillActive || typeof session.lastStats.advSkillActive !== 'object') session.lastStats.advSkillActive = {};
      return session.lastStats;
    }

    // Pushes the authoritative maps to the client. The client merges them
    // forward and never writes them itself any more, so this is the only way a
    // studied level ever reaches the character sheet.
    function _pushProgress() {
      socket.emit('progressSync', {
        upgrades:        session.lastStats.upgrades,
        skillLevels:     session.lastStats.skillLevels,
        passiveLevels:   session.lastStats.passiveLevels,
        advSkillLearned: session.lastStats.advSkillLearned,
        advSkillActive:  session.lastStats.advSkillActive,
      });
    }

    // Counts, then spends, `need` copies of a book. Returns false (and changes
    // nothing) when the player hasn't got them, so every caller can check and
    // charge in one step and can't half-apply.
    function _spendBooks(bookId, need) {
      const inv = liveInventory();
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
      commitServerItems(inv, null, 'books', { book: bookId, n: need }, { beforeLen });
      return true;
    }

    function _progressErr(msg) { socket.emit('progressError', { msg }); }

    // Persist just the progression fields. Cheap enough to do per action — these
    // are a handful of small maps, and an action the player paid books for must
    // not wait on the 3s save debounce to become durable.
    function _persistLearned() {
      persistSavedFields(session.authed, {
        skillLevels: session.lastStats.skillLevels, passiveLevels: session.lastStats.passiveLevels,
        advSkillLearned: session.lastStats.advSkillLearned, advSkillActive: session.lastStats.advSkillActive,
      });
      if (session.room) session.room.updatePlayerSavedData(socket.id, session.lastStats);
    }

    safeOn('learnSkill', ({ key } = {}) => {
      if (!session.authed || !_learnedMaps()) return;
      if (!SKILL_SLOTS.includes(key)) return;
      const cls = session.lastStats.type;
      if (!CHAR_DEF[cls]) return _progressErr('Класс не выбран');
      if ((session.lastStats.skillLevels[key] || 0) > 0) return;   // already studied
      if (!_spendBooks(skillBookId(cls, key), SKILL_STUDY_COST)) return _progressErr('Нужна книга навыка!');
      session.lastStats.skillLevels[key] = 1;
      _persistLearned();
      logPlayer(session.authed.telegramId, session.authed.username, 'skill_study', { key });
      _pushProgress();
    });

    safeOn('upgradeSkill', ({ key } = {}) => {
      if (!session.authed || !_learnedMaps()) return;
      if (!SKILL_SLOTS.includes(key)) return;
      const cls = session.lastStats.type;
      if (!CHAR_DEF[cls]) return _progressErr('Класс не выбран');
      const lvl = session.lastStats.skillLevels[key] || 0;
      if (lvl <= 0) return _progressErr('Сначала изучите навык!');
      if (lvl >= SKILL_MAX_LEVEL) return;
      if (!_spendBooks(skillBookId(cls, key), SKILL_UPGRADE_COST)) return _progressErr('Не хватает книг!');
      // Rolled HERE, not on the client. A client-side roll is a client-side
      // decision: re-rolling until it succeeds costs nothing to implement.
      const ok = Math.random() < SKILL_UPGRADE_CHANCE;
      if (ok) session.lastStats.skillLevels[key] = lvl + 1;
      _persistLearned();
      logPlayer(session.authed.telegramId, session.authed.username, 'skill_upgrade', { key, from: lvl, ok });
      socket.emit('upgradeRolled', { kind: 'skill', key, ok, level: session.lastStats.skillLevels[key] });
      _pushProgress();
    });

    safeOn('learnPassive', ({ id } = {}) => {
      if (!session.authed || !_learnedMaps()) return;
      const cls = session.lastStats.type;
      if (!passiveDefById(cls, id)) return;                 // not a passive this class has
      if ((session.lastStats.passiveLevels[id] || 0) > 0) return;  // already studied
      if (!_spendBooks(passiveBookId(id), SKILL_STUDY_COST)) return _progressErr('Нужна книга этой пассивки!');
      session.lastStats.passiveLevels[id] = 1;
      _persistLearned();
      logPlayer(session.authed.telegramId, session.authed.username, 'passive_study', { id });
      _pushProgress();
    });

    safeOn('upgradePassive', ({ id } = {}) => {
      if (!session.authed || !_learnedMaps()) return;
      const cls = session.lastStats.type;
      if (!passiveDefById(cls, id)) return;
      const lvl = session.lastStats.passiveLevels[id] || 0;
      if (lvl <= 0) return _progressErr('Сначала изучите пассивку!');
      if (lvl >= PASSIVE_MAX_LEVEL) return;
      if (!_spendBooks(passiveBookId(id), SKILL_UPGRADE_COST)) return _progressErr('Не хватает книг!');
      const ok = Math.random() < SKILL_UPGRADE_CHANCE;
      if (ok) session.lastStats.passiveLevels[id] = lvl + 1;
      _persistLearned();
      logPlayer(session.authed.telegramId, session.authed.username, 'passive_upgrade', { id, from: lvl, ok });
      socket.emit('upgradeRolled', { kind: 'passive', id, ok, level: session.lastStats.passiveLevels[id] });
      _pushProgress();
    });

    safeOn('learnAdvSkill', ({ key } = {}) => {
      if (!session.authed || !_learnedMaps()) return;
      if (!SKILL_SLOTS.includes(key)) return;
      const cls = session.lastStats.type;
      if (!CHAR_DEF[cls]) return _progressErr('Класс не выбран');
      // The slot has to be maxed first — the client greys the button out, but
      // that is advice, not a rule, until it is checked here.
      if ((session.lastStats.skillLevels[key] || 0) < SKILL_MAX_LEVEL) return _progressErr('Навык не прокачан до максимума');
      if (session.lastStats.advSkillLearned[key]) return;
      if (!_spendBooks(advSkillBookId(cls, key), ADV_SKILL_STUDY_COST)) return _progressErr('Не хватает книг!');
      session.lastStats.advSkillLearned[key] = true;
      _persistLearned();
      logPlayer(session.authed.telegramId, session.authed.username, 'adv_skill_learn', { key });
      _pushProgress();
    });

    // Free either way — but it decides which variant's damage the server applies
    // (_skillMultFor, server/game/Room.js), so it has to be the server's copy
    // that changes, not a field the client writes into its next save.
    safeOn('toggleAdvSkill', ({ key } = {}) => {
      if (!session.authed || !_learnedMaps()) return;
      if (!SKILL_SLOTS.includes(key)) return;
      if (!session.lastStats.advSkillLearned[key]) return;
      session.lastStats.advSkillActive[key] = !session.lastStats.advSkillActive[key];
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
      if (!session.authed || !session.lastStats) return;
      if (!UPGRADE_KEYS.includes(key)) return;
      beginItemOp();
      let _ran;
      try {
      // Serialized — the budget/gold checks below read _lastStats.upgrades,
      // then `await _serverSpendGold`, and only THEN write upgrades[key] off a
      // `lvl` captured before that await. Nothing previously stopped a second
      // spendUpgrade (any key) from starting in that window: it would read the
      // exact same pre-write upgrades map, so the SAME budget check passed
      // twice for keys A and B that individually fit but together exceed it —
      // a free stat point past skillPointBudget. Racing the SAME key instead
      // just double-charged gold for one committed level, since both writers
      // computed `lvl+1` off the same stale `lvl`. See _withEconLock.
      _ran = await withEconLock(async () => {
        if (!session.lastStats.upgrades || typeof session.lastStats.upgrades !== 'object') session.lastStats.upgrades = {};
        const u = session.lastStats.upgrades;
        const lvl = Math.max(0, Math.floor(Number(u[key])) || 0);
        const cost = upgradeCost(lvl);
        // Exactly the budget getAvailableSkillPoints (js/player.js) shows, from
        // the same shared function — so the button and the rule cannot disagree.
        const spent = UPGRADE_KEYS.reduce((sum, k) => sum + Math.max(0, Math.floor(Number(u[k])) || 0), 0);
        const budget = skillPointBudget(session.lastStats.lvl, session.lastStats.rebirths) + (session.lastStats.bonusSP || 0);
        if (budget - spent < 1) return socket.emit('progressError', { msg: 'Мало очков навыка!' });
        if ((Math.floor(Number(session.lastStats.gold)) || 0) < cost) {
          return socket.emit('progressError', { msg: 'Мало золота!' });
        }
        // Charges, persists the new balance and pushes goldSync.
        await serverSpendGold(cost, 'upgrade:' + key);
        if (!session.lastStats.upgrades || typeof session.lastStats.upgrades !== 'object') session.lastStats.upgrades = {};
        session.lastStats.upgrades[key] = lvl + 1;
        persistSavedFields(session.authed, { upgrades: session.lastStats.upgrades });
        if (session.room) session.room.updatePlayerSavedData(socket.id, session.lastStats);
        logPlayer(session.authed.telegramId, session.authed.username, 'stat_upgrade', { key, to: lvl + 1, cost });
        socket.emit('progressSync', { upgrades: session.lastStats.upgrades });
      });
      } finally {
        endItemOp();
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
    // _lastStats in one synchronous pass, which is also why it needs none of
    // their cross-session-during-an-await machinery (nothing yields between
    // the mat check and the mutation, so activeSessions/_lastStats can't have
    // moved out from under it).
    safeOn('rebirth', () => {
      if (!session.authed) return;
      try {
        if (!session.lastStats || !Array.isArray(session.lastStats.inventory)) {
          return socket.emit('rebirthError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
        }
        const lvl = Math.floor(Number(session.lastStats.lvl)) || 1;
        if (lvl < REBIRTH_LEVEL) {
          return socket.emit('rebirthError', { msg: `Нужен ${REBIRTH_LEVEL} уровень` });
        }
        if (itemsBusy()) return socket.emit('rebirthError', { msg: ITEMS_BUSY_MSG });
        const inv = session.lastStats.inventory;
        const _beforeLen = inv.length;
        const matCount = id => inv.reduce((s, i) => s + (i && i.id === id ? (i.qty || 1) : 0), 0);
        const matName = id => (ITEM_DEF.find(i => i.id === id) || CRAFT_MATS.find(i => i.id === id) || BOX_DEF.find(i => i.id === id) || {}).name || id;
        for (const [id, need] of Object.entries(REBIRTH_COST)) {
          const have = matCount(id);
          if (have < need) {
            return socket.emit('rebirthError', { msg: `Нужно ${need} × ${matName(id)} (есть ${have})` });
          }
        }
        // All four cost items stack (BOX_DEF/CRAFT_MATS' box/recipe slots —
        // isStackableItem, shared/definitions.js), so a plain qty-decrement
        // pass covers every one of them — no enhanced-item matching needed,
        // unlike craftGear's mats (which can carry a minEnhance).
        for (const [id, need] of Object.entries(REBIRTH_COST)) {
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
        // curve resets. That only works without the anti-cheat upgrades-budget
        // check (_sanitizeSavedStats) wiping them right back out on the very
        // next save: it drops the WHOLE upgrades map the instant spent exceeds
        // skillPointBudget(lvl, rebirths) + bonusSP, and post-rebirth that
        // budget is 0 until level REBIRTH_LEVEL again. So bonusSP has to cover
        // at least what's currently spent, or the very next save would erase
        // the upgrades this whole mechanic just promised to keep.
        //
        // getAvailableSkillPoints (js/player.js) computes available = budget +
        // bonusSP - spent — bonusSP is a credit line the anti-cheat check reads
        // against, not a wallet that depletes as points are spent, so spent
        // itself never leaves player.upgrades. max(oldBonus, spentSP) is the
        // floor that keeps that credit line covering the kept spend (whichever
        // of the two actually needs covering), and REBIRTH_BONUS_SP is then
        // added on top of that floor — unconditionally, every rebirth — so the
        // advertised flat reward (rebirthDesc/rebirthConfirmBody: "+15 forever")
        // always lands instead of being absorbed whenever spentSP alone already
        // exceeded oldBonus + REBIRTH_BONUS_SP.
        //
        // Summing spentSP on top of a bonusSP that ALREADY covered that same
        // spend (oldBonus + spentSP, as an earlier version of this line did)
        // inflated `available` by the full spentSP a second time: rebirthing
        // and then immediately hitting "Сбросить" on Улучшения handed back
        // spentSP points nobody ever earned, on top of the ones already
        // invested and kept. Taking max() of the two first, then adding the
        // flat reward once, avoids that double count while still always paying
        // the reward.
        //
        // An even earlier version banked the whole pre-reset BUDGET instead of
        // what was spent, which handed every UNSPENT level point too and then
        // paid that out a second time once REBIRTH_LEVEL was reclimbed and the
        // curve resumed — every rebirth was worth 105 points instead of the
        // flat REBIRTH_BONUS_SP. That's why spentSP, not budget, is one of the
        // two terms max() picks from here.
        //
        // Clamped to the pre-reset budget as a belt-and-braces measure: every
        // save has already been through the check above, so upgrades can't
        // exceed it, and a bad one must not be able to mint bonusSP here.
        const _oldBonus  = Math.max(0, Math.floor(Number(session.lastStats.bonusSP)) || 0);
        const _oldBudget = skillPointBudget(lvl, session.lastStats.rebirths || 0);
        const _spentSP = Math.min(
          Object.values(session.lastStats.upgrades || {})
            .reduce((s, v) => s + Math.max(0, Math.floor(Number(v)) || 0), 0),
          _oldBudget + _oldBonus);
        const _cd = CHAR_DEF[session.lastStats.type] || CHAR_DEF.lev;
        session.lastStats.lvl = 1;
        session.lastStats.xp = 0;
        session.lastStats.xpNext = xpToNext(1);
        // Same derivation _sanitizeSavedStats uses for baseAtk/baseDef/
        // baseMaxHp at any level — here that's simply the class's own raw
        // CHAR_DEF numbers, since lvl-1 is 0 at level 1.
        session.lastStats.baseAtk = _cd.baseAtk;
        session.lastStats.baseDef = _cd.baseDef;
        session.lastStats.baseMaxHp = _cd.baseHP;
        session.lastStats.bonusSP = Math.max(_oldBonus, _spentSP) + REBIRTH_BONUS_SP;
        session.lastStats.rebirths = (session.lastStats.rebirths || 0) + 1;
        session.lastStats.inventory = inv;

        // Keep the room's anti-cheat baseline in step, or its computeStats
        // would go on crediting the pre-rebirth level until the next
        // saveProgress (same reasoning as resetUpgrades above).
        if (session.room) session.room.updatePlayerSavedData(socket.id, session.lastStats);
        // Emits inventorySync with the post-cost inventory —
        // rebirthDone below deliberately carries no inventory field of its own,
        // same "already landed via inventorySync" shape as craftGear/boxOpened.
        commitServerItems(inv, null, 'rebirth', { rebirths: session.lastStats.rebirths }, { beforeLen: _beforeLen });
        persistSavedFields(session.authed, {
          lvl: 1, xp: 0, xpNext: session.lastStats.xpNext,
          baseAtk: session.lastStats.baseAtk, baseDef: session.lastStats.baseDef, baseMaxHp: session.lastStats.baseMaxHp,
          bonusSP: session.lastStats.bonusSP, rebirths: session.lastStats.rebirths,
        });
        logPlayer(session.authed.telegramId, session.authed.username, 'rebirth', {
          rebirths: session.lastStats.rebirths, fromLvl: lvl,
          // What the rebirth actually cost and paid in points — the one line
          // that makes a later "my skill points changed" report answerable.
          spentSP: _spentSP, bonusSP: `${_oldBonus} -> ${session.lastStats.bonusSP}`,
        });
        socket.emit('rebirthDone', {
          lvl: 1, xp: 0, xpNext: session.lastStats.xpNext,
          baseAtk: session.lastStats.baseAtk, baseDef: session.lastStats.baseDef, baseMaxHp: session.lastStats.baseMaxHp,
          upgrades: session.lastStats.upgrades || {}, bonusSP: session.lastStats.bonusSP, rebirths: session.lastStats.rebirths,
        });
      } catch (err) {
        console.error('rebirth:', err);
        logPlayerErr(session.authed.telegramId, session.authed.username, 'rebirth', err, {});
        socket.emit('rebirthError', { msg: 'Ошибка сервера' });
      }
    });

};
