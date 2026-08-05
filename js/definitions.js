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

// Story quest chain: one linear track (player.questIdx) spanning all 4
// corridor arms up to global monster level 78 — 15 quests per arm, each
// arm roughly doubling the previous one's rewards and player-level asks
// (×1/×2/×4/×8 off the floor-1 baseline) so every chapter is noticeably
// harder than the last. Each arm's 3 (2 for arm 4) monster species show up
// in story order weakest→toughest: early kill quests hit the arm's first
// species, the mid-chapter pair introduces its second species, the big
// grind before the boss is its toughest species, matching the level-up
// experience of actually walking further down that corridor. Enemy names
// must match ENEMY_DEF's base names exactly (shared/definitions.js) —
// onEnemyKill() counts kills by that exact string, before any rank prefix.
// The 1st/5th/10th/15th quest of every arm (by array order, not by id
// suffix — quest ids run out of sequence, e.g. f1q11 sits 10th) also hands
// out one of each buff potion, since the merchant no longer sells them.
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
  { id:'f1q9',  floor:1, title:'Изгоняющий бесов',    desc:'Убей Босс бесов',            type:'kill',         enemies:['Босс бесов'],       count:1,   reward:{ xp:300,  gold:150 } },
  { id:'f1q15', floor:1, title:'Следующий уровень',   desc:'Дойди до верхнего коридора', type:'goto_floor',   targetFloor:2,                reward:{ xp:600,  gold:300, items:_BUFF_POTION_IDS } },

  // ── Верхний коридор · Гнилые топи (квесты 16-30) · награда ×2 ──
  { id:'f2q1',  floor:2, title:'Первая кровь II',     desc:'Убей 10 Зомби страж',        type:'kill',         enemies:['Зомби страж'],      count:10,  reward:{ xp:100,  gold:50,  items:_BUFF_POTION_IDS } },
  { id:'f2q2',  floor:2, title:'Страж падёт II',      desc:'Убей 10 Ящер страж',         type:'kill',         enemies:['Ящер страж'],       count:10,  reward:{ xp:100,  gold:50  } },
  { id:'f2q3',  floor:2, title:'Торговля II',         desc:'Купи 10 зелий',              type:'buy_potion',                                 count:10,  reward:{ xp:120,  gold:60  } },
  { id:'f2q4',  floor:2, title:'Охотник II',          desc:'Убей 30 Орк страж',          type:'kill',         enemies:['Орк страж'],        count:30,  reward:{ xp:240,  gold:120 } },
  { id:'f2q5',  floor:2, title:'Каратель II',         desc:'Убей 30 Зомби воин',         type:'kill',         enemies:['Зомби воин'],       count:30,  reward:{ xp:240,  gold:120, items:_BUFF_POTION_IDS } },
  { id:'f2q6',  floor:2, title:'Опытный боец II',     desc:'Достигни 7 уровня',          type:'level',        level:7,                      reward:{ xp:300,  gold:150 } },
  { id:'f2q7',  floor:2, title:'Охотник на ящеров',   desc:'Убей 50 Ящер воин',          type:'kill',         enemies:['Ящер воин'],        count:50,  reward:{ xp:400,  gold:200 } },
  { id:'f2q8',  floor:2, title:'Ярость орков',        desc:'Убей 50 Орк воин',           type:'kill',         enemies:['Орк воин'],         count:50,  reward:{ xp:400,  gold:200 } },
  { id:'f2q10', floor:2, title:'Ветеран II',          desc:'Достигни 10 уровня',         type:'level',        level:10,                     reward:{ xp:700,  gold:350 } },
  { id:'f2q11', floor:2, title:'Покоритель II',       desc:'Дойди до конца верхнего коридора', type:'dungeon_clear',floor:2, count:2,        reward:{ xp:800,  gold:400, items:_BUFF_POTION_IDS } },
  { id:'f2q12', floor:2, title:'Мясник II',           desc:'Убей 100 Орк воин',          type:'kill',         enemies:['Орк воин'],         count:100, reward:{ xp:900,  gold:450 } },
  { id:'f2q13', floor:2, title:'Берсерк II',          desc:'Убей 100 Орк страж',         type:'kill',         enemies:['Орк страж'],        count:100, reward:{ xp:900,  gold:450 } },
  { id:'f2q14', floor:2, title:'Почётный член',       desc:'Повысь ранг в гильдии',      type:'join_guild',                                 reward:{ xp:1000, gold:500 } },
  { id:'f2q9',  floor:2, title:'Убийца боссов II',    desc:'Убей Босс орков',            type:'kill',         enemies:['Босс орков'],       count:1,   reward:{ xp:600,  gold:300 } },
  { id:'f2q15', floor:2, title:'Вглубь тьмы',         desc:'Дойди до нижнего коридора',  type:'goto_floor',   targetFloor:3,                reward:{ xp:1200, gold:600, items:_BUFF_POTION_IDS } },

  // ── Нижний коридор · Кровавые чертоги (квесты 31-45) · награда ×4 ──
  { id:'f3q1',  floor:3, title:'Первая кровь III',    desc:'Убей 10 Лоза страж',         type:'kill',         enemies:['Лоза страж'],       count:10,  reward:{ xp:200,  gold:100, items:_BUFF_POTION_IDS } },
  { id:'f3q2',  floor:3, title:'Страж падёт III',     desc:'Убей 10 Вампир страж',       type:'kill',         enemies:['Вампир страж'],     count:10,  reward:{ xp:200,  gold:100  } },
  { id:'f3q3',  floor:3, title:'Торговля III',        desc:'Купи 10 зелий',              type:'buy_potion',                                 count:10,  reward:{ xp:240,  gold:120  } },
  { id:'f3q4',  floor:3, title:'Охотник III',         desc:'Убей 30 Бехолдер страж',     type:'kill',         enemies:['Бехолдер страж'],   count:30,  reward:{ xp:480,  gold:240  } },
  { id:'f3q5',  floor:3, title:'Каратель III',        desc:'Убей 30 Лоза воин',          type:'kill',         enemies:['Лоза воин'],        count:30,  reward:{ xp:480,  gold:240, items:_BUFF_POTION_IDS } },
  { id:'f3q6',  floor:3, title:'Опытный боец III',    desc:'Достигни 15 уровня',         type:'level',        level:15,                     reward:{ xp:600,  gold:300  } },
  { id:'f3q7',  floor:3, title:'Охотник на вампиров', desc:'Убей 50 Вампир воин',        type:'kill',         enemies:['Вампир воин'],      count:50,  reward:{ xp:800,  gold:400  } },
  { id:'f3q8',  floor:3, title:'Взгляд бездны',       desc:'Убей 50 Бехолдер воин',      type:'kill',         enemies:['Бехолдер воин'],    count:50,  reward:{ xp:800,  gold:400  } },
  { id:'f3q10', floor:3, title:'Ветеран III',         desc:'Достигни 20 уровня',         type:'level',        level:20,                     reward:{ xp:1400, gold:700  } },
  { id:'f3q11', floor:3, title:'Покоритель III',      desc:'Дойди до конца нижнего коридора', type:'dungeon_clear',floor:3, count:3,         reward:{ xp:1600, gold:800, items:_BUFF_POTION_IDS } },
  { id:'f3q12', floor:3, title:'Мясник III',          desc:'Убей 100 Бехолдер воин',     type:'kill',         enemies:['Бехолдер воин'],    count:100, reward:{ xp:1800, gold:900  } },
  { id:'f3q13', floor:3, title:'Берсерк III',         desc:'Убей 100 Бехолдер страж',    type:'kill',         enemies:['Бехолдер страж'],   count:100, reward:{ xp:1800, gold:900  } },
  { id:'f3q14', floor:3, title:'Столп гильдии',       desc:'Повысь ранг в гильдии',      type:'join_guild',                                 reward:{ xp:2000, gold:1000 } },
  { id:'f3q9',  floor:3, title:'Убийца боссов III',   desc:'Убей Босс бехолдеров',       type:'kill',         enemies:['Босс бехолдеров'],  count:1,   reward:{ xp:1200, gold:600  } },
  { id:'f3q15', floor:3, title:'На край света',       desc:'Дойди до правого коридора',  type:'goto_floor',   targetFloor:4,                reward:{ xp:2400, gold:1200, items:_BUFF_POTION_IDS } },

  // ── Правый коридор · Врата преисподней (квесты 46-60) · награда ×8 ──
  { id:'f4q1',  floor:4, title:'Первая кровь IV',     desc:'Убей 10 Древень страж',      type:'kill',         enemies:['Древень страж'],    count:10,  reward:{ xp:400,  gold:200, items:_BUFF_POTION_IDS } },
  { id:'f4q2',  floor:4, title:'Страж падёт IV',      desc:'Убей 10 Демон страж',        type:'kill',         enemies:['Демон страж'],      count:10,  reward:{ xp:400,  gold:200  } },
  { id:'f4q3',  floor:4, title:'Торговля IV',         desc:'Купи 10 зелий',              type:'buy_potion',                                 count:10,  reward:{ xp:480,  gold:240  } },
  { id:'f4q4',  floor:4, title:'Охотник IV',          desc:'Убей 30 Древень страж',      type:'kill',         enemies:['Древень страж'],    count:30,  reward:{ xp:960,  gold:480  } },
  { id:'f4q5',  floor:4, title:'Каратель IV',         desc:'Убей 30 Древень воин',       type:'kill',         enemies:['Древень воин'],     count:30,  reward:{ xp:960,  gold:480, items:_BUFF_POTION_IDS } },
  { id:'f4q6',  floor:4, title:'Опытный боец IV',     desc:'Достигни 25 уровня',         type:'level',        level:25,                     reward:{ xp:1200, gold:600  } },
  { id:'f4q7',  floor:4, title:'Изгоняющий демонов',  desc:'Убей 50 Демон страж',        type:'kill',         enemies:['Демон страж'],      count:50,  reward:{ xp:1600, gold:800  } },
  { id:'f4q8',  floor:4, title:'Пламя преисподней',   desc:'Убей 50 Демон воин',         type:'kill',         enemies:['Демон воин'],       count:50,  reward:{ xp:1600, gold:800  } },
  { id:'f4q10', floor:4, title:'Ветеран IV',          desc:'Достигни 30 уровня',         type:'level',        level:30,                     reward:{ xp:2800, gold:1400 } },
  { id:'f4q11', floor:4, title:'Покоритель IV',       desc:'Дойди до конца правого коридора', type:'dungeon_clear',floor:4, count:4,         reward:{ xp:3200, gold:1600, items:_BUFF_POTION_IDS } },
  { id:'f4q12', floor:4, title:'Мясник IV',           desc:'Убей 100 Демон воин',        type:'kill',         enemies:['Демон воин'],       count:100, reward:{ xp:3600, gold:1800 } },
  { id:'f4q13', floor:4, title:'Берсерк IV',          desc:'Убей 100 Демон страж',       type:'kill',         enemies:['Демон страж'],      count:100, reward:{ xp:3600, gold:1800 } },
  { id:'f4q14', floor:4, title:'Легенда гильдии',     desc:'Повысь ранг в гильдии',      type:'join_guild',                                 reward:{ xp:4000, gold:2000 } },
  { id:'f4q9',  floor:4, title:'Убийца боссов IV',    desc:'Убей Босс демонов',          type:'kill',         enemies:['Босс демонов'],     count:1,   reward:{ xp:2400, gold:1200 } },
  { id:'f4q15', floor:4, title:'Владыка подземелья',  desc:'Убей Босс демонов ещё раз',  type:'kill',         enemies:['Босс демонов'],     count:2,   reward:{ xp:6000, gold:3000, items:_BUFF_POTION_IDS } },
];


