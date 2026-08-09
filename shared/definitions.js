// ─────────────────────────────────────────────────────────────────────────────
//  SHARED GAME DEFINITIONS — single source of truth for server and client
//  Browser: loaded as a plain <script>; constants become global.
//  Node.js: const { ENEMY_DEF, CHAR_DEF, TILE } = require('../shared/definitions');
// ─────────────────────────────────────────────────────────────────────────────

// ── Map constants ─────────────────────────────────────────────────────────────
const TILE = 40;
const WALL = 0, FLOOR = 1;

// How far from a player an enemy has to be before the server stops streaming
// its position/hp to them (see the broadcast in server/game/Room.js and the
// matching client-side prune in js/network.js — both must use this same
// number or one side keeps ghosts the other has dropped).
//
// This used to be unlimited: every player was sent a delta for every enemy in
// the whole world, which measured at ~92% waste (each player could actually
// see ~100 of the ~1270 they were being told about) and ~5 Mbit/s each in
// combat — enough to saturate a phone's uplink and show up as "high ping"
// that was really self-inflicted queueing.
//
// 1400px is deliberately wider than it needs to be for rendering (~700px
// viewport): the minimap draws a 30-tile = 1200px radius around the player,
// so covering that here keeps the minimap fed off the same stream instead of
// needing one of its own. Bosses are never culled by it — the boss HP bar and
// the map's skull markers look them up by id from anywhere on the map.
const ENEMY_AOI_R = 1400;

// ── Character definitions ─────────────────────────────────────────────────────
// Class colors kept as a deliberate, distinct identity per class (steel /
// forest / arcane violet / holy gold / wine / cool steel) rather than run
// through the general dark-fantasy recolor pass — matches the same picks
// made for .cs-dot-*/.cs-btn-* in css/style.css. projColor (ranged attack
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

// From MONSTER_GROWTH_FROM upward, HP and ATK compound by MONSTER_GROWTH per
// level instead of continuing the flat "level N = N x the level-1 stat" line.
//
// The line described above still holds below that point, and the curve is
// anchored to exactly what level MONSTER_GROWTH_FROM already produced, so
// levels 1-20 and the entry into the second zone are unchanged. What it fixes
// is further in: because the old growth was a fixed *absolute* step on a
// growing base, its relative size decayed the deeper you went — +4.8% from
// level 21 to 22 but only +2.6% from 38 to 39 — so monsters stopped feeling
// like they were keeping up within a zone. Compounding keeps every level a
// consistent step over the one below it.
//
// DEF deliberately stays on the linear formula below: it is subtracted from
// player damage directly, so growing it faster than players grow ATK floors
// every hit at 1.
const MONSTER_GROWTH      = 1.07;
const MONSTER_GROWTH_FROM = 21;
// What the pre-existing formula produced at the anchor level (the x15 step
// that the second zone's monsters have always started from).
const _MONSTER_HP_ANCHOR  = MONSTER_HP1  * MONSTER_GROWTH_FROM * 15;
const _MONSTER_ATK_ANCHOR = MONSTER_ATK1 * MONSTER_GROWTH_FROM;

