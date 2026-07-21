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
  // Adaptive quality: drop to tier 1 when FPS stays < 30 for ~3s; recover when FPS > 50.
  // This is a safety net for weak devices — normal mobile play stays at tier 0
  // since render is already capped at ~30fps (see loop()) well before this kicks in.
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

// UI overlay canvas (separate DOM element at native DPR)
let _uiOverlay, _uiCtx = null;
// HUD cache canvas — _renderUI() draws here at 20fps; blitted every frame (cheap drawImage)
let _hudCv = null, _hudCvCtx = null, _uiLastMs = 0;
// Camera position cached for UI overlay coordinate conversion
let _lastCamX = 0, _lastCamY = 0;
// Player sprite state flag (used by _drawPlayerNameOnUI for bar offset)
let _lastPlayerUsedSprite = false;
// measureText cache for player name label — avoids per-frame call when name unchanged
let _prevDisplayName = '', _cachedNameTw = 0;
// Clan tag cache: icon pre-rendered to offscreen canvas; blit with drawImage (1 call vs 256 fillRects)
let _clanIconCv = null, _clanIconKey = null, _prevClanName = '', _cachedClanTw = 0;
// last damage dealt by player — used for optimistic kill prediction on arrow hit
let _lastOwnDmg = 0;

// Reusable sentinel for pvp closest-target — avoids per-frame object spread
const _pvpSentinel = { _socketId: null, x: 0, y: 0 };

// Visible enemy count (set each render frame, read by _drawPerf)
let _visEnm = 0;

// Profiling breakdown — measures update vs render vs socket processing
let _profUpdate = 0, _profRender = 0;
let _profSocketEvts = 0, _profSocketMs = 0;
let _profSocketEvtsSnap = 0, _profSocketMsSnap = 0;


// ─────────────────────────────────────────────────────────
//  CAMERA
// ─────────────────────────────────────────────────────────
// Height actually free for gameplay: the bottom nav is an opaque overlay
// docked to the bottom of #app, not extra canvas space, so it must come off
// the same as the header or the camera treats that strip as visible and can
// center/clamp the player right behind it (invisible, same for chunk streaming).
function _visH() { return (H - HEADER_H - NAV_H) / ZOOM; }

function clampCamera() {
  const visW = W / ZOOM, visH = _visH();
  camera.x = clamp(camera.x, 0, Math.max(0, dungeon.w * TILE - visW));
  camera.y = clamp(camera.y, 0, Math.max(0, dungeon.h * TILE - visH));
}

function updateCamera(dt) {
  const visW = W / ZOOM, visH = _visH();
  const tx = player.x - visW / 2;
  const ty = player.y - visH / 2;
  // Velocity-matched follow. A lerp toward the target trails the player by
  // speed/k while running, and frame-time noise makes that trail length
  // fluctuate — visible as the player wobbling ±1px on screen every uneven
  // frame. Instead, decay the camera→target OFFSET in error space: the
  // camera then moves 1:1 with the player at all times (zero relative
  // wobble), while a large offset (teleport, charge, respawn nearby) still
  // glides down smoothly. Once within a device pixel the offset snaps to 0.
  let ox = camera.x - tx, oy = camera.y - ty;
  const decay = Math.exp(-6 * dt);
  ox *= decay; oy *= decay;
  const _devPx = 1 / (ZOOM * DPR);
  if (Math.abs(ox) < _devPx) ox = 0;
  if (Math.abs(oy) < _devPx) oy = 0;
  camera.x = tx + ox;
  camera.y = ty + oy;
  clampCamera();
}

// Returns the room (from dungeon.rooms) that contains world-pixel point (wx,wy),
// or null if the point is in a corridor or no room data exists.
function _getRoomAt(wx, wy) {
  if (!dungeon || !dungeon.rooms) return null;
  const tx = Math.floor(wx / TILE), ty = Math.floor(wy / TILE);
  for (let i = 0; i < dungeon.rooms.length; i++) {
    const r = dungeon.rooms[i];
    if (!r.size) continue; // old-format rooms without size field
    if (tx >= r.x && tx < r.x + r.size && ty >= r.y && ty < r.y + r.size) return r;
  }
  return null;
}

