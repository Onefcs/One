const SKILL_SZ  = 54;
const SKILL_GAP = 8;
const POTION_R  = 26;
const BUFF_BAR_H = 0; // buff/debuff strip is now inside the header

// Cached joystick center — recomputed only on resize via updateJoyCenter()
const _joyCenter = { x: 0, y: 0 };
function joyCenter() { return _joyCenter; }
function updateJoyCenter() { _joyCenter.x = W * 0.27; _joyCenter.y = H - NAV_H - 130; }

function _inJoyZone(cx, cy) {
  const jc = joyCenter();
  return cx < W * 0.5 && cy > H * 0.45 && cy < H - NAV_H &&
         dist(cx, cy, jc.x, jc.y) < JOY_R * 1.35;
}

function getSkillBtnPos(idx) {
  const sz = SKILL_SZ, gap = SKILL_GAP;
  const rx = W - 14, by = H - NAV_H - 14;
  const col = idx % 2;             // 0=left, 1=right
  const row = Math.floor(idx / 2); // 0=top, 1=bottom
  return {
    x: rx - (1 - col) * (sz + gap) - sz,
    y: by - (1 - row) * (sz + gap) - sz,
    w: sz, h: sz,
  };
}

// Attack and Target are stacked ABOVE the 2×2 skill grid (row); Potion takes
// the primary slot above that row. Attack keeps the bigger (formerly
// Potion's-slot-sized) radius here, Potion the smaller one below — icon size
// scales off these radii, so this alone swaps how big each icon renders.
function getAttackBtnPos() {
  const sz = SKILL_SZ, gap = SKILL_GAP, r = 30;
  const gridTop = H - NAV_H - 14 - 2 * sz - gap;
  return { x: W - 14 - sz / 2, y: gridTop - gap - r, r };
}

function getTargetBtnPos() {
  const sz = SKILL_SZ, gap = SKILL_GAP, r = POTION_R;
  const gridTop = H - NAV_H - 14 - 2 * sz - gap;
  return { x: W - 14 - sz - gap - sz / 2, y: gridTop - gap - r, r };
}

function getPvpBtnPos() {
  return { x: 8, y: HEADER_H + 6, w: 80, h: 26 };
}

// Directly below the Мир/ПК toggle, same column — opens the "Профессия"
// panel (second-profession skills). See _checkProfessionBtnTouch/input.js
// and drawProfessionButton/openProfessionPanel, js/ui.js.
function getProfessionBtnPos() {
  const pvp = getPvpBtnPos();
  return { x: pvp.x, y: pvp.y + pvp.h + 6, w: pvp.w, h: pvp.h };
}

// Directly below Профессия, same column — opens the "Special" GRAM shop
// panel (advanced-skill books of the buyer's own choice + safe enchant
// stones + season points). See _checkSpecialBtnTouch/input.js and
// drawSpecialButton/openSpecialPanel, js/ui.js.
function getSpecialBtnPos() {
  const prof = getProfessionBtnPos();
  return { x: prof.x, y: prof.y + prof.h + 6, w: prof.w, h: prof.h };
}

function getPartyLeaveBtnPos() {
  const bh = 26, gap = 4;
  const startY = _partyHudStartY();
  const count = (typeof partyMembers !== 'undefined') ? partyMembers.length : 0;
  return { x: getPvpBtnPos().x, y: startY + count * (bh + gap), w: 80, h: 22 };
}

// Party member list starts below the Special button, not the Профессия
// button directly — keeps the two stacks from overlapping.
function _partyHudStartY() {
  const sp = getSpecialBtnPos();
  return sp.y + sp.h + 6;
}

// x is offset so the Пати+/Инфо pair as a whole sits centered on screen —
// see getPartyInfoBtnPos, whose width completes the pair's total span back
// to W/2 ± (80 + 6 + 52) / 2.
function getPartyBtnPos() {
  return { x: W / 2 - 69, y: HEADER_H + 52, w: 80, h: 26 };
}

// "Инфо" button right next to Пати+ — view whoever is currently targeted
// (any nearby player, not just someone who invited you), see
// showPeerProfileModal (js/ui.js) and netRequestPlayerProfile (js/network.js).
function getPartyInfoBtnPos() {
  const pb = getPartyBtnPos();
  return { x: pb.x + pb.w + 6, y: pb.y, w: 52, h: pb.h };
}