function monsterDEFAtLevel(lvl) { return Math.max(0, Math.round(1 * Math.max(1, lvl || 1))); } // doubled
function monsterHPAtLevel(lvl) {
  lvl = Math.max(1, lvl || 1);
  if (lvl < MONSTER_GROWTH_FROM) return MONSTER_HP1 * lvl;
  return Math.round(_MONSTER_HP_ANCHOR * Math.pow(MONSTER_GROWTH, lvl - MONSTER_GROWTH_FROM));
}
function monsterATKAtLevel(lvl) {
  lvl = Math.max(1, lvl || 1);
  if (lvl < MONSTER_GROWTH_FROM) return MONSTER_ATK1 * lvl;
  return Math.round(_MONSTER_ATK_ANCHOR * Math.pow(MONSTER_GROWTH, lvl - MONSTER_GROWTH_FROM));
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
// level for bosses) — a static snapshot used as a display fallback. The main
// open world (server/game/dungeon.js) ignores these numbers entirely and
// calls the level functions fresh for the enemy's actual room level,
// overriding name/color/hp/atk/def/xp/gold per spawn.
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

// ── Сезон ───────────────────────────────────────────────────────────────────
// A time-boxed points race. Points come from two places and both are counted
// server-side only (SEASON_* fields are stripped from client saves the same
// way balances are — see _sanitizeSavedStats): an endless rotation of kill
// quests, and burning junk gear.
//
// The kill quests are deliberately drawn from the level 1-19 band, which is
// the starting corridor — so the race is about volume, not about how far into
// the world a player has already got.
const SEASON_END_AT   = Date.UTC(2026, 7, 20, 15, 0, 0); // 20 Aug 2026, 18:00 MSK (UTC+3)
const SEASON_MIN_LVL  = 10;
const SEASON_MAX_LVL  = 19;
const SEASON_QUEST_KILLS  = 5000;
const SEASON_QUEST_POINTS = 100;
// One quest is active at a time; clearing it rolls the next at random from
// this list. `sp` is the eid prefix, so both the guard and the warrior
// variant of a species count toward the same quest.
//
// Every species listed here must actually appear somewhere inside the band —
// a quest for one that does not is literally impossible to finish. The band
// sits entirely inside the starting corridor now, so all three are reachable
// from level 1 and `req` is 0 throughout; it is kept because the roll still
// filters on it (see _seasonRollSpecies, server/index.js), which is what
// would stop a gated species being handed to someone who cannot reach it if
// the band is ever widened past level 20 again.
const SEASON_SPECIES = [
  { sp: 'rat',   name: 'Крысы',  req: 0 },  // levels 10, 13, 16, 19
  { sp: 'slime', name: 'Слизни', req: 0 },  // levels 11, 14, 17
  { sp: 'imp',   name: 'Бесы',   req: 0 },  // levels 12, 15, 18
];

// Two quest bands the player switches between in the Сезон panel. One quest
// is active at a time and it belongs to whichever band is selected; each band
// keeps its own progress, so switching across and back resumes rather than
// rerolls (and so switching cannot be used to skip a species you dislike).
//
// `reqLvl` is what the player needs to select the band at all. For 20+ it is
// not a balance knob: the top corridor itself is gated at level 20
// (ARM_LEVEL_REQ.top), so a lower-level player literally cannot walk in to
// find a single one of those monsters.
//
// The 20+ band starts at 21, not 20 — level 20 is still the last room of the
// starting corridor (slimes), so including it would put a 10+ species inside
// the 20+ band.
const SEASON_TIERS = [
  {
    id: '10', label: '10+', reqLvl: SEASON_MIN_LVL, minLvl: 10, maxLvl: 19,
    species: SEASON_SPECIES,
  },
  {
    id: '20', label: '20+', reqLvl: 20, minLvl: 21, maxLvl: 23,
    species: [
      { sp: 'zombie',    name: 'Зомби',  req: 20 },  // level 21
      { sp: 'lizardman', name: 'Ящеры',  req: 20 },  // level 22
      { sp: 'orc',       name: 'Орки',   req: 20 },  // level 23
    ],
  },
];
const SEASON_TIER_DEFAULT = '10';
function seasonTier(id) {
  return SEASON_TIERS.find(x => x.id === id) || SEASON_TIERS[0];
}
// Repeatable one-off tasks alongside the kill quest. Each pays out once per
// occurrence of the thing it names — once per 3v3 match, once per death
// battle round, once per world-boss appearance — and then arms again, so
// they can be earned over and over across the season. The natural limits of
// the events themselves (daily attempts, fixed schedules, one boss at a
// time) are what keep them from being farmed.
const SEASON_EVENT_POINTS = 50;
// Paid to the WINNER(s) on top of the participation points above — taking the
// match is worth more than turning up for it. Keyed by the same task ids.
// Everyone on the winning 3v3 side gets the full amount each; it is a team
// result, not a pot to divide.
const SEASON_WIN_POINTS = { deathbattle: 150, arena3: 30 };
const SEASON_EVENT_TASKS = [
  { id: 'arena3',     name: 'Участвовать в Арене 3х3' },
  { id: 'deathbattle', name: 'Участвовать в Битве на смерть' },
  { id: 'worldboss',  name: 'Ударить Мирового босса' },
];

// Points for a SUCCESSFUL enhance, by the item's own rarity. A miss costs the
// stone and pays nothing — the task is to enhance, not to attempt. Keyed the
// same way burning is, so anything not listed here earns nothing.
const SEASON_ENHANCE_POINTS = { common: 10, uncommon: 50, rare: 80 };

// Bringing in a player who then reaches SEASON_REF_LEVEL. Paid to the
// REFERRER, once per invited friend ever — the claim flips a flag on the
// friend's own document, so it cannot be collected twice by relogging, and
// it lands whether or not the referrer happens to be online at the time.
const SEASON_REF_POINTS = 200;
const SEASON_REF_LEVEL  = 20;

// Burning destroys the item outright — no gold, no materials back, only
// points. Anything not listed here cannot be burned at all.
const SEASON_BURN_POINTS = { common: 1, uncommon: 5 };
// Paid out manually off-chain; the game only ranks players and shows this.
const SEASON_PRIZES = [
  { place: 1, usdt: 100 },
  { place: 2, usdt: 50  },
  { place: 3, usdt: 30  },
];
function seasonActive(now = Date.now()) { return now < SEASON_END_AT; }

// The levels each species actually appears at, computed per band. The quest
// text names these instead of the band itself: the 20+ band spans 21-23, but
// zombies only live at 21 and orcs only at 23, so "kill zombies, levels 21-23"
// would send the player hunting through rooms that cannot contain one.
//
// Derived from the world tables rather than written out by hand, so a change
// to FLOOR_ENEMIES can't leave a quest pointing at the wrong rooms.
const SEASON_TIER_SPECIES_LEVELS = (() => {
  const out = {};
  for (const tier of SEASON_TIERS) {
    const m = out[tier.id] = {};
    for (let lvl = tier.minLvl; lvl <= tier.maxLvl; lvl++) {
      const arm = armIndexForLevel(lvl);
      const fe = FLOOR_ENEMIES[arm];
      if (!fe) continue;
      const sp = bandForLocalLevel(fe, lvl - ARM_OFFSETS[arm - 1]).eid.split('_')[0];
      (m[sp] = m[sp] || []).push(lvl);
    }
  }
  return out;
})();
// Kept for the 10+ band alone, which is what everything referred to before
// there were two.
const SEASON_SPECIES_LEVELS = SEASON_TIER_SPECIES_LEVELS[SEASON_TIER_DEFAULT];

// ── Quests ──────────────────────────────────────────────────────────────────
// Shared so the server can grant quest rewards itself rather than trusting
// the client to add them to its own inventory (see the claimQuest handler,
// server/index.js). Progress is still tracked client-side; only the reward
// table and the grant are authoritative here.
const _BUFF_POTION_IDS = ['bp_hp', 'bp_exp', 'bp_gold', 'bp_regen', 'bp_atkspeed', 'bp_atk'];
const QUEST_DEF = [
  // ── Левый коридор · Крысиные катакомбы (квесты 1-15) ────
  { id:'f1q1',  floor:1, title:'Первая кровь',        desc:'Убей 10 Крыса страж',        type:'kill',         enemies:['Крыса страж'],      count:10,  reward:{ xp:50,   gold:25,  items:_BUFF_POTION_IDS } },
  { id:'f1q2',  floor:1, title:'Страж падёт',         desc:'Убей 10 Слизень страж',      type:'kill',         enemies:['Слизень страж'],    count:10,  reward:{ xp:50,   gold:25  } },
  { id:'f1q3',  floor:1, title:'Торговля',            desc:'Купи 10 зелий',              type:'buy_potion',                                 count:10,  reward:{ xp:60,   gold:30  } },
  { id:'f1q4',  floor:1, title:'Охотник',             desc:'Убей 30 Бес страж',          type:'kill',         enemies:['Бес страж'],        count:30,  reward:{ xp:120,  gold:60  } },
  { id:'f1q5',  floor:1, title:'Каратель',            desc:'Убей 30 Крыса воин',         type:'kill',         enemies:['Крыса воин'],       count:30,  reward:{ xp:120,  gold:60,  items:_BUFF_POTION_IDS } },
  { id:'f1q6',  floor:1, title:'Опытный боец',        desc:'Достигни 3 уровня',          type:'level',        level:3,                      reward:{ xp:150,  gold:75  } },
  { id:'f1q7',  floor:1, title:'Ловец слизи',         desc:'Убей 50 Слизень воин',       type:'kill',         enemies:['Слизень воин'],     count:50,  reward:{ xp:200,  gold:100 } },
  { id:'f1q8',  floor:1, title:'Гроза бесов',         desc:'Убей 50 Бес воин',           type:'kill',         enemies:['Бес воин'],         count:50,  reward:{ xp:200,  gold:100 } },
  { id:'f1q10', floor:1, title:'Ветеран',             desc:'Достигни 5 уровня',          type:'level',        level:5,                      reward:{ xp:350,  gold:175 } },
  { id:'f1q11', floor:1, title:'Покоритель',          desc:'Достигни 10 уровня',          type:'level',        level:10,                     reward:{ xp:400,  gold:200, items:_BUFF_POTION_IDS } },
  { id:'f1q12', floor:1, title:'Мясник',              desc:'Убей 100 Бес воин',          type:'kill',         enemies:['Бес воин'],         count:100, reward:{ xp:450,  gold:225 } },
  { id:'f1q13', floor:1, title:'Берсерк',             desc:'Убей 100 Бес страж',         type:'kill',         enemies:['Бес страж'],        count:100, reward:{ xp:450,  gold:225 } },
  { id:'f1q14', floor:1, title:'В гильдию!',          desc:'Вступи в гильдию',           type:'join_guild',                                 reward:{ xp:500,  gold:250 } },
  // Sits right before the "go to the top corridor" quest, and the top arm's
  // own gate needs level 20 anyway (ARM_LEVEL_REQ.top) — so this milestone
  // lines up with what the player has to reach to continue regardless.
  // Kept at this array position and under its original id: questIdx is a
  // POSITIONAL index into this table, so moving or removing an entry would
  // silently shift every player already past it onto a different quest.
  { id:'f1q9',  floor:1, title:'Мастер',              desc:'Достигни 20 уровня',         type:'level',        level:20,                     reward:{ xp:300,  gold:150 } },
  { id:'f1q15', floor:1, title:'Следующий уровень',   desc:'Дойди до верхнего коридора', type:'goto_floor',   targetFloor:2,                reward:{ xp:600,  gold:300, items:_BUFF_POTION_IDS } },

  // ── Верхний коридор · Гнилые топи (квесты 16-30) · награда ×2 ──
  { id:'f2q1',  floor:2, title:'Первая кровь II',     desc:'Убей 10 Зомби страж',        type:'kill',         enemies:['Зомби страж'],      count:10,  reward:{ xp:1000, gold:500, items:_BUFF_POTION_IDS } },
  { id:'f2q2',  floor:2, title:'Страж падёт II',      desc:'Убей 10 Ящер страж',         type:'kill',         enemies:['Ящер страж'],       count:10,  reward:{ xp:1000, gold:500 } },
  { id:'f2q3',  floor:2, title:'Торговля II',         desc:'Купи 10 зелий',              type:'buy_potion',                                 count:10,  reward:{ xp:1200, gold:600 } },
  { id:'f2q4',  floor:2, title:'Охотник II',          desc:'Убей 30 Орк страж',          type:'kill',         enemies:['Орк страж'],        count:30,  reward:{ xp:2400, gold:1200 } },
  { id:'f2q5',  floor:2, title:'Каратель II',         desc:'Убей 30 Зомби воин',         type:'kill',         enemies:['Зомби воин'],       count:30,  reward:{ xp:2400, gold:1200, items:_BUFF_POTION_IDS } },
  { id:'f2q6',  floor:2, title:'Опытный боец II',     desc:'Достигни 23 уровня',          type:'level',        level:23,                      reward:{ xp:3000, gold:1500 } },
  { id:'f2q7',  floor:2, title:'Охотник на ящеров',   desc:'Убей 50 Ящер воин',          type:'kill',         enemies:['Ящер воин'],        count:50,  reward:{ xp:4000, gold:2000 } },
  { id:'f2q8',  floor:2, title:'Ярость орков',        desc:'Убей 50 Орк воин',           type:'kill',         enemies:['Орк воин'],         count:50,  reward:{ xp:4000, gold:2000 } },
  { id:'f2q10', floor:2, title:'Ветеран II',          desc:'Достигни 25 уровня',         type:'level',        level:25,                     reward:{ xp:7000, gold:3500 } },
  { id:'f2q11', floor:2, title:'Покоритель II',       desc:'Дойди до конца верхнего коридора', type:'dungeon_clear',floor:2, count:2,        reward:{ xp:8000, gold:4000, items:_BUFF_POTION_IDS } },
  { id:'f2q12', floor:2, title:'Мясник II',           desc:'Убей 100 Орк воин',          type:'kill',         enemies:['Орк воин'],         count:100, reward:{ xp:9000, gold:4500 } },
  { id:'f2q13', floor:2, title:'Берсерк II',          desc:'Убей 100 Орк страж',         type:'kill',         enemies:['Орк страж'],        count:100, reward:{ xp:9000, gold:4500 } },
  { id:'f2q14', floor:2, title:'Почётный член',       desc:'Повысь ранг в гильдии',      type:'join_guild',                                 reward:{ xp:10000, gold:5000 } },
  { id:'f2q9',  floor:2, title:'Убийца боссов II',    desc:'Убей Босс орков',            type:'kill',         enemies:['Босс орков'],       count:1,   reward:{ xp:6000, gold:3000 } },
  { id:'f2q15', floor:2, title:'Вглубь тьмы',         desc:'Дойди до нижнего коридора',  type:'goto_floor',   targetFloor:3,                reward:{ xp:12000, gold:6000, items:_BUFF_POTION_IDS } },

  // ── Нижний коридор · Кровавые чертоги (квесты 31-45) · награда ×4 ──
  { id:'f3q1',  floor:3, title:'Первая кровь III',    desc:'Убей 10 Лоза страж',         type:'kill',         enemies:['Лоза страж'],       count:10,  reward:{ xp:2000, gold:1000, items:_BUFF_POTION_IDS } },
  { id:'f3q2',  floor:3, title:'Страж падёт III',     desc:'Убей 10 Вампир страж',       type:'kill',         enemies:['Вампир страж'],     count:10,  reward:{ xp:2000, gold:1000 } },
  { id:'f3q3',  floor:3, title:'Торговля III',        desc:'Купи 10 зелий',              type:'buy_potion',                                 count:10,  reward:{ xp:2400, gold:1200 } },
  { id:'f3q4',  floor:3, title:'Охотник III',         desc:'Убей 30 Бехолдер страж',     type:'kill',         enemies:['Бехолдер страж'],   count:30,  reward:{ xp:4800, gold:2400 } },
  { id:'f3q5',  floor:3, title:'Каратель III',        desc:'Убей 30 Лоза воин',          type:'kill',         enemies:['Лоза воин'],        count:30,  reward:{ xp:4800, gold:2400, items:_BUFF_POTION_IDS } },
  { id:'f3q6',  floor:3, title:'Опытный боец III',    desc:'Достигни 15 уровня',         type:'level',        level:15,                     reward:{ xp:6000, gold:3000 } },
  { id:'f3q7',  floor:3, title:'Охотник на вампиров', desc:'Убей 50 Вампир воин',        type:'kill',         enemies:['Вампир воин'],      count:50,  reward:{ xp:8000, gold:4000 } },
  { id:'f3q8',  floor:3, title:'Взгляд бездны',       desc:'Убей 50 Бехолдер воин',      type:'kill',         enemies:['Бехолдер воин'],    count:50,  reward:{ xp:8000, gold:4000 } },
  { id:'f3q10', floor:3, title:'Ветеран III',         desc:'Достигни 20 уровня',         type:'level',        level:20,                     reward:{ xp:14000, gold:7000 } },
  { id:'f3q11', floor:3, title:'Покоритель III',      desc:'Дойди до конца нижнего коридора', type:'dungeon_clear',floor:3, count:3,         reward:{ xp:16000, gold:8000, items:_BUFF_POTION_IDS } },
  { id:'f3q12', floor:3, title:'Мясник III',          desc:'Убей 100 Бехолдер воин',     type:'kill',         enemies:['Бехолдер воин'],    count:100, reward:{ xp:18000, gold:9000 } },
  { id:'f3q13', floor:3, title:'Берсерк III',         desc:'Убей 100 Бехолдер страж',    type:'kill',         enemies:['Бехолдер страж'],   count:100, reward:{ xp:18000, gold:9000 } },
  { id:'f3q14', floor:3, title:'Столп гильдии',       desc:'Повысь ранг в гильдии',      type:'join_guild',                                 reward:{ xp:20000, gold:10000 } },
  { id:'f3q9',  floor:3, title:'Убийца боссов III',   desc:'Убей Босс бехолдеров',       type:'kill',         enemies:['Босс бехолдеров'],  count:1,   reward:{ xp:12000, gold:6000 } },
  { id:'f3q15', floor:3, title:'На край света',       desc:'Дойди до правого коридора',  type:'goto_floor',   targetFloor:4,                reward:{ xp:24000, gold:12000, items:_BUFF_POTION_IDS } },

  // ── Правый коридор · Врата преисподней (квесты 46-60) · награда ×8 ──
  { id:'f4q1',  floor:4, title:'Первая кровь IV',     desc:'Убей 10 Древень страж',      type:'kill',         enemies:['Древень страж'],    count:10,  reward:{ xp:4000, gold:2000, items:_BUFF_POTION_IDS } },
  { id:'f4q2',  floor:4, title:'Страж падёт IV',      desc:'Убей 10 Демон страж',        type:'kill',         enemies:['Демон страж'],      count:10,  reward:{ xp:4000, gold:2000 } },
  { id:'f4q3',  floor:4, title:'Торговля IV',         desc:'Купи 10 зелий',              type:'buy_potion',                                 count:10,  reward:{ xp:4800, gold:2400 } },
  { id:'f4q4',  floor:4, title:'Охотник IV',          desc:'Убей 30 Древень страж',      type:'kill',         enemies:['Древень страж'],    count:30,  reward:{ xp:9600, gold:4800 } },
  { id:'f4q5',  floor:4, title:'Каратель IV',         desc:'Убей 30 Древень воин',       type:'kill',         enemies:['Древень воин'],     count:30,  reward:{ xp:9600, gold:4800, items:_BUFF_POTION_IDS } },
  { id:'f4q6',  floor:4, title:'Опытный боец IV',     desc:'Достигни 25 уровня',         type:'level',        level:25,                     reward:{ xp:12000, gold:6000 } },
  { id:'f4q7',  floor:4, title:'Изгоняющий демонов',  desc:'Убей 50 Демон страж',        type:'kill',         enemies:['Демон страж'],      count:50,  reward:{ xp:16000, gold:8000 } },
  { id:'f4q8',  floor:4, title:'Пламя преисподней',   desc:'Убей 50 Демон воин',         type:'kill',         enemies:['Демон воин'],       count:50,  reward:{ xp:16000, gold:8000 } },
  { id:'f4q10', floor:4, title:'Ветеран IV',          desc:'Достигни 30 уровня',         type:'level',        level:30,                     reward:{ xp:28000, gold:14000 } },
  { id:'f4q11', floor:4, title:'Покоритель IV',       desc:'Дойди до конца правого коридора', type:'dungeon_clear',floor:4, count:4,         reward:{ xp:32000, gold:16000, items:_BUFF_POTION_IDS } },
  { id:'f4q12', floor:4, title:'Мясник IV',           desc:'Убей 100 Демон воин',        type:'kill',         enemies:['Демон воин'],       count:100, reward:{ xp:36000, gold:18000 } },
  { id:'f4q13', floor:4, title:'Берсерк IV',          desc:'Убей 100 Демон страж',       type:'kill',         enemies:['Демон страж'],      count:100, reward:{ xp:36000, gold:18000 } },
  { id:'f4q14', floor:4, title:'Легенда гильдии',     desc:'Повысь ранг в гильдии',      type:'join_guild',                                 reward:{ xp:40000, gold:20000 } },
  { id:'f4q9',  floor:4, title:'Убийца боссов IV',    desc:'Убей Босс демонов',          type:'kill',         enemies:['Босс демонов'],     count:1,   reward:{ xp:24000, gold:12000 } },
  { id:'f4q15', floor:4, title:'Владыка подземелья',  desc:'Убей Босс демонов ещё раз',  type:'kill',         enemies:['Босс демонов'],     count:2,   reward:{ xp:60000, gold:30000, items:_BUFF_POTION_IDS } },
];


// ── Страх (Fear) event ───────────────────────────────────────────────────────
// A private, on-demand wave-survival instance (server/game/dungeon.js's
// `fear` lanes, server/game/Room.js's fearSpawnWave/fearRegisterKill): wave N
// is N monsters at global level N, 20 per wave, N running 1..FEAR_MAX_WAVE.
// Shared between Room.js (spawning + the wave-clear check) and server/
// index.js (the UI's wave counter), so it lives here rather than being
// duplicated in both.
const FEAR_MAX_WAVE = 39;

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
  { id:'sw2', name:'Стальной меч',     slot:'weapon', forClass:['deathknight'], img:'/images/wep/uk.png', atk:14, critChance:0.03,          rarity:'uncommon' },
  { id:'sw3', name:'Меч дракона',      slot:'weapon', forClass:['deathknight'], img:'/images/wep/rk.png', atk:23, critChance:0.05,          rarity:'rare'     },
  { id:'sw4', name:'Меч теней',        slot:'weapon', forClass:['deathknight'], img:'/images/wep/ek.png', atk:44, critChance:0.10,          rarity:'epic'     },
  { id:'sw5', name:'Меч героя',        slot:'weapon', forClass:['deathknight'], img:'/images/wep/lk.png', atk:65, critChance:0.25,          rarity:'legendary'},
  // ── Lev's axes ─────────────────────────────────────────
  { id:'tw1', name:'Ржавый топор',     slot:'weapon', forClass:['lev'], img:'/images/wep/ct.png', atk:5,                            rarity:'common'   },
  { id:'tw2', name:'Стальной топор',   slot:'weapon', forClass:['lev'], img:'/images/wep/ut.png', atk:15, def:6,                     rarity:'uncommon' },
  { id:'tw3', name:'Топор дракона',    slot:'weapon', forClass:['lev'], img:'/images/wep/rt.png', atk:23, def:10,                   rarity:'rare'     },
  { id:'tw4', name:'Топор теней',      slot:'weapon', forClass:['lev'], img:'/images/wep/et.png', atk:44, def:16,                   rarity:'epic'     },
  { id:'tw5', name:'Топор героя',      slot:'weapon', forClass:['lev'], img:'/images/wep/lt.png', atk:65, def:24,                   rarity:'legendary'},
  // ── Ranger bows ──────────────────────────────────────────
  { id:'bw1', name:'Деревянный лук',   slot:'weapon', forClass:['ranger'],  img:'/images/wep/cb.png', atk:8,                            rarity:'common'   },
  { id:'bw2', name:'Серебряный лук',   slot:'weapon', forClass:['ranger'],  img:'/images/wep/ub.png', atk:18, atkSpeed:0.03,            rarity:'uncommon' },
  { id:'bw3', name:'Лук охотника',     slot:'weapon', forClass:['ranger'],  img:'/images/wep/rb.png', atk:28, atkSpeed:0.05,            rarity:'rare'     },
  { id:'bw4', name:'Лунный лук',       slot:'weapon', forClass:['ranger'],  img:'/images/wep/eb.png', atk:60, atkSpeed:0.10,            rarity:'epic'     },
  { id:'bw5', name:'Лук героя',        slot:'weapon', forClass:['ranger'],  img:'/images/wep/lb.png', atk:100, atkSpeed:0.15, critChance:0.10, rarity:'legendary'},
  // ── Mage / Warlock staves ─────────────────────────────────
  { id:'st1', name:'Посох новичка',    slot:'weapon', forClass:['mage','warlock'], img:'/images/wep/cs.png', atk:7,                      rarity:'common'   },
  { id:'st2', name:'Посох бойца',      slot:'weapon', forClass:['mage','warlock'], img:'/images/wep/us.png', atk:17, hpPct:0.03,         rarity:'uncommon' },
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
  // ── Class cloaks & artifacts (salvage-craft) ──────────────
  // One flavor per class, common+uncommon only, marked with `classItem` so
  // CLASS_GEAR_SALVAGE_RECIPES below can pool them. Crafted at the blacksmith
  // by salvaging junk gear of the target rarity (plus a flat Liberty cost)
  // rather than bought/dropped.
  // Stats started as a straight copy of the pet tier baseline (hp/atk/def +
  // one class-varying stat) then were halved, but the per-class 4th stat
  // (crit/atk-speed/hp%) made otherwise-identical items feel arbitrarily
  // different. It's now a flat, identical-across-classes bonus instead —
  // rolled into `def` for cloaks and into `atk` for artifacts, matching what
  // each slot is themed around — so every class's cloak (and every class's
  // artifact) of a given tier now has the exact same stat block, differing
  // only in name/art. Same name across both tiers of a class — the cloak art
  // already carries the tier (images/cloak/<class>_c|u.png) and the artifact
  // art has no tier variant at all (images/artifact/<class>.png, reused for
  // both).
  { id:'cloak_c_lev',         name:'Плащ танка',          slot:'cloak', classItem:true, forClass:['lev'],         img:'/images/cloak/lev_c.png',         hp:75,  atk:5,  def:10, rarity:'common'   },
  { id:'cloak_c_deathknight', name:'Плащ рыцаря смерти',  slot:'cloak', classItem:true, forClass:['deathknight'], img:'/images/cloak/deathknight_c.png', hp:75,  atk:5,  def:10, rarity:'common'   },
  { id:'cloak_c_ranger',      name:'Плащ лучника',        slot:'cloak', classItem:true, forClass:['ranger'],      img:'/images/cloak/ranger_c.png',      hp:75,  atk:5,  def:10, rarity:'common'   },
  { id:'cloak_c_mage',        name:'Плащ мага',           slot:'cloak', classItem:true, forClass:['mage'],        img:'/images/cloak/mage_c.png',        hp:75,  atk:5,  def:10, rarity:'common'   },
  { id:'cloak_c_warlock',     name:'Плащ целителя',       slot:'cloak', classItem:true, forClass:['warlock'],     img:'/images/cloak/warlock_c.png',     hp:75,  atk:5,  def:10, rarity:'common'   },
  { id:'cloak_u_lev',         name:'Плащ танка',          slot:'cloak', classItem:true, forClass:['lev'],         img:'/images/cloak/lev_u.png',         hp:150, atk:13, def:20, rarity:'uncommon' },
  { id:'cloak_u_deathknight', name:'Плащ рыцаря смерти',  slot:'cloak', classItem:true, forClass:['deathknight'], img:'/images/cloak/deathknight_u.png', hp:150, atk:13, def:20, rarity:'uncommon' },
  { id:'cloak_u_ranger',      name:'Плащ лучника',        slot:'cloak', classItem:true, forClass:['ranger'],      img:'/images/cloak/ranger_u.png',      hp:150, atk:13, def:20, rarity:'uncommon' },
  { id:'cloak_u_mage',        name:'Плащ мага',           slot:'cloak', classItem:true, forClass:['mage'],        img:'/images/cloak/mage_u.png',        hp:150, atk:13, def:20, rarity:'uncommon' },
  { id:'cloak_u_warlock',     name:'Плащ целителя',       slot:'cloak', classItem:true, forClass:['warlock'],     img:'/images/cloak/warlock_u.png',     hp:150, atk:13, def:20, rarity:'uncommon' },
  { id:'artifact_c_lev',         name:'Артефакт танка',         slot:'artifact', classItem:true, forClass:['lev'],         img:'/images/artifact/lev.png',         hp:75,  atk:10, def:5,  rarity:'common'   },
  { id:'artifact_c_deathknight', name:'Артефакт рыцаря смерти', slot:'artifact', classItem:true, forClass:['deathknight'], img:'/images/artifact/deathknight.png', hp:75,  atk:10, def:5,  rarity:'common'   },
  { id:'artifact_c_ranger',      name:'Артефакт лучника',       slot:'artifact', classItem:true, forClass:['ranger'],      img:'/images/artifact/ranger.png',      hp:75,  atk:10, def:5,  rarity:'common'   },
  { id:'artifact_c_mage',        name:'Артефакт мага',          slot:'artifact', classItem:true, forClass:['mage'],        img:'/images/artifact/mage.png',        hp:75,  atk:10, def:5,  rarity:'common'   },
  { id:'artifact_c_warlock',     name:'Артефакт целителя',      slot:'artifact', classItem:true, forClass:['warlock'],     img:'/images/artifact/warlock.png',     hp:75,  atk:10, def:5,  rarity:'common'   },
  { id:'artifact_u_lev',         name:'Артефакт танка',         slot:'artifact', classItem:true, forClass:['lev'],         img:'/images/artifact/lev.png',         hp:150, atk:23, def:10, rarity:'uncommon' },
  { id:'artifact_u_deathknight', name:'Артефакт рыцаря смерти', slot:'artifact', classItem:true, forClass:['deathknight'], img:'/images/artifact/deathknight.png', hp:150, atk:23, def:10, rarity:'uncommon' },
  { id:'artifact_u_ranger',      name:'Артефакт лучника',       slot:'artifact', classItem:true, forClass:['ranger'],      img:'/images/artifact/ranger.png',      hp:150, atk:23, def:10, rarity:'uncommon' },
  { id:'artifact_u_mage',        name:'Артефакт мага',          slot:'artifact', classItem:true, forClass:['mage'],        img:'/images/artifact/mage.png',        hp:150, atk:23, def:10, rarity:'uncommon' },
  { id:'artifact_u_warlock',     name:'Артефакт целителя',      slot:'artifact', classItem:true, forClass:['warlock'],     img:'/images/artifact/warlock.png',     hp:150, atk:23, def:10, rarity:'uncommon' },
  // ── Pets ─────────────────────────────────────────────────
  // Own equip slot (EQ_SLOTS 'pet', js/definitions.js), crafted at the forge
  // for Liberty/Nexum (PET_CRAFT_RECIPES below) — not a mob/box drop. Base
  // atk/def/hp scale with rarity like any other slot; each pet also carries
  // one small unique bonus (crit/atk-speed/hp%) so same-rarity pets aren't
  // pure duplicates of each other.
  { id:'pet_aztec',   name:'Ацтек',    slot:'pet', img:'/images/pet/pet_aztec/icon.png',   hp:150, atk:10, def:10, atkSpeed:0.10,   rarity:'common'   },
  { id:'pet_maya',    name:'Майя',     slot:'pet', img:'/images/pet/pet_maya/icon.png',    hp:150, atk:10, def:10, critChance:0.10, rarity:'common'   },
  { id:'pet_bear',    name:'Медведь',  slot:'pet', img:'/images/pet/pet_bear/icon.png',    hp:150, atk:10, def:10, hpPct:0.15,      rarity:'common'   },
  { id:'pet_medusa',  name:'Медуза',   slot:'pet', img:'/images/pet/pet_medusa/icon.png',  hp:300, atk:25, def:20, critChance:0.175,rarity:'uncommon' },
  { id:'pet_bone',    name:'Костяк',   slot:'pet', img:'/images/pet/pet_bone/icon.png',    hp:300, atk:25, def:20, atkSpeed:0.175,  rarity:'uncommon' },
  { id:'pet_ogre',    name:'Огр',      slot:'pet', img:'/images/pet/pet_ogre/icon.png',    hp:300, atk:25, def:20, hpPct:0.25,      rarity:'uncommon' },
  { id:'pet_bonessa', name:'Бонесса',  slot:'pet', img:'/images/pet/pet_bonessa/icon.png', hp:550, atk:45, def:35, critChance:0.25, rarity:'rare'     },
  { id:'pet_cyclops', name:'Циклоп',   slot:'pet', img:'/images/pet/pet_cyclops/icon.png', hp:550, atk:45, def:35, hpPct:0.40,      rarity:'rare'     },
  { id:'pet_yeti',    name:'Йети',     slot:'pet', img:'/images/pet/pet_yeti/icon.png',    hp:550, atk:45, def:35, atkSpeed:0.25,   rarity:'rare'     },
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

// Pet crafting: Liberty (Nexum)-only, no recipe scrolls — crafting a rarity
// tier gives one random pet from that tier's 3 skins (ITEM_DEF entries with
// slot:'pet'). Unlike ITEM_CRAFT_RECIPES's per-item tiers (sw1→sw2→...),
// pets of the same rarity are horizontal alternatives, not a progression, so
// there's no single `itemId` to craft toward.
// Lives here (not js/definitions.js, where every other recipe table sits)
// because Nexum is server-granted/server-authoritative only (see
// _nexumBalanceCache in server/index.js) — unlike gold, a client can't be
// trusted to deduct it itself, so the craft has to be a server round-trip
// (server/index.js 'craftPet') and the server needs this table too.
// Enchant stones are no longer craftable. They used to have recipes here
// (recipe scrolls + Liberty at the forge); the table is gone rather than
// emptied so nothing can quietly resurrect it. Stones still drop from
// monsters (roomEnchantStoneChance below), come with VIP level rewards and
// are sold in the season packs — only the forge route is closed.
// The craftStone handler in server/index.js still exists and refuses, so a
// client running a cached bundle gets a clear message instead of silence.

// Epic/legendary gear tiers: these two additionally cost Liberty on top of
// the usual mats, and
// Liberty is server-authoritative, so the recipe the server charges against
// has to live here rather than in js/definitions.js's client-only
// ITEM_CRAFT_RECIPES — a client can't be trusted to report its own spend.
// Uncommon/rare stay pure client-trusted gold+mats crafts, untouched.
// js/definitions.js splices this array into ITEM_CRAFT_RECIPES so the
// craftsman UI keeps listing every tier from one place.
const GEAR_CRAFT_EPIC_COST = 7000;
const GEAR_CRAFT_LEGENDARY_COST = 20000;
const GEAR_CRAFT_RECIPES = [
  { itemId:'sw4', mats:[{id:'sw3',n:2,minEnhance:8},{id:'rece',n:10}], chance:0.80, nexumCost:GEAR_CRAFT_EPIC_COST },
  { itemId:'tw4', mats:[{id:'tw3',n:2,minEnhance:8},{id:'rece',n:10}], chance:0.80, nexumCost:GEAR_CRAFT_EPIC_COST },
  { itemId:'bw4', mats:[{id:'bw3',n:2,minEnhance:8},{id:'rece',n:10}], chance:0.80, nexumCost:GEAR_CRAFT_EPIC_COST },
  { itemId:'st4', mats:[{id:'st3',n:2,minEnhance:8},{id:'rece',n:10}], chance:0.80, nexumCost:GEAR_CRAFT_EPIC_COST },
  { itemId:'hm4', mats:[{id:'hm3',n:2,minEnhance:8},{id:'rece',n:10}], chance:0.80, nexumCost:GEAR_CRAFT_EPIC_COST },
  { itemId:'ar4', mats:[{id:'ar3',n:2,minEnhance:8},{id:'rece',n:10}], chance:0.80, nexumCost:GEAR_CRAFT_EPIC_COST },
  { itemId:'gl4', mats:[{id:'gl3',n:2,minEnhance:8},{id:'rece',n:10}], chance:0.80, nexumCost:GEAR_CRAFT_EPIC_COST },
  { itemId:'bt4', mats:[{id:'bt3',n:2,minEnhance:8},{id:'rece',n:10}], chance:0.80, nexumCost:GEAR_CRAFT_EPIC_COST },
  { itemId:'rn4', mats:[{id:'rn3',n:2,minEnhance:8},{id:'rece',n:10}], chance:0.80, nexumCost:GEAR_CRAFT_EPIC_COST },
  { itemId:'nd4', mats:[{id:'nd3',n:2,minEnhance:8},{id:'rece',n:10}], chance:0.80, nexumCost:GEAR_CRAFT_EPIC_COST },
  { itemId:'sw5', mats:[{id:'sw4',n:2,minEnhance:8},{id:'recl',n:15}], chance:0.80, nexumCost:GEAR_CRAFT_LEGENDARY_COST },
  { itemId:'tw5', mats:[{id:'tw4',n:2,minEnhance:8},{id:'recl',n:15}], chance:0.80, nexumCost:GEAR_CRAFT_LEGENDARY_COST },
  { itemId:'bw5', mats:[{id:'bw4',n:2,minEnhance:8},{id:'recl',n:15}], chance:0.80, nexumCost:GEAR_CRAFT_LEGENDARY_COST },
  { itemId:'st5', mats:[{id:'st4',n:2,minEnhance:8},{id:'recl',n:15}], chance:0.80, nexumCost:GEAR_CRAFT_LEGENDARY_COST },
  { itemId:'hm5', mats:[{id:'hm4',n:2,minEnhance:8},{id:'recl',n:15}], chance:0.80, nexumCost:GEAR_CRAFT_LEGENDARY_COST },
  { itemId:'ar5', mats:[{id:'ar4',n:2,minEnhance:8},{id:'recl',n:15}], chance:0.80, nexumCost:GEAR_CRAFT_LEGENDARY_COST },
  { itemId:'gl5', mats:[{id:'gl4',n:2,minEnhance:8},{id:'recl',n:15}], chance:0.80, nexumCost:GEAR_CRAFT_LEGENDARY_COST },
  { itemId:'bt5', mats:[{id:'bt4',n:2,minEnhance:8},{id:'recl',n:15}], chance:0.80, nexumCost:GEAR_CRAFT_LEGENDARY_COST },
  { itemId:'rn5', mats:[{id:'rn4',n:2,minEnhance:8},{id:'recl',n:15}], chance:0.80, nexumCost:GEAR_CRAFT_LEGENDARY_COST },
  { itemId:'nd5', mats:[{id:'nd4',n:2,minEnhance:8},{id:'recl',n:15}], chance:0.80, nexumCost:GEAR_CRAFT_LEGENDARY_COST },
];

// ── Уникальное оружие ───────────────────────────────────────────────────────
// A separate, top-end weapon line that is not part of the common→legendary
// upgrade chain: it cannot be dropped, bought or upgraded into, only crafted
// from Осколки, and those come from nothing but killing monsters. Two tiers,
// each strictly twice the corresponding tier of the ordinary line.
//
// Осколки are ordinary stackable materials, so they sell on the market and
// merge into one inventory slot per kind like every other material.
// Clan storage: how long someone must have been in the clan before they can
// put shards in or be handed any. Both halves are gated, not just depositing —
// otherwise a freshly invited alt is a way to walk the pool straight out of
// the clan.
const CLAN_STORAGE_MIN_DAYS = 10;
// What the leader pays, once, out of their own gold to open the storage for
// the whole clan. Paid once per clan, never refunded.
const CLAN_STORAGE_UNLOCK_GOLD = 1000000;

const UNIQUE_SHARD_MIN_LEVEL = 15;        // monsters below this level never drop one
const UNIQUE_SHARD_CHANCE    = 0.000001;  // per SHARD KIND, rolled independently on every kill
const UNIQUE_SHARD_MAX_QTY   = 1;         // most of one kind a single kill can yield
// How many of EVERY kind one weapon costs. All 20 are required, so the two
// numbers below mean 20 000 and 100 000 shards respectively.
const UNIQUE_SHARD_COST = { epic: 1000, legendary: 5000 };

// The 20 kinds. Order is display order (forge recipe list, inventory).
const UNIQUE_SHARDS = [
  { id:'shard_amethyst', name:'Осколок аметиста', img:'/images/uniq/shard/amethyst.png' },
  { id:'shard_dusk',     name:'Осколок сумрака',  img:'/images/uniq/shard/dusk.png'     },
  { id:'shard_gold',     name:'Осколок золота',   img:'/images/uniq/shard/gold.png'     },
  { id:'shard_lilac',    name:'Осколок сирени',   img:'/images/uniq/shard/lilac.png'    },
  { id:'shard_azure',    name:'Осколок лазури',   img:'/images/uniq/shard/azure.png'    },
  { id:'shard_verdant',  name:'Осколок листвы',   img:'/images/uniq/shard/verdant.png'  },
  { id:'shard_ember',    name:'Осколок углей',    img:'/images/uniq/shard/ember.png'    },
  { id:'shard_amber',    name:'Осколок янтаря',   img:'/images/uniq/shard/amber.png'    },
  { id:'shard_star',     name:'Осколок звезды',   img:'/images/uniq/shard/star.png'     },
  { id:'shard_copper',   name:'Осколок меди',     img:'/images/uniq/shard/copper.png'   },
  { id:'shard_onyx',     name:'Осколок оникса',   img:'/images/uniq/shard/onyx.png'     },
  { id:'shard_pearl',    name:'Осколок жемчуга',  img:'/images/uniq/shard/pearl.png'    },
  { id:'shard_ruby',     name:'Осколок рубина',   img:'/images/uniq/shard/ruby.png'     },
  { id:'shard_arcane',   name:'Осколок чар',      img:'/images/uniq/shard/arcane.png'   },
  { id:'shard_rune',     name:'Осколок руны',     img:'/images/uniq/shard/rune.png'     },
  { id:'shard_frost',    name:'Осколок инея',     img:'/images/uniq/shard/frost.png'    },
  { id:'shard_flame',    name:'Осколок пламени',  img:'/images/uniq/shard/flame.png'    },
  { id:'shard_sunset',   name:'Осколок заката',   img:'/images/uniq/shard/sunset.png'   },
  { id:'shard_thunder',  name:'Осколок грозы',    img:'/images/uniq/shard/thunder.png'  },
  { id:'shard_void',     name:'Осколок пустоты',  img:'/images/uniq/shard/void.png'     },
];

// The weapons themselves. Every stat carried over from the ordinary line is
// exactly twice the same class's weapon at that rarity (sw4/sw5, tw4/tw5,
// bw4/bw5, st4/st5) — see ITEM_DEF above. Warlocks share the staff line for
// stats but get their own artwork and entry here, since the unique set ships
// a healer weapon.
//
// On top of that, both tiers carry two things no ordinary weapon has:
//   hp       — flat max HP, like a piece of armour
//   skillPct — skill power: +% to skill DAMAGE and HEALING (see
//              _skillDmgMult/_skillHealMult, js/player.js). Buff durations are
//              measured in seconds and are deliberately left alone — a
//              percentage of a duration is a different kind of number.
const UNIQUE_WEAPONS = [
  // Рыцарь смерти — ×2 of sw4 (atk 44, crit .10) / sw5 (atk 65, crit .25)
  { id:'uq_sword_e', name:'Меч бездны',      slot:'weapon', forClass:['deathknight'], img:'/images/wep/uniq/e_sword.png',  atk:88,  critChance:0.20, hp:300, skillPct:0.20, rarity:'epic'      },
  { id:'uq_sword_l', name:'Меч первых',      slot:'weapon', forClass:['deathknight'], img:'/images/wep/uniq/l_sword.png',  atk:130, critChance:0.50, hp:1000, skillPct:0.50, rarity:'legendary' },
  // Танк — ×2 of tw4 (atk 44, def 16) / tw5 (atk 65, def 24)
  { id:'uq_axe_e',   name:'Топор бездны',    slot:'weapon', forClass:['lev'],         img:'/images/wep/uniq/e_axe.png',    atk:88,  def:32,          hp:300, skillPct:0.20, rarity:'epic'      },
  { id:'uq_axe_l',   name:'Топор первых',    slot:'weapon', forClass:['lev'],         img:'/images/wep/uniq/l_axe.png',    atk:130, def:48,          hp:1000, skillPct:0.50, rarity:'legendary' },
  // Лучник — ×2 of bw4 (atk 60, aspd .10) / bw5 (atk 100, aspd .15, crit .10)
  { id:'uq_bow_e',   name:'Лук бездны',      slot:'weapon', forClass:['ranger'],      img:'/images/wep/uniq/e_bow.png',    atk:120, atkSpeed:0.20,   hp:300, skillPct:0.20, rarity:'epic'      },
  { id:'uq_bow_l',   name:'Лук первых',      slot:'weapon', forClass:['ranger'],      img:'/images/wep/uniq/l_bow.png',    atk:200, atkSpeed:0.30, critChance:0.20, hp:1000, skillPct:0.50, rarity:'legendary' },
  // Маг — ×2 of st4 (atk 60, hp% .10) / st5 (atk 120, hp% .20, crit .10)
  { id:'uq_staff_e', name:'Посох бездны',    slot:'weapon', forClass:['mage'],        img:'/images/wep/uniq/e_staff.png',  atk:120, hpPct:0.20,      hp:300, skillPct:0.20, rarity:'epic'      },
  { id:'uq_staff_l', name:'Посох первых',    slot:'weapon', forClass:['mage'],        img:'/images/wep/uniq/l_staff.png',  atk:240, hpPct:0.40, critChance:0.20, hp:1000, skillPct:0.50, rarity:'legendary' },
  // Целитель — same numbers as the mage staff it replaces for warlocks
  { id:'uq_heal_e',  name:'Жезл бездны',     slot:'weapon', forClass:['warlock'],     img:'/images/wep/uniq/e_healer.png', atk:120, hpPct:0.20,      hp:300, skillPct:0.20, rarity:'epic'      },
  { id:'uq_heal_l',  name:'Жезл первых',     slot:'weapon', forClass:['warlock'],     img:'/images/wep/uniq/l_healer.png', atk:240, hpPct:0.40, critChance:0.20, hp:1000, skillPct:0.50, rarity:'legendary' },
];

// One recipe per weapon: every shard kind at the tier's cost, nothing else.
// No Liberty, no recipe scrolls and chance 1.0 — at these quantities a failed
// roll would destroy months of farming, which is not a risk worth offering.
// Shape matches GEAR_CRAFT_RECIPES so craftGear (server/index.js) validates,
// charges and grants these through exactly the same path.
const UNIQUE_CRAFT_RECIPES = UNIQUE_WEAPONS.map(w => ({
  itemId: w.id,
  unique: true,
  mats: UNIQUE_SHARDS.map(s => ({ id: s.id, n: UNIQUE_SHARD_COST[w.rarity] })),
  chance: 1.0,
}));

// Spliced into the shared catalogs rather than written inline among the
// ordinary gear, so the whole unique line stays readable in one block.
// Everything that resolves an item by id — _catalogBase and _canonSavedItem
// (server), _canonicalMarketItem (market), itemCatalogBase (client) — reads
// these arrays at call time, so appending here is what makes the entries real
// everywhere at once.
//
// `noDrop` keeps the weapons out of every random pool that picks by rarity:
// the mob loot roll and the loot boxes both do `ITEM_DEF.filter(d => d.rarity
// === ... )`, and without the flag a legendary unique would start falling off
// high-level monsters — the exact opposite of a craft-only reward.
CRAFT_MATS.push(...UNIQUE_SHARDS.map(sh => ({
  ...sh, slot: 'material', rarity: 'epic', uniqueShard: true,
})));
ITEM_DEF.push(...UNIQUE_WEAPONS.map(w => ({ ...w, noDrop: true, unique: true })));

// Uncommon/rare gear tiers — used to live purely in js/definitions.js's
// client-only ITEM_CRAFT_RECIPES and be trusted outright: the client rolled
// the chance, spent the materials, and granted the result itself, reaching
// the server only via the next saveProgress blob (which _canonSavedItem
// trusts for any valid id+enhance). Moved here so craftGear (server/
// index.js) can validate and roll these the same way it already does
// GEAR_CRAFT_RECIPES above — no currency involved, only materials, so there's
// no nexumCost/goldCost field on any of these. js/definitions.js splices this
// into ITEM_CRAFT_RECIPES so the craftsman UI keeps listing every tier from
// one place.
const GEAR_TIER_CRAFT_RECIPES = [
  // ── Assassin knives ──────────────────────────────────────
  { itemId:'sw2', mats:[{id:'sw1',n:2,minEnhance:8},{id:'recu',n:1}],  chance:0.80 },
  { itemId:'sw3', mats:[{id:'sw2',n:2,minEnhance:8},{id:'recr',n:5}],  chance:0.80 },
  // ── Warrior axes ─────────────────────────────────────────
  { itemId:'tw2', mats:[{id:'tw1',n:2,minEnhance:8},{id:'recu',n:1}],  chance:0.80 },
  { itemId:'tw3', mats:[{id:'tw2',n:2,minEnhance:8},{id:'recr',n:5}],  chance:0.80 },
  // ── Archer bows ──────────────────────────────────────────
  { itemId:'bw2', mats:[{id:'bw1',n:2,minEnhance:8},{id:'recu',n:1}],  chance:0.80 },
  { itemId:'bw3', mats:[{id:'bw2',n:2,minEnhance:8},{id:'recr',n:5}],  chance:0.80 },
  // ── Staves ───────────────────────────────────────────────
  { itemId:'st2', mats:[{id:'st1',n:2,minEnhance:8},{id:'recu',n:1}],  chance:0.80 },
  { itemId:'st3', mats:[{id:'st2',n:2,minEnhance:8},{id:'recr',n:5}],  chance:0.80 },
  // ── Helmets ──────────────────────────────────────────────
  { itemId:'hm2', mats:[{id:'hm1',n:2,minEnhance:8},{id:'recu',n:1}],  chance:0.80 },
  { itemId:'hm3', mats:[{id:'hm2',n:2,minEnhance:8},{id:'recr',n:5}],  chance:0.80 },
  // ── Body armor ───────────────────────────────────────────
  { itemId:'ar2', mats:[{id:'ar1',n:2,minEnhance:8},{id:'recu',n:1}],  chance:0.80 },
  { itemId:'ar3', mats:[{id:'ar2',n:2,minEnhance:8},{id:'recr',n:5}],  chance:0.80 },
  // ── Gloves ───────────────────────────────────────────────
  { itemId:'gl2', mats:[{id:'gl1',n:2,minEnhance:8},{id:'recu',n:1}],  chance:0.80 },
  { itemId:'gl3', mats:[{id:'gl2',n:2,minEnhance:8},{id:'recr',n:5}],  chance:0.80 },
  // ── Boots ────────────────────────────────────────────────
  { itemId:'bt2', mats:[{id:'bt1',n:2,minEnhance:8},{id:'recu',n:1}],  chance:0.80 },
  { itemId:'bt3', mats:[{id:'bt2',n:2,minEnhance:8},{id:'recr',n:5}],  chance:0.80 },
  // ── Rings ────────────────────────────────────────────────
  { itemId:'rn2', mats:[{id:'rn1',n:2,minEnhance:8},{id:'recu',n:1}],  chance:0.80 },
  { itemId:'rn3', mats:[{id:'rn2',n:2,minEnhance:8},{id:'recr',n:5}],  chance:0.80 },
  // ── Belts ────────────────────────────────────────────────
  { itemId:'nd2', mats:[{id:'nd1',n:2,minEnhance:8},{id:'recu',n:1}],  chance:0.80 },
  { itemId:'nd3', mats:[{id:'nd2',n:2,minEnhance:8},{id:'recr',n:5}],  chance:0.80 },
];

// Recipe-scroll tier-up (recu→recr→rece→recl): 20 of the lower rarity → 1 of
// the higher, 80% chance. Moved here from js/definitions.js for the same
// reason as GEAR_TIER_CRAFT_RECIPES above — craftMatUpgrade (server/
// index.js) now rolls this itself instead of trusting the client's roll.
const MAT_UPGRADE_RECIPES = [
  { from:'recu', to:'recr', count:20, chance:0.80 },
  { from:'recr', to:'rece', count:20, chance:0.80 },
  { from:'rece', to:'recl', count:20, chance:0.80 },
];

const PET_CRAFT_RECIPES = [
  { rarity:'common',   nexumCost:500,  chance:1.0 },
  { rarity:'uncommon', nexumCost:2000, chance:1.0 },
  { rarity:'rare',     nexumCost:5000, chance:1.0 },
];

// Class cloaks & artifacts: salvage junk gear of a rarity into one random
// class-flavored cloak/artifact of that same rarity (ITEM_DEF entries with
// `classItem:true` above), plus a flat Liberty cost. Priced in Liberty, which
// is server-authoritative (see PET_CRAFT_RECIPES above), so — unlike a pure
// gold/mats recipe — the whole exchange (material count check + Liberty
// charge + item grant) has to happen server-side; the client only shows this
// table and waits for the result.
const CLASS_GEAR_SALVAGE_RECIPES = [
  { resultSlot:'cloak',    resultRarity:'common',   costRarity:'common',   costCount:30, nexumCost:300  },
  { resultSlot:'cloak',    resultRarity:'uncommon', costRarity:'uncommon', costCount:20, nexumCost:1500 },
  { resultSlot:'artifact', resultRarity:'common',   costRarity:'common',   costCount:30, nexumCost:300  },
  { resultSlot:'artifact', resultRarity:'uncommon', costRarity:'uncommon', costCount:20, nexumCost:1500 },
];

// Clan membership cap. Enforced server-side in clanApprove; the client
// renders it next to the member count so a leader can see how full the
// clan is before approving an application.
const CLAN_MAX_MEMBERS = 30;

// Clan description cap. Enforced server-side in clanSetDescription; the
// client uses it as the textarea's maxlength so the leader sees the limit
// while typing instead of finding out only after saving.
const CLAN_DESC_MAX_CHARS = 200;

// Max enchant-stone enhance level (mirrors the client's _ENH_MAX in ui.js)
const ENHANCE_MAX = 15;
// Slots whose atk/def/hp scale with enhance level (mirrors _enhBonusAt in player.js)
const ENHANCEABLE_SLOTS = new Set(['weapon', 'helmet', 'body', 'gloves', 'boots', 'ring', 'belt', 'pet', 'cloak', 'artifact']);
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
// Not part of any room chain: spawned on demand into its own sealed arena
// (server/game/dungeon.js), reachable only through the event teleport pad
// that appears in the hub while the event runs. Announced
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
  hp: 1000000, atk: 20, def: 1, spd: 50,
  xp: 120, gold: 120,
  isBoss: true, eType: 'boss',
  // Exempts this one boss from three rules tuned for ordinary room-bound
  // monsters: the safe-zone target skip, the 420px leash, and the de-aggro
  // teleport-home. The arena is 40 tiles across, so without the last two it
  // would reset its 100k HP to full the moment players kited it any distance.
  ignoresSafeZone: true,
};