// Kept as a deliberate, distinct hue ladder (grey -> moss -> steel-blue ->
// amethyst -> gold) rather than run through the general dark-fantasy
// recolor pass below — collapsing rare/epic toward the new gold accent
// would erase the rarity tiers players read at a glance.
const RARITY_COLOR = {
  common:    '#9c9086',
  uncommon:  '#6f9c4a',
  rare:      '#4a7bab',
  epic:      '#8a5cc2',
  legendary: '#e8b93e',
};

// CRAFT_MATS, ITEM_DEF → shared/definitions.js (server needs the same
// canonical item catalog to validate Market listings against)

// Order matters: updateInvUI (js/ui.js) splits this in half for the
// equipment diamond's two columns (first 5 → left, last 5 → right).
const EQ_SLOTS = [
  { slot:'weapon',   label:'Оружие',  emptyIcon:'weapon'   },
  { slot:'helmet',   label:'Шлем',    emptyIcon:'helmet'   },
  { slot:'body',     label:'Тело',    emptyIcon:'body'     },
  { slot:'gloves',   label:'Перчи',   emptyIcon:'gloves'   },
  { slot:'cloak',    label:'Плащ',    emptyIcon:'cloak'    },
  { slot:'boots',    label:'Боты',    emptyIcon:'boots'    },
  { slot:'ring',     label:'Кольцо',  emptyIcon:'ring'     },
  { slot:'belt',     label:'Пояс',    emptyIcon:'belt'     },
  { slot:'pet',      label:'Питомец', emptyIcon:'pet'      },
  { slot:'artifact', label:'Артефакт',emptyIcon:'artifact' },
];

