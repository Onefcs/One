// CHAR_DEF, ENEMY_DEF, TILE, WALL, FLOOR → shared/definitions.js

// ── Clan levels & cumulative bonuses ──────────────────────────
// Each level's bonus is the CUMULATIVE total at that level (not the increment)
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

const UPGRADE_DEF = {
  atk:        { label:'Атака',       icon:'sword',      baseCost:30,  desc:'+1 ATK'       },
  def:        { label:'Защита',      icon:'shield',     baseCost:30,  desc:'+1 DEF'       },
  hp:         { label:'Здоровье',    icon:'heart',      baseCost:25,  desc:'+10 MaxHP'    },
  atkSpeed:   { label:'Скор. атаки', icon:'lightning',  baseCost:50,  desc:'+0.05 уд/с'  },
  critChance: { label:'Шанс крита',  icon:'star',       baseCost:60,  desc:'+1%'          },
  critPower:  { label:'Сила крита',  icon:'flame',      baseCost:60,  desc:'+3%'          },
  hpRegen:    { label:'Реген HP',    icon:'hpPlus',     baseCost:80,  desc:'+0.1/сек'     },
};

const QUEST_DEF = [
  // ── Этаж 1 · Скелеты (квесты 1-15) ─────────────────────
  { id:'f1q1',  floor:1, title:'Первая кровь',      desc:'Убей 10 Скелет воин',       type:'kill',         enemies:['Скелет воин'],    count:10,  reward:{ xp:50,   gold:25  } },
  { id:'f1q2',  floor:1, title:'Страж падёт',       desc:'Убей 10 Скелет варвар',     type:'kill',         enemies:['Скелет варвар'],  count:10,  reward:{ xp:50,   gold:25  } },
  { id:'f1q3',  floor:1, title:'Торговля',          desc:'Купи 10 зелий',             type:'buy_potion',                               count:10,  reward:{ xp:60,   gold:30  } },
  { id:'f1q4',  floor:1, title:'Охотник',           desc:'Убей 30 Скелет воин',       type:'kill',         enemies:['Скелет воин'],    count:30,  reward:{ xp:120,  gold:60  } },
  { id:'f1q5',  floor:1, title:'Каратель',          desc:'Убей 30 Скелет варвар',     type:'kill',         enemies:['Скелет варвар'],  count:30,  reward:{ xp:120,  gold:60  } },
  { id:'f1q6',  floor:1, title:'Опытный боец',      desc:'Достигни 3 уровня',         type:'level',        level:3,                    reward:{ xp:150,  gold:75  } },
  { id:'f1q7',  floor:1, title:'Истребитель',       desc:'Убей 50 Скелет воин',       type:'kill',         enemies:['Скелет воин'],    count:50,  reward:{ xp:200,  gold:100 } },
  { id:'f1q8',  floor:1, title:'Гроза стражей',     desc:'Убей 50 Скелет варвар',     type:'kill',         enemies:['Скелет варвар'],  count:50,  reward:{ xp:200,  gold:100 } },
  { id:'f1q9',  floor:1, title:'Убийца боссов',     desc:'Убей Босса скелетов',       type:'kill',         enemies:['Босс скелетов'],  count:1,   reward:{ xp:300,  gold:150 } },
  { id:'f1q10', floor:1, title:'Ветеран',           desc:'Достигни 5 уровня',         type:'level',        level:5,                    reward:{ xp:350,  gold:175 } },
  { id:'f1q11', floor:1, title:'Покоритель',        desc:'Пройди подземелье 1 раз',   type:'dungeon_clear',floor:1,  count:1,           reward:{ xp:400,  gold:200 } },
  { id:'f1q12', floor:1, title:'Мясник',            desc:'Убей 100 Скелет варвар',    type:'kill',         enemies:['Скелет варвар'],  count:100, reward:{ xp:450,  gold:225 } },
  { id:'f1q13', floor:1, title:'Берсерк',           desc:'Убей 100 Скелет воин',      type:'kill',         enemies:['Скелет воин'],    count:100, reward:{ xp:450,  gold:225 } },
  { id:'f1q14', floor:1, title:'В гильдию!',        desc:'Вступи в гильдию',          type:'join_guild',                               reward:{ xp:500,  gold:250 } },
  { id:'f1q15', floor:1, title:'Следующий уровень', desc:'Перейди на этаж 2',         type:'goto_floor',   targetFloor:2,              reward:{ xp:600,  gold:300 } },

  // ── Этаж 2 · Гоблины (квесты 16-30) · награда ×2 ───────
  { id:'f2q1',  floor:2, title:'Первая кровь II',   desc:'Убей 10 Гоблин воин',       type:'kill',         enemies:['Гоблин воин'],    count:10,  reward:{ xp:100,  gold:50  } },
  { id:'f2q2',  floor:2, title:'Страж падёт II',    desc:'Убей 10 Гоблин страж',      type:'kill',         enemies:['Гоблин страж'],   count:10,  reward:{ xp:100,  gold:50  } },
  { id:'f2q3',  floor:2, title:'Торговля II',       desc:'Купи 10 зелий',             type:'buy_potion',                               count:10,  reward:{ xp:120,  gold:60  } },
  { id:'f2q4',  floor:2, title:'Охотник II',        desc:'Убей 30 Гоблин воин',       type:'kill',         enemies:['Гоблин воин'],    count:30,  reward:{ xp:240,  gold:120 } },
  { id:'f2q5',  floor:2, title:'Каратель II',       desc:'Убей 30 Гоблин страж',      type:'kill',         enemies:['Гоблин страж'],   count:30,  reward:{ xp:240,  gold:120 } },
  { id:'f2q6',  floor:2, title:'Опытный боец II',   desc:'Достигни 7 уровня',         type:'level',        level:7,                    reward:{ xp:300,  gold:150 } },
  { id:'f2q7',  floor:2, title:'Истребитель II',    desc:'Убей 50 Гоблин воин',       type:'kill',         enemies:['Гоблин воин'],    count:50,  reward:{ xp:400,  gold:200 } },
  { id:'f2q8',  floor:2, title:'Гроза стражей II',  desc:'Убей 50 Гоблин страж',      type:'kill',         enemies:['Гоблин страж'],   count:50,  reward:{ xp:400,  gold:200 } },
  { id:'f2q9',  floor:2, title:'Убийца боссов II',  desc:'Убей Босса гоблинов',       type:'kill',         enemies:['Босс гоблинов'],  count:1,   reward:{ xp:600,  gold:300 } },
  { id:'f2q10', floor:2, title:'Ветеран II',        desc:'Достигни 10 уровня',        type:'level',        level:10,                   reward:{ xp:700,  gold:350 } },
  { id:'f2q11', floor:2, title:'Покоритель II',     desc:'Пройди подземелье 2 раза',  type:'dungeon_clear',floor:2,  count:2,           reward:{ xp:800,  gold:400 } },
  { id:'f2q12', floor:2, title:'Мясник II',         desc:'Убей 100 Гоблин страж',     type:'kill',         enemies:['Гоблин страж'],   count:100, reward:{ xp:900,  gold:450 } },
  { id:'f2q13', floor:2, title:'Берсерк II',        desc:'Убей 100 Гоблин воин',      type:'kill',         enemies:['Гоблин воин'],    count:100, reward:{ xp:900,  gold:450 } },
  { id:'f2q14', floor:2, title:'Почётный член',     desc:'Повысь ранг в гильдии',     type:'join_guild',                               reward:{ xp:1000, gold:500 } },
  { id:'f2q15', floor:2, title:'Вглубь тьмы',      desc:'Перейди на этаж 3',         type:'goto_floor',   targetFloor:3,              reward:{ xp:1200, gold:600 } },
];


