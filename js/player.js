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
    equipment: {
      weapon:null, offhand:null, helmet:null, body:null, legs:null,
      gloves:null, boots:null, ring:null, belt:null, pendant:null,
    },
    inventory: [],
    potions: 3,
    skillCooldowns: { Q:0, W:0, E:0, R:0 },
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
  if (it.slot === 'material' || it.slot === 'use') return;
  const old = player.equipment[it.slot];
  player.equipment[it.slot] = it;
  player.inventory.splice(idx, 1);
  if (old) player.inventory.push(old);
  recompute(); updateInvUI();
}

function unequipItem(slot) {
  const it = player.equipment[slot];
  if (!it || player.inventory.length >= 10) return;
  player.inventory.push(it);
  player.equipment[slot] = null;
  recompute(); updateInvUI();
}

function usePotion() {
  if (!player || state !== 'playing') return;
  if (player.potions <= 0) return;
  if (player.hp >= player.maxHp) return;
  player.potions--;
  const heal = 60;
  player.hp = Math.min(player.maxHp, player.hp + heal);
  dmgNum(player.x, player.y - 26, '+' + heal + '♥', '#4f4');
  spawnBurst(player.x, player.y, '#4f4', 5);
  netSaveProgress();
}

function useSkill(idx) {
  if (!player || state !== 'playing') return;
  const skills = SKILL_DEF[player.type];
  if (!skills || !skills[idx]) return;
  const sk = skills[idx];
  if ((player.skillCooldowns[sk.key] || 0) > 0) return;

  player.skillCooldowns[sk.key] = sk.cd;
  skillFlash = { key: sk.key, timer: 0.4 };

  const isOnline = !!(socket?.connected);
  const activeEnemies = isOnline ? serverEnemies : enemies;

  if (player.type === 'warrior') {
    if (sk.key === 'Q') { // Shield Bash — AOE near player
      spawnAOE(player.x, player.y, 90);
      if (!isOnline) {
        activeEnemies.forEach(e => {
          if (dist(e.x, e.y, player.x, player.y) < 90) hitEnemy(e, Math.floor(player.atk * 1.2));
        });
      }
    } else if (sk.key === 'W') { // Whirlwind
      spawnAOE(player.x, player.y, 110);
      if (!isOnline) {
        activeEnemies.forEach(e => {
          if (dist(e.x, e.y, player.x, player.y) < 110) hitEnemy(e, Math.floor(player.atk * 0.8));
        });
      }
    } else if (sk.key === 'E') { // Battle Cry
      battleCryTimer = 5;
      dmgNum(player.x, player.y - 40, '⚔ Боевой клич!', '#fa0');
      spawnBurst(player.x, player.y, '#fa0', 10);
    } else if (sk.key === 'R') { // Charge
      const dx = joy.dx || 1, dy = joy.dy || 0;
      const len = Math.hypot(dx, dy) || 1;
      player.x += (dx / len) * 140;
      player.y += (dy / len) * 140;
      spawnBurst(player.x, player.y, '#5af', 8);
    }
  } else if (player.type === 'archer') {
    if (sk.key === 'Q') { // Multi-Shot
      const base = Math.atan2(joy.dy || 0, joy.dx || 1);
      [-0.35, 0, 0.35].forEach(off => {
        const ang = base + off;
        projs.push({ x: player.x, y: player.y, vx: Math.cos(ang)*360, vy: Math.sin(ang)*360,
          color: '#fa0', dmg: player.atk, life: 1.4, size: 6, isPlayer: true });
      });
    } else if (sk.key === 'W') { // Poison Arrow
      const ang = Math.atan2(joy.dy || 0, joy.dx || 1);
      projs.push({ x: player.x, y: player.y, vx: Math.cos(ang)*300, vy: Math.sin(ang)*300,
        color: '#4d4', dmg: player.atk * 1.5, life: 2, size: 8, isPlayer: true });
    } else if (sk.key === 'E') { // Dodge Roll
      dodgeTimer = 0.6;
      const dx = joy.dx || 0, dy = joy.dy || 0;
      const len = Math.hypot(dx, dy) || 1;
      player.x += (dx / len) * 80;
      player.y += (dy / len) * 80;
      spawnBurst(player.x, player.y, '#7e7', 6);
    } else if (sk.key === 'R') { // Rain of Arrows
      spawnAOE(player.x, player.y, 160);
      if (!isOnline) {
        activeEnemies.forEach(e => {
          if (dist(e.x, e.y, player.x, player.y) < 160) hitEnemy(e, Math.floor(player.atk * 1.4));
        });
      }
    }
  } else if (player.type === 'mage') {
    if (sk.key === 'Q') { // Fireball
      const ang = Math.atan2(joy.dy || 0, joy.dx || 1);
      projs.push({ x: player.x, y: player.y, vx: Math.cos(ang)*320, vy: Math.sin(ang)*320,
        color: '#f60', dmg: player.atk * 2, life: 2, size: 12, isPlayer: true });
    } else if (sk.key === 'W') { // Ice Nova
      spawnAOE(player.x, player.y, 130);
      if (!isOnline) {
        activeEnemies.forEach(e => {
          if (dist(e.x, e.y, player.x, player.y) < 130) {
            hitEnemy(e, Math.floor(player.atk * 0.9));
            e.spd = (e.spd || 60) * 0.5;
            setTimeout(() => { if (e.hp > 0) e.spd = ENEMY_DEF.find(d => d.name === e.name)?.spd || 60; }, 3000);
          }
        });
      }
    } else if (sk.key === 'E') { // Barrier
      barrierTimer = 4;
      dmgNum(player.x, player.y - 40, '🔮 Барьер!', '#e8e');
      spawnBurst(player.x, player.y, '#e8e', 8);
    } else if (sk.key === 'R') { // Teleport
      const dx = joy.dx || 0, dy = joy.dy || 0;
      const len = Math.hypot(dx, dy) || 1;
      const tx = player.x + (dx / len) * 180;
      const ty = player.y + (dy / len) * 180;
      if (!isWall(tx, ty)) {
        spawnBurst(player.x, player.y, '#f4f', 6);
        player.x = tx; player.y = ty;
        spawnBurst(player.x, player.y, '#f4f', 6);
      }
    }
  }
}

function restoreFromSave(data) {
  if (!player || !data) return;
  player.lvl      = data.lvl      || 1;
  player.xp       = data.xp       || 0;
  player.xpNext   = data.xpNext   || 100;
  player.gold     = data.gold     || 0;
  player.kills    = data.kills    || 0;
  player.potions  = data.potions  ?? 3;
  player.baseAtk  = data.baseAtk  || player.baseAtk;
  player.baseDef  = data.baseDef  || player.baseDef;
  player.baseMaxHp= data.baseMaxHp|| player.baseMaxHp;
  player.inventory  = data.inventory || [];

  // Migrate old save: armor → body
  const rawEq = data.equipment || {};
  if (rawEq.armor && !rawEq.body) rawEq.body = rawEq.armor;
  delete rawEq.armor;

  const blank = { weapon:null, offhand:null, helmet:null, body:null, legs:null,
                  gloves:null, boots:null, ring:null, belt:null, pendant:null };
  player.equipment = { ...blank, ...rawEq };
  recompute();
  player.hp = player.maxHp;
}

function statStr(it) {
  const p = [];
  if (it.atk) p.push('ATK+' + it.atk);
  if (it.def) p.push('DEF+' + it.def);
  if (it.hp)  p.push('HP+' + it.hp);
  return p.join('  ');
}
