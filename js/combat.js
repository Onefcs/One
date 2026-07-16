function tileAt(wx, wy) {
  const tx = Math.floor(wx / TILE), ty = Math.floor(wy / TILE);
  if (tx < 0 || ty < 0 || tx >= dungeon.w || ty >= dungeon.h) return WALL;
  return dungeon.grid[ty][tx];
}
function isWall(wx, wy) { return tileAt(wx, wy) === WALL; }

function canMoveX(ent, dx, r) {
  const nx = ent.x + dx;
  if (!dungeon || nx - r < 0 || nx + r > dungeon.w * TILE) return false;
  const hr = r * 0.82;
  return !isWall(nx + (dx > 0 ? r : -r), ent.y - hr) &&
         !isWall(nx + (dx > 0 ? r : -r), ent.y + hr);
}
function canMoveY(ent, dy, r) {
  const ny = ent.y + dy;
  if (!dungeon || ny - r < 0 || ny + r > dungeon.h * TILE) return false;
  const hr = r * 0.82;
  return !isWall(ent.x - hr, ny + (dy > 0 ? r : -r)) &&
         !isWall(ent.x + hr, ny + (dy > 0 ? r : -r));
}

function hasLOS(x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1) return true;
  const steps = Math.ceil(len / (TILE * 0.45));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (isWall(x1 + dx * t, y1 + dy * t)) return false;
  }
  return true;
}

function hitEnemy(e, base) {
  // Accuracy check
  if (Math.random() > (player.accuracy ?? 0.85)) {
    dmgNum(e.x, e.y - e.size - 4, 'МИМО', '#888');
    return;
  }
  let dmg = Math.max(1, base - e.def + rnd(-3, 4));
  let isCrit = false;
  if (Math.random() < (player.critChance || 0)) {
    dmg = Math.floor(dmg * (player.critPower || 1.5));
    isCrit = true;
  }
  e.hp -= dmg; e.hurtTimer = 0.22;
  dmgNum(e.x, e.y - e.size - 4, dmg, isCrit ? '#fff' : '#ff4');
  if (isCrit) spawnBurst(e.x, e.y, '#ff8', 3);
  // Life steal
  const ls = player.lifeSteal || 0;
  if (ls > 0 && player.hp < player.maxHp) {
    player.hp = Math.min(player.maxHp, player.hp + dmg * ls);
  }
}

function hitPlayer(atk) {
  if (barrierTimer > 0) { dmgNum(player.x, player.y - 24, 'БЛОК', '#88f'); return; }
  // Dodge check
  if (Math.random() < (player.dodge || 0)) {
    dmgNum(player.x, player.y - 24, 'УКЛОН', '#7ef');
    return;
  }
  const dmg = Math.max(1, atk - player.def + rnd(-2, 3));
  const actual = Math.max(1, Math.floor(dmg * (dodgeTimer > 0 ? 0.3 : 1)));
  player.hp -= actual; player.hurtTimer = 0.22;
  dmgNum(player.x, player.y - 24, actual, '#f55');
  if (player.hp <= 0) { player.hp = 0; playerDie(); }
}

function faceTowards(tx, ty) {
  const dx = tx - player.x, dy = ty - player.y;
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ax > ay * 0.8) player.facing = dx > 0 ? 'right' : 'left';
  else               player.facing = dy > 0 ? 'front' : 'back';
}

function doMeleeAttack(target) {
  faceTowards(target.x, target.y);
  hitEnemy(target, player.atk * (battleCryTimer > 0 ? 1.5 : 1));
  swingAngle = Math.atan2(target.y - player.y, target.x - player.x);
  swingTimer = 0.18;
  player.atkAnimTimer = 0.55; player.animFrame = 0; player.animTimer = 0;
}

function fireProj(tx, ty) {
  const d = player.charDef, len = Math.hypot(tx - player.x, ty - player.y);
  if (len < 1) return;
  faceTowards(tx, ty);
  player.atkAnimTimer = 0.55; player.animFrame = 0; player.animTimer = 0;
  const vx = (tx - player.x) / len * 360;
  const vy = (ty - player.y) / len * 360;
  const ang = Math.atan2(vy, vx);
  const isArcher = player.type === 'archer';
  const proj = { x: player.x, y: player.y, vx, vy,
    color: d.projColor, dmg: player.atk, life: 1.8, size: isArcher ? 5 : 7,
    isPlayer: true, projType: isArcher ? 'arrow' : 'ball', angle: ang };
  projs.push(proj);
  netSpawnProj({ x: proj.x, y: proj.y, vx, vy, color: d.projColor,
    size: proj.size, projType: proj.projType, angle: ang, life: 1.8 });
}

function spawnDrops(e) {
  const g = calcGoldDrop(e, dungeonLvl);
  if (g > 0) drops.push({ type: 'gold', x: e.x + rnd(-12, 12), y: e.y + rnd(-12, 12), amount: g, life: 18 });

  // Item drop: 12% chance, rarity-weighted
  if (Math.random() < 0.12) {
    const r = Math.random();
    let pool;
    if      (r < 0.60)  pool = ITEM_DEF.filter(i => i.rarity === 'common'    && i.slot !== 'use');
    else if (r < 0.88)  pool = ITEM_DEF.filter(i => i.rarity === 'uncommon'  && i.slot !== 'use');
    else if (r < 0.975) pool = ITEM_DEF.filter(i => i.rarity === 'rare'      && i.slot !== 'use');
    else if (r < 0.998) pool = ITEM_DEF.filter(i => i.rarity === 'epic'      && i.slot !== 'use');
    else                pool = ITEM_DEF.filter(i => i.rarity === 'legendary' && i.slot !== 'use');
    if (pool && pool.length > 0) {
      const item = pool[Math.floor(Math.random() * pool.length)];
      drops.push({ type: 'item', x: e.x + rnd(-18, 18), y: e.y + rnd(-18, 18), item: { ...item }, life: 40 });
    }
  }

  // Craft material drop: 20% chance
  if (Math.random() < 0.20) {
    const r = Math.random();
    const matPool = r < 0.55 ? CRAFT_MATS.filter(m => m.rarity === 'common')
                  : r < 0.85 ? CRAFT_MATS.filter(m => m.rarity === 'uncommon')
                  :              CRAFT_MATS.filter(m => m.rarity === 'rare');
    if (matPool.length > 0) {
      const mat = matPool[Math.floor(Math.random() * matPool.length)];
      drops.push({ type: 'item', x: e.x + rnd(-20, 20), y: e.y + rnd(-20, 20), item: { ...mat }, life: 35 });
    }
  }
}

function pickup(drop) {
  if (drop.type === 'gold') {
    player.gold += drop.amount;
    dmgNum(drop.x, drop.y - 12, '+' + drop.amount + '💰', '#ff0');
    return;
  }
  const it = drop.item;
  if (it.slot === 'use') {
    if (it.hp) { player.hp = Math.min(player.maxHp, player.hp + it.hp); dmgNum(player.x, player.y - 26, '+' + it.hp + '♥', '#4f4'); }
    return;
  }
  if (player.inventory.length < 10) {
    player.inventory.push(it);
    dmgNum(drop.x, drop.y - 12, it.name, RARITY_COLOR[it.rarity] || '#4ff');
    netSaveProgress();
  }
}
