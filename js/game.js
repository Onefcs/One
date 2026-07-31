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
// Adaptive quality tier — auto-degrades when FPS stays below 20 for ~3s
let _qualityTier = 0, _lowFpsFrames = 0;
// While a full-screen menu panel covers the world (any tab except the game
// view), the world+HUD are hidden and don't need re-rendering. Kept alive for
// a short grace window after a tab change so the ~0.28s panel slide-in still
// shows live world at the top instead of a frozen frame. Set by setTab().
let _menuGraceUntil = 0;

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
  // Adaptive quality: drop to tier 1 when FPS stays < 20 for ~3s; recover when FPS >= 25.
  if (fps < 20) { if (++_lowFpsFrames > 90) _qualityTier = 1; }
  else if (fps >= 25) { _lowFpsFrames = Math.max(0, _lowFpsFrames - 1); if (_lowFpsFrames === 0) _qualityTier = 0; }
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
    const h = Math.min(bh, ft / 50 * bh);
    ctx.fillStyle = ft > 50 ? '#ed5a6b' : ft > 40 ? '#e69419' : '#8cc758';
    ctx.fillRect(bx0 + i * bw, by0 - h, bw - 1, h);
  }
  // 30fps reference line
  ctx.fillStyle = 'rgba(209,204,197,0.25)';
  ctx.fillRect(bx0 - 2, by0 - bh * (33.3 / 50), samples * bw + 4, 1);

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
    `dpr  ${DPR.toFixed(2)} / ${(window.devicePixelRatio || 1).toFixed(2)} raw`,
    `res  ${_pixiApp ? _pixiApp.renderer.resolution.toFixed(2) : '?'} mob=${_isMobile ? 1 : 0}`,
    `qlty ${_qualityTier}`,
    `drp  ${drops.length}`,
    mem ? `mem  ${(mem.usedJSHeapSize / 1048576).toFixed(0)}MB` : '',
  ];
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  const ty0 = by0 + 6;
  lines.forEach((ln, i) => {
    if (!ln) return;
    ctx.fillStyle = '#000000';
    ctx.fillText(ln, bx0 + 1, ty0 + i * 14 + 1);
    let col = '#d1ccc5';
    if (i === 0) col = fps < 20 ? '#ed5a6b' : fps < 27 ? '#e69419' : '#98e456';
    else if (i === 1 && _pingMs >= 0) col = _pingMs > 150 ? '#ed5a6b' : _pingMs > 80 ? '#e69419' : '#98e456';
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
// Rendered-name-bitmap cache (own player) — see _buildNameBitmap below
let _nameBitmap = null, _prevNameKey = '';
// Clan tag cache: icon pre-rendered to offscreen canvas; blit with drawImage (1 call vs 256 fillRects)
let _clanIconCv = null, _clanIconKey = null;
// Rendered clan-tag-text bitmap cache (own player) — see _buildClanTagBitmap
let _clanTagBitmap = null, _prevClanTagKey = '';
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

  {
    // Not gated to activeTab === 0 — target-chasing, auto-attack movement and
    // position sync must keep running while another bottom-nav tab (Inventory/
    // Map/Quests/etc.) is open, or the character just stands frozen (unable to
    // chase or reposition) while enemies out there keep fighting it. Manual
    // joystick input naturally can't reach inp.dx/dy while its touch target is
    // covered by another panel, so this only ever resumes real movement here
    // via the auto-chase path below.
    if (player.atkAnimTimer <= 0 && (player.stunTimer || 0) <= 0) {
      const inp = inputDir();
      const _spdMult = (player.slowTimer || 0) > 0 ? 0.35 : 1;
      if (inp.len > 0) {
        player._chasing = false;
        // Manual joystick input cancels a manually-armed sustained attack
        // (autoAttackMode is a separate persistent toggle and stays as-is).
        _chaseArmed = false;
        // Speed depends only on player.speed (character stat), not on how
        // far the stick is pushed — inp.dx/dy are already a unit vector
        // (inputDir() normalizes them), so no inp.len factor here.
        const vx = inp.dx * player.speed * _spdMult * dt;
        const vy = inp.dy * player.speed * _spdMult * dt;
        if (canMoveX(player, vx, 12) && !_isGateBlocked(player.x + vx, player.y)) player.x += vx;
        if (canMoveY(player, vy, 12) && !_isGateBlocked(player.x, player.y + vy)) player.y += vy;
        // 8-way facing from joystick angle, with hysteresis: near a sector
        // boundary, tiny input jitter would otherwise flip facing (and
        // restart the run animation) every frame. The new angle must move
        // clearly past the current sector's edge before facing switches.
        player.facing = facing8FromDelta(inp.dx, inp.dy, player.facing);
      } else if (targetId && (autoAttackMode || _chaseArmed)) {
        // Chase locked target when no manual input — pressing attack on a
        // distant target (manual or auto-attack mode) closes the gap instead
        // of standing still and doing nothing. Merely selecting a target
        // (tap/cycle) does NOT arm this — only an actual attack-button press
        // does, via _chaseArmed.
        const _chEnt = targetIsPlayer ? otherPlayers.get(targetId) : serverEnemiesMap.get(targetId);
        if (_chEnt && (_chEnt.hp || 0) > 0) {
          const _cdx = _chEnt.x - player.x, _cdy = _chEnt.y - player.y;
          const _clen = Math.hypot(_cdx, _cdy);
          if (_clen > player.charDef.atkRange * 0.85) {
            const nvx = (_cdx / _clen) * player.speed * _spdMult * dt;
            const nvy = (_cdy / _clen) * player.speed * _spdMult * dt;
            if (canMoveX(player, nvx, 12) && !_isGateBlocked(player.x + nvx, player.y)) player.x += nvx;
            if (canMoveY(player, nvy, 12) && !_isGateBlocked(player.x, player.y + nvy)) player.y += nvy;
            faceTowards(_chEnt.x, _chEnt.y);
            player._chasing = true;
          } else {
            // Just arrived in range — in manual mode atkTimer isn't ticked
            // down by time, so resolve the queued attack now instead of
            // waiting for another button press.
            if (player._chasing && !autoAttackMode) player.atkTimer = 0;
            player._chasing = false;
          }
        } else {
          player._chasing = false;
        }
      } else {
        player._chasing = false;
      }
    }

    // Entities (monsters, other players) no longer block or push the
    // player's movement — only wall/terrain collision (canMoveX/canMoveY)
    // constrains movement now.

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
      dmgNum(player.x, player.y - 40, 'ПК режим выключен', '#edc174');
    }
  }

  _updateArmGates(dt);
  _updateTeleportPads(dt);

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
          fireProj(_op?.x ?? pa.x, _op?.y ?? pa.y, null, pa.socketId);
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

  // Auto-attack, or a single manual attack-button press armed via
  // _chaseArmed — either way keep swinging on its own until the target dies
  // or the joystick cancels it (see inp.len > 0 below), instead of requiring
  // another tap per swing.
  if ((autoAttackMode || _chaseArmed) && (player.stunTimer || 0) <= 0) player.atkTimer -= dt;
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
      const _animDur = Math.min(0.825, 1 / _as) / ATTACK_ANIM_SPEEDUP;
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
      // Homing: steer toward the locked target's *current* position every frame
      // so a moving target can't dodge the projectile after it's been fired.
      if (p.isPlayer && (p.enemyId || p.pvpTargetId)) {
        let tgt = null;
        if (p.enemyId) {
          const e = serverEnemiesMap.get(p.enemyId);
          if (e && (e.hp || 0) > 0) tgt = e;
        } else {
          const op = otherPlayers.get(p.pvpTargetId);
          if (op && (op.hp || 0) > 0 && op.x != null) tgt = op;
        }
        if (tgt) {
          const tdx = tgt.x - p.x, tdy = tgt.y - p.y, tlen = Math.hypot(tdx, tdy);
          if (tlen > 0.01) {
            const spd = Math.hypot(p.vx, p.vy);
            p.vx = tdx / tlen * spd;
            p.vy = tdy / tlen * spd;
            p.angle = Math.atan2(p.vy, p.vx);
          }
        }
      }
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
    particles.length = Math.min(j, _qualityTier > 0 ? 60 : 200);
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
  if (guardTimer > 0) { guardTimer -= dt; if (guardTimer <= 0) { guardTimer = 0; recompute(); } }
  if (vampirismTimer > 0) { vampirismTimer -= dt; if (vampirismTimer <= 0) vampirismTimer = 0; }
  if (invisTimer > 0) { invisTimer -= dt; if (invisTimer <= 0) { invisTimer = 0; if (typeof netPlayerInvis === 'function') netPlayerInvis(false); } }
  if ((player.stunTimer || 0) > 0) { player.stunTimer -= dt; if (player.stunTimer <= 0) player.stunTimer = 0; }
  if ((player.slowTimer || 0) > 0) { player.slowTimer -= dt; if (player.slowTimer <= 0) player.slowTimer = 0; }
  if (skillFlash) { skillFlash.timer -= dt; if (skillFlash.timer <= 0) skillFlash = null; }
  if (typeof tickQuestNotif === 'function') tickQuestNotif(dt);

  // Clear stale target — also disarms a manually-armed sustained attack so
  // it doesn't silently latch onto the next-nearest enemy once this one dies;
  // a fresh attack-button press (or autoAttackMode) is needed to keep going.
  if (targetId) {
    if (targetIsPlayer) {
      const op = otherPlayers.get(targetId);
      if (!op || (op.hp || 0) <= 0) { targetId = null; targetIsPlayer = false; _chaseArmed = false; }
    } else {
      const te = serverEnemiesMap.get(targetId);
      if (!te || (te.hp || 0) <= 0) { targetId = null; targetIsPlayer = false; _chaseArmed = false; }
    }
  }

  // NPC proximity — hysteresis (enter at 65px, only drop past 80px) so
  // standing right at the boundary doesn't flicker the chat-bubble icon and
  // "Поговорить" button on and off every frame from sub-pixel position noise
  // (diagonal-move rounding, wall-collision nudges) tipping the comparison
  // back and forth around a single hard threshold.
  if (nearNpc && dist(player.x, player.y, nearNpc.x, nearNpc.y) > 80) nearNpc = null;
  if (!nearNpc) {
    npcs.forEach(n => { if (dist(player.x, player.y, n.x, n.y) < 65) nearNpc = n; });
  }
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
      // Fallback: exponential lerp — framerate-independent at any FPS
      const _lf = 1 - Math.exp(-15 * dt);
      op.x += (op.targetX - op.x) * _lf;
      op.y += (op.targetY - op.y) * _lf;
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
        const maxF = ad.n;
        // Same as the local player (see update()): spread attack frames
        // evenly across the (already speed-adjusted) cast duration instead
        // of the sprite's own fps, so a shorter castDuration actually plays
        // the swing faster instead of just cutting it off early.
        const step = (!ad.loop && (op.atkAnimTimer || 0) > 0 && op.castDuration > 0)
          ? op.castDuration / maxF
          : 1 / ad.fps;
        while (op.animTimer >= step) {
          op.animTimer -= step;
          if (ad.loop) { op.animFrame = (op.animFrame + 1) % maxF; }
          else if (op.animFrame < maxF - 1) { op.animFrame++; }
        }
      }
    }
  });
  let _corpseExpired = false;
  serverEnemies.forEach(e => {
    // Corpse cleanup must run regardless of distance (a far corpse would
    // otherwise never expire and pile up in the array forever).
    if (e._deathTimer !== undefined && (e._deathTimer -= dt) <= 0) _corpseExpired = true;
    if (e.hp <= 0) return;

    // Skip everything else — cosmetic timers AND full AI — for enemies
    // outside local AOI. An open world can hold ~600 enemies at once; ticking
    // 5 status timers on every single one every frame, most of them far
    // off-screen and invisible anyway, adds up for no visible benefit. The
    // server corrects position/hp/status the moment one re-enters range.
    const _epdx = player.x - e.x, _epdy = player.y - e.y;
    const _epd2 = _epdx * _epdx + _epdy * _epdy;
    if (_epd2 > 1100 * 1100) return;

    if ((e.hurtTimer || 0) > 0) e.hurtTimer -= dt;
    if ((e.atkAnimTimer || 0) > 0) e.atkAnimTimer -= dt;
    if ((e._moveTimer || 0) > 0) e._moveTimer -= dt;
    if ((e.stunTimer || 0) > 0) e.stunTimer -= dt;
    if ((e.slowTimer || 0) > 0) e.slowTimer -= dt;

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

// Renders `text` (black 3px stroke + colored fill, matching the name-tag
// style used below) once into a small offscreen canvas at devicePixelRatio
// resolution — profiling a busy scene (60 enemies, 15 other players) found
// this per-player strokeText+fillText pair was the single heaviest
// per-frame cost after the already-cached HUD panel (_renderUI, 15fps):
// shaping+rasterizing a stroked glyph run every frame for every visible
// name adds up fast, while the text/color themselves rarely change frame
// to frame — only the on-screen POSITION does (it follows the camera).
// _drawNameBitmap below just blits this at the current position instead.
function _buildNameBitmap(text, color, fontPx, px) {
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = `bold ${fontPx * px}px system-ui, Arial`;
  const tw = probe.measureText(text).width;
  const padX = 4 * px, padTop = fontPx * px * 0.4, padBottom = 4 * px;
  const cv = document.createElement('canvas');
  cv.width  = Math.max(1, Math.ceil(tw + padX * 2));
  cv.height = Math.max(1, Math.ceil(fontPx * px + padTop + padBottom));
  const c = cv.getContext('2d');
  c.font = `bold ${fontPx * px}px system-ui, Arial`;
  c.textAlign = 'center'; c.textBaseline = 'alphabetic';
  c.lineWidth = 3 * px; c.strokeStyle = '#000000';
  const bx = cv.width / 2, by = cv.height - padBottom;
  c.strokeText(text, bx, by);
  c.fillStyle = color;
  c.fillText(text, bx, by);
  cv._tw = tw; cv._baseX = bx; cv._baseY = by; cv._px = px;
  return cv;
}
// Blits a bitmap built by _buildNameBitmap centered horizontally on sx, with
// its text baseline at sy — same anchoring strokeText/fillText(text,sx,sy)
// with textAlign='center'/textBaseline='alphabetic' used to give directly.
// Returns the CSS-px text width (callers use it to place e.g. the PvP icon).
function _drawNameBitmap(cv, sx, sy) {
  const px = cv._px;
  const dw = cv.width / px, dh = cv.height / px;
  ctx.drawImage(cv, sx - dw / 2, sy - cv._baseY / px, dw, dh);
  return cv._tw / px;
}

// Same idea as _buildNameBitmap/_drawNameBitmap, but for the clan-tag text
// next to a name — that one uses textAlign='left'/textBaseline='middle'
// (anchored after the clan icon, not centered on the player), so it needs
// its own pair rather than reusing the name one. Anchoring works the same
// way: build with the exact alignment the old direct strokeText/fillText
// call used, at a known offset inside the small canvas, then place that
// same offset at the caller's (x, yMid) when blitting.
function _buildClanTagBitmap(text, color, fontPx, px) {
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = `bold ${fontPx * px}px system-ui, Arial`;
  const tw = probe.measureText(text).width;
  const padL = 2 * px, padR = 3 * px, padV = fontPx * px * 0.8;
  const cv = document.createElement('canvas');
  cv.width  = Math.max(1, Math.ceil(tw + padL + padR));
  cv.height = Math.max(1, Math.ceil(padV * 2));
  const c = cv.getContext('2d');
  c.font = `bold ${fontPx * px}px system-ui, Arial`;
  c.textAlign = 'left'; c.textBaseline = 'middle';
  c.lineWidth = 2.5 * px; c.strokeStyle = '#000000';
  const ax = padL, ay = cv.height / 2;
  c.strokeText(text, ax, ay);
  c.fillStyle = color;
  c.fillText(text, ax, ay);
  cv._tw = tw; cv._anchorX = ax; cv._anchorY = ay; cv._px = px;
  return cv;
}
function _drawClanTagBitmap(cv, x, yMid) {
  const px = cv._px;
  const dw = cv.width / px, dh = cv.height / px;
  ctx.drawImage(cv, x - cv._anchorX / px, yMid - cv._anchorY / px, dw, dh);
}

function _drawPlayerNameOnUI() {
  const barTop = _lastPlayerUsedSprite ? player.y - 39 : player.y - 28;
  const nameY = barTop - 4;
  const sx = (player.x - _lastCamX) * ZOOM;
  const sy = (nameY - _lastCamY) * ZOOM + HEADER_H;
  const displayName = (netUsername || player.charDef.name).slice(0, 16);

  const nameColor = pvpMode ? '#f28a96' : '#edc174';
  const namePx = Math.ceil(DPR);
  const nameKey = displayName + '|' + nameColor + '|' + namePx;
  if (nameKey !== _prevNameKey) { _nameBitmap = _buildNameBitmap(displayName, nameColor, 10, namePx); _prevNameKey = nameKey; }
  const tw = _nameBitmap._tw / namePx;

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
    const clanTagPx = Math.ceil(DPR);
    const clanTagKey = clanData.name + '|' + clanTagPx;
    if (clanTagKey !== _prevClanTagKey) { _clanTagBitmap = _buildClanTagBitmap(clanData.name, '#eaa742', 9, clanTagPx); _prevClanTagKey = clanTagKey; }
    const clanTw = _clanTagBitmap._tw / clanTagPx;
    const iconDisp = 14, gap = 3;
    // Not rounded to whole pixels: sx/sy (and the name text below) move
    // continuously as the player moves, so rounding just this element made
    // it step pixel-by-pixel out of sync with everything around it — the
    // clan tag visibly lagged/jittered relative to the name during movement.
    const lineX = sx - (iconDisp + gap + clanTw) / 2;
    const lineY = sy - 16;
    ctx.drawImage(_clanIconCv, lineX, lineY - iconDisp / 2, iconDisp, iconDisp);
    _drawClanTagBitmap(_clanTagBitmap, lineX + iconDisp + gap, lineY);
  }

  _drawNameBitmap(_nameBitmap, sx, sy);
  if (pvpMode) drawIconCtx(_uiCtx, 'pvpOn', sx + tw / 2 + 8, sy - 3, 9, '#ed5a6b');
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
    const unameColor = p.pvpMode ? '#f28a96' : '#d1ccc5';
    const unamePx = Math.ceil(DPR);
    const unameKey = uname + '|' + unameColor + '|' + unamePx;
    if (unameKey !== p._nameKey) { p._nameBitmap = _buildNameBitmap(uname, unameColor, 10, unamePx); p._nameKey = unameKey; }

    const cname = p.clanName || '';
    if (cname) {
      const clanTagPx = Math.ceil(DPR);
      const clanTagKey = cname + '|' + clanTagPx;
      if (clanTagKey !== p._clanTagKey) { p._clanTagBitmap = _buildClanTagBitmap(cname, '#eaa742', 9, clanTagPx); p._clanTagKey = clanTagKey; }
      const clanTw = p._clanTagBitmap._tw / clanTagPx;
      const iconDisp = 14, gap = 3;
      // Not rounded — see the matching comment in _drawPlayerNameOnUI.
      const lineX = sx - (iconDisp + gap + clanTw) / 2;
      const lineY = sy - 16;
      ctx.drawImage(_getOtherClanIconCv(p.clanIcon || 1), lineX, lineY - iconDisp / 2, iconDisp, iconDisp);
      _drawClanTagBitmap(p._clanTagBitmap, lineX + iconDisp + gap, lineY);
    }

    _drawNameBitmap(p._nameBitmap, sx, sy);
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

  // When a full-screen menu panel (inventory/map/quests/clans/profile) is open,
  // an opaque panel covers the whole viewport above the bottom nav — the PixiJS
  // world and the 2D HUD are completely hidden, so re-rendering them every frame
  // is wasted GPU/CPU/battery on mobile. Skip both once the open-panel slide-in
  // has finished (the grace window keeps drawing during the CSS transition); the
  // last frame stays on the hidden canvas and is revealed intact on close.
  if (state === 'playing' && activeTab !== 0 && ts >= _menuGraceUntil) return;

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
    pixiSetBg('#0f0c07');
    pixiClearWorld();
  }

  // ── UI canvas — cleared every frame so layers don't accumulate ──────────────
  _uiCtx.clearRect(0, 0, _uiOverlay.width, _uiOverlay.height);
  _uiCtx.setTransform(DPR, 0, 0, DPR, 0, 0);

  // HUD panels: rebuild cache at 15fps, blit every frame (cheap drawImage)
  if (ts - _uiLastMs >= 67) {
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
  if (player && dungeon) drawArmGates();
  if (player && dungeon) drawTeleportPads();
  if (activeTab === 0) drawJoystick();

  // Safe zone HUD label (on top of HUD)
  if (player && dungeon && typeof inSafeZone === 'function' && inSafeZone(player.x, player.y)) {
    const lbl = '🛡 Безопасная зона · реген HP';
    _uiCtx.font = 'bold 11px system-ui, Arial';
    _uiCtx.textAlign = 'center'; _uiCtx.textBaseline = 'alphabetic';
    const lw = _uiCtx.measureText(lbl).width;
    _uiCtx.fillStyle = 'rgba(0,0,0,0.55)';
    _uiCtx.fillRect(W / 2 - lw / 2 - 6, HEADER_H + 6, lw + 12, 18);
    _uiCtx.fillStyle = '#94d15e';
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
    _uiCtx.fillStyle = '#d1ccc5';
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
  if (typeof _buildArmGates === 'function') _buildArmGates();
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
  if (typeof _buildArmGates === 'function') _buildArmGates();
  serverEnemies.length = 0; serverEnemiesMap.clear();
  otherPlayers = new Map();
  projs = []; otherProjs = []; drops = []; particles = []; dmgNums = [];
  _raidWaveNotif = null;
}

// Party dungeon (maze + boss): unlike the raid arena, this dungeon has real
// walls/rooms (generated server-side by mazeDungeon.js) in the exact same
// {grid, rooms, w, h, spawn, safeZone} shape a normal floor uses, so the
// normal floor renderer (buildTileCanvas, wall/prop drawing, minimap) just
// works without any raid-arena-style special casing. Forcing dungeonLvl to
// 5 makes every theme lookup (getTheme) render it with floor 5's tileset.
function enterPartyDungeonMode(data) {
  inPartyDungeon = true;
  _normalDungeon    = dungeon;
  _normalDungeonLvl = dungeonLvl;
  _normalPlayerX    = player?.x ?? null;
  _normalPlayerY    = player?.y ?? null;
  dungeon = { ...data.dungeon, enemies: [] };
  dungeonLvl = 5;
  if (player) {
    player.x = data.dungeon.spawn.x;
    player.y = data.dungeon.spawn.y;
    camera.x = player.x - W / (2 * ZOOM);
    camera.y = player.y - _visH() / 2;
    clampCamera();
  }
  if (typeof buildTileCanvas === 'function') buildTileCanvas();
  if (typeof _buildArmGates === 'function') _buildArmGates();
  serverEnemies.length = 0; serverEnemiesMap.clear();
  otherPlayers = new Map();
  projs = []; otherProjs = []; drops = []; particles = []; dmgNums = [];
  setTab(0);
}

function exitPartyDungeonMode() {
  inPartyDungeon = false;
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
  if (typeof _buildArmGates === 'function') _buildArmGates();
  serverEnemies.length = 0; serverEnemiesMap.clear();
  otherPlayers = new Map();
  projs = []; otherProjs = []; drops = []; particles = []; dmgNums = [];
}

function selectChar(type) {
  joy.active = false; joy.dx = 0; joy.dy = 0;
  try { localStorage.setItem('_lastCharType', type); } catch (_) {}
  player = makePlayer(type);
  dungeonLvl = 1;
  // A single account has one savedData blob, not per-type save slots — gating
  // restoration on savedData.type === type dropped real progress to defaults
  // whenever that metadata field was missing/stale (e.g. a fast refresh
  // before the DB write finished), and the next debounced saveProgress then
  // persisted those defaults over the real save. restoreFromSave() itself
  // never reads .type, so just use whatever savedData exists.
  const savedStats = (typeof _savedData !== 'undefined' && _savedData) ? _savedData : null;
  csStartLoading(type, () => { initNpcs(); _finishOnlineStart(); });
  // Gate the loading screen on BOTH player and floor-1 enemy sprites being decoded.
  const _floor1Eids = (FLOOR_ENEMIES[1]?.species || []).flatMap(sp => [sp + '_guard', sp + '_warrior']).concat([FLOOR_ENEMIES[1]?.boss]).filter(Boolean);
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
//  ARM GATES — level-gated checkpoints between every room-pair position
//  down each (now hub-detached) corridor
// ─────────────────────────────────────────────────────────
// Each zone still gates its own deeper rooms by character level: reaching
// e.g. the level-3/4 room pair requires character level 3, the next pair
// requires 5, and so on (dungeon.corridorGates, built server-side in
// server/game/dungeon.js). The zone's OWN entrance is no longer a physical
// door you walk through — see the TELEPORT PADS section below for that.
// Rebuilt any time `dungeon` changes (see _buildArmGates() call sites in
// network.js/game.js).
let _armGates = null;
const _enteredArms = new Set();
let _gateMsgCd = 0;
const _ARM_LABEL = { left: 'левый', top: 'верхний', bottom: 'нижний', right: 'правый' };

// ─────────────────────────────────────────────────────────
//  TELEPORT PADS — hub-side pads (one per arm, labeled by its level range)
//  warp straight into that zone's corridor entrance; a matching pad at each
//  zone's entrance warps back to the hub. Replaces the old walk-down-the-
//  corridor hub doors entirely — the hub isn't physically connected to any
//  zone anymore.
// ─────────────────────────────────────────────────────────
const _TELEPORT_LABEL = { left: '1 уровень', top: '20 уровень', bottom: '40 уровень', right: '60 уровень' };
const _TELEPORT_HUB_DX = { left: -12, top: -4, bottom: 4, right: 12 }; // tiles, hub-side pad row
const _TELEPORT_HUB_DY = 10; // tiles south of spawn (NPCs sit north, at dy -11)
let _teleportPads = null; // hub-side: {dir, x, y, req, label, targetX, targetY}
let _returnPads = null;   // zone-side: {dir, x, y, targetX, targetY} — back to hub

function _buildArmGates() {
  if (!dungeon) { _armGates = []; _teleportPads = []; _returnPads = []; return; }
  _armGates = (dungeon.corridorGates || []).map(g => {
    const horizontal = g.dir === 'left' || g.dir === 'right';
    return { dir: g.dir, x: g.tx * TILE + TILE / 2, y: g.ty * TILE + TILE / 2, horizontal, req: g.req };
  });

  const entries = dungeon.armEntries || [];
  const sx = dungeon.spawn ? dungeon.spawn.x : 0, sy = dungeon.spawn ? dungeon.spawn.y : 0;
  _teleportPads = entries.map(e => ({
    dir: e.dir, req: e.req, label: _TELEPORT_LABEL[e.dir] || `Ур. ${e.req}`,
    x: sx + (_TELEPORT_HUB_DX[e.dir] || 0) * TILE, y: sy + _TELEPORT_HUB_DY * TILE,
    targetX: e.x + TILE * 2, targetY: e.y,
  }));
  // Landing spot is offset 2 tiles further down the corridor from the return
  // pad's own position, so arriving players don't stand on top of it and
  // immediately bounce straight back to the hub.
  _returnPads = entries.map(e => ({ dir: e.dir, x: e.x, y: e.y, targetX: sx, targetY: sy }));
}

let _teleportMsgCd = 0;
function _teleportTo(tx, ty, label) {
  player.x = tx; player.y = ty;
  camera.x = player.x - W / (2 * ZOOM); camera.y = player.y - _visH() / 2; clampCamera();
  spawnBurst(player.x, player.y, '#7fd7ff', 20);
  dmgNum(player.x, player.y - 30, `→ ${label}`, '#7fd7ff', 15);
}

// Called once per frame from update(): triggers a teleport the instant the
// player walks onto a pad they're allowed to use, or shows a throttled lock
// message near one they aren't leveled for yet.
function _updateTeleportPads(dt) {
  if (!player) return;
  if (_teleportMsgCd > 0) _teleportMsgCd -= dt;
  const TRIGGER_R = 26;
  (_teleportPads || []).forEach(p => {
    if (dist(player.x, player.y, p.x, p.y) >= TRIGGER_R) return;
    if (p.req > 0 && (player.lvl || 1) < p.req) {
      if (_teleportMsgCd <= 0) { dmgNum(player.x, player.y - 40, `🔒 Нужен ${p.req} уровень`, '#f17e8b'); _teleportMsgCd = 1.5; }
      return;
    }
    _teleportTo(p.targetX, p.targetY, p.label);
  });
  (_returnPads || []).forEach(p => {
    if (dist(player.x, player.y, p.x, p.y) >= TRIGGER_R) return;
    _teleportTo(p.targetX, p.targetY, 'Центральный зал');
  });
}

function _drawTeleportPad(x, y, req, label, lockedColor, unlockedColor) {
  const sx = (x - _lastCamX) * ZOOM, sy = (y - _lastCamY) * ZOOM + HEADER_H;
  if (sx < -60 || sx > W + 60 || sy < -60 || sy > H + 60) return;
  const locked = req > 0 && (player.lvl || 1) < req;
  const t = _nowMs / 1000;
  const pulse = 0.5 + 0.5 * Math.sin(t * 2.4);
  const baseR = 30 * ZOOM;

  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = locked ? 'rgba(90,20,26,0.35)' : 'rgba(20,110,70,0.28)';
  ctx.beginPath(); ctx.arc(sx, sy, baseR, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 0.55 + 0.25 * pulse;
  ctx.strokeStyle = locked ? lockedColor : unlockedColor;
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(sx, sy, baseR + pulse * 5, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();

  const lbl = locked ? `🔒 ${label}` : label;
  ctx.font = 'bold 11px system-ui, Arial';
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
  ctx.strokeText(lbl, sx, sy + baseR + 14);
  ctx.fillStyle = locked ? '#f17e8b' : '#8ff0c0';
  ctx.fillText(lbl, sx, sy + baseR + 14);
}

function drawTeleportPads() {
  if (!player) return;
  (_teleportPads || []).forEach(p => _drawTeleportPad(p.x, p.y, p.req, p.label, '#eb4e61', '#4ee69a'));
  (_returnPads || []).forEach(p => _drawTeleportPad(p.x, p.y, 0, 'Зал', '#eb4e61', '#4ee69a'));
}

function _isGateBlocked(wx, wy) {
  if (!player || !_armGates) return false;
  for (const g of _armGates) {
    if (g.req <= 0 || (player.lvl || 1) >= g.req) continue;
    const halfW = 70, thick = 22; // wide enough to span the 3-tile-wide main corridor
    if (g.horizontal ? (Math.abs(wx - g.x) < thick && Math.abs(wy - g.y) < halfW)
                      : (Math.abs(wy - g.y) < thick && Math.abs(wx - g.x) < halfW)) return true;
  }
  return false;
}

// Called once per frame from update(): shows a throttled lock message near a
// gate the player can't pass yet, and fires a one-time "teleport" flourish
// the first time they cross an unlocked one this session.
function _updateArmGates(dt) {
  if (!player || !_armGates || !_armGates.length) return;
  if (_gateMsgCd > 0) _gateMsgCd -= dt;
  for (const g of _armGates) {
    if (dist(player.x, player.y, g.x, g.y) >= 90) continue;
    if (g.req > 0 && (player.lvl || 1) < g.req) {
      if (_gateMsgCd <= 0) {
        dmgNum(player.x, player.y - 40, `🔒 Нужен ${g.req} уровень`, '#f17e8b');
        _gateMsgCd = 1.5;
      }
    } else if (!_enteredArms.has(g.dir)) {
      _enteredArms.add(g.dir);
      spawnBurst(g.x, g.y, '#7fd7ff', 16);
      dmgNum(g.x, g.y - 30, `→ Вы вошли в ${_ARM_LABEL[g.dir]} коридор`, '#7fd7ff', 15);
    }
  }
}

function drawArmGates() {
  if (!player || !_armGates || !_armGates.length) return;
  const t = _nowMs / 1000;
  const pulse = 0.5 + 0.5 * Math.sin(t * 2.4);
  for (const g of _armGates) {
    const sx = (g.x - _lastCamX) * ZOOM;
    const sy = (g.y - _lastCamY) * ZOOM + HEADER_H;
    if (sx < -60 || sx > W + 60 || sy < -60 || sy > H + 60) continue;
    const locked = g.req > 0 && (player.lvl || 1) < g.req;
    const baseR = 34 * ZOOM;

    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = locked ? 'rgba(90,20,26,0.35)' : 'rgba(30,90,110,0.28)';
    ctx.beginPath(); ctx.arc(sx, sy, baseR, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 0.55 + 0.25 * pulse;
    ctx.strokeStyle = locked ? '#eb4e61' : '#7fd7ff';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(sx, sy, baseR + pulse * 5, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();

    if (g.req > 0) {
      const lbl = locked ? `🔒 Ур. ${g.req}` : `Ур. ${g.req}`;
      ctx.font = 'bold 11px system-ui, Arial';
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
      ctx.strokeText(lbl, sx, sy + baseR + 14);
      ctx.fillStyle = locked ? '#f17e8b' : '#a8e9ff';
      ctx.fillText(lbl, sx, sy + baseR + 14);
    }
  }
}

// ─────────────────────────────────────────────────────────
//  NPCs
// ─────────────────────────────────────────────────────────
// The hub has no physical exits anymore (see TELEPORT PADS above) — NPCs
// just sit side by side north of spawn, clear of the teleport pad row south
// of it.
function initNpcs() {
  if (!dungeon) return;
  const sx = dungeon.spawn.x, sy = dungeon.spawn.y;
  const offsets = [
    { dx: -TILE * 4, dy: -TILE * 11 },
    { dx:  TILE * 4, dy: -TILE * 11 },
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
  _mmTileCv = null; // minimap floor-tile buffer (js/ui.js) — new dungeon grid
}

// Deterministic per-tile pseudo-random in [0,1) — stable across chunk
// rebuild/eviction (unlike Math.random()), so a tile always redraws with
// the exact same procedural detail no matter when its chunk gets rebuilt.
function _tileHash(tx, ty, salt) {
  let h = (tx * 374761393 + ty * 668265263 + salt * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 15), 1274126177);
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 100000) / 100000;
}

// Lightens (t>0) or darkens (t<0) a hex color toward white/black by |t|.
function _shadeHexColor(hex, t) {
  return t >= 0 ? _lerpHexColor(hex, '#ffffff', t) : _lerpHexColor(hex, '#000000', -t);
}

// A short deterministic zig-zag crack, 2px thick (no 1px hairlines).
function _drawCrack(c, x, y, tx, ty, color, segLen) {
  c.strokeStyle = color;
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(x, y);
  let cx = x, cy = y;
  for (let i = 0; i < 3; i++) {
    const a = _tileHash(tx, ty, i * 3 + 21) * Math.PI * 2;
    cx += Math.cos(a) * segLen;
    cy += Math.sin(a) * segLen;
    c.lineTo(cx, cy);
  }
  c.stroke();
}

// A soft radial grime/blood stain blob.
function _drawStain(c, x, y, radius, color) {
  const g = c.createRadialGradient(x, y, 0, x, y, radius);
  g.addColorStop(0, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g;
  c.beginPath();
  c.arc(x, y, radius, 0, Math.PI * 2);
  c.fill();
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

  // 1. Wall base — flat theme color, then per-tile procedural stone-block
  // shading, coarse 2-tile masonry seams, and occasional cracks. All
  // deterministic per (tx,ty) so a tile looks identical no matter when its
  // chunk gets rebuilt from the LRU cache.
  c.fillStyle = th.wallColor;
  c.fillRect(x0 - _CHUNK_G, y0 - _CHUNK_G, cv.width, cv.height);
  const mortarWall = _shadeHexColor(th.wallColor, -0.45);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (dungeon.grid[ty][tx] !== WALL) continue;
      const x = tx * TILE, y = ty * TILE;
      c.fillStyle = _shadeHexColor(th.wallColor, (_tileHash(tx, ty, 10) - 0.5) * 0.15);
      c.fillRect(x, y, TILE, TILE);
      c.fillStyle = mortarWall;
      if (ty % 2 === 0) c.fillRect(x, y, TILE, 2);
      if (tx % 2 === 0) c.fillRect(x, y, 2, TILE);
      if (_tileHash(tx, ty, 11) < 0.12) {
        const cx = x + 6 + _tileHash(tx, ty, 12) * (TILE - 12);
        const cy = y + 6 + _tileHash(tx, ty, 13) * (TILE - 12);
        _drawCrack(c, cx, cy, tx, ty, mortarWall, 7);
      }
    }
  }

  // 2. Floor — per-tile procedural flagstone: shade blended between this
  // theme's floorA/floorB, 2px mortar seams on the tile's own right/bottom
  // edge, occasional cracks, and occasional grime/blood stains.
  const mortarFloor = _shadeHexColor(th.floorA, -0.35);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (dungeon.grid[ty][tx] !== FLOOR) continue;
      const x = tx * TILE, y = ty * TILE;
      c.fillStyle = _lerpHexColor(th.floorA, th.floorB, _tileHash(tx, ty, 0));
      c.fillRect(x, y, TILE, TILE);
      c.fillStyle = mortarFloor;
      c.fillRect(x, y + TILE - 2, TILE, 2);
      c.fillRect(x + TILE - 2, y, 2, TILE);
      if (_tileHash(tx, ty, 1) < 0.1) {
        const crx = x + 8 + _tileHash(tx, ty, 2) * (TILE - 16);
        const cry = y + 8 + _tileHash(tx, ty, 3) * (TILE - 16);
        _drawCrack(c, crx, cry, tx, ty, mortarFloor, 6);
      }
      if (_tileHash(tx, ty, 4) < 0.06) {
        const sx = x + TILE * (0.3 + _tileHash(tx, ty, 5) * 0.4);
        const sy = y + TILE * (0.3 + _tileHash(tx, ty, 6) * 0.4);
        _drawStain(c, sx, sy, 8 + _tileHash(tx, ty, 8) * 6, 'rgba(60,10,10,0.35)');
      }
    }
  }

  // 3. Wall "cliff face" strip above floor (top-down depth cue) — beveled
  // gradient (dark at top fading to base wallColor) with a soft highlight
  // line along the very top edge for a lit-edge depth cue.
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (dungeon.grid[ty][tx] !== WALL) continue;
      if (!isFloor(tx, ty + 1)) continue;
      const x = tx * TILE, y = ty * TILE + TILE - 10;
      const grad = c.createLinearGradient(0, y, 0, y + 10);
      grad.addColorStop(0, _shadeHexColor(th.wallColor, -0.5));
      grad.addColorStop(1, th.wallColor);
      c.fillStyle = grad;
      c.fillRect(x, y, TILE, 10);
      c.fillStyle = _shadeHexColor(th.wallColor, 0.35);
      c.fillRect(x, y, TILE, 2);
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
  // wall decor pass above, so seams never get a doubled-up prop.
  const ptx0 = cx * _CHUNK_T, pty0 = cy * _CHUNK_T;
  const ptx1 = Math.min(dungeon.w - 1, ptx0 + _CHUNK_T - 1);
  const pty1 = Math.min(dungeon.h - 1, pty0 + _CHUNK_T - 1);
  if (th.drawFloorProp) {
    for (let ty = pty0; ty <= pty1; ty++) {
      for (let tx = ptx0; tx <= ptx1; tx++) {
        if (dungeon.grid[ty][tx] !== FLOOR) continue;
        const h = ((tx * 41) ^ (ty * 59)) & 0xff;
        c.save();
        th.drawFloorProp(c, tx * TILE, ty * TILE, h);
        c.restore();
      }
    }
  }

  return cv;
}


function playerDie() {
  state = 'dead';
  const modal = document.getElementById('death-modal');
  if (!modal) return;
  // Stored as remaining seconds in player.buffs (like every other timed buff/
  // debuff) instead of a standalone client-only timestamp — that variable
  // reset to 0 on every page refresh/reconnect since it was never part of
  // the saved/restored player state, silently letting a refresh clear the
  // penalty. buffs.* already round-trips through saveProgress/restoreFromSave
  // and ticks down in the existing per-frame buff-timer loop for free.
  // Assigning (not adding) also gives the "dying again resets the timer"
  // behavior for free.
  if (player) (player.buffs || (player.buffs = {})).deathPenalty = 5 * 60;
  const info = document.getElementById('death-info');
  if (info && player) {
    const _dRoom = (typeof _getRoomAt === 'function') ? _getRoomAt(player.x, player.y) : null;
    const _dLoc = (_dRoom?.arm && typeof _ARM_LABELS !== 'undefined')
      ? `${_ARM_LABELS[_dRoom.arm]} · Ур. ${_dRoom.monsterLvl}` : 'Центральный зал';
    info.innerHTML =
      `<span class="death-stat">${_dLoc}</span>` +
      `<span class="death-stat">${player.gold} <span class="death-lbl">золота</span> · ${player.kills} <span class="death-lbl">убийств</span></span>`;
  }
  const penaltyEl = document.getElementById('death-penalty');
  if (penaltyEl) penaltyEl.style.display = 'block';
  modal.style.display = 'flex';
}

function respawnPlayer() {
  if (!player || state !== 'dead') return;
  if (inRaid) exitRaidMode();
  targetId = null; targetIsPlayer = false; _chaseArmed = false;
  player.hp = Math.max(1, Math.floor(player.maxHp * 0.1));
  player.hurtTimer = 0;
  player.atkTimer = 0.5;
  if (dungeon) {
    player.x = dungeon.spawn.x; player.y = dungeon.spawn.y;
    camera.x = player.x - W / (2 * ZOOM); camera.y = player.y - _visH() / 2;
    clampCamera();
  }
  state = 'playing';
  document.getElementById('death-modal').style.display = 'none';
  dmgNum(player.x, player.y - 30, '−50% XP (5 мин)', '#c4838a');
  socket?.emit('playerMove', { x: player.x, y: player.y, facing: player.facing });
  if (socket?.connected) socket.emit('respawn');
  netSaveProgress();
}

function restartGame() {
  if (state !== 'dead') return;
  try { localStorage.removeItem('_lastCharType'); } catch (_) {}
  if (typeof _clearSaveBackup === 'function') _clearSaveBackup();
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
// since the last one (an attempt at a ~30fps cap to save heat/battery), then
// later replaced with a wall-clock accumulator (compare accumulated rAF time
// against a 33.33ms threshold). Both were reverted for the same underlying
// reason: real rAF timestamps jitter by a millisecond or two from OS/GPU
// scheduling noise, and whenever that jitter tips a threshold comparison the
// wrong way at the wrong moment, one render lands early to "catch up" right
// after a skipped one — a visible double-step in on-screen motion. This was
// confirmed directly: frame-by-frame analysis of a user-reported jitter
// video measured a repeating ~12px/12px/12px/24px world-position displacement
// pattern, the exact signature of an occasional swallowed-then-caught-up
// tick, not smooth motion.
//
// Fix: render every Nth native rAF *tick*, N picked from the device's own
// measured refresh rate, instead of comparing elapsed time to a threshold.
// Counting ticks is immune to per-tick duration jitter — the trigger is
// "this is tick number N", not "has enough time passed", so a tick that runs
// long or short doesn't shift when the next render fires.
let _loopTs = 0;
let _lastRenderTs = 0;
// dt smoother. A flat N-frame average decouples on-screen motion from real
// elapsed time: the value it feeds update() lags the true frame duration by up
// to N frames, so when frame times wobble the player/camera position drifts
// behind then catches up — visible as micro-judder during movement even when
// the frame cadence itself is perfectly steady (confirmed on-device: a phone
// sitting at a rock-steady 30fps with <2ms/frame of work still juddered while
// moving). The window exists only to cancel the period-2 rAF jitter some mobile
// GPUs show (alternating short/long native gaps), and an *even* window of 2 already
// cancels that exactly — (a+b)/2 is constant for an a,b,a,b sequence — so N=2
// keeps the one benefit while halving the lag that causes the drift. (At the
// 30fps cap each rendered frame already spans two native gaps, which self-cancels
// period-2 at the source, making even a 2-frame average conservative there.)
const _DT_SMOOTH_N = 2;
const _dtBuf = new Float32Array(_DT_SMOOTH_N).fill(1 / 30);
let _dtBufIdx = 0;

const _FPS_CAP_MS = 1000 / 30; // ~33.33ms — dt-clamp budget (frameMs/rawDt clamps below)
// Target render cadence: 60fps on every device, including phones. The 30fps
// mobile cap was justified as heat/battery savings, but the built-in overlay
// disproved that on real hardware: a phone sat at a steady 30fps spending only
// ~0.8ms in update() and ~1.1ms in render() — under 2ms of a 33ms frame, ~15×
// headroom. The GPU idles either way, so the cap saved almost no power while
// forcing 30fps, and full-screen camera panning at 30fps reads as visible
// judder on the 60/90/120Hz screens phones now ship with — the exact symptom
// reported. Net-send rate is decoupled from frame rate (netSendMove is capped
// to 40Hz), so 60fps adds only cheap extra draws, not radio/CPU wakeups. The
// tick-counting scheduler below yields an even cadence at any divisor (N=1
// included), so this is steady 60fps, not the jittery 60fps the cap once
// guarded against; a device that genuinely can't hold 60 simply renders slower
// (rAF delivers fewer ticks) and the adaptive-quality tier still trims particle
// load below 20fps.
const _TARGET_FRAME_MS = 1000 / 60;
// Refresh-rate detection: the native frame interval is the *shortest* real gap
// between rAF ticks — jank only ever makes a frame longer, never shorter. The
// old code averaged the first dozen ticks, but those land on the jankiest
// moment of the session (sprite decode stalls right after load); a slow startup
// inflated the average, so round(target/avg) collapsed to 1 and the cap silently
// became "render every tick" (full native rate, no cap). Instead, sample a longer
// window and take a low percentile of the intervals: robust against both the
// slow startup frames (they sit at the high end, ignored) and the occasional
// sub-native catch-up frame after a stall (a handful at the very low end, also
// skipped). Rendering runs at native rate during this ~0.5s window — a cost not
// worth avoiding. N is then locked for the rest of the session.
const _RATE_DETECT_TICKS = 30;
const _detectBuf = new Float32Array(_RATE_DETECT_TICKS);
let _detectCount = 0;
let _renderEveryN = null;
let _tickCounter = 0;

function loop(ts) {
  const rAFMs = ts - _loopTs; _loopTs = ts;

  if (_renderEveryN === null) {
    // Guard >4ms rejects spurious sub-native catch-up glitches while still
    // admitting up to ~240Hz displays (4.16ms); <100ms drops tab-switch stalls.
    if (rAFMs > 4 && rAFMs < 100) _detectBuf[_detectCount++] = rAFMs;
    if (_detectCount >= _RATE_DETECT_TICKS) {
      const sorted = Array.from(_detectBuf).sort((a, b) => a - b);
      const nativeMs = sorted[Math.floor(_RATE_DETECT_TICKS * 0.2)]; // ~20th pct
      _renderEveryN = Math.max(1, Math.round(_TARGET_FRAME_MS / nativeMs));
    }
  } else {
    _tickCounter++;
    if (_tickCounter % _renderEveryN !== 0) { requestAnimationFrame(loop); return; }
  }

  // dt = actual wall-clock time since the last render, not a derived budget —
  // avoids inflating physics speed on sub-30fps devices.
  const sinceLastRender = _lastRenderTs > 0 ? ts - _lastRenderTs : _FPS_CAP_MS;
  _lastRenderTs = ts;
  const frameMs = Math.min(sinceLastRender, _FPS_CAP_MS * 2.5);
  const rawDt = Math.min(frameMs / 1000, 0.05);
  _dtBuf[_dtBufIdx] = rawDt;
  _dtBufIdx = (_dtBufIdx + 1) % _DT_SMOOTH_N;
  let dt = 0;
  for (let i = 0; i < _DT_SMOOTH_N; i++) dt += _dtBuf[i];
  dt /= _DT_SMOOTH_N;
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
  if (document.visibilityState === 'hidden') { netSaveProgressNow(); return; }
  // Coming back to the foreground: requestAnimationFrame (and with it,
  // update()/render()) is paused for the entire time the tab is hidden, but
  // socket messages still get processed as they arrive, so a fatal
  // 'playerHurt' while backgrounded already set player.hp to 0 and flipped
  // state to 'dead' correctly — this is just a defensive catch-all in case
  // that ever races with a reconnect (see the gameStart handler in
  // network.js for the main fix) and leaves hp at 0 without state following.
  if (player && player.hp <= 0 && state !== 'dead' && typeof playerDie === 'function') playerDie();
});

window.addEventListener('load', () => {
  canvas = document.getElementById('canvas');
  _uiOverlay = document.getElementById('ui-canvas');
  const appEl = document.getElementById('app');

  // Initialise PixiJS on the world canvas
  pixiInit(canvas);

  const resize = () => {
    DPR = Math.min(window.devicePixelRatio || 1, _isMobile ? 1.5 : 2);
    W = appEl.clientWidth;
    H = appEl.clientHeight;
    // WebGL resolution capped at 1.5 (same cap for mobile and desktop) so
    // the GPU fill-rate stays reasonable on high-DPR phones without
    // sacrificing visual quality the way res=1.0 would.
    const _pixiRes = Math.min(window.devicePixelRatio || 1, 1.5);
    pixiResize(W, H, _pixiRes);
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
  requestAnimationFrame(ts => { _loopTs = ts; requestAnimationFrame(loop); });
});