// Potion is above the attack/target row; AUTO sits directly above Potion
function getPotionBtnPos() {
  const sz = SKILL_SZ, gap = SKILL_GAP, r = POTION_R;
  const ab = getAttackBtnPos();
  return { x: W - 14 - sz / 2, y: ab.y - ab.r - gap - r, r };
}

function getAutoBtnPos() {
  const pb = getPotionBtnPos();
  const gap = SKILL_GAP;
  const w = 52, h = 22;
  return { x: pb.x - w / 2, y: pb.y - pb.r - gap - h, w, h };
}

// Invite accept/decline buttons (for popup)
function getPartyAcceptPos()  { return { x: W / 2 - 68, y: H / 2 + 18, w: 58, h: 26 }; }
function getPartyDeclinePos() { return { x: W / 2 + 10, y: H / 2 + 18, w: 58, h: 26 }; }

function _isOnScreen(wx, wy) {
  return wx >= _vL && wx <= _vR && wy >= _vT && wy <= _vB;
}

// True while in a live 3v3 match for an id that shouldn't be selectable as a
// target: your own teammates (assist should only ever offer the enemy team)
// and your own side's guard boss (it can't be hit — see the a3Team check in
// server/index.js — so it shouldn't be offered as a target either).
function _a3Unselectable(id) {
  if (typeof _a3InMatch === 'undefined' || !_a3InMatch || !_a3Team) return false;
  if (id === (typeof _a3BossIds !== 'undefined' && _a3BossIds[_a3Team])) return true;
  return (_a3Mates[_a3Team] || []).includes(id);
}

// True while racing (Кровавая Башня) for a racer in a different lane than
// yours — visible (see the pIsRacer exception in Room.js's per-player
// candidate filter, server/game/Room.js), but not selectable: every lane is
// its own sealed corridor until the one shared room every lane opens into,
// so a party invite or profile lookup across lanes has nobody real to reach.
// Both being past bossRoomX0 (sent as part of dungeon.race10 — see
// dungeonData, Room.js) is the same "converged" exception the server's own
// visibility check already makes, so nothing here needs to track it
// separately once both racers have actually arrived.
function _raceUnselectable(id) {
  if (typeof _race10Lane === 'undefined' || _race10Lane == null) return false;
  const op = otherPlayers.get(id);
  if (!op || op.raceLane == null || op.raceLane === _race10Lane) return false;
  const bx = typeof dungeon !== 'undefined' && dungeon && dungeon.race10 && dungeon.race10.bossRoomX0;
  if (bx != null && player.x >= bx && op.x >= bx) return false;
  return true;
}

function cycleTarget() {
  if (!player) return;
  const isOnline = !!(socket?.connected);
  const activeEnemies = isOnline ? serverEnemies : enemies;
  const candidates = [];
  activeEnemies.forEach(e => {
    if ((e.hp || 0) > 0 && _isOnScreen(e.x, e.y) && !_a3Unselectable(e.id))
      candidates.push({ id: e.id, isPlayer: false, d: dist(e.x, e.y, player.x, player.y) });
  });
  // Selectable regardless of pvpMode: locking onto a player this way is only
  // ever used for viewing their profile or inviting them to a party — the
  // actual attack logic (js/game.js) refuses to swing at a targetIsPlayer
  // target unless pvpMode is separately on, so there's nothing to guard here.
  if (isOnline) {
    otherPlayers.forEach((op, id) => {
      if ((op.hp || 0) > 0 && op.x != null && _isOnScreen(op.x, op.y) && !_a3Unselectable(id) && !_raceUnselectable(id))
        candidates.push({ id, isPlayer: true, d: dist(op.x, op.y, player.x, player.y) });
    });
  }
  candidates.sort((a, b) => a.d - b.d);
  if (candidates.length === 0) { targetId = null; targetIsPlayer = false; _chaseArmed = false; return; }
  const curIdx = candidates.findIndex(c => c.id === targetId && c.isPlayer === targetIsPlayer);
  const next = candidates[(curIdx + 1) % candidates.length];
  targetId = next.id;
  targetIsPlayer = next.isPlayer;
  _chaseArmed = false; // selecting a target this way is just aiming, not committing to chase it
}

