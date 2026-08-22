'use strict';
// clan: the safeOn handlers moved out of server/index.js verbatim, with
// the closure helpers only this domain used.
//
// Per-connection, so this takes the session object rather than the plain deps
// bag the server/game/*.js factories use — see server/handlers/market.js for
// the reasoning. `s.*` is every piece of connection state index.js reassigns
// after this module is wired; everything stable is destructured below under
// its original name, which is what keeps the moved bodies byte-identical.
module.exports = function registerClan(s, safeOn, deps) {
  const {
    CLAN_CREATE_COST, CLAN_MAX_MEMBERS, CLAN_STORAGE_MIN_DAYS,
    CLAN_STORAGE_UNLOCK_GOLD, CRAFT_MATS, ClanModel, FLOOR_IDS,
    GuildWarStateModel, SERVER_INV_MAX, UNIQUE_SHARDS, _clanDataFor,
    _clearOtherClanApplications, _escapeRegex, _gw, _gwPublicState, _invAdd,
    _notifyClan, _recordClanChat, _sanitizeClanDesc, _sanitizeName,
    _socketForTelegramId, activeSessions, clanAtkBonusPct, clanChatHistory,
    getRoom, io, logPlayer, logPlayerErr,
  } = deps;

  const {
    _ITEMS_BUSY_MSG, _commitServerItems, _currentQuest, _goldNow,
    _liveInventory, _questBump, _questPush, _serverSpendGold, _withEconLock,
    socket,
  } = s;

    // ── Clan chat — delivered only to members currently online, same
    // "iterate connected sockets by telegramId" pattern _notifyClan uses ──
    safeOn('clanChat', async ({ text }) => {
      if (!s.authed || !text || typeof text !== 'string') return;
      const now = Date.now();
      if (now - s.lastChatAt < 3000) return;
      const msg = text.trim().slice(0, 100);
      if (!msg) return;
      const clan = await ClanModel.findOne({ 'members.telegramId': s.authed.telegramId }).catch(() => null);
      if (!clan) return socket.emit('chatError', { channel: 'clan', msg: 'Вы не состоите в клане' });
      s.lastChatAt = now;
      _recordClanChat(clan._id, s.authed.username, msg);
      for (const m of clan.members) {
        const target = _socketForTelegramId(m.telegramId);
        if (target) target.emit('clanChatMsg', { username: s.authed.username, text: msg });
      }
    });

    safeOn('clanChatHistory', async () => {
      if (!s.authed) return;
      const clan = await ClanModel.findOne({ 'members.telegramId': s.authed.telegramId }).catch(() => null);
      socket.emit('clanChatHistory', { messages: clan ? (clanChatHistory.get(String(clan._id)) || []) : [] });
    });

    safeOn('clanCreate', async ({ name, icon }) => {
      if (!s.authed) return;
      // Same normalisation player names get (_safeUsername): a clan tag is shown
      // over every member's head and in other players' panels, so it must not be
      // able to carry markup or control characters either.
      const n = _sanitizeName(name).slice(0, 10).trim();
      if (!n) return socket.emit('clanError', { msg: 'Введите название' });
      if (typeof icon !== 'number' || icon < 1 || icon > 30) return socket.emit('clanError', { msg: 'Неверная иконка' });
      const existing = await ClanModel.findOne({ 'members.telegramId': s.authed.telegramId }).catch(() => null);
      if (existing) return socket.emit('clanError', { msg: 'Вы уже в клане' });
      // The founding fee was deducted on the client and reported by the next
      // save — so the server created the clan without ever charging for it, and
      // a client that simply skipped the deduction founded one for free. Charged
      // here, before the clan exists, so a failure cannot leave one unpaid.
      if (_goldNow() < CLAN_CREATE_COST) {
        return socket.emit('clanError', { msg: `Нужно ${CLAN_CREATE_COST} золота` });
      }
      try {
        const clan = await ClanModel.create({
          name: n, icon,
          members: [{ telegramId: s.authed.telegramId, username: s.authed.username, role: 'leader' }],
        });
        await _serverSpendGold(CLAN_CREATE_COST, 'clan_create');
        if (_currentQuest() && _currentQuest().type === 'join_guild') { _questBump('_guild', 1); _questPush(); }
        const _cd = await _clanDataFor(clan, s.authed.telegramId);
        socket.emit('clanData', _cd);
        s.myClanName  = _cd ? _cd.name : null;
        s.myClanIcon  = _cd ? _cd.icon : null;
        s.myClanId    = _cd ? String(_cd._id) : null;
        s.myClanLevel = _cd ? _cd.level : null;
        s.currentRoom?.setPlayerClan(socket.id, s.myClanName, s.myClanIcon, clanAtkBonusPct(s.myClanLevel), s.myClanId);
        // Founding a clan makes any application still pending elsewhere moot —
        // without this it could sit in that other clan's queue and get approved
        // later, leaving this account in two clans at once.
        await _clearOtherClanApplications(s.authed.telegramId);
      } catch (e) {
        if (e.code === 11000) socket.emit('clanError', { msg: 'Название занято' });
        else socket.emit('clanError', { msg: 'Ошибка создания' });
      }
    });

    safeOn('clanSetDescription', async ({ description } = {}) => {
      if (!s.authed) return;
      const clan = await ClanModel.findOne({ 'members.telegramId': s.authed.telegramId }).catch(() => null);
      if (!clan) return;
      if (clan.members.find(m => m.telegramId === s.authed.telegramId)?.role !== 'leader') return;
      clan.description = _sanitizeClanDesc(description);
      await clan.save().catch(() => {});
      await _notifyClan(clan);
    });

    safeOn('clanSearch', async ({ query }) => {
      if (!s.authed) return;
      const q = (query || '').trim().slice(0, 32);
      const filter = q ? { name: { $regex: _escapeRegex(q), $options: 'i' } } : {};
      const clans = await ClanModel.find(filter).sort({ level: -1, xp: -1 }).limit(20).catch(() => []);
      socket.emit('clanSearchResults', clans.map(c => ({
        _id: c._id, name: c.name, icon: c.icon, level: c.level, members: c.members.length,
      })));
    });

    safeOn('clanApply', async ({ clanId }) => {
      if (!s.authed) return;
      const inClan = await ClanModel.findOne({ 'members.telegramId': s.authed.telegramId }).catch(() => null);
      if (inClan) return socket.emit('clanError', { msg: 'Вы уже в клане' });
      const clan = await ClanModel.findById(clanId).catch(() => null);
      if (!clan) return socket.emit('clanError', { msg: 'Клан не найден' });
      // Only one pending application at a time — applying to a new clan
      // withdraws any application still pending elsewhere, so a leader never
      // approves someone who already joined a different clan in the meantime.
      await _clearOtherClanApplications(s.authed.telegramId, clan._id);
      if (clan.applications.find(a => a.telegramId === s.authed.telegramId)) return;
      clan.applications.push({ telegramId: s.authed.telegramId, username: s.authed.username });
      await clan.save().catch(() => {});
      // Dedicated event rather than piggybacking the generic 'clanError' channel
      // with a checkmark-prefixed message — the client needs to tell this success
      // apart from an actual error to give the applied button its own confirmed
      // state instead of a toast that reads as a warning.
      socket.emit('clanApplySent', { clanId: String(clan._id) });
      await _notifyClan(clan);
    });

    // On-demand clan refresh, for when the player opens the clan tab. Replaces
    // what the per-kill clanData push used to do by accident — it kept the XP
    // bar live at the cost of a full clan read + packet on every monster death.
    // One read when the panel is actually being looked at is the same
    // information for a rounding error of the cost. Rate-limited as a heavy
    // event like every other clan handler.
    safeOn('clanRequest', async () => {
      if (!s.authed || !s.myClanId) return;
      const clan = await ClanModel.findById(s.myClanId).catch(() => null);
      if (!clan) return socket.emit('clanData', null);
      socket.emit('clanData', await _clanDataFor(clan, s.authed.telegramId));
    });

    safeOn('clanApprove', async ({ telegramId }) => {
      if (!s.authed) return;
      const clan = await ClanModel.findOne({ 'members.telegramId': s.authed.telegramId }).catch(() => null);
      if (!clan) return;
      if (clan.members.find(m => m.telegramId === s.authed.telegramId)?.role !== 'leader') return;
      const app = clan.applications.find(a => a.telegramId === telegramId);
      if (!app) return;
      // Membership cap. Checked here rather than at clanApply so a full clan can
      // still collect applications for whenever a slot frees up; the leader just
      // can't approve past the limit.
      if (clan.members.length >= CLAN_MAX_MEMBERS) {
        return socket.emit('clanError', { msg: `В клане максимум ${CLAN_MAX_MEMBERS} участников` });
      }
      // $pull + $push instead of mutating the document and calling save(): a
      // full-document write here loses whatever else changed since this copy was
      // read (another approval, someone leaving, a level-up from the XP flusher).
      // The filters make it once-only too — approving the same application twice
      // can't add the member twice.
      const _approved = await ClanModel.updateOne(
        { _id: clan._id, 'applications.telegramId': telegramId, 'members.telegramId': { $ne: telegramId },
          [`members.${CLAN_MAX_MEMBERS - 1}`]: { $exists: false } },
        {
          $pull: { applications: { telegramId } },
          $push: { members: { telegramId: app.telegramId, username: app.username, role: 'member' } },
        },
      ).catch(() => null);
      if (!_approved || !_approved.modifiedCount) {
        return socket.emit('clanError', { msg: 'Заявку уже обработали' });
      }
      // Defensive: clanApply already keeps a player down to one pending
      // application at a time, so there normally isn't anything left to clear
      // here — but belt-and-suspenders against any future path (or a
      // pre-existing stale row) that leaves a second one sitting in some other
      // clan's queue, which a leader there could otherwise still approve.
      await _clearOtherClanApplications(telegramId, clan._id);
      const _fresh = await ClanModel.findById(clan._id).catch(() => null);
      await _notifyClan(_fresh || clan);
    });

    safeOn('clanDecline', async ({ telegramId }) => {
      if (!s.authed) return;
      const clan = await ClanModel.findOne({ 'members.telegramId': s.authed.telegramId }).catch(() => null);
      if (!clan) return;
      if (clan.members.find(m => m.telegramId === s.authed.telegramId)?.role !== 'leader') return;
      clan.applications = clan.applications.filter(a => a.telegramId !== telegramId);
      await clan.save().catch(() => {});
      const _cdDecl = await _clanDataFor(clan, s.authed.telegramId);
      socket.emit('clanData', _cdDecl);
      s.myClanName  = _cdDecl ? _cdDecl.name : null;
      s.myClanIcon  = _cdDecl ? _cdDecl.icon : null;
      s.myClanId    = _cdDecl ? String(_cdDecl._id) : null;
      s.myClanLevel = _cdDecl ? _cdDecl.level : null;
      s.currentRoom?.setPlayerClan(socket.id, s.myClanName, s.myClanIcon, clanAtkBonusPct(s.myClanLevel), s.myClanId);
    });

    safeOn('clanKick', async ({ telegramId }) => {
      if (!s.authed) return;
      const clan = await ClanModel.findOne({ 'members.telegramId': s.authed.telegramId }).catch(() => null);
      if (!clan) return;
      if (clan.members.find(m => m.telegramId === s.authed.telegramId)?.role !== 'leader') return;
      if (telegramId === s.authed.telegramId) return;
      // Their unclaimed shards return to the pool first — once the member row is
      // gone nobody can collect them and they would be stuck in the document.
      await _clanReclaimAllocations(clan._id, telegramId);
      // Atomic $pull — see clanApprove above for why a full-document save here
      // drops concurrent changes.
      await ClanModel.updateOne({ _id: clan._id }, { $pull: { members: { telegramId } } }).catch(() => {});
      clan.members = clan.members.filter(m => m.telegramId !== telegramId);
      await _notifyClan(clan);
      // Notify kicked player
      const kicked = _socketForTelegramId(telegramId);
      if (kicked) {
        kicked.emit('clanData', null);
        // Clears their s.myClanId/s.myClanName/s.myClanIcon and the room clan tag
        // in one go — see _setClanIdentity.
        kicked.data._setClanIdentity?.(null, null, null);
      }
    });

    safeOn('clanLeave', async () => {
      if (!s.authed) return;
      const clan = await ClanModel.findOne({ 'members.telegramId': s.authed.telegramId }).catch(() => null);
      if (!clan) return;
      const myEntry = clan.members.find(m => m.telegramId === s.authed.telegramId);
      if (!myEntry) return;
      // Same as clanKick: hand anything still allocated back to the clan rather
      // than walking out with it locked in the document.
      await _clanReclaimAllocations(clan._id, s.authed.telegramId);
      if (myEntry.role === 'leader') {
        // Promote next member or disband
        const others = clan.members.filter(m => m.telegramId !== s.authed.telegramId);
        if (others.length > 0) {
          // Two targeted updates rather than rewriting the member array: the
          // leaver is pulled and the successor promoted in place, so a member who
          // joined between this read and this write isn't dropped.
          await ClanModel.updateOne(
            { _id: clan._id },
            { $pull: { members: { telegramId: s.authed.telegramId } } },
          ).catch(() => {});
          await ClanModel.updateOne(
            { _id: clan._id, 'members.telegramId': others[0].telegramId },
            { $set: { 'members.$.role': 'leader' } },
          ).catch(() => {});
          const _fresh = await ClanModel.findById(clan._id).catch(() => null);
          await _notifyClan(_fresh || clan);
        } else {
          // Last member out: the clan document (and the shard pool inside it) is
          // about to be deleted. Everything in that pool was put there by this
          // same account — they are the only member — so it goes back to them
          // rather than being destroyed.
          const _pool = await ClanModel.findById(clan._id, 'storage').lean().catch(() => null);
          const _rows = (_pool?.storage || []).filter(e => e && e.qty > 0);
          if (_rows.length) {
            const inv = _liveInventory();
            if (!inv) return socket.emit('clanError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
            const newSlots = _rows.filter(e => !inv.some(i => i && i.id === e.id)).length;
            if (inv.length + newSlots > SERVER_INV_MAX) {
              return socket.emit('clanError', { msg: 'Освободите место в инвентаре — в хранилище остались Осколки' });
            }
            const _beforeLen = inv.length;
            const _got = [];
            for (const e of _rows) {
              const base = CRAFT_MATS.find(m => m.id === e.id);
              if (base && _invAdd(inv, { ...base, qty: e.qty })) _got.push(`${e.id}x${e.qty}`);
            }
            _commitServerItems(inv, null, 'clan_storage_return', { clan: clan.name, items: _got.join(',') }, { beforeLen: _beforeLen });
          }
          await ClanModel.deleteOne({ _id: clan._id }).catch(() => {});
        }
      } else {
        await ClanModel.updateOne(
          { _id: clan._id },
          { $pull: { members: { telegramId: s.authed.telegramId } } },
        ).catch(() => {});
        clan.members = clan.members.filter(m => m.telegramId !== s.authed.telegramId);
        await _notifyClan(clan);
      }
      socket.emit('clanData', null);
      s.myClanName  = null;
      s.myClanIcon  = null;
      s.myClanId    = null;
      s.myClanLevel = null;
      s.currentRoom?.setPlayerClan(socket.id, null, null, 0, null);
    });

    safeOn('clanDisband', async () => {
      if (!s.authed) return;
      const clan = await ClanModel.findOne({ 'members.telegramId': s.authed.telegramId }).catch(() => null);
      if (!clan) return;
      if (clan.members.find(m => m.telegramId === s.authed.telegramId)?.role !== 'leader') return;
      // Disbanding deletes the clan document, and the shard pool lives in it —
      // so an unemptied storage would be destroyed with no warning and no way
      // back. Refuse until it has been handed out; the leader can give it all to
      // themselves in a few taps if they just want to leave.
      const _held = (clan.storage || []).reduce((s, e) => s + (e.qty || 0), 0)
                  + (clan.allocations || []).reduce((s, a) => s + (a.qty || 0), 0);
      if (_held > 0) {
        return socket.emit('clanError', {
          msg: `Сначала раздайте Осколки из хранилища (осталось ${_held})`,
        });
      }
      // Notify all members first and clear their room clan state
      for (const m of clan.members) {
        const target = _socketForTelegramId(m.telegramId);
        if (target) {
          target.emit('clanData', null);
          target.data._setClanIdentity?.(null, null, null);
        }
      }
      // Guild War ownership is the one piece of clan-attributed state that
      // lives OUTSIDE the Clan document (GuildWarState, keyed by clan _id) —
      // everything else (storage/allocations/members) is deleted for free
      // along with the document above. Without this, a disbanded clan would
      // stay the tower's "owner" forever: nobody could ever capture it again
      // (own_tower never matches a clanName that no longer exists, but the
      // hourly income job would keep trying to pay a clan that's gone).
      if (_gw.ownerClanId && String(_gw.ownerClanId) === String(clan._id)) {
        _gw.ownerClanId = null; _gw.ownerClanName = null; _gw.ownerClanIcon = null; _gw.capturedAt = 0;
        await GuildWarStateModel.updateOne(
          { key: 'castle' },
          { $set: { ownerClanId: null, ownerClanName: null, ownerClanIcon: null, capturedAt: 0 } },
          { upsert: true },
        ).catch(err => console.error('[GuildWarState] disband release failed', err));
        const _gwRoom = getRoom(FLOOR_IDS.guildWar);
        const _gwTower = _gwRoom && _gwRoom._gwTowerId && _gwRoom._enemyMap.get(_gwRoom._gwTowerId);
        if (_gwTower) { _gwTower.ownerClanId = null; _gwTower.ownerClanName = null; _gwTower.ownerClanIcon = null; }
        io.emit('guildWarState', _gwPublicState());
      }
      await ClanModel.deleteOne({ _id: clan._id }).catch(() => {});
    });

    // Anything still allocated to someone who is leaving goes back into the
    // pool. Without this it would sit in the clan document forever: only that
    // account can claim it, and it no longer can.
    async function _clanReclaimAllocations(clanId, telegramId) {
      const pulled = await ClanModel.findOneAndUpdate(
        { _id: clanId, 'allocations.telegramId': String(telegramId) },
        { $pull: { allocations: { telegramId: String(telegramId) } } },
        { new: false },
      ).catch(() => null);
      if (!pulled) return;
      const back = new Map();
      for (const a of (pulled.allocations || [])) {
        if (a.telegramId !== String(telegramId) || !(a.qty > 0)) continue;
        back.set(a.id, (back.get(a.id) || 0) + a.qty);
      }
      for (const [id, qty] of back) {
        const bumped = await ClanModel.updateOne(
          { _id: clanId, 'storage.id': id }, { $inc: { 'storage.$.qty': qty } },
        ).catch(() => ({ matchedCount: 1 }));
        if (!bumped.matchedCount) {
          await ClanModel.updateOne(
            { _id: clanId, 'storage.id': { $ne: id } }, { $push: { storage: { id, qty } } },
          ).catch(() => {});
        }
      }
    }

    // Days this account has been in the clan, or null if it is not a member.
    function _clanDaysIn(clan, telegramId) {
      const m = clan.members.find(x => x.telegramId === telegramId);
      if (!m) return null;
      const joined = m.joinedAt ? new Date(m.joinedAt).getTime() : 0;
      // A member row written before joinedAt existed has no date; treat that as
      // "has been here since the beginning" rather than locking them out forever.
      if (!joined) return Infinity;
      return (Date.now() - joined) / 86400000;
    }

    const _clanStorageOk = (clan, tid) => (_clanDaysIn(clan, tid) ?? -1) >= CLAN_STORAGE_MIN_DAYS;

    function _clanStoragePayload(clan, telegramId) {
      const isLeader = clan.members.find(m => m.telegramId === telegramId)?.role === 'leader';
      const days = _clanDaysIn(clan, telegramId);
      const unlocked = !!clan.storageUnlocked;
      const shardName = id => (UNIQUE_SHARDS.find(s => s.id === id) || {}).name || id;
      const shardImg  = id => (UNIQUE_SHARDS.find(s => s.id === id) || {}).img || null;
      return {
        minDays: CLAN_STORAGE_MIN_DAYS,
        // Rounded down, so "9.9 days" reads as 9 and the number never claims
        // eligibility the check itself would refuse.
        daysIn: days === Infinity ? null : Math.floor(Math.max(0, days || 0)),
        // canUse is the DAY gate alone. `unlocked` is separate on purpose: the
        // panel has to be able to say which of the two is missing, and a member
        // who is past 10 days still can't do anything until it is bought.
        canUse: _clanStorageOk(clan, telegramId),
        unlocked,
        unlockCost: CLAN_STORAGE_UNLOCK_GOLD,
        isLeader,
        storage: (clan.storage || [])
          .filter(e => e && e.qty > 0)
          .map(e => ({ id: e.id, name: shardName(e.id), img: shardImg(e.id), qty: e.qty })),
        // A leader sees every outstanding allocation, a member only their own.
        allocations: (clan.allocations || [])
          .filter(a => isLeader || a.telegramId === telegramId)
          .map(a => ({
            telegramId: a.telegramId, username: a.username,
            id: a.id, name: shardName(a.id), img: shardImg(a.id),
            qty: a.qty, byUsername: a.byUsername || null, at: a.at,
          })),
        // Who the leader may hand shards to — members past the same gate.
        members: isLeader
          ? clan.members
              .filter(m => _clanStorageOk(clan, m.telegramId))
              .map(m => ({ telegramId: m.telegramId, username: m.username }))
          : [],
      };
    }

    async function _clanStoragePush(clan) {
      for (const m of clan.members) {
        const target = _socketForTelegramId(m.telegramId);
        if (target) target.emit('clanStorage', _clanStoragePayload(clan, m.telegramId));
      }
    }

    async function _myClan() {
      if (!s.authed) return null;
      return ClanModel.findOne({ 'members.telegramId': s.authed.telegramId }).catch(() => null);
    }

    safeOn('clanStorageSync', async () => {
      const clan = await _myClan();
      if (!clan) return socket.emit('clanStorage', null);
      socket.emit('clanStorage', _clanStoragePayload(clan, s.authed.telegramId));
    });

    // The leader buys the storage for the clan, once, out of their own gold.
    //
    // Gold is the one currency the server does not own outright — it rides in on
    // the client's save blob — so the deduction has to be told to the client as
    // an absolute (newGold) the way the merchant sale does, or their next
    // autosave would put the million straight back.
    safeOn('clanStorageUnlock', async () => {
      if (!s.authed) return;
      const _ran = await _withEconLock(async () => {
        const clan = await _myClan();
        if (!clan) return socket.emit('clanStorageError', { msg: 'Вы не в клане' });
        if (clan.members.find(m => m.telegramId === s.authed.telegramId)?.role !== 'leader') {
          return socket.emit('clanStorageError', { msg: 'Открыть хранилище может только лидер' });
        }
        if (clan.storageUnlocked) {
          return socket.emit('clanStorageError', { msg: 'Хранилище уже открыто' });
        }
        if (!s.lastStats) return socket.emit('clanStorageError', { msg: 'Данные ещё не загружены — попробуйте ещё раз' });
        const gold = Math.floor(Number(s.lastStats.gold) || 0);
        if (gold < CLAN_STORAGE_UNLOCK_GOLD) {
          return socket.emit('clanStorageError', {
            msg: `Нужно ${CLAN_STORAGE_UNLOCK_GOLD.toLocaleString('ru-RU')} золота (есть ${gold.toLocaleString('ru-RU')})`,
          });
        }
        // Claim the unlock BEFORE charging: the filter only matches while it is
        // still locked, so two taps can't both go through and bill twice. If it
        // matched nothing somebody else already bought it and no gold moves.
        const claimed = await ClanModel.findOneAndUpdate(
          { _id: clan._id, storageUnlocked: { $ne: true } },
          { $set: { storageUnlocked: true } },
          { new: true },
        ).catch(() => null);
        if (!claimed) return socket.emit('clanStorageError', { msg: 'Хранилище уже открыто' });

        await _serverSpendGold(CLAN_STORAGE_UNLOCK_GOLD, 'clan_storage_unlock');
        logPlayer(s.authed.telegramId, s.authed.username, 'clan_storage_unlock',
          { clan: clan.name, cost: CLAN_STORAGE_UNLOCK_GOLD, goldBefore: gold, goldLeft: s.lastStats.gold });
        socket.emit('clanStorageUnlocked', { newGold: s.lastStats.gold, cost: CLAN_STORAGE_UNLOCK_GOLD });
        await _clanStoragePush(claimed);
      });
      if (!_ran) socket.emit('clanStorageError', { msg: _ITEMS_BUSY_MSG });
    });

    safeOn('clanStorageDeposit', async ({ id, qty } = {}) => {
      if (!s.authed) return;
      s.itemOpBusy++;
      let _ran;
      try {
      _ran = await _withEconLock(async () => {
        const n = Math.floor(Number(qty));
        if (!Number.isFinite(n) || n <= 0) return;
        // Only Осколки. The pool is a flat id→count list precisely because
        // everything in it is interchangeable and stackable; letting gear in
        // would need per-item identity and enhance levels it cannot hold.
        if (!UNIQUE_SHARDS.some(s => s.id === id)) {
          return socket.emit('clanStorageError', { msg: 'В хранилище можно класть только Осколки' });
        }
        const clan = await _myClan();
        if (!clan) return socket.emit('clanStorageError', { msg: 'Вы не в клане' });
        // Locked clans have no storage at all — nothing goes in, nothing comes
        // out, and the pool stays empty until the leader buys it.
        if (!clan.storageUnlocked) {
          return socket.emit('clanStorageError', { msg: 'Хранилище клана ещё не открыто' });
        }
        if (!_clanStorageOk(clan, s.authed.telegramId)) {
          return socket.emit('clanStorageError', {
            msg: `Хранилище доступно после ${CLAN_STORAGE_MIN_DAYS} дней в клане`,
          });
        }

        // Cross-session guard: the socket that queued this request may no
        // longer be the account's live session (disconnect/reconnect while the
        // _myClan() await above was in flight). Redirect the whole deposit at
        // whichever socket IS live so the removal lands on the inventory the
        // player actually sees, instead of clobbering it from an orphaned
        // closure — same class of bug as the market cancel/buy fix.
        if (activeSessions.get(s.authed.telegramId) !== socket.id) {
          const _target = _socketForTelegramId(s.authed.telegramId);
          const _items = _target && _target.data._adminReadItems ? _target.data._adminReadItems().inventory : null;
          if (!_target || !Array.isArray(_items)) {
            return socket.emit('clanStorageError', { msg: 'Сессия недоступна — попробуйте ещё раз' });
          }
          const _have = _items.reduce((s, i) => s + (i && i.id === id ? (i.qty || 1) : 0), 0);
          if (_have < n) return socket.emit('clanStorageError', { msg: `Недостаточно Осколков (есть ${_have})` });
          try {
            const _bumped = await ClanModel.updateOne(
              { _id: clan._id, 'storage.id': id }, { $inc: { 'storage.$.qty': n } },
            );
            if (!_bumped.matchedCount) {
              await ClanModel.updateOne(
                { _id: clan._id, 'storage.id': { $ne: id } }, { $push: { storage: { id, qty: n } } },
              );
            }
          } catch (err) {
            logPlayerErr(s.authed.telegramId, s.authed.username, 'clan_storage_deposit', err, { id, qty: n });
            return socket.emit('clanStorageError', { msg: 'Ошибка сервера' });
          }
          // The FULL catalog entry, not a bare { id }: _invRemove decides
          // "take n units" vs "take the whole entry" from the item's slot, so a
          // slot-less object made this delete the player's entire stack of that
          // shard and hand only n of them to the clan. _itemSlotOf now resolves
          // the slot from the catalog either way; passing the real base as well
          // means this no longer depends on that fallback at all.
          const _shardBase = CRAFT_MATS.find(m => m.id === id);
          _target.data._applyGrant({ removeItems: [{ item: { ...(_shardBase || { id, slot: 'material' }) }, qty: n }] },
            'clan_storage_deposit_cross_session', { id, qty: n, clan: clan.name });
          const _fresh = await _myClan();
          if (_fresh) await _clanStoragePush(_fresh);
          _target.emit('clanStorageOk', { msg: `Передано в хранилище: ${n}` });
          return;
        }

        const inv = _liveInventory();
        if (!inv) return socket.emit('clanStorageError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
        const _beforeLen = inv.length;
        const have = inv.reduce((s, i) => s + (i && i.id === id ? (i.qty || 1) : 0), 0);
        if (have < n) return socket.emit('clanStorageError', { msg: `Недостаточно Осколков (есть ${have})` });

        // Take from the inventory in memory first, then write the clan. If the
        // clan write fails the items go straight back and nothing is persisted —
        // the reverse order would have to un-write the clan instead, and a
        // failure there would leave the shards in neither place.
        const _removed = [];
        let left = n;
        for (let i = inv.length - 1; i >= 0 && left > 0; i--) {
          const e = inv[i];
          if (!e || e.id !== id) continue;
          const q = e.qty || 1;
          if (q > left) { e.qty = q - left; _removed.push({ i, qty: left, spliced: false }); left = 0; }
          else { left -= q; _removed.push({ i, qty: q, spliced: true, entry: e }); inv.splice(i, 1); }
        }
        const restore = () => {
          for (const r of _removed.reverse()) {
            if (r.spliced) inv.splice(r.i, 0, r.entry);
            else inv[r.i].qty = (inv[r.i].qty || 0) + r.qty;
          }
        };

        try {
          // Bump an existing row, or create it when the clan has none of this
          // kind yet. Two updates rather than one because Mongo has no "increment
          // or push" — the second only runs when the first matched nothing.
          const bumped = await ClanModel.updateOne(
            { _id: clan._id, 'storage.id': id },
            { $inc: { 'storage.$.qty': n } },
          );
          if (!bumped.matchedCount) {
            await ClanModel.updateOne(
              { _id: clan._id, 'storage.id': { $ne: id } },
              { $push: { storage: { id, qty: n } } },
            );
          }
        } catch (err) {
          restore();
          logPlayerErr(s.authed.telegramId, s.authed.username, 'clan_storage_deposit', err, { id, qty: n });
          return socket.emit('clanStorageError', { msg: 'Ошибка сервера' });
        }

        _commitServerItems(inv, null, 'clan_storage_deposit', { id, qty: n, clan: clan.name }, { beforeLen: _beforeLen });
        const fresh = await _myClan();
        if (fresh) await _clanStoragePush(fresh);
        socket.emit('clanStorageOk', { msg: `Передано в хранилище: ${n}` });
      });
      } finally {
        s.itemOpBusy--;
      }
      if (!_ran) socket.emit('clanStorageError', { msg: _ITEMS_BUSY_MSG });
    });

    // Leader hands part of the pool to a member. Nothing reaches their inventory
    // here — it becomes an allocation they collect (see clanStorageClaim).
    safeOn('clanStorageGive', async ({ telegramId, id, qty } = {}) => {
      if (!s.authed) return;
      const n = Math.floor(Number(qty));
      if (!Number.isFinite(n) || n <= 0) return;
      const clan = await _myClan();
      if (!clan) return;
      if (!clan.storageUnlocked) {
        return socket.emit('clanStorageError', { msg: 'Хранилище клана ещё не открыто' });
      }
      if (clan.members.find(m => m.telegramId === s.authed.telegramId)?.role !== 'leader') {
        return socket.emit('clanStorageError', { msg: 'Распределять может только лидер' });
      }
      const target = clan.members.find(m => m.telegramId === String(telegramId));
      if (!target) return socket.emit('clanStorageError', { msg: 'Участник не найден' });
      // The recipient is held to the same gate as a depositor: without it a
      // day-old alt is a way to walk the whole pool out of the clan.
      if (!_clanStorageOk(clan, target.telegramId)) {
        return socket.emit('clanStorageError', {
          msg: `${target.username}: в клане меньше ${CLAN_STORAGE_MIN_DAYS} дней`,
        });
      }
      // One conditional update does the whole move: it only matches while the
      // pool still holds n of that kind, so two taps cannot hand out the same
      // shards twice.
      const upd = await ClanModel.findOneAndUpdate(
        { _id: clan._id, storage: { $elemMatch: { id, qty: { $gte: n } } } },
        {
          $inc: { 'storage.$.qty': -n },
          $push: { allocations: {
            telegramId: target.telegramId, username: target.username,
            id, qty: n, byUsername: s.authed.username, at: new Date(),
          } },
        },
        { new: true },
      ).catch(() => null);
      if (!upd) return socket.emit('clanStorageError', { msg: 'В хранилище столько нет' });
      logPlayer(s.authed.telegramId, s.authed.username, 'clan_storage_give',
        { to: target.username, toTid: target.telegramId, id, qty: n, clan: clan.name });
      await _clanStoragePush(upd);
      socket.emit('clanStorageOk', { msg: `Выдано ${target.username}: ${n}` });
    });

    // Leader takes an unclaimed allocation back into the pool — the only way to
    // undo a mis-tap, since the recipient may simply never collect it.
    safeOn('clanStorageCancel', async ({ telegramId, id } = {}) => {
      if (!s.authed) return;
      const clan = await _myClan();
      if (!clan) return;
      if (clan.members.find(m => m.telegramId === s.authed.telegramId)?.role !== 'leader') return;
      const alloc = (clan.allocations || []).find(a => a.telegramId === String(telegramId) && a.id === id);
      if (!alloc) return socket.emit('clanStorageError', { msg: 'Выдача не найдена' });
      const pulled = await ClanModel.findOneAndUpdate(
        { _id: clan._id, allocations: { $elemMatch: { telegramId: String(telegramId), id } } },
        { $pull: { allocations: { telegramId: String(telegramId), id } } },
        { new: false },
      ).catch(() => null);
      if (!pulled) return socket.emit('clanStorageError', { msg: 'Выдача не найдена' });
      // Sum what was actually pulled from the pre-image rather than trusting the
      // copy read above — another tap may have changed it in between.
      const back = (pulled.allocations || [])
        .filter(a => a.telegramId === String(telegramId) && a.id === id)
        .reduce((s, a) => s + (a.qty || 0), 0);
      if (back > 0) {
        const bumped = await ClanModel.updateOne(
          { _id: clan._id, 'storage.id': id }, { $inc: { 'storage.$.qty': back } },
        );
        if (!bumped.matchedCount) {
          await ClanModel.updateOne(
            { _id: clan._id, 'storage.id': { $ne: id } }, { $push: { storage: { id, qty: back } } },
          );
        }
      }
      const fresh = await _myClan();
      if (fresh) await _clanStoragePush(fresh);
    });

    // Member collects everything allocated to them. Pulled first so a second tap
    // finds nothing, then granted; if the inventory can't take it, the
    // allocation goes back exactly as it was.
    safeOn('clanStorageClaim', async () => {
      if (!s.authed) return;
      s.itemOpBusy++;
      let _ran;
      try {
      _ran = await _withEconLock(async () => {
        const clan = await _myClan();
        if (!clan) return;
        if (!clan.storageUnlocked) {
          return socket.emit('clanStorageError', { msg: 'Хранилище клана ещё не открыто' });
        }
        if (!_clanStorageOk(clan, s.authed.telegramId)) {
          return socket.emit('clanStorageError', {
            msg: `Хранилище доступно после ${CLAN_STORAGE_MIN_DAYS} дней в клане`,
          });
        }

        // Cross-session guard, mirrors clanStorageDeposit above.
        if (activeSessions.get(s.authed.telegramId) !== socket.id) {
          const _target = _socketForTelegramId(s.authed.telegramId);
          const _items = _target && _target.data._adminReadItems ? _target.data._adminReadItems().inventory : null;
          if (!_target || !Array.isArray(_items)) {
            return socket.emit('clanStorageError', { msg: 'Сессия недоступна — попробуйте ещё раз' });
          }

          const _pulled = await ClanModel.findOneAndUpdate(
            { _id: clan._id, 'allocations.telegramId': s.authed.telegramId },
            { $pull: { allocations: { telegramId: s.authed.telegramId } } },
            { new: false },
          ).catch(() => null);
          const _mine = _pulled ? (_pulled.allocations || []).filter(a => a.telegramId === s.authed.telegramId) : [];
          if (!_mine.length) return socket.emit('clanStorageError', { msg: 'Для вас ничего не выдано' });

          const _putBack = async () => {
            await ClanModel.updateOne({ _id: clan._id }, { $push: { allocations: { $each: _mine } } }).catch(() => {});
          };

          const _byId = new Map();
          for (const a of _mine) _byId.set(a.id, (_byId.get(a.id) || 0) + (a.qty || 0));
          const _newSlots = [..._byId.keys()].filter(id => !_items.some(i => i && i.id === id)).length;
          if (_items.length + _newSlots > SERVER_INV_MAX) {
            await _putBack();
            return socket.emit('clanStorageError', { msg: 'Инвентарь полон' });
          }
          // Same partial-loss fix as the same-session path below: a kind that
          // can't be handed over goes back to the clan instead of being dropped
          // after the allocation was already pulled.
          const _granted = [];
          const _addItems = [];
          const _unclaimedX = [];
          for (const [id, q] of _byId) {
            const base = CRAFT_MATS.find(m => m.id === id);
            if (!base || q <= 0) { _unclaimedX.push(..._mine.filter(a => a.id === id)); continue; }
            _addItems.push({ item: base, qty: q });
            _granted.push({ id, name: base.name, qty: q });
          }
          if (!_granted.length) { await _putBack(); return socket.emit('clanStorageError', { msg: 'Инвентарь полон' }); }

          _target.data._applyGrant({ addItems: _addItems }, 'clan_storage_claim_cross_session',
            { clan: clan.name, items: _granted.map(g => `${g.id}x${g.qty}`).join(',') });
          if (_unclaimedX.length) {
            await ClanModel.updateOne({ _id: clan._id }, { $push: { allocations: { $each: _unclaimedX } } }).catch(() => {});
            logPlayer(s.authed.telegramId, s.authed.username, 'clan_storage_claim_partial',
              { clan: clan.name, returned: _unclaimedX.map(a => `${a.id}x${a.qty}`).join(','), crossSession: true });
          }
          const _fresh = await _myClan();
          if (_fresh) await _clanStoragePush(_fresh);
          _target.emit('clanStorageClaimed', { items: _granted });
          return;
        }

        const inv = _liveInventory();
        if (!inv) return socket.emit('clanStorageError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
        const _beforeLen = inv.length;

        const pulled = await ClanModel.findOneAndUpdate(
          { _id: clan._id, 'allocations.telegramId': s.authed.telegramId },
          { $pull: { allocations: { telegramId: s.authed.telegramId } } },
          { new: false },
        ).catch(() => null);
        const mine = pulled
          ? (pulled.allocations || []).filter(a => a.telegramId === s.authed.telegramId)
          : [];
        if (!mine.length) return socket.emit('clanStorageError', { msg: 'Для вас ничего не выдано' });

        const putBack = async () => {
          await ClanModel.updateOne({ _id: clan._id }, { $push: { allocations: { $each: mine } } }).catch(() => {});
        };

        // Merge by kind first, so "5 + 7 рубина" needs one inventory slot rather
        // than being counted as two.
        const byId = new Map();
        for (const a of mine) byId.set(a.id, (byId.get(a.id) || 0) + (a.qty || 0));
        // Space check before anything is added: a shard the player already holds
        // merges into that stack and costs nothing, a new kind costs one slot.
        const newSlots = [...byId.keys()].filter(id => !inv.some(i => i && i.id === id)).length;
        if (inv.length + newSlots > SERVER_INV_MAX) {
          await putBack();
          return socket.emit('clanStorageError', { msg: 'Инвентарь полон' });
        }
        // Anything that can't be handed over goes BACK to the clan. The
        // allocation was already pulled atomically above (so a second tap finds
        // nothing), and skipping a kind here — an id the catalog no longer has,
        // or an _invAdd the space check didn't predict — used to drop it on the
        // floor: gone from the clan, never in the inventory. The all-or-nothing
        // putBack() below only covered the case where NOTHING landed.
        const granted = [];
        const _unclaimed = [];
        for (const [id, q] of byId) {
          const base = CRAFT_MATS.find(m => m.id === id);
          if (!base || q <= 0 || !_invAdd(inv, { ...base, qty: q })) {
            _unclaimed.push(...mine.filter(a => a.id === id));
            continue;
          }
          granted.push({ id, name: base.name, qty: q });
        }
        if (!granted.length) { await putBack(); return socket.emit('clanStorageError', { msg: 'Инвентарь полон' }); }
        if (_unclaimed.length) {
          await ClanModel.updateOne({ _id: clan._id }, { $push: { allocations: { $each: _unclaimed } } }).catch(() => {});
          logPlayer(s.authed.telegramId, s.authed.username, 'clan_storage_claim_partial',
            { clan: clan.name, returned: _unclaimed.map(a => `${a.id}x${a.qty}`).join(',') });
        }

        _commitServerItems(inv, null, 'clan_storage_claim',
          { clan: clan.name, items: granted.map(g => `${g.id}x${g.qty}`).join(',') }, { beforeLen: _beforeLen });
        const fresh = await _myClan();
        if (fresh) await _clanStoragePush(fresh);
        socket.emit('clanStorageClaimed', { items: granted });
      });
      } finally {
        s.itemOpBusy--;
      }
      if (!_ran) socket.emit('clanStorageError', { msg: _ITEMS_BUSY_MSG });
    });
};
