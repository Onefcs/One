const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const helmet = require('helmet');
const compression = require('compression');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const PlayerModel       = require('./models/Player');
const ClanModel         = require('./models/Clan');
const GramTxModel       = require('./models/GramTx');
const MarketListingModel= require('./models/MarketListing');
const SpecialQuestModel = require('./models/SpecialQuest');
const PlayerLogModel    = require('./models/PlayerLog');
const Room = require('./game/Room');
const { RaidRoom } = require('./game/RaidRoom');
const { PartyDungeonRoom } = require('./game/PartyDungeonRoom');
const {
  VIP_THRESHOLDS, VIP_BONUSES,
  ITEM_DEF, CRAFT_MATS, BOX_DEF, ENHANCE_MAX, ENHANCEABLE_SLOTS, enhanceBonus, isStackableItem,
  armIndexForLevel, EVENT_BOSS_ANNOUNCE_MS,
  DEATH_BATTLE_HOURS_MSK, DEATH_BATTLE_MSK_OFFSET_H, DEATH_BATTLE_REG_MS, DEATH_BATTLE_FREEZE_MS,
  DEATH_BATTLE_MIN_PLAYERS, DEATH_BATTLE_MAX_MS, DEATH_BATTLE_GRAM_REWARD, deathBattleRewards,
} = require('../shared/definitions');

// ── Market (player-to-player item trading for GRAM) ────────────────────────
const MARKET_MIN_PRICE   = 0.1;
const MARKET_MAX_PRICE   = 1000;
const MARKET_FEE_PCT     = 0.10;   // burned — not paid out to anyone
const MARKET_MAX_ACTIVE  = 20;     // active listings per seller
const MARKET_MAX_QTY     = 9999;   // sanity bound on a stackable listing's quantity
const MARKET_LIST_COOLDOWN_MS = 3000;
function _round2(n) { return Math.round(n * 100) / 100; }
// GRAM *balances* carry 7 decimals — kill drops accrue at GRAM_PER_LEVEL
// (0.0000001) per mob level and the client renders every balance with
// toFixed(7). Rounding a balance to 2 decimals (as several credit paths did)
// silently destroyed every fraction below 0.01, so a player's entire farmed
// sub-cent balance disappeared the moment a deposit, referral bonus or market
// sale credited them. Use this for anything that IS a balance; _round2 stays
// for genuinely 2-decimal money figures (listing prices, withdrawal fees).
// The 1e7 multiply-round-divide also clears the float drift that repeated
// += 0.0000001 accumulates.
function _round7(n) { return Math.round(n * 1e7) / 1e7; }

// Rebuild a listing's item entirely from the canonical catalog — the client
// is only trusted for WHICH item (id), WHICH enhance level, and (for
// stackable items) HOW MANY units, never for any stat field. This can't
// stop someone claiming an enhance level or a quantity they don't actually
// have (the enhance/craft system and the inventory itself are still
// client-computed, same as the rest of this game's economy), but it does
// stop a listing from carrying arbitrary made-up stats, rarity, or an item
// id that doesn't exist.
function _canonicalMarketItem(rawItem) {
  if (!rawItem || typeof rawItem !== 'object') return null;
  const id = rawItem.id;
  const base = ITEM_DEF.find(d => d.id === id) || CRAFT_MATS.find(d => d.id === id);
  if (!base) return null;
  const item = { ...base };
  if (ENHANCEABLE_SLOTS.has(base.slot)) {
    const enh = Math.floor(Number(rawItem.enhance));
    item.enhance = (Number.isFinite(enh) && enh >= 0 && enh <= ENHANCE_MAX) ? enh : 0;
  }
  if (isStackableItem(base)) {
    const qty = Math.floor(Number(rawItem.qty));
    item.qty = (Number.isFinite(qty) && qty >= 1 && qty <= MARKET_MAX_QTY) ? qty : 1;
  }
  return item;
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
const SERVER_INV_MAX = 150; // matches invHasSpace() in js/player.js

// Does `inv` hold at least `qty` of this item (matching enhance level for
// enhanceable gear, which is what makes two otherwise-identical swords
// different)? Returns the matching entry's index, or -1.
function _invFindOwned(inv, item) {
  if (!Array.isArray(inv)) return -1;
  const wantEnh = ENHANCEABLE_SLOTS.has(item.slot) ? (item.enhance || 0) : null;
  const wantQty = isStackableItem(item) ? (item.qty || 1) : 1;
  return inv.findIndex(i =>
    i && i.id === item.id &&
    (wantEnh === null || (i.enhance || 0) === wantEnh) &&
    ((i.qty || 1) >= wantQty));
}

// Removes `item` (respecting stack quantity) from `inv` in place. Caller must
// have checked _invFindOwned first. Returns true when something was removed.
function _invRemove(inv, item) {
  const idx = _invFindOwned(inv, item);
  if (idx < 0) return false;
  const entry = inv[idx];
  if (isStackableItem(item)) {
    const take = item.qty || 1;
    const have = entry.qty || 1;
    if (have > take) entry.qty = have - take;
    else inv.splice(idx, 1);
  } else {
    inv.splice(idx, 1);
  }
  return true;
}

// Adds `item` to `inv` in place. Returns false when there's no room — the
// caller must then refuse the trade rather than silently destroying the item.
function _invAdd(inv, item) {
  if (isStackableItem(item)) {
    const existing = inv.find(i => i && i.id === item.id);
    if (existing) { existing.qty = (existing.qty || 1) + (item.qty || 1); return true; }
  }
  if (inv.length >= SERVER_INV_MAX) return false;
  inv.push({ ...item });
  return true;
}

function _marketListingData(l) {
  return {
    id: l._id.toString(), sellerId: l.sellerId, sellerUsername: l.sellerUsername,
    item: l.item, price: l.price, createdAt: l.createdAt,
  };
}
function _marketHistoryData(l, myId) {
  const asSeller = l.sellerId === myId;
  return {
    id: l._id.toString(),
    item: l.item, price: l.price, status: l.status,
    role: asSeller ? 'sell' : 'buy',
    counterpart: asSeller ? (l.buyerUsername || null) : l.sellerUsername,
    createdAt: l.createdAt, soldAt: l.soldAt,
  };
}

// Bot token — set TG_BOT_TOKEN env var in Railway
const _TG_TOKEN      = process.env.TG_BOT_TOKEN    || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD  || '';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME  || 'admin';
const TG_ADMIN_ID  = process.env.TG_ADMIN_ID     || '';   // admin's Telegram chat ID
const GRAM_WALLET  = process.env.GRAM_WALLET      || '';   // TON wallet address for deposits
let _tgBotUsername = process.env.TG_BOT_USERNAME  || '';

// In-memory gram balance cache: telegramId → balance (survives autosave overwrites)
const _gramBalanceCache = new Map();

// Same pattern for Nexum. Nexum is server-granted only (mob drops, special-quest
// rewards, admin give) but it also rides along inside the client's saveProgress
// blob, so without an authoritative cache a stale client save could roll back a
// grant the client hadn't observed yet (e.g. a quest/admin nexum award landing
// between two saves). All server-side writers update this map; every persist
// reads nexumBalance from here, never from the client payload.
const _nexumBalanceCache = new Map();

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

// ── VIP item data (server-side subset of js/definitions.js) ──────────────────
const _VIP_WEAPONS = {
  deathknight: {
    uncommon:  { id:'sw2', name:'Стальной меч',   slot:'weapon', img:'/images/wep/uk.png', atk:14,                       rarity:'uncommon' },
    rare:      { id:'sw3', name:'Меч дракона',    slot:'weapon', img:'/images/wep/rk.png', atk:23, critChance:0.05,       rarity:'rare'     },
    epic:      { id:'sw4', name:'Меч теней',      slot:'weapon', img:'/images/wep/ek.png', atk:44, critChance:0.10,       rarity:'epic'     },
    legendary: { id:'sw5', name:'Меч героя',      slot:'weapon', img:'/images/wep/lk.png', atk:65, critChance:0.25,       rarity:'legendary'},
  },
  lev: {
    uncommon:  { id:'tw2', name:'Стальной топор', slot:'weapon', img:'/images/wep/ut.png', atk:15,                       rarity:'uncommon' },
    rare:      { id:'tw3', name:'Топор дракона',  slot:'weapon', img:'/images/wep/rt.png', atk:23,                       rarity:'rare'     },
    epic:      { id:'tw4', name:'Топор теней',    slot:'weapon', img:'/images/wep/et.png', atk:44,                       rarity:'epic'     },
    legendary: { id:'tw5', name:'Топор героя',    slot:'weapon', img:'/images/wep/lt.png', atk:65,                       rarity:'legendary'},
  },
  ranger: {
    uncommon:  { id:'bw2', name:'Серебряный лук', slot:'weapon', img:'/images/wep/ub.png', atk:18, atkSpeed:0.03,         rarity:'uncommon' },
    rare:      { id:'bw3', name:'Лук охотника',   slot:'weapon', img:'/images/wep/rb.png', atk:28, atkSpeed:0.05,         rarity:'rare'     },
    epic:      { id:'bw4', name:'Лунный лук',     slot:'weapon', img:'/images/wep/eb.png', atk:60, atkSpeed:0.10,         rarity:'epic'     },
    legendary: { id:'bw5', name:'Лук героя',      slot:'weapon', img:'/images/wep/lb.png', atk:100,atkSpeed:0.15,critChance:0.10,rarity:'legendary'},
  },
};
_VIP_WEAPONS.mage = {
  uncommon:  { id:'st2', name:'Посох бойца',    slot:'weapon', img:'/images/wep/us.png', atk:17,              rarity:'uncommon' },
  rare:      { id:'st3', name:'Посох охотника', slot:'weapon', img:'/images/wep/rs.png', atk:30, hpPct:0.05,  rarity:'rare'     },
  epic:      { id:'st4', name:'Посох Героя',    slot:'weapon', img:'/images/wep/es.png', atk:60, hpPct:0.10,  rarity:'epic'     },
  legendary: { id:'st5', name:'Посох Легенды',  slot:'weapon', img:'/images/wep/ls.png', atk:100,hpPct:0.15,  rarity:'legendary'},
};
_VIP_WEAPONS.warlock = _VIP_WEAPONS.mage;

const _VIP_BP = [
  { id:'bp_hp',       name:'Зелье здоровья',  slot:'buff_potion', img:'/images/potion/hp.png',       rarity:'uncommon', buffType:'hp',       buffDur:600},
  { id:'bp_exp',      name:'Зелье опыта',      slot:'buff_potion', img:'/images/potion/exp.png',      rarity:'uncommon', buffType:'exp',      buffDur:600},
  { id:'bp_gold',     name:'Зелье золота',     slot:'buff_potion', img:'/images/potion/gold.png',     rarity:'uncommon', buffType:'gold',     buffDur:600},
  { id:'bp_regen',    name:'Зелье регена',     slot:'buff_potion', img:'/images/potion/regen.png',    rarity:'uncommon', buffType:'regen',    buffDur:600},
  { id:'bp_atkspeed', name:'Зелье скорости',   slot:'buff_potion', img:'/images/potion/atkspeed.png', rarity:'uncommon', buffType:'atkspeed', buffDur:600},
  { id:'bp_atk',      name:'Зелье атаки',      slot:'buff_potion', img:'/images/potion/atk.png',      rarity:'uncommon', buffType:'atk',      buffDur:600},
];

// ── GRAM Shop ─────────────────────────────────────────────────────────────────
// skillBooks grants skill books for the buyer's OWN class (see charClass
// below) — `random: N` picks N books independently at random (can repeat),
// `each: N` grants N copies of EVERY one of the class's 4 books.
const _GRAM_SHOP_PKGS = [
  { id:'pkg1',   gram:1,   gold:1000,   potions:2,   armor:null,       weapon:null,       bonusSP:0,  skillBooks:null },
  { id:'pkg5',   gram:5,   gold:5000,   potions:10,  armor:null,       weapon:null,       bonusSP:0,  skillBooks:{ random:1 } },
  { id:'pkg10',  gram:10,  gold:7000,   potions:10,  armor:'common',   weapon:'common',   bonusSP:1,  skillBooks:{ random:2 } },
  { id:'pkg30',  gram:30,  gold:20000,  potions:30,  armor:'uncommon', weapon:'uncommon', bonusSP:2,  skillBooks:{ each:1 } },
  { id:'pkg50',  gram:100, gold:50000,  potions:50,  armor:'rare',     weapon:null,       bonusSP:5,  skillBooks:{ each:4 },  boxes:{ box_rare:10 } },
  { id:'pkg100', gram:220, gold:100000, potions:100, armor:'rare',     weapon:'rare',     bonusSP:10, skillBooks:{ each:12 }, boxes:{ box_rare:30 }, enhance:3 },
];
// Weapon IDs per class and rarity for the shop (reuses ITEM_DEF entries)
const _SHOP_CLASS_WEAPONS = {
  lev:         { common:'tw1', uncommon:'tw2', rare:'tw3' },
  deathknight: { common:'sw1', uncommon:'sw2', rare:'sw3' },
  ranger:      { common:'bw1', uncommon:'bw2', rare:'bw3' },
  mage:        { common:'st1', uncommon:'st2', rare:'st3' },
  warlock:     { common:'st1', uncommon:'st2', rare:'st3' },
};
// Armor slot IDs per rarity for the shop
const _SHOP_ARMOR_SETS = {
  common:   ['hm1','ar1','gl1','bt1','rn1','nd1'],
  uncommon: ['hm2','ar2','gl2','bt2','rn2','nd2'],
  rare:     ['hm3','ar3','gl3','bt3','rn3','nd3'],
};
const _GRAM_WITHDRAW_FEE_PCT = 0.10;

const _STONE_DEFS = {
  norm_stone:  { id:'norm_stone',  name:'Камень обычной заточки',    img:'/images/norm.png',  slot:'material', rarity:'uncommon' },
  bless_stone: { id:'bless_stone', name:'Камень безопасной заточки', img:'/images/bless.png', slot:'material', rarity:'rare'     },
};

function _vipLevelItems(vipLevel, charClass) {
  const wepMap = _VIP_WEAPONS[charClass] || _VIP_WEAPONS.lev;
  const items = [];
  function addStone(id, qty) { if (qty > 0) items.push({ ..._STONE_DEFS[id], qty }); }
  function addBP(qty)        { _VIP_BP.forEach(bp => items.push({ ...bp, qty })); }
  function addWep(rarity, enhance) {
    const w = wepMap[rarity]; if (w) items.push({ ...w, enhance: enhance || 0, qty: 1 });
  }
  function addBox(id, qty) {
    if (qty <= 0) return;
    const b = BOX_DEF.find(x => x.id === id);
    if (b) items.push({ ...b, qty });
  }
  switch (vipLevel) {
    case 2:  addBox('box_uncommon', 3); break;
    case 3:  addStone('bless_stone', 2); addBox('box_uncommon', 5); break;
    case 4:  addStone('bless_stone', 5); addBP(10); addBox('box_rare', 2); addBox('box_uncommon', 3); break;
    case 5:  addStone('bless_stone', 7); addBP(10); addBox('box_rare', 5); break;
    case 6:  addWep('uncommon', 8); addStone('bless_stone', 7); addBP(10); addBox('box_rare', 10); break;
    case 7:  addWep('rare', 8); addStone('norm_stone', 20); addStone('bless_stone', 10); addBox('box_rare', 15); break;
    case 8:  addWep('epic', 1); addBP(50); addStone('norm_stone', 50); addStone('bless_stone', 30); addBox('box_rare', 20); break;
    case 9:  addWep('epic', 8); addBP(80); addStone('norm_stone', 70); addStone('bless_stone', 30); addBox('box_rare', 25); break;
    case 10: addWep('legendary', 0); addBP(100); addStone('norm_stone', 100); addStone('bless_stone', 100); addBox('box_rare', 30); break;
    default: break;
  }
  return items;
}

function _vipGoldReward(vipLevel) {
  if (vipLevel === 7) return 10000;
  if (vipLevel === 8) return 20000;
  return 0;
}

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
    `👤 ${tx.username} (<code>${tx.telegramId}</code>)`,
    `💎 ${tx.amount} GRAM`,
    isDeposit
      ? `🏷 Мемо: <code>${tx.memo}</code>`
      : `📬 Адрес: <code>${tx.address}</code>`,
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
  setTimeout(_pollTg, 500);
}

async function _handleAdminCallback(cq) {
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

  if ((confirmed && tx.type === 'deposit') || (!confirmed && tx.type === 'withdraw')) {
    const doc = await PlayerModel.findOne({ telegramId: tx.telegramId });
    if (doc) {
      // Base on _gramBalanceCache (live, up-to-the-second) rather than the DB's
      // savedData snapshot, and write back with a targeted $set — a full-document
      // findOne-then-save here can read a stale balance (the player's own
      // gameplay autosave landing in between) and then clobber it, which is how
      // an approved deposit could add its amount on top of the wrong base and
      // wipe out balance changes that happened in the meantime.
      const newBal = _round7((_gramBalanceCache.get(tx.telegramId) ?? (doc.savedData?.gramBalance || 0)) + tx.amount);
      await PlayerModel.updateOne({ telegramId: tx.telegramId }, { $set: { 'savedData.gramBalance': newBal } });
      _gramBalanceCache.set(tx.telegramId, newBal);
      io.to(`tg_${tx.telegramId}`).emit('gramBalanceUpdate', { balance: newBal });

      // 5% referral bonus on confirmed deposit
      if (confirmed && tx.type === 'deposit' && doc.referredBy) {
        const bonus = Math.round(tx.amount * 0.05 * 100) / 100;
        if (bonus > 0) {
          const refDoc = await PlayerModel.findOne({ telegramId: doc.referredBy });
          if (refDoc) {
            const refNewBal = _round7((_gramBalanceCache.get(doc.referredBy) ?? (refDoc.savedData?.gramBalance || 0)) + bonus);
            await PlayerModel.updateOne({ telegramId: doc.referredBy }, { $set: { 'savedData.gramBalance': refNewBal } });
            _gramBalanceCache.set(doc.referredBy, refNewBal);
            io.to(`tg_${doc.referredBy}`).emit('gramBalanceUpdate', { balance: refNewBal });
            io.to(`tg_${doc.referredBy}`).emit('refBonusReceived', {
              bonus,
              fromUsername: doc.username,
              newBalance: refNewBal,
            });
          }
        }
      }
    }
  }

  await tx.save();
  io.to(`tg_${tx.telegramId}`).emit('gramTxUpdate', { id: tx._id.toString(), status: tx.status });

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
      `👤 @${username} только что зашёл в игру по вашей ссылке.`,
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
    ? `\n👥 Пригласил: @${referrerUsername}`
    : '\n👥 Источник: органика';
  await tgApi('sendMessage', {
    chat_id: TG_ADMIN_ID,
    text: [
      '🆕 <b>Новый игрок</b>',
      `👤 @${username} (<code>${telegramId}</code>)${refLine}`,
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
  const username = msg.from.username || firstName || `tg_${fromId}`;

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

  const greeting = firstName ? `👋 Привет, <b>${firstName}</b>!` : '👋 Добро пожаловать!';
  const refText  = referrerUsername
    ? `\n🎁 Вас пригласил @${referrerUsername} — играйте вместе и зарабатывайте бонусы!`
    : '';

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

// Login Widget verification (browser button)
function verifyTelegramAuth(data) {
  const { hash, ...rest } = data;
  if (!hash) return false;
  const checkStr = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(_TG_TOKEN).digest();
  const computed = crypto.createHmac('sha256', secret).update(checkStr).digest('hex');
  if (computed !== hash) return false;
  if (Date.now() / 1000 - Number(data.auth_date) > 86400) return false;
  return true;
}

// Mini App verification (opened inside Telegram app) — different secret derivation.
// Returns { user, startParam } — startParam is Telegram's own start_param field,
// present when the app was opened via a t.me/<bot>?startapp=... deep link (the
// Mini App equivalent of a bot's ?start= deep link, but it opens the game
// directly with no intermediate "press START in the bot chat" step — see
// _refLink()/the referral registration in loginTelegramWebApp below).
function verifyTelegramWebApp(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const checkStr = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(_TG_TOKEN).digest();
    const computed = crypto.createHmac('sha256', secret).update(checkStr).digest('hex');
    if (computed !== hash) return null;
    if (Date.now() / 1000 - Number(params.get('auth_date')) > 86400) return null;
    const userStr = params.get('user');
    if (!userStr) return null;
    return { user: JSON.parse(userStr), startParam: params.get('start_param') || '' };
  } catch { return null; }
}

if (!_tgBotUsername) {
  fetch(`https://api.telegram.org/bot${_TG_TOKEN}/getMe`)
    .then(r => r.json())
    .then(d => { if (d.ok) { _tgBotUsername = d.result.username; console.log('TG bot:', _tgBotUsername); } })
    .catch(err => console.error('Could not fetch TG bot username:', err));
}

const ROOT = path.join(__dirname, '..');
const BUNDLE_FILES = [
  'shared/definitions.js',
  'shared/netcodec.js',
  'js/constants.js',
  'js/utils.js',
  'js/state.js',
  'js/icons.js',
  'js/themes.js',
  'js/definitions.js',
  'js/i18n.js',
  'js/tonconnect.js',
  'js/sprites.js',
  'js/particles.js',
  'js/sound.js',
  'js/player.js',
  'js/combat.js',
  'js/input.js',
  'js/ui.js',
  'js/charselect.js',
  'js/network.js',
  'js/quests.js',
  'js/clans.js',
  'js/pixi-world.js',
  'js/game.js',
  'js/npc.js',
].map(f => path.join(ROOT, f));

const jsBundle = BUNDLE_FILES.map(f => fs.readFileSync(f, 'utf8')).join('\n;\n');
const jsBundleEtag = `"${crypto.createHash('sha1').update(jsBundle).digest('hex').slice(0, 8)}"`;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket'],
  pingTimeout: 90000,
  pingInterval: 30000,
  maxHttpBufferSize: 512 * 1024,  // 512 KB max per socket message
});

mongoose.connect(process.env.MONGODB_URI, {
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
})
  .then(() => console.log('MongoDB connected'))
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
      frameAncestors: ["'self'", 'https://web.telegram.org', 'https://*.web.telegram.org', 'https://telegram.org', 'https://*.telegram.org'],
    },
  },
}));
app.use(compression());
app.use(express.json({ limit: '256kb' }));

