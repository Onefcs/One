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
const { NC_FACING } = require('../shared/netcodec');
const mongoose = require('mongoose');
const PlayerModel       = require('./models/Player');
const ClanModel         = require('./models/Clan');
const GramTxModel       = require('./models/GramTx');
const MarketListingModel= require('./models/MarketListing');
const SpecialQuestModel = require('./models/SpecialQuest');
const PlayerLogModel    = require('./models/PlayerLog');
const PvpHistoryModel   = require('./models/PvpHistory');
const ChatMessageModel  = require('./models/ChatMessage');
const BossStateModel    = require('./models/BossState');
const Room = require('./game/Room');
const {
  VIP_THRESHOLDS, VIP_BONUSES,
  ITEM_DEF, CRAFT_MATS, BOX_DEF, ENHANCE_MAX, ENHANCEABLE_SLOTS, enhanceBonus, isStackableItem,
  ENEMY_DEF, CHAR_DEF,
  PET_CRAFT_RECIPES, GEAR_CRAFT_RECIPES, GEAR_TIER_CRAFT_RECIPES, MAT_UPGRADE_RECIPES,
  UNIQUE_SHARDS, UNIQUE_WEAPONS, UNIQUE_CRAFT_RECIPES, UNIQUE_SHARD_COST,
  CLAN_STORAGE_MIN_DAYS, CLAN_STORAGE_UNLOCK_GOLD,
  UNIQUE_SHARD_MIN_LEVEL, UNIQUE_SHARD_CHANCE, UNIQUE_SHARD_MAX_QTY,
  CLASS_GEAR_SALVAGE_RECIPES, CLAN_MAX_MEMBERS, CLAN_DESC_MAX_CHARS, UPGRADE_RESET_COST,
  armIndexForLevel, armLocalLevel,
  BOSS_ITEM_DROP_MULT, itemDropChanceAtLevel, itemRarityForLevel,
  roomDropMult, roomKeyChance, roomEnchantStoneChance,
  DEATH_BATTLE_DAYS_MSK, DEATH_BATTLE_HOURS_MSK, DEATH_BATTLE_REG_MS, DEATH_BATTLE_FREEZE_MS,
  DEATH_BATTLE_MIN_PLAYERS, DEATH_BATTLE_MAX_MS, DEATH_BATTLE_GRAM_REWARD, deathBattleRewards,
  WORLD_BOSS_DAYS_MSK, WORLD_BOSS_HOURS_MSK, EVENT_NOTIFY_BEFORE_MS, nextEventStartAt,
  RACE10_DAYS_MSK, RACE10_HOURS_MSK,
  ARENA3_DAYS_MSK, ARENA3_HOURS_MSK, ARENA3_WINDOW_MS,
  GRAM_MIN_WITHDRAW,
  clanAtkBonusPct,
  FEAR_MAX_WAVE, QUEST_DEF,
  SEASON_END_AT, SEASON_MIN_LVL, SEASON_MAX_LVL, SEASON_QUEST_KILLS, SEASON_QUEST_POINTS,
  SEASON_SPECIES, SEASON_BURN_POINTS, SEASON_PRIZES, seasonActive,
  SEASON_EVENT_POINTS, SEASON_EVENT_TASKS, SEASON_SPECIES_LEVELS, SEASON_ENHANCE_POINTS,
  SEASON_WIN_POINTS,
  SEASON_TIERS, SEASON_TIER_DEFAULT, SEASON_TIER_SPECIES_LEVELS, seasonTier,
  SEASON_REF_POINTS, SEASON_REF_LEVEL,
} = require('../shared/definitions');

// ── Market (player-to-player item trading for GRAM) ────────────────────────
const MARKET_MIN_PRICE   = 0.1;
const MARKET_MAX_PRICE   = 1000;
const MARKET_FEE_PCT     = 0.10;   // burned — not paid out to anyone
const MARKET_MAX_ACTIVE  = 20;     // active listings per seller
const MARKET_MAX_QTY     = 9999;   // sanity bound on a stackable listing's quantity
const MARKET_LIST_COOLDOWN_MS = 3000;
// Per-category floors, below the generic MARKET_MIN_PRICE above — these items
// are cheap/plentiful enough that the flat 0.1 GRAM floor overpriced them
// relative to how easy they are to farm. Keys/recipes/stones are PER UNIT
// (the listing's price covers its whole stack, see _canonicalMarketItem's
// qty); rare gear is a flat per-listing floor since it isn't stackable.
const MARKET_MIN_PRICE_KEY         = 0.01; // key_uncommon / key_rare, per key
const MARKET_MIN_PRICE_RECIPE      = 0.01; // slot:'recipe' (recu/recr/rece/recl), per scroll
const MARKET_MIN_PRICE_STONE       = 0.40; // norm_stone, per stone
const MARKET_MIN_PRICE_BLESS_STONE = 1.5;  // bless_stone, per stone
const MARKET_MIN_PRICE_BOX         = 2;    // box_uncommon / box_rare (BOX_DEF), per box
const MARKET_MIN_PRICE_RARE_GEAR   = 5;    // rarity:'rare' armor/weapon, flat
const MARKET_MIN_PRICE_UNCOMMON_GEAR = 0.3; // rarity:'uncommon' armor/weapon, flat
const MARKET_MIN_PRICE_CLOAK_ARTIFACT = 2; // slot:'cloak'/'artifact', flat, any rarity below 'rare'

// The floor a listing's price has to clear — item-specific where one of the
// categories above applies (scaled by qty for the stackable ones), the
// generic MARKET_MIN_PRICE otherwise. Takes the already-canonicalized item
// (see _canonicalMarketItem) so id/slot/rarity/qty are all trustworthy.
function _marketMinPrice(item) {
  const qty = item.qty || 1;
  if (item.id === 'norm_stone') return MARKET_MIN_PRICE_STONE * qty;
  if (item.id === 'bless_stone') return MARKET_MIN_PRICE_BLESS_STONE * qty;
  if (item.id && item.id.startsWith('key_')) return MARKET_MIN_PRICE_KEY * qty;
  if (item.slot === 'recipe') return MARKET_MIN_PRICE_RECIPE * qty;
  if (item.slot === 'box') return MARKET_MIN_PRICE_BOX * qty;
  // Cloak/artifact have their own flat floor at every rarity below 'rare'
  // (there's no 'rare' tier for either), so this has to win over the
  // rarity-based gear checks below rather than the other way around —
  // otherwise an uncommon cloak (cloak_u_<class>) would fall through to the
  // cheaper uncommon-gear floor instead.
  if (item.slot === 'cloak' || item.slot === 'artifact') return MARKET_MIN_PRICE_CLOAK_ARTIFACT;
  if (item.rarity === 'rare' && ENHANCEABLE_SLOTS.has(item.slot) && item.slot !== 'pet') return MARKET_MIN_PRICE_RARE_GEAR;
  if (item.rarity === 'uncommon' && ENHANCEABLE_SLOTS.has(item.slot) && item.slot !== 'pet') return MARKET_MIN_PRICE_UNCOMMON_GEAR;
  return MARKET_MIN_PRICE;
}
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
  const base = ITEM_DEF.find(d => d.id === id) || CRAFT_MATS.find(d => d.id === id) || BOX_DEF.find(d => d.id === id);
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

