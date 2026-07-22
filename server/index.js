const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const PlayerModel = require('./models/Player');
const ClanModel   = require('./models/Clan');
const GramTxModel = require('./models/GramTx');
const MarketListingModel = require('./models/MarketListing');
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
const _TG_TOKEN    = process.env.TG_BOT_TOKEN    || '';
const TG_ADMIN_ID  = process.env.TG_ADMIN_ID     || '';   // admin's Telegram chat ID
const GRAM_WALLET  = process.env.GRAM_WALLET      || '';   // TON wallet address for deposits
let _tgBotUsername = process.env.TG_BOT_USERNAME  || '';

// In-memory gram balance cache: telegramId → balance (survives autosave overwrites)
const _gramBalanceCache = new Map();

// Single-session enforcement: telegramId → socket.id of the active session
const activeSessions = new Map();

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
      if (!player) {
        isNewPlayer = true;
        player = await PlayerModel.create({ telegramId: fromId, username, referredBy: referrerId });
      } else if (!player.referredBy) {
        player.referredBy = referrerId;
        await player.save();
      }

      // Get referrer info for notifications
      const referrer = await PlayerModel.findOne({ telegramId: referrerId }, 'username telegramId').lean();
      referrerUsername = referrer?.username || null;

      // Notify referrer via socket (if online) and via Telegram bot
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
  transports: ['websocket'],   // force WebSocket only — no polling overhead
  pingTimeout: 90000,
  pingInterval: 30000,
});

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err));