const RARITY_COLOR = {
  common:    '#aaa',
  uncommon:  '#3ef07a',
  rare:      '#55aaff',
  epic:      '#c55ef5',
  legendary: '#ffd700',
};

// CRAFT_MATS, ITEM_DEF → shared/definitions.js (server needs the same
// canonical item catalog to validate Market listings against)

const EQ_SLOTS = [
  { slot:'weapon',  label:'Оружие', emptyIcon:'weapon' },
  { slot:'helmet',  label:'Шлем',   emptyIcon:'helmet' },
  { slot:'body',    label:'Тело',   emptyIcon:'body'   },
  { slot:'gloves',  label:'Перчи',  emptyIcon:'gloves' },
  { slot:'boots',   label:'Боты',   emptyIcon:'boots'  },
  { slot:'ring',    label:'Кольцо', emptyIcon:'ring'   },
  { slot:'belt',    label:'Пояс',   emptyIcon:'belt'   },
];

const SKILL_DEF = {
  warrior: [
    { key:'Q', name:'Щит-удар',    icon:'shieldBash', img:'/images/skill/wstun.png',   cd:18, desc:'×2 урон по цели + стан 3 сек' },
    { key:'W', name:'Вихрь',       icon:'whirlwind',  img:'/images/skill/wvixr.png',   cd:12, desc:'АОЕ урон, радиус 110'          },
    { key:'E', name:'Боевой клич', icon:'battleCry',  img:'/images/skill/wboevoy.png', cd:20, desc:'+20% атака на 5 сек'           },
    { key:'R', name:'Рывок',       icon:'dash',       img:'/images/skill/wrivok.png',  cd:15, desc:'Прыгает к цели нанося урон'    },
  ],
  archer: [
    { key:'Q', name:'Мульти-выстрел', icon:'multiShot',   img:'/images/skill/lmulti.png',   cd:6,  desc:'3 стрелы под углом ±0.35 рад' },
    { key:'W', name:'Комбо стрела',   icon:'poisonArrow', img:'/images/skill/lkombo.png',   cd:10, desc:'3 стрелы ×1 урон'             },
    { key:'E', name:'Прыжок',         icon:'roll',        img:'/images/skill/lprijok.png',  cd:8,  desc:'Рывок 80px'                   },
    { key:'R', name:'Скорость атаки', icon:'arrowRain',   img:'/images/skill/latkspeed.png',cd:20, desc:'×2 скорость атаки на 5 сек'   },
  ],
  mage: [
    { key:'Q', name:'Огненный шар', icon:'fireball', img:'/images/skill/mshar.png',     cd:5,  desc:'Снаряд ×2 урона'               },
    { key:'W', name:'Ледяная нова', icon:'iceNova',  img:'/images/skill/mnova.png',     cd:10, desc:'АОЕ урон 130 + заморозка 3 сек' },
    { key:'E', name:'Барьер',       icon:'barrier',  img:'/images/skill/mbarier.png',   cd:18, desc:'Защита +50% на 3 сек'           },
    { key:'R', name:'Телепорт',     icon:'teleport', img:'/images/skill/mteleport.png', cd:12, desc:'Рывок 180px по направлению'     },
  ],
  priest: [
    { key:'Q', name:'Исцеление',  icon:'heal',      img:'/images/skill/sheal.png',       cd:8,  desc:'+20% maxHP'                    },
    { key:'W', name:'Оцепенение', icon:'holyLight', img:'/images/skill/socepinenie.png', cd:15, desc:'Удерживает цель на месте 3 сек'},
    { key:'E', name:'Щит веры',   icon:'barrier',   img:'/images/skill/sshit.png',       cd:18, desc:'+50% защита себе и пати 4 сек' },
    { key:'R', name:'Молитва',    icon:'prayer',    img:'/images/skill/spartyheal.png',  cd:25, desc:'+10% maxHP себе и +10% пати'   },
  ],
  assasin: [
    { key:'Q', name:'Удар тени',   icon:'shadowStrike', img:'/images/skill/audarteni.png', cd:5,  desc:'Рывок 80px к врагу'        },
    { key:'W', name:'Дым. шашка',  icon:'smokeBomb',    img:'/images/skill/adim.png',      cd:12, desc:'АОЕ урон 100 + замедление' },
    { key:'E', name:'Невидимость', icon:'roll',         img:'/images/skill/ainvidible.png',cd:20, desc:'Невидим для врагов 4 сек'  },
    { key:'R', name:'Смерть. удар',icon:'deathStrike',  img:'/images/skill/asmertudar.png',cd:25, desc:'×4 удар по одной цели'     },
  ],
};

