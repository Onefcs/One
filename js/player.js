function _isStackable(it) { return it.slot === 'material' || it.slot === 'recipe' || it.slot === 'buff_potion'; }

function invSlotCount() {
  return player.inventory.length;
}

function invHasSpace() {
  return invSlotCount() < 50;
}

function addToInventory(it) {
  if (_isStackable(it)) {
    const existing = player.inventory.find(i => i.id === it.id);
    if (existing) { existing.qty = (existing.qty || 1) + 1; return true; }
  }
  if (!invHasSpace()) return false;
  if (_isStackable(it)) {
    player.inventory.push({ ...it, qty: 1 });
  } else {
    player.inventory.push(it);
  }
  return true;
}

function removeFromInventory(id, n) {
  const item = player.inventory.find(i => i.id === id);
  if (!item) return false;
  const qty = item.qty || 1;
  if (qty <= n) {
    player.inventory.splice(player.inventory.indexOf(item), 1);
  } else {
    item.qty = qty - n;
  }
  return true;
}

function countMaterial(id) {
  const item = player.inventory.find(i => i.id === id);
  return item ? (item.qty || 1) : 0;
}

function countEnhancedItem(id, minEnh) {
  return player.inventory.filter(i => i.id === id && (i.enhance || 0) >= minEnh).length;
}

function removeEnhancedItem(id, n, minEnh) {
  let removed = 0;
  for (let i = player.inventory.length - 1; i >= 0 && removed < n; i--) {
    const it = player.inventory[i];
    if (it.id === id && (it.enhance || 0) >= minEnh) {
      player.inventory.splice(i, 1);
      removed++;
    }
  }
  return removed >= n;
}

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
    facing: 'front', atkAnimTimer: 0, castDuration: 0, animFrame: 0, animTimer: 0,
    pendingAttack: null, attackFired: false,
    equipment: {
      weapon:null, helmet:null, body:null, gloves:null, boots:null, ring:null, belt:null,
    },
    inventory: [],
    potionBag: { pt1: 3, pt2: 0 },
    hudPotion: 'pt1',
    buffs: {},
    potCd: 0,
    autoHpPct: 0.5,
    skillCooldowns: { Q:0, W:0, E:0, R:0 },
    skillLevels: { Q:0, W:0, E:0, R:0 },
    skillXp: { Q:0, W:0, E:0, R:0 },
    questIdx: 0,
    questKills: {},
    upgrades: { atk:0, def:0, hp:0, atkSpeed:0, critChance:0, critPower:0, hpRegen:0 },
    // derived combat stats (computed by recompute)
    atkSpeed: d.atkSpeed,
    critChance: 0.05, critPower: 1.5,
    hpRegen: 0,
  };
}

// Per-level enhance bonus for one stat unit — the formula itself lives in
// shared/definitions.js (enhanceBonus) so the server's Market validation
// can't drift out of sync with what the client actually applies.
function _enhBonusAt(it, levels) { return enhanceBonus(it, levels); }
function _enhBonus(it) { return _enhBonusAt(it, it.enhance || 0); }

// ── Skill level helpers ───────────────────────────────────────
function _skillLvl(key) { return (player && player.skillLevels && player.skillLevels[key]) || 0; }
function _skillDmgMult(key)    { return 1 + _skillLvl(key) * 0.01; }
function _skillBuffSec(key)    { return _skillLvl(key); }
function _skillBarrierSec(key) { return _skillLvl(key) * 0.2; }
function _skillInvisSec(key)   { return _skillLvl(key) * 0.2; }
function _skillHealMult(key)   { return 1 + _skillLvl(key) * 0.01; }
function _skillMobRange(key)   { return _skillLvl(key) * 10; }

// XP required to level up from `currentLevel` → currentLevel+1
function skillXpRequired(currentLevel) {
  return Math.round(100 * Math.pow(1.5, currentLevel));
}

// AOE helper with optional damage multiplier (replaces _skillAOE for leveled skills)
function _skillAOEMult(r, mult) {
  const m = Math.max(1, mult || 1);
  serverEnemies.forEach(e => {
    if ((e.hp || 0) <= 0) return;
    if (dist(e.x, e.y, player.x, player.y) < r) netSkillAttack(e.id, m);
  });
}