function _trySelectEntityAtTouch(cx, cy) {
  if (!player || state !== 'playing') return;
  const worldX = cx / ZOOM + camera.x;
  const worldY = (cy - HEADER_H) / ZOOM + camera.y;
  const isOnline = !!(socket?.connected);
  const activeEnemies = isOnline ? serverEnemies : enemies;
  const tapR = 28;
  let best = null, bestD = Infinity;
  activeEnemies.forEach(e => {
    if ((e.hp || 0) <= 0 || _a3Unselectable(e.id)) return;
    const d = dist(worldX, worldY, e.x, e.y);
    if (d < e.size + tapR && d < bestD) { bestD = d; best = { id: e.id, isPlayer: false }; }
  });
  if (isOnline) {
    otherPlayers.forEach((op, id) => {
      if ((op.hp || 0) <= 0 || op.x == null || _a3Unselectable(id)) return;
      const d = dist(worldX, worldY, op.x, op.y);
      if (d < 22 + tapR && d < bestD) { bestD = d; best = { id, isPlayer: true }; }
    });
  }
  if (best) { targetId = best.id; targetIsPlayer = best.isPlayer; _chaseArmed = false; }
}

function joyGuard() { return state === 'playing' && activeTab === 0; }

function _checkSkillTouch(cx, cy) {
  if (!player) return false;
  const skills = SKILL_DEF[player.type];
  if (!skills) return false;
  for (let i = 0; i < 4; i++) {
    const b = getSkillBtnPos(i);
    if (cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h) {
      useSkill(i);
      return true;
    }
  }
  return false;
}

// Potion button: a quick tap uses the potion immediately; holding it down
// opens the auto-use settings picker instead (and suppresses the tap-use).
const POTION_LONGPRESS_MS = 450;
let _potionTouchId = null;
let _potionPressTimer = null;
let _potionLongFired = false;

function _potionPressStart(touchId) {
  _potionTouchId = touchId;
  _potionLongFired = false;
  clearTimeout(_potionPressTimer);
  _potionPressTimer = setTimeout(() => {
    _potionLongFired = true;
    if (typeof openHpPicker === 'function') openHpPicker();
  }, POTION_LONGPRESS_MS);
}

function _potionPressEnd(touchId) {
  if (_potionTouchId !== touchId) return;
  clearTimeout(_potionPressTimer);
  _potionPressTimer = null;
  _potionTouchId = null;
  if (!_potionLongFired) usePotion();
}

function _potionPressCancel(touchId) {
  if (touchId !== undefined && _potionTouchId !== touchId) return;
  clearTimeout(_potionPressTimer);
  _potionPressTimer = null;
  _potionTouchId = null;
}

function _checkPotionTouch(cx, cy, touchId) {
  const pb = getPotionBtnPos();
  if (Math.hypot(cx - pb.x, cy - pb.y) < pb.r + 6) {
    _potionPressStart(touchId);
    return true;
  }
  return false;
}

function _checkTargetBtnTouch(cx, cy) {
  const tb = getTargetBtnPos();
  if (Math.hypot(cx - tb.x, cy - tb.y) < tb.r + 6) {
    cycleTarget();
    return true;
  }
  return false;
}

function _checkPvpBtnTouch(cx, cy) {
  const pb = getPvpBtnPos();
  if (cx >= pb.x && cx <= pb.x + pb.w && cy >= pb.y && cy <= pb.y + pb.h) {
    // PvP is not optional inside a death battle — letting an entrant switch it
    // off would make them unkillable and stall the round.
    if (typeof _dbInFight !== 'undefined' && _dbInFight) {
      if (typeof dmgNum === 'function') dmgNum(player.x, player.y - 40, t('dbPvpLockedToast'), '#f88');
      return true;
    }
    if (!pvpMode && typeof inSafeZone === 'function' && player && inSafeZone(player.x, player.y)) {
      if (typeof dmgNum === 'function') dmgNum(player.x, player.y - 40, 'Нельзя в безопасной зоне', '#f88');
      return true;
    }
    pvpMode = !pvpMode;
    if (typeof netSetPvpMode === 'function') netSetPvpMode(pvpMode);
    if (!pvpMode && targetIsPlayer) { targetId = null; targetIsPlayer = false; }
    return true;
  }
  return false;
}

function _checkProfessionBtnTouch(cx, cy) {
  const pb = getProfessionBtnPos();
  if (cx >= pb.x && cx <= pb.x + pb.w && cy >= pb.y && cy <= pb.y + pb.h) {
    if (typeof openProfessionPanel === 'function') openProfessionPanel();
    return true;
  }
  return false;
}

