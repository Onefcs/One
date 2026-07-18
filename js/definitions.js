// CHAR_DEF, ENEMY_DEF, TILE, WALL, FLOOR → shared/definitions.js

const UPGRADE_DEF = {
  atk:        { label:'Атака',       icon:'sword',      baseCost:30,  desc:'+3 ATK'       },
  def:        { label:'Защита',      icon:'shield',     baseCost:30,  desc:'+2 DEF'       },
  hp:         { label:'Здоровье',    icon:'heart',      baseCost:25,  desc:'+25 MaxHP'    },
  atkSpeed:   { label:'Скор. атаки', icon:'lightning',  baseCost:50,  desc:'+0.05 уд/с'  },
  critChance: { label:'Шанс крита',  icon:'star',       baseCost:60,  desc:'+2.5%'        },
  critPower:  { label:'Сила крита',  icon:'flame',      baseCost:60,  desc:'+15%'         },
  dodge:      { label:'Уворот',      icon:'wind',       baseCost:80,  desc:'+2.5%'        },
  accuracy:   { label:'Точность',    icon:'crosshair',  baseCost:50,  desc:'+2%'          },
  lifeSteal:  { label:'Вампиризм',   icon:'drop',       baseCost:100, desc:'+2.5%'        },
  hpRegen:    { label:'Реген HP',    icon:'hpPlus',     baseCost:80,  desc:'+0.5/сек'     },
};

const QUEST_DEF = [
  { id:'q1',  title:'Охота на грибы',   desc:'Убей 8 грибов',                    type:'kill',       enemies:['Гриб'],            count:8,  reward:{ xp:80,   gold:40  } },
  { id:'q2',  title:'Слизнеед',         desc:'Убей 8 слизней',                   type:'kill',       enemies:['Слизень'],         count:8,  reward:{ xp:100,  gold:50  } },
  { id:'q3',  title:'Паукобой',         desc:'Убей 8 пауков',                    type:'kill',       enemies:['Паук'],            count:8,  reward:{ xp:130,  gold:65  } },
  { id:'q4',  title:'Гоблинский налёт', desc:'Убей 12 гоблинов',                 type:'kill',       enemies:['Гоблин'],          count:12, reward:{ xp:180,  gold:90  } },
  { id:'q5',  title:'Костяная стража',  desc:'Убей 10 скелетов',                 type:'kill',       enemies:['Скелет'],          count:10, reward:{ xp:240,  gold:120 } },
  { id:'q6',  title:'Двойная угроза',   desc:'Убей 8 гоблинов и 8 скелетов',    type:'kill_multi', enemies:['Гоблин','Скелет'], count:8,  reward:{ xp:320,  gold:160 } },
  { id:'q7',  title:'Охота на орков',   desc:'Убей 6 орков',                     type:'kill',       enemies:['Орк'],             count:6,  reward:{ xp:400,  gold:200 } },
  { id:'q8',  title:'Тролли у ворот',   desc:'Убей 4 тролля',                    type:'kill',       enemies:['Тролль'],          count:4,  reward:{ xp:500,  gold:250 } },
  { id:'q9',  title:'Истребитель орд',  desc:'Убей 5 орков и 5 троллей',         type:'kill_multi', enemies:['Орк','Тролль'],    count:5,  reward:{ xp:650,  gold:320 } },
  { id:'q10', title:'Победи Демона',    desc:'Убей демона-босса подземелья',     type:'kill',       enemies:['ДЕМОН'],           count:1,  reward:{ xp:1200, gold:700 } },
];

const RARITY_COLOR = {
  common:    '#aaa',
  uncommon:  '#4af',
  rare:      '#fa4',
  epic:      '#c55ef5',
  legendary: '#ff8c00',
};