// Directional AOE with optional damage multiplier
function _skillDirMult(dx, dy, r, arcDot, mult) {
  const m = Math.max(1, mult || 1);
  const len = Math.hypot(dx, dy) || 1;
  const nx = dx / len, ny = dy / len;
  serverEnemies.forEach(e => {
    if ((e.hp || 0) <= 0) return;
    const ex = e.x - player.x, ey = e.y - player.y;
    const d = Math.hypot(ex, ey);
    if (d > r || d < 1) return;
    if ((ex / d) * nx + (ey / d) * ny > (arcDot ?? 0.3)) netSkillAttack(e.id, m);
  });
}

function recompute() {
  const u = player.upgrades || {};
  let a = player.baseAtk + (u.atk || 0) * 3;
  let d = player.baseDef + (u.def || 0) * 2;
  let h = player.baseMaxHp + (u.hp || 0) * 25;
  let extraCrit = 0, extraAS = 0, hpPct = 0;
  Object.values(player.equipment).forEach(it => {
    if (!it) return;
    const eb = _enhBonus(it);
    a += (it.atk || 0) + (eb.atk || 0);
    d += (it.def || 0) + (eb.def || 0);
    h += (it.hp  || 0) + (eb.hp  || 0);
    if (it.critChance) extraCrit += it.critChance;
    if (it.atkSpeed)   extraAS   += it.atkSpeed;
    if (it.hpPct)      hpPct     += it.hpPct;
  });
  h = Math.floor(h * (1 + hpPct));

  // Buff potion bonuses
  const buffs = player.buffs || {};
  if (buffs.hp        > 0) h = Math.floor(h * 1.10);
  if (buffs.atk       > 0) a = Math.floor(a * 1.20);
  if (buffs.atkspeed  > 0) extraAS += (player.charDef.atkSpeed || 0) * 0.20;

  player.atk = a; player.def = d; player.maxHp = h;
  if (player.hp > player.maxHp) player.hp = player.maxHp;

  const lvl = player.lvl - 1;
  const cd  = player.charDef;
  player.atkSpeed   = cd.atkSpeed * (1 + lvl * 0.015) + (u.atkSpeed   || 0) * 0.05 + extraAS;
  player.critChance = Math.min(0.80, 0.05 + lvl * 0.004 + (u.critChance || 0) * 0.025 + extraCrit);
  player.critPower  = 1.5 + lvl * 0.015 + (u.critPower  || 0) * 0.15;
  if (typeof netStatsUpdate === 'function') netStatsUpdate(a, d, h, player.critChance, player.critPower);
  player.hpRegen    = lvl * 0.02 + (u.hpRegen    || 0) * 0.5 + (buffs.regen > 0 ? 2 : 0);
}

function getAvailableSkillPoints() {
  const total = (player.lvl || 1) * 3;
  const spent = Object.values(player.upgrades || {}).reduce((s, v) => s + v, 0);
  return total - spent;
}

function upgradeStats(key) {
  if (!player || !UPGRADE_DEF[key]) return;
  const u = player.upgrades;
  const lvl = u[key] || 0;
  const cost = 300 * (lvl + 1);
  const availSP = getAvailableSkillPoints();
  if (player.gold < cost) {
    dmgNum(player.x, player.y - 30, 'Мало золота!', '#f88');
    return;
  }
  if (availSP < 1) {
    dmgNum(player.x, player.y - 30, 'Мало очков навыка!', '#f88');
    return;
  }
  player.gold -= cost;
  u[key] = lvl + 1;
  recompute();
  netSaveProgress();
  if (typeof updateUpgradeUI === 'function') updateUpgradeUI();
  if (typeof updateProfileUI === 'function') updateProfileUI();
}

function gainXP(amount) {
  if ((player.buffs || {}).exp > 0) amount *= 2;
  player.xp += amount;
  while (player.xp >= player.xpNext) {
    player.xp -= player.xpNext;
    player.lvl++;
    player.xpNext = Math.floor(100 * Math.pow(1.38, player.lvl - 1));
    player.baseAtk += 3; player.baseDef += 1; player.baseMaxHp += 20;
    recompute();
    player.hp = Math.min(player.maxHp, player.hp + 35);
    dmgNum(player.x, player.y - 38, '↑ УРОВЕНЬ ' + player.lvl, '#ff0');
    dmgNum(player.x, player.y - 54, '+3 очка навыка', '#a0f0a0');
    spawnBurst(player.x, player.y, '#ff0', 14);
    if (typeof onLevelUp === 'function') onLevelUp(player.lvl);
  }
  netSaveProgress();
}

