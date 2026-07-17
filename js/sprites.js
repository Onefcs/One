const SPRITE_DEF = {
  warrior: {
    frameW: 840, frameH: 720,
    anims: {
      'front-idle':   { src:'images/Warrior/Front - Idle.png',      cols:4, rows:4, n:16, fps:7,  loop:true  },
      'back-idle':    { src:'images/Warrior/Back - Idle.png',        cols:4, rows:4, n:16, fps:7,  loop:true  },
      'left-idle':    { src:'images/Warrior/Left - Idle.png',        cols:4, rows:4, n:16, fps:7,  loop:true  },
      'right-idle':   { src:'images/Warrior/Right - Idle.png',       cols:4, rows:4, n:16, fps:7,  loop:true  },
      'front-run':    { src:'images/Warrior/Front - Running.png',    cols:4, rows:3, n:12, fps:12, loop:true  },
      'back-run':     { src:'images/Warrior/Back - Running.png',     cols:4, rows:3, n:12, fps:12, loop:true  },
      'left-run':     { src:'images/Warrior/Left - Running.png',     cols:4, rows:3, n:12, fps:12, loop:true  },
      'right-run':    { src:'images/Warrior/Right - Running.png',    cols:4, rows:3, n:12, fps:12, loop:true  },
      'front-attack': { src:'images/Warrior/Front - Attacking.png',  cols:5, rows:2, n:10, fps:14, loop:false },
      'back-attack':  { src:'images/Warrior/Back - Attacking.png',   cols:5, rows:2, n:10, fps:14, loop:false },
      'left-attack':  { src:'images/Warrior/Left - Attacking.png',   cols:5, rows:2, n:10, fps:14, loop:false },
      'right-attack': { src:'images/Warrior/Right - Attacking.png',  cols:5, rows:2, n:10, fps:14, loop:false },
      'die':          { src:'images/Warrior/Dying.png',              cols:5, rows:2, n:10, fps:8,  loop:false },
    }
  },
  archer: {
    frameW: 480, frameH: 480,
    anims: {
      'front-idle':   { src:'images/Archer/Front - Idle.png',      cols:4, rows:4, n:16, fps:7,  loop:true  },
      'back-idle':    { src:'images/Archer/Back - Idle.png',        cols:4, rows:4, n:16, fps:7,  loop:true  },
      'left-idle':    { src:'images/Archer/Left - Idle.png',        cols:4, rows:4, n:16, fps:7,  loop:true  },
      'right-idle':   { src:'images/Archer/Right - Idle.png',       cols:4, rows:4, n:16, fps:7,  loop:true  },
      'front-run':    { src:'images/Archer/Front - Running.png',    cols:4, rows:3, n:12, fps:12, loop:true  },
      'back-run':     { src:'images/Archer/Back - Running.png',     cols:4, rows:3, n:12, fps:12, loop:true  },
      'left-run':     { src:'images/Archer/Left - Running.png',     cols:4, rows:3, n:12, fps:12, loop:true  },
      'right-run':    { src:'images/Archer/Right - Running.png',    cols:4, rows:3, n:12, fps:12, loop:true  },
      'front-attack': { src:'images/Archer/Front - Shooting.png',   cols:5, rows:2, n:10, fps:14, loop:false },
      'back-attack':  { src:'images/Archer/Back - Shooting.png',    cols:5, rows:2, n:10, fps:14, loop:false },
      'left-attack':  { src:'images/Archer/Left - Shooting.png',    cols:5, rows:2, n:10, fps:14, loop:false },
      'right-attack': { src:'images/Archer/Right - Shooting.png',   cols:5, rows:2, n:10, fps:14, loop:false },
      'die':          { src:'images/Archer/Dying.png',              cols:5, rows:2, n:10, fps:8,  loop:false },
    }
  },
  mage: {
    frameW: 480, frameH: 480,
    anims: {
      'front-idle':   { src:'images/Mage/Front - Idle.png',      cols:4, rows:4, n:16, fps:7,  loop:true  },
      'back-idle':    { src:'images/Mage/Back - Idle.png',        cols:4, rows:4, n:16, fps:7,  loop:true  },
      'left-idle':    { src:'images/Mage/Left - Idle.png',        cols:4, rows:4, n:16, fps:7,  loop:true  },
      'right-idle':   { src:'images/Mage/Right - Idle.png',       cols:4, rows:4, n:16, fps:7,  loop:true  },
      'front-run':    { src:'images/Mage/Front - Running.png',    cols:4, rows:3, n:12, fps:12, loop:true  },
      'back-run':     { src:'images/Mage/Back - Running.png',     cols:4, rows:3, n:12, fps:12, loop:true  },
      'left-run':     { src:'images/Mage/Left - Running.png',     cols:4, rows:3, n:12, fps:12, loop:true  },
      'right-run':    { src:'images/Mage/Right - Running.png',    cols:4, rows:3, n:12, fps:12, loop:true  },
      'front-attack': { src:'images/Mage/Front - Attacking.png',  cols:5, rows:2, n:10, fps:14, loop:false },
      'back-attack':  { src:'images/Mage/Back - Attacking.png',   cols:5, rows:2, n:10, fps:14, loop:false },
      'left-attack':  { src:'images/Mage/Left - Attacking.png',   cols:5, rows:2, n:10, fps:14, loop:false },
      'right-attack': { src:'images/Mage/Right - Attacking.png',  cols:5, rows:2, n:10, fps:14, loop:false },
      'die':          { src:'images/Mage/Dying.png',              cols:5, rows:2, n:10, fps:8,  loop:false },
    }
  },
  priest: {
    frameW: 480, frameH: 480,
    anims: {
      'front-idle':   { src:'images/Priest/Front - Idle.png',      cols:4, rows:4, n:16, fps:7,  loop:true  },
      'back-idle':    { src:'images/Priest/Back - Idle.png',        cols:4, rows:4, n:16, fps:7,  loop:true  },
      'left-idle':    { src:'images/Priest/Left - Idle.png',        cols:4, rows:4, n:16, fps:7,  loop:true  },
      'right-idle':   { src:'images/Priest/Right - Idle.png',       cols:4, rows:4, n:16, fps:7,  loop:true  },
      'front-run':    { src:'images/Priest/Front - Running.png',    cols:4, rows:3, n:12, fps:12, loop:true  },
      'back-run':     { src:'images/Priest/Back - Running.png',     cols:4, rows:3, n:12, fps:12, loop:true  },
      'left-run':     { src:'images/Priest/Left - Running.png',     cols:4, rows:3, n:12, fps:12, loop:true  },
      'right-run':    { src:'images/Priest/Right - Running.png',    cols:4, rows:3, n:12, fps:12, loop:true  },
      'front-attack': { src:'images/Priest/Front - Attacking.png',  cols:5, rows:2, n:10, fps:14, loop:false },
      'back-attack':  { src:'images/Priest/Back - Attacking.png',   cols:5, rows:2, n:10, fps:14, loop:false },
      'left-attack':  { src:'images/Priest/Left - Attacking.png',   cols:5, rows:2, n:10, fps:14, loop:false },
      'right-attack': { src:'images/Priest/Right - Attacking.png',  cols:5, rows:2, n:10, fps:14, loop:false },
      'die':          { src:'images/Priest/Dying.png',              cols:5, rows:2, n:10, fps:8,  loop:false },
    }
  },
  assasin: {
    frameW: 480, frameH: 480,
    anims: {
      'front-idle':   { src:'images/Assasin/Front - Idle.png',      cols:4, rows:4, n:16, fps:7,  loop:true  },
      'back-idle':    { src:'images/Assasin/Back - Idle.png',        cols:4, rows:4, n:16, fps:7,  loop:true  },
      'left-idle':    { src:'images/Assasin/Left - Idle.png',        cols:4, rows:4, n:16, fps:7,  loop:true  },
      'right-idle':   { src:'images/Assasin/Right - Idle.png',       cols:4, rows:4, n:16, fps:7,  loop:true  },
      'front-run':    { src:'images/Assasin/Front - Running.png',    cols:4, rows:3, n:12, fps:12, loop:true  },
      'back-run':     { src:'images/Assasin/Back - Running.png',     cols:4, rows:3, n:12, fps:12, loop:true  },
      'left-run':     { src:'images/Assasin/Left - Running.png',     cols:4, rows:3, n:12, fps:12, loop:true  },
      'right-run':    { src:'images/Assasin/Right - Running.png',    cols:4, rows:3, n:12, fps:12, loop:true  },
      'front-attack': { src:'images/Assasin/Front - Attacking.png',  cols:5, rows:2, n:10, fps:14, loop:false },
      'back-attack':  { src:'images/Assasin/Back - Attacking.png',   cols:5, rows:2, n:10, fps:14, loop:false },
      'left-attack':  { src:'images/Assasin/Left - Attacking.png',   cols:5, rows:2, n:10, fps:14, loop:false },
      'right-attack': { src:'images/Assasin/Right - Attacking.png',  cols:5, rows:2, n:10, fps:14, loop:false },
      'die':          { src:'images/Assasin/Dying.png',              cols:5, rows:2, n:10, fps:8,  loop:false },
    }
  },
};

