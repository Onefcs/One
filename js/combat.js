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

function faceTowards(tx, ty) {
  const dx = tx - player.x, dy = ty - player.y;
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ax > ay * 0.8) player.facing = dx > 0 ? 'right' : 'left';
  else               player.facing = dy > 0 ? 'front' : 'back';
}

function fireProj(tx, ty) {
  const d = player.charDef, len = Math.hypot(tx - player.x, ty - player.y);
  if (len < 1) return;
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
  if (player.inventory.length < 50) {
    player.inventory.push(it);
    dmgNum(drop.x, drop.y - 12, it.name, RARITY_COLOR[it.rarity] || '#4ff');
    netSaveProgress();
  }
}

function applyLootToInventory(eid) {
  if (!player) return;
  const eDef = typeof ENEMY_DEF !== 'undefined' ? ENEMY_DEF.find(e => e.eid === eid) : null;
  const eType = eDef ? eDef.eType : null;
  let saved = false;

  function _addMat(id, yOff) {
    if (player.inventory.length >= 50) return;
    const mat = CRAFT_MATS.find(m => m.id === id);
    if (!mat) return;
    player.inventory.push({ ...mat });
    dmgNum(player.x, player.y - yOff, '+ ' + mat.name, RARITY_COLOR[mat.rarity] || '#aaa');
    saved = true;
  }

  // Recipe drop (all non-boss enemies)
  if (eType && eType !== 'boss') {
    const r = Math.random();
    if      (r < 0.00001)  _addMat('recl', 52);
    else if (r < 0.00021)  _addMat('rece', 52);
    else if (r < 0.00071)  _addMat('recr', 52);
    else if (r < 0.00171)  _addMat('recu', 52);
  }

  // Material drops by enemy type (5% each, 1 piece)
  if (eType === 'warrior') {
    if (Math.random() < 0.05) _addMat('bonec', 36);
    if (Math.random() < 0.05) _addMat('coalc', 48);
  } else if (eType === 'guard') {
    if (Math.random() < 0.05) _addMat('orec',  36);
    if (Math.random() < 0.05) _addMat('skinc', 48);
  }

  if (saved) netSaveProgress();
}
