// ── Character Select: idle animation + loading gate ──────────

const _CS_TYPES = ['warrior', 'archer', 'mage', 'priest', 'assasin'];

let _csRAF = null;
let _csState = {};

function _csUpdateStats() {
  _CS_TYPES.forEach(type => {
    const card = document.querySelector('.cs-' + type);
    if (!card) return;
    const cd = CHAR_DEF[type];
    const vals = card.querySelectorAll('.cs-sv');
    if (vals[0]) vals[0].textContent = cd.baseHP;
    if (vals[1]) vals[1].textContent = cd.baseAtk;
    if (vals[2]) vals[2].textContent = cd.baseDef;
    if (vals[3]) vals[3].textContent = cd.speed;
  });
}

function csShow(savedData) {
  const el = document.getElementById('char-select');
  if (!el) return;

  _csUpdateStats();

  _CS_TYPES.forEach(type => {
    const btn = document.getElementById('cs-btn-' + type);
    if (!btn) return;
    if (savedData && savedData.type === type) {
      btn.textContent = '▶ Продолжить · Ур.' + (savedData.lvl || 1) + ' · ' + (savedData.gold || 0) + 'g';
      btn.classList.add('cs-resume');
    } else {
      btn.textContent = 'Создать персонажа';
      btn.classList.remove('cs-resume');
    }
  });

  el.style.display = 'flex';
  const loadEl = document.getElementById('cs-loading');
  if (loadEl) loadEl.style.display = 'none';

  _CS_TYPES.forEach(type => {
    if (SPRITE_DEF[type]) loadSpritePreviewFrame(type);
  });

  _csStartAnim();
}

function csHide() {
  _csStopAnim();
  const el = document.getElementById('char-select');
  if (el) {
    el.style.display = 'none';
    const cards = el.querySelector('.cs-cards');
    if (cards) cards.style.display = '';
  }
}

function _csStartAnim() {
  if (_csRAF) return;
  _CS_TYPES.forEach(t => {
    if (!_csState[t]) _csState[t] = { frame: 0, timer: 0 };
  });
  let last = performance.now();
  function tick(now) {
    const el = document.getElementById('char-select');
    if (!el || el.style.display === 'none') { _csRAF = null; return; }
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    _CS_TYPES.forEach(t => _csDrawFrame(t, dt));
    _csRAF = requestAnimationFrame(tick);
  }
  _csRAF = requestAnimationFrame(tick);
}

function _csStopAnim() {
  if (_csRAF) { cancelAnimationFrame(_csRAF); _csRAF = null; }
}

function _csDrawFrame(type, dt) {
  const canvas = document.getElementById('cs-canvas-' + type);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const s = _csState[type];
  const fps = 7;
  const animDef = SPRITE_DEF[type]?.anims['front-idle'];
  const totalFrames = animDef ? animDef.n : 16;

  s.timer += dt;
  while (s.timer >= 1 / fps) {
    s.timer -= 1 / fps;
    s.frame = (s.frame + 1) % totalFrames;
  }

  const img = spriteCache[type]?.['front-idle'];
  if (img?.complete && img.naturalWidth > 0 && animDef) {
    const def = SPRITE_DEF[type];
    const col = s.frame % animDef.cols;
    const row = Math.floor(s.frame / animDef.cols);
    ctx.drawImage(img, col * def.frameW, row * def.frameH, def.frameW, def.frameH, 0, 0, W, H);
    return;
  }

  // Fallback: animated circle with bob + emoji
  const def = CHAR_DEF[type];
  const cx = W / 2, cy = H / 2;
  const r = Math.min(W, H) * 0.3;
  const bob = Math.sin(s.frame * 0.45) * 3;

  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(cx, cy + r + 5 - bob * 0.3, r * 0.6, r * 0.18, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = def.color + 'aa';
  ctx.beginPath();
  ctx.arc(cx, cy - bob, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = def.color;
  ctx.lineWidth = 2.5;
  ctx.stroke();

  drawIconCtx(ctx, def.icon, cx, cy - bob + 2, r * 1.8, def.color);
}

// ── Loading gate: game starts only when sprites + server BOTH ready ──

let _csGateSprites = false;
let _csGateServer  = false;
let _csGateCb      = null;

function csStartLoading(type, onReady) {
  _csGateSprites = false;
  _csGateServer  = false;
  _csGateCb      = onReady;

  const def   = CHAR_DEF[type];
  const loadEl = document.getElementById('cs-loading');
  if (loadEl) loadEl.style.display = 'flex';

  const emojiEl = document.getElementById('csl-emoji');
  const nameEl  = document.getElementById('csl-name');
  if (emojiEl) emojiEl.innerHTML = iconHTML(def.icon, 60, def.color);
  if (nameEl)  nameEl.textContent  = def.name;

  csSetStatus('Загрузка спрайтов...');
}

function csSetStatus(text) {
  const el = document.getElementById('csl-status');
  if (el) el.textContent = text;
}

function csOnSpritesReady() {
  _csGateSprites = true;
  if (!_csGateServer) csSetStatus('Ожидание сервера...');
  _csCheckGate();
}

function csOnServerReady() {
  _csGateServer = true;
  if (!_csGateSprites) csSetStatus('Загрузка спрайтов...');
  _csCheckGate();
}

function _csCheckGate() {
  if (_csGateSprites && _csGateServer && _csGateCb) {
    csSetStatus('Запуск!');
    const cb = _csGateCb;
    _csGateCb = null;
    setTimeout(cb, 180);
  }
}