function _checkSpecialBtnTouch(cx, cy) {
  const sb = getSpecialBtnPos();
  if (cx >= sb.x && cx <= sb.x + sb.w && cy >= sb.y && cy <= sb.y + sb.h) {
    if (typeof openSpecialPanel === 'function') openSpecialPanel();
    return true;
  }
  return false;
}

function _checkPartyLeaveBtnTouch(cx, cy) {
  if (!partyMembers || partyMembers.length === 0) return false;
  const lb = getPartyLeaveBtnPos();
  if (cx >= lb.x && cx <= lb.x + lb.w && cy >= lb.y && cy <= lb.y + lb.h) {
    if (typeof netPartyLeave === 'function') netPartyLeave();
    return true;
  }
  return false;
}

function _checkPartyInfoBtnTouch(cx, cy) {
  if (!player || !targetIsPlayer || !targetId) return false;
  const ib = getPartyInfoBtnPos();
  if (cx >= ib.x && cx <= ib.x + ib.w && cy >= ib.y && cy <= ib.y + ib.h) {
    if (typeof netRequestPlayerProfile === 'function') netRequestPlayerProfile(targetId);
    return true;
  }
  return false;
}

function _checkPartyBtnTouch(cx, cy) {
  if (!player) return false;
  if (_checkPartyInfoBtnTouch(cx, cy)) return true;
  const pb = getPartyBtnPos();
  if (cx >= pb.x && cx <= pb.x + pb.w && cy >= pb.y && cy <= pb.y + pb.h) {
    if (targetIsPlayer && targetId) {
      if (typeof netPartyInvite === 'function') netPartyInvite(targetId);
    }
    return true;
  }
  return false;
}

function _checkPartyInviteTouch(cx, cy) {
  if (!partyInvitePending) return false;
  const ac = getPartyAcceptPos(), dc = getPartyDeclinePos();
  if (cx >= ac.x && cx <= ac.x + ac.w && cy >= ac.y && cy <= ac.y + ac.h) {
    if (typeof netPartyAccept === 'function') netPartyAccept(partyInvitePending.fromId);
    return true;
  }
  if (cx >= dc.x && cx <= dc.x + dc.w && cy >= dc.y && cy <= dc.y + dc.h) {
    if (typeof netPartyDecline === 'function') netPartyDecline(partyInvitePending.fromId);
    return true;
  }
  return false;
}

function _checkAttackBtnTouch(cx, cy) {
  if (!player) return false;
  const ab = getAttackBtnPos();
  if (Math.hypot(cx - ab.x, cy - ab.y) < ab.r + 8) {
    // Only force an immediate swing on a FRESH press. Once sustained attack
    // is already armed (or full autoAttackMode is on), atkTimer is already
    // ticking down toward the next swing on its own — forcing it to -1 again
    // here on a repeat tap would skip whatever cooldown is left and fire
    // faster than the character's real attack speed (this was the manual-
    // attack-feels-faster-than-auto bug).
    if (!_chaseArmed && !autoAttackMode && (player.atkAnimTimer || 0) <= 0) {
      player.atkTimer = -1;
    }
    _chaseArmed = true;
    return true;
  }
  return false;
}

const AUTO_ATTACK_VIP_MIN = 2;
function _checkAutoBtnTouch(cx, cy) {
  const ab = getAutoBtnPos();
  if (cx >= ab.x && cx <= ab.x + ab.w && cy >= ab.y && cy <= ab.y + ab.h) {
    if (player && (window._vipData?.level || 0) < AUTO_ATTACK_VIP_MIN) {
      if (typeof dmgNum === 'function') dmgNum(player.x, player.y - 38, `🔒 Авто-атака с VIP ${AUTO_ATTACK_VIP_MIN}`, '#f93');
      return true;
    }
    autoAttackMode = !autoAttackMode;
    return true;
  }
  return false;
}

// Canvas can be offset from the viewport origin — on desktop #app is
// centered by the body flexbox (and capped at max-height:932px), so once the
// window is wider/taller than a phone screen, raw e.clientX/clientY no
// longer line up with the W/H pixel space every button/joystick hitbox is
// computed in. Mobile browsers happen to render #app flush against the
// viewport, which is why this only ever showed up on desktop.
function _toCanvasXY(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  return { x: clientX - r.left, y: clientY - r.top };
}