function equipItem(idx) {
  const it = player.inventory[idx]; if (!it) return;
  if (_isStackable(it) || it.slot === 'use') return;
  const old = player.equipment[it.slot];
  player.equipment[it.slot] = it;
  player.inventory.splice(idx, 1);
  if (old) player.inventory.push(old);
  recompute(); updateInvUI();
}

function unequipItem(slot) {
  const it = player.equipment[slot];
  if (!it || !invHasSpace()) return;
  player.inventory.push(it);
  player.equipment[slot] = null;
  recompute(); updateInvUI();
}

function usePotion() {
  if (!player || state !== 'playing') return;
  if ((player.potCd || 0) > 0) return;
  const bag = player.potionBag || {};
  const type = player.hudPotion || 'pt1';
  if ((bag[type] || 0) <= 0) return;
  if (player.hp >= player.maxHp) return;
  bag[type]--;
  const def = ITEM_DEF.find(i => i.id === type);
  const heal = (def && def.hp) || 20;
  player.hp = Math.min(player.maxHp, player.hp + heal);
  player.potCd = 4;
  dmgNum(player.x, player.y - 26, '+' + heal + '♥', '#4f4');
  spawnBurst(player.x, player.y, '#4f4', 5);
  if (typeof netUsePotion === 'function') netUsePotion(heal);
  if (typeof updateInvUI === 'function') updateInvUI();
  netSaveProgress();
}

function useBuffPotion(id) {
  if (!player || state !== 'playing') return;
  const def = ITEM_DEF.find(d => d.id === id);
  if (!def || def.slot !== 'buff_potion') return;
  const buffs = player.buffs || (player.buffs = {});
  const btype = def.buffType;
  // 30-min cooldown per buff type
  if ((buffs[btype] || 0) > 0) {
    dmgNum(player.x, player.y - 26, 'Уже активно!', '#f88');
    return;
  }
  if (!removeFromInventory(id, 1)) return;
  buffs[btype] = def.buffDur || 1800;
  recompute();
  if (player.hp > player.maxHp) player.hp = player.maxHp;
  dmgNum(player.x, player.y - 30, def.name + '!', '#f0c040');
  spawnBurst(player.x, player.y, '#f0c040', 6);
  if (typeof updateInvUI === 'function') updateInvUI();
  netSaveProgress();
}

// Return direction toward locked target or nearest enemy; fall back to joystick if active
function nearestEnemyDir() {
  const jl = Math.hypot(joy.dx, joy.dy);
  if (jl > 0.25) return { dx: joy.dx / jl, dy: joy.dy / jl };
  if (pvpMode && targetIsPlayer && targetId) {
    const op = otherPlayers.get(targetId);
    if (op && (op.hp || 0) > 0 && op.x != null) {
      const len = Math.max(1, dist(op.x, op.y, player.x, player.y));
      return { dx: (op.x - player.x) / len, dy: (op.y - player.y) / len };
    }
  }
  if (targetId && !targetIsPlayer) {
    const t = serverEnemies.find(e => e.id === targetId && (e.hp || 0) > 0);
    if (t) {
      const len = Math.max(1, dist(t.x, t.y, player.x, player.y));
      return { dx: (t.x - player.x) / len, dy: (t.y - player.y) / len };
    }
  }
  let closest = null, closestD = Infinity;
  serverEnemies.forEach(e => {
    if ((e.hp || 0) <= 0) return;
    const d = dist(e.x, e.y, player.x, player.y);
    if (d < closestD) { closestD = d; closest = e; }
  });
  if (pvpMode) {
    otherPlayers.forEach((op) => {
      if ((op.hp || 0) <= 0 || op.x == null) return;
      const d = dist(op.x, op.y, player.x, player.y);
      if (d < closestD) { closestD = d; closest = op; }
    });
  }
  if (!closest) return { dx: 1, dy: 0 };
  const len = Math.max(1, closestD);
  return { dx: (closest.x - player.x) / len, dy: (closest.y - player.y) / len };
}

function nearestEnemy() {
  let closest = null, closestD2 = Infinity;
  serverEnemies.forEach(e => {
    if ((e.hp || 0) <= 0) return;
    const dx = e.x - player.x, dy = e.y - player.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < closestD2) { closestD2 = d2; closest = e; }
  });
  return closest;
}