// Bonus category for each skill key per class
// damage → +1% per level  |  buff → +1s duration  |  barrier → +0.2s  |  invis → +0.2s  |  heal → +1%  |  mobility → +10px range
const SKILL_BONUS_TYPE = {
  warrior: { Q: 'damage', W: 'damage', E: 'buff',     R: 'damage'   },
  archer:  { Q: 'damage', W: 'damage', E: 'buff',     R: 'buff'     },
  mage:    { Q: 'damage', W: 'damage', E: 'buff',     R: 'mobility' },
  priest:  { Q: 'heal',   W: 'buff',   E: 'buff',     R: 'heal'     },
  assasin: { Q: 'damage', W: 'damage', E: 'buff',     R: 'damage'   },
};

const NPC_DEF = [
  { id:'merchant',   name:'Торговец', icon:'merchant',   color:'#ffaa00', desc:'Зелья и расходники' },
  { id:'craftsman',  name:'Кузнец',   icon:'craftsman',  color:'#8888ff', desc:'Крафт предметов'    },
  { id:'shopkeeper', name:'Лавочник', icon:'shopkeeper', color:'#44ff44', desc:'Снаряжение'         },
];

const MERCHANT_SHOP = [
  { itemId:'pt1',       name:'Малое зелье',     img:'/images/potion/smallhp.png', price:5,    desc:'HP +20'                    },
  { itemId:'pt2',       name:'Большое зелье',   img:'/images/potion/bighp.png',   price:30,   desc:'HP +50'                    },
  { itemId:'bp_hp',       name:'Зелье здоровья',   img:'/images/potion/hp.png',       price:1000, desc:'+10% HP 30мин'             },
  { itemId:'bp_exp',      name:'Зелье опыта',       img:'/images/potion/exp.png',      price:1000, desc:'×2 опыт 30мин'             },
  { itemId:'bp_gold',     name:'Зелье золота',      img:'/images/potion/gold.png',     price:1000, desc:'×2 золото 30мин'           },
  { itemId:'bp_regen',    name:'Зелье регена',      img:'/images/potion/regen.png',    price:1000, desc:'+2 HP/сек 30мин'           },
  { itemId:'bp_atkspeed', name:'Зелье скорости',    img:'/images/potion/atkspeed.png', price:1000, desc:'+20% скор. атаки 30мин'   },
  { itemId:'bp_atk',      name:'Зелье атаки',       img:'/images/potion/atk.png',      price:1000, desc:'+20% атаки 30мин'          },
];