function onTS(e) {
  e.preventDefault();
  for (const t of e.changedTouches) {
    const p = _toCanvasXY(t.clientX, t.clientY);
    _perfToggleTap(p.x, p.y);
  }
  if (!joyGuard()) return;
  const jc = joyCenter();
  for (const t of e.changedTouches) {
    const p = _toCanvasXY(t.clientX, t.clientY);
    // continue, not return — this only means "ignore this one touch", not
    // "stop processing every other simultaneous touch in this event" (a
    // multi-touch batch, e.g. one finger already on the attack button while
    // another lands near the nav bar, was dropping the rest of the batch).
    if (p.y > H - NAV_H) continue;
    if (_checkPartyInviteTouch(p.x, p.y)) continue;
    if (_checkPartyLeaveBtnTouch(p.x, p.y)) continue;
    if (_checkPvpBtnTouch(p.x, p.y)) continue;
    if (_checkProfessionBtnTouch(p.x, p.y)) continue;
    if (_checkSpecialBtnTouch(p.x, p.y)) continue;
    if (_checkPartyBtnTouch(p.x, p.y)) continue;
    if (_checkAutoBtnTouch(p.x, p.y)) continue;
    if (_checkAttackBtnTouch(p.x, p.y)) continue;
    if (_checkPotionTouch(p.x, p.y, t.identifier)) continue;
    if (_checkTargetBtnTouch(p.x, p.y)) continue;
    if (_checkSkillTouch(p.x, p.y)) continue;
    // Starting (or already holding) the joystick claims this touch entirely —
    // don't ALSO tap-select whatever enemy/NPC happens to be rendered behind
    // it on screen (that was firing on every joystick press-down, since this
    // ran unconditionally before the joystick-zone check below).
    if (joy.active || _inJoyZone(p.x, p.y)) {
      if (!joy.active) {
        joy.active = true; joy.id = t.identifier;
        joy.sx = jc.x; joy.sy = jc.y; joy.dx = 0; joy.dy = 0;
      }
      continue;
    }
    _trySelectEntityAtTouch(p.x, p.y);
  }
}

function onTM(e) {
  e.preventDefault();
  if (!joyGuard()) return;
  // joy.active is required here, not just the identifier match: touch
  // identifiers are small integers many mobile browsers hand out
  // sequentially and REUSE once a touch ends. onTE below cleared
  // joy.active but left joy.id holding that now-stale identifier, so once
  // some later, completely unrelated touch (tapping a skill button,
  // attacking, anything) happened to be assigned the same reused id, its
  // touchmove would silently hijack the joystick — matching what looks
  // like "the joystick keeps steering no matter where I tap afterwards."
  for (const t of e.changedTouches) {
    if (joy.active && t.identifier === joy.id) {
      const p = _toCanvasXY(t.clientX, t.clientY);
      setJoy(p.x, p.y);
    }
    // Dragging off the potion button cancels a pending tap/long-press
    // instead of firing either once the finger lifts elsewhere.
    if (t.identifier === _potionTouchId) {
      const p = _toCanvasXY(t.clientX, t.clientY);
      const pb = getPotionBtnPos();
      if (Math.hypot(p.x - pb.x, p.y - pb.y) > pb.r + 40) _potionPressCancel(t.identifier);
    }
  }
}

function onTE(e) {
  for (const t of e.changedTouches) {
    if (t.identifier === joy.id) { joy.active = false; joy.id = null; joy.dx = 0; joy.dy = 0; }
    _potionPressEnd(t.identifier);
  }
  if (e.touches.length === 0) { joy.active = false; joy.id = null; joy.dx = 0; joy.dy = 0; }
}

function onTC() { joy.active = false; joy.id = null; joy.dx = 0; joy.dy = 0; _potionPressCancel(); }

function onMD(e) {
  const p = _toCanvasXY(e.clientX, e.clientY);
  _perfToggleTap(p.x, p.y);
  if (!joyGuard()) return;
  if (p.y > H - NAV_H) return;
  const jc = joyCenter();
  if (_checkPartyInviteTouch(p.x, p.y)) return;
  if (_checkPartyLeaveBtnTouch(p.x, p.y)) return;
  if (_checkPvpBtnTouch(p.x, p.y)) return;
  if (_checkProfessionBtnTouch(p.x, p.y)) return;
  if (_checkSpecialBtnTouch(p.x, p.y)) return;
  if (_checkPartyBtnTouch(p.x, p.y)) return;
  if (_checkAutoBtnTouch(p.x, p.y)) return;
  if (_checkAttackBtnTouch(p.x, p.y)) return;
  if (_checkPotionTouch(p.x, p.y, 'mouse')) return;
  if (_checkTargetBtnTouch(p.x, p.y)) return;
  if (_checkSkillTouch(p.x, p.y)) return;
  if (_inJoyZone(p.x, p.y)) {
    joy.active = true; joy.sx = jc.x; joy.sy = jc.y; joy.dx = 0; joy.dy = 0;
    return;
  }
  _trySelectEntityAtTouch(p.x, p.y);
}

