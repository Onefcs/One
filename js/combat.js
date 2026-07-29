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
  player.facing = facing8FromDelta(dx, dy, player.facing);
}

function fireProj(tx, ty, enemyId, pvpTargetId) {
  const d = player.charDef, len = Math.hypot(tx - player.x, ty - player.y);
  if (len < 1) return;
  const vx = (tx - player.x) / len * 360;
  const vy = (ty - player.y) / len * 360;
  const ang = Math.atan2(vy, vx);
  const isArcher = player.type === 'ranger';
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
    dmgNum(drop.x, drop.y - 12, '+' + amount + '💰', '#e6ac19');
    return;
  }
  const it = drop.item;
  if (it.slot === 'use') {
    if (it.hp) { player.hp = Math.min(player.maxHp, player.hp + it.hp); dmgNum(player.x, player.y - 26, '+' + it.hp + '♥', '#98e456'); }
    return;
  }
  if (addToInventory(it)) {
    dmgNum(drop.x, drop.y - 12, it.name, RARITY_COLOR[it.rarity] || '#c4a276');
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
    dmgNum(player.x, player.y - yOff, '+ ' + mat.name, RARITY_COLOR[mat.rarity] || '#aea599');
    saved = true;
  }

  // Drop multiplier: corridor arm N gives ×N chance (left = ×1, top = ×2,
  // bottom = ×3, right = ×4), further boosted 5% per room level within that
  // arm (room 1 = ×1, room 20/boss = ×1.05^19) — see roomDropMult()/
  // ROOM_DROP_GROWTH in shared/definitions.js.
  const _localLvl = typeof armLocalLevel === 'function' ? armLocalLevel(rlvl) : (rlvl || 1);
  const _fMult = typeof armIndexForLevel === 'function' ? armIndexForLevel(rlvl) : 1;
  const _rMult = typeof roomDropMult === 'function' ? roomDropMult(_localLvl) : 1;
  const _dropMult = _fMult * _rMult;

  // Recipe drop (all non-boss enemies)
  if (eType && eType !== 'boss') {
    const r = Math.random();
    if      (r < 0.00001 * _dropMult)  _addMat('recl', 52);
    else if (r < 0.00021 * _dropMult)  _addMat('rece', 52);
    else if (r < 0.00071 * _dropMult)  _addMat('recr', 52);
    else if (r < 0.00171 * _dropMult)  _addMat('recu', 52);
  }

  // Equipment drop: one continuous per-level chance (+0.1%/level, never
  // resets across zones — see itemDropChanceAtLevel in shared/definitions.js),
  // boss kills get ×BOSS_ITEM_DROP_MULT on top. Rarity is picked by which
  // quarter of the 1-120 level scale the kill happened in (itemRarityForLevel).
  if (typeof itemDropChanceAtLevel === 'function') {
    const _itemChance = Math.min(100, itemDropChanceAtLevel(rlvl) * (eType === 'boss' ? BOSS_ITEM_DROP_MULT : 1));
    if (Math.random() * 100 < _itemChance) {
      const rarity = itemRarityForLevel(rlvl);
      const _gearSlots = ['weapon', 'helmet', 'body', 'gloves', 'boots', 'ring', 'belt'];
      const candidates = ITEM_DEF.filter(d => d.rarity === rarity && _gearSlots.includes(d.slot) &&
        (d.slot !== 'weapon' || (d.forClass && d.forClass.includes(player.type))));
      if (candidates.length) {
        const it = candidates[Math.floor(Math.random() * candidates.length)];
        if (addToInventory({ ...it })) {
          dmgNum(player.x, player.y - 70, '+ ' + it.name, RARITY_COLOR[it.rarity] || '#c4a276');
          saved = true;
        }
      }
    }
  }

  // Room-level key drops (necessary for forge box-crafting) — base chance at
  // room level 1, compounding 5%/level; see roomKeyChance() (shared/definitions.js).
  if (typeof roomKeyChance === 'function') {
    if (Math.random() < roomKeyChance(_localLvl, 'uncommon')) _addMat('key_uncommon', 60);
    if (Math.random() < roomKeyChance(_localLvl, 'rare'))     _addMat('key_rare', 68);
  }

  // Room-level enchant-stone drop (Камень обычной заточки) — base 1% at room
  // level 1, compounding 1%/level; see roomEnchantStoneChance().
  if (typeof roomEnchantStoneChance === 'function' && Math.random() < roomEnchantStoneChance(_localLvl)) {
    _addMat('norm_stone', 76);
  }

  // Skill books — one per class+skill (studySkill()/upgradeSkillWithBook() in
  // js/ui.js spend these to unlock and level up Q/W/E/R). Any class's book
  // can drop from any monster now, not just the killing player's own — a
  // book for a class you're not playing is just something to sell on the
  // Market to whoever needs it. Both chances are 100x rarer than the
  // original tuning (was: boss guaranteed, regular 0.02×dropMult).
  const _allBooks = CRAFT_MATS.filter(m => m.skillKey);
  if (_allBooks.length) {
    if (eType === 'boss') {
      if (Math.random() < 0.01) {
        const book = _allBooks[Math.floor(Math.random() * _allBooks.length)];
        if (addToInventoryQty({ ...book }, 2)) {
          dmgNum(player.x, player.y - 84, '+ 2× ' + book.name, RARITY_COLOR['uncommon'] || '#98e456');
          saved = true;
        }
      }
    } else if (Math.random() < 0.0002 * Math.min(_dropMult, 3)) {
      const book = _allBooks[Math.floor(Math.random() * _allBooks.length)];
      if (addToInventory({ ...book })) {
        dmgNum(player.x, player.y - 84, '+ ' + book.name, RARITY_COLOR['uncommon'] || '#98e456');
        saved = true;
      }
    }
  }

  if (saved) netSaveProgress();
}
