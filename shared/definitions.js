// ─────────────────────────────────────────────────────────────────────────────
//  SHARED GAME DEFINITIONS — single source of truth for server and client
//  Browser: loaded as a plain <script>; constants become global.
//  Node.js: const { ENEMY_DEF, CHAR_DEF, TILE } = require('../shared/definitions');
// ─────────────────────────────────────────────────────────────────────────────

// ── Map constants ─────────────────────────────────────────────────────────────
const TILE = 40;
const WALL = 0, FLOOR = 1;

// ── Character definitions ─────────────────────────────────────────────────────
// Class colors kept as a deliberate, distinct identity per class (steel /
// forest / arcane violet / holy gold / wine / cool steel) rather than run
// through the general dark-fantasy recolor pass — matches the same picks
// made for .cs-tab-*/.cs-btn-* in css/style.css. projColor (ranged attack
// visuals) is left alone; combat-FX readability matters more there than
// theme purity.
const CHAR_DEF = {
  lev:         { name:'Лев',          icon:'lev',        color:'#9aa3ab', baseHP:200, baseAtk:3, baseDef:10, speed:145, atkRange:58,  atkSpeed:1.197, atkType:'melee' },
  deathknight: { name:'Рыцарь Смерти',icon:'skull',      color:'#7a5c99', baseHP:260, baseAtk:2, baseDef:14, speed:130, atkRange:58,  atkSpeed:1.000, atkType:'melee' },
  ranger:      { name:'Егерь',        icon:'archerClass',color:'#5c7a4a', baseHP:140, baseAtk:2, baseDef:5,  speed:175, atkRange:210, atkSpeed:1.593, atkType:'ranged', projColor:'#8fbf5a' },
  mage:        { name:'Маг',          icon:'mageClass',  color:'#5c7fbf', baseHP:110, baseAtk:4, baseDef:3,  speed:155, atkRange:180, atkSpeed:0.837, atkType:'ranged', projColor:'#66aaff' },
  warlock:     { name:'Чернокнижник', icon:'mageClass',  color:'#8a3a4a', baseHP:160, baseAtk:2, baseDef:7,  speed:148, atkRange:170, atkSpeed:1.200, atkType:'ranged', projColor:'#a855e0' },
};

// ── Monster level curve ────────────────────────────────────────────────────────
// Global monster level (1-120, see armIndexForLevel below) drives HP/ATK/DEF
// directly through one continuous formula — this replaces the old system
// where per-room, per-zone and "early level" multipliers all stacked on top
// of each other at spawn time (server/game/dungeon.js), which made the
// boss-vs-trash ratio swing wildly depending on where in a corridor you were.
//
// HP/ATK compound a fixed percentage EVERY level, starting at level 1 — there
// is no "fair" flat zone anymore, difficulty ramps immediately and keeps
// outpacing a gearless player, on purpose: closing that gap is meant to come
// from gear/enchant/skill-point/VIP progression, not character level alone.
// DEF stays on a flat linear formula at every level so it never grows faster
// than a player's own ATK and floors damage to a boring "always 1".
const MONSTER_HP1  = 12; // HP at level 1, before archetype/boss multipliers
const MONSTER_ATK1 = 20; // ATK at level 1, before archetype/boss multipliers
const MONSTER_HP_GROWTH  = 1.065; // per level, compounding, from level 1
const MONSTER_ATK_GROWTH = 1.032;
function monsterDEFAtLevel(lvl) { return Math.max(0, Math.round(0.5 * Math.max(1, lvl || 1))); }
function monsterHPAtLevel(lvl) {
  lvl = Math.max(1, lvl || 1);
  return MONSTER_HP1 * Math.pow(MONSTER_HP_GROWTH, lvl - 1);
}
function monsterATKAtLevel(lvl) {
  lvl = Math.max(1, lvl || 1);
  return MONSTER_ATK1 * Math.pow(MONSTER_ATK_GROWTH, lvl - 1);
}
// Archetype flavor: "страж"(guard) trades damage for HP, "воин"(warrior) the
// reverse, so the two pool monsters per zone play differently instead of
// being near-identical reskins. Bosses are a flat HP/ATK multiplier over a
// regular monster of the same level with no extra DEF — a longer fight, not
// a damage sponge that also shrugs off hits.
const MONSTER_ARCHETYPE = {
  guard:   { hp: 1.15, atk: 0.85 },
  warrior: { hp: 0.90, atk: 1.15 },
};
const BOSS_HP_MULT  = 10;
const BOSS_ATK_MULT = 1.5;
function monsterStatsAtLevel(lvl, eType) {
  const hp = monsterHPAtLevel(lvl), atk = monsterATKAtLevel(lvl), def = monsterDEFAtLevel(lvl);
  if (eType === 'boss') return { hp: Math.round(hp * BOSS_HP_MULT), atk: Math.round(atk * BOSS_ATK_MULT), def };
  const arch = MONSTER_ARCHETYPE[eType] || { hp: 1, atk: 1 };
  return { hp: Math.max(1, Math.round(hp * arch.hp)), atk: Math.max(1, Math.round(atk * arch.atk)), def };
}