// ── 3v3 arena guard boss (one per side) ─────────────────────────────────────
// Same identity as EVENT_BOSS (name/color/size) but a fixed, much smaller HP
// pool and no loot table — see spawnPvpArenaBosses in server/game/Room.js. It
// never moves or attacks and the owning team can't damage it; the opposing
// team destroying it ends the match immediately in their favour.
const ARENA3_BOSS_HP = 30000;

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
  add(mat('bless_stone'), 2);                                      // 2 безопасных заточек
  add(mat('norm_stone'), 5);                                       // 5 обычных заточек
  return out;
}

// ── Death Battle (Битва на смерть) ──────────────────────────────────────────
// Scheduled free-for-all: registration opens DEATH_BATTLE_REG_MS before each
// start time, then everyone who signed up is scattered across the same arena
// the event boss uses, forced into PvP, and fights until one player is left.
// Times are Moscow (UTC+3, no DST) hours — nextEventStartAt below converts to
// UTC itself, so this stays readable.
// Вторник, четверг, суббота — раз в день, в 10:00.
const DEATH_BATTLE_DAYS_MSK = [2, 4, 6];
const DEATH_BATTLE_HOURS_MSK = [10];
const DEATH_BATTLE_MSK_OFFSET_H = 3;
const DEATH_BATTLE_REG_MS = 5 * 60 * 1000;
// Everyone lands in the arena frozen for this long — nobody can move or
// attack — so the round starts from a standstill instead of handing the win to
// whoever's client finished loading the teleport first.
const DEATH_BATTLE_FREEZE_MS = 30 * 1000;
// Without at least two entrants there is nobody to fight, so the round is
// cancelled rather than handing someone a free win.
const DEATH_BATTLE_MIN_PLAYERS = 2;
// A round that somehow never resolves (everyone hiding, a stuck client) is
// force-ended here so the schedule can't wedge.
const DEATH_BATTLE_MAX_MS = 20 * 60 * 1000;
const DEATH_BATTLE_GRAM_REWARD = 0.05;