// ─────────────────────────────────────────────────────────
//  UPDATE
// ─────────────────────────────────────────────────────────
function update(dt) {
  if (state !== 'playing') return;
  frameCount++;
  if (transTimer > 0) { transTimer -= dt; return; }

  if (activeTab === 0) {
    if (player.atkAnimTimer <= 0 && (player.stunTimer || 0) <= 0) {
      const inp = inputDir();
      const _spdMult = (player.slowTimer || 0) > 0 ? 0.35 : 1;
      if (inp.len > 0) {
        player._chasing = false;
        const vx = inp.dx * player.speed * _spdMult * inp.len * dt;
        const vy = inp.dy * player.speed * _spdMult * inp.len * dt;
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
      } else if (autoAttackMode && targetId) {
        // Chase locked target when no manual input (auto-attack only)
        const _chEnt = targetIsPlayer ? otherPlayers.get(targetId) : serverEnemiesMap.get(targetId);
        if (_chEnt && (_chEnt.hp || 0) > 0) {
          const _cdx = _chEnt.x - player.x, _cdy = _chEnt.y - player.y;
          const _clen = Math.hypot(_cdx, _cdy);
          if (_clen > player.charDef.atkRange * 0.85) {
            const nvx = (_cdx / _clen) * player.speed * _spdMult * dt;
            const nvy = (_cdy / _clen) * player.speed * _spdMult * dt;
            if (canMoveX(player, nvx, 12)) player.x += nvx;
            if (canMoveY(player, nvy, 12)) player.y += nvy;
            faceTowards(_chEnt.x, _chEnt.y);
            player._chasing = true;
          } else {
            player._chasing = false;
          }
        } else {
          player._chasing = false;
        }
      } else {
        player._chasing = false;
      }
    }

    // Push player out of enemies — record position first so we can compensate the
    // camera immediately after, preventing push-back from showing as screen jitter
    const _prePushX = player.x, _prePushY = player.y;
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

    // Absorb push-back into camera immediately — without this the camera
    // lerps at 13% per frame while the player can move 5-15px in a single
    // push step, making the character visibly jump on screen
    camera.x += player.x - _prePushX;
    camera.y += player.y - _prePushY;

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

  // Potion cooldown tick
  if ((player.potCd || 0) > 0) player.potCd = Math.max(0, player.potCd - dt);

  // Buff timers tick
  const _buffs = player.buffs || (player.buffs = {});
  let _buffChanged = false;
  for (const btype of Object.keys(_buffs)) {
    if (_buffs[btype] > 0) {
      _buffs[btype] -= dt;
      if (_buffs[btype] <= 0) {
        _buffs[btype] = 0;
        _buffChanged = true;
        // auto-reapply if more in inventory
        const bdef = ITEM_DEF.find(d => d.buffType === btype && d.slot === 'buff_potion');
        if (bdef && countMaterial(bdef.id) > 0) {
          useBuffPotion(bdef.id);
          _buffChanged = false;
        }
      }
    }
  }
  if (_buffChanged) { recompute(); if (typeof updateInvUI === 'function') updateInvUI(); }

  // Auto-use HP potion
  const _autoPct = player.autoHpPct || 0;
  if (_autoPct > 0 && player.potCd <= 0 && player.hp < player.maxHp * _autoPct) {
    usePotion();
  }
  // Safe zone regen: +1 HP/sec; auto-disable PvP on entry
  if (inSafeZone(player.x, player.y)) {
    if (player.hp < player.maxHp) player.hp = Math.min(player.maxHp, player.hp + dt);
    if (pvpMode) {
      pvpMode = false;
      if (typeof netSetPvpMode === 'function') netSetPvpMode(false);
      if (targetIsPlayer) { targetId = null; targetIsPlayer = false; }
      dmgNum(player.x, player.y - 40, 'ПК режим выключен', '#7cf');
    }
  }

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
        if (player.charDef.atkType === 'ranged') {
          // For ranged: fire projectile carrying enemyId; netAttack sent on visual hit
          const _e = serverEnemiesMap.get(pa.id);
          fireProj(_e?.x ?? pa.x, _e?.y ?? pa.y, pa.id);
        } else {
          netAttack(pa.id);
        }
      }
    }
  }
  if (player.atkAnimTimer <= 0) { player.pendingAttack = null; player.attackFired = false; }

  // Auto-attack (skip timer decrement in manual mode; block when stunned)
  if (autoAttackMode && (player.stunTimer || 0) <= 0) player.atkTimer -= dt;
  if (player.atkTimer <= 0 && (player.stunTimer || 0) <= 0) {
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
      const _pRoom = _getRoomAt(player.x, player.y);
      let closestD2 = Infinity;
      serverEnemies.forEach(e => {
        if ((e.hp || 0) <= 0) return;
        // When player is inside a room, only target enemies in that same room
        if (_pRoom) {
          const etx = Math.floor(e.x / TILE), ety = Math.floor(e.y / TILE);
          if (etx < _pRoom.x || etx >= _pRoom.x + _pRoom.size ||
              ety < _pRoom.y || ety >= _pRoom.y + _pRoom.size) return;
        }
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

    // If locked target is in a different room, release it so chase stops
    if (targetId && !targetIsPlayer) {
      const _pRoom = _getRoomAt(player.x, player.y);
      if (_pRoom) {
        const _lt = serverEnemiesMap.get(targetId);
        if (_lt && (_lt.hp || 0) > 0) {
          const etx = Math.floor(_lt.x / TILE), ety = Math.floor(_lt.y / TILE);
          if (etx < _pRoom.x || etx >= _pRoom.x + _pRoom.size ||
              ety < _pRoom.y || ety >= _pRoom.y + _pRoom.size) {
            targetId = null; targetIsPlayer = false;
          }
        }
      }
    }

    const atkRange = player.charDef.atkRange * (closestIsPlayer ? 1.3 : 1);
    if (!closest || closestD >= atkRange || !hasLOS(player.x, player.y, closest.x, closest.y)) {
      // Lock onto closest enemy so the chase system engages
      if (closest && !targetId) {
        targetId = closestIsPlayer ? closest._socketId : closest.id;
        targetIsPlayer = closestIsPlayer;
      }
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
      // Cancel projectile early if its locked target is already dead
      if (p.enemyId && (serverEnemiesMap.get(p.enemyId)?.hp || 0) <= 0) continue;
      if (p.isPlayer) {
        const ps = p.size; let hit = false; let hitEnemy = null;
        for (let k = 0; k < serverEnemies.length; k++) {
          const e = serverEnemies[k];
          if ((e.hp || 0) <= 0) continue;
          const r = e.size + ps, ex = p.x - e.x, ey = p.y - e.y;
          if (ex * ex + ey * ey < r * r) { hit = true; hitEnemy = e; break; }
        }
        if (hit) {
          spawnBurst(p.x, p.y, p.color, 5);
          const _atkId = p.enemyId || hitEnemy?.id;
          if (_atkId) {
            netAttack(_atkId);
            // Optimistic feedback — no waiting for server round-trip
            const _he = serverEnemiesMap.get(_atkId);
            if (_he && _he.hp > 0) {
              _he.hurtTimer = 0.3; // instant hurt flash
              // Predict kill if last known damage would finish it
              if (_lastOwnDmg > 0 && _lastOwnDmg >= _he.hp) _he.hp = 0;
            }
          }
          continue;
        }
        if (pvpMode) {
          let _hitOpId = null;
          for (const [_opId, op] of otherPlayers) {
            if ((op.hp || 0) <= 0 || op.x == null) continue;
            const r = 18 + ps, ex = p.x - op.x, ey = p.y - op.y;
            if (ex * ex + ey * ey < r * r) { _hitOpId = _opId; break; }
          }
          if (_hitOpId) {
            if (p.pvpMult) netPvpSkillAttack(_hitOpId, p.pvpMult);
            spawnBurst(p.x, p.y, p.color, 5);
            continue;
          }
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
    for (let i = 0; i < aoeRings.length; i++) {
      aoeRings[i].life -= dt;
      if (aoeRings[i].life > 0) aoeRings[j++] = aoeRings[i];
    }
    aoeRings.length = j;
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
    dmgNums.length = Math.min(j, _qualityTier > 0 ? 14 : 28);
  }

  // Skill timers
  if (player.skillCooldowns) {
    const cds = player.skillCooldowns;
    if (cds.Q > 0) cds.Q -= dt;
    if (cds.W > 0) cds.W -= dt;
    if (cds.E > 0) cds.E -= dt;
    if (cds.R > 0) cds.R -= dt;
  }
  if (barrierTimer > 0) { barrierTimer -= dt; if (barrierTimer <= 0) { barrierTimer = 0; recompute(); } }
  if (battleCryTimer > 0) { battleCryTimer -= dt; if (battleCryTimer <= 0) { battleCryTimer = 0; recompute(); } }
  if (dodgeTimer > 0) dodgeTimer -= dt;
  if (atkSpeedTimer > 0) { atkSpeedTimer -= dt; if (atkSpeedTimer <= 0) { atkSpeedTimer = 0; recompute(); } }
  if (faithShieldTimer > 0) { faithShieldTimer -= dt; if (faithShieldTimer <= 0) { faithShieldTimer = 0; recompute(); } }
  if (invisTimer > 0) { invisTimer -= dt; if (invisTimer <= 0) { invisTimer = 0; if (typeof netPlayerInvis === 'function') netPlayerInvis(false); } }
  if ((player.stunTimer || 0) > 0) { player.stunTimer -= dt; if (player.stunTimer <= 0) player.stunTimer = 0; }
  if ((player.slowTimer || 0) > 0) { player.slowTimer -= dt; if (player.slowTimer <= 0) player.slowTimer = 0; }
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
    if ((op._swingTimer || 0) > 0) op._swingTimer -= dt;
    if ((op.stunTimer || 0) > 0) op.stunTimer -= dt;
    if ((op.slowTimer || 0) > 0) op.slowTimer -= dt;
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
    if ((e.stunTimer || 0) > 0) e.stunTimer -= dt;
    if ((e.slowTimer || 0) > 0) e.slowTimer -= dt;
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

    if ((e.stunTimer || 0) > 0) {
      if (e.targetX !== undefined) {
        const cedx = e.targetX - e.x, cedy = e.targetY - e.y;
        const err2 = cedx * cedx + cedy * cedy;
        if (err2 > 100) { const k = 1 - Math.exp(-2.5 * dt); e.x += cedx * k; e.y += cedy * k; }
      }
      return;
    }
    if (e.aggro && dp > sz + 14) {
      const nx = (closestTgt.x - e.x) / dp;
      const ny = (closestTgt.y - e.y) / dp;
      if (Math.abs(nx) >= Math.abs(ny)) e._facing = nx > 0 ? 'right' : 'left';
      else                              e._facing = ny > 0 ? 'down'  : 'up';
      const er  = sz * 0.55;
      const spdMult = (e.slowTimer || 0) > 0 ? 0.35 : 1;
      const evx = nx * spd * spdMult * dt;
      const evy = ny * spd * spdMult * dt;
      if (canMoveX(e, evx, er)) e.x += evx;
      if (canMoveY(e, evy, er)) e.y += evy;
      e._moveTimer = 0.2;
    }

    // Server correction — squared fast-reject avoids sqrt when error < 10px.
    // Exponential (frame-rate independent) pull: constant-time correction
    // whether the device runs at 30 or 60fps, so no visible speed-up jerks.
    if (e.targetX !== undefined) {
      const cedx = e.targetX - e.x, cedy = e.targetY - e.y;
      const err2 = cedx * cedx + cedy * cedy;
      if (err2 > 100) {
        const k = 1 - Math.exp(-(err2 > 150 * 150 ? 13 : 2.5) * dt);
        e.x += cedx * k; e.y += cedy * k;
      }
    }
  });
  if (_corpseExpired) {
    let j = 0;
    for (let i = 0; i < serverEnemies.length; i++) {
      const e = serverEnemies[i];
      if (e._deathTimer !== undefined && e._deathTimer <= 0) {
        serverEnemiesMap.delete(e.id);
        if (typeof pixiRemoveEnemy === 'function') pixiRemoveEnemy(e.id);
        continue;
      }
      serverEnemies[j++] = e;
    }
    serverEnemies.length = j;
  }

  updateCamera(dt);
}

// ─────────────────────────────────────────────────────────
//  RENDER
// ─────────────────────────────────────────────────────────

function _drawPlayerNameOnUI() {
  const barTop = _lastPlayerUsedSprite ? player.y - 39 : player.y - 28;
  const nameY = barTop - 4;
  const sx = (player.x - _lastCamX) * ZOOM;
  const sy = (nameY - _lastCamY) * ZOOM + HEADER_H;
  const displayName = (netUsername || player.charDef.name).slice(0, 16);

  ctx.font = 'bold 10px system-ui, Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  if (displayName !== _prevDisplayName) { _cachedNameTw = ctx.measureText(displayName).width; _prevDisplayName = displayName; }
  const tw = _cachedNameTw;

  // Clan tag: icon (pre-rendered, 1 drawImage) + name. Both cached to avoid per-frame cost.
  if (typeof clanData !== 'undefined' && clanData && clanData.name) {
    const iconKey = String(clanData.icon || 1);
    if (!_clanIconCv || _clanIconKey !== iconKey) {
      // Build once per clan icon change (256 fillRects happens only here)
      _clanIconKey = iconKey;
      const px = Math.ceil(DPR);
      _clanIconCv = document.createElement('canvas');
      _clanIconCv.width = 16 * px; _clanIconCv.height = 16 * px;
      drawClanIconOnCtx(_clanIconCv.getContext('2d'), clanData.icon || 1, 8 * px, 8 * px, px);
    }
    ctx.font = 'bold 9px system-ui, Arial';
    if (clanData.name !== _prevClanName) { _cachedClanTw = ctx.measureText(clanData.name).width; _prevClanName = clanData.name; }
    const iconDisp = 14, gap = 3;
    // Not rounded to whole pixels: sx/sy (and the name text below) move
    // continuously as the player moves, so rounding just this element made
    // it step pixel-by-pixel out of sync with everything around it — the
    // clan tag visibly lagged/jittered relative to the name during movement.
    const lineX = sx - (iconDisp + gap + _cachedClanTw) / 2;
    const lineY = sy - 16;
    ctx.drawImage(_clanIconCv, lineX, lineY - iconDisp / 2, iconDisp, iconDisp);
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.strokeStyle = '#000'; ctx.lineWidth = 2.5;
    ctx.strokeText(clanData.name, lineX + iconDisp + gap, lineY);
    ctx.fillStyle = '#f93';
    ctx.fillText(clanData.name, lineX + iconDisp + gap, lineY);
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'center';
    ctx.font = 'bold 10px system-ui, Arial';
  }

  ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
  ctx.strokeText(displayName, sx, sy);
  ctx.fillStyle = pvpMode ? '#f99' : '#7cf';
  ctx.fillText(displayName, sx, sy);
  if (pvpMode) drawIconCtx(_uiCtx, 'pvpOn', sx + tw / 2 + 8, sy - 3, 9, '#f55');
}

// Other players can show several distinct clans on screen at once, so unlike
// the single-slot cache above this is keyed by icon id (+ DPR, in case it
// changes on resize). Still just a handful of small canvases in the worst case.
const _otherClanIconCv = new Map();
function _getOtherClanIconCv(iconId) {
  const px = Math.ceil(DPR);
  const key = (iconId || 1) + '@' + px;
  let cv = _otherClanIconCv.get(key);
  if (cv) return cv;
  cv = document.createElement('canvas');
  cv.width = 16 * px; cv.height = 16 * px;
  drawClanIconOnCtx(cv.getContext('2d'), iconId || 1, 8 * px, 8 * px, px);
  _otherClanIconCv.set(key, cv);
  return cv;
}

// Other players' username + clan tag, drawn on the 2D overlay at native
// screen resolution every frame — mirrors _drawPlayerNameOnUI above so
// remote players read exactly as crisp and jitter-free as the local player,
// instead of the blurry/wobbly look a WebGL-scaled PIXI.Text gave them
// (see pixi-world.js _getOtherPlayer). p._nameBarTop is written each frame
// by _updateOtherPlayers right before this runs.
function _drawOtherPlayerNamesOnUI() {
  if (!otherPlayers.size) return;
  otherPlayers.forEach(p => {
    if (p.x == null || isNaN(p.x) || !_isOnScreen(p.x, p.y)) return;
    const barTop = p._nameBarTop ?? -20;
    const nameY  = p.y + barTop - 3;
    const sx = (p.x - _lastCamX) * ZOOM;
    const sy = (nameY - _lastCamY) * ZOOM + HEADER_H;
    const uname = (p.username || '?').slice(0, 16);

    ctx.font = 'bold 10px system-ui, Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    if (uname !== p._prevUname) { p._unameTw = ctx.measureText(uname).width; p._prevUname = uname; }

    const cname = p.clanName || '';
    if (cname) {
      ctx.font = 'bold 9px system-ui, Arial';
      if (cname !== p._prevClanName) { p._clanTw = ctx.measureText(cname).width; p._prevClanName = cname; }
      const iconDisp = 14, gap = 3;
      // Not rounded — see the matching comment in _drawPlayerNameOnUI.
      const lineX = sx - (iconDisp + gap + p._clanTw) / 2;
      const lineY = sy - 16;
      ctx.drawImage(_getOtherClanIconCv(p.clanIcon || 1), lineX, lineY - iconDisp / 2, iconDisp, iconDisp);
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.strokeStyle = '#000'; ctx.lineWidth = 2.5;
      ctx.strokeText(cname, lineX + iconDisp + gap, lineY);
      ctx.fillStyle = '#f93';
      ctx.fillText(cname, lineX + iconDisp + gap, lineY);
      ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'center';
      ctx.font = 'bold 10px system-ui, Arial';
    }

    ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
    ctx.strokeText(uname, sx, sy);
    ctx.fillStyle = p.pvpMode ? '#f99' : '#fff';
    ctx.fillText(uname, sx, sy);
  });
}

// Enemy name/boss labels — 2D overlay, mirrors _drawOtherPlayerNamesOnUI.
// e._nameBarTop is written each frame by _updateEnemyObj (pixi-world.js)
// right before this runs; skipped for corpses (hp <= 0), which don't get a
// bar/label in _updateEnemyObj so _nameBarTop may be stale from before death.
function _drawEnemyNamesOnUI() {
  if (!serverEnemies.length) return;
  serverEnemies.forEach(e => {
    if ((e.hp || 0) <= 0 || e._nameBarTop === undefined || !_isOnScreen(e.x, e.y)) return;
    const nameY = e.y + e._nameBarTop - 4;
    const sx = (e.x - _lastCamX) * ZOOM;
    const sy = (nameY - _lastCamY) * ZOOM + HEADER_H;
    const lblText = e.isBoss ? `⚠ БОСС · ${e.name || ''}` : (e.name || '');
    if (!lblText) return;

    ctx.font = (e.isBoss ? 'bold 13px' : 'bold 10px') + ' system-ui, Arial';
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.strokeStyle = '#000'; ctx.lineWidth = e.isBoss ? 3.5 : 3;
    ctx.strokeText(lblText, sx, sy);
    ctx.fillStyle = e.isBoss ? '#ff9999' : '#e8e8e8';
    ctx.fillText(lblText, sx, sy);
  });
}

// Render all HUD/UI elements to the overlay canvas (called every frame from render())
function _renderUI() {
  if (!_uiCtx) return;
  drawHeader();
  if (typeof drawQuestNotif === 'function') drawQuestNotif();
  drawPvpButton();
  drawBuffStrip();
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
}


// Cached per-frame view bounds — updated once at the top of render(), read by _isOnScreen
let _vL = 0, _vR = 0, _vT = 0, _vB = 0;
let _nowMs = 0;
function render(dt, ts) {
  _nowMs = ts;
  const _camX = _lastCamX = camera.x;
  const _camY = _lastCamY = camera.y;
  const _vM = 60;
  _vL = _camX - _vM; _vR = _camX + W / ZOOM + _vM;
  _vT = _camY - _vM; _vB = _camY + (H - HEADER_H) / ZOOM + _vM;

  const theme = (state === 'playing' || state === 'dead') && dungeon ? getTheme(dungeonLvl) : null;

  // ── PixiJS world ─────────────────────────────────────────
  if (state !== 'select') {
    pixiWorldRender(dt, ts, _camX, _camY, theme);
  } else {
    pixiSetBg('#060610');
    pixiClearWorld();
  }

  // ── UI canvas — cleared every frame so layers don't accumulate ──────────────
  _uiCtx.clearRect(0, 0, _uiOverlay.width, _uiOverlay.height);
  _uiCtx.setTransform(DPR, 0, 0, DPR, 0, 0);

  // HUD panels: rebuild cache at 20fps, blit every frame (cheap drawImage)
  if (ts - _uiLastMs >= 50) {
    _uiLastMs = ts;
    if (!_hudCv || _hudCv.width !== _uiOverlay.width || _hudCv.height !== _uiOverlay.height) {
      _hudCv = document.createElement('canvas');
      _hudCv.width = _uiOverlay.width;
      _hudCv.height = _uiOverlay.height;
      _hudCvCtx = _hudCv.getContext('2d');
    }
    _hudCvCtx.clearRect(0, 0, _hudCv.width, _hudCv.height);
    _hudCvCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const _prevCtx = ctx; ctx = _hudCvCtx;
    _renderUI();
    ctx = _prevCtx;
  }
  if (_hudCv) {
    _uiCtx.setTransform(1, 0, 0, 1, 0, 0);
    _uiCtx.drawImage(_hudCv, 0, 0);
    _uiCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  // Player name + joystick: 60fps (smooth, cheap)
  if (player && dungeon) _drawPlayerNameOnUI();
  if (dungeon) _drawOtherPlayerNamesOnUI();
  if (dungeon) _drawEnemyNamesOnUI();
  if (activeTab === 0) drawJoystick();

  // Safe zone HUD label (on top of HUD)
  if (player && dungeon && typeof inSafeZone === 'function' && inSafeZone(player.x, player.y)) {
    const lbl = '🛡 Безопасная зона · реген HP';
    _uiCtx.font = 'bold 11px system-ui, Arial';
    _uiCtx.textAlign = 'center'; _uiCtx.textBaseline = 'alphabetic';
    const lw = _uiCtx.measureText(lbl).width;
    _uiCtx.fillStyle = 'rgba(0,0,0,0.55)';
    _uiCtx.fillRect(W / 2 - lw / 2 - 6, HEADER_H + 6, lw + 12, 18);
    _uiCtx.fillStyle = '#4de87a';
    _uiCtx.fillText(lbl, W / 2, HEADER_H + 20);
  }

  // Raid wave notification
  if (_raidWaveNotif && _raidWaveNotif.timer > 0) {
    _raidWaveNotif.timer -= dt;
    const alpha = Math.min(1, _raidWaveNotif.timer * 2);
    const lbl = _raidWaveNotif.text;
    _uiCtx.font = 'bold 20px system-ui, Arial';
    _uiCtx.textAlign = 'center'; _uiCtx.textBaseline = 'alphabetic';
    const lw = _uiCtx.measureText(lbl).width;
    _uiCtx.globalAlpha = alpha;
    _uiCtx.fillStyle = 'rgba(0,0,0,0.65)';
    _uiCtx.fillRect(W / 2 - lw / 2 - 14, H / 2 - 40, lw + 28, 34);
    _uiCtx.fillStyle = '#fff';
    _uiCtx.fillText(lbl, W / 2, H / 2 - 12);
    _uiCtx.globalAlpha = 1;
    if (_raidWaveNotif.timer <= 0) _raidWaveNotif = null;
  }

  // Transition flash (topmost layer)
  if (transTimer > 0) {
    _uiCtx.fillStyle = `rgba(180,120,255,${Math.min(1, transTimer * 3)})`;
    _uiCtx.fillRect(0, 0, W, H);
  }
}

// ─────────────────────────────────────────────────────────
//  GAME FLOW
// ─────────────────────────────────────────────────────────
function goToFloor(n) {
  if (n === dungeonLvl || !player) return;
  const req = (typeof FLOOR_UNLOCK_LEVEL !== 'undefined') ? (FLOOR_UNLOCK_LEVEL[n] || 0) : 0;
  if (req > 0 && player.lvl < req) {
    if (typeof showFloorLock === 'function') showFloorLock(n, req);
    return;
  }
  if (n > dungeonLvl) onDungeonClear(dungeonLvl);
  onGotoFloor(n);
  netSaveProgressNow();
  netSendChangeFloor(clamp(n, 1, 20));
  setTab(0);
}

function enterRaidMode(data) {
  inRaid = true;
  _normalDungeon    = dungeon;
  _normalDungeonLvl = dungeonLvl;
  _normalPlayerX    = player?.x ?? null;
  _normalPlayerY    = player?.y ?? null;
  dungeon = { ...data.dungeon, enemies: [] };
  if (player) {
    player.x = data.dungeon.spawn.x;
    player.y = data.dungeon.spawn.y;
    camera.x = player.x - W / (2 * ZOOM);
    camera.y = player.y - _visH() / 2;
    clampCamera();
  }
  if (typeof buildTileCanvas === 'function') buildTileCanvas();
  serverEnemies.length = 0; serverEnemiesMap.clear();
  otherPlayers = new Map();
  projs = []; otherProjs = []; drops = []; particles = []; dmgNums = [];
  setTab(0);
}

function exitRaidMode() {
  inRaid = false;
  if (_normalDungeon) {
    dungeon = _normalDungeon;
    dungeonLvl = _normalDungeonLvl;
    _normalDungeon = null;
    if (player) {
      player.x = _normalPlayerX ?? dungeon.spawn.x;
      player.y = _normalPlayerY ?? dungeon.spawn.y;
      camera.x = player.x - W / (2 * ZOOM);
      camera.y = player.y - _visH() / 2;
      clampCamera();
    }
  }
  _normalPlayerX = null; _normalPlayerY = null;
  if (typeof buildTileCanvas === 'function') buildTileCanvas();
  serverEnemies.length = 0; serverEnemiesMap.clear();
  otherPlayers = new Map();
  projs = []; otherProjs = []; drops = []; particles = []; dmgNums = [];
  _raidWaveNotif = null;
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


function getOtherPlayerAnimKey(p) {
  if ((p.hp ?? 1) <= 0) return 'die';
  const dir = p.facing || 'front';
  if ((p.atkAnimTimer || 0) > 0) return `${dir}-attack`;
  if (p.moving) return `${dir}-run`;
  return `${dir}-idle`;
}


// ─────────────────────────────────────────────────────────
//  SAFE ZONE
// ─────────────────────────────────────────────────────────
function inSafeZone(px, py) {
  if (!dungeon || !dungeon.safeZone) return false;
  const sz = dungeon.safeZone;
  return px >= sz.x1 && px <= sz.x2 && py >= sz.y1 && py <= sz.y2;
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


// ── Tile chunks ────────────────────────────────────────────
// The map used to pre-render into ONE huge canvas (up to ~3200×2400,
// ~30MB as a GPU texture). Mobile GPUs evict textures that big under
// memory pressure and re-upload them mid-scroll — the whole background
// visibly hitched. Instead the map renders as lazy 8×8-tile chunks
// (320×320px, ~400KB each): only visible chunks are drawn (~12/frame),
// each texture is small enough to stay resident, and a chunk builds in
// well under a millisecond the first time it scrolls into view.
const _CHUNK_T  = 8;                 // tiles per chunk side
const _CHUNK_PX = _CHUNK_T * TILE;   // 320 world px
const _CHUNK_G  = 2;                 // gutter so bilinear edges sample real content
const _CHUNK_MAX = 96;               // cache cap (~38MB worst case, oldest evicted)
const _tileChunks = new Map();       // "cx,cy" -> canvas

function buildTileCanvas() {
  _tileChunks.clear();
  if (typeof pixiInvalidateChunks === 'function') pixiInvalidateChunks();
}

function _buildChunk(cx, cy) {
  const th = getTheme(dungeonLvl);
  const x0 = cx * _CHUNK_PX, y0 = cy * _CHUNK_PX;
  const cv = document.createElement('canvas');
  cv.width = cv.height = _CHUNK_PX + _CHUNK_G * 2;
  const c = cv.getContext('2d');
  c.translate(_CHUNK_G - x0, _CHUNK_G - y0);

  function isFloor(tx, ty) {
    return tx >= 0 && tx < dungeon.w && ty >= 0 && ty < dungeon.h
      && dungeon.grid[ty][tx] === FLOOR;
  }

  // Tile range: chunk + 1-tile ring so gutter pixels and neighbor-dependent
  // passes (cliff faces, shadows) render identically to adjacent chunks
  const tx0 = Math.max(0, cx * _CHUNK_T - 1);
  const ty0 = Math.max(0, cy * _CHUNK_T - 1);
  const tx1 = Math.min(dungeon.w - 1, (cx + 1) * _CHUNK_T);
  const ty1 = Math.min(dungeon.h - 1, (cy + 1) * _CHUNK_T);

  // NOTE: no 1px features — flat multi-pixel fills only, so the bilinear
  // blit at ZOOM 0.75 stays clean (thin lines would render unevenly).

  // 1. Wall base fill — real painted stone texture, tinted to this theme's
  // wallColor; falls back to the flat color if the texture hasn't loaded yet.
  c.fillStyle = (typeof getTilePattern === 'function' && getTilePattern(c, 'wallBody', th.wallColor)) || th.wallColor;
  c.fillRect(x0 - _CHUNK_G, y0 - _CHUNK_G, cv.width, cv.height);

  // 2. Floor — real painted stone texture, tinted to this theme's floorA.
  const floorPat = (typeof getTilePattern === 'function') ? getTilePattern(c, 'floor', th.floorA) : null;
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (dungeon.grid[ty][tx] !== FLOOR) continue;
      c.fillStyle = floorPat || ((tx + ty) % 2 === 0 ? th.floorA : th.floorB);
      c.fillRect(tx * TILE, ty * TILE, TILE, TILE);
    }
  }

  // 3. Wall "cliff face" strip above floor (top-down depth cue) — painted
  // brick-cap texture, tinted to this theme's wallColor. The body fill from
  // step 1 already tiles as clean brick everywhere else.
  const capPat = (typeof getTilePattern === 'function') ? getTilePattern(c, 'wallCap', th.wallColor) : null;
  c.fillStyle = capPat || th.wallColor;
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (dungeon.grid[ty][tx] !== WALL) continue;
      if (!isFloor(tx, ty + 1)) continue;
      c.fillRect(tx * TILE, ty * TILE + TILE - 10, TILE, 10);
    }
  }

  // 4. Shadows cast onto floor from walls above / beside
  c.fillStyle = 'rgba(0,0,0,0.4)';
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (dungeon.grid[ty][tx] !== FLOOR) continue;
      if (!isFloor(tx, ty - 1)) c.fillRect(tx * TILE, ty * TILE, TILE, 6);
    }
  }
  c.fillStyle = 'rgba(0,0,0,0.2)';
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (dungeon.grid[ty][tx] !== FLOOR) continue;
      const x = tx * TILE, y = ty * TILE;
      if (!isFloor(tx - 1, ty)) c.fillRect(x, y, 4, TILE);
      if (!isFloor(tx + 1, ty)) c.fillRect(x + TILE - 4, y, 4, TILE);
    }
  }

  // 5. Floor props — painted clutter (crates, chests, boulders, stumps, etc.)
  // scattered sparsely on floor tiles. Same own-tile-block scoping as the
  // wall decor pass above, so seams never get a doubled-up prop. Skips the
  // spawn-room door gap so clutter never spawns in the doorway.
  const door = dungeon.spawnDoor;
  const ptx0 = cx * _CHUNK_T, pty0 = cy * _CHUNK_T;
  const ptx1 = Math.min(dungeon.w - 1, ptx0 + _CHUNK_T - 1);
  const pty1 = Math.min(dungeon.h - 1, pty0 + _CHUNK_T - 1);
  if (th.drawFloorProp) {
    for (let ty = pty0; ty <= pty1; ty++) {
      for (let tx = ptx0; tx <= ptx1; tx++) {
        if (dungeon.grid[ty][tx] !== FLOOR) continue;
        if (door && ty >= door.ty && ty <= door.ty + 1 && tx >= door.tx && tx <= door.tx + 1) continue;
        const h = ((tx * 41) ^ (ty * 59)) & 0xff;
        c.save();
        th.drawFloorProp(c, tx * TILE, ty * TILE, h);
        c.restore();
      }
    }
  }

  // 6. Spawn-room exit door — fixed position, not part of the hash-scattered
  // prop system. Drawn last so it always sits on top of the floor beneath it.
  if (door && typeof drawSpawnDoor === 'function' &&
      door.tx >= ptx0 && door.tx <= ptx1 && door.ty >= pty0 && door.ty <= pty1) {
    drawSpawnDoor(c, door.tx, door.ty, th.wallColor);
  }

  return cv;
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
  if (inRaid) exitRaidMode();
  const xpLoss = Math.floor(player.xp * 0.05);
  player.xp = Math.max(0, player.xp - xpLoss);
  player.hp = player.maxHp;
  player.hurtTimer = 0;
  player.atkTimer = 0.5;
  if (dungeon) {
    player.x = dungeon.spawn.x; player.y = dungeon.spawn.y;
    camera.x = player.x - W / (2 * ZOOM); camera.y = player.y - _visH() / 2;
    clampCamera(); // reads dungeon.w/h — only safe once dungeon is confirmed loaded
  }
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
  targetId = null; targetIsPlayer = false; pvpMode = false; autoAttackMode = false;
  serverEnemies = []; otherPlayers = new Map();
  npcs = []; nearNpc = null;
  _tileChunks.clear();
  if (typeof pixiInvalidateChunks === 'function') pixiInvalidateChunks();
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
// Driven by requestAnimationFrame so every frame lands exactly on a vsync
// boundary — a setTimeout-scheduled loop fires at arbitrary offsets from the
// display's refresh, which reads as constant micro-stutter even when the
// average rate is steady.
//
// render() used to be skipped on mobile when less than ~32ms had elapsed
// since the last one (an attempt at a ~30fps cap to save heat/battery).
// That skip condition doesn't divide evenly into 90Hz/120Hz tick rates —
// with realistic rAF jitter it sometimes swallows one tick too many,
// producing an irregular sequence of ~33ms/~43ms gaps instead of a steady
// cadence. An uneven gap sequence reads as jitter/stutter even though the
// *average* rate looks fine, which is worse than just running at a lower
// but perfectly steady rate. Profiling shows render() costs well under
// 3ms/frame even in software rendering, so the heat/battery case for
// skipping frames isn't worth that trade — render every tick and let the
// adaptive-quality tier (below) cut visual cost on devices that genuinely
// can't keep up, instead of an artificial cadence cap.
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
  if (_uiCtx) _drawPerf(frameMs);
  requestAnimationFrame(loop);
}