// Images: cache 30 days — sprites never change between deploys
app.use('/images', express.static(path.join(__dirname, '..', 'images'), { maxAge: '30d', immutable: true }));

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
const MAX_FLOOR = 20;
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
function _persistSavedFields(authed, fields, extra) {
  if (!authed) return;
  const set = {};
  Object.keys(fields).forEach(k => { if (fields[k] !== undefined) set[`savedData.${k}`] = fields[k]; });
  if (extra) Object.keys(extra).forEach(k => { set[k] = extra[k]; });
  PlayerModel.findByIdAndUpdate(authed._id, { $set: set }).catch(() => {});
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
  playerFloorMap.set(socket.id, currentFloor);

  const NEXUM_DROP_CHANCE = [0, 0.005, 0.01, 0.02, 0.03, 0.05];

  function _startAutosave() {
    if (_autoSaveInterval) clearInterval(_autoSaveInterval);
    _autoSaveInterval = setInterval(() => {
      if (!authed || !_lastStats) return;
      const saveData = { ..._lastStats, floor: currentFloor, gramBalance: _gramBalanceCache.get(authed.telegramId) ?? _gramBalance, nexumBalance: _nexumBalance };
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
        if (_prevSocket) { _prevSocket.emit('kicked', { reason: 'Вы вошли с другого устройства' }); _prevSocket.disconnect(true); }
      }
      activeSessions.set(telegramId, socket.id);
      let doc = await PlayerModel.findOne({ telegramId });
      if (!doc) doc = await PlayerModel.create({ telegramId, username });
      authed = doc;
      socket.data.username = doc.username;
      socket.data.telegramId = telegramId;
      if (doc.savedData) _lastStats = doc.savedData;
      _gramBalance = doc.savedData?.gramBalance || 0;
      _nexumBalance = doc.savedData?.nexumBalance || 0;
      _gramBalanceCache.set(telegramId, _gramBalance);
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
        if (_prevSocket2) { _prevSocket2.emit('kicked', { reason: 'Вы вошли с другого устройства' }); _prevSocket2.disconnect(true); }
      }
      activeSessions.set(telegramId, socket.id);
      let doc = await PlayerModel.findOne({ telegramId });
      if (!doc) doc = await PlayerModel.create({ telegramId, username });
      authed = doc;
      socket.data.username = doc.username;
      socket.data.telegramId = telegramId;
      if (doc.savedData) _lastStats = doc.savedData;
      _gramBalance = doc.savedData?.gramBalance || 0;
      _nexumBalance = doc.savedData?.nexumBalance || 0;
      _gramBalanceCache.set(telegramId, _gramBalance);
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

      // Buff potions into potionBag
      const potionBag = { pt1: 0, pt2: 0, ...(saved.potionBag || {}) };
      _VIP_BP.forEach(bp => { potionBag[bp.id] = (potionBag[bp.id] || 0) + pkg.potions; });
      saved.potionBag = potionBag;

      // Armor set
      if (pkg.armor) {
        (_SHOP_ARMOR_SETS[pkg.armor] || []).forEach(id => {
          const base = ITEM_DEF.find(d => d.id === id);
          if (base) inv.push({ ...base, enhance: 8 });
        });
      }

      // Class weapon
      if (pkg.weapon) {
        const wepId = wepMap[pkg.weapon];
        const base = ITEM_DEF.find(d => d.id === wepId);
        if (base) inv.push({ ...base, enhance: 8 });
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
        _lastStats.potionBag = potionBag;
        if (pkg.bonusSP > 0) _lastStats.bonusSP = saved.bonusSP;
      }
      socket.data.vipLevel = _vipLvl;

      socket.emit('gramShopResult', {
        pkgId,
        newBalance:  _gramBalance,
        newGold:     saved.gold,
        newPotionBag: potionBag,
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
        const players = await PlayerModel.find({ bm: { $gt: 0 } }, 'username bm savedData')
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
    if (savedStats) _lastStats = savedStats;
    if (!currentRoom) {
      const savedFloor = (savedStats?.floor > 1) ? Math.max(1, Math.min(20, savedStats.floor)) : 1;
      currentFloor = savedFloor;
      currentRoom = getRoom(currentFloor);
      playerFloorMap.set(socket.id, currentFloor);
      socket.join(`floor_${currentFloor}`);
      currentRoom.addPlayer(socket.id, authed.username, _myClanName, _myClanIcon);
      socket.to(`floor_${currentFloor}`).emit('playerJoined', { id: socket.id, username: authed.username });
      if (globalChatHistory.length) socket.emit('chatHistory', globalChatHistory);
    }
    currentRoom.setPlayerChar(socket.id, type, savedStats || null);
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
    const newFloor = Math.max(1, Math.min(20, floor));
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

  socket.on('pvpAttack', ({ targetId }) => {
    if (!currentRoom) return;
    const result = currentRoom.pvpAttack(socket.id, targetId);
    if (!result) return;
    io.to(targetId).emit('pvpDamage', { dmg: result.dmg });
    socket.emit('pvpHit', { x: result.x, y: result.y, dmg: result.dmg, isCrit: result.isCrit, targetId });
  });

  socket.on('pvpSkillAttack', ({ targetId, multiplier }) => {
    if (!currentRoom) return;
    const result = currentRoom.pvpSkillAttack(socket.id, targetId, multiplier);
    if (!result) return;
    io.to(targetId).emit('pvpDamage', { dmg: result.dmg });
    socket.emit('pvpHit', { x: result.x, y: result.y, dmg: result.dmg, isCrit: result.isCrit, targetId });
  });

  socket.on('pvpSkillCC', ({ targetId, type, duration }) => {
    if (!currentRoom) return;
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
    const msg = text.trim().slice(0, 100);
    if (!msg) return;
    _recordChat(authed.username, msg);
    io.emit('chatMsg', { username: authed.username, text: msg });
  });

  socket.on('saveProgress', ({ stats }) => {
    if (authed) {
      _lastStats = stats;
      const bm = calcBM(stats);
      authed.bm = bm;
      _persistSavedFields(authed,
        { ...stats, gramBalance: _gramBalanceCache.get(authed.telegramId) ?? _gramBalance, nexumBalance: _nexumBalance },
        { bm });
    }
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
    const q = (query || '').trim();
    const filter = q ? { name: { $regex: q, $options: 'i' } } : {};
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

  socket.on('disconnect', () => {
    if (_autoSaveInterval) { clearInterval(_autoSaveInterval); _autoSaveInterval = null; }
    if (authed && activeSessions.get(authed.telegramId) === socket.id)
      activeSessions.delete(authed.telegramId);
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
  _pollTg(); // start Telegram callback polling
});