// Move player toward (tx, ty) in small steps, stopping before hitting a wall.
// Radius 12 matches normal movement collision.
function _dashTo(tx, ty) {
  const dx = tx - player.x, dy = ty - player.y;
  const d = Math.hypot(dx, dy);
  if (d < 1) return;
  const nx = dx / d, ny = dy / d;
  const R = 12, STEP = 8;
  let safeX = player.x, safeY = player.y;
  for (let s = STEP; s <= d + STEP; s += STEP) {
    const cx = player.x + nx * Math.min(s, d);
    const cy = player.y + ny * Math.min(s, d);
    // Check center + forward edge + two side edges
    if (isWall(cx + nx * R, cy + ny * R) ||
        isWall(cx - ny * R, cy + nx * R) ||
        isWall(cx + ny * R, cy - nx * R)) break;
    safeX = cx; safeY = cy;
  }
  player.x = safeX; player.y = safeY;
}

// Send attack to all server enemies within range
function _skillAOE(r) {
  serverEnemies.forEach(e => { if (dist(e.x, e.y, player.x, player.y) < r) netAttack(e.id); });
}

// PvP: return targeted/nearest other player as {id, op}, or null
function _pvpPlayerTarget() {
  if (!pvpMode) return null;
  if (targetIsPlayer && targetId) {
    const op = otherPlayers.get(targetId);
    if (op && (op.hp || 0) > 0 && op.x != null) return { id: targetId, op };
  }
  let best = null, bestId = null, bestD2 = Infinity;
  otherPlayers.forEach((op, id) => {
    if ((op.hp || 0) <= 0 || op.x == null) return;
    const dx = op.x - player.x, dy = op.y - player.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = op; bestId = id; }
  });
  return best ? { id: bestId, op: best } : null;
}

// PvP: skill damage AOE hitting all nearby other players
function _pvpSkillAOE(r, mult) {
  if (!pvpMode) return;
  otherPlayers.forEach((op, id) => {
    if ((op.hp || 0) <= 0 || op.x == null) return;
    if (dist(op.x, op.y, player.x, player.y) < r) netPvpSkillAttack(id, mult);
  });
}

// PvP: slow all nearby other players
function _pvpSkillSlow(r, duration) {
  if (!pvpMode) return;
  otherPlayers.forEach((op, id) => {
    if ((op.hp || 0) <= 0 || op.x == null) return;
    if (dist(op.x, op.y, player.x, player.y) < r) {
      op.slowTimer = duration;
      netPvpSkillCC(id, 'slow', duration);
    }
  });
}

// Send attack to enemies in joystick direction within range
function _skillDir(dx, dy, r, arcDot) {
  const len = Math.hypot(dx, dy) || 1;
  const nx = dx / len, ny = dy / len;
  serverEnemies.forEach(e => {
    const ex = e.x - player.x, ey = e.y - player.y;
    const d = Math.hypot(ex, ey);
    if (d > r || d < 1) return;
    if ((ex / d) * nx + (ey / d) * ny > (arcDot ?? 0.3)) netAttack(e.id);
  });
}