// ── Per-level name/color rank ────────────────────────────────────────────────
// Every one of the 29 non-boss local room levels in a zone gets its own rank
// title (weakest → strongest) prefixed onto the monster's base name, so e.g.
// "Скелет воин" at room 1 becomes "Слабый Скелет воин" and at room 29
// "Запредельный Скелет воин" — 29 distinct names per base monster, per zone.
// The boss room keeps the base (already-unique) boss name unchanged.
const MONSTER_RANK_M = [
  'Слабый', 'Молодой', 'Обычный', 'Стойкий', 'Опытный', 'Закалённый', 'Хищный',
  'Свирепый', 'Яростный', 'Кровожадный', 'Безжалостный', 'Отчаянный', 'Могучий',
  'Грозный', 'Разъярённый', 'Устрашающий', 'Смертоносный', 'Демонический',
  'Проклятый', 'Кошмарный', 'Легендарный', 'Титанический', 'Апокалиптический',
  'Погибельный', 'Всесокрушающий', 'Первородный', 'Древний', 'Изначальный', 'Запредельный',
];
const MONSTER_RANK_F = [
  'Слабая', 'Молодая', 'Обычная', 'Стойкая', 'Опытная', 'Закалённая', 'Хищная',
  'Свирепая', 'Яростная', 'Кровожадная', 'Безжалостная', 'Отчаянная', 'Могучая',
  'Грозная', 'Разъярённая', 'Устрашающая', 'Смертоносная', 'Демоническая',
  'Проклятая', 'Кошмарная', 'Легендарная', 'Титаническая', 'Апокалиптическая',
  'Погибельная', 'Всесокрушающая', 'Первородная', 'Древняя', 'Изначальная', 'Запредельная',
];
function monsterNameAtLevel(baseName, localLvl, isBoss, fem) {
  if (isBoss) return baseName;
  const ranks = fem ? MONSTER_RANK_F : MONSTER_RANK_M;
  const idx = Math.min(ranks.length - 1, Math.max(0, (localLvl || 1) - 1));
  return ranks[idx] + ' ' + baseName;
}
function _expandHex(hex) {
  hex = hex.replace('#', '');
  return hex.length === 3 ? hex.split('').map(c => c + c).join('') : hex;
}
function _lerpHexColor(c1, c2, t) {
  const a = parseInt(_expandHex(c1), 16), b = parseInt(_expandHex(c2), 16);
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t), g = Math.round(ag + (bg - ag) * t), bl = Math.round(ab + (bb - ab) * t);
  return '#' + [r, g, bl].map(v => v.toString(16).padStart(2, '0')).join('');
}
// Interpolates from the monster's base (weakest, room 1) color to its
// `endColor` (strongest, room 29) — bosses keep their own fixed color.
function monsterColorAtLevel(baseColor, endColor, localLvl, isBoss) {
  if (isBoss || !endColor) return baseColor;
  const t = Math.min(1, Math.max(0, ((localLvl || 1) - 1) / (MONSTER_RANK_M.length - 1)));
  return _lerpHexColor(baseColor, endColor, t);
}