const CRAFT_MATS = [
  { id:'mat_iron',    name:'Железный слиток', icon:'mat_iron',    slot:'material', rarity:'common'   },
  { id:'mat_leather', name:'Кожа',            icon:'mat_leather', slot:'material', rarity:'common'   },
  { id:'mat_gem',     name:'Самоцвет',        icon:'mat_gem',     slot:'material', rarity:'uncommon' },
  { id:'mat_scale',   name:'Чешуя дракона',   icon:'mat_scale',   slot:'material', rarity:'rare'     },
  { id:'mat_dust',    name:'Магич. пыль',     icon:'mat_dust',    slot:'material', rarity:'uncommon' },
  { id:'boss_stone',  name:'Камень Босса',    icon:'mat_gem',     slot:'material', rarity:'uncommon' },
];

const ITEM_DEF = [
  // ── Assassin knives ───────────────────────────────────────
  { id:'sw1', name:'Ржавый нож',       slot:'weapon', img:'/images/wep/ck.png', atk:4,                            rarity:'common'   },
  { id:'sw2', name:'Стальной нож',     slot:'weapon', img:'/images/wep/uk.png', atk:14,                           rarity:'uncommon' },
  { id:'sw3', name:'Нож дракона',      slot:'weapon', img:'/images/wep/rk.png', atk:23, critChance:0.05,          rarity:'rare'     },
  { id:'sw4', name:'Нож теней',        slot:'weapon', img:'/images/wep/ek.png', atk:44, critChance:0.10,          rarity:'epic'     },
  { id:'sw5', name:'Нож героя',        slot:'weapon', img:'/images/wep/lk.png', atk:65, critChance:0.25, lifeSteal:0.05, rarity:'legendary'},
  // ── Warrior axes ─────────────────────────────────────────
  { id:'tw1', name:'Ржавый топор',     slot:'weapon', img:'/images/wep/ct.png', atk:5,                            rarity:'common'   },
  { id:'tw2', name:'Стальной топор',   slot:'weapon', img:'/images/wep/ut.png', atk:15,                           rarity:'uncommon' },
  { id:'tw3', name:'Топор дракона',    slot:'weapon', img:'/images/wep/rt.png', atk:23, lifeSteal:0.02,           rarity:'rare'     },
  { id:'tw4', name:'Топор теней',      slot:'weapon', img:'/images/wep/et.png', atk:44, lifeSteal:0.05,           rarity:'epic'     },
  { id:'tw5', name:'Топор героя',      slot:'weapon', img:'/images/wep/lt.png', atk:65, lifeSteal:0.08,           rarity:'legendary'},
  // ── Archer bows ──────────────────────────────────────────
  { id:'bw1', name:'Деревянный лук',   slot:'weapon', img:'/images/wep/cb.png', atk:8,                            rarity:'common'   },
  { id:'bw2', name:'Серебряный лук',   slot:'weapon', img:'/images/wep/ub.png', atk:18, atkSpeed:0.03,            rarity:'uncommon' },
  { id:'bw3', name:'Лук охотника',     slot:'weapon', img:'/images/wep/rb.png', atk:28, atkSpeed:0.05,            rarity:'rare'     },
  { id:'bw4', name:'Лунный лук',       slot:'weapon', img:'/images/wep/eb.png', atk:60, atkSpeed:0.10,            rarity:'epic'     },
  { id:'bw5', name:'Лук героя',        slot:'weapon', img:'/images/wep/lb.png', atk:100, atkSpeed:0.15, critChance:0.10, rarity:'legendary'},
  // ── Mage / Priest staves ─────────────────────────────────
  { id:'st1', name:'Посох новичка',    slot:'weapon', img:'/images/wep/cs.png', atk:7,                            rarity:'common'   },
  { id:'st2', name:'Посох бойца',      slot:'weapon', img:'/images/wep/us.png', atk:17,                           rarity:'uncommon' },
  { id:'st3', name:'Посох охотника',   slot:'weapon', img:'/images/wep/rs.png', atk:30, hpPct:0.05,               rarity:'rare'     },
  { id:'st4', name:'Посох Героя',      slot:'weapon', img:'/images/wep/es.png', atk:60, hpPct:0.10,               rarity:'epic'     },
  { id:'st5', name:'Посох Легенды',    slot:'weapon', img:'/images/wep/ls.png', atk:120, hpPct:0.20, critChance:0.10, rarity:'legendary'},
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
  // ── Potions ───────────────────────────────────────────────
  { id:'pt1', name:'Зелье лечения',    slot:'use',    icon:'potion',             hp:60,           rarity:'common'   },
  { id:'pt2', name:'Большое зелье',    slot:'use',    icon:'potion',             hp:120,          rarity:'uncommon' },
];

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
    { key:'Q', name:'Щит-удар',    icon:'shieldBash', cd:8,  desc:'Оглушает врагов рядом'   },
    { key:'W', name:'Вихрь',       icon:'whirlwind',  cd:12, desc:'Удар по всем вокруг'     },
    { key:'E', name:'Боевой клич', icon:'battleCry',  cd:20, desc:'+50% ATK на 5 секунд'    },
    { key:'R', name:'Рывок',       icon:'dash',       cd:15, desc:'Прорыв через врагов'      },
  ],
  archer: [
    { key:'Q', name:'Мульти-выстрел', icon:'multiShot',   cd:6,  desc:'3 стрелы веером'          },
    { key:'W', name:'Яд. стрела',     icon:'poisonArrow', cd:10, desc:'Урон ядом со временем'    },
    { key:'E', name:'Кувырок',        icon:'roll',        cd:8,  desc:'Уклонение с ускорением'   },
    { key:'R', name:'Дождь стрел',    icon:'arrowRain',   cd:20, desc:'Ливень стрел по области'  },
  ],
  mage: [
    { key:'Q', name:'Огненный шар', icon:'fireball', cd:5,  desc:'Мощный огненный снаряд'  },
    { key:'W', name:'Ледяная нова', icon:'iceNova',  cd:10, desc:'Замедляет и ранит врагов' },
    { key:'E', name:'Барьер',       icon:'barrier',  cd:18, desc:'Щит на 4 секунды'         },
    { key:'R', name:'Телепорт',     icon:'teleport', cd:12, desc:'Мгновенный прыжок'        },
  ],
  priest: [
    { key:'Q', name:'Исцеление',   icon:'heal',      cd:8,  desc:'Восстанавливает HP'       },
    { key:'W', name:'Святой свет', icon:'holyLight', cd:6,  desc:'Урон нежити вокруг'       },
    { key:'E', name:'Щит веры',    icon:'barrier',   cd:18, desc:'Снижает урон на 4 сек'    },
    { key:'R', name:'Молитва',     icon:'prayer',    cd:25, desc:'Исцеляет всю группу'      },
  ],
  assasin: [
    { key:'Q', name:'Удар тени',   icon:'shadowStrike', cd:5,  desc:'Рывок + удар ×1.5'    },
    { key:'W', name:'Дым. шашка',  icon:'smokeBomb',    cd:12, desc:'Замедляет врагов'      },
    { key:'E', name:'Уклон',       icon:'roll',         cd:8,  desc:'Быстрое уклонение'     },
    { key:'R', name:'Смерть. удар',icon:'deathStrike',  cd:25, desc:'×3 ATK по цели'        },
  ],
};