// icon = SVG fallback (js/icons.js); img = the real skill artwork from
// images/skill/ — both the HUD canvas buttons (drawSkillButtons) and the
// skill-upgrade modal already prefer img over icon when it's set.
const SKILL_DEF = {
  // lev <-> deathknight skill sets swapped (name/icon/img/cd/desc only —
  // useSkill()'s per-key mechanics in js/player.js were already identical
  // between these two classes, so swapping the definitions is enough).
  lev: [
    { key:'Q', name:'Ледяной удар',   icon:'shieldBash', img:'/images/skill/wstun_v2.png',   cd:18, desc:'×2 урон по цели + стан 3 сек' },
    { key:'W', name:'Смерч клинков',  icon:'whirlwind',  img:'/images/skill/wvixr_v2.png',   cd:12, desc:'АОЕ урон, радиус 110'          },
    { key:'E', name:'Гнев мертвеца',  icon:'battleCry',  img:'/images/skill/wboevoy_v2.png', cd:20, desc:'+80% защиты на 10 сек'         },
    { key:'R', name:'Рывок света',    icon:'dash',       img:'/images/skill/wrivok_v2.png',  cd:15, desc:'Прыгает к цели нанося урон'    },
  ],
  deathknight: [
    { key:'Q', name:'Вампиризм',    icon:'drop',       img:'/images/skill/adim_v2.png',      cd:28, desc:'Вампиризм 10% от удара на 10 сек' },
    { key:'W', name:'Вихрь клинка', icon:'whirlwind',  img:'/images/skill/asmertudar.png', cd:12, desc:'АОЕ урон, радиус 110'          },
    { key:'E', name:'Ярость',       icon:'battleCry',  img:'/images/skill/ainvidible_v2.png', cd:20, desc:'+20% атака на 5 сек'           },
    { key:'R', name:'Кувырок',      icon:'roll',       img:'/images/skill/audarteni.png',  cd:15, desc:'Прыгает к цели нанося урон'    },
  ],
  ranger: [
    { key:'Q', name:'Мульти-выстрел', icon:'multiShot',   img:'/images/skill/lmulti.png',    cd:6,  desc:'3 стрелы под углом ±0.35 рад' },
    { key:'W', name:'Комбо стрела',   icon:'poisonArrow', img:'/images/skill/lkombo.png',    cd:10, desc:'3 стрелы ×1 урон'             },
    { key:'E', name:'Прыжок',         icon:'roll',        img:'/images/skill/lprijok.png',   cd:8,  desc:'Рывок 80px'                   },
    { key:'R', name:'Скорость атаки', icon:'arrowRain',   img:'/images/skill/latkspeed.png', cd:20, desc:'×1.5 скорость атаки на 5 сек' },
  ],
  mage: [
    { key:'Q', name:'Ледяной шар',  icon:'fireball', img:'/images/skill/mshar_v2.png',  cd:5,  desc:'Снаряд ×2 урона'               },
    { key:'W', name:'Ледяная нова', icon:'iceNova',  img:'/images/skill/mnova.png',     cd:10, desc:'АОЕ урон 130 + заморозка 3 сек' },
    { key:'E', name:'Барьер',       icon:'barrier',  img:'/images/skill/mbarier.png',   cd:18, desc:'Защита +50% на 3 сек'           },
    { key:'R', name:'Телепорт',     icon:'teleport', img:'/images/skill/mteleport.png', cd:12, desc:'Рывок 180px по направлению'     },
  ],
  warlock: [
    { key:'Q', name:'Тёмное исцеление', icon:'hpPlus',  img:'/images/skill/sheal.png',        cd:8,  desc:'+20% maxHP'                    },
    { key:'W', name:'Оковы тьмы',       icon:'iceNova', img:'/images/skill/socepinenie.png',  cd:15, desc:'Удерживает цель на месте 3 сек'},
    { key:'E', name:'Тёмный щит',       icon:'barrier', img:'/images/skill/sshit.png',        cd:18, desc:'+50% защита себе и пати 4 сек' },
    { key:'R', name:'Тёмная молитва',   icon:'hpPlus',  img:'/images/skill/spartyheal.png',   cd:25, desc:'+10% maxHP себе и +10% пати'   },
  ],
};