// ── Enemy definitions ─────────────────────────────────────────────────────────
// Each of the 4 arms cycles through several DIFFERENT monster species as you
// climb its 29 regular rooms (3 species per arm, or 2 for arm 4's bigger
// creatures) instead of showing the same 2 sprites for all 30 rooms — see
// FLOOR_ENEMIES' `bands` below. Every species contributes a guard (tankier)
// and a warrior (harder-hitting) variant to its band; the arm's boss reuses
// that same species' own "elite" tier for its look, so the boss always feels
// like a stronger version of something you were just fighting.
//
// hp/atk/def/xp/gold below are monsterStatsAtLevel()/xpAtLevel()/goldAtLevel()
// evaluated at each entry's band-start level (or the arm's last level for
// bosses) — a static snapshot used as-is by the Raid and Party-dungeon modes
// (which don't have a room-progression concept of their own) and as display
// fallback. The main open world (server/game/dungeon.js) ignores these
// numbers entirely and calls the level functions fresh for the enemy's actual
// room level, overriding name/color/hp/atk/def/xp/gold per spawn.
// fem: grammatical gender of the base name's leading noun, for rank agreement
// (Крыса/Лоза are feminine, the rest are masculine).
// endColor: the room-29 (strongest non-boss) tint monsterColorAtLevel ramps to.
const ENEMY_DEF = [
  { eid:'rat_guard', name:'Крыса страж', color:'#8a7a6a', endColor:'#3a2a1a', fem:true, size:13, hp:14, atk:17, def:1, spd:112, xp:1, gold:1, isBoss:false, eType:'guard' },
  { eid:'rat_warrior', name:'Крыса воин', color:'#8a7a6a', endColor:'#3a2a1a', fem:true, size:14, hp:11, atk:23, def:1, spd:118, xp:1, gold:1, isBoss:false, eType:'warrior' },
  { eid:'slime_guard', name:'Слизень страж', color:'#7ac47a', endColor:'#1a3a10', fem:false, size:13, hp:26, atk:23, def:6, spd:52, xp:11, gold:11, isBoss:false, eType:'guard' },
  { eid:'slime_warrior', name:'Слизень воин', color:'#7ac47a', endColor:'#1a3a10', fem:false, size:14, hp:20, atk:32, def:6, spd:56, xp:11, gold:11, isBoss:false, eType:'warrior' },
  { eid:'imp_guard', name:'Бес страж', color:'#c47a5a', endColor:'#4a1408', fem:false, size:14, hp:49, atk:32, def:11, spd:92, xp:21, gold:21, isBoss:false, eType:'guard' },
  { eid:'imp_warrior', name:'Бес воин', color:'#c47a5a', endColor:'#4a1408', fem:false, size:15, hp:38, atk:43, def:11, spd:97, xp:21, gold:21, isBoss:false, eType:'warrior' },
  { eid:'imp_boss', name:'Босс бесов', color:'#ff6a3a', size:22, hp:745, atk:75, def:15, spd:88, xp:30, gold:30, isBoss:true, eType:'boss' },
  { eid:'zombie_guard', name:'Зомби страж', color:'#8aab7a', endColor:'#1a2a10', fem:false, size:15, hp:91, atk:44, def:16, spd:56, xp:31, gold:31, isBoss:false, eType:'guard' },
  { eid:'zombie_warrior', name:'Зомби воин', color:'#8aab7a', endColor:'#1a2a10', fem:false, size:16, hp:71, atk:59, def:16, spd:60, xp:31, gold:31, isBoss:false, eType:'warrior' },
  { eid:'lizardman_guard', name:'Ящер страж', color:'#6ab26a', endColor:'#0a2a0a', fem:false, size:15, hp:171, atk:60, def:21, spd:76, xp:41, gold:41, isBoss:false, eType:'guard' },
  { eid:'lizardman_warrior', name:'Ящер воин', color:'#6ab26a', endColor:'#0a2a0a', fem:false, size:16, hp:134, atk:81, def:21, spd:80, xp:41, gold:41, isBoss:false, eType:'warrior' },
  { eid:'orc_guard', name:'Орк страж', color:'#7a9a5a', endColor:'#1a2a08', fem:false, size:16, hp:322, atk:82, def:26, spd:71, xp:51, gold:51, isBoss:false, eType:'guard' },
  { eid:'orc_warrior', name:'Орк воин', color:'#7a9a5a', endColor:'#1a2a08', fem:false, size:17, hp:252, atk:111, def:26, spd:75, xp:51, gold:51, isBoss:false, eType:'warrior' },
  { eid:'orc_boss', name:'Босс орков', color:'#ffb020', size:24, hp:4930, atk:192, def:30, spd:68, xp:60, gold:60, isBoss:true, eType:'boss' },
  { eid:'plant_guard', name:'Лоза страж', color:'#8aab6a', endColor:'#2a1a3a', fem:true, size:16, hp:604, atk:113, def:31, spd:46, xp:61, gold:61, isBoss:false, eType:'guard' },
  { eid:'plant_warrior', name:'Лоза воин', color:'#8aab6a', endColor:'#2a1a3a', fem:true, size:17, hp:472, atk:152, def:31, spd:50, xp:61, gold:61, isBoss:false, eType:'warrior' },
  { eid:'vampire_guard', name:'Вампир страж', color:'#9a8aab', endColor:'#1a0a2a', fem:false, size:17, hp:1133, atk:154, def:36, spd:101, xp:71, gold:71, isBoss:false, eType:'guard' },
  { eid:'vampire_warrior', name:'Вампир воин', color:'#9a8aab', endColor:'#1a0a2a', fem:false, size:18, hp:887, atk:209, def:36, spd:105, xp:71, gold:71, isBoss:false, eType:'warrior' },
  { eid:'beholder_guard', name:'Бехолдер страж', color:'#a878c0', endColor:'#2a0a3a', fem:false, size:18, hp:2127, atk:211, def:41, spd:66, xp:81, gold:81, isBoss:false, eType:'guard' },
  { eid:'beholder_warrior', name:'Бехолдер воин', color:'#a878c0', endColor:'#2a0a3a', fem:false, size:19, hp:1665, atk:286, def:41, spd:70, xp:81, gold:81, isBoss:false, eType:'warrior' },
  { eid:'beholder_boss', name:'Босс бехолдеров', color:'#c060ff', size:27, hp:32606, atk:495, def:45, spd:60, xp:90, gold:90, isBoss:true, eType:'boss' },
  { eid:'ent_guard', name:'Древень страж', color:'#8a6a4a', endColor:'#2a1a08', fem:false, size:20, hp:3993, atk:289, def:46, spd:41, xp:91, gold:91, isBoss:false, eType:'guard' },
  { eid:'ent_warrior', name:'Древень воин', color:'#8a6a4a', endColor:'#2a1a08', fem:false, size:21, hp:3125, atk:392, def:46, spd:45, xp:91, gold:91, isBoss:false, eType:'warrior' },
  { eid:'demon_guard', name:'Демон страж', color:'#c05050', endColor:'#3a0505', fem:false, size:21, hp:10270, atk:464, def:53, spd:71, xp:106, gold:106, isBoss:false, eType:'guard' },
  { eid:'demon_warrior', name:'Демон воин', color:'#c05050', endColor:'#3a0505', fem:false, size:22, hp:8038, atk:628, def:53, spd:75, xp:106, gold:106, isBoss:false, eType:'warrior' },
  { eid:'demon_boss', name:'Босс демонов', color:'#ff2020', size:32, hp:215667, atk:1274, def:60, spd:65, xp:120, gold:120, isBoss:true, eType:'boss' },
];

