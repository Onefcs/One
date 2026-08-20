'use strict';
// Элитная фарм-зона — a private party run and the pre-run lobby that forms it.
//
// Seventh and last of the instanced/timed event machines to leave
// server/index.js, on the pattern server/events/guildwar.js set. It was the
// one that measured badly enough to be skipped twice: the region under its
// heading returned fourteen names including floorRooms, mongoose,
// _refreshTopPlayer, TOP_PLAYER_POLL_MS, GuildWarStateModel and BossStateModel,
// which is not what a farm zone should need.
//
// None of it was the farm zone. Parked under the same heading, immediately
// after it, was _initFloorRooms — the world's own bootstrap, which pre-creates
// every floor's Room once MongoDB is reachable. It has nothing to do with this
// zone beyond having been written next to it, and it stays in server/index.js.
// With it left behind the machine needs five names, three of which it requires
// for itself. What comes in:
//
//   io              fan-out to a run, a lobby or a socket
//   _returnToHub    put a socket back in the hub
//
// The same two Сотрудничество needs, which is what the two zones being the
// same shape ought to look like.
const Room = require('../game/Room');
const { FLOOR_IDS } = require('../game/floors');
const { FARM2_PARTY_SIZE } = require('../../shared/definitions');

// See createGuildWar for why this is checked rather than assumed.
const REQUIRED_DEPS = ['io', '_returnToHub'];

