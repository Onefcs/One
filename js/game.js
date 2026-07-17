// Cached DOM elements (set once after DOMContentLoaded)
let _talkBtn = null;

// ─── Performance overlay ───────────────────────────────────
let _perfShow = false;          // toggle with triple-tap top-left corner
let _perfTapCount = 0, _perfTapTs = 0;
// Rolling 60-frame buffer for frame times (ms)
const _FT_BUF = new Float32Array(60);
let _ftIdx = 0, _ftFull = false;
// Rolling max frame time — highlights spikes
let _ftWorstMs = 0, _ftWorstDecay = 0;

function _perfToggleTap(cx, cy) {
  if (cx > 80 || cy > 80) return; // only top-left corner
  const now = performance.now();
  if (now - _perfTapTs > 800) _perfTapCount = 0;
  _perfTapTs = now;
  if (++_perfTapCount >= 3) { _perfShow = !_perfShow; _perfTapCount = 0; }
}

function _drawPerf(frameMs) {
  // Store frame time
  _FT_BUF[_ftIdx] = frameMs;
  _ftIdx = (_ftIdx + 1) % 60;
  if (_ftIdx === 0) _ftFull = true;
  const samples = _ftFull ? 60 : _ftIdx || 1;
  let sum = 0, maxFt = 0;
  for (let i = 0; i < samples; i++) {
    sum += _FT_BUF[i];
    if (_FT_BUF[i] > maxFt) maxFt = _FT_BUF[i];
  }
  const avgMs = sum / samples;
  const fps = avgMs > 0 ? Math.round(1000 / avgMs) : 0;
  // Decay worst-case slowly
  if (maxFt > _ftWorstMs) { _ftWorstMs = maxFt; _ftWorstDecay = 180; }
  else if (--_ftWorstDecay <= 0) { _ftWorstMs = maxFt; }

  if (!_perfShow) return;

  // Mini frame-time bar graph (60 bars)
  const bw = 2, bh = 40, bx0 = 8, by0 = 55;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(bx0 - 2, by0 - bh - 2, samples * bw + 4, bh + 4 + 52);

  const _oldest = _ftFull ? _ftIdx : 0;
  for (let i = 0; i < samples; i++) {
    const ft = _FT_BUF[(_oldest + i) % 60];
    const h = Math.min(bh, ft / 33.3 * bh);
    ctx.fillStyle = ft > 25 ? '#f55' : ft > 16.7 ? '#fa0' : '#4d4';
    ctx.fillRect(bx0 + i * bw, by0 - h, bw - 1, h);
  }
  // 60fps line
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.fillRect(bx0 - 2, by0 - bh * (16.7 / 33.3), samples * bw + 4, 1);

  // Text stats
  const mem = performance.memory;
  const lines = [
    `FPS  ${fps}`,
    `avg  ${avgMs.toFixed(1)}ms`,
    `max  ${_ftWorstMs.toFixed(1)}ms`,
    `prt  ${particles.length}`,
    `enm  ${_visEnm}/${serverEnemies.length}`,
    `opl  ${otherPlayers.size}`,
    `drp  ${drops.length}`,
    mem ? `mem  ${(mem.usedJSHeapSize / 1048576).toFixed(0)}MB` : '',
  ];
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  const ty0 = by0 + 6;
  lines.forEach((ln, i) => {
    if (!ln) return;
    ctx.fillStyle = '#000';
    ctx.fillText(ln, bx0 + 1, ty0 + i * 14 + 1);
    ctx.fillStyle = i === 0 ? (fps < 40 ? '#f55' : fps < 55 ? '#fa0' : '#4f4') : '#ddd';
    ctx.fillText(ln, bx0, ty0 + i * 14);
  });
}

// Offscreen UI canvas — rebuilt on wall-clock schedule (~20fps), blitted every frame
let _uiCanvas = null, _uiCtx = null, _uiLastMs = 0;

// Reusable sentinel for pvp closest-target — avoids per-frame object spread
const _pvpSentinel = { _socketId: null, x: 0, y: 0 };

// Visible enemy count (set each render frame, read by _drawPerf)
let _visEnm = 0;
// Squared lerp radius: enemies beyond this snap to target (they're off-screen anyway)
const _LERP_R2 = 700 * 700;

// Reusable dash arrays — declared once, never reallocated
const _DASH = [6, 4];
const _NO_DASH = [];
// Damage-number fonts — only two possible sizes, precompute to avoid template literals
const _FONT_DMGNUM = 'bold 15px Arial';
const _FONT_DMGTXT = 'bold 12px Arial';

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
  camera.x += (player.x - visW / 2 - camera.x) * Math.min(1, 5 * dt);
  camera.y += (player.y - visH / 2 - camera.y) * Math.min(1, 5 * dt);
  clampCamera();
}