function useSkill(idx) {
  if (!player || state !== 'playing') return;
  if ((player.stunTimer || 0) > 0) return;
  const skills = SKILL_DEF[player.type];
  if (!skills || !skills[idx]) return;
  const sk = skills[idx];
  if ((player.skillCooldowns[sk.key] || 0) > 0) return;

  player.skillCooldowns[sk.key] = sk.cd;
  skillFlash = { key: sk.key, timer: 0.4 };
  player.atkAnimTimer = 0.675; player.castDuration = 0.675; player.animFrame = 0; player.animTimer = 0;

  if (player.type === 'warrior') {
    if (sk.key === 'Q') { // Shield Bash — ×2 single target + stun 3s
      const stunDur = 3 + _skillBuffSec('Q');
      const pvpTgt = _pvpPlayerTarget();
      if (pvpTgt) {
        spawnAOE(pvpTgt.op.x, pvpTgt.op.y, 50);
        netPvpSkillAttack(pvpTgt.id, 2 * _skillDmgMult('Q'));
        pvpTgt.op.stunTimer = stunDur;
        netPvpSkillCC(pvpTgt.id, 'stun', stunDur);
        faceTowards(pvpTgt.op.x, pvpTgt.op.y);
      } else {
        const tgt = nearestEnemy();
        if (tgt) {
          spawnAOE(tgt.x, tgt.y, 50);
          netSkillAttack(tgt.id, 2 * _skillDmgMult('Q'));
          tgt.stunTimer = stunDur;
          netSkillStun(tgt.id, stunDur);
          faceTowards(tgt.x, tgt.y);
        }
      }
      spawnBurst(player.x, player.y, '#8af', 8);
      dmgNum(player.x, player.y - 40, '🛡 Щит-удар!', '#8af');
    } else if (sk.key === 'W') { // Whirlwind — AOE 110
      spawnAOE(player.x, player.y, 110);
      _skillAOEMult(110, _skillDmgMult('W')); netSpawnAoe(player.x, player.y, 110);
      _pvpSkillAOE(110, _skillDmgMult('W'));
    } else if (sk.key === 'E') { // Battle Cry — +20% ATK 5s (+1s per level)
      battleCryTimer = 5 + _skillBuffSec('E');
      player.atk = Math.floor(player.atk * 1.20);
      if (typeof netStatsUpdate === 'function') netStatsUpdate(player.atk, player.def, player.maxHp);
      dmgNum(player.x, player.y - 40, '⚔ +20% ATK!', '#fa0');
      spawnBurst(player.x, player.y, '#fa0', 10);
    } else if (sk.key === 'R') { // Charge — dash 140px toward target/enemy, deal ×1.5 on arrival
      const _pvpR = _pvpPlayerTarget();
      let _rdx, _rdy, _chargeTarget = null, _chargePvpTarget = null;
      if (_pvpR) {
        _rdx = _pvpR.op.x - player.x; _rdy = _pvpR.op.y - player.y;
        _chargePvpTarget = _pvpR;
      } else {
        _chargeTarget = (targetId && !targetIsPlayer)
          ? serverEnemies.find(e => e.id === targetId && (e.hp || 0) > 0)
          : nearestEnemy();
        if (_chargeTarget) { _rdx = _chargeTarget.x - player.x; _rdy = _chargeTarget.y - player.y; }
        else { _rdx = joy.dx || 1; _rdy = joy.dy || 0; }
      }
      const len = Math.hypot(_rdx, _rdy) || 1;
      _dashTo(player.x + (_rdx / len) * 140, player.y + (_rdy / len) * 140);
      if (_chargePvpTarget) {
        netPvpSkillAttack(_chargePvpTarget.id, 1.5 * _skillDmgMult('R'));
        faceTowards(_chargePvpTarget.op.x, _chargePvpTarget.op.y);
        spawnAOE(_chargePvpTarget.op.x, _chargePvpTarget.op.y, 40);
      } else if (_chargeTarget) {
        netSkillAttack(_chargeTarget.id, 1.5 * _skillDmgMult('R'));
        faceTowards(_chargeTarget.x, _chargeTarget.y);
        spawnAOE(_chargeTarget.x, _chargeTarget.y, 40);
      }
      spawnBurst(player.x, player.y, '#5af', 8);
    }
  } else if (player.type === 'archer') {
    if (sk.key === 'Q') { // Multi-Shot — 3 arrows fan
      const dir = nearestEnemyDir();
      const base = Math.atan2(dir.dy, dir.dx);
      const dmgMult = _skillDmgMult('Q');
      [-0.35, 0, 0.35].forEach(off => {
        const ang = base + off;
        const p = { x: player.x, y: player.y, vx: Math.cos(ang)*380, vy: Math.sin(ang)*380,
          color: '#fa0', dmg: player.atk * dmgMult, pvpMult: dmgMult, life: 1.5, size: 5, isPlayer: true, projType: 'arrow', angle: ang };
        projs.push(p);
        netSpawnProj({ x: p.x, y: p.y, vx: p.vx, vy: p.vy, color: '#fa0', size: 5, projType: 'arrow', angle: ang, life: 1.5 });
      });
      _skillDirMult(dir.dx, dir.dy, 220, 0.1, dmgMult);
    } else if (sk.key === 'W') { // Combo Arrow — 3 arrows toward target
      const dir = nearestEnemyDir();
      const ang = Math.atan2(dir.dy, dir.dx);
      const dmgMult = _skillDmgMult('W');
      [0, 80, 160].forEach(delayMs => {
        setTimeout(() => {
          if (!player) return;
          projs.push({ x: player.x, y: player.y, vx: Math.cos(ang)*400, vy: Math.sin(ang)*400,
            color: '#fa8', dmg: player.atk * dmgMult, pvpMult: dmgMult, life: 1.5, size: 5, isPlayer: true, projType: 'arrow', angle: ang });
          netSpawnProj({ x: player.x, y: player.y, vx: Math.cos(ang)*400, vy: Math.sin(ang)*400,
            color: '#fa8', size: 5, projType: 'arrow', angle: ang, life: 1.5 });
        }, delayMs);
      });
      _skillDirMult(dir.dx, dir.dy, 240, 0.5, dmgMult);
    } else if (sk.key === 'E') { // Jump — dash 80px (+1s per level)
      dodgeTimer = 0.6 + _skillBuffSec('E');
      const dx = joy.dx || 0, dy = joy.dy || 0;
      const len = Math.hypot(dx, dy) || 1;
      _dashTo(player.x + (dx / len) * 80, player.y + (dy / len) * 80);
      spawnBurst(player.x, player.y, '#7e7', 6);
    } else if (sk.key === 'R') { // Attack Speed ×2 for 5s (+1s per level)
      atkSpeedTimer = 5 + _skillBuffSec('R');
      player.atkSpeed = (player.atkSpeed || player.charDef.atkSpeed) * 2;
      dmgNum(player.x, player.y - 40, '⚡ Скорость!', '#7ef');
      spawnBurst(player.x, player.y, '#7ef', 8);
    }
  } else if (player.type === 'mage') {
    if (sk.key === 'Q') { // Fireball — ×2 damage
      const dir = nearestEnemyDir();
      const ang = Math.atan2(dir.dy, dir.dx);
      const dmgMult = 2 * _skillDmgMult('Q');
      projs.push({ x: player.x, y: player.y, vx: Math.cos(ang)*340, vy: Math.sin(ang)*340,
        color: '#f60', dmg: player.atk * dmgMult, pvpMult: dmgMult, life: 2, size: 11, isPlayer: true, projType: 'ball', angle: ang });
      _skillDirMult(dir.dx, dir.dy, 160, 0.5, dmgMult);
      netSpawnProj({ x: player.x, y: player.y, vx: Math.cos(ang)*340, vy: Math.sin(ang)*340, color: '#f60', size: 11, projType: 'ball', angle: ang, life: 2 });
    } else if (sk.key === 'W') { // Ice Nova — AOE + slow 3s
      spawnAOE(player.x, player.y, 130);
      _skillAOEMult(130, _skillDmgMult('W')); netSpawnAoe(player.x, player.y, 130);
      const slowIds = [];
      serverEnemies.forEach(e => {
        if ((e.hp || 0) <= 0) return;
        if (dist(e.x, e.y, player.x, player.y) < 130) { e.slowTimer = 3; slowIds.push(e.id); }
      });
      if (slowIds.length) netSkillSlow(slowIds, 3);
      _pvpSkillAOE(130, _skillDmgMult('W'));
      _pvpSkillSlow(130, 3);
      dmgNum(player.x, player.y - 40, '❄ Заморозка!', '#8ef');
      spawnBurst(player.x, player.y, '#8ef', 12);
    } else if (sk.key === 'E') { // Barrier — +50% DEF for 3s (+1s per level)
      barrierTimer = 3 + _skillBuffSec('E');
      player.def = Math.floor(player.def * 1.5);
      if (typeof netStatsUpdate === 'function') netStatsUpdate(player.atk, player.def, player.maxHp);
      dmgNum(player.x, player.y - 40, '🔮 Барьер!', '#e8e');
      spawnBurst(player.x, player.y, '#e8e', 8);
    } else if (sk.key === 'R') { // Teleport (+10px per level)
      const dx = joy.dx || 0, dy = joy.dy || 0;
      const len = Math.hypot(dx, dy) || 1;
      const range = 180 + _skillMobRange('R');
      const tx = player.x + (dx / len) * range;
      const ty = player.y + (dy / len) * range;
      if (!isWall(tx, ty)) {
        spawnBurst(player.x, player.y, '#f4f', 6);
        player.x = tx; player.y = ty;
        spawnBurst(player.x, player.y, '#f4f', 6);
      }
    }
  } else if (player.type === 'priest') {
    if (sk.key === 'Q') { // Heal self — +20% maxHP (+1% per level)
      const heal = Math.round(player.maxHp * 0.2 * _skillHealMult('Q'));
      player.hp = Math.min(player.maxHp, player.hp + heal);
      dmgNum(player.x, player.y - 40, '+' + heal + '♥', '#ff4');
      spawnBurst(player.x, player.y, '#ff4', 8);
    } else if (sk.key === 'W') { // Оцепенение — stun nearest target 3s (+1s per level)
      const stunDur = 3 + _skillBuffSec('W');
      const pvpTgt = _pvpPlayerTarget();
      if (pvpTgt) {
        spawnAOE(pvpTgt.op.x, pvpTgt.op.y, 40);
        netPvpSkillAttack(pvpTgt.id, _skillDmgMult('W'));
        pvpTgt.op.stunTimer = stunDur;
        netPvpSkillCC(pvpTgt.id, 'stun', stunDur);
        faceTowards(pvpTgt.op.x, pvpTgt.op.y);
      } else {
        const tgt = nearestEnemy();
        if (tgt) {
          spawnAOE(tgt.x, tgt.y, 40);
          tgt.stunTimer = stunDur;
          netSkillStun(tgt.id, stunDur);
          faceTowards(tgt.x, tgt.y);
        }
      }
      spawnBurst(player.x, player.y, '#ff4', 8);
      dmgNum(player.x, player.y - 40, '✨ Оцепенение!', '#ff4');
    } else if (sk.key === 'E') { // Shield of Faith — +50% DEF self + party 4s (+1s per level)
      faithShieldTimer = 4 + _skillBuffSec('E');
      player.def = Math.floor(player.def * 1.5);
      if (typeof netStatsUpdate === 'function') netStatsUpdate(player.atk, player.def, player.maxHp);
      if (typeof netFaithShield === 'function') netFaithShield(faithShieldTimer);
      dmgNum(player.x, player.y - 40, '🛡 Щит веры!', '#ff4');
      spawnBurst(player.x, player.y, '#ff4', 10);
    } else if (sk.key === 'R') { // Prayer — +10% maxHP self + party (+1% per level)
      const healSelf = Math.round(player.maxHp * 0.10 * _skillHealMult('R'));
      player.hp = Math.min(player.maxHp, player.hp + healSelf);
      dmgNum(player.x, player.y - 50, '+' + healSelf + '♥ Молитва!', '#ff4');
      spawnBurst(player.x, player.y, '#ff4', 14);
      if (typeof netHealParty === 'function') {
        netHealParty(Math.round(player.maxHp * 0.10 * _skillHealMult('R')));
      }
    }
  } else if (player.type === 'assasin') {
    if (sk.key === 'Q') { // Shadow Strike — dash 80px toward enemy/player target
      const pvpTgt = _pvpPlayerTarget();
      if (pvpTgt) {
        const dx = pvpTgt.op.x - player.x, dy = pvpTgt.op.y - player.y;
        const len = Math.hypot(dx, dy) || 1;
        _dashTo(player.x + (dx / len) * 80, player.y + (dy / len) * 80);
      } else {
        const dir = nearestEnemyDir();
        const len = Math.hypot(dir.dx, dir.dy) || 1;
        _dashTo(player.x + (dir.dx / len) * 80, player.y + (dir.dy / len) * 80);
      }
      spawnBurst(player.x, player.y, '#a5f', 6);
    } else if (sk.key === 'W') { // Smoke Bomb — AOE 100 + slow 3s
      spawnAOE(player.x, player.y, 100);
      _skillAOEMult(100, _skillDmgMult('W')); netSpawnAoe(player.x, player.y, 100);
      const slowIds = [];
      serverEnemies.forEach(e => {
        if ((e.hp || 0) <= 0) return;
        if (dist(e.x, e.y, player.x, player.y) < 100) { e.slowTimer = 3; slowIds.push(e.id); }
      });
      if (slowIds.length) netSkillSlow(slowIds, 3);
      _pvpSkillAOE(100, _skillDmgMult('W'));
      _pvpSkillSlow(100, 3);
      dmgNum(player.x, player.y - 40, '💨 Дым!', '#a5f');
      spawnBurst(player.x, player.y, '#a5f', 8);
    } else if (sk.key === 'E') { // Invisibility 4s (+1s per level)
      invisTimer = 4 + _skillBuffSec('E');
      if (typeof netPlayerInvis === 'function') netPlayerInvis(true);
      dmgNum(player.x, player.y - 40, '👁 Невидимость!', '#a5f');
      spawnBurst(player.x, player.y, '#a5f', 6);
    } else if (sk.key === 'R') { // Death Strike — ×4 nearest target
      const pvpTgt = _pvpPlayerTarget();
      if (pvpTgt) {
        netPvpSkillAttack(pvpTgt.id, 4 * _skillDmgMult('R'));
        faceTowards(pvpTgt.op.x, pvpTgt.op.y);
        spawnAOE(pvpTgt.op.x, pvpTgt.op.y, 40);
      } else {
        const tgt = nearestEnemy();
        if (tgt) {
          netSkillAttack(tgt.id, 4 * _skillDmgMult('R'));
          faceTowards(tgt.x, tgt.y);
          spawnAOE(tgt.x, tgt.y, 40);
        }
      }
      dmgNum(player.x, player.y - 50, '💀 ×4 Удар!', '#f0f');
      spawnBurst(player.x, player.y, '#f0f', 10);
    }
  }
}