// Smallest GRAM withdrawal the bot will take. Shared so the server's refusal
// and the client's input/validation/hint can't drift apart — they were three
// separate literals before, which is how a change like this gets half applied.
const GRAM_MIN_WITHDRAW = 1;

// ── World boss schedule ─────────────────────────────────────────────────────
// Понедельник, среда, пятница, воскресенье в 20:00 по Москве. Deliberately
// interleaved with the death battle's days so the two never land on the same
// evening. The boss still has to be summoned — the schedule just does what an
// admin used to do by hand (see scheduleEventBoss in server/index.js), which
// means an admin summon on an off day still works exactly as before.
const WORLD_BOSS_DAYS_MSK  = [1, 3, 5, 0];
const WORLD_BOSS_HOURS_MSK = [20];

// ── Corridor race schedule ───────────────────────────────────────────────────
// Every day, registration opens at 20:30 Moscow time for RACE10_REG_MS (5
// minutes, server/index.js) and then closes for the day — there is exactly
// one start per window (see _race10Start there), so leaving registration
// open any longer than that would just accept sign-ups for a race that
// already ran.
const RACE10_DAYS_MSK  = [0, 1, 2, 3, 4, 5, 6];
const RACE10_HOURS_MSK = [20.5];

// ── 3v3 arena schedule ───────────────────────────────────────────────────────
// Every day, 21:00–22:00 by Moscow time — same reg-window shape as the
// corridor race just above (see _a3Schedule, server/index.js), one hour
// later so the two events don't overlap.
const ARENA3_DAYS_MSK  = [0, 1, 2, 3, 4, 5, 6];
const ARENA3_HOURS_MSK = [21];
const ARENA3_WINDOW_MS = 60 * 60 * 1000;

