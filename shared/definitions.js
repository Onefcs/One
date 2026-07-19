// ─────────────────────────────────────────────────────────────────────────────
//  SHARED GAME DEFINITIONS — single source of truth for server and client
//  Browser: loaded as a plain <script>; constants become global.
//  Node.js: const { ENEMY_DEF, CHAR_DEF, TILE } = require('../shared/definitions');
// ─────────────────────────────────────────────────────────────────────────────

// ── Map constants ─────────────────────────────────────────────────────────────
const TILE = 40;
const WALL = 0, FLOOR = 1;

// ── Character definitions ─────────────────────────────────────────────────────
const CHAR_DEF = {
  warrior: { name:'Воин',    icon:'warrior',    color:'#55aaff', baseHP:200, baseAtk:5,  baseDef:10, speed:145, atkRange:58,  atkSpeed:0.798, atkType:'melee' },
  archer:  { name:'Лучник',  icon:'archerClass',color:'#77ee77', baseHP:140, baseAtk:4,  baseDef:5,  speed:175, atkRange:210, atkSpeed:1.062, atkType:'ranged', projColor:'#ffaa00' },
  mage:    { name:'Маг',     icon:'mageClass',  color:'#ee88ee', baseHP:110, baseAtk:8,  baseDef:3,  speed:155, atkRange:180, atkSpeed:0.558, atkType:'ranged', projColor:'#cc88ff' },
  priest:  { name:'Жрец',    icon:'priest',     color:'#ffee66', baseHP:160, baseAtk:3,  baseDef:7,  speed:148, atkRange:170, atkSpeed:0.800, atkType:'ranged', projColor:'#ffff44' },
  assasin: { name:'Ассасин', icon:'assasin',    color:'#bb55ff', baseHP:120, baseAtk:9,  baseDef:2,  speed:205, atkRange:52,  atkSpeed:1.200, atkType:'melee' },
};

