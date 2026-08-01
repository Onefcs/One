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
  lev:         { name:'Танк',         icon:'lev',        color:'#9aa3ab', baseHP:260, baseAtk:2, baseDef:14, speed:130, atkRange:58,  atkSpeed:1.000, atkType:'melee' },
  deathknight: { name:'Рыцарь Смерти',icon:'skull',      color:'#7a5c99', baseHP:200, baseAtk:3, baseDef:10, speed:145, atkRange:58,  atkSpeed:1.197, atkType:'melee' },
  ranger:      { name:'Егерь',        icon:'archerClass',color:'#5c7a4a', baseHP:140, baseAtk:2, baseDef:5,  speed:175, atkRange:210, atkSpeed:1.593, atkType:'ranged', projColor:'#8fbf5a' },
  mage:        { name:'Маг',          icon:'mageClass',  color:'#5c7fbf', baseHP:110, baseAtk:4, baseDef:3,  speed:155, atkRange:180, atkSpeed:0.837, atkType:'ranged', projColor:'#66aaff' },
  warlock:     { name:'Целитель',     icon:'mageClass',  color:'#8a3a4a', baseHP:160, baseAtk:2, baseDef:7,  speed:148, atkRange:170, atkSpeed:1.200, atkType:'ranged', projColor:'#a855e0' },
};

