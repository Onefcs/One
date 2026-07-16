// ─────────────────────────────────────────────────────────
//  CAMERA
// ─────────────────────────────────────────────────────────
function clampCamera() {
  const visW = W / ZOOM, visH = (H - HEADER_H) / ZOOM;
  camera.x = clamp(camera.x, 0, Math.max(0, dungeon.w * TILE - visW));
  camera.y = clamp(camera.y, 0, Math.max(0, dungeon.h * TILE - visH));
}

function updateCamera(dt) {
  const visW = W / ZOOM, visH = (H - HEADER_H) / ZOOM;
  camera.x += (player.x - visW / 2 - camera.x) * Math.min(1, 8 * dt);
  camera.y += (player.y - visH / 2 - camera.y) * Math.min(1, 8 * dt);
  clampCamera();
}

// ─────────────────────────────────────────────────────────
//  UPDATE
// ─────────────────────────────────────────────────────────
function update(dt) {
  if (state !== 'playing') return;
  frameCount++;
  if (transTimer > 0) { transTimer -= dt; return; }

  const isOnline = !!(socket?.connected);
  const activeEnemies = isOnline ? serverEnemies : enemies;

  if (activeTab === 0) {
    if (player.atkAnimTimer <= 0.3) {
      const inp = inputDir();
      if (inp.len > 0) {
        const vx = inp.dx * player.speed * inp.len * dt;
        const vy = inp.dy * player.speed * inp.len * dt;
        if (canMoveX(player, vx, 12)) player.x += vx;
        if (canMoveY(player, vy, 12)) player.y += vy;
        const ax = Math.abs(inp.dx), ay = Math.abs(inp.dy);
        if (ax > ay * 0.8) player.facing = inp.dx > 0 ? 'right' : 'left';
        else               player.facing = inp.dy > 0 ? 'front' : 'back';
      }
    }
    // Push player out of enemies and other players
    activeEnemies.forEach(e => {
      if ((e.hp || 0) <= 0) return;
      const minD = e.size + 12;
      const ddx = player.x - e.x, ddy = player.y - e.y;
      const dd = Math.hypot(ddx, ddy);
      if (dd < minD && dd > 0.01) {
        const p2 = (minD - dd) / dd;
        if (canMoveX(player, ddx * p2, 12)) player.x += ddx * p2;
        if (canMoveY(player, ddy * p2, 12)) player.y += ddy * p2;
      }
    });
    if (isOnline) {
      Object.values(otherPlayers).forEach(op => {
        if ((op.hp || 0) <= 0 || op.x == null) return;
        const minD = 26;
        const ddx = player.x - op.x, ddy = player.y - op.y;
        const dd = Math.hypot(ddx, ddy);
        if (dd < minD && dd > 0.01) {
          const p2 = (minD - dd) / dd;
          if (canMoveX(player, ddx * p2, 12)) player.x += ddx * p2;
          if (canMoveY(player, ddy * p2, 12)) player.y += ddy * p2;
        }
      });
    }
    if (isOnline) netSendMove();
  }

  if (player.hurtTimer > 0) player.hurtTimer -= dt;
  if (swingTimer > 0)       swingTimer -= dt;
  if (player.atkAnimTimer > 0) player.atkAnimTimer -= dt;

  // advance sprite animation frame
  if (SPRITE_DEF[player.type]) {
    const ak = getSpriteAnimKey(player);
    const ad = SPRITE_DEF[player.type].anims[ak];
    if (ad) {
      player.animTimer += dt;
      const step = 1 / ad.fps;
      while (player.animTimer >= step) {
        player.animTimer -= step;
        const maxF = (spriteCache[player.type]?.[ak] || []).length || ad.n;
        if (ad.loop) { player.animFrame = (player.animFrame + 1) % maxF; }
        else if (player.animFrame < maxF - 1) { player.animFrame++; }
      }
    }
  }

  player.atkTimer -= dt;
  if (player.atkTimer <= 0) {
    let closest = null, closestD = Infinity;
    let closestIsPlayer = false;

    // Prefer locked target
    if (targetId && !targetIsPlayer) {
      const t = activeEnemies.find(e => e.id === targetId && (e.hp || 0) > 0);
      if (t) { closest = t; closestD = dist(t.x, t.y, player.x, player.y); }
    } else if (targetId && targetIsPlayer && pvpMode && isOnline) {
      const op = otherPlayers[targetId];
      if (op && (op.hp || 0) > 0 && op.x != null) {
        closest = { ...op, _socketId: targetId };
        closestD = dist(op.x, op.y, player.x, player.y);
        closestIsPlayer = true;
      }
    }

    // Fall back to nearest enemy
    if (!closest) {
      activeEnemies.forEach(e => {
        if ((e.hp || 0) <= 0) return;
        const d = dist(e.x, e.y, player.x, player.y);
        if (d < closestD) { closestD = d; closest = e; closestIsPlayer = false; }
      });
      // In PK mode also consider nearby players
      if (pvpMode && isOnline) {
        Object.entries(otherPlayers).forEach(([id, op]) => {
          if ((op.hp || 0) <= 0 || op.x == null) return;
          const d = dist(op.x, op.y, player.x, player.y);
          if (d < closestD) { closestD = d; closest = { ...op, _socketId: id }; closestIsPlayer = true; }
        });
      }
    }

    const atkRange = player.charDef.atkRange * (closestIsPlayer ? 1.3 : 1);
    if (!closest || closestD >= atkRange || !hasLOS(player.x, player.y, closest.x, closest.y)) {
      player.atkTimer = 0.15; // short poll interval when nothing in range / no LOS
    } else {
      // Auto-set target to whatever is being attacked
      if (!targetId) {
        targetId = closestIsPlayer ? closest._socketId : closest.id;
        targetIsPlayer = closestIsPlayer;
      }
      player.atkTimer = 1 / player.charDef.atkSpeed;
      if (closestIsPlayer) {
        faceTowards(closest.x, closest.y);
        swingAngle = Math.atan2(closest.y - player.y, closest.x - player.x);
        swingTimer = 0.18;
        player.atkAnimTimer = 0.55; player.animFrame = 0; player.animTimer = 0;
        netPvpAttack(closest._socketId);
        if (player.charDef.atkType === 'ranged') fireProj(closest.x, closest.y);
      } else if (isOnline) {
        netAttack(closest.id);
        faceTowards(closest.x, closest.y);
        swingAngle = Math.atan2(closest.y - player.y, closest.x - player.x);
        swingTimer = 0.18;
        player.atkAnimTimer = 0.55; player.animFrame = 0; player.animTimer = 0;
        if (player.charDef.atkType === 'ranged') fireProj(closest.x, closest.y);
      } else {
        if (player.charDef.atkType === 'ranged') fireProj(closest.x, closest.y);
        else doMeleeAttack(closest);
      }
    }
  }

  if (!isOnline) {
    const dead = [];
    enemies.forEach(e => {
      if (e.hurtTimer > 0) e.hurtTimer -= dt;
      const dp = dist(e.x, e.y, player.x, player.y);
      if (dp < e.aggroR) e.aggro = true;
      if (dp > e.aggroR * 2.2) e.aggro = false;
      if (e.aggro) {
        if (dp > e.size + 14) {
          const ex2 = (player.x - e.x) / dp, ey2 = (player.y - e.y) / dp;
          const er = e.size * 0.55, evx = ex2 * e.spd * dt, evy = ey2 * e.spd * dt;
          if (canMoveX(e, evx, er)) e.x += evx;
          if (canMoveY(e, evy, er)) e.y += evy;
        }
        e.atkTimer -= dt;
        if (dp < e.size + 20 && e.atkTimer <= 0 && hasLOS(e.x, e.y, player.x, player.y)) { e.atkTimer = 1.4 + Math.random() * 0.6; hitPlayer(e.atk); }
      }
      if (e.hp <= 0) dead.push(e);
    });

    dead.forEach(e => {
      if (e.id === targetId && !targetIsPlayer) { targetId = null; targetIsPlayer = false; }
      spawnBurst(e.x, e.y, e.color, 8);
      spawnDrops(e);
      gainXP(e.xp);
      player.kills++;
      deadEnemies.push({ ...e, hp: e.maxHp, respawnTimer: 10, aggro: false, hurtTimer: 0, atkTimer: 1 + Math.random() });
    });
    enemies = enemies.filter(e => e.hp > 0);

    const stillDead = [];
    deadEnemies.forEach(e => {
      e.respawnTimer -= dt;
      if (e.respawnTimer <= 0) {
        enemies.push({ ...e, x: e.spawnX, y: e.spawnY, hp: e.maxHp, hurtTimer: 0, aggro: false, atkTimer: 1 + Math.random() });
      } else {
        stillDead.push(e);
      }
    });
    deadEnemies = stillDead;

    projs = projs.filter(p => {
      p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
      if (p.life <= 0 || isWall(p.x, p.y)) return false;
      if (p.isPlayer) {
        let hit = false;
        enemies = enemies.filter(e => {
          if (hit) return true;
          if (dist(p.x, p.y, e.x, e.y) < e.size + p.size) {
            hitEnemy(e, p.dmg);
            if (e.hp <= 0) {
              spawnBurst(e.x, e.y, e.color, 8); spawnDrops(e); gainXP(e.xp); player.kills++;
              deadEnemies.push({ ...e, hp: e.maxHp, respawnTimer: 10, aggro: false, hurtTimer: 0, atkTimer: 1 + Math.random() });
            }
            hit = true; return e.hp > 0;
          }
          return true;
        });
        return !hit;
      }
      return true;
    });
  } else {
    // Online: advance projectiles with visual hit detection
    projs = projs.filter(p => {
      p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
      if (p.life <= 0 || isWall(p.x, p.y)) return false;
      if (p.isPlayer) {
        const hitE = serverEnemies.find(e => (e.hp || 0) > 0 && dist(p.x, p.y, e.x, e.y) < e.size + p.size);
        if (hitE) { spawnBurst(p.x, p.y, p.color, 5); return false; }
        if (pvpMode) {
          const hitP = Object.values(otherPlayers).find(op => (op.hp || 0) > 0 && op.x != null && dist(p.x, p.y, op.x, op.y) < 18 + p.size);
          if (hitP) { spawnBurst(p.x, p.y, p.color, 5); return false; }
        }
      }
      return true;
    });
    otherProjs = otherProjs.filter(p => {
      p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
      if (p.life <= 0 || isWall(p.x, p.y)) return false;
      const hitE = serverEnemies.find(e => (e.hp || 0) > 0 && dist(p.x, p.y, e.x, e.y) < e.size + p.size);
      if (hitE) { spawnBurst(p.x, p.y, p.color, 5); return false; }
      if (player && state === 'playing' && dist(p.x, p.y, player.x, player.y) < 14 + p.size) {
        spawnBurst(p.x, p.y, p.color, 5); return false;
      }
      return true;
    });
  }

  drops = drops.filter(d => {
    d.life -= dt;
    if (d.life <= 0) return false;
    if (dist(player.x, player.y, d.x, d.y) < 30) { pickup(d); return false; }
    return true;
  });

  particles = particles.filter(p => { p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; return p.life > 0; });
  dmgNums = dmgNums.filter(d => { d.y += d.vy * dt; d.life -= dt; return d.life > 0; });

  // Skill timers
  if (player.skillCooldowns) {
    const cds = player.skillCooldowns;
    if (cds.Q > 0) cds.Q -= dt;
    if (cds.W > 0) cds.W -= dt;
    if (cds.E > 0) cds.E -= dt;
    if (cds.R > 0) cds.R -= dt;
  }
  if (barrierTimer > 0) barrierTimer -= dt;
  if (battleCryTimer > 0) battleCryTimer -= dt;
  if (dodgeTimer > 0) dodgeTimer -= dt;
  if (skillFlash) { skillFlash.timer -= dt; if (skillFlash.timer <= 0) skillFlash = null; }

  // Clear stale target
  if (targetId) {
    if (targetIsPlayer) {
      const op = otherPlayers[targetId];
      if (!op || (op.hp || 0) <= 0) { targetId = null; targetIsPlayer = false; }
    } else {
      const te = activeEnemies.find(e => e.id === targetId);
      if (!te || (te.hp || 0) <= 0) { targetId = null; targetIsPlayer = false; }
    }
  }

  // NPC proximity
  nearNpc = null;
  npcs.forEach(n => { if (dist(player.x, player.y, n.x, n.y) < 65) nearNpc = n; });
  const talkBtn = document.getElementById('npc-talk-btn');
  if (talkBtn) talkBtn.style.display = (nearNpc && activeTab === 0) ? 'block' : 'none';

  // Smooth lerp toward latest server positions (no buffer delay, no jitter)
  if (isOnline) {
    const lk = Math.min(1, 16 * dt);
    Object.entries(otherPlayers).forEach(([id, op]) => {
      if (op.targetX !== undefined) {
        const prevX = op.x, prevY = op.y;
        op.x += (op.targetX - op.x) * lk;
        op.y += (op.targetY - op.y) * lk;
        op.moving = Math.hypot(op.x - prevX, op.y - prevY) > 0.5;
      }
      if ((op.hurtTimer || 0) > 0) op.hurtTimer -= dt;
      if ((op.atkAnimTimer || 0) > 0) op.atkAnimTimer -= dt;
      if (op.type && SPRITE_DEF[op.type]) {
        if (op.animFrame === undefined) { op.animFrame = 0; op.animTimer = 0; }
        const ak = getOtherPlayerAnimKey(op);
        if (ak !== op._prevAnimKey) { op.animFrame = 0; op.animTimer = 0; op._prevAnimKey = ak; }
        const ad = SPRITE_DEF[op.type].anims[ak];
        if (ad) {
          op.animTimer = (op.animTimer || 0) + dt;
          const step = 1 / ad.fps;
          while (op.animTimer >= step) {
            op.animTimer -= step;
            const maxF = (spriteCache[op.type]?.[ak] || []).length || ad.n;
            if (ad.loop) { op.animFrame = (op.animFrame + 1) % maxF; }
            else if (op.animFrame < maxF - 1) { op.animFrame++; }
          }
        }
      }
    });
    serverEnemies.forEach(e => {
      if (e.targetX !== undefined) {
        e.x += (e.targetX - e.x) * lk;
        e.y += (e.targetY - e.y) * lk;
      }
    });
  }

  updateCamera(dt);
}

