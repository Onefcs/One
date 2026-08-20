'use strict';
// Clan chat, private messages, and the party — invite, accept, decline, leave,
// and reading another player's profile card.
//
// Sixth cut into io.on('connection'), and cut around something rather than out
// of a block: between the private-message handlers and the party ones sat
// saveProgress, 192 lines with no heading of its own. It is the handler that
// writes the character — the most central one in the file, and the source of
// every _lastStats reassignment the other modules read through live getters —
// and it has nothing to do with either chat or parties. It stays in
// server/index.js, under a heading of its own now.
//
// That is the fifth region in this refactor whose bad measurement turned out
// to be a heading rather than coupling: probing this range as one block asked
// for _sanitizeSavedStats, _saveDebounceTimer and calcBM, which no chat handler
// wants. Cut around saveProgress it needs twenty-two names.
//
// session.lastChatAt is a get/set pair because global chat and clan chat share
// one 3-second window and now live in different files. _lastTranslateAt is not:
// nothing outside these handlers ever read it, so it moves in as a local.
const ClanModel = require('../models/Clan');
const { calcBM } = require('../anticheat');

// See createGuildWar (server/events/guildwar.js) for why this is checked.
const REQUIRED_DEPS = [
  'socket', 'safeOn', 'io', 'activeSessions', 'session',
  'clanChatHistory', 'dmHistory', 'parties', 'playerParty',
  'dmKey', 'logHandlerErr', 'recordClanChat', 'recordDm',
  'removeFromParty', 'resolveUsername', 'socketForTelegramId', 'translateText',
];

