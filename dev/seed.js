'use strict';

// Seed data for the local dev database (see dev/local.js).
//
// Everything here is written through the same models the server uses, so a
// seeded account is indistinguishable from one the game itself created. The
// savedData blobs mirror the shape the client sends in saveProgress — see
// _buildSaveStats in js/network.js — and only use item ids that exist in
// shared/definitions.js, because the server rebuilds every item from that
// catalog on login and silently drops the ones it doesn't recognise
// (_canonSavedItem in server/index.js).

const PlayerModel        = require('../server/models/Player');
const ClanModel          = require('../server/models/Clan');
const MarketListingModel = require('../server/models/MarketListing');
const SpecialQuestModel  = require('../server/models/SpecialQuest');

// Ids well outside the range Telegram hands out, so a dev account can never
// collide with a real one if this seed is ever pointed at a shared database.
const DEV_USERS = [
  { telegramId: '900000001', username: 'dev',
    note: 'чистый аккаунт — попадает на экран выбора класса' },
  { telegramId: '900000002', username: 'hero',
    note: 'Танк 24 ур., экипировка, 12k золота, Liberty/GRAM, лидер клана' },
  { telegramId: '900000003', username: 'rival',
    note: 'Егерь 18 ур., состоит в клане, выставил лоты на рынке' },
];

function savedDataHero() {
  return {
    type: 'lev',
    floor: 3,
    lvl: 24, xp: 1200, xpNext: 4300,
    gold: 12000, kills: 860,
    hp: 1420, maxHp: 1420,
    baseAtk: 62, baseDef: 48, baseMaxHp: 1180,
    equipment: {
      weapon: { id: 'tw3', enhance: 4 },
      helmet: { id: 'hm3', enhance: 2 },
      body:   { id: 'ar3', enhance: 3 },
      gloves: { id: 'gl2', enhance: 0 },
      boots:  { id: 'bt2', enhance: 0 },
      ring:   { id: 'rn3', enhance: 0 },
      belt:   { id: 'nd2', enhance: 0 },
      pet:    { id: 'pet_bear', enhance: 0 },
    },
    inventory: [
      { id: 'tw4', enhance: 0 },
      { id: 'hm4', enhance: 0 },
      { id: 'norm_stone', qty: 12 },
      { id: 'bless_stone', qty: 3 },
      { id: 'key_uncommon', qty: 40 },
      { id: 'box_uncommon', qty: 2 },
      { id: 'recu', qty: 25 },
      { id: 'bp_exp', qty: 5 },
      { id: 'bp_gold', qty: 5 },
    ],
    storage: [{ id: 'ar4', enhance: 0 }],
    potionBag: { pt1: 40, pt2: 15 },
    hudPotion: 'pt2',
    buffs: {},
    autoHpPct: 0.5,
    upgrades: { atk: 6, def: 5, hp: 8, atkSpeed: 3, critChance: 2, critPower: 2, hpRegen: 1 },
    questIdx: 6,
    questKills: {},
    specialQuestsDone: [],
    skillLevels: { Q: 3, W: 2, E: 1, R: 1 },
    passiveLevels: {},
    bonusSP: 4,
    lang: 'ru',
    gramBalance: 250,
    nexumBalance: 4000,
    savedAt: Date.now(),
  };
}

function savedDataRival() {
  return {
    type: 'ranger',
    floor: 2,
    lvl: 18, xp: 400, xpNext: 2600,
    gold: 5400, kills: 410,
    hp: 720, maxHp: 720,
    baseAtk: 55, baseDef: 22, baseMaxHp: 640,
    equipment: {
      weapon: { id: 'bw3', enhance: 2 },
      helmet: { id: 'hm2', enhance: 0 },
      body:   { id: 'ar2', enhance: 1 },
      boots:  { id: 'bt2', enhance: 0 },
      ring:   { id: 'rn1', enhance: 0 },
    },
    inventory: [
      { id: 'bw2', enhance: 0 },
      { id: 'key_rare', qty: 6 },
      { id: 'recr', qty: 8 },
    ],
    storage: [],
    potionBag: { pt1: 20, pt2: 4 },
    hudPotion: 'pt1',
    buffs: {},
    autoHpPct: 0.5,
    upgrades: { atk: 3, def: 2, hp: 3, atkSpeed: 2, critChance: 1, critPower: 0, hpRegen: 0 },
    questIdx: 3,
    questKills: {},
    specialQuestsDone: [],
    skillLevels: { Q: 2, W: 1, E: 0, R: 0 },
    passiveLevels: {},
    bonusSP: 1,
    lang: 'ru',
    gramBalance: 30,
    nexumBalance: 600,
    savedAt: Date.now(),
  };
}

// Rough stand-in for the server's calcBM — the real value is recomputed on the
// first save of a session anyway; this only exists so the leaderboard and the
// admin panel aren't all zeroes before anyone has played.
function bmOf(s) {
  return Math.round((s.baseAtk * 3 + s.baseDef * 2 + s.baseMaxHp / 4) * s.lvl);
}

async function seed({ force = false } = {}) {
  const existing = await PlayerModel.countDocuments();
  if (existing > 0 && !force) return { skipped: true, players: DEV_USERS };

  if (force) {
    await Promise.all([
      PlayerModel.deleteMany({}),
      ClanModel.deleteMany({}),
      MarketListingModel.deleteMany({}),
      SpecialQuestModel.deleteMany({}),
    ]);
  }

  const saved = { '900000002': savedDataHero(), '900000003': savedDataRival() };
  for (const u of DEV_USERS) {
    const s = saved[u.telegramId] || {};
    await PlayerModel.create({
      telegramId: u.telegramId,
      username: u.username,
      savedData: s,
      bm: s.lvl ? bmOf(s) : 0,
      adminNotified: true, // nothing to notify — there's no bot in local mode
    });
  }

  await ClanModel.create({
    name: 'DEV',
    icon: 7,
    level: 3,
    xp: 4200,
    members: [
      { telegramId: '900000002', username: 'hero',  role: 'leader' },
      { telegramId: '900000003', username: 'rival', role: 'member' },
    ],
    applications: [
      { telegramId: '900000001', username: 'dev' },
    ],
  });

  await MarketListingModel.create([
    { sellerId: '900000003', sellerUsername: 'rival', price: 12, item: { id: 'sw4', name: 'Меч теней', slot: 'weapon', enhance: 3, rarity: 'epic', img: '/images/wep/ek.png', atk: 44, critChance: 0.10 } },
    { sellerId: '900000003', sellerUsername: 'rival', price: 3,  item: { id: 'hm2', name: 'Железный шлем', slot: 'helmet', enhance: 0, rarity: 'uncommon', img: '/images/arm/uh.png', hp: 50 } },
    { sellerId: '900000003', sellerUsername: 'rival', price: 1,  item: { id: 'norm_stone', name: 'Камень обычной заточки', slot: 'material', qty: 5, rarity: 'uncommon', img: '/images/norm.png' } },
  ]);

  await SpecialQuestModel.create([
    { title: 'Подпишись на канал', desc: 'Локальный тестовый квест', type: 'link', url: 'https://example.com', icon: '📣', reward: { gold: 500, xp: 200, nexum: 50 } },
    { title: 'Позови друга',       desc: 'Локальный тестовый квест', type: 'custom', icon: '🤝', reward: { gold: 1000, xp: 0, nexum: 100 } },
  ]);

  return { skipped: false, players: DEV_USERS };
}

module.exports = seed;
module.exports.DEV_USERS = DEV_USERS;
