'use strict';
// Кланы — creating, joining, applications, roles and kicks, the clan's own
// upgrades, and Хранилище клана (the shared storage with its unlock and its
// per-member deposit/claim ledger).
//
// Fourth cut into io.on('connection') and the largest so far. It takes the
// same `session` object the market, the forge and the season use, which grew
// five properties for this file:
//
//   session.clanName / clanId / clanLevel / clanIcon
//       written on BOTH sides — the handlers here set them on join, leave and
//       disband, and the login and clan-data paths in server/index.js set them
//       when a session starts or its clan changes underneath it — so these are
//       get/set pairs like `gram`, not getters.
//   session.room
//       the Room this socket stands in, read-only here. Reassigned on every
//       floor change out there, which is exactly why it cannot be captured:
//       setPlayerClan has to reach whichever Room the player is in NOW.
//
// Nothing in this file is exported. Everything it defines is local to a
// handler or to the file, which is unusual for a block this size and is what
// made it a safe one to move despite its length.
const ClanModel = require('../models/Clan');
const GuildWarStateModel = require('../models/GuildWarState');
const { FLOOR_IDS } = require('../game/floors');
const { SERVER_INV_MAX } = require('../anticheat');
const { _invAdd } = require('../inventory');
const { _sanitizeName, _sanitizeClanDesc } = require('../security');
const {
  CRAFT_MATS, UNIQUE_SHARDS, clanAtkBonusPct,
  CLAN_CREATE_COST, CLAN_MAX_MEMBERS,
  CLAN_STORAGE_MIN_DAYS, CLAN_STORAGE_UNLOCK_GOLD,
} = require('../../shared/definitions');

// See createGuildWar (server/events/guildwar.js) for why this is checked.
const REQUIRED_DEPS = [
  'socket', 'safeOn', 'io', 'activeSessions', 'logPlayer', 'logPlayerErr',
  'session', 'getRoom',
  'ITEMS_BUSY_MSG', 'beginItemOp', 'endItemOp',
  'commitServerItems', 'liveInventory',
  'clanDataFor', 'clanXpAdd', 'clearOtherClanApplications', 'notifyClan',
  'currentQuest', 'questBump', 'questPush',
  'goldNow', 'serverSpendGold', 'withEconLock',
  'escapeRegex', 'socketForTelegramId', 'gw', 'gwPublicState',
];

