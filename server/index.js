const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const helmet = require('helmet');
const compression = require('compression');
const { Server } = require('socket.io');
// Shared with the client so both sides agree on what a facing index means —
// see the 'mv' handler below.
const { NC_FACING, NC_AOE_STYLES } = require('../shared/netcodec');
const mongoose = require('mongoose');
const {
  _sanitizeName, _safeUsername, _sanitizeClanDesc,
  verifyTelegramAuth, verifyTelegramWebApp,
  _adminToken, _verifyAdminToken, _safeEqual,
  _loginLockedUntil, _recordLoginFail, _clearLoginFails, _tgEsc,
} = require('./security');
// Splits the hosting bill's one "network egress" number into player downloads,
// the live game stream, and everything else (the database, the Telegram API).
// See server/egress.js — nothing in the game depends on it.
const egress = require('./egress');
const {
  SERVER_INV_MAX, _SANITIZE_MAX, _HP_POTION_IDS, _HP_POTION_HEAL,
  _catalogBase, _unknownItemIds, _canonSavedItem,
  _clampNum, _clampInt, _sanitizeKeyMap,
  _sanitizeSavedStats, calcBM,
} = require('./anticheat');
const {
  _round2, _round7,
  _itemSlotOf, _isStackable, _invRemove, _invAdd, _invHasRoomFor,
} = require('./inventory');
const { _rollMobLoot, _rollFarmZoneLoot, _rollFarm2Loot } = require('./loot');
// The package tables and the room arithmetic over them went out with the
// wallet handlers (server/handlers/wallet.js), which requires them directly.
// What is left here is what claimVipRewards below still reads.
const { _STONE_DEFS, _vipLevelItems, _vipGoldReward } = require('./shop');

// ── Why sessions end ─────────────────────────────────────────────────────────
// "Мир перезагружается" is, from the server's side, always the same event: a
// socket went away and the client reconnected — which re-runs selectChar and
// makes gameStart rebuild the whole world on the client. The useful question
// is never "did it reconnect" but "why did the socket go", and socket.io
// answers that precisely, in the `reason` argument the disconnect handler was
// throwing away:
//
//   ping timeout               the client stopped answering engine.io's own
//                              pings for pingTimeout — a real network loss, a
//                              frozen client, or a suspended WebView.
//   transport close            the connection closed under us: the app was
//                              backgrounded/closed, the network dropped, or
//                              something in front of us (a load balancer, a
//                              proxy) cut it.
//   transport error            it broke mid-flight.
//   client namespace disconnect  the CLIENT chose to disconnect — for this
//                              game that is js/network.js's watchdog deciding
//                              the link is dead after 4 unanswered pings, so
//                              a pile of these means the watchdog is firing,
//                              not that the network is failing.
//   server namespace disconnect  we closed it: a duplicate login being kicked,
//                              maintenance mode, the auth timeout.
//   server shutting down       a deploy or a restart, i.e. every session at
//                              once.
//
// Those five outcomes need five different fixes, and they are indistinguishable
// from the outside — which is exactly why this had to stop being a guess.
// Counted rather than logged per-event (a busy server would drown in lines),
// split by whether the session had authenticated and how long it lasted, and
// exposed on /health next to the tick timings. `sinceMs` makes the counts a
// rate rather than a total nobody can interpret.
const _sessionStats = {
  since: Date.now(),
  reasons: new Map(),   // reason -> count
  shortLived: 0,        // authenticated sessions that died inside SHORT_SESSION_MS
  authedEnded: 0,
  totalMs: 0,
};
// A session this short did not end because the player put their phone down.
// It is the shape a reconnect loop makes, and counting it separately means a
// loop shows up as a ratio instead of having to be spotted in a log.
const SHORT_SESSION_MS = 60000;
function _recordSessionEnd(reason, wasAuthed, lifetimeMs) {
  const key = String(reason || 'unknown');
  _sessionStats.reasons.set(key, (_sessionStats.reasons.get(key) || 0) + 1);
  if (!wasAuthed) return;
  _sessionStats.authedEnded++;
  _sessionStats.totalMs += lifetimeMs;
  if (lifetimeMs < SHORT_SESSION_MS) _sessionStats.shortLived++;
}
function _sessionStatsSnapshot() {
  const n = _sessionStats.authedEnded;
  return {
    sinceMs: Date.now() - _sessionStats.since,
    endedAuthed: n,
    shortLived: _sessionStats.shortLived,
    avgSessionS: n ? Math.round(_sessionStats.totalMs / n / 1000) : 0,
    reasons: Object.fromEntries(_sessionStats.reasons),
  };
}

// ── Timers that cannot take the process down ─────────────────────────────────
// A timer callback runs on an empty stack: nothing is above it to catch a
// throw, so it reaches process scope, where uncaughtException (bottom of this
// file) logs it and calls process.exit(1). Every player online loses their
// connection over it, the client wipes the world it was rendering (the
// 'disconnect' handler in js/network.js clears serverEnemies/otherPlayers and
// the Pixi pools) and rebuilds from the reconnect's gameStart — which is
// exactly what "мир сломался и игра перезагрузилась" looks like from a phone.
// Worse, the cause is usually per-player and periodic (one bad savedData blob
// under a 60s autosave), so the restart repeats on a timer and reads as an
// overloaded server rather than as one bug.
//
// safeOn already gives socket handlers this protection; these give it to the
// other half — the scheduled work. A throw is logged with its timer's name and
// swallowed: one broken tick of one timer, not the whole world.
//
// Deliberately NOT applied to the shutdown/exit timer itself (see
// uncaughtException), which must stay a bare setTimeout.
function _safeFire(name, fn) {
  try {
    const ret = fn();
    // An async callback's rejection lands in unhandledRejection instead, which
    // only logs — but it logs without saying which timer it came from, so name
    // it here too.
    if (ret && typeof ret.catch === 'function') ret.catch(err => console.error(`[timer ${name}]`, err));
  } catch (err) {
    console.error(`[timer ${name}]`, err);
  }
}
function safeTimeout(name, fn, ms) {
  return setTimeout(() => _safeFire(name, fn), ms);
}
function safeInterval(name, fn, ms) {
  return setInterval(() => _safeFire(name, fn), ms);
}
const PlayerModel       = require('./models/Player');
const ClanModel         = require('./models/Clan');
const GramTxModel       = require('./models/GramTx');
const SpecialQuestModel = require('./models/SpecialQuest');
const PlayerLogModel    = require('./models/PlayerLog');
const PvpHistoryModel   = require('./models/PvpHistory');
const ChatMessageModel  = require('./models/ChatMessage');
const BossStateModel    = require('./models/BossState');
const GuildWarStateModel = require('./models/GuildWarState');
const Room = require('./game/Room');
const { FLOOR_IDS, FLOOR_REGISTRY } = require('./game/floors');
const {
  VIP_THRESHOLDS, VIP_BONUSES,
  ITEM_DEF, CRAFT_MATS, BOX_DEF, ENHANCEABLE_SLOTS, isStackableItem,
  codexSetById, codexItemMeetsReq, codexTotalBonus,
  ENEMY_DEF, CHAR_DEF,
  TELEPORT_STONE_PRICE, TELEPORT_CAST_MS,
  UPGRADE_RESET_COST,
  armIndexForLevel,
  DEATH_BATTLE_GRAM_REWARD, deathBattleRewards,
  race10Rewards, race10Liberty,
  WORLD_BOSS_DAYS_MSK, WORLD_BOSS_HOURS_MSK, EVENT_NOTIFY_BEFORE_MS, nextEventStartAt,
  FARM_ENTRY_LEVEL,
  clanAtkBonusPct, xpToNext, ARM_LEVEL_REQ,
  MERCHANT_SHOP, POTION_CAP, CLAN_LEVELS, questComplete,
  FEAR_MAX_WAVE, COOP_STAGE_LEVELS, QUEST_DEF,
  FARM2_ENTRY_LEVEL, FARM2_PARTY_SIZE, FARM2_DAILY_MINUTES,
  FARM2_LIBERTY_CHANCE,
  SEASON_END_AT, SEASON_BURN_POINTS, SEASON_PRIZES, seasonActive, seasonTier,
  SEASON_REF_POINTS, SEASON_REF_LEVEL,
} = require('../shared/definitions');

// enterLocation's generic level gate (see _doEnterLocation) reads from this —
// the arms' own per-key requirements plus every simple "just a level gate,
// no window/queue" special zone folded in next to them, so each new one of
// those doesn't need its own dedicated branch in _doEnterLocation.
const _ZONE_LEVEL_REQ = { ...ARM_LEVEL_REQ, farmZone: FARM_ENTRY_LEVEL };

// ── Coming back to the floor you were standing on ────────────────────────────
// Every new connection starts on the hub, and until now that is where a
// reconnect put you — from anywhere. The floor was already being saved (the
// autosave writes `floor: currentFloor`) and the client sends its own floor in
// every blob; neither was ever read back. So an ordinary mobile drop — the app
// backgrounded past engine.io's 40s of silence, a network handover — rebuilt
// the world on floor 1 and dropped the player at its spawn, which sits in the
// middle of the hub's safe zone. That is the "выкинуло в безопасную зону" half
// of the reload report.
//
// Restored from the DATABASE's copy, never the client's: `floor` rides inside
// the same savedData blob a modified client composes freely, so honouring it
// would be a free teleport onto any floor, past every level gate below. And
// even the stored one is re-checked rather than trusted, because the world can
// have moved on while the player was away — they may have rebirthed back below
// an arm's requirement, or the zone's window may have closed.
//
// Only floors you can STAND on are restorable. The instanced/scheduled ones
// are deliberately absent: pvpArena, race10 and the Death Battle arena all
// treat a disconnect as elimination (see _pvpEliminate), so returning someone
// to an event they are no longer in would be worse than the hub, and Fear has
// its own hall-holding grace path (_fearDisconnectGrace) that runs before this
// one and wins.
const _RESTORABLE_FLOORS = new Set([
  FLOOR_IDS.hub, FLOOR_IDS.left, FLOOR_IDS.top, FLOOR_IDS.bottom, FLOOR_IDS.right,
  FLOOR_IDS.farmZone, FLOOR_IDS.guildWar, FLOOR_IDS.arena,
]);
// floorId -> the key _ZONE_LEVEL_REQ is written in, for the floors that have a
// requirement at all. The arms are already keyed by name in ARM_LEVEL_REQ.
const _FLOOR_KEY = Object.fromEntries(Object.entries(FLOOR_IDS).map(([k, v]) => [v, k]));
function _restoreFloorFor(savedFloor, lvl) {
  const floor = Number(savedFloor);
  if (!Number.isFinite(floor) || !_RESTORABLE_FLOORS.has(floor)) return FLOOR_IDS.hub;
  if (floor === FLOOR_IDS.hub) return FLOOR_IDS.hub;
  // Same level gate the walk-in path applies (_doEnterLocation), re-evaluated
  // against the level they have NOW.
  if ((lvl || 1) < (_ZONE_LEVEL_REQ[_FLOOR_KEY[floor]] || 0)) return FLOOR_IDS.hub;
  // Window-gated zones: only put them back if the zone is still open, exactly
  // as if they were walking in this second.
  if (floor === FLOOR_IDS.guildWar && _gw.phase !== 'live') return FLOOR_IDS.hub;
  if (floor === FLOOR_IDS.arena && !_arenaOpen()) return FLOOR_IDS.hub;
  return floor;
}

// ── Server-side inventory ops for the market ────────────────────────────────
// The item half of every trade used to be entirely client-authoritative: the
// server created/sold/cancelled listings but never touched savedData.inventory,
// trusting the client to splice the item out on listing and to add it back on
// buy/cancel. Two consequences, both exploitable:
//   • nothing verified the seller actually OWNED what they listed — a modified
//     client could list any catalog item it never earned and sell it for real
//     GRAM (unlimited GRAM minting), and
//   • the item only left the seller's saved inventory once the CLIENT's own
//     post-listing save landed, so listing an item and killing the app before
//     that write duplicated it: the save still held the item and the listing
//     was live too. The mirror case lost items instead — a buyer whose
//     marketBought event never arrived (or whose inventory was full) paid GRAM
//     and got nothing, and a cancelled listing whose marketCancelled event was
//     lost destroyed the item outright.
// These mirror js/player.js's invHasSpace/addToInventoryQty/removeFromInventory
// so the server can apply the same change authoritatively. The client still
// applies it optimistically and its next full-array save wins, which keeps the
// two consistent — but the server-side copy means the trade survives a lost
// event or a disconnect mid-trade.







// Bot token — set TG_BOT_TOKEN env var in Railway
const _TG_TOKEN      = process.env.TG_BOT_TOKEN    || '';
// ADMIN_PASSWORD is read by server/security.js, which owns the token and the
// brute-force lock; this file's own copy of it had no readers left once the
// login route moved to server/admin/auth.js.
const ADMIN_USERNAME = process.env.ADMIN_USERNAME  || 'admin';
const TG_ADMIN_ID  = process.env.TG_ADMIN_ID     || '';   // admin's Telegram chat ID
const GRAM_WALLET  = process.env.GRAM_WALLET      || '';   // TON wallet address for deposits

// ── Maintenance mode ─────────────────────────────────────────────────────────
// In-memory toggle, same convention as _gw/_race10's own open/closed state
// (server/index.js) — not persisted, so a restart always comes back up open.
// While on, only TG_ADMIN_ID may log in (see the `banned` checks inside
// loginTelegramWebApp/loginTelegram below, which this sits right next to);
// everyone else gets the same authError rejection a banned account gets.

// Disconnects every currently-connected player except TG_ADMIN_ID, mirroring
// /admin/player/:tid/ban's own kick — used when maintenance is switched on so
// nobody is left standing in a world nobody else can rejoin.
function _kickAllForMaintenance() {
  io.sockets.sockets.forEach(s => {
    if (s.data?.telegramId && s.data.telegramId !== TG_ADMIN_ID) {
      s.emit('kicked', { reason: 'Ведутся технические работы' });
      s.disconnect(true);
    }
  });
}
let _tgBotUsername = process.env.TG_BOT_USERNAME  || '';

// ── Balances ──────────────────────────────────────────────────────────────────
// GRAM and Liberty (Nexum) are real money, and the database is the only place
// that decides what they are. Every movement goes through _incBalance or
// _spendBalance below: one atomic $inc, keyed on the account, whose returned
// value is then adopted everywhere else.
//
// What this replaces: every path used to read a balance, add to it in JavaScript
// and write the whole number back with $set. Two credits landing in the same
// window — a market sale while a deposit is being confirmed, a kill drop while a
// purchase is in flight — each wrote a total computed before the other, so one of
// them simply vanished. A player would watch GRAM arrive and then disappear.
// $inc has no such window: the database applies the delta to whatever it holds
// at that moment, and concurrent deltas add up instead of overwriting.
//
// Two rules follow from this and matter for anything added later:
//   • never write savedData.gramBalance / savedData.nexumBalance with $set —
//     that is what reintroduces the bug. The periodic save deliberately no
//     longer carries either field (see _sanitizeSavedStats, which strips them
//     from the client blob, and the save paths, which no longer add them back).
//   • a spend must use _spendBalance, whose $gte filter makes "can they afford
//     it" and "take it" a single operation. Checking the cached figure first
//     and deducting afterwards is exactly the race this removes.
//
// The Maps below stay as a read cache for display and for spend decisions made
// before the write; they are refreshed from the value the database returns, so
// they can lag but never lead.
const _gramBalanceCache = new Map();

// Same pattern for Nexum. Nexum is server-granted only (mob drops, special-quest
// rewards, admin give) but it also rides along inside the client's saveProgress
// blob, so without an authoritative cache a stale client save could roll back a
// grant the client hadn't observed yet (e.g. a quest/admin nexum award landing
// between two saves). All server-side writers update this map; every persist
// reads nexumBalance from here, never from the client payload.
const _nexumBalanceCache = new Map();

function _balanceCache(field) {
  return field === 'gramBalance' ? _gramBalanceCache : _nexumBalanceCache;
}

// Adds `delta` (negative to subtract) and returns the resulting balance, or
// null if the account could not be found. The returned figure is the database's
// own, post-write, so callers must use it rather than their own arithmetic.
//
// $inc creates the field when it is missing, which is what a brand-new account
// needs; it does throw when savedData itself is null, so the login paths
// initialise savedData to {} before anyone can earn anything.
async function _incBalance(telegramId, field, delta) {
  if (!telegramId || !Number.isFinite(delta) || delta === 0) return null;
  try {
    // An account that only ever pressed /start in the bot has savedData: null
    // (the bot creates the row, the game initialises the object), and a dotted
    // $inc against a null parent throws rather than creating it. That account
    // can still be owed money — it may be someone's referrer, or a seller whose
    // lot was bought — so give it an object first. The filter makes this a
    // no-op for everyone else, i.e. one cheap extra write only in that case.
    await PlayerModel.updateOne(
      { telegramId: String(telegramId), savedData: null },
      { $set: { savedData: {} } },
    );
    const doc = await PlayerModel.findOneAndUpdate(
      { telegramId: String(telegramId) },
      { $inc: { [`savedData.${field}`]: delta } },
      { new: true, projection: { [`savedData.${field}`]: 1 } },
    ).lean();
    if (!doc) return null;
    // Rounded for the cache and for display only — the stored value keeps full
    // precision. Repeated $inc of the 0.0000001 kill drop drifts by ~1e-10 over
    // thousands of hits, far below the seventh decimal anything ever shows.
    const v = _round7(doc.savedData?.[field] ?? 0);
    _balanceCache(field).set(String(telegramId), v);
    return v;
  } catch (err) {
    console.error(`_incBalance(${field}):`, err);
    return null;
  }
}

// Takes `amount` only if the stored balance covers it. Returns the new balance,
// or null when there wasn't enough — in which case nothing was written at all.
// The $gte filter is the whole point: affordability and deduction are one
// operation, so two purchases sent together can't both pass the check.
async function _spendBalance(telegramId, field, amount) {
  if (!telegramId || !Number.isFinite(amount) || amount <= 0) return null;
  try {
    const doc = await PlayerModel.findOneAndUpdate(
      { telegramId: String(telegramId), [`savedData.${field}`]: { $gte: amount } },
      { $inc: { [`savedData.${field}`]: -amount } },
      { new: true, projection: { [`savedData.${field}`]: 1 } },
    ).lean();
    if (!doc) return null;
    const v = _round7(doc.savedData?.[field] ?? 0);
    _balanceCache(field).set(String(telegramId), v);
    return v;
  } catch (err) {
    console.error(`_spendBalance(${field}):`, err);
    return null;
  }
}

// Single-session enforcement: telegramId → socket.id of the active session
const activeSessions = new Map();

// telegramId → in-flight DB-persist promise from a just-disconnected socket.
// A page refresh usually disconnects the old socket (cleanly, fast) well
// before the new page finishes loading and logs back in — by then the old
// socket object is gone, so a login handler has nothing to await against
// even though that socket's debounced save may still be writing to Mongo.
// Any login for this telegramId awaits the pending entry (if any) before
// reading fresh data, so the read can never land ahead of that write.
const _pendingFlush = new Map();


const _GRAM_WITHDRAW_FEE_PCT = 0.10;

// ── Telegram helpers ──────────────────────────────────────────────────────────
function tgApi(method, body) {
  return fetch(`https://api.telegram.org/bot${_TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => r.json()).catch(() => ({ ok: false }));
}


// Admin notification with approve/reject buttons
async function notifyAdminGram(tx) {
  if (!TG_ADMIN_ID) return;
  const isDeposit = tx.type === 'deposit';
  const header = isDeposit ? '💰 <b>Заявка на пополнение</b>' : '📤 <b>Заявка на вывод</b>';
  const fee    = isDeposit ? 0 : _round2(tx.amount * _GRAM_WITHDRAW_FEE_PCT);
  const payout = isDeposit ? 0 : _round2(tx.amount - fee);
  const lines = [
    header,
    `👤 ${_tgEsc(tx.username)} (<code>${_tgEsc(tx.telegramId)}</code>)`,
    `💎 ${Number(tx.amount)} GRAM`,
    isDeposit
      ? `🏷 Мемо: <code>${_tgEsc(tx.memo)}</code>`
      : `📬 Адрес: <code>${_tgEsc(tx.address)}</code>`,
    ...(isDeposit ? [] : [`💸 К отправке: ${payout} GRAM (комиссия ${fee} GRAM)`]),
    `🆔 <code>${tx._id}</code>`,
  ];
  const res = await tgApi('sendMessage', {
    chat_id: TG_ADMIN_ID,
    text: lines.join('\n'),
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [[
      { text: '✅ Подтвердить', callback_data: `gram_ok:${tx._id}` },
      { text: '❌ Отклонить',   callback_data: `gram_no:${tx._id}` },
    ]]},
  });
  if (res.ok) {
    tx.adminMsgId = res.result.message_id;
    await tx.save();
  }
}

// Telegram long-polling for callback_query (admin button clicks)
let _tgOffset = 0;
async function _pollTg() {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${_TG_TOKEN}/getUpdates?offset=${_tgOffset}&timeout=20&allowed_updates=${encodeURIComponent('["callback_query","message"]')}`
    );
    const data = await res.json();
    if (data.ok) {
      for (const upd of data.result) {
        _tgOffset = upd.update_id + 1;
        if (upd.callback_query) _handleAdminCallback(upd.callback_query).catch(() => {});
        if (upd.message) _handleBotMessage(upd.message).catch(() => {});
      }
    }
  } catch { /* ignore network errors */ }
  safeTimeout('tgPoll', _pollTg, 500);
}

async function _handleAdminCallback(cq) {
  // These buttons approve real payouts, so the sender is checked rather than
  // assumed. Today they only exist in the admin's own chat, but nothing else
  // in this function would notice if that stopped being true.
  if (!TG_ADMIN_ID || String(cq?.from?.id || '') !== String(TG_ADMIN_ID)) return;
  const [action, txId] = (cq.data || '').split(':');
  if (!txId || !['gram_ok', 'gram_no'].includes(action)) return;

  await tgApi('answerCallbackQuery', { callback_query_id: cq.id });

  const tx = await GramTxModel.findById(txId);
  if (!tx || tx.status !== 'pending') {
    await tgApi('sendMessage', { chat_id: cq.message.chat.id, text: '⚠️ Уже обработано' });
    return;
  }

  const confirmed = action === 'gram_ok';
  tx.status = confirmed ? 'confirmed' : 'rejected';
  // Set only when this decision actually moved the balance (a confirmed
  // deposit or a refunded withdrawal); left null otherwise so the log shows
  // the decision without implying a credit that never happened.
  let _logBal = null;

  if ((confirmed && tx.type === 'deposit') || (!confirmed && tx.type === 'withdraw')) {
    const doc = await PlayerModel.findOne({ telegramId: tx.telegramId });
    if (doc) {
      // A confirmed deposit, or a rejected withdrawal being refunded. Both are
      // a pure "+amount" against whatever the account holds when the write
      // lands — the admin may well be pressing this button while the player is
      // out farming, and neither side should be able to erase the other.
      const newBal = await _incBalance(tx.telegramId, 'gramBalance', tx.amount);
      if (newBal !== null) {
        io.to(`tg_${tx.telegramId}`).emit('gramBalanceUpdate', { balance: newBal });
        _logBal = newBal;
      }

      // 5% referral bonus on confirmed deposit
      if (confirmed && tx.type === 'deposit' && doc.referredBy) {
        const bonus = Math.round(tx.amount * 0.05 * 100) / 100;
        if (bonus > 0) {
          const refDoc = await PlayerModel.findOne({ telegramId: doc.referredBy });
          const refNewBal = refDoc ? await _incBalance(doc.referredBy, 'gramBalance', bonus) : null;
          if (refDoc && refNewBal !== null) {
            io.to(`tg_${doc.referredBy}`).emit('gramBalanceUpdate', { balance: refNewBal });
            io.to(`tg_${doc.referredBy}`).emit('refBonusReceived', {
              bonus,
              fromUsername: doc.username,
              newBalance: refNewBal,
            });
            logPlayer(doc.referredBy, refDoc.username, 'gram_ref_bonus',
              { bonus, from: doc.username, newBalance: refNewBal });
          }
        }
      }
    }
  }

  await tx.save();
  io.to(`tg_${tx.telegramId}`).emit('gramTxUpdate', { id: tx._id.toString(), status: tx.status });
  logPlayer(tx.telegramId, tx.username, 'gram_' + tx.type + '_' + tx.status, {
    amount: tx.amount,
    ...(_logBal === null ? {} : { newBalance: _logBal }),
    tx: tx._id.toString(),
  });

  const label = confirmed ? '✅ Подтверждено' : '❌ Отклонено';
  await tgApi('editMessageReplyMarkup', {
    chat_id: cq.message.chat.id,
    message_id: cq.message.message_id,
    reply_markup: { inline_keyboard: [[{ text: label, callback_data: 'done' }]] },
  });
}

function _txData(tx) {
  return {
    id: tx._id.toString(),
    type: tx.type,
    amount: tx.amount,
    address: tx.address || '',
    memo: tx.memo || '',
    status: tx.status,
    createdAt: tx.createdAt,
  };
}

// Shared by the classic bot "/start ref_X" chat flow (_handleBotMessage) and
// the Mini App "?startapp=ref_X" direct-launch flow (loginTelegramWebApp) —
// registers telegramId as referred by refId the first time either path sees
// it (whichever fires first wins; the other is a no-op since referredBy is
// already set by then). Returns the referrer's username for notifications/
// welcome text, or null if no (new) referral was registered.
async function _registerReferral(telegramId, username, refId, playerDoc) {
  if (!refId || refId === telegramId || playerDoc.referredBy) return null;
  playerDoc.referredBy = refId;
  await playerDoc.save();
  const referrer = await PlayerModel.findOne({ telegramId: refId }, 'username telegramId').lean();
  io.to(`tg_${refId}`).emit('friendJoined', { username });
  await tgApi('sendMessage', {
    chat_id: refId,
    text: [
      '🎉 <b>Друг принял приглашение!</b>',
      `👤 @${_tgEsc(username)} только что зашёл в игру по вашей ссылке.`,
      '',
      '💡 Когда друг пополняет GRAM — вы получаете <b>5% бонус</b>.',
    ].join('\n'),
    parse_mode: 'HTML',
  }).catch(() => {});
  return referrer?.username || null;
}

// Fires at most once per account, ever. Claiming the adminNotified flag is
// what enforces that, rather than each caller trying to work out whether it is
// the first to see this player — they can't reliably tell. The bot's organic
// "/start" only LOOKS a player up (it deliberately doesn't create the record,
// so isNewAccount below still does its job on first launch), which meant
// isNewPlayer stayed true there forever: every extra /start sent another
// message, and the normal "/start, then tap Играть" flow sent one from the bot
// and a second from auth once the account was actually created.
//
// The claim is a single-document update, so it also settles the two-tabs /
// reconnect race between concurrent auths, and it survives restarts.
// Consequence worth knowing: someone who only presses /start and never opens
// the game has no account row yet and so isn't announced — the message now
// arrives when they first actually launch the game.
async function _notifyAdminNewPlayer(username, telegramId, referrerUsername) {
  if (!TG_ADMIN_ID) return;
  const claimed = await PlayerModel.findOneAndUpdate(
    { telegramId, adminNotified: { $ne: true } },
    { $set: { adminNotified: true } },
  ).catch(() => null);
  if (!claimed) return;
  const refLine = referrerUsername
    ? `\n👥 Пригласил: @${_tgEsc(referrerUsername)}`
    : '\n👥 Источник: органика';
  await tgApi('sendMessage', {
    chat_id: TG_ADMIN_ID,
    text: [
      '🆕 <b>Новый игрок</b>',
      `👤 @${_tgEsc(username)} (<code>${_tgEsc(telegramId)}</code>)${refLine}`,
    ].join('\n'),
    parse_mode: 'HTML',
  }).catch(() => {});
}

async function _handleBotMessage(msg) {
  const text = msg?.text || '';
  const fromId = String(msg?.from?.id || '');
  if (!text.startsWith('/start') || !fromId) return;

  const parts = text.trim().split(' ');
  const param = parts[1] || '';
  const firstName = msg.from.first_name || '';
  const username = _safeUsername(msg.from.username || firstName, fromId);

  let isNewPlayer = false;
  let referrerUsername = null;

  // /start ref_TELEGRAMID — register referral immediately on first bot interaction
  if (param.startsWith('ref_')) {
    let player = await PlayerModel.findOne({ telegramId: fromId });
    if (!player) {
      isNewPlayer = true;
      player = await PlayerModel.create({ telegramId: fromId, username });
    }
    referrerUsername = await _registerReferral(fromId, username, param.slice(4), player);
  } else {
    // Organic /start — check if new player
    const existing = await PlayerModel.findOne({ telegramId: fromId });
    if (!existing) isNewPlayer = true;
  }

  // Notify admin about new players
  if (isNewPlayer) {
    _notifyAdminNewPlayer(username, fromId, referrerUsername).catch(() => {});
  }

  // Send welcome message with game button
  const gameUrl = process.env.GAME_URL || '';
  const button = gameUrl
    ? { text: '🎮 Играть сейчас', web_app: { url: gameUrl } }
    : { text: '🎮 Открыть игру', url: `https://t.me/${_tgBotUsername || 'game'}` };
  const channelButton = { text: '📢 Канал', url: 'https://t.me/Libertymmo' };
  const chatButton    = { text: '💬 Чат', url: 'https://t.me/+PrFI0HWtRi02NGU0' };

  // Escaped even though this one goes back to the player themselves: an
  // unbalanced tag makes Telegram reject the whole send with a 400, so the
  // welcome message (and its Играть button) would silently never arrive.
  const greeting = firstName ? `👋 Привет, <b>${_tgEsc(firstName)}</b>!` : '👋 Добро пожаловать!';
  const refText  = referrerUsername
    ? `\n🎁 Вас пригласил @${_tgEsc(referrerUsername)} — играйте вместе и зарабатывайте бонусы!`
    : '';

  // Loading-screen preview — sent as its own message just ahead of the
  // welcome text, for both organic /start and a /start ref_ referral link
  // (both reach this same shared send path, so one call covers either).
  // sendPhoto needs a real public HTTPS URL to fetch the image from; without
  // GAME_URL there's nothing here that serves it publicly, so it's skipped
  // rather than sent broken.
  if (gameUrl) {
    await tgApi('sendPhoto', {
      chat_id: fromId,
      photo: `${gameUrl.replace(/\/$/, '')}/images/splash-liberty.jpg`,
    }).catch(() => {});
  }

  await tgApi('sendMessage', {
    chat_id: fromId,
    parse_mode: 'HTML',
    text: [
      greeting,
      '',
      '⚔️ <b>Liberty</b> — мобильная MMORPG прямо в Telegram.',
      '',
      '🗡 Исследуй подземелья и уничтожай врагов',
      '🏆 Соревнуйся в рейтинге игроков',
      '🛡 Вступай в кланы и ходи в рейды',
      '💎 Улучшай снаряжение и прокачивай персонажа',
      refText,
      '',
      '▶️ Нажми кнопку ниже, чтобы начать!',
    ].filter(l => l !== null).join('\n'),
    reply_markup: { inline_keyboard: [[button], [channelButton, chatButton]] },
  }).catch(() => {});
}

function _refLink(telegramId) {
  const bot = _tgBotUsername || process.env.TG_BOT_USERNAME || '';
  if (!bot) return '';
  // Classic bot deep link — opens the bot's own chat first (by design; see
  // _handleBotMessage), not the Mini App directly. Telegram always requires
  // a manual "Запустить бота" tap before the resulting /start ref_<id>
  // message is actually sent — that's a platform-level anti-spam rule for
  // ANY bot, not something any code here can skip. loginTelegramWebApp also
  // reads start_param if the game is ever opened via a startapp link
  // instead, so nothing breaks if that path is used somewhere too.
  return `https://t.me/${bot}?start=ref_${telegramId}`;
}

// Telegram gives us `username` (a @handle, restricted to [A-Za-z0-9_]) only
// for accounts that actually set one; everyone else falls back to first_name,
// which is arbitrary user-chosen text. That string is then stored, shown to
// other players (rating, market, profiles), written into the binary gameState
// packet and embedded in the admin's Telegram notifications — so it is
// normalised once, here, at the only place it enters the system.
//   • angle brackets/quotes/ampersand dropped: the client escapes on output
//     too, but a name that can't carry markup in the first place means one
//     forgotten escape somewhere later isn't an XSS.
//   • control characters dropped — they render as nothing and are a classic
//     way to spoof someone else's name.
//   • capped at 32 characters AND 200 UTF-8 bytes: _ncWStr (shared/netcodec.js)
//     writes each string with a single-byte length prefix, so a 256-byte name
//     (64 emoji, which Telegram allows) would wrap that byte and desync the
//     packet for every client that can see this player.



// Without a token there is no bot to ask, so the call can only ever 404 —
// skipping it keeps a tokenless run (local dev) off the network entirely.
if (!_tgBotUsername && _TG_TOKEN) {
  fetch(`https://api.telegram.org/bot${_TG_TOKEN}/getMe`)
    .then(r => r.json())
    .then(d => { if (d.ok) { _tgBotUsername = d.result.username; console.log('TG bot:', _tgBotUsername); } })
    .catch(err => console.error('Could not fetch TG bot username:', err));
}

const ROOT = path.join(__dirname, '..');
const BUNDLE_FILES = require('./bundle-files').map(f => path.join(ROOT, f));

const jsBundleRaw = BUNDLE_FILES.map(f => fs.readFileSync(f, 'utf8')).join('\n;\n');

// ── Minification ────────────────────────────────────────────────────────────
// Run here, at startup, beside the concatenation and the gzip — this project
// deliberately has no build step to forget, and adding one to save 167 KB
// would have been a poor trade. Costs about two seconds of boot.
//
// toplevel is off for BOTH compress and mangle, and that is not a default to
// rely on quietly. The client is 24 files in one script scope and half its
// entry points are named from strings the minifier cannot see: onclick
// attributes in index.html, and onclick handlers built inside JS template
// literals. Rename a top-level function and every one of those breaks with no
// warning at all. Same reason compress must not drop a "unused" top-level
// binding: its only reader may be a string.
//
// Falls back to the readable bundle if terser is missing or throws. A server
// that will not boot because a size optimisation failed is a far worse outcome
// than a server that serves 167 KB more.
const MINIFY = process.env.MINIFY !== '0';
const _minified = (() => {
  if (!MINIFY) return null;
  try {
    const { minify_sync } = require('terser');
    const out = minify_sync(jsBundleRaw, {
      compress: { toplevel: false },
      mangle:   { toplevel: false },
      format:   { comments: false },
      sourceMap: { url: 'BUNDLE_MAP_URL' },   // patched below, once the hash is known
    });
    if (!out || !out.code) throw new Error('terser returned nothing');
    return out;
  } catch (err) {
    console.error('[bundle] minification skipped —', err.message);
    return null;
  }
})();

const jsBundle = _minified ? _minified.code : jsBundleRaw;
const jsBundleHash = crypto.createHash('sha1').update(jsBundle).digest('hex').slice(0, 12);
const jsBundleEtag = `"${jsBundleHash}"`;
// The hash goes in the URL, which is what lets the file be cached forever:
// /bundle.js could only ever be `no-cache`, because the name stayed the same
// while the content changed, so the browser had to ask on every single launch
// before it could run a line. A content-addressed name changes when the
// content does, so a stale copy is unreachable rather than merely unlikely.
const JS_BUNDLE_PATH = `/bundle.${jsBundleHash}.js`;
const JS_MAP_PATH = `${JS_BUNDLE_PATH}.map`;
// The source map is what keeps a production stack trace readable — without it
// every error reports one line and a five-digit column. Browsers fetch it only
// when devtools is open, so it costs a player nothing.
const jsBundleMap = _minified ? _minified.map : null;
const jsBundleCode = _minified
  ? jsBundle.replace('BUNDLE_MAP_URL', JS_MAP_PATH)
  : jsBundle;

// The stylesheet gets the same treatment for the same reason — it was the
// third round trip a launch had to make before anything could be drawn.
const cssBundle = fs.readFileSync(path.join(ROOT, 'css', 'style.css'));
const cssHash = crypto.createHash('sha1').update(cssBundle).digest('hex').slice(0, 12);
const CSS_PATH = `/css/style.${cssHash}.css`;

// index.html, rewritten once at startup to point at both hashed paths.
//
// Built here rather than substituted per request, and verified: a page that
// names a bundle nobody serves is a blank screen for everyone, so if either
// marker is missing this keeps the original markup — which still works,
// because the un-hashed routes are still answered — and says so loudly rather
// than shipping a broken page quietly.
const INDEX_HTML = (() => {
  const raw = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  let out = raw;
  const swaps = [['/bundle.js', JS_BUNDLE_PATH], ['css/style.css', CSS_PATH.slice(1)]];
  for (const [from, to] of swaps) {
    if (!out.includes(from)) {
      console.error(`[bundle] index.html has no "${from}" to rewrite — serving it unchanged, ` +
        'so the un-hashed routes stay in use and caching is not improved.');
      return raw;
    }
    out = out.split(from).join(to);
  }
  return out;
})();
// Compressed once, here, instead of by the compression() middleware on every
// request. The bundle is ~1.07MB of text (301KB gzipped) and never changes
// while the process lives, so re-deflating it per client was pure repeated
// work — ~30-50ms of CPU each, and after a redeploy every player online comes
// back for it at the same time.
const jsBundleGz = zlib.gzipSync(jsBundleCode, { level: 9 });

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket'],
  // A silent link (Wi-Fi to LTE handover, a sleeping radio, a suspended
  // WebView) does not close the TCP connection — it just stops delivering, so
  // the heartbeat is the only thing that notices. At 30s/90s the protocol let
  // that state persist for pingInterval + pingTimeout = two minutes, during
  // which the player watched a frozen world without the client even trying to
  // reconnect, and the server kept a ghost in the room for monsters and PvP to
  // hit. 15s/25s brings the worst case to ~40s; js/network.js's own 2s
  // round-trip watchdog usually catches it within 8s, and this is the backstop
  // for the reverse direction (the server noticing a client that is gone).
  pingTimeout: 25000,
  pingInterval: 15000,
  maxHttpBufferSize: 512 * 1024,  // 512 KB max per socket message
});
// Counts the game stream by event name — see the [egress] report below.
egress.attachSockets(io);

// Cross-process fan-out. Everything in this file addresses other players
// through io.to(...).emit(...), and socket.io routes those through its adapter
// — so pointing the adapter at Redis is genuinely all it takes for one process
// to reach a socket connected to another. Left unset it uses the in-memory
// adapter and nothing changes.
//
// This is NOT on its own enough to run a second process: the world lives in
// this process's memory (floorRooms, activeSessions, parties, the arena/race
// queues, the balance caches), and none of that is fan-out. See SCALING.md for
// what has to move first. The hook is here so that when it does, the messaging
// half is already done.
if (process.env.REDIS_URL) {
  let createAdapter, createClient;
  try {
    ({ createAdapter } = require('@socket.io/redis-adapter'));
    ({ createClient } = require('redis'));
  } catch (err) {
    // Explicit rather than a bare MODULE_NOT_FOUND at boot: REDIS_URL being set
    // means somebody intended clustering, and silently continuing single-process
    // would be the wrong kind of quiet.
    console.error('REDIS_URL is set but the adapter packages are missing — ' +
      'run: npm i @socket.io/redis-adapter redis');
    throw err;
  }
  const pub = createClient({ url: process.env.REDIS_URL });
  const sub = pub.duplicate();
  Promise.all([pub.connect(), sub.connect()])
    .then(() => { io.adapter(createAdapter(pub, sub)); console.log('socket.io: redis adapter attached'); })
    .catch(err => { console.error('socket.io: redis adapter failed:', err.message); process.exit(1); });
}

mongoose.connect(process.env.MONGODB_URI, {
  // 10 connections shared by every DB-touching op this process makes —
  // logins, saves, every market/craft/clan-storage handler's awaited
  // read+write, and logPlayer's write on "most kills" (its own comment,
  // fires from _rollMobLoot's item grants) — is a tight ceiling once more
  // than a handful of players are doing any of that at once. Past it,
  // operations queue for a free connection instead of running, which is
  // exactly what a player-facing "завис на секунду" during a busy moment
  // (market buy, a clan storage claim, a save landing) looks like from the
  // inside — nothing crashes, everything just waits its turn. Raised well
  // under any real MongoDB plan's own connection ceiling (even constrained
  // free/shared tiers allow 100+); if this instance's plan caps lower than
  // that, match this number to it rather than the driver ceiling.
  maxPoolSize: 50,
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
})
  .then(() => {
    console.log('MongoDB connected');
    // Repopulate the in-memory global chat from the DB. Runs after connect
    // (not at listen time) because the server starts accepting connections
    // before Mongo is necessarily up — anyone who logs in before this
    // resolves just gets the empty history they'd have got pre-persistence,
    // and the very next login sees the restored one.
    _loadChatHistory();
  })
  .catch(err => console.error('MongoDB connect error:', err));

// Behind Railway's reverse proxy — needed so req.ip reflects the real client
// (used by the admin-login brute-force limiter below), not the proxy hop.
app.set('trust proxy', 1);

// Content-Security-Policy was previously disabled entirely. It's re-enabled
// here as defence-in-depth on top of the existing output escaping. Two
// unavoidable relaxations for this app:
//   • 'unsafe-inline' — index.html has inline <script> blocks and 100+ inline
//     on* handlers.
//   • 'unsafe-eval' + worker-src blob: — PixiJS generates its uniform-sync
//     functions via `new Function` and spins up blob-URL Web Workers; without
//     these the WebGL renderer fails to initialise and the game world renders
//     black. (This is what a first cut of the policy broke.)
// CSP still blocks loading executable script from any origin other than the
// ones whitelisted here and keeps object-src/base-uri locked down via helmet's
// defaults.
//
// frame-ancestors: this app is a Telegram Mini App — on Telegram Web/Desktop
// it's loaded inside a cross-origin <iframe> served from web.telegram.org (not
// a same-origin embed). Helmet's default frame-ancestors 'self' (and the
// matching X-Frame-Options: SAMEORIGIN it used to ship with unchanged) blocks
// that outright with ERR_BLOCKED_BY_RESPONSE — some players hit this, others
// don't, because it only affects the iframe-based Web/Desktop clients, not the
// native mobile app's own WebView. frameguard is disabled below because
// X-Frame-Options can only express a single origin (or none) and would either
// still block Telegram or have to be dropped anyway — frame-ancestors is what
// actually enforces the allow-list in every browser that matters here.
app.use(helmet({
  frameguard: false,
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      scriptSrc:     ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://telegram.org', 'https://cdn.socket.io'],
      scriptSrcAttr: ["'unsafe-inline'"],
      workerSrc:     ["'self'", 'blob:'],
      childSrc:      ["'self'", 'blob:'],
      styleSrc:      ["'self'", "'unsafe-inline'"],
      styleSrcAttr:  ["'unsafe-inline'"],
      // 'https:' (not a fixed domain list) for img/connect: TON Connect talks
      // to whichever bridge server the player's chosen wallet registers (a
      // different https host per wallet, an open/growing set — Tonkeeper,
      // MyTonWallet, etc. — not something this app can enumerate), and pulls
      // each wallet's icon from that wallet's own https host too.
      imgSrc:        ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc:    ["'self'", 'https://cdn.socket.io', 'wss:', 'ws:', 'https:'],
      fontSrc:       ["'self'", 'data:'],
      // The Telegram Login Widget (js/network.js _showTelegramLoginWidget,
      // used by the standalone Android app) embeds its confirm UI in an
      // iframe from oauth.telegram.org — frame-src falls back to child-src
      // otherwise, which only allows 'self'/blob: and would silently block it.
      frameSrc:      ["'self'", 'https://oauth.telegram.org', 'https://telegram.org'],
      frameAncestors: ["'self'", 'https://web.telegram.org', 'https://*.web.telegram.org', 'https://telegram.org', 'https://*.telegram.org'],
    },
  },
}));
// BEFORE compression(), and that order is the whole trick: compression()
// replaces res.write/res.end with its own and calls through to whatever was
// there when it ran — which is this hook. So this counts compressed output,
// i.e. bytes on the wire, which is what the bill counts. Registered after it,
// it would count the uncompressed body and overstate JS/HTML ~3x.
app.use(egress.httpMiddleware);
app.use(compression());
app.use(express.json({ limit: '256kb' }));

// Sends `text` to every registered account over the bot. Paced at 30 messages
// a second because Telegram throttles bulk sends and starts dropping (or
// 429-ing) past roughly that rate.
//
// Lives here rather than with the /admin/broadcast route that is its loudest
// caller: _announceOnce below uses it for event announcements too, so it is a
// Telegram helper that the admin panel borrows, not an admin route's private
// worker.
async function tgBroadcastAll(text) {
  const players = await PlayerModel.find({}, 'telegramId').lean();
  let sent = 0;
  for (let i = 0; i < players.length; i++) {
    tgApi('sendMessage', { chat_id: players[i].telegramId, text, parse_mode: 'HTML' }).catch(() => {});
    sent++;
    if (i % 30 === 29) await new Promise(r => setTimeout(r, 1000));
  }
  return sent;
}

// ── Player event log ─────────────────────────────────────────────────────────
// Every economy-touching action lands here so a "where did my item go" report
// can be answered from the admin panel instead of guesswork. The old comment
// here claimed the collection was capped and TTL'd — neither was true, nothing
// ever deleted a row, so it grew without bound. It is now really trimmed.
const LOG_KEEP_PER_PLAYER = 100;
// Trimming on every write would double the cost of logging for no benefit —
// the admin only ever reads the newest LOG_KEEP_PER_PLAYER anyway, so a little
// overshoot between trims is harmless.
const LOG_TRIM_EVERY = 25;
const _logWritesSinceTrim = new Map(); // telegramId -> writes since last trim

// Season point movements are trimmed on their own, much longer, budget.
// Sharing the 100-row window with everything else made them effectively
// invisible: `inv:mob_loot` fires on most kills, so a quest award from a
// 5000-kill grind was pushed out of the log within minutes of earning it —
// which is exactly why "очки не начислились" reports could not be checked.
// These are the rows that decide who takes a prize, so they outlive the rest.
const LOG_SEASON_EVENTS = [
  'season_points', 'season_points_failed',
  'season_quest_done', 'season_quest_award_failed',
  'admin_season_points',
];
const LOG_KEEP_SEASON_PER_PLAYER = 1000;

async function logPlayer(telegramId, username, event, meta) {
  if (!telegramId) return;
  try {
    await PlayerLogModel.create({ telegramId, username, event, meta });
    const n = (_logWritesSinceTrim.get(telegramId) || 0) + 1;
    if (n < LOG_TRIM_EVERY) { _logWritesSinceTrim.set(telegramId, n); return; }
    _logWritesSinceTrim.set(telegramId, 0);
    // Two independent windows, so a flood of ordinary rows can never evict a
    // season one (and vice versa).
    const [stale, staleSeason] = await Promise.all([
      PlayerLogModel.find({ telegramId, event: { $nin: LOG_SEASON_EVENTS } }, '_id')
        .sort({ at: -1 }).skip(LOG_KEEP_PER_PLAYER).lean(),
      PlayerLogModel.find({ telegramId, event: { $in: LOG_SEASON_EVENTS } }, '_id')
        .sort({ at: -1 }).skip(LOG_KEEP_SEASON_PER_PLAYER).lean(),
    ]);
    const doomed = [...stale, ...staleSeason].map(d => d._id);
    if (doomed.length) await PlayerLogModel.deleteMany({ _id: { $in: doomed } });
  } catch {}
}

// Same log, for failures. Recorded under a single 'error' event so the panel
// can colour them and an admin can spot them without reading every row —
// these are exactly the entries that explain a lost item or a refused grant.
function logPlayerErr(telegramId, username, where, err, meta) {
  logPlayer(telegramId, username, 'error', {
    where,
    message: err && err.message ? err.message : String(err || ''),
    ...(meta || {}),
  });
}

// ── PvP history (profile → История tab) ──────────────────────────────────────
// Its own small collection, own trim — see server/models/PvpHistory.js for
// why this doesn't just piggyback on the log above.
const PVP_HISTORY_KEEP = 50;
const PVP_HISTORY_TRIM_EVERY = 10;
const _pvpHistoryWritesSinceTrim = new Map();
async function _recordPvpHistory(telegramId, kind, mode, opponent) {
  if (!telegramId) return;
  try {
    await PvpHistoryModel.create({ telegramId, kind, mode, opponent: opponent || null });
    const n = (_pvpHistoryWritesSinceTrim.get(telegramId) || 0) + 1;
    if (n < PVP_HISTORY_TRIM_EVERY) { _pvpHistoryWritesSinceTrim.set(telegramId, n); return; }
    _pvpHistoryWritesSinceTrim.set(telegramId, 0);
    const stale = await PvpHistoryModel.find({ telegramId }, '_id')
      .sort({ at: -1 }).skip(PVP_HISTORY_KEEP).lean();
    if (stale.length) await PvpHistoryModel.deleteMany({ _id: { $in: stale.map(d => d._id) } });
  } catch {}
}


// ── Admin REST API, part one ─────────────────────────────────────────────────
// The five route groups that used to live here — the rate limiter and login,
// the dashboard counters and searches, one player's card and ban, handing back
// a spent attempt, and granting currency — are in server/admin/ now, along with
// the adminAuth middleware itself. Registered with the rest, further down.

// ── Admin REST API, part two ─────────────────────────────────────────────────
// The nine route groups that used to live here are in server/admin/ now, one
// file each. They are REGISTERED further down, not here: several of them need
// handles on the event machines, and those are created by the requires in the
// Death Battle / Арена / Башня sections below — a `const` binding is in the
// temporal dead zone until then, so building the dependency objects at this
// point would throw. Express does not care about the order as long as nothing
// between here and there claims /admin/*, and nothing does.

// ── Special Quests (public — game client) ─────────────────────────────────────
app.get('/api/special-quests', async (req, res) => {
  try {
    const quests = await SpecialQuestModel.find({ active: true }).sort({ createdAt: -1 }).lean();
    res.json({ quests });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Health ───────────────────────────────────────────────────────────────────
// LIVENESS, not readiness: 200 whenever this process is up and its event loop
// is still turning, whatever Mongo happens to be doing this second.
//
// It used to answer 503 the moment mongoose.connection.readyState left 1, and
// this instance runs behind a platform whose health check restarts the
// container on a failing probe (see app.set('trust proxy') below). So a few
// seconds of Atlas failover — a blip the game itself rides out fine, since the
// simulation is in memory and the driver queues and retries — got the whole
// process killed and restarted, disconnecting every player at once. On the
// client that reads as the world breaking: js/network.js's 'disconnect'
// handler wipes serverEnemies/otherPlayers and the Pixi pools, and the world
// is rebuilt from the reconnect's gameStart. A restart cannot fix a database
// that is unreachable, and it costs every session in flight, so a DB blip must
// not be able to trigger one.
//
// The DB state is still reported, just not as an HTTP failure: `ok`/`db` say
// exactly what they always did, and /health/ready below is the endpoint that
// does answer 503 — point a *dashboard* alert at that one, never a restarting
// health check.
app.get('/health', (req, res) => {
  const dbOk = mongoose.connection.readyState === 1; // 1 = connected
  // Room tick timings alongside the DB state. "Иногда тупит" reports were
  // previously unanswerable because nothing recorded whether the 25ms world
  // loop was actually making its budget; tickOverruns/tickMsMax say so
  // directly. Reading resets the window, so each poll describes the interval
  // since the last one (see Room.stats).
  // The liveness answer itself is public — an uptime monitor has to be able to
  // read it without credentials. The operational detail below it (memory,
  // socket count, tick timings) is only added for an authenticated admin: it
  // says nothing an attacker needs, but it does say precisely when the server
  // is already struggling.
  const brief = { ok: dbOk, db: mongoose.connection.readyState };
  if (!_verifyAdminToken((req.headers.authorization || '').replace('Bearer ', ''))) {
    return res.json(brief);
  }
  const rooms = [];
  // Every floor EXCEPT Fear/Coop reports its one shared Room directly.
  // Their own floorRooms entries are permanently empty placeholders — they
  // exist only so /api/world-map/<id> has bytes to serve — while the runs
  // themselves happen on private Rooms deliberately kept out of that map
  // (see _createFearRoom/_createCoopRoom). Reporting the placeholder is what
  // made this endpoint answer "no rooms with players" while N people were
  // mid-run in Страх, each on their own 40Hz loop: the load being asked
  // about was the only load not shown.
  floorRooms.forEach(r => {
    if (r.floor === FLOOR_IDS.fear || r.floor === FLOOR_IDS.coop) return;
    try { rooms.push(r.stats()); } catch {}
  });
  // One aggregate row per private-instance event instead of N nearly
  // identical ones. Always present, so the floor never silently disappears
  // from the table; instances is 0 when nobody is in there.
  const _aggregateRoomStats = (floorId, liveRooms) => {
    // stats() RESETS its window, so it is read exactly once per room here —
    // calling it twice would hand the second reader a freshly zeroed window.
    const statsList = liveRooms.map(r => { try { return r.stats(); } catch { return {}; } });
    return {
      floor: floorId,
      instances: liveRooms.length,
      players: statsList.reduce((n, s) => n + (s.players || 0), 0),
      enemies: statsList.reduce((n, s) => n + (s.enemies || 0), 0),
      // Worst instance, not the sum: these are parallel loops, so the
      // question "is any run missing its budget" is what a max answers and
      // a total does not.
      tickMsMax: statsList.reduce((n, s) => Math.max(n, s.tickMsMax || 0), 0),
      tickOverruns: statsList.reduce((n, s) => n + (s.tickOverruns || 0), 0),
    };
  };
  rooms.push(_aggregateRoomStats(FLOOR_IDS.fear, _liveFearRooms()));
  rooms.push(_aggregateRoomStats(FLOOR_IDS.coop, _liveCoopRooms()));
  const mem = process.memoryUsage();
  res.json({
    ...brief,
    sockets: io.engine.clientsCount,
    uptimeS: Math.round(process.uptime()),
    heapMb: Math.round(mem.heapUsed / 1048576),
    rssMb: Math.round(mem.rss / 1048576),
    rooms,
    // Why sessions have been ending since this process started — the direct
    // answer to "почему мир перезагружается". See _sessionStats.
    sessions: _sessionStatsSnapshot(),
    // Where the outbound bytes went since this process started — the direct
    // answer to "почему такой счёт за трафик". Cumulative, so two polls a
    // known time apart give a rate; the [egress] log line does that for you
    // every SESSION_REPORT_MS. See server/egress.js.
    egress: egress.snapshot(),
  });
});

// READINESS: "can this process serve a login right now", which /health
// deliberately no longer answers with a status code (see above). 503 here
// means Mongo is unreachable — logins, saves and every DB-backed handler will
// fail until it comes back, while the world itself keeps simulating.
//
// Point dashboards, pager alerts and load-balancer *traffic* decisions at this
// one. Do NOT point a health check that RESTARTS the container at it: killing
// the process cannot reach a database it cannot reach either, and it drops
// every player mid-session to achieve nothing. That misconfiguration is what
// this split exists to make hard to repeat.
app.get('/health/ready', (req, res) => {
  const dbOk = mongoose.connection.readyState === 1;
  res.status(dbOk ? 200 : 503).json({ ok: dbOk, db: mongoose.connection.readyState });
});

// ── World map ────────────────────────────────────────────────────────────────
// The map used to ride inside gameStart: ~132KB (52KB packed grid + ~79KB of
// room JSON) serialized per join. A join is not rare — every socket.io
// reconnect re-runs selectChar, so a phone switching between Wi-Fi and LTE
// paid for the whole map each time, and a redeploy made every client online
// do it within the same second (measured: 150 simultaneous joins stretched a
// 25ms tick to 125ms and pushed p99 latency from 26ms to 146ms).
//
// It is the same bytes for everyone and, because the world generator runs off
// a fixed seed, the same bytes across restarts too. So: serve it once, name it
// by content hash, and let the browser cache do the rest. gameStart now
// carries only mapVersion; the client fetches this URL and, after the first
// time, never asks again.
app.get('/api/world-map/:floor/:ver', (req, res) => {
  const room = floorRooms.get(Number(req.params.floor));
  if (!room) return res.status(503).json({ error: 'not ready' });
  // The version lives in the URL and the response is immutable, so a request
  // naming a different version must not be answered with these bytes — that
  // would poison the cache under the wrong key. It can only happen to a
  // client still running pre-deploy JS, which recovers via the socket
  // fallback below.
  if (req.params.ver !== room.mapVersion) return res.status(404).json({ error: 'stale version' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('ETag', `"${room.mapVersion}"`);
  res.send(room.mapPayload);
});

// Images: cache 30 days — sprites never change between deploys
app.use('/images', express.static(path.join(__dirname, '..', 'images'), { maxAge: '30d', immutable: true }));
// Audio: same treatment — background music/sfx assets don't change between deploys.
app.use('/audio', express.static(path.join(__dirname, '..', 'audio'), { maxAge: '30d', immutable: true }));

// Vendored PixiJS (~456 KB) never changes between deploys, but the catch-all
// static handler below serves it with no explicit caching, so mobile clients
// re-validate the whole file on every load (a wasted round trip and, on a cold
// cache, a full re-download). Serve it immutable with a 1-year TTL so the
// browser skips the request entirely once it's cached.
app.get('/js/pixi.min.js', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(path.join(ROOT, 'js', 'pixi.min.js'));
});

// Vendored TON Connect UI SDK (~445 KB) — same immutable-caching treatment as
// pixi.min.js above, for the same reason (never changes between deploys).
app.get('/js/vendor/tonconnect-ui.min.js', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(path.join(ROOT, 'js', 'vendor', 'tonconnect-ui.min.js'));
});
// The min.js above ends in a //# sourceMappingURL= comment pointing here —
// only fetched by a browser devtools panel, but serve it to avoid a 404.
app.get('/js/vendor/tonconnect-ui.min.js.map', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(path.join(ROOT, 'js', 'vendor', 'tonconnect-ui.min.js.map'));
});

// Single JS bundle, served at a content-addressed path. /bundle.js stays
// answerable for a page that was cached before this change (and for anything
// else pointing at the old name), on the old revalidate-every-time policy.
app.get([JS_BUNDLE_PATH, '/bundle.js'], (req, res) => {
  if (req.headers['if-none-match'] === jsBundleEtag) return res.status(304).end();
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('ETag', jsBundleEtag);
  // Only the hashed path may be cached: the URL is the version, so a change
  // cannot be missed. The legacy name must keep asking.
  res.setHeader('Cache-Control', req.path === JS_BUNDLE_PATH
    ? 'public, max-age=31536000, immutable' : 'no-cache');
  // Setting Content-Encoding ourselves is also what makes compression() skip
  // this response instead of compressing it a second time.
  res.setHeader('Vary', 'Accept-Encoding');
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    res.setHeader('Content-Encoding', 'gzip');
    return res.send(jsBundleGz);
  }
  res.send(jsBundleCode);
});

// HTML/CSS: no cache so updates are picked up immediately.
//
// Served from an ALLOWLIST, not from the repository root. Mounting the root
// published every file in the project: server/index.js and server/security.js
// in full, the models, the audit documents — and /.git, from which the entire
// history (and anything ever committed to it) can be reconstructed. Nothing
// about the game needed any of that; it was the default that came with
// pointing express.static at '..'.
//
// Everything the client actually asks for either has its own route above
// (/bundle.js, /images, /audio, the pixi and tonconnect vendor files) or is
// named here. A file that is not on this list is not public.
const PUBLIC_FILES = {
  '/':                        'index.html',
  '/index.html':              'index.html',
  '/guide.html':              'guide.html',
  '/admin.html':              'admin.html',
  '/tonconnect-manifest.json':'tonconnect-manifest.json',
};
app.get(Object.keys(PUBLIC_FILES), (req, res) => {
  // index.html is the one page that must never be cached: it is what carries
  // the hashed names of everything else, so it is how a deploy is noticed.
  if (PUBLIC_FILES[req.path] === 'index.html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    return res.send(INDEX_HTML);
  }
  res.sendFile(path.join(ROOT, PUBLIC_FILES[req.path] || 'index.html'), err => {
    if (err) res.status(404).end();
  });
});
// The source map, at a hashed path of its own so it is as cacheable as the
// bundle. Nothing requests it unless devtools is open.
app.get(JS_MAP_PATH, (req, res) => {
  if (!jsBundleMap) return res.status(404).end();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(jsBundleMap);
});

// The hashed stylesheet — cacheable forever for the same reason the bundle is.
app.get(CSS_PATH, (req, res) => {
  res.setHeader('Content-Type', 'text/css; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(cssBundle);
});
// The un-hashed path stays answerable for anything still pointing at it
// (guide.html, admin.html, a cached page from before this change).
app.use('/css', express.static(path.join(ROOT, 'css')));

app.get('/tg-botname', (req, res) => {
  if (_tgBotUsername) return res.json({ username: _tgBotUsername });
  // Retry fetch once in case startup request is still in-flight
  fetch(`https://api.telegram.org/bot${_TG_TOKEN}/getMe`)
    .then(r => r.json())
    .then(d => {
      if (d.ok) { _tgBotUsername = d.result.username; res.json({ username: _tgBotUsername }); }
      else res.status(503).json({ error: 'bot not resolved' });
    })
    .catch(() => res.status(503).json({ error: 'bot not resolved' }));
});

// ── Local development login ───────────────────────────────────────────────────
// Only ever mounted by dev/local.js (which sets DEV_LOCAL=1 alongside a
// throwaway MONGODB_URI and its own dummy TG_BOT_TOKEN) — in every normal
// deployment this route does not exist at all.
//
// The game authenticates with Telegram Mini App initData, which a desktop
// browser opened outside Telegram simply doesn't have, so there is nothing to
// log in with locally. Rather than add a bypass to the login handler, this
// signs a real initData with the same HMAC Telegram uses (verifyTelegramWebApp
// above validates it like any other): the local browser then goes through the
// unmodified loginTelegramWebApp path. With the dev token that signature is
// worthless anywhere else — a production server, holding the real bot token,
// rejects it.
if (process.env.DEV_LOCAL === '1' && process.env.NODE_ENV !== 'production') {
  console.log('DEV_LOCAL: /dev/init-data enabled (local browser login)');
  app.get('/dev/init-data', async (req, res) => {
    const username = String(req.query.dev || 'dev').slice(0, 32).replace(/[^\w-]/g, '') || 'dev';
    // Reuse the seeded account's id when the name matches one, so
    // /?dev=hero always lands on the same character; anything else gets a
    // stable id derived from the name, i.e. a new account on first use that
    // is still the same account on every later run.
    const doc = await PlayerModel.findOne({ username }, 'telegramId').lean().catch(() => null);
    const telegramId = doc
      ? doc.telegramId
      : '9' + parseInt(crypto.createHash('sha1').update(username).digest('hex').slice(0, 10), 16)
          .toString().slice(0, 9);
    const user = { id: Number(telegramId), username, first_name: username };
    const params = new URLSearchParams({
      user: JSON.stringify(user),
      auth_date: String(Math.floor(Date.now() / 1000)),
      query_id: 'DEV',
    });
    const checkStr = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(_TG_TOKEN).digest();
    params.set('hash', crypto.createHmac('sha256', secret).update(checkStr).digest('hex'));
    res.json({ initData: params.toString(), user });
  });

  // Opens the Кровавая Башня registration window on the spot, with a short
  // registration period, so the event can actually be played through locally
  // instead of only at 20:30 Moscow time. Same gate as the login helper above:
  // this route does not exist in a normal deployment.
  app.post('/dev/race10/open', (req, res) => {
    const regMs = Math.max(1000, Math.min(Number(req.query.reg) || 5000, 300000));
    _race10OpenWindow(Date.now(), regMs);
    res.json({ ok: true, regMs, startsAt: _race10.startAt });
  });

  // The live boss's enemy id, so a test client can hit the thing the payout
  // rule is written against. A real client learns this from the enemy stream
  // it decodes; the harness speaks the protocol but does not render, so it
  // has no other way to name the boss.
  app.get('/dev/race10/state', (req, res) => {
    res.json({
      live: _race10.live, bossId: _race10.bossId,
      dmg: Object.fromEntries(_race10.dmg), alive: _race10.alive.size,
    });
  });

  // The registration queue in order. The order is the queue — _race10Start
  // takes the first `capacity` — so it is the thing a fairness test has to be
  // able to read.
  app.get('/dev/race10/queue', (req, res) => {
    res.json({ names: [..._race10.queue.values()].map(v => v.name), size: _race10.queue.size });
  });

  // Ends the current race the way its own clock would, awarding the win to
  // whoever has dealt the most damage — the same _race10Finish path a real
  // ending takes, just without waiting out RACE10_MAX_MS.
  app.post('/dev/race10/finish', (req, res) => {
    if (!_race10.live) return res.status(409).json({ error: 'no race running' });
    let winnerId = null, best = 0;
    _race10.dmg.forEach((d, sid) => { if (d > best) { best = d; winnerId = sid; } });
    _race10Finish(winnerId, true);
    res.json({ ok: true, winnerId, best });
  });

  // Same idea, for Death Battle (Битва на смерть): opens registration on the
  // spot with a short window instead of waiting for the next scheduled slot,
  // so the deploy/eliminate/finish flow (arena floor join, return-to-
  // previous-floor) can actually be exercised locally/in the harness.
  app.post('/dev/deathbattle/open', (req, res) => {
    const regMs = Math.max(500, Math.min(Number(req.query.reg) || 2000, 300000));
    _dbOpenReg(Date.now() + regMs);
    res.json({ ok: true, regMs, startAt: _db.startAt });
  });

  // Same idea, for the 3v3 arena: opens registration on the spot instead of
  // waiting for the 21:00 MSK window. Unlike the other two there is no
  // separate "start" timer to short-circuit — arena3Register already tries
  // a deploy itself the moment enough people are queued (_a3TryStartSafe),
  // so this alone is enough to exercise the flow locally/in the harness.
  app.post('/dev/arena3/open', (req, res) => {
    _a3OpenWindow(Date.now());
    res.json({ ok: true });
  });
}

// One permanent Room per location (see server/game/floors.js's
// FLOOR_REGISTRY) — pre-created at startup, never destroyed. Players move
// between them via a real floor transition (see enterLocation below)
// instead of the old single-shared-grid world this replaced.
const floorRooms = new Map();




// Retired item ids → their replacement. An id that leaves the catalog takes
// every copy of that item with it: _canonSavedItem returns null for an unknown
// id, the sanitizer filters those out, and since a save that SHRINKS is
// legitimate by design (_censusOverflow only looks for growth) the loss is
// accepted silently on both sides. That is a live hazard for any future
// rename or merge of a catalog entry, so renames belong here rather than in a
// migration script: one line keeps every existing copy alive.
// Empty today — nothing has been renamed yet.
const _ITEM_ID_ALIASES = Object.create(null);




// Picks the next season quest's species within a band, never repeating the
// one just finished — back-to-back identical quests read like the reward
// simply did not register.
function _seasonRollSpecies(prevSp, playerLvl, tierId) {
  const lvl = Math.max(1, Math.floor(Number(playerLvl)) || 1);
  const list = seasonTier(tierId).species;
  // Only species the player can actually reach. The 20+ band lives in the top
  // corridor, which is gated at level 20 — handing a level-12 player "kill
  // 5000 zombies" would leave them unable to progress the season at all,
  // since they cannot walk into the corridor those live in.
  const reachable = list.filter(s => (s.req || 0) <= lvl);
  const base = reachable.length ? reachable : list.filter(s => !(s.req || 0));
  if (!base.length) return list[0].sp;
  const pool = base.filter(s => s.sp !== prevSp);
  const from = pool.length ? pool : base;
  return from[Math.floor(Math.random() * from.length)].sp;
}

// Which band a player is allowed to select. The 20+ one needs the level that
// opens the corridor its monsters live in; everything else is always open.
function _seasonTierAllowed(tierId, playerLvl) {
  const t = seasonTier(tierId);
  return (Math.floor(Number(playerLvl)) || 1) >= (t.reqLvl || 0);
}

// Adds season points to ANY account by telegramId, online or not. The
// per-socket _seasonAddPoints below is the same write for the player holding
// the socket; this one exists because the referral bonus is paid to someone
// else, who is usually not the one who triggered it.
async function _seasonAddPointsTo(telegramId, n, reason, meta) {
  if (!telegramId || !Number.isFinite(n) || n <= 0 || !seasonActive()) return null;
  try {
    const doc = await PlayerModel.findOneAndUpdate(
      { telegramId: String(telegramId) },
      { $inc: { 'savedData.seasonPoints': n } },
      { new: true, projection: { 'savedData.seasonPoints': 1, username: 1 } },
    ).lean();
    if (!doc) return null;
    const total = Math.max(0, Math.floor(Number(doc?.savedData?.seasonPoints) || 0));
    logPlayer(telegramId, doc.username, 'season_points', { add: n, total, reason, ...(meta || {}) });
    return total;
  } catch (err) { console.error('_seasonAddPointsTo:', err); return null; }
}









// Escape user input before embedding it in a Mongo $regex, so a crafted query
// can't inject regex operators (ReDoS / catastrophic backtracking on the DB).
function _escapeRegex(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Chat "translate" button (js/network.js netTranslateChat) — Google
// Translate's public web endpoint, same one translate.google.com's own page
// calls (client=gtx). No API key/account needed, but it's an undocumented
// endpoint, not the billed Cloud Translation API — Google is free to
// rate-limit or change its shape without notice. sl=auto lets it detect the
// source language instead of us guessing it from arbitrary chat text.
async function _translateText(text, targetLang) {
  const url = 'https://translate.googleapis.com/translate_a/single'
    + '?client=gtx&sl=auto&tl=' + encodeURIComponent(targetLang) + '&dt=t&q=' + encodeURIComponent(text);
  const res = await fetch(url);
  if (!res.ok) throw new Error('translate http ' + res.status);
  const data = await res.json();
  // Response shape: [[[translatedChunk, originalChunk, null, null, ...], ...], null, sourceLang]
  const chunks = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : [];
  return chunks.map(c => c[0]).join('');
}


// Progress writer. The two real-money balances are structurally excluded here
// rather than merely omitted by every caller: this function takes a whole blob
// (`{..._lastStats}`, the sanitized client save), and one future field slipping
// into that blob would silently turn a periodic progress save back into an
// absolute balance write — which is the entire bug the $inc migration removed.
// Balances move only through _incBalance/_spendBalance.
const _BALANCE_FIELDS = ['gramBalance', 'nexumBalance'];
function _persistSavedFields(authed, fields, extra) {
  if (!authed) return;
  const set = {};
  Object.keys(fields).forEach(k => {
    if (fields[k] === undefined || _BALANCE_FIELDS.includes(k)) return;
    set[`savedData.${k}`] = fields[k];
  });
  if (extra) Object.keys(extra).forEach(k => { set[k] = extra[k]; });
  // Returns the write promise so callers that need the persist to actually
  // land before proceeding (see socket.data._flushNow above) can await it;
  // existing fire-and-forget call sites are unaffected since they don't.
  return PlayerModel.findByIdAndUpdate(authed._id, { $set: set }).catch(() => {});
}

// Last-resort delivery: append items straight to the stored inventory when
// there is no live session to hand them to (a market purchase whose buyer
// reconnected and then vanished, a death-battle prize, VIP rewards). Never
// refuses — dropping an item the player has already paid for is the one
// outcome worse than an oversized inventory.
//
// But an oversized inventory is not harmless either, and nothing used to say
// when it happened: past SERVER_INV_MAX the client's own invHasSpace() is
// false forever, so world drops stop being picked up and every market
// cancellation starts failing its room check. So the push still goes through
// and the overflow is recorded, loudly, with the reason that caused it —
// which is what makes such an account findable and trimmable instead of
// quietly broken.
async function _dbPushInventory(authed, items, reason) {
  const list = (Array.isArray(items) ? items : [items]).filter(Boolean);
  if (!authed || !list.length) return false;
  try {
    const doc = await PlayerModel.findByIdAndUpdate(
      authed._id,
      { $push: { 'savedData.inventory': { $each: list } } },
      { new: true, projection: { 'savedData.inventory': 1 } },
    ).lean();
    const len = Array.isArray(doc?.savedData?.inventory) ? doc.savedData.inventory.length : null;
    if (len !== null && len > SERVER_INV_MAX) {
      logPlayer(authed.telegramId, authed.username, 'inv_over_cap',
        { reason, slots: len, cap: SERVER_INV_MAX, added: list.length });
      console.error(`[${reason}] telegramId=${authed.telegramId}: inventory is now ${len} slots, over the ` +
        `${SERVER_INV_MAX} cap — drops and market returns will fail for this account until it is trimmed.`);
    }
    return true;
  } catch (err) {
    console.error('_dbPushInventory:', err);
    return false;
  }
}


// ── Rating tables ────────────────────────────────────────────────────────────
// Both tabs of the rating panel, built at most once every RATING_TTL_MS for
// the whole process instead of once per request.
//
// getRating is a heavy-bucket event, which still allows 40 calls per 5s per
// socket — 8 rebuilds a second from one client, and the clans tab in
// particular is not a small query: it reads EVERY clan document and then a bm
// document for EVERY member of every clan, unbounded, and sorts the result in
// JS. That ran against the same connection pool every progress save shares, so
// a few players idly flipping between the tabs could starve saves and logins
// while nothing looked wrong anywhere. A leaderboard does not need to be
// fresher than a minute; anyone's own live rank is still computed per request
// (see getRating), so the one number a player watches is never stale.
//
// In flight requests share a single promise, so N callers arriving during a
// rebuild queue behind it instead of each starting their own.
const RATING_TTL_MS = 60000;
const _ratingCache = { players: { at: 0, rows: [], p: null }, clans: { at: 0, rows: [], p: null } };
function _cachedRating(key, build) {
  const slot = _ratingCache[key];
  if (slot.p) return slot.p;
  if (Date.now() - slot.at < RATING_TTL_MS) return Promise.resolve(slot.rows);
  slot.p = build()
    .then(rows => { slot.rows = rows; slot.at = Date.now(); return rows; })
    // Keep serving the last good table on a failed rebuild rather than
    // blanking the panel, and let the next caller retry immediately.
    .catch(err => { console.error('rating rebuild:', err); return slot.rows; })
    .finally(() => { slot.p = null; });
  return slot.p;
}

function _ratingPlayers() {
  return _cachedRating('players', async () => {
    // 'savedData.lvl', not 'savedData': the whole blob carries the player's
    // inventory, equipment and every counter — tens of KB each, fetched and
    // BSON-decoded 50 at a time purely to read one number off it.
    const players = await PlayerModel.find({}, 'username bm savedData.lvl savedData.level')
      .sort({ bm: -1 }).limit(50).lean();
    return players.map(p => ({
      username: p.username,
      bm: p.bm || 0,
      level: p.savedData?.lvl || p.savedData?.level || 1,
    }));
  });
}

// Capped as well as cached. Ranking by summed member BM means every clan has
// to be read to rank any of them, so the cap is on the WIDEST reasonable
// candidate set rather than on the answer: the top RATING_CLAN_SCAN clans by
// level/xp (the clan collection's own existing sort key) are the only ones
// that could plausibly hold a top-50 total, and it bounds the second query's
// $in list at the same time.
const RATING_CLAN_SCAN = 300;
function _ratingClans() {
  return _cachedRating('clans', async () => {
    const clans = await ClanModel.find({}, 'name icon members')
      .sort({ level: -1, xp: -1 }).limit(RATING_CLAN_SCAN).lean();
    // One query for every clan's members instead of one aggregate per clan
    // in a loop: at a few dozen clans the old shape queued thousands of
    // aggregations against the same connection pool everyone's saves share.
    const memberIds = [...new Set(clans.flatMap(c => (c.members || []).map(m => m.telegramId)))];
    const bmDocs = memberIds.length
      ? await PlayerModel.find({ telegramId: { $in: memberIds } }, 'telegramId bm').lean()
      : [];
    const bmByTid = new Map(bmDocs.map(d => [d.telegramId, d.bm || 0]));
    const rows = [];
    for (const clan of clans) {
      if (!clan.members?.length) continue;
      rows.push({
        name: clan.name,
        icon: clan.icon,
        memberCount: clan.members.length,
        totalBm: clan.members.reduce((s, m) => s + (bmByTid.get(m.telegramId) || 0), 0),
      });
    }
    rows.sort((a, b) => b.totalBm - a.totalBm);
    return rows.slice(0, 50);
  });
}

// ── Rating leader ─────────────────────────────────────────────────────────────
// Whoever currently sits at #1 in the players rating gets a visible aura in the
// world (js/pixi-world.js). Sorted by bm, the same order getRating uses, so the
// glowing character is always the one at the top of the table players can open
// for themselves. Clients are told a username and nothing else — exactly the
// identity that rating table already shows everyone.
//
// Polled rather than recomputed on every bm change: bm moves on each
// saveProgress (every few seconds, per player), while the leader changes rarely.
// The query rides the existing { bm: -1 } index and reads a single document.
let _topPlayerUsername = null;
const TOP_PLAYER_POLL_MS = 60000;
async function _refreshTopPlayer() {
  try {
    const top = await PlayerModel.findOne({}, 'username').sort({ bm: -1 }).lean();
    const name = top?.username || null;
    if (name === _topPlayerUsername) return;
    _topPlayerUsername = name;
    io.emit('topPlayer', { username: name });
  } catch (err) { console.error('_refreshTopPlayer:', err); }
}

// ── VIP aura roster ───────────────────────────────────────────────────────────
// Usernames of currently-online players at VIP_AURA_MIN_LEVEL or above, so
// every client can draw their aura. Broadcast as a plain username list — the
// same shape/pattern as _topPlayerUsername above — rather than adding a field
// to the per-player gameState entries, because those go through the binary
// codec (shared/netcodec.js) and VIP level changes at most once per purchase;
// paying for it in every world packet, forever, would be absurd.
const VIP_AURA_MIN_LEVEL = 2;
const _vipAuraUsers = new Set();

function _broadcastVipAuras() {
  io.emit('vipAuras', { usernames: [..._vipAuraUsers] });
}

// Called whenever an account's online/VIP state changes (login, logout, a
// GRAM purchase that levels them up). No-ops unless the roster really
// changed, so a login storm doesn't turn into a broadcast storm.
function _setVipAura(username, vipLevel) {
  if (!username) return;
  const should = (vipLevel || 0) >= VIP_AURA_MIN_LEVEL;
  const had = _vipAuraUsers.has(username);
  if (should === had) return;
  if (should) _vipAuraUsers.add(username);
  else _vipAuraUsers.delete(username);
  _broadcastVipAuras();
}

// Global chat history — last CHAT_HISTORY_MAX messages across all floors.
// Unlike clan chat and DMs below, this one is DB-backed (models/ChatMessage):
// the in-memory array stays the hot path every read goes through, and Mongo
// is only touched to write new messages and to repopulate the array at
// startup, so a restart/redeploy no longer wipes the chat everyone sees.
const CHAT_HISTORY_MAX = 50;
const globalChatHistory = [];
// Trimming on every single message would double the write load for no
// benefit — the array is already capped in memory, and the only cost of the
// collection running slightly long is a few extra stored rows.
let _chatWritesSinceTrim = 0;
const CHAT_TRIM_EVERY = 20;

// What clients receive. Strips the Mongo _id carried on entries loaded from
// (or written to) the DB, so the wire shape stays exactly the {username,
// text, time} the client has always parsed and no internal ids leak out.
function _publicChatHistory() {
  return globalChatHistory.map(({ username, text, time }) => ({ username, text, time }));
}

async function _loadChatHistory() {
  try {
    const docs = await ChatMessageModel.find({}, 'username text time')
      .sort({ createdAt: -1 }).limit(CHAT_HISTORY_MAX).lean();
    // Query is newest-first for the limit; the array is oldest-first.
    globalChatHistory.length = 0;
    docs.reverse().forEach(d => globalChatHistory.push({ username: d.username, text: d.text, time: d.time }));
    console.log(`Chat history restored: ${globalChatHistory.length} message(s)`);
  } catch (err) {
    // A failed load must not stop the server coming up — chat simply starts
    // empty for this boot, exactly as it always did before persistence.
    console.error('_loadChatHistory:', err);
  }
}

async function _trimChatHistory() {
  // Deletes exactly the rows past the newest CHAT_HISTORY_MAX, by id. Doing
  // it as a range delete on _id instead would rely on ObjectId ordering
  // matching createdAt ordering — which only holds within one process, since
  // the per-process counter resets on restart.
  const stale = await ChatMessageModel.find({}, '_id')
    .sort({ createdAt: -1 }).skip(CHAT_HISTORY_MAX).lean();
  if (stale.length) {
    await ChatMessageModel.deleteMany({ _id: { $in: stale.map(d => d._id) } });
  }
}

function _recordChat(username, text) {
  const now = new Date();
  const time = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
  const entry = { username, text, time };
  globalChatHistory.push(entry);
  if (globalChatHistory.length > CHAT_HISTORY_MAX) globalChatHistory.shift();
  // Fire-and-forget: chat must never block on (or be lost to) a slow DB.
  ChatMessageModel.create({ username, text, time, createdAt: now })
    .then(doc => {
      // Lets the admin panel's delete-by-index remove the row too, not just
      // the in-memory copy that the next restart would resurrect.
      entry._id = doc._id;
      if (++_chatWritesSinceTrim >= CHAT_TRIM_EVERY) {
        _chatWritesSinceTrim = 0;
        return _trimChatHistory();
      }
    })
    .catch(err => console.error('_recordChat persist:', err));
}

// Clan chat history — last 30 per clan, keyed by clan _id (string). Same
// ephemeral in-memory model as globalChatHistory above (resets on restart,
// no DB persistence) — kept consistent with the rest of this chat system.
// Nothing ever removed a clan's entry here, including when the clan itself
// was disbanded (see the ClanModel.deleteOne in clanLeave/clanDisband), so
// this grew by one row per distinct clan ID ever created for the life of the
// process — the same shape of leak dmHistory below already had fixed. Evict
// the least recently written clan once there are too many, same mechanism.
const clanChatHistory = new Map(); // clanId string -> [{username, text, time}]
const CLAN_CHAT_MAX_CLANS = 2000;
function _recordClanChat(clanId, username, text) {
  const key = String(clanId);
  const now = new Date();
  const time = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
  const arr = clanChatHistory.get(key) || [];
  arr.push({ username, text, time });
  if (arr.length > 30) arr.shift();
  // Re-inserting moves this key to the end of the Map's iteration order, same
  // LRU trick dmHistory uses below.
  clanChatHistory.delete(key);
  clanChatHistory.set(key, arr);
  while (clanChatHistory.size > CLAN_CHAT_MAX_CLANS) {
    clanChatHistory.delete(clanChatHistory.keys().next().value);
  }
}

// Private messages — last 50 per conversation, keyed by the two participants'
// telegramIds sorted into a stable pair key. Also in-memory only, same model
// as above; resolving a conversation by username (not telegramId) works
// whether or not the other party is currently online — only realtime
// *delivery* requires them to be connected (see the privMsg handler).
const dmHistory = new Map(); // "tidA|tidB" -> [{username, text, time}]
// Each conversation holds up to 50 messages and nothing ever removed a
// conversation, so this grew for the life of the process — every pair of
// players who ever exchanged one message, forever. Evict the least recently
// written conversation once there are too many; the history is best-effort
// in-memory state that a restart clears anyway (unlike global chat, which is
// DB-backed).
const DM_MAX_CONVERSATIONS = 2000;
function _dmKey(a, b) { return [String(a), String(b)].sort().join('|'); }
function _recordDm(tidA, tidB, username, text) {
  const key = _dmKey(tidA, tidB);
  const now = new Date();
  const time = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
  const arr = dmHistory.get(key) || [];
  arr.push({ username, text, time });
  if (arr.length > 50) arr.shift();
  // Re-inserting moves this key to the end of the Map's iteration order, which
  // is what makes the eviction below least-recently-used rather than arbitrary.
  dmHistory.delete(key);
  dmHistory.set(key, arr);
  while (dmHistory.size > DM_MAX_CONVERSATIONS) {
    dmHistory.delete(dmHistory.keys().next().value);
  }
}
// Resolves a @nickname to the canonical account, whether or not they're
// currently online (DB lookup, case-insensitive exact match — Telegram
// handles are treated as case-insensitive everywhere else in this app).
// Plain equality + .collation() rather than a case-insensitive regex: Mongo
// can serve this off Player.js's strength:2 collation index on `username`,
// where the regex form was a full collection scan on every call — see the
// comment on that index.
async function _resolveUsername(name) {
  const target = String(name || '').trim().replace(/^@/, '');
  if (!target) return null;
  return PlayerModel.findOne({ username: target }, 'telegramId username')
    .collation({ locale: 'en', strength: 2 }).lean();
}

// ── Party state ───────────────────────────────────────────────────────────────
// partyId -> Map<socketId, username>  (up to 5 members)
const parties     = new Map();
// socketId -> partyId
const playerParty = new Map();
// socketId -> current floor number (for proximity check)
const playerFloorMap = new Map();
// socketId -> Date.now() ms when an in-progress teleport-stone cast
// completes (useTeleportStone, below). Module-level rather than a
// per-connection closure var so _pvpFrozen (which every movement/attack
// handler already gates on) can see it — see _teleportCastFrozen.
const _teleportCasting = new Map();

// Looks up a player's own record on whichever floor they're actually on
// right now, without the caller having to know which Room that is —
// registration for a scheduled event (death battle, …) doesn't require
// being on any particular floor, so deploy-time code that only used to check
// the hub's own Room (back when every reachable zone lived inside it) needs
// this instead.
function _findPlayerAnyFloor(sid) {
  const floor = playerFloorMap.get(sid);
  if (floor == null) return null;
  const room = getRoom(floor);
  return room ? room.players.get(sid) || null : null;
}

// Sends a match/round participant back to the hub for real — the shared exit
// path for 3v3 and Кровавая Башня (an elimination, the round ending under
// everyone still standing). Unlike the death battle's own _dbReturnEntrant,
// neither of those cares where the entrant actually came from: registering
// never required being on any particular floor, but Room.deathBattleReturn
// always sent them to the hub specifically, and this preserves that exactly
// — it's just a real floor change now instead of a position reset within a
// Room they were never really in. socket.data._forceEnterLocation is what
// makes the move even though this may be running from module-level
// scheduling code with no socket of its own.
function _returnToHub(socketId) {
  const sock = io.sockets.sockets.get(socketId);
  if (!sock?.data?._forceEnterLocation?.('hub')) return null;
  const room = getRoom(FLOOR_IDS.hub);
  const p = room ? room.players.get(socketId) : null;
  return p ? { x: p.x, y: p.y } : null;
}

// Arena 3v3 and the Кровавая Башня allow DAILY_DUNGEON_ATTEMPTS runs per UTC
// day — each gets its own savedData field (see the wrapper functions below)
// so their attempt pools are independent. The attempt is consumed on entry,
// not on a successful clear, so dying/failing doesn't refund it. Written
// straight to Mongo by telegramId so it works regardless of which member's
// socket triggered it.
const DAILY_DUNGEON_ATTEMPTS = 3;
function _todayStr() { return new Date().toISOString().slice(0, 10); }

// Consuming an attempt is ONE update, expressed as an aggregation pipeline so
// the "is the stored record still today's?" decision happens inside the same
// atomic document write as the increment. The previous read-then-$set version
// lost increments whenever two runs started in the same window — a party's
// members all trigger this at once — which handed out more runs per day than
// the limit allows. A pair of conditional updates would still leak one attempt
// in the narrow case of two simultaneous runs being the first of the day.
function _lockDailyAttempt(socketId, field) {
  const s = io.sockets.sockets.get(socketId);
  const tid = s?.data?.telegramId;
  if (tid == null) return;
  const today = _todayStr();
  const path = `savedData.${field}`;
  PlayerModel.updateOne({ telegramId: tid }, [{
    $set: {
      [path]: {
        $cond: [
          { $eq: [`$${path}.date`, today] },
          { date: today, count: { $add: [{ $ifNull: [`$${path}.count`, 0] }, 1] } },
          { date: today, count: 1 },
        ],
      },
    },
  }]).catch(() => {});
}

// An admin-forced Tower open (/admin/race10/open) grants everyone a bonus
// daily attempt on top of RACE10_ATTEMPTS for the day it opens on, so an
// account that already spent today's regular one isn't locked out of this
// extra race. Cumulative across more than one admin open the same day;
// rolls back to 0 the moment the UTC date changes, same boundary
// _dailyAttemptsLeft's own per-player records reset on (_todayStr).
let _race10BonusDate = null;
let _race10BonusCount = 0;
function _race10BonusReset() {
  const today = _todayStr();
  if (_race10BonusDate !== today) { _race10BonusDate = today; _race10BonusCount = 0; }
}

// Grants one bonus attempt for today and answers the running total. The admin
// panel used to do this by hand — reset, then ++, then read the variable — which
// only worked for as long as it shared this file's scope. A verb crosses a
// module boundary; a `let` does not.
function _race10GrantBonusAttempt() {
  _race10BonusReset();
  _race10BonusCount++;
  return _race10BonusCount;
}

// How many runs a day each event allows. They share one helper but not one
// pool — the Кровавая Башня has a single start per day now, so a single
// attempt is what makes that start the whole of the opportunity (plus
// whatever _race10BonusCount an admin has granted today).
//
// Read inside the function rather than from a table built up here:
// RACE10_ATTEMPTS/FEAR_ATTEMPTS are declared further down the file, and a
// `const` table evaluated at load time would hit their temporal dead zone
// and take the whole process down on boot.
function _attemptCap(field) {
  if (field === 'race10Attempts') { _race10BonusReset(); return RACE10_ATTEMPTS + _race10BonusCount; }
  if (field === 'fearAttempts') return FEAR_ATTEMPTS;
  if (field === 'coopAttempts') return COOP_ATTEMPTS;
  return DAILY_DUNGEON_ATTEMPTS;
}

async function _dailyAttemptsLeft(socketId, field) {
  const s = io.sockets.sockets.get(socketId);
  const tid = s?.data?.telegramId;
  const cap = _attemptCap(field);
  if (tid == null) return cap;
  try {
    const doc = await PlayerModel.findOne({ telegramId: tid }).select(`savedData.${field}`).lean();
    const rec = doc?.savedData?.[field];
    if (!rec || rec.date !== _todayStr()) return cap;
    return Math.max(0, cap - rec.count);
  } catch (_) { return cap; }
}

function _lockArena3Daily(socketId)                  { _lockDailyAttempt(socketId, 'arena3Attempts'); }
async function _arena3AttemptsLeft(socketId)         { return _dailyAttemptsLeft(socketId, 'arena3Attempts'); }
function _lockRace10Daily(socketId)                  { _lockDailyAttempt(socketId, 'race10Attempts'); }
async function _race10AttemptsLeft(socketId)         { return _dailyAttemptsLeft(socketId, 'race10Attempts'); }
function _lockFearDaily(socketId)                    { _lockDailyAttempt(socketId, 'fearAttempts'); }
async function _fearAttemptsLeft(socketId)           { return _dailyAttemptsLeft(socketId, 'fearAttempts'); }
function _lockCoopDaily(socketId)                    { _lockDailyAttempt(socketId, 'coopAttempts'); }
async function _coopAttemptsLeft(socketId)           { return _dailyAttemptsLeft(socketId, 'coopAttempts'); }

// Элитная фарм-зона's daily cap is minutes actually spent inside, not a
// count of runs — same "$cond on the stored date" atomic-pipeline shape as
// _lockDailyAttempt above, just $add-ing whole minutes instead of +1, and
// read back against FARM2_DAILY_MINUTES instead of a fixed per-field cap.
// Only ever called with small positive integers (the per-minute ticker in
// server/index.js's farm2GroupStart, and the entry-time budget read below),
// so there is no need for _attemptCap's field-keyed dispatch.
function _lockDailyMinutes(socketId, field, minutes) {
  const s = io.sockets.sockets.get(socketId);
  const tid = s?.data?.telegramId;
  if (tid == null || !(minutes > 0)) return;
  const today = _todayStr();
  const path = `savedData.${field}`;
  PlayerModel.updateOne({ telegramId: tid }, [{
    $set: {
      [path]: {
        $cond: [
          { $eq: [`$${path}.date`, today] },
          { date: today, minutes: { $add: [{ $ifNull: [`$${path}.minutes`, 0] }, minutes] } },
          { date: today, minutes },
        ],
      },
    },
  }]).catch(() => {});
}
async function _dailyMinutesLeft(socketId, field, cap) {
  const s = io.sockets.sockets.get(socketId);
  const tid = s?.data?.telegramId;
  if (tid == null) return cap;
  try {
    const doc = await PlayerModel.findOne({ telegramId: tid }).select(`savedData.${field}`).lean();
    const rec = doc?.savedData?.[field];
    if (!rec || rec.date !== _todayStr()) return cap;
    return Math.max(0, cap - rec.minutes);
  } catch (_) { return cap; }
}
function _lockFarm2Minutes(socketId, minutes)        { _lockDailyMinutes(socketId, 'farm2Minutes', minutes); }
async function _farm2MinutesLeft(socketId)           { return _dailyMinutesLeft(socketId, 'farm2Minutes', FARM2_DAILY_MINUTES); }

// Remove leaverId from their party; notify remaining members.
// If only 1 member remains the party dissolves entirely.
function _removeFromParty(partyId, leaverId) {
  const members = parties.get(partyId);
  if (!members) return;

  // Сотрудничество's party is exactly the two participants (formed by
  // coopGroupStart once the leader launches the run) — there's no way to
  // keep going once it breaks, so losing it ends the run for both the same
  // way a death does. Covers an explicit partyLeave from either side; a
  // disconnect already ends the run immediately on its own
  // (_coopEjectOnDisconnect), well before this could ever be reached
  // through the party's own disconnect-grace timeout.
  _coopEliminate(leaverId);
  // Элитная фарм-зона: same idea, generalized from exactly-2 to "fewer than
  // FARM2_PARTY_SIZE of the run's original participants are still in" — see
  // _farm2Eliminate's own comment. A no-op for anyone not currently on a run.
  _farm2Eliminate(leaverId);

  const leaverName = members.get(leaverId) || leaverId.slice(0, 6);
  members.delete(leaverId);
  playerParty.delete(leaverId);

  const remaining = [];
  members.forEach((name, id) => remaining.push({ id, name }));

  if (remaining.length <= 1) {
    // Party fully dissolves. partyLeft alone used to leave the last member's
    // own partyMembers array (js/network.js) never cleared — its handler
    // explicitly defers clearing to a partyUpdated that, in this branch, was
    // never sent — so their party HUD (drawPartyHUD, js/ui.js) kept showing
    // the departed member's HP bar indefinitely. Sending an empty
    // partyUpdated alongside partyLeft here matches the >1-member branch
    // below and actually clears it.
    parties.delete(partyId);
    remaining.forEach(m => {
      playerParty.delete(m.id);
      io.to(m.id).emit('partyLeft', { leftName: leaverName });
      io.to(m.id).emit('partyUpdated', { members: [] });
    });
  } else {
    // Party shrinks; send notification then updated list to each remaining member
    remaining.forEach(m => {
      io.to(m.id).emit('partyLeft', { leftName: leaverName });
      const othersForM = remaining.filter(r => r.id !== m.id);
      io.to(m.id).emit('partyUpdated', { members: othersForM });
    });
  }
}

// How long a disconnected member's party slot is held before they're actually
// dropped — same reasoning/window as Fear's own reconnect grace
// (FEAR_RECONNECT_GRACE_MS): an ordinary network blip's reconnect (transport
// re-handshake, then loginTelegramWebApp's own DB round trip) routinely eats
// several seconds beyond the client's 8s silence watchdog before it even
// starts, so anything shorter drops the member for real before a perfectly
// ordinary reconnect can land. Kept as its own constant (not shared with
// Fear's) since the two systems have nothing to do with each other.
const PARTY_RECONNECT_GRACE_MS = 45000;
// telegramId -> { partyId, socketId, timer } — a party slot held across a
// disconnect. `socketId` is the now-dead socket still sitting in `parties`/
// `playerParty`; reclaimed onto the reconnecting socket in the login flow
// below (mirrors _fearDisconnectGrace/_fearGraceClaim) or, if the timer
// fires first, actually removed via _removeFromParty.
const _partyDisconnectGrace = new Map();
// Called from the 'disconnect' handler instead of an immediate
// _removeFromParty — holds the slot open rather than dissolving the party
// (or evicting the member) over what may just be a brief drop. Falls back to
// removing immediately when there's no telegramId to reconnect-match against
// (shouldn't happen for an authed session, but leaves nothing orphaned if it
// somehow does).
function _partyHoldOnDisconnect(socketId, telegramId) {
  const partyId = playerParty.get(socketId);
  if (!partyId) return;
  if (!telegramId) { _removeFromParty(partyId, socketId); return; }
  const prior = _partyDisconnectGrace.get(telegramId);
  if (prior) clearTimeout(prior.timer);
  const timer = safeTimeout('partyGrace', () => {
    _partyDisconnectGrace.delete(telegramId);
    _removeFromParty(partyId, socketId);
  }, PARTY_RECONNECT_GRACE_MS);
  _partyDisconnectGrace.set(telegramId, { partyId, socketId, timer });
}

function getRoom(floor) {
  return floorRooms.get(floor) || floorRooms.get(FLOOR_IDS.hub);
}

// Builds the gameStart-shaped payload for a socket that just joined (first
// login/reconnect) or transitioned to (enterLocation) a floor's Room — one
// shared builder so both paths send an identical shape, and so the client's
// _applyGameStart (js/network.js) never has to special-case which one it
// came from.
function _buildGameStartPayload(socket, room, floor) {
  const _selfP = room.players.get(socket.id);
  return {
    floor,
    // The map itself is fetched over HTTP and cached by the browser — see
    // /api/world-map above. Only its name (and now its floor) travels here.
    mapVersion: room.mapVersion,
    spawn: _selfP ? { x: _selfP.x, y: _selfP.y } : undefined,
    enemies: room.enemySnapshot(socket.id),
    bossStatus: room.getBossStatus(),
    // So someone logging in mid-countdown still sees the timer, and someone
    // arriving after the kill still sees loot already lying on the floor.
    // These four event systems are still tied to the hub floor for now (see
    // server/game/floors.js) — reported unconditionally since a socket on
    // any floor may still be registered/mid-run in one of them.
    eventBoss: eventBossState(),
    deathBattle: { ..._dbPublicState(), registered: _db.reg.has(socket.id) },
    race10: { ..._race10PublicState(), registered: _race10.queue.has(socket.id) },
    arena3: { ..._a3PublicState(), registered: _a3.queue.has(socket.id) },
    guildWar: _gwPublicState(),
    // Unlike the three above, Fear has no scheduled window/queue to report
    // when nothing's running — only present at all when a run is live for
    // this socket.
    fear: _fear.has(socket.id) ? { inRun: true, wave: _fear.get(socket.id).wave, maxWave: FEAR_MAX_WAVE } : null,
    // Same "only present when a run is live" shape as Fear above — stage
    // comes from the shared Room (both lanes are always on the same one),
    // not the run record itself.
    coop: (() => {
      const run = _coop.get(socket.id);
      if (!run || !run.room) return null;
      return { inRun: true, stage: run.room.coopStage(), maxStage: COOP_STAGE_LEVELS.length };
    })(),
    // Same "only present when a run is live" shape as Fear/Coop above — a
    // reconnect mid-run needs this to resume the client's own "in the zone"
    // UI state (see js/network.js's _applyGameStart).
    farm2: _farm2.has(socket.id) ? { inRun: true } : null,
  };
}

// ── Event announcements over the bot ────────────────────────────────────────
// Both scheduled events warn everyone EVENT_NOTIFY_BEFORE_MS ahead and again
// the moment they start. Fire-and-forget: a bot that is down or a player who
// blocked it must never hold up (or break) the event itself, so nothing here
// is awaited and every failure is swallowed by tgBroadcastAll's per-message
// catch.
const _EVENT_TEXT = {
  boss: {
    soon: (m) => `⚔️ <b>Мировой босс</b>\n\nПоявится через ${m} мин. — в 20:00 по Москве.\nДобыча падает на пол для всех: кто успел, тот забрал.`,
    now:  () => '⚔️ <b>Мировой босс появился!</b>\n\nОн уже в безопасной зоне. Заходи в игру — добычу заберут без тебя.',
  },
  battle: {
    soon: (m) => `🗡 <b>Битва на смерть</b>\n\nНачало через ${m} мин.\nПоследний выживший забирает GRAM и снаряжение.`,
    now:  () => '🗡 <b>Битва на смерть</b>\n\nРегистрация открыта — заходи и записывайся, бой начнётся через 5 минут.\nПосле старта присоединиться уже нельзя.',
  },
  race10: {
    soon: (m) => `🏃 <b>Кровавая Башня</b>\n\nОкно регистрации откроется через ${m} мин. — в 20:30 по Москве, всего на 5 минут.\nПобеждает тот, кто нанесёт общему боссу больше всего урона.`,
    now:  () => '🏃 <b>Кровавая Башня открыта!</b>\n\nЗаписывайся в игре — старт через 5 минут со всеми, кто успел.',
  },
  a3: {
    soon: (m) => `⚔️ <b>Арена 3х3</b>\n\nОкно регистрации откроется через ${m} мин. — с 21:00 до 22:00 по Москве.`,
    now:  () => '⚔️ <b>Арена 3х3 открыта!</b>\n\nЗаписывайся в игре — как наберётся 6 человек, старт. Окно открыто до 22:00 по Москве.',
  },
  guildWar: {
    soon: (m) => `🏰 <b>Война гильдий</b>\n\nЛокация с замком откроется через ${m} мин. — с 22:00 до 22:15 по Москве.\nКлан, который захватит замок, будет получать осколки каждый час, пока держит его.`,
    now:  () => '🏰 <b>Война гильдий открыта!</b>\n\nЗаходи в игру — локация с замком доступна до 22:15 по Москве.',
  },
};

// Each occurrence is announced at most once per process. _dbSchedule and
// _wbSchedule are both re-entrant (boot, end of a round, a cancelled round),
// so without this a single event could be announced several times over.
const _notifiedEvents = new Set();
function _announceOnce(key, text, where) {
  if (_notifiedEvents.has(key)) return;
  _notifiedEvents.add(key);
  // The set only ever holds a handful of keys per process, but a long-lived
  // one shouldn't grow forever either.
  if (_notifiedEvents.size > 64) {
    _notifiedEvents.delete(_notifiedEvents.values().next().value);
  }
  tgBroadcastAll(text).catch(err => console.error(where, err));
}

function notifyEventSoon(kind, at) {
  const mins = Math.max(1, Math.round((at - Date.now()) / 60000));
  _announceOnce(`${kind}:soon:${at}`, _EVENT_TEXT[kind].soon(mins), 'notifyEventSoon:' + kind);
}

function notifyEventStarted(kind, at) {
  _announceOnce(`${kind}:now:${at}`, _EVENT_TEXT[kind].now(), 'notifyEventStarted:' + kind);
}

// ── Event boss scheduling ───────────────────────────────────────────────────
// The boss appears the moment it is summoned. There used to be a five-minute
// countdown banner in between, which meant the schedule said 20:00 and the
// boss actually turned up at 20:05. The 30-minute "coming soon" broadcast
// (notifyEventSoon below) is the warning now, so the advertised time is the
// time it lands.
//
// spawnAt is kept in the wire shape and pinned at 0: the client still has the
// countdown UI wired to it, and 0 is what tells it there's nothing pending.
function _wbNextStartAt(from = Date.now()) {
  return nextEventStartAt(WORLD_BOSS_DAYS_MSK, WORLD_BOSS_HOURS_MSK, from);
}

function eventBossState() {
  const room = getRoom(FLOOR_IDS.arena);
  return {
    spawnAt: 0,
    alive: !!(room && room.isEventBossAlive()),
    // The Events panel counts down to this, so it has to travel with the rest
    // of the boss state rather than being computed client-side from a
    // schedule copy that could drift.
    nextAt: _wbNextStartAt(),
    drops: room ? room.worldDropSnapshot() : [],
  };
}

function scheduleEventBoss() {
  const room = getRoom(FLOOR_IDS.arena);
  if (!room) return { error: 'Мир ещё не инициализирован' };
  if (room.isEventBossAlive()) return { error: 'Босс уже на карте' };
  const boss = room.spawnEventBoss();
  if (!boss) return { error: 'Не удалось призвать босса' };
  io.to('floor_1').emit('eventBossSpawned', { x: boss.x, y: boss.y });
  return { ok: true, spawnAt: 0 };
}

// Whether the arena is currently reachable via a walk-in pad (the world
// boss's own entry path — Death Battle deploys entrants with force:true and
// never consults this, see _doEnterLocation). Mirrors the client's own
// _evtArenaOpen (js/game.js): up while the boss is alive, and for as long as
// its loot still lies on the floor afterward, so nobody who was already
// fighting gets locked out of collecting a drop.
function _arenaOpen() {
  const room = getRoom(FLOOR_IDS.arena);
  if (!room) return false;
  return room.isEventBossAlive() || room.worldDropSnapshot().length > 0;
}

// Arms the next scheduled summon (понедельник/среда/пятница/воскресенье в
// 20:00 МСК) plus its 30-minute warning. Re-arms itself after each firing.
// setTimeout is capped at ~24.8 days, which every gap here is comfortably
// under, so a single timeout per event is safe.
let _wbSpawnTimer  = null;
let _wbNotifyTimer = null;

function _wbSchedule() {
  clearTimeout(_wbSpawnTimer);
  clearTimeout(_wbNotifyTimer);
  const at = _wbNextStartAt();
  if (!at) return;
  // Only arm the warning if its moment is still ahead. Without this, a
  // restart inside the 30-minute window fires a "coming soon" the instant the
  // process boots — every redeploy would spam everyone.
  const warnIn = at - EVENT_NOTIFY_BEFORE_MS - Date.now();
  if (warnIn > 0) _wbNotifyTimer = safeTimeout('wbNotify', () => notifyEventSoon('boss', at), warnIn);
  _wbSpawnTimer = safeTimeout('wbSpawn', () => {
    const r = scheduleEventBoss();
    // A summon refused because an admin already called the boss (or it is
    // still on the map) is not worth alarming anyone about — just skip the
    // announcement and re-arm for next time.
    if (!r.error) notifyEventStarted('boss', at);
    else console.log('world boss schedule skipped:', r.error);
    _wbSchedule();
  }, Math.max(0, at - Date.now()));
}

// ── Death Battle (Битва на смерть) ──────────────────────────────────────────
// The machine lives in server/events/deathbattle.js; it needs nine names from
// this file. `_db` comes back as the same state object it always was — twenty
// reads here and several more in Арена 3х3 still go straight at it.
const {
  _db, _dbPublicState, _dbBroadcast, _dbSchedule, _dbNextStartAt,
  _dbOpenReg, _dbStart, _dbFinish, _dbEliminate, _dbReturnEntrant, _dbFrozen,
} = require('./events/deathbattle')({
  io, safeTimeout, getRoom, playerFloorMap,
  notifyEventSoon, notifyEventStarted,
  _findPlayerAnyFloor, _recordPvpHistory, _socketTid,
});

// ── Арена 3х3 (3v3 Arena) ────────────────────────────────────────────────────
// The machine lives in server/events/arena3.js. What stays here is what was
// parked in the middle of it and belongs to no single event: _socketTid,
// _reclaimQueues/_rekeyQueue, _teleportCastFrozen, _pvpFrozen and
// _pvpEliminate coordinate ACROSS the machines, so they read from several of
// them by design. Leaving them behind is what took the arena's own dependency
// list from thirty-one names down to nineteen — see that file's header.
const {
  ARENA3_MIN_LEVEL, ARENA3_REWARD,
  _a3, _a3PublicState, _a3Broadcast, _a3Schedule, _a3NextOpenAt,
  _a3OpenWindow, _a3TryStart, _a3TryStartSafe, _a3Deploy,
  _a3Eliminate, _a3Finish, _a3Frozen, _a3Allies, _a3Enemies,
} = require('./events/arena3')({
  io, safeTimeout, getRoom, notifyEventSoon, notifyEventStarted,
  logPlayer, _returnToHub, _findPlayerAnyFloor, _socketTid,
  _recordPvpHistory, _lockArena3Daily, _arena3AttemptsLeft,
  DAILY_DUNGEON_ATTEMPTS,
});

function _socketTid(socketId) {
  return io.sockets.sockets.get(socketId)?.data?.telegramId || null;
}

// Moves a queue entry from a dead socket id to the reconnected one WITHOUT
// losing its place in line.
//
// A Map iterates in insertion order, and for the registration queues that
// order is the queue: _race10Start takes the first `capacity` entrants and
// _a3TryStart the first six. The obvious set-then-delete rekey appends, so a
// player whose connection blipped during registration silently went to the
// back — and at 50+ registrants for the Tower's 50 corridors that is the
// difference between racing and being told there was no room. Rebuilding the
// map preserves the position; these queues hold tens of entries at most, so
// the cost is irrelevant next to being fair about who signed up first.
// Hands every pre-match registration this account is holding to its current
// socket, keeping each one's place in line. Called from selectChar on every
// join, so it covers a reconnect however the old socket went away — cleanly
// disconnected, kicked by this very login, or still hanging around as a stale
// room entry. Keyed by telegramId rather than by the old socket id precisely
// because in the common case that id is already gone by the time we get here.
function _reclaimQueues(telegramId, socketId) {
  if (!telegramId) return;
  const each = [[_db.reg, _dbBroadcast], [_a3.queue, _a3Broadcast], [_race10.queue, _race10Broadcast]];
  for (const [map, broadcast] of each) {
    for (const [sid, entry] of map) {
      if (sid === socketId || !entry || entry.tid !== telegramId) continue;
      _rekeyQueue(map, sid, socketId);
      broadcast();
      break;   // one registration per account per event
    }
  }
}

function _rekeyQueue(map, oldKey, newKey) {
  if (!map.has(oldKey)) return false;
  const entries = [...map];
  map.clear();
  for (const [k, v] of entries) map.set(k === oldKey ? newKey : k, v);
  return true;
}

// True while this socket is mid-cast on a teleport stone (useTeleportStone,
// below) — folded into _pvpFrozen so the same movement/attack guards that
// already hold a player still during a PvP pre-fight freeze hold them still
// for the cast too, with no extra per-handler check needed.
function _teleportCastFrozen(socketId) {
  const until = _teleportCasting.get(socketId);
  return until != null && Date.now() < until;
}

// Both PvP modes can hold a player in a pre-fight freeze, and both need to
// know when one goes down; the teleport-stone cast is a third kind of the
// same thing. Every movement/combat path goes through this rather than
// checking each mode separately — adding another one later means changing
// this function, not every attack handler. Each half no-ops for a socket
// that isn't in that mode.
function _pvpFrozen(socketId) {
  return _dbFrozen(socketId) || _a3Frozen(socketId) || _race10Frozen(socketId) || _teleportCastFrozen(socketId);
}
// killerSocketId is only passed by the actual PvP attack handlers below —
// the 'respawn' and disconnect call sites leave it undefined, since dying to
// a monster mid-round (or just leaving) isn't a kill by another player.
// race10 has no player-vs-player damage at all, so it never needs it.
// room is the attacker's Room, only needed to resolve names for the open-world
// fallback below — the three mode-specific eliminates already know names from
// their own alive maps.
//
// opts.fearGrace: true only from the two disconnect-class call sites (the
// real 'disconnect' handler and the stale half of a same-account reconnect)
// — routes the Fear half through _fearHoldOnDisconnect instead of
// _fearEliminate, so an involuntary exit holds the run for a possible
// reconnect instead of ending it on the spot. Every other caller (dying,
// respawn) leaves this unset and gets the immediate, real elimination.
function _pvpEliminate(socketId, killerSocketId, room, opts) {
  const dbHandled = _dbEliminate(socketId, killerSocketId);
  const a3Handled = _a3Eliminate(socketId, killerSocketId);
  const r10Handled = _race10Eliminate(socketId);
  const fearHandled = (opts && opts.fearGrace)
    ? _fearHoldOnDisconnect(socketId, opts.telegramId)
    : _fearEliminate(socketId);
  const coopHandled = (opts && opts.fearGrace)
    ? _coopEjectOnDisconnect(socketId)
    : _coopEliminate(socketId);
  // A PvP kill (setPvpMode duel) that isn't part of any live Death
  // Battle/Arena3/race10/Fear/Coop round falls through all five above
  // untouched — they only record when the victim was in their own alive
  // map. Without this, open-world PvP kills/deaths never appeared in the
  // История tab.
  if (killerSocketId && !dbHandled && !a3Handled && !r10Handled && !fearHandled && !coopHandled) {
    const victimTid = _socketTid(socketId), killerTid = _socketTid(killerSocketId);
    const victim = room?.players.get(socketId);
    const killer = room?.players.get(killerSocketId);
    if (victimTid) _recordPvpHistory(victimTid, 'death', 'open_pvp', killer?.username || null);
    if (killerTid) _recordPvpHistory(killerTid, 'kill', 'open_pvp', victim?.username || null);
  }
}

// ── Война гильдий (Guild War) ────────────────────────────────────────────────
// The machine itself lives in server/events/guildwar.js; what it needs from
// this file is the six names below and nothing else. `_gw` comes back as the
// same state object it always was — the fifteen places here that read it are
// unchanged, and untangling them is its own change.
const {
  _gw, _gwPublicState, _gwOpenWindow, _gwCloseWindow,
  _gwApplyCapture, _gwSchedule, _gwNextOpenAt, _gwIncomeSchedule,
} = require('./events/guildwar')({
  io, safeTimeout, notifyEventSoon, notifyEventStarted,
  _socketForTelegramId, playerFloorMap,
});

// ── Кровавая Башня (corridor race) ──────────────────────────────────────────
// The machine lives in server/events/race10.js; it needs twelve names from
// this file — see that file's header for why it borrows more than the others.
// `_race10` comes back as the same state object: thirty-six reads here and
// several more in Арена 3х3 still go straight at it.
const {
  RACE10_ATTEMPTS, RACE10_MIN_LEVEL,
  _race10, _race10PublicState, _race10Broadcast, _race10Schedule,
  _race10NextOpenAt, _race10OpenWindow, _race10CloseWindow,
  _race10Start, _race10Finish, _race10Eliminate, _race10Frozen,
} = require('./events/race10')({
  io, safeTimeout, getRoom, notifyEventSoon, notifyEventStarted,
  logPlayer, _returnToHub, _findPlayerAnyFloor, _socketTid,
  _recordPvpHistory, _lockRace10Daily, _race10AttemptsLeft,
});

// ── Страх (Fear) ─────────────────────────────────────────────────────────────
// The machine lives in server/events/fear.js; it needs four names from this
// file. The surface below is wide because the socket handlers that drive a run
// are still here — see that file's header.
const {
  FEAR_ATTEMPTS, FEAR_MIN_LEVEL, FEAR_START_DELAY_MS,
  _fear, _fearRooms, _liveFearRooms, _trackFearRoom, _createFearRoom,
  _fearStartWave, _fearTrackKill, _fearEliminate, _fearFinish,
  _fearHoldOnDisconnect, _fearDisconnectGrace, _fearReleaseRun,
} = require('./events/fear')({ io, safeTimeout, _returnToHub, _socketTid });

// ── Сотрудничество (Coop) ────────────────────────────────────────────────────
// The machine and its lobby live in server/events/coop.js; it needs two names
// from this file. The surface below is wide because the socket handlers that
// drive a run and a lobby are still here — see that file's header.
const {
  COOP_ATTEMPTS, COOP_MIN_LEVEL, COOP_START_DELAY_MS, COOP_LIBERTY_CHANCE,
  _coop, _liveCoopRooms, _createCoopRoom,
  _coopTrackKill, _coopBossTrackKill, _coopEliminate, _coopFinish,
  _coopReleaseRun, _coopEjectOnDisconnect,
  _coopGroups, _coopGroupOf, _coopGroupPush, _coopGroupBroadcastList,
  _coopGroupOpenList, _coopGroupStateFor, _coopGroupDissolve,
  _coopGroupDropOnDisconnect,
} = require('./events/coop')({ io, _returnToHub });

// ── Элитная фарм-зона (Elite Farm Zone 2) ───────────────────────────────────
// The machine lives in server/events/farm2.js; it needs two names from this
// file, the same two Сотрудничество needs. What stays behind is what was
// parked under this heading and is not the farm zone at all: _initFloorRooms,
// the world's own bootstrap, immediately below.
const {
  _farm2, _farm2Starting, _createFarm2Room,
  _farm2Finish, _farm2Eliminate, _farm2ReleaseRun,
  _farm2CascadeCheck, _farm2EjectOnDisconnect,
  _farm2Groups, _farm2GroupOf, _farm2GroupPush, _farm2GroupBroadcastList,
  _farm2GroupStateFor, _farm2GroupOpenList, _farm2GroupDissolve,
  _farm2GroupDropOnDisconnect,
} = require('./events/farm2')({ io, _returnToHub });

// ── Admin REST API: registration ─────────────────────────────────────────────
// Every /admin route group, each in its own file under server/admin/. Placed
// here rather than where the routes used to sit because this is the first point
// at which every machine handle above exists — see the notes up there.
//
// Each group declares what it needs and refuses to register without it, the
// same rule the event machines follow. Nine of the thirteen need five names or
// fewer. The two that need more — the event-control panel and the attempt
// refunds — are the two that drive machines rather than tables, and a
// controller needing a handle on each thing it controls is the shape working
// as intended, not coupling to be trimmed.
//
// auth goes first: it mounts the per-IP ceiling that has to see every /admin
// route registered after it, and it hands back the adminAuth middleware the
// other twelve are given, so the token check has exactly one implementation.
const { adminAuth } = require('./admin/auth')(app, { ADMIN_USERNAME });
require('./admin/stats')(app, { adminAuth, io, _escapeRegex });
require('./admin/players')(app, {
  adminAuth, io, logPlayer,
  LOG_KEEP_PER_PLAYER, LOG_KEEP_SEASON_PER_PLAYER, LOG_SEASON_EVENTS,
});
require('./admin/attempts')(app, {
  adminAuth, logPlayer, _socketForTelegramId, _coop, _fear,
  COOP_ATTEMPTS, COOP_MIN_LEVEL, COOP_STAGE_LEVELS,
  FEAR_ATTEMPTS, FEAR_MIN_LEVEL, FEAR_MAX_WAVE,
});
require('./admin/give')(app, { adminAuth, io, logPlayer, activeSessions, _incBalance });
require('./admin/quests')(app, { adminAuth });
require('./admin/misc')(app, { adminAuth });
require('./admin/season')(app, { adminAuth, io, logPlayer });
require('./admin/chat')(app, {
  adminAuth, io, tgApi, tgBroadcastAll, _publicChatHistory, globalChatHistory,
});
require('./admin/items')(app, { adminAuth, activeSessions, io, logPlayer });
require('./admin/market')(app, { adminAuth, activeSessions, io, logPlayer });
require('./admin/events')(app, {
  adminAuth, eventBossState, scheduleEventBoss,
  _gw, _gwPublicState, _gwOpenWindow, _gwCloseWindow,
  _race10, _race10PublicState, _race10OpenWindow, _race10CloseWindow,
  _race10GrantBonusAttempt,
});
// Owns the maintenance flag itself — the login gate below asks through this
// rather than reading a module-level `let`, so the two /admin/maintenance
// routes stay its only writers.
const { isMaintenanceOn } = require('./admin/maintenance')(app, {
  adminAuth, _kickAllForMaintenance,
});



// Pre-create all floor rooms once MongoDB is reachable. Idempotent so it's
// safe to trigger from more than one path below — _floorRoomsStarted is set
// synchronously (before the first await) so two calls racing in before
// either finishes can't both pass the guard and double-init.
let _floorRoomsStarted = false;
async function _initFloorRooms() {
  if (floorRooms.size > 0 || _floorRoomsStarted) return;
  _floorRoomsStarted = true;
  // Per-arm boss cooldowns survive a restart from here: load whatever was
  // last persisted (see the onBossDeath hook passed to each Room below) so
  // a boss that was mid-cooldown resumes the real remaining time instead of
  // restarting a fresh random 1-2h wait on every deploy.
  const bossDocs = await BossStateModel.find({}).lean().catch(() => []);
  const bossStateByFloor = new Map();
  bossDocs.forEach(d => {
    if (!bossStateByFloor.has(d.floor)) bossStateByFloor.set(d.floor, {});
    bossStateByFloor.get(d.floor)[d.arm] = d.respawnAt;
  });
  // Guild War ownership survives a restart the same way per-arm boss
  // deadlines do (just above) — loaded once here, before any Room exists, so
  // spawnGuildWarTower below can hand the tower its persisted owner instead
  // of starting every restart unowned.
  const gwDoc = await GuildWarStateModel.findOne({ key: 'castle' }).lean().catch(() => null);
  if (gwDoc) {
    _gw.ownerClanId = gwDoc.ownerClanId || null;
    _gw.ownerClanName = gwDoc.ownerClanName || null;
    _gw.ownerClanIcon = gwDoc.ownerClanIcon || null;
    _gw.capturedAt = gwDoc.capturedAt || 0;
  }
  for (const entry of FLOOR_REGISTRY) {
    const f = entry.id;
    const onBossDeath = (arm, respawnAt) => {
      BossStateModel.updateOne({ floor: f, arm }, { $set: { respawnAt } }, { upsert: true })
        .catch(err => console.error('[BossState] persist failed', f, arm, err));
    };
    const room = new Room(f, io, bossStateByFloor.get(f) || {}, onBossDeath);
    if (f === FLOOR_IDS.guildWar) room.spawnGuildWarTower(_gw);
    floorRooms.set(f, room);
  }
  console.log('Floor rooms initialized');
  // Needs Mongo, so it starts here rather than at require time.
  _refreshTopPlayer();
  safeInterval('topPlayer', _refreshTopPlayer, TOP_PLAYER_POLL_MS);
}
// 'open' only ever fires once per connection and never fires at all if
// Mongo wasn't reachable yet at the moment this ran — so the game world
// used to stay permanently uninitialized (every player crashing at
// selectChar) whenever Mongo had a slow/failed cold start. Cover the
// already-connected case immediately, then either wait for 'open' (the
// common fast path) or poll until the connection comes up as a fallback
// for the delayed/retried-connection case.
if (mongoose.connection.readyState === 1) {
  _initFloorRooms();
} else {
  mongoose.connection.once('open', _initFloorRooms);
  const _roomInitRetry = safeInterval('roomInitRetry', () => {
    if (mongoose.connection.readyState !== 1) return;
    clearInterval(_roomInitRetry);
    _initFloorRooms();
  }, 2000);
}

// ── Clan helpers ─────────────────────────────────────────────────────────────
// The live socket for an account. Every clan fan-out used to find this with
// `[...io.sockets.sockets.values()].find(s => s.data.telegramId === ...)` —
// a full copy of the socket table, per member, per notification. activeSessions
// is already the authoritative telegramId -> socketId index; use it.
function _socketForTelegramId(telegramId) {
  const sid = activeSessions.get(telegramId);
  if (!sid) return null;
  return io.sockets.sockets.get(sid) || null;
}

// One bm read for the whole clan. _clanDataFor does this lookup itself, and it
// was being called once per member inside a notification loop — so telling a
// 50-member clan anything meant 50 sequential queries that each read the same
// 50 documents. Split out so a fan-out can do it once and reuse the result.
async function _clanBmMap(clan) {
  const memberIds = clan.members.map(m => m.telegramId);
  const docs = await PlayerModel.find({ telegramId: { $in: memberIds } }, { telegramId: 1, bm: 1 })
    .lean().catch(() => []);
  const bmMap = {};
  docs.forEach(d => { bmMap[d.telegramId] = d.bm || 0; });
  return bmMap;
}

function _clanDataWith(clan, telegramId, bmMap) {
  const myRole = clan.members.find(m => m.telegramId === telegramId)?.role || null;
  return {
    _id:          clan._id,
    name:         clan.name,
    icon:         clan.icon,
    description:  clan.description || '',
    level:        clan.level,
    xp:           clan.xp,
    members:      clan.members.map(m => ({ telegramId: m.telegramId, username: m.username, role: m.role, bm: bmMap[m.telegramId] || 0 })),
    applications: myRole === 'leader' ? clan.applications.map(a => ({ telegramId: a.telegramId, username: a.username })) : [],
    myRole,
  };
}

async function _clanDataFor(clan, telegramId) {
  return _clanDataWith(clan, telegramId, await _clanBmMap(clan));
}

async function _notifyClan(clan) {
  const bmMap = await _clanBmMap(clan);
  for (const m of clan.members) {
    const target = _socketForTelegramId(m.telegramId);
    if (!target) continue;
    target.emit('clanData', _clanDataWith(clan, m.telegramId, bmMap));
    // Membership changes are made on the LEADER's socket, so the member's own
    // connection has no idea it now belongs to a clan. It used to find out
    // only on its next kill, because the per-kill XP path happened to re-read
    // the clan and refresh these — which also meant a freshly approved member
    // ran around with no clan tag over their head until they hit something.
    // Now that the kill path is a pure counter bump, refresh it here, where
    // the member is already being told about the change. Also covers a level-
    // up (this is the only path _flushClanXp goes through), so the new atk%
    // reaches every online member's Room player immediately instead of
    // waiting for their client to happen to recompute() on its own.
    target.data._setClanIdentity?.(clan._id, clan.name, clan.icon, clan.level);
  }
}

// Withdraws every pending application this telegramId has anywhere except
// (optionally) one clan — called whenever their clan status is about to
// change: applying elsewhere, getting approved, or founding their own. Without
// this a stale application could sit in some other clan's queue indefinitely
// and, if that leader later approved it, put the player in two clans at once
// (nothing at the DB level stops that — see server/models/Clan.js).
async function _clearOtherClanApplications(telegramId, exceptClanId = null) {
  const filter = { 'applications.telegramId': telegramId };
  if (exceptClanId) filter._id = { $ne: exceptClanId };
  const others = await ClanModel.find(filter).catch(() => []);
  if (!others.length) return;
  await ClanModel.updateMany(
    { _id: { $in: others.map(c => c._id) } },
    { $pull: { applications: { telegramId } } }
  ).catch(() => {});
  for (const c of others) {
    c.applications = c.applications.filter(a => a.telegramId !== telegramId);
    await _notifyClan(c);
  }
}

// ── Clan XP batching ─────────────────────────────────────────────────────────
// Clan XP is +1 per monster kill. It used to be applied inline on every single
// kill: a findOne on an unindexed embedded field, a full-document clan.save(),
// a second query over every member's bm, and a whole clanData packet — four
// round trips of work for one point, hundreds of times a second across the
// server, all sharing a 10-connection pool with everyone's progress saves.
// That is the single biggest reason ordinary actions would intermittently hang.
//
// Kills now just increment an in-memory counter. A timer folds each clan's
// accumulated points into one atomic $inc, and members only hear about it when
// the level actually changes — which is the only part of it they can see. A
// concurrent $inc is also correct under load in a way clan.save() never was:
// two members of the same clan killing at once each read-modify-wrote the whole
// document, so one of the two increments was simply lost.
const CLAN_XP_LEVELS = [0, 500, 1500, 4000, 10000, 25000, 60000, 150000, 350000, 800000];
const CLAN_MAX_LEVEL = 10;
const CLAN_XP_FLUSH_MS = 20000;
const _clanXpPending = new Map(); // clanId string -> accumulated xp

function _clanXpAdd(clanId, amount) {
  if (!clanId || amount <= 0) return;
  const k = String(clanId);
  _clanXpPending.set(k, (_clanXpPending.get(k) || 0) + amount);
}

async function _flushClanXp() {
  if (!_clanXpPending.size) return;
  const batch = [..._clanXpPending];
  _clanXpPending.clear();
  for (const [clanId, xp] of batch) {
    if (xp <= 0) continue;
    try {
      // level filter mirrors the old early-return: a maxed clan stops earning.
      const clan = await ClanModel.findOneAndUpdate(
        { _id: clanId, level: { $lt: CLAN_MAX_LEVEL } },
        { $inc: { xp } },
        { new: true },
      );
      if (!clan) continue;
      // A batch can carry a clan across more than one threshold at once, which
      // the old one-point-at-a-time path never had to consider.
      let lvl = clan.level;
      while (lvl < CLAN_MAX_LEVEL && clan.xp >= CLAN_XP_LEVELS[lvl]) lvl++;
      if (lvl === clan.level) continue;
      clan.level = lvl;
      await ClanModel.updateOne({ _id: clan._id }, { $set: { level: lvl } });
      // Everyone gets the level-up, not just whoever happened to land the kill
      // that crossed the line — the client shows a toast off exactly this.
      await _notifyClan(clan);
    } catch (err) { console.error('_flushClanXp:', err); }
  }
}
safeInterval('clanXpFlush', () => { _flushClanXp().catch(() => {}); }, CLAN_XP_FLUSH_MS).unref();

// One line every SESSION_REPORT_MS naming why sessions ended in that window,
// so the answer is in the deploy log rather than only behind an authenticated
// /health poll nobody is making at 3am. Silent when nothing disconnected, and
// on stdout rather than stderr — this is a routine measurement, and a hosting
// dashboard paints anything from stderr as an error (see the [move] guard
// lines, which are console.warn and get flagged red for no reason).
//
// Read it as a shape, not as numbers: mostly 'transport close' with long
// average sessions is ordinary mobile churn and nothing to fix. A large
// 'client namespace disconnect' share means js/network.js's own watchdog is
// tearing down healthy links. A large 'ping timeout' share means the link (or
// the client) really is going quiet. 'server shutting down' means the process
// restarted and took everyone with it. shortLived/endedAuthed climbing toward
// 1 is a reconnect loop whatever the reason column says.
const SESSION_REPORT_MS = 5 * 60 * 1000;
let _lastSessionReport = _sessionStatsSnapshot();
safeInterval('sessionReport', () => {
  const now = _sessionStatsSnapshot();
  const delta = {};
  let total = 0;
  for (const [k, v] of Object.entries(now.reasons)) {
    const d = v - (_lastSessionReport.reasons[k] || 0);
    if (d > 0) { delta[k] = d; total += d; }
  }
  const endedAuthed = now.endedAuthed - _lastSessionReport.endedAuthed;
  const shortLived  = now.shortLived  - _lastSessionReport.shortLived;
  _lastSessionReport = now;
  if (!total) return;
  console.log(`[sessions] ${total} ended in ${SESSION_REPORT_MS / 60000}min ` +
    `(${endedAuthed} authed, ${shortLived} under ${SHORT_SESSION_MS / 1000}s, ` +
    `avg ${now.avgSessionS}s all-time) — ` +
    Object.entries(delta).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '));
}, SESSION_REPORT_MS).unref();

// The same window, for the other recurring question: the hosting bill says
// egress is what costs money, and this says which egress. Unlike [sessions]
// this prints even when the number is small — a quiet window is itself the
// answer when the bill is large, because it means the traffic is arriving in
// bursts (new devices downloading assets) rather than continuously (the game
// stream, or a database being written to across a network boundary).
//
// What to do with the line, in the order the numbers appear:
//   http dominates  — assets. Look at the by-type breakdown: it is per FRESH
//                     DEVICE (everything but index.html is immutable for a
//                     year), so a big number means new players, not online
//                     ones. dev/egress.js prices one such load exactly.
//   ws dominates    — the world stream, and it scales with concurrency and
//                     with how tightly players are packed. dev/roombench.js
//                     prices it per player per cast.
//   other dominates — nothing to do with players. MongoDB (every autosave, and
//                     Atlas is outside the hosting network so those bytes are
//                     billed like a download) or the Telegram Bot API.
let _lastEgress = egress.snapshot();
safeInterval('egressReport', () => {
  const now = egress.snapshot();
  const d = egress.diff(_lastEgress, now);
  _lastEgress = now;
  console.log(egress.format(d));
}, SESSION_REPORT_MS).unref();

// ── Combat fan-out ───────────────────────────────────────────────────────────
// enemyHurt/enemyKilled describe ONE enemy, and they used to go to the whole
// floor on every swing. The world is a single shared floor, so the cost of one
// player hitting one monster scaled with everyone online: at a few hundred
// players each landing a handful of hits a second, that is six figures of
// outbound packets a second, almost all of them about an enemy the recipient
// has never been told exists and prunes on arrival. The AOI stream already
// knows exactly who can see a given enemy (Room._eKnown, via viewersOfEnemy),
// so address these to that set instead.
//
// Returns the recipient list, or null when nobody is left to tell — callers
// skip the emit entirely in that case rather than paying for an empty
// broadcast. `exclude` is for the recipients that already got a richer,
// personally-addressed copy (the attacker, their party).
function _enemyViewers(room, enemyId, exclude) {
  if (!room) return null;
  const viewers = room.viewersOfEnemy(enemyId);
  if (!viewers.length) return null;
  // Copy: viewersOfEnemy hands back a buffer it reuses on the next call.
  const out = [];
  for (let i = 0; i < viewers.length; i++) {
    const id = viewers[i];
    if (exclude && exclude.includes(id)) continue;
    out.push(id);
  }
  return out.length ? out : null;
}

// Emits `event` to everyone currently able to see `enemyId`, minus `exclude`.
// io.to(idArray) resolves each socket id as its own room and encodes the
// payload once for the whole set, so this stays a single serialization.
function _emitToEnemyViewers(room, enemyId, event, payload, exclude) {
  const ids = _enemyViewers(room, enemyId, exclude);
  if (!ids) return;
  io.to(ids).emit(event, payload);
}

// Server-side floor between two 'healParty' casts from the same connection —
// see the handler's own comment (below, inside io.on('connection')) for why
// this exists at all. Same "far below the real cooldown, just tight enough
// that spamming isn't worth anything" role SKILL_CD_MS plays for every other
// skill (server/game/Room.js) — legitimate play (25s between casts, the
// warlock R skill's own client-side cooldown) never gets near it.
const HEAL_PARTY_CD_MS = 2000;

io.on('connection', socket => {
  let authed = null;
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
    if (!authed) socket.disconnect(true);
  }, 20000);
  let currentRoom = null;
  let currentFloor = FLOOR_IDS.hub;
  let _lastStats = null;
  let _autoSaveInterval = null;
  // Wall-clock time this session last had a save accepted — used by the gold
  // growth cap below (saveProgress). Deliberately server time, not the
  // client's own savedAt: a forged save controls that field just as freely
  // as the gold figure itself, so rate-limiting against it would let the
  // same forgery just claim an earlier savedAt to buy a bigger allowance.
  let _lastSaveAcceptedAt = 0;

  // Banks one XP grant at the most generous multiplier the client could
  // legitimately apply to it. Exposed on socket.data because a kill pays
  // every nearby party member, and their entitlement lives in THEIR socket's
  // closure, not this one — same reason _grantKillLoot is exposed.
  // The XP entitlement ledger used to live here: it banked what the server had
  // handed out so a CLIENT-COMPOSED level could be measured against it. The
  // server applies the XP and runs the level curve itself now (_grantXp), so
  // there is no claim left to audit and nothing to bank.
  // A party member's share is credited against their OWN session — same
  // reasoning as the XP share below, and the same delivery route. Returns what was
  // credited as well as the new total: the attacker's socket cannot compute a
  // member's clan bonus or potion buff, so the figure their client displays has
  // to come back from their own session.
  socket.data._grantKillGold = base => {
    const gained = _killGold(base);
    return { gained, total: _grantGold(gained, 'kill', { quiet: true }) };
  };

  // ── Server-side gold spend ────────────────────────────────────────────────
  // Gold is the one currency the server does not own: it rides in on the
  // client's save blob and the next saveProgress replaces _lastStats wholesale.
  // So deducting it here is not enough on its own — a save composed BEFORE the
  // deduction, arriving after it, carries the pre-spend figure and hands the
  // money straight back. That is why "золото не снимает" for the clan storage
  // unlock: the charge landed and was then quietly undone.
  //
  // That whole correction is gone: gold is server-owned, a save cannot report
  // a balance, and so nothing can hand a charge back. What is left is the
  // charge itself.
  async function _serverSpendGold(amount, reason) {
    if (!authed || !_lastStats || !(amount > 0)) return null;
    const before = _goldNow();
    const after = Math.max(0, before - Math.floor(amount));
    _lastStats.gold = after;
    await _persistSavedFields(authed, { gold: after });
    socket.emit('goldSync', { gold: after });
    logPlayer(authed.telegramId, authed.username, 'gold_spend',
      { reason, amount, before, after });
    return after;
  }
  let _myClanName = null;
  let _myClanIcon = null;
  // The clan's _id, kept beside the name/icon so the per-kill XP tally can be
  // a pure in-memory increment instead of re-resolving the clan from the DB on
  // every single monster death — see _onKillClanXp and _clanXpAdd.
  let _myClanId = null;
  // The clan's current level, kept purely so its atk% (clanAtkBonusPct) can be
  // pushed onto the Room player object below — Room.js's computeStats needs
  // it synchronously and has no DB access of its own.
  let _myClanLevel = null;

  // Lets another connection (a clan leader approving/kicking, the XP flusher
  // announcing a level-up) update THIS session's clan identity — see
  // _notifyClan. Passing nulls clears it, which is what a kick/disband does.
  socket.data._setClanIdentity = (clanId, name, icon, level) => {
    _myClanId    = clanId ? String(clanId) : null;
    _myClanName  = name || null;
    _myClanIcon  = icon || null;
    _myClanLevel = level || null;
    currentRoom?.setPlayerClan(socket.id, _myClanName, _myClanIcon, clanAtkBonusPct(_myClanLevel), _myClanId);
  };
  // Per-socket MIRROR of the account's balances — NOT the source of truth.
  // _gramBalanceCache/_nexumBalanceCache (keyed by telegramId) are, because
  // several credit paths run in a *different* connection's closure — or in no
  // connection at all — and can only reach the account through the cache:
  //   • a market sale's payout to the seller (marketBuy runs on the BUYER's
  //     socket),
  //   • an admin confirming a deposit, and the 5% referral bonus it pays,
  //   • POST /admin/player/:tid/give.
  // All of those write the cache and push a gramBalanceUpdate to the client,
  // so the player SEES the credit — but this socket's mirror stays at the old
  // number. Anything that then based a new value on the mirror (a gram drop,
  // a purchase, a withdrawal) wrote that stale figure straight back over the
  // credit, in both the cache and the DB. With a 30% gram-drop chance per
  // kill, a sale's proceeds could vanish within seconds of arriving — the
  // reported "продал лот, а GRAM не пришли / баланс перезаписался" bug.
  // Read every balance through _liveGram/_liveNexum and write every change
  // through _setGram/_setNexum so the mirror and the cache can never diverge.
  let _gramBalance = 0;
  let _nexumBalance = 0;
  function _liveGram() {
    return (authed && _gramBalanceCache.has(authed.telegramId))
      ? _gramBalanceCache.get(authed.telegramId) : _gramBalance;
  }
  function _setGram(v) {
    _gramBalance = v;
    if (authed) _gramBalanceCache.set(authed.telegramId, v);
    return v;
  }
  function _liveNexum() {
    return (authed && _nexumBalanceCache.has(authed.telegramId))
      ? _nexumBalanceCache.get(authed.telegramId) : _nexumBalance;
  }
  function _setNexum(v) {
    _nexumBalance = v;
    if (authed) _nexumBalanceCache.set(authed.telegramId, v);
    return v;
  }
  let _lastMarketListAt = 0;

  // ── One-at-a-time guard for spend/claim handlers ──────────────────────────
  // gramShopBuy, claimVipRewards and completeSpecialQuest all read a balance
  // or a claim flag, then `await` a DB round trip, and only then spend or
  // clear it. Two events sent in the same tick both pass the check while the
  // first is still awaiting — buying one package twice for one payment,
  // claiming a VIP tier's items twice, taking a quest reward twice. The rate
  // limiter doesn't help: it allows 40 heavy events per 5s, and this needs
  // exactly two.
  //
  // marketBuy solves the same problem by keeping no await between its
  // re-check and its deduction (see the comment there); these three can't be
  // rearranged that way, so they serialize instead. Per-socket is the right
  // scope: all three act on the connection's own account, and a second
  // connection for the same account is already impossible (activeSessions).
  let _econBusy = false;
  async function _withEconLock(fn) {
    if (_econBusy) return false;
    _econBusy = true;
    try { await fn(); } finally { _econBusy = false; }
    return true;
  }

  // ── Stale-inventory-array guard for item-granting handlers ─────────────────
  // marketCancel/marketBuy/craftGear/craftClassGear/gramShopBuy/claimVipRewards/
  // clanStorageDeposit/clanStorageClaim/_dbGrantWin all read _lastStats.inventory
  // (or a copy of it) BEFORE at least one `await` (a DB round trip), then
  // mutate/commit it AFTER. saveProgress runs fully synchronously and needs no
  // await of its own, so it can — and does — run to completion in the gap
  // between two of THIS handler's awaits, on the very same socket (safeOn just
  // does a plain socket.on; nothing serializes different event types against
  // each other). When it does, its accepted branch replaces _lastStats
  // wholesale with a brand-new object (see `_lastStats = clean` below), which
  // orphans the array these handlers are still holding a reference to — their
  // eventual _commitServerItems() then stamps that stale, detached array back
  // over the live one, silently discarding whatever the save legitimately
  // changed in between, INCLUDING — if the ordering lands the other way — the
  // item the handler itself just granted or returned. This is what made a
  // cancelled market listing's item vanish right after coming back.
  //
  // _lastStats is otherwise only ever reassigned wholesale at login/selectChar
  // (both before any of these handlers can fire) — saveProgress is the one
  // recurring source of the race, so gating just it is enough to close the
  // window for every handler below without touching their internal logic.
  let _itemOpBusy = 0;

  // The per-socket session, as the handler modules under server/handlers/ see
  // it. Every property is a LIVE accessor over one of this closure's own
  // variables, never a copy: `authed` and `_lastStats` are both reassigned
  // while a session runs (login/selectChar, and every saveProgress), and
  // handlers deliberately re-read them across their awaits — marketList's
  // ownership re-check is the clearest case. Handing over values instead would
  // defeat those checks silently.
  //
  // One object shared by every handler module rather than one assembled per
  // require: six slightly different session objects would be worse than the
  // closure they came out of.
  //
  // `gram`'s setter assigns exactly what this closure's own code assigns, and
  // deliberately NOT _setGram, which also writes the balance cache — see
  // server/handlers/market.js.
  const session = {
    get authed() { return authed; },
    get lastStats() { return _lastStats; },
    get gram() { return _gramBalance; },
    set gram(v) { _gramBalance = v; },
    get nexum() { return _nexumBalance; },
    set nexum(v) { _nexumBalance = v; },
    // Read-only out here: the inventory revision counter is bumped by
    // _commitServerItems and only ever READ by handlers, which put it in their
    // log lines so a "where did my item go" report can be lined up against the
    // write that moved it.
    get invRev() { return _invRev; },
    // The clan a session belongs to. Written on both sides — the clan handlers
    // set it on join/leave/disband, the login and clan-data paths out here set
    // it when a session starts or its clan changes underneath it — so these are
    // get/set pairs like `gram` rather than getters like the rest.
    get clanName() { return _myClanName; },
    set clanName(v) { _myClanName = v; },
    get clanId() { return _myClanId; },
    set clanId(v) { _myClanId = v; },
    get clanLevel() { return _myClanLevel; },
    set clanLevel(v) { _myClanLevel = v; },
    get clanIcon() { return _myClanIcon; },
    set clanIcon(v) { _myClanIcon = v; },
    // The Room this socket is standing in, reassigned on every floor change.
    get room() { return currentRoom; },
    // Shared chat cooldown: global chat and clan chat draw on the same 3s
    // window, and they now live in different files, so it is a get/set pair.
    get lastChatAt() { return _lastChatAt; },
    set lastChatAt(v) { _lastChatAt = v; },
  };
  let _saveDebounceTimer = null;
  // Pending teleport-stone cast's setTimeout handle (server/index.js's own
  // useTeleportStone below) — cleared on disconnect so a dead connection
  // never fires _doEnterLocation against a socket that is no longer live.
  let _teleportCastTimer = null;

  // Items granted from OUTSIDE a player-initiated handler while one of the
  // clone-and-commit handlers above is mid-flight: mob loot (every kill),
  // a market item arriving cross-session, a death-battle/Tower reward, a
  // craft result landing on a reconnected socket.
  //
  // Those grants go straight into the live inventory, and the clone-holder's
  // eventual wholesale commit stamps them away — the "+1×" floating text
  // plays for an item that never arrives. A player-initiated handler can
  // simply refuse and be retried (that is what _itemsBusy is for), but a
  // grant has nowhere to be retried FROM: the mob is already dead, the lot
  // already sold. Refusing would destroy it just as surely.
  //
  // So they are recorded here as well as applied, and the stale commit
  // re-applies them on top of the snapshot it is about to install (see
  // _commitServerItems). Nothing is refused and nothing is lost: the grant
  // survives whichever way the two land.
  let _pendingOobGrants = [];
  // Takes either a full item object or a bare {id, qty} (the loot roll reports
  // its drops in a display shape, not a catalog one). Either way what is
  // stored is rebuilt from the catalog, so the replay is a real item _invAdd
  // can place — slot included, which is what decides stacking.
  function _recordOobGrant(items) {
    if (_itemOpBusy <= 0) return;
    for (const it of items) {
      if (!it || !it.id) continue;
      const base = _catalogBase(it.id);
      if (!base) continue;
      const qty = Math.max(1, Math.floor(Number(it.qty)) || 1);
      _pendingOobGrants.push(isStackableItem(base) ? { ...base, qty } : { ...base, ...(it.enhance ? { enhance: it.enhance } : {}) });
    }
  }

  // ── Coalesced balance writes ──────────────────────────────────────────────
  // Kill drops (Liberty on a few percent of kills, GRAM on 30% of them) used
  // to hit Mongo the instant they landed — one findByIdAndUpdate per drop, per
  // player. At a few hundred players farming that is hundreds of writes a
  // second, each persisting a fraction of a coin, all queued through the same
  // 10-connection pool as every real progress save; the queueing is felt as
  // the whole server going syrupy for a moment.
  //
  // So a burst of drops is accumulated here and lands as ONE write. What is
  // accumulated is the DELTA, not the resulting total: the flush is an $inc, so
  // whatever else credited the account meanwhile (a market sale, an admin
  // deposit) is added to rather than replaced. The mirror is advanced
  // optimistically as drops land so the HUD stays live, then reconciled with
  // the figure the database returns on flush.
  const BALANCE_PERSIST_MS = 10000;
  let _balancePersistTimer = null;
  let _gramPending = 0;    // GRAM earned since the last flush
  let _nexumPending = 0;   // Liberty earned since the last flush
  async function _flushBalances() {
    if (_balancePersistTimer) { clearTimeout(_balancePersistTimer); _balancePersistTimer = null; }
    if (!authed) return;
    const g = _gramPending, n = _nexumPending;
    // Cleared before the awaits so drops landing during the write are counted
    // toward the NEXT flush instead of being written twice.
    _gramPending = 0; _nexumPending = 0;
    if (g > 0) {
      const v = await _incBalance(authed.telegramId, 'gramBalance', g);
      if (v !== null) _gramBalance = v;
    }
    if (n > 0) {
      const v = await _incBalance(authed.telegramId, 'nexumBalance', n);
      if (v !== null) _nexumBalance = v;
    }
  }
  // Adds an earned amount: visible immediately, persisted within
  // BALANCE_PERSIST_MS.
  function _earnGram(amount) {
    if (!(amount > 0)) return;
    _gramPending = _round7(_gramPending + amount);
    _setGram(_round7(_liveGram() + amount));
    _persistBalancesSoon();
  }
  function _earnNexum(amount) {
    if (!(amount > 0)) return;
    _nexumPending = _round7(_nexumPending + amount);
    _setNexum(_round7(_liveNexum() + amount));
    _persistBalancesSoon();
  }
  function _persistBalancesSoon() {
    if (_balancePersistTimer) return;
    _balancePersistTimer = safeTimeout('balancePersist', () => {
      _balancePersistTimer = null;
      _flushBalances().catch(err => console.error('_flushBalances:', err));
    }, BALANCE_PERSIST_MS);
  }
  let _lastChatAt = 0;
  let _lastTranslateAt = 0;
  // Simple per-second rate limiter for attack events
  let _atkCount = 0, _atkResetAt = 0;
  function _atkAllowed() {
    const now = Date.now();
    if (now > _atkResetAt) { _atkCount = 0; _atkResetAt = now + 1000; }
    return ++_atkCount <= 20;
  }

  // ── Per-socket event rate limiting ─────────────────────────────────────────
  // Two token buckets over a 5s window: a tight one for DB-touching / broadcast
  // / query events (spam of these is the real DoS + race-condition surface —
  // e.g. hammering marketBuy or clanApply), and a loose one for everything else
  // (movement/combat, already bounded by _atkAllowed and cheap in-memory ops).
  // Excess packets are dropped silently before the handler runs. Single-instance
  // in-memory limiter — matches this server's existing state model.
  const _HEAVY_EVENTS = new Set([
    'marketBrowse', 'marketMyListings', 'marketHistory', 'marketList', 'marketBuy', 'marketCancel',
    'gramGetHistory', 'gramShopBuy', 'specialShopBuy', 'gramDepositRequest', 'gramWithdrawRequest',
    'getReferrals', 'getRating', 'getPvpHistory', 'completeSpecialQuest', 'claimVipRewards',
    'clanCreate', 'clanSearch', 'clanApply', 'clanApprove', 'clanDecline', 'clanRequest',
    'clanKick', 'clanLeave', 'clanDisband', 'clanSetDescription',
    // Clan storage — every one of these reads and writes the clan document.
    'clanStorageSync', 'clanStorageDeposit', 'clanStorageGive',
    'clanStorageCancel', 'clanStorageClaim', 'clanStorageUnlock',
    'partyInvite', 'partyAccept', 'saveProgress', 'selectChar',
    'requestPlayerProfile', 'resetUpgrades', 'rebirth', 'craftPet', 'craftStone', 'craftGear', 'craftClassGear', 'enhanceItem',
    'buyTeleportStone',
    'craftBox', 'craftMatUpgrade', 'openLootBox',
    // Both hit the database on every call — seasonRating sorts the whole
    // player collection, seasonSetTier writes the selected band.
    'seasonRating', 'seasonSetTier',
    // History/lookup reads that were left in the loose default bucket even
    // though each call is its own DB round trip — a client idly re-opening
    // (or scripting) a DM thread or the clan chat panel could fire these at
    // up to 300/s in the fast bucket, same amplification shape as the ones
    // above, just missed when this list was written.
    'privMsgHistory', 'clanChatHistory',
    // arena3/race10/fear Register+Sync all await the daily-attempts DB read
    // (see _dailyAttemptsLeft) on every single call — Register additionally
    // rewrites the queue and re-broadcasts it. Same shape as the rest of this
    // list; only the *Unregister/*Return/*ing-state variants stay in the fast
    // bucket because they're pure in-memory reads/writes.
    'arena3Register', 'arena3Sync', 'race10Register', 'race10Sync', 'fearEnter', 'fearSync',
    // coopGroupCreate/Join/Kick/Leave all rewrite the lobby and re-broadcast
    // it to every connected socket (_coopGroupBroadcastList) — same
    // broadcast-amplification shape as arena3Register/race10Register above.
    'coopGroupCreate', 'coopGroupJoin', 'coopGroupKick', 'coopGroupLeave', 'coopGroupStart', 'coopSync',
    // Same shape as the coopGroup* bucket just above, for Элитная фарм-зона's
    // own lobby.
    'farm2GroupCreate', 'farm2GroupJoin', 'farm2GroupKick', 'farm2GroupLeave', 'farm2GroupStart', 'farm2Sync',
  ]);
  // A third bucket for the events that are cheap to ASK for and expensive to
  // ANSWER. enemyResync is the amplifier: one request makes the server encode
  // and send up to ENEMY_RESYNC_MAX (40) full enemy records, strings and all,
  // and in the fast bucket a client was allowed 300 of those a second — 12000
  // full records/s off a few bytes of request. The real client sends at most
  // two a second (_ENEMY_RESYNC_MS = 500, js/network.js), so 10 per 5s window
  // is five times what honest play needs. worldMapInline is here for the same
  // reason: it answers with the entire map.
  const _AMPLIFYING_EVENTS = new Set(['enemyResync', 'worldMapInline']);
  const _rlHeavy = { n: 0, reset: 0 };
  const _rlFast  = { n: 0, reset: 0 };
  const _rlAmp   = { n: 0, reset: 0 };
  function _rlBump(bucket, max) {
    const now = Date.now();
    if (now > bucket.reset) { bucket.n = 0; bucket.reset = now + 5000; }
    return ++bucket.n <= max;
  }
  socket.use((packet, next) => {
    const ev = packet && packet[0];
    // per 5s window. Heavy (DB/query/broadcast) kept tight; amplifying ones
    // tighter still; fast (movement/combat, sent per-frame) set high enough to
    // never throttle real play — it only exists to cut a scripted flood.
    let bucket, max;
    if (_AMPLIFYING_EVENTS.has(ev))  { bucket = _rlAmp;   max = 10; }
    else if (_HEAVY_EVENTS.has(ev))  { bucket = _rlHeavy; max = 40; }
    else                             { bucket = _rlFast;  max = 1500; }
    if (!_rlBump(bucket, max)) return; // drop silently — over budget
    next();
  });

  playerFloorMap.set(socket.id, currentFloor);

  // Exposed on socket.data so a *different* connection's closure (e.g. the
  // new socket that's about to kick this one on same-account reconnect) can
  // force this socket's pending debounced save to persist before reading
  // fresh data from the DB. Without this, a fast refresh raced the DB read
  // in loginTelegram(WebApp) against this socket's async disconnect-flush —
  // if the read won, the new session got stale savedData and, a few seconds
  // later, persisted it right back over the real progress.
  socket.data._flushNow = async () => {
    if (_saveDebounceTimer) { clearTimeout(_saveDebounceTimer); _saveDebounceTimer = null; }
    // Read BEFORE the first await. The disconnect handler ends in
    // currentRoom.removePlayer(socket.id), which runs synchronously while this
    // is still suspended on _flushBalances below — so by the time the write
    // itself happens there is no room entry left to read a position off, and
    // the flush that matters most (the one on the way out) was the one path
    // that always stored the floor without a position to go with it.
    const _where = _wherePlayerIs();
    // Balances are their own write and are never part of the progress blob —
    // see the balance block at the top of this file. Whatever this session has
    // earned since the last flush has to land either way.
    await _flushBalances();
    if (authed && _lastStats) {
      await _persistSavedFields(authed, { ..._lastStats, ..._where }, { bm: authed.bm });
    }
    // Season quest progress is deliberately NOT part of _lastStats (the
    // sanitizer strips it, so the blob above cannot carry it) and is only
    // batched to the database every SEASON_FLUSH_EVERY kills. Without this it
    // was never written on the way out, so every disconnect, refresh or closed
    // tab threw away whatever had accumulated since the last batch.
    await season.flushQuests();
  };

  // ── Admin inventory editing on a LIVE session ────────────────────────────
  // _lastStats is this socket's authoritative copy and its next autosave
  // rewrites savedData wholesale, so an admin edit written straight to the DB
  // would be silently undone. These let the admin endpoints go through the
  // session instead: read the current items, then apply the edit to
  // _lastStats, persist it, and push it to the client so the player sees it
  // immediately instead of on their next login.
  // ── Server-owned inventory changes ───────────────────────────────────────
  // The client sends its WHOLE inventory on every autosave and the server has
  // always taken it as truth. That autosave is debounced up to 2s, so one
  // queued before a server-side grant lands after it and silently reverts it —
  // which is how bought packs "never arrived" for some players.
  //
  // A per-session counter bumped by every server-side item change. It used to
  // be an ordering token echoed back by the client's save so the server could
  // tell a pre-grant item set from a post-grant one; with items server-owned
  // there is no client item set to order, and nothing reads it back. Kept as a
  // sequence number in the item log, which is what makes a "where did my item
  // go" report answerable.
  let _invRev = 0;

  // Single choke point for every server-side item change: updates the live
  // copy, bumps the revision, persists, and pushes the authoritative result to
  // the client so it can't drift.
  // opts.persist === false: the caller writes the document itself (marketBuy
  // bundles the item and the payment into one atomic $set), but the live copy,
  // the revision bump, the client sync and the log still have to happen.
  //
  // IMPORTANT for callers that also emit their own "here's your item" event
  // (worldDropPicked, marketBought, marketCancelled, petCrafted,
  // deathBattleWon): the inventorySync below already carries the item, and it
  // is delivered first. Those events must therefore tell the client whether
  // the item was committed here (delivered: true) so it does NOT mirror it
  // into the local inventory a second time — that mirroring is what handed
  // out a free duplicate of every market purchase and world drop.
  function _commitServerItems(inventory, equipment, reason, meta, opts) {
    if (!_lastStats) _lastStats = {};
    // Most callers grab `_lastStats.inventory` itself (not a copy), mutate it
    // in place (push/qty++) and only THEN call this — so by the time we get
    // here _lastStats.inventory already IS `inventory`, post-mutation, and
    // reading its length as "before" always printed the post-grant count
    // twice (`slots: 39 -> 39` no matter what actually landed). Callers that
    // mutate in place instead snapshot the true pre-mutation length and pass
    // it as opts.beforeLen; opts-less callers (the admin panel's wholesale
    // replace) never mutated the old array, so its still-current length is
    // the real "before" and the fallback stays correct for them.
    const _before = (opts && Number.isFinite(opts.beforeLen))
      ? opts.beforeLen
      : (Array.isArray(_lastStats.inventory) ? _lastStats.inventory.length : 0);
    // A commit of a DETACHED array (one of the clone-and-commit handlers
    // installing the snapshot it took before its DB awaits) would drop every
    // out-of-band grant that landed in the live array in the meantime. Pour
    // them back in first, so the snapshot carries them too — see
    // _pendingOobGrants. A commit of the live array itself already holds
    // them, so there is only the bookkeeping to clear.
    if (_pendingOobGrants.length) {
      if (Array.isArray(inventory) && inventory !== _lastStats.inventory) {
        const _rescued = [];
        for (const it of _pendingOobGrants) {
          if (_invAdd(inventory, it)) _rescued.push(it.id);
        }
        if (authed) {
          logPlayer(authed.telegramId, authed.username, 'inv:oob_rescued', {
            reason: reason || 'change', n: _rescued.length,
            of: _pendingOobGrants.length, ids: _rescued.slice(0, 10).join(','),
          });
        }
      }
      _pendingOobGrants = [];
    }
    _lastStats.inventory = inventory;
    if (equipment) _lastStats.equipment = equipment;
    _invRev++;
    // Every server-side item change funnels through here, so logging it here
    // covers all of them at once — and records the slot count before/after,
    // which is what makes a later "my item vanished" report answerable.
    if (authed) {
      logPlayer(authed.telegramId, authed.username, 'inv:' + (reason || 'change'), {
        slots: `${_before} -> ${inventory.length}`, rev: _invRev, ...(meta || {}),
      });
    }
    if (currentRoom) currentRoom.updatePlayerSavedData(socket.id, _lastStats);
    // storage travels with the other two whenever a caller touched it. It is
    // the third leg of the same set — the census counts all three together and
    // an inventory <-> storage move changes both halves at once — so writing
    // and syncing only part of it is what left the client holding an item in
    // two places at the same time.
    const _fields = { inventory };
    if (equipment) _fields.equipment = equipment;
    if (opts && opts.storage) _fields.storage = _lastStats.storage || [];
    const written = (opts && opts.persist === false) ? null : _persistSavedFields(authed, _fields);
    socket.emit('inventorySync', {
      inventory, equipment: _lastStats.equipment || {},
      storage: _lastStats.storage || [],
    });
    return written;
  }

  // The live inventory, or the DB copy when this session has yet to receive
  // one. Server-side grants must start from THIS, never from a fresh DB read:
  // the debounced save means Mongo can be up to ~3s behind, and building on
  // that snapshot rolls back whatever the player picked up in the meantime.
  function _liveInventory() {
    return (_lastStats && Array.isArray(_lastStats.inventory)) ? _lastStats.inventory : null;
  }

  socket.data._adminReadItems = () => ({
    inventory: (_lastStats && Array.isArray(_lastStats.inventory)) ? _lastStats.inventory : [],
    equipment: (_lastStats && _lastStats.equipment && typeof _lastStats.equipment === 'object')
      ? _lastStats.equipment : {},
  });

  // Unlike the grants below this is a WHOLESALE replace, so it cannot be
  // replayed on top of a stale snapshot the way _pendingOobGrants are — there
  // is no delta to replay, only "this is the inventory now". Committing it
  // while a clone-and-commit handler is outstanding just means that handler
  // stamps the edit away a moment later and the admin is told it worked.
  // Refusing and saying so is the honest answer: the admin retries, and the
  // window is a fraction of a second.
  socket.data._adminApplyItems = async (inventory, equipment) => {
    if (!authed) return false;
    if (_itemsBusy()) return false;
    await _commitServerItems(inventory, equipment, 'admin');
    return true;
  };

  // Cross-socket kill-loot grant. A party member other than the attacker can
  // win a kill's loot (random pick among party + attacker — see 'attack'/
  // 'skillAttack' below), and their inventory only lives in THEIR OWN
  // socket's closure, not the attacker's whose handler is actually running.
  // Same pattern as _adminApplyItems above: exposed on socket.data so a
  // different connection's handler can invoke it and land the grant where it
  // belongs. Rolls and grants everything itself (the mob loot table, the VIP
  // drop-bonus reroll, and — for a boss kill — the box/enchant-stone drops
  // that used to be rolled by the caller but only ever granted by the
  // client) so the caller only has to decide who won and relay what comes
  // back for that player's floating-text feedback.
  socket.data._grantKillLoot = ({ eid, rlvl, isBoss, farmZone, farmZone2, coop }) => {
    const empty = { items: [], boxUncommon: 0, boxRare: 0, normStone: 0, blessStone: 0 };
    if (!authed || !_lastStats || !Array.isArray(_lastStats.inventory)) return empty;
    const inv = _lastStats.inventory;
    const _beforeLen = inv.length;
    // Фарм-зона kills skip the normal loot table (and its VIP drop-bonus
    // reroll below) entirely — see _rollFarmZoneLoot's own comment in
    // server/loot.js. Элитная фарм-зона kills skip it the same way, in favor
    // of _rollFarm2Loot's own
    // box/stone/recipe/book table. Coop kills skip it too (including a boss
    // kill's box/stone rolls just below) and grant nothing from this
    // function at all — a regular kill's only reward beyond xp is the flat
    // COOP_LIBERTY_CHANCE Liberty roll in the attack/skillAttack handlers,
    // and the boss's own fixed reward is granted separately by
    // _coopBossTrackKill.
    const items = farmZone ? _rollFarmZoneLoot(inv, eid) : farmZone2 ? _rollFarm2Loot(inv) : coop ? [] : _rollMobLoot(inv, eid, rlvl, _lastStats.lvl);
    const _vipBon = VIP_BONUSES[socket.data.vipLevel || 0] || VIP_BONUSES[0];
    if (!farmZone && !farmZone2 && !coop && _vipBon.drop > 0 && Math.random() * 100 < _vipBon.drop) {
      items.push(..._rollMobLoot(inv, eid, rlvl, _lastStats.lvl));
    }
    let boxUncommon = 0, boxRare = 0, normStone = 0, blessStone = 0;
    if (isBoss && !coop && !farmZone2) {
      // The flag is set from what _invAdd ACTUALLY placed, not from the roll.
      // Setting it first and ignoring the return (as this did) meant a full
      // inventory still told the client "+1× Ящик" — the floating text played,
      // nothing arrived, and the player had no way to tell the drop apart from
      // one that was stolen. Every other grant in this file already reports
      // only what landed (see _rollMobLoot's addMat, server/loot.js).
      const _rollInto = (chance, item) => (Math.random() < chance && _invAdd(inv, item)) ? 1 : 0;
      boxUncommon = _rollInto(0.50, { ...BOX_DEF.find(b => b.id === 'box_uncommon'), qty: 1 });
      boxRare     = _rollInto(0.10, { ...BOX_DEF.find(b => b.id === 'box_rare'), qty: 1 });
      normStone   = _rollInto(0.10, { ..._STONE_DEFS.norm_stone, qty: 1 });
      blessStone  = _rollInto(0.01, { ..._STONE_DEFS.bless_stone, qty: 1 });
    }
    if (items.length || boxUncommon || boxRare || normStone || blessStone) {
      // Recorded before the commit so a clone-holder's later stamp re-applies
      // them instead of erasing the drop — see _pendingOobGrants. Kills are by
      // far the most frequent grant in the game, so this is the path that path
      // exists for.
      _recordOobGrant([
        ...items,
        ...(boxUncommon ? [{ id: 'box_uncommon', qty: 1 }] : []),
        ...(boxRare ? [{ id: 'box_rare', qty: 1 }] : []),
        ...(normStone ? [{ id: 'norm_stone', qty: 1 }] : []),
        ...(blessStone ? [{ id: 'bless_stone', qty: 1 }] : []),
      ]);
      _commitServerItems(inv, null, 'mob_loot', { eid, rlvl, n: items.length, boxUncommon, boxRare, normStone, blessStone }, { beforeLen: _beforeLen });
    }
    return { items, boxUncommon, boxRare, normStone, blessStone };
  };

  // Cross-socket item grant for a handler resuming after this account may
  // have reconnected on a DIFFERENT socket while it was mid-flight —
  // marketCancel/marketBuy hold across two-to-four DB awaits before they
  // apply the item, and Node never cancels a promise chain just because its
  // socket disconnected. A stale handler that kept _sellerInv/_buyerInv as a
  // direct reference into THIS closure's _lastStats.inventory would, on
  // resuming, either write into a _lastStats nobody's client can see any
  // more (harmless but the item is gone from the account's real, live
  // session) or — via _commitServerItems' unconditional persist — overwrite
  // whatever the real live session has saved since, with the returned/bought
  // item nowhere in it. That is exactly what "предмет пропал после снятия с
  // маркета" kept coming back as: the reconnect itself is what raced it.
  // Same reasoning as _grantKillLoot above; this is the same pattern for a
  // single specific item instead of a loot roll.
  socket.data._grantMarketItem = (item) => {
    if (!authed || !_lastStats || !Array.isArray(_lastStats.inventory) || !item) return { delivered: false };
    _itemOpBusy++;
    try {
      const inv = _lastStats.inventory;
      const _beforeLen = inv.length;
      const delivered = _invAdd(inv, item);
      if (delivered) {
        _recordOobGrant([item]);
        _commitServerItems(inv, null, 'market_cross_session_grant', { item: item.id }, { beforeLen: _beforeLen });
      }
      return { delivered };
    } finally {
      _itemOpBusy--;
    }
  };

  // The mirror of _grantMarketItem: takes an item OUT of whichever socket is
  // the account's live session, for marketList resuming after the account
  // reconnected mid-flight. Same reasoning, opposite direction — and the
  // direction is what makes it worse. A grant that lands in an orphaned
  // _lastStats merely goes missing; a REMOVAL that lands there removes
  // nothing anyone can see: the listing is live in the database while the
  // item is still sitting in the live session's inventory, and that
  // session's next save writes it back to the account for good. The seller
  // then gets paid for a book they still own — "продал книгу, а она
  // вернулась в инвентарь, и GRAM с продажи остались".
  //
  // Returns { removed } so the caller can undo the listing when the live
  // session doesn't actually hold the item any more (it was equipped, spent
  // or stored between the two sessions).
  socket.data._takeMarketItem = (item) => {
    if (!authed || !_lastStats || !Array.isArray(_lastStats.inventory) || !item) return { removed: false };
    // Refused while THIS session has a clone-and-commit handler of its own in
    // flight (gramShopBuy/specialShopBuy/claimVipRewards): its snapshot was
    // taken before this removal and stamps the item straight back in — the
    // very duplication marketList's own entry guard exists to stop, only
    // arriving from the other session. There is nothing to replay it into
    // either (_pendingOobGrants only carries additions), so the honest answer
    // is "not taken", which drops the lot.
    if (_itemsBusy()) return { removed: false };
    _itemOpBusy++;
    try {
      const inv = _lastStats.inventory;
      const _beforeLen = inv.length;
      if (!_invRemove(inv, item)) return { removed: false };
      _commitServerItems(inv, null, 'market_list_cross_session',
        { item: item.id, enhance: item.enhance || 0, qty: item.qty || 1 }, { beforeLen: _beforeLen });
      return { removed: true };
    } finally {
      _itemOpBusy--;
    }
  };

  // General-purpose version of _grantMarketItem above, for handlers that
  // touch more than one item and/or gold/bonusSP/VIP progress in one go
  // (crafts consuming materials, shop packages granting several rewards at
  // once). Same reasoning: those handlers hold across several DB awaits
  // before applying anything, and if the account reconnected on a different
  // socket in the meantime, this is what actually applies the result
  // against whichever session's _lastStats is live NOW — see each caller's
  // own comment for the specific race this closes.
  //
  // patch: { addItems: [{item, qty?}], removeItems: [{item, qty?}],
  //          goldDelta, bonusSPDelta, vipGramDelta, clearVipPending }
  // removeItems are applied before addItems (matters for crafts: spend
  // materials, then hand back the result). Returns null if this socket
  // isn't authed/loaded; otherwise the account's resulting gold/VIP state,
  // which callers use to build the event they emit back.
  socket.data._applyGrant = (patch, reason, meta) => {
    if (!authed || !_lastStats) return null;
    _itemOpBusy++;
    try {
      if (!Array.isArray(_lastStats.inventory)) _lastStats.inventory = [];
      const inv = _lastStats.inventory;
      const _beforeLen = inv.length;
      (patch.removeItems || []).forEach(({ item, qty }) => {
        if (item) _invRemove(inv, qty != null ? { ...item, qty } : item);
      });
      (patch.addItems || []).forEach(({ item, qty }) => {
        if (item) _invAdd(inv, qty != null ? { ...item, qty } : item);
      });
      // Same replay bookkeeping as _grantKillLoot's — this is the path the
      // death-battle and Tower rewards arrive on. Only the additions: a
      // removal that gets undone by a stale stamp costs the player nothing.
      _recordOobGrant((patch.addItems || []).map(({ item, qty }) => (
        item ? { id: item.id, qty: qty != null ? qty : item.qty, enhance: item.enhance } : null)));
      if (patch.goldDelta) _lastStats.gold = Math.max(0, (_lastStats.gold || 0) + patch.goldDelta);
      if (patch.bonusSPDelta) _lastStats.bonusSP = (_lastStats.bonusSP || 0) + patch.bonusSPDelta;
      let vipLeveled = false;
      if (patch.vipGramDelta) {
        let _vipLvl = _lastStats.vipLevel || 0;
        let _vipDep = (_lastStats.vipDeposited || 0) + patch.vipGramDelta;
        const _vipPend = Array.isArray(_lastStats.vipPending) ? [..._lastStats.vipPending] : [];
        const _prevVipLvl = _vipLvl;
        while (_vipLvl < 10 && _vipDep >= VIP_THRESHOLDS[_vipLvl + 1]) {
          _vipDep -= VIP_THRESHOLDS[_vipLvl + 1]; _vipLvl++; _vipPend.push(_vipLvl);
        }
        _lastStats.vipLevel = _vipLvl; _lastStats.vipDeposited = _vipDep; _lastStats.vipPending = _vipPend;
        vipLeveled = _vipLvl > _prevVipLvl;
        socket.data.vipLevel = _vipLvl;
        _setVipAura(authed.username, _vipLvl);
      }
      if (patch.clearVipPending) _lastStats.vipPending = [];
      _commitServerItems(inv, null, reason, meta, { beforeLen: _beforeLen });
      _persistSavedFields(authed, {
        gold: _lastStats.gold, bonusSP: _lastStats.bonusSP, vipLevel: _lastStats.vipLevel,
        vipDeposited: _lastStats.vipDeposited, vipPending: _lastStats.vipPending,
      });
      if (vipLeveled) {
        socket.emit('vipUpdate', {
          level: _lastStats.vipLevel, deposited: _lastStats.vipDeposited, pending: _lastStats.vipPending,
        });
      }
      return {
        gold: _lastStats.gold, bonusSP: _lastStats.bonusSP || 0, vipLevel: _lastStats.vipLevel || 0,
        vipDeposited: _lastStats.vipDeposited || 0, vipPending: _lastStats.vipPending || [], vipLeveled,
      };
    } finally {
      _itemOpBusy--;
    }
  };

  // Cross-socket craft delegate: craftGear/craftClassGear consume materials
  // with matching rules (minEnhance thresholds, rarity/salvage counts) that
  // don't fit the generic addItems/removeItems shape _applyGrant takes, so
  // instead of re-encoding that matching here, the caller passes in the exact
  // same removal closure it already built against its own (possibly stale)
  // inventory — it runs the same, just against whichever socket is actually
  // live. removeFn(inv) mutates in place; resultItem (or null on a failed
  // craft roll) is appended after.
  socket.data._applyCraftResult = (removeFn, resultItem, reason, meta) => {
    if (!authed || !_lastStats || !Array.isArray(_lastStats.inventory)) return { delivered: false };
    _itemOpBusy++;
    try {
      const inv = _lastStats.inventory;
      const _beforeLen = inv.length;
      removeFn(inv);
      const delivered = resultItem ? _invAdd(inv, resultItem) : true;
      if (delivered && resultItem) _recordOobGrant([resultItem]);
      _commitServerItems(inv, null, reason, meta, { beforeLen: _beforeLen });
      return { delivered };
    } finally {
      _itemOpBusy--;
    }
  };

  // Gold and/or skill points granted by an admin to a player who is online.
  // Both have to land in _lastStats, not just in the database: this
  // session's 60s autosave writes _lastStats wholesale, so a grant written
  // only to Mongo was reverted the next time that timer fired (most visibly
  // for a backgrounded mobile client, whose own save — which does carry the
  // grant, see the adminGive handler in js/network.js — may not come for a
  // long time). No double-counting: the client's next save replaces
  // _lastStats rather than adding to it. Used by both /admin/give-all (a
  // mass grant to every online account) and /admin/player/:tid/give (a
  // single account) — both fields move in one _persistSavedFields call so a
  // gold+SP grant sets them together.
  socket.data._adminGiveGoldSP = async (goldAmount, spAmount) => {
    if (!authed) return null;
    if (!_lastStats) _lastStats = {};
    const fields = {};
    if (Number.isFinite(goldAmount) && goldAmount !== 0) {
      _lastStats.gold = Math.max(0, (_lastStats.gold || 0) + goldAmount);
      fields.gold = _lastStats.gold;
    }
    if (Number.isFinite(spAmount) && spAmount !== 0) {
      _lastStats.bonusSP = (_lastStats.bonusSP || 0) + spAmount;
      fields.bonusSP = _lastStats.bonusSP;
    }
    if (!Object.keys(fields).length) return { gold: _lastStats.gold || 0, bonusSP: _lastStats.bonusSP || 0 };
    await _persistSavedFields(authed, fields);
    logPlayer(authed.telegramId, authed.username, 'admin_give_all_live',
      { gold: goldAmount, sp: spAmount, balance: _lastStats.gold, bonusSP: _lastStats.bonusSP });
    return { gold: _lastStats.gold || 0, bonusSP: _lastStats.bonusSP || 0 };
  };

  // Hands the death-battle winner its prize. Lives here rather than beside
  // _dbFinish because this is where the socket's own inventory/GRAM copies
  // are (same reasoning as pickupWorldDrop's award path). Returns the item
  // list so the caller can show it in the win modal, plus whether the prize
  // actually landed in the server-side inventory — see _commitServerItems.
  socket.data._dbGrantWin = async () => {
    if (!authed) return null;
    _itemOpBusy++;
    try {
      const items = deathBattleRewards();
      const _dbBal = await _incBalance(authed.telegramId, 'gramBalance', DEATH_BATTLE_GRAM_REWARD);
      if (_dbBal !== null) { _gramBalance = _dbBal; socket.emit('gramBalanceUpdate', { balance: _dbBal }); }
      // The account may have reconnected on a different socket during the
      // balance award above — this closure (`socket` here is whichever
      // socket _dbFinish resolved as the winner's live one AT THE TIME it
      // called this) can be stale by now. Apply the item reward against
      // whichever socket is the account's live session RIGHT NOW instead of
      // writing it through a closure nobody's client can see any more —
      // same race as marketCancel/marketBuy, see _applyGrant's comment.
      const _liveSid = activeSessions.get(authed.telegramId);
      const _target = _liveSid === socket.id ? socket : _socketForTelegramId(authed.telegramId);
      const _result = _target && _target.data._applyGrant
        ? _target.data._applyGrant({ addItems: items.map(it => ({ item: it })) }, 'death_battle_win',
            { items: items.map(i => i.id), gram: DEATH_BATTLE_GRAM_REWARD })
        : null;
      const _delivered = !!_result;
      if (!_delivered && items.length) {
        await _dbPushInventory(authed, items, 'death_battle_win');
      }
      logPlayer(authed.telegramId, authed.username, 'death_battle_win',
        { gram: DEATH_BATTLE_GRAM_REWARD, delivered: _delivered, crossSession: !!_target && _target !== socket });
      return { items, delivered: _delivered };
    } finally {
      _itemOpBusy--;
    }
  };

  // Pays out a 3v3 win. Lives on the socket for the same reason _dbGrantWin
  // does: Liberty is server-authoritative and its live value is in this
  // closure, not in whatever the DB last saw. Returns what was actually paid
  // so the result screen can't claim a reward that didn't land.
  socket.data._a3GrantWin = async () => {
    if (!authed) return 0;
    const _a3Bal = await _incBalance(authed.telegramId, 'nexumBalance', ARENA3_REWARD);
    if (_a3Bal !== null) _nexumBalance = _a3Bal;
    socket.emit('nexumBalanceUpdate', { balance: _liveNexum() });
    logPlayer(authed.telegramId, authed.username, 'arena3_reward',
      { nexum: ARENA3_REWARD, balance: _liveNexum() });
    return ARENA3_REWARD;
  };

  // Pays out a race10 finish. Unlike _a3GrantWin above this runs for EVERY
  // entrant who landed a hit on the boss, not only the winner — `won` picks
  // the tier (see race10Rewards/race10Liberty, shared/definitions.js).
  //
  // Items go through _applyGrant against whichever socket is the account's
  // live session right now, not through this closure: a three-minute race is
  // long enough that the account may have reconnected on a different socket
  // since _race10Finish resolved this one, and writing the prize through a
  // socket nobody's client is listening to would lose it. Same race
  // _dbGrantWin already handles; the _dbPushInventory fallback covers the
  // case where there is no live session at all.
  socket.data._race10GrantReward = async (won) => {
    if (!authed) return null;
    _itemOpBusy++;
    try {
      const nexum = race10Liberty(won);
      const items = race10Rewards(won);
      const _rcBal = await _incBalance(authed.telegramId, 'nexumBalance', nexum);
      if (_rcBal !== null) _nexumBalance = _rcBal;
      socket.emit('nexumBalanceUpdate', { balance: _liveNexum() });
      const _liveSid = activeSessions.get(authed.telegramId);
      const _target = _liveSid === socket.id ? socket : _socketForTelegramId(authed.telegramId);
      const _result = _target && _target.data._applyGrant
        ? _target.data._applyGrant({ addItems: items.map(it => ({ item: it })) }, 'race10_reward',
            { items: items.map(i => i.id), nexum })
        : null;
      const _delivered = !!_result;
      if (!_delivered && items.length) {
        await _dbPushInventory(authed, items, 'race10_reward');
      }
      logPlayer(authed.telegramId, authed.username, 'race10_reward',
        { won: !!won, nexum, balance: _liveNexum(), items: items.map(i => i.id), delivered: _delivered });
      return { nexum, items, delivered: _delivered };
    } finally {
      _itemOpBusy--;
    }
  };

  // Coop's fixed boss reward — 1 bless_stone (a "safe" enchant stone, i.e.
  // one that can't fail/break an attempt) + 100 Liberty, to whichever
  // participant _coopBossTrackKill (server/index.js) randomly picked. Same
  // cross-socket-safe shape as _race10GrantReward just above: _incBalance is
  // a DB-level atomic op (safe to call from another connection's context),
  // and the item goes through _applyGrant against whichever socket is the
  // account's LIVE session right now (it may have reconnected on a
  // different one since the run started), falling back to a raw DB push if
  // there is no live session at all.
  socket.data._grantCoopBossReward = async () => {
    if (!authed) return null;
    _itemOpBusy++;
    try {
      const nexum = 100;
      const stone = { ..._STONE_DEFS.bless_stone, qty: 1 };
      const _rcBal = await _incBalance(authed.telegramId, 'nexumBalance', nexum);
      if (_rcBal !== null) _nexumBalance = _rcBal;
      socket.emit('nexumBalanceUpdate', { balance: _liveNexum() });
      const _liveSid = activeSessions.get(authed.telegramId);
      const _target = _liveSid === socket.id ? socket : _socketForTelegramId(authed.telegramId);
      const _result = _target && _target.data._applyGrant
        ? _target.data._applyGrant({ addItems: [{ item: stone }] }, 'coop_boss_reward', { items: ['bless_stone'], nexum })
        : null;
      const _delivered = !!_result;
      if (!_delivered) await _dbPushInventory(authed, [stone], 'coop_boss_reward');
      logPlayer(authed.telegramId, authed.username, 'coop_boss_reward', { nexum, balance: _liveNexum(), delivered: _delivered });
      return { nexum, items: [stone], delivered: _delivered };
    } finally {
      _itemOpBusy--;
    }
  };

  const NEXUM_DROP_CHANCE = [0, 0.005, 0.01, 0.02, 0.03, 0.05];
  // Tiny GRAM trickle from regular kills: 7.5% chance, amount scales with the
  // monster's own level (rlvl) — a level-1 mob drops 0.000001 GRAM, a
  // level-2 mob 0.000002, and so on.
  const GRAM_DROP_CHANCE = 0.075;
  const GRAM_PER_LEVEL = 0.0000001;

  // calcBM (shared/anticheat.js) reads sd.atk/sd.def/sd.maxHp — the FULL,
  // gear-inclusive combat stats — but _buildSaveStats() (js/network.js)
  // never sends those fields at all, in any saveProgress call, ever; only
  // baseAtk/baseDef (pre-equipment) reach _sanitizeSavedStats. So calling
  // calcBM directly on _lastStats/clean silently treated atk/def as 0 for
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
    const stats = Room.computeStats(sd, cd, sd.type, clanAtkBonusPct(_myClanLevel));
    return { lvl: sd.lvl, upgrades: sd.upgrades, atk: stats.atk, def: stats.def, maxHp: stats.maxHp };
  }

  // Where this session currently is, for every persist path below. Used to be
  // written by the 60s autosave alone and by nothing else, so a player who
  // walked into an arm and dropped 10 seconds later had the HUB stored as
  // their floor — and _restoreFloorFor would faithfully put them back there.
  // The floor is only worth restoring if it is actually current, so every
  // write carries it: the periodic save, the debounced saveProgress, and the
  // final flush on disconnect.
  //
  // x/y ride along for the same reason the floor does. Landing on an arm's
  // entrance after every blip is better than landing in the hub, but it is
  // still not where the player was standing; the position is validated on the
  // way back out (see the restore in selectChar), never trusted blindly.
  function _wherePlayerIs() {
    const out = { floor: currentFloor };
    const p = currentRoom && currentRoom.players.get(socket.id);
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) { out.x = p.x; out.y = p.y; }
    return out;
  }

  function _startAutosave() {
    if (_autoSaveInterval) clearInterval(_autoSaveInterval);
    _autoSaveInterval = safeInterval('autosave', () => {
      if (!authed || !_lastStats) return;
      // Progress only. Balances are moved by $inc from their own paths and must
      // never be written as an absolute from here — that is precisely what let
      // a periodic save undo a credit that arrived seconds earlier.
      const saveData = { ..._lastStats, ..._wherePlayerIs() };
      if (currentRoom) {
        const p = currentRoom.players.get(socket.id);
        if (p && p.hp > 0) saveData.hp = p.hp;
      }
      const bmNow = calcBM(_bmStatsFor(_lastStats));
      authed.bm = bmNow;
      _persistSavedFields(authed, saveData, { bm: bmNow });
    }, 60000);
  }

  // Wraps every socket.on registration below so a thrown error or rejected
  // promise inside a single handler can't escape to process scope — the
  // global uncaughtException/unhandledRejection handler calls process.exit()
  // shortly after logging, which would otherwise drop every connected
  // player's connection over one bad packet in one handler.
  //
  // Logging is throttled per event. console.error is a SYNCHRONOUS write and
  // formatting an Error means building its stack string, so a client sending
  // malformed packets in a loop turned every one of them into blocking I/O on
  // the same thread the world loop runs on — a handful of junk clients could
  // stall the tick for everyone without ever tripping the rate limiter's
  // budget. One line per event per _ERR_LOG_MS says the same thing.
  const _ERR_LOG_MS = 5000;
  const _errLoggedAt = new Map();
  function _logHandlerErr(event, err) {
    const now = Date.now();
    const last = _errLoggedAt.get(event) || 0;
    if (now - last < _ERR_LOG_MS) return;
    _errLoggedAt.set(event, now);
    console.error(`[socket:${event}]`, err);
  }
  function safeOn(event, handler) {
    socket.on(event, (...args) => {
      // A client can send an explicit null where a handler expects a payload
      // object; `({ x } = {})` defaults only cover undefined, so normalise it
      // here and let those defaults do their job for both cases.
      if (args.length && args[0] === null) args[0] = undefined;
      try {
        const ret = handler(...args);
        if (ret && typeof ret.catch === 'function') {
          ret.catch(err => _logHandlerErr(event, err));
        }
      } catch (err) {
        _logHandlerErr(event, err);
      }
    });
  }

  safeOn('_ping', t0 => socket.emit('_pong', t0));

  // ── Shared login plumbing ──────────────────────────────────────────────
  // loginTelegramWebApp (Mini App) and loginTelegram (bot widget) differ only
  // in how they establish WHO is logging in; everything after that was two
  // byte-identical copies, which is how a fix to one of them could silently
  // miss the other.

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
    if (isMaintenanceOn() && telegramId !== TG_ADMIN_ID) {
      activeSessions.delete(telegramId);
      socket.emit('authError', { message: 'Ведутся технические работы. Попробуйте позже.' });
      return false;
    }
    authed = doc;
    clearTimeout(_authTimeout);
    socket.data.username = doc.username;
    socket.data.telegramId = telegramId;
    if (doc.savedData) _lastStats = doc.savedData;
    _setGram(doc.savedData?.gramBalance || 0);
    _setNexum(doc.savedData?.nexumBalance || 0);
    _startAutosave();
    socket.join(`tg_${telegramId}`);
    const _clan = await ClanModel.findOne({ 'members.telegramId': telegramId }).catch(() => null);
    const _clanInfo = _clan ? await _clanDataFor(_clan, telegramId) : null;
    _myClanName  = _clanInfo ? _clanInfo.name : null;
    _myClanIcon  = _clanInfo ? _clanInfo.icon : null;
    _myClanId    = _clan ? String(_clan._id) : null;
    _myClanLevel = _clanInfo ? _clanInfo.level : null;
    socket.data.vipLevel = doc.savedData?.vipLevel || 0;
    _setVipAura(doc.username, socket.data.vipLevel);
    socket.emit('authOk', { username: doc.username, savedData: doc.savedData || null, isNewAccount, clanInfo: _clanInfo, gramBalance: _gramBalance, gramWallet: GRAM_WALLET, refLink: _refLink(telegramId), vipData: { level: doc.savedData?.vipLevel || 0, deposited: doc.savedData?.vipDeposited || 0, pending: doc.savedData?.vipPending || [] }, nexumBalance: _nexumBalance, topPlayer: _topPlayerUsername, vipAuras: [..._vipAuraUsers] });
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

  // ── Кошелёк GRAM и магазины ───────────────────────────────────────────────
  // Deposits, withdrawals, the GRAM/seasonal/Special shops and the VIP bar they
  // feed all live in server/handlers/wallet.js. Registered further down, after
  // the season: a package carrying season points awards them through
  // season.addPoints, and `season` does not exist yet at this point in the file.
  // ── Reset stat upgrades (Улучшения → Сбросить) ─────────────────────────────
  // Costs Liberty, so the charge has to happen here: Liberty is the one
  // currency the client doesn't own the source of truth for (see craftPet
  // below for the same reasoning).
  //
  // Clearing player.upgrades is all a "refund" needs to be — spent points are
  // never stored, they're derived as skillPointBudget(lvl, rebirths) +
  // bonusSP minus the sum of the upgrade levels (getAvailableSkillPoints,
  // js/player.js). Emptying the map therefore hands back every point ever
  // put into it, however many that was.
  // Gold spent on those upgrades is deliberately not refunded.
  safeOn('resetUpgrades', async () => {
    if (!authed) return;
    _itemOpBusy++;
    let _ran;
    try {
    // Serialized like gramShopBuy/craftGear — spent is read here and the
    // upgrades map is only cleared after two awaits, so two resets sent in
    // the same tick both saw a nonzero spent, both charged UPGRADE_RESET_COST
    // (each atomically affordable on its own), and both then cleared the same
    // already-empty map: a real double-charge for a single reset. See
    // _withEconLock.
    _ran = await _withEconLock(async () => {
    try {
      const cur = (_lastStats && _lastStats.upgrades) || {};
      const spent = Object.values(cur).reduce((s, v) => s + (Number(v) || 0), 0);
      if (spent <= 0) {
        return socket.emit('resetUpgradesError', { msg: 'Улучшений нет — сбрасывать нечего' });
      }
      await _flushBalances();
      // Charged atomically: the write only happens if the balance covers the
      // cost, so the upgrades below are never cleared for free.
      const _bal = await _spendBalance(authed.telegramId, 'nexumBalance', UPGRADE_RESET_COST);
      if (_bal === null) {
        return socket.emit('resetUpgradesError', { msg: `Нужно ${UPGRADE_RESET_COST} Liberty` });
      }
      _nexumBalance = _bal;
      if (_lastStats) _lastStats.upgrades = {};
      // Keep the room's anti-cheat baseline in step, or its computeStats would
      // go on crediting the cleared upgrades until the next saveProgress.
      if (currentRoom) currentRoom.updatePlayerSavedData(socket.id, _lastStats);
      _persistSavedFields(authed, { upgrades: {} });
      logPlayer(authed.telegramId, authed.username, 'upgrades_reset',
        { pointsReturned: spent, cost: UPGRADE_RESET_COST });
      socket.emit('upgradesReset', { pointsReturned: spent, newNexumBalance: _nexumBalance });
    } catch (err) {
      console.error('resetUpgrades:', err);
      socket.emit('resetUpgradesError', { msg: 'Ошибка сервера' });
    }
    });
    } finally {
      _itemOpBusy--;
    }
    if (!_ran) socket.emit('resetUpgradesError', { msg: 'Операция уже выполняется' });
  });

  // Drinking a buff potion. Client-side until now: it removed the item and
  // wrote the timer into its own save. That was already an item write the
  // census had to cover, and it became load-bearing the moment gold and XP
  // started reading buffs.gold / buffs.exp to apply the x2 — a save claiming a
  // permanently active gold buff would have doubled every payout for good.
  //
  // The timer still ticks down on the client (js/game.js) for the HUD; what
  // matters here is that the server holds its own copy and only ever sets it
  // from a potion it watched being consumed.
  safeOn('useBuffPotion', ({ id } = {}) => {
    if (!authed || !_itemsFor()) return;
    if (_itemsBusy()) return _itemErr(_ITEMS_BUSY_MSG);
    const def = ITEM_DEF.find(d => d.id === id);
    if (!def || def.slot !== 'buff_potion' || !def.buffType) return;
    if (!_lastStats.buffs || typeof _lastStats.buffs !== 'object') _lastStats.buffs = {};
    if ((_lastStats.buffs[def.buffType] || 0) > 0) return _itemErr('Уже активно!');
    const inv = _lastStats.inventory;
    const beforeLen = inv.length;
    if (!_invRemove(inv, { id, qty: 1, slot: def.slot })) return _itemErr('Нет зелья');
    _lastStats.buffs[def.buffType] = def.buffDur || 1800;
    _persistSavedFields(authed, { buffs: _lastStats.buffs });
    _commitServerItems(inv, null, 'buff_potion', { id }, { beforeLen });
    logPlayer(authed.telegramId, authed.username, 'buff_potion', { id, type: def.buffType });
    socket.emit('buffSync', { buffs: _lastStats.buffs });
  });

  // ── Using a teleport stone (bought from the merchant, see buyTeleportStone
  // above) ─────────────────────────────────────────────────────────────────
  // Always recalls to the hub, after a TELEPORT_CAST_MS channel during which
  // the player is held still — _teleportCasting (module-level, above) is
  // what _pvpFrozen reads to enforce that, so movement/attacks are already
  // refused everywhere else in this file without a change to those handlers.
  // The stone is spent the instant the cast starts (not on completion): a
  // successful cast is the one thing this handler can guarantee, and gating
  // the spend on the setTimeout below firing would let a second tap start a
  // free second cast in the same window if the first stone hadn't been
  // deducted yet.
  safeOn('useTeleportStone', () => {
    if (!authed || !_itemsFor()) return;
    if (_itemsBusy()) return _itemErr(_ITEMS_BUSY_MSG);
    if (_teleportCastFrozen(socket.id)) return _itemErr('Уже произносится телепорт');
    if (currentFloor === FLOOR_IDS.hub) return _itemErr('Вы уже в зале');
    const inv = _lastStats.inventory;
    const beforeLen = inv.length;
    if (!_invRemove(inv, { id: 'teleport_stone', qty: 1, slot: 'material' })) {
      return _itemErr('Нет камня телепортации');
    }
    _commitServerItems(inv, null, 'teleport_stone_use', {}, { beforeLen });
    logPlayer(authed.telegramId, authed.username, 'teleport_stone_use', {});

    _teleportCasting.set(socket.id, Date.now() + TELEPORT_CAST_MS);
    socket.emit('teleportCastStarted', { ms: TELEPORT_CAST_MS });

    if (_teleportCastTimer) clearTimeout(_teleportCastTimer);
    _teleportCastTimer = setTimeout(() => {
      _teleportCastTimer = null;
      _teleportCasting.delete(socket.id);
      if (!authed || !currentRoom) return; // disconnected mid-cast
      _doEnterLocation('hub');
    }, TELEPORT_CAST_MS);
  });

  // The buff timers run down in real time. The client counts them for its own
  // HUD, but the server needs its own clock or a buff would last forever here —
  // which, for the gold and XP multipliers, is the whole exposure.
  const _buffTick = safeInterval('buffTick', () => {
    if (!_lastStats || !_lastStats.buffs) return;
    let changed = false;
    for (const [k, v] of Object.entries(_lastStats.buffs)) {
      const left = Math.max(0, (Number(v) || 0) - 5);
      if (left !== v) { _lastStats.buffs[k] = left; changed = true; }
      if (left <= 0) delete _lastStats.buffs[k];
    }
    if (changed) _persistSavedFields(authed, { buffs: _lastStats.buffs });
  }, 5000);

  // ── Quest progress ────────────────────────────────────────────────────────
  // claimQuest checked WHICH quest was being claimed but never whether it had
  // been done: the counters lived in the client's blob, so the server had
  // nothing to ask. A client could walk the whole 60-quest chain in one go.
  //
  // The server sees every event these counters are made of — kills, potion
  // purchases, clan membership, the corridor a kill happened in — so it counts
  // them itself, and the claim is checked against questComplete (shared, so the
  // button and the rule cannot disagree).
  function _questKills() {
    if (!_lastStats) return null;
    if (!_lastStats.questKills || typeof _lastStats.questKills !== 'object') _lastStats.questKills = {};
    return _lastStats.questKills;
  }

  // Only the CURRENT quest's counters are tracked, exactly as the client did:
  // a counter for a quest that isn't active yet would let a player arrive at it
  // already complete.
  function _currentQuest() {
    if (!_lastStats) return null;
    return QUEST_DEF[Math.max(0, Math.floor(Number(_lastStats.questIdx)) || 0)] || null;
  }

  function _questBump(key, by) {
    const k = _questKills();
    if (!k) return false;
    k[key] = Math.max(0, Math.floor(Number(k[key])) || 0) + (by || 1);
    return true;
  }

  // Pushes the counters and lets the client light up the claim button.
  function _questPush() {
    if (!_lastStats) return;
    socket.emit('questSync', { questIdx: _lastStats.questIdx || 0, questKills: _lastStats.questKills || {} });
  }

  // Called for every kill this session is credited for.
  function _questOnKill(eid, rlvl) {
    const q = _currentQuest();
    if (!q || !_questKills()) return;
    let changed = false;
    if ((q.type === 'kill' || q.type === 'kill_multi') && eid) {
      const def = ENEMY_DEF.find(e => e.eid === eid);
      // Matched on the base catalog name, the same string the quest lists and
      // the same one the client counted (the level prefix is display only).
      if (def && (q.enemies || []).includes(def.name)) changed = _questBump(def.name, 1);
    }
    // Legacy floor quests: with one seamless world there is no floor to walk
    // into, so reaching the corridor a kill happened in is what completes them
    // — the same rule the client applied in onEnterArm.
    if ((q.type === 'dungeon_clear' || q.type === 'goto_floor') && rlvl > 0) {
      const arm = armIndexForLevel(rlvl);
      if (q.type === 'dungeon_clear' && arm > q.floor) {
        const k = _questKills();
        if ((k['_dungeon_' + q.floor] || 0) < q.count) {
          k['_dungeon_' + q.floor] = q.count;
          changed = true;
        }
      }
      if (q.type === 'goto_floor' && arm >= q.targetFloor) {
        changed = _questBump('_floor_' + q.targetFloor, 1) || changed;
      }
    }
    if (changed) _questPush();
  }
  socket.data._questOnKill = (eid, rlvl) => _questOnKill(eid, rlvl);

  // ── Experience and level ──────────────────────────────────────────────────
  // The mirror image of gold. The server decided how much XP a kill was worth
  // and banked an entitlement for it (_allowXp), but the CLIENT applied the
  // clan bonus, the ×2 exp potion and the death penalty, added the result to
  // its own total, ran the level-up loop and reported the resulting level in
  // the next save. The ledger then checked afterwards whether that level was
  // reachable.
  //
  // Applying it here instead makes the level derivable, which is what lets the
  // ledger go: there is no claim left to audit.
  function _xpMult(base) {
    if (!(base > 0)) return 0;
    let x = base;
    const _cl = _myClanLevel ? CLAN_LEVELS[_myClanLevel - 1] : null;
    const clanPct = (_cl && _cl.bonus && _cl.bonus.xp) || 0;
    if (clanPct > 0) x = Math.round(x * (1 + clanPct / 100));
    const buffs = (_lastStats && _lastStats.buffs) || {};
    if (buffs.exp > 0) x *= 2;
    // Halving would floor a level-1 monster's single XP to zero — the penalty
    // must not be able to zero out a kill entirely, so it skips anything
    // already under 2. Identical to what gainXP did client-side.
    if (buffs.deathPenalty > 0 && x >= 2) x = Math.floor(x * 0.5);
    return Math.round(x);
  }

  // Credits XP, runs the level-up curve, and returns everything the client
  // needs to render the result. Levels raise the base stats by the same steps
  // the client used to apply, and computeStats (Room.js) reads them straight
  // out of _sd — so the room's idea of the player follows the level up without
  // waiting for a save.
  function _grantXp(base, opts) {
    if (!authed || !_lastStats) return null;
    const gained = (opts && opts.flat) ? Math.max(0, Math.round(Number(base) || 0)) : _xpMult(base);
    if (!(gained > 0)) return null;
    const before = Math.max(1, Math.floor(Number(_lastStats.lvl)) || 1);
    _lastStats.xp = Math.round((Number(_lastStats.xp) || 0) + gained);
    _lastStats.lvl = before;
    if (!Number.isFinite(Number(_lastStats.xpNext)) || _lastStats.xpNext <= 0) {
      _lastStats.xpNext = xpToNext(_lastStats.lvl);
    }
    while (_lastStats.xp >= _lastStats.xpNext && _lastStats.lvl < _SANITIZE_MAX.lvl) {
      _lastStats.xp = Math.round(_lastStats.xp - _lastStats.xpNext);
      _lastStats.lvl += 1;
      _lastStats.xpNext = xpToNext(_lastStats.lvl);
      _lastStats.baseAtk   = (Number(_lastStats.baseAtk)   || 0) + 1;
      _lastStats.baseDef   = (Number(_lastStats.baseDef)   || 0) + 1;
      _lastStats.baseMaxHp = (Number(_lastStats.baseMaxHp) || 0) + 20;
    }
    const levelled = _lastStats.lvl > before;
    if (levelled && currentRoom) {
      currentRoom.updatePlayerSavedData(socket.id, _lastStats);
      currentRoom.healPlayer(socket.id, 35 * (_lastStats.lvl - before));
      _persistSavedFields(authed, {
        lvl: _lastStats.lvl, xp: _lastStats.xp, xpNext: _lastStats.xpNext,
        baseAtk: _lastStats.baseAtk, baseDef: _lastStats.baseDef, baseMaxHp: _lastStats.baseMaxHp,
      });
      logPlayer(authed.telegramId, authed.username, 'level_up', { from: before, to: _lastStats.lvl });
    }
    return {
      gained, levelled,
      lvl: _lastStats.lvl, xp: _lastStats.xp, xpNext: _lastStats.xpNext,
      baseAtk: _lastStats.baseAtk, baseDef: _lastStats.baseDef, baseMaxHp: _lastStats.baseMaxHp,
    };
  }
  // A party member's share lands on their own session, for the same reason
  // their gold share does: their clan and their buffs are not visible here.
  socket.data._grantXp = (base, opts) => _grantXp(base, opts);

  // ── Gold ──────────────────────────────────────────────────────────────────
  // Gold was a client-side number. The server computed a kill's drop and sent
  // it, but the CLIENT applied the clan bonus and the ×2 potion on top, added
  // it to its own total, and reported the result in the next save. Merchant
  // purchases and the clan founding fee were deducted the same way — locally,
  // with the server never told the price.
  //
  // So the server had no idea what a player's balance should be, and the only
  // thing standing between that and an arbitrary figure was a rate guess (the
  // gold growth cap) that had to be loose enough never to punish a good farming
  // streak. Applying the multipliers here instead makes the total derivable,
  // which is what lets that cap go.
  function _goldNow() {
    return Math.max(0, Math.floor(Number(_lastStats && _lastStats.gold)) || 0);
  }

  // Credits gold and tells the client the new total. `reason` shows up in the
  // player log beside every other economic event.
  function _grantGold(amount, reason, opts) {
    if (!authed || !_lastStats || !(amount > 0)) return _goldNow();
    const before = _goldNow();
    const after = before + Math.floor(amount);
    _lastStats.gold = after;
    // Persisted on the ordinary save debounce rather than per kill: a kill is
    // the highest-frequency event in the game and a write per kill would be a
    // write per player per second. The debounce already covers a crash to
    // within a few seconds, which is the same window it always did.
    if (!(opts && opts.quiet)) socket.emit('goldSync', { gold: after });
    return after;
  }

  // Everything a kill's gold passes through before it lands, in the order the
  // client used to apply it: the VIP bonus is already folded into the figure
  // Room.js returns, then the clan's gold bonus, then the ×2 potion.
  function _killGold(base) {
    if (!(base > 0)) return 0;
    let g = base;
    const _cl = _myClanLevel ? CLAN_LEVELS[_myClanLevel - 1] : null;
    const clanPct = (_cl && _cl.bonus && _cl.bonus.gold) || 0;
    if (clanPct > 0) g = Math.round(g * (1 + clanPct / 100));
    if (((_lastStats && _lastStats.buffs) || {}).gold > 0) g *= 2;
    return Math.floor(g);
  }

  // Merchant: the only shop priced in gold. MERCHANT_SHOP and POTION_CAP are
  // shared (shared/definitions.js) precisely so the price charged here is the
  // one the button showed.
  safeOn('buyPotion', ({ idx, qty } = {}) => {
    if (!authed || !_lastStats) return;
    const entry = MERCHANT_SHOP[Math.floor(Number(idx))];
    if (!entry) return;
    const n = Math.max(1, Math.min(POTION_CAP, Math.floor(Number(qty)) || 1));
    if (!_lastStats.potionBag || typeof _lastStats.potionBag !== 'object') _lastStats.potionBag = {};
    const cur = Math.max(0, Math.floor(Number(_lastStats.potionBag[entry.itemId])) || 0);
    if (cur + n > POTION_CAP) return socket.emit('goldError', { msg: `Максимум ${POTION_CAP} зелий!` });
    const cost = entry.price * n;
    if (_goldNow() < cost) return socket.emit('goldError', { msg: 'Мало золота!' });
    _lastStats.gold = _goldNow() - cost;
    _lastStats.potionBag[entry.itemId] = cur + n;
    _persistSavedFields(authed, { gold: _lastStats.gold, potionBag: _lastStats.potionBag });
    logPlayer(authed.telegramId, authed.username, 'buy_potion', { id: entry.itemId, n, cost });
    socket.emit('goldSync', { gold: _lastStats.gold });
    socket.emit('potionBag', { potionBag: _lastStats.potionBag, bought: { id: entry.itemId, n } });
    // buy_potion quests count purchases, and this is the only place one happens.
    if (_currentQuest() && _currentQuest().type === 'buy_potion') { _questBump('_potion', n); _questPush(); }
  });

  // ── Buying teleport stones from the merchant (Liberty/Nexum) ───────────────
  // The one merchant purchase NOT priced in gold — Liberty is
  // server-authoritative only (see resetUpgrades/craftPet above for why), so
  // unlike buyPotion the charge and the grant both have to happen here rather
  // than trusting a client-side gold deduction. Mirrors craftPet's shape: an
  // atomic balance spend, then a deterministic item grant (no roll — a
  // purchase always delivers exactly the stones paid for).
  safeOn('buyTeleportStone', async ({ qty } = {}) => {
    if (!authed) return;
    const n = Math.max(1, Math.min(99, Math.floor(Number(qty)) || 1));
    _itemOpBusy++;
    let _ran;
    try {
    // Serialized like craftPet/resetUpgrades — the spend below is a DB round
    // trip, and two purchases overlapping across it would interleave their
    // inventory writes.
    _ran = await _withEconLock(async () => {
    try {
      if (!_lastStats || !Array.isArray(_lastStats.inventory)) {
        return socket.emit('teleportStoneError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
      }
      const mat = CRAFT_MATS.find(m => m.id === 'teleport_stone');
      if (!mat) return;
      if (!_invHasRoomFor(_lastStats.inventory, mat)) {
        return socket.emit('teleportStoneError', { msg: 'Инвентарь полон' });
      }
      const cost = TELEPORT_STONE_PRICE * n;

      // Atomic charge — the grant below only happens if the Liberty was
      // really taken, same reasoning as every other Liberty spend in this file.
      await _flushBalances();
      const _bal = await _spendBalance(authed.telegramId, 'nexumBalance', cost);
      if (_bal === null) return socket.emit('teleportStoneError', { msg: `Нужно ${cost} Liberty` });
      _nexumBalance = _bal;

      // Cross-session guard, same as craftPet's own: the spend above is a DB
      // round trip, and the account may have reconnected on a different
      // socket by the time it resolves.
      if (activeSessions.get(authed.telegramId) !== socket.id) {
        const _target = _socketForTelegramId(authed.telegramId);
        if (!_target || !_target.data._applyGrant) {
          // Nothing live to grant into. Refund rather than charge for stones
          // that cannot be delivered.
          const back = await _incBalance(authed.telegramId, 'nexumBalance', cost);
          if (back !== null) _nexumBalance = back;
          return socket.emit('teleportStoneError', { msg: 'Сессия недоступна — попробуйте ещё раз' });
        }
        const _res = _target.data._applyGrant(
          { addItems: [{ item: mat, qty: n }] }, 'teleport_stone_buy_cross_session', { qty: n, cost });
        _target.emit('teleportStoneBought', { qty: n, newNexumBalance: _nexumBalance, delivered: !!_res });
        return;
      }

      const _beforeLen = _lastStats.inventory.length;
      const _delivered = _invAdd(_lastStats.inventory, { ...mat, qty: n });
      _commitServerItems(_lastStats.inventory, null, 'teleport_stone_buy', { qty: n, cost }, { beforeLen: _beforeLen });
      logPlayer(authed.telegramId, authed.username, 'teleport_stone_buy', { qty: n, cost });
      socket.emit('teleportStoneBought', { qty: n, newNexumBalance: _nexumBalance, delivered: _delivered });
    } catch (err) {
      console.error('buyTeleportStone:', err);
      logPlayerErr(authed.telegramId, authed.username, 'teleport_stone_buy', err, { qty: n });
      socket.emit('teleportStoneError', { msg: 'Ошибка сервера' });
    }
    });
    } finally {
      _itemOpBusy--;
    }
    if (!_ran) socket.emit('teleportStoneError', { msg: 'Секунду, идёт другая операция — повторите' });
  });

  // ── Item placement (equip, unequip, storage) ──────────────────────────────
  // The last four item operations the CLIENT still decided for itself. Loot,
  // sales, crafts, enhancing, boxes, market and potions were already server
  // side; these four moved an item between inventory, an equipment slot and
  // the storage chest by editing the local arrays and letting the next
  // debounced save carry the result.
  //
  // That is what the whole item-census machinery exists to police: because a
  // save could rewrite the item set, the server had to work out afterwards
  // whether the rewrite was legitimate. Moving them here removes the writer,
  // and with it the need to police it — a move is now a request the server
  // performs on its own copy, and answers with inventorySync.
  //
  // Nothing here can create or destroy an item: each one takes it out of one
  // container and puts it in another, refusing when the destination is full.
  const SERVER_STORAGE_MAX = 200;   // matches storageHasSpace() in js/player.js

  function _itemsFor() {
    if (!_lastStats) return null;
    if (!Array.isArray(_lastStats.inventory)) _lastStats.inventory = [];
    if (!Array.isArray(_lastStats.storage))   _lastStats.storage = [];
    if (!_lastStats.equipment || typeof _lastStats.equipment !== 'object') _lastStats.equipment = {};
    return _lastStats;
  }
  function _itemErr(msg) { socket.emit('itemError', { msg }); }

  // True while an async handler that CLONES _lastStats.inventory before an
  // await (gramShopBuy/specialShopBuy/claimVipRewards — see _itemOpBusy's own
  // comment, above) is mid-flight. Every handler below moves an item into or
  // out of the SAME live inventory array synchronously; if one of those
  // clone-and-commit handlers is holding a snapshot taken before this runs,
  // this handler's own splice/push is invisible to it — and gets silently
  // discarded, or for a move INTO a slot (equip, an unequip landing back in
  // inventory), duplicated, since the item survives in both the stale clone
  // and its new home the instant that handler's delayed _commitServerItems
  // stamps the snapshot back over the live array. Refusing here for the
  // brief window _itemOpBusy is raised closes the race at the source rather
  // than trying to reconcile it after the fact.
  function _itemsBusy() { return _itemOpBusy > 0; }
  const _ITEMS_BUSY_MSG = 'Секунду, идёт другая операция — повторите';

  safeOn('equipItem', ({ idx } = {}) => {
    if (!authed || !_itemsFor()) return;
    if (_itemsBusy()) return _itemErr(_ITEMS_BUSY_MSG);
    const inv = _lastStats.inventory;
    const i = Math.floor(Number(idx));
    const it = (Number.isInteger(i) && i >= 0) ? inv[i] : null;
    if (!it) return;
    // A stackable or a consumable has no slot to occupy. The client greys
    // these out; that is advice until it is checked here.
    if (_isStackable(it) || it.slot === 'use' || !it.slot) return;
    if (Array.isArray(it.forClass) && _lastStats.type && !it.forClass.includes(_lastStats.type)) {
      return _itemErr('Этот предмет не для вашего класса');
    }
    const beforeLen = inv.length;
    const old = _lastStats.equipment[it.slot] || null;
    _lastStats.equipment[it.slot] = it;
    inv.splice(i, 1);
    // The displaced item goes back to the slot the new one just freed, so the
    // swap is always net-zero and can never need room it hasn't got.
    if (old) inv.push(old);
    _commitServerItems(inv, _lastStats.equipment, 'equip', { id: it.id, slot: it.slot }, { beforeLen });
  });

  safeOn('unequipItem', ({ slot } = {}) => {
    if (!authed || !_itemsFor()) return;
    if (_itemsBusy()) return _itemErr(_ITEMS_BUSY_MSG);
    const it = _lastStats.equipment[slot];
    if (!it) return;
    const inv = _lastStats.inventory;
    if (!_invHasRoomFor(inv, it)) return _itemErr('Инвентарь полон!');
    const beforeLen = inv.length;
    _lastStats.equipment[slot] = null;
    inv.push(it);
    _commitServerItems(inv, _lastStats.equipment, 'unequip', { id: it.id, slot }, { beforeLen });
  });

  // { [setId]: boolean[] } — one flag per slot of that set, true once the
  // slot's item has been consumed into it. Sparse: a set the player has never
  // touched simply has no key.
  function _codexFor() {
    if (!_lastStats) return null;
    if (!_lastStats.codex || typeof _lastStats.codex !== 'object' || Array.isArray(_lastStats.codex)) {
      _lastStats.codex = {};
    }
    return _lastStats.codex;
  }

  // Pushes the authoritative codex progress + its resulting stat bonus to the
  // client — same "server decides, client mirrors" shape as _pushProgress.
  function _pushCodex() {
    socket.emit('codexSync', { codex: _lastStats.codex, bonus: codexTotalBonus(_lastStats.codex) });
  }

  // Кодекс: наборы предметов. Registering consumes an owned item into ONE
  // specific slot of ONE specific set (see CODEX_SETS, shared/definitions.js)
  // — the same item id can be required by many different sets, and each one
  // needs its own copy, same as a real L2M item collection. Completing every
  // slot in a set folds its flat stat bonus into codexTotalBonus forever,
  // regardless of what's equipped or later sold.
  safeOn('registerCodexSetItem', ({ setId, slotIdx, idx } = {}) => {
    if (!authed || !_itemsFor()) return;
    if (_itemsBusy()) return _itemErr(_ITEMS_BUSY_MSG);
    const set = codexSetById(setId);
    if (!set) return;
    const si = Math.floor(Number(slotIdx));
    if (!Number.isInteger(si) || si < 0 || si >= set.slots.length) return;
    const codex = _codexFor();
    let filled = codex[setId];
    if (!Array.isArray(filled) || filled.length !== set.slots.length) filled = set.slots.map(() => false);
    if (filled[si]) return _itemErr('Этот слот набора уже заполнен');
    const inv = _lastStats.inventory;
    const i = Math.floor(Number(idx));
    const it = (Number.isInteger(i) && i >= 0) ? inv[i] : null;
    if (!it) return;
    if (!codexItemMeetsReq(it, set.slots[si])) return _itemErr('Этот предмет не подходит для выбранного слота набора');
    const beforeLen = inv.length;
    inv.splice(i, 1);
    filled[si] = true;
    codex[setId] = filled;
    _commitServerItems(inv, null, 'codex_register', { setId, slotIdx: si, id: it.id, enhance: it.enhance || 0 }, { beforeLen });
    _persistSavedFields(authed, { codex });
    _pushCodex();
  });

  // Inventory -> storage and back. Both are MOVES: the item is spliced out of
  // one array and merged into the other in a single handler, so the two halves
  // can never be observed apart the way they could when a save carried them.
  function _moveBetween(fromArr, toArr, idx, cap) {
    const i = Math.floor(Number(idx));
    const it = (Number.isInteger(i) && i >= 0) ? fromArr[i] : null;
    if (!it) return null;
    if (_isStackable(it)) {
      const existing = toArr.find(e => e && e.id === it.id);
      if (existing) {
        existing.qty = (existing.qty || 1) + (it.qty || 1);
        fromArr.splice(i, 1);
        return it;
      }
    }
    if (toArr.length >= cap) return 'full';
    fromArr.splice(i, 1);
    toArr.push(it);
    return it;
  }

  safeOn('storageDeposit', ({ idx } = {}) => {
    if (!authed || !_itemsFor()) return;
    if (_itemsBusy()) return _itemErr(_ITEMS_BUSY_MSG);
    const beforeLen = _lastStats.inventory.length;
    const res = _moveBetween(_lastStats.inventory, _lastStats.storage, idx, SERVER_STORAGE_MAX);
    if (res === 'full') return _itemErr('Хранилище полно!');
    if (!res) return;
    _commitServerItems(_lastStats.inventory, null, 'storage_in', { id: res.id }, { beforeLen, storage: true });
  });

  safeOn('storageWithdraw', ({ idx } = {}) => {
    if (!authed || !_itemsFor()) return;
    if (_itemsBusy()) return _itemErr(_ITEMS_BUSY_MSG);
    const beforeLen = _lastStats.inventory.length;
    const res = _moveBetween(_lastStats.storage, _lastStats.inventory, idx, SERVER_INV_MAX);
    if (res === 'full') return _itemErr('Инвентарь полон!');
    if (!res) return;
    _commitServerItems(_lastStats.inventory, null, 'storage_out', { id: res.id }, { beforeLen, storage: true });
  });

  // ── Навыки, пассивки и Перерождение ───────────────────────────────────────
  // All of it lives in server/handlers/progression.js, on the same `session`
  // object as the rest — the module that leans on session.lastStats hardest.
  require('./handlers/progression')({
    socket, safeOn, logPlayer, logPlayerErr, session,
    itemsBusy: _itemsBusy,
    beginItemOp: () => { _itemOpBusy++; },
    endItemOp: () => { _itemOpBusy--; },
    ITEMS_BUSY_MSG: _ITEMS_BUSY_MSG,
    commitServerItems: _commitServerItems,
    liveInventory: _liveInventory,
    persistSavedFields: _persistSavedFields,
    serverSpendGold: _serverSpendGold,
    withEconLock: _withEconLock,
  });

  // ── Сезон ─────────────────────────────────────────────────────────────────
  // The season's handlers live in server/handlers/season.js, on the same
  // `session` object the market and the forge use. Registered BEFORE the forge
  // because the forge spends points through season.addPoints; the state itself
  // is owned there and read back here through getters — the opposite direction
  // from the other two, see that file's header.
  const season = require('./handlers/season')({
    socket, safeOn, logPlayer, logPlayerErr, session,
    persistSavedFields: _persistSavedFields,
    seasonRollSpecies: _seasonRollSpecies,
    seasonTierAllowed: _seasonTierAllowed,
  });

  // ── Кузница (forge) ───────────────────────────────────────────────────────
  // The eight forge handlers — crafting, material tier-ups, box opening and
  // заточка — live in server/handlers/forge.js, on the same `session` object
  // the market uses. See that file's header.
  // ── Кошелёк GRAM и магазины ───────────────────────────────────────────────
  // See the note further up for why this is registered here rather than there.
  require('./handlers/wallet')({
    socket, safeOn, io, activeSessions, logPlayer, logPlayerErr,
    session, season,
    itemsBusy: _itemsBusy,
    beginItemOp: () => { _itemOpBusy++; },
    endItemOp: () => { _itemOpBusy--; },
    ITEMS_BUSY_MSG: _ITEMS_BUSY_MSG,
    commitServerItems: _commitServerItems,
    flushBalances: _flushBalances,
    liveGram: _liveGram,
    liveInventory: _liveInventory,
    incBalance: _incBalance,
    spendBalance: _spendBalance,
    setVipAura: _setVipAura,
    socketForTelegramId: _socketForTelegramId,
    withEconLock: _withEconLock,
    txData: _txData,
    notifyAdminGram,
  });

  require('./handlers/forge')({
    socket, safeOn, activeSessions, logPlayer, logPlayerErr,
    session,
    itemsBusy: _itemsBusy,
    beginItemOp: () => { _itemOpBusy++; },
    endItemOp: () => { _itemOpBusy--; },
    ITEMS_BUSY_MSG: _ITEMS_BUSY_MSG,
    commitServerItems: _commitServerItems,
    flushBalances: _flushBalances,
    withEconLock: _withEconLock,
    seasonAddPoints: season.addPoints,
    incBalance: _incBalance,
    spendBalance: _spendBalance,
    socketForTelegramId: _socketForTelegramId,
  });

  // ── Ground loot (event-boss drops) ────────────────────────────────────────
  // The claim itself is arbitrated inside the Room (one Map delete, so exactly
  // one player can win a given pile). Awarding is done here because this is
  // The client got position deltas for enemies it has no record of and is
  // asking for their full details. Rate-limited like any other client-driven
  // request; the room caps how many it will answer at once.
  // Fallback for a client that cannot fetch /api/world-map (a proxy eating the
  // request, a cache serving a 404 for a version this process no longer has).
  // Delivers the same buffer down the socket so the game still starts; the
  // normal path costs the server nothing per join and this one is rare.
  safeOn('worldMapInline', () => {
    const room = currentRoom || getRoom(currentFloor);
    if (room) socket.emit('worldMap', room.mapPayload);
  });

  safeOn('enemyResync', ({ ids } = {}) => {
    if (!currentRoom || !Array.isArray(ids)) return;
    currentRoom.resendEnemies(socket.id, ids);
  });


  // ── Приведи друга ─────────────────────────────────────────────────────────
  // Paid to the REFERRER when someone they invited reaches SEASON_REF_LEVEL.
  // The claim is the flag flip itself: only the update that actually changes
  // seasonRefPaid from unset to true goes on to pay, so two sessions racing
  // (or one player relogging) cannot collect twice. The flag lives on the
  // FRIEND's document because that is what "this friend has been counted"
  // is about — and _sanitizeSavedStats strips it from client saves, so the
  // friend cannot clear their own.
  //
  // Checked at most once per session: the level only ever goes up, so if it
  // is not there yet at login the next login will catch it.
  let _seasonRefChecked = false;
  async function _seasonCheckRefFriend() {
    if (_seasonRefChecked || !authed || !_lastStats || !seasonActive()) return;
    const lvl = Math.floor(Number(_lastStats.lvl)) || 1;
    if (lvl < SEASON_REF_LEVEL) return;
    _seasonRefChecked = true;
    try {
      const me = await PlayerModel.findOneAndUpdate(
        {
          _id: authed._id,
          referredBy: { $nin: [null, ''] },
          'savedData.seasonRefPaid': { $ne: true },
        },
        { $set: { 'savedData.seasonRefPaid': true } },
        { new: false, projection: { referredBy: 1 } },
      ).lean();
      if (!me || !me.referredBy) return;   // no referrer, or already paid
      const total = await _seasonAddPointsTo(me.referredBy, SEASON_REF_POINTS,
        'ref_lvl20', { friend: authed.username, lvl });
      if (total === null) return;
      // The referrer is usually a different session, and may be offline —
      // the room emit reaches every device they have open and is simply
      // dropped when there are none.
      io.to(`tg_${me.referredBy}`).emit('seasonRefBonus', {
        points: SEASON_REF_POINTS, friend: authed.username, total,
      });
    } catch (err) { console.error('_seasonCheckRefFriend:', err); }
  }
  socket.data._seasonCheckRefFriend = _seasonCheckRefFriend;

  // Top 50 by points, plus this player's own rank when they are not in it —
  // same shape (and same reasoning) as the BM rating above.
  safeOn('seasonRating', async () => {
    if (!authed) return;
    try {
      const rows = await PlayerModel.find(
        { 'savedData.seasonPoints': { $gt: 0 } },
        'username savedData.seasonPoints',
      ).sort({ 'savedData.seasonPoints': -1 }).limit(50).lean();
      const list = rows.map((p, i) => ({
        place: i + 1, username: p.username,
        points: Math.max(0, Math.floor(Number(p.savedData?.seasonPoints) || 0)),
      }));
      const mine = season.points;
      let myPlace = list.findIndex(r => r.username === authed.username) + 1;
      if (!myPlace && mine > 0) {
        myPlace = await PlayerModel.countDocuments({ 'savedData.seasonPoints': { $gt: mine } }) + 1;
      }
      socket.emit('seasonRatingData', {
        list, me: { username: authed.username, points: mine, place: myPlace || 0 },
        endAt: SEASON_END_AT, active: seasonActive(), prizes: SEASON_PRIZES,
      });
    } catch (err) { console.error('seasonRating:', err); }
  });

  // ── Сжигание ──────────────────────────────────────────────────────────────
  // Destroys gear outright for points — no gold, no materials back. Only the
  // rarities in SEASON_BURN_POINTS can be burned, and the rarity is re-read
  // from the catalog rather than taken from the entry, so a crafted request
  // cannot claim a common item is worth an uncommon's points.
  function _burnValue(it) {
    const base = it && _catalogBase(it.id);
    if (!base || isStackableItem(base)) return 0;
    return SEASON_BURN_POINTS[base.rarity] || 0;
  }

  // ── Addressing an inventory item the client tapped ────────────────────────
  // The client sends the slot INDEX it drew the item at, and destructive
  // handlers (burn, sell) used to index straight into the server's own array
  // with it. The two copies legitimately drift: every server-side splice
  // (craft materials, a market listing, a clan deposit) renumbers the server's
  // slots, and the client only catches up when the inventorySync that follows
  // arrives. A tap sent inside that window addressed a DIFFERENT item — and
  // for the burn path, which accepts any burnable rarity, that meant
  // destroying something the player never picked.
  //
  // So the request also carries WHAT the client thinks is there (id, plus
  // enhance for gear, where +0 and +9 of the same sword are different things
  // to own — the same identity scheme enhanceItem resolves by). The index is
  // used as a hint and verified; if it doesn't hold, the item is looked up by
  // identity instead, and only a request naming something the server doesn't
  // have at all is refused. `id` absent means a client from before this
  // change: fall back to the index alone so an open tab keeps working.
  // Returns an index, or -1.
  function _resolveInvIdx(inv, idx, id, enhance) {
    const i = Math.floor(Number(idx));
    const inRange = Number.isFinite(i) && i >= 0 && i < inv.length;
    if (id == null) return inRange ? i : -1;
    const wantEnh = Math.floor(Number(enhance));
    const _matches = it => it && it.id === id &&
      (!ENHANCEABLE_SLOTS.has(_itemSlotOf(it)) || !Number.isFinite(wantEnh) || (it.enhance || 0) === wantEnh);
    if (inRange && _matches(inv[i])) return i;
    return inv.findIndex(_matches);
  }

  safeOn('seasonBurn', async ({ idx, id, enhance } = {}) => {
    if (!authed) return;
    // _seasonAddPoints below is an await, and the re-check after it only
    // re-resolves the index WITHIN `inv` — it can't notice `inv` itself going
    // stale. A saveProgress landing in that window replaces _lastStats (and
    // its inventory array) wholesale; this handler is still holding the OLD
    // array, and the eventual _commitServerItems(inv, ...) would stamp it
    // back over the save's real one, discarding whatever the save legitimately
    // changed. Same hazard _itemOpBusy already closes for craftGear/etc.
    _itemOpBusy++;
    let _ran;
    try {
    _ran = await _withEconLock(async () => {
      try {
        if (!seasonActive()) return socket.emit('seasonBurnError', { msg: 'Сезон завершён' });
        const inv = _liveInventory();
        if (!inv) return socket.emit('seasonBurnError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
        const _beforeLen = inv.length;
        // By identity, not by raw index — see _resolveInvIdx. Burning is
        // irreversible, so addressing the wrong slot destroys the wrong item.
        const i = _resolveInvIdx(inv, idx, id, enhance);
        if (i < 0) {
          socket.emit('inventorySync', {
            inventory: inv, equipment: _lastStats.equipment || {},
          });
          logPlayer(authed.telegramId, authed.username, 'season_burn_desync', { idx, id, enhance });
          return socket.emit('seasonBurnError', { msg: 'Предмет не найден — список обновлён' });
        }
        const pts = _burnValue(inv[i]);
        if (!pts) return socket.emit('seasonBurnError', { msg: 'Этот предмет нельзя сжечь' });
        const burned = inv[i];
        // Points FIRST. The destruction used to be committed (and persisted)
        // before this await, so a failed points write — a DB blip, an
        // exhausted connection pool — burned the item for nothing. Awarding
        // first means the worst case is points credited for a burn that then
        // didn't happen, which the player can simply redo.
        const total = await season.addPoints(pts, 'burn', { itemId: burned.id, n: 1 });
        if (total === null) {
          return socket.emit('seasonBurnError', { msg: 'Не удалось начислить очки — попробуйте ещё раз' });
        }
        // Re-resolve after the await: the inventory can have moved under us.
        const j = _resolveInvIdx(inv, i, burned.id, burned.enhance);
        if (j < 0) return socket.emit('seasonBurnError', { msg: 'Предмет не найден — список обновлён' });
        inv.splice(j, 1);
        _commitServerItems(inv, null, 'season_burn', { itemId: burned.id, points: pts }, { beforeLen: _beforeLen });
        socket.emit('seasonBurned', { burned: 1, points: pts, total });
      } catch (err) {
        console.error('seasonBurn:', err);
        logPlayerErr(authed.telegramId, authed.username, 'season_burn', err, { idx });
        socket.emit('seasonBurnError', { msg: 'Ошибка сервера' });
      }
    });
    } finally {
      _itemOpBusy--;
    }
    if (!_ran) socket.emit('seasonBurnError', { msg: _ITEMS_BUSY_MSG });
  });

  // Bulk form — burning a full inventory one tap at a time is not a real
  // option. Equipped items are untouched: this only ever walks the inventory.
  safeOn('seasonBurnAll', async ({ rarity } = {}) => {
    if (!authed) return;
    // Same hazard as seasonBurn above: a saveProgress landing during the
    // _seasonAddPoints await would replace _lastStats.inventory wholesale,
    // and this handler is still holding the OLD array in `inv` — closing the
    // window with _itemOpBusy is what makes the "re-checked because the await
    // above is a window" comment below actually complete, rather than only
    // covering moves within the same array.
    _itemOpBusy++;
    let _ran;
    try {
    _ran = await _withEconLock(async () => {
      try {
        if (!seasonActive()) return socket.emit('seasonBurnError', { msg: 'Сезон завершён' });
        if (!SEASON_BURN_POINTS[rarity]) return socket.emit('seasonBurnError', { msg: 'Эту редкость нельзя сжечь' });
        const inv = _liveInventory();
        if (!inv) return socket.emit('seasonBurnError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
        const _beforeLen = inv.length;
        // Counted first, destroyed only once the points have actually landed —
        // same reasoning as the single burn above, and it matters more here
        // because one call can consume a whole rarity's worth of gear.
        const _victims = [];
        let pts = 0;
        for (let i = inv.length - 1; i >= 0; i--) {
          const it = inv[i];
          const base = it && _catalogBase(it.id);
          if (!base || base.rarity !== rarity) continue;
          const v = _burnValue(it);
          if (!v) continue;
          _victims.push(i); pts += v;
        }
        if (!_victims.length) return socket.emit('seasonBurnError', { msg: 'Нечего сжигать' });
        const total = await season.addPoints(pts, 'burn_all', { rarity, n: _victims.length });
        if (total === null) {
          return socket.emit('seasonBurnError', { msg: 'Не удалось начислить очки — попробуйте ещё раз' });
        }
        // Indices were collected high-to-low, so splicing in that order stays
        // valid. Each one is re-checked because the await above is a window in
        // which the inventory can have changed.
        let burned = 0;
        for (const i of _victims) {
          const it = inv[i];
          const base = it && _catalogBase(it.id);
          if (!base || base.rarity !== rarity) continue;
          inv.splice(i, 1);
          burned++;
        }
        _commitServerItems(inv, null, 'season_burn_all', { rarity, burned, points: pts }, { beforeLen: _beforeLen });
        socket.emit('seasonBurned', { burned, points: pts, total });
      } catch (err) {
        console.error('seasonBurnAll:', err);
        logPlayerErr(authed.telegramId, authed.username, 'season_burn_all', err, { rarity });
        socket.emit('seasonBurnError', { msg: 'Ошибка сервера' });
      }
    });
    } finally {
      _itemOpBusy--;
    }
    if (!_ran) socket.emit('seasonBurnError', { msg: _ITEMS_BUSY_MSG });
  });

  // ── Story quest reward ────────────────────────────────────────────────────
  // The reward used to be handed out entirely client-side (js/quests.js's
  // claimQuest added the gold and pushed the items into its own inventory,
  // reaching the server only through the next saveProgress). That stopped
  // working the moment the save path refused to let a client's item list
  // grow — the reward potions were rejected as forged and the player simply
  // lost them, which is what the save_items_forged entries for bp_hp were.
  //
  // Progress itself stays client-tracked (questKills lives in the save blob
  // and nothing server-side counts it), so this is not a completion check —
  // it is a grant. What it does own is the part that mints value: the reward
  // comes from QUEST_DEF here, not from the client, and questIdx is what
  // makes it once-only. A client can still claim a quest it hasn't finished,
  // exactly as before; it cannot claim one twice, claim out of order, or
  // choose its own reward.
  safeOn('claimQuest', ({ idx } = {}) => {
    if (!authed) return;
    if (!_lastStats || !Array.isArray(_lastStats.inventory)) {
      return socket.emit('questClaimError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
    }
    if (_itemsBusy()) return socket.emit('questClaimError', { msg: _ITEMS_BUSY_MSG });
    const cur = Math.max(0, Math.floor(Number(_lastStats.questIdx)) || 0);
    // The claim names the quest it means, so a save still in flight can't
    // make this grant the NEXT quest's reward by accident.
    //
    // A mismatch is NOT necessarily an attempt at anything — the usual cause
    // is the client never hearing the questClaimed that advanced this
    // counter (a disconnect right after the grant, a reload mid-flight). The
    // client then sits on the old index and re-sends it forever, and refusing
    // without saying what the real index is left the player permanently
    // unable to claim anything again. So the refusal carries the
    // authoritative counter and the client catches up from it.
    const want = Math.floor(Number(idx));
    if (!Number.isFinite(want) || want !== cur) {
      socket.emit('questSync', { questIdx: cur, questKills: _lastStats.questKills || {} });
      logPlayer(authed.telegramId, authed.username, 'quest_claim_desync', { sent: want, server: cur });
      return socket.emit('questClaimError', {
        msg: want < cur ? 'Награда уже получена — список обновлён' : 'Прогресс квестов обновлён — попробуйте снова',
      });
    }
    const q = QUEST_DEF[cur];
    if (!q) return socket.emit('questClaimError', { msg: 'Квест не найден' });
    // Was it actually done? This is the check that was missing: the index said
    // WHICH quest, never whether it had been finished, so a client could claim
    // the whole chain in sequence without playing it.
    if (!questComplete(q, _questKills(), _lastStats.lvl)) {
      logPlayer(authed.telegramId, authed.username, 'quest_claim_incomplete', { questId: q.id, idx: cur });
      socket.emit('questSync', { questIdx: cur, questKills: _lastStats.questKills || {} });
      return socket.emit('questClaimError', { msg: 'Квест ещё не выполнен' });
    }

    const inv = _lastStats.inventory;
    const _beforeLen = inv.length;
    const rewardIds = Array.isArray(q.reward.items) ? q.reward.items : [];
    const rewardDefs = rewardIds
      .map(id => ITEM_DEF.find(d => d.id === id) || CRAFT_MATS.find(d => d.id === id) || BOX_DEF.find(d => d.id === id))
      .filter(Boolean);
    // Room for the WHOLE reward before anything is claimed. This used to push
    // each item with _invAdd and ignore the refusal — on a full inventory the
    // reward items were dropped one by one while questIdx advanced anyway,
    // which made them unrecoverable (the claim can never be replayed: see the
    // index check above). Same "refuse up front" rule the crafts and the shop
    // already follow. Stackables that merge into an existing entry cost no
    // slot, so they are counted the way _invAdd would actually place them.
    {
      let _need = 0;
      const _willStack = new Set();
      for (const def of rewardDefs) {
        if (_isStackable(def) && (inv.some(i => i && i.id === def.id) || _willStack.has(def.id))) {
          _willStack.add(def.id);
          continue;
        }
        if (_isStackable(def)) _willStack.add(def.id);
        _need++;
      }
      if (inv.length + _need > SERVER_INV_MAX) {
        logPlayer(authed.telegramId, authed.username, 'quest_reward_refused',
          { questId: q.id, idx: cur, need: _need, slots: `${inv.length}/${SERVER_INV_MAX}` });
        return socket.emit('questClaimError', {
          msg: `Нужно ${_need} свободных мест в инвентаре (занято ${inv.length}/${SERVER_INV_MAX})`,
        });
      }
    }
    const items = [];
    rewardDefs.forEach(def => {
      if (_invAdd(inv, { ...def, qty: 1 })) items.push({ id: def.id, name: def.name, rarity: def.rarity });
    });
    const gold = Math.max(0, Math.floor(Number(q.reward.gold)) || 0);
    if (gold) _lastStats.gold = Math.max(0, (_lastStats.gold || 0) + gold);
    // Advancing here is what closes the replay: a second claim finds
    // questIdx already past this quest and is refused above. questKills is
    // reset for the same reason the client resets it — the next quest counts
    // from zero.
    _lastStats.questIdx = cur + 1;
    _lastStats.questKills = {};
    _commitServerItems(inv, null, 'quest_reward', { questId: q.id, idx: cur, gold, items: items.map(i => i.id) }, { beforeLen: _beforeLen });
    _persistSavedFields(authed, { gold: _lastStats.gold, questIdx: _lastStats.questIdx, questKills: {} });
    logPlayer(authed.telegramId, authed.username, 'quest_reward', { questId: q.id, idx: cur, gold, xp: q.reward.xp || 0 });
    // Quest XP is a fixed reward, so it is granted flat: the kill multipliers
    // (clan, potion, death penalty) deliberately do not apply to it, exactly as
    // gainXP's old `flat` path did not apply them client-side.
    const _qxp = _grantXp(Math.max(0, Math.floor(Number(q.reward.xp)) || 0), { flat: true });
    socket.emit('questClaimed', {
      idx: cur, questId: q.id, gold, xp: _qxp ? _qxp.gained : 0,
      items, newGold: _lastStats.gold, questIdx: _lastStats.questIdx,
    });
    if (_qxp) socket.emit('xpSync', _qxp);
  });

  // ── Selling a common item to the merchant ─────────────────────────────────
  // Used to be entirely client-side (js/ui.js's sellCommonItem removed the
  // item and added the gold locally, reaching the server only through the
  // next saveProgress). The item half of that was already covered once the
  // save path stopped accepting item growth, but the gold half was a plain
  // faucet — and with the ceiling now bounding gold, a client-side credit
  // would be clamped away and the player would lose the sale. So the whole
  // transaction moves here.
  const SELL_COMMON_PRICE = 100;
  safeOn('sellItem', async ({ idx, id, enhance } = {}) => {
    if (!authed) return;
    const _ran = await _withEconLock(async () => {
      try {
        const inv = _liveInventory();
        if (!inv) return socket.emit('sellItemError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
        const _beforeLen = inv.length;
        // By identity rather than by raw index — see _resolveInvIdx. The
        // rarity check below already stopped this selling anything but a
        // common, but "a common, just not the one tapped" was still possible
        // while the two copies were briefly renumbered differently.
        const i = _resolveInvIdx(inv, idx, id, enhance);
        if (i < 0) {
          socket.emit('inventorySync', {
            inventory: inv, equipment: _lastStats.equipment || {},
          });
          logPlayer(authed.telegramId, authed.username, 'sell_desync', { idx, id, enhance });
          return socket.emit('sellItemError', { msg: 'Предмет не найден — список обновлён' });
        }
        const it = inv[i];
        if (!it) return;
        // Re-derived from the catalog rather than read off the entry, so the
        // price can't be unlocked for a rarity that isn't actually sellable.
        const base = _catalogBase(it.id);
        if (!base || base.rarity !== 'common' || isStackableItem(base)) {
          return socket.emit('sellItemError', { msg: 'Этот предмет нельзя продать' });
        }
        inv.splice(i, 1);
        if (!_lastStats) _lastStats = {};
        _lastStats.gold = Math.max(0, (_lastStats.gold || 0) + SELL_COMMON_PRICE);
            _commitServerItems(inv, null, 'sell_common', { itemId: it.id, gold: SELL_COMMON_PRICE }, { beforeLen: _beforeLen });
        await _persistSavedFields(authed, { gold: _lastStats.gold });
        socket.emit('itemSold', { gold: SELL_COMMON_PRICE, newGold: _lastStats.gold });
      } catch (err) {
        console.error('sellItem:', err);
        logPlayerErr(authed.telegramId, authed.username, 'sell_common', err, { idx });
        socket.emit('sellItemError', { msg: 'Ошибка сервера' });
      }
    });
    if (!_ran) socket.emit('sellItemError', { msg: _ITEMS_BUSY_MSG });
  });

  // where _lastStats — the server's own inventory copy — lives; same pattern
  // as the market, so a dropped worldDropTaken event or a disconnect mid-
  // pickup can't lose the item.
  safeOn('pickupWorldDrop', ({ id } = {}) => {
    if (!authed || !id || !currentRoom) return;
    const p = currentRoom.players.get(socket.id);
    if (!p || p.hp <= 0) return;
    // Left on the floor rather than claimed: a clone-and-commit handler
    // (gramShopBuy/specialShopBuy/claimVipRewards) holding a stale inventory
    // snapshot would silently erase this pickup the moment it commits — see
    // _itemsBusy. The drop stays put for the brief window that takes, same
    // as the room-full refusal below.
    if (_itemsBusy()) return socket.emit('worldDropError', { msg: _ITEMS_BUSY_MSG });
    const inv = (_lastStats && Array.isArray(_lastStats.inventory)) ? _lastStats.inventory : null;
    // Peek at the pile first: a full inventory must be rejected BEFORE the
    // claim consumes it, otherwise the item is destroyed instead of staying
    // on the floor for someone else — same ordering as the market's buy path.
    const peek = currentRoom.worldDrops.get(id);
    if (!peek) return;
    // Exactly the condition _invAdd would refuse on, checked BEFORE the claim
    // consumes the pile: a stackable only rides in for free when a stack of
    // it already exists, so one with no existing stack needs a slot just like
    // a non-stackable does. Testing only the non-stackable case (as this used
    // to) meant a stackable drop landing on a full inventory was claimed off
    // the floor and then dropped on the way in — destroyed rather than left
    // for someone else. The client used to paper over that by adding it
    // locally on delivered:false, which is precisely the kind of client-side
    // grant the save path no longer accepts.
    //
    // A session with no inventory loaded at all (no selectChar yet) is
    // refused for the same reason rather than being let through: the `inv &&`
    // in front of the old check skipped it, so claimWorldDrop below consumed
    // the pile off the floor — removing it for everyone — and then had
    // nowhere to put it. Leaving the drop where it is costs nothing; there is
    // no second chance once it's claimed.
    if (!inv) return socket.emit('worldDropError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
    if (!_invHasRoomFor(inv, peek.item)) {
      return socket.emit('worldDropError', { msg: 'Инвентарь полон' });
    }
    const drop = currentRoom.claimWorldDrop(id, p.x, p.y);
    if (!drop) return;
    const _beforeLen = inv.length;
    const _delivered = _invAdd(inv, drop.item);
    if (_delivered) {
      _commitServerItems(inv, null, 'world_drop', { item: drop.item && drop.item.id }, { beforeLen: _beforeLen });
    } else {
      // Unreachable via the check above; logged rather than silent so that if
      // it ever does happen there is a record naming the item.
      logPlayer(authed.telegramId, authed.username, 'world_drop_noroom',
        { item: drop.item && drop.item.id, slots: inv.length });
    }
    socket.emit('worldDropPicked', { id: drop.id, item: drop.item, delivered: _delivered });
  });

  // ── Market ────────────────────────────────────────────────────────────────
  // The six market handlers live in server/handlers/market.js. First cut into
  // this closure, so the shape is new: what crosses the boundary is a `session`
  // object of LIVE accessors over the variables below, not their values. See
  // that file's header for why each one is an accessor and not a copy.
  require('./handlers/market')({
    socket, safeOn, io, activeSessions, logPlayer, logPlayerErr,
    session,
    liveGram: _liveGram,
    itemsBusy: _itemsBusy,
    beginItemOp: () => { _itemOpBusy++; },
    endItemOp: () => { _itemOpBusy--; },
    ITEMS_BUSY_MSG: _ITEMS_BUSY_MSG,
    commitServerItems: _commitServerItems,
    flushBalances: _flushBalances,
    dbPushInventory: _dbPushInventory,
    incBalance: _incBalance,
    spendBalance: _spendBalance,
    setVipAura: _setVipAura,
    socketForTelegramId: _socketForTelegramId,
  });


  safeOn('getPvpHistory', async () => {
    if (!authed) return;
    try {
      const rows = await PvpHistoryModel.find({ telegramId: authed.telegramId })
        .sort({ at: -1 }).limit(PVP_HISTORY_KEEP).lean();
      socket.emit('pvpHistoryResult', {
        history: rows.map(r => ({ kind: r.kind, mode: r.mode, opponent: r.opponent, at: r.at })),
      });
    } catch (err) { console.error('getPvpHistory:', err); }
  });

  safeOn('getReferrals', async () => {
    if (!authed) return;
    try {
      const referrals = await PlayerModel.find({ referredBy: authed.telegramId }, 'username telegramId').lean();
      // Sum bonuses paid to this referrer from GramTx (confirmed deposits of their referrals × 5%)
      const bonusMap = {};
      if (referrals.length) {
        const refIds = referrals.map(r => r.telegramId);
        const deposits = await GramTxModel.find({
          telegramId: { $in: refIds },
          type: 'deposit',
          status: 'confirmed',
        }, 'telegramId amount').lean();
        for (const d of deposits) {
          bonusMap[d.telegramId] = (bonusMap[d.telegramId] || 0) + Math.round(d.amount * 0.05 * 100) / 100;
        }
      }
      const friends = referrals.map(r => ({ username: r.username, bonus: bonusMap[r.telegramId] || 0 }));
      socket.emit('refData', { friends, refLink: _refLink(authed.telegramId) });
    } catch (err) { console.error('getReferrals:', err); }
  });

  safeOn('getRating', async ({ tab }) => {
    try {
      if (tab === 'players') {
        const rows = (await _ratingPlayers()).slice();
        // If current player not in top-50, find their rank and append. Not
        // part of the shared cached table — it is this player's own row.
        const myUsername = authed?.username;
        const inTop = rows.some(r => r.username === myUsername);
        if (!inTop && authed) {
          const myRank = await PlayerModel.countDocuments({ bm: { $gt: authed.bm || 0 } }) + 1;
          rows.push({
            username: myUsername,
            bm: authed.bm || 0,
            level: (_lastStats?.lvl) || authed.savedData?.lvl || authed.savedData?.level || 1,
            rank: myRank,
            isSelf: true,
            gap: true,
          });
        }
        socket.emit('ratingData', { tab: 'players', rows });
      } else {
        socket.emit('ratingData', { tab: 'clans', rows: await _ratingClans() });
      }
    } catch (err) { console.error('getRating:', err); }
  });

  safeOn('claimVipRewards', async () => {
    if (!authed) return;
    if (_itemsBusy()) return _itemErr(_ITEMS_BUSY_MSG);
    _itemOpBusy++;
    let _ran;
    try {
    // Serialized: vipPending is read here and only cleared after an await, so
    // two claims in one tick both saw the same pending list and each handed
    // out the full item set. See _withEconLock.
    _ran = await _withEconLock(async () => {
    try {
      const doc = await PlayerModel.findById(authed._id);
      if (!doc) return;
      const saved = doc.savedData || {};
      const pending = Array.isArray(saved.vipPending) ? [...saved.vipPending] : [];
      if (!pending.length) return;
      const charClass = saved.type || 'lev';
      // Live copy first, same reason as gramShopBuy: a fresh DB read lags the
      // saveProgress debounce by up to ~3s and would roll back recent pickups.
      const _liveInv = _liveInventory();
      // Entries are CLONED, not just the array. A shallow [...inv] shares every
      // item object with the live inventory, so the `existing.qty += n` merges
      // below were landing in _lastStats immediately — including on the paths
      // that then bail out with "nothing was consumed" (claimVipRewards'
      // outOfRoom refusal), which left a grant half-applied to a purchase that
      // never happened. Cloning keeps this a scratch copy until it is committed.
      const inv = _liveInv ? _liveInv.map(i => (i && typeof i === 'object' ? { ...i } : i))
        : (Array.isArray(saved.inventory) ? saved.inventory.map(i => (i && typeof i === 'object' ? { ...i } : i)) : []);
      let goldReward = 0;
      let outOfRoom = false;
      // Mirrors what actually gets pushed/merged into inv below — used to
      // replay the same grant against a different socket if the account
      // reconnected elsewhere during the DB awaits above (see below).
      const _addedItems = [];
      for (const vipLvl of pending) {
        const items = _vipLevelItems(vipLvl, charClass);
        for (const item of items) {
          if (item.slot === 'weapon') {
            // Room check — this used to push unconditionally, which is how
            // accounts got pushed over the client's 150-slot cap; past it
            // invHasSpace() is false forever, so drops stop being picked up
            // and market cancellations start destroying their item.
            if (inv.length >= SERVER_INV_MAX) { outOfRoom = true; break; }
            inv.push({ ...item });
            _addedItems.push({ item });
          } else {
            const ex = inv.find(i => i.id === item.id);
            if (ex) ex.qty = (ex.qty || 1) + (item.qty || 1);
            else {
              if (inv.length >= SERVER_INV_MAX) { outOfRoom = true; break; }
              inv.push({ ...item });
            }
            _addedItems.push({ item, qty: item.qty || 1 });
          }
        }
        if (outOfRoom) break;
        goldReward += _vipGoldReward(vipLvl);
      }
      // Nothing is consumed on failure: vipPending is left intact so the
      // rewards stay claimable once the player frees up space.
      if (outOfRoom) {
        logPlayer(authed.telegramId, authed.username, 'vip_rewards_refused',
          { levels: pending, slots: `${inv.length}/${SERVER_INV_MAX}` });
        return socket.emit('gramShopError', {
          msg: `Инвентарь полон (${inv.length}/${SERVER_INV_MAX}) — освободите место и заберите награды снова`,
        });
      }
      // The account may have reconnected on a different socket during the
      // findById/updateOne awaits above — inv here was built off a snapshot
      // that predates whatever the REAL live session has done since. Same
      // race as marketCancel/marketBuy (see _applyGrant's comment): replay
      // the same additions against whichever socket is live now instead of
      // writing this stale snapshot through a dead one.
      const _liveSid = activeSessions.get(authed.telegramId);
      if (_liveSid !== socket.id) {
        const _target = _socketForTelegramId(authed.telegramId);
        const _result = _target && _target.data._applyGrant
          ? _target.data._applyGrant(
              { addItems: _addedItems, goldDelta: goldReward, clearVipPending: true },
              'vip_rewards', { levels: pending, gold: goldReward })
          : null;
        if (!_result) {
          // Gold and the vipPending reset stay in one update with the items:
          // clearing pending separately would risk clearing it for a push that
          // never landed. The over-cap check _dbPushInventory does for the
          // other fallbacks is run after it, on the same figure.
          await PlayerModel.updateOne({ _id: authed._id }, {
            $push: { 'savedData.inventory': { $each: _addedItems.map(({ item, qty }) => ({ ...item, ...(qty != null ? { qty } : {}) })) } },
            ...(goldReward > 0 ? { $inc: { 'savedData.gold': goldReward } } : {}),
            $set: { 'savedData.vipPending': [] },
          }).catch(() => {});
          const _after = await PlayerModel.findById(authed._id, { 'savedData.inventory': 1 }).lean().catch(() => null);
          const _len = Array.isArray(_after?.savedData?.inventory) ? _after.savedData.inventory.length : null;
          if (_len !== null && _len > SERVER_INV_MAX) {
            logPlayer(authed.telegramId, authed.username, 'inv_over_cap',
              { reason: 'vip_rewards_cross_session', slots: _len, cap: SERVER_INV_MAX, added: _addedItems.length });
          }
        }
        logPlayer(authed.telegramId, authed.username, 'vip_rewards_cross_session',
          { levels: pending, gold: goldReward, delivered: !!_result, hadLiveSocket: !!_target });
        if (_target) _target.emit('vipRewardsClaimed', { newInventory: inv, goldAdded: goldReward, vipPending: [] });
        return;
      }
      if (goldReward > 0) saved.gold = (saved.gold || 0) + goldReward;
      saved.inventory  = inv;
      saved.vipPending = [];
      // Targeted $set (see the matching comment in gramShopBuy) — a full
      // savedData overwrite here would revert any other field this account's
      // own gameplay autosave wrote in the same window.
      const _vipSet = { 'savedData.inventory': inv, 'savedData.vipPending': [] };
      if (goldReward > 0) _vipSet['savedData.gold'] = saved.gold;
      await PlayerModel.updateOne({ _id: doc._id }, { $set: _vipSet });
      if (_lastStats && goldReward > 0) _lastStats.gold = saved.gold;
      _commitServerItems(inv, null, 'vip_rewards', { levels: pending, gold: goldReward });
      socket.emit('vipRewardsClaimed', { newInventory: inv, goldAdded: goldReward, vipPending: [] });
    } catch (err) {
      console.error('claimVipRewards:', err);
      logPlayerErr(authed.telegramId, authed.username, 'vip_rewards', err);
    }
    });
    } finally {
      _itemOpBusy--;
    }
    if (!_ran) _itemErr(_ITEMS_BUSY_MSG);
  });

  safeOn('selectChar', ({ type, savedStats }) => {
    if (!authed) return;
    // This handler replaces _lastStats wholesale further down — the same
    // thing saveProgress does, and the same thing saveProgress is gated
    // against _itemOpBusy for: a clone-and-commit handler mid-flight is
    // holding a snapshot of the OLD object, and its commit lands on the new
    // one, discarding whatever the re-read brought in.
    //
    // Only a REPEAT selection is refused. currentRoom is null until this
    // handler assigns it, so a first join — the only one that can't have an
    // item op in flight anyway, since nothing has run yet — is untouched and
    // login can never be blocked by this. A duplicate arriving while the
    // player is already in the world simply leaves them where they are.
    if (currentRoom && _itemsBusy()) return _itemErr(_ITEMS_BUSY_MSG);
    // authed.savedData is the DB-loaded record for this account (single save
    // blob, not per-type slots). If the client sent no savedStats — e.g. it
    // raced a fast refresh before its own savedData snapshot arrived — fall
    // back to the server's copy instead of leaving _lastStats unset, which
    // would let the next debounced saveProgress persist fresh/default stats
    // over real progress.
    //
    // A blank blob used to be a hazard here — a fresh makePlayer() sent by a
    // reconnect that raced ahead of its own restore would become _lastStats and
    // poison the baseline for the rest of the connection. Every field that
    // mattered is now taken from the stored record below regardless of what
    // arrived, so a blank blob simply has nothing to poison.
    const sanitized = _sanitizeSavedStats(savedStats || null);
    const effectiveSaved = sanitized || _sanitizeSavedStats(authed.savedData || null);
    // This blob becomes _lastStats, which is the BASELINE every later
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
      const _dbBase = _sanitizeSavedStats(authed.savedData) || null;
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
      // bonusSP/rebirths/upgrades are pinned here too, and BEFORE the rebase
      // below, not after: a reconnect's savedStats (_buildSaveStats, js/
      // network.js) never carries these fields at all, so leaving them to the
      // client blob left them undefined/zero for the rest of the session —
      // and the next autosave (clean.bonusSP/rebirths/upgrades further down)
      // wrote that zero straight over the real stored totals. Pinning them
      // before the rebase also means the upgrades-budget check inside
      // _sanitizeSavedStats validates the real upgrades against the real
      // bonusSP/rebirths/level, instead of clearing them for failing a budget
      // computed off fields that were never actually sent.
      effectiveSaved.bonusSP   = Math.max(0, Math.floor(Number(_dbBase && _dbBase.bonusSP)) || 0);
      effectiveSaved.rebirths  = Math.max(0, Math.floor(Number(_dbBase && _dbBase.rebirths)) || 0);
      effectiveSaved.upgrades  = (_dbBase && _dbBase.upgrades) || {};
      const _rebasedLvl = _sanitizeSavedStats(effectiveSaved);
      effectiveSaved.baseAtk   = _rebasedLvl.baseAtk;
      effectiveSaved.baseDef   = _rebasedLvl.baseDef;
      effectiveSaved.baseMaxHp = _rebasedLvl.baseMaxHp;
      effectiveSaved.xpNext    = _rebasedLvl.xpNext;
      effectiveSaved.upgrades  = _rebasedLvl.upgrades;
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
      // bonusSP/rebirths above (see saveProgress's matching pin, further down
      // this file, for why — usePotion spends the bag and persists
      // immediately, and completeSpecialQuest's own once-only DB guard is
      // meaningless if a later save can write its record back). This block
      // used to leave all of them to whatever the client's blob happened to
      // carry, so a reconnect
      // (or a fresh tab reading an older localStorage snapshot) that raced
      // ahead of its own last potion purchase/use sent a bag one or more
      // potions short — and because saveProgress persists _lastStats.potionBag
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
      effectiveSaved.specialQuestsDone = Array.isArray(authed.savedData && authed.savedData.specialQuestsDone)
        ? authed.savedData.specialQuestsDone : [];
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
      });
      socket.emit('codexSync', { codex: effectiveSaved.codex, bonus: codexTotalBonus(effectiveSaved.codex) });
      _lastStats = effectiveSaved;
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
    // Season state is read straight off the stored record. It is never part of
    // the client blob — the sanitizer strips both fields so they can't be
    // written by the people competing for the prize — so this is the only
    // point at which it enters the session.
    season.hydrate(authed.savedData);
    // A friend invited by someone else may have crossed level 20 while this
    // session was away; the check is a no-op below that level and runs at most
    // once per session.
    _seasonCheckRefFriend();
    // Persist the chosen character type immediately so a page refresh
    // before the first full saveProgress doesn't show the char select again.
    PlayerModel.updateOne(
      { telegramId: authed.telegramId },
      { $set: { 'savedData.type': type } }
    ).catch(() => {});
    if (!currentRoom) {
      // A held Fear run (see _fearDisconnectGrace, above) lives on ITS OWN
      // private Room now (_createFearRoom), not a shared floor lookup —
      // getRoom(FLOOR_IDS.fear) only ever returns the harmless, always-empty
      // static entry every floor gets at boot, never a real run's instance.
      // currentFloor's initial value is always the hub (every fresh
      // connection starts there), so without this a reconnecting session
      // would land on the hub instead, and never find its way back to the
      // room actually holding its run. loginTelegramWebApp/selectChar are two
      // separate round trips, so by the time this runs the stale socket's
      // own 'disconnect' handler (which populates _fearDisconnectGrace) has
      // had a full network round trip to complete — reliable in practice,
      // and the worst case if it somehow hasn't is the same as any other
      // missed reconnect window: the run just times out normally.
      const _fearHeld = _fearDisconnectGrace.get(authed.telegramId);
      // Everything else comes back to the floor it was standing on — see
      // _restoreFloorFor, which re-checks the level gate and any window rather
      // than trusting the stored number, and falls back to the hub when the
      // floor is no longer somewhere this account may be. Read off the DB
      // record, never off `savedStats`: that blob is the client's. Coop has
      // no equivalent hold to reclaim into (see _coopEjectOnDisconnect) — a
      // reconnecting Coop participant just lands wherever the restore above
      // sends them, same as anyone else whose run already ended.
      if (_fearHeld) currentFloor = FLOOR_IDS.fear;
      else currentFloor = _restoreFloorFor((authed.savedData || {}).floor, effectiveSaved && effectiveSaved.lvl);
      currentRoom = _fearHeld ? _fearHeld.run.room : getRoom(currentFloor);
      // The instance may have been swept out of _fearRooms while this player
      // was away (it had no players for the length of the drop) — put it
      // back so /health and the shutdown pass can see it again.
      if (_fearHeld) _trackFearRoom(currentRoom);
      playerFloorMap.set(socket.id, currentFloor);
      // See _doEnterLocation's identical guard: Fear/Coop players never join
      // the shared floor_<id> broadcast group, since each is alone (or, for
      // Coop, paired) on its own private Room.
      if (currentFloor !== FLOOR_IDS.fear && currentFloor !== FLOOR_IDS.coop && currentFloor !== FLOOR_IDS.farmZone2) socket.join(`floor_${currentFloor}`);
      const { staleSocketId, fearCarry } = currentRoom.addPlayer(socket.id, authed.username, _myClanName, _myClanIcon, clanAtkBonusPct(_myClanLevel), authed.telegramId, _myClanId);
      // Anything this account had signed up for before the drop comes back
      // onto this socket, in the position it signed up at. Unconditional: the
      // registration survives the disconnect now (see the 'disconnect'
      // handler), so this is the only thing that reconnects it to a live
      // socket, and the gameStart built further down already reports the
      // restored registered:… flags because of it.
      _reclaimQueues(authed.telegramId, socket.id);
      // Back to the exact spot, not just the right floor — but only when the
      // stored floor is the one actually being restored (an arm's coordinates
      // land far outside the hub's own grid) and the spot is still standable.
      // Anything else keeps addPlayer's spawn placement. Fear is excluded:
      // its grace path re-deploys into the held hall itself, a stricter
      // placement than this (Coop isn't restorable at all — see
      // _RESTORABLE_FLOORS — so it never reaches this branch either way).
      if (!_fearHeld) {
        const _sd = authed.savedData || {};
        if (Number(_sd.floor) === currentFloor && currentRoom.canStandAt(_sd.x, _sd.y)) {
          const _me = currentRoom.players.get(socket.id);
          if (_me) { _me.x = _sd.x; _me.y = _sd.y; }
        }
      }
      // A stale room entry for this same account (see addPlayer's comment)
      // was just dropped — tell other clients immediately instead of waiting
      // for that old socket's own (possibly delayed) disconnect to do it, so
      // this account never briefly renders as two players on screen.
      if (staleSocketId) {
        socket.to(`floor_${currentFloor}`).emit('playerLeft', { id: staleSocketId });
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
        _pvpEliminate(staleSocketId, undefined, undefined, { fearGrace: true, telegramId: authed.telegramId });
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
        _partyHoldOnDisconnect(staleSocketId, authed.telegramId);
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
        const g = _fearDisconnectGrace.get(authed.telegramId);
        if (g) {
          clearTimeout(g.timer);
          _fearDisconnectGrace.delete(authed.telegramId);
          _fear.set(socket.id, g.run);
          // Disconnected during the pre-wave countdown (see
          // FEAR_START_DELAY_MS): the setTimeout that would have started
          // wave 1 was scheduled against the now-dead old socketId and no
          // longer applies (its own guard confirms this and no-ops) — start
          // the wave right here instead, immediately rather than resuming a
          // countdown no client is around to display. currentRoom is the
          // fear floor's Room at this point (currentFloor was forced to it
          // above specifically because this account had a hold to reclaim).
          if (g.run.wave === 0) _fearStartWave(currentRoom, socket.id, g.run.lane, 1);
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
      const _pg = _partyDisconnectGrace.get(authed.telegramId);
      if (_pg) {
        clearTimeout(_pg.timer);
        _partyDisconnectGrace.delete(authed.telegramId);
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
      socket.to(`floor_${currentFloor}`).emit('playerJoined', { id: socket.id, username: authed.username });
      if (globalChatHistory.length) socket.emit('chatHistory', _publicChatHistory());
    }
    currentRoom.setPlayerChar(socket.id, type, effectiveSaved);
    socket.to(`floor_${currentFloor}`).emit('playerChar', { id: socket.id, type });
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
    const _selfP = currentRoom.players.get(socket.id);
    socket.emit('gameStart', _buildGameStartPayload(socket, currentRoom, currentFloor));
    // MUST come after gameStart: its client handler rebuilds otherPlayers from
    // scratch (`otherPlayers = new Map()`), so a roster delivered before it was
    // wiped on arrival and nobody ever saw anyone else's pet.
    // Whole roster to the arriving player, their own pet to everyone else —
    // same shape both ways, so a missed update self-heals on the next join.
    socket.emit('playerPets', { pets: currentRoom.petSnapshot() });
    if (_selfP && _selfP.petId) {
      socket.to(`floor_${currentFloor}`).emit('playerPet', { id: socket.id, petId: _selfP.petId });
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
    // above, which pinned _lastStats to the stored record but never told the
    // client — leaving it to resend the rejected set on every later save.
    //
    // Always sent: the join blob no longer carries an item set at all
    // (_buildSaveStats, js/network.js), so there is nothing to compare it
    // against. This used to be conditional on a census comparison purely to
    // avoid echoing an identical inventory back down on every mobile
    // reconnect — a cost that disappeared with the upward copy.
    if (_lastStats) {
      socket.emit('inventorySync', {
        inventory: _lastStats.inventory || [],
        equipment: _lastStats.equipment || {},
        storage:   _lastStats.storage   || [],
      });
    }
  });

  // Real floor transition — replaces the old client-only _teleportTo trick
  // (js/game.js) for the hub's arm pads, and (as the special zones split off
  // the hub one by one, see server/game/floors.js) their pads too: the player
  // leaves their current floor's Room entirely and joins a different one,
  // with its own grid/enemies/NPCs, instead of just being repositioned
  // inside a shared grid. `target` is an arm key ('left'/'top'/'bottom'/
  // 'right'), a special-zone key ('guildWar', …), 'hub', or (force-only, see
  // below) a raw numeric floor id.
  //
  // Factored out of the socket handler (rather than living inline in it) so
  // code OUTSIDE this connection — a scheduled window closing, a match
  // ending — can also move this specific player between floors. Every other
  // per-connection escape hatch in this file follows the same shape: a
  // closure assigned onto socket.data (see _grantXp, _questOnKill, …) so a
  // handler elsewhere can call back into a connection it doesn't otherwise
  // have a reference to.
  //
  // `force` skips every gate (level/window/reachability) and accepts a raw
  // floor id as `target` — this is what a trusted server-initiated move
  // (an eviction, a death-battle deploy or its return-to-wherever-you-were)
  // needs: those are not requests that can be refused, they are the server
  // telling this connection where it has already decided the player goes.
  // The plain client-facing 'enterLocation' handler below never sets it.
  //
  // `pos`, when given, overrides the landing spot after the normal join
  // (which otherwise always lands on the target floor's own default spawn/
  // zone placement) — used only by the death battle's "send this entrant
  // back to the exact spot they were standing in before" return path.
  function _doEnterLocation(target, { force = false, pos, room = null } = {}) {
    if (!authed || !currentRoom) return false;
    const oldP = currentRoom.players.get(socket.id);
    if (!oldP || !oldP.type) return false; // no character selected yet
    let targetFloor;
    if (force && typeof target === 'number') {
      targetFloor = target;
    } else if (target === 'hub') {
      targetFloor = FLOOR_IDS.hub;
    } else if (target === 'guildWar') {
      // Combat access follows the daily window, not a level — see _gw
      // (phase 'live' only 22:00-22:15 MSK).
      if (!force && _gw.phase !== 'live') { socket.emit('enterLocationDenied', { target, reason: 'closed' }); return false; }
      targetFloor = FLOOR_IDS.guildWar;
    } else if (target === 'arena') {
      // Reachable while a world boss is up (or its loot still lies on the
      // floor) — see _arenaOpen. Death Battle deploys entrants with
      // force:true regardless, since registering for it has nothing to do
      // with whether a world boss happens to be up at the same time.
      if (!force && !_arenaOpen()) { socket.emit('enterLocationDenied', { target, reason: 'closed' }); return false; }
      targetFloor = FLOOR_IDS.arena;
    } else if (target === 'farmZone2') {
      // Элитная фарм-зона has no walk-in pad — this floor's monsters are
      // baked in at world-gen (unlike Fear/Coop's runtime-spawned ones), so
      // an ordinary enterLocation landing here directly would find a fully
      // populated, functional zone with no party-of-3/leader/daily-minutes
      // gating ever having run. The only sanctioned way in is
      // farm2GroupStart, which calls this with force:true — a plain client
      // request always gets denied, same "no equivalent to a walk-in pad"
      // deal Fear/Coop's own floors have (their own generic branch below
      // would technically also accept a bare request, they just never spawn
      // anything for it to find).
      if (!force) { socket.emit('enterLocationDenied', { target, reason: 'partyOnly' }); return false; }
      targetFloor = FLOOR_IDS.farmZone2;
    } else if (FLOOR_IDS[target] != null) {
      // Server-side level gate — the pad's own lock icon is client-side
      // decoration only, this is the check that actually matters. Фарм-зона
      // used to only ever be checked client-side (FARM_ENTRY_LEVEL, shared/
      // definitions.js) — folded into the same map as the arms' own
      // ARM_LEVEL_REQ now that entry is a real gated floor transition too.
      const req = _ZONE_LEVEL_REQ[target] || 0;
      const lvl = (oldP._sd && oldP._sd.lvl) || 1;
      if (!force && lvl < req) { socket.emit('enterLocationDenied', { target, reason: 'level', req }); return false; }
      targetFloor = FLOOR_IDS[target];
    } else {
      return false; // unknown target
    }
    if (targetFloor === currentFloor) return false; // already there

    const oldFloor = currentFloor;
    const charType = oldP.type;
    const savedStats = oldP._sd;

    // Fear/Coop players never join the shared floor_<id> broadcast group —
    // each Fear entrant (and each Coop pair) is on its own private Room now
    // (see _createFearRoom/_createCoopRoom), so there is never anyone else
    // legitimately on that floor id to tell about a join/leave/char change,
    // and joining them all into one group would leak exactly that across
    // otherwise-isolated runs. Skipping the join means every
    // socket.to(`floor_${currentFloor}`) broadcast below is already a no-op
    // for Fear/Coop on their own — nothing else here needs to know the
    // difference.
    if (oldFloor !== FLOOR_IDS.fear && oldFloor !== FLOOR_IDS.coop && oldFloor !== FLOOR_IDS.farmZone2) socket.leave(`floor_${oldFloor}`);
    // Walking out of Страх ends the run, exactly as dying in it does.
    //
    // Only two things used to end a run: clearing wave FEAR_MAX_WAVE and
    // dying (_fearFinish / _fearEliminate). Leaving the floor any other way —
    // the player choosing a destination from the map, or an event window
    // closing and force-moving them — took them off the fear floor and left
    // the _fear record behind. That record is what every later fearEnter
    // checks first, and it returns SILENTLY on a hit: the player is standing
    // in the hub, the button does nothing at all, no error is shown, and
    // their remaining attempts are never spent. It reads as "попытки в Страх
    // не уходят", and only for the players who happen to leave that way —
    // anyone who dies or clears the run is unaffected.
    //
    // Released before removePlayer, for the reason spelled out in
    // _fearFinish: removePlayer holds a still-owned lane open on the 45s
    // reconnect grace, which is meant for a genuine disconnect and not for
    // someone who deliberately walked out.
    //
    // A real disconnect does NOT come through here — it goes to
    // _fearHoldOnDisconnect and keeps its grace window, which is the whole
    // point of the distinction.
    if (oldFloor === FLOOR_IDS.fear && _fearReleaseRun(socket.id)) {
      // The client mirrors this state in page-level JS (_fearInRun,
      // js/network.js) and would otherwise keep drawing the wave HUD for a
      // run that no longer exists. attemptsLeft is deliberately omitted —
      // it costs a DB read and the client keeps its previous value for any
      // field this event leaves out.
      socket.emit('fearState', {
        maxAttempts: FEAR_ATTEMPTS, maxWave: FEAR_MAX_WAVE, minLevel: FEAR_MIN_LEVEL,
        inRun: false, wave: 0,
      });
    }
    // Same reasoning as Fear's own block just above, for Сотрудничество —
    // walking off the coop floor any other way than clearing/dying also has
    // to end the run, and (there being no way to continue with only one of
    // the two) end it for the partner too. This function is only already
    // moving THIS connection, so the partner has to be redirected home
    // explicitly rather than left mid-lane forever waiting on a stage that
    // can now never clear.
    if (oldFloor === FLOOR_IDS.coop) {
      const run = _coop.get(socket.id);
      if (run) {
        const partnerId = run.partnerId;
        _coopReleaseRun(socket.id);
        if (partnerId && _coop.has(partnerId)) _coopFinish(partnerId, false);
        socket.emit('coopState', {
          maxAttempts: COOP_ATTEMPTS, maxStage: COOP_STAGE_LEVELS.length, minLevel: COOP_MIN_LEVEL,
          inRun: false, stage: 0,
        });
      }
    }
    // Same reasoning as Coop's own block just above, generalized from
    // exactly-2 to "fewer than FARM2_PARTY_SIZE still in" — walking off the
    // Элитная фарм-зона floor any other way than the run's own end also has
    // to end this connection's own membership, and cascades to whoever else
    // is still in via _farm2CascadeCheck (self already excluded, since
    // _farm2ReleaseRun above already removed it from `_farm2`).
    if (oldFloor === FLOOR_IDS.farmZone2) {
      const run = _farm2.get(socket.id);
      if (run) {
        const { room, participantIds } = run;
        _farm2ReleaseRun(socket.id);
        _farm2CascadeCheck(room, participantIds);
        socket.emit('farm2State', {
          entryLevel: FARM2_ENTRY_LEVEL, partySize: FARM2_PARTY_SIZE, dailyMinutes: FARM2_DAILY_MINUTES,
          inRun: false,
        });
      }
    }
    currentRoom.removePlayer(socket.id);
    socket.to(`floor_${oldFloor}`).emit('playerLeft', { id: socket.id });

    currentFloor = targetFloor;
    playerFloorMap.set(socket.id, currentFloor);
    if (currentFloor !== FLOOR_IDS.fear && currentFloor !== FLOOR_IDS.coop && currentFloor !== FLOOR_IDS.farmZone2) socket.join(`floor_${currentFloor}`);
    // `room`, when given, is a fresh private instance this connection just
    // created (fearEnter) — the ordinary getRoom(floorId) lookup only ever
    // returns the one shared Room per floor, which Fear no longer has one of.
    currentRoom = room || getRoom(currentFloor);
    currentRoom.addPlayer(socket.id, authed.username, _myClanName, _myClanIcon, clanAtkBonusPct(_myClanLevel), authed.telegramId, _myClanId);
    currentRoom.setPlayerChar(socket.id, charType, savedStats);
    // Guild War: spread fresh entrants across the spawn ring instead of
    // landing everyone on the same tile — the same placement a mid-window
    // death respawn already uses (Room.guildWarRespawn).
    if (target === 'guildWar') currentRoom.guildWarRespawn(socket.id);
    const _joined = currentRoom.players.get(socket.id);
    if (pos && _joined) { _joined.x = pos.x; _joined.y = pos.y; }
    socket.to(`floor_${currentFloor}`).emit('playerJoined', { id: socket.id, username: authed.username });
    socket.to(`floor_${currentFloor}`).emit('playerChar', { id: socket.id, type: charType });

    socket.emit('gameStart', _buildGameStartPayload(socket, currentRoom, currentFloor));
    socket.emit('playerPets', { pets: currentRoom.petSnapshot() });
    const _selfP2 = currentRoom.players.get(socket.id);
    if (_selfP2 && _selfP2.petId) {
      socket.to(`floor_${currentFloor}`).emit('playerPet', { id: socket.id, petId: _selfP2.petId });
    }
    // 'enter_zone' quests (currently just "Войди в Фарм-зону") complete the
    // instant the transition actually lands — unlike goto_floor's legacy
    // kill-triggered proxy (there's no monster-level curve to hook into for
    // a zone that isn't part of the arm progression), this fires directly
    // off the real event.
    {
      const q = _currentQuest();
      if (q && q.type === 'enter_zone' && q.zone === target) {
        if (_questBump('_zone_' + target, 1)) _questPush();
      }
    }
    return true;
  }
  socket.data._forceEnterLocation = (target, opts) => _doEnterLocation(target, { ...opts, force: true });

  safeOn('enterLocation', ({ target } = {}) => { _doEnterLocation(target); });

  // Compact position update: [x*2, y*2, facingIndex, hp] — see netSendMove in
  // js/network.js for why it is an array of half-pixel integers rather than an
  // object or a binary payload. 'playerMove' below is the same thing in the
  // old shape, kept so a client that has not reloaded since the deploy keeps
  // moving normally.
  safeOn('mv', a => {
    if (!currentRoom || !Array.isArray(a)) return;
    // 5th element is new (moving flag) — a[4] is undefined against an older
    // client's 4-element packet, which _applyMove treats as "unknown, leave
    // whatever we already had" rather than stomping it to false.
    _applyMove(a[0] / 2, a[1] / 2, NC_FACING[a[2]] || 'front', a[3], a.length > 4 ? !!a[4] : undefined);
  });

  safeOn('playerMove', ({ x, y, facing, hp, moving } = {}) => {
    _applyMove(x, y, facing, hp, moving);
  });

  function _applyMove(x, y, facing, hp, moving) {
    if (!currentRoom) return;
    // Frozen entrants stay exactly where they were dropped. Facing/hp still
    // sync so the countdown doesn't look like a frozen screen.
    if (_pvpFrozen(socket.id)) {
      if (hp != null && isFinite(hp)) currentRoom.syncPlayerHp(socket.id, hp);
      return;
    }
    currentRoom.updatePlayerPos(socket.id, x, y, facing, moving);
    if (hp != null && isFinite(hp)) currentRoom.syncPlayerHp(socket.id, hp);
  }

  // The КАРТА panel draws the player's whole current arm, which is far wider
  // than the enemy stream's interest radius — so while it's open the room
  // sends a coarse dot list for it (Room._broadcastMapBlips). Off by default
  // and off again the moment the panel closes: it's the one feed still
  // proportional to the world's whole enemy count.
  safeOn('mapView', ({ open } = {}) => {
    if (currentRoom) currentRoom.setMapOpen(socket.id, !!open);
  });

  // ── HP potion ─────────────────────────────────────────────────────────────
  // `amount` is validated as a real number before it goes anywhere near hp.
  // Math.min('x', 200) is NaN, and NaN assigned to hp is permanent: every
  // damage path writes Math.max(0, NaN - dmg) === NaN back, and `hp <= 0` is
  // false for NaN — so one malformed packet made a player unkillable until
  // respawn, which is worth real money in the death battle/arena/tower.
  //
  // That validation was the whole of it, and it wasn't enough. healPlayer
  // (Room.js) is deliberately NOT gated by MAX_HP_REGEN_PER_SEC — the rate
  // limit that stops a client simply reporting full hp on every movement
  // packet — because real heals are supposed to arrive through here. So this
  // event was a full-heal button with no cooldown, no cost and no proof the
  // player owned a potion, sitting in the loose rate-limit bucket (1500 per
  // 5s). Spamming it made a character unkillable in exactly the modes that
  // pay out real GRAM/Liberty.
  //
  // Three things close it, all server-side:
  //   • POTION_CD_MS, mirroring the client's own 4s potCd with a little slack
  //     for latency — a legitimate client can never exceed it;
  //   • the potion is spent from the server's own copy of potionBag (now
  //     sanitized to real ids and sane counts — see _sanitizeSavedStats);
  //   • the heal is the catalog's value for THAT potion, not a number the
  //     packet chose.
  // `amount` is still accepted and still clamped, but only as the fallback
  // for a client from before this change that sends nothing else — a tab left
  // open across the deploy keeps working instead of losing its potions.
  const POTION_CD_MS = 3500;
  let _lastPotionAt = 0;
  safeOn('usePotion', ({ id, amount } = {}) => {
    if (!currentRoom) return;
    const now = Date.now();
    if (now - _lastPotionAt < POTION_CD_MS) return;
    const potId = _HP_POTION_IDS.includes(id) ? id
      : (_lastStats && _HP_POTION_IDS.includes(_lastStats.hudPotion) ? _lastStats.hudPotion : _HP_POTION_IDS[0]);
    const bag = (_lastStats && _lastStats.potionBag && typeof _lastStats.potionBag === 'object')
      ? _lastStats.potionBag : null;
    // No server-side bag yet (a session that hasn't sent a save since the
    // sanitizer started producing one) — fall back to the old behaviour so
    // nobody is left unable to drink, but the cooldown above still applies.
    if (bag) {
      if (!(bag[potId] > 0)) return socket.emit('potionEmpty', { id: potId });
      bag[potId] -= 1;
    }
    _lastPotionAt = now;
    const _catalogHeal = _HP_POTION_HEAL.get(potId);
    const n = Number(amount);
    const heal = Number.isFinite(_catalogHeal) && _catalogHeal > 0
      ? _catalogHeal
      : (Number.isFinite(n) ? Math.max(0, Math.min(n, 200)) : 60);
    currentRoom.healPlayer(socket.id, heal);
    // Persisted here, and this is not optional any more. It used to ride "the
    // normal progress save, and the client's own copy is what the next save
    // carries anyway" — but potionBag is pinned to the server's copy now, so
    // the client's save carries nothing and the decrement never reached the
    // database. Potions came back after every reconnect. One small $set per
    // potion, against a 3.5s cooldown, is the right price for that.
    if (bag) _persistSavedFields(authed, { potionBag: bag });
    socket.emit('potionUsed', { id: potId, heal, left: bag ? bag[potId] : null });
    // The authoritative bag, so the shop and the HUD show what is actually
    // left rather than the client's own guess.
    if (bag) socket.emit('potionBag', { potionBag: bag });
  });

  safeOn('statsUpdate', ({ atk, def, maxHp, critChance, critPower } = {}) => {
    if (currentRoom) currentRoom.updatePlayerStats(socket.id, { atk, def, maxHp, critChance, critPower });
  });

  // Shared by attack/skillAttack — tallies a hit against the race10 boss
  // (killing or not — "most damage dealt" needs every hit, not just the
  // last one) and ends the race the instant it dies. The winner is whoever
  // has the highest cumulative tally, not necessarily whoever lands the
  // killing blow. Only returns true (fully handled, caller should return) on
  // the killing hit — a non-killing hit still needs the caller's normal
  // enemyHurt emit below it, or the attacker would never see a damage number
  // or a live HP-bar update.
  function _race10TrackHit(socketId, enemyId, result) {
    if (!result.raceBoss) return false;
    if (_race10.live && _race10.bossId === enemyId) {
      const newDmg = (_race10.dmg.get(socketId) || 0) + (result.dmg || 0);
      _race10.dmg.set(socketId, newDmg);
      // Live feedback for the hitter only (not a broadcast) — cheap since it
      // only fires on hits against this one boss, and it's what makes the
      // "most damage wins" framing feel like a race instead of a black box.
      const ranked = [..._race10.dmg.values()].sort((a, b) => b - a);
      io.to(socketId).emit('race10Score', { myDamage: newDmg, rank: ranked.indexOf(newDmg) + 1, total: _race10.dmg.size });
    }
    if (!result.killed) return false;
    // Visual-only kill broadcast (no xp/gold/loot fields) so every client's
    // enemyKilled handler plays the death animation and removes the corpse —
    // otherwise the boss would just freeze on screen since _race10Finish
    // despawns it server-side before the next tick ever reports hp: 0.
    _emitToEnemyViewers(currentRoom, enemyId, 'enemyKilled',
      { id: enemyId, ex: result.ex, ey: result.ey, color: result.color });
    let winnerId = null, best = -1;
    _race10.dmg.forEach((d, sid) => { if (d > best) { best = d; winnerId = sid; } });
    _race10Finish(winnerId, false);
    return true;
  }

  safeOn('attack', ({ enemyId, splash } = {}) => {
    if (!_atkAllowed()) return;
    if (!currentRoom) return;
    if (_pvpFrozen(socket.id)) return;
    if (currentRoom.isPlayerInSafeZone(socket.id)) return;
    // splash: "Безумие" (advanced deathknight E) — a basic hit that rides
    // along with a primary attack rather than standing on its own. Always
    // exactly 50% damage, gated by its own window off the attacker's last
    // real hit — see attackEnemy's own comment (server/game/Room.js).
    const result = currentRoom.attackEnemy(socket.id, enemyId, { splash: !!splash });
    if (!result) return;
    if (result.immune) {
      socket.emit('guildWarError', { msg: result.reason === 'no_clan' ? 'Нужен клан, чтобы атаковать замок' : 'Нельзя атаковать свой замок' });
      return;
    }
    if (_race10TrackHit(socket.id, enemyId, result)) return;
    // Fear kills still pay out xp/gold through the normal path below — this
    // only advances the wave counter (spawns the next wave, or ends the run
    // on FEAR_MAX_WAVE), so it doesn't gate the rest of the handler.
    if (result.killed && result.arm === 'fear') _fearTrackKill(socket.id, result);
    // Coop kills also pay out xp through the normal path below — a regular
    // one only advances the stage counter (_coopTrackKill), the boss instead
    // grants its own fixed reward and ends the run for both participants
    // (_coopBossTrackKill), neither of which gates the rest of the handler.
    if (result.killed && result.arm === 'coop') {
      if (result.isBoss) _coopBossTrackKill(socket.id, result).catch(err => console.error('[coop boss reward]', err));
      else _coopTrackKill(socket.id, result);
    }
    if (result.killed) season.trackKill(result);
    // "Ударить Мирового босса" — any landed hit counts, and it pays once
    // per boss appearance rather than once per swing.
    season.trackBossHit(enemyId);
    // Guild War tower: no xp/gold/loot — capture just flips ownership. The
    // tower's hp already bounced back to maxHp inside Room.attackEnemy, so no
    // enemyKilled/death-animation broadcast either — the next tick's normal
    // hp stream is enough, and js/sprites.js's guildwar_castle entry has no
    // death sheet to play anyway.
    if (result.captured) { _gwApplyCapture(result); return; }
    if (result.killed) {
      if (result.isBoss) io.to(`floor_${currentFloor}`).emit('bossStatus', { arm: result.arm, alive: false, respawnAt: result.respawnAt });
      const partyId    = playerParty.get(socket.id);
      const partyMap   = partyId ? parties.get(partyId) : null;

      // Party members near enough to have actually taken part (excluding the
      // attacker). The floor check alone was never a proximity test — the
      // whole world is one shared floor (MAX_FLOOR = 1), so it passed for
      // every member no matter where they were, and someone parked across
      // the map collected a full XP/gold share off every kill.
      const memberIds = [];
      if (partyMap) {
        partyMap.forEach((_, mid) => {
          if (mid === socket.id) return;
          if (playerFloorMap.get(mid) !== currentFloor) return;
          if (!currentRoom.arePlayersNear(socket.id, mid)) return;
          memberIds.push(mid);
        });
      }

      const _arm = armIndexForLevel(result.rlvl);
      const _isCoop = result.arm === 'coop';
      // Фарм-зона already skips the whole normal loot table (see farmZone in
      // _grantKillLoot) — Liberty/GRAM are the same "no drop but shards" deal.
      // Coop replaces both with one flat COOP_LIBERTY_CHANCE Liberty roll and
      // no GRAM at all — see its own comment above. Элитная фарм-зона rolls
      // its own flat FARM2_LIBERTY_CHANCE Liberty (part of the drop table the
      // task spec calls for) but still no GRAM, same "own table replaces the
      // normal drops" deal as the original farm zone.
      const nexumDrop  = _isCoop ? (Math.random() < COOP_LIBERTY_CHANCE ? 1 : 0)
        : result.farmZone2 ? (Math.random() < FARM2_LIBERTY_CHANCE ? 1 : 0)
        : (!result.farmZone && Math.random() < (NEXUM_DROP_CHANCE[_arm] || 0)) ? 1 : 0;
      const gramDrop   = (_isCoop || result.farmZone || result.farmZone2) ? 0
        : (Math.random() < GRAM_DROP_CHANCE) ? (result.rlvl || 1) * GRAM_PER_LEVEL : 0;
      const _vipBon = VIP_BONUSES[socket.data.vipLevel || 0] || VIP_BONUSES[0];
      if (_vipBon.xp   > 0) result.xp   = Math.round(result.xp   * (1 + _vipBon.xp   / 100));
      if (_vipBon.gold > 0) result.gold = Math.round(result.gold * (1 + _vipBon.gold / 100));

      // Accumulated as a delta and flushed as one $inc — see _earnGram.
      if (nexumDrop > 0) _earnNexum(nexumDrop);
      if (gramDrop > 0) _earnGram(gramDrop);

      // Loot winner: random pick among party + attacker (just the attacker
      // when solo). The roll AND the grant both happen inside the winner's
      // own socket closure (socket.data._grantKillLoot) — a party member's
      // inventory isn't reachable from this handler, only from theirs.
      const allIds = memberIds.length > 0 ? [socket.id, ...memberIds] : [socket.id];
      const lootWinnerId = allIds[Math.floor(Math.random() * allIds.length)];
      const winnerSocket = lootWinnerId === socket.id ? socket : io.sockets.sockets.get(lootWinnerId);
      const lootResult = winnerSocket?.data?._grantKillLoot
        ? winnerSocket.data._grantKillLoot({ eid: result.eid, rlvl: result.rlvl, isBoss: result.isBoss, farmZone: result.farmZone, farmZone2: result.farmZone2, coop: result.arm === 'coop' })
        : { items: [], boxUncommon: 0, boxRare: 0, normStone: 0, blessStone: 0 };

      if (memberIds.length > 0) {
        const totalMembers = memberIds.length + 1;
        const xpShare   = Math.max(1, Math.round(result.xp / totalMembers));
        const goldShare = Math.round(result.gold / totalMembers);

        // Each recipient's share is credited on their OWN socket — see the
        // _grantXp/_grantKillGold spreads in the payloads below.

        _questOnKill(result.eid, result.rlvl);
        socket.emit('enemyKilled', {
          id: enemyId,
          ...(_m => ({ gold: _m.gained, goldTotal: _m.total }))(socket.data._grantKillGold(goldShare)),
          ...(_x => ({ xp: _x ? _x.gained : 0, level: _x }))(_grantXp(xpShare)),
          dmg: result.dmg, isCrit: result.isCrit, ex: result.ex, ey: result.ey, color: result.color,
          eid: result.eid, rlvl: result.rlvl,
          ...(lootWinnerId === socket.id ? lootResult : null),
          nexum: nexumDrop, gram: gramDrop,
        });
        memberIds.forEach(mid => {
          // A member's quest counters, XP and gold all live in their own
          // session — the attacker's socket cannot see any of them.
          io.sockets.sockets.get(mid)?.data?._questOnKill?.(result.eid, result.rlvl);
          io.to(mid).emit('enemyKilled', {
            id: enemyId,
            ...(_g => ({ gold: _g.gained, goldTotal: _g.total }))(io.sockets.sockets.get(mid)?.data?._grantKillGold?.(goldShare) || {}),
            ...(_x => ({ xp: _x ? _x.gained : 0, level: _x }))(io.sockets.sockets.get(mid)?.data?._grantXp?.(xpShare)),
            ex: result.ex, ey: result.ey, color: result.color,
            eid: result.eid, rlvl: result.rlvl,
            ...(lootWinnerId === mid ? lootResult : null),
          });
        });
        // Visual only, and only to the players who can actually see it — the
        // attacker and the party members above already got their own copies.
        _emitToEnemyViewers(currentRoom, enemyId, 'enemyKilled',
          { id: enemyId, ex: result.ex, ey: result.ey, color: result.color },
          [socket.id, ...memberIds]);
      } else {
        // No party: attacker gets full reward and loot
        _questOnKill(result.eid, result.rlvl);
        socket.emit('enemyKilled', {
          id: enemyId,
          ...(_m => ({ gold: _m.gained, goldTotal: _m.total }))(socket.data._grantKillGold(result.gold)),
          ...(_x => ({ xp: _x ? _x.gained : 0, level: _x }))(_grantXp(result.xp)),
          dmg: result.dmg, isCrit: result.isCrit, ex: result.ex, ey: result.ey, color: result.color,
          eid: result.eid, rlvl: result.rlvl, ...lootResult, nexum: nexumDrop, gram: gramDrop,
        });
        _emitToEnemyViewers(currentRoom, enemyId, 'enemyKilled',
          { id: enemyId, ex: result.ex, ey: result.ey, color: result.color }, [socket.id]);
      }
      onKillClanXp();
    } else {
      // Only the attacker is told how hard the hit landed. dmg is what drives
      // the floating damage number, vampirism and the client's optimistic kill
      // prediction (see the `if (dmg)` branch in js/network.js), so sending it
      // floor-wide made every nearby player render someone else's hit as their
      // own — and let a Вампиризм deathknight heal off other people's damage.
      // Everyone else still gets hp so health bars and the hit flash stay in
      // sync. Mirrors the split enemyKilled above already uses.
      socket.emit('enemyHurt', { id: enemyId, hp: result.hp, dmg: result.dmg, isCrit: result.isCrit });
      _emitToEnemyViewers(currentRoom, enemyId, 'enemyHurt',
        { id: enemyId, hp: result.hp }, [socket.id]);
    }
  });

  safeOn('skillAttack', ({ enemyId, key } = {}) => {
    if (!_atkAllowed()) return;
    if (_pvpFrozen(socket.id)) return;
    if (!currentRoom) return;
    if (currentRoom.isPlayerInSafeZone(socket.id)) return;
    const result = currentRoom.skillAttackEnemy(socket.id, enemyId, key);
    if (!result) return;
    if (result.immune) {
      socket.emit('guildWarError', { msg: result.reason === 'no_clan' ? 'Нужен клан, чтобы атаковать замок' : 'Нельзя атаковать свой замок' });
      return;
    }
    if (_race10TrackHit(socket.id, enemyId, result)) return;
    // Fear kills still pay out xp/gold through the normal path below — this
    // only advances the wave counter (spawns the next wave, or ends the run
    // on FEAR_MAX_WAVE), so it doesn't gate the rest of the handler.
    if (result.killed && result.arm === 'fear') _fearTrackKill(socket.id, result);
    // Coop kills also pay out xp through the normal path below — a regular
    // one only advances the stage counter (_coopTrackKill), the boss instead
    // grants its own fixed reward and ends the run for both participants
    // (_coopBossTrackKill), neither of which gates the rest of the handler.
    if (result.killed && result.arm === 'coop') {
      if (result.isBoss) _coopBossTrackKill(socket.id, result).catch(err => console.error('[coop boss reward]', err));
      else _coopTrackKill(socket.id, result);
    }
    if (result.killed) season.trackKill(result);
    // "Ударить Мирового босса" — any landed hit counts, and it pays once
    // per boss appearance rather than once per swing.
    season.trackBossHit(enemyId);
    if (result.captured) { _gwApplyCapture(result); return; }
    if (result.killed) {
      if (result.isBoss) io.to(`floor_${currentFloor}`).emit('bossStatus', { arm: result.arm, alive: false, respawnAt: result.respawnAt });
      const partyId    = playerParty.get(socket.id);
      const partyMap   = partyId ? parties.get(partyId) : null;
      // Same proximity requirement as the basic-attack kill above.
      const memberIds  = [];
      if (partyMap) {
        partyMap.forEach((_, mid) => {
          if (mid === socket.id) return;
          if (playerFloorMap.get(mid) !== currentFloor) return;
          if (!currentRoom.arePlayersNear(socket.id, mid)) return;
          memberIds.push(mid);
        });
      }
      const _arm2 = armIndexForLevel(result.rlvl);
      const _isCoop2 = result.arm === 'coop';
      // Same Сотрудничество/Элитная фарм-зона override as the basic-attack
      // path above.
      const nexumDrop2 = _isCoop2 ? (Math.random() < COOP_LIBERTY_CHANCE ? 1 : 0)
        : result.farmZone2 ? (Math.random() < FARM2_LIBERTY_CHANCE ? 1 : 0)
        : (!result.farmZone && Math.random() < (NEXUM_DROP_CHANCE[_arm2] || 0)) ? 1 : 0;
      const gramDrop2  = (_isCoop2 || result.farmZone || result.farmZone2) ? 0
        : (Math.random() < GRAM_DROP_CHANCE) ? (result.rlvl || 1) * GRAM_PER_LEVEL : 0;
      const _vipBon2 = VIP_BONUSES[socket.data.vipLevel || 0] || VIP_BONUSES[0];
      if (_vipBon2.xp   > 0) result.xp   = Math.round(result.xp   * (1 + _vipBon2.xp   / 100));
      if (_vipBon2.gold > 0) result.gold = Math.round(result.gold * (1 + _vipBon2.gold / 100));
      // Same delta accumulation as the basic-attack path above.
      if (nexumDrop2 > 0) _earnNexum(nexumDrop2);
      if (gramDrop2 > 0) _earnGram(gramDrop2);
      // Same cross-socket loot-winner grant as the basic-attack path above.
      const allIds = memberIds.length > 0 ? [socket.id, ...memberIds] : [socket.id];
      const lootWinnerId = allIds[Math.floor(Math.random() * allIds.length)];
      const winnerSocket = lootWinnerId === socket.id ? socket : io.sockets.sockets.get(lootWinnerId);
      const lootResult = winnerSocket?.data?._grantKillLoot
        ? winnerSocket.data._grantKillLoot({ eid: result.eid, rlvl: result.rlvl, isBoss: result.isBoss, farmZone: result.farmZone, farmZone2: result.farmZone2, coop: result.arm === 'coop' })
        : { items: [], boxUncommon: 0, boxRare: 0, normStone: 0, blessStone: 0 };
      if (memberIds.length > 0) {
        const totalMembers = memberIds.length + 1;
        const xpShare = Math.max(1, Math.round(result.xp / totalMembers)), goldShare = Math.round(result.gold / totalMembers);
        _questOnKill(result.eid, result.rlvl);
        socket.emit('enemyKilled', {
          id: enemyId, dmg: result.dmg, isCrit: result.isCrit,
          ...(_m => ({ gold: _m.gained, goldTotal: _m.total }))(socket.data._grantKillGold(goldShare)),
          ...(_x => ({ xp: _x ? _x.gained : 0, level: _x }))(_grantXp(xpShare)),
          ex: result.ex, ey: result.ey, color: result.color,
          eid: result.eid, rlvl: result.rlvl,
          ...(lootWinnerId === socket.id ? lootResult : null),
          nexum: nexumDrop2, gram: gramDrop2,
        });
        memberIds.forEach(mid => {
          // A member's quest counters, XP and gold all live in their own
          // session — the attacker's socket cannot see any of them.
          io.sockets.sockets.get(mid)?.data?._questOnKill?.(result.eid, result.rlvl);
          io.to(mid).emit('enemyKilled', {
            id: enemyId,
            ...(_g => ({ gold: _g.gained, goldTotal: _g.total }))(io.sockets.sockets.get(mid)?.data?._grantKillGold?.(goldShare) || {}),
            ...(_x => ({ xp: _x ? _x.gained : 0, level: _x }))(io.sockets.sockets.get(mid)?.data?._grantXp?.(xpShare)),
            ex: result.ex, ey: result.ey, color: result.color,
            eid: result.eid, rlvl: result.rlvl,
            ...(lootWinnerId === mid ? lootResult : null),
          });
        });
        _emitToEnemyViewers(currentRoom, enemyId, 'enemyKilled',
          { id: enemyId, ex: result.ex, ey: result.ey, color: result.color }, [socket.id, ...memberIds]);
      } else {
        _questOnKill(result.eid, result.rlvl);
        socket.emit('enemyKilled', {
          id: enemyId,
          ...(_m => ({ gold: _m.gained, goldTotal: _m.total }))(socket.data._grantKillGold(result.gold)),
          ...(_x => ({ xp: _x ? _x.gained : 0, level: _x }))(_grantXp(result.xp)), dmg: result.dmg, isCrit: result.isCrit,
          ex: result.ex, ey: result.ey, color: result.color,
          eid: result.eid, rlvl: result.rlvl, ...lootResult, nexum: nexumDrop2, gram: gramDrop2,
        });
        _emitToEnemyViewers(currentRoom, enemyId, 'enemyKilled',
          { id: enemyId, ex: result.ex, ey: result.ey, color: result.color }, [socket.id]);
      }
      onKillClanXp();
    } else {
      // dmg only to the attacker — see the same split in the attack handler.
      socket.emit('enemyHurt', { id: enemyId, hp: result.hp, dmg: result.dmg, isCrit: result.isCrit });
      _emitToEnemyViewers(currentRoom, enemyId, 'enemyHurt',
        { id: enemyId, hp: result.hp }, [socket.id]);
    }
  });

  safeOn('skillEffect', ({ enemyId, enemyIds, type, duration } = {}) => {
    if (!currentRoom) return;
    if (enemyId) currentRoom.applySkillEffect(enemyId, type, duration);
    if (enemyIds) currentRoom.applySkillEffectMany(enemyIds, type, duration);
    // Visual only (the freeze/stun tint on a monster), so it goes to whoever
    // is close enough to see that monster rather than to the whole world —
    // see _emitNearby. The caster's own position is the anchor: every CC in
    // the game is cast on something the caster is standing next to, and it
    // saves resolving a list of enemy ids to coordinates on a hot path.
    const _me = currentRoom.players.get(socket.id);
    if (!_me) return;
    _emitNearby(_me.x, _me.y, 'enemyCC', { enemyId, enemyIds, type, duration });
  });

  // Clearing invisibility is the only thing this event may still do.
  //
  // It used to be `p._invis = !!invis` — an unauthenticated, unbounded,
  // client-set flag that makes every monster in the room ignore you for as
  // long as you like (see _invis in server/game/Room.js: it drops the player
  // out of both the cached-target check and the proximity search). One
  // `socket.emit('playerInvis', { invis: true })` from the console bought
  // permanent PvE immunity — farm anything, including Страх waves and the
  // tower, with nothing able to aggro you.
  //
  // No skill in the game grants invisibility. invisTimer (js/state.js) is only
  // ever decremented and zeroed, never set to a positive value, and the helper
  // written for it (_skillInvisSec, js/player.js) has no call sites — so the
  // only `invis: true` that can reach this handler is a forged one. The two
  // real call sites both send false (the timer draining out, and attacking
  // while invisible), and they keep working.
  //
  // If the skill is ever actually implemented, the grant belongs here —
  // server-side, gated on the caster's class owning it and expiring on a
  // server-held timer — not on the client's say-so.
  safeOn('playerInvis', () => {
    if (!currentRoom) return;
    const p = currentRoom.players.get(socket.id);
    if (p) p._invis = false;
  });

  safeOn('faithShield', ({ duration } = {}) => {
    if (!currentRoom) return;
    const partyId = playerParty.get(socket.id);
    const partyMap = partyId ? parties.get(partyId) : null;
    if (!partyMap) return;
    partyMap.forEach((_, mid) => {
      if (mid === socket.id) return;
      // Buffs the caster's party, not the caster's friends list: this had no
      // distance (or even floor) check at all, so the shield reached every
      // member wherever they were on the map. Same radius as the shared
      // XP/gold and the party heal — see arePlayersNear.
      if (!currentRoom.arePlayersNear(socket.id, mid)) return;
      io.to(mid).emit('faithShieldBuff', { duration });
    });
  });

  // Returns true if attacker and target share a party or clan (PvP immune)
  function _isPvpImmune(attackerId, targetId) {
    // Guild War: while both players are physically inside the zone, ordinary
    // party/clan protection is suspended for anyone NOT sharing a clan — the
    // zone's whole point is open PvP between different clans ("PvE +
    // полноценный PvP"). Same-clan players inside the zone stay immune. This
    // has to run before every other check below because it's conditional on
    // live position, unlike the generic clan/party checks further down which
    // apply everywhere with no zone awareness.
    const gwA = currentRoom?.players.get(attackerId);
    const gwT = currentRoom?.players.get(targetId);
    if (gwA?._guildWarZone && gwT?._guildWarZone) {
      return !!gwA.clanName && gwA.clanName === gwT.clanName;
    }
    // In a 3v3 the teams are what matter, not who is whose friend: allies are
    // protected outright, and opponents can always be hit even if they happen
    // to share a party or a clan with the attacker.
    if (_a3Allies(attackerId, targetId)) return true;
    if (_a3Enemies(attackerId, targetId)) return false;
    // A death battle is a free-for-all: party and clan protection would let
    // allied entrants refuse to fight and stall the round forever, so both are
    // suspended for as long as the two of them are in the same live round.
    if (_db.phase === 'live' && _db.alive.has(attackerId) && _db.alive.has(targetId)) return false;
    const aParty = playerParty.get(attackerId);
    const tParty = playerParty.get(targetId);
    if (aParty && aParty === tParty) return true;
    const aPlayer = currentRoom?.players.get(attackerId);
    const tPlayer = currentRoom?.players.get(targetId);
    if (aPlayer?.clanName && aPlayer.clanName === tPlayer?.clanName) return true;
    return false;
  }

  safeOn('pvpAttack', ({ targetId } = {}) => {
    if (!_atkAllowed()) return;
    if (!currentRoom) return;
    if (_pvpFrozen(socket.id) || _pvpFrozen(targetId)) return;
    if (_isPvpImmune(socket.id, targetId)) return;
    const result = currentRoom.pvpAttack(socket.id, targetId);
    if (!result) return;
    // hp is now applied server-side inside pvpAttack itself — the target's
    // client used to self-report "actual damage taken" separately, which let
    // a modified client always report 0 and become unkillable.
    io.to(targetId).emit('pvpDamage', { dmg: result.dmg, hp: result.hp });
    socket.emit('pvpHit', { x: result.x, y: result.y, dmg: result.dmg, isCrit: result.isCrit, targetId });
    if (result.hp <= 0) { io.to(targetId).emit('playerHurt', { id: targetId, hp: 0 }); _pvpEliminate(targetId, socket.id, currentRoom); }
  });

  safeOn('pvpSkillAttack', ({ targetId, key } = {}) => {
    // Was the only combat handler outside the attack limiter, i.e. in the
    // 300 events/s bucket.
    if (!_atkAllowed()) return;
    if (!currentRoom) return;
    if (_pvpFrozen(socket.id) || _pvpFrozen(targetId)) return;
    if (_isPvpImmune(socket.id, targetId)) return;
    const result = currentRoom.pvpSkillAttack(socket.id, targetId, key);
    if (!result) return;
    io.to(targetId).emit('pvpDamage', { dmg: result.dmg, hp: result.hp });
    socket.emit('pvpHit', { x: result.x, y: result.y, dmg: result.dmg, isCrit: result.isCrit, targetId });
    if (result.hp <= 0) { io.to(targetId).emit('playerHurt', { id: targetId, hp: 0 }); _pvpEliminate(targetId, socket.id, currentRoom); }
  });

  safeOn('pvpSkillCC', ({ targetId, type, duration } = {}) => {
    if (!currentRoom) return;
    if (_pvpFrozen(socket.id) || _pvpFrozen(targetId)) return;
    if (_isPvpImmune(socket.id, targetId)) return;
    const attacker = currentRoom.players.get(socket.id);
    if (!attacker || !attacker.pvpMode) return;
    if (attacker.hp <= 0) return;
    if (currentRoom.isPlayerInSafeZone(socket.id)) return;
    const target = currentRoom.players.get(targetId);
    if (!target || target.hp <= 0) return;
    if (currentRoom.isPlayerInSafeZone(targetId)) return;
    const dur = Math.max(0, Math.min(duration, 6));
    // Anchored on the TARGET, and including the caster: the target's own
    // client is what applies the freeze/stun, so it must be in the recipient
    // set, and it always is — it sits at distance 0 from the anchor. Everyone
    // else nearby gets it for the visual. See _emitNearby for why this is no
    // longer a floor-wide broadcast.
    _emitNearby(target.x, target.y, 'pvpPlayerCC', { targetId, type, duration: dur }, true);
  });

  safeOn('respawn', () => {
    // Dying to anything at all during a round is an elimination — this covers
    // the paths the PvP kill hooks don't (the event boss, a stray mob).
    _pvpEliminate(socket.id);
    const _gwP = currentRoom?.players.get(socket.id);
    // Guild War: dying inside the zone while it's still live respawns back
    // inside the fight instead of ejecting to the hub — the first "die and
    // come back in the same zone" path in this game (every other zone's
    // respawn/elimination ejects). The phase check covers dying right as
    // 22:15 closes: a respawn click that lands after the window shut sends
    // the player to the hub like normal instead of into a closed zone.
    if (_gwP?._guildWarZone && _gw.phase === 'live') currentRoom.guildWarRespawn(socket.id);
    else if (currentRoom) currentRoom.respawnPlayer(socket.id);
  });

  // ── Вход в события ────────────────────────────────────────────────────────
  // All eight entry paths live in server/handlers/event-entry.js. The list is
  // long because this is where a player crosses into any of the six machines
  // under server/events/ — see that file's header.
  require('./handlers/event-entry')({
    ARENA3_MIN_LEVEL, RACE10_MIN_LEVEL, FEAR_ATTEMPTS, FEAR_MIN_LEVEL,
    FEAR_START_DELAY_MS, COOP_ATTEMPTS, COOP_MIN_LEVEL, COOP_START_DELAY_MS,
    socket, safeOn, session, _a3, _a3Broadcast, _a3PublicState,
    _a3TryStartSafe, _arena3AttemptsLeft, _coop, _coopAttemptsLeft,
    _coopGroupBroadcastList, _coopGroupDissolve, _coopGroupOf,
    _coopGroupOpenList, _coopGroupPush, _coopGroupStateFor, _coopGroups,
    _createCoopRoom, _createFarm2Room, _createFearRoom, _db, _dbBroadcast,
    _dbPublicState, _dbReturnEntrant, _doEnterLocation, _farm2,
    _farm2CascadeCheck, _farm2Finish, _farm2GroupBroadcastList,
    _farm2GroupDissolve, _farm2GroupOf, _farm2GroupOpenList, _farm2GroupPush,
    _farm2GroupStateFor, _farm2Groups, _farm2MinutesLeft, _farm2Starting,
    _fear, _fearAttemptsLeft, _fearStartWave, _lockCoopDaily,
    _lockFarm2Minutes, _lockFearDaily, _race10, _race10AttemptsLeft,
    _race10Broadcast, _race10PublicState, _removeFromParty, _returnToHub, io,
    parties, playerParty, safeInterval, safeTimeout
  });

  safeOn('setPvpMode', ({ pvpMode } = {}) => {
    if (currentRoom) currentRoom.setPlayerPvpMode(socket.id, pvpMode);
  });

  // Both of these are pure visuals — they carry no damage, the hit itself goes
  // through attack/skillAttack. They used to forward the client's object as-is
  // to everyone on the floor, which meant one player could push up to
  // maxHttpBufferSize (512 KB) of arbitrary data at every other player, several
  // hundred times a second, and inject unknown fields into their render loop.
  // Rebuild a fixed, numeric, bounded packet instead: the fields below are
  // exactly what js/network.js's netSpawnProj/netSpawnAoe send and what the
  // receiving handlers read.
  const _PROJ_TYPES = new Set(['arrow', 'ball']);
  const _num = (v, min, max, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
  };
  // Colours are written into a canvas fillStyle, so anything not matching a
  // plain hex literal is replaced rather than passed through.
  const _color = v => (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v)) ? v : '#ffffff';

  // Recipients for a visual-only combat event: everyone close enough to see
  // the point it happens at. These used to go to `floor_${currentFloor}`,
  // which — with one shared world floor — means every player online, so a
  // single archer's auto-attack cost one packet per player and the feature's
  // total cost grew as the square of the population (measured: 37% of a CPU
  // core at 150 players firing twice a second, more than the world simulation
  // itself). Same treatment enemyHurt/enemyKilled already get, see
  // _emitToEnemyViewers.
  // `includeSelf` is for the events the caster's own client does NOT render
  // locally and therefore has to be told about like everyone else.
  function _emitNearby(x, y, event, payload, includeSelf) {
    if (!currentRoom) return;
    const ids = currentRoom.nearbyPlayerIds(x, y, includeSelf ? null : socket.id,
      currentRoom.laneOf(socket.id));
    if (!ids.length) return;
    io.to(ids).emit(event, payload);
  }

  // Both now ride the addressed player's next world cast instead of going out
  // as their own socket.io event — see Room.queueProjectile. The validation is
  // unchanged; only the delivery moved. `angle` is no longer carried at all:
  // the receiver derives it from the velocity, which is the same number.
  safeOn('spawnProj', data => {
    if (!currentRoom || !data || typeof data !== 'object') return;
    currentRoom.queueProjectile(socket.id, {
      x:        _num(data.x, -1e5, 1e5, 0),
      y:        _num(data.y, -1e5, 1e5, 0),
      vx:       _num(data.vx, -5000, 5000, 0),
      vy:       _num(data.vy, -5000, 5000, 0),
      size:     _num(data.size, 1, 64, 5),
      life:     _num(data.life, 0, 10, 1.5),
      color:    _color(data.color),
      projType: _PROJ_TYPES.has(data.projType) ? data.projType : 'ball',
    });
  });

  safeOn('spawnAoe', data => {
    if (!currentRoom || !data || typeof data !== 'object') return;
    currentRoom.queueAoe(socket.id, {
      x: _num(data.x, -1e5, 1e5, 0),
      y: _num(data.y, -1e5, 1e5, 0),
      r: _num(data.r, 1, 400, 80),
      style: NC_AOE_STYLES.includes(data.style) ? data.style : 'classic',
      color: _color(data.color),
      color2: _color(data.color2 || data.color),
    });
  });

  safeOn('healParty', ({ amount } = {}) => {
    if (!authed || !currentRoom) return;
    // HEAL_PARTY_CD_MS floor — unlike a damage skill this never went through
    // skillAttackEnemy's own SKILL_CD_MS check, so nothing previously stopped
    // a modified client firing this event as fast as the socket would carry
    // it (see the constant's own comment).
    const caster = currentRoom.players.get(socket.id);
    if (!caster) return;
    const now = Date.now();
    if (now - (caster._lastHealParty || 0) < HEAL_PARTY_CD_MS) return;
    caster._lastHealParty = now;
    // `|| 0` is what stops a non-numeric amount becoming NaN and freezing the
    // recipient's hp forever — see usePotion above. The party-dungeon twin of
    // this handler already had it; this one didn't.
    const healAmt = Math.max(0, Math.min(Math.floor(Number(amount)) || 0, 9999));
    const partyId = playerParty.get(socket.id);
    if (!partyId) return;
    const partyMap = parties.get(partyId);
    if (!partyMap) return;
    partyMap.forEach((_, mid) => {
      if (mid === socket.id) return;
      if (playerFloorMap.get(mid) !== currentFloor) return;
      // Only members actually standing with the healer — see arePlayersNear.
      if (!currentRoom.arePlayersNear(socket.id, mid)) return;
      if (currentRoom.healPartyMember(mid, healAmt))
        io.to(mid).emit('healPartyMember', { amount: healAmt });
    });
  });

  safeOn('chat', ({ text } = {}) => {
    if (!authed || !text || typeof text !== 'string') return;
    const now = Date.now();
    if (now - _lastChatAt < 3000) return;
    _lastChatAt = now;
    const msg = text.trim().slice(0, 100);
    if (!msg) return;
    _recordChat(authed.username, msg);
    io.emit('chatMsg', { username: authed.username, text: msg });
  });

  // ── Чат, личка и пати ─────────────────────────────────────────────────────
  // All of it lives in server/handlers/social.js. Note what is NOT there:
  // saveProgress, which sat between the private-message handlers and the party
  // ones with no heading of its own, is directly below and stays here.
  require('./handlers/social')({
    socket, safeOn, io, activeSessions, session,
    clanChatHistory, dmHistory, parties, playerParty,
    dmKey: _dmKey,
    logHandlerErr: _logHandlerErr,
    recordClanChat: _recordClanChat,
    recordDm: _recordDm,
    removeFromParty: _removeFromParty,
    resolveUsername: _resolveUsername,
    socketForTelegramId: _socketForTelegramId,
    translateText: _translateText,
  });

  // ── Saving the character ──────────────────────────────────────────────────
  // The handler that writes the character, and the source of every _lastStats
  // reassignment the handler modules read through session's live getters. It
  // had no heading of its own and sat between the private-message and party
  // handlers, which is why probing that range as one block asked for
  // _sanitizeSavedStats and calcBM.
  safeOn('saveProgress', ({ stats } = {}) => {
    if (!authed) return;
    // No blob, nothing to do. _sanitizeSavedStats returns its argument
    // unchanged when it isn't an object, so without this the pins below run
    // against undefined and the handler throws — which safeOn then swallows,
    // leaving the client with no reply at all. Found by the handler sweep in
    // dev/harness.js.
    if (!stats || typeof stats !== 'object') return;
    // An item-granting handler (market cancel/buy, a craft, a shop purchase...)
    // is mid-flight and holding a reference to the current _lastStats.inventory
    // across an await. Accepting this save now would let its eventual commit
    // stamp that now-stale reference back over whatever this save changes —
    // see _itemOpBusy above.
    //
    // Dropping it was assumed to be safe because "the client's own autosave
    // debounce resends within a couple seconds" — but the client has no
    // periodic autosave, only event-driven ones (netSaveProgress, js/
    // network.js). A player who studies a passive and then stands still —
    // which is exactly what someone does in the skills panel, right after the
    // market/craft/shop op that set this flag — emits nothing further, so the
    // dropped save was the only one carrying that study and it simply never
    // reached the database. Ask for it back instead of discarding it.
    if (_itemOpBusy > 0) { socket.emit('saveDeferred'); return; }
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
        logPlayer(authed.telegramId, authed.username, 'save_items_unknown_id', {
          ids: _gone.slice(0, 20).join(','), n: _gone.length,
        });
        console.error(`[saveProgress] Dropped items with unknown ids for telegramId=${authed.telegramId}:`,
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
    if (_lastStats) {
      clean.inventory = _lastStats.inventory || [];
      clean.equipment = _lastStats.equipment || {};
      clean.storage   = _lastStats.storage   || [];
    }

    // Quest progress is server-tracked: the counters are incremented from the
    // events the server already sees (kills, potion purchases, joining a clan)
    // and the claim is checked against them. So both fields come from the
    // session copy, and the monotonic guard that used to sit here — which
    // stopped a rewound questIdx from re-claiming a reward — has nothing left
    // to guard: the client cannot rewind a counter it does not write.
    if (_lastStats) {
      clean.questIdx   = _lastStats.questIdx || 0;
      clean.questKills = _lastStats.questKills || {};
      // The last of it. buffs decide the x2 gold and XP payouts, potionBag is
      // spent by usePotion, bonusSP and rebirths are written by the rebirth and
      // shop handlers, specialQuestsDone is what makes a special quest
      // once-only. None of them is a number the client may compose.
      clean.buffs             = _lastStats.buffs             || {};
      clean.potionBag         = _lastStats.potionBag         || {};
      clean.bonusSP           = _lastStats.bonusSP           || 0;
      clean.rebirths          = _lastStats.rebirths          || 0;
      clean.specialQuestsDone = _lastStats.specialQuestsDone || [];
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
      const _rp = currentRoom && currentRoom.players.get(socket.id);
      if (_rp && _rp.hp > 0) clean.hp = _rp.hp;
      else if (_lastStats.hp != null) clean.hp = _lastStats.hp;
      // maxHp is a pure function of class, level, equipment and passives —
      // every one of which the server holds — so it is derived rather than
      // accepted. _sanitizeSavedStats already rebuilt it from the pinned
      // level above; this just stops the client's own figure winning.
      clean.maxHp = _lastStats.maxHp != null ? _lastStats.maxHp : clean.maxHp;
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
    if (_lastStats) {
      clean.skillLevels     = _lastStats.skillLevels     || {};
      clean.passiveLevels   = _lastStats.passiveLevels   || {};
      clean.advSkillLearned = _lastStats.advSkillLearned || {};
      clean.advSkillActive  = _lastStats.advSkillActive  || {};
      clean.upgrades        = _lastStats.upgrades        || {};
      // Кодекс: same reasoning — registerCodexSetItem is the only path that
      // ever changes it, so a save has nothing left to say about it either.
      clean.codex = (_lastStats.codex && typeof _lastStats.codex === 'object' && !Array.isArray(_lastStats.codex))
        ? _lastStats.codex : {};
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
    if (_lastStats) clean.gold = _goldNow();
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
    if (_lastStats) {
      clean.lvl       = _lastStats.lvl;
      clean.xp        = _lastStats.xp;
      clean.xpNext    = _lastStats.xpNext;
      clean.baseAtk   = _lastStats.baseAtk;
      clean.baseDef   = _lastStats.baseDef;
      clean.baseMaxHp = _lastStats.baseMaxHp;
    }

    // The catastrophic-reset guard used to live here: it refused a save that
    // arrived blank over a real character, because such a save would have
    // wiped items, gold and level in one write. Every one of those fields is
    // now taken from the session copy a few lines above, so a blank save
    // overwrites nothing worth having — there is no reset left to catch.
    _lastStats = clean;
    authed.bm = calcBM(_bmStatsFor(clean));
    // Catches the friend crossing level 20 mid-session rather than only at the
    // next login. Self-limiting: it returns immediately below level 20 and
    // runs at most once per session above it.
    _seasonCheckRefFriend();
    // Keeps the Room's basis for statsUpdate's true-base recomputation
    // (server/game/Room.js updatePlayerStats) in sync with the player's
    // actual equipment/upgrades/level as they change mid-session.
    if (currentRoom) {
      // Pets are the one bit of equipment other players can see, so a change
      // has to be pushed out. Broadcast as its own tiny event rather than a
      // gameState field: those go through the binary codec (shared/netcodec.js)
      // and a client that's still running the previous bundle after a redeploy
      // would misparse every packet, whereas an unknown extra event is simply
      // ignored.
      if (currentRoom.updatePlayerSavedData(socket.id, clean)) {
        const _p = currentRoom.players.get(socket.id);
        socket.to(`floor_${currentFloor}`).emit('playerPet', { id: socket.id, petId: _p ? _p.petId : null });
      }
    }
    clearTimeout(_saveDebounceTimer);
    _saveDebounceTimer = safeTimeout('saveDebounce', () => {
      if (!authed) return;
      // Progress only — balances move by $inc from their own paths. `clean` has
      // already had both stripped by _sanitizeSavedStats, so nothing here can
      // reintroduce a client-supplied figure either.
      _persistSavedFields(authed, { ...clean, ..._wherePlayerIs() }, { bm: authed.bm });
    }, 3000);
  });

  // ── Кланы и Хранилище клана ───────────────────────────────────────────────
  // Both live in server/handlers/clans.js, on the same `session` object the
  // market, the forge and the season use. The four clan fields on it are
  // get/set pairs because they are written from both sides — see that file's
  // header.
  const { onKillClanXp } = require('./handlers/clans')({
    socket, safeOn, io, activeSessions, logPlayer, logPlayerErr,
    session, getRoom,
    ITEMS_BUSY_MSG: _ITEMS_BUSY_MSG,
    beginItemOp: () => { _itemOpBusy++; },
    endItemOp: () => { _itemOpBusy--; },
    commitServerItems: _commitServerItems,
    liveInventory: _liveInventory,
    clanDataFor: _clanDataFor,
    clanXpAdd: _clanXpAdd,
    clearOtherClanApplications: _clearOtherClanApplications,
    notifyClan: _notifyClan,
    currentQuest: _currentQuest,
    questBump: _questBump,
    questPush: _questPush,
    goldNow: _goldNow,
    serverSpendGold: _serverSpendGold,
    withEconLock: _withEconLock,
    escapeRegex: _escapeRegex,
    socketForTelegramId: _socketForTelegramId,
    gw: _gw,
    gwPublicState: _gwPublicState,
  });

  // ── Special Quests ────────────────────────────────────────────────────────
  safeOn('completeSpecialQuest', async ({ questId } = {}) => {
    if (!authed || !questId) return;
    try {
      const quest = await SpecialQuestModel.findById(questId).lean();
      if (!quest || !quest.active) {
        socket.emit('specialQuestError', { questId: String(questId), reason: 'not_found' });
        return;
      }
      const done = (authed.savedData?.specialQuestsDone) || [];
      if (done.includes(String(questId))) {
        // Client is out of sync — re-send done so UI corrects itself
        socket.emit('specialQuestDone', { questId: String(questId), reward: { gold: 0, xp: 0, nexum: 0 }, alreadyDone: true });
        return;
      }
      const newDone = [...done, String(questId)];
      // The Liberty reward is NOT part of the writes below: it is credited with
      // its own $inc once the completion has been claimed, so it adds to
      // whatever the account holds instead of overwriting it. The claim itself
      // is what makes it once-only.
      // Build the per-field update using the in-memory savedData when available,
      // falling back to the DB current values when savedData is null (new player
      // who has never saved yet). In either case use $set on the whole savedData
      // object when savedData is null to avoid a MongoDB write error ("cannot
      // traverse null element") that would otherwise silently eat the completion.
      if (authed.savedData) {
        const upd = { 'savedData.specialQuestsDone': newDone };
        if (quest.reward.gold)  upd['savedData.gold']         = (authed.savedData.gold         || 0) + quest.reward.gold;
        if (quest.reward.xp)    upd['savedData.xp']           = (authed.savedData.xp           || 0) + quest.reward.xp;
        // The `$ne` on the filter is what makes the reward once-only. The
        // `done.includes` check above reads authed.savedData, which is only
        // updated after this await — so two completions sent in the same tick
        // both passed it and both paid out. Here the database decides: the
        // second write matches nothing and modifiedCount is 0.
        const _claim = await PlayerModel.updateOne(
          { telegramId: authed.telegramId, 'savedData.specialQuestsDone': { $ne: String(questId) } },
          { $set: upd },
        );
        if (!_claim.modifiedCount) {
          socket.emit('specialQuestDone', { questId: String(questId), reward: { gold: 0, xp: 0, nexum: 0 }, alreadyDone: true });
          return;
        }
        authed.savedData.specialQuestsDone = newDone;
        if (quest.reward.gold)  authed.savedData.gold         = (authed.savedData.gold         || 0) + quest.reward.gold;
        if (quest.reward.xp)    authed.savedData.xp           = (authed.savedData.xp           || 0) + quest.reward.xp;
      } else {
        // savedData is null (brand-new player who hasn't saved yet): initialise
        // it as a plain object so dotted-path $set won't error on null parent.
        const freshData = { specialQuestsDone: newDone };
        if (quest.reward.gold)  freshData.gold         = quest.reward.gold;
        if (quest.reward.xp)    freshData.xp           = quest.reward.xp;
        // Same once-only guard as the branch above, expressed against the null
        // savedData this branch exists for.
        const _claimNew = await PlayerModel.updateOne(
          { telegramId: authed.telegramId, savedData: null },
          { $set: { savedData: freshData } },
        );
        if (!_claimNew.modifiedCount) {
          socket.emit('specialQuestDone', { questId: String(questId), reward: { gold: 0, xp: 0, nexum: 0 }, alreadyDone: true });
          return;
        }
        authed.savedData = freshData;
      }
      // Credited only after the claim above succeeded, so a duplicate request
      // that lost the race pays nothing.
      if (quest.reward.nexum) {
        const _qb = await _incBalance(authed.telegramId, 'nexumBalance', quest.reward.nexum);
        if (_qb !== null) {
          _nexumBalance = _qb;
          socket.emit('nexumBalanceUpdate', { balance: _qb });
        }
      }
      let _sqxp = null;
      if (_lastStats) {
        _lastStats.specialQuestsDone = newDone;
        // Gold and XP were written straight from the freshly-read document,
        // which was how a reward computed elsewhere reached this session. Both
        // are applied on this side now, so they go through the same helpers as
        // every other credit and the client is told the result.
        if (quest.reward.gold) {
          _lastStats.gold = (authed.savedData.gold || 0);
          socket.emit('goldSync', { gold: _goldNow() });
        }
        // Flat, like the story-quest reward above: a fixed reward does not take
        // the kill multipliers.
        if (quest.reward.xp) _sqxp = _grantXp(quest.reward.xp, { flat: true });
      }
      logPlayer(authed.telegramId, authed.username, 'special_quest', { questId, title: quest.title, reward: quest.reward });
      socket.emit('specialQuestDone', { questId: String(questId), reward: quest.reward });
      if (_sqxp) socket.emit('xpSync', _sqxp);
    } catch(e) {
      console.error('completeSpecialQuest error:', e);
      socket.emit('specialQuestError', { questId: String(questId || ''), reason: 'server_error' });
    }
  });

  safeOn('disconnect', (reason) => {
    // Counted before anything else here can throw or return early — a session
    // that ended is a session that ended, whatever the cleanup below does.
    _recordSessionEnd(reason, !!authed, Date.now() - _connectedAt);
    clearTimeout(_authTimeout);
    if (_autoSaveInterval) { clearInterval(_autoSaveInterval); _autoSaveInterval = null; }
    clearInterval(_buffTick);
    // _flushNow (below, via _pendingFlush) clears this too and writes whatever
    // the coalesced drop balances are owed — clearing here as well just makes
    // sure no timer outlives the socket in the paths that don't reach it.
    if (_balancePersistTimer) { clearTimeout(_balancePersistTimer); _balancePersistTimer = null; }
    // Flush any pending debounced save immediately (same logic socket.data
    // ._flushNow exposes for a reconnecting session to await synchronously).
    // Registered in _pendingFlush (keyed by account, not socket) so a login
    // that arrives after this socket is already gone can still await the
    // write landing — see _pendingFlush comment above.
    if (authed) {
      const _tid = authed.telegramId;
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
        _setVipAura(authed.username, 0);
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
    if (authed) {
      _logWritesSinceTrim.delete(authed.telegramId);
      _pvpHistoryWritesSinceTrim.delete(authed.telegramId);
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
    _pvpEliminate(socket.id, undefined, undefined, { fearGrace: true, telegramId: authed?.telegramId });
    // Not routed through _pvpEliminate — see the stale-socket reconnect
    // path's own comment on why (it also fires on every death, which must
    // not end an Элитная фарм-зона run). No reconnect grace, same immediate-
    // eject choice Coop made for its own live runs.
    _farm2EjectOnDisconnect(socket.id);
    playerFloorMap.delete(socket.id);
    _teleportCasting.delete(socket.id);
    if (_teleportCastTimer) { clearTimeout(_teleportCastTimer); _teleportCastTimer = null; }
    // Held for PARTY_RECONNECT_GRACE_MS instead of dissolved on the spot — a
    // small network drop (see the fearGrace comment just above) used to kick
    // the member out of their party immediately, same class of bug as Fear's
    // hall-release-on-blip one.
    _partyHoldOnDisconnect(socket.id, authed?.telegramId);
    // Coop groups are a pre-run lobby, not a live match — no reconnect grace
    // (see _coopGroupDropOnDisconnect's own comment); this is unrelated to
    // _coopEjectOnDisconnect above, which only ever fires for a run already
    // under way.
    _coopGroupDropOnDisconnect(socket.id);
    _farm2GroupDropOnDisconnect(socket.id);
    if (!currentRoom) return;
    socket.to(`floor_${currentFloor}`).emit('playerLeft', { id: socket.id });
    currentRoom.removePlayer(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
  // Same reasoning as the getMe call above: getUpdates can only 404 without a
  // real token, and _pollTg re-arms itself every 500ms, so an unconfigured
  // instance — or a local dev one, whose token is a dummy used purely to sign
  // its own initData — would hammer api.telegram.org for nothing.
  if (_TG_TOKEN && process.env.DEV_LOCAL !== '1') _pollTg();
  _dbSchedule();
  _wbSchedule();
  _race10Schedule();
  _a3Schedule();
  _gwSchedule();
  _gwIncomeSchedule();
  console.log('next death battle:', new Date(_dbNextStartAt()).toISOString(),
              '| next world boss:', new Date(_wbNextStartAt()).toISOString(),
              '| next Bloody Tower window:', new Date(_race10NextOpenAt()).toISOString(),
              '| next 3v3 window:', new Date(_a3NextOpenAt()).toISOString(),
              '| next Guild War window:', new Date(_gwNextOpenAt()).toISOString());
});

// ── Error handlers ────────────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  // Give in-flight saves 2s to complete, then exit so the process manager restarts us
  setTimeout(() => process.exit(1), 2000).unref();
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Upper bound on how long to wait for final saves. Generous compared with the
// writes themselves (each is one small $set) but well inside the grace period
// a host gives between SIGTERM and SIGKILL.
const SHUTDOWN_FLUSH_MS = 8000;

async function _gracefulShutdown(signal) {
  console.log(`${signal}: shutting down...`);
  // Stop all game loops — the static per-floor ones AND the private Fear
  // instances, which are deliberately not in floorRooms (_createFearRoom) and
  // so were left ticking through the whole shutdown, right across the final
  // save flush below.
  floorRooms.forEach(r => r._stopLoop());
  _liveFearRooms().forEach(r => r._stopLoop());
  _liveCoopRooms().forEach(r => r._stopLoop());
  // Land whatever clan XP has accumulated since the last 20s flush, so a
  // redeploy doesn't quietly discard it.
  await _flushClanXp().catch(() => {});
  // Disconnect all sockets. Each socket's own disconnect handler registers its
  // final save in _pendingFlush, keyed by account.
  io.close();
  // Then WAIT FOR THOSE WRITES, rather than for a fixed two seconds and hoping.
  // The sleep was a guess that got worse the more players were online: every
  // one of them lands a flush at the same instant, they queue for the Mongo
  // pool (maxPoolSize), and anything still queued when the timer expired was
  // dropped by process.exit below — the last few seconds of progress, for
  // whoever happened to be at the back of the queue, on every single deploy.
  //
  // Bounded all the same: a shutdown that hangs on one stuck write is worse
  // than one that loses it, and SIGTERM usually comes with a hard kill behind
  // it. The race resolves on whichever comes first, and the timeout path says
  // so instead of exiting silently.
  // io.close() disconnects the sockets, but each socket's disconnect handler is
  // what registers its flush — give the event loop a turn so they have all run
  // before the map is read, or this collects an empty set and waits for
  // nothing at all.
  await new Promise(r => setTimeout(r, 200));
  const _flushes = [..._pendingFlush.values()];
  if (_flushes.length) {
    console.log(`waiting for ${_flushes.length} pending save(s)...`);
    const _done = await Promise.race([
      Promise.allSettled(_flushes).then(() => true),
      new Promise(r => setTimeout(() => r(false), SHUTDOWN_FLUSH_MS)),
    ]);
    console.log(_done ? 'all pending saves landed'
      : `WARNING: ${SHUTDOWN_FLUSH_MS}ms elapsed with saves still in flight — exiting anyway`);
  }
  await mongoose.connection.close();
  console.log('Shutdown complete');
  process.exit(0);
}
process.on('SIGTERM', () => _gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => _gracefulShutdown('SIGINT'));
