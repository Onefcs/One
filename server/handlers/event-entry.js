'use strict';
// Entering an event: registering for Битва на смерть, Арена 3х3 and Кровавая
// Башня, walking into Страх, forming and starting a Сотрудничество or Элитная
// фарм-зона party, and returning to the hub from any of them.
//
// Eighth and last of the closure cuts in this pass, and the widest: fifty-three
// injected names. That is not a defect to trim. This is the one place a player
// crosses INTO any of the six machines under server/events/, so it holds a
// handle on every one of them, plus the daily-attempt ledgers that gate entry
// and the party bookkeeping that entry disturbs. The same shape the admin
// event panel has, for the same reason — a controller needs a handle on each
// thing it controls.
//
// The machine handles keep their original names and are passed by shorthand, so
// the handler bodies below are byte-identical to what stood in the closure
// apart from three session reads. That was deliberate: at this width, renaming
// would have been the risk, not the coupling.
//
// Cut around two things that are not event entry and stayed behind:
// _emitNearby, the combat fan-out helper that CC handlers ABOVE this block
// already used, and the setPvpMode/spawnProj/spawnAoe/healParty/chat handlers
// that followed it under this block's heading.
// Only the five that shared/definitions actually exports. The other eight
// entry gates — ARENA3_MIN_LEVEL, RACE10_MIN_LEVEL, FEAR_ATTEMPTS,
// FEAR_MIN_LEVEL, FEAR_START_DELAY_MS, COOP_ATTEMPTS, COOP_MIN_LEVEL,
// COOP_START_DELAY_MS — belong to the machines under server/events/ and are
// injected below. Requiring them from here instead would destructure keys that
// do not exist: `undefined` at every level gate, no lint error, and `lvl <
// undefined` is false, so every event would admit anyone at any level.
const {
  FEAR_MAX_WAVE, COOP_STAGE_LEVELS,
  FARM2_ENTRY_LEVEL, FARM2_PARTY_SIZE, FARM2_DAILY_MINUTES,
} = require('../../shared/definitions');

// See createGuildWar (server/events/guildwar.js) for why this is checked. The
// list is long because the surface is; each name here is one thing this entry
// point can reach.
const REQUIRED_DEPS = [
  'ARENA3_MIN_LEVEL', 'RACE10_MIN_LEVEL', 'FEAR_ATTEMPTS', 'FEAR_MIN_LEVEL',
  'FEAR_START_DELAY_MS', 'COOP_ATTEMPTS', 'COOP_MIN_LEVEL',
  'COOP_START_DELAY_MS', 'socket', 'safeOn', 'session', '_a3',
  '_a3Broadcast', '_a3PublicState', '_a3TryStartSafe',
  '_arena3AttemptsLeft', '_coop', '_coopAttemptsLeft',
  '_coopGroupBroadcastList', '_coopGroupDissolve', '_coopGroupOf',
  '_coopGroupOpenList', '_coopGroupPush', '_coopGroupStateFor',
  '_coopGroups', '_createCoopRoom', '_createFarm2Room', '_createFearRoom',
  '_db', '_dbBroadcast', '_dbPublicState', '_dbReturnEntrant',
  '_doEnterLocation', '_farm2', '_farm2CascadeCheck', '_farm2Finish',
  '_farm2GroupBroadcastList', '_farm2GroupDissolve', '_farm2GroupOf',
  '_farm2GroupOpenList', '_farm2GroupPush', '_farm2GroupStateFor',
  '_farm2Groups', '_farm2MinutesLeft', '_farm2Starting', '_fear',
  '_fearAttemptsLeft', '_fearStartWave', '_lockCoopDaily',
  '_lockFarm2Minutes', '_lockFearDaily', '_race10', '_race10AttemptsLeft',
  '_race10Broadcast', '_race10PublicState', '_removeFromParty',
  '_returnToHub', 'parties', 'playerParty', 'safeInterval', 'safeTimeout',
];

// What this file takes from the shared services object.
const REQUIRED_SVC = [
  'io',
];

