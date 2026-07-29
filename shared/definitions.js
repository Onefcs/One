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
// hp/atk/def below are monsterStatsAtLevel() evaluated at each zone's first
// room (arm's start level) and boss room (arm's last level) — a static
// snapshot used as-is by the Raid and Party-dungeon modes (which don't have
// a room-progression concept of their own) and as display fallback. The main
// open world (server/game/dungeon.js) ignores these numbers entirely and
// calls monsterStatsAtLevel() fresh for the enemy's actual room level, and
// overrides name/color per spawn via monsterNameAtLevel/monsterColorAtLevel.
// fem: grammatical gender of the base name's leading noun, for rank agreement
// (skel/goblin/mush/golem nouns are masculine, "Тень" is feminine).
// endColor: the room-29 (strongest non-boss) tint monsterColorAtLevel ramps to.
const ENEMY_DEF = [
  // Arm 1 (levels 1-30) — Skeletons
  { eid:'skel_warrior',   name:'Скелет воин',   color:'#bbb', endColor:'#5c1a24', fem:false, size:15, hp:11,  atk:23,  def:1,  spd:81,  xp:2,  gold:[1,3],   isBoss:false, eType:'warrior' },
  { eid:'skel_barbarian', name:'Скелет варвар', color:'#ccc', endColor:'#4a1420', fem:false, size:16, hp:14,  atk:17,  def:1,  spd:93,  xp:3,  gold:[1,3],   isBoss:false, eType:'guard'   },
  { eid:'skel_boss',      name:'Босс скелетов', color:'#eee', size:24, hp:745,  atk:75,  def:15, spd:99,  xp:20, gold:[15,25], isBoss:true,  eType:'boss'    },
  // Arm 2 (levels 31-60) — Goblins
  { eid:'goblin_guard',   name:'Гоблин страж',  color:'#4a4', endColor:'#123d1a', fem:false, size:13, hp:91, atk:44,  def:16, spd:70,  xp:4,  gold:[1,3],   isBoss:false, eType:'guard'   },
  { eid:'goblin_warrior', name:'Гоблин воин',   color:'#2a5', endColor:'#0a3d14', fem:false, size:14, hp:71, atk:59,  def:16, spd:75,  xp:5,  gold:[1,3],   isBoss:false, eType:'warrior' },
  { eid:'goblin_boss',    name:'Босс гоблинов', color:'#0f5', size:22, hp:4930,  atk:192, def:30, spd:83,  xp:30, gold:[20,35], isBoss:true,  eType:'boss'    },
  // Arm 3 (levels 61-90) — Mushrooms
  { eid:'mush_guard',     name:'Гриб страж',    color:'#c63', endColor:'#4a1c08', fem:false, size:13, hp:604, atk:113, def:31, spd:60,  xp:6,  gold:[1,3],   isBoss:false, eType:'guard'   },
  { eid:'mush_warrior',   name:'Гриб воин',     color:'#d74', endColor:'#5c2408', fem:false, size:15, hp:472, atk:152, def:31, spd:65,  xp:7,  gold:[1,3],   isBoss:false, eType:'warrior' },
  { eid:'mush_boss',      name:'Босс грибов',   color:'#f85', size:26, hp:32606, atk:495, def:45, spd:68,  xp:45, gold:[30,50], isBoss:true,  eType:'boss'    },
  // Arm 4 (levels 91-120) — Ghosts
  { eid:'ghost_warrior',  name:'Тень воин',     color:'#88f', endColor:'#0f0f4a', fem:true,  size:16, hp:3125, atk:392, def:46, spd:110, xp:8,  gold:[1,3],   isBoss:false, eType:'warrior' },
  { eid:'ghost_guard',    name:'Тень страж',    color:'#aaf', endColor:'#1a1a5c', fem:true,  size:14, hp:3993, atk:289, def:46, spd:120, xp:7,  gold:[1,3],   isBoss:false, eType:'guard'   },
  { eid:'ghost_boss',     name:'Босс теней',    color:'#ccf', size:28, hp:215667, atk:1274, def:60, spd:128, xp:60, gold:[40,65], isBoss:true,  eType:'boss'    },
  // Arm 5 (levels 121-150) — Golems, defined but currently unused: only 4
  // arms are ever built (ARM_NAMES), so this pool never actually spawns.
  { eid:'golem_warrior',  name:'Голем воин',    color:'#964', endColor:'#3a1a08', fem:false, size:20, hp:20672, atk:1008, def:61, spd:50,  xp:10, gold:[1,3],   isBoss:false, eType:'warrior' },
  { eid:'golem_guard',    name:'Голем страж',   color:'#875', endColor:'#2e1406', fem:false, size:18, hp:26414, atk:745, def:61, spd:55,  xp:9,  gold:[1,3],   isBoss:false, eType:'guard'   },
  { eid:'golem_boss',     name:'Босс големов',  color:'#ba6', size:32, hp:1426503,atk:3276, def:75, spd:60,  xp:80, gold:[55,80], isBoss:true,  eType:'boss'    },
];