// ── ENEMY SPRITE SHEETS ─────────────────────────────────────────────────────
// All sheets: 64×64 frames, 4 identical rows (slime is symmetric — row 0 used)
const ENEMY_SPRITE_DEF = {
  slime: {
    frameW: 64, frameH: 64, row: 0,
    sheets: {
      idle:   { src:'images/Slime/Slime1_Idle_with_shadow.png',   cols:6,  fps:8,  loop:true  },
      walk:   { src:'images/Slime/Slime1_Walk_with_shadow.png',   cols:8,  fps:10, loop:true  },
      attack: { src:'images/Slime/Slime1_Attack_with_shadow.png', cols:10, fps:14, loop:false },
      hurt:   { src:'images/Slime/Slime1_Hurt_with_shadow.png',   cols:5,  fps:14, loop:false },
      death:  { src:'images/Slime/Slime1_Death_with_shadow.png',  cols:10, fps:8,  loop:false },
    }
  },
  goblin: { sharedWith: 'slime' },
};

// Warm up an already-loaded image so the canvas 2D pipeline never has to
// decode/rasterize it lazily on the first real drawImage() call. decode()
// alone isn't reliable enough here — under the load of many concurrent large
// sheets it can silently reject (falling back to a no-op), and even on
// success it doesn't always warm the same raster cache canvas drawing uses.
// Actually drawing one pixel into a throwaway canvas forces genuine
// rasterization through the exact code path the game canvas will use.
let _warmCanvas = null, _warmCtx = null;
function _warmUpImage(img, onDone) {
  function draw() {
    if (!_warmCanvas) { _warmCanvas = document.createElement('canvas'); _warmCanvas.width = _warmCanvas.height = 1; _warmCtx = _warmCanvas.getContext('2d'); }
    try { _warmCtx.drawImage(img, 0, 0, 1, 1, 0, 0, 1, 1); } catch (e) { /* ignore */ }
    onDone();
  }
  if (img.decode) img.decode().then(draw, draw);
  else draw();
}