// ── Mob kill loot roll ──────────────────────────────────────────────────────
// Mirrors applyLootToInventory (js/combat.js) exactly — recipe/equipment/
// room-key/enchant-stone/skill-book/passive-book drops on a regular kill.
// This used to be entirely client-rolled and only ever reached the server via
// the next saveProgress blob (which _canonSavedItem trusts for any valid id+
// enhance+qty) — the single biggest "items appearing out of nowhere" vector,
// since it fires on every kill in the game. Mutates `inv` in place via
// _invAdd; the caller ('attack'/'skillAttack' below) decides who this runs
// for (loot-winner arbitration among a party) and reports the result back.
function _rollMobLoot(inv, eid, rlvl) {
  const eDef = ENEMY_DEF.find(e => e.eid === eid);
  const eType = eDef ? eDef.eType : null;
  const granted = [];

  function addMat(id, qty) {
    const mat = CRAFT_MATS.find(m => m.id === id);
    if (mat && _invAdd(inv, { ...mat, qty })) granted.push({ id: mat.id, name: mat.name, rarity: mat.rarity, qty });
  }

  // Same drop multiplier as the client used: corridor arm × room-level growth.
  const _localLvl = armLocalLevel(rlvl);
  const _dropMult = armIndexForLevel(rlvl) * roomDropMult(_localLvl);

  // Recipe drop (all non-boss enemies)
  if (eType && eType !== 'boss') {
    const r = Math.random();
    if      (r < 0.00001 * _dropMult) addMat('recl', 1);
    else if (r < 0.00021 * _dropMult) addMat('rece', 1);
    else if (r < 0.00071 * _dropMult) addMat('recr', 1);
    else if (r < 0.00171 * _dropMult) addMat('recu', 1);
  }

  // Equipment drop — no cloak/artifact (craft-only), weapons unrestricted by
  // class (same as js/combat.js: any class's weapon can drop for anyone).
  const _itemChance = Math.min(100, itemDropChanceAtLevel(rlvl) * (eType === 'boss' ? BOSS_ITEM_DROP_MULT : 1));
  if (Math.random() * 100 < _itemChance) {
    const rarity = itemRarityForLevel(rlvl);
    const _gearSlots = ['weapon', 'helmet', 'body', 'gloves', 'boots', 'ring', 'belt'];
    // !d.noDrop excludes the unique weapons: they are epic/legendary `weapon`
    // entries like any other, so without it they would simply start dropping.
    const candidates = ITEM_DEF.filter(d => d.rarity === rarity && !d.noDrop && _gearSlots.includes(d.slot));
    if (candidates.length) {
      const it = candidates[Math.floor(Math.random() * candidates.length)];
      if (_invAdd(inv, { ...it })) granted.push({ id: it.id, name: it.name, rarity: it.rarity, qty: 1 });
    }
  }

  // Room-level key drops (forge box-crafting)
  if (Math.random() < roomKeyChance(_localLvl, 'uncommon')) addMat('key_uncommon', 1);
  if (Math.random() < roomKeyChance(_localLvl, 'rare'))     addMat('key_rare', 1);

  // Room-level enchant-stone drop
  if (Math.random() < roomEnchantStoneChance(_localLvl)) addMat('norm_stone', 1);

  // Осколки для уникального оружия. Every kind rolls on its own, so one kill
  // can yield several different shards but never more than
  // UNIQUE_SHARD_MAX_QTY of the same one. Deliberately flat: no arm/room
  // multiplier and no boss bonus — the only gate is the monster's level, so
  // the drop reads the same everywhere past it and cannot be farmed faster by
  // finding a favourable room.
  //
  // Math.random() has ~2^-53 granularity, so a chance this small is still
  // rolled honestly rather than collapsing to never/always.
  if (rlvl >= UNIQUE_SHARD_MIN_LEVEL) {
    for (const sh of UNIQUE_SHARDS) {
      if (Math.random() < UNIQUE_SHARD_CHANCE) {
        addMat(sh.id, 1 + Math.floor(Math.random() * UNIQUE_SHARD_MAX_QTY));
      }
    }
  }

  // Skill books — any class's book can drop for anyone (see js/combat.js).
  const _allBooks = CRAFT_MATS.filter(m => m.skillKey);
  if (_allBooks.length) {
    if (eType === 'boss') {
      if (Math.random() < 0.001) addMat(_allBooks[Math.floor(Math.random() * _allBooks.length)].id, 2);
    } else if (Math.random() < 0.00002 * Math.min(_dropMult, 3)) {
      addMat(_allBooks[Math.floor(Math.random() * _allBooks.length)].id, 1);
    }
  }

  // Passive skill books — own independent roll/pool, same odds as above.
  const _allPassiveBooks = CRAFT_MATS.filter(m => m.passiveId);
  if (_allPassiveBooks.length) {
    if (eType === 'boss') {
      if (Math.random() < 0.001) addMat(_allPassiveBooks[Math.floor(Math.random() * _allPassiveBooks.length)].id, 2);
    } else if (Math.random() < 0.00002 * Math.min(_dropMult, 3)) {
      addMat(_allPassiveBooks[Math.floor(Math.random() * _allPassiveBooks.length)].id, 1);
    }
  }

  return granted;
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

// ── VIP item data (server-side subset of js/definitions.js) ──────────────────
const _VIP_WEAPONS = {
  deathknight: {
    uncommon:  { id:'sw2', name:'Стальной меч',   slot:'weapon', img:'/images/wep/uk.png', atk:14, critChance:0.03,      rarity:'uncommon' },
    rare:      { id:'sw3', name:'Меч дракона',    slot:'weapon', img:'/images/wep/rk.png', atk:23, critChance:0.05,       rarity:'rare'     },
    epic:      { id:'sw4', name:'Меч теней',      slot:'weapon', img:'/images/wep/ek.png', atk:44, critChance:0.10,       rarity:'epic'     },
    legendary: { id:'sw5', name:'Меч героя',      slot:'weapon', img:'/images/wep/lk.png', atk:65, critChance:0.25,       rarity:'legendary'},
  },
  lev: {
    uncommon:  { id:'tw2', name:'Стальной топор', slot:'weapon', img:'/images/wep/ut.png', atk:15, def:6,                rarity:'uncommon' },
    rare:      { id:'tw3', name:'Топор дракона',  slot:'weapon', img:'/images/wep/rt.png', atk:23, def:10,               rarity:'rare'     },
    epic:      { id:'tw4', name:'Топор теней',    slot:'weapon', img:'/images/wep/et.png', atk:44, def:16,               rarity:'epic'     },
    legendary: { id:'tw5', name:'Топор героя',    slot:'weapon', img:'/images/wep/lt.png', atk:65, def:24,               rarity:'legendary'},
  },
  ranger: {
    uncommon:  { id:'bw2', name:'Серебряный лук', slot:'weapon', img:'/images/wep/ub.png', atk:18, atkSpeed:0.03,         rarity:'uncommon' },
    rare:      { id:'bw3', name:'Лук охотника',   slot:'weapon', img:'/images/wep/rb.png', atk:28, atkSpeed:0.05,         rarity:'rare'     },
    epic:      { id:'bw4', name:'Лунный лук',     slot:'weapon', img:'/images/wep/eb.png', atk:60, atkSpeed:0.10,         rarity:'epic'     },
    legendary: { id:'bw5', name:'Лук героя',      slot:'weapon', img:'/images/wep/lb.png', atk:100,atkSpeed:0.15,critChance:0.10,rarity:'legendary'},
  },
};
_VIP_WEAPONS.mage = {
  uncommon:  { id:'st2', name:'Посох бойца',    slot:'weapon', img:'/images/wep/us.png', atk:17, hpPct:0.03,  rarity:'uncommon' },
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
  { id:'pkg30',  gram:30,  gold:20000,  potions:30,  armor:'uncommon', weapon:'uncommon', bonusSP:2,  skillBooks:{ each:1 },  enhance:5, nexum:500 },
  { id:'pkg50',  gram:100, gold:50000,  potions:50,  armor:'rare',     weapon:'rare',     bonusSP:5,  skillBooks:{ each:4 },  boxes:{ box_rare:10 }, enhance:0, nexum:4000 },
  { id:'pkg100', gram:220, gold:100000, potions:100, armor:'rare',     weapon:'rare',     bonusSP:10, skillBooks:{ each:12 }, boxes:{ box_rare:30 }, enhance:8, nexum:10000 },
];
// ── Сезонные паки ────────────────────────────────────────────────────────────
// Enhance stones only, priced in GRAM. Kept in the same shape as the regular
// packages (and bought through the same handler) so the purchase path — the
// atomic spend, the inventory-space check, the single commit — is shared
// rather than duplicated. `stones` maps a CRAFT_MATS id to a quantity; both
// stones stack, so a pack needs at most one new slot per kind.
const _SEASON_SHOP_PKGS = [
  { id:'sp5',  gram:5,  season:true, stones:{ norm_stone:10 } },
  { id:'sp10', gram:10, season:true, stones:{ norm_stone:10, bless_stone:2  } },
  { id:'sp20', gram:20, season:true, stones:{ norm_stone:15, bless_stone:5  } },
  { id:'sp50', gram:50, season:true, stones:{ norm_stone:35, bless_stone:15 } },
  // Liberty + a full set of buff potions. `potions: N` grants N of EVERY buff
  // potion (see _VIP_BP and the purchase handler), which is what "N банок
  // бафов всех" means — not N split across them.
  { id:'sl10', gram:10, season:true, nexum:1000, potions:10 },
  { id:'sl20', gram:20, season:true, nexum:2200, potions:20 },
  { id:'sl50', gram:50, season:true, nexum:6000, potions:60 },
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
// How many NEW inventory slots a package needs, given what the player already
// holds. Mirrors exactly what gramShopBuy grants below — stackables that merge
// into an existing entry cost nothing, everything else is one slot per item.
// Kept next to the package tables so the two can't drift apart.
function _shopNewSlots(pkg, inv, charClass) {
  const has = id => inv.some(i => i && i.id === id);
  const pending = new Set();          // ids this purchase will itself create
  let slots = 0;
  const need = (id, stackable) => {
    if (stackable) {
      if (has(id) || pending.has(id)) return;
      pending.add(id);
    }
    slots++;
  };

  if (pkg.potions > 0) _VIP_BP.forEach(bp => need(bp.id, true));
  if (pkg.armor) (_SHOP_ARMOR_SETS[pkg.armor] || []).forEach(() => slots++);
  if (pkg.weapon) {
    const wepMap = _SHOP_CLASS_WEAPONS[charClass] || _SHOP_CLASS_WEAPONS.lev;
    if (wepMap[pkg.weapon]) slots++;
  }
  if (pkg.skillBooks) {
    const classBooks = CRAFT_MATS.filter(m => m.forClass === charClass && m.skillKey);
    if (pkg.skillBooks.each) classBooks.forEach(bk => need(bk.id, true));
    // `random` picks N books independently, so worst case it touches every one
    else if (pkg.skillBooks.random) classBooks.forEach(bk => need(bk.id, true));
  }
  if (pkg.boxes) Object.keys(pkg.boxes).forEach(boxId => need(boxId, true));
  if (pkg.stones) Object.keys(pkg.stones).forEach(sid => need(sid, true));
  return slots;
}

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

// Everything below sends with parse_mode:'HTML', and several of the values
// interpolated into those messages come from the player — the deposit memo and
// the withdrawal address are typed straight into the client, and a display
// name falls back to Telegram's first_name. Unescaped, a player could close a
// tag and write their own lines into the message the admin reads before
// pressing ✅ — a different amount, a fake "already verified" note — or simply
// break the markup so Telegram rejects the send and the request never appears.
function _tgEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
  setTimeout(_pollTg, 500);
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
const _USERNAME_MAX_CHARS = 32;
const _USERNAME_MAX_BYTES = 200;
function _sanitizeName(raw) {
  let s = String(raw == null ? '' : raw)
    // Control characters, markup delimiters and quote marks — everything
    // that could either spoof a name visually or break out of an HTML
    // context somewhere downstream.
    .replace(/[\u0000-\u001f\u007f<>&"'`\\]/g, '')
    .trim()
    .slice(0, _USERNAME_MAX_CHARS);
  while (Buffer.byteLength(s, 'utf8') > _USERNAME_MAX_BYTES) s = s.slice(0, -1);
  return s;
}
// Same cleaning, with the "nothing usable left" fallback the login paths need.
// Clan names use _sanitizeName directly instead, so that a clan legitimately
// called "tg_something" isn't mistaken for the fallback.
function _safeUsername(raw, telegramId) {
  return _sanitizeName(raw) || `tg_${telegramId}`;
}
// Same character-stripping as _sanitizeName, but for the clan description
// (CLAN_DESC_MAX_CHARS, well past _sanitizeName's 32-char username cap)
// rather than a display name.
function _sanitizeClanDesc(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f<>&"'`\\]/g, '')
    .trim()
    .slice(0, CLAN_DESC_MAX_CHARS);
}

// Login Widget verification (browser button)
function verifyTelegramAuth(data) {
  const { hash, ...rest } = data;
  if (!hash) return false;
  // No token configured means no signature can be trusted: the HMAC below
  // would be computed with an empty key, which anyone can reproduce, so an
  // unconfigured deployment would accept a forged login for ANY telegramId.
  // Fail closed instead.
  if (!_TG_TOKEN) return false;
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
    // Fail closed with no token — see the matching guard in verifyTelegramAuth:
    // an HMAC keyed on the empty string is one anybody can compute, so a
    // deployment that forgot TG_BOT_TOKEN would accept a forged login for any
    // account rather than refusing every login.
    if (!_TG_TOKEN) return null;
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

// Without a token there is no bot to ask, so the call can only ever 404 —
// skipping it keeps a tokenless run (local dev) off the network entirely.
if (!_tgBotUsername && _TG_TOKEN) {
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
// Compressed once, here, instead of by the compression() middleware on every
// request. The bundle is ~1.07MB of text (301KB gzipped) and never changes
// while the process lives, so re-deflating it per client was pure repeated
// work — ~30-50ms of CPU each, and after a redeploy every player online comes
// back for it at the same time.
const jsBundleGz = zlib.gzipSync(jsBundle, { level: 9 });

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

mongoose.connect(process.env.MONGODB_URI, {
  maxPoolSize: 10,
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
  // One entry per IP that ever failed a login, kept forever, is a slow leak
  // that a spray across many source addresses turns into a fast one. Drop
  // entries that are neither locked nor recently active whenever the map grows
  // past a sane size.
  if (_loginFails.size > 5000) {
    const now = Date.now();
    _loginFails.forEach((v, k) => { if (v.lockedUntil <= now && v.n === 0) _loginFails.delete(k); });
  }
}
// Constant-time string compare that never throws on length mismatch.
function _safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) { crypto.timingSafeEqual(ba, ba); return false; }
  return crypto.timingSafeEqual(ba, bb);
}

// ── Admin REST API ─────────────────────────────────────────────────────────────
// Blanket per-IP ceiling over every /admin route. The login endpoint has its
// own (much stricter) brute-force lock; this covers the rest, where several
// endpoints run unindexed scans and aggregations — a leaked or brute-forced
// token shouldn't also be a way to flatten the database. Registered before the
// routes below so it actually sees them.
const _ADMIN_RL_WINDOW_MS = 60000;
const _ADMIN_RL_MAX = 240;
const _adminHits = new Map(); // ip → { n, resetAt }
app.use('/admin', (req, res, next) => {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const e = _adminHits.get(ip);
  if (!e || now > e.resetAt) {
    _adminHits.set(ip, { n: 1, resetAt: now + _ADMIN_RL_WINDOW_MS });
    if (_adminHits.size > 5000) {
      _adminHits.forEach((v, k) => { if (now > v.resetAt) _adminHits.delete(k); });
    }
    return next();
  }
  if (++e.n > _ADMIN_RL_MAX) return res.status(429).json({ error: 'Слишком много запросов' });
  next();
});

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

// Top referrers — ranked by how many accounts list them in `referredBy`,
// same 5%-of-confirmed-deposits bonus math as the player-facing 'getReferrals'
// handler above, just summed across every referral instead of one player's own.
app.get('/admin/top-referrals', adminAuth, async (req, res) => {
  try {
    const rows = await PlayerModel.aggregate([
      { $match: { referredBy: { $ne: null } } },
      { $group: { _id: '$referredBy', count: { $sum: 1 }, referredIds: { $push: '$telegramId' } } },
      { $sort: { count: -1 } },
      { $limit: 50 },
    ]);
    if (!rows.length) return res.json({ referrers: [] });

    const referrers = await PlayerModel.find({ telegramId: { $in: rows.map(r => r._id) } }, 'username telegramId').lean();
    const nameByTid = {};
    referrers.forEach(r => { nameByTid[r.telegramId] = r.username; });

    const deposits = await GramTxModel.find({
      telegramId: { $in: rows.flatMap(r => r.referredIds) }, type: 'deposit', status: 'confirmed',
    }, 'telegramId amount').lean();
    const depositSumByTid = {};
    deposits.forEach(d => { depositSumByTid[d.telegramId] = (depositSumByTid[d.telegramId] || 0) + d.amount; });

    res.json({
      referrers: rows.map(r => ({
        telegramId: r._id,
        username: nameByTid[r._id] || r._id,
        count: r.count,
        bonusEarned: Math.round(r.referredIds.reduce((s, tid) => s + (depositSumByTid[tid] || 0), 0) * 0.05 * 100) / 100,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/player/:tid', adminAuth, async (req, res) => {
  try {
    const p = await PlayerModel.findOne({ telegramId: req.params.tid }).lean();
    if (!p) return res.status(404).json({ error: 'Not found' });
    // Season rows come back as their own list. Folding them into `logs` would
    // hide them again the moment a player has 100 newer ordinary rows, which
    // after any real farming session is always.
    const [logs, seasonLogs, referrer] = await Promise.all([
      PlayerLogModel.find({ telegramId: req.params.tid }).sort({ at: -1 }).limit(LOG_KEEP_PER_PLAYER).lean(),
      PlayerLogModel.find({ telegramId: req.params.tid, event: { $in: LOG_SEASON_EVENTS } })
        .sort({ at: -1 }).limit(LOG_KEEP_SEASON_PER_PLAYER).lean(),
      p.referredBy ? PlayerModel.findOne({ telegramId: p.referredBy }, 'username').lean() : null,
    ]);
    res.json({
      player: p, logs, seasonLogs,
      seasonPoints: Math.max(0, Math.floor(Number(p.savedData?.seasonPoints) || 0)),
      referrerUsername: referrer?.username || null,
    });
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

// Wipes today's Страх (Fear) attempt counter for one player, back to the
// full daily cap — same "unset the tracked record" trick _lockDailyAttempt's
// own shape relies on: _dailyAttemptsLeft treats a missing/stale record as
// "nothing spent today" (see server/index.js's _dailyAttemptsLeft), so this
// doesn't need to know the current count at all, just clear it.
app.post('/admin/player/:tid/reset-fear-attempts', adminAuth, async (req, res) => {
  try {
    const p = await PlayerModel.findOneAndUpdate(
      { telegramId: req.params.tid },
      { $unset: { 'savedData.fearAttempts': '' } },
      { new: true },
    );
    if (!p) return res.status(404).json({ error: 'Not found' });
    logPlayer(p.telegramId, p.username, 'admin_reset_fear_attempts', { by: 'admin' });
    // Live-refresh the Events panel for anyone with it open right now —
    // otherwise they'd see the old attemptsLeft until their next fearSync
    // (opening/reopening the panel).
    const target = _socketForTelegramId(req.params.tid);
    if (target) {
      target.emit('fearState', {
        maxAttempts: FEAR_ATTEMPTS, maxWave: FEAR_MAX_WAVE, minLevel: FEAR_MIN_LEVEL,
        attemptsLeft: FEAR_ATTEMPTS, inRun: _fear.has(target.id), wave: _fear.get(target.id)?.wave || 0,
      });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/player/:tid/give', adminAuth, async (req, res) => {
  try {
    // Validated before anything is added: an unparseable figure used to reach
    // Mongo as NaN, and a savedData.gold of NaN breaks the client's whole
    // money UI with no obvious cause.
    const _amt = v => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const gold  = _amt((req.body || {}).gold);
    const nexum = _amt((req.body || {}).nexum);
    const gram  = _amt((req.body || {}).gram);
    if (!gold && !nexum && !gram) return res.status(400).json({ error: 'Нечего выдавать' });
    const p = await PlayerModel.findOne({ telegramId: req.params.tid });
    if (!p) return res.status(404).json({ error: 'Not found' });
    const saved = p.savedData || {};
    // Gold, unlike gram/nexum, has no server-side live cache — it rides the
    // client's save blob. Writing it straight to the DB for a player who is
    // online meant their next autosave (up to 60s later) overwrote it with the
    // figure their client still held, and the grant silently vanished. Route it
    // through the live session when there is one, exactly as the item endpoint
    // above does.
    const _liveSock = io.sockets.sockets.get(activeSessions.get(String(req.params.tid)) || '');
    const _giveGoldLive = gold ? _liveSock?.data?._adminGiveGold : null;
    if (gold)  saved.gold          = (saved.gold || 0) + gold;
    // Both balances move by $inc against the live document — the player may be
    // online and earning while the admin types, and neither side should
    // overwrite the other. A negative figure is a valid way to take money back,
    // which is why this uses _incBalance and not _spendBalance.
    if (nexum) await _incBalance(p.telegramId, 'nexumBalance', nexum);
    if (gram) {
      const newG = await _incBalance(p.telegramId, 'gramBalance', gram);
      if (newG !== null) io.to(`tg_${p.telegramId}`).emit('gramBalanceUpdate', { balance: newG });
    }
    // Targeted $set on just the touched fields — a full-document save from
    // this snapshot would revert any other savedData field this account's
    // own gameplay autosave wrote in the same window.
    // Only gold goes through $set here — the two real balances were already
    // moved atomically above and must never be written as an absolute.
    const _giveSet = {};
    // Gold handled by the live session when the player is online (see above);
    // only write it here when nobody is holding a newer copy in memory.
    if (gold && !_giveGoldLive) _giveSet['savedData.gold'] = saved.gold;
    if (Object.keys(_giveSet).length) await PlayerModel.updateOne({ _id: p._id }, { $set: _giveSet });
    if (_giveGoldLive) await _giveGoldLive(gold);
    io.to(`tg_${p.telegramId}`).emit('adminGive', { gold, nexum, gram });
    logPlayer(p.telegramId, p.username, 'admin_give', { gold, nexum, gram });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: season points ─────────────────────────────────────────────────────
// Hands out (or takes back) season points by hand — for compensating an award
// that failed, and for anything else the automatic paths can't cover.
// $inc against the live document for the same reason the balances use it: the
// player may be earning while the admin types, and neither side should
// overwrite the other. A negative figure is a valid way to correct a mistake.
app.post('/admin/player/:tid/season-points', adminAuth, async (req, res) => {
  try {
    const raw = Number((req.body || {}).points);
    if (!Number.isFinite(raw) || Math.trunc(raw) === 0) {
      return res.status(400).json({ error: 'Укажи количество очков' });
    }
    const points = Math.trunc(raw);
    const note = String((req.body || {}).note || '').slice(0, 200);
    const p = await PlayerModel.findOne({ telegramId: req.params.tid }, 'telegramId username savedData.seasonPoints');
    if (!p) return res.status(404).json({ error: 'Not found' });
    // savedData may be null on an account that only ever pressed /start — a
    // dotted $inc through a null parent throws (see _incBalance).
    await PlayerModel.updateOne({ _id: p._id, savedData: null }, { $set: { savedData: {} } });
    const doc = await PlayerModel.findOneAndUpdate(
      { _id: p._id },
      { $inc: { 'savedData.seasonPoints': points } },
      { new: true, projection: { 'savedData.seasonPoints': 1 } },
    ).lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });
    // Never below zero: a correction bigger than the balance would otherwise
    // leave a negative total sitting in the leaderboard.
    let total = Math.floor(Number(doc.savedData?.seasonPoints) || 0);
    if (total < 0) {
      await PlayerModel.updateOne({ _id: p._id }, { $set: { 'savedData.seasonPoints': 0 } });
      total = 0;
    }
    logPlayer(p.telegramId, p.username, 'admin_season_points', { add: points, total, note });
    // The player's live session holds its own copy of the total; tell it to
    // refetch rather than letting the panel show a number their game doesn't.
    io.to(`tg_${p.telegramId}`).emit('seasonRefresh', { total });
    res.json({ ok: true, total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: player inventory / equipment ──────────────────────────────────────
// The whole catalog an admin can hand out, in the same shape the game itself
// stores items in, so the panel can render real icons rather than raw ids.
app.get('/admin/items', adminAuth, (req, res) => {
  const pack = d => ({
    id: d.id, name: d.name, img: d.img || null, slot: d.slot,
    rarity: d.rarity || 'common', forClass: d.forClass || null,
    stackable: isStackableItem(d), enhanceable: ENHANCEABLE_SLOTS.has(d.slot),
  });
  res.json({ items: [...ITEM_DEF, ...CRAFT_MATS, ...BOX_DEF].map(pack) });
});

// Applies an inventory/equipment edit. The player may be online, in which case
// their socket holds the authoritative copy (_lastStats) and its next autosave
// would simply overwrite whatever we wrote to the DB — so when a live session
// exists the edit goes through it (socket.data._adminApplyItems, which updates
// _lastStats, persists, and pushes the result to the client) and only falls
// back to a direct DB write when the account is offline.
app.post('/admin/player/:tid/items', adminAuth, async (req, res) => {
  try {
    const { action, itemId, slot, index, qty, enhance } = req.body || {};
    const p = await PlayerModel.findOne({ telegramId: req.params.tid });
    if (!p) return res.status(404).json({ error: 'Not found' });

    const liveSocket = io.sockets.sockets.get(activeSessions.get(String(req.params.tid)) || '');
    const live = liveSocket && liveSocket.data && liveSocket.data._adminApplyItems;

    const saved = p.savedData || {};
    // Work on the live copy when there is one, so a concurrent autosave can't
    // race this edit; otherwise on the DB snapshot.
    const base = live ? liveSocket.data._adminReadItems() : {
      inventory: Array.isArray(saved.inventory) ? saved.inventory : [],
      equipment: (saved.equipment && typeof saved.equipment === 'object') ? saved.equipment : {},
    };
    const inv = base.inventory.slice();
    const eq  = { ...base.equipment };

    if (action === 'add') {
      const catalogItem = _catalogBase(itemId);
      if (!catalogItem) return res.status(400).json({ error: 'Unknown item' });
      const item = { ...catalogItem };
      if (ENHANCEABLE_SLOTS.has(item.slot)) {
        const e = Math.floor(Number(enhance));
        item.enhance = (Number.isFinite(e) && e >= 0 && e <= ENHANCE_MAX) ? e : 0;
      }
      const n = Math.max(1, Math.min(Math.floor(Number(qty)) || 1, _SANITIZE_MAX.qty));
      if (isStackableItem(item)) {
        item.qty = n;
        if (!_invAdd(inv, item)) return res.status(400).json({ error: 'Инвентарь полон' });
      } else {
        // Non-stackables occupy one slot each — add them one at a time so the
        // capacity check is real rather than counting a single push as n items.
        for (let i = 0; i < n; i++) {
          if (!_invAdd(inv, { ...item })) return res.status(400).json({ error: 'Инвентарь полон' });
        }
      }
    } else if (action === 'removeInv') {
      const i = Math.floor(Number(index));
      if (!(i >= 0 && i < inv.length)) return res.status(400).json({ error: 'Bad index' });
      const entry = inv[i];
      const take = Math.max(1, Math.floor(Number(qty)) || 1);
      const have = entry && entry.qty ? entry.qty : 1;
      if (isStackableItem(entry || {}) && have > take) entry.qty = have - take;
      else inv.splice(i, 1);
    } else if (action === 'removeEq') {
      if (!slot || !eq[slot]) return res.status(400).json({ error: 'Слот пуст' });
      delete eq[slot];
    } else {
      return res.status(400).json({ error: 'Unknown action' });
    }

    if (live) {
      await liveSocket.data._adminApplyItems(inv, eq);
    } else {
      await PlayerModel.updateOne({ _id: p._id },
        { $set: { 'savedData.inventory': inv, 'savedData.equipment': eq } });
    }
    logPlayer(p.telegramId, p.username, 'admin_items', { action, itemId, slot, index, qty, enhance });
    res.json({ ok: true, inventory: inv, equipment: eq, online: !!live });
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
  res.json({ messages: _publicChatHistory() });
});

app.delete('/admin/chat/:idx', adminAuth, async (req, res) => {
  const idx = Number(req.params.idx);
  if (idx >= 0 && idx < globalChatHistory.length) {
    const [removed] = globalChatHistory.splice(idx, 1);
    // Also drop the persisted row — otherwise a deleted message came back on
    // the next restart, now that the history is DB-backed.
    if (removed && removed._id) {
      await ChatMessageModel.deleteOne({ _id: removed._id }).catch(err => console.error('admin chat delete:', err));
    }
  }
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
    const sent = await tgBroadcastAll(text);
    res.json({ ok: true, sent });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Sends `text` to every registered account over the bot. Paced at 30 messages
// a second because Telegram throttles bulk sends and starts dropping (or
// 429-ing) past roughly that rate.
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

// Summon the world-event boss (shared/definitions.js EVENT_BOSS) — it appears
// on the map immediately.
app.post('/admin/event-boss', adminAuth, (req, res) => {
  const r = scheduleEventBoss();
  if (r.error) return res.status(409).json({ error: r.error });
  res.json(r);
});

app.get('/admin/event-boss', adminAuth, (req, res) => {
  const st = eventBossState();
  res.json({ spawnAt: st.spawnAt, alive: st.alive, dropsOnGround: st.drops.length });
});

// Force-opens the Кровавая Башня registration window right now, same
// RACE10_REG_MS window as the normal 20:30 MSK schedule — for whenever an
// admin wants to run it off-schedule. _race10OpenWindow/_race10PublicState
// are defined further down the file; safe to reference here since this
// callback only runs once a request arrives, well after the whole module
// (and the const _race10 it closes over) has finished loading — same
// pattern the DEV_LOCAL-only /dev/race10/open route above already relies on.
app.post('/admin/race10/open', adminAuth, (req, res) => {
  if (_race10.phase === 'reg') return res.status(409).json({ error: 'Регистрация уже открыта' });
  if (_race10.live) return res.status(409).json({ error: 'Забег уже идёт' });
  _race10OpenWindow(Date.now());
  res.json({ ok: true, startAt: _race10.startAt });
});

// Cancels an open registration window early — same effect as the normal
// close once the 5-minute registration period runs out (_race10CloseWindow):
// bumps everyone still queued back to "not registered" and re-arms the
// scheduler for the next regular 20:30 window. Does not touch an
// already-running race (_race10.live) — there is nothing left in the queue
// by the time a race starts anyway.
app.post('/admin/race10/close', adminAuth, (req, res) => {
  if (_race10.phase !== 'reg') return res.status(409).json({ error: 'Регистрация не открыта' });
  _race10CloseWindow();
  res.json({ ok: true });
});

app.get('/admin/race10', adminAuth, (req, res) => {
  res.json(_race10PublicState());
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

// Cancels one active listing and returns its item to the seller — same
// mechanics as the player's own marketCancel (server/index.js), just
// initiated by an admin and for a seller who is very likely offline. Checks
// for room BEFORE flipping the listing's status, same "never destroy the
// item" rule marketCancel follows, so a full inventory refuses the cancel
// entirely rather than cancelling and losing the item.
async function _adminCancelListing(listingId) {
  const pre = await MarketListingModel.findOne({ _id: listingId, status: 'active' }).lean();
  if (!pre) return { ok: false, error: 'Лот не найден или уже закрыт' };

  const liveSocket = io.sockets.sockets.get(activeSessions.get(String(pre.sellerId)) || '');
  const live = liveSocket && liveSocket.data && liveSocket.data._adminApplyItems;
  let sellerDoc = null, sellerInv, sellerEq;
  if (live) {
    const base = liveSocket.data._adminReadItems();
    sellerInv = base.inventory.slice();
    sellerEq = base.equipment;
  } else {
    sellerDoc = await PlayerModel.findOne({ telegramId: pre.sellerId });
    if (!sellerDoc) return { ok: false, error: 'Продавец не найден' };
    const saved = sellerDoc.savedData || {};
    sellerInv = Array.isArray(saved.inventory) ? saved.inventory.slice() : [];
  }
  if (!isStackableItem(pre.item) && sellerInv.length >= SERVER_INV_MAX) {
    return { ok: false, error: 'У продавца полон инвентарь' };
  }

  const listing = await MarketListingModel.findOneAndUpdate(
    { _id: listingId, status: 'active' },
    { status: 'cancelled', soldAt: new Date() },
    { new: false }, // pre-update doc, still carries the item
  );
  if (!listing) return { ok: false, error: 'Лот не найден или уже закрыт' };

  const delivered = _invAdd(sellerInv, listing.item);
  if (delivered) {
    if (live) await liveSocket.data._adminApplyItems(sellerInv, sellerEq);
    else await PlayerModel.updateOne({ _id: sellerDoc._id }, { $set: { 'savedData.inventory': sellerInv } });
  }
  io.to(`tg_${listing.sellerId}`).emit('marketCancelled', {
    listingId: String(listing._id), item: listing.item, delivered,
  });
  logPlayer(listing.sellerId, listing.sellerUsername, 'admin_market_cancel',
    { listingId: String(listing._id), item: listing.item && listing.item.id, delivered });
  return { ok: true, delivered };
}

app.post('/admin/market/:id/cancel', adminAuth, async (req, res) => {
  try {
    const result = await _adminCancelListing(req.params.id);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cancels every currently active listing, one at a time — same per-listing
// safety (room check, item return) as the single-cancel endpoint above, just
// looped. Not a hot path (an admin action, run rarely), so sequential is
// fine and keeps each listing's DB round trip isolated from the others.
// Each iteration is caught on its own: one listing throwing (a malformed
// item, a lookup failure) used to abort the whole res.json below with a bare
// 500, silently leaving every listing after it in the list still active with
// no visible reason why. Now a bad one is just one more "failed" entry and
// the rest still get processed.
app.post('/admin/market/cancel-all', adminAuth, async (req, res) => {
  try {
    const listings = await MarketListingModel.find({ status: 'active' }, '_id').lean();
    let delivered = 0, failed = 0;
    const errors = [];
    for (const l of listings) {
      try {
        const result = await _adminCancelListing(l._id);
        if (result.ok && result.delivered) delivered++;
        else { failed++; errors.push({ id: String(l._id), error: result.error || 'Инвентарь полон' }); }
      } catch (e) {
        failed++;
        errors.push({ id: String(l._id), error: e.message });
        console.error('admin_market_cancel_all item failed:', l._id, e);
      }
    }
    // Each successful cancellation already logged itself individually
    // (_adminCancelListing above) against its own seller — nothing aggregate
    // to add here beyond the failures, capped so a bad batch can't bloat the
    // response.
    res.json({ ok: true, total: listings.length, delivered, failed, errors: errors.slice(0, 20) });
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
// Only the fields the quest editor actually offers are taken from the body —
// passing req.body straight to the model let any document shape through,
// including keys the game later reads as if the server had written them.
function _questFields(body) {
  const b = body || {};
  const out = {};
  if (b.title  != null) out.title  = String(b.title).slice(0, 120);
  if (b.desc   != null) out.desc   = String(b.desc).slice(0, 500);
  if (b.url    != null) out.url    = String(b.url).slice(0, 500);
  if (b.icon   != null) out.icon   = String(b.icon).slice(0, 8);
  if (b.type   != null) out.type   = ['link', 'subscribe', 'custom'].includes(b.type) ? b.type : 'link';
  if (b.active != null) out.active = !!b.active;
  if (b.reward) {
    const n = v => Math.max(0, Math.min(Number(v) || 0, 1e9));
    out.reward = { gold: n(b.reward.gold), xp: n(b.reward.xp), nexum: n(b.reward.nexum) };
  }
  return out;
}
app.post('/admin/special-quests', adminAuth, async (req, res) => {
  try {
    const f = _questFields(req.body);
    if (!f.title) return res.status(400).json({ error: 'title required' });
    res.json({ quest: await SpecialQuestModel.create(f) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/admin/special-quests/:id', adminAuth, async (req, res) => {
  try {
    const q = await SpecialQuestModel.findByIdAndUpdate(req.params.id, _questFields(req.body), { new: true });
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
    return res.status(dbOk ? 200 : 503).json(brief);
  }
  const rooms = [];
  floorRooms.forEach(r => { try { rooms.push(r.stats()); } catch {} });
  const mem = process.memoryUsage();
  res.status(dbOk ? 200 : 503).json({
    ...brief,
    sockets: io.engine.clientsCount,
    uptimeS: Math.round(process.uptime()),
    heapMb: Math.round(mem.heapUsed / 1048576),
    rssMb: Math.round(mem.rss / 1048576),
    rooms,
  });
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
app.get('/api/world-map/:ver', (req, res) => {
  const room = floorRooms.get(1);
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

// Single JS bundle — ETag changes on every server restart (bundle rebuilt on startup)
app.get('/bundle.js', (req, res) => {
  if (req.headers['if-none-match'] === jsBundleEtag) return res.status(304).end();
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('ETag', jsBundleEtag);
  res.setHeader('Cache-Control', 'no-cache');
  // Setting Content-Encoding ourselves is also what makes compression() skip
  // this response instead of compressing it a second time.
  res.setHeader('Vary', 'Accept-Encoding');
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    res.setHeader('Content-Encoding', 'gzip');
    return res.send(jsBundleGz);
  }
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
}

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
  maxHp: 1e7, atk: 1e6, def: 1e6, invLen: 500, storageLen: 200,
  // Raised from 9999 for the Осколки: a unique legendary costs 5000 of every
  // kind, so a player working toward a second one legitimately holds well
  // past the old ceiling. See _canonSavedItem for why going over it now
  // clamps instead of resetting.
  qty: 1e6,
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
    // Over the ceiling CLAMPS rather than resetting to 1. The old reset was a
    // trap once stacks got big: a legitimate pile one over the bound was
    // destroyed outright, and destroying goods is a far worse failure than
    // capping a forged number — the census in saveProgress is what actually
    // stops items being minted, and it compares against the stored baseline,
    // so a clamped value cannot smuggle anything past it either.
    item.qty = Number.isFinite(qty) && qty >= 1 ? Math.min(qty, _SANITIZE_MAX.qty) : 1;
  }
  return item;
}

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

// ── Anti-duplication: the item census ───────────────────────────────────────
// _canonSavedItem above rebuilds an item from the catalog, so a save can only
// ever carry REAL items — but it says nothing about whether the player was
// ever entitled to them, and saveProgress took the resulting array as the new
// truth. That is the hole every "items out of nowhere" report comes back to:
// a modified client appends a legendary at +15, echoes the invRev the server
// itself just told it, and the save is accepted. invRev is an ordering token
// (it tells a save composed before a grant from one composed after), never an
// authorisation one — the client is the one that supplies it.
//
// What closes it is an invariant rather than another per-feature check: every
// legitimate CLIENT-side operation on items either moves one (equip/unequip,
// inventory <-> storage) or destroys one (sell, discard, consume a potion/
// book/key). Not one of them creates an item or raises an enhance level —
// every path that does is already server-side and goes through
// _commitServerItems. So across inventory + equipment + storage combined, a
// client save may only ever SHRINK. Anything that grew was minted.
//
// The key is what makes "+15 copy of a +0 sword" a different thing to own
// rather than the same sword with a bigger number: enhance is part of the
// identity for gear, while stackables collapse to one key counted by qty.
function _itemCensus(stats) {
  const out = new Map();
  const add = raw => {
    const it = _canonSavedItem(raw);
    if (!it) return;
    const stack = isStackableItem(it);
    const key = stack ? it.id : `${it.id}@${it.enhance || 0}`;
    out.set(key, (out.get(key) || 0) + (stack ? (it.qty || 1) : 1));
  };
  if (Array.isArray(stats?.inventory)) stats.inventory.forEach(add);
  if (Array.isArray(stats?.storage)) stats.storage.forEach(add);
  const eq = stats?.equipment;
  if (eq && typeof eq === 'object' && !Array.isArray(eq)) Object.values(eq).forEach(add);
  return out;
}

// The first key `incoming` holds more of than `baseline` does, or null when
// nothing grew. Returned rather than a bare boolean so the rejection log
// names the item that gave it away.
function _censusOverflow(incoming, baseline) {
  for (const [key, n] of incoming) {
    if (n > (baseline.get(key) || 0)) return { key, had: baseline.get(key) || 0, sent: n };
  }
  return null;
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
  // baseAtk/baseDef/baseMaxHp are a pure function of class + level — gainXP
  // (js/player.js) starts them at the class's CHAR_DEF stats and adds a flat
  // +1/+1/+20 on every level-up, nothing else ever changes them. They used
  // to be trusted straight from the client here (just clamped to a huge
  // ceiling), which was a direct line to real, server-enforced PvE *and*
  // PvP combat power: these three feed computeStats (server/game/Room.js)
  // with no relationship to whether the reported level actually earned
  // them. Derived here instead of trusted, so the client's own copy of
  // these fields is simply ignored.
  const _cd = CHAR_DEF[s.type] || CHAR_DEF.lev;
  s.baseAtk   = _cd.baseAtk + (s.lvl - 1);
  s.baseDef   = _cd.baseDef + (s.lvl - 1);
  s.baseMaxHp = _cd.baseHP  + (s.lvl - 1) * 20;
  if (s.autoHpPct != null) s.autoHpPct = _clampNum(s.autoHpPct, 0, 1, 0.5);

  // Upgrade points spent must not exceed what the (now server-derived) lvl/
  // bonusSP could actually have earned — getAvailableSkillPoints (js/
  // player.js) computes this identical budget client-side to gate
  // upgradeStats(), but nothing enforced it here, so a crafted save could
  // report any upgrades total up to the per-stat ceiling regardless of
  // level, and — same as baseAtk/baseDef above — these feed real combat
  // power via computeStats. A legitimate client can never violate this
  // budget, so a save that does is treated the same as an untrusted item
  // id: the whole map is dropped rather than guessing which entries (if
  // any) were legitimate.
  if (s.upgrades && typeof s.upgrades === 'object' && !Array.isArray(s.upgrades)) {
    const u = {};
    for (const [k, v] of Object.entries(s.upgrades)) u[k] = _clampInt(v, 0, 1e5, 0);
    const _spent = Object.values(u).reduce((sum, v) => sum + v, 0);
    const _budget = s.lvl * 3 + s.bonusSP;
    s.upgrades = _spent <= _budget ? u : {};
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
  // VIP progress is set only by gramShopBuy's own targeted $set (server/
  // index.js) after a real GRAM spend, never by this general save path — but
  // unlike the balances above, nothing here ever stripped it, so a crafted
  // saveProgress carrying e.g. vipPending:[1..10] was accepted verbatim and
  // claimVipRewards (which reads it straight back from the DB) would then
  // hand out every VIP tier's items and gold for free, plus the permanent
  // per-kill xp/gold/drop bonuses that come with a fake vipLevel — without a
  // single GRAM ever being spent. Same reasoning as gramBalance/nexumBalance:
  // drop it here so the DB write below leaves whatever the real purchase
  // flow last set untouched.
  delete s.vipLevel;
  delete s.vipDeposited;
  delete s.vipPending;
  // specialQuestsDone gates completeSpecialQuest's once-only claim via a DB
  // $ne filter against this very array — but the array itself came from this
  // same client-trusted save path, so a saveProgress that simply omitted an
  // id (or reset the whole array) let that quest's reward be claimed again.
  // Stripped for the same reason as vipPending: the server already owns this
  // field via completeSpecialQuest's own targeted $set.
  delete s.specialQuestsDone;
  // Season points and quest progress decide who takes a real prize, so they
  // are owned exclusively by the handlers that award them — same rule the
  // currency balances and vipPending already follow.
  delete s.seasonPoints;
  delete s.seasonQuest;
  delete s.seasonQuests;
  delete s.seasonTier;
  // "This invited friend has already been counted." Lives on the friend's own
  // record, so without this they could clear it and have their referrer paid
  // the 200 again on the next login.
  delete s.seasonRefPaid;
  return s;
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

// Keep in sync with the identical calcBM in js/definitions.js — the client
// renders this number in the HUD and clan panel, the server stores it for
// the rating, and the two disagreeing is immediately visible to players.
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

// How many runs a day each event allows. They share one helper but not one
// pool — the Кровавая Башня has a single start per day now, so a single
// attempt is what makes that start the whole of the opportunity.
//
// Read inside the function rather than from a table built up here:
// RACE10_ATTEMPTS/FEAR_ATTEMPTS are declared further down the file, and a
// `const` table evaluated at load time would hit their temporal dead zone
// and take the whole process down on boot.
function _attemptCap(field) {
  if (field === 'race10Attempts') return RACE10_ATTEMPTS;
  if (field === 'fearAttempts') return FEAR_ATTEMPTS;
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
  } catch (e) { return cap; }
}

function _lockArena3Daily(socketId)                  { _lockDailyAttempt(socketId, 'arena3Attempts'); }
async function _arena3AttemptsLeft(socketId)         { return _dailyAttemptsLeft(socketId, 'arena3Attempts'); }
function _lockRace10Daily(socketId)                  { _lockDailyAttempt(socketId, 'race10Attempts'); }
async function _race10AttemptsLeft(socketId)         { return _dailyAttemptsLeft(socketId, 'race10Attempts'); }
function _lockFearDaily(socketId)                    { _lockDailyAttempt(socketId, 'fearAttempts'); }
async function _fearAttemptsLeft(socketId)           { return _dailyAttemptsLeft(socketId, 'fearAttempts'); }

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
  const room = getRoom(1);
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
  const room = getRoom(1);
  if (!room) return { error: 'Мир ещё не инициализирован' };
  if (room.isEventBossAlive()) return { error: 'Босс уже на карте' };
  const boss = room.spawnEventBoss();
  if (!boss) return { error: 'Не удалось призвать босса' };
  io.to('floor_1').emit('eventBossSpawned', { x: boss.x, y: boss.y });
  return { ok: true, spawnAt: 0 };
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
  if (warnIn > 0) _wbNotifyTimer = setTimeout(() => notifyEventSoon('boss', at), warnIn);
  _wbSpawnTimer = setTimeout(() => {
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
  regTimer: null, startTimer: null, maxTimer: null, freezeTimer: null, notifyTimer: null,
};

// True while this socket is an entrant of a round that hasn't gone live yet.
function _dbFrozen(socketId) {
  return _db.phase === 'live' && Date.now() < _db.fightAt && _db.alive.has(socketId);
}

// Next scheduled start, in UTC ms — вторник/четверг/суббота, дважды в день.
// The weekday+hour maths lives in shared/definitions.js so the client's
// countdown reads from exactly the same schedule.
function _dbNextStartAt(from = Date.now()) {
  return nextEventStartAt(DEATH_BATTLE_DAYS_MSK, DEATH_BATTLE_HOURS_MSK, from);
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
  clearTimeout(_db.notifyTimer);
  _db.phase = 'idle';
  _db.startAt = 0;
  const startAt = _dbNextStartAt();
  _db.regTimer = setTimeout(() => _dbOpenReg(startAt), Math.max(0, startAt - DEATH_BATTLE_REG_MS - Date.now()));
  // The 30-minute warning is its own timer rather than part of the
  // registration one: registration only opens DEATH_BATTLE_REG_MS ahead, far
  // too late to get anyone into the game in time. Skipped when that moment
  // has already passed, so a restart inside the window doesn't fire it late
  // (see the same guard in _wbSchedule).
  const warnIn = startAt - EVENT_NOTIFY_BEFORE_MS - Date.now();
  if (warnIn > 0) _db.notifyTimer = setTimeout(() => notifyEventSoon('battle', startAt), warnIn);
}

function _dbOpenReg(startAt) {
  _db.phase = 'reg';
  _db.startAt = startAt;
  // Announced when registration opens rather than at startAt: once the round
  // actually begins nobody can join it any more, so a message then would be
  // pointless. This is the moment the event becomes something to act on.
  notifyEventStarted('battle', startAt);
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
    io.sockets.sockets.get(socketId)?.data?._seasonAwardEvent?.('deathbattle');
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
// it returns immediately. killerSocketId is only ever set when this came from
// an actual pvpAttack/pvpSkillAttack hit (see _pvpEliminate) — dying to a
// monster mid-round (the 'respawn' path) or a disconnect leaves it undefined,
// and no kill/death pair is recorded for those.
function _dbEliminate(socketId, killerSocketId) {
  if (_db.phase !== 'live') return false;
  const victim = _db.alive.get(socketId);
  if (!_db.alive.delete(socketId)) return false;
  const room = getRoom(1);
  const spot = room ? room.dbReturnToPrevSpot(socketId) : null;
  io.to(socketId).emit('deathBattleEliminated', { left: _db.alive.size, x: spot?.x, y: spot?.y });
  if (killerSocketId) {
    const killer = _db.alive.get(killerSocketId);
    const victimTid = _socketTid(socketId), killerTid = _socketTid(killerSocketId);
    if (victimTid) _recordPvpHistory(victimTid, 'death', 'death_battle', killer?.name || null);
    if (killerTid) _recordPvpHistory(killerTid, 'kill', 'death_battle', victim?.name || null);
  }
  _dbBroadcast();
  if (_db.alive.size <= 1) _dbFinish(false);
  return true;
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
    const spot = room ? room.dbReturnToPrevSpot(sid) : null;
    io.to(sid).emit('deathBattleEliminated', { left: 0, x: spot?.x, y: spot?.y });
  });
  _db.alive.clear();
  _db.winnerId = winnerId;
  if (winnerId) {
    // Everyone else in this match already has a 'death' history row from
    // _dbEliminate on their way out — the winner is the only one who still
    // needs an outcome recorded here. A timeout with no winner records
    // nothing (nobody won or lost, the clock just ran out).
    const winnerTid = _socketTid(winnerId);
    if (winnerTid) _recordPvpHistory(winnerTid, 'win', 'death_battle', null);
    const s = io.sockets.sockets.get(winnerId);
    // The prize is granted through the winner's own socket closure, which is
    // where its inventory/GRAM copies live (same reasoning as pickupWorldDrop).
    const won = s?.data?._dbGrantWin ? await s.data._dbGrantWin() : null;
    // Season points for taking the match, on top of the participation ones
    // already paid at deploy. Awarded here rather than inside _dbGrantWin so
    // it lands on a timed-out-but-still-won match too, and stays next to the
    // 3v3 equivalent in _a3Finish.
    s?.data?._seasonAwardWin?.('deathbattle');
    if (s) s.emit('deathBattleWon', {
      gram: DEATH_BATTLE_GRAM_REWARD,
      items: (won && won.items) || [],
      delivered: !!(won && won.delivered),
    });
  }
  _dbSchedule();
  _dbBroadcast();
}

// ── 3v3 Arena (Арена 3х3) ───────────────────────────────────────────────────
// Queue-driven team PvP: six players sign up, get split at random into two
// teams of three, and are dropped into the three-lane arena (see pvpArena in
// server/game/dungeon.js). Allies cannot damage each other; the team with
// anyone left standing wins. Unlike the death battle this has no scheduled
// slot — it fires whenever six people are waiting.
const ARENA3_TEAM_SIZE   = 3;
const ARENA3_NEEDED      = ARENA3_TEAM_SIZE * 2;
const ARENA3_MIN_LEVEL   = 15;
const ARENA3_FREEZE_MS   = 10 * 1000;   // shorter than the death battle's: six known players, no scatter to take in
const ARENA3_REWARD      = 10;          // Liberty (Nexum) per winner
// A real match clock now (it used to be a 30-minute operational guard only,
// back when the rules said a match ran until one side was wiped out however
// long that took). Counted from when the fight itself starts (_a3.fightAt),
// not from deploy — the freeze countdown doesn't eat into it. If nobody wipes
// the other team or drops their guard boss to 0 before this runs out, the
// match ends with no winner and no reward (see the wedged path in _a3Finish).
const ARENA3_ROUND_MS    = 3 * 60 * 1000;

const _a3 = {
  phase: 'idle',       // 'idle' → 'reg' (21:00–22:00 MSK window) → 'idle'
  queue: new Map(),   // socketId -> { name, lvl }
  live: false,
  starting: false,    // guards the async attempt re-check inside _a3TryStart
  teams: new Map(),   // socketId -> 'A' | 'B'
  alive: new Map(),   // socketId -> { name, team }
  names: new Map(),   // socketId -> name, kept for the result screen after elimination
  fightAt: 0,
  roundEndAt: 0,       // fightAt + ARENA3_ROUND_MS — pushed to clients so they can show a countdown
  freezeTimer: null,
  roundTimer: null,
  openTimer: null, closeTimer: null, notifyTimer: null,
};

function _socketTid(socketId) {
  return io.sockets.sockets.get(socketId)?.data?.telegramId || null;
}

// Next scheduled window open, in UTC ms — every day, 21:00 Moscow. Same
// nextEventStartAt helper the death battle/world boss/race10 schedules use.
function _a3NextOpenAt(from = Date.now()) {
  return nextEventStartAt(ARENA3_DAYS_MSK, ARENA3_HOURS_MSK, from);
}

function _a3PublicState() {
  return {
    phase:   _a3.phase,
    nextAt:  _a3NextOpenAt(),
    queued: _a3.queue.size,
    needed: ARENA3_NEEDED,
    live: _a3.live,
    minLevel: ARENA3_MIN_LEVEL,
    reward: ARENA3_REWARD,
    maxAttempts: DAILY_DUNGEON_ATTEMPTS,
  };
}

// Only the people waiting or fighting care about this, so it goes to them
// rather than the whole floor.
function _a3Broadcast() {
  const st = _a3PublicState();
  _a3.queue.forEach((_, sid) => io.to(sid).emit('arena3State', { ...st, registered: true }));
  _a3.names.forEach((_, sid) => io.to(sid).emit('arena3State', st));
}

// Arms the next daily window (21:00 MSK) plus its 30-minute warning. Called
// at boot and after every window closes — same shape as _race10Schedule.
function _a3Schedule() {
  clearTimeout(_a3.openTimer);
  clearTimeout(_a3.notifyTimer);
  _a3.phase = 'idle';
  const openAt = _a3NextOpenAt();
  _a3.openTimer = setTimeout(() => _a3OpenWindow(openAt), Math.max(0, openAt - Date.now()));
  const warnIn = openAt - EVENT_NOTIFY_BEFORE_MS - Date.now();
  if (warnIn > 0) _a3.notifyTimer = setTimeout(() => notifyEventSoon('a3', openAt), warnIn);
}

// Opens the hour-long registration window. Like race10, the queue keeps
// trying for the whole hour — more than one match can fire if enough
// players keep signing up.
function _a3OpenWindow(openAt) {
  _a3.phase = 'reg';
  notifyEventStarted('a3', openAt);
  clearTimeout(_a3.closeTimer);
  _a3.closeTimer = setTimeout(_a3CloseWindow, ARENA3_WINDOW_MS);
  _a3Broadcast();
  _a3TryStartSafe();
}

// Closes the window at 22:00 MSK. Anyone still only queued is bumped back to
// "not registered" — a match already under way keeps running on its own
// ARENA3_ROUND_MS clock regardless.
function _a3CloseWindow() {
  _a3.phase = 'idle';
  [..._a3.queue.keys()].forEach(sid => {
    io.to(sid).emit('arena3Registered', { registered: false });
    io.to(sid).emit('arena3Error', { msg: 'Окно арены 3х3 закрылось — до встречи в 21:00' });
  });
  _a3.queue.clear();
  _a3Schedule();
  _a3Broadcast();
}

function _a3Frozen(socketId) {
  return _a3.live && Date.now() < _a3.fightAt && _a3.alive.has(socketId);
}

// True only for two players on the SAME side of a running match — that is the
// one case where PvP has to be refused inside the arena.
function _a3Allies(a, b) {
  if (!_a3.live) return false;
  const ta = _a3.teams.get(a), tb = _a3.teams.get(b);
  return !!ta && ta === tb;
}
// ...and this is the opposite: two players on OPPOSITE sides, who must be able
// to hit each other even if they share a party or a clan.
function _a3Enemies(a, b) {
  if (!_a3.live) return false;
  const ta = _a3.teams.get(a), tb = _a3.teams.get(b);
  return !!ta && !!tb && ta !== tb;
}

// Both PvP modes can hold a player in a pre-fight freeze, and both need to
// know when one goes down. Every combat path goes through these rather than
// checking each mode separately — adding a third mode later means changing
// these two functions, not every attack handler. Each half no-ops for a
// socket that isn't in that mode.
function _pvpFrozen(socketId) { return _dbFrozen(socketId) || _a3Frozen(socketId) || _race10Frozen(socketId); }
// killerSocketId is only passed by the actual PvP attack handlers below —
// the 'respawn' and disconnect call sites leave it undefined, since dying to
// a monster mid-round (or just leaving) isn't a kill by another player.
// race10 has no player-vs-player damage at all, so it never needs it.
// room is the attacker's Room, only needed to resolve names for the open-world
// fallback below — the three mode-specific eliminates already know names from
// their own alive maps.
function _pvpEliminate(socketId, killerSocketId, room) {
  const dbHandled = _dbEliminate(socketId, killerSocketId);
  const a3Handled = _a3Eliminate(socketId, killerSocketId);
  const r10Handled = _race10Eliminate(socketId);
  const fearHandled = _fearEliminate(socketId);
  // A PvP kill (setPvpMode duel) that isn't part of any live Death
  // Battle/Arena3/race10/Fear round falls through all four above untouched —
  // they only record when the victim was in their own alive map. Without
  // this, open-world PvP kills/deaths never appeared in the История tab.
  if (killerSocketId && !dbHandled && !a3Handled && !r10Handled && !fearHandled) {
    const victimTid = _socketTid(socketId), killerTid = _socketTid(killerSocketId);
    const victim = room?.players.get(socketId);
    const killer = room?.players.get(killerSocketId);
    if (victimTid) _recordPvpHistory(victimTid, 'death', 'open_pvp', killer?.username || null);
    if (killerTid) _recordPvpHistory(killerTid, 'kill', 'open_pvp', victim?.username || null);
  }
}

// _a3TryStart is async now (it re-checks daily attempts against the DB), and
// every caller fires it without waiting — this keeps a failed launch from
// surfacing as an unhandled rejection and taking the process down.
function _a3TryStartSafe() { _a3TryStart().catch(err => console.error('_a3TryStart:', err)); }

async function _a3TryStart() {
  // _a3.starting covers the await below: without it two callers could both
  // pass the _a3.live check while the attempt re-check is in flight and
  // deploy two matches into the one arena.
  if (_a3.live || _a3.starting) return;
  const room = getRoom(1);
  if (!room) return;
  // Only entrants still connected and still standing in the world can be
  // deployed; anyone else is dropped from the queue rather than counted.
  const ready = [..._a3.queue.keys()].filter(sid =>
    io.sockets.sockets.get(sid) && room.players.get(sid));
  [..._a3.queue.keys()].forEach(sid => { if (!ready.includes(sid)) _a3.queue.delete(sid); });
  if (ready.length < ARENA3_NEEDED) return;

  _a3.starting = true;
  try {
    await _a3Deploy(ready, room);
  } finally {
    _a3.starting = false;
  }
}

async function _a3Deploy(ready, room) {
  const picked = ready.slice(0, ARENA3_NEEDED);

  // Attempts are re-checked against fresh DB state right before launch, not
  // just at sign-up: someone can burn their last attempt in another session
  // while sitting in this queue. Anyone out of attempts is dropped and the
  // launch is retried with whoever is left.
  const spent = await Promise.all(picked.map(sid => _arena3AttemptsLeft(sid)));
  const outOfAttempts = picked.filter((sid, i) => spent[i] <= 0);
  if (outOfAttempts.length) {
    outOfAttempts.forEach(sid => {
      _a3.queue.delete(sid);
      io.to(sid).emit('arena3Error', { msg: 'Попытки на арену на сегодня закончились' });
      io.to(sid).emit('arena3Registered', { registered: false });
    });
    _a3Broadcast();
    // Each pass removes at least one entrant, so this can't loop forever.
    // Deferred so _a3.starting has been cleared by the caller's finally.
    setImmediate(_a3TryStartSafe);
    return;
  }
  // Fisher-Yates, so the split is genuinely random rather than "first three to
  // press the button are one team".
  for (let i = picked.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [picked[i], picked[j]] = [picked[j], picked[i]];
  }
  const teamA = picked.slice(0, ARENA3_TEAM_SIZE);
  const teamB = picked.slice(ARENA3_TEAM_SIZE);

  _a3.live = true;
  _a3.teams.clear(); _a3.alive.clear(); _a3.names.clear();
  _a3.fightAt = Date.now() + ARENA3_FREEZE_MS;
  _a3.roundEndAt = _a3.fightAt + ARENA3_ROUND_MS;

  const placed = room.pvpArenaDeploy(teamA, teamB);
  // Someone can vanish between the readiness filter above and the deploy. A
  // side with nobody on it would never trigger the win check — no one is left
  // to be killed — and with no match timer that would hold the arena until the
  // round guard fired. Put everyone back and wait instead.
  if (placed.filter(p => p.team === 'A').length === 0 ||
      placed.filter(p => p.team === 'B').length === 0) {
    placed.forEach(({ socketId }) => room.deathBattleReturn(socketId));
    _a3.live = false;
    _a3.fightAt = 0;
    _a3.roundEndAt = 0;
    _a3Broadcast();
    return;
  }
  // One guard boss per side (see spawnPvpArenaBosses in server/game/Room.js) —
  // 30k HP each, no drop; the owning team can't damage its own (checked in
  // the attack/skillAttack handlers below) and destroying the enemy's ends
  // the match immediately (see the a3Team branch in those same handlers).
  const bossIds = room.spawnPvpArenaBosses();
  placed.forEach(({ socketId, x, y, hp, team }) => {
    const name = _a3.queue.get(socketId)?.name || '?';
    _a3.teams.set(socketId, team);
    _a3.alive.set(socketId, { name, team });
    _a3.names.set(socketId, name);
    _a3.queue.delete(socketId);
    // The attempt is spent the moment the match starts, win or lose. Only
    // players actually deployed are charged, so a cancelled launch costs
    // nobody anything.
    _lockArena3Daily(socketId);
    // Same moment the attempt is charged: they are in the match, so the
    // season task for taking part is earned.
    io.sockets.sockets.get(socketId)?.data?._seasonAwardEvent?.('arena3');
  });
  // Rosters are only known once everyone is placed, so this is a second pass.
  const roster = placed.map(p => ({ id: p.socketId, name: _a3.names.get(p.socketId), team: p.team }));
  placed.forEach(({ socketId, x, y, hp, team }) => {
    io.to(socketId).emit('arena3Started', {
      x, y, hp, team, fightAt: _a3.fightAt, roundEndAt: _a3.roundEndAt, roster, bossIds,
    });
    logPlayer(_socketTid(socketId), _a3.names.get(socketId), 'arena3_start', { team });
  });

  clearTimeout(_a3.freezeTimer);
  _a3.freezeTimer = setTimeout(() => {
    if (!_a3.live) return;
    _a3.alive.forEach((_, sid) => io.to(sid).emit('arena3Fight', { roundEndAt: _a3.roundEndAt }));
  }, ARENA3_FREEZE_MS);

  clearTimeout(_a3.roundTimer);
  _a3.roundTimer = setTimeout(() => _a3Finish(null, true), ARENA3_FREEZE_MS + ARENA3_ROUND_MS);
  _a3Broadcast();
}

// Knocks one player out. Safe to call for anyone not in a match — a normal PvP
// kill elsewhere, an unrelated disconnect — it returns immediately.
// killerSocketId (only set by an actual pvpAttack/pvpSkillAttack hit, see
// _pvpEliminate) records the kill/death pair; a monster/disconnect
// elimination leaves it undefined and records nothing.
function _a3Eliminate(socketId, killerSocketId) {
  if (!_a3.live) return false;
  const rec = _a3.alive.get(socketId);
  if (!rec) return false;
  _a3.alive.delete(socketId);
  const room = getRoom(1);
  const spot = room ? room.deathBattleReturn(socketId) : null;
  io.to(socketId).emit('arena3Eliminated', { x: spot?.x, y: spot?.y });
  if (killerSocketId) {
    const killerRec = _a3.alive.get(killerSocketId);
    const victimTid = _socketTid(socketId), killerTid = _socketTid(killerSocketId);
    if (victimTid) _recordPvpHistory(victimTid, 'death', 'arena3', killerRec?.name || null);
    if (killerTid) _recordPvpHistory(killerTid, 'kill', 'arena3', rec?.name || null);
  }
  const aliveA = [..._a3.alive.values()].filter(r => r.team === 'A').length;
  const aliveB = [..._a3.alive.values()].filter(r => r.team === 'B').length;
  // Sent relative to each recipient — "mine" is always their own side, so the
  // client can always render itself as the blue half of the score and the
  // opponent as the red half, regardless of which internal team (A/B) either
  // side actually got assigned.
  _a3.alive.forEach((_, sid) => {
    const mine  = _a3.teams.get(sid) === 'A' ? aliveA : aliveB;
    const enemy = _a3.teams.get(sid) === 'A' ? aliveB : aliveA;
    io.to(sid).emit('arena3Score', { mine, enemy });
  });
  if (aliveA === 0 || aliveB === 0) {
    _a3Finish(aliveA === 0 && aliveB === 0 ? null : (aliveA === 0 ? 'B' : 'A'), false);
  }
  return true;
}

async function _a3Finish(winner, wedged) {
  if (!_a3.live) return;
  clearTimeout(_a3.freezeTimer);
  clearTimeout(_a3.roundTimer);
  _a3.live = false;
  _a3.fightAt = 0;
  _a3.roundEndAt = 0;
  const room = getRoom(1);
  // Match is over either way — clear both guard bosses so a dead-or-alive
  // leftover never carries into the next one.
  if (room) room.despawnPvpArenaBosses();
  // Everyone still standing goes home too — the match is over for them as
  // well, they just didn't die to get there.
  _a3.alive.forEach((_, sid) => { if (room) room.deathBattleReturn(sid); });

  const teams = new Map(_a3.teams);
  const names = new Map(_a3.names);
  _a3.teams.clear(); _a3.alive.clear(); _a3.names.clear();

  for (const [sid, team] of teams) {
    const won = !!winner && team === winner;
    const s = io.sockets.sockets.get(sid);
    let reward = 0;
    if (won && s?.data?._a3GrantWin) {
      reward = await s.data._a3GrantWin();
    }
    // Every player on the winning side gets the full amount — it is a team
    // result, not a pot split three ways.
    if (won) s?.data?._seasonAwardWin?.('arena3');
    io.to(sid).emit('arena3Result', { won, winner, wedged: !!wedged, reward, team });
    logPlayer(_socketTid(sid), names.get(sid), 'arena3_end',
      { team, result: winner ? (won ? 'win' : 'lose') : (wedged ? 'wedged' : 'draw'), reward });
    // Team result, independent of whether this player personally got
    // eliminated mid-match (already its own 'death' row from _a3Eliminate if
    // so) — a wedged/no-winner match records neither.
    if (winner) {
      const tid = _socketTid(sid);
      if (tid) _recordPvpHistory(tid, won ? 'win' : 'lose', 'arena3', null);
    }
  }
  _a3Broadcast();
  // A queue that filled up while this match ran starts the next one straight
  // away rather than waiting for someone to press register again.
  _a3TryStartSafe();
}

// ── Кровавая Башня (corridor race) ──────────────────────────────────────────
// Registration opens at 20:30 MSK and everyone who signs up runs — no fixed
// headcount. RACE10_REG_MS later the whole field starts at once, one sealed
// lane each (server/game/dungeon.js race10): 60 level-5 monsters then 60
// level-10, packed shoulder to shoulder, no way past but through. Every lane
// ends at the same shared room and the same single boss (spawnRaceBoss,
// server/game/Room.js): whoever has dealt it the most cumulative damage when
// it dies wins Liberty. Dying anywhere in a lane is an elimination — handled
// by the existing 'respawn' handler via _pvpEliminate, the same wiring the
// death battle and 3v3 arena already share, so a monster kill in the corridor
// counts exactly like a PvP kill would.
//
// It used to fire the moment ten players were queued, and could run several
// times in the hour. One start with everyone in it replaces that, which is
// also what makes a single daily attempt fair: miss the five minutes and you
// miss the day, rather than losing your one attempt to a race that filled up
// without you.
//
// How many can enter is a property of the map, not of this file: lanes are
// carved at world generation and never change, so the ceiling is however many
// exist (read below from the dungeon, not hardcoded here).
const RACE10_MIN_PLAYERS = 2;            // a race of one has nobody to race
const RACE10_REG_MS    = 5 * 60 * 1000;  // registration window before the start
const RACE10_ATTEMPTS  = 1;              // per UTC day — its own limit, not the shared dungeon pool
const RACE10_MIN_LEVEL = 10;
const RACE10_FREEZE_MS = 10 * 1000;
const RACE10_REWARD    = 10;             // Liberty (Nexum) to the top damage-dealer only — the boss drops no loot
// Operational guard only, same idea as the 3v3 arena's old wedge — ends the
// race with no winner if the boss just never comes down, so the one shared
// instance can't be tied up forever.
const RACE10_MAX_MS    = 15 * 60 * 1000;

// The map's lane count — the hard ceiling on entrants. Read once the world
// exists; before that (nobody can register yet) it reports 0.
function _race10Capacity() {
  const room = getRoom(1);
  return room?.dungeonData?.race10?.lanes?.length || 0;
}

const _race10 = {
  phase: 'idle',        // 'idle' → 'reg' (20:30 MSK, RACE10_REG_MS window) → 'idle'
  queue: new Map(),    // socketId -> { name, lvl }
  live: false,
  starting: false,     // guards the async attempt re-check inside _race10TryStart
  alive: new Map(),    // socketId -> { name, lane } — still in a lane or the boss room
  names: new Map(),    // socketId -> name, kept for the result screen after elimination
  dmg: new Map(),      // socketId -> cumulative damage dealt to the shared boss
  bossId: null,
  fightAt: 0,
  startAt: 0,          // when the field is deployed — registration closes then
  freezeTimer: null,
  maxTimer: null,
  startTimer: null,
  openTimer: null, notifyTimer: null,
};

// Next scheduled window open, in UTC ms — every day, 20:30 Moscow. Lives in
// shared/definitions.js (RACE10_DAYS_MSK/HOURS_MSK) so it's computed the
// same way the death battle's and world boss's own schedules are.
function _race10NextOpenAt(from = Date.now()) {
  return nextEventStartAt(RACE10_DAYS_MSK, RACE10_HOURS_MSK, from);
}

function _race10PublicState() {
  return {
    phase:   _race10.phase,
    nextAt:  _race10NextOpenAt(),
    queued: _race10.queue.size,
    // No headcount to reach any more; the client shows the queue size and
    // counts down to startAt instead. `capacity` is the lane ceiling.
    startAt: _race10.startAt,
    capacity: _race10Capacity(),
    minPlayers: RACE10_MIN_PLAYERS,
    live: _race10.live,
    minLevel: RACE10_MIN_LEVEL,
    reward: RACE10_REWARD,
    maxAttempts: RACE10_ATTEMPTS,
  };
}

function _race10Broadcast() {
  const st = _race10PublicState();
  _race10.queue.forEach((_, sid) => io.to(sid).emit('race10State', { ...st, registered: true }));
  _race10.names.forEach((_, sid) => io.to(sid).emit('race10State', st));
}

// Arms the next daily window (20:30 MSK) plus its 30-minute warning. Called
// at boot and after every window closes; if the process starts inside the
// window itself the open-timeout is already due and fires immediately with
// whatever time is left, same as _dbSchedule.
function _race10Schedule() {
  clearTimeout(_race10.openTimer);
  clearTimeout(_race10.notifyTimer);
  _race10.phase = 'idle';
  const openAt = _race10NextOpenAt();
  _race10.openTimer = setTimeout(() => _race10OpenWindow(openAt), Math.max(0, openAt - Date.now()));
  const warnIn = openAt - EVENT_NOTIFY_BEFORE_MS - Date.now();
  if (warnIn > 0) _race10.notifyTimer = setTimeout(() => notifyEventSoon('race10', openAt), warnIn);
}

// Opens registration at 20:30 MSK and arms the single start RACE10_REG_MS
// later. Everyone signed up by then runs; there is no headcount to reach and
// no second race in the same window, so the five minutes are the whole of the
// opportunity — which is what the 30-minute warning broadcast is for. The
// window closes itself the moment that single start attempt is processed
// (_race10Start below calls _race10CloseWindow once it's done, win or no
// players) — there's nothing left to wait around for after that.
// regMs is only ever passed by the local dev opener (see the DEV_LOCAL block
// near the top of this file) so the event can be exercised without waiting for
// 20:30; the scheduled path always uses RACE10_REG_MS.
function _race10OpenWindow(openAt, regMs = RACE10_REG_MS) {
  _race10.phase = 'reg';
  _race10.startAt = Date.now() + regMs;
  notifyEventStarted('race10', openAt);
  clearTimeout(_race10.startTimer);
  _race10.startTimer = setTimeout(_race10StartSafe, regMs);
  _race10Broadcast();
}

// Closes registration early — either RACE10_REG_MS after opening, once
// _race10Start has processed the day's one attempt (silent: true, since
// anyone still queued by then already got a more specific message about why),
// or from an admin's manual "close now" (server-authoritative, no silent
// flag — those callers want the generic notice). Either way there is no
// second start left in this window, so this always re-arms tomorrow's.
function _race10CloseWindow(opts = {}) {
  _race10.phase = 'idle';
  _race10.startAt = 0;
  clearTimeout(_race10.startTimer);
  if (!opts.silent) {
    [..._race10.queue.keys()].forEach(sid => {
      io.to(sid).emit('race10Registered', { registered: false });
      io.to(sid).emit('race10Error', { msg: 'Окно Кровавой Башни закрылось — до встречи в 20:30' });
    });
  }
  _race10.queue.clear();
  _race10Schedule();
  _race10Broadcast();
}

function _race10Frozen(socketId) {
  return _race10.live && Date.now() < _race10.fightAt && _race10.alive.has(socketId);
}

// The scheduled start fires once per window; async because it re-checks daily
// attempts against the DB, and never awaited by its caller (a timer), so the
// rejection has to be caught here.
function _race10StartSafe() { _race10Start().catch(err => console.error('_race10Start:', err)); }

async function _race10Start() {
  if (_race10.live || _race10.starting) return;
  _race10.startAt = 0;
  const room = getRoom(1);
  if (!room) { _race10CloseWindow({ silent: true }); return; }
  // Only entrants still connected and still standing in the world can be
  // deployed; anyone else is dropped rather than counted.
  const ready = [..._race10.queue.keys()].filter(sid =>
    io.sockets.sockets.get(sid) && room.players.get(sid));
  [..._race10.queue.keys()].forEach(sid => { if (!ready.includes(sid)) _race10.queue.delete(sid); });
  if (ready.length < RACE10_MIN_PLAYERS) {
    // Not enough showed up. Nobody is charged an attempt (that happens on
    // deploy) — there is no second start, so this is "not today" and
    // registration closes right along with it (silent: already told these
    // exact sockets why, above).
    ready.forEach(sid => io.to(sid).emit('race10Error', {
      msg: `Забег отменён — нужно минимум ${RACE10_MIN_PLAYERS} участника`,
    }));
    _race10CloseWindow({ silent: true });
    return;
  }

  _race10.starting = true;
  try {
    await _race10Deploy(ready, room);
  } finally {
    _race10.starting = false;
    // One start per window, successful or not — close registration the
    // moment it's been attempted (queue is already drained by _race10Deploy
    // either way, so this is just phase/reschedule bookkeeping by now).
    _race10CloseWindow();
  }
}

async function _race10Deploy(ready, room) {
  // Everyone who registered, capped only by how many corridors the map has.
  // Anyone past that is told plainly rather than being silently dropped into
  // somebody else's lane.
  const capacity = room.dungeonData.race10?.lanes?.length || 0;
  const picked = ready.slice(0, capacity);
  ready.slice(capacity).forEach(sid => {
    _race10.queue.delete(sid);
    io.to(sid).emit('race10Registered', { registered: false });
    io.to(sid).emit('race10Error', { msg: `В Башне только ${capacity} коридоров — сегодня не хватило места` });
  });

  // Re-checked against fresh DB state right before launch, not just at
  // sign-up — same reasoning as the 3v3 arena's own re-check.
  const spent = await Promise.all(picked.map(sid => _race10AttemptsLeft(sid)));
  const outOfAttempts = picked.filter((sid, i) => spent[i] <= 0);
  // Anyone who used their attempt elsewhere since signing up is dropped, and
  // the race goes ahead with the rest — there is only one start per window, so
  // retrying the whole launch (as the queue-driven version did) would just
  // cancel the event for everybody.
  const running = picked.filter((sid, i) => spent[i] > 0);
  outOfAttempts.forEach(sid => {
    _race10.queue.delete(sid);
    io.to(sid).emit('race10Error', { msg: 'Попытки в Кровавую Башню на сегодня закончились' });
    io.to(sid).emit('race10Registered', { registered: false });
  });
  if (running.length < RACE10_MIN_PLAYERS) {
    running.forEach(sid => io.to(sid).emit('race10Error', {
      msg: `Забег отменён — нужно минимум ${RACE10_MIN_PLAYERS} участника`,
    }));
    _race10Broadcast();
    return;
  }

  _race10.live = true;
  _race10.alive.clear(); _race10.names.clear(); _race10.dmg.clear();
  _race10.fightAt = Date.now() + RACE10_FREEZE_MS;

  // Every lane's monsters have to be back at full strength before this race
  // starts — they don't respawn on their own (see Room.js's tick loop), so a
  // second race later in the same window would otherwise find them still
  // dead from the first one.
  room.resetRaceMonsters();
  const placed = room.raceDeploy(running);
  _race10.bossId = room.spawnRaceBoss();

  placed.forEach(({ socketId, lane }) => {
    const name = _race10.queue.get(socketId)?.name || '?';
    _race10.alive.set(socketId, { name, lane });
    _race10.names.set(socketId, name);
    _race10.dmg.set(socketId, 0);
    _race10.queue.delete(socketId);
    // Attempt spent the moment the race starts, win or lose — same rule as
    // the 3v3 arena.
    _lockRace10Daily(socketId);
  });

  const roster = placed.map(p => ({ id: p.socketId, name: _race10.names.get(p.socketId), lane: p.lane }));
  placed.forEach(({ socketId, x, y, hp, lane }) => {
    io.to(socketId).emit('race10Started', { x, y, hp, lane, fightAt: _race10.fightAt, roster });
    logPlayer(_socketTid(socketId), _race10.names.get(socketId), 'race10_start', { lane });
  });

  clearTimeout(_race10.freezeTimer);
  _race10.freezeTimer = setTimeout(() => {
    if (!_race10.live) return;
    _race10.alive.forEach((_, sid) => io.to(sid).emit('race10Fight'));
  }, RACE10_FREEZE_MS);

  clearTimeout(_race10.maxTimer);
  _race10.maxTimer = setTimeout(() => _race10Finish(null, true), RACE10_FREEZE_MS + RACE10_MAX_MS);
  _race10Broadcast();
}

// Knocks one player out — dying anywhere in a lane, to anything. Safe to
// call for anyone not in the race (a normal death elsewhere), it returns
// immediately. Their damage tally survives them: "most damage dealt" doesn't
// require surviving to the end.
function _race10Eliminate(socketId) {
  if (!_race10.live) return false;
  if (!_race10.alive.has(socketId)) return false;
  _race10.alive.delete(socketId);
  io.to(socketId).emit('race10Eliminated', {});
  // Nobody left standing anywhere and the boss is still up — no one can ever
  // land another hit, so there's no point riding out RACE10_MAX_MS.
  if (_race10.alive.size === 0) _race10Finish(null, false);
  return true;
}

async function _race10Finish(winnerId, timedOut) {
  if (!_race10.live) return;
  clearTimeout(_race10.freezeTimer);
  clearTimeout(_race10.maxTimer);
  _race10.live = false;
  _race10.fightAt = 0;
  const room = getRoom(1);
  if (room) room.despawnRaceBoss();
  // Everyone still standing goes home too — the race is over for them as
  // well, they just didn't die to get there.
  _race10.alive.forEach((_, sid) => { if (room) room.deathBattleReturn(sid); });

  const names = new Map(_race10.names);
  const dmg = new Map(_race10.dmg);
  const participants = [...names.keys()];
  _race10.alive.clear(); _race10.names.clear(); _race10.dmg.clear(); _race10.bossId = null;

  for (const sid of participants) {
    const won = !!winnerId && sid === winnerId;
    const s = io.sockets.sockets.get(sid);
    let reward = 0;
    if (won && s?.data?._race10GrantWin) reward = await s.data._race10GrantWin();
    io.to(sid).emit('race10Result', {
      won, winnerName: winnerId ? names.get(winnerId) : null,
      myDamage: dmg.get(sid) || 0, timedOut: !!timedOut, reward,
    });
    logPlayer(_socketTid(sid), names.get(sid), 'race10_end', {
      result: winnerId ? (won ? 'win' : 'lose') : (timedOut ? 'timeout' : 'no_survivors'),
      dmg: dmg.get(sid) || 0, reward,
    });
    // No player-vs-player damage in this mode (everyone fights the same
    // shared boss/monsters), so only a win/lose result is recorded — never
    // a kill/death. A timeout/no-survivors race records neither.
    if (winnerId) {
      const tid = _socketTid(sid);
      if (tid) _recordPvpHistory(tid, won ? 'win' : 'lose', 'race10', null);
    }
  }
  _race10Broadcast();
  // No follow-up race: the window holds exactly one start (see
  // _race10OpenWindow), so anyone who missed it waits for tomorrow.
}

// ── Страх (Fear) ─────────────────────────────────────────────────────────────
// A private, on-demand wave-survival instance: no scheduled window and no
// registration queue, unlike arena3/race10 above — a player spends one of
// FEAR_ATTEMPTS daily attempts the instant they enter (fearEnter, below the
// socket handlers further down this file), same "spent on entry, not on a
// successful clear" rule the shared daily-attempts pool already follows for
// arena3/race10. Waves escalate one global monster level at a time, 20
// monsters per wave (server/game/Room.js's FEAR_WAVE_MOBS), up to
// FEAR_MAX_WAVE (shared/definitions.js, read by both here and Room.js).
// Dying or clearing the last wave both send the player home — there is no
// way to fail out and keep the attempt, and no way to "win" beyond that.
const FEAR_ATTEMPTS = 2;
const FEAR_MIN_LEVEL = 10;

// socketId -> { lane, wave } for whoever currently has a run going — read by
// the attack/skillAttack handlers to advance the run one kill at a time, by
// _fearEliminate on death, and by the disconnect handler if they drop
// mid-run. A player can only ever be in one lane at once (fearEnter refuses
// a second entry while this already has them), so a flat map is enough.
const _fear = new Map();

// Spawns wave `wave` in `lane` and tells the client — split out since both
// fearEnter (wave 1) and _fearTrackKill (every wave after) need it.
function _fearStartWave(room, socketId, lane, wave) {
  room.fearSpawnWave(lane, wave);
  _fear.set(socketId, { lane, wave });
  io.to(socketId).emit('fearWave', { wave, maxWave: FEAR_MAX_WAVE });
}

// Called right after a kill lands on a `fear`-tagged enemy (see the attack/
// skillAttack handlers, alongside the existing _race10TrackHit call). The kill
// itself already paid out xp/gold through the normal reward path — this only
// owns the wave-progression side effect: advance to the next wave once the
// current one's last monster falls, or finish the run if that was
// FEAR_MAX_WAVE.
function _fearTrackKill(socketId, result) {
  if (result.arm !== 'fear') return;
  const run = _fear.get(socketId);
  if (!run || run.lane !== result.lane) return;
  const room = getRoom(1);
  if (!room) return;
  // The run record is only trustworthy while the player is still actually
  // standing in that hall. Several handlers unrelated to this event
  // (race10Return/arena3Return/deathBattleReturn) call Room.deathBattleReturn
  // unconditionally, which hands the hall back as a side effect — so a stale
  // record here could otherwise be counting kills against a hall that now
  // belongs to somebody else's run.
  if (room.fearLaneOf(socketId) !== run.lane || room.fearOwnerOf(run.lane) !== socketId) {
    _fear.delete(socketId);
    return;
  }
  const left = room.fearRegisterKill(result.lane);
  if (left > 0) return;
  if (run.wave >= FEAR_MAX_WAVE) { _fearFinish(socketId, true); return; }
  _fearStartWave(room, socketId, result.lane, run.wave + 1);
}

// Sends the player home and frees their lane — either because they cleared
// FEAR_MAX_WAVE (cleared: true) or died mid-run (cleared: false, called from
// _fearEliminate). Safe to call on someone not currently in a run.
function _fearFinish(socketId, cleared) {
  const run = _fear.get(socketId);
  if (!run) return;
  _fear.delete(socketId);
  const room = getRoom(1);
  // deathBattleReturn releases the hall as part of the teleport home, but
  // ONLY while the player record still exists — it bails out early otherwise,
  // which is exactly the case when this is reached from a disconnect. So the
  // hall is also released off the run record, which always knows its lane —
  // but only while it is still THIS socket's hall. Releasing it unconditionally
  // would let a stale run record (see _fearTrackKill) wipe the wave of
  // whoever had since been given that hall.
  const ownedBefore = room ? room.fearOwnerOf(run.lane) === socketId : false;
  const spot = room ? room.deathBattleReturn(socketId) : null;
  if (room && ownedBefore) room.fearReleaseLane(run.lane);
  io.to(socketId).emit('fearFinished', { cleared, wave: run.wave, x: spot?.x, y: spot?.y });
}

// Wired into _pvpEliminate's fan-out (mirrors _race10Eliminate) — dying
// anywhere while in a Fear lane ends the run on the spot. Only a lane's own
// monsters can ever reach a player there, but this covers the death path
// generically the same way the other instanced events do.
function _fearEliminate(socketId) {
  if (!_fear.has(socketId)) return false;
  _fearFinish(socketId, false);
  return true;
}

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
  for (let f = 1; f <= MAX_FLOOR; f++) {
    const onBossDeath = (arm, respawnAt) => {
      BossStateModel.updateOne({ floor: f, arm }, { $set: { respawnAt } }, { upsert: true })
        .catch(err => console.error('[BossState] persist failed', f, arm, err));
    };
    floorRooms.set(f, new Room(f, io, bossStateByFloor.get(f) || {}, onBossDeath));
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
setInterval(() => { _flushClanXp().catch(() => {}); }, CLAN_XP_FLUSH_MS).unref();

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

io.on('connection', socket => {
  let authed = null;
  let currentRoom = null;
  let currentFloor = 1;
  let _lastStats = null;
  let _autoSaveInterval = null;

  // ── Server-side gold spend ────────────────────────────────────────────────
  // Gold is the one currency the server does not own: it rides in on the
  // client's save blob and the next saveProgress replaces _lastStats wholesale.
  // So deducting it here is not enough on its own — a save composed BEFORE the
  // deduction, arriving after it, carries the pre-spend figure and hands the
  // money straight back. That is why "золото не снимает" for the clan storage
  // unlock: the charge landed and was then quietly undone.
  //
  // The fix is to remember the spend until a save that actually accounts for it
  // arrives. saveProgress re-applies it to any save stamped EARLIER than the
  // spend (see the _pendingGoldSpend block there) — savedAt is what separates
  // "composed before" from "composed after", so a player who legitimately
  // earned gold in between is never charged twice. One-shot and time-bounded:
  // it can correct at most one save, and expires either way.
  let _pendingGoldSpend = null;

  async function _serverSpendGold(amount, reason) {
    if (!authed || !_lastStats || !(amount > 0)) return null;
    const before = Math.floor(Number(_lastStats.gold) || 0);
    const after = Math.max(0, before - amount);
    _lastStats.gold = after;
    // savedAt moves with it: the client compares its localStorage backup
    // against the stored blob by this stamp (_pickFreshestSave, js/network.js),
    // and a write that left savedAt behind could be beaten by a device cache
    // still holding the pre-spend figure.
    _lastStats.savedAt = Date.now();
    _pendingGoldSpend = { amount, after, at: _lastStats.savedAt, reason,
                          until: Date.now() + 60000 };
    await _persistSavedFields(authed, { gold: after, savedAt: _lastStats.savedAt });
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
    currentRoom?.setPlayerClan(socket.id, _myClanName, _myClanIcon, clanAtkBonusPct(_myClanLevel));
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
  let _saveDebounceTimer = null;

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
    _balancePersistTimer = setTimeout(() => {
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
    'gramGetHistory', 'gramShopBuy', 'gramDepositRequest', 'gramWithdrawRequest',
    'getReferrals', 'getRating', 'getPvpHistory', 'completeSpecialQuest', 'claimVipRewards',
    'clanCreate', 'clanSearch', 'clanApply', 'clanApprove', 'clanDecline', 'clanRequest',
    'clanKick', 'clanLeave', 'clanDisband', 'clanSetDescription',
    // Clan storage — every one of these reads and writes the clan document.
    'clanStorageSync', 'clanStorageDeposit', 'clanStorageGive',
    'clanStorageCancel', 'clanStorageClaim', 'clanStorageUnlock',
    'partyInvite', 'partyAccept', 'saveProgress', 'selectChar',
    'requestPlayerProfile', 'resetUpgrades', 'craftPet', 'craftStone', 'craftGear', 'craftClassGear', 'enhanceItem',
    'craftBox', 'craftMatUpgrade', 'openLootBox',
    // Both hit the database on every call — seasonRating sorts the whole
    // player collection, seasonSetTier writes the selected band.
    'seasonRating', 'seasonSetTier',
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
    // Balances are their own write and are never part of the progress blob —
    // see the balance block at the top of this file. Whatever this session has
    // earned since the last flush has to land either way.
    await _flushBalances();
    if (authed && _lastStats) {
      await _persistSavedFields(authed, { ..._lastStats }, { bm: authed.bm });
    }
    // Season quest progress is deliberately NOT part of _lastStats (the
    // sanitizer strips it, so the blob above cannot carry it) and is only
    // batched to the database every SEASON_FLUSH_EVERY kills. Without this it
    // was never written on the way out, so every disconnect, refresh or closed
    // tab threw away whatever had accumulated since the last batch.
    if (authed && _seasonQuests && Object.keys(_seasonQuests).length) {
      await _persistSavedFields(authed, {
        seasonQuests: _seasonQuests, seasonTier: _seasonTierCur,
      });
      _seasonKillsUnsaved = 0;
    }
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
  // _invRev is a per-session counter bumped by every server-side item change.
  // The client echoes back the last value it was told (invRev in saveProgress)
  // and a mismatch means that save was composed before the grant, so its
  // inventory is stale and must not be applied. Never sent to the client for
  // interpretation — it just stores and returns it.
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
    const _before = Array.isArray(_lastStats.inventory) ? _lastStats.inventory.length : 0;
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
    const written = (opts && opts.persist === false) ? null : _persistSavedFields(authed,
      equipment ? { inventory, equipment } : { inventory });
    socket.emit('inventorySync', {
      inventory, equipment: _lastStats.equipment || {}, invRev: _invRev,
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

  socket.data._adminApplyItems = async (inventory, equipment) => {
    if (!authed) return;
    await _commitServerItems(inventory, equipment, 'admin');
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
  socket.data._grantKillLoot = ({ eid, rlvl, isBoss }) => {
    const empty = { items: [], boxUncommon: 0, boxRare: 0, normStone: 0, blessStone: 0 };
    if (!authed || !_lastStats || !Array.isArray(_lastStats.inventory)) return empty;
    const inv = _lastStats.inventory;
    const items = _rollMobLoot(inv, eid, rlvl);
    const _vipBon = VIP_BONUSES[socket.data.vipLevel || 0] || VIP_BONUSES[0];
    if (_vipBon.drop > 0 && Math.random() * 100 < _vipBon.drop) {
      items.push(..._rollMobLoot(inv, eid, rlvl));
    }
    let boxUncommon = 0, boxRare = 0, normStone = 0, blessStone = 0;
    if (isBoss) {
      if (Math.random() < 0.50) { boxUncommon = 1; _invAdd(inv, { ...BOX_DEF.find(b => b.id === 'box_uncommon'), qty: 1 }); }
      if (Math.random() < 0.10) { boxRare = 1; _invAdd(inv, { ...BOX_DEF.find(b => b.id === 'box_rare'), qty: 1 }); }
      if (Math.random() < 0.10) { normStone = 1; _invAdd(inv, { ..._STONE_DEFS.norm_stone, qty: 1 }); }
      if (Math.random() < 0.01) { blessStone = 1; _invAdd(inv, { ..._STONE_DEFS.bless_stone, qty: 1 }); }
    }
    if (items.length || boxUncommon || boxRare || normStone || blessStone) {
      _commitServerItems(inv, null, 'mob_loot', { eid, rlvl, n: items.length, boxUncommon, boxRare, normStone, blessStone });
    }
    return { items, boxUncommon, boxRare, normStone, blessStone };
  };

  // Gold granted by an admin to a player who is online. It has to land in
  // _lastStats, not just in the database: this session's 60s autosave writes
  // _lastStats wholesale, so a grant written only to Mongo was reverted the
  // next time that timer fired (most visibly for a backgrounded mobile client,
  // whose own save — which does carry the grant, see the adminGive handler in
  // js/network.js — may not come for a long time). No double-counting: the
  // client's next save replaces _lastStats rather than adding to it.
  socket.data._adminGiveGold = async (amount) => {
    if (!authed || !Number.isFinite(amount) || amount === 0) return;
    if (!_lastStats) _lastStats = {};
    _lastStats.gold = Math.max(0, (_lastStats.gold || 0) + amount);
    await _persistSavedFields(authed, { gold: _lastStats.gold });
    logPlayer(authed.telegramId, authed.username, 'admin_give_gold_live',
      { amount, balance: _lastStats.gold });
  };

  // Hands the death-battle winner its prize. Lives here rather than beside
  // _dbFinish because this is where the socket's own inventory/GRAM copies
  // are (same reasoning as pickupWorldDrop's award path). Returns the item
  // list so the caller can show it in the win modal, plus whether the prize
  // actually landed in the server-side inventory — see _commitServerItems.
  socket.data._dbGrantWin = async () => {
    if (!authed) return null;
    const items = deathBattleRewards();
    const inv = (_lastStats && Array.isArray(_lastStats.inventory)) ? _lastStats.inventory : null;
    if (inv) items.forEach(it => _invAdd(inv, it));
    const _dbBal = await _incBalance(authed.telegramId, 'gramBalance', DEATH_BATTLE_GRAM_REWARD);
    if (_dbBal !== null) { _gramBalance = _dbBal; socket.emit('gramBalanceUpdate', { balance: _dbBal }); }
    if (inv) await _commitServerItems(inv, null, 'death_battle_win',
      { items: items.map(i => i.id), gram: DEATH_BATTLE_GRAM_REWARD });
    logPlayer(authed.telegramId, authed.username, 'death_battle_win', { gram: DEATH_BATTLE_GRAM_REWARD });
    return { items, delivered: !!inv };
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

  // Pays out a race10 win — same reasoning as _a3GrantWin above.
  socket.data._race10GrantWin = async () => {
    if (!authed) return 0;
    const _rcBal = await _incBalance(authed.telegramId, 'nexumBalance', RACE10_REWARD);
    if (_rcBal !== null) _nexumBalance = _rcBal;
    socket.emit('nexumBalanceUpdate', { balance: _liveNexum() });
    logPlayer(authed.telegramId, authed.username, 'race10_reward',
      { nexum: RACE10_REWARD, balance: _liveNexum() });
    return RACE10_REWARD;
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
      // Progress only. Balances are moved by $inc from their own paths and must
      // never be written as an absolute from here — that is precisely what let
      // a periodic save undo a credit that arrived seconds earlier.
      const saveData = { ..._lastStats, floor: currentFloor };
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

  safeOn('loginTelegramWebApp', async ({ initData }) => {
    try {
      const verified = verifyTelegramWebApp(initData);
      if (!verified) return socket.emit('authError', { message: 'Ошибка авторизации Telegram' });
      const { user, startParam } = verified;
      const telegramId = String(user.id);
      const username = _safeUsername(user.username || user.first_name, telegramId);
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
      _myClanName  = _clanInfo ? _clanInfo.name : null;
      _myClanIcon  = _clanInfo ? _clanInfo.icon : null;
      _myClanId    = _clan ? String(_clan._id) : null;
      _myClanLevel = _clanInfo ? _clanInfo.level : null;
      socket.data.vipLevel = doc.savedData?.vipLevel || 0;
      _setVipAura(doc.username, socket.data.vipLevel);
      socket.emit('authOk', { username: doc.username, savedData: doc.savedData || null, isNewAccount, clanInfo: _clanInfo, gramBalance: _gramBalance, gramWallet: GRAM_WALLET, refLink: _refLink(telegramId), vipData: { level: doc.savedData?.vipLevel || 0, deposited: doc.savedData?.vipDeposited || 0, pending: doc.savedData?.vipPending || [] }, nexumBalance: _nexumBalance, topPlayer: _topPlayerUsername, vipAuras: [..._vipAuraUsers] });
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
      _myClanName  = _clanInfo ? _clanInfo.name : null;
      _myClanIcon  = _clanInfo ? _clanInfo.icon : null;
      _myClanId    = _clan ? String(_clan._id) : null;
      _myClanLevel = _clanInfo ? _clanInfo.level : null;
      socket.data.vipLevel = doc.savedData?.vipLevel || 0;
      _setVipAura(doc.username, socket.data.vipLevel);
      socket.emit('authOk', { username: doc.username, savedData: doc.savedData || null, isNewAccount, clanInfo: _clanInfo, gramBalance: _gramBalance, gramWallet: GRAM_WALLET, refLink: _refLink(telegramId), vipData: { level: doc.savedData?.vipLevel || 0, deposited: doc.savedData?.vipDeposited || 0, pending: doc.savedData?.vipPending || [] }, nexumBalance: _nexumBalance, topPlayer: _topPlayerUsername, vipAuras: [..._vipAuraUsers] });
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
        // Bounded: it is shown to the admin in a Telegram message and stored
        // per request, so there's no reason to accept an arbitrary-length blob.
        memo: String(memo || authed.telegramId).slice(0, 64),
      });
      socket.emit('gramTxCreated', { tx: _txData(tx) });
      logPlayer(authed.telegramId, authed.username, 'gram_deposit_request',
        { amount: Number(amount), tx: tx._id.toString() });
      notifyAdminGram(tx).catch(() => {});
    } catch (err) {
      console.error('gramDepositRequest:', err);
      logPlayerErr(authed.telegramId, authed.username, 'gram_deposit_request', err, { amount });
    }
  });

  safeOn('gramWithdrawRequest', async ({ amount, address }) => {
    if (!authed || !amount || amount < GRAM_MIN_WITHDRAW || !address) return;
    try {
      const amt = Number(amount);
      if (!Number.isFinite(amt) || amt <= 0) return;
      // Any pending drop earnings have to reach the database before the balance
      // is tested, or a player could be told they can't afford a withdrawal
      // they've already earned the GRAM for.
      await _flushBalances();

      // The deduction IS the affordability check: _spendBalance only writes if
      // the stored balance covers the amount, so two withdrawal requests sent
      // together can't both succeed against the same funds. Refunded in full if
      // the admin rejects the request (see _handleAdminCallback).
      const newBal = await _spendBalance(authed.telegramId, 'gramBalance', amt);
      if (newBal === null) return socket.emit('gramError', { msg: 'Недостаточно средств' });
      _gramBalance = newBal;

      let tx;
      try {
        tx = await GramTxModel.create({
          telegramId: authed.telegramId,
          username:   authed.username,
          type: 'withdraw',
          amount: amt,
          address: String(address).slice(0, 128),
        });
      } catch (err) {
        // The money is already out of the account and there is now no request
        // to refund it from — put it back rather than leave the player short.
        const back = await _incBalance(authed.telegramId, 'gramBalance', amt);
        if (back !== null) _gramBalance = back;
        logPlayerErr(authed.telegramId, authed.username, 'gram_withdraw_request', err, { amount: amt, refunded: true });
        return socket.emit('gramError', { msg: 'Не удалось создать заявку — средства возвращены' });
      }

      socket.emit('gramTxCreated', { tx: _txData(tx), newBalance: _gramBalance });
      logPlayer(authed.telegramId, authed.username, 'gram_withdraw_request',
        { amount: amt, newBalance: _gramBalance, tx: tx._id.toString() });
      notifyAdminGram(tx).catch(() => {});
    } catch (err) {
      console.error('gramWithdrawRequest:', err);
      logPlayerErr(authed.telegramId, authed.username, 'gram_withdraw_request', err, { amount });
    }
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
    const _ran = await _withEconLock(async () => {
    try {
      const pkg = _GRAM_SHOP_PKGS.find(p => p.id === pkgId)
                || _SEASON_SHOP_PKGS.find(p => p.id === pkgId);
      if (!pkg) return socket.emit('gramShopError', { msg: 'Пакет не найден' });
      if (_liveGram() < pkg.gram) return socket.emit('gramShopError', { msg: 'Недостаточно GRAM' });

      const doc = await PlayerModel.findById(authed._id);
      if (!doc) return;
      // Drop earnings first, so the price is tested against everything the
      // player has actually earned.
      await _flushBalances();
      const saved = doc.savedData || {};
      const charClass = saved.type || 'lev';
      const wepMap = _SHOP_CLASS_WEAPONS[charClass] || _SHOP_CLASS_WEAPONS.lev;
      // Live copy first — a fresh DB read here is up to ~3s behind (the
      // saveProgress debounce), so building the purchase on it rolled back
      // anything picked up in that window.
      const _liveInv = _liveInventory();
      const inv = _liveInv ? [..._liveInv] : (Array.isArray(saved.inventory) ? [...saved.inventory] : []);

      // Room check before anything is deducted. This used to push items in
      // unconditionally, which is how accounts ended up over the 150-slot cap
      // the client enforces — and once over it, invHasSpace() is false forever:
      // drops stop being picked up and every market cancellation destroys its
      // item. Stackables that merge into an existing entry cost no new slot.
      const _newSlots = _shopNewSlots(pkg, inv, charClass);
      if (inv.length + _newSlots > SERVER_INV_MAX) {
        logPlayer(authed.telegramId, authed.username, 'gram_shop_refused',
          { pkg: pkg.id, need: _newSlots, slots: `${inv.length}/${SERVER_INV_MAX}` });
        return socket.emit('gramShopError', {
          msg: `Нужно ${_newSlots} свободных мест в инвентаре (занято ${inv.length}/${SERVER_INV_MAX})`,
        });
      }

      // The deduction is the affordability check — _spendBalance writes only
      // if the stored balance covers the price (see the balance block at the
      // top of this file), so nothing here can spend GRAM the account doesn't
      // have, whatever the cached figure said a moment ago.
      const _paid = await _spendBalance(authed.telegramId, 'gramBalance', pkg.gram);
      if (_paid === null) return socket.emit('gramShopError', { msg: 'Недостаточно GRAM' });
      _gramBalance = _paid;

      // Gold. Defaulted rather than added raw: the season packages carry no
      // gold at all, and `x + undefined` is NaN — which _sanitizeSavedStats
      // then clamps to 0, i.e. buying a stone pack would have wiped the
      // buyer's gold. Same reasoning for the potion count below.
      saved.gold = (saved.gold || 0) + (pkg.gold || 0);

      // Buff potions (bp_hp/bp_exp/... — ITEM_DEF slot 'buff_potion') are
      // stackable inventory items, not potionBag entries. potionBag only
      // holds pt1/pt2 HP potions; useBuffPotion() (player.js) looks these up
      // via removeFromInventory() against player.inventory, so writing them
      // into potionBag instead — as this used to — meant they were paid for
      // and deducted but never actually reachable anywhere in the UI.
      if (pkg.potions > 0) _VIP_BP.forEach(bp => {
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

      // Enhance stones (сезонные паки). _STONE_DEFS is the same catalog the
      // loot roll grants them from, so a bought stone is identical to a
      // dropped one.
      if (pkg.stones) {
        Object.entries(pkg.stones).forEach(([sid, qty]) => {
          const base = _STONE_DEFS[sid] || CRAFT_MATS.find(m => m.id === sid);
          if (!base) return;
          const existing = inv.find(i => i.id === sid);
          if (existing) existing.qty = (existing.qty || 1) + qty;
          else inv.push({ ...base, qty });
        });
      }

      // Bonus skill points
      if (pkg.bonusSP > 0) saved.bonusSP = (saved.bonusSP || 0) + pkg.bonusSP;

      // Liberty (Nexum) bonus — atomic, like every other balance move.
      if (pkg.nexum > 0) {
        const _nb = await _incBalance(authed.telegramId, 'nexumBalance', pkg.nexum);
        if (_nb !== null) _nexumBalance = _nb;
      }

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
      // No balance fields here: both were already moved with $inc above, and
      // writing an absolute would undo anything that landed in between.
      const _shopSet = {
        'savedData.gold': saved.gold,
        'savedData.inventory': inv,
        'savedData.vipLevel': _vipLvl,
        'savedData.vipDeposited': _vipDep,
        'savedData.vipPending': _vipPend,
      };
      if (pkg.bonusSP > 0) _shopSet['savedData.bonusSP'] = saved.bonusSP;
      await PlayerModel.updateOne({ _id: doc._id }, { $set: _shopSet });

      if (_lastStats) {
        _lastStats.gold = saved.gold;
            if (pkg.bonusSP > 0) _lastStats.bonusSP = saved.bonusSP;
      }
      // Bumps the revision, so a client autosave queued before this purchase
      // can no longer land afterwards and wipe the items out.
      _commitServerItems(inv, null, 'gram_shop', { pkg: pkg.id, gram: pkg.gram });
      socket.data.vipLevel = _vipLvl;
      _setVipAura(authed.username, _vipLvl);

      socket.emit('gramShopResult', {
        pkgId,
        newBalance:  _gramBalance,
        newGold:     saved.gold,
        newInventory: inv,
        invRev:      _invRev,
        newBonusSP:  saved.bonusSP || 0,
        newNexumBalance: _nexumBalance,
        vipData: { level: _vipLvl, deposited: _vipDep, pending: _vipPend },
        leveled: _vipLvl > _prevVipLvl,
      });
      io.to(`tg_${authed.telegramId}`).emit('gramBalanceUpdate', { balance: _gramBalance });
      if (_vipLvl > _prevVipLvl) {
        socket.emit('vipUpdate', { level: _vipLvl, deposited: _vipDep, pending: _vipPend });
      }
    } catch (err) {
      console.error('gramShopBuy:', err);
      logPlayerErr(authed.telegramId, authed.username, 'gram_shop', err, { pkgId });
    }
    });
    if (!_ran) socket.emit('gramShopError', { msg: 'Покупка уже обрабатывается' });
  });

  // ── Reset stat upgrades (Улучшения → Сбросить) ─────────────────────────────
  // Costs Liberty, so the charge has to happen here: Liberty is the one
  // currency the client doesn't own the source of truth for (see craftPet
  // below for the same reasoning).
  //
  // Clearing player.upgrades is all a "refund" needs to be — spent points are
  // never stored, they're derived as lvl*3 + bonusSP minus the sum of the
  // upgrade levels (getAvailableSkillPoints, js/player.js). Emptying the map
  // therefore hands back every point ever put into it, however many that was.
  // Gold spent on those upgrades is deliberately not refunded.
  safeOn('resetUpgrades', async () => {
    if (!authed) return;
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

  // ── Enchant stone crafting — REMOVED ──────────────────────────────────────
  // Stones are no longer craftable at the forge: the recipes are gone from
  // shared/definitions.js and the craftsman UI no longer lists them. The
  // handler stays registered on purpose — a client running a cached bundle
  // still shows the old cell, and answering it with a clear message beats
  // leaving its craft button spinning forever. It grants nothing and charges
  // nothing.
  //
  // Stones themselves are untouched: they still drop from monsters
  // (roomEnchantStoneChance), come with VIP level rewards and are sold in the
  // season packs — only this one route is closed.
  safeOn('craftStone', ({ matId } = {}) => {
    if (!authed) return;
    logPlayer(authed.telegramId, authed.username, 'stone_craft_removed', { matId });
    socket.emit('craftStoneError', { msg: 'Камни заточки больше не создаются в кузнице' });
  });

  // ── Gear crafting (Кузнец → Предметы → все тиры) ───────────────────────────
  // Covers both GEAR_TIER_CRAFT_RECIPES (uncommon/rare — materials only, no
  // nexumCost) and GEAR_CRAFT_RECIPES (epic/legendary — same shape plus a
  // Liberty cost). The uncommon/rare tiers used to be entirely client-
  // computed (js/npc.js's craftSpecificItem rolled the chance and granted the
  // result itself, only ever reaching the server via the next saveProgress
  // blob) — exactly the "items appearing out of nowhere" hole this closes:
  // _canonSavedItem trusts any valid id+enhance on save, no matter how it got
  // there. Unlike stones (chance:1.0), these can genuinely roll a failure —
  // on a miss the mats (and Liberty, where the recipe has one) are still
  // spent, same "materials lost" rule every recipe already applies, only the
  // item isn't granted.
  safeOn('craftGear', async ({ itemId } = {}) => {
    if (!authed) return;
    await _withEconLock(async () => {
    try {
      const rec = GEAR_CRAFT_RECIPES.find(r => r.itemId === itemId)
               || GEAR_TIER_CRAFT_RECIPES.find(r => r.itemId === itemId)
               || UNIQUE_CRAFT_RECIPES.find(r => r.itemId === itemId);
      if (!rec) return socket.emit('craftGearError', { msg: 'Неизвестный рецепт' });
      const resultDef = ITEM_DEF.find(i => i.id === rec.itemId);
      if (!resultDef) return socket.emit('craftGearError', { msg: 'Предмет не найден' });
      if (!_lastStats || !Array.isArray(_lastStats.inventory)) {
        return socket.emit('craftGearError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
      }
      const inv = _lastStats.inventory;
      // A full inventory dooms the craft regardless of how the roll lands —
      // refuse up front rather than spend mats/Liberty on an attempt that
      // could never have delivered the item.
      if (inv.length >= SERVER_INV_MAX) {
        return socket.emit('craftGearError', { msg: 'Инвентарь полон' });
      }
      // Enhanced-gear mats (minEnhance set) are non-stackable items matched
      // by id+enhance, like removeEnhancedItem/countEnhancedItem client-side
      // (js/player.js); plain mats (recipe scrolls) are counted by qty like
      // craftStone's countOf above.
      const matCount = m => m.minEnhance != null
        ? inv.reduce((s, i) => s + (i && i.id === m.id && (i.enhance || 0) >= m.minEnhance ? 1 : 0), 0)
        : inv.reduce((s, i) => s + (i && i.id === m.id ? (i.qty || 1) : 0), 0);
      const matName = id => (ITEM_DEF.find(i => i.id === id) || CRAFT_MATS.find(i => i.id === id) || {}).name || id;
      for (const m of rec.mats) {
        if (matCount(m) < m.n) {
          return socket.emit('craftGearError', { msg: `Нужно ${m.n} × ${matName(m.id)} (есть ${matCount(m)})` });
        }
      }
      // Charged before anything is consumed, and atomically — see craftStone.
      // Uncommon/rare recipes have no nexumCost, so this (and the re-check
      // right after) is skipped entirely for them — nothing to charge.
      if (rec.nexumCost) {
        await _flushBalances();
        const _bal = await _spendBalance(authed.telegramId, 'nexumBalance', rec.nexumCost);
        if (_bal === null) {
          return socket.emit('craftGearError', { msg: `Нужно ${rec.nexumCost} Liberty` });
        }
        _nexumBalance = _bal;
      }
      // Re-checked after the await, same reasoning as craftStone.
      for (const m of rec.mats) {
        if (matCount(m) < m.n) {
          if (rec.nexumCost) {
            const back = await _incBalance(authed.telegramId, 'nexumBalance', rec.nexumCost);
            if (back !== null) _nexumBalance = back;
          }
          return socket.emit('craftGearError', { msg: `Нужно ${m.n} × ${matName(m.id)} (есть ${matCount(m)})` });
        }
      }
      for (const m of rec.mats) {
        let left = m.n;
        for (let i = inv.length - 1; i >= 0 && left > 0; i--) {
          const e = inv[i];
          if (!e || e.id !== m.id) continue;
          if (m.minEnhance != null) {
            if ((e.enhance || 0) < m.minEnhance) continue;
            inv.splice(i, 1); left--;
          } else {
            const have = e.qty || 1;
            if (have > left) { e.qty = have - left; left = 0; }
            else { left -= have; inv.splice(i, 1); }
          }
        }
      }
      // Result enhance mirrors _craftResultEnhance (js/npc.js): comes out 2
      // levels below whatever the consumed base item was required to be.
      const baseMat = rec.mats.find(m => m.minEnhance != null);
      const resultEnhance = baseMat ? Math.max(0, baseMat.minEnhance - 2) : 0;
      const success = Math.random() < rec.chance;
      if (success) {
        // Space was already guaranteed above, so this can only fail if the
        // check there and this add somehow disagree — treat as the same
        // "inventory's full, but the roll already happened" edge case
        // craftStone accepts rather than trying to re-roll or fabricate a
        // refund policy for a case that shouldn't be reachable.
        _invAdd(inv, resultEnhance > 0 ? { ...resultDef, enhance: resultEnhance } : { ...resultDef });
      }
      _commitServerItems(inv, null, 'gear_craft', { itemId, cost: rec.nexumCost, success });
      socket.emit('gearCrafted', { itemId, success, resultEnhance: success ? resultEnhance : 0, newNexumBalance: _nexumBalance });
    } catch (err) {
      console.error('craftGear:', err);
      logPlayerErr(authed.telegramId, authed.username, 'gear_craft', err, { itemId });
      socket.emit('craftGearError', { msg: 'Ошибка сервера' });
    }
    });
  });

  // ── Enhance / заточка (inventory item modal + equipped item modal) ─────────
  // Used to be entirely client-computed (js/ui.js's enhanceItem/enhanceEqItem
  // rolled the success chance themselves and only ever reached the server via
  // the next saveProgress blob) — which is exactly the "items appearing out
  // of nowhere" hole: _canonSavedItem (above) trusts any enhance 0..
  // ENHANCE_MAX on a valid item id, so a modified client could just claim any
  // item already at max enhance without ever spending a stone. The roll, the
  // stone spend and the mutation all happen here now; the client only shows
  // what this event reports.
  //
  // No DB round trip happens before the mutation (stones are paid for out of
  // the in-memory _lastStats.inventory, not a server-tracked balance), so
  // unlike the Liberty-spending crafts above this handler never awaits — it
  // runs start to finish in one tick, which rules out the same-account double
  // -submit race those needed _withEconLock for.
  //
  // Target identity: an equipped slot is unambiguous, but a non-stackable
  // inventory item has no id of its own — id+current-enhance is the same
  // matching scheme craftGear already uses for its minEnhance-gated mats
  // (two copies of the same weapon at the same enhance are interchangeable,
  // so matching the first one found is correct either way).
  safeOn('enhanceItem', ({ id, enhance, stoneType, slot } = {}) => {
    if (!authed) return;
    if (!_lastStats || !Array.isArray(_lastStats.inventory)) {
      return socket.emit('enhanceError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
    }
    const inv = _lastStats.inventory;
    const curEnh = Math.max(0, Math.floor(Number(enhance)) || 0);
    if (curEnh >= ENHANCE_MAX) return socket.emit('enhanceError', { msg: 'Уже максимальная заточка' });

    // "Предмет не найден" means the client is holding something this server
    // does not have — the two inventories have drifted apart. Erroring and
    // stopping there leaves the player stuck on a dead end they cannot clear
    // themselves (every retry re-reads the same stale item), so push the
    // authoritative set back at the same time: the UI corrects itself and a
    // retry works. The log records what the server actually holds for that
    // id, which is what makes the drift diagnosable rather than a guess.
    const _enhNotFound = where => {
      logPlayer(authed.telegramId, authed.username, 'enhance_not_found', {
        id, wantEnhance: curEnh, where, rev: _invRev, invLen: inv.length,
        serverHas: inv.filter(i => i && i.id === id).map(i => i.enhance || 0),
      });
      socket.emit('inventorySync', {
        inventory: inv, equipment: _lastStats.equipment || {}, invRev: _invRev,
      });
      return socket.emit('enhanceError', { msg: 'Предмет не найден' });
    };

    // Where the item currently sits can legitimately differ between the two
    // sides. equip/unequip only move it in the CLIENT's copy and reach the
    // server on a save — and in the hub, with nothing to kill, that save may
    // be seconds away or (on an older client, which never saved on equip at
    // all) not coming. Trusting the client's `slot` and stopping there is
    // exactly what made enhancing a just-crafted, just-equipped pet fail with
    // "Предмет не найден" every single time.
    //
    // So resolve by IDENTITY first — id + current enhance, the same matching
    // scheme used above — and reconcile the location afterwards. Relocating an
    // item between the inventory and an equip slot creates and destroys
    // nothing, so this stays inside the census invariant saveProgress enforces
    // (_itemCensus counts both together); it cannot be used to conjure or
    // upgrade anything, only to agree on where a thing already owned is kept.
    const eq = _lastStats.equipment || {};
    const _matches = it => it && it.id === id && (it.enhance || 0) === curEnh;

    let target = null, targetIdx = -1, targetSlot = null;
    if (slot && _matches(eq[slot])) {
      target = eq[slot];
      targetSlot = slot;
    } else {
      targetIdx = inv.findIndex(_matches);
      if (targetIdx >= 0) {
        target = inv[targetIdx];
      } else {
        // Mirror image: the client has it loose, the server still has it
        // equipped — an unequip that has not been saved yet.
        const found = Object.keys(eq).find(sl => _matches(eq[sl]));
        if (found) { target = eq[found]; targetSlot = found; }
      }
    }
    if (!target) return _enhNotFound(slot ? 'equipped:' + slot : 'inventory');

    // An item may only ever be enhanced in its OWN slot. Without this the
    // relocation below would honour whatever slot name the request carried and
    // file, say, a pet under `weapon` — and since a client sums the stats of
    // every equipment entry regardless of which key it sits under, that is a
    // way to wear one item twice over.
    if (slot && target.slot !== slot) {
      logPlayer(authed.telegramId, authed.username, 'enhance_slot_mismatch',
        { id, claimed: slot, actual: target.slot });
      return _enhNotFound('slot_mismatch:' + slot);
    }

    // The client's placement wins where the two disagree — it is the one the
    // player is looking at — so move the item before the roll below writes the
    // result back. Only the inventory <-> equip-slot direction is reconciled:
    // an item found in a DIFFERENT equip slot than the one named is left where
    // it is (there is nothing sensible to swap it with, and the sync below
    // corrects the client either way). Every move here is one item out of one
    // place and into another, so the totals are unchanged.
    if (slot && targetIdx >= 0) {
      const displaced = eq[slot];
      eq[slot] = target;
      inv.splice(targetIdx, 1);
      if (displaced) inv.push(displaced);   // straight swap, so no slot growth
      _lastStats.equipment = eq;
      targetIdx = -1;
      targetSlot = slot;
    } else if (!slot && targetSlot && inv.length < SERVER_INV_MAX) {
      eq[targetSlot] = null;
      inv.push(target);
      _lastStats.equipment = eq;
      targetIdx = inv.length - 1;
      targetSlot = null;
    }
    // Pets are enhanceable and always have been — the client has offered it
    // for every slot since long before this handler existed (canEnh in
    // js/ui.js is a pure enhance < max test), and players hold pets at +3
    // and above that were enhanced back when the roll happened client-side.
    // Excluding them here made every one of those attempts fail, which is
    // the regression behind the reports about enhancing suddenly breaking.
    if (!ENHANCEABLE_SLOTS.has(target.slot)) {
      return socket.emit('enhanceError', { msg: 'Этот предмет нельзя точить' });
    }

    const stoneId = stoneType === 'bless' ? 'bless_stone' : 'norm_stone';
    const stoneIdx = inv.findIndex(s => s && s.id === stoneId && (s.qty || 1) > 0);
    if (stoneIdx < 0) return socket.emit('enhanceError', { msg: 'Нет камня заточки' });

    const stoneItem = inv[stoneIdx];
    if ((stoneItem.qty || 1) <= 1) {
      inv.splice(stoneIdx, 1);
      if (!targetSlot && stoneIdx < targetIdx) targetIdx--;
    } else {
      stoneItem.qty--;
    }

    // Mirrors _enhSuccessRate (js/ui.js) exactly.
    const rate = Math.max(10, 80 - curEnh * 10);
    const success = Math.random() * 100 < rate;
    let outcome, newEnhance = curEnh;
    if (success) {
      target.enhance = curEnh + 1;
      newEnhance = curEnh + 1;
      outcome = 'success';
    } else if (stoneType === 'bless') {
      outcome = 'fail'; // safe stone: item survives a miss
    } else {
      outcome = 'burned'; // normal stone: item is destroyed on a miss
      if (targetSlot) _lastStats.equipment[targetSlot] = null;
      else inv.splice(targetIdx, 1);
    }

    // Equipment goes along unconditionally: the reconciliation above can have
    // moved the item even when the roll targeted a loose one, and the client
    // rebuilds both halves from this sync — sending only the inventory would
    // leave the two disagreeing again the moment they were made to agree.
    _commitServerItems(inv, _lastStats.equipment || {}, 'enhance',
      { id, stoneType, outcome, fromEnhance: curEnh, slot: targetSlot || null });
    // Season points for a successful enhance. The rarity is re-read from the
    // catalog rather than taken off the entry, so a crafted request cannot
    // claim a common item is worth an uncommon's points. A miss pays nothing.
    if (outcome === 'success') {
      const _eb = _catalogBase(id);
      const _ep = _eb ? (SEASON_ENHANCE_POINTS[_eb.rarity] || 0) : 0;
      if (_ep > 0 && seasonActive()) {
        _seasonAddPoints(_ep, 'enhance', { id, rarity: _eb.rarity, to: newEnhance })
          .then(total => socket.emit('seasonEventDone', { task: 'enhance', points: _ep, total: total ?? null }));
      }
    }
    // targetSlot, not the requested slot: it names where the item actually
    // ended up, which is what the client reopens the modal on.
    socket.emit('enhanceResult', { id, slot: targetSlot || null, outcome, newEnhance });
  });

  // ── Box crafting (Кузнец → Материалы → Боксы, e.g. box_rare from key_rare) ──
  // No currency involved — just an exchange of keys for a box, 100% success —
  // but this was still entirely client-computed (js/npc.js's craftBox),
  // reaching the server only via the next saveProgress blob. Synchronous, no
  // await anywhere, so — like enhanceItem above — there's no window for a
  // double-submit race to land in.
  safeOn('craftBox', ({ boxId } = {}) => {
    if (!authed) return;
    const box = BOX_DEF.find(b => b.id === boxId);
    if (!box) return socket.emit('craftBoxError', { msg: 'Неизвестный бокс' });
    if (!_lastStats || !Array.isArray(_lastStats.inventory)) {
      return socket.emit('craftBoxError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
    }
    const inv = _lastStats.inventory;
    const countOf = id => inv.reduce((s, i) => s + (i && i.id === id ? (i.qty || 1) : 0), 0);
    const have = countOf(box.keyId);
    if (have < box.keyCost) {
      const keyName = (CRAFT_MATS.find(m => m.id === box.keyId) || {}).name || box.keyId;
      return socket.emit('craftBoxError', { msg: `Нужно ${box.keyCost} × ${keyName} (есть ${have})` });
    }
    // A box stacks into an existing entry for free — a new slot is only
    // needed for the first one, same rule _shopNewSlots uses.
    const hasBoxAlready = inv.some(i => i && i.id === box.id);
    if (!hasBoxAlready && inv.length >= SERVER_INV_MAX) {
      return socket.emit('craftBoxError', { msg: 'Инвентарь полон' });
    }
    let left = box.keyCost;
    for (let i = inv.length - 1; i >= 0 && left > 0; i--) {
      const e = inv[i];
      if (!e || e.id !== box.keyId) continue;
      const qty = e.qty || 1;
      if (qty > left) { e.qty = qty - left; left = 0; }
      else { left -= qty; inv.splice(i, 1); }
    }
    _invAdd(inv, { ...box, qty: 1 });
    _commitServerItems(inv, null, 'box_craft', { boxId });
    socket.emit('boxCrafted', { boxId });
  });

  // ── Material tier-up (Кузнец → Материалы → Рецепты, e.g. recu→recr) ────────
  // 20 of the lower recipe scroll → 80% chance at 1 of the next tier —
  // MAT_UPGRADE_RECIPES, shared/definitions.js. Same closing as craftBox
  // above: was entirely client-computed (js/npc.js's craftMatUpgrade), no
  // currency involved, synchronous handler so no double-submit race window.
  safeOn('craftMatUpgrade', ({ from } = {}) => {
    if (!authed) return;
    const rec = MAT_UPGRADE_RECIPES.find(r => r.from === from);
    if (!rec) return socket.emit('craftMatUpgradeError', { msg: 'Неизвестный рецепт' });
    const toMat = CRAFT_MATS.find(m => m.id === rec.to);
    if (!toMat) return socket.emit('craftMatUpgradeError', { msg: 'Материал не найден' });
    if (!_lastStats || !Array.isArray(_lastStats.inventory)) {
      return socket.emit('craftMatUpgradeError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
    }
    const inv = _lastStats.inventory;
    const countOf = id => inv.reduce((s, i) => s + (i && i.id === id ? (i.qty || 1) : 0), 0);
    const have = countOf(rec.from);
    if (have < rec.count) {
      const fromMat = CRAFT_MATS.find(m => m.id === rec.from);
      return socket.emit('craftMatUpgradeError', {
        msg: `Нужно ${rec.count} × ${fromMat ? fromMat.name : rec.from} (есть ${have})`,
      });
    }
    const hasToAlready = inv.some(i => i && i.id === toMat.id);
    if (!hasToAlready && inv.length >= SERVER_INV_MAX) {
      return socket.emit('craftMatUpgradeError', { msg: 'Инвентарь полон' });
    }
    let left = rec.count;
    for (let i = inv.length - 1; i >= 0 && left > 0; i--) {
      const e = inv[i];
      if (!e || e.id !== rec.from) continue;
      const qty = e.qty || 1;
      if (qty > left) { e.qty = qty - left; left = 0; }
      else { left -= qty; inv.splice(i, 1); }
    }
    const success = Math.random() < rec.chance;
    if (success) _invAdd(inv, { ...toMat, qty: 1 });
    _commitServerItems(inv, null, 'mat_upgrade', { from: rec.from, to: rec.to, success });
    socket.emit('matUpgraded', { from: rec.from, to: rec.to, success });
  });

  // ── Loot box opening (inventory item modal → "Открыть") ─────────────────────
  // Rolls a rarity off the box's own odds table, then a random gear item
  // within that rarity — the exact two-step roll js/ui.js's openLootBox used
  // to do itself (weighted rarity, then uniform pick among that rarity's
  // craft-only gear pool), reaching the server only via the next saveProgress
  // blob. The server now owns both rolls and the grant; the pool mirrors
  // _boxCandidates (js/ui.js) exactly — no cloak/artifact (craft-only), and a
  // weapon only comes up for the buyer's own class.
  safeOn('openLootBox', ({ id } = {}) => {
    if (!authed) return;
    const boxDef = BOX_DEF.find(b => b.id === id);
    if (!boxDef) return socket.emit('openBoxError', { msg: 'Неизвестный бокс' });
    if (!_lastStats || !Array.isArray(_lastStats.inventory)) {
      return socket.emit('openBoxError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
    }
    const inv = _lastStats.inventory;
    const boxIdx = inv.findIndex(i => i && i.id === id);
    if (boxIdx < 0) return socket.emit('openBoxError', { msg: 'Бокс не найден' });

    // The box is spent whether or not the pool below turns out to have
    // anything in it — same "spent regardless of outcome" rule every other
    // recipe here follows.
    const boxItem = inv[boxIdx];
    if ((boxItem.qty || 1) <= 1) inv.splice(boxIdx, 1);
    else boxItem.qty--;

    const r = Math.random();
    let acc = 0, resultRarity = boxDef.odds[boxDef.odds.length - 1].rarity;
    for (const o of boxDef.odds) {
      acc += o.chance;
      if (r < acc) { resultRarity = o.rarity; break; }
    }

    const charClass = _lastStats.type || 'lev';
    const gearSlots = ['weapon', 'helmet', 'body', 'gloves', 'boots', 'ring', 'belt'];
    const cands = ITEM_DEF.filter(d => d.rarity === resultRarity && !d.noDrop && gearSlots.includes(d.slot) &&
      (d.slot !== 'weapon' || (d.forClass && d.forClass.includes(charClass))));
    const wonItem = cands.length ? cands[Math.floor(Math.random() * cands.length)] : null;
    const granted = wonItem ? _invAdd(inv, { ...wonItem }) : false;

    _commitServerItems(inv, null, 'box_open', { boxId: id, wonItemId: wonItem ? wonItem.id : null, granted });
    socket.emit('boxOpened', { boxId: id, item: granted ? wonItem : null });
  });

  // ── Pet crafting (Кузнец → Материалы → Питомцы) ────────────────────────────
  // Costs Liberty (Nexum), which — unlike gold — is server-granted/server-
  // authoritative only (see _nexumBalanceCache above), so unlike every other
  // craft in this game this can't be a client-computed spend: the client
  // would just be trusted to decrement a balance it doesn't actually own the
  // source of truth for. Mirrors gramShopBuy below: server checks the live
  // balance, deducts it, and picks+returns the random result itself — the
  // client only ever displays what this event reports back.
  safeOn('craftPet', async ({ rarity } = {}) => {
    if (!authed) return;
    // Serialized like the other spend handlers — the charge below is a DB
    // round trip, and two crafts overlapping across it would interleave their
    // inventory writes.
    await _withEconLock(async () => {
    try {
      const rec = PET_CRAFT_RECIPES.find(r => r.rarity === rarity);
      if (!rec) return socket.emit('petCraftError', { msg: 'Неизвестная редкость питомца' });
      if (!_lastStats || !Array.isArray(_lastStats.inventory)) {
        return socket.emit('petCraftError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
      }
      if (_lastStats.inventory.length >= SERVER_INV_MAX) {
        return socket.emit('petCraftError', { msg: 'Инвентарь полон' });
      }
      const candidates = ITEM_DEF.filter(d => d.slot === 'pet' && d.rarity === rarity);
      if (!candidates.length) return socket.emit('petCraftError', { msg: 'Питомцы этой редкости не найдены' });

      // Atomic charge — the roll below only happens if the Liberty was really
      // taken. A failed craft (rec.chance) still costs, as it always has.
      await _flushBalances();
      const _bal = await _spendBalance(authed.telegramId, 'nexumBalance', rec.nexumCost);
      if (_bal === null) return socket.emit('petCraftError', { msg: 'Недостаточно Liberty' });
      _nexumBalance = _bal;

      let resultPet = null, _delivered = false;
      if (Math.random() < rec.chance) {
        resultPet = { ...candidates[Math.floor(Math.random() * candidates.length)] };
        _delivered = _invAdd(_lastStats.inventory, resultPet);
      }
      _commitServerItems(_lastStats.inventory, null, 'pet_craft',
        { rarity, cost: rec.nexumCost, got: resultPet ? resultPet.id : null });

      socket.emit('petCrafted', {
        pet: resultPet, newNexumBalance: _nexumBalance, delivered: _delivered,
      });
    } catch (err) {
      console.error('craftPet:', err);
      logPlayerErr(authed.telegramId, authed.username, 'pet_craft', err, { rarity });
      socket.emit('petCraftError', { msg: 'Ошибка сервера' });
    }
    });
  });

  // ── Class cloak/artifact crafting (Кузнец → Материалы → Плащи и артефакты
  // классов) ──────────────────────────────────────────────────────────────
  // Costs Liberty on top of salvaging junk gear of the target rarity
  // (CLASS_GEAR_SALVAGE_RECIPES, shared/definitions.js) — same reasoning as
  // craftStone/craftGear above: Liberty is server-authoritative, so the whole
  // exchange (material count + Liberty charge + random item grant) has to
  // happen here rather than being client-computed.
  safeOn('craftClassGear', async ({ slot, rarity } = {}) => {
    if (!authed) return;
    await _withEconLock(async () => {
    try {
      const rec = CLASS_GEAR_SALVAGE_RECIPES.find(r => r.resultSlot === slot && r.resultRarity === rarity);
      if (!rec) return socket.emit('craftClassGearError', { msg: 'Неизвестный рецепт' });
      const candidates = ITEM_DEF.filter(d => d.classItem && d.slot === rec.resultSlot && d.rarity === rec.resultRarity);
      if (!candidates.length) return socket.emit('craftClassGearError', { msg: 'Предметы этой редкости не найдены' });
      if (!_lastStats || !Array.isArray(_lastStats.inventory)) {
        return socket.emit('craftClassGearError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
      }
      const inv = _lastStats.inventory;
      if (inv.length >= SERVER_INV_MAX) {
        return socket.emit('craftClassGearError', { msg: 'Инвентарь полон' });
      }
      // Salvage material: any non-stackable item of the matching rarity —
      // same "junk gear" definition the client's inventory panel uses.
      const matCount = () => inv.reduce((s, i) => s + (i && !isStackableItem(i) && i.rarity === rec.costRarity ? 1 : 0), 0);
      if (matCount() < rec.costCount) {
        return socket.emit('craftClassGearError', { msg: `Нужно ${rec.costCount} предметов редкости «${rec.costRarity}» (есть ${matCount()})` });
      }
      // Charged before anything is consumed, and atomically — see craftStone.
      await _flushBalances();
      const _bal = await _spendBalance(authed.telegramId, 'nexumBalance', rec.nexumCost);
      if (_bal === null) {
        return socket.emit('craftClassGearError', { msg: `Нужно ${rec.nexumCost} Liberty` });
      }
      _nexumBalance = _bal;
      // Re-checked after the await, same reasoning as craftStone/craftGear.
      if (matCount() < rec.costCount) {
        const back = await _incBalance(authed.telegramId, 'nexumBalance', rec.nexumCost);
        if (back !== null) _nexumBalance = back;
        return socket.emit('craftClassGearError', { msg: `Нужно ${rec.costCount} предметов редкости «${rec.costRarity}» (есть ${matCount()})` });
      }
      let left = rec.costCount;
      for (let i = inv.length - 1; i >= 0 && left > 0; i--) {
        const e = inv[i];
        if (e && !isStackableItem(e) && e.rarity === rec.costRarity) { inv.splice(i, 1); left--; }
      }
      const resultItem = { ...candidates[Math.floor(Math.random() * candidates.length)] };
      const _delivered = _invAdd(inv, resultItem);
      _commitServerItems(inv, null, 'class_gear_craft',
        { slot: rec.resultSlot, rarity: rec.resultRarity, cost: rec.nexumCost, got: resultItem.id });
      socket.emit('classGearCrafted', { item: resultItem, newNexumBalance: _nexumBalance, delivered: _delivered });
    } catch (err) {
      console.error('craftClassGear:', err);
      logPlayerErr(authed.telegramId, authed.username, 'class_gear_craft', err, { slot, rarity });
      socket.emit('craftClassGearError', { msg: 'Ошибка сервера' });
    }
    });
  });

  // ── Market ────────────────────────────────────────────────────────────────
  // GRAM movement is fully server-authoritative (same balance/cache pattern as
  // the wallet above). The item itself is trusted from the client at the same
  // level as the rest of the inventory system — this game doesn't otherwise
  // keep a server-side copy of item stats to validate against.
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
    const lvl = _lastStats ? _lastStats.lvl : 1;
    return _seasonTierAllowed(_seasonTierCur, lvl) ? _seasonTierCur : SEASON_TIER_DEFAULT;
  }

  // The active band's quest, created on first use. An unknown species (a save
  // from before this existed, or a table change) is re-rolled rather than
  // trusted.
  function _seasonQuest() {
    if (!_lastStats) return null;
    const tid = _seasonTierId();
    const q = _seasonQuests[tid];
    const lvl = Math.max(1, Math.floor(Number(_lastStats.lvl)) || 1);
    const def = q && typeof q === 'object' ? seasonTier(tid).species.find(s => s.sp === q.sp) : null;
    if (def && (def.req || 0) <= lvl) return q;
    const fresh = { sp: _seasonRollSpecies(null, _lastStats.lvl, tid), kills: 0 };
    _seasonQuests[tid] = fresh;
    _persistSavedFields(authed, { seasonQuests: _seasonQuests, seasonTier: tid });
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
    const lvl = _lastStats ? (Math.floor(Number(_lastStats.lvl)) || 1) : 1;
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
    if (!authed || !Number.isFinite(n) || n <= 0) return null;
    if (!seasonActive()) {
      logPlayer(authed.telegramId, authed.username, 'season_points_failed',
        { add: n, reason, why: 'season_over', ...(meta || {}) });
      return null;
    }
    try {
      // An account that only ever pressed /start has savedData: null, and a
      // dotted $inc against a null parent THROWS instead of creating it — the
      // same trap _incBalance documents. Without this the award was lost and
      // the only trace was a console line.
      await PlayerModel.updateOne(
        { telegramId: String(authed.telegramId), savedData: null },
        { $set: { savedData: {} } },
      );
      const doc = await PlayerModel.findOneAndUpdate(
        { telegramId: String(authed.telegramId) },
        { $inc: { 'savedData.seasonPoints': n } },
        { new: true, projection: { 'savedData.seasonPoints': 1 } },
      ).lean();
      // No document matched: nothing was incremented. This used to fall
      // through to `total = 0`, which both reported success to the caller AND
      // wiped the running total held in memory — a failed award turned into a
      // reset to zero. Report the failure instead and leave _seasonPoints be.
      if (!doc) {
        logPlayer(authed.telegramId, authed.username, 'season_points_failed',
          { add: n, reason, why: 'player_not_found', ...(meta || {}) });
        return null;
      }
      const total = Math.max(0, Math.floor(Number(doc?.savedData?.seasonPoints) || 0));
      _seasonPoints = total;
      logPlayer(authed.telegramId, authed.username, 'season_points', { add: n, total, reason, ...(meta || {}) });
      return total;
    } catch (err) {
      console.error('_seasonAddPoints:', err);
      // Both rows on purpose: the 'error' one so it shows under Ошибки with a
      // stack message, and the durable season one so it survives the ordinary
      // log's 100-row window like every other points movement.
      logPlayerErr(authed.telegramId, authed.username, 'season_points', err, { add: n, reason, ...(meta || {}) });
      logPlayer(authed.telegramId, authed.username, 'season_points_failed',
        { add: n, reason, why: 'db_error', message: err && err.message, ...(meta || {}) });
      return null;
    }
  }

  // Called on every kill. Progress lives in _lastStats and is only written out
  // every SEASON_FLUSH_EVERY kills (and on completion) — a 5000-kill quest
  // would otherwise be 5000 database writes per player.
  const SEASON_FLUSH_EVERY = 10;
  function _seasonTrackKill(result) {
    if (!authed || !_lastStats || !seasonActive()) return;
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
        _persistSavedFields(authed, { seasonQuests: _seasonQuests });
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
    _persistSavedFields(authed, { seasonQuests: _seasonQuests });
    const doneSp = q.sp;
    _seasonAddPoints(SEASON_QUEST_POINTS, 'quest', { sp: doneSp, tier: tid, kills: q.kills })
      .then(total => {
        _seasonQuestAwarding = false;
        if (total === null) {
          // Not rolled over — the player keeps the completed quest and the
          // next kill retries the award.
          logPlayer(authed.telegramId, authed.username, 'season_quest_award_failed',
            { sp: doneSp, tier: tid, points: SEASON_QUEST_POINTS, kills: q.kills });
          return;
        }
        const next = { sp: _seasonRollSpecies(doneSp, _lastStats.lvl, tid), kills: 0 };
        _seasonQuests[tid] = next;
        _seasonKillsUnsaved = 0;
        _persistSavedFields(authed, { seasonQuests: _seasonQuests });
        logPlayer(authed.telegramId, authed.username, 'season_quest_done',
          { sp: doneSp, tier: tid, points: SEASON_QUEST_POINTS, total, next: next.sp });
        socket.emit('seasonQuestDone', {
          sp: doneSp, points: SEASON_QUEST_POINTS, total,
          next: _seasonQuestPublic(next, tid),
        });
      })
      .catch(err => {
        _seasonQuestAwarding = false;
        logPlayerErr(authed.telegramId, authed.username, 'season_quest_award', err, { sp: doneSp, tier: tid });
      });
  }
  socket.data._seasonTrackKill = _seasonTrackKill;

  // Repeatable event tasks (SEASON_EVENT_TASKS). Each pays once per
  // occurrence and then arms again — the caller decides what "an occurrence"
  // is, because only it knows: one 3v3 match, one death-battle round, one
  // world-boss appearance. Nothing is stored per task beyond what is needed
  // to stop a single occurrence paying twice.
  function _seasonAwardEvent(taskId) {
    if (!authed || !seasonActive()) return;
    if (!SEASON_EVENT_TASKS.some(t => t.id === taskId)) return;
    // A failed award is only reported to the client as `total: null`, which
    // it cannot distinguish from "no total to show" — so the miss is recorded
    // here as well, where an admin can actually find it.
    _seasonAddPoints(SEASON_EVENT_POINTS, 'event', { task: taskId }).then(total => {
      if (total === null) return;   // _seasonAddPoints already logged why
      socket.emit('seasonEventDone', { task: taskId, points: SEASON_EVENT_POINTS, total });
    }).catch(err => logPlayerErr(authed.telegramId, authed.username, 'season_event', err, { task: taskId }));
  }
  socket.data._seasonAwardEvent = _seasonAwardEvent;

  // Winning one, on top of the participation points above. Called from the
  // match-end paths (_dbFinish / _a3Finish), which already know who took it —
  // this side only turns that into points, so there is no way to claim a win
  // from a client message.
  function _seasonAwardWin(taskId) {
    if (!authed || !seasonActive()) return;
    const pts = SEASON_WIN_POINTS[taskId] || 0;
    if (pts <= 0) return;
    _seasonAddPoints(pts, 'win', { task: taskId }).then(total => {
      if (total === null) return;   // _seasonAddPoints already logged why
      socket.emit('seasonEventDone', { task: taskId, points: pts, total, win: true });
    }).catch(err => logPlayerErr(authed.telegramId, authed.username, 'season_win', err, { task: taskId }));
  }
  socket.data._seasonAwardWin = _seasonAwardWin;

  // Which world boss this session has already been paid for. The boss keeps
  // one id for its whole appearance, so remembering the last one paid is
  // enough to make it once-per-boss no matter how many times it is hit —
  // otherwise every swing would be worth points.
  let _seasonBossPaid = null;
  function _seasonTrackBossHit(enemyId) {
    if (!authed || !seasonActive() || !enemyId) return;
    if (!String(enemyId).startsWith('evtboss_')) return;
    if (_seasonBossPaid === enemyId) return;
    _seasonBossPaid = enemyId;
    _seasonAwardEvent('worldboss');
  }
  socket.data._seasonTrackBossHit = _seasonTrackBossHit;

  // Re-reads the running total from the database. Points can now be added by
  // somebody ELSE's session — the referral bonus is paid to the referrer, who
  // may well be online at the time — so the closure copy is no longer the only
  // writer and a stale one would show the panel a number that is too low.
  async function _seasonReloadPoints() {
    if (!authed) return _seasonPoints;
    try {
      const doc = await PlayerModel.findById(authed._id, 'savedData.seasonPoints').lean();
      const total = Math.max(0, Math.floor(Number(doc?.savedData?.seasonPoints) || 0));
      _seasonPoints = total;
    } catch (err) { console.error('_seasonReloadPoints:', err); }
    return _seasonPoints;
  }

  safeOn('seasonSync', async () => {
    if (!authed) return;
    await _seasonReloadPoints();
    socket.emit('seasonState', _seasonPublicState());
  });

  // Switching the quest band (10+ / 20+). The other band's quest is left
  // untouched, so coming back resumes it — see _seasonQuests.
  safeOn('seasonSetTier', ({ tier } = {}) => {
    if (!authed || !_lastStats) return;
    const t = SEASON_TIERS.find(x => x.id === String(tier));
    if (!t) return;
    if (!_seasonTierAllowed(t.id, _lastStats.lvl)) {
      return socket.emit('seasonError', { msg: `Нужен ${t.reqLvl} уровень` });
    }
    if (_seasonTierCur !== t.id) {
      // Whatever the old band had counted since its last flush would be lost
      // otherwise: the counter is per-session, not per-band.
      if (_seasonKillsUnsaved > 0) {
        _seasonKillsUnsaved = 0;
        _persistSavedFields(authed, { seasonQuests: _seasonQuests });
      }
      _seasonTierCur = t.id;
      _persistSavedFields(authed, { seasonTier: t.id });
    }
    socket.emit('seasonState', _seasonPublicState());
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
      const mine = _seasonPoints;
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

  safeOn('seasonBurn', async ({ idx } = {}) => {
    if (!authed) return;
    await _withEconLock(async () => {
      try {
        if (!seasonActive()) return socket.emit('seasonBurnError', { msg: 'Сезон завершён' });
        const inv = _liveInventory();
        if (!inv) return socket.emit('seasonBurnError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
        const i = Math.floor(Number(idx));
        if (!Number.isFinite(i) || i < 0 || i >= inv.length) return;
        const pts = _burnValue(inv[i]);
        if (!pts) return socket.emit('seasonBurnError', { msg: 'Этот предмет нельзя сжечь' });
        const burned = inv[i];
        inv.splice(i, 1);
        _commitServerItems(inv, null, 'season_burn', { itemId: burned.id, points: pts });
        const total = await _seasonAddPoints(pts, 'burn', { itemId: burned.id, n: 1 });
        socket.emit('seasonBurned', { burned: 1, points: pts, total: total ?? null });
      } catch (err) {
        console.error('seasonBurn:', err);
        logPlayerErr(authed.telegramId, authed.username, 'season_burn', err, { idx });
        socket.emit('seasonBurnError', { msg: 'Ошибка сервера' });
      }
    });
  });

  // Bulk form — burning a full inventory one tap at a time is not a real
  // option. Equipped items are untouched: this only ever walks the inventory.
  safeOn('seasonBurnAll', async ({ rarity } = {}) => {
    if (!authed) return;
    await _withEconLock(async () => {
      try {
        if (!seasonActive()) return socket.emit('seasonBurnError', { msg: 'Сезон завершён' });
        if (!SEASON_BURN_POINTS[rarity]) return socket.emit('seasonBurnError', { msg: 'Эту редкость нельзя сжечь' });
        const inv = _liveInventory();
        if (!inv) return socket.emit('seasonBurnError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
        let burned = 0, pts = 0;
        for (let i = inv.length - 1; i >= 0; i--) {
          const it = inv[i];
          const base = it && _catalogBase(it.id);
          if (!base || base.rarity !== rarity) continue;
          const v = _burnValue(it);
          if (!v) continue;
          inv.splice(i, 1);
          burned++; pts += v;
        }
        if (!burned) return socket.emit('seasonBurnError', { msg: 'Нечего сжигать' });
        _commitServerItems(inv, null, 'season_burn_all', { rarity, burned, points: pts });
        const total = await _seasonAddPoints(pts, 'burn_all', { rarity, n: burned });
        socket.emit('seasonBurned', { burned, points: pts, total: total ?? null });
      } catch (err) {
        console.error('seasonBurnAll:', err);
        logPlayerErr(authed.telegramId, authed.username, 'season_burn_all', err, { rarity });
        socket.emit('seasonBurnError', { msg: 'Ошибка сервера' });
      }
    });
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

    const inv = _lastStats.inventory;
    const rewardIds = Array.isArray(q.reward.items) ? q.reward.items : [];
    const items = [];
    rewardIds.forEach(id => {
      const def = ITEM_DEF.find(d => d.id === id) || CRAFT_MATS.find(d => d.id === id) || BOX_DEF.find(d => d.id === id);
      if (def && _invAdd(inv, { ...def, qty: 1 })) items.push({ id: def.id, name: def.name, rarity: def.rarity });
    });
    const gold = Math.max(0, Math.floor(Number(q.reward.gold)) || 0);
    if (gold) _lastStats.gold = Math.max(0, (_lastStats.gold || 0) + gold);
    // Advancing here is what closes the replay: a second claim finds
    // questIdx already past this quest and is refused above. questKills is
    // reset for the same reason the client resets it — the next quest counts
    // from zero.
    _lastStats.questIdx = cur + 1;
    _lastStats.questKills = {};
    _commitServerItems(inv, null, 'quest_reward', { questId: q.id, idx: cur, gold, items: items.map(i => i.id) });
    _persistSavedFields(authed, { gold: _lastStats.gold, questIdx: _lastStats.questIdx, questKills: {} });
    logPlayer(authed.telegramId, authed.username, 'quest_reward', { questId: q.id, idx: cur, gold, xp: q.reward.xp || 0 });
    socket.emit('questClaimed', {
      idx: cur, questId: q.id, gold, xp: Math.max(0, Math.floor(Number(q.reward.xp)) || 0),
      items, newGold: _lastStats.gold, questIdx: _lastStats.questIdx,
    });
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
  safeOn('sellItem', async ({ idx } = {}) => {
    if (!authed) return;
    await _withEconLock(async () => {
      try {
        const inv = _liveInventory();
        if (!inv) return socket.emit('sellItemError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
        const i = Math.floor(Number(idx));
        if (!Number.isFinite(i) || i < 0 || i >= inv.length) return;
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
            _commitServerItems(inv, null, 'sell_common', { itemId: it.id, gold: SELL_COMMON_PRICE });
        await _persistSavedFields(authed, { gold: _lastStats.gold });
        socket.emit('itemSold', { gold: SELL_COMMON_PRICE, newGold: _lastStats.gold });
      } catch (err) {
        console.error('sellItem:', err);
        logPlayerErr(authed.telegramId, authed.username, 'sell_common', err, { idx });
        socket.emit('sellItemError', { msg: 'Ошибка сервера' });
      }
    });
  });

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
    // Exactly the condition _invAdd would refuse on, checked BEFORE the claim
    // consumes the pile: a stackable only rides in for free when a stack of
    // it already exists, so one with no existing stack needs a slot just like
    // a non-stackable does. Testing only the non-stackable case (as this used
    // to) meant a stackable drop landing on a full inventory was claimed off
    // the floor and then dropped on the way in — destroyed rather than left
    // for someone else. The client used to paper over that by adding it
    // locally on delivered:false, which is precisely the kind of client-side
    // grant the save path no longer accepts.
    const _wouldStack = inv && isStackableItem(peek.item) && inv.some(i => i && i.id === peek.item.id);
    if (inv && !_wouldStack && inv.length >= SERVER_INV_MAX) {
      return socket.emit('worldDropError', { msg: 'Инвентарь полон' });
    }
    const drop = currentRoom.claimWorldDrop(id, p.x, p.y);
    if (!drop) return;
    const _delivered = !!(inv && _invAdd(inv, drop.item));
    if (_delivered) {
      _commitServerItems(inv, null, 'world_drop', { item: drop.item && drop.item.id });
    }
    socket.emit('worldDropPicked', { id: drop.id, item: drop.item, delivered: _delivered });
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
    if ((socket.data.vipLevel || 0) < 1) {
      return socket.emit('marketListError', { msg: 'Продажа на маркете доступна с VIP 1' });
    }
    const now = Date.now();
    if (now - _lastMarketListAt < MARKET_LIST_COOLDOWN_MS) {
      return socket.emit('marketListError', { msg: 'Слишком часто — подождите немного' });
    }
    // Only id + enhance are trusted from the client — every other field
    // (stats, rarity, name, img...) is rebuilt from the canonical catalog.
    // Computed before the price check below: the minimum price depends on
    // which item this actually is (see _marketMinPrice).
    const canonItem = _canonicalMarketItem(item);
    if (!canonItem) {
      return socket.emit('marketListError', { msg: 'Такого предмета не существует' });
    }
    const p = Number(price);
    const minPrice = _marketMinPrice(canonItem);
    if (!Number.isFinite(p) || p < minPrice || p > MARKET_MAX_PRICE) {
      return socket.emit('marketListError', { msg: `Цена должна быть от ${minPrice} до ${MARKET_MAX_PRICE} GRAM` });
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
      _commitServerItems(_lastStats.inventory, null, 'market_list',
        { item: canonItem.id, enhance: canonItem.enhance || 0, qty: canonItem.qty || 1, price: _round2(p) });
      socket.emit('marketListed', { listing: _marketListingData(listing) });
    } catch (err) {
      console.error('marketList:', err);
      _lastMarketListAt = _prevListAt;
      logPlayerErr(authed.telegramId, authed.username, 'market_list', err,
        { item: canonItem && canonItem.id });
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
      const _returned = !!(_sellerInv && _invAdd(_sellerInv, listing.item));
      if (_returned) {
        _commitServerItems(_sellerInv, null, 'market_cancel',
          { item: listing.item && listing.item.id, listingId: String(listingId) });
      } else {
        // Cancelled but not returned server-side — the client is the only
        // copy holding it now, so make that visible rather than silent.
        logPlayer(authed.telegramId, authed.username, 'market_cancel_noroom',
          { item: listing.item && listing.item.id, listingId: String(listingId),
            slots: _sellerInv ? _sellerInv.length : null });
      }
      socket.emit('marketCancelled', { listingId, item: listing.item, delivered: _returned });
    } catch (err) {
      console.error('marketCancel:', err);
      logPlayerErr(authed.telegramId, authed.username, 'market_cancel', err, { listingId: String(listingId) });
    }
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

      // Room for the item BEFORE any money moves. The client used to just
      // report "инвентарь полон, предмет потерян" after the fact — the GRAM
      // was already gone and the item was destroyed with the listing marked
      // sold. Refuse the trade instead and put the lot back up.
      const _buyerInv = (_lastStats && Array.isArray(_lastStats.inventory)) ? _lastStats.inventory : null;
      if (_buyerInv && !isStackableItem(claimed.item) && _buyerInv.length >= SERVER_INV_MAX) {
        await _releaseClaim(listingId);
        return socket.emit('marketError', { msg: 'Инвентарь полон' });
      }
      // Payment is the affordability check: _spendBalance only writes if the
      // balance covers the price, so two purchases in flight can't be paid for
      // out of the same GRAM. Pending drop earnings are flushed first so the
      // player can spend what they've just farmed.
      await _flushBalances();
      const _paid = await _spendBalance(authed.telegramId, 'gramBalance', claimed.price);
      if (_paid === null) {
        await _releaseClaim(listingId);
        return socket.emit('marketError', { msg: 'Недостаточно GRAM' });
      }
      _gramBalance = _paid;
      // The item is delivered server-side so a marketBought event that never
      // reaches the client (disconnect, lost packet) can't leave the buyer
      // having paid for nothing.
      const _delivered = !!(_buyerInv && _invAdd(_buyerInv, claimed.item));
      if (_delivered) {
        _commitServerItems(_buyerInv, null, 'market_buy',
          { item: claimed.item && claimed.item.id, price: claimed.price,
            seller: claimed.sellerId, listingId: String(listingId) });
      }

      // Credit the seller (10% fee burned — not paid to anyone), online or not.
      // A plain "+payout" against the live document: the seller may be farming,
      // spending or being paid by someone else at this very moment, and this is
      // the pattern that stops any of those erasing the sale — the reported
      // "продал лот, а GRAM не пришли / баланс перезаписался".
      const payout = _round7(claimed.price * (1 - MARKET_FEE_PCT));
      try {
        const sellerNewBal = await _incBalance(claimed.sellerId, 'gramBalance', payout);
        if (sellerNewBal === null) throw new Error('seller not found');
        io.to(`tg_${claimed.sellerId}`).emit('gramBalanceUpdate', { balance: sellerNewBal });
        io.to(`tg_${claimed.sellerId}`).emit('marketSold', {
          itemName: claimed.item?.name || '', price: claimed.price, payout,
          buyerUsername: authed.username, newBalance: sellerNewBal,
        });
        logPlayer(claimed.sellerId, claimed.sellerUsername, 'market_sold',
          { item: claimed.item && claimed.item.id, price: claimed.price, payout,
            buyer: authed.username, balance: sellerNewBal });
      } catch (err) {
        console.error('marketBuy seller payout:', err);
        logPlayerErr(claimed.sellerId, claimed.sellerUsername, 'market_sold_payout', err,
          { listingId: String(listingId), payout });
      }

      socket.emit('marketBought', {
        listingId, item: claimed.item, newBalance: _gramBalance, delivered: _delivered,
      });
    } catch (err) {
      console.error('marketBuy:', err);
      logPlayerErr(authed.telegramId, authed.username, 'market_buy', err, { listingId: String(listingId) });
    }
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
        // One query for every clan's members instead of one aggregate per clan
        // in a loop: this handler is rate-limited as a heavy event (40 per 5s
        // per socket), so at a few dozen clans the old shape let a single
        // client queue thousands of aggregations against the same connection
        // pool everyone's saves share.
        const _allMemberIds = [...new Set(clans.flatMap(c => (c.members || []).map(m => m.telegramId)))];
        const _bmDocs = _allMemberIds.length
          ? await PlayerModel.find({ telegramId: { $in: _allMemberIds } }, 'telegramId bm').lean()
          : [];
        const _bmByTid = new Map(_bmDocs.map(d => [d.telegramId, d.bm || 0]));
        const clanBm = [];
        for (const clan of clans) {
          if (!clan.members?.length) continue;
          clanBm.push({
            name: clan.name,
            icon: clan.icon,
            memberCount: clan.members.length,
            totalBm: clan.members.reduce((s, m) => s + (_bmByTid.get(m.telegramId) || 0), 0),
          });
        }
        clanBm.sort((a, b) => b.totalBm - a.totalBm);
        socket.emit('ratingData', { tab: 'clans', rows: clanBm.slice(0, 50) });
      }
    } catch (err) { console.error('getRating:', err); }
  });

  safeOn('claimVipRewards', async () => {
    if (!authed) return;
    // Serialized: vipPending is read here and only cleared after an await, so
    // two claims in one tick both saw the same pending list and each handed
    // out the full item set. See _withEconLock.
    await _withEconLock(async () => {
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
      const inv = _liveInv ? [..._liveInv] : (Array.isArray(saved.inventory) ? [...saved.inventory] : []);
      let goldReward = 0;
      let outOfRoom = false;
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
          } else {
            const ex = inv.find(i => i.id === item.id);
            if (ex) ex.qty = (ex.qty || 1) + (item.qty || 1);
            else {
              if (inv.length >= SERVER_INV_MAX) { outOfRoom = true; break; }
              inv.push({ ...item });
            }
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
  });

  safeOn('selectChar', ({ type, savedStats }) => {
    if (!authed) return;
    // authed.savedData is the DB-loaded record for this account (single save
    // blob, not per-type slots). If the client sent no savedStats — e.g. it
    // raced a fast refresh before its own savedData snapshot arrived — fall
    // back to the server's copy instead of leaving _lastStats unset, which
    // would let the next debounced saveProgress persist fresh/default stats
    // over real progress.
    //
    // A client can also send a well-formed but BLANK object here — a fresh
    // makePlayer() sent by a socket.io reconnect that raced ahead of its own
    // restoreFromSave (a flaky/slow connection during the loading window is
    // exactly what triggers this: see the _playerRestored guard in
    // js/network.js's authOk handler). That object is truthy, so it slips
    // past the "sent nothing" fallback above. Catch it the same way
    // saveProgress already catches a blank autosave — refuse to let it
    // overwrite a real DB record, which is what _lastStats (read by every
    // later saveProgress's own catastrophic-reset check) would otherwise be
    // poisoned with for the rest of this connection.
    const sanitized = _sanitizeSavedStats(savedStats || null);
    const blankOverReal = sanitized && authed.savedData && _looksLikeCatastrophicReset(authed.savedData, sanitized);
    const effectiveSaved = blankOverReal
      ? _sanitizeSavedStats(authed.savedData)
      : (sanitized || _sanitizeSavedStats(authed.savedData || null));
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
    if (effectiveSaved) {
      const _dbBase = _sanitizeSavedStats(authed.savedData) || null;
      const _over = _censusOverflow(_itemCensus(effectiveSaved), _itemCensus(_dbBase));
      if (_over) {
        effectiveSaved.inventory = (_dbBase && _dbBase.inventory) || [];
        effectiveSaved.equipment = (_dbBase && _dbBase.equipment) || {};
        effectiveSaved.storage   = (_dbBase && _dbBase.storage)   || [];
        logPlayer(authed.telegramId, authed.username, 'select_items_forged', {
          item: _over.key, had: _over.had, sent: _over.sent,
        });
        console.error(`[selectChar] Rejected minted items for telegramId=${authed.telegramId}` +
          ` (${_over.key}: had ${_over.had}, claimed ${_over.sent})`);
      }
      _lastStats = effectiveSaved;
    }
    // Season state is read straight off the stored record. It is never part of
    // the client blob — the sanitizer strips both fields so they can't be
    // written by the people competing for the prize — so this is the only
    // point at which it enters the session.
    {
      const _sd = authed.savedData || {};
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
      // Migration: before the bands existed there was a single seasonQuest,
      // and it was always a 10+ one. Carried across so nobody loses progress
      // to the upgrade.
      if (!_seasonQuests[SEASON_TIER_DEFAULT]) {
        const q = _readQuest(_sd.seasonQuest, SEASON_TIER_DEFAULT);
        if (q) _seasonQuests[SEASON_TIER_DEFAULT] = q;
      }
      _seasonTierCur = SEASON_TIERS.some(x => x.id === _sd.seasonTier)
        ? _sd.seasonTier : SEASON_TIER_DEFAULT;
    }
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
      currentRoom = getRoom(currentFloor);
      playerFloorMap.set(socket.id, currentFloor);
      socket.join(`floor_${currentFloor}`);
      const { staleSocketId } = currentRoom.addPlayer(socket.id, authed.username, _myClanName, _myClanIcon, clanAtkBonusPct(_myClanLevel), authed.telegramId);
      // A stale room entry for this same account (see addPlayer's comment)
      // was just dropped — tell other clients immediately instead of waiting
      // for that old socket's own (possibly delayed) disconnect to do it, so
      // this account never briefly renders as two players on screen.
      if (staleSocketId) socket.to(`floor_${currentFloor}`).emit('playerLeft', { id: staleSocketId });
      socket.to(`floor_${currentFloor}`).emit('playerJoined', { id: socket.id, username: authed.username });
      if (globalChatHistory.length) socket.emit('chatHistory', _publicChatHistory());
    }
    currentRoom.setPlayerChar(socket.id, type, effectiveSaved);
    socket.to(`floor_${currentFloor}`).emit('playerChar', { id: socket.id, type });
    socket.emit('gameStart', {
      floor: currentFloor,
      // The map itself is fetched over HTTP and cached by the browser — see
      // /api/world-map above. Only its name travels here.
      mapVersion: currentRoom.mapVersion,
      enemies: currentRoom.enemySnapshot(socket.id),
      bossStatus: currentRoom.getBossStatus(),
      // So someone logging in mid-countdown still sees the timer, and someone
      // arriving after the kill still sees loot already lying on the floor.
      eventBoss: eventBossState(),
      deathBattle: { ..._dbPublicState(), registered: _db.reg.has(socket.id) },
      race10: { ..._race10PublicState(), registered: _race10.queue.has(socket.id) },
      arena3: { ..._a3PublicState(), registered: _a3.queue.has(socket.id) },
    });
    // MUST come after gameStart: its client handler rebuilds otherPlayers from
    // scratch (`otherPlayers = new Map()`), so a roster delivered before it was
    // wiped on arrival and nobody ever saw anyone else's pet.
    // Whole roster to the arriving player, their own pet to everyone else —
    // same shape both ways, so a missed update self-heals on the next join.
    socket.emit('playerPets', { pets: currentRoom.petSnapshot() });
    const _selfPet = currentRoom.players.get(socket.id);
    if (_selfPet && _selfPet.petId) {
      socket.to(`floor_${currentFloor}`).emit('playerPet', { id: socket.id, petId: _selfPet.petId });
    }
  });

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

  // `amount` is validated as a real number before it goes anywhere near hp.
  // Math.min('x', 200) is NaN, and NaN assigned to hp is permanent: every
  // damage path writes Math.max(0, NaN - dmg) === NaN back, and `hp <= 0` is
  // false for NaN — so one malformed packet made a player unkillable until
  // respawn, which is worth real money in the death battle/arena/tower.
  safeOn('usePotion', ({ amount } = {}) => {
    if (!currentRoom) return;
    const n = Number(amount);
    currentRoom.healPlayer(socket.id, Number.isFinite(n) ? Math.max(0, Math.min(n, 200)) : 60);
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

  safeOn('attack', ({ enemyId } = {}) => {
    if (!_atkAllowed()) return;
    if (!currentRoom) return;
    if (_pvpFrozen(socket.id)) return;
    if (currentRoom.isPlayerInSafeZone(socket.id)) return;
    // Arena3 guard boss: the owning team can't damage its own — the only
    // team check needed here, since attackEnemy already refuses anything
    // dead/out of range on its own.
    const _a3TargetEnemy = currentRoom._enemyMap.get(enemyId);
    if (_a3TargetEnemy && _a3TargetEnemy.a3Team && _a3.teams.get(socket.id) === _a3TargetEnemy.a3Team) return;
    const result = currentRoom.attackEnemy(socket.id, enemyId);
    if (!result) return;
    if (_race10TrackHit(socket.id, enemyId, result)) return;
    // Fear kills still pay out xp/gold through the normal path below — this
    // only advances the wave counter (spawns the next wave, or ends the run
    // on FEAR_MAX_WAVE), so it doesn't gate the rest of the handler.
    if (result.killed && result.arm === 'fear') _fearTrackKill(socket.id, result);
    if (result.killed) _seasonTrackKill(result);
    // "Ударить Мирового босса" — any landed hit counts, and it pays once
    // per boss appearance rather than once per swing.
    _seasonTrackBossHit(enemyId);
    if (result.a3Team) {
      // Visual-only kill broadcast (no xp/gold/loot fields) so every client's
      // enemyKilled handler plays the death animation and removes the corpse
      // — otherwise the boss would just freeze on screen since _a3Finish
      // despawns it server-side before the next tick ever reports hp: 0.
      _emitToEnemyViewers(currentRoom, enemyId, 'enemyKilled',
        { id: enemyId, ex: result.ex, ey: result.ey, color: result.color });
      _a3Finish(result.a3Team === 'A' ? 'B' : 'A', false);
      return;
    }
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
      const nexumDrop  = Math.random() < (NEXUM_DROP_CHANCE[_arm] || 0) ? 1 : 0;
      const gramDrop   = Math.random() < GRAM_DROP_CHANCE ? (result.rlvl || 1) * GRAM_PER_LEVEL : 0;
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
        ? winnerSocket.data._grantKillLoot({ eid: result.eid, rlvl: result.rlvl, isBoss: result.isBoss })
        : { items: [], boxUncommon: 0, boxRare: 0, normStone: 0, blessStone: 0 };

      if (memberIds.length > 0) {
        const totalMembers = memberIds.length + 1;
        const xpShare   = Math.max(1, Math.round(result.xp / totalMembers));
        const goldShare = Math.round(result.gold / totalMembers);

        socket.emit('enemyKilled', {
          id: enemyId, xp: xpShare, gold: goldShare,
          dmg: result.dmg, isCrit: result.isCrit, ex: result.ex, ey: result.ey, color: result.color,
          eid: result.eid, rlvl: result.rlvl,
          ...(lootWinnerId === socket.id ? lootResult : null),
          nexum: nexumDrop, gram: gramDrop,
        });
        memberIds.forEach(mid => {
          io.to(mid).emit('enemyKilled', {
            id: enemyId, xp: xpShare, gold: goldShare,
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
        socket.emit('enemyKilled', {
          id: enemyId, xp: result.xp, gold: result.gold,
          dmg: result.dmg, isCrit: result.isCrit, ex: result.ex, ey: result.ey, color: result.color,
          eid: result.eid, rlvl: result.rlvl, ...lootResult, nexum: nexumDrop, gram: gramDrop,
        });
        _emitToEnemyViewers(currentRoom, enemyId, 'enemyKilled',
          { id: enemyId, ex: result.ex, ey: result.ey, color: result.color }, [socket.id]);
      }
      _onKillClanXp();
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

  safeOn('skillAttack', ({ enemyId, multiplier } = {}) => {
    if (!_atkAllowed()) return;
    if (_pvpFrozen(socket.id)) return;
    if (!currentRoom) return;
    if (currentRoom.isPlayerInSafeZone(socket.id)) return;
    const _a3TargetEnemy2 = currentRoom._enemyMap.get(enemyId);
    if (_a3TargetEnemy2 && _a3TargetEnemy2.a3Team && _a3.teams.get(socket.id) === _a3TargetEnemy2.a3Team) return;
    const result = currentRoom.skillAttackEnemy(socket.id, enemyId, multiplier);
    if (!result) return;
    if (_race10TrackHit(socket.id, enemyId, result)) return;
    // Fear kills still pay out xp/gold through the normal path below — this
    // only advances the wave counter (spawns the next wave, or ends the run
    // on FEAR_MAX_WAVE), so it doesn't gate the rest of the handler.
    if (result.killed && result.arm === 'fear') _fearTrackKill(socket.id, result);
    if (result.killed) _seasonTrackKill(result);
    // "Ударить Мирового босса" — any landed hit counts, and it pays once
    // per boss appearance rather than once per swing.
    _seasonTrackBossHit(enemyId);
    if (result.a3Team) {
      // Visual-only kill broadcast (no xp/gold/loot fields) so every client's
      // enemyKilled handler plays the death animation and removes the corpse
      // — otherwise the boss would just freeze on screen since _a3Finish
      // despawns it server-side before the next tick ever reports hp: 0.
      _emitToEnemyViewers(currentRoom, enemyId, 'enemyKilled',
        { id: enemyId, ex: result.ex, ey: result.ey, color: result.color });
      _a3Finish(result.a3Team === 'A' ? 'B' : 'A', false);
      return;
    }
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
      const nexumDrop2 = Math.random() < (NEXUM_DROP_CHANCE[_arm2] || 0) ? 1 : 0;
      const gramDrop2  = Math.random() < GRAM_DROP_CHANCE ? (result.rlvl || 1) * GRAM_PER_LEVEL : 0;
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
        ? winnerSocket.data._grantKillLoot({ eid: result.eid, rlvl: result.rlvl, isBoss: result.isBoss })
        : { items: [], boxUncommon: 0, boxRare: 0, normStone: 0, blessStone: 0 };
      if (memberIds.length > 0) {
        const totalMembers = memberIds.length + 1;
        const xpShare = Math.max(1, Math.round(result.xp / totalMembers)), goldShare = Math.round(result.gold / totalMembers);
        socket.emit('enemyKilled', {
          id: enemyId, xp: xpShare, gold: goldShare, dmg: result.dmg, isCrit: result.isCrit,
          ex: result.ex, ey: result.ey, color: result.color,
          eid: result.eid, rlvl: result.rlvl,
          ...(lootWinnerId === socket.id ? lootResult : null),
          nexum: nexumDrop2, gram: gramDrop2,
        });
        memberIds.forEach(mid => {
          io.to(mid).emit('enemyKilled', {
            id: enemyId, xp: xpShare, gold: goldShare,
            ex: result.ex, ey: result.ey, color: result.color,
            eid: result.eid, rlvl: result.rlvl,
            ...(lootWinnerId === mid ? lootResult : null),
          });
        });
        _emitToEnemyViewers(currentRoom, enemyId, 'enemyKilled',
          { id: enemyId, ex: result.ex, ey: result.ey, color: result.color }, [socket.id, ...memberIds]);
      } else {
        socket.emit('enemyKilled', {
          id: enemyId, xp: result.xp, gold: result.gold, dmg: result.dmg, isCrit: result.isCrit,
          ex: result.ex, ey: result.ey, color: result.color,
          eid: result.eid, rlvl: result.rlvl, ...lootResult, nexum: nexumDrop2, gram: gramDrop2,
        });
        _emitToEnemyViewers(currentRoom, enemyId, 'enemyKilled',
          { id: enemyId, ex: result.ex, ey: result.ey, color: result.color }, [socket.id]);
      }
      _onKillClanXp();
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

  safeOn('playerInvis', ({ invis } = {}) => {
    if (!currentRoom) return;
    const p = currentRoom.players.get(socket.id);
    if (p) p._invis = !!invis;
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

  safeOn('pvpSkillAttack', ({ targetId, multiplier } = {}) => {
    // Was the only combat handler outside the attack limiter, i.e. in the
    // 300 events/s bucket.
    if (!_atkAllowed()) return;
    if (!currentRoom) return;
    if (_pvpFrozen(socket.id) || _pvpFrozen(targetId)) return;
    if (_isPvpImmune(socket.id, targetId)) return;
    const result = currentRoom.pvpSkillAttack(socket.id, targetId, multiplier);
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
    if (currentRoom) currentRoom.respawnPlayer(socket.id);
  });

  // ── Death Battle (Битва на смерть) ─────────────────────────────────────────
  safeOn('deathBattleRegister', () => {
    if (!authed) return;
    if (_db.phase !== 'reg') return socket.emit('deathBattleError', { msg: 'Регистрация закрыта' });
    const cp = currentRoom?.players.get(socket.id);
    if (!cp) return socket.emit('deathBattleError', { msg: 'Выберите персонажа' });
    if (_fear.has(socket.id)) return socket.emit('deathBattleError', { msg: 'Вы сейчас в Страхе' });
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

  // ── 3v3 Arena ─────────────────────────────────────────────────────────────
  safeOn('arena3Register', async () => {
    if (!authed) return;
    if (_a3.live && _a3.teams.has(socket.id)) return;
    if (_a3.phase !== 'reg') return socket.emit('arena3Error', { msg: 'Арена 3х3 открыта с 21:00 до 22:00 по Москве' });
    const cp = currentRoom?.players.get(socket.id);
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
    if (_race10.alive.has(socket.id)) {
      return socket.emit('arena3Error', { msg: 'Вы сейчас в Кровавой Башне' });
    }
    if (_fear.has(socket.id)) {
      return socket.emit('arena3Error', { msg: 'Вы сейчас в Страхе' });
    }
    const lvl = (_lastStats && _lastStats.lvl) || 1;
    if (lvl < ARENA3_MIN_LEVEL) {
      return socket.emit('arena3Error', { msg: `Нужен ${ARENA3_MIN_LEVEL} уровень` });
    }
    const left = await _arena3AttemptsLeft(socket.id);
    if (left <= 0) {
      return socket.emit('arena3Error', { msg: 'Попытки на арену на сегодня закончились' });
    }
    _a3.queue.set(socket.id, { name: authed.username, lvl });
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
    if (!authed) return;
    if (_race10.live && _race10.alive.has(socket.id)) return;
    if (_race10.phase !== 'reg') return socket.emit('race10Error', { msg: 'Кровавая Башня открыта в 20:30 по Москве, всего на 5 минут' });
    const cp = currentRoom?.players.get(socket.id);
    if (!cp) return socket.emit('race10Error', { msg: 'Выберите персонажа' });
    if (_db.reg.has(socket.id) || _db.alive.has(socket.id)) {
      return socket.emit('race10Error', { msg: 'Вы уже записаны на битву на смерть' });
    }
    if (_a3.live && _a3.teams.has(socket.id)) {
      return socket.emit('race10Error', { msg: 'Вы сейчас на арене 3х3' });
    }
    if (_fear.has(socket.id)) {
      return socket.emit('race10Error', { msg: 'Вы сейчас в Страхе' });
    }
    const lvl = (_lastStats && _lastStats.lvl) || 1;
    if (lvl < RACE10_MIN_LEVEL) {
      return socket.emit('race10Error', { msg: `Нужен ${RACE10_MIN_LEVEL} уровень` });
    }
    const left = await _race10AttemptsLeft(socket.id);
    if (left <= 0) {
      return socket.emit('race10Error', { msg: 'Попытки в Кровавую Башню на сегодня закончились' });
    }
    // Registering no longer risks starting the race — it begins on its own
    // timer with whoever is signed up by then.
    _race10.queue.set(socket.id, { name: authed.username, lvl });
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
    if (!authed) return;
    if (_fear.has(socket.id)) return; // already running — the client shouldn't offer the button
    if (!currentRoom) return;
    const cp = currentRoom.players.get(socket.id);
    if (!cp) return socket.emit('fearError', { msg: 'Выберите персонажа' });
    if (_db.reg.has(socket.id) || _db.alive.has(socket.id)) {
      return socket.emit('fearError', { msg: 'Вы уже записаны на битву на смерть' });
    }
    if (_a3.live && _a3.teams.has(socket.id)) {
      return socket.emit('fearError', { msg: 'Вы сейчас на арене 3х3' });
    }
    if (_race10.live && _race10.alive.has(socket.id)) {
      return socket.emit('fearError', { msg: 'Вы сейчас в Кровавой Башне' });
    }
    const lvl = (_lastStats && _lastStats.lvl) || 1;
    if (lvl < FEAR_MIN_LEVEL) {
      return socket.emit('fearError', { msg: `Нужен ${FEAR_MIN_LEVEL} уровень` });
    }
    const left = await _fearAttemptsLeft(socket.id);
    if (left <= 0) {
      return socket.emit('fearError', { msg: 'Попытки в Страх на сегодня закончились' });
    }
    // Checked before the attempt is spent, and again implicitly by
    // fearDeploy itself (which re-derives occupancy from live state) — a
    // refusal here must never cost the player one of their two runs.
    const spot = currentRoom.fearDeploy(socket.id);
    if (!spot) {
      return socket.emit('fearError', {
        msg: `Все ${currentRoom.fearLaneCount()} залов заняты — дождитесь, пока кто-нибудь выйдет`,
      });
    }
    _lockFearDaily(socket.id);
    _fearStartWave(currentRoom, socket.id, spot.lane, 1);
    socket.emit('fearStarted', { x: spot.x, y: spot.y, hp: cp.hp, maxWave: FEAR_MAX_WAVE, attemptsLeft: left - 1 });
  });

  safeOn('fearSync', async () => {
    const run = _fear.get(socket.id);
    socket.emit('fearState', {
      maxAttempts: FEAR_ATTEMPTS, maxWave: FEAR_MAX_WAVE, minLevel: FEAR_MIN_LEVEL,
      attemptsLeft: await _fearAttemptsLeft(socket.id),
      inRun: !!run, wave: run?.wave || 0,
      freeLanes: currentRoom ? currentRoom.fearFreeLaneCount() : null,
      totalLanes: currentRoom ? currentRoom.fearLaneCount() : null,
    });
  });

  // Sent once the player closes the fear result modal — same reasoning as
  // race10Return/arena3Return: server-side position was already reset when
  // the run ended (_fearFinish), this just makes the client catch up
  // visually if it somehow missed the fearFinished payload's x/y.
  safeOn('fearReturn', () => {
    const spot = currentRoom ? currentRoom.deathBattleReturn(socket.id) : null;
    if (spot) socket.emit('deathBattleReturned', spot);
  });

  // Sent once the player closes the race10 result modal — same reasoning as
  // arena3Return below (server-side position was already reset when the race
  // ended; this just makes the client catch up visually).
  safeOn('race10Return', () => {
    const spot = currentRoom ? currentRoom.deathBattleReturn(socket.id) : null;
    if (spot) socket.emit('deathBattleReturned', spot);
  });

  // Sent once the player closes the arena3 result modal. Server-side position
  // was already reset to the hub spawn when the match ended (eliminated
  // players get it immediately via arena3Eliminated; survivors get it inside
  // _a3Finish) — this just tells THIS client to catch up visually, same as
  // deathBattleReturn below does for the death battle's winner. Safe to call
  // any time (not gated on being mid-match): deathBattleReturn always just
  // re-lands the caller on the hub spawn.
  safeOn('arena3Return', () => {
    const spot = currentRoom ? currentRoom.deathBattleReturn(socket.id) : null;
    if (spot) socket.emit('deathBattleReturned', spot);
  });

  // Sent once the winner closes the reward modal — everyone else was already
  // sent back (to wherever they each were, see dbReturnToPrevSpot) the
  // moment they were eliminated; the winner is left standing in the arena
  // until this. Own event name (not the shared 'deathBattleReturned'
  // arena3Return/race10Return use) so the client can label this teleport
  // correctly — it lands somewhere different (the winner's own pre-battle
  // spot) from what that event means for those other two.
  safeOn('deathBattleReturn', () => {
    if (_db.winnerId !== socket.id) return; // see _db.winnerId — not a free teleport home
    _db.winnerId = null;
    const spot = currentRoom ? currentRoom.dbReturnToPrevSpot(socket.id) : null;
    if (spot) socket.emit('deathBattleReturnedPrev', spot);
  });

  safeOn('deathBattleSync', () => {
    socket.emit('deathBattleState', { ..._dbPublicState(), registered: _db.reg.has(socket.id) });
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
    });
  });

  safeOn('healParty', ({ amount } = {}) => {
    if (!authed || !currentRoom) return;
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
      const target = _socketForTelegramId(m.telegramId);
      if (target) target.emit('clanChatMsg', { username: authed.username, text: msg });
    }
  });

  safeOn('clanChatHistory', async () => {
    if (!authed) return;
    const clan = await ClanModel.findOne({ 'members.telegramId': authed.telegramId }).catch(() => null);
    socket.emit('clanChatHistory', { messages: clan ? (clanChatHistory.get(String(clan._id)) || []) : [] });
  });

  // "Translate" button on a chat bubble (global/clan/DM alike — this only
  // ever sees the message text, never which channel it came from). Keyed by
  // reqId so a reply can't land on the wrong bubble if the player fires off
  // several translate clicks before any of them come back.
  safeOn('translateChat', async ({ text, target, reqId } = {}) => {
    if (!authed || !text || typeof text !== 'string') return;
    const now = Date.now();
    if (now - _lastTranslateAt < 1000) return;
    _lastTranslateAt = now;
    const msg = text.slice(0, 200);
    const lang = (typeof target === 'string' && /^[a-z]{2}$/.test(target)) ? target : 'en';
    try {
      const translated = await _translateText(msg, lang);
      socket.emit('translateChatResult', { reqId, text: translated });
    } catch (err) {
      _logHandlerErr('translateChat', err);
      socket.emit('translateChatResult', { reqId, error: true });
    }
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

  safeOn('saveProgress', ({ stats } = {}) => {
    if (!authed) return;
    // Sanitize the client blob before it becomes the server's source of truth
    // for BM/combat stats and before it's persisted (anti-cheat — see
    // _sanitizeSavedStats). gram/nexum are never taken from here.
    const clean = _sanitizeSavedStats(stats);
    // Stale-inventory guard. A save composed before the last server-side item
    // change carries an inventory that predates it, and taking it at face
    // value is what reverted shop packs and market cancellations. Keep the
    // server's copy for those two fields, accept everything else in the save
    // (position, hp, xp... are all still current), and push the authoritative
    // items back so the client stops resending the stale set.
    const _clientRev = Math.floor(Number(stats && stats.invRev)) || 0;
    if (_clientRev !== _invRev && _lastStats) {
      const _rejected = Array.isArray(clean.inventory) ? clean.inventory.length : 0;
      clean.inventory = _lastStats.inventory || [];
      clean.equipment = _lastStats.equipment || {};
      // The single most useful line when a player says an item vanished: it
      // records that a save arrived carrying a pre-grant inventory and was
      // overruled, rather than that happening invisibly.
      logPlayer(authed.telegramId, authed.username, 'save_stale_items', {
        clientRev: _clientRev, serverRev: _invRev,
        rejectedSlots: _rejected, keptSlots: clean.inventory.length,
      });
      socket.emit('inventorySync', {
        inventory: clean.inventory, equipment: clean.equipment, invRev: _invRev,
      });
    }
    // Anti-duplication. Enforced on EVERY save, including ones whose invRev
    // matched — that token only orders saves against grants, it never proves
    // entitlement (the client is what supplies it). See _itemCensus.
    //
    // Baseline is this session's live copy, or the stored one when the save
    // arrives before selectChar has established it. A brand-new character
    // legitimately owns nothing at all (js/player.js starts inventory,
    // equipment and storage empty — the free potions live in potionBag, not
    // in items), so an absent baseline is an EMPTY census rather than a free
    // pass: the very first save of a new account can't smuggle items in
    // either.
    const _itemBase = _lastStats || _sanitizeSavedStats(authed.savedData) || null;
    const _grew = _censusOverflow(_itemCensus(clean), _itemCensus(_itemBase));
    if (_grew) {
      // Items are dropped as a set rather than trimmed to the legal subset:
      // once a save is known to be forged there is nothing in its item
      // fields worth salvaging, and the authoritative copy is right here.
      clean.inventory = (_itemBase && _itemBase.inventory) || [];
      clean.equipment = (_itemBase && _itemBase.equipment) || {};
      clean.storage   = (_itemBase && _itemBase.storage)   || [];
      logPlayer(authed.telegramId, authed.username, 'save_items_forged', {
        item: _grew.key, had: _grew.had, sent: _grew.sent,
        clientRev: _clientRev, serverRev: _invRev,
      });
      console.error(`[saveProgress] Rejected minted items for telegramId=${authed.telegramId}` +
        ` (${_grew.key}: had ${_grew.had}, save claimed ${_grew.sent})`);
      socket.emit('inventorySync', {
        inventory: clean.inventory, equipment: clean.equipment, invRev: _invRev,
      });
    }

    // Story progress only ever moves forward. questIdx is what makes a quest
    // reward once-only (see the claimQuest handler), and it rides in on this
    // same client blob — so a save that rewinds it would let the same quest
    // be claimed for its reward again and again. It also keeps a save that
    // was composed before a claim from undoing the advance.
    if (_lastStats) {
      const _prevQ = Math.floor(Number(_lastStats.questIdx)) || 0;
      const _newQ = Math.floor(Number(clean.questIdx)) || 0;
      if (_newQ < _prevQ) {
        clean.questIdx = _prevQ;
        // questKills belongs to whichever quest is current, so it has to come
        // back with it rather than being carried over from the rewound one.
        clean.questKills = _lastStats.questKills || {};
        // And the client has to be told, or it keeps its rewound counter and
        // every claim from here on names a quest the server considers done —
        // which is the same permanent dead end the claim handler guards
        // against. Overwhelmingly this is an ordinary stale save rather than
        // anything deliberate, so it is corrected, not punished.
        socket.emit('questSync', { questIdx: _prevQ, questKills: clean.questKills });
      }
    }

    // A server-side gold spend the client may not have known about yet. Only a
    // save composed BEFORE the spend is corrected — savedAt is the client's own
    // "when I built this blob" stamp, so a later save has already had the
    // deduction applied to it (or the player has earned since, which is theirs
    // to keep). Either way the pending spend is cleared: it corrects at most
    // one save, so it can never charge twice.
    if (_pendingGoldSpend) {
      if (Date.now() > _pendingGoldSpend.until) {
        _pendingGoldSpend = null;
      } else if ((Math.floor(Number(clean.savedAt)) || 0) < _pendingGoldSpend.at) {
        const was = Math.floor(Number(clean.gold) || 0);
        clean.gold = Math.max(0, was - _pendingGoldSpend.amount);
        logPlayer(authed.telegramId, authed.username, 'gold_spend_reapplied',
          { reason: _pendingGoldSpend.reason, amount: _pendingGoldSpend.amount,
            saveHad: was, now: clean.gold });
        socket.emit('goldSync', { gold: clean.gold });
        _pendingGoldSpend = null;
      } else {
        _pendingGoldSpend = null;   // this save already accounts for the spend
      }
    }

    if (_looksLikeCatastrophicReset(_lastStats, clean)) {
      logPlayer(authed.telegramId, authed.username, 'save_reset_blocked', {
        hadLvl: _lastStats.lvl, hadGold: _lastStats.gold,
        hadItems: (_lastStats.inventory || []).length,
        hadEquip: Object.keys(_lastStats.equipment || {}).length,
      });
      console.error(`[saveProgress] Rejected suspicious full-reset for telegramId=${authed.telegramId} ` +
        `(had lvl=${_lastStats.lvl} gold=${_lastStats.gold} items=${(_lastStats.inventory || []).length} ` +
        `equip=${Object.keys(_lastStats.equipment || {}).length} — incoming save was blank). Keeping previous state.`);
      return;
    }
    _lastStats = clean;
    authed.bm = calcBM(clean);
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
    _saveDebounceTimer = setTimeout(() => {
      if (!authed) return;
      // Progress only — balances move by $inc from their own paths. `clean` has
      // already had both stripped by _sanitizeSavedStats, so nothing here can
      // reintroduce a client-supplied figure either.
      _persistSavedFields(authed, { ...clean }, { bm: authed.bm });
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

  // Answered straight from this Room's own record of the target (see
  // Room.publicProfile) instead of relaying to their client — that earlier
  // approach could go unanswered forever if their client was slow, on a
  // menu, or gone. The requester can only ever target someone currently
  // rendered in their own view, so they're guaranteed to be in this same
  // Room; the null case below is just the rare race of them disconnecting
  // in the instant between being targeted and the tap landing.
  safeOn('requestPlayerProfile', ({ targetId }) => {
    if (!authed || typeof targetId !== 'string' || !currentRoom) return;
    const raw = currentRoom.publicProfile(targetId);
    if (!raw) return socket.emit('playerProfileResult', { fromId: targetId, fromName: null, profile: null });
    const { upgrades, ...profile } = raw;
    profile.bm = calcBM({ lvl: raw.lvl, atk: raw.atk, def: raw.def, maxHp: raw.maxHp, upgrades });
    socket.emit('playerProfileResult', { fromId: targetId, fromName: raw.name, profile });
  });

  safeOn('partyLeave', () => {
    const partyId = playerParty.get(socket.id);
    if (partyId) _removeFromParty(partyId, socket.id);
  });

  // ── Clan handlers ─────────────────────────────────────────────
  // _clanDataFor / _notifyClan now live at module scope (see the clan helpers
  // block above) — they take no closure state, and the batched XP flusher
  // needs them too.

  safeOn('clanCreate', async ({ name, icon }) => {
    if (!authed) return;
    // Same normalisation player names get (_safeUsername): a clan tag is shown
    // over every member's head and in other players' panels, so it must not be
    // able to carry markup or control characters either.
    const n = _sanitizeName(name).slice(0, 10).trim();
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
      _myClanName  = _cd ? _cd.name : null;
      _myClanIcon  = _cd ? _cd.icon : null;
      _myClanId    = _cd ? String(_cd._id) : null;
      _myClanLevel = _cd ? _cd.level : null;
      currentRoom?.setPlayerClan(socket.id, _myClanName, _myClanIcon, clanAtkBonusPct(_myClanLevel));
      // Founding a clan makes any application still pending elsewhere moot —
      // without this it could sit in that other clan's queue and get approved
      // later, leaving this account in two clans at once.
      await _clearOtherClanApplications(authed.telegramId);
    } catch (e) {
      if (e.code === 11000) socket.emit('clanError', { msg: 'Название занято' });
      else socket.emit('clanError', { msg: 'Ошибка создания' });
    }
  });

  safeOn('clanSetDescription', async ({ description } = {}) => {
    if (!authed) return;
    const clan = await ClanModel.findOne({ 'members.telegramId': authed.telegramId }).catch(() => null);
    if (!clan) return;
    if (clan.members.find(m => m.telegramId === authed.telegramId)?.role !== 'leader') return;
    clan.description = _sanitizeClanDesc(description);
    await clan.save().catch(() => {});
    await _notifyClan(clan);
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
    await _clearOtherClanApplications(authed.telegramId, clan._id);
    if (clan.applications.find(a => a.telegramId === authed.telegramId)) return;
    clan.applications.push({ telegramId: authed.telegramId, username: authed.username });
    await clan.save().catch(() => {});
    // Dedicated event rather than piggybacking the generic 'clanError' channel
    // with a checkmark-prefixed message — the client needs to tell this success
    // apart from an actual error to give the applied button its own confirmed
    // state instead of a toast that reads as a warning.
    socket.emit('clanApplySent', { clanId: String(clan._id) });
    await _notifyClan(clan);
  });

  // On-demand clan refresh, for when the player opens the clan tab. Replaces
  // what the per-kill clanData push used to do by accident — it kept the XP
  // bar live at the cost of a full clan read + packet on every monster death.
  // One read when the panel is actually being looked at is the same
  // information for a rounding error of the cost. Rate-limited as a heavy
  // event like every other clan handler.
  safeOn('clanRequest', async () => {
    if (!authed || !_myClanId) return;
    const clan = await ClanModel.findById(_myClanId).catch(() => null);
    if (!clan) return socket.emit('clanData', null);
    socket.emit('clanData', await _clanDataFor(clan, authed.telegramId));
  });

  safeOn('clanApprove', async ({ telegramId }) => {
    if (!authed) return;
    const clan = await ClanModel.findOne({ 'members.telegramId': authed.telegramId }).catch(() => null);
    if (!clan) return;
    if (clan.members.find(m => m.telegramId === authed.telegramId)?.role !== 'leader') return;
    const app = clan.applications.find(a => a.telegramId === telegramId);
    if (!app) return;
    // Membership cap. Checked here rather than at clanApply so a full clan can
    // still collect applications for whenever a slot frees up; the leader just
    // can't approve past the limit.
    if (clan.members.length >= CLAN_MAX_MEMBERS) {
      return socket.emit('clanError', { msg: `В клане максимум ${CLAN_MAX_MEMBERS} участников` });
    }
    // $pull + $push instead of mutating the document and calling save(): a
    // full-document write here loses whatever else changed since this copy was
    // read (another approval, someone leaving, a level-up from the XP flusher).
    // The filters make it once-only too — approving the same application twice
    // can't add the member twice.
    const _approved = await ClanModel.updateOne(
      { _id: clan._id, 'applications.telegramId': telegramId, 'members.telegramId': { $ne: telegramId },
        [`members.${CLAN_MAX_MEMBERS - 1}`]: { $exists: false } },
      {
        $pull: { applications: { telegramId } },
        $push: { members: { telegramId: app.telegramId, username: app.username, role: 'member' } },
      },
    ).catch(() => null);
    if (!_approved || !_approved.modifiedCount) {
      return socket.emit('clanError', { msg: 'Заявку уже обработали' });
    }
    // Defensive: clanApply already keeps a player down to one pending
    // application at a time, so there normally isn't anything left to clear
    // here — but belt-and-suspenders against any future path (or a
    // pre-existing stale row) that leaves a second one sitting in some other
    // clan's queue, which a leader there could otherwise still approve.
    await _clearOtherClanApplications(telegramId, clan._id);
    const _fresh = await ClanModel.findById(clan._id).catch(() => null);
    await _notifyClan(_fresh || clan);
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
    _myClanName  = _cdDecl ? _cdDecl.name : null;
    _myClanIcon  = _cdDecl ? _cdDecl.icon : null;
    _myClanId    = _cdDecl ? String(_cdDecl._id) : null;
    _myClanLevel = _cdDecl ? _cdDecl.level : null;
    currentRoom?.setPlayerClan(socket.id, _myClanName, _myClanIcon, clanAtkBonusPct(_myClanLevel));
  });

  safeOn('clanKick', async ({ telegramId }) => {
    if (!authed) return;
    const clan = await ClanModel.findOne({ 'members.telegramId': authed.telegramId }).catch(() => null);
    if (!clan) return;
    if (clan.members.find(m => m.telegramId === authed.telegramId)?.role !== 'leader') return;
    if (telegramId === authed.telegramId) return;
    // Their unclaimed shards return to the pool first — once the member row is
    // gone nobody can collect them and they would be stuck in the document.
    await _clanReclaimAllocations(clan._id, telegramId);
    // Atomic $pull — see clanApprove above for why a full-document save here
    // drops concurrent changes.
    await ClanModel.updateOne({ _id: clan._id }, { $pull: { members: { telegramId } } }).catch(() => {});
    clan.members = clan.members.filter(m => m.telegramId !== telegramId);
    await _notifyClan(clan);
    // Notify kicked player
    const kicked = _socketForTelegramId(telegramId);
    if (kicked) {
      kicked.emit('clanData', null);
      // Clears their _myClanId/_myClanName/_myClanIcon and the room clan tag
      // in one go — see _setClanIdentity.
      kicked.data._setClanIdentity?.(null, null, null);
    }
  });

  safeOn('clanLeave', async () => {
    if (!authed) return;
    const clan = await ClanModel.findOne({ 'members.telegramId': authed.telegramId }).catch(() => null);
    if (!clan) return;
    const myEntry = clan.members.find(m => m.telegramId === authed.telegramId);
    if (!myEntry) return;
    // Same as clanKick: hand anything still allocated back to the clan rather
    // than walking out with it locked in the document.
    await _clanReclaimAllocations(clan._id, authed.telegramId);
    if (myEntry.role === 'leader') {
      // Promote next member or disband
      const others = clan.members.filter(m => m.telegramId !== authed.telegramId);
      if (others.length > 0) {
        // Two targeted updates rather than rewriting the member array: the
        // leaver is pulled and the successor promoted in place, so a member who
        // joined between this read and this write isn't dropped.
        await ClanModel.updateOne(
          { _id: clan._id },
          { $pull: { members: { telegramId: authed.telegramId } } },
        ).catch(() => {});
        await ClanModel.updateOne(
          { _id: clan._id, 'members.telegramId': others[0].telegramId },
          { $set: { 'members.$.role': 'leader' } },
        ).catch(() => {});
        const _fresh = await ClanModel.findById(clan._id).catch(() => null);
        await _notifyClan(_fresh || clan);
      } else {
        // Last member out: the clan document (and the shard pool inside it) is
        // about to be deleted. Everything in that pool was put there by this
        // same account — they are the only member — so it goes back to them
        // rather than being destroyed.
        const _pool = await ClanModel.findById(clan._id, 'storage').lean().catch(() => null);
        const _rows = (_pool?.storage || []).filter(e => e && e.qty > 0);
        if (_rows.length) {
          const inv = _liveInventory();
          if (!inv) return socket.emit('clanError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
          const newSlots = _rows.filter(e => !inv.some(i => i && i.id === e.id)).length;
          if (inv.length + newSlots > SERVER_INV_MAX) {
            return socket.emit('clanError', { msg: 'Освободите место в инвентаре — в хранилище остались Осколки' });
          }
          const _got = [];
          for (const e of _rows) {
            const base = CRAFT_MATS.find(m => m.id === e.id);
            if (base && _invAdd(inv, { ...base, qty: e.qty })) _got.push(`${e.id}x${e.qty}`);
          }
          _commitServerItems(inv, null, 'clan_storage_return', { clan: clan.name, items: _got.join(',') });
        }
        await ClanModel.deleteOne({ _id: clan._id }).catch(() => {});
      }
    } else {
      await ClanModel.updateOne(
        { _id: clan._id },
        { $pull: { members: { telegramId: authed.telegramId } } },
      ).catch(() => {});
      clan.members = clan.members.filter(m => m.telegramId !== authed.telegramId);
      await _notifyClan(clan);
    }
    socket.emit('clanData', null);
    _myClanName  = null;
    _myClanIcon  = null;
    _myClanId    = null;
    _myClanLevel = null;
    currentRoom?.setPlayerClan(socket.id, null, null, 0);
  });

  safeOn('clanDisband', async () => {
    if (!authed) return;
    const clan = await ClanModel.findOne({ 'members.telegramId': authed.telegramId }).catch(() => null);
    if (!clan) return;
    if (clan.members.find(m => m.telegramId === authed.telegramId)?.role !== 'leader') return;
    // Disbanding deletes the clan document, and the shard pool lives in it —
    // so an unemptied storage would be destroyed with no warning and no way
    // back. Refuse until it has been handed out; the leader can give it all to
    // themselves in a few taps if they just want to leave.
    const _held = (clan.storage || []).reduce((s, e) => s + (e.qty || 0), 0)
                + (clan.allocations || []).reduce((s, a) => s + (a.qty || 0), 0);
    if (_held > 0) {
      return socket.emit('clanError', {
        msg: `Сначала раздайте Осколки из хранилища (осталось ${_held})`,
      });
    }
    // Notify all members first and clear their room clan state
    for (const m of clan.members) {
      const target = _socketForTelegramId(m.telegramId);
      if (target) {
        target.emit('clanData', null);
        target.data._setClanIdentity?.(null, null, null);
      }
    }
    await ClanModel.deleteOne({ _id: clan._id }).catch(() => {});
  });

  // Anything still allocated to someone who is leaving goes back into the
  // pool. Without this it would sit in the clan document forever: only that
  // account can claim it, and it no longer can.
  async function _clanReclaimAllocations(clanId, telegramId) {
    const pulled = await ClanModel.findOneAndUpdate(
      { _id: clanId, 'allocations.telegramId': String(telegramId) },
      { $pull: { allocations: { telegramId: String(telegramId) } } },
      { new: false },
    ).catch(() => null);
    if (!pulled) return;
    const back = new Map();
    for (const a of (pulled.allocations || [])) {
      if (a.telegramId !== String(telegramId) || !(a.qty > 0)) continue;
      back.set(a.id, (back.get(a.id) || 0) + a.qty);
    }
    for (const [id, qty] of back) {
      const bumped = await ClanModel.updateOne(
        { _id: clanId, 'storage.id': id }, { $inc: { 'storage.$.qty': qty } },
      ).catch(() => ({ matchedCount: 1 }));
      if (!bumped.matchedCount) {
        await ClanModel.updateOne(
          { _id: clanId, 'storage.id': { $ne: id } }, { $push: { storage: { id, qty } } },
        ).catch(() => {});
      }
    }
  }

  // ── Хранилище клана ───────────────────────────────────────────────────────
  // A shared pool of Осколки: members deposit, the leader decides who gets
  // what. Shards do NOT go straight from the pool into the recipient's
  // inventory — the leader allocates, the member collects. The recipient is
  // usually offline when a leader hands things out, and writing items into an
  // offline account's saved inventory races that account's own next login;
  // making the member collect means every grant lands through their own live
  // session and _commitServerItems, the same path all other server-side item
  // grants use.
  //
  // Every mutation below is a single conditional Mongo update rather than
  // read-modify-write: two members depositing, or a leader handing out the
  // same stack twice from two taps, must not be able to interleave.

  // Days this account has been in the clan, or null if it is not a member.
  function _clanDaysIn(clan, telegramId) {
    const m = clan.members.find(x => x.telegramId === telegramId);
    if (!m) return null;
    const joined = m.joinedAt ? new Date(m.joinedAt).getTime() : 0;
    // A member row written before joinedAt existed has no date; treat that as
    // "has been here since the beginning" rather than locking them out forever.
    if (!joined) return Infinity;
    return (Date.now() - joined) / 86400000;
  }
  const _clanStorageOk = (clan, tid) => (_clanDaysIn(clan, tid) ?? -1) >= CLAN_STORAGE_MIN_DAYS;

  function _clanStoragePayload(clan, telegramId) {
    const isLeader = clan.members.find(m => m.telegramId === telegramId)?.role === 'leader';
    const days = _clanDaysIn(clan, telegramId);
    const unlocked = !!clan.storageUnlocked;
    const shardName = id => (UNIQUE_SHARDS.find(s => s.id === id) || {}).name || id;
    const shardImg  = id => (UNIQUE_SHARDS.find(s => s.id === id) || {}).img || null;
    return {
      minDays: CLAN_STORAGE_MIN_DAYS,
      // Rounded down, so "9.9 days" reads as 9 and the number never claims
      // eligibility the check itself would refuse.
      daysIn: days === Infinity ? null : Math.floor(Math.max(0, days || 0)),
      // canUse is the DAY gate alone. `unlocked` is separate on purpose: the
      // panel has to be able to say which of the two is missing, and a member
      // who is past 10 days still can't do anything until it is bought.
      canUse: _clanStorageOk(clan, telegramId),
      unlocked,
      unlockCost: CLAN_STORAGE_UNLOCK_GOLD,
      isLeader,
      storage: (clan.storage || [])
        .filter(e => e && e.qty > 0)
        .map(e => ({ id: e.id, name: shardName(e.id), img: shardImg(e.id), qty: e.qty })),
      // A leader sees every outstanding allocation, a member only their own.
      allocations: (clan.allocations || [])
        .filter(a => isLeader || a.telegramId === telegramId)
        .map(a => ({
          telegramId: a.telegramId, username: a.username,
          id: a.id, name: shardName(a.id), img: shardImg(a.id),
          qty: a.qty, byUsername: a.byUsername || null, at: a.at,
        })),
      // Who the leader may hand shards to — members past the same gate.
      members: isLeader
        ? clan.members
            .filter(m => _clanStorageOk(clan, m.telegramId))
            .map(m => ({ telegramId: m.telegramId, username: m.username }))
        : [],
    };
  }

  async function _clanStoragePush(clan) {
    for (const m of clan.members) {
      const target = _socketForTelegramId(m.telegramId);
      if (target) target.emit('clanStorage', _clanStoragePayload(clan, m.telegramId));
    }
  }

  async function _myClan() {
    if (!authed) return null;
    return ClanModel.findOne({ 'members.telegramId': authed.telegramId }).catch(() => null);
  }

  safeOn('clanStorageSync', async () => {
    const clan = await _myClan();
    if (!clan) return socket.emit('clanStorage', null);
    socket.emit('clanStorage', _clanStoragePayload(clan, authed.telegramId));
  });

  // The leader buys the storage for the clan, once, out of their own gold.
  //
  // Gold is the one currency the server does not own outright — it rides in on
  // the client's save blob — so the deduction has to be told to the client as
  // an absolute (newGold) the way the merchant sale does, or their next
  // autosave would put the million straight back.
  safeOn('clanStorageUnlock', async () => {
    if (!authed) return;
    await _withEconLock(async () => {
      const clan = await _myClan();
      if (!clan) return socket.emit('clanStorageError', { msg: 'Вы не в клане' });
      if (clan.members.find(m => m.telegramId === authed.telegramId)?.role !== 'leader') {
        return socket.emit('clanStorageError', { msg: 'Открыть хранилище может только лидер' });
      }
      if (clan.storageUnlocked) {
        return socket.emit('clanStorageError', { msg: 'Хранилище уже открыто' });
      }
      if (!_lastStats) return socket.emit('clanStorageError', { msg: 'Данные ещё не загружены — попробуйте ещё раз' });
      const gold = Math.floor(Number(_lastStats.gold) || 0);
      if (gold < CLAN_STORAGE_UNLOCK_GOLD) {
        return socket.emit('clanStorageError', {
          msg: `Нужно ${CLAN_STORAGE_UNLOCK_GOLD.toLocaleString('ru-RU')} золота (есть ${gold.toLocaleString('ru-RU')})`,
        });
      }
      // Claim the unlock BEFORE charging: the filter only matches while it is
      // still locked, so two taps can't both go through and bill twice. If it
      // matched nothing somebody else already bought it and no gold moves.
      const claimed = await ClanModel.findOneAndUpdate(
        { _id: clan._id, storageUnlocked: { $ne: true } },
        { $set: { storageUnlocked: true } },
        { new: true },
      ).catch(() => null);
      if (!claimed) return socket.emit('clanStorageError', { msg: 'Хранилище уже открыто' });

      await _serverSpendGold(CLAN_STORAGE_UNLOCK_GOLD, 'clan_storage_unlock');
      logPlayer(authed.telegramId, authed.username, 'clan_storage_unlock',
        { clan: clan.name, cost: CLAN_STORAGE_UNLOCK_GOLD, goldBefore: gold, goldLeft: _lastStats.gold });
      socket.emit('clanStorageUnlocked', { newGold: _lastStats.gold, cost: CLAN_STORAGE_UNLOCK_GOLD });
      await _clanStoragePush(claimed);
    });
  });

  safeOn('clanStorageDeposit', async ({ id, qty } = {}) => {
    if (!authed) return;
    await _withEconLock(async () => {
      const n = Math.floor(Number(qty));
      if (!Number.isFinite(n) || n <= 0) return;
      // Only Осколки. The pool is a flat id→count list precisely because
      // everything in it is interchangeable and stackable; letting gear in
      // would need per-item identity and enhance levels it cannot hold.
      if (!UNIQUE_SHARDS.some(s => s.id === id)) {
        return socket.emit('clanStorageError', { msg: 'В хранилище можно класть только Осколки' });
      }
      const clan = await _myClan();
      if (!clan) return socket.emit('clanStorageError', { msg: 'Вы не в клане' });
      // Locked clans have no storage at all — nothing goes in, nothing comes
      // out, and the pool stays empty until the leader buys it.
      if (!clan.storageUnlocked) {
        return socket.emit('clanStorageError', { msg: 'Хранилище клана ещё не открыто' });
      }
      if (!_clanStorageOk(clan, authed.telegramId)) {
        return socket.emit('clanStorageError', {
          msg: `Хранилище доступно после ${CLAN_STORAGE_MIN_DAYS} дней в клане`,
        });
      }
      const inv = _liveInventory();
      if (!inv) return socket.emit('clanStorageError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });
      const have = inv.reduce((s, i) => s + (i && i.id === id ? (i.qty || 1) : 0), 0);
      if (have < n) return socket.emit('clanStorageError', { msg: `Недостаточно Осколков (есть ${have})` });

      // Take from the inventory in memory first, then write the clan. If the
      // clan write fails the items go straight back and nothing is persisted —
      // the reverse order would have to un-write the clan instead, and a
      // failure there would leave the shards in neither place.
      const _removed = [];
      let left = n;
      for (let i = inv.length - 1; i >= 0 && left > 0; i--) {
        const e = inv[i];
        if (!e || e.id !== id) continue;
        const q = e.qty || 1;
        if (q > left) { e.qty = q - left; _removed.push({ i, qty: left, spliced: false }); left = 0; }
        else { left -= q; _removed.push({ i, qty: q, spliced: true, entry: e }); inv.splice(i, 1); }
      }
      const restore = () => {
        for (const r of _removed.reverse()) {
          if (r.spliced) inv.splice(r.i, 0, r.entry);
          else inv[r.i].qty = (inv[r.i].qty || 0) + r.qty;
        }
      };

      try {
        // Bump an existing row, or create it when the clan has none of this
        // kind yet. Two updates rather than one because Mongo has no "increment
        // or push" — the second only runs when the first matched nothing.
        const bumped = await ClanModel.updateOne(
          { _id: clan._id, 'storage.id': id },
          { $inc: { 'storage.$.qty': n } },
        );
        if (!bumped.matchedCount) {
          await ClanModel.updateOne(
            { _id: clan._id, 'storage.id': { $ne: id } },
            { $push: { storage: { id, qty: n } } },
          );
        }
      } catch (err) {
        restore();
        logPlayerErr(authed.telegramId, authed.username, 'clan_storage_deposit', err, { id, qty: n });
        return socket.emit('clanStorageError', { msg: 'Ошибка сервера' });
      }

      _commitServerItems(inv, null, 'clan_storage_deposit', { id, qty: n, clan: clan.name });
      const fresh = await _myClan();
      if (fresh) await _clanStoragePush(fresh);
      socket.emit('clanStorageOk', { msg: `Передано в хранилище: ${n}` });
    });
  });

  // Leader hands part of the pool to a member. Nothing reaches their inventory
  // here — it becomes an allocation they collect (see clanStorageClaim).
  safeOn('clanStorageGive', async ({ telegramId, id, qty } = {}) => {
    if (!authed) return;
    const n = Math.floor(Number(qty));
    if (!Number.isFinite(n) || n <= 0) return;
    const clan = await _myClan();
    if (!clan) return;
    if (!clan.storageUnlocked) {
      return socket.emit('clanStorageError', { msg: 'Хранилище клана ещё не открыто' });
    }
    if (clan.members.find(m => m.telegramId === authed.telegramId)?.role !== 'leader') {
      return socket.emit('clanStorageError', { msg: 'Распределять может только лидер' });
    }
    const target = clan.members.find(m => m.telegramId === String(telegramId));
    if (!target) return socket.emit('clanStorageError', { msg: 'Участник не найден' });
    // The recipient is held to the same gate as a depositor: without it a
    // day-old alt is a way to walk the whole pool out of the clan.
    if (!_clanStorageOk(clan, target.telegramId)) {
      return socket.emit('clanStorageError', {
        msg: `${target.username}: в клане меньше ${CLAN_STORAGE_MIN_DAYS} дней`,
      });
    }
    // One conditional update does the whole move: it only matches while the
    // pool still holds n of that kind, so two taps cannot hand out the same
    // shards twice.
    const upd = await ClanModel.findOneAndUpdate(
      { _id: clan._id, storage: { $elemMatch: { id, qty: { $gte: n } } } },
      {
        $inc: { 'storage.$.qty': -n },
        $push: { allocations: {
          telegramId: target.telegramId, username: target.username,
          id, qty: n, byUsername: authed.username, at: new Date(),
        } },
      },
      { new: true },
    ).catch(() => null);
    if (!upd) return socket.emit('clanStorageError', { msg: 'В хранилище столько нет' });
    logPlayer(authed.telegramId, authed.username, 'clan_storage_give',
      { to: target.username, toTid: target.telegramId, id, qty: n, clan: clan.name });
    await _clanStoragePush(upd);
    socket.emit('clanStorageOk', { msg: `Выдано ${target.username}: ${n}` });
  });

  // Leader takes an unclaimed allocation back into the pool — the only way to
  // undo a mis-tap, since the recipient may simply never collect it.
  safeOn('clanStorageCancel', async ({ telegramId, id } = {}) => {
    if (!authed) return;
    const clan = await _myClan();
    if (!clan) return;
    if (clan.members.find(m => m.telegramId === authed.telegramId)?.role !== 'leader') return;
    const alloc = (clan.allocations || []).find(a => a.telegramId === String(telegramId) && a.id === id);
    if (!alloc) return socket.emit('clanStorageError', { msg: 'Выдача не найдена' });
    const pulled = await ClanModel.findOneAndUpdate(
      { _id: clan._id, allocations: { $elemMatch: { telegramId: String(telegramId), id } } },
      { $pull: { allocations: { telegramId: String(telegramId), id } } },
      { new: false },
    ).catch(() => null);
    if (!pulled) return socket.emit('clanStorageError', { msg: 'Выдача не найдена' });
    // Sum what was actually pulled from the pre-image rather than trusting the
    // copy read above — another tap may have changed it in between.
    const back = (pulled.allocations || [])
      .filter(a => a.telegramId === String(telegramId) && a.id === id)
      .reduce((s, a) => s + (a.qty || 0), 0);
    if (back > 0) {
      const bumped = await ClanModel.updateOne(
        { _id: clan._id, 'storage.id': id }, { $inc: { 'storage.$.qty': back } },
      );
      if (!bumped.matchedCount) {
        await ClanModel.updateOne(
          { _id: clan._id, 'storage.id': { $ne: id } }, { $push: { storage: { id, qty: back } } },
        );
      }
    }
    const fresh = await _myClan();
    if (fresh) await _clanStoragePush(fresh);
  });

  // Member collects everything allocated to them. Pulled first so a second tap
  // finds nothing, then granted; if the inventory can't take it, the
  // allocation goes back exactly as it was.
  safeOn('clanStorageClaim', async () => {
    if (!authed) return;
    await _withEconLock(async () => {
      const clan = await _myClan();
      if (!clan) return;
      if (!clan.storageUnlocked) {
        return socket.emit('clanStorageError', { msg: 'Хранилище клана ещё не открыто' });
      }
      if (!_clanStorageOk(clan, authed.telegramId)) {
        return socket.emit('clanStorageError', {
          msg: `Хранилище доступно после ${CLAN_STORAGE_MIN_DAYS} дней в клане`,
        });
      }
      const inv = _liveInventory();
      if (!inv) return socket.emit('clanStorageError', { msg: 'Инвентарь ещё не загружен — попробуйте ещё раз' });

      const pulled = await ClanModel.findOneAndUpdate(
        { _id: clan._id, 'allocations.telegramId': authed.telegramId },
        { $pull: { allocations: { telegramId: authed.telegramId } } },
        { new: false },
      ).catch(() => null);
      const mine = pulled
        ? (pulled.allocations || []).filter(a => a.telegramId === authed.telegramId)
        : [];
      if (!mine.length) return socket.emit('clanStorageError', { msg: 'Для вас ничего не выдано' });

      const putBack = async () => {
        await ClanModel.updateOne({ _id: clan._id }, { $push: { allocations: { $each: mine } } }).catch(() => {});
      };

      // Merge by kind first, so "5 + 7 рубина" needs one inventory slot rather
      // than being counted as two.
      const byId = new Map();
      for (const a of mine) byId.set(a.id, (byId.get(a.id) || 0) + (a.qty || 0));
      // Space check before anything is added: a shard the player already holds
      // merges into that stack and costs nothing, a new kind costs one slot.
      const newSlots = [...byId.keys()].filter(id => !inv.some(i => i && i.id === id)).length;
      if (inv.length + newSlots > SERVER_INV_MAX) {
        await putBack();
        return socket.emit('clanStorageError', { msg: 'Инвентарь полон' });
      }
      const granted = [];
      for (const [id, q] of byId) {
        const base = CRAFT_MATS.find(m => m.id === id);
        if (!base || q <= 0) continue;
        if (!_invAdd(inv, { ...base, qty: q })) continue;
        granted.push({ id, name: base.name, qty: q });
      }
      if (!granted.length) { await putBack(); return socket.emit('clanStorageError', { msg: 'Инвентарь полон' }); }

      _commitServerItems(inv, null, 'clan_storage_claim',
        { clan: clan.name, items: granted.map(g => `${g.id}x${g.qty}`).join(',') });
      const fresh = await _myClan();
      if (fresh) await _clanStoragePush(fresh);
      socket.emit('clanStorageClaimed', { items: granted });
    });
  });

  // One point of clan XP for the kill — now a Map increment and nothing else.
  // See the clan XP batching block at module scope for why: this used to be
  // four DB round trips and a full clanData packet on every monster death.
  // Deliberately not async any more; the call sites' `.catch(() => {})` is
  // harmless on undefined-returning calls but has been dropped where it stood.
  function _onKillClanXp() {
    if (!authed || !_myClanId) return;
    _clanXpAdd(_myClanId, 1);
  }

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
      if (_lastStats) {
        _lastStats.specialQuestsDone = newDone;
        if (quest.reward.gold) _lastStats.gold = (authed.savedData.gold || 0);
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
    _db.reg.delete(socket.id);
    if (_a3.queue.delete(socket.id)) _a3Broadcast();
    if (_race10.queue.delete(socket.id)) _race10Broadcast();
    _pvpEliminate(socket.id);
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
  // Same reasoning as the getMe call above: getUpdates can only 404 without a
  // real token, and _pollTg re-arms itself every 500ms, so an unconfigured
  // instance — or a local dev one, whose token is a dummy used purely to sign
  // its own initData — would hammer api.telegram.org for nothing.
  if (_TG_TOKEN && process.env.DEV_LOCAL !== '1') _pollTg();
  _dbSchedule();
  _wbSchedule();
  _race10Schedule();
  _a3Schedule();
  console.log('next death battle:', new Date(_dbNextStartAt()).toISOString(),
              '| next world boss:', new Date(_wbNextStartAt()).toISOString(),
              '| next Bloody Tower window:', new Date(_race10NextOpenAt()).toISOString(),
              '| next 3v3 window:', new Date(_a3NextOpenAt()).toISOString());
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
  // Land whatever clan XP has accumulated since the last 20s flush, so a
  // redeploy doesn't quietly discard it.
  await _flushClanXp().catch(() => {});
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
