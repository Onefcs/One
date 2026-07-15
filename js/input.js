const SKILL_SZ  = 54;
const SKILL_GAP = 8;
const POTION_R  = 26;

function joyCenter() { return { x: W * 0.27, y: H - NAV_H - 88 }; }

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

function getPotionBtnPos() {
  const sb = getSkillBtnPos(0);
  const cx = sb.x + SKILL_SZ + SKILL_GAP / 2;
  return { x: cx, y: sb.y - POTION_R - 10, r: POTION_R };
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

function _checkPotionTouch(cx, cy) {
  const pb = getPotionBtnPos();
  if (Math.hypot(cx - pb.x, cy - pb.y) < pb.r + 6) {
    usePotion();
    return true;
  }
  return false;
}

function onTS(e) {
  e.preventDefault();
  if (!joyGuard()) return;
  const jc = joyCenter();
  for (const t of e.changedTouches) {
    if (t.clientY > H - NAV_H) return;
    if (_checkPotionTouch(t.clientX, t.clientY)) continue;
    if (_checkSkillTouch(t.clientX, t.clientY)) continue;
    if (!joy.active && dist(t.clientX, t.clientY, jc.x, jc.y) < JOY_R * 1.9) {
      joy.active = true; joy.id = t.identifier;
      joy.sx = jc.x; joy.sy = jc.y; joy.dx = 0; joy.dy = 0;
    }
  }
}

function onTM(e) {
  e.preventDefault();
  if (!joyGuard()) return;
  for (const t of e.changedTouches)
    if (t.identifier === joy.id) setJoy(t.clientX, t.clientY);
}

function onTE(e) {
  for (const t of e.changedTouches)
    if (t.identifier === joy.id) { joy.active = false; joy.dx = 0; joy.dy = 0; }
  if (e.touches.length === 0) { joy.active = false; joy.dx = 0; joy.dy = 0; }
}

function onTC() { joy.active = false; joy.dx = 0; joy.dy = 0; }

function onMD(e) {
  if (!joyGuard()) return;
  if (e.clientY > H - NAV_H) return;
  if (_checkPotionTouch(e.clientX, e.clientY)) return;
  if (_checkSkillTouch(e.clientX, e.clientY)) return;
  const jc = joyCenter();
  if (dist(e.clientX, e.clientY, jc.x, jc.y) < JOY_R * 1.9) {
    joy.active = true; joy.sx = jc.x; joy.sy = jc.y; joy.dx = 0; joy.dy = 0;
  }
}

function onMM(e) { if (joy.active && joyGuard()) setJoy(e.clientX, e.clientY); }
function onMU()  { joy.active = false; joy.dx = 0; joy.dy = 0; }

function setJoy(cx, cy) {
  const dx = cx - joy.sx, dy = cy - joy.sy, len = Math.hypot(dx, dy);
  if (len > JOY_R) { joy.dx = dx / len; joy.dy = dy / len; }
  else { joy.dx = dx / JOY_R; joy.dy = dy / JOY_R; }
}

function inputDir() {
  let dx = joy.dx, dy = joy.dy;
  if (keys['ArrowLeft']  || keys['a']) dx -= 1;
  if (keys['ArrowRight'] || keys['d']) dx += 1;
  if (keys['ArrowUp']    || keys['w']) dy -= 1;
  if (keys['ArrowDown']  || keys['s']) dy += 1;
  const l = Math.hypot(dx, dy);
  return l > 0.01 ? { dx: dx / l, dy: dy / l, len: Math.min(1, l) } : { dx: 0, dy: 0, len: 0 };
}

function initInput() {
  window.addEventListener('keydown', e => {
    keys[e.key] = true;
    if (state === 'playing' && activeTab === 0) {
      const map = { q:0, w:1, e:2, r:3, Q:0, W:1, E:2, R:3 };
      if (e.key in map) useSkill(map[e.key]);
      if (e.key === 'f' || e.key === 'F') usePotion();
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
  canvas.addEventListener('click', e => { if (state === 'dead' && activeTab === 0) restartGame(); });
}