// Per-floor enemy pools for floors 1-5
const FLOOR_ENEMIES = {
  1: { bands: [
        { maxLocalLvl: 10, pool: ['rat_guard',      'rat_warrior']      },
        { maxLocalLvl: 20, pool: ['slime_guard',    'slime_warrior']    },
        { maxLocalLvl: 29, pool: ['imp_guard',       'imp_warrior']      },
      ], boss: 'imp_boss' },
  2: { bands: [
        { maxLocalLvl: 10, pool: ['zombie_guard',    'zombie_warrior']    },
        { maxLocalLvl: 20, pool: ['lizardman_guard', 'lizardman_warrior'] },
        { maxLocalLvl: 29, pool: ['orc_guard',        'orc_warrior']       },
      ], boss: 'orc_boss' },
  3: { bands: [
        { maxLocalLvl: 10, pool: ['plant_guard',    'plant_warrior']    },
        { maxLocalLvl: 20, pool: ['vampire_guard',  'vampire_warrior']  },
        { maxLocalLvl: 29, pool: ['beholder_guard', 'beholder_warrior'] },
      ], boss: 'beholder_boss' },
  4: { bands: [
        { maxLocalLvl: 15, pool: ['ent_guard',   'ent_warrior']   },
        { maxLocalLvl: 29, pool: ['demon_guard', 'demon_warrior'] },
      ], boss: 'demon_boss' },
};

// Picks the right band (and its 2-eid pool) for a given local room level —
// the last band whose maxLocalLvl covers it wins, so bands don't need to
// divide the 29 levels evenly.
function bandForLocalLevel(fe, localLvl) {
  const lvl = Math.max(1, localLvl || 1);
  return fe.bands.find(b => lvl <= b.maxLocalLvl) || fe.bands[fe.bands.length - 1];
}

// XP/gold: dead simple, 1:1 with the monster's global level — level 1 gives
// 1 XP / 1 gold, level 120 gives 120 XP / 120 gold. No more per-arm ×3/×2^N
// multipliers stacked on top; the level itself already carries the scaling.
function xpAtLevel(lvl)   { return Math.max(1, Math.round(lvl || 1)); }
function goldAtLevel(lvl) { return Math.max(1, Math.round(lvl || 1)); }

// Gold drop: 30% chance for regular enemies, 100% (guaranteed) for bosses —
// the roll only gates WHETHER gold drops, the amount is always goldAtLevel().
function calcGoldDrop(enemy) {
  const g = goldAtLevel(enemy.rlvl || 1);
  if (enemy.isBoss) return g;
  return Math.random() > 0.30 ? 0 : g;
}

// Equipment (gear) drop: one continuous per-kill chance that climbs +0.1
// percentage points every global level (never resets, never repeats — level
// 1 is 0.1%, level 2 is 0.2%, ... level 120 is 12.0%). Boss kills get a flat
// ×20 on top of their level's chance. Which RARITY drops is decided purely
// by which quarter of the 1-120 scale the level falls in.
const ITEM_DROP_GROWTH_PCT = 0.1; // percentage points per level
const BOSS_ITEM_DROP_MULT  = 20;
function itemDropChanceAtLevel(lvl) {
  return Math.min(100, ITEM_DROP_GROWTH_PCT * Math.max(1, lvl || 1));
}
function itemRarityForLevel(lvl) {
  lvl = Math.max(1, lvl || 1);
  if (lvl <= 30) return 'uncommon';
  if (lvl <= 60) return 'rare';
  if (lvl <= 90) return 'epic';
  return 'legendary';
}

// ── Open-world corridors ──────────────────────────────────────────────────────
// The world is one continuous map: a central hub room (spawn + NPCs) with 4
// corridors radiating out. Each corridor is a straight, empty main path with
// rooms branching off in facing pairs (one on each side) at ROOM_PAIRS_PER_ARM
// evenly spaced positions — ROOMS_PER_ARM = ROOM_PAIRS_PER_ARM * 2 rooms total
// per corridor. Global monster level 1-120 is assigned by position: rooms
// 1-30 in the left corridor, 31-60 top, 61-90 bottom, 91-120 right. Each
// corridor reuses one of the FLOOR_ENEMIES pools/themes below (arm index =
// old "floor" number) so enemy stats/gold/xp/rarity scaling keeps its
// existing tuning per zone.
const ARM_NAMES = ['left', 'top', 'bottom', 'right'];
const ROOM_PAIRS_PER_ARM = 15;
const ROOMS_PER_ARM = ROOM_PAIRS_PER_ARM * 2;
function armIndexForLevel(lvl) {
  return Math.min(ARM_NAMES.length, Math.max(1, Math.ceil((lvl || 1) / ROOMS_PER_ARM)));
}
function armNameForLevel(lvl) {
  return ARM_NAMES[armIndexForLevel(lvl) - 1];
}