// ── Guild War ("Война гильдий") schedule ─────────────────────────────────────
// Every day, 22:00–23:00 Moscow time — one sealed zone, one stationary tower.
// Whichever clan lands the killing blow owns it until another clan re-fights
// it down to 0 (full HP reset on every capture). Ownership itself has no
// schedule — it persists across the closed 23:00-22:00 gap, only the zone's
// combat access opens and closes on this window.
const GUILD_WAR_DAYS_MSK  = [0, 1, 2, 3, 4, 5, 6];
const GUILD_WAR_HOURS_MSK = [22];
const GUILD_WAR_WINDOW_MS = 60 * 60 * 1000;

// Between ARENA3_BOSS_HP (30k, solo-killable in one 3v3) and EVENT_BOSS.hp
// (1M, a whole server's worth of damage) — meant to take a sustained
// multi-clan push, not one raid. A starting placeholder pending real
// multi-clan playtesting; easy to retune since it's one constant read by
// both Room.spawnGuildWarTower and the client's HP bar.
const GUILD_WAR_TOWER_HP = 300000;

// Passive income while owned: a random total of 10-30 shard units per hour,
// spread across UNIQUE_SHARDS' kinds (see _rollGuildWarIncome, server/
// index.js), credited 24/7 regardless of whether the zone is currently open.
const GUILD_WAR_SHARD_MIN = 10;
const GUILD_WAR_SHARD_MAX = 30;
const GUILD_WAR_INCOME_INTERVAL_MS = 60 * 60 * 1000;

