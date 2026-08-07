// CHAR_DEF, ENEMY_DEF, TILE, WALL, FLOOR, CLAN_LEVELS, clanAtkBonusPct → shared/definitions.js

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
// _BUFF_POTION_IDS and QUEST_DEF now live in shared/definitions.js so the
// server can validate and grant quest rewards itself (see the claimQuest
// handler, server/index.js). That file is bundled ahead of this one
// (BUNDLE_FILES), so both names are already in scope here.


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
// GEAR_TIER_CRAFT_RECIPES (uncommon/rare), STONE_CRAFT_RECIPES and
// GEAR_CRAFT_RECIPES (epic/legendary) all now live in shared/definitions.js —
// the server rolls and validates every one of them (craftGear/craftStone,
// server/index.js), not just the Liberty-priced tiers, so it needs the same
// single copy of each recipe the client shows. Spliced together here purely
// so the craftsman UI keeps listing every tier from one place.
const ITEM_CRAFT_RECIPES = [];
if (typeof GEAR_TIER_CRAFT_RECIPES !== 'undefined') ITEM_CRAFT_RECIPES.push(...GEAR_TIER_CRAFT_RECIPES);
if (typeof STONE_CRAFT_RECIPES !== 'undefined') ITEM_CRAFT_RECIPES.push(...STONE_CRAFT_RECIPES);
if (typeof GEAR_CRAFT_RECIPES !== 'undefined') ITEM_CRAFT_RECIPES.push(...GEAR_CRAFT_RECIPES);

// CLASS_GEAR_SALVAGE_RECIPES (class cloaks/artifacts) lives in
// shared/definitions.js, not here — it costs Liberty on top of the salvage
// materials, and Liberty is server-authoritative, so the server needs its own
// copy of the recipe to charge against (same reasoning as GEAR_CRAFT_RECIPES
// above).

// MAT_UPGRADE_RECIPES (recipe-scroll tier-up) also moved to shared/
// definitions.js — see the comment there for why.

// Battle Power — reflects the player's overall combat strength.
// Keep in sync with the identical calcBM in server/index.js, which stores this
// for the rating. The level field is `lvl` on both the live player object and
// save blobs; reading `p.level` matched nothing, so the level term silently
// collapsed to its `|| 1` fallback and BM ignored levels entirely.
function calcBM(p) {
  if (!p) return 0;
  const upg = p.upgrades || {};
  const extras = ((upg.critChance || 0) + (upg.critPower || 0) +
    (upg.hpRegen || 0) + (upg.atkSpeed || 0)) * 8;
  return Math.round((p.lvl || p.level || 1) * 50 + (p.atk || 0) * 5 + (p.def || 0) * 3 + (p.maxHp || 100) * 0.5 + extras);
}