window.addEventListener('beforeunload', () => { netSaveProgressNow(); });
// Mobile browsers rarely fire beforeunload — flush the save when the app
// goes to background (tab switch, screen lock, app switcher)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') netSaveProgressNow();
});

window.addEventListener('load', () => {
  canvas = document.getElementById('canvas');
  _uiOverlay = document.getElementById('ui-canvas');
  const appEl = document.getElementById('app');

  // Initialise PixiJS on the world canvas
  pixiInit(canvas);

  const resize = () => {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = appEl.clientWidth;
    H = appEl.clientHeight;
    // Resize PixiJS renderer (autoDensity:true handles canvas CSS size)
    pixiResize(W, H, DPR);
    // UI overlay — 2D canvas for HUD, joystick, name labels, etc.
    _uiOverlay.width  = Math.round(W * DPR);
    _uiOverlay.height = Math.round(H * DPR);
    _uiCtx = _uiOverlay.getContext('2d');
    // ctx global points to _uiCtx so HUD drawing functions work unchanged
    ctx = _uiCtx;
    _hudCv = null;
    _clanIconCv = null; _clanIconKey = null; // DPR may have changed
    _skillBtnGradCache = null;
    _uiBtnGrads = null;
    _partyHpGrads = null;
    updateJoyCenter();
    if (dungeon) clampCamera();
  };
  resize();
  window.addEventListener('resize', resize);
  _talkBtn = document.getElementById('npc-talk-btn');
  initInput();
  requestAnimationFrame(ts => { lastTs = ts; _loopTs = ts; requestAnimationFrame(loop); });
});