function onMM(e) {
  if (_potionTouchId === 'mouse') {
    const p = _toCanvasXY(e.clientX, e.clientY);
    const pb = getPotionBtnPos();
    if (Math.hypot(p.x - pb.x, p.y - pb.y) > pb.r + 40) _potionPressCancel('mouse');
  }
  if (joy.active && joyGuard()) {
    const p = _toCanvasXY(e.clientX, e.clientY);
    setJoy(p.x, p.y);
  }
}
function onMU()  { joy.active = false; joy.dx = 0; joy.dy = 0; _potionPressEnd('mouse'); }

function setJoy(cx, cy) {
  const dx = cx - joy.sx, dy = cy - joy.sy, len = Math.hypot(dx, dy);
  if (len > JOY_R) { joy.dx = dx / len; joy.dy = dy / len; }
  else { joy.dx = dx / JOY_R; joy.dy = dy / JOY_R; }
}

// Below this raw magnitude (fraction of JOY_R), treat the stick as centered.
// A real thumb resting near the middle — or just touchscreen digitizer noise
// on an otherwise-still finger — reports 1-2px of jitter around dead center.
// joy.dx/dy near zero still have SOME direction (angle is unstable at tiny
// magnitude), and inputDir() below normalizes that to a full-strength unit
// vector — so without a deadzone, that noise was flipping player.facing
// back and forth at full confidence (the hysteresis check only compares the
// two normalized axes against each other, and noise makes them trade off
// arbitrarily), which resets the walk/idle animation frame every time and
// reads as the character sprite twitching/jittering while barely moving.
const _JOY_DEADZONE = 0.12;

// Pre-allocated return value — callers must consume before next call
const _inputDirResult = { dx: 0, dy: 0, len: 0 };
function inputDir() {
  let dx = joy.dx, dy = joy.dy;
  if (keys['ArrowLeft']  || keys['a']) dx -= 1;
  if (keys['ArrowRight'] || keys['d']) dx += 1;
  // 'w' is intentionally NOT a move-up alias here (unlike a/s/d) — it's also
  // the W skill hotkey (see initInput() below), and treating it as movement
  // too meant holding "up" on WASD kept re-triggering the W skill instead of
  // turning the character to face up: the skill's cast animation takes over
  // player.atkAnimTimer, which gates the movement/facing code below out
  // entirely for as long as it plays. ArrowUp remains a full, unambiguous
  // way to move up from the keyboard.
  if (keys['ArrowUp']) dy -= 1;
  if (keys['ArrowDown']  || keys['s']) dy += 1;
  const l = Math.hypot(dx, dy);
  if (l > _JOY_DEADZONE) {
    _inputDirResult.dx = dx / l; _inputDirResult.dy = dy / l; _inputDirResult.len = Math.min(1, l);
  } else {
    _inputDirResult.dx = 0; _inputDirResult.dy = 0; _inputDirResult.len = 0;
  }
  return _inputDirResult;
}

function initInput() {
  window.addEventListener('keydown', e => {
    keys[e.key] = true;
    if (state === 'playing' && activeTab === 0) {
      const map = { q:0, w:1, e:2, r:3, Q:0, W:1, E:2, R:3 };
      if (e.key in map) useSkill(map[e.key]);
      if (e.key === 'f' || e.key === 'F') usePotion();
      if (e.key === 'Tab') { e.preventDefault(); cycleTarget(); }
    }
  });
  window.addEventListener('keyup', e => { keys[e.key] = false; });
  canvas.addEventListener('touchstart',  onTS, { passive: false });
  canvas.addEventListener('touchmove',   onTM, { passive: false });
  canvas.addEventListener('touchend',    onTE);
  canvas.addEventListener('touchcancel', onTC);
  canvas.addEventListener('mousedown',   onMD);
  window.addEventListener('mousemove',   onMM);
  window.addEventListener('mouseup',     onMU);
}