// ── Admin auth helpers ─────────────────────────────────────────────────────────
function _adminToken(ts) {
  return crypto.createHmac('sha256', ADMIN_PASSWORD || 'disabled').update(`adm:${ts}`).digest('hex');
}
function _verifyAdminToken(raw) {
  if (!ADMIN_PASSWORD) return false;
  try {
    const { ts, sig } = JSON.parse(Buffer.from(raw, 'base64url').toString());
    if (Date.now() - ts > 7 * 86400000) return false;
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(_adminToken(ts)));
  } catch { return false; }
}
function adminAuth(req, res, next) {
  const tok = (req.headers.authorization || '').replace('Bearer ', '');
  if (!_verifyAdminToken(tok)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Player event logger (last 30 per player kept, older auto-expire in 30d)
async function logPlayer(telegramId, username, event, meta) {
  try {
    await PlayerLogModel.create({ telegramId, username, event, meta });
  } catch {}
}

// ── Admin login brute-force limiter ────────────────────────────────────────────
// Per-IP failed-attempt tracker: after LOGIN_MAX_FAILS failures the IP is locked
// out for LOGIN_LOCK_MS. A successful login clears the counter. In-memory (this
// process holds all state anyway); good enough to blunt online password guessing.
const _loginFails = new Map(); // ip → { n, lockedUntil }
const LOGIN_MAX_FAILS = 8;
const LOGIN_LOCK_MS   = 15 * 60 * 1000;
function _loginLockedUntil(ip) {
  const e = _loginFails.get(ip);
  return e && e.lockedUntil > Date.now() ? e.lockedUntil : 0;
}
function _recordLoginFail(ip) {
  const e = _loginFails.get(ip) || { n: 0, lockedUntil: 0 };
  e.n += 1;
  if (e.n >= LOGIN_MAX_FAILS) { e.lockedUntil = Date.now() + LOGIN_LOCK_MS; e.n = 0; }
  _loginFails.set(ip, e);
}
// Constant-time string compare that never throws on length mismatch.
function _safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) { crypto.timingSafeEqual(ba, ba); return false; }
  return crypto.timingSafeEqual(ba, bb);
}

// ── Admin REST API ─────────────────────────────────────────────────────────────
app.post('/admin/login', (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'Admin disabled' });
  const ip = req.ip || 'unknown';
  const lockedUntil = _loginLockedUntil(ip);
  if (lockedUntil) {
    const mins = Math.ceil((lockedUntil - Date.now()) / 60000);
    return res.status(429).json({ error: `Слишком много попыток. Повторите через ${mins} мин.` });
  }
  const { username, password } = req.body || {};
  // Constant-time compare on both fields so login timing leaks neither.
  const ok = _safeEqual(username, ADMIN_USERNAME) & _safeEqual(password, ADMIN_PASSWORD);
  if (!ok) {
    _recordLoginFail(ip);
    return res.status(401).json({ error: 'Wrong credentials' });
  }
  _loginFails.delete(ip);
  const ts  = Date.now();
  const tok = Buffer.from(JSON.stringify({ ts, sig: _adminToken(ts) })).toString('base64url');
  res.json({ token: tok });
});

