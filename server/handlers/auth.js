'use strict';
// auth: the safeOn handlers moved out of server/index.js verbatim, with
// the closure helpers only this domain used.
//
// Per-connection, so this takes the session object rather than the plain deps
// bag the server/game/*.js factories use — see server/handlers/market.js for
// the reasoning. `s.*` is every piece of connection state index.js reassigns
// after this module is wired; everything stable is destructured below under
// its original name, which is what keeps the moved bodies byte-identical.
module.exports = function registerAuth(s, safeOn, deps) {
  const {
    CHAR_DEF, ClanModel, FLOOR_IDS, GRAM_WALLET, PlayerModel, Room,
    TG_ADMIN_ID, _a3Broadcast, _buildGameStartPayload, _clanDataFor,
    _coopGroupDropOnDisconnect, _dbBroadcast, _farm2EjectOnDisconnect,
    _farm2GroupDropOnDisconnect, _fear, _fearDisconnectGrace, _fearStartWave,
    _gramBalanceCache, _logWritesSinceTrim, _maintenanceMode,
    _nexumBalanceCache, _notifyAdminNewPlayer, _partyDisconnectGrace,
    _partyHoldOnDisconnect, _pendingFlush, _persistSavedFields,
    _publicChatHistory, _pvpEliminate, _pvpHistoryWritesSinceTrim,
    _race10Broadcast, _reclaimQueues, _recordSessionEnd, _refLink,
    _registerReferral, _restoreFloorFor, _safeUsername, _sanitizeSavedStats,
    _setVipAura, _teleportCasting, _topPlayerUsername, _trackFearRoom,
    _unknownItemIds, _vipAuraUsers, activeSessions, calcBM, clanAtkBonusPct,
    codexTotalBonus, getRoom, globalChatHistory, io, logPlayer,
    migrateEmpowers, migrateKeptSP,
    parties,
    playerFloorMap, playerParty, safeInterval, safeTimeout,
    verifyTelegramAuth, verifyTelegramWebApp,
  } = deps;

  const {
    _ITEMS_BUSY_MSG, _goldNow, _itemErr, _itemsBusy, _schedulePersist,
    _seasonCheckRefFriend, _setGram, _setNexum, _wherePlayerIs, socket,
  } = s;

    // When this connection opened — read by the disconnect handler to bucket
    // how long sessions actually last (see _sessionStats). A world that
    // "reloads itself" is a client reconnecting: the reconnect re-runs
    // selectChar, and gameStart rebuilds the world from scratch on the client
    // (js/network.js). So the question behind that report is always "why did
    // the socket go away", and until now the server threw away the one field
    // that answers it.
    const _connectedAt = Date.now();

    // Every safeguard in this file (rate-limit buckets, brute-force locks,
    // cache eviction...) assumes a socket either authenticates or goes away
    // quickly — nothing ever bounded how long an UNauthenticated one can sit
    // open. transports:['websocket'] (see the Server() options above) means a
    // raw WebSocket handshake alone opens a connection here with no HTTP
    // request/response round trip to rate-limit separately, so a script that
    // just connects and never sends loginTelegram(WebApp) could hold sockets
    // (and their fds) open indefinitely, for free, with no cap. Real clients
    // authenticate within a second or two of connecting; this is generous
    // slack on top of that, not a tight budget.
    const _authTimeout = safeTimeout('authTimeout', () => {
      if (!s.authed) socket.disconnect(true);
    }, 20000);

    let _autoSaveInterval = null;

    // Wall-clock time this session last had a save accepted — used by the gold
    // growth cap below (saveProgress). Deliberately server time, not the
    // client's own savedAt: a forged save controls that field just as freely
    // as the gold figure itself, so rate-limiting against it would let the
    // same forgery just claim an earlier savedAt to buy a bigger allowance.
    let _lastSaveAcceptedAt = 0;

    // calcBM (shared/anticheat.js) reads sd.atk/sd.def/sd.maxHp — the FULL,
    // gear-inclusive combat stats — but _buildSaveStats() (js/network.js)
    // never sends those fields at all, in any saveProgress call, ever; only
    // baseAtk/baseDef (pre-equipment) reach _sanitizeSavedStats. So calling
    // calcBM directly on s.lastStats/clean silently treated atk/def as 0 for
    // every player: BM collapsed to roughly lvl*50 + maxHp*0.5 the moment
    // their first real saveProgress landed, discarding gear entirely — while
    // the client's own HUD (recompute()'s live, correct atk/def) kept showing
    // the real number. That mismatch is exactly what made the rating look
    // wrong: two players at the same level with wildly different gear ended
    // up with nearly identical stored bm. publicProfile (requestPlayerProfile,
    // further down) never had this bug — it already goes through
    // Room.computeStats for the "Инфо" panel's own BM. This gives calcBM the
    // same authoritative input.
    function _bmStatsFor(sd) {
      const cd = CHAR_DEF[sd.type] || CHAR_DEF.lev;
      const stats = Room.computeStats(sd, cd, sd.type, clanAtkBonusPct(s.myClanLevel));
      return { lvl: sd.lvl, upgrades: sd.upgrades, atk: stats.atk, def: stats.def, maxHp: stats.maxHp };
    }

    // The one composer for every periodic progress write: the debounced one
    // (armed through s._schedulePersist, server/index.js) and the 60s autosave
    // below both land exactly this blob. Installed on socket.data because the
    // scheduler that fires it lives in the other file's closure, and it reads
    // s.lastStats at FIRE time rather than closing over a snapshot — the whole
    // point of a deferred write is that it carries what happened during the
    // delay, not what was true when it was armed.
    socket.data._persistProgressNow = () => {
      if (!s.authed || !s.lastStats) return;
      // Progress only. Balances are moved by $inc from their own paths and must
      // never be written as an absolute from here — that is precisely what let
      // a periodic save undo a credit that arrived seconds earlier.
      const saveData = { ...s.lastStats, ..._wherePlayerIs() };
      if (s.currentRoom) {
        const p = s.currentRoom.players.get(socket.id);
        if (p && p.hp > 0) saveData.hp = p.hp;
      }
      const bmNow = calcBM(_bmStatsFor(s.lastStats));
      s.authed.bm = bmNow;
      _persistSavedFields(s.authed, saveData, { bm: bmNow });
    };

    function _startAutosave() {
      if (_autoSaveInterval) clearInterval(_autoSaveInterval);
      // The backstop, not the primary path any more: a session whose progress
      // nothing else marks dirty (a buff ticking down, a floor that changed
      // and nothing since) still gets written once a minute.
      _autoSaveInterval = safeInterval('autosave', () => {
        socket.data._persistProgressNow();
      }, 60000);
    }

    safeOn('_ping', t0 => socket.emit('_pong', t0));

    // One live session per telegramId: kick whatever socket holds the slot,
    // wait for its save to land, then claim it. Both awaits must complete
    // before the caller's DB read, or that read can return stale data.
    async function _claimSession(telegramId) {
      if (activeSessions.has(telegramId) && activeSessions.get(telegramId) !== socket.id) {
        const _prevSocket = io.sockets.sockets.get(activeSessions.get(telegramId));
        if (_prevSocket) {
          _prevSocket.emit('kicked', { reason: 'Вы вошли с другого устройства' });
          await _prevSocket.data._flushNow?.();
          _prevSocket.disconnect(true);
        }
      }
      // Covers the far more common refresh case: the old socket already
      // disconnected on its own (faster than this page loaded) and its
      // flush is registered here instead of reachable via a live socket.
      const _pending = _pendingFlush.get(telegramId);
      if (_pending) await _pending.catch(() => {});
      activeSessions.set(telegramId, socket.id);
    }

    // The gates every login has to pass, then the connection state it primes.
    // Returns false when the login was refused (the caller has nothing left to
    // do — the authError is already out).
    async function _finishLogin(doc, telegramId, isNewAccount) {
      if (doc.banned) {
        activeSessions.delete(telegramId);
        socket.emit('authError', { message: 'Ваш аккаунт заблокирован' });
        return false;
      }
      if (_maintenanceMode && telegramId !== TG_ADMIN_ID) {
        activeSessions.delete(telegramId);
        socket.emit('authError', { message: 'Ведутся технические работы. Попробуйте позже.' });
        return false;
      }
      // ── One-time repairs for accounts that used Перерождение ─────────────
      // Усиление replaced Перерождение, the feature that reset the level.
      // Both repairs below run here, and not in selectChar: this is the one
      // point every login path passes through, and it lands BEFORE authOk
      // hands the stored record to the client, so the panel never gets a
      // chance to show a stale figure. Both are idempotent — a record that
      // already carries the field is skipped — and both read the raw stored
      // record, which is the only place the old `rebirths` field still lives.
      //
      // 1. The counter. `rebirths` and `empowers` are the same tally, and the
      //    every-5th-costs-double ladder reads the latter, so the count is
      //    carried over rather than restarted (migrateEmpowers).
      const _ascN = doc.savedData ? migrateEmpowers(doc.savedData) : null;
      if (_ascN) {
        doc.savedData.empowers = _ascN.empowers;
        PlayerModel.updateOne({ telegramId },
          { $set: { 'savedData.empowers': _ascN.empowers } }).catch(() => {});
      }
      // 2. The skill points. Records written before keptSP existed carry the
      //    cost of the upgrades a level reset kept inside bonusSP itself,
      //    where availableSkillPoints reads it as spendable capacity — so the
      //    level curve paid for those same points a second time on the way
      //    back up, and a single Улучшения → Сбросить handed the whole banked
      //    total over. migrateKeptSP moves that committed part into keptSP
      //    without changing the sum of the two, so the upgrades map still
      //    clears the anti-cheat ceiling it already passed.
      const _spSplit = doc.savedData ? migrateKeptSP(doc.savedData) : null;
      if (_spSplit) {
        const _wasBonus = Math.max(0, Math.floor(Number(doc.savedData.bonusSP)) || 0);
        doc.savedData.bonusSP = _spSplit.bonusSP;
        doc.savedData.keptSP  = _spSplit.keptSP;
        PlayerModel.updateOne({ telegramId }, { $set: {
          'savedData.bonusSP': _spSplit.bonusSP, 'savedData.keptSP': _spSplit.keptSP,
        } }).catch(() => {});
        if (_spSplit.keptSP) {
          logPlayer(telegramId, doc.username, 'sp_kept_split',
            { bonusSP: `${_wasBonus} -> ${_spSplit.bonusSP}`, keptSP: _spSplit.keptSP });
        }
      }
      s.authed = doc;
      clearTimeout(_authTimeout);
      socket.data.username = doc.username;
      socket.data.telegramId = telegramId;
      if (doc.savedData) s.lastStats = doc.savedData;
      _setGram(doc.savedData?.gramBalance || 0);
      _setNexum(doc.savedData?.nexumBalance || 0);
      // Read once, here, at the one point in the connection's life where the
      // stored record and "current" genuinely mean the same thing. It used to
      // be read again on every selectChar instead (which is idempotent by
      // design — see selectChar's own comment on why a duplicate is always one
      // packet away) off this same s.authed.savedData, which nothing ever
      // refreshes after login. _seasonAddPoints (below) keeps s.seasonPoints
      // itself current as points are earned mid-session — a burn, a special
      // quest, a GRAM purchase, a referral's friend hitting level 20 — so a
      // duplicate/reconnect-retry selectChar landing after any of those was
      // rolling the session's own points display back to whatever they were
      // at login. seasonRating reads s.seasonPoints straight, with no reload
      // of its own, so this is exactly the kind of thing a player would open
      // Рейтинг and see for themselves.
      s.seasonPoints = Math.max(0, Math.floor(Number(doc.savedData?.seasonPoints2) || 0));
      _startAutosave();
      socket.join(`tg_${telegramId}`);
      const _clan = await ClanModel.findOne({ 'members.telegramId': telegramId }).catch(() => null);
      const _clanInfo = _clan ? await _clanDataFor(_clan, telegramId) : null;
      s.myClanName  = _clanInfo ? _clanInfo.name : null;
      s.myClanIcon  = _clanInfo ? _clanInfo.icon : null;
      s.myClanId    = _clan ? String(_clan._id) : null;
      s.myClanLevel = _clanInfo ? _clanInfo.level : null;
      socket.data.vipLevel = doc.savedData?.vipLevel || 0;
      // Server-authoritative like vipLevel just above — stripped from client
      // saves (see _sanitizeSavedStats), read straight off the stored record.
      socket.data.seasonTicketActive = !!doc.savedData?.seasonTicket;
      _setVipAura(doc.username, socket.data.vipLevel);
      socket.emit('authOk', { username: doc.username, savedData: doc.savedData || null, isNewAccount, clanInfo: _clanInfo, gramBalance: s.gramBalance, gramWallet: GRAM_WALLET, refLink: _refLink(telegramId), vipData: { level: doc.savedData?.vipLevel || 0, deposited: doc.savedData?.vipDeposited || 0, pending: doc.savedData?.vipPending || [] }, nexumBalance: s.nexumBalance, topPlayer: _topPlayerUsername, vipAuras: [..._vipAuraUsers], seasonTicketActive: !!doc.savedData?.seasonTicket });
      return true;
    }

    safeOn('loginTelegramWebApp', async ({ initData }) => {
      try {
        const verified = verifyTelegramWebApp(initData);
        if (!verified) return socket.emit('authError', { message: 'Ошибка авторизации Telegram' });
        const { user, startParam } = verified;
        const telegramId = String(user.id);
        const username = _safeUsername(user.username || user.first_name, telegramId);
        await _claimSession(telegramId);
        let doc = await PlayerModel.findOne({ telegramId });
        // isNewAccount tells the client this telegramId has no prior server
        // record — either a genuine first login, or (just as importantly) one
        // that existed before but was deleted from the DB (e.g. by an admin).
        // Either way the client must not resurrect it from its own localStorage
        // save backup — see the authOk handler in js/network.js.
        let isNewAccount = false;
        if (!doc) { doc = await PlayerModel.create({ telegramId, username, savedData: {} }); isNewAccount = true; }
        // startapp=ref_<telegramId> (see _refLink()) opens the Mini App directly
        // with no bot-chat "/start" message ever sent, so this is the only place
        // that referral link is ever registered — the classic bot-chat "/start
        // ref_X" flow in _handleBotMessage is a fallback for anyone who still
        // lands there first (whichever path sees the account first wins).
        if (startParam && startParam.startsWith('ref_')) {
          const referrerUsername = await _registerReferral(telegramId, username, startParam.slice(4), doc);
          if (referrerUsername) _notifyAdminNewPlayer(username, telegramId, referrerUsername).catch(() => {});
        } else if (isNewAccount) {
          _notifyAdminNewPlayer(username, telegramId, null).catch(() => {});
        }
        // Initialise savedData to {} for legacy accounts that still have null —
        // dotted-path $set operations fail on a null parent in MongoDB, silently
        // swallowing quest completions and saves.
        if (!doc.savedData) {
          doc.savedData = {};
          await PlayerModel.updateOne({ telegramId }, { $set: { savedData: {} } }).catch(() => {});
        }
        await _finishLogin(doc, telegramId, isNewAccount);
      } catch (err) {
        console.error('loginTelegramWebApp:', err);
        socket.emit('authError', { message: 'Ошибка сервера' });
      }
    });

    safeOn('loginTelegram', async (data) => {
      try {
        if (!verifyTelegramAuth(data))
          return socket.emit('authError', { message: 'Ошибка авторизации Telegram' });
        const telegramId = String(data.id);
        const username = _safeUsername(data.username || data.first_name, telegramId);
        await _claimSession(telegramId);
        let doc = await PlayerModel.findOne({ telegramId });
        // See the matching comment in loginTelegramWebApp — tells the client
        // not to resurrect a deleted account from its localStorage backup.
        let isNewAccount = false;
        if (!doc) { doc = await PlayerModel.create({ telegramId, username, savedData: {} }); isNewAccount = true; }
        if (!doc.savedData) {
          doc.savedData = {};
          await PlayerModel.updateOne({ telegramId }, { $set: { savedData: {} } }).catch(() => {});
        }
        await _finishLogin(doc, telegramId, isNewAccount);
      } catch (err) {
        console.error('loginTelegram:', err);
        socket.emit('authError', { message: 'Ошибка сервера' });
      }
    });

    // The buff timers run down in real time. The client counts them for its own
    // HUD, but the server needs its own clock or a buff would last forever here —
    // which, for the gold and XP multipliers, is the whole exposure.
    const _buffTick = safeInterval('buffTick', () => {
      if (!s.lastStats || !s.lastStats.buffs) return;
      let changed = false;
      for (const [k, v] of Object.entries(s.lastStats.buffs)) {
        const left = Math.max(0, (Number(v) || 0) - 5);
        if (left !== v) { s.lastStats.buffs[k] = left; changed = true; }
        if (left <= 0) delete s.lastStats.buffs[k];
      }
      if (changed) _persistSavedFields(s.authed, { buffs: s.lastStats.buffs });
    }, 5000);

    // The record every server-owned field below is pinned to. `s.authed` is the
    // document as it was READ AT LOGIN, and nothing ever refreshes it:
    // _persistSavedFields/_persistLearned/_commitServerItems all write through
    // the model (findByIdAndUpdate), not through this document, so
    // s.authed.savedData goes stale the moment anything is studied, spent,
    // granted or picked up. s.lastStats is the session's own live copy and is
    // what every other handler in this file already treats as the truth.
    //
    // On the FIRST selection of a connection the two are the same object
    // (_finishLogin seeds s.lastStats from doc.savedData), so this changes
    // nothing there — including on a reconnect, which is a fresh socket with a
    // fresh read. It only differs on a REPEAT selectChar, and there it is the
    // whole difference between resuming the session and rolling it back to
    // login: pinning to s.authed.savedData handed the client back its login-time
    // skillLevels/passiveLevels/upgrades/gold/xp/items, emitted them as the
    // authoritative progressSync, and then let the next save persist that
    // rollback. A skill studied minutes earlier simply un-learned itself, and
    // the books were already gone. selectChar is a plain client event, so a
    // duplicate is always one packet away — it must be idempotent.
    //
    // specialQuestsDone deliberately still reads s.authed.savedData further down:
    // the sanitizer strips that field outright, and completeSpecialQuest is the
    // one path that DOES keep the document in sync (see its own $ne guard).
    function _sessionBase() { return s.lastStats || s.authed.savedData; }

    safeOn('selectChar', ({ type, savedStats }) => {
      if (!s.authed) return;
      // This handler replaces s.lastStats wholesale further down — the same
      // thing saveProgress does, and the same thing saveProgress is gated
      // against s.itemOpBusy for: a clone-and-commit handler mid-flight is
      // holding a snapshot of the OLD object, and its commit lands on the new
      // one, discarding whatever the re-read brought in.
      //
      // Only a REPEAT selection is refused. s.currentRoom is null until this
      // handler assigns it, so a first join — the only one that can't have an
      // item op in flight anyway, since nothing has run yet — is untouched and
      // login can never be blocked by this. A duplicate arriving while the
      // player is already in the world simply leaves them where they are.
      if (s.currentRoom && _itemsBusy()) return _itemErr(_ITEMS_BUSY_MSG);
      // s.authed.savedData is the DB-loaded record for this account (single save
      // blob, not per-type slots). If the client sent no savedStats — e.g. it
      // raced a fast refresh before its own savedData snapshot arrived — fall
      // back to the server's copy instead of leaving s.lastStats unset, which
      // would let the next debounced saveProgress persist fresh/default stats
      // over real progress.
      //
      // A blank blob used to be a hazard here — a fresh makePlayer() sent by a
      // reconnect that raced ahead of its own restore would become s.lastStats and
      // poison the baseline for the rest of the connection. Every field that
      // mattered is now taken from the stored record below regardless of what
      // arrived, so a blank blob simply has nothing to poison.
      const sanitized = _sanitizeSavedStats(savedStats || null);
      // _sessionBase() rather than s.authed.savedData — see its comment.
      const effectiveSaved = sanitized || _sanitizeSavedStats(_sessionBase() || null);
      // This blob becomes s.lastStats, which is the BASELINE every later
      // saveProgress is checked against — so accepting the client's items and
      // gold here unchecked would simply move the forgery one step earlier and
      // launder it: every subsequent save would then validate cleanly against
      // it. The stored record is the only trustworthy starting point.
      //
      // Nothing legitimate is lost by pinning items to it. Every path that
      // GRANTS an item is server-side and persists immediately through
      // _commitServerItems, so a real grant is already in the DB by the time
      // this runs; only client-side removals/moves (equip, consume) ride the
      // 3s-debounced save, and losing one of those merely means the item is
      // still there. Gold is capped the same way, which costs at most the last
      // few seconds of kill gold on an unclean disconnect — the same window
      // the debounce always risked.
      // Whatever gets corrected below has to reach the client too, or a session
      // that reconnects with a stale/ahead blob (see _isReconnectRejoin in
      // js/network.js — every socket.io reconnect resends the CLIENT's current
      // in-memory stats here, by design, so it doesn't lose the last few
      // unsaved seconds) gets silently rewritten server-side while the client
      // goes right on believing its rejected figures. It then resends those
      // same figures on the very next reconnect, trips the same rejection
      // again, and the desync only ever gets fixed by luck — whichever
      // unrelated saveProgress happens to run its own check first. That's the
      // moment a real, non-cheating player sees an item or a level vanish.
      if (effectiveSaved) {
        const _dbBase = _sanitizeSavedStats(_sessionBase()) || null;
        // Items come from the stored record, full stop — the blob the client
        // sent has no say. Every change to them was applied and persisted
        // server-side as it happened (_commitServerItems), so the record is
        // current even on a reconnect that arrives seconds later, and there is
        // nothing to compare or correct: this is not a rejection, it is simply
        // where the item set lives now.
        effectiveSaved.inventory = (_dbBase && _dbBase.inventory) || [];
        effectiveSaved.equipment = (_dbBase && _dbBase.equipment) || {};
        effectiveSaved.storage   = (_dbBase && _dbBase.storage)   || [];
        // Gold comes from the stored record, like the items above. Every change
        // to it was applied and persisted server-side as it happened, so there
        // is nothing to cap: this is not a correction, it is where the balance
        // lives.
        effectiveSaved.gold = Math.max(0, Math.floor(Number(_dbBase && _dbBase.gold)) || 0);
        // Level and XP come from the stored record, like the items and the gold
        // above — every point of it was applied and persisted server-side as it
        // happened, so there is nothing to check.
        effectiveSaved.lvl       = Math.max(1, Math.floor(Number(_dbBase && _dbBase.lvl)) || 1);
        effectiveSaved.xp        = Math.max(0, Number(_dbBase && _dbBase.xp) || 0);
        // bonusSP/empowers/upgrades are pinned here too, and BEFORE the rebase
        // below, not after: a reconnect's savedStats (_buildSaveStats, js/
        // network.js) never carries these fields at all, so leaving them to the
        // client blob left them undefined/zero for the rest of the session —
        // and the next autosave (clean.bonusSP/empowers/upgrades further down)
        // wrote that zero straight over the real stored totals. Pinning them
        // before the rebase also means the upgrades-budget check inside
        // _sanitizeSavedStats validates the real upgrades against the real
        // bonusSP/empowers/level, instead of clearing them for failing a budget
        // computed off fields that were never actually sent.
        effectiveSaved.bonusSP   = Math.max(0, Math.floor(Number(_dbBase && _dbBase.bonusSP)) || 0);
        // Same pin, same reason — and keptSP has to travel WITH bonusSP: they
        // are two halves of one sum (shared/definitions.js's skill point
        // accounting), so restoring one without the other would either wipe the
        // upgrades a legacy level reset kept or hand their cost back as
        // spendable.
        effectiveSaved.keptSP    = Math.max(0, Math.floor(Number(_dbBase && _dbBase.keptSP)) || 0);
        effectiveSaved.empowers  = Math.max(0, Math.floor(Number(_dbBase && _dbBase.empowers)) || 0);
        effectiveSaved.upgrades  = (_dbBase && _dbBase.upgrades) || {};
        const _rebasedLvl = _sanitizeSavedStats(effectiveSaved);
        effectiveSaved.baseAtk   = _rebasedLvl.baseAtk;
        effectiveSaved.baseDef   = _rebasedLvl.baseDef;
        effectiveSaved.baseMaxHp = _rebasedLvl.baseMaxHp;
        effectiveSaved.xpNext    = _rebasedLvl.xpNext;
        effectiveSaved.upgrades  = _rebasedLvl.upgrades;
        effectiveSaved.keptSP    = _rebasedLvl.keptSP;
        // Quest progress, from the stored record like everything else the server
        // owns — the counters are incremented on this side as the events happen.
        // HP comes from the stored record, not from the blob a reconnect sent.
        // setPlayerChar (Room.js) seats the character at savedStats.hp, so
        // accepting it here meant any client could full-heal on demand simply by
        // reconnecting with hp set to its maximum — bypassing syncPlayerHp's
        // regen limit entirely, mid-boss or mid-PvP.
        effectiveSaved.hp = (_dbBase && _dbBase.hp != null) ? _dbBase.hp : undefined;
        effectiveSaved.questIdx   = Math.max(0, Math.floor(Number(_dbBase && _dbBase.questIdx)) || 0);
        effectiveSaved.questKills = (_dbBase && _dbBase.questKills) || {};
        socket.emit('questSync', { questIdx: effectiveSaved.questIdx, questKills: effectiveSaved.questKills });
        // potionBag/buffs/specialQuestsDone: server-owned exactly like
        // bonusSP/empowers above (see saveProgress's matching pin, further down
        // this file, for why — usePotion spends the bag and persists
        // immediately, and completeSpecialQuest's own once-only DB guard is
        // meaningless if a later save can write its record back). This block
        // used to leave all of them to whatever the client's blob happened to
        // carry, so a reconnect
        // (or a fresh tab reading an older localStorage snapshot) that raced
        // ahead of its own last potion purchase/use sent a bag one or more
        // potions short — and because saveProgress persists s.lastStats.potionBag
        // verbatim a few seconds later, that stale, smaller number became the
        // new permanent total in the database. Same failure shape as the
        // gold/items bug this whole pin block exists to close, just for a field
        // that got missed. Pinning here, and telling the client its real bag
        // right away (a stale reconnect otherwise only found out on its next
        // buy/drink), is what closes it.
        effectiveSaved.potionBag         = (_dbBase && _dbBase.potionBag)         || {};
        effectiveSaved.buffs             = (_dbBase && _dbBase.buffs)             || {};
        // specialQuestsDone specifically: NOT from _dbBase — _sanitizeSavedStats
        // unconditionally `delete`s this field (see its own comment on why: the
        // once-only claim in completeSpecialQuest guards itself with a DB $ne
        // against this very array, so a sanitize pass that let a save merely
        // omit an id would let that quest be claimed again). That means
        // _dbBase.specialQuestsDone is always undefined, and this has to read
        // the raw, untouched DB record instead — same as completeSpecialQuest's
        // own read a little further down this file.
        effectiveSaved.specialQuestsDone = Array.isArray(s.authed.savedData && s.authed.savedData.specialQuestsDone)
          ? s.authed.savedData.specialQuestsDone : [];
        socket.emit('potionBag', { potionBag: effectiveSaved.potionBag });
        // Studied progression comes from the stored record, never from the
        // blob the client sent — see the matching pin in saveProgress. Every
        // change to it was applied and persisted server-side as it happened
        // (_persistLearned), so the record is current even on a reconnect that
        // arrives seconds later, and the client is told what it actually has.
        effectiveSaved.skillLevels     = (_dbBase && _dbBase.skillLevels)     || {};
        effectiveSaved.passiveLevels   = (_dbBase && _dbBase.passiveLevels)   || {};
        effectiveSaved.advSkillLearned = (_dbBase && _dbBase.advSkillLearned) || {};
        effectiveSaved.advSkillActive  = (_dbBase && _dbBase.advSkillActive)  || {};
        // Кодекс progress, same pinning as the progression maps above —
        // server-applied and persisted the moment registerCodexSetItem ran, so
        // a reconnect reads the stored record rather than whatever a stale
        // client blob happened to carry. Also guards against the old (pre-sets)
        // array-shaped codex field — Object.keys of an array just yields index
        // strings codexSetById won't match, so it degrades to an empty bonus
        // instead of throwing.
        const _dbCodex = _dbBase && _dbBase.codex;
        effectiveSaved.codex = (_dbCodex && typeof _dbCodex === 'object' && !Array.isArray(_dbCodex)) ? _dbCodex : {};
        socket.emit('progressSync', {
          upgrades:        effectiveSaved.upgrades,
          skillLevels:     effectiveSaved.skillLevels,
          passiveLevels:   effectiveSaved.passiveLevels,
          advSkillLearned: effectiveSaved.advSkillLearned,
          advSkillActive:  effectiveSaved.advSkillActive,
          // The three fields the Улучшения panel counts points from. A
          // reconnect's own blob carries none of them (they are pinned from the
          // stored record just above), and the login repair further up this
          // file can have changed bonusSP/keptSP since authOk went out — so
          // this is what stops the panel showing a number the server would
          // refuse to sell against.
          bonusSP:         effectiveSaved.bonusSP,
          keptSP:          effectiveSaved.keptSP,
          empowers:        effectiveSaved.empowers,
        });
        socket.emit('codexSync', { codex: effectiveSaved.codex, bonus: codexTotalBonus(effectiveSaved.codex) });
        s.lastStats = effectiveSaved;
        // Baseline for saveProgress's own rate-based gold cap — without this,
        // the time this session spends actually playing before its first
        // autosave (real combat, real gold) would count as zero elapsed
        // server-side time and that first save would be capped down to the
        // same flat slack used here, rejecting gold that was earned honestly.
        _lastSaveAcceptedAt = Date.now();
        // Push every field just pinned above back to the client right away — a
        // reconnect that arrives believing stale/rejected figures (see the
        // comment above this whole block) needs to be told what it actually
        // has, not left to find out on the next unrelated sync.
        socket.emit('inventorySync', {
          inventory: effectiveSaved.inventory, equipment: effectiveSaved.equipment || {},
          storage: effectiveSaved.storage || [],
        });
        socket.emit('goldSync', { gold: effectiveSaved.gold });
        socket.emit('xpSync', {
          lvl: effectiveSaved.lvl, xp: effectiveSaved.xp, xpNext: effectiveSaved.xpNext,
        });
      }
      // Season points: nothing to do here any more — see _finishLogin, which
      // now sets s.seasonPoints exactly once, at login, instead of this
      // handler re-reading (and rolling back) the stale record on every
      // repeat/duplicate selectChar.
      // A friend invited by someone else may have crossed level 20 while this
      // session was away; the check is a no-op below that level and runs at most
      // once per session.
      _seasonCheckRefFriend();
      // Persist the chosen character type immediately so a page refresh
      // before the first full saveProgress doesn't show the char select again.
      PlayerModel.updateOne(
        { telegramId: s.authed.telegramId },
        { $set: { 'savedData.type': type } }
      ).catch(() => {});
      if (!s.currentRoom) {
        // A held Fear run (see _fearDisconnectGrace, above) lives on ITS OWN
        // private Room now (_createFearRoom), not a shared floor lookup —
        // getRoom(FLOOR_IDS.fear) only ever returns the harmless, always-empty
        // static entry every floor gets at boot, never a real run's instance.
        // s.currentFloor's initial value is always the hub (every fresh
        // connection starts there), so without this a reconnecting session
        // would land on the hub instead, and never find its way back to the
        // room actually holding its run. loginTelegramWebApp/selectChar are two
        // separate round trips, so by the time this runs the stale socket's
        // own 'disconnect' handler (which populates _fearDisconnectGrace) has
        // had a full network round trip to complete — reliable in practice,
        // and the worst case if it somehow hasn't is the same as any other
        // missed reconnect window: the run just times out normally.
        const _fearHeld = _fearDisconnectGrace.get(s.authed.telegramId);
        // Everything else comes back to the floor it was standing on — see
        // _restoreFloorFor, which re-checks the level gate and any window rather
        // than trusting the stored number, and falls back to the hub when the
        // floor is no longer somewhere this account may be. Read off the DB
        // record, never off `savedStats`: that blob is the client's. Coop has
        // no equivalent hold to reclaim into (see _coopEjectOnDisconnect) — a
        // reconnecting Coop participant just lands wherever the restore above
        // sends them, same as anyone else whose run already ended.
        if (_fearHeld) s.currentFloor = FLOOR_IDS.fear;
        else s.currentFloor = _restoreFloorFor((s.authed.savedData || {}).floor, effectiveSaved && effectiveSaved.lvl);
        s.currentRoom = _fearHeld ? _fearHeld.run.room : getRoom(s.currentFloor);
        // The instance may have been swept out of _fearRooms while this player
        // was away (it had no players for the length of the drop) — put it
        // back so /health and the shutdown pass can see it again.
        if (_fearHeld) _trackFearRoom(s.currentRoom);
        playerFloorMap.set(socket.id, s.currentFloor);
        // See _doEnterLocation's identical guard: Fear/Coop players never join
        // the shared floor_<id> broadcast group, since each is alone (or, for
        // Coop, paired) on its own private Room.
        if (s.currentFloor !== FLOOR_IDS.fear && s.currentFloor !== FLOOR_IDS.coop && s.currentFloor !== FLOOR_IDS.farmZone2) socket.join(`floor_${s.currentFloor}`);
        const { staleSocketId, fearCarry } = s.currentRoom.addPlayer(socket.id, s.authed.username, s.myClanName, s.myClanIcon, clanAtkBonusPct(s.myClanLevel), s.authed.telegramId, s.myClanId);
        // Anything this account had signed up for before the drop comes back
        // onto this socket, in the position it signed up at. Unconditional: the
        // registration survives the disconnect now (see the 'disconnect'
        // handler), so this is the only thing that reconnects it to a live
        // socket, and the gameStart built further down already reports the
        // restored registered:… flags because of it.
        _reclaimQueues(s.authed.telegramId, socket.id);
        // Back to the exact spot, not just the right floor — but only when the
        // stored floor is the one actually being restored (an arm's coordinates
        // land far outside the hub's own grid) and the spot is still standable.
        // Anything else keeps addPlayer's spawn placement. Fear is excluded:
        // its grace path re-deploys into the held hall itself, a stricter
        // placement than this (Coop isn't restorable at all — see
        // _RESTORABLE_FLOORS — so it never reaches this branch either way).
        if (!_fearHeld) {
          const _sd = s.authed.savedData || {};
          if (Number(_sd.floor) === s.currentFloor && s.currentRoom.canStandAt(_sd.x, _sd.y)) {
            const _me = s.currentRoom.players.get(socket.id);
            if (_me) { _me.x = _sd.x; _me.y = _sd.y; }
          }
        }
        // A stale room entry for this same account (see addPlayer's comment)
        // was just dropped — tell other clients immediately instead of waiting
        // for that old socket's own (possibly delayed) disconnect to do it, so
        // this account never briefly renders as two players on screen.
        if (staleSocketId) {
          socket.to(`floor_${s.currentFloor}`).emit('playerLeft', { id: staleSocketId });
          // Pre-match REGISTRATION queues carry over — race10Register/
          // arena3Register/deathBattleRegister just record a name/level against
          // a socketId and wait for the scheduled window (several minutes for
          // race10) to deploy. A network blip in that window used to leave the
          // entry parked under the now-dead old socketId: _race10Start/
          // _a3Deploy's own "still connected" filter then silently dropped it
          // at deploy time, so the player registered, waited, and simply never
          // got thrown into the race/match — with no error telling them why.
          // Doing this before gameStart is built further down means its own
          // registered:_race10.queue.has(socket.id) (etc.) fields already
          // reflect the transfer, so the client's UI just shows "you're
          // registered" with no extra event needed.
          // Registration carry-over used to live here, keyed off the stale room
          // entry — see _reclaimQueues, which now does it for every join
          // instead. This branch only ever fired when the old socket was still
          // sitting in the room, which is the one case a real reconnect usually
          // is NOT: the duplicate login kicks the old socket first, and its
          // disconnect handler runs before this does.
          // The real 'disconnect' handler below also drops the old socket out of
          // any LIVE PvP instance (race10/arena3/deathBattle/Fear) — separate
          // Maps from the registration queues just transferred above (_db.alive/
          // _a3.teams/_race10.alive vs. _db.reg/_a3.queue/_race10.queue), so this
          // doesn't conflict with them. addPlayer's stale-entry cleanup only
          // drops its ROOM record, not this bookkeeping, since Room has no
          // visibility into the instance Maps kept here. Without this, a
          // reconnect mid-Bloody-Tower-run (a Wi-Fi/LTE handover, a suspended
          // WebView — see the pingTimeout comment above) leaves the old socketId
          // as a ghost "still alive" entrant that nothing ever clears: the new
          // socket starts back at the hub with _raceLane null, so every corridor
          // monster is invisible to it (_raceVisible, server/game/Room.js) —
          // reading exactly like "the monsters disappeared" — while the ghost
          // entry blocks the race from ever finishing for anyone else. Same
          // class of bug as the one already fixed for Fear halls; race10/
          // arena3/deathBattle just never got the parallel fix, and Fear itself
          // now goes through the same fearGrace hold as a real disconnect (see
          // below) rather than a bespoke same-tick-only carry.
          _pvpEliminate(staleSocketId, undefined, undefined, { fearGrace: true, telegramId: s.authed.telegramId });
          // Not routed through _pvpEliminate — that fan-out also fires on every
          // death (the 'respawn' handler), and dying inside Элитная фарм-зона
          // must NOT end the run (Room.respawnPlayer respawns in place, same
          // as any other free-roam zone). This stale-socket path really is a
          // disconnect-class event, so it gets its own direct call instead.
          _farm2EjectOnDisconnect(staleSocketId);
          // Same-tick duplicate-login race: the stale socket's own 'disconnect'
          // hasn't fired yet (this addPlayer call is what's dropping it), so
          // nothing has put its party slot into _partyDisconnectGrace for the
          // reclaim block below to find. Start that hold explicitly now so the
          // reclaim right after this block still picks it up onto socket.id
          // instead of leaving the party pointed at a socketId that's already
          // gone and will never itself reconnect.
          _partyHoldOnDisconnect(staleSocketId, s.authed.telegramId);
        }
        // Reclaim a Fear hall/run held across a disconnect. Room's own
        // _fearGraceClaim (inside addPlayer above) already reclaimed the hall
        // and its monsters if it found one — fearCarry says whether it did —
        // and the _pvpEliminate call just above (when staleSocketId existed)
        // guarantees any run still sitting on the stale socketId has by now
        // been moved into _fearDisconnectGrace. This check is independent of
        // staleSocketId, though: a real disconnect can finish completely
        // before this reconnect arrives, still inside the window, in which
        // case there was never a stale room record left to find above at all.
        if (fearCarry) {
          const g = _fearDisconnectGrace.get(s.authed.telegramId);
          if (g) {
            clearTimeout(g.timer);
            _fearDisconnectGrace.delete(s.authed.telegramId);
            _fear.set(socket.id, g.run);
            // Disconnected during the pre-wave countdown (see
            // FEAR_START_DELAY_MS): the setTimeout that would have started
            // wave 1 was scheduled against the now-dead old socketId and no
            // longer applies (its own guard confirms this and no-ops) — start
            // the wave right here instead, immediately rather than resuming a
            // countdown no client is around to display. s.currentRoom is the
            // fear floor's Room at this point (s.currentFloor was forced to it
            // above specifically because this account had a hold to reclaim).
            if (g.run.wave === 0) _fearStartWave(s.currentRoom, socket.id, g.run.lane, 1);
          }
        }
        // Reclaim a party slot held across a disconnect (_partyHoldOnDisconnect,
        // the 'disconnect' handler below) — same independent-of-staleSocketId
        // reasoning as the Fear reclaim just above: an ordinary reconnect's old
        // socket has usually finished disconnecting well before this new one
        // gets here, so there's rarely a live staleSocketId to key off. Moves
        // the still-held socketId in `parties`/`playerParty` onto this socket
        // and refreshes every member's roster — including this one, so its own
        // partyMembers isn't left showing pre-reconnect ids.
        const _pg = _partyDisconnectGrace.get(s.authed.telegramId);
        if (_pg) {
          clearTimeout(_pg.timer);
          _partyDisconnectGrace.delete(s.authed.telegramId);
          const pmap = parties.get(_pg.partyId);
          if (pmap && pmap.has(_pg.socketId)) {
            const uname = pmap.get(_pg.socketId);
            pmap.delete(_pg.socketId);
            pmap.set(socket.id, uname);
            playerParty.delete(_pg.socketId);
            playerParty.set(socket.id, _pg.partyId);
            pmap.forEach((_, mid) => {
              const others = [];
              pmap.forEach((name, oid) => { if (oid !== mid) others.push({ id: oid, name }); });
              io.to(mid).emit('partyUpdated', { members: others });
            });
          }
        }
        socket.to(`floor_${s.currentFloor}`).emit('playerJoined', { id: socket.id, username: s.authed.username });
        if (globalChatHistory.length) socket.emit('chatHistory', _publicChatHistory());
      }
      s.currentRoom.setPlayerChar(socket.id, type, effectiveSaved);
      socket.to(`floor_${s.currentFloor}`).emit('playerChar', { id: socket.id, type });
      // The room's own record of where this socket actually stands — addPlayer
      // (above) already resolved this to the reclaimed Fear hall (fearCarry.x/y)
      // when a run was restored, or the map's ordinary spawn otherwise. Sent
      // explicitly so js/network.js's _applyGameStart can place the player here
      // instead of unconditionally snapping to the map's static spawn point on
      // every fresh load: without this, a page refresh mid-Fear-run left the
      // server correctly reporting `fear.inRun: true` (wave HUD/"in battle"
      // showing, exactly right) while the client teleported the player back to
      // the hub regardless — stuck "in battle" with no monsters in sight, at a
      // spot with nothing to fight and no way out.
      const _selfP = s.currentRoom.players.get(socket.id);
      socket.emit('gameStart', _buildGameStartPayload(socket, s.currentRoom, s.currentFloor));
      // MUST come after gameStart: its client handler rebuilds otherPlayers from
      // scratch (`otherPlayers = new Map()`), so a roster delivered before it was
      // wiped on arrival and nobody ever saw anyone else's pet.
      // Whole roster to the arriving player, their own pet to everyone else —
      // same shape both ways, so a missed update self-heals on the next join.
      socket.emit('playerPets', { pets: s.currentRoom.petSnapshot() });
      if (_selfP && _selfP.petId) {
        socket.to(`floor_${s.currentFloor}`).emit('playerPet', { id: socket.id, petId: _selfP.petId });
      }

      // Authoritative item state, pushed on every join. On a FIRST join this
      // only re-affirms what the client is restoring from the same record. It
      // exists for the RECONNECT (js/network.js's _isReconnectRejoin), which
      // deliberately skips restoreFromSave to avoid stomping live progress —
      // and so had no way at all to learn that the server's items had moved on
      // while the socket was down.
      //
      // That gap is what duplicated market listings. Listing an item splices it
      // out of the local inventory optimistically and only marketListError undoes
      // that, so when the connection dropped mid-request the client restored the
      // item itself (onMarketConnectionLost) — with no way to know the server had
      // already created the listing and persisted the removal. The item then
      // existed both in the inventory and as a live lot, until the next save's
      // census caught the extra copy and reverted the player's WHOLE item set as
      // forged. Both outcomes of that race are settled here instead: the server's
      // copy is right whether the request landed or not.
      //
      // It also closes the loop on this handler's own forged-items rejection
      // above, which pinned s.lastStats to the stored record but never told the
      // client — leaving it to resend the rejected set on every later save.
      //
      // Always sent: the join blob no longer carries an item set at all
      // (_buildSaveStats, js/network.js), so there is nothing to compare it
      // against. This used to be conditional on a census comparison purely to
      // avoid echoing an identical inventory back down on every mobile
      // reconnect — a cost that disappeared with the upward copy.
      if (s.lastStats) {
        socket.emit('inventorySync', {
          inventory: s.lastStats.inventory || [],
          equipment: s.lastStats.equipment || {},
          storage:   s.lastStats.storage   || [],
        });
      }
    });

    safeOn('saveProgress', ({ stats } = {}) => {
      if (!s.authed) return;
      // No blob, nothing to do. _sanitizeSavedStats returns its argument
      // unchanged when it isn't an object, so without this the pins below run
      // against undefined and the handler throws — which safeOn then swallows,
      // leaving the client with no reply at all. Found by the handler sweep in
      // dev/harness.js.
      if (!stats || typeof stats !== 'object') return;
      // An item-granting handler (market cancel/buy, a craft, a shop purchase...)
      // is mid-flight and holding a reference to the current s.lastStats.inventory
      // across an await. Accepting this save now would let its eventual commit
      // stamp that now-stale reference back over whatever this save changes —
      // see s.itemOpBusy above.
      //
      // Dropping it was assumed to be safe because "the client's own autosave
      // debounce resends within a couple seconds" — but the client has no
      // periodic autosave, only event-driven ones (netSaveProgress, js/
      // network.js). A player who studies a passive and then stands still —
      // which is exactly what someone does in the skills panel, right after the
      // market/craft/shop op that set this flag — emits nothing further, so the
      // dropped save was the only one carrying that study and it simply never
      // reached the database. Ask for it back instead of discarding it.
      if (s.itemOpBusy > 0) { socket.emit('saveDeferred'); return; }
      // Sanitize the client blob before it becomes the server's source of truth
      // for BM/combat stats and before it's persisted (anti-cheat — see
      // _sanitizeSavedStats). gram/nexum are never taken from here.
      const clean = _sanitizeSavedStats(stats);
      // Did sanitizing DELETE anything? An id the catalog no longer knows is
      // dropped on the floor here and, because a shrinking save is legitimate,
      // nothing downstream ever notices. The length comparison is the cheap
      // guard (it is equal on every normal save); only when it isn't do we pay
      // for the scan that names the ids. See _unknownItemIds.
      if (Array.isArray(stats && stats.inventory) &&
          stats.inventory.length > clean.inventory.length) {
        const _gone = _unknownItemIds(stats);
        if (_gone.length) {
          logPlayer(s.authed.telegramId, s.authed.username, 'save_items_unknown_id', {
            ids: _gone.slice(0, 20).join(','), n: _gone.length,
          });
          console.error(`[saveProgress] Dropped items with unknown ids for telegramId=${s.authed.telegramId}:`,
            _gone.slice(0, 20).join(', '));
        }
      }
      // Items are server-owned. Every path that moves one — loot, sale, craft,
      // enhance, box, market, potion, and now equip/unequip/storage as well —
      // goes through _commitServerItems, so a save has nothing left to say about
      // them and they are taken from the session copy here.
      //
      // This is what retires the machinery that used to live in this spot. The
      // stale-revision guard existed to order a client's item set against a
      // server grant (invRev), and the census existed to work out afterwards
      // whether a rewrite had minted anything. Both were answers to the question
      // "was this client-authored item set legitimate?" — a question that no
      // longer has anything to range over, because the client does not author it.
      if (s.lastStats) {
        clean.inventory = s.lastStats.inventory || [];
        clean.equipment = s.lastStats.equipment || {};
        clean.storage   = s.lastStats.storage   || [];
      }

      // Quest progress is server-tracked: the counters are incremented from the
      // events the server already sees (kills, potion purchases, joining a clan)
      // and the claim is checked against them. So both fields come from the
      // session copy, and the monotonic guard that used to sit here — which
      // stopped a rewound questIdx from re-claiming a reward — has nothing left
      // to guard: the client cannot rewind a counter it does not write.
      if (s.lastStats) {
        clean.questIdx   = s.lastStats.questIdx || 0;
        clean.questKills = s.lastStats.questKills || {};
        // The last of it. buffs decide the x2 gold and XP payouts, potionBag is
        // spent by usePotion, bonusSP and empowers are written by the empower
        // and shop handlers, specialQuestsDone is what makes a special quest
        // once-only. None of them is a number the client may compose.
        clean.buffs             = s.lastStats.buffs             || {};
        clean.potionBag         = s.lastStats.potionBag         || {};
        clean.bonusSP           = s.lastStats.bonusSP           || 0;
        clean.keptSP            = s.lastStats.keptSP            || 0;
        clean.empowers          = s.lastStats.empowers          || 0;
        clean.specialQuestsDone = s.lastStats.specialQuestsDone || [];
        // HP, from the room. The server is what lowers it (attackEnemy,
        // pvpAttack, the AI) and what raises it (healPlayer, respawn, and the
        // rate-limited regen syncPlayerHp accepts off playerMove) — so the live
        // figure is already the truthful one, and taking it from the save was
        // the last way a client could hand itself health.
        //
        // Only while alive: a dead player's room entry sits at 0 until they
        // respawn, and persisting that is exactly right, but a save arriving in
        // the window before the room entry exists must not zero a live
        // character.
        const _rp = s.currentRoom && s.currentRoom.players.get(socket.id);
        if (_rp && _rp.hp > 0) clean.hp = _rp.hp;
        else if (s.lastStats.hp != null) clean.hp = s.lastStats.hp;
        // maxHp is a pure function of class, level, equipment and passives —
        // every one of which the server holds — so it is derived rather than
        // accepted. _sanitizeSavedStats already rebuilt it from the pinned
        // level above; this just stops the client's own figure winning.
        clean.maxHp = s.lastStats.maxHp != null ? s.lastStats.maxHp : clean.maxHp;
      }

      // Studied skills, passives and the "вторая профессия" unlocks are
      // server-owned now: the client asks for them through learnSkill/
      // upgradePassive/... and the server counts the books, rolls the chance and
      // applies the level itself. So they are taken from the session copy here
      // rather than from the blob, and a save that carries anything else — a
      // stale copy that predates a study, or a forged one claiming max levels —
      // simply has no effect on them. This is what retires the whole class of
      // "my passive rolled back" reports, rather than detecting it after the
      // fact. advSkillActive rides along: it is free to change, but it decides
      // which variant's damage the server applies (_skillMultFor, Room.js), so
      // the server's copy has to be the one that counts.
      if (s.lastStats) {
        clean.skillLevels     = s.lastStats.skillLevels     || {};
        clean.passiveLevels   = s.lastStats.passiveLevels   || {};
        clean.advSkillLearned = s.lastStats.advSkillLearned || {};
        clean.advSkillActive  = s.lastStats.advSkillActive  || {};
        clean.upgrades        = s.lastStats.upgrades        || {};
        // Кодекс: same reasoning — registerCodexSetItem is the only path that
        // ever changes it, so a save has nothing left to say about it either.
        clean.codex = (s.lastStats.codex && typeof s.lastStats.codex === 'object' && !Array.isArray(s.lastStats.codex))
          ? s.lastStats.codex : {};
      }

      // Gold is server-owned: every credit (kills, quests, sales, VIP, admin)
      // and every debit (merchant, stat upgrades, clan storage, clan founding)
      // is applied on this side and pushed as a total. A save has nothing left
      // to say about it.
      //
      // Two things go rather than sit alongside this pin, because a pinned field
      // cannot need either. _pendingGoldSpend existed to re-apply a charge to a
      // save composed just before it. The growth cap existed to bound how fast a
      // CLIENT-COMPOSED balance could rise — a rate guess that had to stay loose
      // enough never to punish a good farming streak, and therefore could never
      // be tight enough to stop a patient forgery. Deriving the total is what
      // makes both unnecessary.
      if (s.lastStats) clean.gold = _goldNow();
      _lastSaveAcceptedAt = Date.now();

      // Level and XP are server-owned: _grantXp applies every kill, quest and
      // event reward, runs the level curve and pushes the result. A save has
      // nothing to say about them, and the stats the level derives (baseAtk,
      // baseDef, baseMaxHp, xpNext) ride along, since accepting those from the
      // client would hand back through the side door exactly what pinning the
      // level closed.
      //
      // This is what retires the entitlement ledger. It existed to bank what the
      // server had granted so a client-composed level could be measured against
      // it — an audit that only ever made sense while the client was the one
      // composing.
      if (s.lastStats) {
        clean.lvl       = s.lastStats.lvl;
        clean.xp        = s.lastStats.xp;
        clean.xpNext    = s.lastStats.xpNext;
        clean.baseAtk   = s.lastStats.baseAtk;
        clean.baseDef   = s.lastStats.baseDef;
        clean.baseMaxHp = s.lastStats.baseMaxHp;
      }

      // The catastrophic-reset guard used to live here: it refused a save that
      // arrived blank over a real character, because such a save would have
      // wiped items, gold and level in one write. Every one of those fields is
      // now taken from the session copy a few lines above, so a blank save
      // overwrites nothing worth having — there is no reset left to catch.
      s.lastStats = clean;
      s.authed.bm = calcBM(_bmStatsFor(clean));
      // Catches the friend crossing level 20 mid-session rather than only at the
      // next login. Self-limiting: it returns immediately below level 20 and
      // runs at most once per session above it.
      _seasonCheckRefFriend();
      // Keeps the Room's basis for statsUpdate's true-base recomputation
      // (server/game/Room.js updatePlayerStats) in sync with the player's
      // actual equipment/upgrades/level as they change mid-session.
      if (s.currentRoom) {
        // Pets are the one bit of equipment other players can see, so a change
        // has to be pushed out. Broadcast as its own tiny event rather than a
        // gameState field: those go through the binary codec (shared/netcodec.js)
        // and a client that's still running the previous bundle after a redeploy
        // would misparse every packet, whereas an unknown extra event is simply
        // ignored.
        if (s.currentRoom.updatePlayerSavedData(socket.id, clean)) {
          const _p = s.currentRoom.players.get(socket.id);
          socket.to(`floor_${s.currentFloor}`).emit('playerPet', { id: socket.id, petId: _p ? _p.petId : null });
        }
      }
      // Marks the session dirty; the write itself is composed at fire time by
      // socket.data._persistProgressNow (above) from s.lastStats, which `clean`
      // has just become. Arming used to happen inline here as a bare 3s
      // clearTimeout/setTimeout pair — a trailing debounce that a client saving
      // every 2s reset forever, so nothing but the 60s autosave ever wrote a
      // farming session's gold and XP. See _schedulePersist (server/index.js).
      _schedulePersist();
    });

    safeOn('disconnect', (reason) => {
      // Counted before anything else here can throw or return early — a session
      // that ended is a session that ended, whatever the cleanup below does.
      _recordSessionEnd(reason, !!s.authed, Date.now() - _connectedAt);
      clearTimeout(_authTimeout);
      if (_autoSaveInterval) { clearInterval(_autoSaveInterval); _autoSaveInterval = null; }
      clearInterval(_buffTick);
      // _flushNow (below, via _pendingFlush) clears this too and writes whatever
      // the coalesced drop balances are owed — clearing here as well just makes
      // sure no timer outlives the socket in the paths that don't reach it.
      if (s.balancePersistTimer) { clearTimeout(s.balancePersistTimer); s.balancePersistTimer = null; }
      // Flush any pending debounced save immediately (same logic socket.data
      // ._flushNow exposes for a reconnecting session to await synchronously).
      // Registered in _pendingFlush (keyed by account, not socket) so a login
      // that arrives after this socket is already gone can still await the
      // write landing — see _pendingFlush comment above.
      if (s.authed) {
        const _tid = s.authed.telegramId;
        const _p = Promise.resolve(socket.data._flushNow?.())
          .finally(() => { if (_pendingFlush.get(_tid) === _p) _pendingFlush.delete(_tid); });
        _pendingFlush.set(_tid, _p);
        if (activeSessions.get(_tid) === socket.id) {
          activeSessions.delete(_tid);
          // The cache entries are dropped only once the flush above has landed:
          // that flush ends in an $inc whose result repopulates them, so clearing
          // them first would leave a stale figure behind for an account that is
          // no longer online. A reconnect that arrives in the meantime re-reads
          // the balance from the database anyway (see the login handlers).
          _p.finally(() => {
            if (activeSessions.get(_tid) === socket.id || !activeSessions.has(_tid)) {
              _gramBalanceCache.delete(_tid);
              _nexumBalanceCache.delete(_tid);
            }
          });
          // Drop their aura from the roster — but only when this socket is
          // still the account's active session. On a reconnect the new socket
          // has already claimed it (and re-registered the aura), and clearing
          // it here would blank the aura of a player who is very much online.
          _setVipAura(s.authed.username, 0);
        }
      } else {
        socket.data._flushNow?.();
      }
      // Leaving mid-round counts as being knocked out, so a round can't hang
      // waiting on someone who closed the app. The 3v3 has no timer at all, so
      // this is the only thing that stops a closed app from holding the arena.
      // Both of these are keyed by account and only count writes since the last
      // trim — nothing needed them to outlive the session, and nothing ever
      // deleted an entry, so they grew by one row per distinct account for the
      // whole uptime of the process.
      if (s.authed) {
        _logWritesSinceTrim.delete(s.authed.telegramId);
        _pvpHistoryWritesSinceTrim.delete(s.authed.telegramId);
      }
      // Registration entries are LEFT PARKED under this dead socket id rather
      // than deleted. They used to be dropped here, and that made an ordinary
      // blip during the registration window cost the whole sign-up: the kick
      // that a reconnecting duplicate login performs runs this handler first,
      // so by the time the new socket reached selectChar there was nothing left
      // to carry over and the player waited for a race they were no longer in.
      //
      // Parked is safe because nothing deploys a parked entry: _race10Start and
      // _a3TryStart both filter for "still connected and still in the world"
      // before deploying, and _race10CloseWindow clears the queue wholesale when
      // the window ends. A player who comes back reclaims their entry — in
      // place, so they keep the position they signed up in (see _reclaimQueues,
      // called from selectChar).
      _dbBroadcast(); _a3Broadcast(); _race10Broadcast();
      // fearGrace: an actual disconnect (network blip, closed tab, backgrounded
      // WebView) might just be a reconnect a moment away — hold the Fear run
      // instead of ending it, same as Room's own removePlayer now holds the
      // hall. Race10/arena3/deathBattle stay on the immediate path: they're
      // shared/competitive instances a lone reconnect can't safely resume into.
      _pvpEliminate(socket.id, undefined, undefined, { fearGrace: true, telegramId: s.authed?.telegramId });
      // Not routed through _pvpEliminate — see the stale-socket reconnect
      // path's own comment on why (it also fires on every death, which must
      // not end an Элитная фарм-зона run). No reconnect grace, same immediate-
      // eject choice Coop made for its own live runs.
      _farm2EjectOnDisconnect(socket.id);
      playerFloorMap.delete(socket.id);
      _teleportCasting.delete(socket.id);
      if (s.teleportCastTimer) { clearTimeout(s.teleportCastTimer); s.teleportCastTimer = null; }
      // Held for PARTY_RECONNECT_GRACE_MS instead of dissolved on the spot — a
      // small network drop (see the fearGrace comment just above) used to kick
      // the member out of their party immediately, same class of bug as Fear's
      // hall-release-on-blip one.
      _partyHoldOnDisconnect(socket.id, s.authed?.telegramId);
      // Coop groups are a pre-run lobby, not a live match — no reconnect grace
      // (see _coopGroupDropOnDisconnect's own comment); this is unrelated to
      // _coopEjectOnDisconnect above, which only ever fires for a run already
      // under way.
      _coopGroupDropOnDisconnect(socket.id);
      _farm2GroupDropOnDisconnect(socket.id);
      if (!s.currentRoom) return;
      socket.to(`floor_${s.currentFloor}`).emit('playerLeft', { id: socket.id });
      s.currentRoom.removePlayer(socket.id);
    });
};
