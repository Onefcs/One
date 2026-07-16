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
];

const ITEM_DEF = [
  // ── Weapons ──────────────────────────────────────────────
  { id:'sw1', name:'Ржавый меч',        slot:'weapon',  icon:'sword',   atk:6,         rarity:'common'   },
  { id:'sw2', name:'Стальной меч',      slot:'weapon',  icon:'sword',   atk:14,        rarity:'uncommon' },
  { id:'sw3', name:'Меч дракона',       slot:'weapon',  icon:'sword',   atk:28,        rarity:'rare'     },
  { id:'sw4', name:'Клинок теней',      slot:'weapon',  icon:'sword',   atk:44,        rarity:'epic'     },
  { id:'sw5', name:'Экскалибур',        slot:'weapon',  icon:'sword',   atk:65,        rarity:'legendary'},
  { id:'bw1', name:'Деревянный лук',    slot:'weapon',  icon:'bow',     atk:5,         rarity:'common'   },
  { id:'bw2', name:'Серебряный лук',    slot:'weapon',  icon:'bow',     atk:13,        rarity:'uncommon' },
  { id:'bw3', name:'Лук охотника',      slot:'weapon',  icon:'bow',     atk:25,        rarity:'rare'     },
  { id:'bw4', name:'Лунный лук',        slot:'weapon',  icon:'bow',     atk:40,        rarity:'epic'     },
  { id:'st1', name:'Посох мага',        slot:'weapon',  icon:'staff',   atk:7,         rarity:'common'   },
  { id:'st2', name:'Огненный посох',    slot:'weapon',  icon:'staff',   atk:18,        rarity:'uncommon' },
  { id:'st3', name:'Посох Анубара',     slot:'weapon',  icon:'staff',   atk:32,        rarity:'rare'     },
  { id:'st4', name:'Посох Вечности',    slot:'weapon',  icon:'staff',   atk:52,        rarity:'epic'     },
  { id:'st5', name:'Скипетр богов',     slot:'weapon',  icon:'staff',   atk:72,        rarity:'legendary'},
  // ── Offhand ───────────────────────────────────────────────
  { id:'oh1', name:'Деревянный щит',    slot:'offhand', icon:'offhand', def:4,         rarity:'common'   },
  { id:'oh2', name:'Кожаный щит',       slot:'offhand', icon:'offhand', def:8,         rarity:'uncommon' },
  { id:'oh3', name:'Стальной щит',      slot:'offhand', icon:'offhand', def:16,        rarity:'rare'     },
  { id:'oh4', name:'Щит паладина',      slot:'offhand', icon:'offhand', def:26,hp:30,  rarity:'epic'     },
  { id:'oh5', name:'Щит легенды',       slot:'offhand', icon:'offhand', def:38,hp:60,  rarity:'legendary'},
  // ── Helmet ────────────────────────────────────────────────
  { id:'hm1', name:'Кожаный шлем',      slot:'helmet',  icon:'helmet',  hp:25,         rarity:'common'   },
  { id:'hm2', name:'Железный шлем',     slot:'helmet',  icon:'helmet',  hp:50,         rarity:'uncommon' },
  { id:'hm3', name:'Шлем дракона',      slot:'helmet',  icon:'helmet',  hp:90,atk:4,   rarity:'rare'     },
  { id:'hm4', name:'Корона воина',      slot:'helmet',  icon:'helmet',  hp:140,atk:8,  rarity:'epic'     },
  { id:'hm5', name:'Шлем легенды',      slot:'helmet',  icon:'helmet',  hp:210,atk:12, rarity:'legendary'},
  // ── Body ─────────────────────────────────────────────────
  { id:'ar1', name:'Кожаная броня',     slot:'body',    icon:'body',    def:5,         rarity:'common'   },
  { id:'ar2', name:'Кольчуга',          slot:'body',    icon:'body',    def:11,        rarity:'uncommon' },
  { id:'ar3', name:'Латы',              slot:'body',    icon:'body',    def:20,        rarity:'rare'     },
  { id:'ar4', name:'Броня теней',       slot:'body',    icon:'body',    def:33,        rarity:'epic'     },
  { id:'ar5', name:'Доспех легенды',    slot:'body',    icon:'body',    def:48,hp:50,  rarity:'legendary'},
  // ── Legs ─────────────────────────────────────────────────
  { id:'lg1', name:'Кожаные штаны',     slot:'legs',    icon:'legs',    def:3,         rarity:'common'   },
  { id:'lg2', name:'Кольчужные штаны',  slot:'legs',    icon:'legs',    def:7,         rarity:'uncommon' },
  { id:'lg3', name:'Латные поножи',     slot:'legs',    icon:'legs',    def:14,        rarity:'rare'     },
  { id:'lg4', name:'Поножи теней',      slot:'legs',    icon:'legs',    def:22,        rarity:'epic'     },
  // ── Gloves ───────────────────────────────────────────────
  { id:'gl1', name:'Кожаные перчи',     slot:'gloves',  icon:'gloves',  atk:2,         rarity:'common'   },
  { id:'gl2', name:'Боевые перчи',      slot:'gloves',  icon:'gloves',  atk:5,         rarity:'uncommon' },
  { id:'gl3', name:'Перчи силы',        slot:'gloves',  icon:'gloves',  atk:10,        rarity:'rare'     },
  { id:'gl4', name:'Перчи мастера',     slot:'gloves',  icon:'gloves',  atk:16,def:4,  rarity:'epic'     },
  // ── Boots ────────────────────────────────────────────────
  { id:'bt1', name:'Кожаные боты',      slot:'boots',   icon:'boots',   def:2,         rarity:'common'   },
  { id:'bt2', name:'Скоростные боты',   slot:'boots',   icon:'boots',   def:4,         rarity:'uncommon' },
  { id:'bt3', name:'Боты ветра',        slot:'boots',   icon:'boots',   def:8,atk:3,   rarity:'rare'     },
  { id:'bt4', name:'Боты теней',        slot:'boots',   icon:'boots',   def:14,atk:5,  rarity:'epic'     },
  // ── Ring ─────────────────────────────────────────────────
  { id:'rn1', name:'Кольцо силы',       slot:'ring',    icon:'ring',    atk:4,         rarity:'uncommon' },
  { id:'rn2', name:'Кольцо защиты',     slot:'ring',    icon:'ring',    def:4,         rarity:'uncommon' },
  { id:'rn3', name:'Кольцо крови',      slot:'ring',    icon:'ring',    hp:40,atk:3,   rarity:'rare'     },
  { id:'rn4', name:'Кольцо мастера',    slot:'ring',    icon:'ring',    atk:8,def:4,   rarity:'epic'     },
  { id:'rn5', name:'Кольцо богов',      slot:'ring',    icon:'ring',    atk:14,def:8,hp:50, rarity:'legendary'},
  // ── Belt ─────────────────────────────────────────────────
  { id:'bl1', name:'Кожаный пояс',      slot:'belt',    icon:'belt',    hp:20,         rarity:'common'   },
  { id:'bl2', name:'Пояс воина',        slot:'belt',    icon:'belt',    hp:45,atk:3,   rarity:'uncommon' },
  { id:'bl3', name:'Пояс силы',         slot:'belt',    icon:'belt',    hp:75,atk:6,   rarity:'rare'     },
  { id:'bl4', name:'Пояс легенды',      slot:'belt',    icon:'belt',    hp:120,atk:10, rarity:'epic'     },
  // ── Pendant ──────────────────────────────────────────────
  { id:'nd1', name:'Амулет силы',       slot:'pendant', icon:'pendant', atk:5,         rarity:'uncommon' },
  { id:'nd2', name:'Амулет здоровья',   slot:'pendant', icon:'pendant', hp:60,         rarity:'uncommon' },
  { id:'nd3', name:'Амулет тьмы',       slot:'pendant', icon:'pendant', atk:8,hp:30,   rarity:'rare'     },
  { id:'nd4', name:'Амулет легенды',    slot:'pendant', icon:'pendant', atk:16,hp:80,  rarity:'epic'     },
  { id:'nd5', name:'Амулет богов',      slot:'pendant', icon:'pendant', atk:24,hp:120, rarity:'legendary'},
  // ── Potions (use-type, don't take inv slot) ───────────────
  { id:'pt1', name:'Зелье лечения',     slot:'use',     icon:'potion',  hp:60,         rarity:'common'   },
  { id:'pt2', name:'Большое зелье',     slot:'use',     icon:'potion',  hp:120,        rarity:'uncommon' },
];

