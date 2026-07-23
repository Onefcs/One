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

function fireProj(tx, ty, enemyId, pvpTargetId) {
  const d = player.charDef, len = Math.hypot(tx - player.x, ty - player.y);
  if (len < 1) return;
  const vx = (tx - player.x) / len * 360;
  const vy = (ty - player.y) / len * 360;
  const ang = Math.atan2(vy, vx);
  const isArcher = player.type === 'archer';
  const proj = { x: player.x, y: player.y, vx, vy,
    color: d.projColor, dmg: player.atk, life: 1.8, size: isArcher ? 5 : 7,
    isPlayer: true, projType: isArcher ? 'arrow' : 'ball', angle: ang,
    enemyId: enemyId || null, pvpTargetId: pvpTargetId || null };
  projs.push(proj);
  netSpawnProj({ x: proj.x, y: proj.y, vx, vy, color: d.projColor,
    size: proj.size, projType: proj.projType, angle: ang, life: 1.8 });
}

function pickup(drop) {
  if (drop.type === 'gold') {
    let amount = drop.amount;
    if ((player.buffs || {}).gold > 0) amount *= 2;
    player.gold += amount;
    dmgNum(drop.x, drop.y - 12, '+' + amount + '💰', '#ff0');
    return;
  }
  const it = drop.item;
  if (it.slot === 'use') {
    if (it.hp) { player.hp = Math.min(player.maxHp, player.hp + it.hp); dmgNum(player.x, player.y - 26, '+' + it.hp + '♥', '#4f4'); }
    return;
  }
  if (addToInventory(it)) {
    dmgNum(drop.x, drop.y - 12, it.name, RARITY_COLOR[it.rarity] || '#4ff');
    netSaveProgress();
  }
}

function applyLootToInventory(eid, rlvl) {
  if (!player) return;
  const eDef = typeof ENEMY_DEF !== 'undefined' ? ENEMY_DEF.find(e => e.eid === eid) : null;
  const eType = eDef ? eDef.eType : null;
  let saved = false;

  function _addMat(id, yOff) {
    const mat = CRAFT_MATS.find(m => m.id === id);
    if (!mat) return;
    if (!addToInventory({ ...mat })) return;
    dmgNum(player.x, player.y - yOff, '+ ' + mat.name, RARITY_COLOR[mat.rarity] || '#aaa');
    saved = true;
  }

  // Drop multiplier: floor N gives ×N chance (floor 1 = ×1, floor 2 = ×2, …, floor 5 = ×5),
  // further boosted 5% per room level (room 1 = ×1, room 19/boss = ×1.05^18) — see
  // roomDropMult()/ROOM_DROP_GROWTH in shared/definitions.js.
  const _fMult = (typeof dungeonLvl !== 'undefined' && dungeonLvl >= 1 && dungeonLvl <= 5) ? dungeonLvl : 1;
  const _rMult = typeof roomDropMult === 'function' ? roomDropMult(rlvl) : 1;
  const _dropMult = _fMult * _rMult;

  // Recipe drop (all non-boss enemies)
  if (eType && eType !== 'boss') {
    const r = Math.random();
    if      (r < 0.00001 * _dropMult)  _addMat('recl', 52);
    else if (r < 0.00021 * _dropMult)  _addMat('rece', 52);
    else if (r < 0.00071 * _dropMult)  _addMat('recr', 52);
    else if (r < 0.00171 * _dropMult)  _addMat('recu', 52);
  }

  // Buff potion drop
  const _buffPotIds = ['bp_hp','bp_exp','bp_gold','bp_regen','bp_atkspeed','bp_atk'];
  const _bpChance = eType === 'boss' ? 0.03 : 0.005;
  if (Math.random() < _bpChance * _dropMult) {
    const bpId = _buffPotIds[Math.floor(Math.random() * _buffPotIds.length)];
    const bpDef = typeof ITEM_DEF !== 'undefined' ? ITEM_DEF.find(d => d.id === bpId) : null;
    if (bpDef && addToInventory({ ...bpDef })) {
      dmgNum(player.x, player.y - 52, '+ ' + bpDef.name, '#f0c040');
      saved = true;
    }
  }

  // Equipment rarity drop (uncommon..legendary gear, floor-based; boss ×20)
  const _rarTable = typeof FLOOR_RARITY_DROPS !== 'undefined' ? FLOOR_RARITY_DROPS[_fMult] : null;
  if (_rarTable) {
    const _rarBossMult = eType === 'boss' ? BOSS_RARITY_DROP_MULT : 1;
    const _gearSlots = ['weapon', 'helmet', 'body', 'gloves', 'boots', 'ring', 'belt'];
    for (const rarity in _rarTable) {
      if (Math.random() >= _rarTable[rarity] * _rarBossMult * _rMult) continue;
      const candidates = ITEM_DEF.filter(d => d.rarity === rarity && _gearSlots.includes(d.slot) &&
        (d.slot !== 'weapon' || (d.forClass && d.forClass.includes(player.type))));
      if (!candidates.length) continue;
      const it = candidates[Math.floor(Math.random() * candidates.length)];
      if (addToInventory({ ...it })) {
        dmgNum(player.x, player.y - 70, '+ ' + it.name, RARITY_COLOR[it.rarity] || '#4ff');
        saved = true;
      }
    }
  }

  // Room-level key drops (necessary for forge box-crafting) — base chance at
  // room level 1, compounding 5%/level; see roomKeyChance() (shared/definitions.js).
  if (typeof roomKeyChance === 'function') {
    if (Math.random() < roomKeyChance(rlvl, 'uncommon')) _addMat('key_uncommon', 60);
    if (Math.random() < roomKeyChance(rlvl, 'rare'))     _addMat('key_rare', 68);
  }

  // Room-level enchant-stone drop (Камень обычной заточки) — base 1% at room
  // level 1, compounding 1%/level; see roomEnchantStoneChance().
  if (typeof roomEnchantStoneChance === 'function' && Math.random() < roomEnchantStoneChance(rlvl)) {
    _addMat('norm_stone', 76);
  }

  if (saved) netSaveProgress();
}
