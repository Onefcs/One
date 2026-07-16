const CHAR_DEF = {
  warrior: { name:'Воин',   emoji:'🗡️', color:'#55aaff', baseHP:200, baseAtk:25, baseDef:10, speed:145, atkRange:58,  atkSpeed:1.2,  atkType:'melee' },
  archer:  { name:'Лучник', emoji:'🏹', color:'#77ee77', baseHP:140, baseAtk:20, baseDef:5,  speed:175, atkRange:210, atkSpeed:1.6,  atkType:'ranged', projColor:'#ffaa00' },
  mage:    { name:'Маг',    emoji:'🔮', color:'#ee88ee', baseHP:110, baseAtk:38, baseDef:3,  speed:155, atkRange:180, atkSpeed:0.85, atkType:'ranged', projColor:'#cc88ff' },
};

const ENEMY_DEF = [
  { eid:'mushroom', name:'Гриб',    color:'#cc6633', size:13, hp:30,  atk:6,  def:1,  spd:65,  xp:12,  gold:[1,4],   isBoss:false },
  { eid:'slime',    name:'Слизень', color:'#44cc44', size:12, hp:35,  atk:7,  def:0,  spd:55,  xp:14,  gold:[1,4],   isBoss:false },
  { eid:'spider',   name:'Паук',    color:'#332255', size:14, hp:50,  atk:10, def:2,  spd:110, xp:20,  gold:[2,7],   isBoss:false },
  { eid:'goblin',   name:'Гоблин',  color:'#3a3',    size:14, hp:40,  atk:8,  def:2,  spd:92,  xp:15,  gold:[1,5],   isBoss:false },
  { eid:'skeleton', name:'Скелет',  color:'#bbb',    size:16, hp:70,  atk:14, def:4,  spd:70,  xp:25,  gold:[3,9],   isBoss:false },
  { eid:'orc',      name:'Орк',     color:'#964',    size:20, hp:130, atk:20, def:8,  spd:56,  xp:40,  gold:[6,16],  isBoss:false },
  { eid:'troll',    name:'Тролль',  color:'#575',    size:24, hp:230, atk:28, def:12, spd:40,  xp:65,  gold:[10,22], isBoss:false },
  { eid:'demon',    name:'ДЕМОН',   color:'#f33',    size:28, hp:420, atk:42, def:16, spd:60,  xp:130, gold:[25,55], isBoss:true  },
];

const QUEST_DEF = [
  { id:'q1',  title:'Грибная охота',      desc:'Убей 10 грибов',                 type:'kill',       enemies:['Гриб'],           count:10, reward:{ xp:80,  gold:40  } },
  { id:'q2',  title:'Первый уровень',     desc:'Достигни 3-го уровня',           type:'level',      level:3,                              reward:{ xp:0,   gold:60  } },
  { id:'q3',  title:'Запас зелий',        desc:'Купи зелье у Торговца',          type:'buy_potion', count:1,                              reward:{ xp:50,  gold:30  } },
  { id:'q4',  title:'Охота на гоблинов',  desc:'Убей 15 гоблинов',               type:'kill',       enemies:['Гоблин'],         count:15, reward:{ xp:120, gold:80  } },
  { id:'q5',  title:'Ветеран',            desc:'Достигни 5-го уровня',           type:'level',      level:5,                              reward:{ xp:0,   gold:120 } },
  { id:'q6',  title:'Двойная охота',      desc:'Убей 10 грибов и 10 слизней',   type:'kill_multi', enemies:['Гриб','Слизень'], count:10, reward:{ xp:180, gold:100 } },
  { id:'q7',  title:'Слизнеед',           desc:'Убей 20 слизней',                type:'kill',       enemies:['Слизень'],        count:20, reward:{ xp:220, gold:130 } },
  { id:'q8',  title:'Паукобой',           desc:'Убей 15 пауков',                 type:'kill',       enemies:['Паук'],           count:15, reward:{ xp:260, gold:150 } },
  { id:'q9',  title:'Мастер подземелья',  desc:'Достигни 8-го уровня',           type:'level',      level:8,                              reward:{ xp:0,   gold:200 } },
  { id:'q10', title:'Кузнечное ремесло',  desc:'Скрафти любое оружие у Кузнеца', type:'craft',                                            reward:{ xp:350, gold:250 } },
];