module.exports = function registerClanHandlers(deps) {
  const missing = REQUIRED_DEPS.filter(k => !deps || deps[k] == null);
  if (missing.length) throw new Error(`registerClanHandlers: missing deps: ${missing.join(', ')}`);
  const {
    socket, safeOn, io, activeSessions, logPlayer, logPlayerErr,
    session, getRoom,
    ITEMS_BUSY_MSG, beginItemOp, endItemOp,
    commitServerItems, liveInventory,
    clanDataFor, clanXpAdd, clearOtherClanApplications, notifyClan,
    currentQuest, questBump, questPush,
    goldNow, serverSpendGold, withEconLock,
    escapeRegex, socketForTelegramId, gw, gwPublicState,
  } = deps;

    // ── Clan handlers ─────────────────────────────────────────────
    // _clanDataFor / _notifyClan now live at module scope (see the clan helpers
    // block above) — they take no closure state, and the batched XP flusher
    // needs them too.

    safeOn('clanCreate', async ({ name, icon }) => {
      if (!session.authed) return;
      // Same normalisation player names get (_safeUsername): a clan tag is shown
      // over every member's head and in other players' panels, so it must not be
      // able to carry markup or control characters either.
      const n = _sanitizeName(name).slice(0, 10).trim();
      if (!n) return socket.emit('clanError', { msg: 'Введите название' });
      if (typeof icon !== 'number' || icon < 1 || icon > 30) return socket.emit('clanError', { msg: 'Неверная иконка' });
      const existing = await ClanModel.findOne({ 'members.telegramId': session.authed.telegramId }).catch(() => null);
      if (existing) return socket.emit('clanError', { msg: 'Вы уже в клане' });
      // The founding fee was deducted on the client and reported by the next
      // save — so the server created the clan without ever charging for it, and
      // a client that simply skipped the deduction founded one for free. Charged
      // here, before the clan exists, so a failure cannot leave one unpaid.
      if (goldNow() < CLAN_CREATE_COST) {
        return socket.emit('clanError', { msg: `Нужно ${CLAN_CREATE_COST} золота` });
      }
      try {
        const clan = await ClanModel.create({
          name: n, icon,
          members: [{ telegramId: session.authed.telegramId, username: session.authed.username, role: 'leader' }],
        });
        await serverSpendGold(CLAN_CREATE_COST, 'clan_create');
        if (currentQuest() && currentQuest().type === 'join_guild') { questBump('_guild', 1); questPush(); }
        const _cd = await clanDataFor(clan, session.authed.telegramId);
        socket.emit('clanData', _cd);
        session.clanName  = _cd ? _cd.name : null;
        session.clanIcon  = _cd ? _cd.icon : null;
        session.clanId    = _cd ? String(_cd._id) : null;
        session.clanLevel = _cd ? _cd.level : null;
        session.room?.setPlayerClan(socket.id, session.clanName, session.clanIcon, clanAtkBonusPct(session.clanLevel), session.clanId);
        // Founding a clan makes any application still pending elsewhere moot —
        // without this it could sit in that other clan's queue and get approved
        // later, leaving this account in two clans at once.
        await clearOtherClanApplications(session.authed.telegramId);
      } catch (e) {
        if (e.code === 11000) socket.emit('clanError', { msg: 'Название занято' });
        else socket.emit('clanError', { msg: 'Ошибка создания' });
      }
    });

    safeOn('clanSetDescription', async ({ description } = {}) => {
      if (!session.authed) return;
      const clan = await ClanModel.findOne({ 'members.telegramId': session.authed.telegramId }).catch(() => null);
      if (!clan) return;
      if (clan.members.find(m => m.telegramId === session.authed.telegramId)?.role !== 'leader') return;
      clan.description = _sanitizeClanDesc(description);
      await clan.save().catch(() => {});
      await notifyClan(clan);
    });

    safeOn('clanSearch', async ({ query }) => {
      if (!session.authed) return;
      const q = (query || '').trim().slice(0, 32);
      const filter = q ? { name: { $regex: escapeRegex(q), $options: 'i' } } : {};
      const clans = await ClanModel.find(filter).sort({ level: -1, xp: -1 }).limit(20).catch(() => []);
      socket.emit('clanSearchResults', clans.map(c => ({
        _id: c._id, name: c.name, icon: c.icon, level: c.level, members: c.members.length,
      })));
    });

    safeOn('clanApply', async ({ clanId }) => {
      if (!session.authed) return;
      const inClan = await ClanModel.findOne({ 'members.telegramId': session.authed.telegramId }).catch(() => null);
      if (inClan) return socket.emit('clanError', { msg: 'Вы уже в клане' });
      const clan = await ClanModel.findById(clanId).catch(() => null);
      if (!clan) return socket.emit('clanError', { msg: 'Клан не найден' });
      // Only one pending application at a time — applying to a new clan
      // withdraws any application still pending elsewhere, so a leader never
      // approves someone who already joined a different clan in the meantime.
      await clearOtherClanApplications(session.authed.telegramId, clan._id);
      if (clan.applications.find(a => a.telegramId === session.authed.telegramId)) return;
      clan.applications.push({ telegramId: session.authed.telegramId, username: session.authed.username });
      await clan.save().catch(() => {});
      // Dedicated event rather than piggybacking the generic 'clanError' channel
      // with a checkmark-prefixed message — the client needs to tell this success
      // apart from an actual error to give the applied button its own confirmed
      // state instead of a toast that reads as a warning.
      socket.emit('clanApplySent', { clanId: String(clan._id) });
      await notifyClan(clan);
    });

    // On-demand clan refresh, for when the player opens the clan tab. Replaces
    // what the per-kill clanData push used to do by accident — it kept the XP
    // bar live at the cost of a full clan read + packet on every monster death.
    // One read when the panel is actually being looked at is the same
    // information for a rounding error of the cost. Rate-limited as a heavy
    // event like every other clan handler.
    safeOn('clanRequest', async () => {
      if (!session.authed || !session.clanId) return;
      const clan = await ClanModel.findById(session.clanId).catch(() => null);
      if (!clan) return socket.emit('clanData', null);
      socket.emit('clanData', await clanDataFor(clan, session.authed.telegramId));
    });

    safeOn('clanApprove', async ({ telegramId }) => {
      if (!session.authed) return;
      const clan = await ClanModel.findOne({ 'members.telegramId': session.authed.telegramId }).catch(() => null);
      if (!clan) return;
      if (clan.members.find(m => m.telegramId === session.authed.telegramId)?.role !== 'leader') return;
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
      await clearOtherClanApplications(telegramId, clan._id);
      const _fresh = await ClanModel.findById(clan._id).catch(() => null);
      await notifyClan(_fresh || clan);
    });

    safeOn('clanDecline', async ({ telegramId }) => {
      if (!session.authed) return;
      const clan = await ClanModel.findOne({ 'members.telegramId': session.authed.telegramId }).catch(() => null);
      if (!clan) return;
      if (clan.members.find(m => m.telegramId === session.authed.telegramId)?.role !== 'leader') return;
      clan.applications = clan.applications.filter(a => a.telegramId !== telegramId);
      await clan.save().catch(() => {});
      const _cdDecl = await clanDataFor(clan, session.authed.telegramId);
      socket.emit('clanData', _cdDecl);
      session.clanName  = _cdDecl ? _cdDecl.name : null;
      session.clanIcon  = _cdDecl ? _cdDecl.icon : null;
      session.clanId    = _cdDecl ? String(_cdDecl._id) : null;
      session.clanLevel = _cdDecl ? _cdDecl.level : null;
      session.room?.setPlayerClan(socket.id, session.clanName, session.clanIcon, clanAtkBonusPct(session.clanLevel), session.clanId);
    });

    safeOn('clanKick', async ({ telegramId }) => {
      if (!session.authed) return;
      const clan = await ClanModel.findOne({ 'members.telegramId': session.authed.telegramId }).catch(() => null);
      if (!clan) return;
      if (clan.members.find(m => m.telegramId === session.authed.telegramId)?.role !== 'leader') return;
      if (telegramId === session.authed.telegramId) return;
      // Their unclaimed shards return to the pool first — once the member row is
      // gone nobody can collect them and they would be stuck in the document.
      await _clanReclaimAllocations(clan._id, telegramId);
      // Atomic $pull — see clanApprove above for why a full-document save here
      // drops concurrent changes.
      await ClanModel.updateOne({ _id: clan._id }, { $pull: { members: { telegramId } } }).catch(() => {});
      clan.members = clan.members.filter(m => m.telegramId !== telegramId);
      await notifyClan(clan);
      // Notify kicked player
      const kicked = socketForTelegramId(telegramId);
      if (kicked) {
        kicked.emit('clanData', null);
        // Clears their _myClanId/_myClanName/_myClanIcon and the room clan tag
        // in one go — see _setClanIdentity.
        kicked.data._setClanIdentity?.(null, null, null);
      }
    });

    safeOn('clanLeave', async () => {
      if (!session.authed) return;
      const clan = await ClanModel.findOne({ 'members.telegramId': session.authed.telegramId }).catch(() => null);
      if (!clan) return;
      const myEntry = clan.members.find(m => m.telegramId === session.authed.telegramId);
      if (!myEntry) return;
      // Same as clanKick: hand anything still allocated back to the clan rather
      // than walking out with it locked in the document.
      await _clanReclaimAllocations(clan._id, session.authed.telegramId);
      if (myEntry.role === 'leader') {
        // Promote next member or disband
        const others = clan.members.filter(m => m.telegramId !== session.authed.telegramId);
        if (others.length > 0) {
          // Two targeted updates rather than rewriting the member array: the
          // leaver is pulled and the successor promoted in place, so a member who
          // joined between this read and this write isn't dropped.
          await ClanModel.updateOne(
            { _id: clan._id },
            { $pull: { members: { telegramId: session.authed.telegramId } } },
          ).catch(() => {});
          await ClanModel.updateOne(
            { _id: clan._id, 'members.telegramId': others[0].telegramId },
            { $set: { 'members.$.role': 'leader' } },
          ).catch(() => {});
          const _fresh = await ClanModel.findById(clan._id).catch(() => null);
          await notifyClan(_fresh || clan);
        } else {
          // Last member out: the clan document (and the shard pool inside it) is
          // about to be deleted. Everything in that pool was put there by this
          // same account — they are the only member — so it goes back to them
          // rather than being destroyed.
          const _pool = await ClanModel.findById(clan._id, 'storage').lean().catch(() => null);
          const _rows = (_pool?.storage || []).filter(e => e && e.qty > 0);
          if (_rows.length) {
            const inv = liveInventory();
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
            commitServerItems(inv, null, 'clan_storage_return', { clan: clan.name, items: _got.join(',') }, { beforeLen: _beforeLen });
          }
          await ClanModel.deleteOne({ _id: clan._id }).catch(() => {});
        }
      } else {
        await ClanModel.updateOne(
          { _id: clan._id },
          { $pull: { members: { telegramId: session.authed.telegramId } } },
        ).catch(() => {});
        clan.members = clan.members.filter(m => m.telegramId !== session.authed.telegramId);
        await notifyClan(clan);
      }
      socket.emit('clanData', null);
      session.clanName  = null;
      session.clanIcon  = null;
      session.clanId    = null;
      session.clanLevel = null;
      session.room?.setPlayerClan(socket.id, null, null, 0, null);
    });

    safeOn('clanDisband', async () => {
      if (!session.authed) return;
      const clan = await ClanModel.findOne({ 'members.telegramId': session.authed.telegramId }).catch(() => null);
      if (!clan) return;
      if (clan.members.find(m => m.telegramId === session.authed.telegramId)?.role !== 'leader') return;
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
        const target = socketForTelegramId(m.telegramId);
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
      if (gw.ownerClanId && String(gw.ownerClanId) === String(clan._id)) {
        gw.ownerClanId = null; gw.ownerClanName = null; gw.ownerClanIcon = null; gw.capturedAt = 0;
        await GuildWarStateModel.updateOne(
          { key: 'castle' },
          { $set: { ownerClanId: null, ownerClanName: null, ownerClanIcon: null, capturedAt: 0 } },
          { upsert: true },
        ).catch(err => console.error('[GuildWarState] disband release failed', err));
        const _gwRoom = getRoom(FLOOR_IDS.guildWar);
        const _gwTower = _gwRoom && _gwRoom._gwTowerId && _gwRoom._enemyMap.get(_gwRoom._gwTowerId);
        if (_gwTower) { _gwTower.ownerClanId = null; _gwTower.ownerClanName = null; _gwTower.ownerClanIcon = null; }
        io.emit('guildWarState', gwPublicState());
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

    // ── Хранилище клана ───────────────────────────────────────────────────────
    // A shared pool of Осколки: members deposit, the leader decides who gets
    // what. Shards do NOT go straight from the pool into the recipient's
    // inventory — the leader allocates, the member collects. The recipient is
    // usually offline when a leader hands things out, and writing items into an
    // offline account's saved inventory races that account's own next login;
    // making the member collect means every grant lands through their own live
    // session and _commitServerItems, the same path all other server-side item
    // grants use.
    //
    // Every mutation below is a single conditional Mongo update rather than
    // read-modify-write: two members depositing, or a leader handing out the
    // same stack twice from two taps, must not be able to interleave.

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
        const target = socketForTelegramId(m.telegramId);
        if (target) target.emit('clanStorage', _clanStoragePayload(clan, m.telegramId));
      }
    }

    async function _myClan() {
      if (!session.authed) return null;
      return ClanModel.findOne({ 'members.telegramId': session.authed.telegramId }).catch(() => null);
    }

    safeOn('clanStorageSync', async () => {
      const clan = await _myClan();
      if (!clan) return socket.emit('clanStorage', null);
      socket.emit('clanStorage', _clanStoragePayload(clan, session.authed.telegramId));
    });

    // The leader buys the storage for the clan, once, out of their own gold.
    //
    // Gold is the one currency the server does not own outright — it rides in on
    // the client's save blob — so the deduction has to be told to the client as
    // an absolute (newGold) the way the merchant sale does, or their next
    // autosave would put the million straight back.
    safeOn('clanStorageUnlock', async () => {
      if (!session.authed) return;
      const _ran = await withEconLock(async () => {
        const clan = await _myClan();
        if (!clan) return socket.emit('clanStorageError', { msg: 'Вы не в клане' });
        if (clan.members.find(m => m.telegramId === session.authed.telegramId)?.role !== 'leader') {
          return socket.emit('clanStorageError', { msg: 'Открыть хранилище может только лидер' });
        }
        if (clan.storageUnlocked) {
          return socket.emit('clanStorageError', { msg: 'Хранилище уже открыто' });
        }
        if (!session.lastStats) return socket.emit('clanStorageError', { msg: 'Данные ещё не загружены — попробуйте ещё раз' });
        const gold = Math.floor(Number(session.lastStats.gold) || 0);
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

        await serverSpendGold(CLAN_STORAGE_UNLOCK_GOLD, 'clan_storage_unlock');
        logPlayer(session.authed.telegramId, session.authed.username, 'clan_storage_unlock',
          { clan: clan.name, cost: CLAN_STORAGE_UNLOCK_GOLD, goldBefore: gold, goldLeft: session.lastStats.gold });
        socket.emit('clanStorageUnlocked', { newGold: session.lastStats.gold, cost: CLAN_STORAGE_UNLOCK_GOLD });
        await _clanStoragePush(claimed);
      });
      if (!_ran) socket.emit('clanStorageError', { msg: ITEMS_BUSY_MSG });
    });

    safeOn('clanStorageDeposit', async ({ id, qty } = {}) => {
      if (!session.authed) return;
      beginItemOp();
      let _ran;
      try {
      _ran = await withEconLock(async () => {
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
        if (!_clanStorageOk(clan, session.authed.telegramId)) {
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
        if (activeSessions.get(session.authed.telegramId) !== socket.id) {
          const _target = socketForTelegramId(session.authed.telegramId);
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
            logPlayerErr(session.authed.telegramId, session.authed.username, 'clan_storage_deposit', err, { id, qty: n });
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

        const inv = liveInventory();
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
          logPlayerErr(session.authed.telegramId, session.authed.username, 'clan_storage_deposit', err, { id, qty: n });
          return socket.emit('clanStorageError', { msg: 'Ошибка сервера' });
        }

        commitServerItems(inv, null, 'clan_storage_deposit', { id, qty: n, clan: clan.name }, { beforeLen: _beforeLen });
        const fresh = await _myClan();
        if (fresh) await _clanStoragePush(fresh);
        socket.emit('clanStorageOk', { msg: `Передано в хранилище: ${n}` });
      });
      } finally {
        endItemOp();
      }
      if (!_ran) socket.emit('clanStorageError', { msg: ITEMS_BUSY_MSG });
    });

    // Leader hands part of the pool to a member. Nothing reaches their inventory
    // here — it becomes an allocation they collect (see clanStorageClaim).
    safeOn('clanStorageGive', async ({ telegramId, id, qty } = {}) => {
      if (!session.authed) return;
      const n = Math.floor(Number(qty));
      if (!Number.isFinite(n) || n <= 0) return;
      const clan = await _myClan();
      if (!clan) return;
      if (!clan.storageUnlocked) {
        return socket.emit('clanStorageError', { msg: 'Хранилище клана ещё не открыто' });
      }
      if (clan.members.find(m => m.telegramId === session.authed.telegramId)?.role !== 'leader') {
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
            id, qty: n, byUsername: session.authed.username, at: new Date(),
          } },
        },
        { new: true },
      ).catch(() => null);
      if (!upd) return socket.emit('clanStorageError', { msg: 'В хранилище столько нет' });
      logPlayer(session.authed.telegramId, session.authed.username, 'clan_storage_give',
        { to: target.username, toTid: target.telegramId, id, qty: n, clan: clan.name });
      await _clanStoragePush(upd);
      socket.emit('clanStorageOk', { msg: `Выдано ${target.username}: ${n}` });
    });

    // Leader takes an unclaimed allocation back into the pool — the only way to
    // undo a mis-tap, since the recipient may simply never collect it.
    safeOn('clanStorageCancel', async ({ telegramId, id } = {}) => {
      if (!session.authed) return;
      const clan = await _myClan();
      if (!clan) return;
      if (clan.members.find(m => m.telegramId === session.authed.telegramId)?.role !== 'leader') return;
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
      if (!session.authed) return;
      beginItemOp();
      let _ran;
      try {
      _ran = await withEconLock(async () => {
        const clan = await _myClan();
        if (!clan) return;
        if (!clan.storageUnlocked) {
          return socket.emit('clanStorageError', { msg: 'Хранилище клана ещё не открыто' });
        }
        if (!_clanStorageOk(clan, session.authed.telegramId)) {
          return socket.emit('clanStorageError', {
            msg: `Хранилище доступно после ${CLAN_STORAGE_MIN_DAYS} дней в клане`,
          });
        }

        // Cross-session guard, mirrors clanStorageDeposit above.
        if (activeSessions.get(session.authed.telegramId) !== socket.id) {
          const _target = socketForTelegramId(session.authed.telegramId);
          const _items = _target && _target.data._adminReadItems ? _target.data._adminReadItems().inventory : null;
          if (!_target || !Array.isArray(_items)) {
            return socket.emit('clanStorageError', { msg: 'Сессия недоступна — попробуйте ещё раз' });
          }

          const _pulled = await ClanModel.findOneAndUpdate(
            { _id: clan._id, 'allocations.telegramId': session.authed.telegramId },
            { $pull: { allocations: { telegramId: session.authed.telegramId } } },
            { new: false },
          ).catch(() => null);
          const _mine = _pulled ? (_pulled.allocations || []).filter(a => a.telegramId === session.authed.telegramId) : [];
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
            logPlayer(session.authed.telegramId, session.authed.username, 'clan_storage_claim_partial',
              { clan: clan.name, returned: _unclaimedX.map(a => `${a.id}x${a.qty}`).join(','), crossSession: true });
          }
          const _fresh = await _myClan();
          if (_fresh) await _clanStoragePush(_fresh);
          _target.emit('clanStorageClaimed', { items: _granted });
          return;
        }

        const inv = liveInventory();
        if (!inv) return socket.emit('clanStorageError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
        const _beforeLen = inv.length;

        const pulled = await ClanModel.findOneAndUpdate(
          { _id: clan._id, 'allocations.telegramId': session.authed.telegramId },
          { $pull: { allocations: { telegramId: session.authed.telegramId } } },
          { new: false },
        ).catch(() => null);
        const mine = pulled
          ? (pulled.allocations || []).filter(a => a.telegramId === session.authed.telegramId)
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
          logPlayer(session.authed.telegramId, session.authed.username, 'clan_storage_claim_partial',
            { clan: clan.name, returned: _unclaimed.map(a => `${a.id}x${a.qty}`).join(',') });
        }

        commitServerItems(inv, null, 'clan_storage_claim',
          { clan: clan.name, items: granted.map(g => `${g.id}x${g.qty}`).join(',') }, { beforeLen: _beforeLen });
        const fresh = await _myClan();
        if (fresh) await _clanStoragePush(fresh);
        socket.emit('clanStorageClaimed', { items: granted });
      });
      } finally {
        endItemOp();
      }
      if (!_ran) socket.emit('clanStorageError', { msg: ITEMS_BUSY_MSG });
    });

    // One point of clan XP for the kill — now a Map increment and nothing else.
    // See the clan XP batching block at module scope for why: this used to be
    // four DB round trips and a full clanData packet on every monster death.
    // Deliberately not async any more; the call sites' `.catch(() => {})` is
    // harmless on undefined-returning calls but has been dropped where it stood.
    function _onKillClanXp() {
      if (!session.authed || !session.clanId) return;
      clanXpAdd(session.clanId, 1);
    }

  // Awarding clan XP on a kill is driven from the attack handlers in
  // server/index.js, not from anything in this file — it is the one name here
  // the closure still needs, so it is the only thing returned.
  return { onKillClanXp: _onKillClanXp };
};