// ── Items ─────────────────────────────────────────────────────────────────────
// Canonical item catalog — single source of truth for both client rendering
// and server-side validation (e.g. the Market only ever stores a listing's
// stats as recomputed from here, never whatever the client sent).
const CRAFT_MATS = [
  // ── Recipes (от всех) ───────────────────────────────────
  { id:'recu',  name:'Рецепт необычный',  img:'/images/material/recu.png',  slot:'recipe',   rarity:'uncommon'  },
  { id:'recr',  name:'Рецепт редкий',     img:'/images/material/recr.png',  slot:'recipe',   rarity:'rare'      },
  { id:'rece',  name:'Рецепт эпичный',    img:'/images/material/rece.png',  slot:'recipe',   rarity:'epic'      },
  { id:'recl',  name:'Рецепт легенд.',    img:'/images/material/recl.png',  slot:'recipe',   rarity:'legendary' },
  // ── Boss stone (от боссов) ──────────────────────────────
  { id:'boss_stone',  name:'Камень Босса',              img:'/images/material/bstone.png', slot:'material', rarity:'legendary' },
  // ── Enchant stones ──────────────────────────────────────
  { id:'norm_stone',  name:'Камень обычной заточки',    img:'/images/norm.png',  slot:'material', rarity:'uncommon' },
  { id:'bless_stone', name:'Камень безопасной заточки', img:'/images/bless.png', slot:'material', rarity:'rare'    },
  // ── Room-level keys (от монстров в комнатах подземелья) ──
  { id:'key_uncommon', name:'Необычный ключ', img:'/images/material/keyu.png', slot:'material', rarity:'uncommon' },
  { id:'key_rare',      name:'Редкий ключ',    img:'/images/material/keyr.png', slot:'material', rarity:'rare'     },
];

// ── Loot boxes ────────────────────────────────────────────────────────────────
// Crafted at the forge (Кузнец → Материалы) from room-level keys. Opening one
// rolls a rarity tier from `odds`, then a random matching gear item.
const BOX_DEF = [
  {
    id: 'box_uncommon', name: 'Необычный бокс', img: '/images/material/boxu.png', slot: 'box', rarity: 'uncommon',
    keyId: 'key_uncommon', keyCost: 500,
    odds: [ { rarity: 'common', chance: 0.60 }, { rarity: 'uncommon', chance: 0.40 } ],
  },
  {
    id: 'box_rare', name: 'Редкий бокс', img: '/images/material/boxr.png', slot: 'box', rarity: 'rare',
    keyId: 'key_rare', keyCost: 500,
    odds: [ { rarity: 'common', chance: 0.30 }, { rarity: 'uncommon', chance: 0.60 }, { rarity: 'rare', chance: 0.10 } ],
  },
];