// ── Monster level curve ────────────────────────────────────────────────────────
// Global monster level (1-120, see armIndexForLevel below) drives HP/ATK/DEF
// directly through one continuous formula — this replaces the old system
// where per-room, per-zone and "early level" multipliers all stacked on top
// of each other at spawn time (server/game/dungeon.js), which made the
// boss-vs-trash ratio swing wildly depending on where in a corridor you were.
//
// HP/ATK are a flat multiple of the level-1 value: level N is exactly N times
// the level-1 stat (level 2 = ×2, level 3 = ×3, ... level 120 = ×120). No
// compounding — this replaced an earlier exponential-growth curve that made
// stats explode at high levels. DEF stays on its own flat linear formula at
// every level so it never grows faster than a player's own ATK and floors
// damage to a boring "always 1".
const MONSTER_HP1  = 12; // HP at level 1, before archetype/boss multipliers
const MONSTER_ATK1 = 10; // ATK at level 1, before archetype/boss multipliers (halved)
function monsterDEFAtLevel(lvl) { return Math.max(0, Math.round(1 * Math.max(1, lvl || 1))); } // doubled
function monsterHPAtLevel(lvl) {
  lvl = Math.max(1, lvl || 1);
  const mult = lvl > 20 ? 15 : 1;
  return MONSTER_HP1 * lvl * mult;
}
function monsterATKAtLevel(lvl) {
  lvl = Math.max(1, lvl || 1);
  return MONSTER_ATK1 * lvl;
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
// maxLocalLvl is the arm's own last non-boss room (arms differ in length —
// see ARM_ROOM_COUNTS below), so every arm still sweeps the full rank list
// from 'Слабый' at room 1 to 'Запредельный' right before its boss, regardless
// of how many rooms that arm actually has.
function monsterNameAtLevel(baseName, localLvl, isBoss, fem, maxLocalLvl) {
  if (isBoss) return baseName;
  const ranks = fem ? MONSTER_RANK_F : MONSTER_RANK_M;
  const denom = Math.max(1, (maxLocalLvl || ranks.length) - 1);
  const t = Math.min(1, Math.max(0, ((localLvl || 1) - 1) / denom));
  return ranks[Math.round(t * (ranks.length - 1))] + ' ' + baseName;
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
// `endColor` (strongest, last non-boss room) — bosses keep their own fixed
// color. maxLocalLvl works the same as in monsterNameAtLevel above.
function monsterColorAtLevel(baseColor, endColor, localLvl, isBoss, maxLocalLvl) {
  if (isBoss || !endColor) return baseColor;
  const denom = Math.max(1, (maxLocalLvl || MONSTER_RANK_M.length) - 1);
  const t = Math.min(1, Math.max(0, ((localLvl || 1) - 1) / denom));
  return _lerpHexColor(baseColor, endColor, t);
}

// ── Enemy definitions ─────────────────────────────────────────────────────────
// Each of the 4 arms rotates through several DIFFERENT monster species EVERY
// ROOM — room 1 is species A, room 2 is species B, room 3 is species C, room
// 4 is back to species A, and so on (see FLOOR_ENEMIES' `species` list and
// bandForLocalLevel below) — so no two consecutive rooms ever show the same
// sprite, unlike the old design where one species held 10 rooms in a row.
// Every monster IN a room is the same species and the same archetype (all
// guard or all warrior, never mixed) — the archetype flips every time the
// rotation completes a full lap through the arm's species list, so an exact
// species+archetype combo only repeats every few laps, not every room. The
// arm's boss reuses that arm's last (toughest) species' own "elite" tier for
// its look, so the boss always feels like a stronger version of something
// you were just fighting.
//
// hp/atk/def/xp/gold below are monsterStatsAtLevel()/xpAtLevel()/goldAtLevel()
// evaluated at a representative level for each species (or the arm's last
// level for bosses) — a static snapshot used as-is by the Raid and
// Party-dungeon modes (which don't have a room-progression concept of their
// own) and as display fallback. The main open world (server/game/dungeon.js)
// ignores these numbers entirely and calls the level functions fresh for the
// enemy's actual room level, overriding name/color/hp/atk/def/xp/gold per
// spawn.
// fem: grammatical gender of the base name's leading noun, for rank agreement
// (Крыса/Лоза are feminine, the rest are masculine).
// endColor: the tint monsterColorAtLevel ramps to at the arm's last non-boss
// room (see maxLocalLvl in monsterColorAtLevel above).
const ENEMY_DEF = [
  { eid:'rat_guard', name:'Крыса страж', color:'#8a7a6a', endColor:'#3a2a1a', fem:true, size:13, hp:14, atk:17, def:1, spd:112, xp:1, gold:1, isBoss:false, eType:'guard' },
  { eid:'rat_warrior', name:'Крыса воин', color:'#8a7a6a', endColor:'#3a2a1a', fem:true, size:14, hp:11, atk:23, def:1, spd:118, xp:1, gold:1, isBoss:false, eType:'warrior' },
  { eid:'slime_guard', name:'Слизень страж', color:'#7ac47a', endColor:'#1a3a10', fem:false, size:13, hp:152, atk:187, def:6, spd:52, xp:11, gold:11, isBoss:false, eType:'guard' },
  { eid:'slime_warrior', name:'Слизень воин', color:'#7ac47a', endColor:'#1a3a10', fem:false, size:14, hp:119, atk:253, def:6, spd:56, xp:11, gold:11, isBoss:false, eType:'warrior' },
  { eid:'imp_guard', name:'Бес страж', color:'#c47a5a', endColor:'#4a1408', fem:false, size:14, hp:290, atk:357, def:11, spd:92, xp:21, gold:21, isBoss:false, eType:'guard' },
  { eid:'imp_warrior', name:'Бес воин', color:'#c47a5a', endColor:'#4a1408', fem:false, size:15, hp:227, atk:483, def:11, spd:97, xp:21, gold:21, isBoss:false, eType:'warrior' },
  { eid:'imp_boss', name:'Босс бесов', color:'#ff6a3a', size:22, hp:3600, atk:900, def:15, spd:88, xp:30, gold:30, isBoss:true, eType:'boss' },
  { eid:'zombie_guard', name:'Зомби страж', color:'#8aab7a', endColor:'#1a2a10', fem:false, size:15, hp:428, atk:527, def:16, spd:56, xp:31, gold:31, isBoss:false, eType:'guard' },
  { eid:'zombie_warrior', name:'Зомби воин', color:'#8aab7a', endColor:'#1a2a10', fem:false, size:16, hp:335, atk:713, def:16, spd:60, xp:31, gold:31, isBoss:false, eType:'warrior' },
  { eid:'lizardman_guard', name:'Ящер страж', color:'#6ab26a', endColor:'#0a2a0a', fem:false, size:15, hp:566, atk:697, def:21, spd:76, xp:41, gold:41, isBoss:false, eType:'guard' },
  { eid:'lizardman_warrior', name:'Ящер воин', color:'#6ab26a', endColor:'#0a2a0a', fem:false, size:16, hp:443, atk:943, def:21, spd:80, xp:41, gold:41, isBoss:false, eType:'warrior' },
  { eid:'orc_guard', name:'Орк страж', color:'#7a9a5a', endColor:'#1a2a08', fem:false, size:16, hp:704, atk:867, def:26, spd:71, xp:51, gold:51, isBoss:false, eType:'guard' },
  { eid:'orc_warrior', name:'Орк воин', color:'#7a9a5a', endColor:'#1a2a08', fem:false, size:17, hp:551, atk:1173, def:26, spd:75, xp:51, gold:51, isBoss:false, eType:'warrior' },
  { eid:'orc_boss', name:'Босс орков', color:'#ffb020', size:24, hp:7200, atk:1800, def:30, spd:68, xp:60, gold:60, isBoss:true, eType:'boss' },
  { eid:'plant_guard', name:'Лоза страж', color:'#8aab6a', endColor:'#2a1a3a', fem:true, size:16, hp:842, atk:1037, def:31, spd:46, xp:61, gold:61, isBoss:false, eType:'guard' },
  { eid:'plant_warrior', name:'Лоза воин', color:'#8aab6a', endColor:'#2a1a3a', fem:true, size:17, hp:659, atk:1403, def:31, spd:50, xp:61, gold:61, isBoss:false, eType:'warrior' },
  { eid:'vampire_guard', name:'Вампир страж', color:'#9a8aab', endColor:'#1a0a2a', fem:false, size:17, hp:980, atk:1207, def:36, spd:101, xp:71, gold:71, isBoss:false, eType:'guard' },
  { eid:'vampire_warrior', name:'Вампир воин', color:'#9a8aab', endColor:'#1a0a2a', fem:false, size:18, hp:767, atk:1633, def:36, spd:105, xp:71, gold:71, isBoss:false, eType:'warrior' },
  { eid:'beholder_guard', name:'Бехолдер страж', color:'#a878c0', endColor:'#2a0a3a', fem:false, size:18, hp:1118, atk:1377, def:41, spd:66, xp:81, gold:81, isBoss:false, eType:'guard' },
  { eid:'beholder_warrior', name:'Бехолдер воин', color:'#a878c0', endColor:'#2a0a3a', fem:false, size:19, hp:875, atk:1863, def:41, spd:70, xp:81, gold:81, isBoss:false, eType:'warrior' },
  { eid:'beholder_boss', name:'Босс бехолдеров', color:'#c060ff', size:27, hp:10800, atk:2700, def:45, spd:60, xp:90, gold:90, isBoss:true, eType:'boss' },
  { eid:'ent_guard', name:'Древень страж', color:'#8a6a4a', endColor:'#2a1a08', fem:false, size:20, hp:1256, atk:1547, def:46, spd:41, xp:91, gold:91, isBoss:false, eType:'guard' },
  { eid:'ent_warrior', name:'Древень воин', color:'#8a6a4a', endColor:'#2a1a08', fem:false, size:21, hp:983, atk:2093, def:46, spd:45, xp:91, gold:91, isBoss:false, eType:'warrior' },
  { eid:'demon_guard', name:'Демон страж', color:'#c05050', endColor:'#3a0505', fem:false, size:21, hp:1463, atk:1802, def:53, spd:71, xp:106, gold:106, isBoss:false, eType:'guard' },
  { eid:'demon_warrior', name:'Демон воин', color:'#c05050', endColor:'#3a0505', fem:false, size:22, hp:1145, atk:2438, def:53, spd:75, xp:106, gold:106, isBoss:false, eType:'warrior' },
  { eid:'demon_boss', name:'Босс демонов', color:'#ff2020', size:32, hp:14400, atk:3600, def:60, spd:65, xp:120, gold:120, isBoss:true, eType:'boss' },
];

// Per-arm species rotation, ordered weakest → strongest (the last entry is
// the one whose "elite" tier the arm's boss uses for its look).
const FLOOR_ENEMIES = {
  1: { species: ['rat',     'slime',      'imp']      , boss: 'imp_boss' },
  2: { species: ['zombie',  'lizardman',  'orc']      , boss: 'orc_boss' },
  3: { species: ['plant',   'vampire',    'beholder'] , boss: 'beholder_boss' },
  4: { species: ['ent',     'demon']                  , boss: 'demon_boss' },
};

// Picks the ONE species+archetype (guard or warrior) that every monster in a
// given room shares, cycling through fe.species one room at a time — room 1
// = species[0], room 2 = species[1], ..., wrapping back to species[0] after
// the last one — so every consecutive room gets a different species. The
// archetype flips (guard → warrior → guard...) every time the rotation
// completes a full lap through fe.species, so a room's exact species+
// archetype combo only repeats every species.length*2 rooms (6 rooms for a
// 3-species arm, 4 for arm 4's 2-species one) instead of every room.
function bandForLocalLevel(fe, localLvl) {
  const lvl = Math.max(1, localLvl || 1) - 1;
  const idx = lvl % fe.species.length;
  const lap = Math.floor(lvl / fe.species.length) % 2;
  const sp = fe.species[idx];
  const eid = sp + (lap === 0 ? '_guard' : '_warrior');
  return { pool: [eid], species: sp, eid };
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

// Equipment (gear) drop: which RARITY drops is decided by the level — 1-10
// is common-only (a gearless-start on-ramp), then arm ranges the same as
// before (each arm from 11 onward = one rarity tier).
const COMMON_ITEM_MAX_LEVEL = 10;
const BOSS_ITEM_DROP_MULT  = 20;
function itemRarityForLevel(lvl) {
  lvl = Math.max(1, lvl || 1);
  if (lvl <= COMMON_ITEM_MAX_LEVEL) return 'common';
  if (lvl <= ARM_OFFSETS[1]) return 'uncommon';
  if (lvl <= ARM_OFFSETS[2]) return 'rare';
  if (lvl <= ARM_OFFSETS[3]) return 'epic';
  return 'legendary';
}
// The level each rarity tier starts at — used both to know how far into its
// own tier a level is (for the within-tier growth below) and to chain the
// ×5 step-down between tiers.
const _ITEM_RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
function _itemTierMinLevel(rarity) {
  if (rarity === 'common')    return 1;
  if (rarity === 'uncommon')  return COMMON_ITEM_MAX_LEVEL + 1;
  if (rarity === 'rare')      return ARM_OFFSETS[1] + 1;
  if (rarity === 'epic')      return ARM_OFFSETS[2] + 1;
  return ARM_OFFSETS[3] + 1; // legendary
}
// Equipment (gear) drop: within a rarity tier the chance climbs from that
// tier's starting value up to the same ceiling a flat +0.1 percentage-point-
// per-level step would have reached by the tier's last level — BUT smoothly
// (geometric interpolation), not linearly. A flat +0.1pp step made sense for
// the common tier (which starts at 0.1%) but produced a ~25x jump within the
// first level or two of entering uncommon/rare/epic/legendary, since those
// tiers start at a tiny fraction of a percent (1/5th of the previous tier's
// start, see ITEM_TIER_STEPDOWN) — the additive step completely dwarfed the
// starting value instead of gradually building on it. Boss kills still get a
// flat ×20 on top.
const ITEM_DROP_GROWTH_PCT = 0.1;     // percentage points per level — only used to derive each tier's END value (as if linear), not the actual per-level step anymore
const ITEM_TIER_STEPDOWN   = 5;       // each new tier starts at (prev tier start) / 5
function _itemTierStartChancePct(rarity) {
  let pct = ITEM_DROP_GROWTH_PCT; // common tier starts at level 1's value: 0.1%
  for (let i = 0; i < _ITEM_RARITY_ORDER.indexOf(rarity); i++) pct /= ITEM_TIER_STEPDOWN;
  return pct;
}
// Extra multiplier applied uniformly across one rarity's whole curve (start
// AND end alike), on top of the geometric chain above — a knob for tuning a
// single tier's overall drop rate without disturbing the /5 step-down chain
// the other tiers derive their own start from.
const _ITEM_TIER_EXTRA_MULT = { uncommon: 0.1 };
// Last level still inside a given tier (one level before the next tier's
// _itemTierMinLevel, or the world's max level for legendary).
function _itemTierMaxLevel(rarity) {
  const idx = _ITEM_RARITY_ORDER.indexOf(rarity);
  if (idx >= _ITEM_RARITY_ORDER.length - 1) return MAX_MONSTER_LEVEL;
  return _itemTierMinLevel(_ITEM_RARITY_ORDER[idx + 1]) - 1;
}
function itemDropChanceAtLevel(lvl) {
  lvl = Math.max(1, lvl || 1);
  const rarity = itemRarityForLevel(lvl);
  const tierMin = _itemTierMinLevel(rarity);
  const tierMax = _itemTierMaxLevel(rarity);
  const startPct = _itemTierStartChancePct(rarity);
  const endPct = startPct + ITEM_DROP_GROWTH_PCT * (tierMax - tierMin);
  const span = Math.max(1, tierMax - tierMin);
  const frac = Math.min(1, (lvl - tierMin) / span);
  const pct = startPct * Math.pow(endPct / startPct, frac);
  return Math.min(100, pct * (_ITEM_TIER_EXTRA_MULT[rarity] || 1));
}

// ── Open-world corridors ──────────────────────────────────────────────────────
// The world is one continuous map: a central hub room (spawn + NPCs) with 4
// corridors radiating out. Each corridor is a straight, empty main path with
// rooms branching off in facing pairs (one on each side) at ARM_ROOM_PAIRS[i]
// evenly spaced positions — ARM_ROOM_COUNTS[i] = ARM_ROOM_PAIRS[i] * 2 rooms
// total for that corridor. Arms 1-3 (left/top/bottom) get 20 rooms each, arm
// 4 (right) gets 18 (it only has 2 species instead of 3) — MAX_MONSTER_LEVEL
// (78) is the sum of all 4. Global monster level is assigned by position:
// see ARM_OFFSETS below for where each arm's range starts. Each corridor
// reuses one of the FLOOR_ENEMIES pools/themes below (arm index = old
// "floor" number) so enemy stats/gold/xp/rarity scaling keeps its existing
// tuning per zone.
const ARM_NAMES = ['left', 'top', 'bottom', 'right'];
const ARM_ROOM_PAIRS  = [10, 10, 10, 9];                  // rooms-per-arm ÷ 2, indexed by armIdx-1
const ARM_ROOM_COUNTS = ARM_ROOM_PAIRS.map(p => p * 2);   // [20, 20, 20, 18]
const ARM_OFFSETS = [];                                   // global level right before each arm starts
for (let i = 0, sum = 0; i < ARM_ROOM_COUNTS.length; i++) { ARM_OFFSETS.push(sum); sum += ARM_ROOM_COUNTS[i]; }
const MAX_MONSTER_LEVEL = ARM_OFFSETS[ARM_OFFSETS.length - 1] + ARM_ROOM_COUNTS[ARM_ROOM_COUNTS.length - 1]; // 78
function roomsInArm(armIdx) { return ARM_ROOM_COUNTS[Math.min(ARM_ROOM_COUNTS.length, Math.max(1, armIdx || 1)) - 1]; }
function armIndexForLevel(lvl) {
  lvl = Math.max(1, lvl || 1);
  for (let i = 0; i < ARM_ROOM_COUNTS.length; i++) {
    if (lvl <= ARM_OFFSETS[i] + ARM_ROOM_COUNTS[i]) return i + 1;
  }
  return ARM_ROOM_COUNTS.length;
}
function armNameForLevel(lvl) {
  return ARM_NAMES[armIndexForLevel(lvl) - 1];
}

// Character level required to pass through each arm's hub door — a level-1
// player wandering straight into arm 3's monsters would just get shredded, so
// the entrance doubles as a gate matching where the PREVIOUS arm tops out.
const ARM_LEVEL_REQ = { left: 0, top: 20, bottom: 40, right: 60 };

// ── Items ─────────────────────────────────────────────────────────────────────
// Canonical item catalog — single source of truth for both client rendering
// and server-side validation (e.g. the Market only ever stores a listing's
// stats as recomputed from here, never whatever the client sent).
// [class, skillKey, name] — name must match SKILL_DEF[class][i].name exactly
// (js/definitions.js) so a book's label always names the ability it unlocks.
const _SKILL_BOOK_SRC = [
  ['lev', 'Q', 'Ледяной удар'], ['lev', 'W', 'Смерч клинков'], ['lev', 'E', 'Гнев мертвеца'], ['lev', 'R', 'Рывок света'],
  ['deathknight', 'Q', 'Вампиризм'], ['deathknight', 'W', 'Вихрь клинка'], ['deathknight', 'E', 'Ярость'], ['deathknight', 'R', 'Кувырок'],
  ['ranger', 'Q', 'Мульти-выстрел'], ['ranger', 'W', 'Комбо стрела'], ['ranger', 'E', 'Прыжок'], ['ranger', 'R', 'Скорость атаки'],
  ['mage', 'Q', 'Ледяной шар'], ['mage', 'W', 'Ледяная нова'], ['mage', 'E', 'Барьер'], ['mage', 'R', 'Телепорт'],
  ['warlock', 'Q', 'Тёмное исцеление'], ['warlock', 'W', 'Оковы тьмы'], ['warlock', 'E', 'Тёмный щит'], ['warlock', 'R', 'Тёмная молитва'],
];

// [class, passiveId, name] — class-exclusive pair of passives, one book per
// class+passive combo. Name must match PASSIVE_CLASS_DEF's entry for that
// id exactly (further down in this file).
const _PASSIVE_BOOK_SRC = [
  ['lev', 'tankatk', 'Мощь берсерка'], ['lev', 'deftank', 'Несокрушимость'],
  ['deathknight', 'dkatk', 'Кровавый пакт'], ['deathknight', 'dkdef', 'Тёмный панцирь'],
  ['ranger', 'bowatk', 'Меткий глаз'], ['ranger', 'bowdef', 'Чутьё следопыта'],
  ['mage', 'mageatk', 'Поток маны'], ['mage', 'magedef', 'Ледяной щит'],
  ['warlock', 'healatk', 'Тёмная жажда'], ['warlock', 'healdef', 'Оберег тьмы'],
];
// [passiveId, name] — universal passives, no class attached (PASSIVE_COMMON_DEF).
const _PASSIVE_COMMON_BOOK_SRC = [
  ['allatkspeed', 'Стремительность'], ['allhp', 'Живучесть'], ['allcritdmg', 'Кровавая ярость'],
  ['allspeed', 'Быстрые ноги'], ['allcdskill', 'Ясный разум'], ['allregen', 'Регенерация'],
];

const CRAFT_MATS = [
  // ── Recipes (от всех) ───────────────────────────────────
  { id:'recu',  name:'Рецепт необычный',  img:'/images/material/recu.png',  slot:'recipe',   rarity:'uncommon'  },
  { id:'recr',  name:'Рецепт редкий',     img:'/images/material/recr.png',  slot:'recipe',   rarity:'rare'      },
  { id:'rece',  name:'Рецепт эпичный',    img:'/images/material/rece.png',  slot:'recipe',   rarity:'epic'      },
  { id:'recl',  name:'Рецепт легенд.',    img:'/images/material/recl.png',  slot:'recipe',   rarity:'legendary' },
  // ── Enchant stones ──────────────────────────────────────
  { id:'norm_stone',  name:'Камень обычной заточки',    img:'/images/norm.png',  slot:'material', rarity:'uncommon' },
  { id:'bless_stone', name:'Камень безопасной заточки', img:'/images/bless.png', slot:'material', rarity:'rare'    },
  // ── Room-level keys (от монстров в комнатах подземелья) ──
  { id:'key_uncommon', name:'Необычный ключ', img:'/images/material/keyu.png', slot:'material', rarity:'uncommon' },
  { id:'key_rare',      name:'Редкий ключ',    img:'/images/material/keyr.png', slot:'material', rarity:'rare'     },
  // ── Skill books (изучение/прокачка Q/W/E/R) ──────────────
  // One book per class+skill-key combo — each class's Q/W/E/R is a
  // different ability, so a generic book wouldn't identify which one it
  // unlocks. Names mirror SKILL_DEF (js/definitions.js) so the two never
  // drift apart; the client resolves each book's actual icon/img by looking
  // up forClass+skillKey against SKILL_DEF at render time (see _itemIcon in
  // js/ui.js) rather than duplicating image paths here. See
  // studySkill/upgradeSkillWithBook in js/ui.js.
  ..._SKILL_BOOK_SRC.map(([cls, key, name]) => ({
    id: `book_${cls}_${key}`, name: `Книга: ${name}`,
    slot: 'material', rarity: 'uncommon', forClass: cls, skillKey: key,
  })),
  // ── Passive skill books (изучение/прокачка пассивок) ─────
  // Same idea as the active skill books above, one per passive id — class-
  // exclusive ones carry forClass, universal ones (PASSIVE_COMMON_DEF) don't.
  // Icon/img resolved at render time via passiveId against PASSIVE_CLASS_DEF/
  // PASSIVE_COMMON_DEF (see _itemIcon in js/ui.js). See studyPassiveSkill/
  // upgradePassiveSkillWithBook in js/ui.js.
  ..._PASSIVE_BOOK_SRC.map(([cls, id, name]) => ({
    id: `book_pas_${id}`, name: `Книга: ${name}`,
    slot: 'material', rarity: 'uncommon', forClass: cls, passiveId: id,
  })),
  ..._PASSIVE_COMMON_BOOK_SRC.map(([id, name]) => ({
    id: `book_pas_${id}`, name: `Книга: ${name}`,
    slot: 'material', rarity: 'uncommon', passiveId: id,
  })),
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

// Look up an item's canonical catalog definition by id (mirrors the server's
// own _catalogBase in server/index.js). Used to rebuild inventory/equipment
// items loaded from a save against the LIVE catalog instead of trusting
// whatever display fields (name, img, stats) were embedded in the save blob
// — those are frozen at whatever language/balance was active the last time
// the account was saved, so trusting them forever would leave old items
// permanently untranslated after a language switch.
function itemCatalogBase(id) {
  return ITEM_DEF.find(d => d.id === id) || CRAFT_MATS.find(d => d.id === id) || BOX_DEF.find(d => d.id === id) || null;
}

// ── Room-level monster progression ─────────────────────────────────────────────
// Each corridor (server/game/dungeon.js) chains roomsInArm(armIdx) rooms of
// increasing "local room level" 1..roomsInArm(armIdx) (room 1 = weakest, the
// last = that arm's boss room / strongest) — this resets every arm. The
// global display level (1-78, see armIndexForLevel above) feeds this via
// armLocalLevel(). Monster HP/ATK/DEF no longer scale off local room level at
// all (see monsterStatsAtLevel above, which is a function of the GLOBAL
// level only) — only item/key/enchant-stone drop chance still compounds per
// local room level below.
function armLocalLevel(globalLvl) {
  const armIdx = armIndexForLevel(globalLvl);
  return Math.max(1, globalLvl || 1) - ARM_OFFSETS[armIdx - 1];
}

const ROOM_DROP_GROWTH     = 0.05; // +5% item-drop chance per room level
const ROOM_KEY_GROWTH      = 0.05; // +5% key-drop chance per room level
const ROOM_KEY_BASE = { uncommon: 0.004, rare: 0.0008 }; // room level 1 base chance (5× lower than the previous tuning)
const ROOM_ENCHANT_STONE_BASE   = 0.0001; // room level 1 base chance (Камень обычной заточки) — ×100 lower than the original
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

// ── Event boss (summoned from the admin panel) ──────────────────────────────
// Not part of any room chain: spawned on demand into the hub, announced
// EVENT_BOSS_ANNOUNCE_MS ahead, and gone for good once killed (the per-arm
// bosses in ENEMY_DEF respawn on a timer — this one only ever comes back when
// an admin summons it again). Its loot does NOT roll per-killer like ordinary
// monsters: the whole table below lands on the ground at once for everyone,
// first come first served (see rollEventBossDrops / the worldDrops system in
// server/game/Room.js).
const EVENT_BOSS_ANNOUNCE_MS  = 5 * 60 * 1000; // warning shown before it appears
const EVENT_BOSS_DROP_LIFE_MS = 3 * 60 * 1000; // how long loot stays on the ground

const EVENT_BOSS = {
  eid: 'demon_event_boss',
  name: 'Владыка Демонов',
  color: '#ff2020',
  // Bosses render at size*4.5 while regular monsters render at size*6.75
  // (js/pixi-world.js) — which is why the existing demon_boss (size 32) looks
  // no bigger than a demon warrior (size 22). "5× a regular monster" therefore
  // means 5 * (22 * 6.75) / 4.5 ≈ 165, not simply 5 * 22.
  size: 165,
  hp: 100000, atk: 20, def: 1, spd: 50,
  xp: 120, gold: 120,
  isBoss: true, eType: 'boss',
  // Lets this one boss act inside the hub's safe zone, which normally makes
  // enemies drop aggro and skip every player standing there.
  ignoresSafeZone: true,
};

const _EVENT_BOSS_ARMOR_SLOTS = ['helmet', 'body', 'gloves', 'boots', 'ring', 'belt'];

// Builds the full ground-loot list for one kill. Every entry becomes its own
// separate pile on the floor (hence qty 1 on the stackables) so 10 keys are
// ten things to walk over, not one stack of ten.
function rollEventBossDrops(rand) {
  const rnd = rand || Math.random;
  const out = [];
  const pick = arr => arr[Math.floor(rnd() * arr.length)];
  const add = (base, n) => {
    if (!base) return;
    for (let i = 0; i < n; i++) {
      const it = { ...base };
      if (isStackableItem(base)) it.qty = 1;
      else if (ENHANCEABLE_SLOTS.has(base.slot)) it.enhance = 0;
      out.push(it);
    }
  };
  const mat = id => CRAFT_MATS.find(m => m.id === id);

  add(mat('key_uncommon'), 10);                                    // 10 необычных ключей
  ITEM_DEF.filter(i => i.slot === 'buff_potion').forEach(bp => add(bp, 5)); // 6 видов × 5 = 30 зелий
  add(pick(ITEM_DEF.filter(i => i.rarity === 'uncommon' && _EVENT_BOSS_ARMOR_SLOTS.includes(i.slot))), 1);
  add(pick(ITEM_DEF.filter(i => i.rarity === 'uncommon' && i.slot === 'weapon')), 1);
  const commons = ITEM_DEF.filter(i => i.rarity === 'common' &&
    (i.slot === 'weapon' || _EVENT_BOSS_ARMOR_SLOTS.includes(i.slot)));
  for (let i = 0; i < 5; i++) add(pick(commons), 1);               // 5 случайных common
  add(mat('bless_stone'), 5);                                      // 5 безопасных заточек
  add(mat('norm_stone'), 10);                                      // 10 обычных заточек
  return out;
}

// ── Passive skills ────────────────────────────────────────────────────────────
// Second skill track next to SKILL_DEF's active Q/W/E/R (js/definitions.js):
// every class gets its OWN pair of passives (one ATK-flavored, one
// DEF-flavored, matching that class's identity) plus six universal passives
// every class can invest in regardless of which one was picked. Studied and
// leveled with books exactly like active skills (studyPassiveSkill/
// upgradePassiveSkillWithBook, js/ui.js — same SKILL_STUDY_COST/
// SKILL_UPGRADE_COST/SKILL_UPGRADE_CHANCE), dropped by monsters the same
// way (js/combat.js), just capped at a lower max level. Bonuses stack as
// flat/percent on top of recompute()'s existing
// atk/def/hp/atkSpeed/critPower/hpRegen/speed pipeline (js/player.js).
const PASSIVE_MAX_LEVEL = 5;

const PASSIVE_CLASS_DEF = {
  lev: [
    { id:'tankatk', name:'Мощь берсерка',  img:'/images/passive/tankatk.png', stat:'atkPct', perLevel:0.03, desc:'+3% атаки за уровень' },
    { id:'deftank', name:'Несокрушимость', img:'/images/passive/deftank.png', stat:'defPct', perLevel:0.03, desc:'+3% защиты за уровень' },
  ],
  deathknight: [
    { id:'dkatk', name:'Кровавый пакт',  img:'/images/passive/dkatk.png', stat:'atkPct', perLevel:0.03, desc:'+3% атаки за уровень' },
    { id:'dkdef', name:'Тёмный панцирь', img:'/images/passive/dkdef.png', stat:'defPct', perLevel:0.03, desc:'+3% защиты за уровень' },
  ],
  ranger: [
    { id:'bowatk', name:'Меткий глаз',     img:'/images/passive/bowatk.png', stat:'atkPct', perLevel:0.03, desc:'+3% атаки за уровень' },
    { id:'bowdef', name:'Чутьё следопыта', img:'/images/passive/bowdef.png', stat:'defPct', perLevel:0.03, desc:'+3% защиты за уровень' },
  ],
  mage: [
    { id:'mageatk', name:'Поток маны',  img:'/images/passive/mageatk.png', stat:'atkPct', perLevel:0.03, desc:'+3% атаки за уровень' },
    { id:'magedef', name:'Ледяной щит', img:'/images/passive/magedef.png', stat:'defPct', perLevel:0.03, desc:'+3% защиты за уровень' },
  ],
  warlock: [
    { id:'healatk', name:'Тёмная жажда', img:'/images/passive/healatk.png', stat:'atkPct', perLevel:0.03, desc:'+3% атаки за уровень' },
    { id:'healdef', name:'Оберег тьмы',  img:'/images/passive/healdef.png', stat:'defPct', perLevel:0.03, desc:'+3% защиты за уровень' },
  ],
};

// Available to every class regardless of which one was picked — a second,
// universal passive track next to the class-exclusive pair above.
const PASSIVE_COMMON_DEF = [
  { id:'allatkspeed', name:'Стремительность', img:'/images/passive/allatkspeed.png', stat:'atkSpeedPct',  perLevel:0.02, desc:'+2% скорости атаки за уровень' },
  { id:'allhp',       name:'Живучесть',       img:'/images/passive/allhp.png',       stat:'hpPct',        perLevel:0.03, desc:'+3% макс. здоровья за уровень' },
  { id:'allcritdmg',  name:'Кровавая ярость', img:'/images/passive/allcritdmg.png',  stat:'critPowerFlat',perLevel:0.04, desc:'+4% силы крита за уровень' },
  { id:'allspeed',    name:'Быстрые ноги',    img:'/images/passive/allspeed.png',    stat:'moveSpeedPct', perLevel:0.02, desc:'+2% скорости передвижения за уровень' },
  { id:'allcdskill',  name:'Ясный разум',     img:'/images/passive/allcdskill.png',  stat:'cdrPct',       perLevel:0.02, desc:'-2% перезарядки навыков за уровень' },
  { id:'allregen',    name:'Регенерация',     img:'/images/passive/allregen.png',    stat:'hpRegenFlat',  perLevel:0.2,  desc:'+0.2 реген. HP/сек за уровень' },
];

function passiveDefById(cls, id) {
  return (PASSIVE_CLASS_DEF[cls] || []).find(p => p.id === id) || PASSIVE_COMMON_DEF.find(p => p.id === id) || null;
}
function passivesForClass(cls) {
  return [...(PASSIVE_CLASS_DEF[cls] || []), ...PASSIVE_COMMON_DEF];
}
// Sums every passive's (level * perLevel) into one bag of named bonuses —
// recompute() (js/player.js) reads this once per call and folds each field
// into its matching stat, exactly like equipment/buff bonuses already are.
function passiveBonusTotal(passiveLevels, cls) {
  const totals = { atkPct:0, defPct:0, hpPct:0, atkSpeedPct:0, moveSpeedPct:0, critPowerFlat:0, cdrPct:0, hpRegenFlat:0 };
  passivesForClass(cls).forEach(p => {
    const lvl = Math.max(0, Math.min(PASSIVE_MAX_LEVEL, (passiveLevels || {})[p.id] || 0));
    if (lvl > 0) totals[p.stat] += p.perLevel * lvl;
  });
  return totals;
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
  ARM_NAMES, ARM_ROOM_PAIRS, ARM_ROOM_COUNTS, ARM_OFFSETS, MAX_MONSTER_LEVEL, roomsInArm,
  armIndexForLevel, armNameForLevel, armLocalLevel, ARM_LEVEL_REQ,
  MONSTER_HP1, MONSTER_ATK1, MONSTER_ARCHETYPE,
  BOSS_HP_MULT, BOSS_ATK_MULT,
  monsterHPAtLevel, monsterATKAtLevel, monsterDEFAtLevel, monsterStatsAtLevel,
  MONSTER_RANK_M, MONSTER_RANK_F, monsterNameAtLevel, monsterColorAtLevel,
  PASSIVE_MAX_LEVEL, PASSIVE_CLASS_DEF, PASSIVE_COMMON_DEF,
  passiveDefById, passivesForClass, passiveBonusTotal,
  VIP_THRESHOLDS, VIP_BONUSES,
  ITEM_DEF, CRAFT_MATS, BOX_DEF, ENHANCE_MAX, ENHANCEABLE_SLOTS, enhanceBonus, isStackableItem,
  ITEM_DROP_GROWTH_PCT, BOSS_ITEM_DROP_MULT, COMMON_ITEM_MAX_LEVEL, itemDropChanceAtLevel, itemRarityForLevel,
  ROOM_DROP_GROWTH, ROOM_KEY_GROWTH, ROOM_KEY_BASE,
  ROOM_ENCHANT_STONE_BASE, ROOM_ENCHANT_STONE_GROWTH,
  roomDropMult, roomKeyChance, roomEnchantStoneChance,
  EVENT_BOSS, EVENT_BOSS_ANNOUNCE_MS, EVENT_BOSS_DROP_LIFE_MS, rollEventBossDrops,
};
