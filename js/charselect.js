// ── Character Select ──────────────────────────────────────────

const _CS_TYPES = ['warrior', 'archer', 'mage', 'priest', 'assasin'];

let _csRAF = null;
let _csState = {};
let _csActiveType = 'warrior';
let _csSavedData  = null;

const _CS_BADGE = {
  warrior: '⚔ Ближний бой',
  archer:  '🏹 Дальний бой',
  mage:    '✨ Дальний бой',
  priest:  '💛 Поддержка',
  assasin: '🗡 Ближний бой',
};

// Max values for bar scaling
const _CS_STAT_MAX = { hp: 200, atk: 9, def: 10, spd: 205, as: 1.2 };

function _csSetBar(id, valId, value, max) {
  const fill = document.getElementById(id);
  const lbl  = document.getElementById(valId);
  if (fill) fill.style.width = Math.round(Math.min(1, value / max) * 100) + '%';
  if (lbl)  lbl.textContent  = typeof value === 'number' && value % 1 !== 0 ? value.toFixed(2) : value;
}

function _csBuildSkills(type) {
  const list = document.getElementById('cs-skills-list');
  if (!list) return;
  const skills = SKILL_DEF[type];
  if (!skills) { list.innerHTML = ''; return; }
  list.innerHTML = skills.map(sk => `
    <div class="cs-skill">
      ${sk.img
        ? `<img src="${sk.img}" width="32" height="32" style="image-rendering:pixelated;border-radius:6px;flex-shrink:0">`
        : `<div class="cs-skill-key">${sk.key}</div>`}
      <div class="cs-skill-body">
        <div class="cs-skill-name">${sk.name}</div>
        <div class="cs-skill-desc">${sk.desc}</div>
        <div class="cs-skill-cd">Кулдаун: ${sk.cd} сек</div>
      </div>
    </div>`).join('');
}

function _csSwitchChar(type) {
  _csActiveType = type;
  const cd = CHAR_DEF[type];

  // Tabs
  document.querySelectorAll('.cs-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.type === type);
  });

  // Canvases
  _CS_TYPES.forEach(t => {
    const c = document.getElementById('cs-canvas-' + t);
    if (c) c.style.display = t === type ? 'block' : 'none';
  });

  // Name + badge
  const nameEl  = document.getElementById('cs-active-name');
  const badgeEl = document.getElementById('cs-active-badge');
  if (nameEl)  { nameEl.textContent = cd.name; nameEl.style.color = cd.color; }
  if (badgeEl) { badgeEl.textContent = _CS_BADGE[type] || ''; }

  // Stat bars
  _csSetBar('cs-bar-hp',  'cs-val-hp',  cd.baseHP,    _CS_STAT_MAX.hp);
  _csSetBar('cs-bar-atk', 'cs-val-atk', cd.baseAtk,   _CS_STAT_MAX.atk);
  _csSetBar('cs-bar-def', 'cs-val-def', cd.baseDef,    _CS_STAT_MAX.def);
  _csSetBar('cs-bar-spd', 'cs-val-spd', cd.speed,      _CS_STAT_MAX.spd);
  _csSetBar('cs-bar-as',  'cs-val-as',  cd.atkSpeed,   _CS_STAT_MAX.as);

  // Skills list
  _csBuildSkills(type);

  // Button
  const btn = document.getElementById('cs-btn-active');
  if (btn) {
    btn.className = 'cs-btn cs-btn-' + type;
    if (_csSavedData && _csSavedData.type === type) {
      btn.textContent = '▶ Продолжить · Ур.' + (_csSavedData.lvl || 1) + ' · ' + (_csSavedData.gold || 0) + 'g';
      btn.classList.add('cs-resume');
    } else {
      btn.textContent = 'Создать персонажа';
    }
    btn.onclick = () => selectChar(type);
  }
}

function csShow(savedData) {
  _csSavedData = savedData || null;
  const el = document.getElementById('char-select');
  if (!el) return;
  el.style.display = 'flex';
  const loadEl = document.getElementById('cs-loading');
  if (loadEl) loadEl.style.display = 'none';

  // Load sprite previews for all types
  _CS_TYPES.forEach(type => {
    if (SPRITE_DEF[type]) loadSpritePreviewFrame(type);
    if (!_csState[type]) _csState[type] = { frame: 0, timer: 0 };
  });

  // Default to saved type, or warrior
  const startType = (savedData && savedData.type) ? savedData.type : 'warrior';
  _csSwitchChar(startType);
  _csStartAnim();
}

function csHide() {
  _csStopAnim();
  const el = document.getElementById('char-select');
  if (el) el.style.display = 'none';
}

function _csStartAnim() {
  if (_csRAF) return;
  let last = performance.now();
  function tick(now) {
    const el = document.getElementById('char-select');
    if (!el || el.style.display === 'none') { _csRAF = null; return; }
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    // Only animate the active canvas
    _csDrawFrame(_csActiveType, dt);
    _csRAF = requestAnimationFrame(tick);
  }
  _csRAF = requestAnimationFrame(tick);
}

function _csStopAnim() {
  if (_csRAF) { cancelAnimationFrame(_csRAF); _csRAF = null; }
}

function _csDrawFrame(type, dt) {
  const canvas = document.getElementById('cs-canvas-' + type);
  if (!canvas || canvas.style.display === 'none') return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const s = _csState[type] || (_csState[type] = { frame: 0, timer: 0 });
  const fps = 7;
  const animDef = SPRITE_DEF[type]?.anims['front-idle'];
  const totalFrames = animDef ? animDef.n : 16;

  s.timer += dt;
  while (s.timer >= 1 / fps) {
    s.timer -= 1 / fps;
    s.frame = (s.frame + 1) % totalFrames;
  }

  const img = spriteCache[type]?.['front-idle'];
  if (img && _sheetReady(img) && animDef) {
    const def = SPRITE_DEF[type];
    const fw = img.frameW || def.frameW, fh = img.frameH || def.frameH;
    const col = s.frame % animDef.cols;
    const row = Math.floor(s.frame / animDef.cols);
    ctx.drawImage(img, col * fw, row * fh, fw, fh, 0, 0, W, H);
    return;
  }

  // Fallback: animated circle with bob + emoji
  const def = CHAR_DEF[type];
  const cx = W / 2, cy = H / 2;
  const r = Math.min(W, H) * 0.28;
  const bob = Math.sin(s.frame * 0.45) * 4;

  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.beginPath();
  ctx.ellipse(cx, cy + r + 6 - bob * 0.3, r * 0.55, r * 0.16, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = def.color + 'aa';
  ctx.beginPath();
  ctx.arc(cx, cy - bob, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = def.color;
  ctx.lineWidth = 3;
  ctx.stroke();

  drawIconCtx(ctx, def.icon, cx, cy - bob + 2, r * 1.8, def.color);
}

// ── Loading gate ──────────────────────────────────────────────

let _csGateSprites = false;
let _csGateServer  = false;
let _csGateCb      = null;

function csStartLoading(type, onReady) {
  _csGateSprites = false;
  _csGateServer  = false;
  _csGateCb      = onReady;

  const def    = CHAR_DEF[type];
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