const ITEM_DEF = [
  // ── Death Knight swords (was assassin's knife tier — same ids/progression,
  //    reforged as swords since deathknight replaced assasin) ────────────
  { id:'sw1', name:'Ржавый меч',       slot:'weapon', forClass:['deathknight'], img:'/images/wep/ck.png', atk:4,                            rarity:'common'   },
  { id:'sw2', name:'Стальной меч',     slot:'weapon', forClass:['deathknight'], img:'/images/wep/uk.png', atk:14,                           rarity:'uncommon' },
  { id:'sw3', name:'Меч дракона',      slot:'weapon', forClass:['deathknight'], img:'/images/wep/rk.png', atk:23, critChance:0.05,          rarity:'rare'     },
  { id:'sw4', name:'Меч теней',        slot:'weapon', forClass:['deathknight'], img:'/images/wep/ek.png', atk:44, critChance:0.10,          rarity:'epic'     },
  { id:'sw5', name:'Меч героя',        slot:'weapon', forClass:['deathknight'], img:'/images/wep/lk.png', atk:65, critChance:0.25,          rarity:'legendary'},
  // ── Lev's axes ─────────────────────────────────────────
  { id:'tw1', name:'Ржавый топор',     slot:'weapon', forClass:['lev'], img:'/images/wep/ct.png', atk:5,                            rarity:'common'   },
  { id:'tw2', name:'Стальной топор',   slot:'weapon', forClass:['lev'], img:'/images/wep/ut.png', atk:15,                           rarity:'uncommon' },
  { id:'tw3', name:'Топор дракона',    slot:'weapon', forClass:['lev'], img:'/images/wep/rt.png', atk:23,                           rarity:'rare'     },
  { id:'tw4', name:'Топор теней',      slot:'weapon', forClass:['lev'], img:'/images/wep/et.png', atk:44,                           rarity:'epic'     },
  { id:'tw5', name:'Топор героя',      slot:'weapon', forClass:['lev'], img:'/images/wep/lt.png', atk:65,                           rarity:'legendary'},
  // ── Ranger bows ──────────────────────────────────────────
  { id:'bw1', name:'Деревянный лук',   slot:'weapon', forClass:['ranger'],  img:'/images/wep/cb.png', atk:8,                            rarity:'common'   },
  { id:'bw2', name:'Серебряный лук',   slot:'weapon', forClass:['ranger'],  img:'/images/wep/ub.png', atk:18, atkSpeed:0.03,            rarity:'uncommon' },
  { id:'bw3', name:'Лук охотника',     slot:'weapon', forClass:['ranger'],  img:'/images/wep/rb.png', atk:28, atkSpeed:0.05,            rarity:'rare'     },
  { id:'bw4', name:'Лунный лук',       slot:'weapon', forClass:['ranger'],  img:'/images/wep/eb.png', atk:60, atkSpeed:0.10,            rarity:'epic'     },
  { id:'bw5', name:'Лук героя',        slot:'weapon', forClass:['ranger'],  img:'/images/wep/lb.png', atk:100, atkSpeed:0.15, critChance:0.10, rarity:'legendary'},
  // ── Mage / Warlock staves ─────────────────────────────────
  { id:'st1', name:'Посох новичка',    slot:'weapon', forClass:['mage','warlock'], img:'/images/wep/cs.png', atk:7,                      rarity:'common'   },
  { id:'st2', name:'Посох бойца',      slot:'weapon', forClass:['mage','warlock'], img:'/images/wep/us.png', atk:17,                     rarity:'uncommon' },
  { id:'st3', name:'Посох охотника',   slot:'weapon', forClass:['mage','warlock'], img:'/images/wep/rs.png', atk:30, hpPct:0.05,         rarity:'rare'     },
  { id:'st4', name:'Посох Героя',      slot:'weapon', forClass:['mage','warlock'], img:'/images/wep/es.png', atk:60, hpPct:0.10,         rarity:'epic'     },
  { id:'st5', name:'Посох Легенды',    slot:'weapon', forClass:['mage','warlock'], img:'/images/wep/ls.png', atk:120, hpPct:0.20, critChance:0.10, rarity:'legendary'},
  // ── Helmet ────────────────────────────────────────────────
  { id:'hm1', name:'Кожаный шлем',     slot:'helmet', img:'/images/arm/ch.png', hp:25,           rarity:'common'   },
  { id:'hm2', name:'Железный шлем',    slot:'helmet', img:'/images/arm/uh.png', hp:50,           rarity:'uncommon' },
  { id:'hm3', name:'Платиновый шлем',  slot:'helmet', img:'/images/arm/rh.png', hp:90,  atk:4,  rarity:'rare'     },
  { id:'hm4', name:'Корона героя',     slot:'helmet', img:'/images/arm/eh.png', hp:140, atk:8,  rarity:'epic'     },
  { id:'hm5', name:'Шлем легенды',     slot:'helmet', img:'/images/arm/lh.png', hp:210, atk:12, rarity:'legendary'},
  // ── Body ─────────────────────────────────────────────────
  { id:'ar1', name:'Кожаная броня',    slot:'body',   img:'/images/arm/ct.png', def:5,           rarity:'common'   },
  { id:'ar2', name:'Железная броня',   slot:'body',   img:'/images/arm/ut.png', def:11,          rarity:'uncommon' },
  { id:'ar3', name:'Платиновая броня', slot:'body',   img:'/images/arm/rt.png', def:20,          rarity:'rare'     },
  { id:'ar4', name:'Доспех героя',     slot:'body',   img:'/images/arm/et.png', def:33,          rarity:'epic'     },
  { id:'ar5', name:'Доспех легенды',   slot:'body',   img:'/images/arm/lt.png', def:48, hp:50,   rarity:'legendary'},
  // ── Gloves ───────────────────────────────────────────────
  { id:'gl1', name:'Кожаные перчи',    slot:'gloves', img:'/images/arm/cg.png', atk:2,           rarity:'common'   },
  { id:'gl2', name:'Железные перчи',   slot:'gloves', img:'/images/arm/ug.png', atk:5,           rarity:'uncommon' },
  { id:'gl3', name:'Платиновые перчи', slot:'gloves', img:'/images/arm/rg.png', atk:10,          rarity:'rare'     },
  { id:'gl4', name:'Перчатки героя',   slot:'gloves', img:'/images/arm/eg.png', atk:16, def:4,   rarity:'epic'     },
  { id:'gl5', name:'Перчатки легенды', slot:'gloves', img:'/images/arm/lg.png', atk:24, def:8,   rarity:'legendary'},
  // ── Boots ────────────────────────────────────────────────
  { id:'bt1', name:'Кожаные боты',     slot:'boots',  img:'/images/arm/cb.png', def:2,           rarity:'common'   },
  { id:'bt2', name:'Железные боты',    slot:'boots',  img:'/images/arm/ub.png', def:4,           rarity:'uncommon' },
  { id:'bt3', name:'Платиновые боты',  slot:'boots',  img:'/images/arm/rb.png', def:8,  atk:3,  rarity:'rare'     },
  { id:'bt4', name:'Боты героя',       slot:'boots',  img:'/images/arm/eb.png', def:14, atk:5,  rarity:'epic'     },
  { id:'bt5', name:'Боты легенды',     slot:'boots',  img:'/images/arm/lb.png', def:20, atk:10, rarity:'legendary'},
  // ── Ring ─────────────────────────────────────────────────
  { id:'rn1', name:'Кольцо силы',      slot:'ring',   img:'/images/acs/cr.png', atk:4,           rarity:'common'   },
  { id:'rn2', name:'Кольцо защиты',    slot:'ring',   img:'/images/acs/ur.png', def:4,           rarity:'uncommon' },
  { id:'rn3', name:'Кольцо крови',     slot:'ring',   img:'/images/acs/rr.png', atk:3,  hp:40,  rarity:'rare'     },
  { id:'rn4', name:'Кольцо героя',     slot:'ring',   img:'/images/acs/er.png', atk:8,  def:4,  rarity:'epic'     },
  { id:'rn5', name:'Кольцо легенды',   slot:'ring',   img:'/images/acs/lr.png', atk:14, def:8, hp:50, rarity:'legendary'},
  // ── Belt ─────────────────────────────────────────────────
  { id:'nd1', name:'Пояс силы',        slot:'belt',   img:'/images/acs/cp.png', atk:5,           rarity:'common'   },
  { id:'nd2', name:'Пояс здоровья',    slot:'belt',   img:'/images/acs/up.png', hp:60,           rarity:'uncommon' },
  { id:'nd3', name:'Пояс тьмы',        slot:'belt',   img:'/images/acs/rp.png', atk:8,  hp:30,  rarity:'rare'     },
  { id:'nd4', name:'Пояс героя',       slot:'belt',   img:'/images/acs/ep.png', atk:16, hp:80,  rarity:'epic'     },
  { id:'nd5', name:'Пояс легенды',     slot:'belt',   img:'/images/acs/lp.png', atk:24, hp:120, rarity:'legendary'},
  // ── HP Potions ────────────────────────────────────────────
  { id:'pt1', name:'Малое зелье',      slot:'use', img:'/images/potion/smallhp.png', hp:20, rarity:'common'   },
  { id:'pt2', name:'Большое зелье',    slot:'use', img:'/images/potion/bighp.png',   hp:50, rarity:'uncommon' },
  // ── Buff Potions ──────────────────────────────────────────
  { id:'bp_hp',       name:'Зелье здоровья',   slot:'buff_potion', img:'/images/potion/hp.png',       rarity:'uncommon', buffType:'hp',       buffDur:600, buffDesc:'+10% HP на 10 мин'            },
  { id:'bp_exp',      name:'Зелье опыта',       slot:'buff_potion', img:'/images/potion/exp.png',      rarity:'uncommon', buffType:'exp',      buffDur:600, buffDesc:'×2 опыт на 10 мин'            },
  { id:'bp_gold',     name:'Зелье золота',      slot:'buff_potion', img:'/images/potion/gold.png',     rarity:'uncommon', buffType:'gold',     buffDur:600, buffDesc:'×2 золото на 10 мин'          },
  { id:'bp_regen',    name:'Зелье регена',      slot:'buff_potion', img:'/images/potion/regen.png',    rarity:'uncommon', buffType:'regen',    buffDur:600, buffDesc:'+2 HP/сек на 10 мин'          },
  { id:'bp_atkspeed', name:'Зелье скорости',    slot:'buff_potion', img:'/images/potion/atkspeed.png', rarity:'uncommon', buffType:'atkspeed', buffDur:600, buffDesc:'+20% скорость атаки на 10 мин' },
  { id:'bp_atk',      name:'Зелье атаки',       slot:'buff_potion', img:'/images/potion/atk.png',      rarity:'uncommon', buffType:'atk',      buffDur:600, buffDesc:'+20% атаки на 10 мин'         },
];

