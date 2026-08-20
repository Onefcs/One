'use strict';
// Guild War (Война гильдий) — tower ownership, combat window, and hourly
// income — moved out of server/index.js verbatim as a factory
// (createGuildWar(deps)), same pattern as arena3.js/death-battle.js.
const {
  GUILD_WAR_DAYS_MSK, GUILD_WAR_HOURS_MSK, GUILD_WAR_WINDOW_MS, GUILD_WAR_TOWER_HP,
  GUILD_WAR_SHARD_MIN, GUILD_WAR_SHARD_MAX, GUILD_WAR_INCOME_INTERVAL_MS,
  EVENT_NOTIFY_BEFORE_MS, nextEventStartAt,
  UNIQUE_SHARDS,
} = require('../../shared/definitions');
const { FLOOR_IDS } = require('../game/floors');
const ClanModel = require('../models/Clan');
const GuildWarStateModel = require('../models/GuildWarState');

module.exports = function createGuildWar(deps) {
  const {
    io, playerFloorMap, _socketForTelegramId, notifyEventSoon, notifyEventStarted, safeTimeout,
  } = deps;

  // ── Война гильдий (Guild War) ────────────────────────────────────────────────
  // One sealed zone, open daily 22:00-22:15 MSK, containing one stationary
  // tower (Room.spawnGuildWarTower). Whichever clan lands the killing blow
  // owns it — Room.attackEnemy/skillAttackEnemy reset its hp to maxHp in
  // place and reassign ownership the instant it happens (see result.captured,
  // handled below by _gwApplyCapture). Ownership itself has no schedule: it
  // persists across the closed 22:15-22:00 gap and pays out passive income
  // every hour, 24/7 (_gwGrantIncome), independent of whether the zone is
  // currently open for combat — only combat access follows the window.
  const _gw = {
    phase: 'closed',      // 'closed' → 'live' (22:00-22:15 MSK) → 'closed'
    ownerClanId: null, ownerClanName: null, ownerClanIcon: null, capturedAt: 0,
    openTimer: null, closeTimer: null, notifyTimer: null, incomeTimer: null,
  };

  function _gwNextOpenAt(from = Date.now()) {
    return nextEventStartAt(GUILD_WAR_DAYS_MSK, GUILD_WAR_HOURS_MSK, from);
  }

  function _gwPublicState() {
    return {
      phase: _gw.phase,
      nextAt: _gwNextOpenAt(),
      ownerClanId: _gw.ownerClanId, ownerClanName: _gw.ownerClanName, ownerClanIcon: _gw.ownerClanIcon,
      capturedAt: _gw.capturedAt,
      towerHp: GUILD_WAR_TOWER_HP,
    };
  }

  // Arms the next daily window (22:00 MSK) plus its 30-minute warning. Called
  // at boot and every time the window closes — same shape as _race10Schedule.
  function _gwSchedule() {
    clearTimeout(_gw.openTimer);
    clearTimeout(_gw.notifyTimer);
    const openAt = _gwNextOpenAt();
    _gw.openTimer = safeTimeout('gwOpen', () => _gwOpenWindow(openAt), Math.max(0, openAt - Date.now()));
    const warnIn = openAt - EVENT_NOTIFY_BEFORE_MS - Date.now();
    if (warnIn > 0) _gw.notifyTimer = safeTimeout('gwNotify', () => notifyEventSoon('guildWar', openAt), warnIn);
  }

  function _gwOpenWindow(openAt = Date.now()) {
    _gw.phase = 'live';
    notifyEventStarted('guildWar', openAt);
    clearTimeout(_gw.closeTimer);
    _gw.closeTimer = safeTimeout('gwClose', _gwCloseWindow, GUILD_WAR_WINDOW_MS);
    io.emit('guildWarState', _gwPublicState());
  }

  // Hard-closes combat access: whoever holds the tower right now keeps it
  // (ownership doesn't reset here, only the closeTimer/phase do) and everyone
  // still standing inside the zone is ejected to the hub. Re-arms tomorrow's
  // window immediately, same as _race10CloseWindow.
  //
  // Guild War is its own floor now (see server/game/floors.js), so "ejected"
  // means a real floor change, not just a position/flag reset within one
  // shared Room — that's what _forceEnterLocation (socket.data, set up per
  // connection near the enterLocation handler) exists for: this runs from a
  // module-level timer with no socket of its own in scope, so it has to reach
  // into each affected connection from outside.
  function _gwCloseWindow() {
    _gw.phase = 'closed';
    clearTimeout(_gw.closeTimer);
    for (const [sid, floor] of playerFloorMap) {
      if (floor !== FLOOR_IDS.guildWar) continue;
      io.sockets.sockets.get(sid)?.data?._forceEnterLocation?.('hub');
    }
    io.emit('guildWarState', _gwPublicState());
    _gwSchedule();
  }

  // Applies a capture result from Room.attackEnemy/skillAttackEnemy
  // (result.captured) — updates the in-memory owner, persists it, and tells
  // everyone. Module-level (not per-connection) since result is self-contained
  // and the hourly income job (below) needs the same _gw.ownerClanId it writes.
  function _gwApplyCapture(result) {
    _gw.ownerClanId = result.newOwnerClanId;
    _gw.ownerClanName = result.newOwnerClanName;
    _gw.ownerClanIcon = result.newOwnerClanIcon;
    _gw.capturedAt = Date.now();
    GuildWarStateModel.updateOne(
      { key: 'castle' },
      { $set: { ownerClanId: _gw.ownerClanId, ownerClanName: _gw.ownerClanName, ownerClanIcon: _gw.ownerClanIcon, capturedAt: _gw.capturedAt } },
      { upsert: true },
    ).catch(err => console.error('[GuildWarState] persist failed', err));
    io.emit('guildWarCaptured', {
      newOwnerClanName: result.newOwnerClanName, newOwnerClanIcon: result.newOwnerClanIcon,
      prevOwnerClanName: result.prevOwnerClanName,
    });
    io.emit('guildWarState', _gwPublicState());
  }

  // shardName/shardImg used to only exist inside io.on('connection', ...) (see
  // the per-connection clan-storage handlers further down) — moved to module
  // scope (unchanged) so the hourly income job below, which runs from a
  // top-level setTimeout chain with no socket in scope, can reach them too.
  const _gwShardName = id => (UNIQUE_SHARDS.find(s => s.id === id) || {}).name || id;
  const _gwShardImg  = id => (UNIQUE_SHARDS.find(s => s.id === id) || {}).img || null;

  // Same $inc-then-$push pattern already inlined a few times elsewhere for
  // clan storage credit (e.g. the deposit/allocation-return handlers further
  // down) — factored out here since the income job needs it and there was no
  // shared top-level version yet.
  async function _grantClanStorage(clanId, id, qty) {
    const bumped = await ClanModel.updateOne({ _id: clanId, 'storage.id': id }, { $inc: { 'storage.$.qty': qty } });
    if (!bumped.matchedCount) {
      await ClanModel.updateOne({ _id: clanId, 'storage.id': { $ne: id } }, { $push: { storage: { id, qty } } });
    }
  }

  // Pushes a fresh clanStorage payload to every online member — top-level twin
  // of the per-connection _clanStoragePush, needed for the same reason
  // shardName/shardImg were moved up: no socket in scope inside the income job.
  function _gwStoragePushToClan(clan) {
    clan.members.forEach(m => {
      const target = _socketForTelegramId(m.telegramId);
      if (!target) return;
      target.emit('clanStorage', {
        storageUnlocked: !!clan.storageUnlocked,
        storage: (clan.storage || []).filter(e => e && e.qty > 0)
          .map(e => ({ id: e.id, name: _gwShardName(e.id), img: _gwShardImg(e.id), qty: e.qty })),
      });
    });
  }

  // A random total of GUILD_WAR_SHARD_MIN..MAX shard units, each an
  // independent uniform-random pick across UNIQUE_SHARDS' kinds — reads as
  // "assorted" without any rarity weighting, which nothing in the brief asked
  // for. Pure function, easy to sanity-check in isolation (see plan's
  // verification section).
  function _rollGuildWarIncome() {
    const total = GUILD_WAR_SHARD_MIN + Math.floor(Math.random() * (GUILD_WAR_SHARD_MAX - GUILD_WAR_SHARD_MIN + 1));
    const counts = new Map();
    for (let i = 0; i < total; i++) {
      const sh = UNIQUE_SHARDS[Math.floor(Math.random() * UNIQUE_SHARDS.length)];
      counts.set(sh.id, (counts.get(sh.id) || 0) + 1);
    }
    return [...counts.entries()].map(([id, qty]) => ({ id, qty }));
  }

  // The first sub-daily recurring job in this codebase — every other scheduled
  // event is a daily (or less frequent) nextEventStartAt chain. Aligns to the
  // next wall-clock hour boundary (not "boot + 1h") so a mid-hour redeploy
  // doesn't reset the cadence, and re-reads the owning clan fresh from Mongo
  // on every fire (never trusts the cached name/icon) since it may have been
  // renamed, or disbanded (handled by the clanDisband hook releasing
  // _gw.ownerClanId) since the last grant. No retroactive back-pay for a
  // missed hour during downtime — it's simply skipped, matching how nothing
  // else in this codebase back-pays offline time.
  async function _gwGrantIncome() {
    if (!_gw.ownerClanId) return;
    const clan = await ClanModel.findById(_gw.ownerClanId).catch(() => null);
    if (!clan) { _gw.ownerClanId = null; _gw.ownerClanName = null; _gw.ownerClanIcon = null; return; }
    const grant = _rollGuildWarIncome();
    for (const { id, qty } of grant) await _grantClanStorage(clan._id, id, qty);
    const fresh = await ClanModel.findById(clan._id).catch(() => null);
    if (fresh) _gwStoragePushToClan(fresh);
  }

  function _gwIncomeSafe() {
    _gwGrantIncome().catch(err => console.error('_gwGrantIncome:', err));
    _gw.incomeTimer = safeTimeout('gwIncome', _gwIncomeSafe, GUILD_WAR_INCOME_INTERVAL_MS);
  }

  function _gwIncomeSchedule() {
    clearTimeout(_gw.incomeTimer);
    const now = Date.now();
    const nextHour = Math.ceil(now / GUILD_WAR_INCOME_INTERVAL_MS) * GUILD_WAR_INCOME_INTERVAL_MS;
    _gw.incomeTimer = safeTimeout('gwIncome', _gwIncomeSafe, nextHour - now);
  }

  return {
    _gw, _gwNextOpenAt, _gwPublicState, _gwSchedule, _gwOpenWindow, _gwCloseWindow,
    _gwApplyCapture, _gwIncomeSchedule,
  };
};