module.exports = function registerSocialHandlers(deps) {
  const missing = REQUIRED_DEPS.filter(k => !deps || deps[k] == null);
  if (missing.length) throw new Error(`registerSocialHandlers: missing deps: ${missing.join(', ')}`);
  const {
    socket, safeOn, io, activeSessions, session,
    clanChatHistory, dmHistory, parties, playerParty,
    dmKey, logHandlerErr, recordClanChat, recordDm,
    removeFromParty, resolveUsername, socketForTelegramId, translateText,
  } = deps;

  // Per-socket translate cooldown — see the header for why it lives here.
  let _lastTranslateAt = 0;

    // ── Clan chat — delivered only to members currently online, same
    // "iterate connected sockets by telegramId" pattern _notifyClan uses ──
    safeOn('clanChat', async ({ text }) => {
      if (!session.authed || !text || typeof text !== 'string') return;
      const now = Date.now();
      if (now - session.lastChatAt < 3000) return;
      const msg = text.trim().slice(0, 100);
      if (!msg) return;
      const clan = await ClanModel.findOne({ 'members.telegramId': session.authed.telegramId }).catch(() => null);
      if (!clan) return socket.emit('chatError', { channel: 'clan', msg: 'Вы не состоите в клане' });
      session.lastChatAt = now;
      recordClanChat(clan._id, session.authed.username, msg);
      for (const m of clan.members) {
        const target = socketForTelegramId(m.telegramId);
        if (target) target.emit('clanChatMsg', { username: session.authed.username, text: msg });
      }
    });

    safeOn('clanChatHistory', async () => {
      if (!session.authed) return;
      const clan = await ClanModel.findOne({ 'members.telegramId': session.authed.telegramId }).catch(() => null);
      socket.emit('clanChatHistory', { messages: clan ? (clanChatHistory.get(String(clan._id)) || []) : [] });
    });

    // "Translate" button on a chat bubble (global/clan/DM alike — this only
    // ever sees the message text, never which channel it came from). Keyed by
    // reqId so a reply can't land on the wrong bubble if the player fires off
    // several translate clicks before any of them come back.
    safeOn('translateChat', async ({ text, target, reqId } = {}) => {
      if (!session.authed || !text || typeof text !== 'string') return;
      const now = Date.now();
      if (now - _lastTranslateAt < 1000) return;
      _lastTranslateAt = now;
      const msg = text.slice(0, 200);
      const lang = (typeof target === 'string' && /^[a-z]{2}$/.test(target)) ? target : 'en';
      try {
        const translated = await translateText(msg, lang);
        socket.emit('translateChatResult', { reqId, text: translated });
      } catch (err) {
        logHandlerErr('translateChat', err);
        socket.emit('translateChatResult', { reqId, error: true });
      }
    });

    // ── Private messages — @mention-addressed 1:1 conversation. Resolved via
    // DB (works even if the recipient is offline, see _resolveUsername), but
    // only delivered live if they currently have an active socket. ──
    safeOn('privMsg', async ({ toUsername, text }) => {
      if (!session.authed || !text || typeof text !== 'string' || !toUsername) return;
      const now = Date.now();
      if (now - session.lastChatAt < 3000) return;
      const msg = text.trim().slice(0, 100);
      if (!msg) return;
      const target = await resolveUsername(toUsername);
      if (!target) return socket.emit('privMsgError', { msg: 'Пользователь @' + toUsername + ' не найден' });
      if (target.telegramId === session.authed.telegramId) return socket.emit('privMsgError', { msg: 'Нельзя написать самому себе' });
      session.lastChatAt = now;
      recordDm(session.authed.telegramId, target.telegramId, session.authed.username, msg);
      socket.emit('privMsg', { withUsername: target.username, username: session.authed.username, text: msg });
      const targetSocketId = activeSessions.get(target.telegramId);
      const targetSocket = targetSocketId ? io.sockets.sockets.get(targetSocketId) : null;
      if (targetSocket) targetSocket.emit('privMsg', { withUsername: session.authed.username, username: session.authed.username, text: msg });
    });

    safeOn('privMsgHistory', async ({ withUsername }) => {
      if (!session.authed || !withUsername) return;
      const target = await resolveUsername(withUsername);
      if (!target) return socket.emit('privMsgError', { msg: 'Пользователь @' + withUsername + ' не найден' });
      socket.emit('privMsgHistory', { withUsername: target.username, messages: dmHistory.get(dmKey(session.authed.telegramId, target.telegramId)) || [] });
    });


    // ── Party ─────────────────────────────────────────────────────────────────
    safeOn('partyInvite', ({ targetId }) => {
      if (!session.authed) return;
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
      if (session.room && !session.room.racePairAllowed(socket.id, targetId)) return;
      targetSocket.emit('partyInviteReceived', { fromId: socket.id, fromName: session.authed.username });
    });

    safeOn('partyAccept', ({ fromId }) => {
      if (!session.authed || playerParty.has(socket.id)) return;
      const fromSocket = io.sockets.sockets.get(fromId);
      if (!fromSocket) return;

      const fromPartyId = playerParty.get(fromId);
      let partyId, partyMap;

      if (fromPartyId) {
        // Join inviter's existing party
        partyMap = parties.get(fromPartyId);
        if (!partyMap || partyMap.size >= 5) return;
        partyId = fromPartyId;
        partyMap.set(socket.id, session.authed.username);
        playerParty.set(socket.id, partyId);
      } else {
        // Create new party
        partyId = fromId + '_' + socket.id;
        partyMap = new Map();
        partyMap.set(fromId, fromSocket.data.username || fromId.slice(0, 6));
        partyMap.set(socket.id, session.authed.username);
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
      if (!session.authed || typeof fromId !== 'string') return;
      const fromSocket = io.sockets.sockets.get(fromId);
      if (fromSocket) fromSocket.emit('partyInviteDeclined', { byName: session.authed.username });
    });

    // Answered straight from this Room's own record of the target (see
    // Room.publicProfile) instead of relaying to their client — that earlier
    // approach could go unanswered forever if their client was slow, on a
    // menu, or gone. The requester can only ever target someone currently
    // rendered in their own view, so they're guaranteed to be in this same
    // Room; the null case below is just the rare race of them disconnecting
    // in the instant between being targeted and the tap landing.
    safeOn('requestPlayerProfile', ({ targetId }) => {
      if (!session.authed || typeof targetId !== 'string' || !session.room) return;
      // Being rendered is no longer the same as being reachable: race10 racers
      // in a different (still-corridor-bound) lane are visible to each other
      // but not to each other's profile — see racePairAllowed, Room.js.
      if (!session.room.racePairAllowed(socket.id, targetId)) {
        return socket.emit('playerProfileResult', { fromId: targetId, fromName: null, profile: null });
      }
      const raw = session.room.publicProfile(targetId);
      if (!raw) return socket.emit('playerProfileResult', { fromId: targetId, fromName: null, profile: null });
      const { upgrades, ...profile } = raw;
      profile.bm = calcBM({ lvl: raw.lvl, atk: raw.atk, def: raw.def, maxHp: raw.maxHp, upgrades });
      socket.emit('playerProfileResult', { fromId: targetId, fromName: raw.name, profile });
    });

    safeOn('partyLeave', () => {
      const partyId = playerParty.get(socket.id);
      if (partyId) removeFromParty(partyId, socket.id);
    });

};
