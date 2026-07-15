function tileAt(wx, wy) {
  const tx = Math.floor(wx / TILE), ty = Math.floor(wy / TILE);
  if (tx < 0 || ty < 0 || tx >= dungeon.w || ty >= dungeon.h) return WALL;
  return dungeon.grid[ty][tx];
}
function isWall(wx, wy) { return tileAt(wx, wy) === WALL; }

function canMoveX(ent, dx, r) {
  const nx = ent.x + dx, hr = r * 0.82;
  return !isWall(nx + (dx > 0 ? r : -r), ent.y - hr) &&
         !isWall(nx + (dx > 0 ? r : -r), ent.y + hr);
}
function canMoveY(ent, dy, r) {
  const ny = ent.y + dy, hr = r * 0.82;
  return !isWall(ent.x - hr, ny + (dy > 0 ? r : -r)) &&
         !isWall(ent.x + hr, ny + (dy > 0 ? r : -r));
}

function hitEnemy(e, base) {
  const dmg = Math.max(1, base - e.def + rnd(-3, 4));
  e.hp -= dmg; e.hurtTimer = 0.22;
  dmgNum(e.x, e.y - e.size - 4, dmg, '#ff4');
}

function hitPlayer(atk) {
  const dmg = Math.max(1, atk - player.def + rnd(-2, 3));
  player.hp -= dmg; player.hurtTimer = 0.22;
  dmgNum(player.x, player.y - 24, dmg, '#f55');
  if (player.hp <= 0) { player.hp = 0; state = 'dead'; }
}

function faceTowards(tx, ty) {
  const dx = tx - player.x, dy = ty - player.y;
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ax > ay * 0.8) player.facing = dx > 0 ? 'right' : 'left';
  else               player.facing = dy > 0 ? 'front' : 'back';
}

function doMeleeAttack(target) {
  faceTowards(target.x, target.y);
  hitEnemy(target, player.atk);
  swingAngle = Math.atan2(target.y - player.y, target.x - player.x);
  swingTimer = 0.18;
  player.atkAnimTimer = 0.55; player.animFrame = 0; player.animTimer = 0;
  if (player.charDef.atkType === 'aoe') {
    enemies.forEach(e => {
      if (e === target || e.hp <= 0) return;
      if (dist(e.x, e.y, player.x, player.y) < player.charDef.atkRange * 0.8)
        hitEnemy(e, Math.floor(player.atk * 0.55));
    });
    spawnAOE(player.x, player.y, player.charDef.atkRange);
  }
}

function fireProj(tx, ty) {
  const d = player.charDef, len = Math.hypot(tx - player.x, ty - player.y);
  if (len < 1) return;
  faceTowards(tx, ty);
  player.atkAnimTimer = 0.55; player.animFrame = 0; player.animTimer = 0;
  projs.push({ x: player.x, y: player.y, vx: (tx - player.x) / len * 360, vy: (ty - player.y) / len * 360, color: d.projColor, dmg: player.atk, life: 1.6, size: 6, isPlayer: true });
}

function spawnDrops(e) {
  const g = e.gold[0] + Math.floor(Math.random() * (e.gold[1] - e.gold[0] + 1));
  drops.push({ type: 'gold', x: e.x, y: e.y, amount: g, life: 18 });
  if (Math.random() < 0.38) {
    const r = Math.random();
    const pool = r < 0.55 ? ITEM_DEF.filter(i => i.rarity === 'common')
               : r < 0.88 ? ITEM_DEF.filter(i => i.rarity === 'uncommon')
               :              ITEM_DEF.filter(i => i.rarity === 'rare');
    drops.push({ type: 'item', x: e.x + (Math.random() - .5) * 20, y: e.y + (Math.random() - .5) * 20, item: { ...pool[Math.floor(Math.random() * pool.length)] }, life: 35 });
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
  if (player.inventory.length < 20) {
    player.inventory.push(it);
    dmgNum(drop.x, drop.y - 12, it.name, '#4ff');
  }
}