// Both events warn everyone over the bot this far ahead, then again on start.
const EVENT_NOTIFY_BEFORE_MS = 30 * 60 * 1000;

// Next occurrence of a weekday+hour schedule, in UTC ms. Moscow is UTC+3
// year-round (no DST since 2014), so the offset is a constant rather than a
// timezone lookup: shift into Moscow time to read the calendar date there,
// then shift that date's midnight back to real UTC before adding the hour.
// Shared so the client's countdown and the server's timers can't disagree.
// `days` are Moscow weekdays, 0 = воскресенье .. 6 = суббота.
function nextEventStartAt(days, hours, from = Date.now()) {
  const OFF = DEATH_BATTLE_MSK_OFFSET_H * 3600000;
  const msk = new Date(from + OFF);
  let best = Infinity;
  // A full week ahead plus today, so a schedule with a single weekday still
  // resolves no matter which day it is asked on.
  for (let d = 0; d <= 7; d++) {
    const midnightMsk = Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate() + d);
    if (!days.includes(new Date(midnightMsk).getUTCDay())) continue;
    for (const h of hours) {
      const t = midnightMsk - OFF + h * 3600000;
      if (t > from && t < best) best = t;
    }
  }
  return best === Infinity ? 0 : best;
}

// The winner's prize, built the same way as rollEventBossDrops: every entry is
// a fully-formed inventory item, so the granting code never has to know what
// any of them are.
function deathBattleRewards() {
  const out = [];
  const add = (base, qty) => { if (base) out.push({ ...base, qty }); };
  add(CRAFT_MATS.find(m => m.id === 'bless_stone'), 1);   // 1 безопасная заточка
  add(CRAFT_MATS.find(m => m.id === 'key_rare'), 10);     // 10 редких ключей
  ITEM_DEF.filter(i => i.slot === 'buff_potion').forEach(bp => add(bp, 1)); // все 6 банок бафа
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
// Liberty charged to wipe every stat upgrade and hand back the skill points
// that went into them (see the resetUpgrades handler in server/index.js and
// the button in js/ui.js — both read this so the price shown is the price
// charged).
const UPGRADE_RESET_COST = 200;

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

// ── Clan levels & cumulative bonuses ──────────────────────────
// Each level's bonus is the CUMULATIVE total at that level (not the increment).
// Shared (not just js/definitions.js) because the server needs the same atk%
// the client's recompute() applies — see clanAtkBonusPct below and its
// callers in server/game/Room.js's computeStats.
const CLAN_LEVELS = [
  { lvl:1,  xpReq:0,      bonus:{ gold:0,  xp:0,  atk:0  }, label:'Новообразованный' },
  { lvl:2,  xpReq:500,    bonus:{ gold:5,  xp:0,  atk:0  }, label:'Слаженный'        },
  { lvl:3,  xpReq:1500,   bonus:{ gold:5,  xp:5,  atk:0  }, label:'Сплочённый'       },
  { lvl:4,  xpReq:4000,   bonus:{ gold:10, xp:5,  atk:0  }, label:'Опытный'          },
  { lvl:5,  xpReq:10000,  bonus:{ gold:10, xp:5,  atk:5  }, label:'Именитый'         },
  { lvl:6,  xpReq:25000,  bonus:{ gold:10, xp:10, atk:5  }, label:'Прославленный'    },
  { lvl:7,  xpReq:60000,  bonus:{ gold:15, xp:10, atk:5  }, label:'Легендарный'      },
  { lvl:8,  xpReq:150000, bonus:{ gold:15, xp:10, atk:10 }, label:'Великий'          },
  { lvl:9,  xpReq:350000, bonus:{ gold:15, xp:15, atk:10 }, label:'Непобедимый'      },
  { lvl:10, xpReq:800000, bonus:{ gold:20, xp:20, atk:15 }, label:'Бессмертный'      },
];
// The % attack bonus for a clan currently at `level` — used identically by
// the client (recompute(), js/player.js) and the server (computeStats below)
// so a player's effective atk can't drift depending on which side computed
// it last.
function clanAtkBonusPct(level) {
  return CLAN_LEVELS[(level || 1) - 1]?.bonus.atk || 0;
}

if (typeof module !== 'undefined') module.exports = {
  TILE, WALL, FLOOR, ENEMY_AOI_R, CHAR_DEF, ENEMY_DEF, FLOOR_ENEMIES, bandForLocalLevel, calcGoldDrop,
  xpAtLevel, goldAtLevel,
  CLAN_LEVELS, clanAtkBonusPct,
  ARM_NAMES, ARM_ROOM_PAIRS, ARM_ROOM_COUNTS, ARM_OFFSETS, MAX_MONSTER_LEVEL, roomsInArm,
  armIndexForLevel, armNameForLevel, armLocalLevel, ARM_LEVEL_REQ, FEAR_MAX_WAVE,
  QUEST_DEF,
  SEASON_END_AT, SEASON_MIN_LVL, SEASON_MAX_LVL, SEASON_QUEST_KILLS, SEASON_QUEST_POINTS,
  SEASON_SPECIES, SEASON_BURN_POINTS, SEASON_PRIZES, seasonActive,
  SEASON_EVENT_POINTS, SEASON_EVENT_TASKS, SEASON_SPECIES_LEVELS, SEASON_ENHANCE_POINTS,
  SEASON_WIN_POINTS,
  SEASON_TIERS, SEASON_TIER_DEFAULT, SEASON_TIER_SPECIES_LEVELS, seasonTier,
  SEASON_REF_POINTS, SEASON_REF_LEVEL,
  MONSTER_HP1, MONSTER_ATK1, MONSTER_ARCHETYPE,
  BOSS_HP_MULT, BOSS_ATK_MULT,
  monsterHPAtLevel, monsterATKAtLevel, monsterDEFAtLevel, monsterStatsAtLevel,
  MONSTER_RANK_M, MONSTER_RANK_F, monsterNameAtLevel, monsterColorAtLevel,
  UPGRADE_RESET_COST,
  PASSIVE_MAX_LEVEL, PASSIVE_CLASS_DEF, PASSIVE_COMMON_DEF,
  passiveDefById, passivesForClass, passiveBonusTotal,
  VIP_THRESHOLDS, VIP_BONUSES,
  ITEM_DEF, CRAFT_MATS, BOX_DEF, ENHANCE_MAX, ENHANCEABLE_SLOTS, enhanceBonus, isStackableItem,
  PET_CRAFT_RECIPES, GEAR_CRAFT_RECIPES, GEAR_TIER_CRAFT_RECIPES, MAT_UPGRADE_RECIPES,
  UNIQUE_SHARDS, UNIQUE_WEAPONS, UNIQUE_CRAFT_RECIPES, UNIQUE_SHARD_COST,
  CLAN_STORAGE_MIN_DAYS, CLAN_STORAGE_UNLOCK_GOLD,
  UNIQUE_SHARD_MIN_LEVEL, UNIQUE_SHARD_CHANCE, UNIQUE_SHARD_MAX_QTY,
  CLASS_GEAR_SALVAGE_RECIPES, CLAN_MAX_MEMBERS, CLAN_DESC_MAX_CHARS,
  ITEM_DROP_GROWTH_PCT, BOSS_ITEM_DROP_MULT, COMMON_ITEM_MAX_LEVEL, itemDropChanceAtLevel, itemRarityForLevel,
  ROOM_DROP_GROWTH, ROOM_KEY_GROWTH, ROOM_KEY_BASE,
  ROOM_ENCHANT_STONE_BASE, ROOM_ENCHANT_STONE_GROWTH,
  roomDropMult, roomKeyChance, roomEnchantStoneChance,
  EVENT_BOSS, EVENT_BOSS_ANNOUNCE_MS, EVENT_BOSS_DROP_LIFE_MS, rollEventBossDrops,
  ARENA3_BOSS_HP,
  DEATH_BATTLE_DAYS_MSK, DEATH_BATTLE_HOURS_MSK, DEATH_BATTLE_MSK_OFFSET_H,
  DEATH_BATTLE_REG_MS, DEATH_BATTLE_FREEZE_MS,
  DEATH_BATTLE_MIN_PLAYERS, DEATH_BATTLE_MAX_MS, DEATH_BATTLE_GRAM_REWARD, deathBattleRewards,
  WORLD_BOSS_DAYS_MSK, WORLD_BOSS_HOURS_MSK, EVENT_NOTIFY_BEFORE_MS, nextEventStartAt,
  RACE10_DAYS_MSK, RACE10_HOURS_MSK,
  ARENA3_DAYS_MSK, ARENA3_HOURS_MSK, ARENA3_WINDOW_MS,
  GUILD_WAR_DAYS_MSK, GUILD_WAR_HOURS_MSK, GUILD_WAR_WINDOW_MS,
  GUILD_WAR_TOWER_HP, GUILD_WAR_SHARD_MIN, GUILD_WAR_SHARD_MAX, GUILD_WAR_INCOME_INTERVAL_MS,
  GRAM_MIN_WITHDRAW,
};