// Max enchant-stone enhance level (mirrors the client's _ENH_MAX in ui.js)
const ENHANCE_MAX = 15;
// Slots whose atk/def/hp scale with enhance level (mirrors _enhBonusAt in player.js)
const ENHANCEABLE_SLOTS = new Set(['weapon', 'helmet', 'body', 'gloves', 'boots', 'ring', 'belt']);
function enhanceBonus(it, levels) {
  if (!levels) return {};
  const b = {};
  if (it.atk) b.atk = Math.max(1, Math.ceil(it.atk * 0.10)) * levels;
  if (it.def) b.def = Math.max(1, Math.ceil(it.def * 0.10)) * levels;
  if (it.hp)  b.hp  = Math.max(5, Math.ceil(it.hp  * 0.10)) * levels;
  return b;
}
// Items that stack into one inventory slot by id, tracked with a qty
// counter (mirrors _isStackable in player.js)
function isStackableItem(it) { return it.slot === 'material' || it.slot === 'recipe' || it.slot === 'buff_potion' || it.slot === 'box'; }

// ── Room-level monster progression ─────────────────────────────────────────────
// Each corridor (server/game/dungeon.js) chains ROOMS_PER_ARM rooms of
// increasing "local room level" 1..ROOMS_PER_ARM (room 1 = weakest, the last
// = that arm's boss room / strongest) — this resets every arm. The global
// display level (1-120, see armIndexForLevel above) feeds this via
// armLocalLevel(). Monster HP/ATK/DEF no longer scale off local room level at
// all (see monsterStatsAtLevel above, which is a function of the GLOBAL
// level only) — only item/key/enchant-stone drop chance still compounds per
// local room level below.
function armLocalLevel(globalLvl) {
  return ((Math.max(1, globalLvl || 1) - 1) % ROOMS_PER_ARM) + 1;
}