function _migrateInventory(inv) {
  const stacked = [];
  const matMap = {};
  inv.forEach(it => {
    if (_isStackable(it)) {
      if (matMap[it.id]) {
        matMap[it.id].qty = (matMap[it.id].qty || 1) + (it.qty || 1);
      } else {
        const entry = { ...it, qty: it.qty || 1 };
        matMap[it.id] = entry;
        stacked.push(entry);
      }
    } else {
      stacked.push(it);
    }
  });
  return stacked;
}

function restoreFromSave(data) {
  if (!player || !data) return;
  player.lvl      = data.lvl      || 1;
  player.xp       = data.xp       || 0;
  player.xpNext   = data.xpNext   || 100;
  player.gold     = data.gold     || 0;
  player.kills    = data.kills    || 0;
  // migrate old integer potions save → potionBag
  if (data.potionBag) {
    player.potionBag = { pt1: 0, pt2: 0, ...data.potionBag };
  } else {
    player.potionBag = { pt1: data.potions ?? 3, pt2: 0 };
  }
  player.hudPotion  = data.hudPotion  || 'pt1';
  player.buffs      = data.buffs      || {};
  player.potCd      = 0;
  player.autoHpPct  = data.autoHpPct  != null ? data.autoHpPct : 0.5;
  player.baseAtk  = data.baseAtk  || player.baseAtk;
  player.baseDef  = data.baseDef  || player.baseDef;
  player.baseMaxHp= data.baseMaxHp|| player.baseMaxHp;
  player.inventory  = _migrateInventory(data.inventory || []);
  player.upgrades = data.upgrades || { atk:0, def:0, hp:0, atkSpeed:0, critChance:0, critPower:0, hpRegen:0 };
  player.questIdx  = data.questIdx  || 0;
  player.questKills = data.questKills || {};

  // Migrate old save: armor → body
  const rawEq = data.equipment || {};
  if (rawEq.armor && !rawEq.body) rawEq.body = rawEq.armor;
  delete rawEq.armor;

  const blank = { weapon:null, helmet:null, body:null, gloves:null, boots:null, ring:null, belt:null };
  // strip removed slots from old saves
  const { offhand:_, legs:__, pendant:___, ...cleanEq } = rawEq;
  player.equipment = { ...blank, ...cleanEq };
  player.skillLevels = { Q:0, W:0, E:0, R:0, ...(data.skillLevels || {}) };
  player.skillXp     = { Q:0, W:0, E:0, R:0, ...(data.skillXp || {}) };
  recompute();
  player.hp = (data.hp && data.hp > 0) ? Math.min(data.hp, player.maxHp) : player.maxHp;
}

function statStr(it) {
  const p = [];
  if (it.atk)       p.push('ATK+' + it.atk);
  if (it.def)       p.push('DEF+' + it.def);
  if (it.hp)        p.push('HP+' + it.hp);
  if (it.critChance) p.push('Крит+' + (it.critChance * 100).toFixed(0) + '%');
  if (it.atkSpeed)   p.push('Скор+' + (it.atkSpeed   * 100).toFixed(0) + '%');
  if (it.hpPct)      p.push('HP+' +  (it.hpPct       * 100).toFixed(0) + '%макс');
  return p.join('  ');
}
