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
// Adaptive quality tier — auto-degrades when FPS stays below 30 for ~3s
let _qualityTier = 0, _lowFpsFrames = 0;

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
  // Adaptive quality: drop to tier 1 when FPS stays < 30 for ~3s; recover when FPS > 50
  if (fps < 30) { if (++_lowFpsFrames > 180) _qualityTier = 1; }
  else if (fps > 50) { _lowFpsFrames = Math.max(0, _lowFpsFrames - 2); if (_lowFpsFrames === 0) _qualityTier = 0; }
  // Decay worst-case slowly
  if (maxFt > _ftWorstMs) { _ftWorstMs = maxFt; _ftWorstDecay = 180; }
  else if (--_ftWorstDecay <= 0) { _ftWorstMs = maxFt; }

  if (!_perfShow) return;

  // Mini frame-time bar graph (60 bars)
  const bw = 2, bh = 40, bx0 = 8, by0 = 55;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(bx0 - 2, by0 - bh - 2, samples * bw + 4, bh + 4 + 130);

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
    `ping ${_pingMs >= 0 ? _pingMs + 'ms' : '...'} ${socket?.io?.engine?.transport?.name === 'websocket' ? 'ws' : socket?.io?.engine?.transport?.name ?? ''}`,
    `avg  ${avgMs.toFixed(1)}ms`,
    `max  ${_ftWorstMs.toFixed(1)}ms`,
    `prt  ${particles.length}`,
    `enm  ${_visEnm}/${serverEnemies.length}`,
    `opl  ${otherPlayers.size}`,
    `upd  ${_profUpdate.toFixed(1)}ms`,
    `rnd  ${_profRender.toFixed(1)}ms`,
    `skt  ${_profSocketEvtsSnap}e ${_profSocketMsSnap.toFixed(1)}ms`,
    `dpr  ${DPR.toFixed(2)}`,
    `qlty ${_qualityTier}`,
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
    let col = '#ddd';
    if (i === 0) col = fps < 40 ? '#f55' : fps < 55 ? '#fa0' : '#4f4';
    else if (i === 1 && _pingMs >= 0) col = _pingMs > 150 ? '#f55' : _pingMs > 80 ? '#fa0' : '#4f4';
    ctx.fillStyle = col;
    ctx.fillText(ln, bx0, ty0 + i * 14);
  });
}

// UI overlay canvas (separate DOM element at native DPR) — rebuilt ~20fps
let _uiOverlay, _uiCtx = null, _uiLastMs = 0;
// Camera position cached for UI overlay coordinate conversion
let _lastCamX = 0, _lastCamY = 0;
// Player sprite state and previous name label bounds for 60fps name tracking
let _lastPlayerUsedSprite = false, _prevPlayerNameBounds = null;
// measureText cache for player name label — avoids per-frame call when name unchanged
let _prevDisplayName = '', _cachedNameTw = 0;
// Enemy name label cache — pre-rendered text canvases keyed by `name|isBoss`
const _enemyNameLabels = new Map();

// Reusable sentinel for pvp closest-target — avoids per-frame object spread
const _pvpSentinel = { _socketId: null, x: 0, y: 0 };

// Visible enemy count (set each render frame, read by _drawPerf)
let _visEnm = 0;