const ROOM_DROP_GROWTH     = 0.05; // +5% item-drop chance per room level
const ROOM_KEY_GROWTH      = 0.05; // +5% key-drop chance per room level
const ROOM_KEY_BASE = { uncommon: 0.05, rare: 0.01 }; // room level 1 base chance
const ROOM_ENCHANT_STONE_BASE   = 0.01; // room level 1 base chance (Камень обычной заточки)
const ROOM_ENCHANT_STONE_GROWTH = 0.01; // +1% per room level

function roomDropMult(lvl) {
  return Math.pow(1 + ROOM_DROP_GROWTH, Math.max(1, lvl || 1) - 1);
}
function roomKeyChance(lvl, tier) {
  const base = ROOM_KEY_BASE[tier] || 0;
  return base * Math.pow(1 + ROOM_KEY_GROWTH, Math.max(1, lvl || 1) - 1);
}
function roomEnchantStoneChance(lvl) {
  return ROOM_ENCHANT_STONE_BASE * Math.pow(1 + ROOM_ENCHANT_STONE_GROWTH, Math.max(1, lvl || 1) - 1);
}

// ── VIP System ────────────────────────────────────────────────────────────────
// GRAM threshold to reach THIS level (counter resets after each level-up)
const VIP_THRESHOLDS = [0, 1, 5, 10, 25, 50, 100, 150, 200, 300, 500];

// Cumulative permanent bonuses at each VIP level (index = level)
const VIP_BONUSES = [
  { xp:0,   gold:0,   drop:0   }, // 0 – no VIP
  { xp:5,   gold:0,   drop:0   }, // VIP 1
  { xp:5,   gold:5,   drop:0   }, // VIP 2
  { xp:10,  gold:10,  drop:0   }, // VIP 3
  { xp:20,  gold:20,  drop:0   }, // VIP 4
  { xp:35,  gold:35,  drop:10  }, // VIP 5
  { xp:50,  gold:50,  drop:20  }, // VIP 6
  { xp:60,  gold:60,  drop:25  }, // VIP 7
  { xp:75,  gold:75,  drop:30  }, // VIP 8
  { xp:90,  gold:90,  drop:40  }, // VIP 9
  { xp:100, gold:100, drop:100 }, // VIP 10
];

if (typeof module !== 'undefined') module.exports = {
  TILE, WALL, FLOOR, CHAR_DEF, ENEMY_DEF, FLOOR_ENEMIES, bandForLocalLevel, calcGoldDrop,
  xpAtLevel, goldAtLevel,
  ARM_NAMES, ROOM_PAIRS_PER_ARM, ROOMS_PER_ARM, armIndexForLevel, armNameForLevel, armLocalLevel,
  MONSTER_HP1, MONSTER_ATK1, MONSTER_HP_GROWTH, MONSTER_ATK_GROWTH, MONSTER_ARCHETYPE,
  BOSS_HP_MULT, BOSS_ATK_MULT,
  monsterHPAtLevel, monsterATKAtLevel, monsterDEFAtLevel, monsterStatsAtLevel,
  MONSTER_RANK_M, MONSTER_RANK_F, monsterNameAtLevel, monsterColorAtLevel,
  VIP_THRESHOLDS, VIP_BONUSES,
  ITEM_DEF, CRAFT_MATS, BOX_DEF, ENHANCE_MAX, ENHANCEABLE_SLOTS, enhanceBonus, isStackableItem,
  ITEM_DROP_GROWTH_PCT, BOSS_ITEM_DROP_MULT, itemDropChanceAtLevel, itemRarityForLevel,
  ROOM_DROP_GROWTH, ROOM_KEY_GROWTH, ROOM_KEY_BASE,
  ROOM_ENCHANT_STONE_BASE, ROOM_ENCHANT_STONE_GROWTH,
  roomDropMult, roomKeyChance, roomEnchantStoneChance,
};