const RARITY_COLOR = {
  common:    '#aaa',
  uncommon:  '#4af',
  rare:      '#fa4',
  epic:      '#c55ef5',
  legendary: '#ff8c00',
};

const CRAFT_MATS = [
  { id:'mat_iron',    name:'Железный слиток', emoji:'🔩', slot:'material', rarity:'common'   },
  { id:'mat_leather', name:'Кожа',            emoji:'🟫', slot:'material', rarity:'common'   },
  { id:'mat_gem',     name:'Самоцвет',        emoji:'💎', slot:'material', rarity:'uncommon' },
  { id:'mat_scale',   name:'Чешуя дракона',  emoji:'🐉', slot:'material', rarity:'rare'     },
  { id:'mat_dust',    name:'Магич. пыль',     emoji:'✨', slot:'material', rarity:'uncommon' },
];

const ITEM_DEF = [
  // ── Weapons ──────────────────────────────────────────────
  { id:'sw1', name:'Ржавый меч',        slot:'weapon',  emoji:'🗡️', atk:6,         rarity:'common'   },
  { id:'sw2', name:'Стальной меч',      slot:'weapon',  emoji:'⚔️', atk:14,        rarity:'uncommon' },
  { id:'sw3', name:'Меч дракона',       slot:'weapon',  emoji:'🔥', atk:28,        rarity:'rare'     },
  { id:'sw4', name:'Клинок теней',      slot:'weapon',  emoji:'🌑', atk:44,        rarity:'epic'     },
  { id:'sw5', name:'Экскалибур',        slot:'weapon',  emoji:'⚡', atk:65,        rarity:'legendary'},
  { id:'bw1', name:'Деревянный лук',    slot:'weapon',  emoji:'🏹', atk:5,         rarity:'common'   },
  { id:'bw2', name:'Серебряный лук',    slot:'weapon',  emoji:'🏹', atk:13,        rarity:'uncommon' },
  { id:'bw3', name:'Лук охотника',      slot:'weapon',  emoji:'🎯', atk:25,        rarity:'rare'     },
  { id:'bw4', name:'Лунный лук',        slot:'weapon',  emoji:'🌙', atk:40,        rarity:'epic'     },
  { id:'st1', name:'Посох мага',        slot:'weapon',  emoji:'🪄', atk:7,         rarity:'common'   },
  { id:'st2', name:'Огненный посох',    slot:'weapon',  emoji:'🔮', atk:18,        rarity:'uncommon' },
  { id:'st3', name:'Посох Анубара',     slot:'weapon',  emoji:'💜', atk:32,        rarity:'rare'     },
  { id:'st4', name:'Посох Вечности',    slot:'weapon',  emoji:'🌟', atk:52,        rarity:'epic'     },
  { id:'st5', name:'Скипетр богов',     slot:'weapon',  emoji:'👑', atk:72,        rarity:'legendary'},
  // ── Offhand ───────────────────────────────────────────────
  { id:'oh1', name:'Деревянный щит',    slot:'offhand', emoji:'🪵', def:4,         rarity:'common'   },
  { id:'oh2', name:'Кожаный щит',       slot:'offhand', emoji:'🛡️', def:8,         rarity:'uncommon' },
  { id:'oh3', name:'Стальной щит',      slot:'offhand', emoji:'⚜️', def:16,        rarity:'rare'     },
  { id:'oh4', name:'Щит паладина',      slot:'offhand', emoji:'✝️', def:26,hp:30,  rarity:'epic'     },
  { id:'oh5', name:'Щит легенды',       slot:'offhand', emoji:'🌟', def:38,hp:60,  rarity:'legendary'},
  // ── Helmet ────────────────────────────────────────────────
  { id:'hm1', name:'Кожаный шлем',      slot:'helmet',  emoji:'⛑️', hp:25,         rarity:'common'   },
  { id:'hm2', name:'Железный шлем',     slot:'helmet',  emoji:'🪖', hp:50,         rarity:'uncommon' },
  { id:'hm3', name:'Шлем дракона',      slot:'helmet',  emoji:'🐉', hp:90,atk:4,   rarity:'rare'     },
  { id:'hm4', name:'Корона воина',      slot:'helmet',  emoji:'👑', hp:140,atk:8,  rarity:'epic'     },
  { id:'hm5', name:'Шлем легенды',      slot:'helmet',  emoji:'⭐', hp:210,atk:12, rarity:'legendary'},
  // ── Body ─────────────────────────────────────────────────
  { id:'ar1', name:'Кожаная броня',     slot:'body',    emoji:'🥋', def:5,         rarity:'common'   },
  { id:'ar2', name:'Кольчуга',          slot:'body',    emoji:'🛡️', def:11,        rarity:'uncommon' },
  { id:'ar3', name:'Латы',              slot:'body',    emoji:'⚜️', def:20,        rarity:'rare'     },
  { id:'ar4', name:'Броня теней',       slot:'body',    emoji:'🌑', def:33,        rarity:'epic'     },
  { id:'ar5', name:'Доспех легенды',    slot:'body',    emoji:'✨', def:48,hp:50,  rarity:'legendary'},
  // ── Legs ─────────────────────────────────────────────────
  { id:'lg1', name:'Кожаные штаны',     slot:'legs',    emoji:'👖', def:3,         rarity:'common'   },
  { id:'lg2', name:'Кольчужные штаны',  slot:'legs',    emoji:'🩱', def:7,         rarity:'uncommon' },
  { id:'lg3', name:'Латные поножи',     slot:'legs',    emoji:'🦵', def:14,        rarity:'rare'     },
  { id:'lg4', name:'Поножи теней',      slot:'legs',    emoji:'🌑', def:22,        rarity:'epic'     },
  // ── Gloves ───────────────────────────────────────────────
  { id:'gl1', name:'Кожаные перчи',     slot:'gloves',  emoji:'🧤', atk:2,         rarity:'common'   },
  { id:'gl2', name:'Боевые перчи',      slot:'gloves',  emoji:'🥊', atk:5,         rarity:'uncommon' },
  { id:'gl3', name:'Перчи силы',        slot:'gloves',  emoji:'💪', atk:10,        rarity:'rare'     },
  { id:'gl4', name:'Перчи мастера',     slot:'gloves',  emoji:'🌟', atk:16,def:4,  rarity:'epic'     },
  // ── Boots ────────────────────────────────────────────────
  { id:'bt1', name:'Кожаные боты',      slot:'boots',   emoji:'👞', def:2,         rarity:'common'   },
  { id:'bt2', name:'Скоростные боты',   slot:'boots',   emoji:'👟', def:4,         rarity:'uncommon' },
  { id:'bt3', name:'Боты ветра',        slot:'boots',   emoji:'💨', def:8,atk:3,   rarity:'rare'     },
  { id:'bt4', name:'Боты теней',        slot:'boots',   emoji:'🌑', def:14,atk:5,  rarity:'epic'     },
  // ── Ring ─────────────────────────────────────────────────
  { id:'rn1', name:'Кольцо силы',       slot:'ring',    emoji:'💍', atk:4,         rarity:'uncommon' },
  { id:'rn2', name:'Кольцо защиты',     slot:'ring',    emoji:'💍', def:4,         rarity:'uncommon' },
  { id:'rn3', name:'Кольцо крови',      slot:'ring',    emoji:'❤️', hp:40,atk:3,   rarity:'rare'     },
  { id:'rn4', name:'Кольцо мастера',    slot:'ring',    emoji:'🌀', atk:8,def:4,   rarity:'epic'     },
  { id:'rn5', name:'Кольцо богов',      slot:'ring',    emoji:'✨', atk:14,def:8,hp:50, rarity:'legendary'},
  // ── Belt ─────────────────────────────────────────────────
  { id:'bl1', name:'Кожаный пояс',      slot:'belt',    emoji:'🔶', hp:20,         rarity:'common'   },
  { id:'bl2', name:'Пояс воина',        slot:'belt',    emoji:'🔷', hp:45,atk:3,   rarity:'uncommon' },
  { id:'bl3', name:'Пояс силы',         slot:'belt',    emoji:'💫', hp:75,atk:6,   rarity:'rare'     },
  { id:'bl4', name:'Пояс легенды',      slot:'belt',    emoji:'🌟', hp:120,atk:10, rarity:'epic'     },
  // ── Pendant ──────────────────────────────────────────────
  { id:'nd1', name:'Амулет силы',       slot:'pendant', emoji:'📿', atk:5,         rarity:'uncommon' },
  { id:'nd2', name:'Амулет здоровья',   slot:'pendant', emoji:'📿', hp:60,         rarity:'uncommon' },
  { id:'nd3', name:'Амулет тьмы',       slot:'pendant', emoji:'💠', atk:8,hp:30,   rarity:'rare'     },
  { id:'nd4', name:'Амулет легенды',    slot:'pendant', emoji:'🌟', atk:16,hp:80,  rarity:'epic'     },
  { id:'nd5', name:'Амулет богов',      slot:'pendant', emoji:'⭐', atk:24,hp:120, rarity:'legendary'},
  // ── Potions (use-type, don't take inv slot) ───────────────
  { id:'pt1', name:'Зелье лечения',     slot:'use',     emoji:'🧪', hp:60,         rarity:'common'   },
  { id:'pt2', name:'Большое зелье',     slot:'use',     emoji:'💊', hp:120,        rarity:'uncommon' },
];