const enemySpriteCache = {};
// eid -> Promise resolved once every sheet for that enemy is loaded AND decoded.
// Callers may ask for the same eid again while a load is still in flight (e.g.
// the loading-screen gate and drawEnemySprite's own lazy-load both do) — chain
// onto the existing promise instead of firing onDone before decode finishes.
const _enemySpriteLoadPromises = {};

function loadEnemySprites(eid, onDone) {
  onDone = onDone || function () {};
  const def = ENEMY_SPRITE_DEF[eid];
  if (!def) { onDone(); return; }
  if (_enemySpriteLoadPromises[eid]) { _enemySpriteLoadPromises[eid].then(onDone); return; }
  enemySpriteCache[eid] = {};
  const keys = Object.keys(def.sheets);
  let total = keys.length, done = 0;
  let resolveReady;
  _enemySpriteLoadPromises[eid] = new Promise(res => { resolveReady = res; });
  function tick() { if (++done >= total) resolveReady(); }
  keys.forEach(key => {
    const img = new Image();
    img.src = def.sheets[key].src;
    img.onload = () => _warmUpImage(img, tick);
    img.onerror = tick;
    enemySpriteCache[eid][key] = img;
  });
  if (total === 0) resolveReady();
  _enemySpriteLoadPromises[eid].then(onDone);
}

function drawEnemySprite(e, dt) {
  const ownDef = ENEMY_SPRITE_DEF[e.eid];
  if (!ownDef) return false;
  const resolvedEid = ownDef.sharedWith || e.eid;
  const def = ENEMY_SPRITE_DEF[resolvedEid];
  if (!def) return false;
  if (!enemySpriteCache[resolvedEid]) loadEnemySprites(resolvedEid);
  const cache = enemySpriteCache[resolvedEid];

  let key;
  if (e.hp <= 0)               key = 'death';
  else if (e.hurtTimer > 0.05) key = 'hurt';
  else if (e.atkAnimTimer > 0) key = 'attack';
  else if (e.aggro)            key = 'walk';
  else                         key = 'idle';

  const sh = def.sheets[key];
  const img = cache[key];
  if (!img || !img.complete || img.naturalWidth === 0) return false;

  if (e._animKey !== key) { e._animKey = key; e._animFrame = 0; e._animTimer = 0; }

  e._animTimer += dt || 0;
  const fd = 1 / sh.fps;
  while (e._animTimer >= fd) {
    e._animTimer -= fd;
    e._animFrame++;
    if (e._animFrame >= sh.cols) e._animFrame = sh.loop ? 0 : sh.cols - 1;
  }

  const { frameW, frameH, row } = def;
  const sx = e._animFrame * frameW;
  const sy = row * frameH;
  const ds = e.size * 4.5;
  ctx.drawImage(img, sx, sy, frameW, frameH,
    Math.round(e.x - ds * 0.5), Math.round(e.y - ds * 0.80),
    ds, ds);
  return true;
}

// ── PLAYER SPRITE SHEETS ────────────────────────────────────────────────────

const spriteCache = {};
// charType -> Promise resolved once every frame is loaded AND decoded — see
// _enemySpriteLoadPromises for why concurrent callers must chain onto it
// rather than firing onDone as soon as the cache object exists.
const _spriteLoadPromises = {};