// Per-floor enemy pools for floors 1-5
const FLOOR_ENEMIES = {
  1: { pool: ['skel_warrior',  'skel_barbarian'], boss: 'skel_boss'     },
  2: { pool: ['goblin_guard', 'goblin_warrior'], boss: 'goblin_boss'   },
  3: { pool: ['mush_guard',   'mush_warrior'],   boss: 'mush_boss'     },
  4: { pool: ['ghost_warrior','ghost_guard'],     boss: 'ghost_boss'    },
  5: { pool: ['golem_warrior','golem_guard'],     boss: 'golem_boss'    },
};

// Equipment rarity drops: per-kill chance (0-1) of an uncommon+ gear item
// dropping on that floor. Boss kills use BOSS_RARITY_DROP_MULT × this chance.
const FLOOR_RARITY_DROPS = {
  1: { uncommon: 0.00001 },
  2: { uncommon: 0.00005,  rare: 0.000005 },
  3: { rare: 0.00005,      epic: 0.000005 },
  4: { epic: 0.00005,      legendary: 0.00001 },
  5: { legendary: 0.00005 },
};
const BOSS_RARITY_DROP_MULT = 20;

// Gold drop: 30% chance for regular enemies, 100% for bosses. Scales with floor.
// Floors 2-5 receive a ×3 gold bonus on top of the base scaling.
function calcGoldDrop(enemy, floor) {
  const floorBonus = (floor >= 2 && floor <= 5) ? 3 : 1;
  if (enemy.isBoss) {
    const g = enemy.gold || [50, 50];
    return Math.round((g[0] + Math.floor(Math.random() * (g[1] - g[0] + 1))) * floorBonus);
  }
  if (Math.random() > 0.30) return 0;
  const base = enemy.gold[0] + Math.floor(Math.random() * (enemy.gold[1] - enemy.gold[0] + 1));
  return Math.round(base * Math.pow(2, floor - 1) * floorBonus);
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
  TILE, WALL, FLOOR, CHAR_DEF, ENEMY_DEF, FLOOR_ENEMIES, calcGoldDrop,
  ARM_NAMES, ROOM_PAIRS_PER_ARM, ROOMS_PER_ARM, armIndexForLevel, armNameForLevel, armLocalLevel,
  MONSTER_HP1, MONSTER_ATK1, MONSTER_HP_GROWTH, MONSTER_ATK_GROWTH, MONSTER_ARCHETYPE,
  BOSS_HP_MULT, BOSS_ATK_MULT,
  monsterHPAtLevel, monsterATKAtLevel, monsterDEFAtLevel, monsterStatsAtLevel,
  MONSTER_RANK_M, MONSTER_RANK_F, monsterNameAtLevel, monsterColorAtLevel,
  VIP_THRESHOLDS, VIP_BONUSES,
  ITEM_DEF, CRAFT_MATS, BOX_DEF, ENHANCE_MAX, ENHANCEABLE_SLOTS, enhanceBonus, isStackableItem,
  FLOOR_RARITY_DROPS, BOSS_RARITY_DROP_MULT,
  ROOM_DROP_GROWTH, ROOM_KEY_GROWTH, ROOM_KEY_BASE,
  ROOM_ENCHANT_STONE_BASE, ROOM_ENCHANT_STONE_GROWTH,
  roomDropMult, roomKeyChance, roomEnchantStoneChance,
};