// ─────────────────────────────────────────────────────────
//  UPDATE
// ─────────────────────────────────────────────────────────
function update(dt) {
  if (state !== 'playing') return;
  frameCount++;
  if (transTimer > 0) { transTimer -= dt; return; }

  if (activeTab === 0) {
    if (player.atkAnimTimer <= 0) {
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

    // Push player out of enemies
    serverEnemies.forEach(e => {
      if ((e.hp || 0) <= 0) return;
      const minD = e.size + 12;
      const ddx = player.x - e.x, ddy = player.y - e.y;
      if (ddx * ddx + ddy * ddy >= minD * minD) return; // squared-dist fast reject
      const dd = Math.hypot(ddx, ddy);
      if (dd > 0.01) {
        const p2 = (minD - dd) / dd;
        if (canMoveX(player, ddx * p2, 12)) player.x += ddx * p2;
        if (canMoveY(player, ddy * p2, 12)) player.y += ddy * p2;
      }
    });

    // Push player out of other players
    otherPlayers.forEach(op => {
      if ((op.hp || 0) <= 0 || op.x == null) return;
      const minD = 26;
      const ddx = player.x - op.x, ddy = player.y - op.y;
      if (ddx * ddx + ddy * ddy >= minD * minD) return; // squared fast-reject avoids Math.hypot
      const dd = Math.hypot(ddx, ddy);
      if (dd < minD && dd > 0.01) {
        const p2 = (minD - dd) / dd;
        if (canMoveX(player, ddx * p2, 12)) player.x += ddx * p2;
        if (canMoveY(player, ddy * p2, 12)) player.y += ddy * p2;
      }
    });

    netSendMove();
  }

  if (player.hurtTimer > 0) player.hurtTimer -= dt;
  if (swingTimer > 0)       swingTimer -= dt;
  if (player.atkAnimTimer > 0) player.atkAnimTimer -= dt;
  if (partyInvitePending) {
    partyInvitePending.timer -= dt;
    if (partyInvitePending.timer <= 0) partyInvitePending = null;
  }
  // HP regen
  if ((player.hpRegen || 0) > 0 && player.hp < player.maxHp)
    player.hp = Math.min(player.maxHp, player.hp + player.hpRegen * dt);

  // Advance sprite animation frame
  if (SPRITE_DEF[player.type]) {
    const ak = getSpriteAnimKey(player);
    const ad = SPRITE_DEF[player.type].anims[ak];
    if (ad) {
      player.animTimer += dt;
      const maxF = ad.n;
      // Spread attack frames evenly across the full cast duration
      const step = (!ad.loop && player.atkAnimTimer > 0 && player.castDuration > 0)
        ? player.castDuration / maxF
        : 1 / ad.fps;
      while (player.animTimer >= step) {
        player.animTimer -= step;
        if (ad.loop) { player.animFrame = (player.animFrame + 1) % maxF; }
        else if (player.animFrame < maxF - 1) { player.animFrame++; }
      }
    }
  } else if (player.castDuration > 0 && player.atkAnimTimer > 0) {
    // No sprite sheet: advance animFrame proportionally so frame-8 gate still fires
    const elapsed = player.castDuration - player.atkAnimTimer;
    player.animFrame = Math.floor(elapsed / player.castDuration * 10);
  }

  // Fire pending attack on frame 8
  if (player.pendingAttack && !player.attackFired && player.animFrame >= 8) {
    const pa = player.pendingAttack;
    player.attackFired = true;
    swingTimer = 0.18;
    if (pa.isPlayer) {
      netPvpAttack(pa.socketId);
      if (player.charDef.atkType === 'ranged') fireProj(pa.x, pa.y);
    } else {
      netAttack(pa.id);
      if (player.charDef.atkType === 'ranged') fireProj(pa.x, pa.y);
    }
  }
  if (player.atkAnimTimer <= 0) { player.pendingAttack = null; player.attackFired = false; }

  // Auto-attack (skip timer decrement in manual mode)
  if (autoAttackMode) player.atkTimer -= dt;
  if (player.atkTimer <= 0) {
    let closest = null, closestD = Infinity;
    let closestIsPlayer = false;

    // Prefer locked target
    if (targetId && !targetIsPlayer) {
      const t = serverEnemiesMap.get(targetId);
      if (t && (t.hp || 0) > 0) { closest = t; closestD = dist(t.x, t.y, player.x, player.y); }
    } else if (targetId && targetIsPlayer && pvpMode) {
      const op = otherPlayers.get(targetId);
      if (op && (op.hp || 0) > 0 && op.x != null) {
        _pvpSentinel._socketId = targetId; _pvpSentinel.x = op.x; _pvpSentinel.y = op.y;
        closest = _pvpSentinel;
        closestD = dist(op.x, op.y, player.x, player.y);
        closestIsPlayer = true;
      }
    }

    // Fall back to nearest enemy using squared distance (avoids sqrt per candidate)
    if (!closest) {
      let closestD2 = Infinity;
      serverEnemies.forEach(e => {
        if ((e.hp || 0) <= 0) return;
        const dx = e.x - player.x, dy = e.y - player.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < closestD2) { closestD2 = d2; closest = e; closestIsPlayer = false; }
      });
      if (pvpMode) {
        otherPlayers.forEach((op, id) => {
          if ((op.hp || 0) <= 0 || op.x == null) return;
          const dx = op.x - player.x, dy = op.y - player.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < closestD2) { closestD2 = d2; _pvpSentinel._socketId = id; _pvpSentinel.x = op.x; _pvpSentinel.y = op.y; closest = _pvpSentinel; closestIsPlayer = true; }
        });
      }
      if (closest) closestD = Math.sqrt(closestD2);
    }

    const atkRange = player.charDef.atkRange * (closestIsPlayer ? 1.3 : 1);
    if (!closest || closestD >= atkRange || !hasLOS(player.x, player.y, closest.x, closest.y)) {
      player.atkTimer = 0.15;
    } else {
      if (!targetId) {
        targetId = closestIsPlayer ? closest._socketId : closest.id;
        targetIsPlayer = closestIsPlayer;
      }
      const _as = player.atkSpeed || player.charDef.atkSpeed;
      player.atkTimer = 1 / _as;
      faceTowards(closest.x, closest.y);
      swingAngle = Math.atan2(closest.y - player.y, closest.x - player.x);
      const _animDur = Math.min(0.825, 1 / _as);
      player.atkAnimTimer = _animDur; player.castDuration = _animDur; player.animFrame = 0; player.animTimer = 0;
      player.pendingAttack = closestIsPlayer
        ? { isPlayer: true, socketId: closest._socketId, x: closest.x, y: closest.y }
        : { isPlayer: false, id: closest.id, x: closest.x, y: closest.y };
      player.attackFired = false;
    }
  }

  // Advance projectiles — visual only; server is authoritative for hit detection
  {
    let j = 0;
    for (let i = 0; i < projs.length; i++) {
      const p = projs[i];
      p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
      if (p.life <= 0 || isWall(p.x, p.y)) continue;
      if (p.isPlayer) {
        const ps = p.size; let hit = false;
        for (let k = 0; k < serverEnemies.length; k++) {
          const e = serverEnemies[k];
          if ((e.hp || 0) <= 0) continue;
          const r = e.size + ps, ex = p.x - e.x, ey = p.y - e.y;
          if (ex * ex + ey * ey < r * r) { hit = true; break; }
        }
        if (hit) { spawnBurst(p.x, p.y, p.color, 5); continue; }
        if (pvpMode) {
          for (const op of otherPlayers.values()) {
            if ((op.hp || 0) <= 0 || op.x == null) continue;
            const r = 18 + ps, ex = p.x - op.x, ey = p.y - op.y;
            if (ex * ex + ey * ey < r * r) { hit = true; break; }
          }
          if (hit) { spawnBurst(p.x, p.y, p.color, 5); continue; }
        }
      }
      projs[j++] = projs[i];
    }
    projs.length = j;
  }
  {
    let j = 0;
    for (let i = 0; i < otherProjs.length; i++) {
      const p = otherProjs[i];
      p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
      if (p.life <= 0 || isWall(p.x, p.y)) continue;
      const ps = p.size; let hit = false;
      for (let k = 0; k < serverEnemies.length; k++) {
        const e = serverEnemies[k];
        if ((e.hp || 0) <= 0) continue;
        const r = e.size + ps, ex = p.x - e.x, ey = p.y - e.y;
        if (ex * ex + ey * ey < r * r) { hit = true; break; }
      }
      if (hit) { spawnBurst(p.x, p.y, p.color, 5); continue; }
      if (player && state === 'playing') {
        const r = 14 + ps, ex = p.x - player.x, ey = p.y - player.y;
        if (ex * ex + ey * ey < r * r) { spawnBurst(p.x, p.y, p.color, 5); continue; }
      }
      otherProjs[j++] = otherProjs[i];
    }
    otherProjs.length = j;
  }

  {
    let j = 0;
    for (let i = 0; i < drops.length; i++) {
      const d = drops[i]; d.life -= dt;
      if (d.life <= 0) continue;
      const _ddx = d.x - player.x, _ddy = d.y - player.y;
      if (_ddx * _ddx + _ddy * _ddy < 900) { pickup(d); continue; }
      drops[j++] = drops[i];
    }
    drops.length = j;
  }

  {
    let j = 0;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i]; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
      if (p.life > 0) particles[j++] = particles[i];
    }
    particles.length = Math.min(j, 200);
  }
  {
    let j = 0;
    for (let i = 0; i < dmgNums.length; i++) {
      const d = dmgNums[i]; d.y += d.vy * dt; d.life -= dt;
      if (d.life > 0) dmgNums[j++] = dmgNums[i];
    }
    dmgNums.length = Math.min(j, 40);
  }

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
  if (typeof tickQuestNotif === 'function') tickQuestNotif(dt);

  // Clear stale target
  if (targetId) {
    if (targetIsPlayer) {
      const op = otherPlayers.get(targetId);
      if (!op || (op.hp || 0) <= 0) { targetId = null; targetIsPlayer = false; }
    } else {
      const te = serverEnemiesMap.get(targetId);
      if (!te || (te.hp || 0) <= 0) { targetId = null; targetIsPlayer = false; }
    }
  }

  // NPC proximity
  nearNpc = null;
  npcs.forEach(n => { if (dist(player.x, player.y, n.x, n.y) < 65) nearNpc = n; });
  if (_talkBtn) _talkBtn.style.display = (nearNpc && activeTab === 0) ? 'block' : 'none';

  // Smooth lerp toward latest server positions
  const lk = Math.min(1, 25 * dt);
  otherPlayers.forEach((op, id) => {
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
          if (ad.loop) { op.animFrame = (op.animFrame + 1) % ad.n; }
          else if (op.animFrame < ad.n - 1) { op.animFrame++; }
        }
      }
    }
  });
  serverEnemies.forEach(e => {
    if ((e.hurtTimer || 0) > 0) e.hurtTimer -= dt;
    if ((e.atkAnimTimer || 0) > 0) e.atkAnimTimer -= dt;
    if (e.targetX !== undefined) {
      const dx = e.targetX - e.x, dy = e.targetY - e.y;
      if (dx * dx + dy * dy > 0.01) {
        const ex = e.x - player.x, ey = e.y - player.y;
        if (ex * ex + ey * ey < _LERP_R2) {
          e.x += dx * lk; e.y += dy * lk; // smooth lerp for nearby enemies
        } else {
          e.x = e.targetX; e.y = e.targetY; // instant snap — off-screen anyway
        }
      }
    }
  });

  updateCamera(dt);
}

