function makePlayer(type) {
  const d = CHAR_DEF[type];
  return {
    type, charDef: d,
    x: 0, y: 0,
    baseAtk: d.baseAtk, baseDef: d.baseDef, baseMaxHp: d.baseHP,
    atk: d.baseAtk, def: d.baseDef, maxHp: d.baseHP, hp: d.baseHP,
    speed: d.speed,
    lvl: 1, xp: 0, xpNext: 100,
    gold: 0, kills: 0,
    atkTimer: 0, hurtTimer: 0,
    facing: 'front', atkAnimTimer: 0, animFrame: 0, animTimer: 0,
    equipment: { weapon: null, armor: null, helmet: null, ring: null, pendant: null },
    inventory: [],
  };
}

function recompute() {
  let a = player.baseAtk, d = player.baseDef, h = player.baseMaxHp;
  Object.values(player.equipment).forEach(it => {
    if (!it) return;
    if (it.atk) a += it.atk;
    if (it.def) d += it.def;
    if (it.hp)  h += it.hp;
  });
  player.atk = a; player.def = d; player.maxHp = h;
  if (player.hp > player.maxHp) player.hp = player.maxHp;
}

function gainXP(amount) {
  player.xp += amount;
  while (player.xp >= player.xpNext) {
    player.xp -= player.xpNext;
    player.lvl++;
    player.xpNext = Math.floor(100 * Math.pow(1.38, player.lvl - 1));
    player.baseAtk += 3; player.baseDef += 1; player.baseMaxHp += 20;
    recompute();
    player.hp = Math.min(player.maxHp, player.hp + 35);
    dmgNum(player.x, player.y - 38, '↑ УРОВЕНЬ ' + player.lvl, '#ff0');
    spawnBurst(player.x, player.y, '#ff0', 14);
  }
  netSaveProgress();
}

function equipItem(idx) {
  const it = player.inventory[idx]; if (!it) return;
  const old = player.equipment[it.slot];
  player.equipment[it.slot] = it;
  player.inventory.splice(idx, 1);
  if (old) player.inventory.push(old);
  recompute(); updateInvUI();
}

function unequipItem(slot) {
  const it = player.equipment[slot];
  if (!it || player.inventory.length >= 20) return;
  player.inventory.push(it);
  player.equipment[slot] = null;
  recompute(); updateInvUI();
}

function restoreFromSave(data) {
  if (!player || !data) return;
  player.lvl      = data.lvl      || 1;
  player.xp       = data.xp       || 0;
  player.xpNext   = data.xpNext   || 100;
  player.gold     = data.gold     || 0;
  player.kills    = data.kills    || 0;
  player.baseAtk  = data.baseAtk  || player.baseAtk;
  player.baseDef  = data.baseDef  || player.baseDef;
  player.baseMaxHp= data.baseMaxHp|| player.baseMaxHp;
  player.inventory  = data.inventory  || [];
  player.equipment  = data.equipment  || { weapon: null, armor: null, helmet: null, ring: null, pendant: null };
  recompute();
  player.hp = player.maxHp; // начинаем каждую сессию с полным здоровьем
}

function statStr(it) {
  const p = [];
  if (it.atk) p.push('ATK+' + it.atk);
  if (it.def) p.push('DEF+' + it.def);
  if (it.hp)  p.push('HP+' + it.hp);
  return p.join('  ');
}
