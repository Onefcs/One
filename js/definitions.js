const CHAR_DEF = {
  warrior: { name:'Воин',   emoji:'🗡️', color:'#5af', baseHP:200, baseAtk:25, baseDef:10, speed:145, atkRange:58,  atkSpeed:1.2,  atkType:'melee' },
  archer:  { name:'Лучник', emoji:'🏹', color:'#7e7', baseHP:140, baseAtk:20, baseDef:5,  speed:175, atkRange:210, atkSpeed:1.6,  atkType:'ranged', projColor:'#fa0' },
  mage:    { name:'Маг',    emoji:'🔮', color:'#e8e', baseHP:110, baseAtk:38, baseDef:3,  speed:155, atkRange:140, atkSpeed:0.85, atkType:'aoe',    projColor:'#f4f' },
};

const ENEMY_DEF = [
  { name:'Гоблин', color:'#3a3', size:14, hp:40,  atk:8,  def:2,  spd:92,  xp:15,  gold:[1,5],   isBoss:false },
  { name:'Скелет', color:'#bbb', size:16, hp:70,  atk:14, def:4,  spd:70,  xp:25,  gold:[3,9],   isBoss:false },
  { name:'Орк',    color:'#964', size:20, hp:130, atk:20, def:8,  spd:56,  xp:40,  gold:[6,16],  isBoss:false },
  { name:'Тролль', color:'#575', size:24, hp:230, atk:28, def:12, spd:40,  xp:65,  gold:[10,22], isBoss:false },
  { name:'ДЕМОН',  color:'#f33', size:28, hp:420, atk:42, def:16, spd:60,  xp:130, gold:[25,55], isBoss:true  },
];

const ITEM_DEF = [
  { id:'sw1', name:'Ржавый меч',      slot:'weapon',  emoji:'🗡️', atk:6,        rarity:'common'   },
  { id:'sw2', name:'Стальной меч',    slot:'weapon',  emoji:'⚔️', atk:14,       rarity:'uncommon' },
  { id:'sw3', name:'Меч дракона',     slot:'weapon',  emoji:'🔥', atk:28,       rarity:'rare'     },
  { id:'bw1', name:'Деревянный лук',  slot:'weapon',  emoji:'🏹', atk:5,        rarity:'common'   },
  { id:'bw2', name:'Серебряный лук',  slot:'weapon',  emoji:'🏹', atk:13,       rarity:'uncommon' },
  { id:'st1', name:'Посох мага',      slot:'weapon',  emoji:'🪄', atk:7,        rarity:'common'   },
  { id:'st2', name:'Огненный посох',  slot:'weapon',  emoji:'🔮', atk:18,       rarity:'uncommon' },
  { id:'st3', name:'Посох Анубара',   slot:'weapon',  emoji:'💜', atk:32,       rarity:'rare'     },
  { id:'ar1', name:'Кожаная броня',   slot:'armor',   emoji:'🥋', def:5,        rarity:'common'   },
  { id:'ar2', name:'Кольчуга',        slot:'armor',   emoji:'🛡️', def:11,       rarity:'uncommon' },
  { id:'ar3', name:'Латы',            slot:'armor',   emoji:'⚜️', def:20,       rarity:'rare'     },
  { id:'hm1', name:'Кожаный шлем',   slot:'helmet',  emoji:'⛑️', hp:25,        rarity:'common'   },
  { id:'hm2', name:'Железный шлем',  slot:'helmet',  emoji:'🪖', hp:50,        rarity:'uncommon' },
  { id:'hm3', name:'Шлем дракона',   slot:'helmet',  emoji:'🐉', hp:90,atk:4,  rarity:'rare'     },
  { id:'rn1', name:'Кольцо силы',    slot:'ring',    emoji:'💍', atk:4,        rarity:'uncommon' },
  { id:'rn2', name:'Кольцо защиты',  slot:'ring',    emoji:'💍', def:4,        rarity:'uncommon' },
  { id:'rn3', name:'Кольцо крови',   slot:'ring',    emoji:'❤️', hp:40,atk:3,  rarity:'rare'     },
  { id:'nd1', name:'Амулет силы',    slot:'pendant', emoji:'📿', atk:5,        rarity:'uncommon' },
  { id:'nd2', name:'Амулет здоровья',slot:'pendant', emoji:'📿', hp:60,        rarity:'uncommon' },
  { id:'nd3', name:'Амулет тьмы',    slot:'pendant', emoji:'💠', atk:8,hp:30,  rarity:'rare'     },
  { id:'pt1', name:'Зелье лечения',  slot:'use',     emoji:'🧪', hp:60,        rarity:'common'   },
  { id:'pt2', name:'Большое зелье',  slot:'use',     emoji:'💊', hp:120,       rarity:'uncommon' },
];

const EQ_SLOTS = [
  { slot:'weapon',  label:'Оружие',  empty:'⚔️' },
  { slot:'armor',   label:'Броня',   empty:'🛡️' },
  { slot:'helmet',  label:'Шлем',    empty:'⛑️' },
  { slot:'ring',    label:'Кольцо',  empty:'💍' },
  { slot:'pendant', label:'Амулет',  empty:'📿' },
];