// ─────────────────────────────────────────────────────────
//  RENDER
// ─────────────────────────────────────────────────────────
function render() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const theme = (state === 'playing' || state === 'dead') && dungeon ? getTheme(dungeonLvl) : null;
  ctx.fillStyle = theme ? theme.bg : '#060610';
  ctx.fillRect(0, 0, W, H);
  if (state === 'select') return;

  ctx.save(); // [camera]
  ctx.beginPath(); ctx.rect(0, HEADER_H, W, H - HEADER_H); ctx.clip();
  ctx.translate(0, HEADER_H);
  ctx.scale(ZOOM, ZOOM);
  ctx.translate(-Math.round(camera.x), -Math.round(camera.y));

  if (tileCanvas) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tileCanvas, 0, 0);
  }

  // NPCs
  drawNpcs();

  // Drops
  drops.forEach(d => {
    ctx.save(); ctx.globalAlpha = Math.min(1, d.life * 1.5) * (0.85 + 0.15 * Math.sin(frameCount * .12));
    const bob = Math.sin(frameCount * .09) * 3;
    if (d.type === 'gold') {
      ctx.fillStyle = '#ff0'; ctx.beginPath(); ctx.arc(d.x, d.y + bob, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#a80'; ctx.font = 'bold 9px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(d.amount + 'g', d.x, d.y + bob);
    } else {
      ctx.font = '20px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(d.item.emoji, d.x, d.y + bob);
    }
    ctx.restore();
  });

  // Particles
  particles.forEach(p => { ctx.globalAlpha = Math.max(0, p.life); ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill(); });
  ctx.globalAlpha = 1;

  // Enemies (authoritative source depends on online/offline mode)
  const drawEnemyList = socket?.connected ? serverEnemies : enemies;
  drawEnemyList.forEach(e => {
    const hurt = e.hurtTimer > 0;
    // Selection ring
    if (e.id === targetId && !targetIsPlayer) {
      const pulse = 0.5 + 0.5 * Math.sin(frameCount * 0.15);
      ctx.save();
      ctx.strokeStyle = `rgba(255,60,60,${0.65 + 0.35 * pulse})`;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.arc(e.x, e.y, e.size + 8 + pulse * 3, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
    ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.beginPath(); ctx.ellipse(e.x, e.y + e.size, e.size * .8, e.size * .3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = hurt ? '#fff' : e.color; ctx.beginPath(); ctx.arc(e.x, e.y, e.size, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.arc(e.x - e.size * .3, e.y - e.size * .18, e.size * .18, 0, Math.PI * 2); ctx.arc(e.x + e.size * .3, e.y - e.size * .18, e.size * .18, 0, Math.PI * 2); ctx.fill();
    if (e.isBoss) {
      ctx.strokeStyle = `rgba(255,50,50,${0.6 + 0.4 * Math.sin(frameCount * .1)})`; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(e.x, e.y, e.size + 5, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#f44'; ctx.font = 'bold 9px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillText('БОСС', e.x, e.y - e.size - 16);
    }
    const bw = e.size * 2.6, bh = 5, bx = e.x - bw / 2, by = e.y - e.size - 13;
    ctx.fillStyle = '#400'; ctx.fillRect(bx, by, bw, bh);
    const pct = e.hp / e.maxHp;
    ctx.fillStyle = pct > .5 ? '#2d2' : pct > .25 ? '#da2' : '#d22';
    ctx.fillRect(bx, by, bw * pct, bh);
  });

  // Other players (online only)
  if (socket?.connected) {
    Object.entries(otherPlayers).forEach(([pid, p]) => {
      if (p.x == null || isNaN(p.x)) return;

      // Selection ring
      if (pid === targetId && targetIsPlayer) {
        const pulse = 0.5 + 0.5 * Math.sin(frameCount * 0.15);
        ctx.save();
        ctx.strokeStyle = `rgba(255,80,80,${0.65 + 0.35 * pulse})`;
        ctx.lineWidth = 2.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.arc(p.x, p.y, 22 + pulse * 3, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }

      const usedSprite = drawOtherPlayerSprite(p);
      if (!usedSprite) {
        ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.ellipse(p.x, p.y + 14, 11, 4, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = p.type === 'warrior' ? '#5af' : p.type === 'archer' ? '#7e7' : p.type === 'mage' ? '#e8e' : '#aaa';
        ctx.beginPath(); ctx.arc(p.x, p.y, 14, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 2; ctx.stroke();
      }
      // Name above HP bar, bar close to player
      const bh = 4, bw = 38;
      const barTop = usedSprite ? p.y - 46 : p.y - 20;
      const bx = p.x - bw / 2;
      const nameY = barTop - 4;
      ctx.font = 'bold 10px system-ui, Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
      ctx.strokeText(p.username || '?', p.x, nameY);
      ctx.fillStyle = p.pvpMode ? '#f99' : '#fff';
      ctx.fillText(p.username || '?', p.x, nameY);
      if (p.pvpMode) {
        ctx.font = '9px system-ui, Arial'; ctx.textAlign = 'left'; ctx.fillStyle = '#f55';
        ctx.fillText('⚔', p.x + bw / 2 + 2, nameY);
      }
      ctx.fillStyle = '#300'; ctx.fillRect(bx, barTop, bw, bh);
      ctx.fillStyle = '#2d2'; ctx.fillRect(bx, barTop, bw * Math.max(0, (p.hp || 0) / (p.maxHp || 1)), bh);
    });
  }

  // Projectiles (local + other players')
  [...projs, ...otherProjs].forEach(p => {
    ctx.globalAlpha = 1;
    if (p.projType === 'arrow') {
      const ang = p.angle ?? Math.atan2(p.vy, p.vx);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(ang);
      ctx.strokeStyle = p.color || '#fa0';
      ctx.lineWidth = 2.5; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-13, 0); ctx.lineTo(9, 0); ctx.stroke();
      ctx.fillStyle = p.color || '#fa0';
      ctx.beginPath(); ctx.moveTo(13, 0); ctx.lineTo(6, -3.5); ctx.lineTo(6, 3.5); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(-13, 0); ctx.lineTo(-8, -4); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-13, 0); ctx.lineTo(-8,  4); ctx.stroke();
      ctx.restore();
    } else {
      ctx.globalAlpha = 0.3; ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size + 7, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.8; ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.9; ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size * 0.38, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }
  });

  // Player
  const phurt = player.hurtTimer > 0 && (frameCount % 6 < 3);
  {
    const usedSprite = !phurt && drawSprite(player);
    if (!phurt && !usedSprite) {
      ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.beginPath(); ctx.ellipse(player.x, player.y + 14, 11, 4, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = player.charDef.color; ctx.beginPath(); ctx.arc(player.x, player.y, 14, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.4)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(player.x, player.y, 14, 0, Math.PI * 2); ctx.stroke();
      const fdx = joy.dx || (keys['ArrowRight'] || keys['d'] ? 1 : keys['ArrowLeft'] || keys['a'] ? -1 : 1);
      const fdy = joy.dy || (keys['ArrowDown'] || keys['s'] ? 1 : keys['ArrowUp'] || keys['w'] ? -1 : 0);
      const fl = Math.hypot(fdx, fdy) || 1;
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(player.x + fdx / fl * 8, player.y + fdy / fl * 8, 3.5, 0, Math.PI * 2); ctx.fill();
    }
    if (!phurt && swingTimer > 0) {
      ctx.strokeStyle = 'rgba(200,220,255,.75)';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(player.x, player.y, 34, swingAngle - .7, swingAngle + .7); ctx.stroke();
    }

    // Name + HP bar above player
    const barTop = usedSprite ? player.y - 46 : player.y - 28;
    const bw = 44, bh = 4, bx2 = player.x - bw / 2;
    const nameY = barTop - 4;
    const hpPct = Math.max(0, Math.min(1, player.hp / player.maxHp));
    const displayName = (netUsername || player.charDef.name).slice(0, 16);

    ctx.font = 'bold 10px system-ui, Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
    ctx.strokeText(displayName, player.x, nameY);
    ctx.fillStyle = pvpMode ? '#f99' : '#7cf';
    ctx.fillText(displayName, player.x, nameY);
    if (pvpMode) {
      ctx.font = '9px system-ui, Arial'; ctx.textAlign = 'left'; ctx.fillStyle = '#f55';
      ctx.fillText('⚔', player.x + bw / 2 + 2, nameY);
    }

    ctx.fillStyle = 'rgba(30,0,0,0.75)'; ctx.fillRect(bx2, barTop, bw, bh);
    if (hpPct > 0) {
      const hg = ctx.createLinearGradient(bx2, 0, bx2 + bw, 0);
      if (hpPct > 0.5) { hg.addColorStop(0, '#0d7a2e'); hg.addColorStop(1, '#2ecc71'); }
      else if (hpPct > 0.25) { hg.addColorStop(0, '#8c5500'); hg.addColorStop(1, '#f39c12'); }
      else { hg.addColorStop(0, '#7b1010'); hg.addColorStop(1, '#e74c3c'); }
      ctx.fillStyle = hg;
      ctx.fillRect(bx2, barTop, bw * hpPct, bh);
    }
  }

  // Damage numbers
  dmgNums.forEach(d => {
    ctx.globalAlpha = Math.min(1, d.life * 1.5);
    ctx.fillStyle = d.color;
    const fs = isNaN(d.text) ? 12 : 15;
    ctx.font = `bold ${fs}px Arial`; ctx.textAlign = 'center';
    ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.strokeText(d.text, d.x, d.y); ctx.fillText(d.text, d.x, d.y);
  });
  ctx.globalAlpha = 1;
  ctx.restore(); // [camera]

  drawHeader();
  drawPvpButton();
  drawTargetFrame();
  if (activeTab === 0) {
    drawJoystick();
    drawSkillButtons();
    drawPotionButton();
    drawTargetButton();
  }
  if (state === 'dead') drawDead();

  if (transTimer > 0) {
    ctx.fillStyle = `rgba(180,120,255,${Math.min(1, transTimer * 3)})`; ctx.fillRect(0, 0, W, H);
  }
}

// ─────────────────────────────────────────────────────────
//  GAME FLOW
// ─────────────────────────────────────────────────────────
function goToFloor(n) {
  if (n === dungeonLvl || !player) return;
  if (socket?.connected) {
    netSaveProgress();
    netSendChangeFloor(clamp(n, 1, 20));
    setTab(0);
  } else {
    dungeonLvl = clamp(n, 1, 20);
    netSaveProgress();
    transTimer = 0.5;
    loadLevel();
    setTab(0);
  }
}

function selectChar(type) {
  joy.active = false; joy.dx = 0; joy.dy = 0;
  player = makePlayer(type);
  dungeonLvl = 1;

  if (socket?.connected) {
    const savedStats = (typeof _savedData !== 'undefined' && _savedData?.type === type) ? _savedData : null;

    csStartLoading(type, () => {
      initNpcs();
      _finishOnlineStart();
    });

    // Start loading sprites early; gate opens when both sprites + server ready
    loadSprites(type, csOnSpritesReady);
    netSelectChar(type, savedStats);
  } else {
    const offlineRestore = (typeof _savedData !== 'undefined' && _savedData?.type === type) ? _savedData : null;

    csStartLoading(type, () => {
      csHide();
      document.getElementById('bottom-nav').style.display = 'block';
      document.querySelectorAll('.bpanel').forEach(p => { p.style.display = 'block'; });
      state = 'playing';
      setTab(0);
    });

    loadSprites(type, () => {
      if (offlineRestore) { restoreFromSave(offlineRestore); _savedData = null; }
      loadLevel();
      // Offline has no server, mark both conditions ready
      csOnSpritesReady();
      csOnServerReady();
    });
  }
}

// Returns the interpolated {x, y} for an entity at (now - INTERP_DELAY),
// using two buffered snapshots to linearly interpolate between them.
function getOtherPlayerAnimKey(p) {
  if ((p.hp ?? 1) <= 0) return 'die';
  const dir = p.facing || 'front';
  if ((p.hurtTimer || 0) > 0.08) return `${dir}-hurt`;
  if ((p.atkAnimTimer || 0) > 0) return `${dir}-attack`;
  if (p.moving) return `${dir}-run`;
  return `${dir}-idle`;
}

function drawOtherPlayerSprite(p) {
  const cache = spriteCache[p.type];
  if (!cache) return false;
  const key = getOtherPlayerAnimKey(p);
  const frames = cache[key];
  if (!frames || frames.length === 0) return false;
  const fi = Math.min(Math.floor(p.animFrame || 0), frames.length - 1);
  const img = frames[fi];
  if (!img || !img.complete || img.naturalWidth === 0) return false;
  const sz = 80;
  ctx.fillStyle = 'rgba(0,0,0,.3)';
  ctx.beginPath(); ctx.ellipse(p.x, p.y + 18, 13, 5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.drawImage(img, p.x - sz / 2, p.y - sz * 0.62, sz, sz);
  return true;
}

// ─────────────────────────────────────────────────────────
//  NPCs
// ─────────────────────────────────────────────────────────
function initNpcs() {
  if (!dungeon) return;
  const sx = dungeon.spawn.x, sy = dungeon.spawn.y;
  const offsets = [
    { dx: -TILE * 2, dy: 0 },
    { dx: 0,         dy: -TILE * 2 },
    { dx: TILE * 2,  dy: 0 },
  ];
  npcs = NPC_DEF.map((def, i) => ({
    ...def,
    x: sx + offsets[i].dx,
    y: sy + offsets[i].dy,
  }));
}

function drawNpcs() {
  if (!npcs.length) return;
  const F = 'system-ui, -apple-system, Arial';
  npcs.forEach(n => {
    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath(); ctx.ellipse(n.x, n.y + 18, 14, 5, 0, 0, Math.PI * 2); ctx.fill();

    // Glow ring
    const pulse = 0.7 + 0.3 * Math.sin(frameCount * 0.08);
    ctx.strokeStyle = n.color + Math.round(pulse * 80).toString(16).padStart(2, '0');
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(n.x, n.y, 22, 0, Math.PI * 2); ctx.stroke();

    // Emoji
    ctx.font = `28px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(n.emoji, n.x, n.y);

    // Name label
    ctx.font = `bold 10px ${F}`; ctx.textBaseline = 'alphabetic';
    ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
    ctx.strokeText(n.name, n.x, n.y - 26);
    ctx.fillStyle = n.color;
    ctx.fillText(n.name, n.x, n.y - 26);

    // Dialog icon when player is near
    if (nearNpc && nearNpc.id === n.id) {
      const bounce = Math.sin(frameCount * 0.15) * 3;
      ctx.font = `18px ${F}`; ctx.textBaseline = 'middle';
      ctx.fillText('💬', n.x, n.y - 44 + bounce);
    }
  });
}

function buildTileCanvas() {
  if (!dungeon) return;
  const th = getTheme(dungeonLvl);
  tileCanvas = document.createElement('canvas');
  tileCanvas.width = dungeon.w * TILE;
  tileCanvas.height = dungeon.h * TILE;
  const tctx = tileCanvas.getContext('2d');
  for (let ty = 0; ty < dungeon.h; ty++) {
    for (let tx = 0; tx < dungeon.w; tx++) {
      const t = dungeon.grid[ty][tx];
      if (t === WALL) th.drawWall(tctx, tx * TILE, ty * TILE, 0);
      else            th.drawFloor(tctx, tx * TILE, ty * TILE, 0);
    }
  }
}

function loadLevel() {
  // Cache dungeon layout per floor so revisiting keeps the same map
  if (!floorCache[dungeonLvl]) {
    floorCache[dungeonLvl] = generateDungeon(dungeonLvl);
  }
  dungeon = floorCache[dungeonLvl];
  // Reset enemies to fresh state (full HP, original positions)
  enemies = dungeon.enemies.map(e => ({
    ...e, hp: e.maxHp, hurtTimer: 0, aggro: false, atkTimer: 1 + Math.random()
  }));
  deadEnemies = [];
  projs = []; drops = []; particles = []; dmgNums = [];
  player.x = dungeon.spawn.x; player.y = dungeon.spawn.y;
  if (dungeonLvl > 1) player.hp = Math.min(player.maxHp, player.hp + Math.floor(player.maxHp * .25));
  camera.x = player.x - W / (2 * ZOOM); camera.y = player.y - (H - HEADER_H) / (2 * ZOOM);
  clampCamera();
  buildTileCanvas();
  initNpcs();
}

function playerDie() {
  state = 'dead';
  const modal = document.getElementById('death-modal');
  if (!modal) return;
  const xpLoss = Math.floor((player?.xp || 0) * 0.05);
  const info = document.getElementById('death-info');
  if (info && player) {
    info.innerHTML =
      `${getTheme(dungeonLvl).name} · Этаж ${dungeonLvl}<br>` +
      `💰 ${player.gold} золота · ⚔ ${player.kills} убито` +
      (xpLoss > 0 ? `<br><span style="color:#c66">−${xpLoss} XP при возрождении</span>` : '');
  }
  modal.style.display = 'flex';
}

function respawnPlayer() {
  if (!player || state !== 'dead') return;
  const xpLoss = Math.floor(player.xp * 0.05);
  player.xp = Math.max(0, player.xp - xpLoss);
  player.hp = player.maxHp;
  player.hurtTimer = 0;
  player.atkTimer = 0.5;
  if (dungeon) { player.x = dungeon.spawn.x; player.y = dungeon.spawn.y; }
  camera.x = player.x - W / (2 * ZOOM); camera.y = player.y - (H - HEADER_H) / (2 * ZOOM);
  clampCamera();
  state = 'playing';
  document.getElementById('death-modal').style.display = 'none';
  if (xpLoss > 0) dmgNum(player.x, player.y - 30, `−${xpLoss} XP`, '#a88');
  if (socket?.connected)
    socket.emit('playerMove', { x: player.x, y: player.y, facing: player.facing, hp: player.hp, maxHp: player.maxHp });
  netSaveProgress();
}

function restartGame() {
  if (state !== 'dead') return;
  document.getElementById('death-modal').style.display = 'none';
  targetId = null; targetIsPlayer = false; pvpMode = false;
  serverEnemies = []; otherPlayers = {};
  npcs = []; nearNpc = null;
  Object.keys(floorCache).forEach(k => delete floorCache[k]);
  tileCanvas = null;
  document.getElementById('bottom-nav').style.display = 'none';
  document.querySelectorAll('.bpanel').forEach(p => { p.classList.remove('open'); p.style.display = 'none'; });
  setTab(0);
  player = null; dungeonLvl = 1;
  enemies = []; projs = []; drops = []; particles = []; dmgNums = [];
  deadEnemies = [];
  state = 'select';
  csShow(null);
}

// ─────────────────────────────────────────────────────────
//  LOOP
// ─────────────────────────────────────────────────────────
function loop(ts) {
  const dt = Math.min((ts - lastTs) / 1000, .05); lastTs = ts;
  update(dt); render();
  requestAnimationFrame(loop);
}

window.addEventListener('beforeunload', () => { netSaveProgress(); });

window.addEventListener('load', () => {
  canvas = document.getElementById('canvas');
  ctx = canvas.getContext('2d');
  const app = document.getElementById('app');
  const resize = () => {
    DPR = window.devicePixelRatio || 1;
    W = app.clientWidth;
    H = app.clientHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (dungeon) clampCamera();
  };
  resize(); window.addEventListener('resize', resize);
  initInput();
  requestAnimationFrame(ts => { lastTs = ts; requestAnimationFrame(loop); });
});
