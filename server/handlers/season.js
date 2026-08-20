'use strict';
// Сезон — the seasonal quest, its species tiers, the points ledger the prizes
// are decided from, and burning points for a reward.
//
// Third cut into io.on('connection'), on the `session` object the market and
// the forge already use. Nothing here writes session state: the season reads
// session.lastStats and session.authed and persists through
// persistSavedFields, which writes named sub-fields rather than the whole
// blob — the season's rows are the ones an appeal gets checked against, so
// they are never part of a wholesale save that a stale client could overwrite.
const PlayerModel = require('../models/Player');
const {
  SEASON_END_AT, SEASON_QUEST_KILLS, SEASON_QUEST_POINTS,
  SEASON_BURN_POINTS, SEASON_PRIZES, seasonActive,
  SEASON_EVENT_POINTS, SEASON_EVENT_TASKS, SEASON_ENHANCE_POINTS,
  SEASON_WIN_POINTS, SEASON_REF_POINTS, SEASON_REF_LEVEL,
  SEASON_TIERS, SEASON_TIER_DEFAULT, SEASON_TIER_SPECIES_LEVELS, seasonTier,
} = require('../../shared/definitions');

// See createGuildWar (server/events/guildwar.js) for why this is checked.
const REQUIRED_DEPS = [
  'socket', 'safeOn', 'logPlayer', 'logPlayerErr', 'session',
  'persistSavedFields', 'seasonRollSpecies', 'seasonTierAllowed',
];

