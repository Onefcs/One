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
const {
  VIP_THRESHOLDS, VIP_BONUSES,
  ITEM_DEF, CRAFT_MATS, ENHANCE_MAX, ENHANCEABLE_SLOTS, enhanceBonus, isStackableItem,
} = require('../shared/definitions');

// ── Market (player-to-player item trading for GRAM) ────────────────────────
const MARKET_MIN_PRICE   = 0.1;
const MARKET_MAX_PRICE   = 1000;
const MARKET_FEE_PCT     = 0.10;   // burned — not paid out to anyone
const MARKET_MAX_ACTIVE  = 20;     // active listings per seller
const MARKET_MAX_QTY     = 9999;   // sanity bound on a stackable listing's quantity
const MARKET_LIST_COOLDOWN_MS = 3000;
function _round2(n) { return Math.round(n * 100) / 100; }

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
  assasin: {
    uncommon:  { id:'sw2', name:'Стальной нож',   slot:'weapon', img:'/images/wep/uk.png', atk:14,                       rarity:'uncommon' },
    rare:      { id:'sw3', name:'Нож дракона',    slot:'weapon', img:'/images/wep/rk.png', atk:23, critChance:0.05,       rarity:'rare'     },
    epic:      { id:'sw4', name:'Нож теней',      slot:'weapon', img:'/images/wep/ek.png', atk:44, critChance:0.10,       rarity:'epic'     },
    legendary: { id:'sw5', name:'Нож героя',      slot:'weapon', img:'/images/wep/lk.png', atk:65, critChance:0.25,       rarity:'legendary'},
  },
  warrior: {
    uncommon:  { id:'tw2', name:'Стальной топор', slot:'weapon', img:'/images/wep/ut.png', atk:15,                       rarity:'uncommon' },
    rare:      { id:'tw3', name:'Топор дракона',  slot:'weapon', img:'/images/wep/rt.png', atk:23,                       rarity:'rare'     },
    epic:      { id:'tw4', name:'Топор теней',    slot:'weapon', img:'/images/wep/et.png', atk:44,                       rarity:'epic'     },
    legendary: { id:'tw5', name:'Топор героя',    slot:'weapon', img:'/images/wep/lt.png', atk:65,                       rarity:'legendary'},
  },
  archer: {
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
_VIP_WEAPONS.priest = _VIP_WEAPONS.mage;

const _VIP_BP = [
  { id:'bp_hp',       name:'Зелье здоровья',  slot:'buff_potion', img:'/images/potion/hp.png',       rarity:'uncommon', buffType:'hp',       buffDur:600},
  { id:'bp_exp',      name:'Зелье опыта',      slot:'buff_potion', img:'/images/potion/exp.png',      rarity:'uncommon', buffType:'exp',      buffDur:600},
  { id:'bp_gold',     name:'Зелье золота',     slot:'buff_potion', img:'/images/potion/gold.png',     rarity:'uncommon', buffType:'gold',     buffDur:600},
  { id:'bp_regen',    name:'Зелье регена',     slot:'buff_potion', img:'/images/potion/regen.png',    rarity:'uncommon', buffType:'regen',    buffDur:600},
  { id:'bp_atkspeed', name:'Зелье скорости',   slot:'buff_potion', img:'/images/potion/atkspeed.png', rarity:'uncommon', buffType:'atkspeed', buffDur:600},
  { id:'bp_atk',      name:'Зелье атаки',      slot:'buff_potion', img:'/images/potion/atk.png',      rarity:'uncommon', buffType:'atk',      buffDur:600},
];

// ── GRAM Shop ─────────────────────────────────────────────────────────────────
const _GRAM_SHOP_PKGS = [
  { id:'pkg1',   gram:1,   gold:1000,   potions:2,   armor:null,       weapon:null,       bonusSP:0  },
  { id:'pkg5',   gram:5,   gold:5000,   potions:10,  armor:null,       weapon:null,       bonusSP:0  },
  { id:'pkg10',  gram:10,  gold:7000,   potions:10,  armor:'common',   weapon:'common',   bonusSP:1  },
  { id:'pkg30',  gram:30,  gold:20000,  potions:30,  armor:'uncommon', weapon:'uncommon', bonusSP:2  },
  { id:'pkg50',  gram:50,  gold:50000,  potions:50,  armor:'rare',     weapon:null,       bonusSP:5  },
  { id:'pkg100', gram:100, gold:100000, potions:100, armor:'rare',     weapon:'rare',     bonusSP:10 },
];
// Weapon IDs per class and rarity for the shop (reuses ITEM_DEF entries)
const _SHOP_CLASS_WEAPONS = {
  warrior: { common:'tw1', uncommon:'tw2', rare:'tw3' },
  assasin: { common:'sw1', uncommon:'sw2', rare:'sw3' },
  archer:  { common:'bw1', uncommon:'bw2', rare:'bw3' },
  mage:    { common:'st1', uncommon:'st2', rare:'st3' },
  priest:  { common:'st1', uncommon:'st2', rare:'st3' },
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
  const wepMap = _VIP_WEAPONS[charClass] || _VIP_WEAPONS.warrior;
  const items = [];
  function addStone(id, qty) { if (qty > 0) items.push({ ..._STONE_DEFS[id], qty }); }
  function addBP(qty)        { _VIP_BP.forEach(bp => items.push({ ...bp, qty })); }
  function addWep(rarity, enhance) {
    const w = wepMap[rarity]; if (w) items.push({ ...w, enhance: enhance || 0, qty: 1 });
  }
  switch (vipLevel) {
    case 3:  addStone('bless_stone', 2); break;
    case 4:  addStone('bless_stone', 5); addBP(10); break;
    case 5:  addStone('bless_stone', 7); addBP(10); break;
    case 6:  addWep('uncommon', 8); addStone('bless_stone', 7); addBP(10); break;
    case 7:  addWep('rare', 8); addStone('norm_stone', 20); addStone('bless_stone', 10); break;
    case 8:  addWep('epic', 1); addBP(50); addStone('norm_stone', 50); addStone('bless_stone', 30); break;
    case 9:  addWep('epic', 8); addBP(80); addStone('norm_stone', 70); addStone('bless_stone', 30); break;
    case 10: addWep('legendary', 0); addBP(100); addStone('norm_stone', 100); addStone('bless_stone', 100); break;
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
      const saved = doc.savedData || {};
      const newBal = (saved.gramBalance || 0) + tx.amount;
      saved.gramBalance = newBal;
      doc.savedData = saved;
      doc.markModified('savedData');
      await doc.save();
      _gramBalanceCache.set(tx.telegramId, newBal);
      io.to(`tg_${tx.telegramId}`).emit('gramBalanceUpdate', { balance: newBal });

      // 5% referral bonus on confirmed deposit
      if (confirmed && tx.type === 'deposit' && doc.referredBy) {
        const bonus = Math.round(tx.amount * 0.05 * 100) / 100;
        if (bonus > 0) {
          const refDoc = await PlayerModel.findOne({ telegramId: doc.referredBy });
          if (refDoc) {
            const refSaved = refDoc.savedData || {};
            const refNewBal = (refSaved.gramBalance || 0) + bonus;
            refSaved.gramBalance = refNewBal;
            refDoc.savedData = refSaved;
            refDoc.markModified('savedData');
            await refDoc.save();
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

async function _notifyAdminNewPlayer(username, telegramId, referrerUsername) {
  if (!TG_ADMIN_ID) return;
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
    const referrerId = param.slice(4);
    if (referrerId !== fromId) {
      let player = await PlayerModel.findOne({ telegramId: fromId });
      let refWasNew = false;
      if (!player) {
        isNewPlayer = true;
        refWasNew = true;
        player = await PlayerModel.create({ telegramId: fromId, username, referredBy: referrerId });
      } else if (!player.referredBy) {
        refWasNew = true;
        player.referredBy = referrerId;
        await player.save();
      }

      if (refWasNew) {
        // Get referrer info for notifications
        const referrer = await PlayerModel.findOne({ telegramId: referrerId }, 'username telegramId').lean();
        referrerUsername = referrer?.username || null;

        // Notify referrer via socket (if online) and via Telegram bot — once only
        io.to(`tg_${referrerId}`).emit('friendJoined', { username });
        await tgApi('sendMessage', {
          chat_id: referrerId,
          text: [
            '🎉 <b>Друг принял приглашение!</b>',
            `👤 @${username} только что зашёл в игру по вашей ссылке.`,
            '',
            '💡 Когда друг пополняет GRAM — вы получаете <b>5% бонус</b>.',
          ].join('\n'),
          parse_mode: 'HTML',
        }).catch(() => {});
      }
    }
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
      '⚔️ <b>Nexum</b> — мобильная MMORPG прямо в Telegram.',
      '',
      '🗡 Исследуй подземелья и уничтожай врагов',
      '🏆 Соревнуйся в рейтинге игроков',
      '🛡 Вступай в кланы и ходи в рейды',
      '💎 Улучшай снаряжение и прокачивай персонажа',
      refText,
      '',
      '▶️ Нажми кнопку ниже, чтобы начать!',
    ].filter(l => l !== null).join('\n'),
    reply_markup: { inline_keyboard: [[button]] },
  }).catch(() => {});
}

function _refLink(telegramId) {
  const bot = _tgBotUsername || process.env.TG_BOT_USERNAME || '';
  if (!bot) return '';
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

// Mini App verification (opened inside Telegram app) — different secret derivation
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
    return userStr ? JSON.parse(userStr) : null;
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
  'js/sprites.js',
  'js/particles.js',
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
// defaults. All other helmet defaults (incl. X-Frame-Options SAMEORIGIN /
// frame-ancestors 'self') are preserved unchanged.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      scriptSrc:     ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://telegram.org', 'https://cdn.socket.io'],
      scriptSrcAttr: ["'unsafe-inline'"],
      workerSrc:     ["'self'", 'blob:'],
      childSrc:      ["'self'", 'blob:'],
      styleSrc:      ["'self'", "'unsafe-inline'"],
      styleSrcAttr:  ["'unsafe-inline'"],
      imgSrc:        ["'self'", 'data:', 'blob:'],
      connectSrc:    ["'self'", 'https://cdn.socket.io', 'wss:', 'ws:'],
      fontSrc:       ["'self'", 'data:'],
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
      saved.gramBalance = (saved.gramBalance || 0) + Number(gram);
      const cur = _gramBalanceCache.get(p.telegramId) || 0;
      _gramBalanceCache.set(p.telegramId, cur + Number(gram));
      io.to(`tg_${p.telegramId}`).emit('gramBalanceUpdate', { balance: saved.gramBalance });
    }
    p.savedData = saved;
    p.markModified('savedData');
    await p.save();
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

// Images: cache 30 days — sprites never change between deploys
app.use('/images', express.static(path.join(__dirname, '..', 'images'), { maxAge: '30d', immutable: true }));

// Vendored PixiJS (~456 KB) never changes between deploys, but the catch-all
// static handler below serves it with no explicit caching, so mobile clients
// re-validate the whole file on every load (a wasted round trip and, on a cold
// cache, a full re-download). Serve it immutable with a 1-year TTL so the
// browser skips the request entirely once it's cached.
app.get('/js/pixi.min.js', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(path.join(ROOT, 'js', 'pixi.min.js'));
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

// One permanent Room per floor — pre-created at startup, never destroyed.
// All players on the same floor share one world (no sub-instances, no capacity limit).
const MAX_FLOOR = 5;
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
  maxHp: 1e7, atk: 1e6, def: 1e6, baseStat: 1e6, hpBase: 1e7, invLen: 500, qty: 9999,
};

function _catalogBase(id) {
  return ITEM_DEF.find(d => d.id === id) || CRAFT_MATS.find(d => d.id === id) || null;
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

function _sanitizeSavedStats(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const s = { ...raw };

  // Inventory — canonicalize, drop unknowns, cap length
  s.inventory = Array.isArray(s.inventory)
    ? s.inventory.slice(0, _SANITIZE_MAX.invLen).map(_canonSavedItem).filter(Boolean)
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
  return s;
}

// Escape user input before embedding it in a Mongo $regex, so a crafted query
// can't inject regex operators (ReDoS / catastrophic backtracking on the DB).
function _escapeRegex(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

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

function calcBM(s) {
  if (!s) return 0;
  const upg = s.upgrades || {};
  const extras = ((upg.critChance || 0) + (upg.critPower || 0) +
    (upg.hpRegen || 0) + (upg.atkSpeed || 0)) * 8;
  return Math.round((s.level || 1) * 50 + (s.atk || 0) * 5 + (s.def || 0) * 3 + (s.maxHp || 100) * 0.5 + extras);
}

// Global chat history (last 30 messages across all floors)
const globalChatHistory = [];
function _recordChat(username, text) {
  const now = new Date();
  const time = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
  globalChatHistory.push({ username, text, time });
  if (globalChatHistory.length > 30) globalChatHistory.shift();
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

// Pre-create all floor rooms at startup
mongoose.connection.once('open', () => {
  for (let f = 1; f <= MAX_FLOOR; f++) {
    floorRooms.set(f, new Room(f, io));
  }
});

io.on('connection', socket => {
  let authed = null;
  let currentRoom = null;
  let currentFloor = 1;
  let _lastStats = null;
  let _autoSaveInterval = null;
  let _myClanName = null;
  let _myClanIcon = null;
  let _gramBalance = 0;
  let _nexumBalance = 0;
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
        { ..._lastStats, gramBalance: _gramBalanceCache.get(authed.telegramId) ?? _gramBalance, nexumBalance: _nexumBalanceCache.get(authed.telegramId) ?? _nexumBalance },
        { bm: authed.bm });
    }
  };

  const NEXUM_DROP_CHANCE = [0, 0.005, 0.01, 0.02, 0.03, 0.05];

  function _startAutosave() {
    if (_autoSaveInterval) clearInterval(_autoSaveInterval);
    _autoSaveInterval = setInterval(() => {
      if (!authed || !_lastStats) return;
      const saveData = { ..._lastStats, floor: currentFloor, gramBalance: _gramBalanceCache.get(authed.telegramId) ?? _gramBalance, nexumBalance: _nexumBalanceCache.get(authed.telegramId) ?? _nexumBalance };
      if (currentRoom) {
        const p = currentRoom.players.get(socket.id);
        if (p && p.hp > 0) saveData.hp = p.hp;
      }
      const bmNow = calcBM(_lastStats);
      authed.bm = bmNow;
      _persistSavedFields(authed, saveData, { bm: bmNow });
    }, 60000);
  }

  socket.on('_ping', t0 => socket.emit('_pong', t0));

  socket.on('loginTelegramWebApp', async ({ initData }) => {
    try {
      const user = verifyTelegramWebApp(initData);
      if (!user) return socket.emit('authError', { message: 'Ошибка авторизации Telegram' });
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
      if (!doc) doc = await PlayerModel.create({ telegramId, username, savedData: {} });
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
      _gramBalance = doc.savedData?.gramBalance || 0;
      _nexumBalance = doc.savedData?.nexumBalance || 0;
      _gramBalanceCache.set(telegramId, _gramBalance);
      _nexumBalanceCache.set(telegramId, _nexumBalance);
      _startAutosave();
      socket.join(`tg_${telegramId}`);
      const _clan = await ClanModel.findOne({ 'members.telegramId': telegramId }).catch(() => null);
      const _clanInfo = _clan ? await _clanDataFor(_clan, telegramId) : null;
      _myClanName = _clanInfo ? _clanInfo.name : null;
      _myClanIcon = _clanInfo ? _clanInfo.icon : null;
      socket.data.vipLevel = doc.savedData?.vipLevel || 0;
      socket.emit('authOk', { username: doc.username, savedData: doc.savedData || null, clanInfo: _clanInfo, gramBalance: _gramBalance, gramWallet: GRAM_WALLET, refLink: _refLink(telegramId), vipData: { level: doc.savedData?.vipLevel || 0, deposited: doc.savedData?.vipDeposited || 0, pending: doc.savedData?.vipPending || [] }, nexumBalance: _nexumBalance });
    } catch (err) {
      console.error('loginTelegramWebApp:', err);
      socket.emit('authError', { message: 'Ошибка сервера' });
    }
  });

  socket.on('loginTelegram', async (data) => {
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
      if (!doc) doc = await PlayerModel.create({ telegramId, username, savedData: {} });
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
      _gramBalance = doc.savedData?.gramBalance || 0;
      _nexumBalance = doc.savedData?.nexumBalance || 0;
      _gramBalanceCache.set(telegramId, _gramBalance);
      _nexumBalanceCache.set(telegramId, _nexumBalance);
      _startAutosave();
      socket.join(`tg_${telegramId}`);
      const _clan = await ClanModel.findOne({ 'members.telegramId': telegramId }).catch(() => null);
      const _clanInfo = _clan ? await _clanDataFor(_clan, telegramId) : null;
      _myClanName = _clanInfo ? _clanInfo.name : null;
      _myClanIcon = _clanInfo ? _clanInfo.icon : null;
      socket.data.vipLevel = doc.savedData?.vipLevel || 0;
      socket.emit('authOk', { username: doc.username, savedData: doc.savedData || null, clanInfo: _clanInfo, gramBalance: _gramBalance, gramWallet: GRAM_WALLET, refLink: _refLink(telegramId), vipData: { level: doc.savedData?.vipLevel || 0, deposited: doc.savedData?.vipDeposited || 0, pending: doc.savedData?.vipPending || [] }, nexumBalance: _nexumBalance });
    } catch (err) {
      console.error('loginTelegram:', err);
      socket.emit('authError', { message: 'Ошибка сервера' });
    }
  });

  // ── GRAM wallet ───────────────────────────────────────────────────────────
  socket.on('gramDepositRequest', async ({ amount, memo }) => {
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

  socket.on('gramWithdrawRequest', async ({ amount, address }) => {
    if (!authed || !amount || amount < 10 || !address) return;
    try {
      if (amount > _gramBalance) return socket.emit('gramError', { msg: 'Недостаточно средств' });

      // Deduct immediately — refunded on rejection
      _gramBalance -= amount;
      _gramBalanceCache.set(authed.telegramId, _gramBalance);
      const doc = await PlayerModel.findById(authed._id);
      const saved = doc.savedData || {};
      saved.gramBalance = _gramBalance;
      doc.savedData = saved;
      doc.markModified('savedData');
      await doc.save();

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

  socket.on('gramGetHistory', async () => {
    if (!authed) return;
    try {
      const txs = await GramTxModel.find({ telegramId: authed.telegramId })
        .sort({ createdAt: -1 }).limit(30).lean();
      socket.emit('gramHistory', { txs: txs.map(_txData) });
    } catch (err) { console.error('gramGetHistory:', err); }
  });

  socket.on('gramShopBuy', async ({ pkgId } = {}) => {
    if (!authed || !pkgId) return;
    try {
      const pkg = _GRAM_SHOP_PKGS.find(p => p.id === pkgId);
      if (!pkg) return socket.emit('gramShopError', { msg: 'Пакет не найден' });
      if (_gramBalance < pkg.gram) return socket.emit('gramShopError', { msg: 'Недостаточно GRAM' });

      const doc = await PlayerModel.findById(authed._id);
      if (!doc) return;
      const saved = doc.savedData || {};
      const charClass = saved.type || 'warrior';
      const wepMap = _SHOP_CLASS_WEAPONS[charClass] || _SHOP_CLASS_WEAPONS.warrior;
      const inv = Array.isArray(saved.inventory) ? [...saved.inventory] : [];

      // Deduct GRAM
      _gramBalance -= pkg.gram;
      _gramBalanceCache.set(authed.telegramId, _gramBalance);
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
          if (base) inv.push({ ...base, enhance: 0 });
        });
      }

      // Class weapon
      if (pkg.weapon) {
        const wepId = wepMap[pkg.weapon];
        const base = ITEM_DEF.find(d => d.id === wepId);
        if (base) inv.push({ ...base, enhance: 0 });
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
      doc.savedData = saved;
      doc.markModified('savedData');
      await doc.save();

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
  socket.on('marketBrowse', async () => {
    if (!authed) return;
    try {
      const rows = await MarketListingModel.find({ status: 'active', sellerId: { $ne: authed.telegramId } })
        .sort({ createdAt: -1 }).limit(200).lean();
      socket.emit('marketBrowseData', { listings: rows.map(_marketListingData) });
    } catch (err) { console.error('marketBrowse:', err); }
  });

  socket.on('marketMyListings', async () => {
    if (!authed) return;
    try {
      const rows = await MarketListingModel.find({ status: 'active', sellerId: authed.telegramId })
        .sort({ createdAt: -1 }).limit(MARKET_MAX_ACTIVE).lean();
      socket.emit('marketMyListingsData', { listings: rows.map(_marketListingData) });
    } catch (err) { console.error('marketMyListings:', err); }
  });

  socket.on('marketHistory', async () => {
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
  socket.on('marketList', async ({ item, price } = {}) => {
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
    try {
      const activeCount = await MarketListingModel.countDocuments({ sellerId: authed.telegramId, status: 'active' });
      if (activeCount >= MARKET_MAX_ACTIVE) {
        return socket.emit('marketListError', { msg: `Максимум ${MARKET_MAX_ACTIVE} активных лотов` });
      }
      _lastMarketListAt = now;
      const listing = await MarketListingModel.create({
        sellerId: authed.telegramId, sellerUsername: authed.username,
        item: canonItem, price: _round2(p), status: 'active',
      });
      socket.emit('marketListed', { listing: _marketListingData(listing) });
    } catch (err) {
      console.error('marketList:', err);
      socket.emit('marketListError', { msg: 'Ошибка сервера' });
    }
  });

  socket.on('marketCancel', async ({ listingId } = {}) => {
    if (!authed || !listingId) return;
    try {
      const listing = await MarketListingModel.findOneAndUpdate(
        { _id: listingId, sellerId: authed.telegramId, status: 'active' },
        { status: 'cancelled', soldAt: new Date() },
        { new: false }, // return the pre-update doc (still has the item)
      );
      if (!listing) return socket.emit('marketError', { msg: 'Лот не найден' });
      socket.emit('marketCancelled', { listingId, item: listing.item });
    } catch (err) { console.error('marketCancel:', err); }
  });

  socket.on('marketBuy', async ({ listingId } = {}) => {
    if (!authed || !listingId) return;
    try {
      const listing = await MarketListingModel.findOne({ _id: listingId, status: 'active' }, 'sellerId price').lean();
      if (!listing) return socket.emit('marketError', { msg: 'Лот уже продан или снят' });
      if (listing.sellerId === authed.telegramId) return socket.emit('marketError', { msg: 'Нельзя купить свой лот' });
      if (listing.price > _gramBalance) return socket.emit('marketError', { msg: 'Недостаточно GRAM' });

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
      if (claimed.price > _gramBalance) {
        await MarketListingModel.updateOne(
          { _id: listingId },
          { status: 'active', buyerId: null, buyerUsername: null, soldAt: null },
        ).catch(err => console.error('marketBuy release claim:', err));
        return socket.emit('marketError', { msg: 'Недостаточно GRAM' });
      }
      _gramBalance -= claimed.price;
      _gramBalanceCache.set(authed.telegramId, _gramBalance);
      const buyerDoc = await PlayerModel.findById(authed._id);
      const buyerSaved = buyerDoc.savedData || {};
      buyerSaved.gramBalance = _gramBalance;
      buyerDoc.savedData = buyerSaved;
      buyerDoc.markModified('savedData');
      await buyerDoc.save();

      // Credit seller (10% fee burned — not paid to anyone), whether online or not
      const payout = _round2(claimed.price * (1 - MARKET_FEE_PCT));
      try {
        const sellerDoc = await PlayerModel.findOne({ telegramId: claimed.sellerId });
        if (sellerDoc) {
          const sellerSaved = sellerDoc.savedData || {};
          const sellerNewBal = _round2((sellerSaved.gramBalance || 0) + payout);
          sellerSaved.gramBalance = sellerNewBal;
          sellerDoc.savedData = sellerSaved;
          sellerDoc.markModified('savedData');
          await sellerDoc.save();
          _gramBalanceCache.set(claimed.sellerId, sellerNewBal);
          io.to(`tg_${claimed.sellerId}`).emit('gramBalanceUpdate', { balance: sellerNewBal });
          io.to(`tg_${claimed.sellerId}`).emit('marketSold', {
            itemName: claimed.item?.name || '', price: claimed.price, payout,
            buyerUsername: authed.username, newBalance: sellerNewBal,
          });
        }
      } catch (err) { console.error('marketBuy seller payout:', err); }

      socket.emit('marketBought', { listingId, item: claimed.item, newBalance: _gramBalance });
    } catch (err) { console.error('marketBuy:', err); }
  });

  socket.on('getReferrals', async () => {
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

  socket.on('getRating', async ({ tab }) => {
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

  socket.on('claimVipRewards', async () => {
    if (!authed) return;
    try {
      const doc = await PlayerModel.findById(authed._id);
      if (!doc) return;
      const saved = doc.savedData || {};
      const pending = Array.isArray(saved.vipPending) ? [...saved.vipPending] : [];
      if (!pending.length) return;
      const charClass = saved.type || 'warrior';
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
      doc.savedData = saved;
      doc.markModified('savedData');
      await doc.save();
      if (_lastStats) {
        _lastStats.inventory = inv;
        if (goldReward > 0) _lastStats.gold = saved.gold;
      }
      socket.emit('vipRewardsClaimed', { newInventory: inv, goldAdded: goldReward, vipPending: [] });
    } catch (err) { console.error('claimVipRewards:', err); }
  });

  socket.on('selectChar', ({ type, savedStats }) => {
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
      const savedFloor = (effectiveSaved?.floor > 1) ? Math.max(1, Math.min(MAX_FLOOR, effectiveSaved.floor)) : 1;
      currentFloor = savedFloor;
      currentRoom = getRoom(currentFloor);
      playerFloorMap.set(socket.id, currentFloor);
      socket.join(`floor_${currentFloor}`);
      currentRoom.addPlayer(socket.id, authed.username, _myClanName, _myClanIcon);
      socket.to(`floor_${currentFloor}`).emit('playerJoined', { id: socket.id, username: authed.username });
      if (globalChatHistory.length) socket.emit('chatHistory', globalChatHistory);
    }
    currentRoom.setPlayerChar(socket.id, type, effectiveSaved);
    socket.to(`floor_${currentFloor}`).emit('playerChar', { id: socket.id, type });
    socket.emit('gameStart', {
      floor: currentFloor,
      dungeon: currentRoom.dungeonData,
      enemies: currentRoom.enemySnapshot(),
    });
  });

  socket.on('playerMove', ({ x, y, facing, hp }) => {
    if (!currentRoom) return;
    currentRoom.updatePlayerPos(socket.id, x, y, facing);
    if (hp != null && isFinite(hp)) currentRoom.syncPlayerHp(socket.id, hp);
  });

  socket.on('usePotion', ({ amount }) => {
    if (currentRoom) currentRoom.healPlayer(socket.id, Math.min(amount || 60, 200));
  });

  socket.on('statsUpdate', ({ atk, def, maxHp, critChance, critPower }) => {
    if (currentRoom) currentRoom.updatePlayerStats(socket.id, { atk, def, maxHp, critChance, critPower });
  });

  socket.on('pvpDamageTaken', ({ actual }) => {
    if (!currentRoom) return;
    const newHp = currentRoom.applyPvpDamage(socket.id, Math.max(0, Math.min(actual, 9999)));
    if (newHp !== null && newHp <= 0)
      io.to(socket.id).emit('playerHurt', { id: socket.id, hp: 0 });
  });

  socket.on('attack', ({ enemyId }) => {
    if (!_atkAllowed()) return;
    if (!currentRoom) return;
    if (currentRoom.isPlayerInSafeZone(socket.id)) return;
    const result = currentRoom.attackEnemy(socket.id, enemyId);
    if (!result) return;
    if (result.killed) {
      const partyId    = playerParty.get(socket.id);
      const partyMap   = partyId ? parties.get(partyId) : null;

      // Party members on the same floor (excluding attacker)
      const memberIds = [];
      if (partyMap) {
        partyMap.forEach((_, mid) => {
          if (mid !== socket.id && playerFloorMap.get(mid) === currentFloor) memberIds.push(mid);
        });
      }

      const bossStone = result.isBoss
        ? (currentFloor + Math.floor(Math.random() * 3)) : 0;
      const normStone  = result.isBoss && Math.random() < 0.10 ? 1 : 0;
      const blessStone = result.isBoss && Math.random() < 0.01 ? 1 : 0;
      const nexumDrop  = Math.random() < (NEXUM_DROP_CHANCE[currentFloor] || 0) ? 1 : 0;
      const _vipBon = VIP_BONUSES[socket.data.vipLevel || 0] || VIP_BONUSES[0];
      if (_vipBon.xp   > 0) result.xp   = Math.round(result.xp   * (1 + _vipBon.xp   / 100));
      if (_vipBon.gold > 0) result.gold = Math.round(result.gold * (1 + _vipBon.gold / 100));

      if (nexumDrop > 0) {
        _nexumBalance += nexumDrop;
        _nexumBalanceCache.set(authed.telegramId, _nexumBalance);
        _persistSavedFields(authed, { nexumBalance: _nexumBalance });
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
          gotLoot: lootWinnerId === socket.id, eid: result.eid,
          bossStone: lootWinnerId === socket.id ? bossStone : 0,
          normStone:  lootWinnerId === socket.id ? normStone  : 0,
          blessStone: lootWinnerId === socket.id ? blessStone : 0,
          nexum: nexumDrop,
        });
        memberIds.forEach(mid => {
          io.to(mid).emit('enemyKilled', {
            id: enemyId, xp: xpShare, gold: goldShare,
            ex: result.ex, ey: result.ey, color: result.color,
            gotLoot: lootWinnerId === mid, eid: result.eid,
            bossStone:  lootWinnerId === mid ? bossStone  : 0,
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
          gotLoot: true, eid: result.eid, bossStone, normStone, blessStone, nexum: nexumDrop,
        });
        socket.to(`floor_${currentFloor}`).emit('enemyKilled', {
          id: enemyId, ex: result.ex, ey: result.ey, color: result.color,
        });
      }
      _onKillClanXp().catch(() => {});
    } else {
      io.to(`floor_${currentFloor}`).emit('enemyHurt', { id: enemyId, hp: result.hp, dmg: result.dmg, isCrit: result.isCrit });
    }
  });

  socket.on('skillAttack', ({ enemyId, multiplier }) => {
    if (!_atkAllowed()) return;
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
        rr.memberIds.forEach(mid => io.to(mid).emit('raidEnemyHurt', { id: enemyId, hp: result.hp, dmg: result.dmg }));
      }
      return;
    }
    if (!currentRoom) return;
    if (currentRoom.isPlayerInSafeZone(socket.id)) return;
    const result = currentRoom.skillAttackEnemy(socket.id, enemyId, multiplier);
    if (!result) return;
    if (result.killed) {
      const partyId    = playerParty.get(socket.id);
      const partyMap   = partyId ? parties.get(partyId) : null;
      const memberIds  = [];
      if (partyMap) {
        partyMap.forEach((_, mid) => {
          if (mid !== socket.id && playerFloorMap.get(mid) === currentFloor) memberIds.push(mid);
        });
      }
      const bossStone  = result.isBoss ? (currentFloor + Math.floor(Math.random() * 3)) : 0;
      const normStone  = result.isBoss && Math.random() < 0.10 ? 1 : 0;
      const blessStone = result.isBoss && Math.random() < 0.01 ? 1 : 0;
      const nexumDrop2 = Math.random() < (NEXUM_DROP_CHANCE[currentFloor] || 0) ? 1 : 0;
      const _vipBon2 = VIP_BONUSES[socket.data.vipLevel || 0] || VIP_BONUSES[0];
      if (_vipBon2.xp   > 0) result.xp   = Math.round(result.xp   * (1 + _vipBon2.xp   / 100));
      if (_vipBon2.gold > 0) result.gold = Math.round(result.gold * (1 + _vipBon2.gold / 100));
      if (nexumDrop2 > 0) {
        _nexumBalance += nexumDrop2;
        _nexumBalanceCache.set(authed.telegramId, _nexumBalance);
        _persistSavedFields(authed, { nexumBalance: _nexumBalance });
      }
      if (memberIds.length > 0) {
        const totalMembers = memberIds.length + 1;
        const xpShare = result.xp / totalMembers, goldShare = result.gold / totalMembers;
        const allIds = [socket.id, ...memberIds];
        const lootWinnerId = allIds[Math.floor(Math.random() * allIds.length)];
        socket.emit('enemyKilled', {
          id: enemyId, xp: xpShare, gold: goldShare, dmg: result.dmg, isCrit: result.isCrit,
          ex: result.ex, ey: result.ey, color: result.color,
          gotLoot: lootWinnerId === socket.id, eid: result.eid,
          bossStone: lootWinnerId === socket.id ? bossStone : 0,
          normStone:  lootWinnerId === socket.id ? normStone  : 0,
          blessStone: lootWinnerId === socket.id ? blessStone : 0,
          nexum: nexumDrop2,
        });
        memberIds.forEach(mid => io.to(mid).emit('enemyKilled', {
          id: enemyId, xp: xpShare, gold: goldShare,
          ex: result.ex, ey: result.ey, color: result.color,
          gotLoot: lootWinnerId === mid, eid: result.eid,
          bossStone:  lootWinnerId === mid ? bossStone  : 0,
          normStone:  lootWinnerId === mid ? normStone  : 0,
          blessStone: lootWinnerId === mid ? blessStone : 0,
        }));
        socket.to(`floor_${currentFloor}`).except(memberIds).emit('enemyKilled', { id: enemyId, ex: result.ex, ey: result.ey, color: result.color });
      } else {
        socket.emit('enemyKilled', {
          id: enemyId, xp: result.xp, gold: result.gold, dmg: result.dmg, isCrit: result.isCrit,
          ex: result.ex, ey: result.ey, color: result.color,
          gotLoot: true, eid: result.eid, bossStone, normStone, blessStone, nexum: nexumDrop2,
        });
        socket.to(`floor_${currentFloor}`).emit('enemyKilled', { id: enemyId, ex: result.ex, ey: result.ey, color: result.color });
      }
      _onKillClanXp().catch(() => {});
    } else {
      io.to(`floor_${currentFloor}`).emit('enemyHurt', { id: enemyId, hp: result.hp, dmg: result.dmg, isCrit: result.isCrit });
    }
  });

  socket.on('skillEffect', ({ enemyId, enemyIds, type, duration }) => {
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

  socket.on('playerInvis', ({ invis }) => {
    if (!currentRoom) return;
    const p = currentRoom.players.get(socket.id);
    if (p) p._invis = !!invis;
  });

  socket.on('faithShield', ({ duration }) => {
    const partyId = playerParty.get(socket.id);
    const partyMap = partyId ? parties.get(partyId) : null;
    if (!partyMap) return;
    partyMap.forEach((_, mid) => {
      if (mid !== socket.id) io.to(mid).emit('faithShieldBuff', { duration });
    });
  });

  socket.on('changeFloor', ({ floor }) => {
    if (!currentRoom) return;
    const newFloor = Math.max(1, Math.min(MAX_FLOOR, floor));
    if (newFloor === currentFloor) return;

    // Snapshot player state before leaving
    const p = currentRoom.players.get(socket.id);

    // Leave old floor
    socket.leave(`floor_${currentFloor}`);
    socket.to(`floor_${currentFloor}`).emit('playerLeft', { id: socket.id });
    currentRoom.removePlayer(socket.id);

    // Join new floor
    currentFloor = newFloor;
    playerFloorMap.set(socket.id, currentFloor);
    currentRoom = getRoom(newFloor);
    socket.join(`floor_${newFloor}`);
    currentRoom.addPlayer(socket.id, authed.username);
    if (globalChatHistory.length) socket.emit('chatHistory', globalChatHistory);

    // Carry over character stats directly — avoids recalculation from partial data
    if (p?.type) {
      const np = currentRoom.players.get(socket.id);
      if (np) {
        np.type   = p.type;
        np.atk    = p.atk;
        np.def    = p.def;
        np.maxHp  = p.maxHp;
        np.hp     = p.hp;
        np.pvpMode = p.pvpMode || false;
      }
    }

    socket.to(`floor_${newFloor}`).emit('playerJoined', { id: socket.id, username: authed.username });
    if (p?.type) socket.to(`floor_${newFloor}`).emit('playerChar', { id: socket.id, type: p.type });

    socket.emit('floorChanged', {
      floor: newFloor,
      dungeon: currentRoom.dungeonData,
      enemies: currentRoom.enemySnapshot(),
    });
  });

  // Returns true if attacker and target share a party or clan (PvP immune)
  function _isPvpImmune(attackerId, targetId) {
    const aParty = playerParty.get(attackerId);
    const tParty = playerParty.get(targetId);
    if (aParty && aParty === tParty) return true;
    const aPlayer = currentRoom?.players.get(attackerId);
    const tPlayer = currentRoom?.players.get(targetId);
    if (aPlayer?.clanName && aPlayer.clanName === tPlayer?.clanName) return true;
    return false;
  }

  socket.on('pvpAttack', ({ targetId }) => {
    if (!_atkAllowed()) return;
    if (!currentRoom) return;
    if (_isPvpImmune(socket.id, targetId)) return;
    const result = currentRoom.pvpAttack(socket.id, targetId);
    if (!result) return;
    io.to(targetId).emit('pvpDamage', { dmg: result.dmg });
    socket.emit('pvpHit', { x: result.x, y: result.y, dmg: result.dmg, isCrit: result.isCrit, targetId });
  });

  socket.on('pvpSkillAttack', ({ targetId, multiplier }) => {
    if (!currentRoom) return;
    if (_isPvpImmune(socket.id, targetId)) return;
    const result = currentRoom.pvpSkillAttack(socket.id, targetId, multiplier);
    if (!result) return;
    io.to(targetId).emit('pvpDamage', { dmg: result.dmg });
    socket.emit('pvpHit', { x: result.x, y: result.y, dmg: result.dmg, isCrit: result.isCrit, targetId });
  });

  socket.on('pvpSkillCC', ({ targetId, type, duration }) => {
    if (!currentRoom) return;
    if (_isPvpImmune(socket.id, targetId)) return;
    const attacker = currentRoom.players.get(socket.id);
    if (!attacker || !attacker.pvpMode) return;
    if (currentRoom.isPlayerInSafeZone(socket.id)) return;
    const target = currentRoom.players.get(targetId);
    if (!target || target.hp <= 0) return;
    if (currentRoom.isPlayerInSafeZone(targetId)) return;
    const dur = Math.max(0, Math.min(duration, 6));
    io.to(`floor_${currentFloor}`).emit('pvpPlayerCC', { targetId, type, duration: dur });
  });

  socket.on('respawn', () => {
    if (currentRoom) currentRoom.respawnPlayer(socket.id);
  });

  socket.on('setPvpMode', ({ pvpMode }) => {
    if (currentRoom) currentRoom.setPlayerPvpMode(socket.id, pvpMode);
  });

  socket.on('spawnProj', data => {
    if (!currentRoom) return;
    socket.to(`floor_${currentFloor}`).emit('spawnProj', data);
  });

  socket.on('spawnAoe', data => {
    if (!currentRoom) return;
    socket.to(`floor_${currentFloor}`).emit('spawnAoe', data);
  });

  socket.on('healParty', ({ amount }) => {
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

  socket.on('chat', ({ text }) => {
    if (!authed || !text || typeof text !== 'string') return;
    const now = Date.now();
    if (now - _lastChatAt < 3000) return;
    _lastChatAt = now;
    const msg = text.trim().slice(0, 100);
    if (!msg) return;
    _recordChat(authed.username, msg);
    io.emit('chatMsg', { username: authed.username, text: msg });
  });

  socket.on('saveProgress', ({ stats }) => {
    if (!authed) return;
    // Sanitize the client blob before it becomes the server's source of truth
    // for BM/combat stats and before it's persisted (anti-cheat — see
    // _sanitizeSavedStats). gram/nexum are never taken from here.
    const clean = _sanitizeSavedStats(stats);
    _lastStats = clean;
    authed.bm = calcBM(clean);
    clearTimeout(_saveDebounceTimer);
    _saveDebounceTimer = setTimeout(() => {
      if (!authed) return;
      _persistSavedFields(authed,
        { ...clean, gramBalance: _gramBalanceCache.get(authed.telegramId) ?? _gramBalance, nexumBalance: _nexumBalanceCache.get(authed.telegramId) ?? _nexumBalance },
        { bm: authed.bm });
    }, 3000);
  });

  // ── Party ─────────────────────────────────────────────────────────────────
  socket.on('partyInvite', ({ targetId }) => {
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

  socket.on('partyAccept', ({ fromId }) => {
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

  socket.on('partyDecline', () => { /* no cleanup needed */ });

  socket.on('partyLeave', () => {
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

  socket.on('clanCreate', async ({ name, icon }) => {
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

  socket.on('clanSearch', async ({ query }) => {
    if (!authed) return;
    const q = (query || '').trim().slice(0, 32);
    const filter = q ? { name: { $regex: _escapeRegex(q), $options: 'i' } } : {};
    const clans = await ClanModel.find(filter).sort({ level: -1, xp: -1 }).limit(20).catch(() => []);
    socket.emit('clanSearchResults', clans.map(c => ({
      _id: c._id, name: c.name, icon: c.icon, level: c.level, members: c.members.length,
    })));
  });

  socket.on('clanApply', async ({ clanId }) => {
    if (!authed) return;
    const inClan = await ClanModel.findOne({ 'members.telegramId': authed.telegramId }).catch(() => null);
    if (inClan) return socket.emit('clanError', { msg: 'Вы уже в клане' });
    const clan = await ClanModel.findById(clanId).catch(() => null);
    if (!clan) return socket.emit('clanError', { msg: 'Клан не найден' });
    if (clan.applications.find(a => a.telegramId === authed.telegramId)) return;
    clan.applications.push({ telegramId: authed.telegramId, username: authed.username });
    await clan.save().catch(() => {});
    socket.emit('clanError', { msg: '✓ Заявка отправлена' });
    await _notifyClan(clan);
  });

  socket.on('clanApprove', async ({ telegramId }) => {
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

  socket.on('clanDecline', async ({ telegramId }) => {
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

  socket.on('clanKick', async ({ telegramId }) => {
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

  socket.on('clanLeave', async () => {
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

  socket.on('clanDisband', async () => {
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
  socket.on('getLobbyList', () => {
    const list = [...raidLobbies.values()].map(lb => ({
      id: lb.id, creatorName: lb.creatorName, dungeonId: lb.dungeonId,
      members: [...lb.members.entries()].map(([sid, m]) => ({ id: sid, name: m.name, bm: m.bm, lvl: m.lvl })),
    }));
    socket.emit('lobbyList', { lobbies: list });
  });

  socket.on('createRaidLobby', ({ dungeonId }) => {
    if (!authed) return;
    if (playerLobby.has(socket.id)) _cleanupLobby(socket.id);
    if (playerRaid.has(socket.id)) return socket.emit('lobbyError', { msg: 'Вы уже в рейде' });
    const cp = currentRoom?.players.get(socket.id);
    if (!cp || (cp.lvl || 1) < 3) return socket.emit('lobbyError', { msg: 'Нужен 3 уровень' });
    const bm = _lastStats ? ((_lastStats.lvl || 1) * 50 + (_lastStats.atk || 0) * 5 + (_lastStats.def || 0) * 3) : 0;
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

  socket.on('joinRaidLobby', ({ lobbyId }) => {
    if (!authed) return;
    const lb = raidLobbies.get(lobbyId);
    if (!lb) return socket.emit('lobbyError', { msg: 'Группа не найдена' });
    if (lb.members.size >= 5) return socket.emit('lobbyError', { msg: 'Группа полна (5/5)' });
    if (playerRaid.has(socket.id)) return socket.emit('lobbyError', { msg: 'Вы уже в рейде' });
    if (playerLobby.has(socket.id)) _cleanupLobby(socket.id);
    const cp = currentRoom?.players.get(socket.id);
    const bm = _lastStats ? ((_lastStats.lvl || 1) * 50 + (_lastStats.atk || 0) * 5 + (_lastStats.def || 0) * 3) : 0;
    lb.members.set(socket.id, { name: authed.username, bm, lvl: cp?.lvl || 1 });
    playerLobby.set(socket.id, lobbyId);
    const memberList = [...lb.members.entries()].map(([sid, m]) => ({ id: sid, name: m.name, bm: m.bm, lvl: m.lvl }));
    lb.members.forEach((_, mid) => io.to(mid).emit('lobbyJoined', { lobbyId, isCreator: mid === lb.creatorId, members: memberList }));
    _lobbyBroadcast();
  });

  socket.on('leaveRaidLobby', () => {
    if (!playerLobby.has(socket.id)) return;
    _cleanupLobby(socket.id);
    socket.emit('lobbyLeft', {});
    _lobbyBroadcast();
  });

  socket.on('startRaidLobby', () => {
    if (!authed) return;
    const lobbyId = playerLobby.get(socket.id);
    const lb = raidLobbies.get(lobbyId);
    if (!lb || lb.creatorId !== socket.id) return socket.emit('lobbyError', { msg: 'Вы не создатель группы' });
    if (lb.members.size < 2) return socket.emit('lobbyError', { msg: 'Нужно минимум 2 игрока' });
    const memberIds = [...lb.members.keys()];
    for (const mid of memberIds) {
      if (playerRaid.has(mid)) return socket.emit('lobbyError', { msg: 'Кто-то уже в рейде' });
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
      const mfl = playerFloorMap.get(mid);
      const mRoom = mfl !== undefined ? floorRooms.get(mfl) : null;
      const mp = mRoom?.players.get(mid);
      if (mp) {
        mp._inRaid = true;
        raidRoom.addPlayer(mid, { maxHp: mp.maxHp, atk: mp.atk, def: mp.def, type: mp.type, username: mp.username || lb.members.get(mid)?.name || '' });
      } else {
        raidRoom.addPlayer(mid, { maxHp: 100, atk: 10, def: 0, type: 'warrior', username: lb.members.get(mid)?.name || '' });
      }
      io.to(mid).emit('raidStart', { raidId, dungeon: raidRoom.dungeonData });
    }
    raidRoom.start();
    _lobbyBroadcast();
  });

  // ── Raid game ─────────────────────────────────────────────────────────────
  socket.on('raidMove', ({ x, y, hp }) => {
    const rId = playerRaid.get(socket.id);
    const rr  = rId ? raidRooms.get(rId) : null;
    if (rr) rr.updatePlayerPos(socket.id, x, y, hp);
  });

  socket.on('raidAttack', ({ enemyId }) => {
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
      rr.memberIds.forEach(mid => io.to(mid).emit('raidEnemyHurt', {
        id: enemyId, hp: result.hp, dmg: result.dmg,
      }));
    }
  });

  socket.on('leaveRaid', () => { _cleanupRaid(socket.id); });

  // ── Special Quests ────────────────────────────────────────────────────────
  socket.on('completeSpecialQuest', async ({ questId } = {}) => {
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
        ? ((_nexumBalanceCache.get(authed.telegramId) ?? _nexumBalance) + quest.reward.nexum)
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
        _nexumBalance = _newNexum;
        _nexumBalanceCache.set(authed.telegramId, _newNexum);
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

  socket.on('disconnect', () => {
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