// Char-select shows 5 idle previews at once — only the 'front-idle' frame is
// ever drawn there, so only load+decode that one sheet per unpicked character.
// Eagerly decoding all 13 sheets × 5 characters (some up to 3360×2880px) at
// once was overwhelming the browser's image-decode pipeline: decode() calls
// started silently rejecting under the load, leaving bitmaps un-warmed, which
// then forced a synchronous decode-on-draw (a 100-300ms freeze) the first
// time the chosen character's run/attack animation was drawn mid-game.
function loadSpritePreviewFrame(charType, onDone) {
  onDone = onDone || function () {};
  const def = SPRITE_DEF[charType];
  if (!def) { onDone(); return; }
  spriteCache[charType] = spriteCache[charType] || {};
  const cache = spriteCache[charType];
  if (cache['front-idle']) { onDone(); return; }
  const img = new Image();
  img.src = def.anims['front-idle'].src;
  img.onload = () => _warmUpImage(img, onDone);
  img.onerror = onDone;
  cache['front-idle'] = img;
}

function loadSprites(charType, onDone) {
  const def = SPRITE_DEF[charType];
  if (!def) { onDone(); return; }
  if (_spriteLoadPromises[charType]) { _spriteLoadPromises[charType].then(onDone); return; }
  spriteCache[charType] = spriteCache[charType] || {};
  const cache = spriteCache[charType];
  const keys = Object.keys(def.anims);
  let total = keys.length, done = 0;
  let resolveReady;
  _spriteLoadPromises[charType] = new Promise(res => { resolveReady = res; });
  function tick() { if (++done >= total) resolveReady(); }
  keys.forEach(key => {
    // Reuse the char-select preview frame instead of re-fetching/re-decoding it.
    const existing = cache[key];
    if (existing && existing.complete && existing.naturalWidth > 0) {
      _warmUpImage(existing, tick);
      return;
    }
    const img = new Image();
    img.src = def.anims[key].src;
    img.onload = () => _warmUpImage(img, tick);
    img.onerror = tick;
    cache[key] = img;
  });
  if (total === 0) resolveReady();
  _spriteLoadPromises[charType].then(onDone);
}

function getSpriteAnimKey(p) {
  if (state === 'dead') return 'die';
  const dir = p.facing || 'front';
  if (p.atkAnimTimer > 0)  return `${dir}-attack`;
  const inp = inputDir();
  if (inp.len > 0.05)      return `${dir}-run`;
  return `${dir}-idle`;
}

let _tintCanvas = null, _tintCtx = null;
function _drawTinted(img, fw, fh, sx, sy, dx, dy, dw, dh, color) {
  if (!_tintCanvas) {
    _tintCanvas = document.createElement('canvas');
    _tintCtx = _tintCanvas.getContext('2d');
  }
  const iw = Math.round(dw), ih = Math.round(dh);
  if (_tintCanvas.width !== iw || _tintCanvas.height !== ih) {
    _tintCanvas.width = iw; _tintCanvas.height = ih;
  }
  _tintCtx.clearRect(0, 0, iw, ih);
  _tintCtx.drawImage(img, sx, sy, fw, fh, 0, 0, iw, ih);
  _tintCtx.globalCompositeOperation = 'source-atop';
  _tintCtx.fillStyle = color;
  _tintCtx.fillRect(0, 0, iw, ih);
  _tintCtx.globalCompositeOperation = 'source-over';
  ctx.drawImage(_tintCanvas, dx, dy, iw, ih);
}

function drawSprite(p, tint) {
  const def = SPRITE_DEF[p.type];
  const cache = spriteCache[p.type];
  if (!def || !cache) return false;
  const key = getSpriteAnimKey(p);
  const ad = def.anims[key];
  const img = cache[key];
  if (!ad || !img || !img.complete || img.naturalWidth === 0) return false;

  const fi = Math.min(Math.floor(p.animFrame), ad.n - 1);
  const sx = (fi % ad.cols) * def.frameW;
  const sy = Math.floor(fi / ad.cols) * def.frameH;

  const dh = 80;
  const dw = dh * def.frameW / def.frameH;
  const dx = Math.round(p.x - dw / 2);
  const dy = Math.round(p.y - dh * 0.62);

  ctx.fillStyle = 'rgba(0,0,0,.3)';
  ctx.beginPath(); ctx.ellipse(p.x, p.y + 18, 13, 5, 0, 0, Math.PI * 2); ctx.fill();
  if (tint) _drawTinted(img, def.frameW, def.frameH, sx, sy, dx, dy, dw, dh, tint);
  else      ctx.drawImage(img, sx, sy, def.frameW, def.frameH, dx, dy, dw, dh);
  return true;
}