// ── Enemy definitions ─────────────────────────────────────────────────────────
// Floors 1-5 use FLOOR_ENEMIES map; floors 6+ use orc/troll/demon.
const ENEMY_DEF = [
  // Floor 1 — Goblins
  { eid:'goblin_guard',   name:'Гоблин страж',  color:'#4a4', size:13, hp:45,  atk:9,   def:1,  spd:80,  xp:2,  gold:[1,3],   isBoss:false, eType:'guard'   },
  { eid:'goblin_warrior', name:'Гоблин воин',   color:'#2a5', size:14, hp:55,  atk:12,  def:2,  spd:92,  xp:3,  gold:[1,3],   isBoss:false, eType:'warrior' },
  { eid:'goblin_boss',    name:'Босс гоблинов', color:'#0f5', size:22, hp:200, atk:25,  def:5,  spd:65,  xp:20, gold:[15,25], isBoss:true,  eType:'boss'    },
  // Floor 2 — Skeletons
  { eid:'skel_warrior',   name:'Скелет воин',   color:'#bbb', size:15, hp:75,  atk:16,  def:3,  spd:70,  xp:4,  gold:[1,3],   isBoss:false, eType:'warrior' },
  { eid:'skel_barbarian', name:'Скелет варвар', color:'#ccc', size:16, hp:90,  atk:20,  def:4,  spd:75,  xp:5,  gold:[1,3],   isBoss:false, eType:'guard'   },
  { eid:'skel_boss',      name:'Босс скелетов', color:'#eee', size:24, hp:350, atk:40,  def:8,  spd:55,  xp:30, gold:[20,35], isBoss:true,  eType:'boss'    },
  // Floor 3 — Mushrooms
  { eid:'mush_guard',     name:'Гриб страж',    color:'#c63', size:13, hp:110, atk:22,  def:5,  spd:60,  xp:6,  gold:[1,3],   isBoss:false, eType:'guard'   },
  { eid:'mush_warrior',   name:'Гриб воин',     color:'#d74', size:15, hp:130, atk:28,  def:6,  spd:65,  xp:7,  gold:[1,3],   isBoss:false, eType:'warrior' },
  { eid:'mush_boss',      name:'Босс грибов',   color:'#f85', size:26, hp:500, atk:55,  def:12, spd:45,  xp:45, gold:[30,50], isBoss:true,  eType:'boss'    },
  // Floor 4 — Ghosts
  { eid:'ghost_warrior',  name:'Тень воин',     color:'#88f', size:16, hp:150, atk:35,  def:7,  spd:110, xp:8,  gold:[1,3],   isBoss:false, eType:'warrior' },
  { eid:'ghost_guard',    name:'Тень страж',    color:'#aaf', size:14, hp:130, atk:30,  def:6,  spd:120, xp:7,  gold:[1,3],   isBoss:false, eType:'guard'   },
  { eid:'ghost_boss',     name:'Босс теней',    color:'#ccf', size:28, hp:700, atk:70,  def:15, spd:85,  xp:60, gold:[40,65], isBoss:true,  eType:'boss'    },
  // Floor 5 — Golems
  { eid:'golem_warrior',  name:'Голем воин',    color:'#964', size:20, hp:200, atk:45,  def:10, spd:50,  xp:10, gold:[1,3],   isBoss:false, eType:'warrior' },
  { eid:'golem_guard',    name:'Голем страж',   color:'#875', size:18, hp:180, atk:40,  def:12, spd:55,  xp:9,  gold:[1,3],   isBoss:false, eType:'guard'   },
  { eid:'golem_boss',     name:'Босс големов',  color:'#ba6', size:32, hp:1000,atk:100, def:20, spd:40,  xp:80, gold:[55,80], isBoss:true,  eType:'boss'    },
  // Floors 6+ — legacy enemies
  { eid:'orc',    name:'Орк',    color:'#964', size:20, hp:130, atk:20, def:8,  spd:56, xp:4,  gold:[1,3],   isBoss:false, eType:'warrior' },
  { eid:'troll',  name:'Тролль', color:'#575', size:24, hp:230, atk:28, def:12, spd:40, xp:7,  gold:[1,3],   isBoss:false, eType:'guard'   },
  { eid:'demon',  name:'ДЕМОН',  color:'#f33', size:28, hp:420, atk:42, def:16, spd:60, xp:50, gold:[50,50], isBoss:true,  eType:'boss'    },
];

// Per-floor enemy pools for floors 1-5
const FLOOR_ENEMIES = {
  1: { pool: ['goblin_guard', 'goblin_warrior'], boss: 'goblin_boss'   },
  2: { pool: ['skel_warrior', 'skel_barbarian'], boss: 'skel_boss'     },
  3: { pool: ['mush_guard',   'mush_warrior'],   boss: 'mush_boss'     },
  4: { pool: ['ghost_warrior','ghost_guard'],     boss: 'ghost_boss'    },
  5: { pool: ['golem_warrior','golem_guard'],     boss: 'golem_boss'    },
};

// Gold drop: 30% chance for regular enemies, 100% for bosses. Scales with floor.
function calcGoldDrop(enemy, floor) {
  if (enemy.isBoss) {
    const g = enemy.gold || [50, 50];
    return g[0] + Math.floor(Math.random() * (g[1] - g[0] + 1));
  }
  if (Math.random() > 0.30) return 0;
  const base = enemy.gold[0] + Math.floor(Math.random() * (enemy.gold[1] - enemy.gold[0] + 1));
  return Math.round(base * Math.pow(2, floor - 1));
}

// Minimum player level to enter each floor (index = floor number)
const FLOOR_UNLOCK_LEVEL = [0, 0, 5, 15, 30, 50];

if (typeof module !== 'undefined') module.exports = { TILE, WALL, FLOOR, CHAR_DEF, ENEMY_DEF, FLOOR_ENEMIES, calcGoldDrop, FLOOR_UNLOCK_LEVEL };