app.get('/admin/stats', adminAuth, async (req, res) => {
  try {
    const now = new Date();
    const dayAgo  = new Date(now - 86400000);
    const weekAgo = new Date(now - 7 * 86400000);
    const [total, newToday, newWeek, gramSum] = await Promise.all([
      PlayerModel.countDocuments(),
      PlayerModel.countDocuments({ createdAt: { $gte: dayAgo } }),
      PlayerModel.countDocuments({ createdAt: { $gte: weekAgo } }),
      GramTxModel.aggregate([{ $match: { type: 'deposit', status: 'confirmed' } }, { $group: { _id: null, s: { $sum: '$amount' } } }]),
    ]);
    const online = io.sockets.sockets.size;
    const [topBm, topLvl, topGold, topNexum] = await Promise.all([
      PlayerModel.find({}, 'username bm savedData').sort({ bm: -1 }).limit(5).lean(),
      PlayerModel.find({}, 'username savedData').sort({ 'savedData.lvl': -1 }).limit(5).lean(),
      PlayerModel.find({}, 'username savedData').sort({ 'savedData.gold': -1 }).limit(5).lean(),
      PlayerModel.find({}, 'username savedData').sort({ 'savedData.nexumBalance': -1 }).limit(5).lean(),
    ]);
    const banned = await PlayerModel.countDocuments({ banned: true });
    res.json({
      total, newToday, newWeek, online, banned,
      gramTotal: gramSum[0]?.s || 0,
      tops: {
        bm:    topBm.map(p    => ({ username: p.username, val: p.bm || 0 })),
        lvl:   topLvl.map(p   => ({ username: p.username, val: p.savedData?.lvl || 1 })),
        gold:  topGold.map(p  => ({ username: p.username, val: p.savedData?.gold || 0 })),
        nexum: topNexum.map(p => ({ username: p.username, val: p.savedData?.nexumBalance || 0 })),
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/players', adminAuth, async (req, res) => {
  try {
    const { q = '', page = 1, limit = 30 } = req.query;
    const filter = q ? { username: { $regex: _escapeRegex(q).slice(0, 64), $options: 'i' } } : {};
    const [players, count] = await Promise.all([
      PlayerModel.find(filter, 'username telegramId bm banned savedData referredBy createdAt')
        .sort({ bm: -1 }).skip((page - 1) * limit).limit(Number(limit)).lean(),
      PlayerModel.countDocuments(filter),
    ]);
    const onlineIds = new Set([...io.sockets.sockets.values()].map(s => s.data?.telegramId).filter(Boolean));
    res.json({
      players: players.map(p => ({
        id: p._id, telegramId: p.telegramId, username: p.username,
        bm: p.bm || 0, banned: p.banned || false,
        lvl: p.savedData?.lvl || 1, gold: p.savedData?.gold || 0,
        nexum: p.savedData?.nexumBalance || 0, gram: p.savedData?.gramBalance || 0,
        referredBy: p.referredBy, createdAt: p.createdAt,
        online: onlineIds.has(p.telegramId),
      })),
      total: count,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/player/:tid', adminAuth, async (req, res) => {
  try {
    const p = await PlayerModel.findOne({ telegramId: req.params.tid }).lean();
    if (!p) return res.status(404).json({ error: 'Not found' });
    const [logs, referrer] = await Promise.all([
      PlayerLogModel.find({ telegramId: req.params.tid }).sort({ at: -1 }).limit(30).lean(),
      p.referredBy ? PlayerModel.findOne({ telegramId: p.referredBy }, 'username').lean() : null,
    ]);
    res.json({ player: p, logs, referrerUsername: referrer?.username || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/player/:tid/ban', adminAuth, async (req, res) => {
  try {
    const p = await PlayerModel.findOneAndUpdate({ telegramId: req.params.tid }, { banned: true }, { new: true });
    if (!p) return res.status(404).json({ error: 'Not found' });
    // Kick if online
    io.sockets.sockets.forEach(s => {
      if (s.data?.telegramId === req.params.tid) {
        s.emit('kicked', { reason: 'Вы заблокированы администратором' });
        s.disconnect(true);
      }
    });
    logPlayer(p.telegramId, p.username, 'ban', { by: 'admin', reason: req.body?.reason || '' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/player/:tid/unban', adminAuth, async (req, res) => {
  try {
    const p = await PlayerModel.findOneAndUpdate({ telegramId: req.params.tid }, { banned: false }, { new: true });
    if (!p) return res.status(404).json({ error: 'Not found' });
    logPlayer(p.telegramId, p.username, 'unban', { by: 'admin' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/player/:tid/give', adminAuth, async (req, res) => {
  try {
    const { gold = 0, nexum = 0, gram = 0 } = req.body || {};
    const p = await PlayerModel.findOne({ telegramId: req.params.tid });
    if (!p) return res.status(404).json({ error: 'Not found' });
    const saved = p.savedData || {};
    if (gold)  saved.gold          = (saved.gold || 0) + Number(gold);
    if (nexum) {
      // If the player is online, base the grant on the live cache (authoritative)
      // and update it, so their session's next save can't roll the grant back.
      const curN = _nexumBalanceCache.has(p.telegramId)
        ? _nexumBalanceCache.get(p.telegramId) : (saved.nexumBalance || 0);
      const newN = curN + Number(nexum);
      saved.nexumBalance = newN;
      if (_nexumBalanceCache.has(p.telegramId)) _nexumBalanceCache.set(p.telegramId, newN);
    }
    if (gram) {
      // Same live-cache-first pattern as nexum above — basing this on
      // saved.gramBalance alone (a DB snapshot) could diverge from the
      // player's actual live balance if they're currently online.
      const curG = _gramBalanceCache.has(p.telegramId)
        ? _gramBalanceCache.get(p.telegramId) : (saved.gramBalance || 0);
      const newG = curG + Number(gram);
      saved.gramBalance = newG;
      _gramBalanceCache.set(p.telegramId, newG);
      io.to(`tg_${p.telegramId}`).emit('gramBalanceUpdate', { balance: newG });
    }
    // Targeted $set on just the touched fields — a full-document save from
    // this snapshot would revert any other savedData field this account's
    // own gameplay autosave wrote in the same window.
    const _giveSet = {};
    if (gold)  _giveSet['savedData.gold'] = saved.gold;
    if (nexum) _giveSet['savedData.nexumBalance'] = saved.nexumBalance;
    if (gram)  _giveSet['savedData.gramBalance'] = saved.gramBalance;
    if (Object.keys(_giveSet).length) await PlayerModel.updateOne({ _id: p._id }, { $set: _giveSet });
    io.to(`tg_${p.telegramId}`).emit('adminGive', { gold: Number(gold), nexum: Number(nexum), gram: Number(gram) });
    logPlayer(p.telegramId, p.username, 'admin_give', { gold, nexum, gram });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/transactions', adminAuth, async (req, res) => {
  try {
    const { status, page = 1 } = req.query;
    const filter = status ? { status } : {};
    const txs = await GramTxModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * 50).limit(50).lean();
    res.json({ txs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/clans', adminAuth, async (req, res) => {
  try {
    const clans = await ClanModel.find({}, 'name icon level xp members').sort({ level: -1, xp: -1 }).lean();
    res.json({ clans: clans.map(c => ({
      id: c._id, name: c.name, icon: c.icon, level: c.level, xp: c.xp,
      memberCount: c.members?.length || 0,
      members: c.members?.map(m => ({ username: m.username, role: m.role, telegramId: m.telegramId })) || [],
    })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/admin/clan/:id', adminAuth, async (req, res) => {
  try {
    await ClanModel.deleteOne({ _id: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/chat', adminAuth, (req, res) => {
  res.json({ messages: [...globalChatHistory] });
});

app.delete('/admin/chat/:idx', adminAuth, (req, res) => {
  const idx = Number(req.params.idx);
  if (idx >= 0 && idx < globalChatHistory.length) globalChatHistory.splice(idx, 1);
  res.json({ ok: true });
});

app.post('/admin/broadcast', adminAuth, async (req, res) => {
  try {
    const { text, target = 'all' } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text required' });
    if (target === 'online') {
      let sent = 0;
      io.sockets.sockets.forEach(s => {
        if (s.data?.telegramId) {
          tgApi('sendMessage', { chat_id: s.data.telegramId, text, parse_mode: 'HTML' }).catch(() => {});
          sent++;
        }
      });
      return res.json({ ok: true, sent });
    }
    // All players — batch with delay
    const players = await PlayerModel.find({}, 'telegramId').lean();
    let sent = 0;
    for (let i = 0; i < players.length; i++) {
      tgApi('sendMessage', { chat_id: players[i].telegramId, text, parse_mode: 'HTML' }).catch(() => {});
      sent++;
      if (i % 30 === 29) await new Promise(r => setTimeout(r, 1000));
    }
    res.json({ ok: true, sent });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Summon the world-event boss (shared/definitions.js EVENT_BOSS). Announces
// it to everyone immediately and spawns it EVENT_BOSS_ANNOUNCE_MS later.
app.post('/admin/event-boss', adminAuth, (req, res) => {
  const r = scheduleEventBoss();
  if (r.error) return res.status(409).json({ error: r.error });
  res.json(r);
});

app.get('/admin/event-boss', adminAuth, (req, res) => {
  const st = eventBossState();
  res.json({ spawnAt: st.spawnAt, alive: st.alive, dropsOnGround: st.drops.length });
});

app.get('/admin/market', adminAuth, async (req, res) => {
  try {
    const { page = 1, tab = 'active' } = req.query;
    const filter = tab === 'history' ? { status: { $in: ['sold', 'cancelled'] } } : { status: 'active' };
    const listings = await MarketListingModel.find(filter)
      .sort({ createdAt: -1 }).skip((page - 1) * 50).limit(50).lean();
    // Resolve referrers via sellerId (field name in model)
    const sellerIds = [...new Set(listings.map(l => l.sellerId).filter(Boolean))];
    const sellers = await PlayerModel.find({ telegramId: { $in: sellerIds } }, 'username telegramId referredBy').lean();
    const sellerMap = Object.fromEntries(sellers.map(s => [s.telegramId, s]));
    const refIds = [...new Set(sellers.map(s => s.referredBy).filter(Boolean))];
    const refs = await PlayerModel.find({ telegramId: { $in: refIds } }, 'username telegramId').lean();
    const refMap = Object.fromEntries(refs.map(r => [r.telegramId, r.username]));
    res.json({ listings: listings.map(l => ({
      _id: l._id, status: l.status,
      itemName: l.item?.name || l.item?.id || '?',
      itemRarity: l.item?.rarity || '',
      price: l.price,
      sellerUsername: l.sellerUsername || sellerMap[l.sellerId]?.username || l.sellerId,
      buyerUsername: l.buyerUsername || null,
      referrerUsername: sellerMap[l.sellerId]?.referredBy ? (refMap[sellerMap[l.sellerId].referredBy] || null) : null,
      createdAt: l.createdAt, soldAt: l.soldAt,
    })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/suspicious', adminAuth, async (req, res) => {
  try {
    const weekAgo = new Date(Date.now() - 7 * 86400000);
    const players = await PlayerModel.find(
      { createdAt: { $gte: weekAgo }, bm: { $gt: 3000 } },
      'username telegramId bm savedData createdAt'
    ).sort({ bm: -1 }).limit(50).lean();
    res.json({ players: players.map(p => ({
      telegramId: p.telegramId, username: p.username,
      bm: p.bm, lvl: p.savedData?.lvl || 1,
      gold: p.savedData?.gold || 0, createdAt: p.createdAt,
      ageHours: Math.round((Date.now() - new Date(p.createdAt)) / 3600000),
    })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Special Quests (admin CRUD) ──────────────────────────────────────────────
app.get('/admin/special-quests', adminAuth, async (req, res) => {
  try { res.json({ quests: await SpecialQuestModel.find({}).sort({ createdAt: -1 }).lean() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/admin/special-quests', adminAuth, async (req, res) => {
  try { res.json({ quest: await SpecialQuestModel.create(req.body) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/admin/special-quests/:id', adminAuth, async (req, res) => {
  try {
    const q = await SpecialQuestModel.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json({ quest: q });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/admin/special-quests/:id', adminAuth, async (req, res) => {
  try { await SpecialQuestModel.deleteOne({ _id: req.params.id }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Special Quests (public — game client) ─────────────────────────────────────
app.get('/api/special-quests', async (req, res) => {
  try {
    const quests = await SpecialQuestModel.find({ active: true }).sort({ createdAt: -1 }).lean();
    res.json({ quests });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Health check for container orchestrators / uptime monitors — the
// catch-all static handler below returns 200 for "/" regardless of DB
// state, which would otherwise report "healthy" even with Mongo down.
app.get('/health', (req, res) => {
  const dbOk = mongoose.connection.readyState === 1; // 1 = connected
  res.status(dbOk ? 200 : 503).json({ ok: dbOk, db: mongoose.connection.readyState });
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

// Single JS bundle — ETag changes on every server restart (bundle rebuilt on startup)
app.get('/bundle.js', (req, res) => {
  if (req.headers['if-none-match'] === jsBundleEtag) return res.status(304).end();
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('ETag', jsBundleEtag);
  res.setHeader('Cache-Control', 'no-cache');
  res.send(jsBundle);
});

// HTML/CSS: no cache so updates are picked up immediately
app.use(express.static(path.join(__dirname, '..')));

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

// One permanent Room for the whole open world — pre-created at startup, never
// destroyed. All players share the one world (no sub-instances, no capacity
// limit). MAX_FLOOR=1: the "floor" machinery below (floorRooms/currentFloor/
// the floor_1 socket.io room) is legacy plumbing from the old 5-floor system,
// kept as-is since it still works unchanged with a single permanent world —
// only renaming would churn without benefit.
const MAX_FLOOR = 1;
const floorRooms = new Map();

// ── Battle Power (БМ) formula ─────────────────────────────────────────────────
// Persists only the given savedData sub-fields (via Mongo dot-notation
// $set), never the whole savedData object. Several call sites used to do
// `findByIdAndUpdate(id, { savedData: {...} })`, which replaces the entire
// nested object — silently wiping any field that call didn't happen to
// know about. vipLevel/vipDeposited/vipPending (set only by the GRAM
// deposit-confirmation flow) and nexumBalance (set only on a Nexum drop)
// were never part of the client's regular save payload, so the very next
// ordinary save (loot pickup, quest, anything) erased them. Dot-notation
// $set only touches the keys actually passed here, leaving everything
// else already in the document untouched.
// ── Anti-cheat: sanitize the client-supplied save blob ─────────────────────────
// The economy in this game is otherwise client-authoritative (loot rolls,
// crafting and enhancing all happen on the client). This does NOT make it fully
// server-authoritative — a *valid* item id the player never legitimately earned
// still passes — but it removes the worst console-injection vectors before the
// blob is persisted or used for server-side combat/BM stats:
//   • fabricated item stats (a "legendary" with atk:99999) — every item is
//     rebuilt from the canonical catalog; only id + enhance + (stackable) qty
//     are trusted, exactly like the Market's _canonicalMarketItem.
//   • non-existent item ids — dropped entirely.
//   • absurd numeric values (gold:1e15, lvl:99999, baseAtk:1e9) — clamped.
// Rebuilding from the catalog is loss-free for legitimate items: the client
// stores each item as {…catalogBase, enhance} and derives the enhance bonus at
// runtime (see recompute()/enhanceBonus()), so no earned stat is discarded.
const _SANITIZE_MAX = {
  gold: 1e12, xp: 1e12, lvl: 1000, kills: 1e9, bonusSP: 1e6,
  maxHp: 1e7, atk: 1e6, def: 1e6, baseStat: 1e6, hpBase: 1e7, invLen: 500, storageLen: 200, qty: 9999,
};

function _catalogBase(id) {
  return ITEM_DEF.find(d => d.id === id) || CRAFT_MATS.find(d => d.id === id) || BOX_DEF.find(d => d.id === id) || null;
}

// Rebuild one inventory/equipment entry from the canonical catalog, trusting the
// client only for id, enhance level and (stackables) qty. Unknown id → null.
function _canonSavedItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const base = _catalogBase(raw.id);
  if (!base) return null;
  const item = { ...base };
  if (ENHANCEABLE_SLOTS.has(base.slot)) {
    const enh = Math.floor(Number(raw.enhance));
    item.enhance = (Number.isFinite(enh) && enh >= 0 && enh <= ENHANCE_MAX) ? enh : 0;
  }
  if (isStackableItem(base)) {
    const qty = Math.floor(Number(raw.qty));
    item.qty = (Number.isFinite(qty) && qty >= 1 && qty <= _SANITIZE_MAX.qty) ? qty : 1;
  }
  return item;
}

function _clampNum(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}
function _clampInt(v, min, max, dflt) { return Math.floor(_clampNum(v, min, max, dflt)); }

const _VALID_LANGS = ['ru', 'en', 'uk', 'es', 'tr', 'pt'];

function _sanitizeSavedStats(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const s = { ...raw };

  // Language preference (js/i18n.js) — display-only, but validate anyway
  // rather than trust an arbitrary client string.
  if (s.lang != null) s.lang = _VALID_LANGS.includes(s.lang) ? s.lang : 'ru';

  // Inventory — canonicalize, drop unknowns, cap length
  s.inventory = Array.isArray(s.inventory)
    ? s.inventory.slice(0, _SANITIZE_MAX.invLen).map(_canonSavedItem).filter(Boolean)
    : [];

  // Storage (Хранилище NPC) — same canonicalization, capped at 200 slots
  s.storage = Array.isArray(s.storage)
    ? s.storage.slice(0, _SANITIZE_MAX.storageLen).map(_canonSavedItem).filter(Boolean)
    : [];

  // Equipment — { slot: item }; canonicalize, drop unknowns
  if (s.equipment && typeof s.equipment === 'object' && !Array.isArray(s.equipment)) {
    const eq = {};
    for (const [slot, it] of Object.entries(s.equipment)) {
      if (!it) continue;
      const c = _canonSavedItem(it);
      if (c) eq[slot] = c;
    }
    s.equipment = eq;
  } else {
    s.equipment = {};
  }

  // Numeric progression clamps (reject NaN/Infinity/negatives/absurd values)
  s.gold    = _clampInt(s.gold,    0, _SANITIZE_MAX.gold, 0);
  s.lvl     = _clampInt(s.lvl,     1, _SANITIZE_MAX.lvl, 1);
  s.xp      = _clampNum(s.xp,      0, _SANITIZE_MAX.xp, 0);
  s.kills   = _clampInt(s.kills,   0, _SANITIZE_MAX.kills, 0);
  s.bonusSP = _clampInt(s.bonusSP, 0, _SANITIZE_MAX.bonusSP, 0);
  if (s.maxHp     != null) s.maxHp     = _clampInt(s.maxHp,     1, _SANITIZE_MAX.maxHp, 100);
  if (s.hp        != null) s.hp        = _clampNum(s.hp,        0, s.maxHp ?? _SANITIZE_MAX.maxHp, 0);
  if (s.atk       != null) s.atk       = _clampNum(s.atk,       0, _SANITIZE_MAX.atk, 0);
  if (s.def       != null) s.def       = _clampNum(s.def,       0, _SANITIZE_MAX.def, 0);
  if (s.baseAtk   != null) s.baseAtk   = _clampNum(s.baseAtk,   0, _SANITIZE_MAX.baseStat, 0);
  if (s.baseDef   != null) s.baseDef   = _clampNum(s.baseDef,   0, _SANITIZE_MAX.baseStat, 0);
  if (s.baseMaxHp != null) s.baseMaxHp = _clampNum(s.baseMaxHp, 1, _SANITIZE_MAX.hpBase, 100);
  if (s.autoHpPct != null) s.autoHpPct = _clampNum(s.autoHpPct, 0, 1, 0.5);

  if (s.upgrades && typeof s.upgrades === 'object' && !Array.isArray(s.upgrades)) {
    const u = {};
    for (const [k, v] of Object.entries(s.upgrades)) u[k] = _clampInt(v, 0, 1e5, 0);
    s.upgrades = u;
  }
  // Freshness stamp used only to pick the newer of {DB, client localStorage
  // backup} on reload. Clamp to a sane range so a client can't write a
  // far-future value that would make its record permanently "win".
  if (s.savedAt != null) s.savedAt = _clampInt(s.savedAt, 0, Date.now() + 60000, 0);
  // Real-money balances are server-authoritative and are NEVER taken from the
  // client blob — they live in _gramBalanceCache/_nexumBalanceCache and are
  // re-attached explicitly by every persist path (see _liveGram/_liveNexum).
  // Dropping them here (rather than merely overriding them downstream) means
  // a client can't inject a balance, and a future persist call that forgets
  // the explicit override writes nothing for these keys instead of writing a
  // client-supplied number — _persistSavedFields skips undefined values.
  delete s.gramBalance;
  delete s.nexumBalance;
  return s;
}

// Escape user input before embedding it in a Mongo $regex, so a crafted query
// can't inject regex operators (ReDoS / catastrophic backtracking on the DB).
function _escapeRegex(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Last line of defense against a client-side race (e.g. a save firing before
// restoreFromSave has populated the real character — the exact shape of the
// bug fixed in "stop wiping saved progress on refresh when savedData.type is
// stale") silently overwriting real progress with a blank starter character.
// A legitimate save never simultaneously zeroes level, gold, kills, inventory
// AND equipment at once — those don't all reset together in normal play — so
// treat that combination as corruption and refuse to persist it rather than
// trust the client blindly.
function _looksLikeCatastrophicReset(prev, next) {
  if (!prev) return false;
  const hadProgress = (prev.lvl || 1) > 2 || (prev.gold || 0) > 0 ||
    (prev.inventory || []).length > 0 || Object.keys(prev.equipment || {}).length > 0;
  if (!hadProgress) return false;
  const isBlank = (next.lvl || 1) <= 1 && (next.gold || 0) === 0 && (next.kills || 0) === 0 &&
    (next.inventory || []).length === 0 && Object.keys(next.equipment || {}).length === 0;
  return isBlank;
}

function _persistSavedFields(authed, fields, extra) {
  if (!authed) return;
  const set = {};
  Object.keys(fields).forEach(k => { if (fields[k] !== undefined) set[`savedData.${k}`] = fields[k]; });
  if (extra) Object.keys(extra).forEach(k => { set[k] = extra[k]; });
  // Returns the write promise so callers that need the persist to actually
  // land before proceeding (see socket.data._flushNow above) can await it;
  // existing fire-and-forget call sites are unaffected since they don't.
  return PlayerModel.findByIdAndUpdate(authed._id, { $set: set }).catch(() => {});
}

// Keep in sync with the identical calcBM in js/definitions.js — the client
// renders this number in the HUD and clan panel, the server stores it for the
// rating and reports it in raid/party-dungeon lobbies, and the two disagreeing
// is immediately visible to players.
// The level field is `lvl` everywhere (save blobs and the live player object
// alike); reading `s.level` matched nothing, so the level term silently
// collapsed to its `|| 1` fallback and BM ignored levels entirely.
function calcBM(s) {
  if (!s) return 0;
  const upg = s.upgrades || {};
  const extras = ((upg.critChance || 0) + (upg.critPower || 0) +
    (upg.hpRegen || 0) + (upg.atkSpeed || 0)) * 8;
  return Math.round((s.lvl || s.level || 1) * 50 + (s.atk || 0) * 5 + (s.def || 0) * 3 + (s.maxHp || 100) * 0.5 + extras);
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

// Global chat history (last 30 messages across all floors)
const globalChatHistory = [];
function _recordChat(username, text) {
  const now = new Date();
  const time = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
  globalChatHistory.push({ username, text, time });
  if (globalChatHistory.length > 30) globalChatHistory.shift();
}

// Clan chat history — last 30 per clan, keyed by clan _id (string). Same
// ephemeral in-memory model as globalChatHistory above (resets on restart,
// no DB persistence) — kept consistent with the rest of this chat system.
const clanChatHistory = new Map(); // clanId string -> [{username, text, time}]
function _recordClanChat(clanId, username, text) {
  const key = String(clanId);
  const now = new Date();
  const time = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
  const arr = clanChatHistory.get(key) || [];
  arr.push({ username, text, time });
  if (arr.length > 30) arr.shift();
  clanChatHistory.set(key, arr);
}

// Private messages — last 50 per conversation, keyed by the two participants'
// telegramIds sorted into a stable pair key. Also in-memory only, same model
// as above; resolving a conversation by username (not telegramId) works
// whether or not the other party is currently online — only realtime
// *delivery* requires them to be connected (see the privMsg handler).
const dmHistory = new Map(); // "tidA|tidB" -> [{username, text, time}]
function _dmKey(a, b) { return [String(a), String(b)].sort().join('|'); }
function _recordDm(tidA, tidB, username, text) {
  const key = _dmKey(tidA, tidB);
  const now = new Date();
  const time = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
  const arr = dmHistory.get(key) || [];
  arr.push({ username, text, time });
  if (arr.length > 50) arr.shift();
  dmHistory.set(key, arr);
}
// Resolves a @nickname to the canonical account, whether or not they're
// currently online (DB lookup, case-insensitive exact match — Telegram
// handles are treated as case-insensitive everywhere else in this app).
async function _resolveUsername(name) {
  const target = String(name || '').trim().replace(/^@/, '');
  if (!target) return null;
  return PlayerModel.findOne({ username: new RegExp('^' + _escapeRegex(target) + '$', 'i') }, 'telegramId username').lean();
}

// ── Party state ───────────────────────────────────────────────────────────────
// partyId -> Map<socketId, username>  (up to 5 members)
const parties     = new Map();
// socketId -> partyId
const playerParty = new Map();
// socketId -> current floor number (for proximity check)
const playerFloorMap = new Map();

// ── Raid state ────────────────────────────────────────────────────────────────
// raidId -> RaidRoom
const raidRooms  = new Map();
// socketId -> raidId
const playerRaid = new Map();

// ── Raid lobby state ─────────────────────────────────────────────────────────
// lobbyId -> { id, creatorId, creatorName, dungeonId, members: Map<sid, {name, bm, lvl}> }
const raidLobbies = new Map();
// socketId -> lobbyId
const playerLobby = new Map();

// ── Party dungeon state (maze + boss instance, min 3 players, 1x/day) ─────────
// pdId -> PartyDungeonRoom
const pdRooms = new Map();
// socketId -> pdId
const playerPartyDungeon = new Map();
// pdLobbyId -> { id, creatorId, creatorName, members: Map<sid, {name, bm, lvl}> }
const pdLobbies = new Map();
// socketId -> pdLobbyId
const playerPdLobby = new Map();
const PARTY_DUNGEON_MIN_MEMBERS = 3;
const PARTY_DUNGEON_MAX_MEMBERS = 8;

function _pdLobbyBroadcast() {
  const list = [...pdLobbies.values()].map(lb => ({
    id: lb.id, creatorName: lb.creatorName,
    members: [...lb.members.entries()].map(([sid, m]) => ({ id: sid, name: m.name, bm: m.bm, lvl: m.lvl })),
  }));
  io.emit('pdLobbyList', { lobbies: list });
}

function _cleanupPdLobby(socketId) {
  const lobbyId = playerPdLobby.get(socketId);
  if (!lobbyId) return;
  const lb = pdLobbies.get(lobbyId);
  if (!lb) { playerPdLobby.delete(socketId); return; }
  lb.members.delete(socketId);
  playerPdLobby.delete(socketId);
  if (lb.members.size === 0 || lb.creatorId === socketId) {
    lb.members.forEach((_, mid) => { playerPdLobby.delete(mid); io.to(mid).emit('pdLobbyLeft', { reason: 'disbanded' }); });
    pdLobbies.delete(lobbyId);
    _pdLobbyBroadcast();
  } else {
    _pdLobbyBroadcast();
  }
}

// Removes a player from a live party-dungeon instance's bookkeeping (does
// NOT touch the instance itself — caller handles that separately since the
// instance may need to keep running for the rest of the party).
function _cleanupPartyDungeonPlayer(socketId, channel) {
  playerPartyDungeon.delete(socketId);
  const s = io.sockets.sockets.get(socketId);
  if (s && channel) s.leave(channel);
  const fl = playerFloorMap.get(socketId);
  if (fl !== undefined) {
    const fr = floorRooms.get(fl);
    const p = fr?.players.get(socketId);
    if (p) { p._inRaid = false; p._knownE.clear(); }
  }
}

function _cleanupPartyDungeon(socketId) {
  const pdId = playerPartyDungeon.get(socketId);
  if (!pdId) return;
  const pd = pdRooms.get(pdId);
  const channel = pd ? pd.channel : null;
  _cleanupPartyDungeonPlayer(socketId, channel);
  if (pd) {
    pd.removePlayer(socketId);
    if (pd.players.size === 0) { pd.stop(); pdRooms.delete(pdId); }
  }
}

// Atomically credits Nexum to an arbitrary (possibly-not-the-caller) online
// player by socketId, keyed through their telegramId — this is how party
// dungeon loot can be awarded to a random party member rather than only the
// player whose attack landed the kill.
async function _grantPartyDungeonNexum(winnerSocketId, amount) {
  if (!(amount > 0)) return;
  const s = io.sockets.sockets.get(winnerSocketId);
  const tid = s?.data?.telegramId;
  if (tid == null) return;
  try {
    const updated = await PlayerModel.findOneAndUpdate(
      { telegramId: tid },
      { $inc: { 'savedData.nexumBalance': amount } },
      { new: true }
    ).select('savedData.nexumBalance');
    if (!updated) return;
    const newBal = updated.savedData?.nexumBalance || 0;
    _nexumBalanceCache.set(tid, newBal);
    io.to(winnerSocketId).emit('partyDungeonNexum', { amount, balance: newBal });
  } catch (e) { console.error('party dungeon nexum grant:', e); }
}

// Both the raid ("Подземелье 1") and the party dungeon ("Лабиринт") allow
// DAILY_DUNGEON_ATTEMPTS runs per UTC day — each gets its own savedData
// field (see the wrapper functions below) so their attempt pools are
// independent. The attempt is consumed on entry (start*Lobby), not on a
// successful clear, so dying/failing doesn't refund it. Written straight to
// Mongo by telegramId so it works regardless of which member's socket
// triggered it.
const DAILY_DUNGEON_ATTEMPTS = 3;
function _todayStr() { return new Date().toISOString().slice(0, 10); }

function _lockDailyAttempt(socketId, field) {
  const s = io.sockets.sockets.get(socketId);
  const tid = s?.data?.telegramId;
  if (tid == null) return;
  const today = _todayStr();
  PlayerModel.findOne({ telegramId: tid }).select(`savedData.${field}`).lean()
    .then(doc => {
      const prev = doc?.savedData?.[field];
      const count = (prev && prev.date === today) ? prev.count + 1 : 1;
      return PlayerModel.findOneAndUpdate({ telegramId: tid }, { $set: { [`savedData.${field}`]: { date: today, count } } });
    }).catch(() => {});
}

async function _dailyAttemptsLeft(socketId, field) {
  const s = io.sockets.sockets.get(socketId);
  const tid = s?.data?.telegramId;
  if (tid == null) return DAILY_DUNGEON_ATTEMPTS;
  try {
    const doc = await PlayerModel.findOne({ telegramId: tid }).select(`savedData.${field}`).lean();
    const rec = doc?.savedData?.[field];
    if (!rec || rec.date !== _todayStr()) return DAILY_DUNGEON_ATTEMPTS;
    return Math.max(0, DAILY_DUNGEON_ATTEMPTS - rec.count);
  } catch (e) { return DAILY_DUNGEON_ATTEMPTS; }
}

function _lockPartyDungeonDaily(socketId)            { _lockDailyAttempt(socketId, 'partyDungeonAttempts'); }
async function _partyDungeonLockedToday(socketId)    { return (await _dailyAttemptsLeft(socketId, 'partyDungeonAttempts')) <= 0; }
function _lockRaidDaily(socketId)                    { _lockDailyAttempt(socketId, 'raidAttempts'); }
async function _raidLockedToday(socketId)            { return (await _dailyAttemptsLeft(socketId, 'raidAttempts')) <= 0; }

// Shared by partyDungeonAttack/partyDungeonSkillAttack — mirrors the normal
// attack/skillAttack handlers' kill-reward flow, but rewards split across
// the *whole instance roster* (every member is, by construction, "the
// party" here) instead of the ambient party system, and with this
// dungeon's own drop rates: 50% Nexum per regular kill, 50%/10% enchant
// stones on the boss kill — both to one random member, not the killer.
function _handlePartyDungeonKillResult(pd, attackerId, enemyId, result) {
  if (!result.killed) {
    // dmg only to the attacker — see the enemyHurt split in the normal attack
    // handler for why (floating number / vampirism / kill prediction).
    io.to(attackerId).emit('partyDungeonEnemyHurt', { id: enemyId, hp: result.hp, dmg: result.dmg, isCrit: result.isCrit });
    io.to(pd.channel).except(attackerId).emit('partyDungeonEnemyHurt', { id: enemyId, hp: result.hp });
    return;
  }
  const mids = [...pd.memberIds];
  const n = Math.max(1, mids.length);
  const xpShare = result.xp / n, goldShare = result.gold / n;
  const nexumDrop  = !result.isBoss && Math.random() < 0.50 ? 1 : 0;
  const normStone  = result.isBoss && Math.random() < 0.50 ? 1 : 0;
  const blessStone = result.isBoss && Math.random() < 0.10 ? 1 : 0;
  const lootWinnerId = mids[Math.floor(Math.random() * n)];

  mids.forEach(mid => {
    io.to(mid).emit('partyDungeonEnemyKilled', {
      id: enemyId, xp: xpShare, gold: goldShare,
      dmg: mid === attackerId ? result.dmg : undefined,
      isCrit: mid === attackerId ? result.isCrit : undefined,
      ex: result.ex, ey: result.ey, color: result.color, eid: result.eid, isBoss: result.isBoss,
      normStone:  mid === lootWinnerId ? normStone  : 0,
      blessStone: mid === lootWinnerId ? blessStone : 0,
    });
  });
  if (nexumDrop > 0) _grantPartyDungeonNexum(lootWinnerId, nexumDrop);

  if (result.isBoss) {
    pd.state = 'complete';
    pd.stop();
    mids.forEach(mid => {
      io.to(mid).emit('partyDungeonComplete', { gold: goldShare, xp: xpShare });
      _cleanupPartyDungeonPlayer(mid, pd.channel);
    });
    pdRooms.delete(pd.id);
  }
}

function _lobbyBroadcast() {
  const list = [...raidLobbies.values()].map(lb => ({
    id: lb.id, creatorName: lb.creatorName, dungeonId: lb.dungeonId,
    members: [...lb.members.entries()].map(([sid, m]) => ({ id: sid, name: m.name, bm: m.bm, lvl: m.lvl })),
  }));
  io.emit('lobbyList', { lobbies: list });
}

function _cleanupLobby(socketId) {
  const lobbyId = playerLobby.get(socketId);
  if (!lobbyId) return;
  const lb = raidLobbies.get(lobbyId);
  if (!lb) { playerLobby.delete(socketId); return; }
  lb.members.delete(socketId);
  playerLobby.delete(socketId);
  if (lb.members.size === 0 || lb.creatorId === socketId) {
    lb.members.forEach((_, mid) => { playerLobby.delete(mid); io.to(mid).emit('lobbyLeft', { reason: 'disbanded' }); });
    raidLobbies.delete(lobbyId);
    _lobbyBroadcast();
  } else {
    _lobbyBroadcast();
  }
}

function _cleanupRaidPlayer(socketId) {
  playerRaid.delete(socketId);
  const fl = playerFloorMap.get(socketId);
  if (fl !== undefined) {
    const fr = floorRooms.get(fl);
    if (fr) {
      const p = fr.players.get(socketId);
      if (p) {
        p._inRaid = false;
        p._knownE.clear(); // force full enemy refresh on next gameState
      }
    }
  }
}

function _cleanupRaid(socketId) {
  const rId = playerRaid.get(socketId);
  if (!rId) return;
  _cleanupRaidPlayer(socketId);
  const rr = raidRooms.get(rId);
  if (rr) {
    rr.removePlayer(socketId);
    if (rr.memberIds.length === 0) { rr._stop(); raidRooms.delete(rId); }
  }
}

// Remove leaverId from their party; notify remaining members.
// If only 1 member remains the party dissolves entirely.
function _removeFromParty(partyId, leaverId) {
  const members = parties.get(partyId);
  if (!members) return;

  const leaverName = members.get(leaverId) || leaverId.slice(0, 6);
  members.delete(leaverId);
  playerParty.delete(leaverId);

  const remaining = [];
  members.forEach((name, id) => remaining.push({ id, name }));

  if (remaining.length <= 1) {
    // Party fully dissolves
    parties.delete(partyId);
    remaining.forEach(m => {
      playerParty.delete(m.id);
      io.to(m.id).emit('partyLeft', { leftName: leaverName });
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

function getRoom(floor) {
  return floorRooms.get(Math.max(1, Math.min(MAX_FLOOR, floor)));
}

// ── Event boss scheduling ───────────────────────────────────────────────────
// An admin summon doesn't spawn the boss straight away: everyone gets a
// countdown banner first (EVENT_BOSS_ANNOUNCE_MS), then it appears. The
// pending time is module state rather than per-socket so a player who logs in
// mid-countdown still sees the timer (sent from gameStart, see selectChar).
let _eventBossSpawnAt = 0;
let _eventBossTimer   = null;

function eventBossState() {
  const room = getRoom(1);
  return {
    spawnAt: _eventBossSpawnAt > Date.now() ? _eventBossSpawnAt : 0,
    alive: !!(room && room.isEventBossAlive()),
    drops: room ? room.worldDropSnapshot() : [],
  };
}

function scheduleEventBoss() {
  const room = getRoom(1);
  if (!room) return { error: 'Мир ещё не инициализирован' };
  if (room.isEventBossAlive()) return { error: 'Босс уже на карте' };
  if (_eventBossSpawnAt > Date.now()) return { error: 'Босс уже вызван — идёт отсчёт' };
  _eventBossSpawnAt = Date.now() + EVENT_BOSS_ANNOUNCE_MS;
  io.to('floor_1').emit('eventBossAnnounce', { spawnAt: _eventBossSpawnAt });
  clearTimeout(_eventBossTimer);
  _eventBossTimer = setTimeout(() => {
    _eventBossSpawnAt = 0;
    const r = getRoom(1);
    if (!r) return;
    const boss = r.spawnEventBoss();
    if (boss) io.to('floor_1').emit('eventBossSpawned', { x: boss.x, y: boss.y });
  }, EVENT_BOSS_ANNOUNCE_MS);
  return { ok: true, spawnAt: _eventBossSpawnAt };
}

// ── Death Battle (Битва на смерть) ──────────────────────────────────────────
// Runs on a fixed daily schedule (shared/definitions.js): registration opens
// DEATH_BATTLE_REG_MS before each start, then everyone signed up is dropped
// into the arena in PvP and fights until one is left. All of it is module
// state rather than per-socket, so a player who connects mid-registration sees
// the same countdown as everyone else (sent from gameStart, see selectChar).
const _db = {
  phase: 'idle',       // 'idle' → 'reg' → 'live' → 'idle'
  startAt: 0,          // when the fighting begins (also the registration deadline)
  reg: new Map(),      // socketId -> { name }
  alive: new Map(),    // socketId -> { name }
  // Set for exactly one socket between winning and closing the reward modal,
  // and cleared the moment it's used — deathBattleReturn teleports whoever
  // sends it to the hub, so without this any client could emit it at will as a
  // free instant travel home.
  winnerId: null,
  // While Date.now() < fightAt everyone is in the arena but held still: the
  // server refuses their movement and attacks outright (see _dbFrozen), so a
  // modified client can't get a head start by ignoring the countdown.
  fightAt: 0,
  regTimer: null, startTimer: null, maxTimer: null, freezeTimer: null,
};

// True while this socket is an entrant of a round that hasn't gone live yet.
function _dbFrozen(socketId) {
  return _db.phase === 'live' && Date.now() < _db.fightAt && _db.alive.has(socketId);
}

// Next scheduled start, in UTC ms. Moscow is UTC+3 year-round (no DST since
// 2014), so the offset is a constant rather than a timezone lookup: shift into
// Moscow time to read the calendar date there, then shift the resulting
// midnight back to real UTC before adding the hour.
function _dbNextStartAt(from = Date.now()) {
  const OFF = DEATH_BATTLE_MSK_OFFSET_H * 3600000;
  const msk = new Date(from + OFF);
  let best = Infinity;
  for (let dayShift = 0; dayShift <= 1; dayShift++) {
    const midnightUtc = Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate() + dayShift) - OFF;
    for (const h of DEATH_BATTLE_HOURS_MSK) {
      const t = midnightUtc + h * 3600000;
      if (t > from && t < best) best = t;
    }
  }
  return best;
}

function _dbPublicState() {
  return {
    phase:   _db.phase,
    startAt: _db.startAt,
    nextAt:  _dbNextStartAt(),
    count:   _db.phase === 'live' ? _db.alive.size : _db.reg.size,
  };
}

function _dbBroadcast() {
  io.to('floor_1').emit('deathBattleState', _dbPublicState());
}

// Arms the registration window for the next start time. Called at boot and
// after every round; if the process happens to start inside a registration
// window the timeout is already due and fires immediately with whatever time
// is left, which is the correct behaviour.
function _dbSchedule() {
  clearTimeout(_db.regTimer);
  _db.phase = 'idle';
  _db.startAt = 0;
  const startAt = _dbNextStartAt();
  _db.regTimer = setTimeout(() => _dbOpenReg(startAt), Math.max(0, startAt - DEATH_BATTLE_REG_MS - Date.now()));
}

function _dbOpenReg(startAt) {
  _db.phase = 'reg';
  _db.startAt = startAt;
  _db.reg.clear();
  _db.alive.clear();
  clearTimeout(_db.startTimer);
  _db.startTimer = setTimeout(_dbStart, Math.max(0, startAt - Date.now()));
  _dbBroadcast();
}

function _dbStart() {
  const room = getRoom(1);
  // Only entrants who are still connected and still in the world can fight.
  const ids = [..._db.reg.keys()].filter(sid =>
    io.sockets.sockets.get(sid) && room && room.players.get(sid));
  if (!room || ids.length < DEATH_BATTLE_MIN_PLAYERS) {
    io.to('floor_1').emit('deathBattleCancelled', { reason: 'notEnough' });
    _db.reg.clear();
    _dbSchedule();
    _dbBroadcast();
    return;
  }
  _db.phase = 'live';
  _db.alive.clear();
  _db.fightAt = Date.now() + DEATH_BATTLE_FREEZE_MS;
  const placed = room.deathBattleDeploy(ids);
  placed.forEach(({ socketId, x, y, hp }) => {
    _db.alive.set(socketId, _db.reg.get(socketId) || { name: '?' });
    io.to(socketId).emit('deathBattleStarted', { x, y, hp, total: placed.length, fightAt: _db.fightAt });
  });
  _db.reg.clear();
  // Lift the freeze on a timer as well as by clock, so clients get a clean
  // "go" push instead of each deciding for itself when the countdown ended.
  clearTimeout(_db.freezeTimer);
  _db.freezeTimer = setTimeout(() => {
    if (_db.phase !== 'live') return;
    _db.alive.forEach((_, sid) => io.to(sid).emit('deathBattleFight'));
  }, DEATH_BATTLE_FREEZE_MS);
  // Safety net: a round where nobody can finish anybody off (everyone hiding,
  // a wedged client) would otherwise block every later round forever.
  clearTimeout(_db.maxTimer);
  _db.maxTimer = setTimeout(() => _dbFinish(true), DEATH_BATTLE_MAX_MS);
  _dbBroadcast();
}

// Drops one entrant out of a running round. Safe to call for a socket that
// isn't in the round (a normal PvP kill elsewhere, an unrelated disconnect) —
// it returns immediately.
function _dbEliminate(socketId) {
  if (_db.phase !== 'live') return;
  if (!_db.alive.delete(socketId)) return;
  const room = getRoom(1);
  const spot = room ? room.deathBattleReturn(socketId) : null;
  io.to(socketId).emit('deathBattleEliminated', { left: _db.alive.size, x: spot?.x, y: spot?.y });
  _dbBroadcast();
  if (_db.alive.size <= 1) _dbFinish(false);
}

async function _dbFinish(timedOut) {
  if (_db.phase !== 'live') return;
  clearTimeout(_db.maxTimer);
  clearTimeout(_db.freezeTimer);
  _db.phase = 'idle';
  _db.fightAt = 0;
  const room = getRoom(1);
  // A timeout has no winner: send everyone still standing back to the hub.
  const winnerId = (!timedOut && _db.alive.size === 1) ? [..._db.alive.keys()][0] : null;
  _db.alive.forEach((_, sid) => {
    if (sid === winnerId) return;
    const spot = room ? room.deathBattleReturn(sid) : null;
    io.to(sid).emit('deathBattleEliminated', { left: 0, x: spot?.x, y: spot?.y });
  });
  _db.alive.clear();
  _db.winnerId = winnerId;
  if (winnerId) {
    const s = io.sockets.sockets.get(winnerId);
    // The prize is granted through the winner's own socket closure, which is
    // where its inventory/GRAM copies live (same reasoning as pickupWorldDrop).
    const items = s?.data?._dbGrantWin ? await s.data._dbGrantWin() : null;
    if (s) s.emit('deathBattleWon', { gram: DEATH_BATTLE_GRAM_REWARD, items: items || [] });
  }
  _dbSchedule();
  _dbBroadcast();
}

// Pre-create all floor rooms once MongoDB is reachable. Idempotent so it's
// safe to trigger from more than one path below.
function _initFloorRooms() {
  if (floorRooms.size > 0) return;
  for (let f = 1; f <= MAX_FLOOR; f++) {
    floorRooms.set(f, new Room(f, io));
  }
  console.log('Floor rooms initialized');
  // Needs Mongo, so it starts here rather than at require time.
  _refreshTopPlayer();
  setInterval(_refreshTopPlayer, TOP_PLAYER_POLL_MS);
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
  const _roomInitRetry = setInterval(() => {
    if (mongoose.connection.readyState !== 1) return;
    clearInterval(_roomInitRetry);
    _initFloorRooms();
  }, 2000);
}

io.on('connection', socket => {
  let authed = null;
  let currentRoom = null;
  let currentFloor = 1;
  let _lastStats = null;
  let _autoSaveInterval = null;
  let _myClanName = null;
  let _myClanIcon = null;
  // Per-socket MIRROR of the account's balances — NOT the source of truth.
  // _gramBalanceCache/_nexumBalanceCache (keyed by telegramId) are, because
  // several credit paths run in a *different* connection's closure — or in no
  // connection at all — and can only reach the account through the cache:
  //   • a market sale's payout to the seller (marketBuy runs on the BUYER's
  //     socket),
  //   • an admin confirming a deposit, and the 5% referral bonus it pays,
  //   • POST /admin/player/:tid/give,
  //   • _grantPartyDungeonNexum (credits an arbitrary party member).
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
  let _saveDebounceTimer = null;
  let _lastChatAt = 0;
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
    'gramGetHistory', 'gramShopBuy', 'gramDepositRequest', 'gramWithdrawRequest',
    'getReferrals', 'getRating', 'completeSpecialQuest', 'claimVipRewards',
    'clanCreate', 'clanSearch', 'clanApply', 'clanApprove', 'clanDecline',
    'clanKick', 'clanLeave', 'clanDisband',
    'createRaidLobby', 'joinRaidLobby', 'startRaidLobby', 'getLobbyList',
    'createPartyDungeonLobby', 'joinPartyDungeonLobby', 'startPartyDungeonLobby', 'getPartyDungeonLobbyList',
    'partyInvite', 'partyAccept', 'saveProgress', 'selectChar',
  ]);
  const _rlHeavy = { n: 0, reset: 0 };
  const _rlFast  = { n: 0, reset: 0 };
  function _rlBump(bucket, max) {
    const now = Date.now();
    if (now > bucket.reset) { bucket.n = 0; bucket.reset = now + 5000; }
    return ++bucket.n <= max;
  }
  socket.use((packet, next) => {
    const ev = packet && packet[0];
    const bucket = _HEAVY_EVENTS.has(ev) ? _rlHeavy : _rlFast;
    // per 5s window. Heavy (DB/query/broadcast) kept tight; fast (movement/
    // combat, sent per-frame) set high enough to never throttle real play —
    // it only exists to cut a scripted flood.
    const max    = _HEAVY_EVENTS.has(ev) ? 40 : 1500;
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
    if (authed && _lastStats) {
      await _persistSavedFields(authed,
        { ..._lastStats, gramBalance: _liveGram(), nexumBalance: _liveNexum() },
        { bm: authed.bm });
    }
  };

  // Hands the death-battle winner its prize. Lives here rather than beside
  // _dbFinish because this is where the socket's own inventory/GRAM copies
  // are (same reasoning as pickupWorldDrop's award path). Returns the item
  // list so the caller can show it in the win modal.
  socket.data._dbGrantWin = async () => {
    if (!authed) return null;
    const items = deathBattleRewards();
    const inv = (_lastStats && Array.isArray(_lastStats.inventory)) ? _lastStats.inventory : null;
    if (inv) items.forEach(it => _invAdd(inv, it));
    _setGram(_round7(_liveGram() + DEATH_BATTLE_GRAM_REWARD));
    await _persistSavedFields(authed,
      { ...(inv ? { inventory: inv } : {}), gramBalance: _liveGram() });
    logPlayer(authed.telegramId, authed.username, 'death_battle_win', { gram: DEATH_BATTLE_GRAM_REWARD });
    return items;
  };

  const NEXUM_DROP_CHANCE = [0, 0.005, 0.01, 0.02, 0.03, 0.05];
  // Tiny GRAM trickle from regular kills: 30% chance, amount scales with the
  // monster's own level (rlvl) — a level-1 mob drops 0.000001 GRAM, a
  // level-2 mob 0.000002, and so on.
  const GRAM_DROP_CHANCE = 0.30;
  const GRAM_PER_LEVEL = 0.0000001;

  function _startAutosave() {
    if (_autoSaveInterval) clearInterval(_autoSaveInterval);
    _autoSaveInterval = setInterval(() => {
      if (!authed || !_lastStats) return;
      const saveData = { ..._lastStats, floor: currentFloor, gramBalance: _liveGram(), nexumBalance: _liveNexum() };
      if (currentRoom) {
        const p = currentRoom.players.get(socket.id);
        if (p && p.hp > 0) saveData.hp = p.hp;
      }
      const bmNow = calcBM(_lastStats);
      authed.bm = bmNow;
      _persistSavedFields(authed, saveData, { bm: bmNow });
    }, 60000);
  }

  // Wraps every socket.on registration below so a thrown error or rejected
  // promise inside a single handler can't escape to process scope — the
  // global uncaughtException/unhandledRejection handler calls process.exit()
  // shortly after logging, which would otherwise drop every connected
  // player's connection over one bad packet in one handler.
  function safeOn(event, handler) {
    socket.on(event, (...args) => {
      try {
        const ret = handler(...args);
        if (ret && typeof ret.catch === 'function') {
          ret.catch(err => console.error(`[socket:${event}]`, err));
        }
      } catch (err) {
        console.error(`[socket:${event}]`, err);
      }
    });
  }

  safeOn('_ping', t0 => socket.emit('_pong', t0));

  safeOn('loginTelegramWebApp', async ({ initData }) => {
    try {
      const verified = verifyTelegramWebApp(initData);
      if (!verified) return socket.emit('authError', { message: 'Ошибка авторизации Telegram' });
      const { user, startParam } = verified;
      const telegramId = String(user.id);
      const username = user.username || user.first_name || `tg_${telegramId}`;
      // Reserve slot before first await to prevent concurrent logins
      if (activeSessions.has(telegramId) && activeSessions.get(telegramId) !== socket.id) {
        const _prevSocket = io.sockets.sockets.get(activeSessions.get(telegramId));
        if (_prevSocket) {
          _prevSocket.emit('kicked', { reason: 'Вы вошли с другого устройства' });
          // Must land before the DB read below — otherwise this read can race
          // the old socket's async disconnect-flush and return stale data.
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
      if (doc.banned) {
        activeSessions.delete(telegramId);
        return socket.emit('authError', { message: 'Ваш аккаунт заблокирован' });
      }
      authed = doc;
      socket.data.username = doc.username;
      socket.data.telegramId = telegramId;
      if (doc.savedData) _lastStats = doc.savedData;
      _setGram(doc.savedData?.gramBalance || 0);
      _setNexum(doc.savedData?.nexumBalance || 0);
      _startAutosave();
      socket.join(`tg_${telegramId}`);
      const _clan = await ClanModel.findOne({ 'members.telegramId': telegramId }).catch(() => null);
      const _clanInfo = _clan ? await _clanDataFor(_clan, telegramId) : null;
      _myClanName = _clanInfo ? _clanInfo.name : null;
      _myClanIcon = _clanInfo ? _clanInfo.icon : null;
      socket.data.vipLevel = doc.savedData?.vipLevel || 0;
      socket.emit('authOk', { username: doc.username, savedData: doc.savedData || null, isNewAccount, clanInfo: _clanInfo, gramBalance: _gramBalance, gramWallet: GRAM_WALLET, refLink: _refLink(telegramId), vipData: { level: doc.savedData?.vipLevel || 0, deposited: doc.savedData?.vipDeposited || 0, pending: doc.savedData?.vipPending || [] }, nexumBalance: _nexumBalance, topPlayer: _topPlayerUsername });
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
      const username = data.username || data.first_name || `tg_${telegramId}`;
      // Reserve slot before first await to prevent concurrent logins
      if (activeSessions.has(telegramId) && activeSessions.get(telegramId) !== socket.id) {
        const _prevSocket2 = io.sockets.sockets.get(activeSessions.get(telegramId));
        if (_prevSocket2) {
          _prevSocket2.emit('kicked', { reason: 'Вы вошли с другого устройства' });
          // Must land before the DB read below — otherwise this read can race
          // the old socket's async disconnect-flush and return stale data.
          await _prevSocket2.data._flushNow?.();
          _prevSocket2.disconnect(true);
        }
      }
      // Covers the far more common refresh case: the old socket already
      // disconnected on its own (faster than this page loaded) and its
      // flush is registered here instead of reachable via a live socket.
      const _pending2 = _pendingFlush.get(telegramId);
      if (_pending2) await _pending2.catch(() => {});
      activeSessions.set(telegramId, socket.id);
      let doc = await PlayerModel.findOne({ telegramId });
      // See the matching comment in loginTelegramWebApp — tells the client
      // not to resurrect a deleted account from its localStorage backup.
      let isNewAccount = false;
      if (!doc) { doc = await PlayerModel.create({ telegramId, username, savedData: {} }); isNewAccount = true; }
      if (!doc.savedData) {
        doc.savedData = {};
        await PlayerModel.updateOne({ telegramId }, { $set: { savedData: {} } }).catch(() => {});
      }
      if (doc.banned) {
        activeSessions.delete(telegramId);
        return socket.emit('authError', { message: 'Ваш аккаунт заблокирован' });
      }
      authed = doc;
      socket.data.username = doc.username;
      socket.data.telegramId = telegramId;
      if (doc.savedData) _lastStats = doc.savedData;
      _setGram(doc.savedData?.gramBalance || 0);
      _setNexum(doc.savedData?.nexumBalance || 0);
      _startAutosave();
      socket.join(`tg_${telegramId}`);
      const _clan = await ClanModel.findOne({ 'members.telegramId': telegramId }).catch(() => null);
      const _clanInfo = _clan ? await _clanDataFor(_clan, telegramId) : null;
      _myClanName = _clanInfo ? _clanInfo.name : null;
      _myClanIcon = _clanInfo ? _clanInfo.icon : null;
      socket.data.vipLevel = doc.savedData?.vipLevel || 0;
      socket.emit('authOk', { username: doc.username, savedData: doc.savedData || null, isNewAccount, clanInfo: _clanInfo, gramBalance: _gramBalance, gramWallet: GRAM_WALLET, refLink: _refLink(telegramId), vipData: { level: doc.savedData?.vipLevel || 0, deposited: doc.savedData?.vipDeposited || 0, pending: doc.savedData?.vipPending || [] }, nexumBalance: _nexumBalance, topPlayer: _topPlayerUsername });
    } catch (err) {
      console.error('loginTelegram:', err);
      socket.emit('authError', { message: 'Ошибка сервера' });
    }
  });

  // ── GRAM wallet ───────────────────────────────────────────────────────────
  safeOn('gramDepositRequest', async ({ amount, memo }) => {
    if (!authed || !amount || amount < 1) return;
    try {
      const tx = await GramTxModel.create({
        telegramId: authed.telegramId,
        username:   authed.username,
        type: 'deposit',
        amount: Number(amount),
        memo: String(memo || authed.telegramId),
      });
      socket.emit('gramTxCreated', { tx: _txData(tx) });
      notifyAdminGram(tx).catch(() => {});
    } catch (err) { console.error('gramDepositRequest:', err); }
  });

  safeOn('gramWithdrawRequest', async ({ amount, address }) => {
    if (!authed || !amount || amount < 10 || !address) return;
    try {
      if (amount > _liveGram()) return socket.emit('gramError', { msg: 'Недостаточно средств' });

      // Deduct immediately — refunded on rejection. Based on _liveGram() so a
      // credit that landed through another code path since this socket logged
      // in (market sale payout, admin deposit confirmation, referral bonus)
      // isn't erased by writing back a stale mirror — see _liveGram's comment.
      _setGram(_round7(_liveGram() - amount));
      // Targeted $set instead of a findById-then-save round trip — this
      // value is already the live authoritative figure (_gramBalance), so
      // there's nothing to read first, and a full-document save would risk
      // clobbering any other savedData field this account's own autosave
      // writes in the same window.
      await PlayerModel.updateOne(
        { _id: authed._id },
        { $set: { 'savedData.gramBalance': _gramBalance } },
      );

      const tx = await GramTxModel.create({
        telegramId: authed.telegramId,
        username:   authed.username,
        type: 'withdraw',
        amount: Number(amount),
        address: String(address),
      });
      socket.emit('gramTxCreated', { tx: _txData(tx), newBalance: _gramBalance });
      notifyAdminGram(tx).catch(() => {});
    } catch (err) { console.error('gramWithdrawRequest:', err); }
  });

  safeOn('gramGetHistory', async () => {
    if (!authed) return;
    try {
      const txs = await GramTxModel.find({ telegramId: authed.telegramId })
        .sort({ createdAt: -1 }).limit(30).lean();
      socket.emit('gramHistory', { txs: txs.map(_txData) });
    } catch (err) { console.error('gramGetHistory:', err); }
  });

  safeOn('gramShopBuy', async ({ pkgId } = {}) => {
    if (!authed || !pkgId) return;
    try {
      const pkg = _GRAM_SHOP_PKGS.find(p => p.id === pkgId);
      if (!pkg) return socket.emit('gramShopError', { msg: 'Пакет не найден' });
      if (_liveGram() < pkg.gram) return socket.emit('gramShopError', { msg: 'Недостаточно GRAM' });

      const doc = await PlayerModel.findById(authed._id);
      if (!doc) return;
      const saved = doc.savedData || {};
      const charClass = saved.type || 'lev';
      const wepMap = _SHOP_CLASS_WEAPONS[charClass] || _SHOP_CLASS_WEAPONS.lev;
      const inv = Array.isArray(saved.inventory) ? [...saved.inventory] : [];

      // Deduct GRAM
      _setGram(_round7(_liveGram() - pkg.gram));
      saved.gramBalance = _gramBalance;

      // Gold
      saved.gold = (saved.gold || 0) + pkg.gold;

      // Buff potions (bp_hp/bp_exp/... — ITEM_DEF slot 'buff_potion') are
      // stackable inventory items, not potionBag entries. potionBag only
      // holds pt1/pt2 HP potions; useBuffPotion() (player.js) looks these up
      // via removeFromInventory() against player.inventory, so writing them
      // into potionBag instead — as this used to — meant they were paid for
      // and deducted but never actually reachable anywhere in the UI.
      _VIP_BP.forEach(bp => {
        const existing = inv.find(i => i.id === bp.id);
        if (existing) existing.qty = (existing.qty || 1) + pkg.potions;
        else inv.push({ ...bp, qty: pkg.potions });
      });

      // Armor set
      if (pkg.armor) {
        (_SHOP_ARMOR_SETS[pkg.armor] || []).forEach(id => {
          const base = ITEM_DEF.find(d => d.id === id);
          if (base) inv.push({ ...base, enhance: pkg.enhance || 0 });
        });
      }

      // Class weapon
      if (pkg.weapon) {
        const wepId = wepMap[pkg.weapon];
        const base = ITEM_DEF.find(d => d.id === wepId);
        if (base) inv.push({ ...base, enhance: pkg.enhance || 0 });
      }

      // Skill books — for the buyer's own class only (see charClass above)
      if (pkg.skillBooks) {
        const classBooks = CRAFT_MATS.filter(m => m.forClass === charClass && m.skillKey);
        const _addBook = (book, qty) => {
          const existing = inv.find(i => i.id === book.id);
          if (existing) existing.qty = (existing.qty || 1) + qty;
          else inv.push({ ...book, qty });
        };
        if (pkg.skillBooks.each) {
          classBooks.forEach(book => _addBook(book, pkg.skillBooks.each));
        } else if (pkg.skillBooks.random && classBooks.length) {
          for (let i = 0; i < pkg.skillBooks.random; i++) {
            _addBook(classBooks[Math.floor(Math.random() * classBooks.length)], 1);
          }
        }
      }

      // Boxes (BOX_DEF — opened via the forge for random-rarity gear)
      if (pkg.boxes) {
        Object.entries(pkg.boxes).forEach(([boxId, qty]) => {
          const base = BOX_DEF.find(b => b.id === boxId);
          if (!base) return;
          const existing = inv.find(i => i.id === boxId);
          if (existing) existing.qty = (existing.qty || 1) + qty;
          else inv.push({ ...base, qty });
        });
      }

      // Bonus skill points
      if (pkg.bonusSP > 0) saved.bonusSP = (saved.bonusSP || 0) + pkg.bonusSP;

      // VIP progress from purchase
      let _vipLvl = saved.vipLevel || 0;
      let _vipDep = saved.vipDeposited || 0;
      const _vipPend = Array.isArray(saved.vipPending) ? [...saved.vipPending] : [];
      const _prevVipLvl = _vipLvl;
      if (_vipLvl < 10) {
        _vipDep += pkg.gram;
        while (_vipLvl < 10 && _vipDep >= VIP_THRESHOLDS[_vipLvl + 1]) {
          _vipDep -= VIP_THRESHOLDS[_vipLvl + 1];
          _vipLvl++;
          _vipPend.push(_vipLvl);
        }
        saved.vipLevel = _vipLvl;
        saved.vipDeposited = _vipDep;
        saved.vipPending = _vipPend;
      }

      saved.inventory = inv;
      // Targeted $set on exactly the fields this purchase touched, instead of
      // a full-document save from the doc fetched at the top of this handler
      // — that snapshot can already be stale by the time this lands (this
      // account's own gameplay autosave landing in between), and overwriting
      // the whole savedData blob with it would silently revert whatever else
      // changed (equipment, hp, position...) in that window.
      const _shopSet = {
        'savedData.gramBalance': saved.gramBalance,
        'savedData.gold': saved.gold,
        'savedData.inventory': inv,
        'savedData.vipLevel': _vipLvl,
        'savedData.vipDeposited': _vipDep,
        'savedData.vipPending': _vipPend,
      };
      if (pkg.bonusSP > 0) _shopSet['savedData.bonusSP'] = saved.bonusSP;
      await PlayerModel.updateOne({ _id: doc._id }, { $set: _shopSet });

      if (_lastStats) {
        _lastStats.inventory = inv;
        _lastStats.gold = saved.gold;
        if (pkg.bonusSP > 0) _lastStats.bonusSP = saved.bonusSP;
      }
      socket.data.vipLevel = _vipLvl;

      socket.emit('gramShopResult', {
        pkgId,
        newBalance:  _gramBalance,
        newGold:     saved.gold,
        newInventory: inv,
        newBonusSP:  saved.bonusSP || 0,
        vipData: { level: _vipLvl, deposited: _vipDep, pending: _vipPend },
        leveled: _vipLvl > _prevVipLvl,
      });
      io.to(`tg_${authed.telegramId}`).emit('gramBalanceUpdate', { balance: _gramBalance });
      if (_vipLvl > _prevVipLvl) {
        socket.emit('vipUpdate', { level: _vipLvl, deposited: _vipDep, pending: _vipPend });
      }
    } catch (err) { console.error('gramShopBuy:', err); }
  });

  // ── Market ────────────────────────────────────────────────────────────────
  // GRAM movement is fully server-authoritative (same balance/cache pattern as
  // the wallet above). The item itself is trusted from the client at the same
  // level as the rest of the inventory system — this game doesn't otherwise
  // keep a server-side copy of item stats to validate against.
  // ── Ground loot (event-boss drops) ────────────────────────────────────────
  // The claim itself is arbitrated inside the Room (one Map delete, so exactly
  // one player can win a given pile). Awarding is done here because this is
  // where _lastStats — the server's own inventory copy — lives; same pattern
  // as the market, so a dropped worldDropTaken event or a disconnect mid-
  // pickup can't lose the item.
  safeOn('pickupWorldDrop', ({ id } = {}) => {
    if (!authed || !id || !currentRoom) return;
    const p = currentRoom.players.get(socket.id);
    if (!p || p.hp <= 0) return;
    const inv = (_lastStats && Array.isArray(_lastStats.inventory)) ? _lastStats.inventory : null;
    // Peek at the pile first: a full inventory must be rejected BEFORE the
    // claim consumes it, otherwise the item is destroyed instead of staying
    // on the floor for someone else — same ordering as the market's buy path.
    const peek = currentRoom.worldDrops.get(id);
    if (!peek) return;
    if (inv && !isStackableItem(peek.item) && inv.length >= SERVER_INV_MAX) {
      return socket.emit('worldDropError', { msg: 'Инвентарь полон' });
    }
    const drop = currentRoom.claimWorldDrop(id, p.x, p.y);
    if (!drop) return;
    if (inv && _invAdd(inv, drop.item)) {
      _persistSavedFields(authed, { inventory: inv });
    }
    socket.emit('worldDropPicked', { id: drop.id, item: drop.item });
  });

  safeOn('marketBrowse', async () => {
    if (!authed) return;
    try {
      const rows = await MarketListingModel.find({ status: 'active', sellerId: { $ne: authed.telegramId } })
        .sort({ createdAt: -1 }).limit(200).lean();
      socket.emit('marketBrowseData', { listings: rows.map(_marketListingData) });
    } catch (err) { console.error('marketBrowse:', err); }
  });

  safeOn('marketMyListings', async () => {
    if (!authed) return;
    try {
      const rows = await MarketListingModel.find({ status: 'active', sellerId: authed.telegramId })
        .sort({ createdAt: -1 }).limit(MARKET_MAX_ACTIVE).lean();
      socket.emit('marketMyListingsData', { listings: rows.map(_marketListingData) });
    } catch (err) { console.error('marketMyListings:', err); }
  });

  safeOn('marketHistory', async () => {
    if (!authed) return;
    try {
      const rows = await MarketListingModel.find({
        status: { $in: ['sold', 'cancelled'] },
        $or: [{ sellerId: authed.telegramId }, { buyerId: authed.telegramId }],
      }).sort({ soldAt: -1, createdAt: -1 }).limit(50).lean();
      socket.emit('marketHistoryData', { entries: rows.map(l => _marketHistoryData(l, authed.telegramId)) });
    } catch (err) { console.error('marketHistory:', err); }
  });

  // marketList failures use a dedicated event (not the shared marketError) —
  // the client optimistically removes the item from inventory before this
  // round-trip completes, and needs to know specifically that THIS request
  // failed to roll that back, without misfiring on an unrelated buy/cancel
  // error that happens to land while a listing request is in flight.
  safeOn('marketList', async ({ item, price } = {}) => {
    if (!authed) return;
    const now = Date.now();
    if (now - _lastMarketListAt < MARKET_LIST_COOLDOWN_MS) {
      return socket.emit('marketListError', { msg: 'Слишком часто — подождите немного' });
    }
    const p = Number(price);
    if (!Number.isFinite(p) || p < MARKET_MIN_PRICE || p > MARKET_MAX_PRICE) {
      return socket.emit('marketListError', { msg: `Цена должна быть от ${MARKET_MIN_PRICE} до ${MARKET_MAX_PRICE} GRAM` });
    }
    // Only id + enhance are trusted from the client — every other field
    // (stats, rarity, name, img...) is rebuilt from the canonical catalog.
    const canonItem = _canonicalMarketItem(item);
    if (!canonItem) {
      return socket.emit('marketListError', { msg: 'Такого предмета не существует' });
    }
    // Claim the cooldown slot BEFORE the first await. Setting it after the
    // countDocuments round-trip let two listings sent back-to-back both read
    // the old timestamp, pass the check and create a listing each — which,
    // with a client that sends the same item twice, minted a duplicate.
    const _prevListAt = _lastMarketListAt;
    _lastMarketListAt = now;
    // The seller must actually own what they're listing. _lastStats is the
    // server's own sanitized copy of the inventory, refreshed on every
    // saveProgress (the client flushes one right before this request, see
    // _confirmMarketList in js/ui.js), so it's the authoritative answer to
    // "does this account hold this item". Without this check any client could
    // list catalog items it never earned and sell them for real GRAM.
    if (!_lastStats || !Array.isArray(_lastStats.inventory)) {
      _lastMarketListAt = _prevListAt;
      return socket.emit('marketListError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
    }
    if (_invFindOwned(_lastStats.inventory, canonItem) < 0) {
      _lastMarketListAt = _prevListAt;
      return socket.emit('marketListError', { msg: 'Предмета нет в инвентаре' });
    }
    try {
      const activeCount = await MarketListingModel.countDocuments({ sellerId: authed.telegramId, status: 'active' });
      if (activeCount >= MARKET_MAX_ACTIVE) {
        _lastMarketListAt = _prevListAt;
        return socket.emit('marketListError', { msg: `Максимум ${MARKET_MAX_ACTIVE} активных лотов` });
      }
      // Re-check ownership right before the write: the countDocuments await
      // above is a window in which this account's own save (or a concurrent
      // listing of the same item) could have removed it.
      if (_invFindOwned(_lastStats.inventory, canonItem) < 0) {
        _lastMarketListAt = _prevListAt;
        return socket.emit('marketListError', { msg: 'Предмета нет в инвентаре' });
      }
      const listing = await MarketListingModel.create({
        sellerId: authed.telegramId, sellerUsername: authed.username,
        item: canonItem, price: _round2(p), status: 'active',
      });
      // Take the item out of the server's copy too, and persist immediately —
      // otherwise the item only left the account once the CLIENT's own save
      // landed, and listing-then-killing-the-app duplicated it.
      _invRemove(_lastStats.inventory, canonItem);
      _persistSavedFields(authed, { inventory: _lastStats.inventory });
      socket.emit('marketListed', { listing: _marketListingData(listing) });
    } catch (err) {
      console.error('marketList:', err);
      _lastMarketListAt = _prevListAt;
      socket.emit('marketListError', { msg: 'Ошибка сервера' });
    }
  });

  safeOn('marketCancel', async ({ listingId } = {}) => {
    if (!authed || !listingId) return;
    try {
      // Peek at the item before cancelling: if there's nowhere to put it back,
      // the cancellation must not happen at all. Cancelling first and only
      // then discovering the inventory is full destroyed the item — the
      // listing was already gone, so nothing would ever return it.
      const pre = await MarketListingModel.findOne(
        { _id: listingId, sellerId: authed.telegramId, status: 'active' }, 'item').lean();
      if (!pre) return socket.emit('marketError', { msg: 'Лот не найден' });
      const _sellerInv = (_lastStats && Array.isArray(_lastStats.inventory)) ? _lastStats.inventory : null;
      if (_sellerInv && !isStackableItem(pre.item) && _sellerInv.length >= SERVER_INV_MAX) {
        return socket.emit('marketError', { msg: 'Инвентарь полон' });
      }
      const listing = await MarketListingModel.findOneAndUpdate(
        { _id: listingId, sellerId: authed.telegramId, status: 'active' },
        { status: 'cancelled', soldAt: new Date() },
        { new: false }, // return the pre-update doc (still has the item)
      );
      if (!listing) return socket.emit('marketError', { msg: 'Лот не найден' });
      // Put the item back server-side as well. Relying on the client to do it
      // from the marketCancelled event meant a lost event (or a disconnect in
      // the round trip) destroyed the item — the listing was already
      // cancelled, so nothing would ever return it.
      if (_sellerInv && _invAdd(_sellerInv, listing.item)) {
        _persistSavedFields(authed, { inventory: _sellerInv });
      }
      socket.emit('marketCancelled', { listingId, item: listing.item });
    } catch (err) { console.error('marketCancel:', err); }
  });

  // Undoes THIS buyer's claim only. The old unconditional update-by-_id would
  // happily flip a listing back to 'active' regardless of who currently held
  // it, so a release racing another buyer's completed purchase could put an
  // already-paid-for lot back on sale.
  function _releaseClaim(listingId) {
    return MarketListingModel.updateOne(
      { _id: listingId, status: 'sold', buyerId: authed.telegramId },
      { status: 'active', buyerId: null, buyerUsername: null, soldAt: null },
    ).catch(err => console.error('marketBuy release claim:', err));
  }

  safeOn('marketBuy', async ({ listingId } = {}) => {
    if (!authed || !listingId) return;
    try {
      const listing = await MarketListingModel.findOne({ _id: listingId, status: 'active' }, 'sellerId price').lean();
      if (!listing) return socket.emit('marketError', { msg: 'Лот уже продан или снят' });
      if (listing.sellerId === authed.telegramId) return socket.emit('marketError', { msg: 'Нельзя купить свой лот' });
      if (listing.price > _liveGram()) return socket.emit('marketError', { msg: 'Недостаточно GRAM' });

      // Atomically claim the listing first so two simultaneous buyers can't both win it
      const claimed = await MarketListingModel.findOneAndUpdate(
        { _id: listingId, status: 'active' },
        { status: 'sold', buyerId: authed.telegramId, buyerUsername: authed.username, soldAt: new Date() },
        { new: true },
      );
      if (!claimed) return socket.emit('marketError', { msg: 'Лот уже продан или снят' });

      // Re-check and deduct with no `await` in between — a rapid double-buy on
      // this same connection (two overlapping marketBuy handlers) would otherwise
      // both pass the earlier balance check before either deduction landed and
      // together spend more than the account holds, same risk the gap between
      // check and write would create in gramWithdrawRequest if it awaited there.
      if (claimed.price > _liveGram()) {
        await _releaseClaim(listingId);
        return socket.emit('marketError', { msg: 'Недостаточно GRAM' });
      }
      // Room for the item BEFORE any money moves. The client used to just
      // report "инвентарь полон, предмет потерян" after the fact — the GRAM
      // was already gone and the item was destroyed with the listing marked
      // sold. Refuse the trade instead and put the lot back up.
      const _buyerInv = (_lastStats && Array.isArray(_lastStats.inventory)) ? _lastStats.inventory : null;
      if (_buyerInv && !isStackableItem(claimed.item) && _buyerInv.length >= SERVER_INV_MAX) {
        await _releaseClaim(listingId);
        return socket.emit('marketError', { msg: 'Инвентарь полон' });
      }
      _setGram(_round7(_liveGram() - claimed.price));
      // Atomic $set on just this one nested field — a full-document
      // findOne-then-save (as this used to do) reads a savedData snapshot
      // that can already be stale by the time it writes back (the player's
      // own debounced saveProgress autosave landing in between), silently
      // reverting whatever else changed in savedData since that snapshot.
      // Deliver the item server-side in the same write as the payment, so a
      // marketBought event that never reaches the client (disconnect, lost
      // packet) can't leave the buyer having paid for nothing.
      const _buyerSet = { 'savedData.gramBalance': _gramBalance };
      if (_buyerInv && _invAdd(_buyerInv, claimed.item)) {
        _buyerSet['savedData.inventory'] = _buyerInv;
      }
      await PlayerModel.updateOne(
        { _id: authed._id },
        { $set: _buyerSet },
      ).catch(err => console.error('marketBuy buyer persist:', err));

      // Credit seller (10% fee burned — not paid to anyone), whether online or not.
      // Base the payout on _gramBalanceCache (the live, up-to-the-second balance
      // for anyone active this server process) rather than the DB's savedData
      // snapshot, which can lag behind the seller's own actions (gram drops,
      // deposits) — adding the payout on top of that stale figure, then having
      // this write clobber the true live value, is exactly what caused sold
      // items to sometimes not credit anything, or to reset the balance to a
      // wrong number. Only offline sellers (no live cache entry) fall back to
      // the DB figure, which is safe since nothing else can be mutating it.
      const payout = _round7(claimed.price * (1 - MARKET_FEE_PCT));
      try {
        const hasLive = _gramBalanceCache.has(claimed.sellerId);
        const sellerBase = hasLive
          ? _gramBalanceCache.get(claimed.sellerId)
          : ((await PlayerModel.findOne({ telegramId: claimed.sellerId }, 'savedData.gramBalance').lean())?.savedData?.gramBalance || 0);
        const sellerNewBal = _round7(sellerBase + payout);
        // DB first, cache second: if the write throws, the cache must not be
        // left advertising a credit that was never persisted (the seller's
        // session would then keep building on a number the DB never had, and
        // lose it all on their next login).
        await PlayerModel.updateOne(
          { telegramId: claimed.sellerId },
          { $set: { 'savedData.gramBalance': sellerNewBal } },
        );
        _gramBalanceCache.set(claimed.sellerId, sellerNewBal);
        io.to(`tg_${claimed.sellerId}`).emit('gramBalanceUpdate', { balance: sellerNewBal });
        io.to(`tg_${claimed.sellerId}`).emit('marketSold', {
          itemName: claimed.item?.name || '', price: claimed.price, payout,
          buyerUsername: authed.username, newBalance: sellerNewBal,
        });
      } catch (err) { console.error('marketBuy seller payout:', err); }

      socket.emit('marketBought', { listingId, item: claimed.item, newBalance: _gramBalance });
    } catch (err) { console.error('marketBuy:', err); }
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
        const players = await PlayerModel.find({}, 'username bm savedData')
          .sort({ bm: -1 }).limit(50).lean();
        const rows = players.map(p => ({
          username: p.username,
          bm: p.bm || 0,
          level: p.savedData?.lvl || p.savedData?.level || 1,
        }));
        // If current player not in top-50, find their rank and append
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
        const clans = await ClanModel.find({}, 'name icon members').lean();
        const clanBm = [];
        for (const clan of clans) {
          if (!clan.members?.length) continue;
          const ids = clan.members.map(m => m.telegramId);
          const result = await PlayerModel.aggregate([
            { $match: { telegramId: { $in: ids } } },
            { $group: { _id: null, total: { $sum: '$bm' } } },
          ]);
          clanBm.push({
            name: clan.name,
            icon: clan.icon,
            memberCount: clan.members.length,
            totalBm: result[0]?.total || 0,
          });
        }
        clanBm.sort((a, b) => b.totalBm - a.totalBm);
        socket.emit('ratingData', { tab: 'clans', rows: clanBm.slice(0, 50) });
      }
    } catch (err) { console.error('getRating:', err); }
  });

  safeOn('claimVipRewards', async () => {
    if (!authed) return;
    try {
      const doc = await PlayerModel.findById(authed._id);
      if (!doc) return;
      const saved = doc.savedData || {};
      const pending = Array.isArray(saved.vipPending) ? [...saved.vipPending] : [];
      if (!pending.length) return;
      const charClass = saved.type || 'lev';
      const inv = Array.isArray(saved.inventory) ? [...saved.inventory] : [];
      let goldReward = 0;
      for (const vipLvl of pending) {
        const items = _vipLevelItems(vipLvl, charClass);
        for (const item of items) {
          if (item.slot === 'weapon') {
            inv.push({ ...item });
          } else {
            const ex = inv.find(i => i.id === item.id);
            if (ex) ex.qty = (ex.qty || 1) + (item.qty || 1);
            else inv.push({ ...item });
          }
        }
        goldReward += _vipGoldReward(vipLvl);
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
      if (_lastStats) {
        _lastStats.inventory = inv;
        if (goldReward > 0) _lastStats.gold = saved.gold;
      }
      socket.emit('vipRewardsClaimed', { newInventory: inv, goldAdded: goldReward, vipPending: [] });
    } catch (err) { console.error('claimVipRewards:', err); }
  });

  safeOn('selectChar', ({ type, savedStats }) => {
    if (!authed) return;
    // authed.savedData is the DB-loaded record for this account (single save
    // blob, not per-type slots). If the client sent no savedStats — e.g. it
    // raced a fast refresh before its own savedData snapshot arrived — fall
    // back to the server's copy instead of leaving _lastStats unset, which
    // would let the next debounced saveProgress persist fresh/default stats
    // over real progress.
    const effectiveSaved = _sanitizeSavedStats(savedStats || authed.savedData || null);
    if (effectiveSaved) _lastStats = effectiveSaved;
    // Persist the chosen character type immediately so a page refresh
    // before the first full saveProgress doesn't show the char select again.
    PlayerModel.updateOne(
      { telegramId: authed.telegramId },
      { $set: { 'savedData.type': type } }
    ).catch(() => {});
    if (!currentRoom) {
      currentRoom = getRoom(currentFloor);
      playerFloorMap.set(socket.id, currentFloor);
      socket.join(`floor_${currentFloor}`);
      const { staleSocketId } = currentRoom.addPlayer(socket.id, authed.username, _myClanName, _myClanIcon, authed.telegramId);
      // A stale room entry for this same account (see addPlayer's comment)
      // was just dropped — tell other clients immediately instead of waiting
      // for that old socket's own (possibly delayed) disconnect to do it, so
      // this account never briefly renders as two players on screen.
      if (staleSocketId) socket.to(`floor_${currentFloor}`).emit('playerLeft', { id: staleSocketId });
      socket.to(`floor_${currentFloor}`).emit('playerJoined', { id: socket.id, username: authed.username });
      if (globalChatHistory.length) socket.emit('chatHistory', globalChatHistory);
    }
    currentRoom.setPlayerChar(socket.id, type, effectiveSaved);
    socket.to(`floor_${currentFloor}`).emit('playerChar', { id: socket.id, type });
    socket.emit('gameStart', {
      floor: currentFloor,
      dungeon: currentRoom.dungeonData,
      enemies: currentRoom.enemySnapshot(),
      bossStatus: currentRoom.getBossStatus(),
      // So someone logging in mid-countdown still sees the timer, and someone
      // arriving after the kill still sees loot already lying on the floor.
      eventBoss: eventBossState(),
      deathBattle: { ..._dbPublicState(), registered: _db.reg.has(socket.id) },
    });
  });

  safeOn('playerMove', ({ x, y, facing, hp }) => {
    if (!currentRoom) return;
    // Frozen entrants stay exactly where they were dropped. Facing/hp still
    // sync so the countdown doesn't look like a frozen screen.
    if (_dbFrozen(socket.id)) {
      if (hp != null && isFinite(hp)) currentRoom.syncPlayerHp(socket.id, hp);
      return;
    }
    currentRoom.updatePlayerPos(socket.id, x, y, facing);
    if (hp != null && isFinite(hp)) currentRoom.syncPlayerHp(socket.id, hp);
  });

  safeOn('usePotion', ({ amount }) => {
    if (currentRoom) currentRoom.healPlayer(socket.id, Math.min(amount || 60, 200));
  });

  safeOn('statsUpdate', ({ atk, def, maxHp, critChance, critPower }) => {
    if (currentRoom) currentRoom.updatePlayerStats(socket.id, { atk, def, maxHp, critChance, critPower });
  });

  safeOn('attack', ({ enemyId }) => {
    if (!_atkAllowed()) return;
    if (!currentRoom) return;
    if (_dbFrozen(socket.id)) return;
    if (currentRoom.isPlayerInSafeZone(socket.id)) return;
    const result = currentRoom.attackEnemy(socket.id, enemyId);
    if (!result) return;
    if (result.killed) {
      if (result.isBoss) io.to(`floor_${currentFloor}`).emit('bossStatus', { arm: result.arm, alive: false, respawnAt: Date.now() + 3600000 });
      const partyId    = playerParty.get(socket.id);
      const partyMap   = partyId ? parties.get(partyId) : null;

      // Party members on the same floor (excluding attacker)
      const memberIds = [];
      if (partyMap) {
        partyMap.forEach((_, mid) => {
          if (mid !== socket.id && playerFloorMap.get(mid) === currentFloor) memberIds.push(mid);
        });
      }

      const _arm = armIndexForLevel(result.rlvl);
      const boxUncommon = result.isBoss && Math.random() < 0.50 ? 1 : 0;
      const boxRare     = result.isBoss && Math.random() < 0.10 ? 1 : 0;
      const normStone  = result.isBoss && Math.random() < 0.10 ? 1 : 0;
      const blessStone = result.isBoss && Math.random() < 0.01 ? 1 : 0;
      const nexumDrop  = Math.random() < (NEXUM_DROP_CHANCE[_arm] || 0) ? 1 : 0;
      const gramDrop   = Math.random() < GRAM_DROP_CHANCE ? (result.rlvl || 1) * GRAM_PER_LEVEL : 0;
      const _vipBon = VIP_BONUSES[socket.data.vipLevel || 0] || VIP_BONUSES[0];
      if (_vipBon.xp   > 0) result.xp   = Math.round(result.xp   * (1 + _vipBon.xp   / 100));
      if (_vipBon.gold > 0) result.gold = Math.round(result.gold * (1 + _vipBon.gold / 100));

      if (nexumDrop > 0) {
        _setNexum(_liveNexum() + nexumDrop);
        _persistSavedFields(authed, { nexumBalance: _nexumBalance });
      }
      if (gramDrop > 0) {
        _setGram(_round7(_liveGram() + gramDrop));
        _persistSavedFields(authed, { gramBalance: _gramBalance });
      }

      if (memberIds.length > 0) {
        const totalMembers = memberIds.length + 1;
        const xpShare   = result.xp   / totalMembers;
        const goldShare = result.gold  / totalMembers;

        // Random loot recipient among party + attacker
        const allIds = [socket.id, ...memberIds];
        const lootWinnerId = allIds[Math.floor(Math.random() * allIds.length)];

        socket.emit('enemyKilled', {
          id: enemyId, xp: xpShare, gold: goldShare,
          dmg: result.dmg, isCrit: result.isCrit, ex: result.ex, ey: result.ey, color: result.color,
          gotLoot: lootWinnerId === socket.id, eid: result.eid, rlvl: result.rlvl,
          boxUncommon: lootWinnerId === socket.id ? boxUncommon : 0,
          boxRare:    lootWinnerId === socket.id ? boxRare    : 0,
          normStone:  lootWinnerId === socket.id ? normStone  : 0,
          blessStone: lootWinnerId === socket.id ? blessStone : 0,
          nexum: nexumDrop, gram: gramDrop,
        });
        memberIds.forEach(mid => {
          io.to(mid).emit('enemyKilled', {
            id: enemyId, xp: xpShare, gold: goldShare,
            ex: result.ex, ey: result.ey, color: result.color,
            gotLoot: lootWinnerId === mid, eid: result.eid, rlvl: result.rlvl,
            boxUncommon: lootWinnerId === mid ? boxUncommon : 0,
            boxRare:    lootWinnerId === mid ? boxRare    : 0,
            normStone:  lootWinnerId === mid ? normStone  : 0,
            blessStone: lootWinnerId === mid ? blessStone : 0,
          });
        });
        // Visual only to the rest of the floor
        socket.to(`floor_${currentFloor}`).except(memberIds).emit('enemyKilled', {
          id: enemyId, ex: result.ex, ey: result.ey, color: result.color,
        });
      } else {
        // No party: attacker gets full reward and loot
        socket.emit('enemyKilled', {
          id: enemyId, xp: result.xp, gold: result.gold,
          dmg: result.dmg, isCrit: result.isCrit, ex: result.ex, ey: result.ey, color: result.color,
          gotLoot: true, eid: result.eid, rlvl: result.rlvl, boxUncommon, boxRare, normStone, blessStone, nexum: nexumDrop, gram: gramDrop,
        });
        socket.to(`floor_${currentFloor}`).emit('enemyKilled', {
          id: enemyId, ex: result.ex, ey: result.ey, color: result.color,
        });
      }
      _onKillClanXp().catch(() => {});
    } else {
      // Only the attacker is told how hard the hit landed. dmg is what drives
      // the floating damage number, vampirism and the client's optimistic kill
      // prediction (see the `if (dmg)` branch in js/network.js), so sending it
      // floor-wide made every nearby player render someone else's hit as their
      // own — and let a Вампиризм deathknight heal off other people's damage.
      // Everyone else still gets hp so health bars and the hit flash stay in
      // sync. Mirrors the split enemyKilled above already uses.
      socket.emit('enemyHurt', { id: enemyId, hp: result.hp, dmg: result.dmg, isCrit: result.isCrit });
      socket.to(`floor_${currentFloor}`).emit('enemyHurt', { id: enemyId, hp: result.hp });
    }
  });

  safeOn('skillAttack', ({ enemyId, multiplier }) => {
    if (!_atkAllowed()) return;
    if (_dbFrozen(socket.id)) return;
    const rId = playerRaid.get(socket.id);
    if (rId) {
      const rr = raidRooms.get(rId);
      if (!rr) return;
      const cp = currentRoom?.players.get(socket.id);
      const targetEnemy = rr._enemyMap.get(enemyId);
      const result = rr.skillAttackEnemy(socket.id, enemyId, cp?.atk || 10, multiplier, cp?.critChance || 0.05, cp?.critPower || 1.5);
      if (!result) return;
      if (targetEnemy) rr.memberIds.forEach(mid => io.to(mid).emit('raidPlayerAtk', { playerId: socket.id, tx: targetEnemy.x, ty: targetEnemy.y }));
      if (result.killed) {
        const rNorm  = result.isBoss && Math.random() < 0.10 ? 1 : 0;
        const rBless = result.isBoss && Math.random() < 0.01 ? 1 : 0;
        rr.memberIds.forEach(mid => io.to(mid).emit('raidEnemyKilled', {
          id: enemyId, ex: result.ex, ey: result.ey, isBoss: result.isBoss,
          normStone:  mid === socket.id ? rNorm  : 0,
          blessStone: mid === socket.id ? rBless : 0,
        }));
      } else {
        // dmg only to the attacker (0 reads as "not mine" client-side) — same
        // reasoning as the enemyHurt split in the normal attack handler.
        rr.memberIds.forEach(mid => io.to(mid).emit('raidEnemyHurt', {
          id: enemyId, hp: result.hp, dmg: mid === socket.id ? result.dmg : 0,
        }));
      }
      return;
    }
    if (!currentRoom) return;
    if (currentRoom.isPlayerInSafeZone(socket.id)) return;
    const result = currentRoom.skillAttackEnemy(socket.id, enemyId, multiplier);
    if (!result) return;
    if (result.killed) {
      if (result.isBoss) io.to(`floor_${currentFloor}`).emit('bossStatus', { arm: result.arm, alive: false, respawnAt: Date.now() + 3600000 });
      const partyId    = playerParty.get(socket.id);
      const partyMap   = partyId ? parties.get(partyId) : null;
      const memberIds  = [];
      if (partyMap) {
        partyMap.forEach((_, mid) => {
          if (mid !== socket.id && playerFloorMap.get(mid) === currentFloor) memberIds.push(mid);
        });
      }
      const _arm2 = armIndexForLevel(result.rlvl);
      const boxUncommon2 = result.isBoss && Math.random() < 0.50 ? 1 : 0;
      const boxRare2     = result.isBoss && Math.random() < 0.10 ? 1 : 0;
      const normStone  = result.isBoss && Math.random() < 0.10 ? 1 : 0;
      const blessStone = result.isBoss && Math.random() < 0.01 ? 1 : 0;
      const nexumDrop2 = Math.random() < (NEXUM_DROP_CHANCE[_arm2] || 0) ? 1 : 0;
      const gramDrop2  = Math.random() < GRAM_DROP_CHANCE ? (result.rlvl || 1) * GRAM_PER_LEVEL : 0;
      const _vipBon2 = VIP_BONUSES[socket.data.vipLevel || 0] || VIP_BONUSES[0];
      if (_vipBon2.xp   > 0) result.xp   = Math.round(result.xp   * (1 + _vipBon2.xp   / 100));
      if (_vipBon2.gold > 0) result.gold = Math.round(result.gold * (1 + _vipBon2.gold / 100));
      if (nexumDrop2 > 0) {
        _setNexum(_liveNexum() + nexumDrop2);
        _persistSavedFields(authed, { nexumBalance: _nexumBalance });
      }
      if (gramDrop2 > 0) {
        _setGram(_round7(_liveGram() + gramDrop2));
        _persistSavedFields(authed, { gramBalance: _gramBalance });
      }
      if (memberIds.length > 0) {
        const totalMembers = memberIds.length + 1;
        const xpShare = result.xp / totalMembers, goldShare = result.gold / totalMembers;
        const allIds = [socket.id, ...memberIds];
        const lootWinnerId = allIds[Math.floor(Math.random() * allIds.length)];
        socket.emit('enemyKilled', {
          id: enemyId, xp: xpShare, gold: goldShare, dmg: result.dmg, isCrit: result.isCrit,
          ex: result.ex, ey: result.ey, color: result.color,
          gotLoot: lootWinnerId === socket.id, eid: result.eid, rlvl: result.rlvl,
          boxUncommon: lootWinnerId === socket.id ? boxUncommon2 : 0,
          boxRare:    lootWinnerId === socket.id ? boxRare2    : 0,
          normStone:  lootWinnerId === socket.id ? normStone  : 0,
          blessStone: lootWinnerId === socket.id ? blessStone : 0,
          nexum: nexumDrop2, gram: gramDrop2,
        });
        memberIds.forEach(mid => io.to(mid).emit('enemyKilled', {
          id: enemyId, xp: xpShare, gold: goldShare,
          ex: result.ex, ey: result.ey, color: result.color,
          gotLoot: lootWinnerId === mid, eid: result.eid, rlvl: result.rlvl,
          boxUncommon: lootWinnerId === mid ? boxUncommon2 : 0,
          boxRare:    lootWinnerId === mid ? boxRare2    : 0,
          normStone:  lootWinnerId === mid ? normStone  : 0,
          blessStone: lootWinnerId === mid ? blessStone : 0,
        }));
        socket.to(`floor_${currentFloor}`).except(memberIds).emit('enemyKilled', { id: enemyId, ex: result.ex, ey: result.ey, color: result.color });
      } else {
        socket.emit('enemyKilled', {
          id: enemyId, xp: result.xp, gold: result.gold, dmg: result.dmg, isCrit: result.isCrit,
          ex: result.ex, ey: result.ey, color: result.color,
          gotLoot: true, eid: result.eid, rlvl: result.rlvl, boxUncommon: boxUncommon2, boxRare: boxRare2, normStone, blessStone, nexum: nexumDrop2, gram: gramDrop2,
        });
        socket.to(`floor_${currentFloor}`).emit('enemyKilled', { id: enemyId, ex: result.ex, ey: result.ey, color: result.color });
      }
      _onKillClanXp().catch(() => {});
    } else {
      // dmg only to the attacker — see the same split in the attack handler.
      socket.emit('enemyHurt', { id: enemyId, hp: result.hp, dmg: result.dmg, isCrit: result.isCrit });
      socket.to(`floor_${currentFloor}`).emit('enemyHurt', { id: enemyId, hp: result.hp });
    }
  });

  safeOn('skillEffect', ({ enemyId, enemyIds, type, duration }) => {
    const rId = playerRaid.get(socket.id);
    if (rId) {
      const rr = raidRooms.get(rId);
      if (!rr) return;
      if (enemyId) rr.applySkillEffect(enemyId, type, duration);
      if (enemyIds) rr.applySkillEffectMany(enemyIds, type, duration);
      socket.to(rId).emit('enemyCC', { enemyId, enemyIds, type, duration });
      return;
    }
    if (!currentRoom) return;
    if (enemyId) currentRoom.applySkillEffect(enemyId, type, duration);
    if (enemyIds) currentRoom.applySkillEffectMany(enemyIds, type, duration);
    socket.to(`floor_${currentFloor}`).emit('enemyCC', { enemyId, enemyIds, type, duration });
  });

  safeOn('playerInvis', ({ invis }) => {
    if (!currentRoom) return;
    const p = currentRoom.players.get(socket.id);
    if (p) p._invis = !!invis;
  });

  safeOn('faithShield', ({ duration }) => {
    const partyId = playerParty.get(socket.id);
    const partyMap = partyId ? parties.get(partyId) : null;
    if (!partyMap) return;
    partyMap.forEach((_, mid) => {
      if (mid !== socket.id) io.to(mid).emit('faithShieldBuff', { duration });
    });
  });

  // Returns true if attacker and target share a party or clan (PvP immune)
  function _isPvpImmune(attackerId, targetId) {
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

  safeOn('pvpAttack', ({ targetId }) => {
    if (!_atkAllowed()) return;
    if (!currentRoom) return;
    if (_dbFrozen(socket.id) || _dbFrozen(targetId)) return;
    if (_isPvpImmune(socket.id, targetId)) return;
    const result = currentRoom.pvpAttack(socket.id, targetId);
    if (!result) return;
    // hp is now applied server-side inside pvpAttack itself — the target's
    // client used to self-report "actual damage taken" separately, which let
    // a modified client always report 0 and become unkillable.
    io.to(targetId).emit('pvpDamage', { dmg: result.dmg, hp: result.hp });
    socket.emit('pvpHit', { x: result.x, y: result.y, dmg: result.dmg, isCrit: result.isCrit, targetId });
    if (result.hp <= 0) { io.to(targetId).emit('playerHurt', { id: targetId, hp: 0 }); _dbEliminate(targetId); }
  });

  safeOn('pvpSkillAttack', ({ targetId, multiplier }) => {
    if (!currentRoom) return;
    if (_dbFrozen(socket.id) || _dbFrozen(targetId)) return;
    if (_isPvpImmune(socket.id, targetId)) return;
    const result = currentRoom.pvpSkillAttack(socket.id, targetId, multiplier);
    if (!result) return;
    io.to(targetId).emit('pvpDamage', { dmg: result.dmg, hp: result.hp });
    socket.emit('pvpHit', { x: result.x, y: result.y, dmg: result.dmg, isCrit: result.isCrit, targetId });
    if (result.hp <= 0) { io.to(targetId).emit('playerHurt', { id: targetId, hp: 0 }); _dbEliminate(targetId); }
  });

  safeOn('pvpSkillCC', ({ targetId, type, duration }) => {
    if (!currentRoom) return;
    if (_dbFrozen(socket.id) || _dbFrozen(targetId)) return;
    if (_isPvpImmune(socket.id, targetId)) return;
    const attacker = currentRoom.players.get(socket.id);
    if (!attacker || !attacker.pvpMode) return;
    if (attacker.hp <= 0) return;
    if (currentRoom.isPlayerInSafeZone(socket.id)) return;
    const target = currentRoom.players.get(targetId);
    if (!target || target.hp <= 0) return;
    if (currentRoom.isPlayerInSafeZone(targetId)) return;
    const dur = Math.max(0, Math.min(duration, 6));
    io.to(`floor_${currentFloor}`).emit('pvpPlayerCC', { targetId, type, duration: dur });
  });

  safeOn('respawn', () => {
    // Dying to anything at all during a round is an elimination — this covers
    // the paths the PvP kill hooks don't (the event boss, a stray mob).
    _dbEliminate(socket.id);
    if (currentRoom) currentRoom.respawnPlayer(socket.id);
  });

  // ── Death Battle (Битва на смерть) ─────────────────────────────────────────
  safeOn('deathBattleRegister', () => {
    if (!authed) return;
    if (_db.phase !== 'reg') return socket.emit('deathBattleError', { msg: 'Регистрация закрыта' });
    const cp = currentRoom?.players.get(socket.id);
    if (!cp) return socket.emit('deathBattleError', { msg: 'Выберите персонажа' });
    if (playerRaid.has(socket.id) || playerPartyDungeon.has(socket.id)) {
      return socket.emit('deathBattleError', { msg: 'Нельзя записаться из рейда или подземелья' });
    }
    _db.reg.set(socket.id, { name: authed.username });
    socket.emit('deathBattleRegistered', { registered: true });
    _dbBroadcast();
  });

  safeOn('deathBattleUnregister', () => {
    if (_db.phase !== 'reg') return;
    if (!_db.reg.delete(socket.id)) return;
    socket.emit('deathBattleRegistered', { registered: false });
    _dbBroadcast();
  });

  // Sent once the winner closes the reward modal — everyone else is already
  // back in the hub, the winner is left standing in the arena until this.
  safeOn('deathBattleReturn', () => {
    if (_db.winnerId !== socket.id) return; // see _db.winnerId — not a free teleport home
    _db.winnerId = null;
    const spot = currentRoom ? currentRoom.deathBattleReturn(socket.id) : null;
    if (spot) socket.emit('deathBattleReturned', spot);
  });

  safeOn('deathBattleSync', () => {
    socket.emit('deathBattleState', { ..._dbPublicState(), registered: _db.reg.has(socket.id) });
  });

  safeOn('setPvpMode', ({ pvpMode }) => {
    if (currentRoom) currentRoom.setPlayerPvpMode(socket.id, pvpMode);
  });

  safeOn('spawnProj', data => {
    if (!currentRoom) return;
    socket.to(`floor_${currentFloor}`).emit('spawnProj', data);
  });

  safeOn('spawnAoe', data => {
    if (!currentRoom) return;
    socket.to(`floor_${currentFloor}`).emit('spawnAoe', data);
  });

  safeOn('healParty', ({ amount }) => {
    if (!authed || !currentRoom) return;
    const healAmt = Math.max(0, Math.min(Math.floor(amount), 9999));
    const partyId = playerParty.get(socket.id);
    if (!partyId) return;
    const partyMap = parties.get(partyId);
    if (!partyMap) return;
    partyMap.forEach((_, mid) => {
      if (mid === socket.id) return;
      if (playerFloorMap.get(mid) !== currentFloor) return;
      if (currentRoom.healPartyMember(mid, healAmt))
        io.to(mid).emit('healPartyMember', { amount: healAmt });
    });
  });

  safeOn('chat', ({ text }) => {
    if (!authed || !text || typeof text !== 'string') return;
    const now = Date.now();
    if (now - _lastChatAt < 3000) return;
    _lastChatAt = now;
    const msg = text.trim().slice(0, 100);
    if (!msg) return;
    _recordChat(authed.username, msg);
    io.emit('chatMsg', { username: authed.username, text: msg });
  });

  // ── Clan chat — delivered only to members currently online, same
  // "iterate connected sockets by telegramId" pattern _notifyClan uses ──
  safeOn('clanChat', async ({ text }) => {
    if (!authed || !text || typeof text !== 'string') return;
    const now = Date.now();
    if (now - _lastChatAt < 3000) return;
    const msg = text.trim().slice(0, 100);
    if (!msg) return;
    const clan = await ClanModel.findOne({ 'members.telegramId': authed.telegramId }).catch(() => null);
    if (!clan) return socket.emit('chatError', { channel: 'clan', msg: 'Вы не состоите в клане' });
    _lastChatAt = now;
    _recordClanChat(clan._id, authed.username, msg);
    for (const m of clan.members) {
      const target = [...io.sockets.sockets.values()].find(s => s.data.telegramId === m.telegramId);
      if (target) target.emit('clanChatMsg', { username: authed.username, text: msg });
    }
  });

  safeOn('clanChatHistory', async () => {
    if (!authed) return;
    const clan = await ClanModel.findOne({ 'members.telegramId': authed.telegramId }).catch(() => null);
    socket.emit('clanChatHistory', { messages: clan ? (clanChatHistory.get(String(clan._id)) || []) : [] });
  });

  // ── Private messages — @mention-addressed 1:1 conversation. Resolved via
  // DB (works even if the recipient is offline, see _resolveUsername), but
  // only delivered live if they currently have an active socket. ──
  safeOn('privMsg', async ({ toUsername, text }) => {
    if (!authed || !text || typeof text !== 'string' || !toUsername) return;
    const now = Date.now();
    if (now - _lastChatAt < 3000) return;
    const msg = text.trim().slice(0, 100);
    if (!msg) return;
    const target = await _resolveUsername(toUsername);
    if (!target) return socket.emit('privMsgError', { msg: 'Пользователь @' + toUsername + ' не найден' });
    if (target.telegramId === authed.telegramId) return socket.emit('privMsgError', { msg: 'Нельзя написать самому себе' });
    _lastChatAt = now;
    _recordDm(authed.telegramId, target.telegramId, authed.username, msg);
    socket.emit('privMsg', { withUsername: target.username, username: authed.username, text: msg });
    const targetSocketId = activeSessions.get(target.telegramId);
    const targetSocket = targetSocketId ? io.sockets.sockets.get(targetSocketId) : null;
    if (targetSocket) targetSocket.emit('privMsg', { withUsername: authed.username, username: authed.username, text: msg });
  });

  safeOn('privMsgHistory', async ({ withUsername }) => {
    if (!authed || !withUsername) return;
    const target = await _resolveUsername(withUsername);
    if (!target) return socket.emit('privMsgError', { msg: 'Пользователь @' + withUsername + ' не найден' });
    socket.emit('privMsgHistory', { withUsername: target.username, messages: dmHistory.get(_dmKey(authed.telegramId, target.telegramId)) || [] });
  });

  safeOn('saveProgress', ({ stats }) => {
    if (!authed) return;
    // Sanitize the client blob before it becomes the server's source of truth
    // for BM/combat stats and before it's persisted (anti-cheat — see
    // _sanitizeSavedStats). gram/nexum are never taken from here.
    const clean = _sanitizeSavedStats(stats);
    if (_looksLikeCatastrophicReset(_lastStats, clean)) {
      console.error(`[saveProgress] Rejected suspicious full-reset for telegramId=${authed.telegramId} ` +
        `(had lvl=${_lastStats.lvl} gold=${_lastStats.gold} items=${(_lastStats.inventory || []).length} ` +
        `equip=${Object.keys(_lastStats.equipment || {}).length} — incoming save was blank). Keeping previous state.`);
      return;
    }
    _lastStats = clean;
    authed.bm = calcBM(clean);
    // Keeps the Room's basis for statsUpdate's true-base recomputation
    // (server/game/Room.js updatePlayerStats) in sync with the player's
    // actual equipment/upgrades/level as they change mid-session.
    if (currentRoom) currentRoom.updatePlayerSavedData(socket.id, clean);
    clearTimeout(_saveDebounceTimer);
    _saveDebounceTimer = setTimeout(() => {
      if (!authed) return;
      _persistSavedFields(authed,
        { ...clean, gramBalance: _liveGram(), nexumBalance: _liveNexum() },
        { bm: authed.bm });
    }, 3000);
  });

  // ── Party ─────────────────────────────────────────────────────────────────
  safeOn('partyInvite', ({ targetId }) => {
    if (!authed) return;
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
    targetSocket.emit('partyInviteReceived', { fromId: socket.id, fromName: authed.username });
  });

  safeOn('partyAccept', ({ fromId }) => {
    if (!authed || playerParty.has(socket.id)) return;
    const fromSocket = io.sockets.sockets.get(fromId);
    if (!fromSocket) return;

    const fromPartyId = playerParty.get(fromId);
    let partyId, partyMap;

    if (fromPartyId) {
      // Join inviter's existing party
      partyMap = parties.get(fromPartyId);
      if (!partyMap || partyMap.size >= 5) return;
      partyId = fromPartyId;
      partyMap.set(socket.id, authed.username);
      playerParty.set(socket.id, partyId);
    } else {
      // Create new party
      partyId = fromId + '_' + socket.id;
      partyMap = new Map();
      partyMap.set(fromId, fromSocket.data.username || fromId.slice(0, 6));
      partyMap.set(socket.id, authed.username);
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

  safeOn('partyDecline', () => { /* no cleanup needed */ });

  safeOn('partyLeave', () => {
    const partyId = playerParty.get(socket.id);
    if (partyId) _removeFromParty(partyId, socket.id);
  });

  // ── Clan handlers ─────────────────────────────────────────────
  async function _clanDataFor(clan, telegramId) {
    const myRole = clan.members.find(m => m.telegramId === telegramId)?.role || null;
    const memberIds = clan.members.map(m => m.telegramId);
    const playerDocs = await PlayerModel.find({ telegramId: { $in: memberIds } }, { telegramId: 1, bm: 1 }).lean().catch(() => []);
    const bmMap = {};
    playerDocs.forEach(d => { bmMap[d.telegramId] = d.bm || 0; });
    return {
      _id:          clan._id,
      name:         clan.name,
      icon:         clan.icon,
      level:        clan.level,
      xp:           clan.xp,
      members:      clan.members.map(m => ({ telegramId: m.telegramId, username: m.username, role: m.role, bm: bmMap[m.telegramId] || 0 })),
      applications: myRole === 'leader' ? clan.applications.map(a => ({ telegramId: a.telegramId, username: a.username })) : [],
      myRole,
    };
  }

  async function _notifyClan(clan) {
    for (const m of clan.members) {
      // Find active socket for this member by iterating connected sockets
      const target = [...io.sockets.sockets.values()].find(s => s.data.telegramId === m.telegramId);
      if (target) target.emit('clanData', await _clanDataFor(clan, m.telegramId));
    }
  }

  safeOn('clanCreate', async ({ name, icon }) => {
    if (!authed) return;
    const n = (name || '').trim().slice(0, 10);
    if (!n) return socket.emit('clanError', { msg: 'Введите название' });
    if (typeof icon !== 'number' || icon < 1 || icon > 30) return socket.emit('clanError', { msg: 'Неверная иконка' });
    const existing = await ClanModel.findOne({ 'members.telegramId': authed.telegramId }).catch(() => null);
    if (existing) return socket.emit('clanError', { msg: 'Вы уже в клане' });
    try {
      const clan = await ClanModel.create({
        name: n, icon,
        members: [{ telegramId: authed.telegramId, username: authed.username, role: 'leader' }],
      });
      const _cd = await _clanDataFor(clan, authed.telegramId);
      socket.emit('clanData', _cd);
      _myClanName = _cd ? _cd.name : null;
      _myClanIcon = _cd ? _cd.icon : null;
      currentRoom?.setPlayerClan(socket.id, _myClanName, _myClanIcon);
    } catch (e) {
      if (e.code === 11000) socket.emit('clanError', { msg: 'Название занято' });
      else socket.emit('clanError', { msg: 'Ошибка создания' });
    }
  });

  safeOn('clanSearch', async ({ query }) => {
    if (!authed) return;
    const q = (query || '').trim().slice(0, 32);
    const filter = q ? { name: { $regex: _escapeRegex(q), $options: 'i' } } : {};
    const clans = await ClanModel.find(filter).sort({ level: -1, xp: -1 }).limit(20).catch(() => []);
    socket.emit('clanSearchResults', clans.map(c => ({
      _id: c._id, name: c.name, icon: c.icon, level: c.level, members: c.members.length,
    })));
  });

  safeOn('clanApply', async ({ clanId }) => {
    if (!authed) return;
    const inClan = await ClanModel.findOne({ 'members.telegramId': authed.telegramId }).catch(() => null);
    if (inClan) return socket.emit('clanError', { msg: 'Вы уже в клане' });
    const clan = await ClanModel.findById(clanId).catch(() => null);
    if (!clan) return socket.emit('clanError', { msg: 'Клан не найден' });
    // Only one pending application at a time — applying to a new clan
    // withdraws any application still pending elsewhere, so a leader never
    // approves someone who already joined a different clan in the meantime.
    const otherPending = await ClanModel.find(
      { _id: { $ne: clan._id }, 'applications.telegramId': authed.telegramId }
    ).catch(() => []);
    if (otherPending.length) {
      await ClanModel.updateMany(
        { _id: { $in: otherPending.map(c => c._id) } },
        { $pull: { applications: { telegramId: authed.telegramId } } }
      ).catch(() => {});
      for (const c of otherPending) {
        c.applications = c.applications.filter(a => a.telegramId !== authed.telegramId);
        await _notifyClan(c);
      }
    }
    if (clan.applications.find(a => a.telegramId === authed.telegramId)) return;
    clan.applications.push({ telegramId: authed.telegramId, username: authed.username });
    await clan.save().catch(() => {});
    socket.emit('clanError', { msg: '✓ Заявка отправлена' });
    await _notifyClan(clan);
  });

  safeOn('clanApprove', async ({ telegramId }) => {
    if (!authed) return;
    const clan = await ClanModel.findOne({ 'members.telegramId': authed.telegramId }).catch(() => null);
    if (!clan) return;
    if (clan.members.find(m => m.telegramId === authed.telegramId)?.role !== 'leader') return;
    const app = clan.applications.find(a => a.telegramId === telegramId);
    if (!app) return;
    clan.applications = clan.applications.filter(a => a.telegramId !== telegramId);
    clan.members.push({ telegramId: app.telegramId, username: app.username, role: 'member' });
    await clan.save().catch(() => {});
    await _notifyClan(clan);
  });

  safeOn('clanDecline', async ({ telegramId }) => {
    if (!authed) return;
    const clan = await ClanModel.findOne({ 'members.telegramId': authed.telegramId }).catch(() => null);
    if (!clan) return;
    if (clan.members.find(m => m.telegramId === authed.telegramId)?.role !== 'leader') return;
    clan.applications = clan.applications.filter(a => a.telegramId !== telegramId);
    await clan.save().catch(() => {});
    const _cdDecl = await _clanDataFor(clan, authed.telegramId);
    socket.emit('clanData', _cdDecl);
    _myClanName = _cdDecl ? _cdDecl.name : null;
    _myClanIcon = _cdDecl ? _cdDecl.icon : null;
    currentRoom?.setPlayerClan(socket.id, _myClanName, _myClanIcon);
  });

  safeOn('clanKick', async ({ telegramId }) => {
    if (!authed) return;
    const clan = await ClanModel.findOne({ 'members.telegramId': authed.telegramId }).catch(() => null);
    if (!clan) return;
    if (clan.members.find(m => m.telegramId === authed.telegramId)?.role !== 'leader') return;
    if (telegramId === authed.telegramId) return;
    clan.members = clan.members.filter(m => m.telegramId !== telegramId);
    await clan.save().catch(() => {});
    await _notifyClan(clan);
    // Notify kicked player
    const kicked = [...io.sockets.sockets.values()].find(s => s.data.telegramId === telegramId);
    if (kicked) {
      kicked.emit('clanData', null);
      const _kFloor = playerFloorMap.get(kicked.id);
      const _kRoom = _kFloor !== undefined ? floorRooms.get(_kFloor) : null;
      if (_kRoom) _kRoom.setPlayerClan(kicked.id, null, null);
    }
  });

  safeOn('clanLeave', async () => {
    if (!authed) return;
    const clan = await ClanModel.findOne({ 'members.telegramId': authed.telegramId }).catch(() => null);
    if (!clan) return;
    const myEntry = clan.members.find(m => m.telegramId === authed.telegramId);
    if (!myEntry) return;
    if (myEntry.role === 'leader') {
      // Promote next member or disband
      const others = clan.members.filter(m => m.telegramId !== authed.telegramId);
      if (others.length > 0) {
        others[0].role = 'leader';
        clan.members = others;
        await clan.save().catch(() => {});
        await _notifyClan(clan);
      } else {
        await ClanModel.deleteOne({ _id: clan._id }).catch(() => {});
      }
    } else {
      clan.members = clan.members.filter(m => m.telegramId !== authed.telegramId);
      await clan.save().catch(() => {});
      await _notifyClan(clan);
    }
    socket.emit('clanData', null);
    _myClanName = null;
    _myClanIcon = null;
    currentRoom?.setPlayerClan(socket.id, null, null);
  });

  safeOn('clanDisband', async () => {
    if (!authed) return;
    const clan = await ClanModel.findOne({ 'members.telegramId': authed.telegramId }).catch(() => null);
    if (!clan) return;
    if (clan.members.find(m => m.telegramId === authed.telegramId)?.role !== 'leader') return;
    // Notify all members first and clear their room clan state
    for (const m of clan.members) {
      const target = [...io.sockets.sockets.values()].find(s => s.data.telegramId === m.telegramId);
      if (target) {
        target.emit('clanData', null);
        const _tFloor = playerFloorMap.get(target.id);
        const _tRoom = _tFloor !== undefined ? floorRooms.get(_tFloor) : null;
        if (_tRoom) _tRoom.setPlayerClan(target.id, null, null);
      }
    }
    await ClanModel.deleteOne({ _id: clan._id }).catch(() => {});
  });

  async function _onKillClanXp() {
    if (!authed || !_myClanName) return;
    const clan = await ClanModel.findOne({ 'members.telegramId': authed.telegramId }).catch(() => null);
    if (!clan || clan.level >= 10) return;
    clan.xp += 1;
    const LEVELS = [0,500,1500,4000,10000,25000,60000,150000,350000,800000];
    const nextLvl = clan.level < 10 ? LEVELS[clan.level] : Infinity;
    if (clan.xp >= nextLvl) clan.level = Math.min(10, clan.level + 1);
    await clan.save().catch(() => {});
    const _cdKill = await _clanDataFor(clan, authed.telegramId);
    socket.emit('clanData', _cdKill);
    _myClanName = _cdKill ? _cdKill.name : null;
    _myClanIcon = _cdKill ? _cdKill.icon : null;
    currentRoom?.setPlayerClan(socket.id, _myClanName, _myClanIcon);
  }

  // ── Raid ───────────────────────────────────────────────────────────────────
  // ── Raid lobbies ──────────────────────────────────────────────────────────
  safeOn('getLobbyList', () => {
    const list = [...raidLobbies.values()].map(lb => ({
      id: lb.id, creatorName: lb.creatorName, dungeonId: lb.dungeonId,
      members: [...lb.members.entries()].map(([sid, m]) => ({ id: sid, name: m.name, bm: m.bm, lvl: m.lvl })),
    }));
    socket.emit('lobbyList', { lobbies: list });
  });

  safeOn('createRaidLobby', async ({ dungeonId }) => {
    if (!authed) return;
    if (playerLobby.has(socket.id)) _cleanupLobby(socket.id);
    if (playerRaid.has(socket.id)) return socket.emit('lobbyError', { msg: 'Вы уже в рейде' });
    const cp = currentRoom?.players.get(socket.id);
    if (!cp || (cp.lvl || 1) < 3) return socket.emit('lobbyError', { msg: 'Нужен 3 уровень' });
    if (await _raidLockedToday(socket.id)) return socket.emit('lobbyError', { msg: 'Попытки в рейд на сегодня закончились' });
    const bm = calcBM(_lastStats);
    const lobbyId = 'lb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5);
    const lb = { id: lobbyId, creatorId: socket.id, creatorName: authed.username,
      dungeonId: dungeonId || 1,
      members: new Map([[socket.id, { name: authed.username, bm, lvl: cp.lvl || 1 }]]) };
    raidLobbies.set(lobbyId, lb);
    playerLobby.set(socket.id, lobbyId);
    socket.emit('lobbyJoined', { lobbyId, isCreator: true,
      members: [...lb.members.entries()].map(([sid, m]) => ({ id: sid, name: m.name, bm: m.bm, lvl: m.lvl })) });
    _lobbyBroadcast();
  });

  safeOn('joinRaidLobby', async ({ lobbyId }) => {
    if (!authed) return;
    const lb = raidLobbies.get(lobbyId);
    if (!lb) return socket.emit('lobbyError', { msg: 'Группа не найдена' });
    if (lb.members.size >= 5) return socket.emit('lobbyError', { msg: 'Группа полна (5/5)' });
    if (playerRaid.has(socket.id)) return socket.emit('lobbyError', { msg: 'Вы уже в рейде' });
    if (await _raidLockedToday(socket.id)) return socket.emit('lobbyError', { msg: 'Попытки в рейд на сегодня закончились' });
    if (playerLobby.has(socket.id)) _cleanupLobby(socket.id);
    const cp = currentRoom?.players.get(socket.id);
    const bm = calcBM(_lastStats);
    lb.members.set(socket.id, { name: authed.username, bm, lvl: cp?.lvl || 1 });
    playerLobby.set(socket.id, lobbyId);
    const memberList = [...lb.members.entries()].map(([sid, m]) => ({ id: sid, name: m.name, bm: m.bm, lvl: m.lvl }));
    lb.members.forEach((_, mid) => io.to(mid).emit('lobbyJoined', { lobbyId, isCreator: mid === lb.creatorId, members: memberList }));
    _lobbyBroadcast();
  });

  safeOn('leaveRaidLobby', () => {
    if (!playerLobby.has(socket.id)) return;
    _cleanupLobby(socket.id);
    socket.emit('lobbyLeft', {});
    _lobbyBroadcast();
  });

  safeOn('startRaidLobby', async () => {
    if (!authed) return;
    const lobbyId = playerLobby.get(socket.id);
    const lb = raidLobbies.get(lobbyId);
    if (!lb || lb.creatorId !== socket.id) return socket.emit('lobbyError', { msg: 'Вы не создатель группы' });
    if (lb.members.size < 2) return socket.emit('lobbyError', { msg: 'Нужно минимум 2 игрока' });
    const memberIds = [...lb.members.keys()];
    for (const mid of memberIds) {
      if (playerRaid.has(mid)) return socket.emit('lobbyError', { msg: 'Кто-то уже в рейде' });
    }
    // Re-check the daily lock against fresh DB state for every member right
    // before launch (not just at queue time) — someone could have used up
    // their attempts in another session between joining and starting.
    const lockChecks = await Promise.all(memberIds.map(mid => _raidLockedToday(mid)));
    const lockedIdx = lockChecks.findIndex(Boolean);
    if (lockedIdx !== -1) {
      const nm = lb.members.get(memberIds[lockedIdx])?.name || 'Игрок';
      return socket.emit('lobbyError', { msg: `У ${nm} закончились попытки в рейд на сегодня` });
    }
    raidLobbies.delete(lobbyId);
    memberIds.forEach(mid => playerLobby.delete(mid));
    const raidId = 'raid_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const raidRoom = new RaidRoom(raidId, io, memberIds, (mids) => {
      mids.forEach(mid => _cleanupRaidPlayer(mid));
      raidRooms.delete(raidId);
    });
    raidRooms.set(raidId, raidRoom);
    for (const mid of memberIds) {
      playerRaid.set(mid, raidId);
      // The daily attempt is used up the moment the run starts, not on a
      // successful clear — entering counts, win or lose.
      _lockRaidDaily(mid);
      const mfl = playerFloorMap.get(mid);
      const mRoom = mfl !== undefined ? floorRooms.get(mfl) : null;
      const mp = mRoom?.players.get(mid);
      if (mp) {
        mp._inRaid = true;
        raidRoom.addPlayer(mid, { maxHp: mp.maxHp, atk: mp.atk, def: mp.def, type: mp.type, username: mp.username || lb.members.get(mid)?.name || '' });
      } else {
        raidRoom.addPlayer(mid, { maxHp: 100, atk: 10, def: 0, type: 'lev', username: lb.members.get(mid)?.name || '' });
      }
      io.to(mid).emit('raidStart', { raidId, dungeon: raidRoom.dungeonData });
    }
    raidRoom.start();
    _lobbyBroadcast();
  });

  // ── Raid game ─────────────────────────────────────────────────────────────
  safeOn('raidMove', ({ x, y, hp }) => {
    const rId = playerRaid.get(socket.id);
    const rr  = rId ? raidRooms.get(rId) : null;
    if (rr) rr.updatePlayerPos(socket.id, x, y, hp);
  });

  safeOn('raidAttack', ({ enemyId }) => {
    const rId = playerRaid.get(socket.id);
    const rr  = rId ? raidRooms.get(rId) : null;
    if (!rr) return;
    const cp = currentRoom?.players.get(socket.id);
    const targetEnemy = rr._enemyMap.get(enemyId);
    const result = rr.attackEnemy(socket.id, enemyId, cp?.atk || 10, cp?.critChance || 0.05, cp?.critPower || 1.5);
    if (!result) return;
    // Broadcast attacker animation to all members
    if (targetEnemy) rr.memberIds.forEach(mid => io.to(mid).emit('raidPlayerAtk', { playerId: socket.id, tx: targetEnemy.x, ty: targetEnemy.y }));
    if (result.killed) {
      const rNorm  = result.isBoss && Math.random() < 0.10 ? 1 : 0;
      const rBless = result.isBoss && Math.random() < 0.01 ? 1 : 0;
      rr.memberIds.forEach(mid => io.to(mid).emit('raidEnemyKilled', {
        id: enemyId, ex: result.ex, ey: result.ey, isBoss: result.isBoss,
        normStone:  mid === socket.id ? rNorm  : 0,
        blessStone: mid === socket.id ? rBless : 0,
      }));
    } else {
      // dmg only to the attacker — see the enemyHurt split in the normal
      // attack handler.
      rr.memberIds.forEach(mid => io.to(mid).emit('raidEnemyHurt', {
        id: enemyId, hp: result.hp, dmg: mid === socket.id ? result.dmg : 0,
      }));
    }
  });

  safeOn('leaveRaid', () => { _cleanupRaid(socket.id); });

  // ── Party dungeon (maze + boss, min 3 players, 1x/day) ─────────────────────
  safeOn('getPartyDungeonLobbyList', () => {
    const list = [...pdLobbies.values()].map(lb => ({
      id: lb.id, creatorName: lb.creatorName,
      members: [...lb.members.entries()].map(([sid, m]) => ({ id: sid, name: m.name, bm: m.bm, lvl: m.lvl })),
    }));
    socket.emit('pdLobbyList', { lobbies: list });
  });

  safeOn('createPartyDungeonLobby', async () => {
    if (!authed) return;
    if (playerPdLobby.has(socket.id)) _cleanupPdLobby(socket.id);
    if (playerPartyDungeon.has(socket.id)) return socket.emit('pdLobbyError', { msg: 'Вы уже в подземелье' });
    const cp = currentRoom?.players.get(socket.id);
    if (!cp) return socket.emit('pdLobbyError', { msg: 'Выберите персонажа' });
    if ((cp.lvl || 1) < 10) return socket.emit('pdLobbyError', { msg: 'Нужен 10 уровень' });
    if (await _partyDungeonLockedToday(socket.id)) return socket.emit('pdLobbyError', { msg: 'Попытки в лабиринт на сегодня закончились' });
    const bm = calcBM(_lastStats);
    const lobbyId = 'pdlb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5);
    const lb = { id: lobbyId, creatorId: socket.id, creatorName: authed.username,
      members: new Map([[socket.id, { name: authed.username, bm, lvl: cp.lvl || 1 }]]) };
    pdLobbies.set(lobbyId, lb);
    playerPdLobby.set(socket.id, lobbyId);
    socket.emit('pdLobbyJoined', { lobbyId, isCreator: true,
      members: [...lb.members.entries()].map(([sid, m]) => ({ id: sid, name: m.name, bm: m.bm, lvl: m.lvl })) });
    _pdLobbyBroadcast();
  });

  safeOn('joinPartyDungeonLobby', async ({ lobbyId }) => {
    if (!authed) return;
    const lb = pdLobbies.get(lobbyId);
    if (!lb) return socket.emit('pdLobbyError', { msg: 'Группа не найдена' });
    if (lb.members.size >= PARTY_DUNGEON_MAX_MEMBERS) return socket.emit('pdLobbyError', { msg: 'Группа полна' });
    if (playerPartyDungeon.has(socket.id)) return socket.emit('pdLobbyError', { msg: 'Вы уже в подземелье' });
    if (playerPdLobby.has(socket.id)) _cleanupPdLobby(socket.id);
    const cp = currentRoom?.players.get(socket.id);
    if ((cp?.lvl || 1) < 10) return socket.emit('pdLobbyError', { msg: 'Нужен 10 уровень' });
    if (await _partyDungeonLockedToday(socket.id)) return socket.emit('pdLobbyError', { msg: 'Попытки в лабиринт на сегодня закончились' });
    const bm = calcBM(_lastStats);
    lb.members.set(socket.id, { name: authed.username, bm, lvl: cp?.lvl || 1 });
    playerPdLobby.set(socket.id, lobbyId);
    const memberList = [...lb.members.entries()].map(([sid, m]) => ({ id: sid, name: m.name, bm: m.bm, lvl: m.lvl }));
    lb.members.forEach((_, mid) => io.to(mid).emit('pdLobbyJoined', { lobbyId, isCreator: mid === lb.creatorId, members: memberList }));
    _pdLobbyBroadcast();
  });

  safeOn('leavePartyDungeonLobby', () => {
    if (!playerPdLobby.has(socket.id)) return;
    _cleanupPdLobby(socket.id);
    socket.emit('pdLobbyLeft', {});
    _pdLobbyBroadcast();
  });

  safeOn('startPartyDungeonLobby', async () => {
    if (!authed) return;
    const lobbyId = playerPdLobby.get(socket.id);
    const lb = pdLobbies.get(lobbyId);
    if (!lb || lb.creatorId !== socket.id) return socket.emit('pdLobbyError', { msg: 'Вы не создатель группы' });
    if (lb.members.size < PARTY_DUNGEON_MIN_MEMBERS) return socket.emit('pdLobbyError', { msg: `Нужно минимум ${PARTY_DUNGEON_MIN_MEMBERS} игрока` });
    const memberIds = [...lb.members.keys()];
    for (const mid of memberIds) {
      if (playerRaid.has(mid) || playerPartyDungeon.has(mid)) return socket.emit('pdLobbyError', { msg: 'Кто-то уже в подземелье' });
    }
    // Re-check the daily lock against fresh DB state for every member right
    // before launch (not just at queue time) — someone could have cleared
    // it in another session between joining the lobby and starting.
    const lockChecks = await Promise.all(memberIds.map(mid => _partyDungeonLockedToday(mid)));
    const lockedIdx = lockChecks.findIndex(Boolean);
    if (lockedIdx !== -1) {
      const nm = lb.members.get(memberIds[lockedIdx])?.name || 'Игрок';
      return socket.emit('pdLobbyError', { msg: `У ${nm} закончились попытки в лабиринт на сегодня` });
    }
    pdLobbies.delete(lobbyId);
    memberIds.forEach(mid => playerPdLobby.delete(mid));
    const pdId = 'pd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const pd = new PartyDungeonRoom(pdId, io, memberIds, (mids) => {
      mids.forEach(mid => _cleanupPartyDungeonPlayer(mid, pd.channel));
      pdRooms.delete(pdId);
    }, (deadMid) => {
      // Death kicks the player out of the dungeon entirely (no respawn-in-
      // place) — tell their client to leave, and drop our own bookkeeping.
      // Do NOT call pd.removePlayer here: PartyDungeonRoom._ejectPlayer()
      // already removed them internally, and if they were the last one
      // left, the room's own next-tick "nobody alive" check needs to see
      // that and run _fail() (proper notification + onFail cleanup) rather
      // than this callback silently stop()-ing it first.
      io.to(deadMid).emit('partyDungeonEliminated', {});
      _cleanupPartyDungeonPlayer(deadMid, pd.channel);
    });
    pdRooms.set(pdId, pd);
    for (const mid of memberIds) {
      playerPartyDungeon.set(mid, pdId);
      // The daily attempt is used up the moment the run starts, not on a
      // successful clear — entering counts, win or lose.
      _lockPartyDungeonDaily(mid);
      const mfl = playerFloorMap.get(mid);
      const mRoom = mfl !== undefined ? floorRooms.get(mfl) : null;
      const mp = mRoom?.players.get(mid);
      const mSocket = io.sockets.sockets.get(mid);
      if (mSocket) mSocket.join(pd.channel);
      if (mp) {
        mp._inRaid = true;
        pd.addPlayer(mid, mp.username || lb.members.get(mid)?.name || '', {
          maxHp: mp.maxHp, atk: mp.atk, def: mp.def, type: mp.type,
          critChance: mp.critChance, critPower: mp.critPower,
        });
      } else {
        pd.addPlayer(mid, lb.members.get(mid)?.name || '', { maxHp: 100, atk: 10, def: 0, type: 'lev' });
      }
      io.to(mid).emit('partyDungeonStart', { pdId, dungeon: pd.dungeonData, enemies: pd.enemySnapshot() });
    }
    pd.start();
    _pdLobbyBroadcast();
  });

  safeOn('partyDungeonMove', ({ x, y, facing, hp }) => {
    const pdId = playerPartyDungeon.get(socket.id);
    const pd = pdId ? pdRooms.get(pdId) : null;
    if (pd) pd.updatePlayerPos(socket.id, x, y, facing, hp);
  });

  // Sync this player's live stats (level-ups, gear, upgrades) into the
  // instance right before resolving damage — the player never actually
  // leaves their floor Room while in here (same convention raids use), so
  // currentRoom always holds their freshest server-computed stats.
  function _syncPdStats(pd) {
    const cp = currentRoom?.players.get(socket.id);
    if (cp) pd.updatePlayerStats(socket.id, { atk: cp.atk, def: cp.def, maxHp: cp.maxHp, critChance: cp.critChance, critPower: cp.critPower });
  }

  safeOn('partyDungeonAttack', ({ enemyId }) => {
    if (!_atkAllowed()) return;
    const pdId = playerPartyDungeon.get(socket.id);
    const pd = pdId ? pdRooms.get(pdId) : null;
    if (!pd) return;
    _syncPdStats(pd);
    const result = pd.attackEnemy(socket.id, enemyId);
    if (!result) return;
    _handlePartyDungeonKillResult(pd, socket.id, enemyId, result);
  });

  safeOn('partyDungeonSkillAttack', ({ enemyId, multiplier }) => {
    if (!_atkAllowed()) return;
    const pdId = playerPartyDungeon.get(socket.id);
    const pd = pdId ? pdRooms.get(pdId) : null;
    if (!pd) return;
    _syncPdStats(pd);
    const result = pd.skillAttackEnemy(socket.id, enemyId, multiplier);
    if (!result) return;
    _handlePartyDungeonKillResult(pd, socket.id, enemyId, result);
  });

  safeOn('partyDungeonSkillEffect', ({ enemyId, enemyIds, type, duration }) => {
    const pdId = playerPartyDungeon.get(socket.id);
    const pd = pdId ? pdRooms.get(pdId) : null;
    if (!pd) return;
    if (enemyId) pd.applySkillEffect(enemyId, type, duration);
    if (enemyIds) pd.applySkillEffectMany(enemyIds, type, duration);
    io.to(pd.channel).emit('enemyCC', { enemyId, enemyIds, type, duration });
  });

  safeOn('partyDungeonHealParty', ({ amount }) => {
    const pdId = playerPartyDungeon.get(socket.id);
    const pd = pdId ? pdRooms.get(pdId) : null;
    if (!pd) return;
    const healAmt = Math.max(0, Math.min(Math.floor(amount) || 0, 9999));
    pd.players.forEach((_, mid) => {
      if (mid === socket.id) return;
      if (pd.healPartyMember(mid, healAmt)) io.to(mid).emit('healPartyMember', { amount: healAmt });
    });
  });

  safeOn('leavePartyDungeon', () => { _cleanupPartyDungeon(socket.id); });

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
      // Nexum is server-authoritative — base the reward on the live balance
      // (cache), never on the possibly-stale savedData snapshot, so a quest
      // reward can't wipe nexum earned from drops earlier this session.
      const _newNexum = quest.reward.nexum
        ? (_liveNexum() + quest.reward.nexum)
        : null;
      // Build the per-field update using the in-memory savedData when available,
      // falling back to the DB current values when savedData is null (new player
      // who has never saved yet). In either case use $set on the whole savedData
      // object when savedData is null to avoid a MongoDB write error ("cannot
      // traverse null element") that would otherwise silently eat the completion.
      if (authed.savedData) {
        const upd = { 'savedData.specialQuestsDone': newDone };
        if (quest.reward.gold)  upd['savedData.gold']         = (authed.savedData.gold         || 0) + quest.reward.gold;
        if (_newNexum != null)  upd['savedData.nexumBalance'] = _newNexum;
        if (quest.reward.xp)    upd['savedData.xp']           = (authed.savedData.xp           || 0) + quest.reward.xp;
        await PlayerModel.updateOne({ telegramId: authed.telegramId }, { $set: upd });
        authed.savedData.specialQuestsDone = newDone;
        if (quest.reward.gold)  authed.savedData.gold         = (authed.savedData.gold         || 0) + quest.reward.gold;
        if (_newNexum != null)  authed.savedData.nexumBalance = _newNexum;
        if (quest.reward.xp)    authed.savedData.xp           = (authed.savedData.xp           || 0) + quest.reward.xp;
      } else {
        // savedData is null (brand-new player who hasn't saved yet): initialise
        // it as a plain object so dotted-path $set won't error on null parent.
        const freshData = { specialQuestsDone: newDone };
        if (quest.reward.gold)  freshData.gold         = quest.reward.gold;
        if (_newNexum != null)  freshData.nexumBalance = _newNexum;
        if (quest.reward.xp)    freshData.xp           = quest.reward.xp;
        await PlayerModel.updateOne({ telegramId: authed.telegramId }, { $set: { savedData: freshData } });
        authed.savedData = freshData;
      }
      if (_newNexum != null) {
        _setNexum(_newNexum);
      }
      if (_lastStats) {
        _lastStats.specialQuestsDone = newDone;
        if (quest.reward.gold)  _lastStats.gold         = (authed.savedData.gold         || 0);
        if (_newNexum != null)  _lastStats.nexumBalance = _newNexum;
        if (quest.reward.xp)    _lastStats.xp           = (authed.savedData.xp           || 0);
      }
      logPlayer(authed.telegramId, authed.username, 'special_quest', { questId, title: quest.title, reward: quest.reward });
      socket.emit('specialQuestDone', { questId: String(questId), reward: quest.reward });
    } catch(e) {
      console.error('completeSpecialQuest error:', e);
      socket.emit('specialQuestError', { questId: String(questId || ''), reason: 'server_error' });
    }
  });

  safeOn('disconnect', () => {
    if (_autoSaveInterval) { clearInterval(_autoSaveInterval); _autoSaveInterval = null; }
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
        _gramBalanceCache.delete(_tid);
        _nexumBalanceCache.delete(_tid);
      }
    } else {
      socket.data._flushNow?.();
    }
    _cleanupRaid(socket.id);
    _cleanupLobby(socket.id);
    _cleanupPartyDungeon(socket.id);
    _cleanupPdLobby(socket.id);
    // Leaving mid-round counts as being knocked out, so a round can't hang
    // waiting on someone who closed the app.
    _db.reg.delete(socket.id);
    _dbEliminate(socket.id);
    playerFloorMap.delete(socket.id);
    const partyId = playerParty.get(socket.id);
    if (partyId) _removeFromParty(partyId, socket.id);
    if (!currentRoom) return;
    socket.to(`floor_${currentFloor}`).emit('playerLeft', { id: socket.id });
    currentRoom.removePlayer(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
  _pollTg();
  _dbSchedule();
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
async function _gracefulShutdown(signal) {
  console.log(`${signal}: shutting down...`);
  // Stop all floor game loops
  floorRooms.forEach(r => r._stopLoop());
  // Disconnect all sockets — triggers disconnect event per socket which flushes pending saves
  io.close();
  // Wait 2s for in-flight DB writes to complete
  await new Promise(r => setTimeout(r, 2000));
  await mongoose.connection.close();
  console.log('Shutdown complete');
  process.exit(0);
}
process.on('SIGTERM', () => _gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => _gracefulShutdown('SIGINT'));