module.exports = function registerSeasonHandlers(deps) {
  const missing = REQUIRED_DEPS.filter(k => !deps || deps[k] == null);
  if (missing.length) throw new Error(`registerSeasonHandlers: missing deps: ${missing.join(', ')}`);
  const {
    socket, safeOn, logPlayer, logPlayerErr, session,
    persistSavedFields, seasonRollSpecies, seasonTierAllowed,
  } = deps;

    // ── Сезон ─────────────────────────────────────────────────────────────────
    // Every point is added right here. seasonPoints/seasonQuest never travel in
    // from a client save (_sanitizeSavedStats drops them, same as the balances),
    // so the leaderboard the prizes are read off cannot be written to by the
    // people competing on it.
    // Held here rather than on _lastStats: that object is REPLACED wholesale by
    // every saveProgress with the sanitized client blob, and the sanitizer
    // deletes both season fields (they must never arrive from a client). Keeping
    // them there meant each save silently wiped the running total and the quest
    // progress from memory — the panel fell back to 0 and a fresh quest was
    // rolled every few seconds. Same reason the currency balances live in their
    // own closure variables.
    let _seasonPoints = 0;
    // One quest per band, keyed by tier id, plus which band is selected. Both
    // are kept rather than a single active quest so that switching bands and
    // back resumes where the player left off — otherwise the switch would be a
    // free reroll of a species someone didn't like, and 5000 kills of progress
    // would evaporate on a mis-tap.
    let _seasonQuests = {};
    let _seasonTierCur = SEASON_TIER_DEFAULT;
    let _seasonKillsUnsaved = 0;
    // True while a completed quest's award is mid-flight. The award is async and
    // kills keep arriving, so without this several of them would each fire their
    // own award for the same finished quest.
    let _seasonQuestAwarding = false;

    // The selected band, demoted to the default if the player is not (or is no
    // longer) high enough for it.
    function _seasonTierId() {
      const lvl = session.lastStats ? session.lastStats.lvl : 1;
      return seasonTierAllowed(_seasonTierCur, lvl) ? _seasonTierCur : SEASON_TIER_DEFAULT;
    }

    // The active band's quest, created on first use. An unknown species (a save
    // from before this existed, or a table change) is re-rolled rather than
    // trusted.
    function _seasonQuest() {
      if (!session.lastStats) return null;
      const tid = _seasonTierId();
      const q = _seasonQuests[tid];
      const lvl = Math.max(1, Math.floor(Number(session.lastStats.lvl)) || 1);
      const def = q && typeof q === 'object' ? seasonTier(tid).species.find(s => s.sp === q.sp) : null;
      if (def && (def.req || 0) <= lvl) return q;
      const fresh = { sp: seasonRollSpecies(null, session.lastStats.lvl, tid), kills: 0 };
      _seasonQuests[tid] = fresh;
      persistSavedFields(session.authed, { seasonQuests: _seasonQuests, seasonTier: tid });
      return fresh;
    }

    // A quest as the client renders it: the species' display name and the exact
    // levels it can be found at, which is what the quest text names instead of
    // the band (zombies only live at 21, so "21-23" would send players through
    // rooms that cannot contain one).
    function _seasonQuestPublic(q, tid) {
      if (!q) return null;
      const def = seasonTier(tid).species.find(s => s.sp === q.sp);
      return {
        sp: q.sp,
        name: def ? def.name : q.sp,
        levels: (SEASON_TIER_SPECIES_LEVELS[tid] || {})[q.sp] || [],
        kills: Math.min(q.kills || 0, SEASON_QUEST_KILLS),
        tier: tid,
      };
    }

    function _seasonPublicState() {
      const tid = _seasonTierId();
      const q = _seasonQuest();
      const lvl = session.lastStats ? (Math.floor(Number(session.lastStats.lvl)) || 1) : 1;
      const t = seasonTier(tid);
      return {
        endAt: SEASON_END_AT,
        active: seasonActive(),
        points: _seasonPoints,
        quest: _seasonQuestPublic(q, tid),
        target: SEASON_QUEST_KILLS,
        questPoints: SEASON_QUEST_POINTS,
        // The selected band's own range, so the panel describes what is actually
        // being hunted rather than the 10+ one it used to hard-code.
        minLvl: t.minLvl, maxLvl: t.maxLvl,
        tier: tid,
        tiers: SEASON_TIERS.map(x => ({
          id: x.id, label: x.label, reqLvl: x.reqLvl,
          minLvl: x.minLvl, maxLvl: x.maxLvl,
          locked: lvl < (x.reqLvl || 0),
        })),
        burn: SEASON_BURN_POINTS,
        eventTasks: SEASON_EVENT_TASKS,
        enhance: SEASON_ENHANCE_POINTS,
        eventPoints: SEASON_EVENT_POINTS,
        win: SEASON_WIN_POINTS,
        ref: { points: SEASON_REF_POINTS, level: SEASON_REF_LEVEL },
        prizes: SEASON_PRIZES,
      };
    }

    // Atomic, like the currency balances — two sockets for one account (a
    // reconnect overlapping its predecessor) must not lose each other's points.
    async function _seasonAddPoints(n, reason, meta) {
      if (!session.authed || !Number.isFinite(n) || n <= 0) return null;
      if (!seasonActive()) {
        logPlayer(session.authed.telegramId, session.authed.username, 'season_points_failed',
          { add: n, reason, why: 'season_over', ...(meta || {}) });
        return null;
      }
      try {
        // An account that only ever pressed /start has savedData: null, and a
        // dotted $inc against a null parent THROWS instead of creating it — the
        // same trap _incBalance documents. Without this the award was lost and
        // the only trace was a console line.
        await PlayerModel.updateOne(
          { telegramId: String(session.authed.telegramId), savedData: null },
          { $set: { savedData: {} } },
        );
        const doc = await PlayerModel.findOneAndUpdate(
          { telegramId: String(session.authed.telegramId) },
          { $inc: { 'savedData.seasonPoints': n } },
          { new: true, projection: { 'savedData.seasonPoints': 1 } },
        ).lean();
        // No document matched: nothing was incremented. This used to fall
        // through to `total = 0`, which both reported success to the caller AND
        // wiped the running total held in memory — a failed award turned into a
        // reset to zero. Report the failure instead and leave _seasonPoints be.
        if (!doc) {
          logPlayer(session.authed.telegramId, session.authed.username, 'season_points_failed',
            { add: n, reason, why: 'player_not_found', ...(meta || {}) });
          return null;
        }
        const total = Math.max(0, Math.floor(Number(doc?.savedData?.seasonPoints) || 0));
        _seasonPoints = total;
        logPlayer(session.authed.telegramId, session.authed.username, 'season_points', { add: n, total, reason, ...(meta || {}) });
        return total;
      } catch (err) {
        console.error('_seasonAddPoints:', err);
        // Both rows on purpose: the 'error' one so it shows under Ошибки with a
        // stack message, and the durable season one so it survives the ordinary
        // log's 100-row window like every other points movement.
        logPlayerErr(session.authed.telegramId, session.authed.username, 'season_points', err, { add: n, reason, ...(meta || {}) });
        logPlayer(session.authed.telegramId, session.authed.username, 'season_points_failed',
          { add: n, reason, why: 'db_error', message: err && err.message, ...(meta || {}) });
        return null;
      }
    }

    // Called on every kill. Progress lives in _lastStats and is only written out
    // every SEASON_FLUSH_EVERY kills (and on completion) — a 5000-kill quest
    // would otherwise be 5000 database writes per player.
    const SEASON_FLUSH_EVERY = 10;
    function _seasonTrackKill(result) {
      if (!session.authed || !session.lastStats || !seasonActive()) return;
      if (!result || !result.eid) return;
      // Only the SELECTED band counts. Kills in the other one are ignored
      // rather than banked, which is the whole point of the switch: one quest
      // is active at a time, and the player chooses which.
      const tid = _seasonTierId();
      const t = seasonTier(tid);
      const lvl = result.rlvl || 0;
      if (lvl < t.minLvl || lvl > t.maxLvl) return;
      const q = _seasonQuest();
      if (!q) return;
      // Both the guard and the warrior variant of a species count.
      if (String(result.eid).split('_')[0] !== q.sp) return;

      q.kills = (q.kills || 0) + 1;
      if (q.kills < SEASON_QUEST_KILLS) {
        if (++_seasonKillsUnsaved >= SEASON_FLUSH_EVERY) {
          _seasonKillsUnsaved = 0;
          persistSavedFields(session.authed, { seasonQuests: _seasonQuests });
        }
        return;
      }
      // Cleared. The award has to LAND before the quest is replaced: this used
      // to roll the next species and persist it first, so any failed write —
      // and _seasonAddPoints could fail silently in three different ways — ate
      // 5000 kills and paid nothing, with no way for the player to retry. That
      // is the "квест выполнен, очки не начислились" report.
      //
      // Leaving the finished quest in place on failure makes the next kill try
      // again (kills is already at the target, so it re-enters this branch), and
      // the count is flushed on the way out, so it survives a disconnect too.
      if (_seasonQuestAwarding) return;   // one award in flight at a time
      _seasonQuestAwarding = true;
      _seasonKillsUnsaved = 0;
      persistSavedFields(session.authed, { seasonQuests: _seasonQuests });
      const doneSp = q.sp;
      _seasonAddPoints(SEASON_QUEST_POINTS, 'quest', { sp: doneSp, tier: tid, kills: q.kills })
        .then(total => {
          _seasonQuestAwarding = false;
          if (total === null) {
            // Not rolled over — the player keeps the completed quest and the
            // next kill retries the award.
            logPlayer(session.authed.telegramId, session.authed.username, 'season_quest_award_failed',
              { sp: doneSp, tier: tid, points: SEASON_QUEST_POINTS, kills: q.kills });
            return;
          }
          const next = { sp: seasonRollSpecies(doneSp, session.lastStats.lvl, tid), kills: 0 };
          _seasonQuests[tid] = next;
          _seasonKillsUnsaved = 0;
          persistSavedFields(session.authed, { seasonQuests: _seasonQuests });
          logPlayer(session.authed.telegramId, session.authed.username, 'season_quest_done',
            { sp: doneSp, tier: tid, points: SEASON_QUEST_POINTS, total, next: next.sp });
          socket.emit('seasonQuestDone', {
            sp: doneSp, points: SEASON_QUEST_POINTS, total,
            next: _seasonQuestPublic(next, tid),
          });
        })
        .catch(err => {
          _seasonQuestAwarding = false;
          logPlayerErr(session.authed.telegramId, session.authed.username, 'season_quest_award', err, { sp: doneSp, tier: tid });
        });
    }
    socket.data._seasonTrackKill = _seasonTrackKill;

    // Repeatable event tasks (SEASON_EVENT_TASKS). Each pays once per
    // occurrence and then arms again — the caller decides what "an occurrence"
    // is, because only it knows: one 3v3 match, one death-battle round, one
    // world-boss appearance. Nothing is stored per task beyond what is needed
    // to stop a single occurrence paying twice.
    function _seasonAwardEvent(taskId) {
      if (!session.authed || !seasonActive()) return;
      if (!SEASON_EVENT_TASKS.some(t => t.id === taskId)) return;
      // A failed award is only reported to the client as `total: null`, which
      // it cannot distinguish from "no total to show" — so the miss is recorded
      // here as well, where an admin can actually find it.
      _seasonAddPoints(SEASON_EVENT_POINTS, 'event', { task: taskId }).then(total => {
        if (total === null) return;   // _seasonAddPoints already logged why
        socket.emit('seasonEventDone', { task: taskId, points: SEASON_EVENT_POINTS, total });
      }).catch(err => logPlayerErr(session.authed.telegramId, session.authed.username, 'season_event', err, { task: taskId }));
    }
    socket.data._seasonAwardEvent = _seasonAwardEvent;

    // Winning one, on top of the participation points above. Called from the
    // match-end paths (_dbFinish / _a3Finish), which already know who took it —
    // this side only turns that into points, so there is no way to claim a win
    // from a client message.
    function _seasonAwardWin(taskId) {
      if (!session.authed || !seasonActive()) return;
      const pts = SEASON_WIN_POINTS[taskId] || 0;
      if (pts <= 0) return;
      _seasonAddPoints(pts, 'win', { task: taskId }).then(total => {
        if (total === null) return;   // _seasonAddPoints already logged why
        socket.emit('seasonEventDone', { task: taskId, points: pts, total, win: true });
      }).catch(err => logPlayerErr(session.authed.telegramId, session.authed.username, 'season_win', err, { task: taskId }));
    }
    socket.data._seasonAwardWin = _seasonAwardWin;

    // Which world boss this account has already been paid for. The boss keeps
    // one id for its whole appearance, so remembering the last one paid is
    // enough to make it once-per-boss no matter how many times it is hit —
    // otherwise every swing would be worth points.
    //
    // _seasonBossPaid used to be ONLY this in-memory variable, scoped to one
    // socket connection — so it forgot on every reconnect, and a page refresh
    // (or any ordinary mobile network blip; ordinary here) is a brand new
    // connection. The very next hit on the still-alive boss then read as a
    // fresh appearance and paid the 50 points again — the same failure shape
    // any once-per-account flag has when it lives only in a connection. It
    // still exists as a same-connection fast path (avoids a DB round trip on
    // every one of a boss fight's many hits), but the actual "already paid"
    // decision is now the persisted, atomically-guarded write below — a
    // $ne-guarded findOneAndUpdate — which survives whatever connection asks
    // and still "arms again" the moment a new boss spawns, since a fresh spawn
    // always gets a fresh id (Room.spawnEventBoss).
    let _seasonBossPaid = null;
    function _seasonTrackBossHit(enemyId) {
      if (!session.authed || !seasonActive() || !enemyId) return;
      if (!String(enemyId).startsWith('evtboss_')) return;
      if (_seasonBossPaid === enemyId) return;
      _seasonBossPaid = enemyId;
      PlayerModel.findOneAndUpdate(
        { telegramId: String(session.authed.telegramId), 'savedData.seasonBossPaid': { $ne: enemyId } },
        { $set: { 'savedData.seasonBossPaid': enemyId } },
      ).then(doc => { if (doc) _seasonAwardEvent('worldboss'); })
       .catch(err => console.error('_seasonTrackBossHit:', err));
    }
    socket.data._seasonTrackBossHit = _seasonTrackBossHit;

    // Re-reads the running total from the database. Points can now be added by
    // somebody ELSE's session — the referral bonus is paid to the referrer, who
    // may well be online at the time — so the closure copy is no longer the only
    // writer and a stale one would show the panel a number that is too low.
    async function _seasonReloadPoints() {
      if (!session.authed) return _seasonPoints;
      try {
        const doc = await PlayerModel.findById(session.authed._id, 'savedData.seasonPoints').lean();
        const total = Math.max(0, Math.floor(Number(doc?.savedData?.seasonPoints) || 0));
        _seasonPoints = total;
      } catch (err) { console.error('_seasonReloadPoints:', err); }
      return _seasonPoints;
    }

    safeOn('seasonSync', async () => {
      if (!session.authed) return;
      await _seasonReloadPoints();
      socket.emit('seasonState', _seasonPublicState());
    });

    // Switching the quest band (10+ / 20+). The other band's quest is left
    // untouched, so coming back resumes it — see _seasonQuests.
    safeOn('seasonSetTier', ({ tier } = {}) => {
      if (!session.authed || !session.lastStats) return;
      const t = SEASON_TIERS.find(x => x.id === String(tier));
      if (!t) return;
      if (!seasonTierAllowed(t.id, session.lastStats.lvl)) {
        return socket.emit('seasonError', { msg: `Нужен ${t.reqLvl} уровень` });
      }
      if (_seasonTierCur !== t.id) {
        // Whatever the old band had counted since its last flush would be lost
        // otherwise: the counter is per-session, not per-band.
        if (_seasonKillsUnsaved > 0) {
          _seasonKillsUnsaved = 0;
          persistSavedFields(session.authed, { seasonQuests: _seasonQuests });
        }
        _seasonTierCur = t.id;
        persistSavedFields(session.authed, { seasonTier: t.id });
      }
      socket.emit('seasonState', _seasonPublicState());
    });

  // ── What the rest of the connection closure needs from here ───────────────
  // The season's four pieces of state are owned by this file and read from
  // server/index.js, which is the opposite direction from the market and the
  // forge: there the closure owned the state and lent it out. Getters, so the
  // reads stay live, and two verbs for the two places the closure legitimately
  // drives the season rather than reading it.

  // Season state is read straight off the stored record. It is never part of
  // the client blob — the sanitizer strips both fields so they can't be
  // written by the people competing for the prize — so this is the only point
  // at which it enters the session. Called from the login path.
  function hydrate(savedData) {
    const _sd = savedData || {};
    _seasonPoints = Math.max(0, Math.floor(Number(_sd.seasonPoints) || 0));
    // One quest per band. Each is validated against ITS OWN band's species
    // list, so a stored quest naming a species that has since moved (or that
    // never belonged to that band) is dropped and re-rolled rather than
    // becoming an unfinishable "kill 5000 of something that isn't there".
    const _readQuest = (raw, tid) => {
      if (!raw || typeof raw !== 'object') return null;
      if (!seasonTier(tid).species.some(x => x.sp === raw.sp)) return null;
      return { sp: raw.sp, kills: Math.max(0, Math.floor(Number(raw.kills) || 0)) };
    };
    _seasonQuests = {};
    const _sqs = _sd.seasonQuests;
    if (_sqs && typeof _sqs === 'object') {
      for (const tier of SEASON_TIERS) {
        const q = _readQuest(_sqs[tier.id], tier.id);
        if (q) _seasonQuests[tier.id] = q;
      }
    }
    // Migration: before the bands existed there was a single seasonQuest, and
    // it was always a 10+ one. Carried across so nobody loses progress to the
    // upgrade.
    if (!_seasonQuests[SEASON_TIER_DEFAULT]) {
      const q = _readQuest(_sd.seasonQuest, SEASON_TIER_DEFAULT);
      if (q) _seasonQuests[SEASON_TIER_DEFAULT] = q;
    }
    _seasonTierCur = SEASON_TIERS.some(x => x.id === _sd.seasonTier)
      ? _sd.seasonTier : SEASON_TIER_DEFAULT;
  }

  // Writes whatever quest progress has accumulated since the last batch.
  // Called on the way out: without it every disconnect, refresh or closed tab
  // threw away the kills since the last save.
  async function flushQuests() {
    if (session.authed && _seasonQuests && Object.keys(_seasonQuests).length) {
      await persistSavedFields(session.authed, {
        seasonQuests: _seasonQuests, seasonTier: _seasonTierCur,
      });
      _seasonKillsUnsaved = 0;
    }
  }

  return {
    hydrate, flushQuests,
    addPoints: _seasonAddPoints,
    trackKill: _seasonTrackKill,
    trackBossHit: _seasonTrackBossHit,
    get points() { return _seasonPoints; },
    get quests() { return _seasonQuests; },
    get tier() { return _seasonTierCur; },
  };
};