const EQ_SLOTS = [
  { slot:'weapon',  label:'Оружие',   emptyIcon:'weapon'  },
  { slot:'offhand', label:'Щит',      emptyIcon:'offhand' },
  { slot:'helmet',  label:'Шлем',     emptyIcon:'helmet'  },
  { slot:'body',    label:'Тело',     emptyIcon:'body'    },
  { slot:'legs',    label:'Низ',      emptyIcon:'legs'    },
  { slot:'gloves',  label:'Перчи',    emptyIcon:'gloves'  },
  { slot:'boots',   label:'Боты',     emptyIcon:'boots'   },
  { slot:'ring',    label:'Кольцо',   emptyIcon:'ring'    },
  { slot:'belt',    label:'Пояс',     emptyIcon:'belt'    },
  { slot:'pendant', label:'Ожерелье', emptyIcon:'pendant' },
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
  { itemId:'sw1', price:20  }, { itemId:'bw1', price:20  }, { itemId:'st1', price:20  },
  { itemId:'ar1', price:20  }, { itemId:'hm1', price:20  },
  { itemId:'sw2', price:60  }, { itemId:'bw2', price:60  }, { itemId:'st2', price:60  },
  { itemId:'ar2', price:60  }, { itemId:'hm2', price:60  }, { itemId:'oh2', price:60  },
  { itemId:'rn1', price:80  }, { itemId:'rn2', price:80  }, { itemId:'nd1', price:80  },
  { itemId:'sw3', price:160 }, { itemId:'ar3', price:160 }, { itemId:'hm3', price:160 },
];

const CRAFT_RECIPES = [
  { name:'Стальной меч',  resultId:'sw2', mats:[{id:'mat_iron',n:3}],                          gold:50  },
  { name:'Кольчуга',      resultId:'ar2', mats:[{id:'mat_iron',n:2},{id:'mat_leather',n:2}],   gold:80  },
  { name:'Кожаный щит',   resultId:'oh2', mats:[{id:'mat_iron',n:2},{id:'mat_leather',n:1}],   gold:50  },
  { name:'Шлем железный', resultId:'hm2', mats:[{id:'mat_iron',n:2}],                          gold:40  },
  { name:'Кольцо силы',   resultId:'rn1', mats:[{id:'mat_gem',n:1}],                           gold:100 },
  { name:'Меч дракона',   resultId:'sw3', mats:[{id:'mat_scale',n:2},{id:'mat_iron',n:3}],     gold:200 },
  { name:'Посох Анубара',  resultId:'st3', mats:[{id:'mat_scale',n:2},{id:'mat_dust',n:3}],    gold:200 },
  { name:'Амулет тьмы',   resultId:'nd3', mats:[{id:'mat_gem',n:2},{id:'mat_dust',n:2}],       gold:150 },
];