const SHOP_CATALOG = [
  // Common
  { itemId:'sw1', price:100 }, { itemId:'tw1', price:100 }, { itemId:'bw1', price:100 }, { itemId:'st1', price:100 },
  { itemId:'hm1', price:100 }, { itemId:'ar1', price:100 }, { itemId:'gl1', price:100 }, { itemId:'bt1', price:100 },
  { itemId:'rn1', price:100 }, { itemId:'nd1', price:100 },
];

// Crafting recipes: uncommon+ = 2× same-type lower tier at +8 + 1 recipe scroll
// Stone recipes: boss_stone + gold → enchant stone
const ITEM_CRAFT_RECIPES = [
  // ── Assassin knives ──────────────────────────────────────
  { itemId:'sw2', mats:[{id:'sw1',n:2,minEnhance:8},{id:'recu',n:1}],  chance:0.80 },
  { itemId:'sw3', mats:[{id:'sw2',n:2,minEnhance:8},{id:'recr',n:5}],  chance:0.80 },
  { itemId:'sw4', mats:[{id:'sw3',n:2,minEnhance:8},{id:'rece',n:10}], chance:0.80 },
  { itemId:'sw5', mats:[{id:'sw4',n:2,minEnhance:8},{id:'recl',n:15}], chance:0.80 },
  // ── Warrior axes ─────────────────────────────────────────
  { itemId:'tw2', mats:[{id:'tw1',n:2,minEnhance:8},{id:'recu',n:1}],  chance:0.80 },
  { itemId:'tw3', mats:[{id:'tw2',n:2,minEnhance:8},{id:'recr',n:5}],  chance:0.80 },
  { itemId:'tw4', mats:[{id:'tw3',n:2,minEnhance:8},{id:'rece',n:10}], chance:0.80 },
  { itemId:'tw5', mats:[{id:'tw4',n:2,minEnhance:8},{id:'recl',n:15}], chance:0.80 },
  // ── Archer bows ──────────────────────────────────────────
  { itemId:'bw2', mats:[{id:'bw1',n:2,minEnhance:8},{id:'recu',n:1}],  chance:0.80 },
  { itemId:'bw3', mats:[{id:'bw2',n:2,minEnhance:8},{id:'recr',n:5}],  chance:0.80 },
  { itemId:'bw4', mats:[{id:'bw3',n:2,minEnhance:8},{id:'rece',n:10}], chance:0.80 },
  { itemId:'bw5', mats:[{id:'bw4',n:2,minEnhance:8},{id:'recl',n:15}], chance:0.80 },
  // ── Staves ───────────────────────────────────────────────
  { itemId:'st2', mats:[{id:'st1',n:2,minEnhance:8},{id:'recu',n:1}],  chance:0.80 },
  { itemId:'st3', mats:[{id:'st2',n:2,minEnhance:8},{id:'recr',n:5}],  chance:0.80 },
  { itemId:'st4', mats:[{id:'st3',n:2,minEnhance:8},{id:'rece',n:10}], chance:0.80 },
  { itemId:'st5', mats:[{id:'st4',n:2,minEnhance:8},{id:'recl',n:15}], chance:0.80 },
  // ── Helmets ──────────────────────────────────────────────
  { itemId:'hm2', mats:[{id:'hm1',n:2,minEnhance:8},{id:'recu',n:1}],  chance:0.80 },
  { itemId:'hm3', mats:[{id:'hm2',n:2,minEnhance:8},{id:'recr',n:5}],  chance:0.80 },
  { itemId:'hm4', mats:[{id:'hm3',n:2,minEnhance:8},{id:'rece',n:10}], chance:0.80 },
  { itemId:'hm5', mats:[{id:'hm4',n:2,minEnhance:8},{id:'recl',n:15}], chance:0.80 },
  // ── Body armor ───────────────────────────────────────────
  { itemId:'ar2', mats:[{id:'ar1',n:2,minEnhance:8},{id:'recu',n:1}],  chance:0.80 },
  { itemId:'ar3', mats:[{id:'ar2',n:2,minEnhance:8},{id:'recr',n:5}],  chance:0.80 },
  { itemId:'ar4', mats:[{id:'ar3',n:2,minEnhance:8},{id:'rece',n:10}], chance:0.80 },
  { itemId:'ar5', mats:[{id:'ar4',n:2,minEnhance:8},{id:'recl',n:15}], chance:0.80 },
  // ── Gloves ───────────────────────────────────────────────
  { itemId:'gl2', mats:[{id:'gl1',n:2,minEnhance:8},{id:'recu',n:1}],  chance:0.80 },
  { itemId:'gl3', mats:[{id:'gl2',n:2,minEnhance:8},{id:'recr',n:5}],  chance:0.80 },
  { itemId:'gl4', mats:[{id:'gl3',n:2,minEnhance:8},{id:'rece',n:10}], chance:0.80 },
  { itemId:'gl5', mats:[{id:'gl4',n:2,minEnhance:8},{id:'recl',n:15}], chance:0.80 },
  // ── Boots ────────────────────────────────────────────────
  { itemId:'bt2', mats:[{id:'bt1',n:2,minEnhance:8},{id:'recu',n:1}],  chance:0.80 },
  { itemId:'bt3', mats:[{id:'bt2',n:2,minEnhance:8},{id:'recr',n:5}],  chance:0.80 },
  { itemId:'bt4', mats:[{id:'bt3',n:2,minEnhance:8},{id:'rece',n:10}], chance:0.80 },
  { itemId:'bt5', mats:[{id:'bt4',n:2,minEnhance:8},{id:'recl',n:15}], chance:0.80 },
  // ── Rings ────────────────────────────────────────────────
  { itemId:'rn2', mats:[{id:'rn1',n:2,minEnhance:8},{id:'recu',n:1}],  chance:0.80 },
  { itemId:'rn3', mats:[{id:'rn2',n:2,minEnhance:8},{id:'recr',n:5}],  chance:0.80 },
  { itemId:'rn4', mats:[{id:'rn3',n:2,minEnhance:8},{id:'rece',n:10}], chance:0.80 },
  { itemId:'rn5', mats:[{id:'rn4',n:2,minEnhance:8},{id:'recl',n:15}], chance:0.80 },
  // ── Belts ────────────────────────────────────────────────
  { itemId:'nd2', mats:[{id:'nd1',n:2,minEnhance:8},{id:'recu',n:1}],  chance:0.80 },
  { itemId:'nd3', mats:[{id:'nd2',n:2,minEnhance:8},{id:'recr',n:5}],  chance:0.80 },
  { itemId:'nd4', mats:[{id:'nd3',n:2,minEnhance:8},{id:'rece',n:10}], chance:0.80 },
  { itemId:'nd5', mats:[{id:'nd4',n:2,minEnhance:8},{id:'recl',n:15}], chance:0.80 },
  // ── Enchant stones ───────────────────────────────────────
  { matId:'norm_stone',  mats:[{id:'boss_stone',n:3}],  goldCost:300,  chance:1.0 },
  { matId:'bless_stone', mats:[{id:'boss_stone',n:10}], goldCost:2000, chance:1.0 },
];

// Recipe upgrade: 20 of lower rarity → 1 of higher rarity (80% chance)
const MAT_UPGRADE_RECIPES = [
  { from:'recu', to:'recr', count:20, chance:0.80 },
  { from:'recr', to:'rece', count:20, chance:0.80 },
  { from:'rece', to:'recl', count:20, chance:0.80 },
];

// Battle Power — reflects the player's overall combat strength
function calcBM(p) {
  if (!p) return 0;
  const upg = p.upgrades || {};
  const extras = ((upg.critChance || 0) + (upg.critPower || 0) +
    (upg.hpRegen || 0) + (upg.atkSpeed || 0)) * 8;
  return Math.round((p.level || 1) * 50 + (p.atk || 0) * 5 + (p.def || 0) * 3 + (p.maxHp || 100) * 0.5 + extras);
}
