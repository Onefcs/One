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
  warrior: { name:'Воин',    icon:'warrior',    color:'#55aaff', baseHP:200, baseAtk:3,  baseDef:10, speed:145, atkRange:58,  atkSpeed:1.197, atkType:'melee' },
  archer:  { name:'Лучник',  icon:'archerClass',color:'#77ee77', baseHP:140, baseAtk:2,  baseDef:5,  speed:175, atkRange:210, atkSpeed:1.593, atkType:'ranged', projColor:'#ffaa00' },
  mage:    { name:'Маг',     icon:'mageClass',  color:'#ee88ee', baseHP:110, baseAtk:4,  baseDef:3,  speed:155, atkRange:180, atkSpeed:0.837, atkType:'ranged', projColor:'#cc88ff' },
  priest:  { name:'Жрец',    icon:'priest',     color:'#ffee66', baseHP:160, baseAtk:2,  baseDef:7,  speed:148, atkRange:170, atkSpeed:1.200, atkType:'ranged', projColor:'#ffff44' },
  assasin: { name:'Ассасин', icon:'assasin',    color:'#bb55ff', baseHP:120, baseAtk:5,  baseDef:2,  speed:205, atkRange:52,  atkSpeed:1.800, atkType:'melee' },
};

// ── Enemy definitions ─────────────────────────────────────────────────────────
// Floors are capped at 5 (MAX_FLOOR, server/index.js); FLOOR_ENEMIES below
// covers every eid used here.
const ENEMY_DEF = [
  // Floor 1 — Skeletons (swapped from floor 2, stats adjusted to floor-1 level)
  { eid:'skel_warrior',   name:'Скелет воин',   color:'#bbb', size:15, hp:65,  atk:10,  def:2,  spd:81,  xp:2,  gold:[1,3],   isBoss:false, eType:'warrior' },
  { eid:'skel_barbarian', name:'Скелет варвар', color:'#ccc', size:16, hp:75,  atk:13,  def:3,  spd:93,  xp:3,  gold:[1,3],   isBoss:false, eType:'guard'   },
  { eid:'skel_boss',      name:'Босс скелетов', color:'#eee', size:24, hp:880, atk:52,  def:6,  spd:66,  xp:20, gold:[15,25], isBoss:true,  eType:'boss'    },
  // Floor 2 — Goblins (4× original)
  { eid:'goblin_guard',   name:'Гоблин страж',  color:'#4a4', size:13, hp:900,  atk:128, def:12, spd:70,  xp:4,  gold:[1,3],   isBoss:false, eType:'guard'   },
  { eid:'goblin_warrior', name:'Гоблин воин',   color:'#2a5', size:14, hp:1080, atk:160, def:16, spd:75,  xp:5,  gold:[1,3],   isBoss:false, eType:'warrior' },
  { eid:'goblin_boss',    name:'Босс гоблинов', color:'#0f5', size:22, hp:4200, atk:320, def:32, spd:55,  xp:30, gold:[20,35], isBoss:true,  eType:'boss'    },
  // Floor 3 — Mushrooms (4× original)
  { eid:'mush_guard',     name:'Гриб страж',    color:'#c63', size:13, hp:1320, atk:264, def:20, spd:60,  xp:6,  gold:[1,3],   isBoss:false, eType:'guard'   },
  { eid:'mush_warrior',   name:'Гриб воин',     color:'#d74', size:15, hp:1560, atk:336, def:24, spd:65,  xp:7,  gold:[1,3],   isBoss:false, eType:'warrior' },
  { eid:'mush_boss',      name:'Босс грибов',   color:'#f85', size:26, hp:6000, atk:660, def:48, spd:45,  xp:45, gold:[30,50], isBoss:true,  eType:'boss'    },
  // Floor 4 — Ghosts (4× original)
  { eid:'ghost_warrior',  name:'Тень воин',     color:'#88f', size:16, hp:1800, atk:420, def:28, spd:110, xp:8,  gold:[1,3],   isBoss:false, eType:'warrior' },
  { eid:'ghost_guard',    name:'Тень страж',    color:'#aaf', size:14, hp:1560, atk:360, def:24, spd:120, xp:7,  gold:[1,3],   isBoss:false, eType:'guard'   },
  { eid:'ghost_boss',     name:'Босс теней',    color:'#ccf', size:28, hp:8400, atk:840, def:60, spd:85,  xp:60, gold:[40,65], isBoss:true,  eType:'boss'    },
  // Floor 5 — Golems (4× original)
  { eid:'golem_warrior',  name:'Голем воин',    color:'#964', size:20, hp:2400, atk:540, def:40, spd:50,  xp:10, gold:[1,3],   isBoss:false, eType:'warrior' },
  { eid:'golem_guard',    name:'Голем страж',   color:'#875', size:18, hp:2160, atk:480, def:48, spd:55,  xp:9,  gold:[1,3],   isBoss:false, eType:'guard'   },
  { eid:'golem_boss',     name:'Босс големов',  color:'#ba6', size:32, hp:12000,atk:1200,def:80, spd:40,  xp:80, gold:[55,80], isBoss:true,  eType:'boss'    },
];

