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
  warrior: { name:'Воин',   emoji:'🗡️', color:'#55aaff', baseHP:200, baseAtk:5,  baseDef:10, speed:145, atkRange:58,  atkSpeed:0.798, atkType:'melee' },
  archer:  { name:'Лучник', emoji:'🏹', color:'#77ee77', baseHP:140, baseAtk:4,  baseDef:5,  speed:175, atkRange:210, atkSpeed:1.062, atkType:'ranged', projColor:'#ffaa00' },
  mage:    { name:'Маг',    emoji:'🔮', color:'#ee88ee', baseHP:110, baseAtk:8,  baseDef:3,  speed:155, atkRange:180, atkSpeed:0.558, atkType:'ranged', projColor:'#cc88ff' },
};

// ── Enemy definitions ─────────────────────────────────────────────────────────
// Index order matters: client dungeon uses index for maxEIdx scaling per floor.
// Floor 1 → indices 0-1 (mushroom, slime); floor 5 → indices 0-3 (+ goblin); etc.
const ENEMY_DEF = [
  { eid:'mushroom', name:'Гриб',    color:'#cc6633', size:13, hp:30,  atk:6,  def:1,  spd:65,  xp:1,  gold:[1,3], isBoss:false },
  { eid:'slime',    name:'Слизень', color:'#44cc44', size:12, hp:35,  atk:7,  def:0,  spd:55,  xp:1,  gold:[1,3], isBoss:false },
  { eid:'spider',   name:'Паук',    color:'#332255', size:14, hp:50,  atk:10, def:2,  spd:110, xp:2,  gold:[1,3], isBoss:false },
  { eid:'goblin',   name:'Гоблин',  color:'#3a3',    size:14, hp:40,  atk:8,  def:2,  spd:92,  xp:2,  gold:[1,3], isBoss:false },
  { eid:'skeleton', name:'Скелет',  color:'#bbb',    size:16, hp:70,  atk:14, def:4,  spd:70,  xp:3,  gold:[1,3], isBoss:false },
  { eid:'orc',      name:'Орк',     color:'#964',    size:20, hp:130, atk:20, def:8,  spd:56,  xp:4,  gold:[1,3], isBoss:false },
  { eid:'troll',    name:'Тролль',  color:'#575',    size:24, hp:230, atk:28, def:12, spd:40,  xp:7,  gold:[1,3], isBoss:false },
  { eid:'demon',    name:'ДЕМОН',   color:'#f33',    size:28, hp:420, atk:42, def:16, spd:60,  xp:13, gold:[1,3], isBoss:true  },
];

// Gold drop: 30% chance, scales with floor. Returns 0 if no drop.
function calcGoldDrop(enemy, floor) {
  if (Math.random() > 0.30) return 0;
  const base = enemy.gold[0] + Math.floor(Math.random() * (enemy.gold[1] - enemy.gold[0] + 1));
  return Math.round(base * Math.pow(2, floor - 1));
}

if (typeof module !== 'undefined') module.exports = { TILE, WALL, FLOOR, CHAR_DEF, ENEMY_DEF, calcGoldDrop };