module.exports = function registerEventEntryHandlers(deps) {
  if (!deps || !deps.svc || !deps.session) throw new Error('event-entry: needs svc and session');
  const { svc, session } = deps;
  const missingSvc = REQUIRED_SVC.filter(k => svc[k] == null);
  if (missingSvc.length) throw new Error(`event-entry: svc missing: ${missingSvc.join(', ')}`);
  const missing = REQUIRED_DEPS.filter(k => deps[k] == null);
  if (missing.length) throw new Error(`registerEventEntryHandlers: missing deps: ${missing.join(', ')}`);
  const {
    ARENA3_MIN_LEVEL, RACE10_MIN_LEVEL, FEAR_ATTEMPTS, FEAR_MIN_LEVEL,
    FEAR_START_DELAY_MS, COOP_ATTEMPTS, COOP_MIN_LEVEL, COOP_START_DELAY_MS,
    socket, safeOn, _a3, _a3Broadcast, _a3PublicState,
    _a3TryStartSafe, _arena3AttemptsLeft, _coop, _coopAttemptsLeft,
    _coopGroupBroadcastList, _coopGroupDissolve, _coopGroupOf,
    _coopGroupOpenList, _coopGroupPush, _coopGroupStateFor, _coopGroups,
    _createCoopRoom, _createFarm2Room, _createFearRoom, _db, _dbBroadcast,
    _dbPublicState, _dbReturnEntrant, _doEnterLocation, _farm2,
    _farm2CascadeCheck, _farm2Finish, _farm2GroupBroadcastList,
    _farm2GroupDissolve, _farm2GroupOf, _farm2GroupOpenList,
    _farm2GroupPush, _farm2GroupStateFor, _farm2Groups, _farm2MinutesLeft,
    _farm2Starting, _fear, _fearAttemptsLeft, _fearStartWave,
    _lockCoopDaily, _lockFarm2Minutes, _lockFearDaily, _race10,
    _race10AttemptsLeft, _race10Broadcast, _race10PublicState,
    _removeFromParty, _returnToHub, parties, playerParty, safeInterval,
    safeTimeout,
  } = deps;
  const { io } = svc;

    // ── Death Battle (Битва на смерть) ─────────────────────────────────────────
    safeOn('deathBattleRegister', () => {
      if (!session.authed) return;
      if (_db.phase !== 'reg') return socket.emit('deathBattleError', { msg: 'Регистрация закрыта' });
      const cp = session.room?.players.get(socket.id);
      if (!cp) return socket.emit('deathBattleError', { msg: 'Выберите персонажа' });
      if (_fear.has(socket.id)) return socket.emit('deathBattleError', { msg: 'Вы сейчас в Страхе' });
      // Checked against the QUEUE too, not just live participation — same
      // reasoning as fearEnter's own cross-checks (see its comment): arena3/
      // race10 registration opens minutes before the match actually deploys,
      // so a player who queued there and then also queued here could get
      // deployed into arena3/race10 while still holding a death-battle slot,
      // or the reverse. This was the one direction that never got the
      // treatment — arena3Register/race10Register already check .reg here.
      if (_a3.queue.has(socket.id) || (_a3.live && _a3.teams.has(socket.id))) {
        return socket.emit('deathBattleError', { msg: 'Вы сейчас на арене 3х3' });
      }
      if (_race10.queue.has(socket.id) || (_race10.live && _race10.alive.has(socket.id))) {
        return socket.emit('deathBattleError', { msg: 'Вы сейчас в Кровавой Башне' });
      }
      _db.reg.set(socket.id, { name: session.authed.username, tid: session.authed.telegramId });
      socket.emit('deathBattleRegistered', { registered: true });
      _dbBroadcast();
    });

    safeOn('deathBattleUnregister', () => {
      if (_db.phase !== 'reg') return;
      if (!_db.reg.delete(socket.id)) return;
      socket.emit('deathBattleRegistered', { registered: false });
      _dbBroadcast();
    });

    // ── 3v3 Arena ─────────────────────────────────────────────────────────────
    safeOn('arena3Register', async () => {
      if (!session.authed) return;
      if (_a3.live && _a3.teams.has(socket.id)) return;
      if (_a3.phase !== 'reg') return socket.emit('arena3Error', { msg: 'Арена 3х3 открыта с 21:00 до 22:00 по Москве' });
      const cp = session.room?.players.get(socket.id);
      if (!cp) return socket.emit('arena3Error', { msg: 'Выберите персонажа' });
      // Signing up for both at once would have the death battle yank someone out
      // of a running 3v3 (or the reverse) mid-fight.
      if (_db.reg.has(socket.id) || _db.alive.has(socket.id)) {
        return socket.emit('arena3Error', { msg: 'Вы уже записаны на битву на смерть' });
      }
      // Кровавая Башня's 5-minute registration (20:30) and its own 15-minute
      // overrun grace period normally wrap up well before this window opens at
      // 21:00, but an admin can force-open either one off-schedule, so a race
      // can in principle still be live right as this one opens.
      //
      // Checked against the QUEUE too, not just live participation — the same
      // gap fearEnter's own cross-checks were added to close (see its
      // comment): without this, queuing here AND for race10 let both windows'
      // deploys fight over the same player, landing them in one match while
      // still holding a slot in the other.
      if (_race10.queue.has(socket.id) || _race10.alive.has(socket.id)) {
        return socket.emit('arena3Error', { msg: 'Вы сейчас в Кровавой Башне' });
      }
      if (_fear.has(socket.id)) {
        return socket.emit('arena3Error', { msg: 'Вы сейчас в Страхе' });
      }
      const lvl = (session.lastStats && session.lastStats.lvl) || 1;
      if (lvl < ARENA3_MIN_LEVEL) {
        return socket.emit('arena3Error', { msg: `Нужен ${ARENA3_MIN_LEVEL} уровень` });
      }
      const left = await _arena3AttemptsLeft(socket.id);
      if (left <= 0) {
        return socket.emit('arena3Error', { msg: 'Попытки на арену на сегодня закончились' });
      }
      _a3.queue.set(socket.id, { name: session.authed.username, lvl, tid: session.authed.telegramId });
      socket.emit('arena3Registered', { registered: true, attemptsLeft: left });
      _a3Broadcast();
      _a3TryStartSafe();
    });

    safeOn('arena3Unregister', () => {
      if (!_a3.queue.delete(socket.id)) return;
      socket.emit('arena3Registered', { registered: false });
      _a3Broadcast();
    });

    // The only place attemptsLeft is read from the DB — the periodic broadcasts
    // stay a pure in-memory push, so opening the panel costs one query rather
    // than every queue change costing one per waiting player.
    safeOn('arena3Sync', async () => {
      socket.emit('arena3State', {
        ..._a3PublicState(),
        registered: _a3.queue.has(socket.id),
        inMatch: _a3.teams.has(socket.id),
        attemptsLeft: await _arena3AttemptsLeft(socket.id),
      });
    });

    // ── 10-Player Corridor Race ──────────────────────────────────────────────
    safeOn('race10Register', async () => {
      if (!session.authed) return;
      if (_race10.live && _race10.alive.has(socket.id)) return;
      if (_race10.phase !== 'reg') return socket.emit('race10Error', { msg: 'Кровавая Башня открыта в 20:30 по Москве, всего на 5 минут' });
      const cp = session.room?.players.get(socket.id);
      if (!cp) return socket.emit('race10Error', { msg: 'Выберите персонажа' });
      if (_db.reg.has(socket.id) || _db.alive.has(socket.id)) {
        return socket.emit('race10Error', { msg: 'Вы уже записаны на битву на смерть' });
      }
      // Checked against the QUEUE too, not just live participation — mirrors
      // the check arena3Register now runs the other way (see its comment):
      // without this, queuing here AND for arena3 let both windows' deploys
      // fight over the same player.
      if (_a3.queue.has(socket.id) || (_a3.live && _a3.teams.has(socket.id))) {
        return socket.emit('race10Error', { msg: 'Вы сейчас на арене 3х3' });
      }
      if (_fear.has(socket.id)) {
        return socket.emit('race10Error', { msg: 'Вы сейчас в Страхе' });
      }
      const lvl = (session.lastStats && session.lastStats.lvl) || 1;
      if (lvl < RACE10_MIN_LEVEL) {
        return socket.emit('race10Error', { msg: `Нужен ${RACE10_MIN_LEVEL} уровень` });
      }
      const left = await _race10AttemptsLeft(socket.id);
      if (left <= 0) {
        return socket.emit('race10Error', { msg: 'Попытки в Кровавую Башню на сегодня закончились' });
      }
      // Registering no longer risks starting the race — it begins on its own
      // timer with whoever is signed up by then.
      _race10.queue.set(socket.id, { name: session.authed.username, lvl, tid: session.authed.telegramId });
      socket.emit('race10Registered', { registered: true, attemptsLeft: left });
      _race10Broadcast();
    });

    safeOn('race10Unregister', () => {
      if (!_race10.queue.delete(socket.id)) return;
      socket.emit('race10Registered', { registered: false });
      _race10Broadcast();
    });

    safeOn('race10Sync', async () => {
      socket.emit('race10State', {
        ..._race10PublicState(),
        registered: _race10.queue.has(socket.id),
        inMatch: _race10.alive.has(socket.id),
        attemptsLeft: await _race10AttemptsLeft(socket.id),
      });
    });

    // ── Страх (Fear) ──────────────────────────────────────────────────────────
    // On-demand: no registration queue, no scheduled window — entering IS
    // starting, so this single handler does everything arena3Register/
    // race10Register + their deploy step do together.
    safeOn('fearEnter', async () => {
      if (!session.authed) return;
      if (_fear.has(socket.id)) return; // already running — the client shouldn't offer the button
      if (!session.room) return;
      const cp = session.room.players.get(socket.id);
      if (!cp) return socket.emit('fearError', { msg: 'Выберите персонажа' });
      if (_db.reg.has(socket.id) || _db.alive.has(socket.id)) {
        return socket.emit('fearError', { msg: 'Вы уже записаны на битву на смерть' });
      }
      // Checked against the QUEUE too, not just live participation: race10/
      // arena3 registration opens minutes before the match actually deploys
      // (race10Register/arena3Register), and neither of those two checked Fear
      // the other way around before this. A player could register, then start
      // a Fear run while waiting, and get yanked into the race/match the
      // moment it deployed — raceDeploy/arena3's own deploy only ever set
      // _raceLane, never checked or cleared an existing _fearLane, so the
      // player ended up with BOTH set at once. Their Fear hall was never
      // released (fearReleaseLane never ran) — a leaked, permanently-occupied
      // slot — while the AOI distance check silently dropped its monsters off
      // their screen the instant they were teleported to the race lane: from
      // their side that reads as "the monsters just disappeared". Death battle
      // registration already checked `.reg` (not just `.alive`) for exactly
      // this reason; race10/arena3 just never got the same treatment.
      if (_a3.queue.has(socket.id) || (_a3.live && _a3.teams.has(socket.id))) {
        return socket.emit('fearError', { msg: 'Вы сейчас на арене 3х3' });
      }
      if (_race10.queue.has(socket.id) || (_race10.live && _race10.alive.has(socket.id))) {
        return socket.emit('fearError', { msg: 'Вы сейчас в Кровавой Башне' });
      }
      const lvl = (session.lastStats && session.lastStats.lvl) || 1;
      if (lvl < FEAR_MIN_LEVEL) {
        return socket.emit('fearError', { msg: `Нужен ${FEAR_MIN_LEVEL} уровень` });
      }
      const left = await _fearAttemptsLeft(socket.id);
      if (left <= 0) {
        return socket.emit('fearError', { msg: 'Попытки в Страх на сегодня закончились' });
      }
      // Fear is its own floor (server/game/floors.js), but unlike every other
      // one there is no shared Room to walk onto — this connection creates a
      // brand-new private instance right here and force-joins it via the
      // `room` override (_doEnterLocation), the same way it used to force-join
      // the old shared floor. Every real gate (level, attempts, the cross-
      // checks above) is already applied, so force:true is just skipping the
      // (nonexistent) reachability gate, not bypassing anything that still
      // needs checking.
      const fearRoom = _createFearRoom();
      if (!_doEnterLocation('fear', { force: true, room: fearRoom })) {
        return socket.emit('fearError', { msg: 'Не удалось войти — попробуйте ещё раз' });
      }
      // Always succeeds: fearRoom was just created for this connection alone,
      // so its one lane can only ever already belong to this same socket.
      // Kept as a real check (not assumed) rather than trusting that no future
      // change to fearDeploy's own logic could ever disagree.
      const spot = session.room.fearDeploy(socket.id);
      if (!spot) {
        _doEnterLocation('hub', { force: true });
        return socket.emit('fearError', { msg: 'Не удалось войти — попробуйте ещё раз' });
      }
      _lockFearDaily(socket.id);
      // wave:0 first — see FEAR_START_DELAY_MS's own comment for why this has
      // to be a real _fear record (not just a bare setTimeout with nothing
      // backing it) rather than calling _fearStartWave immediately.
      const readyAt = Date.now() + FEAR_START_DELAY_MS;
      _fear.set(socket.id, { room: fearRoom, lane: spot.lane, wave: 0 });
      socket.emit('fearStarted', { x: spot.x, y: spot.y, hp: cp.hp, maxWave: FEAR_MAX_WAVE, attemptsLeft: left - 1, readyAt });
      safeTimeout('fearWave1', () => {
        // Still exactly the run this timer was scheduled for? A disconnect
        // during the countdown deletes this socket's _fear entry (moved to
        // _fearDisconnectGrace instead — see _fearHoldOnDisconnect), so a
        // stale timer for a socket that's since gone quietly no-ops here
        // rather than double-spawning the wave once the reconnect path
        // starts it (see the fearCarry reclaim, further up this file).
        //
        // run.room !== fearRoom (identity, not just lane/wave) is the part
        // that matters now that every run gets its own fresh Room: lane is
        // always 0 and wave is always 0 at this point for ANY fresh entry, so
        // a player who died during this exact countdown (impossible today —
        // wave 0 has no monsters — but not a case worth trusting to stay that
        // way) and re-entered before this timer fired would have a NEW room
        // with the same lane/wave numbers as this stale closure's. Without the
        // identity check that coincidence would pass the old guard and spawn
        // wave 1 into the abandoned OLD room while stamping ITS reference back
        // over the new run's _fear entry — silently hijacking the active run.
        const run = _fear.get(socket.id);
        if (!run || run.room !== fearRoom || run.lane !== spot.lane || run.wave !== 0) return;
        _fearStartWave(fearRoom, socket.id, spot.lane, 1);
      }, FEAR_START_DELAY_MS);
    });

    safeOn('fearSync', async () => {
      const run = _fear.get(socket.id);
      socket.emit('fearState', {
        maxAttempts: FEAR_ATTEMPTS, maxWave: FEAR_MAX_WAVE, minLevel: FEAR_MIN_LEVEL,
        attemptsLeft: await _fearAttemptsLeft(socket.id),
        inRun: !!run, wave: run?.wave || 0,
        // No freeLanes/totalLanes any more — every entrant gets their own
        // private Room now (_createFearRoom), so there is no shared pool that
        // can ever be "full".
      });
    });

    // Sent once the player closes the fear result modal — same reasoning as
    // race10Return/arena3Return: server-side position was already reset when
    // the run ended (_fearFinish), this just makes the client catch up
    // visually if it somehow missed the fearFinished payload's x/y.
    safeOn('fearReturn', () => {
      const spot = _returnToHub(socket.id);
      if (spot) socket.emit('deathBattleReturned', spot);
    });

    // ── Сотрудничество (Coop) ────────────────────────────────────────────────
    // Group-based lobby: coopGroupCreate makes this connection a leader,
    // coopGroupJoin lets someone else take the one open slot, coopGroupKick
    // lets the leader boot them back out, coopGroupLeave covers either side
    // stepping away on their own, and coopGroupStart — leader only — is the
    // sole way a run actually begins. All the real gates (level, attempts,
    // conflicts with the other instanced modes) run at create/join time, same
    // trust model race10/arena3's registration queues already use for a
    // stored entry — coopGroupStart itself only rechecks that both sides are
    // still actually connected before deploying.
    safeOn('coopGroupCreate', async () => {
      if (!session.authed) return;
      if (_coop.has(socket.id) || _coopGroupOf.has(socket.id)) return;
      if (!session.room) return;
      const cp = session.room.players.get(socket.id);
      if (!cp) return socket.emit('coopError', { msg: 'Выберите персонажа' });
      if (_db.reg.has(socket.id) || _db.alive.has(socket.id)) {
        return socket.emit('coopError', { msg: 'Вы уже записаны на битву на смерть' });
      }
      if (_a3.queue.has(socket.id) || (_a3.live && _a3.teams.has(socket.id))) {
        return socket.emit('coopError', { msg: 'Вы сейчас на арене 3х3' });
      }
      if (_race10.queue.has(socket.id) || (_race10.live && _race10.alive.has(socket.id))) {
        return socket.emit('coopError', { msg: 'Вы сейчас в Кровавой Башне' });
      }
      if (_fear.has(socket.id)) {
        return socket.emit('coopError', { msg: 'Вы сейчас в Страхе' });
      }
      const lvl = (session.lastStats && session.lastStats.lvl) || 1;
      if (lvl < COOP_MIN_LEVEL) {
        return socket.emit('coopError', { msg: `Нужен ${COOP_MIN_LEVEL} уровень` });
      }
      const left = await _coopAttemptsLeft(socket.id);
      if (left <= 0) {
        return socket.emit('coopError', { msg: 'Попытки в Сотрудничество на сегодня закончились' });
      }
      _coopGroups.set(socket.id, { leaderName: session.authed.username, memberId: null, memberName: null });
      _coopGroupOf.set(socket.id, socket.id);
      _coopGroupPush(socket.id);
      _coopGroupBroadcastList();
    });

    safeOn('coopGroupJoin', ({ leaderId } = {}) => {
      if (!session.authed || !leaderId) return;
      if (_coop.has(socket.id) || _coopGroupOf.has(socket.id)) return;
      const g = _coopGroups.get(leaderId);
      if (!g || g.memberId || !io.sockets.sockets.get(leaderId)) {
        return socket.emit('coopError', { msg: 'Группа недоступна' });
      }
      if (!session.room) return;
      const cp = session.room.players.get(socket.id);
      if (!cp) return socket.emit('coopError', { msg: 'Выберите персонажа' });
      if (_db.reg.has(socket.id) || _db.alive.has(socket.id)) {
        return socket.emit('coopError', { msg: 'Вы уже записаны на битву на смерть' });
      }
      if (_a3.queue.has(socket.id) || (_a3.live && _a3.teams.has(socket.id))) {
        return socket.emit('coopError', { msg: 'Вы сейчас на арене 3х3' });
      }
      if (_race10.queue.has(socket.id) || (_race10.live && _race10.alive.has(socket.id))) {
        return socket.emit('coopError', { msg: 'Вы сейчас в Кровавой Башне' });
      }
      if (_fear.has(socket.id)) {
        return socket.emit('coopError', { msg: 'Вы сейчас в Страхе' });
      }
      const lvl = (session.lastStats && session.lastStats.lvl) || 1;
      if (lvl < COOP_MIN_LEVEL) {
        return socket.emit('coopError', { msg: `Нужен ${COOP_MIN_LEVEL} уровень` });
      }
      // Re-check the slot is still open — two joins racing each other on the
      // same open group must not both land.
      if (g.memberId) return socket.emit('coopError', { msg: 'Группа недоступна' });
      g.memberId = socket.id;
      g.memberName = session.authed.username;
      _coopGroupOf.set(socket.id, leaderId);
      _coopGroupPush(leaderId);
      _coopGroupPush(socket.id);
      _coopGroupBroadcastList();
    });

    // Leader-only: boots the current member back to idle, freeing the slot
    // for someone else to join. A no-op if there's no member to kick.
    safeOn('coopGroupKick', () => {
      const g = _coopGroups.get(socket.id);
      if (!g || !g.memberId) return;
      const memberId = g.memberId;
      g.memberId = null;
      g.memberName = null;
      _coopGroupOf.delete(memberId);
      _coopGroupPush(memberId, 'kicked');
      _coopGroupPush(socket.id);
      _coopGroupBroadcastList();
    });

    // Either side stepping away on their own. The leader leaving dissolves
    // the whole group (the member, if any, is bounced back to idle); a
    // member leaving just frees their own slot.
    safeOn('coopGroupLeave', () => {
      const leaderId = _coopGroupOf.get(socket.id);
      if (!leaderId) return;
      if (leaderId === socket.id) {
        _coopGroupDissolve(leaderId, 'leaderLeft');
      } else {
        const g = _coopGroups.get(leaderId);
        if (!g || g.memberId !== socket.id) return;
        g.memberId = null;
        g.memberName = null;
        _coopGroupOf.delete(socket.id);
        _coopGroupPush(leaderId);
        _coopGroupBroadcastList();
      }
    });

    // Leader-only, and only once a member has actually joined — this is the
    // ONLY way a Coop run begins now, replacing the old random matchmaking.
    safeOn('coopGroupStart', async () => {
      if (!session.authed) return;
      if (_coop.has(socket.id)) return;
      const g = _coopGroups.get(socket.id);
      if (!g) return; // not a leader (or not in a group at all)
      if (!g.memberId) return socket.emit('coopError', { msg: 'Нужен второй участник' });
      const partnerSid = g.memberId;
      const partnerSocket = io.sockets.sockets.get(partnerSid);
      if (!partnerSocket) {
        // Member vanished without the disconnect path catching it — clear the
        // slot rather than trying to deploy a ghost.
        g.memberId = null;
        g.memberName = null;
        _coopGroupPush(socket.id);
        _coopGroupBroadcastList();
        return socket.emit('coopError', { msg: 'Участник отключился' });
      }

      // Group the two into a fresh party of exactly themselves — same shape
      // partyAccept's "create new party" branch uses, and needed for the PvP
      // immunity/heal checks the run itself relies on (see arePlayersNear and
      // playerParty's other readers).
      const oldPartyA = playerParty.get(partnerSid);
      if (oldPartyA) _removeFromParty(oldPartyA, partnerSid);
      const oldPartyB = playerParty.get(socket.id);
      if (oldPartyB) _removeFromParty(oldPartyB, socket.id);
      const partyId = partnerSid + '_' + socket.id;
      const partyMap = new Map();
      partyMap.set(partnerSid, g.memberName);
      partyMap.set(socket.id, g.leaderName);
      parties.set(partyId, partyMap);
      playerParty.set(partnerSid, partyId);
      playerParty.set(socket.id, partyId);
      partyMap.forEach((_, mid) => {
        const others = [];
        partyMap.forEach((name, oid) => { if (oid !== mid) others.push({ id: oid, name }); });
        io.to(mid).emit('partyUpdated', { members: others });
      });

      // Deploy both. Coop is its own floor (server/game/floors.js), but like
      // Fear there is no shared Room to walk onto — this connection creates a
      // brand-new private instance right here and force-joins BOTH
      // connections onto it via the `room` override (_forceEnterLocation,
      // exposed per-connection so this handler can move a socket that isn't
      // its own).
      const coopRoom = _createCoopRoom();
      const ok1 = partnerSocket.data._forceEnterLocation?.('coop', { room: coopRoom });
      const ok2 = socket.data._forceEnterLocation?.('coop', { room: coopRoom });
      if (!ok1 || !ok2) {
        // Something about one of the two connections refused the move (no
        // character selected any more, already elsewhere) — don't strand
        // either one on a half-joined floor, and leave the group intact so
        // the leader can just try again.
        if (ok1) partnerSocket.data._forceEnterLocation?.('hub');
        if (ok2) socket.data._forceEnterLocation?.('hub');
        socket.emit('coopError', { msg: 'Не удалось войти — попробуйте ещё раз' });
        partnerSocket.emit('coopError', { msg: 'Не удалось войти — попробуйте ещё раз' });
        return;
      }
      const spot1 = coopRoom.coopDeploy(partnerSid);
      const spot2 = coopRoom.coopDeploy(socket.id);
      if (!spot1 || !spot2) {
        partnerSocket.data._forceEnterLocation?.('hub');
        socket.data._forceEnterLocation?.('hub');
        socket.emit('coopError', { msg: 'Не удалось войти — попробуйте ещё раз' });
        partnerSocket.emit('coopError', { msg: 'Не удалось войти — попробуйте ещё раз' });
        return;
      }
      // The group has done its job — clear it out before locking attempts and
      // deploying, same as the old pool entry was cleared before deploy.
      _coopGroups.delete(socket.id);
      _coopGroupOf.delete(socket.id);
      _coopGroupOf.delete(partnerSid);
      _coopGroupBroadcastList();
      _lockCoopDaily(partnerSid);
      _lockCoopDaily(socket.id);
      _coop.set(partnerSid, { room: coopRoom, lane: spot1.lane, partnerId: socket.id });
      _coop.set(socket.id, { room: coopRoom, lane: spot2.lane, partnerId: partnerSid });
      const p1 = coopRoom.players.get(partnerSid), p2 = coopRoom.players.get(socket.id);
      const readyAt = Date.now() + COOP_START_DELAY_MS;
      io.to(partnerSid).emit('coopStarted', { x: spot1.x, y: spot1.y, hp: p1?.maxHp, maxStage: COOP_STAGE_LEVELS.length, attemptsLeft: await _coopAttemptsLeft(partnerSid), readyAt });
      socket.emit('coopStarted', { x: spot2.x, y: spot2.y, hp: p2?.maxHp, maxStage: COOP_STAGE_LEVELS.length, attemptsLeft: await _coopAttemptsLeft(socket.id), readyAt });
      safeTimeout('coopStage1', () => {
        // Still exactly the run this timer was scheduled for? A disconnect
        // during the countdown ends the run for both right away (see
        // _coopEjectOnDisconnect) and drops both _coop entries — a stale timer
        // left over from that quietly no-ops here instead of spawning a stage
        // 1 nobody's left to fight.
        const r1 = _coop.get(partnerSid), r2 = _coop.get(socket.id);
        if (!r1 || !r2 || r1.room !== coopRoom || r2.room !== coopRoom || coopRoom.coopStage() !== 0) return;
        coopRoom.coopStartFirstStage();
        io.to(partnerSid).emit('coopStage', { stage: 1, maxStage: COOP_STAGE_LEVELS.length });
        io.to(socket.id).emit('coopStage', { stage: 1, maxStage: COOP_STAGE_LEVELS.length });
      }, COOP_START_DELAY_MS);
    });

    safeOn('coopSync', async () => {
      const run = _coop.get(socket.id);
      socket.emit('coopState', {
        maxAttempts: COOP_ATTEMPTS, maxStage: COOP_STAGE_LEVELS.length, minLevel: COOP_MIN_LEVEL,
        attemptsLeft: await _coopAttemptsLeft(socket.id),
        inRun: !!run, stage: run?.room ? run.room.coopStage() : 0,
      });
      socket.emit('coopGroupState', _coopGroupStateFor(socket.id));
      socket.emit('coopGroupList', { groups: _coopGroupOpenList() });
    });

    // Sent once the player closes the coop result modal — same reasoning as
    // fearReturn above.
    safeOn('coopReturn', () => {
      const spot = _returnToHub(socket.id);
      if (spot) socket.emit('deathBattleReturned', spot);
    });

    // ── Элитная фарм-зона (Elite Farm Zone 2) ────────────────────────────────
    // Same group-based lobby shape as Coop just above, sized for
    // FARM2_PARTY_SIZE (leader + FARM2_PARTY_SIZE-1 members) instead of 2, and
    // — unlike Coop — the daily allowance (minutes, not run attempts) is
    // re-checked for EVERY participant at Start, not just the leader at
    // create/join time: an exhausted member silently deployed and then
    // immediately timed back out would break the whole trio for the other
    // two, which is worse than just refusing to start.
    safeOn('farm2GroupCreate', async () => {
      if (!session.authed) return;
      if (_farm2.has(socket.id) || _farm2GroupOf.has(socket.id)) return;
      if (!session.room) return;
      const cp = session.room.players.get(socket.id);
      if (!cp) return socket.emit('farm2Error', { msg: 'Выберите персонажа' });
      if (_db.reg.has(socket.id) || _db.alive.has(socket.id)) {
        return socket.emit('farm2Error', { msg: 'Вы уже записаны на битву на смерть' });
      }
      if (_a3.queue.has(socket.id) || (_a3.live && _a3.teams.has(socket.id))) {
        return socket.emit('farm2Error', { msg: 'Вы сейчас на арене 3х3' });
      }
      if (_race10.queue.has(socket.id) || (_race10.live && _race10.alive.has(socket.id))) {
        return socket.emit('farm2Error', { msg: 'Вы сейчас в Кровавой Башне' });
      }
      if (_fear.has(socket.id)) {
        return socket.emit('farm2Error', { msg: 'Вы сейчас в Страхе' });
      }
      if (_coop.has(socket.id) || _coopGroupOf.has(socket.id)) {
        return socket.emit('farm2Error', { msg: 'Вы сейчас в Сотрудничестве' });
      }
      const lvl = (session.lastStats && session.lastStats.lvl) || 1;
      if (lvl < FARM2_ENTRY_LEVEL) {
        return socket.emit('farm2Error', { msg: `Нужен ${FARM2_ENTRY_LEVEL} уровень` });
      }
      const left = await _farm2MinutesLeft(socket.id);
      if (left <= 0) {
        return socket.emit('farm2Error', { msg: 'Время в Элитной фарм-зоне на сегодня закончилось' });
      }
      _farm2Groups.set(socket.id, { leaderName: session.authed.username, members: new Map() });
      _farm2GroupOf.set(socket.id, socket.id);
      _farm2GroupPush(socket.id);
      _farm2GroupBroadcastList();
    });

    safeOn('farm2GroupJoin', async ({ leaderId } = {}) => {
      if (!session.authed || !leaderId) return;
      if (_farm2.has(socket.id) || _farm2GroupOf.has(socket.id)) return;
      const g = _farm2Groups.get(leaderId);
      if (!g || g.members.size >= FARM2_PARTY_SIZE - 1 || !io.sockets.sockets.get(leaderId)) {
        return socket.emit('farm2Error', { msg: 'Группа недоступна' });
      }
      if (!session.room) return;
      const cp = session.room.players.get(socket.id);
      if (!cp) return socket.emit('farm2Error', { msg: 'Выберите персонажа' });
      if (_db.reg.has(socket.id) || _db.alive.has(socket.id)) {
        return socket.emit('farm2Error', { msg: 'Вы уже записаны на битву на смерть' });
      }
      if (_a3.queue.has(socket.id) || (_a3.live && _a3.teams.has(socket.id))) {
        return socket.emit('farm2Error', { msg: 'Вы сейчас на арене 3х3' });
      }
      if (_race10.queue.has(socket.id) || (_race10.live && _race10.alive.has(socket.id))) {
        return socket.emit('farm2Error', { msg: 'Вы сейчас в Кровавой Башне' });
      }
      if (_fear.has(socket.id)) {
        return socket.emit('farm2Error', { msg: 'Вы сейчас в Страхе' });
      }
      if (_coop.has(socket.id) || _coopGroupOf.has(socket.id)) {
        return socket.emit('farm2Error', { msg: 'Вы сейчас в Сотрудничестве' });
      }
      const lvl = (session.lastStats && session.lastStats.lvl) || 1;
      if (lvl < FARM2_ENTRY_LEVEL) {
        return socket.emit('farm2Error', { msg: `Нужен ${FARM2_ENTRY_LEVEL} уровень` });
      }
      const left = await _farm2MinutesLeft(socket.id);
      if (left <= 0) {
        return socket.emit('farm2Error', { msg: 'Время в Элитной фарм-зоне на сегодня закончилось' });
      }
      // Re-check the slot is still open — two joins racing each other on the
      // same open group must not both land.
      if (g.members.size >= FARM2_PARTY_SIZE - 1) return socket.emit('farm2Error', { msg: 'Группа недоступна' });
      g.members.set(socket.id, session.authed.username);
      _farm2GroupOf.set(socket.id, leaderId);
      _farm2GroupPush(leaderId);
      _farm2GroupPush(socket.id);
      _farm2GroupBroadcastList();
    });

    // Leader-only: boots the named member back to idle, freeing their slot for
    // someone else to join. A no-op if that member isn't actually in the group.
    safeOn('farm2GroupKick', ({ memberId } = {}) => {
      const g = _farm2Groups.get(socket.id);
      if (!g || !memberId || !g.members.has(memberId)) return;
      g.members.delete(memberId);
      _farm2GroupOf.delete(memberId);
      _farm2GroupPush(memberId, 'kicked');
      _farm2GroupPush(socket.id);
      _farm2GroupBroadcastList();
    });

    // Any side stepping away on their own. The leader leaving dissolves the
    // whole group (every member is bounced back to idle); a member leaving
    // just frees their own slot.
    safeOn('farm2GroupLeave', () => {
      const leaderId = _farm2GroupOf.get(socket.id);
      if (!leaderId) return;
      if (leaderId === socket.id) {
        _farm2GroupDissolve(leaderId, 'leaderLeft');
      } else {
        const g = _farm2Groups.get(leaderId);
        if (!g || !g.members.has(socket.id)) return;
        g.members.delete(socket.id);
        _farm2GroupOf.delete(socket.id);
        _farm2GroupPush(leaderId);
        _farm2GroupBroadcastList();
      }
    });

    // Leader-only, and only once the group is FULL (FARM2_PARTY_SIZE-1
    // members) — this is the ONLY way an Элитная фарм-зона run begins: the
    // leader is the one who "enters" and every member is force-moved in with
    // them, exactly as the task spec asks.
    safeOn('farm2GroupStart', async () => {
      if (!session.authed) return;
      if (_farm2.has(socket.id) || _farm2Starting.has(socket.id)) return;
      const g = _farm2Groups.get(socket.id);
      if (!g) return; // not a leader (or not in a group at all)
      const memberIds = [...g.members.keys()];
      if (memberIds.length < FARM2_PARTY_SIZE - 1) {
        return socket.emit('farm2Error', { msg: `Нужна полная группа из ${FARM2_PARTY_SIZE} человек` });
      }
      const memberSockets = memberIds.map(id => io.sockets.sockets.get(id));
      const vanished = memberIds.filter((id, i) => !memberSockets[i]);
      if (vanished.length) {
        // One or more members vanished without the disconnect path catching
        // it — clear those slots rather than trying to deploy ghosts.
        vanished.forEach(id => { g.members.delete(id); _farm2GroupOf.delete(id); });
        _farm2GroupPush(socket.id);
        _farm2GroupBroadcastList();
        return socket.emit('farm2Error', { msg: 'Участник отключился' });
      }

      const allIds = [socket.id, ...memberIds];
      const allNames = [session.authed.username, ...memberIds.map(id => g.members.get(id))];

      // Marks this leader mid-start for the duration of the daily-minutes
      // await below — see _farm2Starting's own comment. Cleared in the
      // finally block covering every return path past this point.
      _farm2Starting.add(socket.id);
      try {
        // Authoritative daily-minutes gate — see this section's own header
        // comment on why every participant is checked here, not just the
        // leader at create time.
        const minutesLeft = await Promise.all(allIds.map(sid => _farm2MinutesLeft(sid)));
        const exhaustedIdx = minutesLeft.findIndex(m => m <= 0);
        if (exhaustedIdx !== -1) {
          const msg = exhaustedIdx === 0
            ? 'Ваше время в Элитной фарм-зоне на сегодня закончилось'
            : `У ${allNames[exhaustedIdx]} закончилось время в Элитной фарм-зоне на сегодня`;
          return socket.emit('farm2Error', { msg });
        }

        // Group everyone into a fresh party of exactly themselves — same shape
        // coopGroupStart's own party formation uses, needed for the kill-share/
        // party-heal/proximity checks the run itself relies on (arePlayersNear
        // and playerParty's other readers).
        allIds.forEach(sid => {
          const oldPartyId = playerParty.get(sid);
          if (oldPartyId) _removeFromParty(oldPartyId, sid);
        });
        const partyId = allIds.join('_');
        const partyMap = new Map();
        allIds.forEach((sid, i) => partyMap.set(sid, allNames[i]));
        parties.set(partyId, partyMap);
        allIds.forEach(sid => playerParty.set(sid, partyId));
        partyMap.forEach((_, mid) => {
          const others = [];
          partyMap.forEach((name, oid) => { if (oid !== mid) others.push({ id: oid, name }); });
          io.to(mid).emit('partyUpdated', { members: others });
        });

        // Deploy everyone. Элитная фарм-зона is its own floor (server/game/
        // floors.js), but like Coop there is no shared, populated Room to walk
        // onto — this connection creates a brand-new private instance right
        // here and force-joins every connection onto it via the `room` override
        // (_forceEnterLocation, exposed per-connection so this handler can move
        // sockets that aren't its own).
        const allSockets = [socket, ...memberSockets];
        const farm2Room = _createFarm2Room();
        const entered = allSockets.map(s => s.data._forceEnterLocation?.('farmZone2', { room: farm2Room }));
        if (entered.some(ok => !ok)) {
          // Something about one of the connections refused the move (no
          // character selected any more, already elsewhere) — don't strand
          // anyone on a half-joined floor, and leave the group intact so the
          // leader can just try again.
          allSockets.forEach((s, i) => { if (entered[i]) s.data._forceEnterLocation?.('hub'); });
          allSockets.forEach(s => s.emit('farm2Error', { msg: 'Не удалось войти — попробуйте ещё раз' }));
          return;
        }
        const spots = allIds.map(sid => farm2Room.farm2Deploy(sid));
        if (spots.some(sp => !sp)) {
          allSockets.forEach(s => s.data._forceEnterLocation?.('hub'));
          allSockets.forEach(s => s.emit('farm2Error', { msg: 'Не удалось войти — попробуйте ещё раз' }));
          return;
        }

        // The group has done its job — clear it out before tracking the run.
        _farm2Groups.delete(socket.id);
        allIds.forEach(sid => _farm2GroupOf.delete(sid));
        _farm2GroupBroadcastList();

        allIds.forEach((sid, i) => {
          const capTimer = safeTimeout('farm2Cap_' + sid, () => {
            _farm2Finish(sid, 'timeCap');
            _farm2CascadeCheck(farm2Room, allIds);
          }, minutesLeft[i] * 60000);
          const minuteTimer = safeInterval('farm2Min_' + sid, () => _lockFarm2Minutes(sid, 1), 60000);
          _farm2.set(sid, { room: farm2Room, participantIds: allIds, capTimer, minuteTimer });
        });
        allSockets.forEach((s, i) => {
          const p = farm2Room.players.get(allIds[i]);
          s.emit('farm2Started', { x: spots[i].x, y: spots[i].y, hp: p?.maxHp, minutesLeft: minutesLeft[i] });
        });
      } finally {
        _farm2Starting.delete(socket.id);
      }
    });

    safeOn('farm2Sync', async () => {
      const run = _farm2.get(socket.id);
      socket.emit('farm2State', {
        entryLevel: FARM2_ENTRY_LEVEL, partySize: FARM2_PARTY_SIZE, dailyMinutes: FARM2_DAILY_MINUTES,
        minutesLeft: await _farm2MinutesLeft(socket.id),
        inRun: !!run,
      });
      socket.emit('farm2GroupState', _farm2GroupStateFor(socket.id));
      socket.emit('farm2GroupList', { groups: _farm2GroupOpenList() });
    });

    // Sent once the player closes the farm2 result modal — same reasoning as
    // coopReturn above.
    safeOn('farm2Return', () => {
      const spot = _returnToHub(socket.id);
      if (spot) socket.emit('deathBattleReturned', spot);
    });

    // Sent once the player closes the race10 result modal — same reasoning as
    // arena3Return above. Server-side position was already reset to the hub
    // floor by the time this fires either way (an eliminated racer via
    // _race10Eliminate, called from the 'respawn' handler; a survivor via
    // _race10Finish once the race ends) — this is just the visual catch-up,
    // and _returnToHub's own same-floor guard makes it a safe no-op if so.
    safeOn('race10Return', () => {
      const spot = _returnToHub(socket.id);
      if (spot) socket.emit('deathBattleReturned', spot);
    });

    // Sent once the player closes the arena3 result modal. Server-side position
    // was already reset to the hub floor when the match ended (eliminated
    // players get it immediately via arena3Eliminated; survivors get it inside
    // _a3Finish) — this just tells THIS client to catch up visually. Safe to
    // call any time (not gated on being mid-match): _returnToHub always just
    // re-lands the caller on the hub floor, and no-ops if they're already
    // there (see _doEnterLocation's same-floor guard).
    safeOn('arena3Return', () => {
      const spot = _returnToHub(socket.id);
      if (spot) socket.emit('deathBattleReturned', spot);
    });

    // Sent once the winner closes the reward modal — everyone else was already
    // sent back (to wherever they each were, see _dbReturnEntrant) the
    // moment they were eliminated; the winner is left standing in the arena
    // until this. Own event name (not the shared 'deathBattleReturned'
    // arena3Return/race10Return use) so the client can label this teleport
    // correctly — it lands somewhere different (the winner's own pre-battle
    // spot) from what that event means for those other two.
    safeOn('deathBattleReturn', () => {
      if (_db.winnerId !== socket.id) return; // see _db.winnerId — not a free teleport home
      _db.winnerId = null;
      const spot = _dbReturnEntrant(socket.id);
      if (spot) socket.emit('deathBattleReturnedPrev', spot);
    });

    safeOn('deathBattleSync', () => {
      socket.emit('deathBattleState', { ..._dbPublicState(), registered: _db.reg.has(socket.id) });
    });

};