// Profiling breakdown — measures update vs render vs socket processing
let _profUpdate = 0, _profRender = 0;
let _profSocketEvts = 0, _profSocketMs = 0;
let _profSocketEvtsSnap = 0, _profSocketMsSnap = 0;

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
  const tx = player.x - visW / 2;
  const ty = player.y - visH / 2;
  const factor = Math.min(1, 8 * dt); // slightly faster tracking reduces perceived lag
  camera.x += (tx - camera.x) * factor;
  camera.y += (ty - camera.y) * factor;
  // Once within a device pixel of the target, lock onto it exactly —
  // prevents float oscillation around a rounding boundary when standing
  // still (during steady running the lerp trails at a constant offset,
  // so the player already holds a fixed screen position).
  const _devPx = 1 / (ZOOM * DPR);
  if (Math.abs(tx - camera.x) < _devPx) camera.x = tx;
  if (Math.abs(ty - camera.y) < _devPx) camera.y = ty;
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
        // Hysteresis on the facing axis: near-diagonal joystick input hovers
        // around a fixed threshold, flipping facing (and restarting the run
        // animation) every frame. Once an axis owns the facing, the other
        // axis must clearly dominate (×1.25) to take it over; flips within
        // the same axis (left↔right, front↔back) stay immediate.
        const ax = Math.abs(inp.dx), ay = Math.abs(inp.dy);
        if (player.facing === 'left' || player.facing === 'right') {
          if (ay > ax * 1.25)  player.facing = inp.dy > 0 ? 'front' : 'back';
          else if (ax > 0)     player.facing = inp.dx > 0 ? 'right' : 'left';
        } else {
          if (ax > ay * 1.25)  player.facing = inp.dx > 0 ? 'right' : 'left';
          else if (ay > 0)     player.facing = inp.dy > 0 ? 'front' : 'back';
        }
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

  // Cancel attack animation immediately if target already dead
  if (player.pendingAttack && !player.attackFired && player.atkAnimTimer > 0) {
    const _pa = player.pendingAttack;
    const _alive = _pa.isPlayer
      ? (otherPlayers.get(_pa.socketId)?.hp || 0) > 0
      : (serverEnemiesMap.get(_pa.id)?.hp || 0) > 0;
    if (!_alive) { player.atkAnimTimer = 0; player.pendingAttack = null; player.attackFired = false; }
  }
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
    if (ak !== player._lastAnimKey) { player._lastAnimKey = ak; player.animFrame = 0; player.animTimer = 0; }
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
    const targetAlive = pa.isPlayer
      ? (otherPlayers.get(pa.socketId)?.hp || 0) > 0
      : (serverEnemiesMap.get(pa.id)?.hp || 0) > 0;
    if (targetAlive) {
      swingTimer = 0.18;
      if (pa.isPlayer) {
        netPvpAttack(pa.socketId);
        if (player.charDef.atkType === 'ranged') {
          const _op = otherPlayers.get(pa.socketId);
          fireProj(_op?.x ?? pa.x, _op?.y ?? pa.y);
        }
      } else {
        netAttack(pa.id);
        if (player.charDef.atkType === 'ranged') {
          const _e = serverEnemiesMap.get(pa.id);
          fireProj(_e?.x ?? pa.x, _e?.y ?? pa.y);
        }
      }
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
    dmgNums.length = Math.min(j, _qualityTier > 0 ? 20 : 40);
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

  // Snapshot interpolation — render others at (serverNow - INTERP_MS)
  // Always between two known positions → no prediction errors, perfectly linear
  const _renderT = _svrTimeOffset !== null
    ? Date.now() + _svrTimeOffset - _INTERP_MS
    : 0;
  otherPlayers.forEach((op, id) => {
    const buf = op._buf;
    const prevX = op.x, prevY = op.y;
    if (buf && buf.length >= 2 && _renderT > 0) {
      // Walk back to find the two snapshots that bracket _renderT
      let i = buf.length - 2;
      while (i > 0 && buf[i].t > _renderT) i--;
      const s0 = buf[i], s1 = buf[i + 1];
      const span = s1.t - s0.t;
      if (span < 1) {
        op.x = s1.x; op.y = s1.y;
      } else {
        const a = Math.max(0, Math.min(1, (_renderT - s0.t) / span));
        op.x = s0.x + (s1.x - s0.x) * a;
        op.y = s0.y + (s1.y - s0.y) * a;
      }
    } else if (op.targetX !== undefined) {
      // Fallback: lerp until 2 snapshots accumulate (~50ms after join)
      op.x += (op.targetX - op.x) * Math.min(1, 40 * dt);
      op.y += (op.targetY - op.y) * Math.min(1, 40 * dt);
    }
    const _mdx = op.x - prevX, _mdy = op.y - prevY;
    op.moving = _mdx * _mdx + _mdy * _mdy > 0.1;
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
  let _corpseExpired = false;
  serverEnemies.forEach(e => {
    if ((e.hurtTimer || 0) > 0) e.hurtTimer -= dt;
    if ((e.atkAnimTimer || 0) > 0) e.atkAnimTimer -= dt;
    if ((e._moveTimer || 0) > 0) e._moveTimer -= dt;
    if (e._deathTimer !== undefined && (e._deathTimer -= dt) <= 0) _corpseExpired = true;
    if (e.hp <= 0) return;

    // Skip full AI for enemies outside local AOI — server corrects position on entry
    const _epdx = player.x - e.x, _epdy = player.y - e.y;
    const _epd2 = _epdx * _epdx + _epdy * _epdy;
    if (_epd2 > 1100 * 1100) return;

    // Find closest player — squared dist avoids sqrts in comparison loop
    let closestD2 = _epd2, closestTgt = player;
    otherPlayers.forEach(op => {
      if ((op.hp || 0) <= 0 || op.x == null) return;
      const ddx = op.x - e.x, ddy = op.y - e.y;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 < closestD2) { closestD2 = d2; closestTgt = op; }
    });
    const dp = Math.sqrt(closestD2); // single sqrt per in-AOI enemy

    const aggroR = e.aggroR || 175;
    const spd    = e.spd    || 70;
    const sz     = e.size   || 16;

    if (dp < aggroR) e.aggro = true;
    if (dp > aggroR * 2.2) e.aggro = false;

    if (e.aggro && dp > sz + 14) {
      const nx = (closestTgt.x - e.x) / dp;
      const ny = (closestTgt.y - e.y) / dp;
      if (Math.abs(nx) >= Math.abs(ny)) e._facing = nx > 0 ? 'right' : 'left';
      else                              e._facing = ny > 0 ? 'down'  : 'up';
      const er  = sz * 0.55;
      const evx = nx * spd * dt;
      const evy = ny * spd * dt;
      if (canMoveX(e, evx, er)) e.x += evx;
      if (canMoveY(e, evy, er)) e.y += evy;
      e._moveTimer = 0.2;
    }

    // Server correction — squared fast-reject avoids sqrt when error < 10px
    if (e.targetX !== undefined) {
      const cedx = e.targetX - e.x, cedy = e.targetY - e.y;
      const err2 = cedx * cedx + cedy * cedy;
      if (err2 > 100) {
        const err = Math.sqrt(err2);
        const k = err > 150 ? 0.2 : 0.04;
        e.x += cedx * k; e.y += cedy * k;
      }
    }
  });
  if (_corpseExpired) {
    let j = 0;
    for (let i = 0; i < serverEnemies.length; i++) {
      const e = serverEnemies[i];
      if (e._deathTimer !== undefined && e._deathTimer <= 0) { serverEnemiesMap.delete(e.id); continue; }
      serverEnemies[j++] = e;
    }
    serverEnemies.length = j;
  }

  updateCamera(dt);
}

// ─────────────────────────────────────────────────────────
//  RENDER
// ─────────────────────────────────────────────────────────

// Draw the player's name label at 60fps on the UI canvas using screen coords,
// clearing only the label's bounding box each frame so no ghosting occurs.
function _drawPlayerNameOnUI() {
  const barTop = _lastPlayerUsedSprite ? player.y - 46 : player.y - 28;
  const nameY = barTop - 4;
  const sx = (player.x - _lastCamX) * ZOOM;
  const sy = (nameY - _lastCamY) * ZOOM + HEADER_H;
  const displayName = (netUsername || player.charDef.name).slice(0, 16);
  const _c = ctx; ctx = _uiCtx;
  if (_prevPlayerNameBounds) {
    const b = _prevPlayerNameBounds;
    ctx.clearRect(b.x, b.y, b.w, b.h);
  }
  ctx.font = 'bold 10px system-ui, Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  if (displayName !== _prevDisplayName) { _cachedNameTw = ctx.measureText(displayName).width; _prevDisplayName = displayName; }
  const tw = _cachedNameTw;
  ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
  ctx.strokeText(displayName, sx, sy);
  ctx.fillStyle = pvpMode ? '#f99' : '#7cf';
  ctx.fillText(displayName, sx, sy);
  _prevPlayerNameBounds = { x: sx - tw / 2 - 6, y: sy - 14, w: tw + 12, h: 18 };
  if (pvpMode) {
    drawIconCtx(_uiCtx, 'pvpOn', sx + 22 + 8, sy - 3, 9, '#f55');
    _prevPlayerNameBounds.w += 26;
  }
  ctx = _c;
}

// Render all HUD/UI elements to the overlay canvas at native DPR (~20fps)
function _renderUI() {
  if (!_uiCtx) return;
  const uiDPR = window.devicePixelRatio || 1;
  _uiCtx.clearRect(0, 0, _uiOverlay.width, _uiOverlay.height);
  _prevPlayerNameBounds = null; // cleared by the full wipe above
  _uiCtx.setTransform(uiDPR, 0, 0, uiDPR, 0, 0);
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

  // Pixel-lock the camera once per frame — to the DEVICE pixel grid, not
  // whole world pixels. At ZOOM 0.75 × DPR 2 one world px = 1.5 device px,
  // so world-integer rounding lands between device pixels: the background
  // scroll steps by 1.5 px and sprite-vs-camera rounding phases drift,
  // both visible as micro-jitter. Rounding camera.x*ZOOM*DPR to an integer
  // makes every world-grid-snapped draw land exactly on device pixels.
  const _grid = ZOOM * DPR;
  const _camX = _lastCamX = Math.round(camera.x * _grid) / _grid;
  const _camY = _lastCamY = Math.round(camera.y * _grid) / _grid;

  // Cache view bounds so _isOnScreen() avoids divisions on every call
  const _vM = 60;
  _vL = _camX - _vM; _vR = _camX + W / ZOOM + _vM;
  _vT = _camY - _vM; _vB = _camY + (H - HEADER_H) / ZOOM + _vM;

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const theme = (state === 'playing' || state === 'dead') && dungeon ? getTheme(dungeonLvl) : null;
  ctx.fillStyle = theme ? theme.bg : '#060610';
  ctx.fillRect(0, 0, W, H);
  if (state === 'select') return;

  ctx.save(); // [camera]
  ctx.beginPath(); ctx.rect(0, HEADER_H, W, H - HEADER_H); ctx.clip();
  ctx.translate(0, HEADER_H);
  ctx.scale(ZOOM, ZOOM);
  ctx.translate(-_camX, -_camY);

  if (tileCanvas) {
    ctx.imageSmoothingEnabled = false;
    // Draw only the visible slice; source rect is drawn back at the same
    // world coords (identity mapping), so the fractional camera is handled
    // entirely by the transform — flooring here only picks the region.
    const _tcSx = Math.max(0, Math.floor(_camX));
    const _tcSy = Math.max(0, Math.floor(_camY));
    const _tcSw = Math.min(tileCanvas.width  - _tcSx, Math.ceil(W  / ZOOM) + 2);
    const _tcSh = Math.min(tileCanvas.height - _tcSy, Math.ceil((H - HEADER_H) / ZOOM) + 2);
    if (_tcSw > 0 && _tcSh > 0)
      ctx.drawImage(tileCanvas, _tcSx, _tcSy, _tcSw, _tcSh, _tcSx, _tcSy, _tcSw, _tcSh);
  }
  // Moving art (sprites, drops, icons) draws at FLOAT positions with
  // bilinear filtering. Snapping movers to any pixel grid can't be smooth
  // here: the camera scrolls 3-4 device px per frame, so the rounding phase
  // sweeps a full pixel every couple of frames and snapped positions flip
  // ±1 px — the exact micro-jitter this replaces. Sub-pixel filtering costs
  // half a pixel of softness and gives perfectly even motion.
  ctx.imageSmoothingEnabled = true;

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
    if (_qualityTier > 0 && particles.length > 120) particles.length = 120;
    if (particles.length > 1) particles.sort((a, b) => (a.color > b.color) - (a.color < b.color));
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
    if (e.hp <= 0) return; // corpse playing its death animation — no bars/name/ring
    const ds = e.isBoss ? e.size * 4.5 : e.size * 6.75;
    const bw = Math.round(ds * 0.7), bh = 5, bx = e.x - bw / 2, by = e.y - ds * 0.55 - 8;
    if (e.isBoss) {
      ctx.globalAlpha = _bossGlow; ctx.strokeStyle = '#ff3232'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(e.x, e.y, e.size + 5, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#f44'; ctx.font = 'bold 9px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillText('БОСС', e.x, by - 14);
    }
    ctx.fillStyle = '#400'; ctx.fillRect(bx, by, bw, bh);
    const pct = e.hp / e.maxHp;
    ctx.fillStyle = pct > .5 ? '#2d2' : pct > .25 ? '#da2' : '#d22';
    ctx.fillRect(bx, by, bw * pct, bh);
    const _nl = _getEnemyNameLabel(e.name, e.isBoss);
    ctx.drawImage(_nl, Math.round(e.x - _nl._lw / 2), Math.round(by - _nl._lh - 1), _nl._lw, _nl._lh);
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
    // Pre-rendered name canvas — rebuilt when username, pvpMode, or render scale changes
    const _ns = Math.max(1, Math.ceil(DPR * ZOOM));
    if (!p._nameCanvas || p._nameCanvas._u !== (p.username || '?') || p._nameCanvas._pvp !== !!p.pvpMode || p._nameCanvas._scale !== _ns) {
      p._nameCanvas = _buildPlayerNameCanvas(p);
    }
    const nc = p._nameCanvas;
    ctx.drawImage(nc, Math.round(p.x - nc._lw / 2), Math.round(barTop - nc._lh - 2), nc._lw, nc._lh);
    if (p.pvpMode) {
      drawIconCtx(ctx, 'pvpOn', p.x + bw / 2 + 8, barTop - nc.height / 2 - 2, 9, '#f55');
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
    const usedSprite = _lastPlayerUsedSprite = drawSprite(player, hurtTint);
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
    const hpPct = Math.max(0, Math.min(1, player.hp / player.maxHp));

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

  // UI overlay — rendered to separate canvas at native DPR (~20fps), no blit needed
  ctx.globalAlpha = 1;
  if (_uiCtx && ts - _uiLastMs >= 50) { _uiLastMs = ts; _renderUI(); }
  // Player name drawn at 60fps on UI canvas so it tracks movement without lag
  if (_uiCtx && player && dungeon) _drawPlayerNameOnUI();
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
  // Gate the loading screen on BOTH player and floor-1 enemy sprites being decoded.
  const _floor1Eids = (FLOOR_ENEMIES[1]?.pool || []).concat([FLOOR_ENEMIES[1]?.boss]).filter(Boolean);
  let _spritesPending = 1 + _floor1Eids.length;
  const _onSpriteSetReady = () => { if (--_spritesPending === 0) csOnSpritesReady(); };
  _floor1Eids.forEach(eid => loadEnemySprites(eid, _onSpriteSetReady));
  loadSprites(type, _onSpriteSetReady);
  netSelectChar(type, savedStats);
}

// Pre-rendered player shadow (rx=13,ry=5 ellipse) — replaces per-frame ctx.ellipse+fill
const _playerShadow = (() => {
  const cv = document.createElement('canvas');
  cv.width = 32; cv.height = 14;
  const c = cv.getContext('2d');
  c.fillStyle = 'rgba(0,0,0,.3)';
  c.beginPath(); c.ellipse(16, 7, 13, 5, 0, 0, Math.PI * 2); c.fill();
  return cv;
})();

function _buildPlayerNameCanvas(p) {
  const uname = p.username || '?';
  const pvp = !!p.pvpMode;
  const scale = Math.max(1, Math.ceil(DPR * ZOOM));
  const tmp = document.createElement('canvas').getContext('2d');
  tmp.font = 'bold 10px system-ui, Arial';
  const tw = tmp.measureText(uname).width;
  const lw = Math.ceil(tw + 10), lh = 16;
  const cv = document.createElement('canvas');
  cv.width = Math.ceil(lw * scale); cv.height = Math.ceil(lh * scale);
  const c = cv.getContext('2d');
  c.scale(scale, scale);
  c.font = 'bold 10px system-ui, Arial';
  c.textAlign = 'center'; c.textBaseline = 'alphabetic';
  c.strokeStyle = '#000'; c.lineWidth = 3;
  c.strokeText(uname, lw / 2, lh - 2);
  c.fillStyle = pvp ? '#f99' : '#fff';
  c.fillText(uname, lw / 2, lh - 2);
  cv._u = uname; cv._pvp = pvp; cv._lw = lw; cv._lh = lh; cv._scale = scale;
  return cv;
}

function _getEnemyNameLabel(name, isBoss) {
  const scale = Math.max(1, Math.ceil(DPR * ZOOM));
  const key = `${name}|${isBoss}|${scale}`;
  let cv = _enemyNameLabels.get(key);
  if (cv) return cv;
  const font = isBoss ? 'bold 9px system-ui,Arial' : '8px system-ui,Arial';
  const tmp = document.createElement('canvas').getContext('2d');
  tmp.font = font;
  const tw = Math.ceil(tmp.measureText(name).width);
  const lw = tw + 8, lh = 13;
  cv = document.createElement('canvas');
  cv.width = Math.ceil(lw * scale); cv.height = Math.ceil(lh * scale);
  const c = cv.getContext('2d');
  c.scale(scale, scale);
  c.font = font; c.textAlign = 'center'; c.textBaseline = 'alphabetic';
  c.strokeStyle = '#000'; c.lineWidth = 2.5;
  c.strokeText(name, lw / 2, lh - 1);
  c.fillStyle = isBoss ? '#f88' : '#ddd';
  c.fillText(name, lw / 2, lh - 1);
  cv._lw = lw; cv._lh = lh;
  _enemyNameLabels.set(key, cv);
  return cv;
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
  // Float position + bilinear filtering — see drawSprite for rationale
  const dh = 80, dw = dh * fw / fh;
  const dx = p.x - dw / 2;
  const dy = p.y - dh * 0.62;
  ctx.drawImage(_playerShadow, p.x - 16, p.y + 11);
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
  _npcCache = null;
}

// NPC visuals are static (shadow + icon + name) except a pulsing aura ring —
// profiling showed the per-frame path fills / strokeText here cost ~1.1ms per
// frame (half the entire render budget). Pre-render each NPC once into an
// offscreen canvas and blit two images per frame instead; the ring lives on
// its own layer so its pulse is just globalAlpha at draw time.
let _npcCache = null;
const _NPC_RES = 2; // supersample so the ZOOM×DPR upscale stays crisp

function _buildNpcCache() {
  _npcCache = npcs.map(n => {
    const w = 96, h = 84, cx = 48, cy = 44; // world-px box, NPC center at (cx,cy)
    const cv = document.createElement('canvas');
    cv.width = w * _NPC_RES; cv.height = h * _NPC_RES;
    const c = cv.getContext('2d');
    c.scale(_NPC_RES, _NPC_RES);
    c.fillStyle = 'rgba(0,0,0,0.3)';
    c.beginPath(); c.ellipse(cx, cy + 18, 14, 5, 0, 0, Math.PI * 2); c.fill();
    // NOTE: the icon is NOT baked in — drawIconCtx's SVG image loads async and
    // would bake in empty on the first frame; it's blitted per-frame below.
    c.font = 'bold 10px system-ui, -apple-system, Arial';
    c.textAlign = 'center'; c.textBaseline = 'alphabetic';
    c.strokeStyle = '#000'; c.lineWidth = 3;
    c.strokeText(n.name, cx, cy - 26);
    c.fillStyle = n.color;
    c.fillText(n.name, cx, cy - 26);

    const rw = 52; // ring box: r=22 + lineWidth + margin
    const ring = document.createElement('canvas');
    ring.width = rw * _NPC_RES; ring.height = rw * _NPC_RES;
    const rc = ring.getContext('2d');
    rc.scale(_NPC_RES, _NPC_RES);
    rc.strokeStyle = n.color; rc.lineWidth = 2;
    rc.beginPath(); rc.arc(rw / 2, rw / 2, 22, 0, Math.PI * 2); rc.stroke();

    return { cv, ring, w, h, cx, cy, rw };
  });
}

function drawNpcs() {
  if (!npcs.length) return;
  if (!_npcCache || _npcCache.length !== npcs.length) _buildNpcCache();
  const _nPulse  = 0.7 + 0.3 * Math.sin(frameCount * 0.08);
  const _nBounce = Math.sin(frameCount * 0.15) * 3;
  const _smooth = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = true; // supersampled cache needs filtering
  for (let i = 0; i < npcs.length; i++) {
    const n = npcs[i];
    // NPCs cluster at spawn — skip entirely when off-screen
    if (n.x < _vL || n.x > _vR || n.y < _vT || n.y > _vB) continue;
    const cc = _npcCache[i];
    ctx.globalAlpha = _nPulse;
    ctx.drawImage(cc.ring, n.x - cc.rw / 2, n.y - cc.rw / 2, cc.rw, cc.rw);
    ctx.globalAlpha = 1;
    ctx.drawImage(cc.cv, n.x - cc.cx, n.y - cc.cy, cc.w, cc.h);
    drawIconCtx(ctx, n.icon, n.x, n.y, 28, n.color);
    if (nearNpc && nearNpc.id === n.id) {
      drawIconCtx(ctx, 'chat', n.x, n.y - 44 + _nBounce, 18, '#fff');
    }
  }
  ctx.imageSmoothingEnabled = _smooth;
}

function buildTileCanvas() {
  if (!dungeon) return;
  const th = getTheme(dungeonLvl);
  tileCanvas = document.createElement('canvas');
  tileCanvas.width  = dungeon.w * TILE;
  tileCanvas.height = dungeon.h * TILE;
  const tctx = tileCanvas.getContext('2d');

  function isFloor(tx, ty) {
    return tx >= 0 && tx < dungeon.w && ty >= 0 && ty < dungeon.h
      && dungeon.grid[ty][tx] === FLOOR;
  }

  // Pass 1: fill entire canvas with wall base color
  tctx.fillStyle = th.wallColor;
  tctx.fillRect(0, 0, dungeon.w * TILE, dungeon.h * TILE);

  // Pass 2: subtle masonry pattern across the whole canvas —
  // horizontal brick rows every 10 px + staggered vertical joints.
  // These are drawn before floor tiles so they only show on wall areas.
  tctx.strokeStyle = th.wallEdge;
  tctx.lineWidth   = 1;
  tctx.globalAlpha = 0.22;
  const bH = 10; // brick row height in pixels
  for (let row = 0; row <= dungeon.h * TILE; row += bH) {
    const rowNum = (row / bH) | 0;
    const off    = (rowNum % 2 === 0 ? 0 : (TILE >> 1));
    tctx.beginPath();
    tctx.moveTo(0, row); tctx.lineTo(dungeon.w * TILE, row);
    tctx.stroke();
    for (let col = off % TILE; col <= dungeon.w * TILE; col += TILE) {
      tctx.beginPath();
      tctx.moveTo(col, row); tctx.lineTo(col, row + bH);
      tctx.stroke();
    }
  }
  tctx.globalAlpha = 1;

  // Pass 3: fill floor tiles with a subtle checkerboard shade
  for (let ty = 0; ty < dungeon.h; ty++) {
    for (let tx = 0; tx < dungeon.w; tx++) {
      if (dungeon.grid[ty][tx] !== FLOOR) continue;
      tctx.fillStyle = (tx + ty) % 2 === 0 ? th.floorA : th.floorB;
      tctx.fillRect(tx * TILE, ty * TILE, TILE, TILE);
    }
  }

  // Pass 4: 1-px grout lines between floor tiles (top + left edges only)
  tctx.fillStyle = th.grout;
  for (let ty = 0; ty < dungeon.h; ty++) {
    for (let tx = 0; tx < dungeon.w; tx++) {
      if (dungeon.grid[ty][tx] !== FLOOR) continue;
      const x = tx * TILE, y = ty * TILE;
      tctx.fillRect(x, y, TILE, 1);
      tctx.fillRect(x, y, 1, TILE);
    }
  }

  // Pass 5: wall top-edge highlight — classic RPG "3-D depth" effect.
  // Where a wall tile has a floor tile directly below, paint the bottom
  // strip of the wall tile with a bright-to-transparent gradient so it
  // looks like you're viewing the lit top face of a 3-D wall.
  for (let ty = 0; ty < dungeon.h; ty++) {
    for (let tx = 0; tx < dungeon.w; tx++) {
      if (dungeon.grid[ty][tx] !== WALL) continue;
      if (!isFloor(tx, ty + 1)) continue;
      const x = tx * TILE, y = ty * TILE;
      const g = tctx.createLinearGradient(0, y + TILE - 7, 0, y + TILE);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(1, `rgba(255,255,255,${th.wallHighlight})`);
      tctx.fillStyle = g;
      tctx.fillRect(x, y + TILE - 7, TILE, 7);
    }
  }

  // Pass 6: wall face decorations — lanterns, skulls, chains, etc.
  if (th.drawWallDecor) {
    for (let ty = 0; ty < dungeon.h; ty++) {
      for (let tx = 0; tx < dungeon.w; tx++) {
        if (dungeon.grid[ty][tx] !== WALL) continue;
        if (!isFloor(tx, ty + 1)) continue;
        const h = ((tx * 37) ^ (ty * 53)) & 0xff;
        tctx.save();
        th.drawWallDecor(tctx, tx * TILE, ty * TILE, h);
        tctx.restore();
      }
    }
  }

  // Pass 8: seeded random crack/detail lines on floor tiles
  // — adds life without the per-tile noise of the old approach.
  const seed = dungeonLvl * 1234;
  function rng(n) { const v = Math.sin(seed + n) * 43758.5453; return v - Math.floor(v); }

  const floorTiles = [];
  for (let ty = 0; ty < dungeon.h; ty++)
    for (let tx = 0; tx < dungeon.w; tx++)
      if (dungeon.grid[ty][tx] === FLOOR) floorTiles.push([tx, ty]);

  tctx.strokeStyle = th.crackColor;
  tctx.lineWidth   = 1;
  const detailCount = Math.floor(floorTiles.length * 0.09);
  for (let i = 0; i < detailCount; i++) {
    const idx = Math.floor(rng(i * 7 + 1) * floorTiles.length);
    const [fx, fy] = floorTiles[idx];
    const ox = fx * TILE + 4 + rng(i * 7 + 5) * (TILE - 8);
    const oy = fy * TILE + 4 + rng(i * 7 + 6) * (TILE - 8);
    const len = 5 + rng(i * 7 + 2) * 14;
    const ang = rng(i * 7 + 3) * Math.PI;
    tctx.globalAlpha = th.crackAlpha * (0.5 + rng(i * 7 + 4) * 0.5);
    tctx.beginPath();
    tctx.moveTo(ox, oy);
    tctx.lineTo(ox + Math.cos(ang) * len, oy + Math.sin(ang) * len);
    tctx.stroke();
  }
  tctx.globalAlpha = 1;

  // Pass 9: soft shadow on floor tiles at wall edges
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
  socket?.emit('playerMove', { x: player.x, y: player.y, facing: player.facing });
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
  const _t0 = performance.now();
  update(dt);
  const _t1 = performance.now();
  render(dt, ts);
  const _t2 = performance.now();
  _profUpdate = _t1 - _t0;
  _profRender = _t2 - _t1;
  _profSocketEvtsSnap = _profSocketEvts; _profSocketEvts = 0;
  _profSocketMsSnap = _profSocketMs; _profSocketMs = 0;
  // Draw perf overlay on UI canvas so it's always on top and at native DPR
  if (_uiCtx) { const _c = ctx; ctx = _uiCtx; _drawPerf(frameMs); ctx = _c; }
  else { _drawPerf(frameMs); }
  requestAnimationFrame(loop);
}

window.addEventListener('beforeunload', () => { netSaveProgress(); });

window.addEventListener('load', () => {
  canvas = document.getElementById('canvas');
  ctx = canvas.getContext('2d', { alpha: false });
  _uiOverlay = document.getElementById('ui-canvas');
  const app = document.getElementById('app');
  const _isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

  const resize = () => {
    DPR = _isMobile ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    W = app.clientWidth;
    H = app.clientHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    // UI overlay: always native DPR for crisp header and labels
    const uiDPR = window.devicePixelRatio || 1;
    _uiOverlay.width = Math.round(W * uiDPR);
    _uiOverlay.height = Math.round(H * uiDPR);
    _uiCtx = _uiOverlay.getContext('2d');
    _skillBtnGradCache = null;  // force skill button gradient rebuild
    _uiBtnGrads = null;         // force button gradient rebuild
    _partyHpGrads = null;       // force party HP gradient rebuild
    updateJoyCenter();          // recompute cached joystick center
    if (dungeon) clampCamera();
  };
  resize(); window.addEventListener('resize', resize);
  _talkBtn = document.getElementById('npc-talk-btn');
  initInput();
  requestAnimationFrame(ts => { lastTs = ts; _loopTs = ts; requestAnimationFrame(loop); });
});