// Per-floor enemy pools for floors 1-5
const FLOOR_ENEMIES = {
  1: { pool: ['skel_warrior',  'skel_barbarian'], boss: 'skel_boss'     },
  2: { pool: ['goblin_guard', 'goblin_warrior'], boss: 'goblin_boss'   },
  3: { pool: ['mush_guard',   'mush_warrior'],   boss: 'mush_boss'     },
  4: { pool: ['ghost_warrior','ghost_guard'],     boss: 'ghost_boss'    },
  5: { pool: ['golem_warrior','golem_guard'],     boss: 'golem_boss'    },
};

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

// Minimum player level to enter each floor (index = floor number)
const FLOOR_UNLOCK_LEVEL = [0, 0, 5, 15, 30, 50];

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
];

const ITEM_DEF = [
  // ── Assassin knives ───────────────────────────────────────
  { id:'sw1', name:'Ржавый нож',       slot:'weapon', forClass:['assasin'], img:'/images/wep/ck.png', atk:4,                            rarity:'common'   },
  { id:'sw2', name:'Стальной нож',     slot:'weapon', forClass:['assasin'], img:'/images/wep/uk.png', atk:14,                           rarity:'uncommon' },
  { id:'sw3', name:'Нож дракона',      slot:'weapon', forClass:['assasin'], img:'/images/wep/rk.png', atk:23, critChance:0.05,          rarity:'rare'     },
  { id:'sw4', name:'Нож теней',        slot:'weapon', forClass:['assasin'], img:'/images/wep/ek.png', atk:44, critChance:0.10,          rarity:'epic'     },
  { id:'sw5', name:'Нож героя',        slot:'weapon', forClass:['assasin'], img:'/images/wep/lk.png', atk:65, critChance:0.25,          rarity:'legendary'},
  // ── Warrior axes ─────────────────────────────────────────
  { id:'tw1', name:'Ржавый топор',     slot:'weapon', forClass:['warrior'], img:'/images/wep/ct.png', atk:5,                            rarity:'common'   },
  { id:'tw2', name:'Стальной топор',   slot:'weapon', forClass:['warrior'], img:'/images/wep/ut.png', atk:15,                           rarity:'uncommon' },
  { id:'tw3', name:'Топор дракона',    slot:'weapon', forClass:['warrior'], img:'/images/wep/rt.png', atk:23,                           rarity:'rare'     },
  { id:'tw4', name:'Топор теней',      slot:'weapon', forClass:['warrior'], img:'/images/wep/et.png', atk:44,                           rarity:'epic'     },
  { id:'tw5', name:'Топор героя',      slot:'weapon', forClass:['warrior'], img:'/images/wep/lt.png', atk:65,                           rarity:'legendary'},
  // ── Archer bows ──────────────────────────────────────────
  { id:'bw1', name:'Деревянный лук',   slot:'weapon', forClass:['archer'],  img:'/images/wep/cb.png', atk:8,                            rarity:'common'   },
  { id:'bw2', name:'Серебряный лук',   slot:'weapon', forClass:['archer'],  img:'/images/wep/ub.png', atk:18, atkSpeed:0.03,            rarity:'uncommon' },
  { id:'bw3', name:'Лук охотника',     slot:'weapon', forClass:['archer'],  img:'/images/wep/rb.png', atk:28, atkSpeed:0.05,            rarity:'rare'     },
  { id:'bw4', name:'Лунный лук',       slot:'weapon', forClass:['archer'],  img:'/images/wep/eb.png', atk:60, atkSpeed:0.10,            rarity:'epic'     },
  { id:'bw5', name:'Лук героя',        slot:'weapon', forClass:['archer'],  img:'/images/wep/lb.png', atk:100, atkSpeed:0.15, critChance:0.10, rarity:'legendary'},
  // ── Mage / Priest staves ─────────────────────────────────
  { id:'st1', name:'Посох новичка',    slot:'weapon', forClass:['mage','priest'], img:'/images/wep/cs.png', atk:7,                      rarity:'common'   },
  { id:'st2', name:'Посох бойца',      slot:'weapon', forClass:['mage','priest'], img:'/images/wep/us.png', atk:17,                     rarity:'uncommon' },
  { id:'st3', name:'Посох охотника',   slot:'weapon', forClass:['mage','priest'], img:'/images/wep/rs.png', atk:30, hpPct:0.05,         rarity:'rare'     },
  { id:'st4', name:'Посох Героя',      slot:'weapon', forClass:['mage','priest'], img:'/images/wep/es.png', atk:60, hpPct:0.10,         rarity:'epic'     },
  { id:'st5', name:'Посох Легенды',    slot:'weapon', forClass:['mage','priest'], img:'/images/wep/ls.png', atk:120, hpPct:0.20, critChance:0.10, rarity:'legendary'},
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
function isStackableItem(it) { return it.slot === 'material' || it.slot === 'recipe' || it.slot === 'buff_potion'; }

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
  TILE, WALL, FLOOR, CHAR_DEF, ENEMY_DEF, FLOOR_ENEMIES, calcGoldDrop, FLOOR_UNLOCK_LEVEL,
  VIP_THRESHOLDS, VIP_BONUSES,
  ITEM_DEF, CRAFT_MATS, ENHANCE_MAX, ENHANCEABLE_SLOTS, enhanceBonus, isStackableItem,
};
