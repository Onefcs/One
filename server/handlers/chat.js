'use strict';
// chat: the safeOn handlers moved out of server/index.js verbatim, with
// the closure helpers only this domain used.
//
// Per-connection, so this takes the session object rather than the plain deps
// bag the server/game/*.js factories use — see server/handlers/market.js for
// the reasoning. `s.*` is every piece of connection state index.js reassigns
// after this module is wired; everything stable is destructured below under
// its original name, which is what keeps the moved bodies byte-identical.
module.exports = function registerChat(s, safeOn, deps) {
  const {
    _dmKey, _recordChat, _recordDm, _removeFromParty, _resolveUsername,
    _translateText, activeSessions, calcBM, dmHistory, io, parties,
    playerParty,
  } = deps;

  const {
    _logHandlerErr, socket,
  } = s;

    let _lastTranslateAt = 0;

    safeOn('chat', ({ text } = {}) => {
      if (!s.authed || !text || typeof text !== 'string') return;
      const now = Date.now();
      if (now - s.lastChatAt < 3000) return;
      s.lastChatAt = now;
      const msg = text.trim().slice(0, 100);
      if (!msg) return;
      _recordChat(s.authed.username, msg);
      io.emit('chatMsg', { username: s.authed.username, text: msg });
    });

    // "Translate" button on a chat bubble (global/clan/DM alike — this only
    // ever sees the message text, never which channel it came from). Keyed by
    // reqId so a reply can't land on the wrong bubble if the player fires off
    // several translate clicks before any of them come back.
    safeOn('translateChat', async ({ text, target, reqId } = {}) => {
      if (!s.authed || !text || typeof text !== 'string') return;
      const now = Date.now();
      // Answered, not dropped. The client marks the bubble as translating the
      // moment it asks and only ever clears that on a reply, so returning in
      // silence here left it stuck on "…" for the rest of the session — with
      // no way to retry, since the same flag makes a second click a no-op.
      if (now - _lastTranslateAt < 1000) {
        return socket.emit('translateChatResult', { reqId, error: true, reason: 'rate' });
      }
      _lastTranslateAt = now;
      const msg = text.slice(0, 200);
      const lang = (typeof target === 'string' && /^[a-z]{2}$/.test(target)) ? target : 'en';
      try {
        const translated = await _translateText(msg, lang);
        socket.emit('translateChatResult', { reqId, text: translated });
      } catch (err) {
        // Google throttles the free endpoints per IP and every player's click
        // leaves from this one server IP, so this is a "come back in a bit",
        // not a broken message — and the log line carries the HTTP status the
        // player's error could never explain (see _translateText).
        _logHandlerErr('translateChat', err);
        socket.emit('translateChatResult', { reqId, error: true, reason: 'unavailable' });
      }
    });

    // ── Private messages — @mention-addressed 1:1 conversation. Resolved via
    // DB (works even if the recipient is offline, see _resolveUsername), but
    // only delivered live if they currently have an active socket. ──
    safeOn('privMsg', async ({ toUsername, text }) => {
      if (!s.authed || !text || typeof text !== 'string' || !toUsername) return;
      const now = Date.now();
      if (now - s.lastChatAt < 3000) return;
      const msg = text.trim().slice(0, 100);
      if (!msg) return;
      const target = await _resolveUsername(toUsername);
      if (!target) return socket.emit('privMsgError', { msg: 'Пользователь @' + toUsername + ' не найден' });
      if (target.telegramId === s.authed.telegramId) return socket.emit('privMsgError', { msg: 'Нельзя написать самому себе' });
      s.lastChatAt = now;
      _recordDm(s.authed.telegramId, target.telegramId, s.authed.username, msg);
      socket.emit('privMsg', { withUsername: target.username, username: s.authed.username, text: msg });
      const targetSocketId = activeSessions.get(target.telegramId);
      const targetSocket = targetSocketId ? io.sockets.sockets.get(targetSocketId) : null;
      if (targetSocket) targetSocket.emit('privMsg', { withUsername: s.authed.username, username: s.authed.username, text: msg });
    });

    safeOn('privMsgHistory', async ({ withUsername }) => {
      if (!s.authed || !withUsername) return;
      const target = await _resolveUsername(withUsername);
      if (!target) return socket.emit('privMsgError', { msg: 'Пользователь @' + withUsername + ' не найден' });
      socket.emit('privMsgHistory', { withUsername: target.username, messages: dmHistory.get(_dmKey(s.authed.telegramId, target.telegramId)) || [] });
    });

    // ── Party ─────────────────────────────────────────────────────────────────
    safeOn('partyInvite', ({ targetId }) => {
      if (!s.authed) return;
      // Target must not already be in a party
      if (playerParty.has(targetId)) return;
      // Inviter's party must not be full (max 5)
      const inviterPartyId = playerParty.get(socket.id);
      if (inviterPartyId) {
        const inviterParty = parties.get(inviterPartyId);
        if (inviterParty && inviterParty.size >= 5) return;
      }
      const targetSocket = io.sockets.sockets.get(targetId);
      if (!targetSocket || !targetSocket.data?.username) return;
      // Authoritative — see racePairAllowed (Room.js): a race10 racer in
      // another (still-corridor-bound) lane is now visible to invite from, but
      // shouldn't actually be reachable until the shared boss room.
      if (s.currentRoom && !s.currentRoom.racePairAllowed(socket.id, targetId)) return;
      targetSocket.emit('partyInviteReceived', { fromId: socket.id, fromName: s.authed.username });
    });

    safeOn('partyAccept', ({ fromId }) => {
      if (!s.authed || playerParty.has(socket.id)) return;
      const fromSocket = io.sockets.sockets.get(fromId);
      if (!fromSocket) return;

      const fromPartyId = playerParty.get(fromId);
      let partyId, partyMap;

      if (fromPartyId) {
        // Join inviter's existing party
        partyMap = parties.get(fromPartyId);
        if (!partyMap || partyMap.size >= 5) return;
        partyId = fromPartyId;
        partyMap.set(socket.id, s.authed.username);
        playerParty.set(socket.id, partyId);
      } else {
        // Create new party
        partyId = fromId + '_' + socket.id;
        partyMap = new Map();
        partyMap.set(fromId, fromSocket.data.username || fromId.slice(0, 6));
        partyMap.set(socket.id, s.authed.username);
        parties.set(partyId, partyMap);
        playerParty.set(fromId, partyId);
        playerParty.set(socket.id, partyId);
      }

      // Emit partyUpdated to each member with the list of OTHER members
      partyMap.forEach((_, mid) => {
        const others = [];
        partyMap.forEach((name, oid) => { if (oid !== mid) others.push({ id: oid, name }); });
        io.to(mid).emit('partyUpdated', { members: others });
      });
    });

    // No server-side party state to clean up here — a pending invite was never
    // tracked anywhere (partyInvite is fire-and-forget: it either lands as
    // partyInviteReceived or the target was never reachable at all), so
    // there's nothing to roll back. But the inviter WAS left with nothing:
    // this used to be a pure no-op, so their client just sat there with no
    // idea whether the invite is still pending, was declined, or vanished
    // into a client that closed the popup without answering at all. Telling
    // them closes that gap.
    safeOn('partyDecline', ({ fromId } = {}) => {
      if (!s.authed || typeof fromId !== 'string') return;
      const fromSocket = io.sockets.sockets.get(fromId);
      if (fromSocket) fromSocket.emit('partyInviteDeclined', { byName: s.authed.username });
    });

    // Answered straight from this Room's own record of the target (see
    // Room.publicProfile) instead of relaying to their client — that earlier
    // approach could go unanswered forever if their client was slow, on a
    // menu, or gone. The requester can only ever target someone currently
    // rendered in their own view, so they're guaranteed to be in this same
    // Room; the null case below is just the rare race of them disconnecting
    // in the instant between being targeted and the tap landing.
    safeOn('requestPlayerProfile', ({ targetId }) => {
      if (!s.authed || typeof targetId !== 'string' || !s.currentRoom) return;
      // Being rendered is no longer the same as being reachable: race10 racers
      // in a different (still-corridor-bound) lane are visible to each other
      // but not to each other's profile — see racePairAllowed, Room.js.
      if (!s.currentRoom.racePairAllowed(socket.id, targetId)) {
        return socket.emit('playerProfileResult', { fromId: targetId, fromName: null, profile: null });
      }
      const raw = s.currentRoom.publicProfile(targetId);
      if (!raw) return socket.emit('playerProfileResult', { fromId: targetId, fromName: null, profile: null });
      const { upgrades, ...profile } = raw;
      profile.bm = calcBM({ lvl: raw.lvl, atk: raw.atk, def: raw.def, maxHp: raw.maxHp, upgrades });
      socket.emit('playerProfileResult', { fromId: targetId, fromName: raw.name, profile });
    });

    safeOn('partyLeave', () => {
      const partyId = playerParty.get(socket.id);
      if (partyId) _removeFromParty(partyId, socket.id);
    });
};
