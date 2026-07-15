function joyCenter() { return { x: W / 2, y: H - NAV_H - 88 }; }

function joyGuard() { return state === 'playing' && activeTab === 0; }

function onTS(e) {
  e.preventDefault();
  if (!joyGuard()) return;
  const jc = joyCenter();
  for (const t of e.changedTouches) {
    if (t.clientY > H - NAV_H) return;
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
  window.addEventListener('keydown', e => { keys[e.key] = true; });
  window.addEventListener('keyup',   e => { keys[e.key] = false; });
  canvas.addEventListener('touchstart',  onTS, { passive: false });
  canvas.addEventListener('touchmove',   onTM, { passive: false });
  canvas.addEventListener('touchend',    onTE);
  canvas.addEventListener('touchcancel', onTC);
  canvas.addEventListener('mousedown',   onMD);
  window.addEventListener('mousemove',   onMM);
  window.addEventListener('mouseup',     onMU);
  canvas.addEventListener('click', e => { if (state === 'dead' && activeTab === 0) restartGame(); });
}