const EQ_SLOTS = [
  { slot:'weapon',  label:'Оружие',   empty:'⚔️' },
  { slot:'offhand', label:'Щит',      empty:'🛡️' },
  { slot:'helmet',  label:'Шлем',     empty:'⛑️' },
  { slot:'body',    label:'Тело',     empty:'🥋' },
  { slot:'legs',    label:'Низ',      empty:'👖' },
  { slot:'gloves',  label:'Перчи',    empty:'🧤' },
  { slot:'boots',   label:'Боты',     empty:'👞' },
  { slot:'ring',    label:'Кольцо',   empty:'💍' },
  { slot:'belt',    label:'Пояс',     empty:'🔶' },
  { slot:'pendant', label:'Ожерелье', empty:'📿' },
];

const SKILL_DEF = {
  warrior: [
    { key:'Q', name:'Щит-удар',    emoji:'🛡️', cd:8,  desc:'Оглушает врагов рядом'   },
    { key:'W', name:'Вихрь',       emoji:'⚔️', cd:12, desc:'Удар по всем вокруг'     },
    { key:'E', name:'Боевой клич', emoji:'📣', cd:20, desc:'+50% ATK на 5 секунд'    },
    { key:'R', name:'Рывок',       emoji:'💨', cd:15, desc:'Прорыв через врагов'      },
  ],
  archer: [
    { key:'Q', name:'Мульти-выстрел', emoji:'🏹', cd:6,  desc:'3 стрелы веером'          },
    { key:'W', name:'Яд. стрела',     emoji:'☠️', cd:10, desc:'Урон ядом со временем'    },
    { key:'E', name:'Кувырок',        emoji:'🌀', cd:8,  desc:'Уклонение с ускорением'   },
    { key:'R', name:'Дождь стрел',    emoji:'🌧️', cd:20, desc:'Ливень стрел по области'  },
  ],
  mage: [
    { key:'Q', name:'Огненный шар', emoji:'🔥', cd:5,  desc:'Мощный огненный снаряд'  },
    { key:'W', name:'Ледяная нова', emoji:'❄️', cd:10, desc:'Замедляет и ранит врагов' },
    { key:'E', name:'Барьер',       emoji:'🔮', cd:18, desc:'Щит на 4 секунды'         },
    { key:'R', name:'Телепорт',     emoji:'⚡', cd:12, desc:'Мгновенный прыжок'        },
  ],
};

const NPC_DEF = [
  { id:'merchant',   name:'Торговец',  emoji:'🧙', color:'#ffaa00', desc:'Зелья и расходники' },
  { id:'craftsman',  name:'Кузнец',    emoji:'⚒️',  color:'#8888ff', desc:'Крафт предметов'    },
  { id:'shopkeeper', name:'Лавочник',  emoji:'🏪',  color:'#44ff44', desc:'Снаряжение'         },
];

const MERCHANT_SHOP = [
  { itemId:'pt1', name:'Зелье лечения', emoji:'🧪', price:30,  desc:'HP +60'  },
  { itemId:'pt2', name:'Большое зелье', emoji:'💊', price:80,  desc:'HP +120' },
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