module.exports = function createFarm2(deps) {
  const missing = REQUIRED_DEPS.filter(k => !deps || deps[k] == null);
  if (missing.length) throw new Error(`createFarm2: missing deps: ${missing.join(', ')}`);
  const { io, _returnToHub } = deps;

  // ── Элитная фарм-зона (Elite Farm Zone 2) ───────────────────────────────────
  // Same leader/member group-lobby shape Coop's own _coopGroups uses, just
  // FARM2_PARTY_SIZE seats (leader + FARM2_PARTY_SIZE-1 members) instead of 2,
  // and one shared private instance instead of per-player lanes — every
  // monster here is baked in at world-gen (generateFarmZone2, server/game/
  // dungeon.js), not spawned per-stage, so there is nothing that needs the
  // per-player isolation Coop's stage progression relies on. Unlike Coop,
  // dying inside does NOT end the run (Room.respawnPlayer respawns in place,
  // same as any other free-roam zone) — only actually LEAVING the zone
  // (walking out, disconnecting, or dropping out of the run's temporary
  // party) does, and when it does, everyone else still in goes too: see
  // _farm2CascadeCheck.
  //
  // leaderId -> { leaderName, members: Map<socketId, name> } — up to
  // FARM2_PARTY_SIZE-1 members. Lives here only until farm2GroupStart
  // consumes it (deleted at that point) or it's dissolved without ever
  // starting (leader leaves/disconnects).
  const _farm2Groups = new Map();
  // socketId -> leaderId, for the leader (points at itself) and every member —
  // the reverse lookup farm2GroupKick/Leave/Start all need.
  const _farm2GroupOf = new Map();
  // leaderId currently mid-farm2GroupStart. farm2GroupStart awaits a daily-
  // minutes DB read (_farm2MinutesLeft) BEFORE its first write to `_farm2` —
  // unlike coopGroupStart, which never yields to the event loop before its
  // own `_coop.set` — so without this, a double-click/duplicate event could
  // have two calls both pass the `_farm2.has(socket.id)` guard while the
  // first is still in flight and deploy the same leader twice. Same shape as
  // _a3.starting (see _a3TryStart's own comment).
  const _farm2Starting = new Set();

  function _farm2GroupStateFor(socketId) {
    const leaderId = _farm2GroupOf.get(socketId);
    const g = leaderId && _farm2Groups.get(leaderId);
    if (!g) return { inGroup: false };
    const members = [...g.members.entries()].map(([id, name]) => ({ id, name }));
    return {
      inGroup: true,
      isLeader: socketId === leaderId,
      leaderId, leaderName: g.leaderName,
      members, maxMembers: FARM2_PARTY_SIZE - 1,
    };
  }

  function _farm2GroupPush(socketId, reason) {
    const st = _farm2GroupStateFor(socketId);
    if (reason) st.reason = reason;
    io.to(socketId).emit('farm2GroupState', st);
  }

  // Only groups still short a member are worth offering.
  function _farm2GroupOpenList() {
    const groups = [];
    _farm2Groups.forEach((g, leaderId) => {
      if (g.members.size < FARM2_PARTY_SIZE - 1 && io.sockets.sockets.get(leaderId)) {
        groups.push({ id: leaderId, leaderName: g.leaderName, size: g.members.size + 1, maxSize: FARM2_PARTY_SIZE });
      }
    });
    return groups;
  }

  function _farm2GroupBroadcastList() {
    io.emit('farm2GroupList', { groups: _farm2GroupOpenList() });
  }

  // Leader gone dissolves the whole group; every member is notified so their
  // panel drops back to idle rather than waiting forever on a leader who's no
  // longer there.
  function _farm2GroupDissolve(leaderId, reason) {
    const g = _farm2Groups.get(leaderId);
    if (!g) return;
    _farm2Groups.delete(leaderId);
    _farm2GroupOf.delete(leaderId);
    g.members.forEach((_, mid) => {
      _farm2GroupOf.delete(mid);
      _farm2GroupPush(mid, reason);
    });
    _farm2GroupBroadcastList();
  }

  // Disconnect while still in the lobby (never reached a live run) drops the
  // disconnecting side immediately — no reconnect grace, same as Coop's own
  // lobby (_coopGroupDropOnDisconnect).
  function _farm2GroupDropOnDisconnect(socketId) {
    const leaderId = _farm2GroupOf.get(socketId);
    if (!leaderId) return;
    if (leaderId === socketId) {
      _farm2GroupDissolve(leaderId, 'leaderLeft');
    } else {
      const g = _farm2Groups.get(leaderId);
      if (g && g.members.has(socketId)) {
        g.members.delete(socketId);
        _farm2GroupOf.delete(socketId);
        _farm2GroupPush(leaderId);
        _farm2GroupBroadcastList();
      }
    }
  }

  // Every Элитная фарм-зона run gets its OWN Room, shared by exactly its
  // FARM2_PARTY_SIZE participants, created here and never registered in
  // floorRooms — same reasoning as _createCoopRoom's own comment.
  function _createFarm2Room() {
    const room = new Room(FLOOR_IDS.farmZone2, io, {}, null);
    _farm2Rooms.add(room);
    return room;
  }
  const _farm2Rooms = new Set();
  function _liveFarm2Rooms() {
    const live = [];
    _farm2Rooms.forEach(r => {
      if (r.players.size > 0) live.push(r);
      else _farm2Rooms.delete(r);
    });
    return live;
  }

  // socketId -> { room, participantIds, capTimer, minuteTimer } for whoever
  // currently has a run going. participantIds is every one of the
  // FARM2_PARTY_SIZE sockets that started this run together, captured once at
  // farm2GroupStart — read by _farm2CascadeCheck to know who else needs to be
  // pulled out the moment membership drops below the full party.
  const _farm2 = new Map();

  function _farm2ClearTimers(socketId) {
    const run = _farm2.get(socketId);
    if (!run) return;
    if (run.capTimer) clearTimeout(run.capTimer);
    if (run.minuteTimer) clearInterval(run.minuteTimer);
  }

  // Ends this ONE participant's own membership — releases their spot on the
  // room, clears their timers, and drops the run record, without deciding
  // where they go or telling anyone else anything (callers that need to end
  // the run for everyone still in call this once per participant still
  // present — see _farm2CascadeCheck). Returns the run it ended, or null.
  function _farm2ReleaseRun(socketId) {
    const run = _farm2.get(socketId);
    if (!run) return null;
    _farm2ClearTimers(socketId);
    _farm2.delete(socketId);
    if (run.room) run.room.farm2Release(socketId);
    return run;
  }

  function _farm2Finish(socketId, reason) {
    const run = _farm2ReleaseRun(socketId);
    if (!run) return;
    const spot = _returnToHub(socketId);
    io.to(socketId).emit('farm2Finished', { reason, x: spot?.x, y: spot?.y });
  }

  // Called after any ONE participant's own membership just ended (finished,
  // disconnected, dropped out of the run's party) — the zone was only ever
  // entered as a full FARM2_PARTY_SIZE, so if fewer than that are still
  // actually in the room, whoever's left can't continue and the whole run
  // ends for them too. `room`/`participantIds` are the ones captured on the
  // run record BEFORE the triggering release, since that release already
  // removed its own socket from `_farm2`.
  function _farm2CascadeCheck(room, participantIds) {
    if (!room || !participantIds) return;
    const stillIn = participantIds.filter(sid => _farm2.has(sid) && _farm2.get(sid).room === room);
    if (stillIn.length > 0 && stillIn.length < FARM2_PARTY_SIZE) {
      stillIn.forEach(sid => _farm2Finish(sid, 'partyBroken'));
    }
  }

  // Wired into _removeFromParty's fan-out (mirrors _coopEliminate) — dropping
  // out of the run's temporary party (an explicit partyLeave, or any other
  // removal path) ends this participant's own membership and, if that leaves
  // fewer than a full party still in, ends the run for the rest too.
  function _farm2Eliminate(socketId) {
    const run = _farm2.get(socketId);
    if (!run) return false;
    const { room, participantIds } = run;
    _farm2Finish(socketId, 'left');
    _farm2CascadeCheck(room, participantIds);
    return true;
  }

  // Disconnect-class exit — no reconnect grace (same choice Coop made for its
  // own live runs): the disconnecting socket is already gone, so this only
  // releases its own spot/timers (no _returnToHub/farm2Finished round trip —
  // there is nothing to tell it) and cascades to whoever is still in.
  function _farm2EjectOnDisconnect(socketId) {
    const run = _farm2ReleaseRun(socketId);
    if (!run) return false;
    _farm2CascadeCheck(run.room, run.participantIds);
    return true;
  }

  return {
    _farm2, _farm2Starting, _createFarm2Room,
    _farm2Finish, _farm2Eliminate, _farm2ReleaseRun,
    _farm2CascadeCheck, _farm2EjectOnDisconnect,
    _farm2Groups, _farm2GroupOf, _farm2GroupPush, _farm2GroupBroadcastList,
    _farm2GroupStateFor, _farm2GroupOpenList, _farm2GroupDissolve,
    _farm2GroupDropOnDisconnect,
  };
};