// Bonus category for each skill key per class
// damage → +1% per level  |  buff → +1s duration  |  barrier → +0.2s  |  invis → +0.2s  |  heal → +1%  |  mobility → +10px range
const SKILL_BONUS_TYPE = {
  lev:         { Q: 'damage', W: 'damage', E: 'buff', R: 'damage'   },
  deathknight: { Q: 'buff',   W: 'damage', E: 'buff', R: 'damage'   },
  ranger:      { Q: 'damage', W: 'damage', E: 'buff', R: 'buff'     },
  mage:        { Q: 'damage', W: 'damage', E: 'buff', R: 'mobility' },
  warlock:     { Q: 'heal',   W: 'buff',   E: 'buff', R: 'heal'     },
};

const NPC_DEF = [
  { id:'merchant',   name:'Торговец',   icon:'merchant',   color:'#ffaa00', desc:'Зелья и расходники'          },
  { id:'craftsman',  name:'Кузнец',     icon:'craftsman',  color:'#8888ff', desc:'Крафт предметов'             },
  { id:'storage',    name:'Хранилище', icon:'storage',    color:'#44ff44', desc:'Хранение предметов (200 ячеек)' },
];

const MERCHANT_SHOP = [
  { itemId:'pt1',       name:'Малое зелье',     img:'/images/potion/smallhp.png', price:5,    desc:'HP +20'                    },
  { itemId:'pt2',       name:'Большое зелье',   img:'/images/potion/bighp.png',   price:30,   desc:'HP +50'                    },
];