const NPC_DEF = [
  { id:'merchant',   name:'Торговец', icon:'merchant',   color:'#ffaa00', desc:'Зелья и расходники' },
  { id:'craftsman',  name:'Кузнец',   icon:'craftsman',  color:'#8888ff', desc:'Крафт предметов'    },
  { id:'shopkeeper', name:'Лавочник', icon:'shopkeeper', color:'#44ff44', desc:'Снаряжение'         },
];

const MERCHANT_SHOP = [
  { itemId:'pt1', name:'Зелье лечения', icon:'potion', price:30,  desc:'HP +60'  },
  { itemId:'pt2', name:'Большое зелье', icon:'potion', price:80,  desc:'HP +120' },
];

const SHOP_CATALOG = [
  // Common
  { itemId:'sw1', price:20 }, { itemId:'tw1', price:20 }, { itemId:'bw1', price:20 }, { itemId:'st1', price:20 },
  { itemId:'hm1', price:20 }, { itemId:'ar1', price:20 }, { itemId:'gl1', price:20 }, { itemId:'bt1', price:20 },
  { itemId:'rn1', price:30 }, { itemId:'nd1', price:30 },
  // Uncommon
  { itemId:'sw2', price:60 }, { itemId:'tw2', price:60 }, { itemId:'bw2', price:60 }, { itemId:'st2', price:60 },
  { itemId:'hm2', price:60 }, { itemId:'ar2', price:60 }, { itemId:'gl2', price:60 }, { itemId:'bt2', price:60 },
  { itemId:'rn2', price:80 }, { itemId:'nd2', price:80 },
  // Rare
  { itemId:'sw3', price:160 }, { itemId:'tw3', price:160 }, { itemId:'bw3', price:160 }, { itemId:'st3', price:160 },
  { itemId:'hm3', price:160 }, { itemId:'ar3', price:160 },
];