// ─────────────────────────────────────────────────────────
//  RENDER
// ─────────────────────────────────────────────────────────

// Render all HUD/UI elements to an offscreen canvas (reused every other frame)
function _renderUI() {
  const cw = Math.round(W * DPR), ch = Math.round(H * DPR);
  if (!_uiCanvas || _uiCanvas.width !== cw || _uiCanvas.height !== ch) {
    _uiCanvas = document.createElement('canvas');
    _uiCanvas.width = cw; _uiCanvas.height = ch;
    _uiCtx = _uiCanvas.getContext('2d');
  }
  _uiCtx.clearRect(0, 0, cw, ch);
  _uiCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const _c = ctx; ctx = _uiCtx;
  drawHeader();
  if (activeTab === 0 && typeof drawQuestTracker === 'function') drawQuestTracker();
  drawPvpButton();
  drawPartyButton();
  drawPartyHUD();
  drawTargetFrame();
  if (activeTab === 0) {
    drawSkillButtons();
    drawPotionButton();
    drawTargetButton();
    drawAttackButton();
    drawAutoToggle();
  }
  drawPartyInvitePopup();
  if (state === 'dead') drawDead();
  ctx = _c;
}

function _drawProj(p) {
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
}

// Cached per-frame view bounds — updated once at the top of render(), read by _isOnScreen
let _vL = 0, _vR = 0, _vT = 0, _vB = 0;
function render(dt, ts) {
  // Precompute per-frame trig — used in multiple places below
  const _pulse    = 0.5 + 0.5 * Math.sin(frameCount * 0.15);
  const _bossGlow = 0.6 + 0.4 * Math.sin(frameCount * 0.10);
  const _dropSin  = Math.sin(frameCount * 0.09);
  // Cache view bounds so _isOnScreen() avoids divisions on every call
  const _vM = 60;
  _vL = camera.x - _vM; _vR = camera.x + W / ZOOM + _vM;
  _vT = camera.y - _vM; _vB = camera.y + (H - HEADER_H) / ZOOM + _vM;

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
    // Draw only the visible slice — avoids reading the full (2000-3000px) tile canvas each frame
    const _tcSx = Math.max(0, Math.floor(camera.x));
    const _tcSy = Math.max(0, Math.floor(camera.y));
    const _tcSw = Math.min(tileCanvas.width  - _tcSx, Math.ceil(W  / ZOOM) + 2);
    const _tcSh = Math.min(tileCanvas.height - _tcSy, Math.ceil((H - HEADER_H) / ZOOM) + 2);
    if (_tcSw > 0 && _tcSh > 0)
      ctx.drawImage(tileCanvas, _tcSx, _tcSy, _tcSw, _tcSh, _tcSx, _tcSy, _tcSw, _tcSh);
  }

  // NPCs
  drawNpcs();

  // Drops — no save/restore per drop; state is set fresh each iteration
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = 'bold 9px Arial';
  const _dropBob = _dropSin * 3;
  drops.forEach(d => {
    ctx.globalAlpha = Math.min(1, d.life * 1.5) * (0.85 + 0.15 * _dropSin);
    const bob = _dropBob;
    if (d.type === 'gold') {
      ctx.fillStyle = '#ff0'; ctx.beginPath(); ctx.arc(d.x, d.y + bob, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#a80'; ctx.fillText(d.amount + 'g', d.x, d.y + bob);
    } else {
      drawIconCtx(ctx, d.item.icon, d.x, d.y + bob, 20, '#ccc');
    }
  });

  // Particles — sort by color, then batch-fill per group (1 fill() per color, not per particle)
  if (particles.length) {
    particles.sort((a, b) => (a.color > b.color) - (a.color < b.color));
    let i = 0;
    while (i < particles.length) {
      const col = particles[i].color;
      ctx.fillStyle = col;
      ctx.globalAlpha = Math.max(0, particles[i].life);
      ctx.beginPath();
      while (i < particles.length && particles[i].color === col) {
        const p = particles[i++];
        ctx.moveTo(p.x + p.size, p.y); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      }
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // Enemies
  _visEnm = 0;
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  serverEnemies.forEach(e => {
    if (!_isOnScreen(e.x, e.y)) return; // viewport cull
    _visEnm++;
    const hurt = e.hurtTimer > 0;
    // Selection ring
    if (e.id === targetId && !targetIsPlayer) {
      ctx.globalAlpha = 0.65 + 0.35 * _pulse;
      ctx.strokeStyle = '#ff3c3c'; ctx.lineWidth = 2.5;
      ctx.setLineDash(_DASH);
      ctx.beginPath(); ctx.arc(e.x, e.y, e.size + 8 + _pulse * 3, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash(_NO_DASH); ctx.globalAlpha = 1;
    }
    if (!drawEnemySprite(e, dt)) {
      ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.beginPath(); ctx.ellipse(e.x, e.y + e.size, e.size * .8, e.size * .3, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = hurt ? '#fff' : e.color; ctx.beginPath(); ctx.arc(e.x, e.y, e.size, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#000';
      ctx.beginPath(); ctx.arc(e.x - e.size * .3, e.y - e.size * .18, e.size * .18, 0, Math.PI * 2); ctx.arc(e.x + e.size * .3, e.y - e.size * .18, e.size * .18, 0, Math.PI * 2); ctx.fill();
    }
    if (e.isBoss) {
      ctx.globalAlpha = _bossGlow; ctx.strokeStyle = '#ff3232'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(e.x, e.y, e.size + 5, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#f44'; ctx.font = 'bold 9px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillText('БОСС', e.x, e.y - e.size - 16);
    }
    const bw = e.size * 2.6, bh = 5, bx = e.x - bw / 2, by = e.y - e.size - 13;
    ctx.fillStyle = '#400'; ctx.fillRect(bx, by, bw, bh);
    const pct = e.hp / e.maxHp;
    ctx.fillStyle = pct > .5 ? '#2d2' : pct > .25 ? '#da2' : '#d22';
    ctx.fillRect(bx, by, bw * pct, bh);
    ctx.font = e.isBoss ? 'bold 9px system-ui,Arial' : '8px system-ui,Arial';
    ctx.fillStyle = e.isBoss ? '#f88' : '#ddd';
    ctx.fillText(e.name, e.x, by - 2);
  });

  // Other players
  otherPlayers.forEach((p, pid) => {
    if (p.x == null || isNaN(p.x)) return;
    if (!_isOnScreen(p.x, p.y)) return; // viewport cull

    if (pid === targetId && targetIsPlayer) {
      ctx.globalAlpha = 0.65 + 0.35 * _pulse;
      ctx.strokeStyle = '#ff5050'; ctx.lineWidth = 2.5;
      ctx.setLineDash(_DASH);
      ctx.beginPath(); ctx.arc(p.x, p.y, 22 + _pulse * 3, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash(_NO_DASH); ctx.globalAlpha = 1;
    }

    const usedSprite = drawOtherPlayerSprite(p);
    if (!usedSprite) {
      ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.ellipse(p.x, p.y + 14, 11, 4, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = (CHAR_DEF[p.type]?.color) || '#aaa';
      ctx.beginPath(); ctx.arc(p.x, p.y, 14, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 2; ctx.stroke();
    }
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
      drawIconCtx(ctx, 'pvpOn', p.x + bw / 2 + 8, nameY - 3, 9, '#f55');
    }
    ctx.fillStyle = '#300'; ctx.fillRect(bx, barTop, bw, bh);
    ctx.fillStyle = '#2d2'; ctx.fillRect(bx, barTop, bw * Math.max(0, (p.hp || 0) / (p.maxHp || 1)), bh);
  });

  // Projectiles (local + other players') — two loops avoid array allocation each frame
  projs.forEach(_drawProj);
  otherProjs.forEach(_drawProj);

  // Player
  {
    const hurtTint = player.hurtTimer > 0 ? 'rgba(255,40,40,0.55)' : null;
    const usedSprite = drawSprite(player, hurtTint);
    if (!usedSprite) {
      ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.beginPath(); ctx.ellipse(player.x, player.y + 14, 11, 4, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = hurtTint ? '#ff4444' : player.charDef.color;
      ctx.beginPath(); ctx.arc(player.x, player.y, 14, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.4)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(player.x, player.y, 14, 0, Math.PI * 2); ctx.stroke();
      const fdx = joy.dx || (keys['ArrowRight'] || keys['d'] ? 1 : keys['ArrowLeft'] || keys['a'] ? -1 : 1);
      const fdy = joy.dy || (keys['ArrowDown'] || keys['s'] ? 1 : keys['ArrowUp'] || keys['w'] ? -1 : 0);
      const fl = Math.hypot(fdx, fdy) || 1;
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(player.x + fdx / fl * 8, player.y + fdy / fl * 8, 3.5, 0, Math.PI * 2); ctx.fill();
    }
    if (swingTimer > 0) {
      ctx.strokeStyle = 'rgba(200,220,255,.75)';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(player.x, player.y, 34, swingAngle - .7, swingAngle + .7); ctx.stroke();
    }

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
      drawIconCtx(ctx, 'pvpOn', player.x + bw / 2 + 8, nameY - 3, 9, '#f55');
    }

    ctx.fillStyle = 'rgba(30,0,0,0.75)'; ctx.fillRect(bx2, barTop, bw, bh);
    if (hpPct > 0) {
      ctx.fillStyle = hpPct > 0.5 ? '#2ecc71' : hpPct > 0.25 ? '#f39c12' : '#e74c3c';
      ctx.fillRect(bx2, barTop, bw * hpPct, bh);
    }
  }

  // Damage numbers
  dmgNums.forEach(d => {
    ctx.globalAlpha = Math.min(1, d.life * 1.5);
    ctx.fillStyle = d.color;
    ctx.font = d.fontSize === 15 ? _FONT_DMGNUM : _FONT_DMGTXT; ctx.textAlign = 'center';
    ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.strokeText(d.text, d.x, d.y); ctx.fillText(d.text, d.x, d.y);
  });
  ctx.globalAlpha = 1;
  ctx.restore(); // [camera]

  // UI — blit from offscreen canvas (time-based rebuild ~20fps, decoupled from frame rate)
  ctx.globalAlpha = 1;
  if (!_uiCanvas || ts - _uiLastMs >= 50) { _uiLastMs = ts; _renderUI(); }
  ctx.drawImage(_uiCanvas, 0, 0, _uiCanvas.width, _uiCanvas.height, 0, 0, W, H);
  // Joystick drawn directly at full 60fps — knob tracks live touch position
  if (activeTab === 0) drawJoystick();

  if (transTimer > 0) {
    ctx.fillStyle = `rgba(180,120,255,${Math.min(1, transTimer * 3)})`; ctx.fillRect(0, 0, W, H);
  }
}

// ─────────────────────────────────────────────────────────
//  GAME FLOW
// ─────────────────────────────────────────────────────────
function goToFloor(n) {
  if (n === dungeonLvl || !player) return;
  netSaveProgress();
  netSendChangeFloor(clamp(n, 1, 20));
  setTab(0);
}

function selectChar(type) {
  joy.active = false; joy.dx = 0; joy.dy = 0;
  player = makePlayer(type);
  dungeonLvl = 1;
  const savedStats = (typeof _savedData !== 'undefined' && _savedData?.type === type) ? _savedData : null;
  csStartLoading(type, () => { initNpcs(); _finishOnlineStart(); });
  // Gate the loading screen on BOTH player and enemy sprites being decoded —
  // otherwise the first monster walk/attack animation mid-game would still hitch.
  let _spritesPending = 2;
  const _onSpriteSetReady = () => { if (--_spritesPending === 0) csOnSpritesReady(); };
  loadEnemySprites('slime', _onSpriteSetReady);
  loadSprites(type, _onSpriteSetReady);
  netSelectChar(type, savedStats);
}

function getOtherPlayerAnimKey(p) {
  if ((p.hp ?? 1) <= 0) return 'die';
  const dir = p.facing || 'front';
  if ((p.atkAnimTimer || 0) > 0) return `${dir}-attack`;
  if (p.moving) return `${dir}-run`;
  return `${dir}-idle`;
}

function drawOtherPlayerSprite(p) {
  const def = SPRITE_DEF[p.type];
  const cache = spriteCache[p.type];
  if (!def || !cache) return false;
  const key = getOtherPlayerAnimKey(p);
  const ad = def.anims[key];
  const img = cache[key];
  if (!ad || !_sheetReady(img)) return false;
  const fw = img.frameW || def.frameW, fh = img.frameH || def.frameH;
  const fi = Math.min(Math.floor(p.animFrame || 0), ad.n - 1);
  const sx = (fi % ad.cols) * fw;
  const sy = Math.floor(fi / ad.cols) * fh;
  const dh = 80, dw = dh * fw / fh;
  const dx = Math.round(p.x - dw / 2), dy = Math.round(p.y - dh * 0.62);
  ctx.fillStyle = 'rgba(0,0,0,.3)';
  ctx.beginPath(); ctx.ellipse(p.x, p.y + 18, 13, 5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.drawImage(img, sx, sy, fw, fh, dx, dy, dw, dh);
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
  // Precompute per-frame values once — not per NPC
  const _nPulse   = 0.7 + 0.3 * Math.sin(frameCount * 0.08);
  const _nBounce  = Math.sin(frameCount * 0.15) * 3;
  const _nFont    = 'bold 10px system-ui, -apple-system, Arial';

  // Shadow ellipses all share the same style — batch into one path/fill() call
  // instead of one beginPath()+fill() per NPC. Alternating fillStyle between
  // this shadow color and each NPC's own color (for the ring/text below) on
  // every single shape forces a paint-state flush per call; measured at
  // ~0.34ms per tiny 14×5px ellipse — over 200x the cost of a batched fill.
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  npcs.forEach(n => { ctx.moveTo(n.x + 14, n.y + 18); ctx.ellipse(n.x, n.y + 18, 14, 5, 0, 0, Math.PI * 2); });
  ctx.fill();

  npcs.forEach(n => {
    ctx.globalAlpha = _nPulse; ctx.strokeStyle = n.color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(n.x, n.y, 22, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;

    drawIconCtx(ctx, n.icon, n.x, n.y, 28, n.color);

    ctx.font = _nFont; ctx.textBaseline = 'alphabetic';
    ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
    ctx.strokeText(n.name, n.x, n.y - 26);
    ctx.fillStyle = n.color;
    ctx.fillText(n.name, n.x, n.y - 26);

    if (nearNpc && nearNpc.id === n.id) {
      drawIconCtx(ctx, 'chat', n.x, n.y - 44 + _nBounce, 18, '#fff');
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

  function isFloor(tx, ty) {
    return tx >= 0 && tx < dungeon.w && ty >= 0 && ty < dungeon.h
      && dungeon.grid[ty][tx] === FLOOR;
  }

  // Pass 1: solid wall base color everywhere
  tctx.fillStyle = th.wallBase || '#050505';
  tctx.fillRect(0, 0, dungeon.w * TILE, dungeon.h * TILE);

  // Pass 2: draw floor tiles
  for (let ty = 0; ty < dungeon.h; ty++)
    for (let tx = 0; tx < dungeon.w; tx++)
      if (dungeon.grid[ty][tx] === FLOOR)
        th.drawFloor(tctx, tx * TILE, ty * TILE, 0);

  // Pass 3: draw wall decorations only on tiles adjacent to floor
  for (let ty = 0; ty < dungeon.h; ty++)
    for (let tx = 0; tx < dungeon.w; tx++)
      if (dungeon.grid[ty][tx] === WALL) {
        const nb = {
          top: isFloor(tx, ty - 1), bottom: isFloor(tx, ty + 1),
          left: isFloor(tx - 1, ty), right: isFloor(tx + 1, ty),
          tl: isFloor(tx - 1, ty - 1), tr: isFloor(tx + 1, ty - 1),
          bl: isFloor(tx - 1, ty + 1), br: isFloor(tx + 1, ty + 1),
        };
        if (nb.top || nb.bottom || nb.left || nb.right || nb.tl || nb.tr || nb.bl || nb.br)
          th.drawWall(tctx, tx * TILE, ty * TILE, 0, nb);
      }

  // Pass 4: soft shadow on floor tiles at wall edges (universal)
  const sd = 11;
  for (let ty = 0; ty < dungeon.h; ty++) {
    for (let tx = 0; tx < dungeon.w; tx++) {
      if (dungeon.grid[ty][tx] !== FLOOR) continue;
      const x = tx * TILE, y = ty * TILE;
      if (!isFloor(tx, ty - 1)) {
        const g = tctx.createLinearGradient(0, y, 0, y + sd);
        g.addColorStop(0, 'rgba(0,0,0,0.5)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        tctx.fillStyle = g; tctx.fillRect(x, y, TILE, sd);
      }
      if (!isFloor(tx, ty + 1)) {
        const g = tctx.createLinearGradient(0, y + TILE - sd, 0, y + TILE);
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.4)');
        tctx.fillStyle = g; tctx.fillRect(x, y + TILE - sd, TILE, sd);
      }
      if (!isFloor(tx - 1, ty)) {
        const g = tctx.createLinearGradient(x, 0, x + sd, 0);
        g.addColorStop(0, 'rgba(0,0,0,0.4)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        tctx.fillStyle = g; tctx.fillRect(x, y, sd, TILE);
      }
      if (!isFloor(tx + 1, ty)) {
        const g = tctx.createLinearGradient(x + TILE - sd, 0, x + TILE, 0);
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.4)');
        tctx.fillStyle = g; tctx.fillRect(x + TILE - sd, y, sd, TILE);
      }
    }
  }
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
      `${player.gold} золота · ${player.kills} убито` +
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
  socket.emit('playerMove', { x: player.x, y: player.y, facing: player.facing });
  if (socket?.connected) socket.emit('respawn');
  netSaveProgress();
}

function restartGame() {
  if (state !== 'dead') return;
  document.getElementById('death-modal').style.display = 'none';
  targetId = null; targetIsPlayer = false; pvpMode = false;
  serverEnemies = []; otherPlayers = new Map();
  npcs = []; nearNpc = null;
  tileCanvas = null;
  document.getElementById('bottom-nav').style.display = 'none';
  document.querySelectorAll('.bpanel').forEach(p => { p.classList.remove('open'); p.style.display = 'none'; });
  setTab(0);
  player = null; dungeonLvl = 1;
  projs = []; otherProjs = []; drops = []; particles = []; dmgNums = [];
  state = 'select';
  csShow(null);
}

// ─────────────────────────────────────────────────────────
//  LOOP
// ─────────────────────────────────────────────────────────
let _loopTs = 0;
function loop(ts) {
  const frameMs = ts - _loopTs; _loopTs = ts;
  const dt = Math.min((ts - lastTs) / 1000, .033); lastTs = ts;
  update(dt); render(dt, ts);
  _drawPerf(frameMs);
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
    _uiCanvas = null;           // force UI canvas recreation at new size
    _skillBtnGradCache = null;  // force skill button gradient rebuild
    _uiBtnGrads = null;         // force button gradient rebuild
    updateJoyCenter();          // recompute cached joystick center
    if (dungeon) clampCamera();
  };
  resize(); window.addEventListener('resize', resize);
  _talkBtn = document.getElementById('npc-talk-btn');
  initInput();
  requestAnimationFrame(ts => { lastTs = ts; requestAnimationFrame(loop); });
});