// Crafting recipes: uncommon+ = 2× same-type lower tier at +8 + 1 recipe scroll
// Stone recipes: recipe scrolls + gold → enchant stone
// Epic (*4) and legendary (*5) tiers are defined in shared/definitions.js
// (GEAR_CRAFT_RECIPES) instead, and appended below — they additionally cost
// Liberty, which is server-authoritative, so the server needs its own copy
// of that recipe to charge against.
const ITEM_CRAFT_RECIPES = [
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
  // ── Cloaks ───────────────────────────────────────────────
  { itemId:'cl2', mats:[{id:'cl1',n:2,minEnhance:8},{id:'recu',n:1}],  chance:0.80 },
  { itemId:'cl3', mats:[{id:'cl2',n:2,minEnhance:8},{id:'recr',n:5}],  chance:0.80 },
  // ── Artifacts ────────────────────────────────────────────
  { itemId:'af2', mats:[{id:'af1',n:2,minEnhance:8},{id:'recu',n:1}],  chance:0.80 },
  { itemId:'af3', mats:[{id:'af2',n:2,minEnhance:8},{id:'recr',n:5}],  chance:0.80 },
];

// Enchant stones and epic/legendary gear are defined in shared/definitions.js
// instead — they cost Liberty, which only the server can spend, so both sides
// have to read one copy of the recipe. Appended here so the craftsman's tabs
// keep listing them with everything else (filtered on rec.matId/rec.itemId).
if (typeof STONE_CRAFT_RECIPES !== 'undefined') ITEM_CRAFT_RECIPES.push(...STONE_CRAFT_RECIPES);
if (typeof GEAR_CRAFT_RECIPES !== 'undefined') ITEM_CRAFT_RECIPES.push(...GEAR_CRAFT_RECIPES);

// Recipe upgrade: 20 of lower rarity → 1 of higher rarity (80% chance)
const MAT_UPGRADE_RECIPES = [
  { from:'recu', to:'recr', count:20, chance:0.80 },
  { from:'recr', to:'rece', count:20, chance:0.80 },
  { from:'rece', to:'recl', count:20, chance:0.80 },
];

// Battle Power — reflects the player's overall combat strength.
// Keep in sync with the identical calcBM in server/index.js, which stores this
// for the rating and reports it in raid/party-dungeon lobbies. The level field
// is `lvl` on both the live player object and save blobs; reading `p.level`
// matched nothing, so the level term silently collapsed to its `|| 1` fallback
// and BM ignored levels entirely.
function calcBM(p) {
  if (!p) return 0;
  const upg = p.upgrades || {};
  const extras = ((upg.critChance || 0) + (upg.critPower || 0) +
    (upg.hpRegen || 0) + (upg.atkSpeed || 0)) * 8;
  return Math.round((p.lvl || p.level || 1) * 50 + (p.atk || 0) * 5 + (p.def || 0) * 3 + (p.maxHp || 100) * 0.5 + extras);
}