const CRAFT_RECIPES = [
  // ── Uncommon ─────────────────────────────────────────────
  { name:'Стальной нож',   resultId:'sw2', mats:[{id:'mat_iron',n:3},{id:'boss_stone',n:20}],                        gold:50  },
  { name:'Стальной топор', resultId:'tw2', mats:[{id:'mat_iron',n:3},{id:'boss_stone',n:20}],                        gold:50  },
  { name:'Серебряный лук', resultId:'bw2', mats:[{id:'mat_iron',n:2},{id:'mat_leather',n:2},{id:'boss_stone',n:20}], gold:60  },
  { name:'Посох бойца',    resultId:'st2', mats:[{id:'mat_iron',n:2},{id:'mat_dust',n:1},{id:'boss_stone',n:20}],    gold:60  },
  { name:'Железный шлем',  resultId:'hm2', mats:[{id:'mat_iron',n:2},{id:'boss_stone',n:20}],                        gold:40  },
  { name:'Железная броня', resultId:'ar2', mats:[{id:'mat_iron',n:3},{id:'mat_leather',n:2},{id:'boss_stone',n:20}], gold:80  },
  { name:'Кольцо силы',    resultId:'rn1', mats:[{id:'mat_gem',n:1},{id:'boss_stone',n:20}],                         gold:100 },
  // ── Rare (boss_stone ×60) ────────────────────────────────
  { name:'Нож дракона',      resultId:'sw3', mats:[{id:'mat_scale',n:2},{id:'mat_iron',n:3},{id:'boss_stone',n:60}],  gold:200 },
  { name:'Топор дракона',    resultId:'tw3', mats:[{id:'mat_scale',n:2},{id:'mat_iron',n:3},{id:'boss_stone',n:60}],  gold:200 },
  { name:'Лук охотника',     resultId:'bw3', mats:[{id:'mat_scale',n:2},{id:'mat_leather',n:3},{id:'boss_stone',n:60}],gold:200},
  { name:'Посох охотника',   resultId:'st3', mats:[{id:'mat_scale',n:2},{id:'mat_dust',n:3},{id:'boss_stone',n:60}],  gold:200 },
  { name:'Пояс тьмы',        resultId:'nd3', mats:[{id:'mat_gem',n:2},{id:'mat_dust',n:2},{id:'boss_stone',n:60}],   gold:150 },
  { name:'Кольцо крови',     resultId:'rn3', mats:[{id:'mat_gem',n:2},{id:'boss_stone',n:60}],                        gold:150 },
  // ── Epic (boss_stone ×100) ───────────────────────────────
  { name:'Нож теней',       resultId:'sw4', mats:[{id:'mat_scale',n:3},{id:'mat_dust',n:3},{id:'boss_stone',n:100}], gold:500 },
  { name:'Топор теней',     resultId:'tw4', mats:[{id:'mat_scale',n:3},{id:'mat_dust',n:3},{id:'boss_stone',n:100}], gold:500 },
  { name:'Лунный лук',      resultId:'bw4', mats:[{id:'mat_scale',n:3},{id:'mat_leather',n:3},{id:'boss_stone',n:100}],gold:500},
  { name:'Посох Героя',     resultId:'st4', mats:[{id:'mat_scale',n:3},{id:'mat_dust',n:4},{id:'boss_stone',n:100}], gold:500 },
  { name:'Корона героя',    resultId:'hm4', mats:[{id:'mat_scale',n:2},{id:'mat_gem',n:2},{id:'boss_stone',n:100}],  gold:400 },
  { name:'Доспех героя',    resultId:'ar4', mats:[{id:'mat_scale',n:3},{id:'mat_leather',n:3},{id:'boss_stone',n:100}],gold:500},
  { name:'Перчатки героя',  resultId:'gl4', mats:[{id:'mat_scale',n:2},{id:'mat_leather',n:1},{id:'boss_stone',n:100}],gold:350},
  { name:'Боты героя',      resultId:'bt4', mats:[{id:'mat_scale',n:2},{id:'mat_leather',n:2},{id:'boss_stone',n:100}],gold:350},
  { name:'Кольцо героя',    resultId:'rn4', mats:[{id:'mat_gem',n:3},{id:'mat_dust',n:2},{id:'boss_stone',n:100}],   gold:400 },
  { name:'Пояс героя',      resultId:'nd4', mats:[{id:'mat_gem',n:3},{id:'mat_dust',n:3},{id:'boss_stone',n:100}],   gold:400 },
  // ── Legendary (boss_stone ×300) ──────────────────────────
  { name:'Нож героя',        resultId:'sw5', mats:[{id:'mat_scale',n:5},{id:'mat_dust',n:5},{id:'boss_stone',n:300}], gold:1500},
  { name:'Топор героя',      resultId:'tw5', mats:[{id:'mat_scale',n:5},{id:'mat_dust',n:5},{id:'boss_stone',n:300}], gold:1500},
  { name:'Лук героя',        resultId:'bw5', mats:[{id:'mat_scale',n:5},{id:'mat_leather',n:4},{id:'boss_stone',n:300}],gold:1500},
  { name:'Посох Легенды',    resultId:'st5', mats:[{id:'mat_scale',n:5},{id:'mat_dust',n:6},{id:'boss_stone',n:300}], gold:1500},
  { name:'Шлем легенды',     resultId:'hm5', mats:[{id:'mat_scale',n:4},{id:'mat_gem',n:3},{id:'boss_stone',n:300}],  gold:1200},
  { name:'Доспех легенды',   resultId:'ar5', mats:[{id:'mat_scale',n:5},{id:'mat_leather',n:4},{id:'boss_stone',n:300}],gold:1500},
  { name:'Перчатки легенды', resultId:'gl5', mats:[{id:'mat_scale',n:3},{id:'mat_gem',n:2},{id:'boss_stone',n:300}],  gold:1200},
  { name:'Боты легенды',     resultId:'bt5', mats:[{id:'mat_scale',n:3},{id:'mat_leather',n:3},{id:'boss_stone',n:300}],gold:1200},
  { name:'Кольцо легенды',   resultId:'rn5', mats:[{id:'mat_gem',n:5},{id:'mat_dust',n:4},{id:'boss_stone',n:300}],   gold:1500},
  { name:'Пояс легенды',     resultId:'nd5', mats:[{id:'mat_gem',n:5},{id:'mat_dust',n:5},{id:'boss_stone',n:300}],   gold:1500},
];
