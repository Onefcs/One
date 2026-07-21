// ── pixi-world.js — PixiJS WebGL world renderer ────────────────────────────
// Replaces Canvas 2D world drawing; HUD stays on _uiOverlay (2D canvas).

const _isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

let _pixiApp = null;
let _worldCt  = null;   // Container — camera transform applied here
let _tileCt   = null;
let _szGfx    = null;   // safe-zone overlay (Graphics, rebuilt on dungeon change)
let _aoeGfx   = null;   // AOE rings (Graphics, cleared each frame)
let _npcGfx   = null;   // NPC bodies
let _npcNames = [];      // PIXI.Text per NPC
let _dropGfx  = null;
let _partGfx  = null;   // particles (Graphics, cleared each frame)
let _enemyCt  = null;
let _otherPCt = null;
let _projGfx  = null;
let _playerCt = null;
let _dmgNumCt = null;

// Entity sprite pools
const _enemyPool  = new Map(); // id  → {ct, spr, gfx}
const _otherPool  = new Map(); // sid → {ct, spr, gfx}

// Player rendering objects
let _plSpr = null, _plGfx = null;

// Damage-number pool
const _dmgActive = [];
const _dmgPool   = [];

// Chunk sprite cache — separate from _tileChunks canvas cache
const _chunkSprCache = new Map(); // "cx,cy" → PIXI.Sprite

// Texture caches
const _pTex = {};          // charType|animKey → PIXI.Texture[]
const _eTex = {};          // eid|sheetKey     → {down,up,left,right}: PIXI.Texture[]
const _clanIconTexCache = {}; // iconId → PIXI.Texture (pixel-art clan icons)

let _szBuiltFor = null; // dungeon reference for safe-zone rebuild guard
let _lastBgColor = null; // dirty flag — bg color only changes on floor switch

// Rasterise a clan icon to a PIXI.Texture (cached per iconId, NEAREST filtering for pixel art)
function _getClanIconTex(iconId) {
  const id = iconId || 1;
  if (_clanIconTexCache[id]) return _clanIconTexCache[id];
  const px = 2, sz = 16 * px;
  const oc = document.createElement('canvas');
  oc.width = sz; oc.height = sz;
  drawClanIconOnCtx(oc.getContext('2d'), id, sz / 2, sz / 2, px);
  const bt = PIXI.BaseTexture.from(oc);
  bt.scaleMode = PIXI.SCALE_MODES.NEAREST;
  return (_clanIconTexCache[id] = new PIXI.Texture(bt));
}

// ── init ──────────────────────────────────────────────────
function pixiInit(canvasEl) {
  _pixiApp = new PIXI.Application({
    view: canvasEl,
    width:  canvasEl.clientWidth  || 375,
    height: canvasEl.clientHeight || 667,
    resolution: Math.min(window.devicePixelRatio || 1, _isMobile ? 1.5 : 2),
    autoDensity: true,
    backgroundAlpha: 1,
    antialias: false,
    powerPreference: _isMobile ? 'default' : 'high-performance',
  });
  _pixiApp.stop(); // manual render call

  _worldCt  = new PIXI.Container();
  _tileCt   = new PIXI.Container();
  _szGfx    = new PIXI.Graphics();
  _aoeGfx   = new PIXI.Graphics();
  _npcGfx   = new PIXI.Graphics();
  _dropGfx  = new PIXI.Graphics();
  _partGfx  = new PIXI.Graphics();
  _enemyCt  = new PIXI.Container();
  _otherPCt = new PIXI.Container();
  _projGfx  = new PIXI.Graphics();
  _playerCt = new PIXI.Container();
  _dmgNumCt = new PIXI.Container();

  _worldCt.addChild(
    _tileCt, _szGfx, _aoeGfx,
    _npcGfx, _dropGfx, _partGfx,
    _enemyCt, _otherPCt, _projGfx,
    _playerCt, _dmgNumCt
  );
  _worldCt.scale.set(ZOOM); // constant — set once, never changed in the render loop
  _pixiApp.stage.addChild(_worldCt);
}

function pixiClearEntityPools() {
  _enemyPool.forEach(obj => obj.ct.destroy({ children: true }));
  _enemyPool.clear();
  _otherPool.forEach(obj => obj.ct.destroy({ children: true }));
  _otherPool.clear();
  // Invalidate player texture cache so new char type picks up fresh textures
  Object.keys(_pTex).forEach(k => delete _pTex[k]);
}

function pixiResize(w, h, dpr) {
  if (!_pixiApp) return;
  _pixiApp.renderer.resolution = dpr;
  _pixiApp.renderer.resize(w, h);
}

function pixiSetBg(cssHex) {
  if (!_pixiApp) return;
  _pixiApp.renderer.background.color = parseInt(cssHex.replace('#', ''), 16);
}

function pixiClearWorld() {
  if (_worldCt) _worldCt.visible = false;
  if (_pixiApp) _pixiApp.renderer.render(_pixiApp.stage);
}

// Called from buildTileCanvas() on floor change
function pixiInvalidateChunks() {
  _chunkSprCache.forEach(spr => {
    _tileCt.removeChild(spr);
    spr.destroy({ texture: true, baseTexture: true });
  });
  _chunkSprCache.clear();
  _szBuiltFor = null; // force safe-zone rebuild
  pixiClearEntityPools();
}

// ── texture helpers ───────────────────────────────────────

function _playerTextures(charType, animKey) {
  const k = charType + '|' + animKey;
  if (_pTex[k]) return _pTex[k];
  const def   = SPRITE_DEF[charType];
  const cache = spriteCache[charType];
  if (!def || !cache) return null;
  const img = cache[animKey];
  if (!img || img.naturalWidth !== undefined) return null; // not yet rasterized
  const ad = def.anims[animKey];
  const fw = img.frameW, fh = img.frameH;
  const bt = PIXI.BaseTexture.from(img);
  bt.scaleMode = PIXI.SCALE_MODES.LINEAR;
  const arr = [];
  for (let i = 0; i < ad.n; i++) {
    const col = i % ad.cols, row = Math.floor(i / ad.cols);
    arr.push(new PIXI.Texture(bt, new PIXI.Rectangle(col * fw, row * fh, fw, fh)));
  }
  return (_pTex[k] = arr);
}

function _enemyTextures(eid, sheetKey) {
  const k = eid + '|' + sheetKey;
  if (_eTex[k]) return _eTex[k];
  const def   = ENEMY_SPRITE_DEF[eid];
  const cache = enemySpriteCache[eid];
  if (!def || !cache) return null;
  const img = cache[sheetKey];
  if (!img || !img.complete || !img.naturalWidth) return null;
  const sh = def.sheets[sheetKey];
  const { frameW, frameH } = def;
  const bt = PIXI.BaseTexture.from(img);
  bt.scaleMode = PIXI.SCALE_MODES.LINEAR;
  const rows = {};
  for (const [facing, ri] of Object.entries(ENEMY_FACING_ROW)) {
    rows[facing] = [];
    for (let c = 0; c < sh.cols; c++)
      rows[facing].push(new PIXI.Texture(bt, new PIXI.Rectangle(c * frameW, ri * frameH, frameW, frameH)));
  }
  return (_eTex[k] = rows);
}

// ── tiles ─────────────────────────────────────────────────

function _updateTiles(camX, camY) {
  if (!dungeon || !dungeon.grid) return;
  const maxCx = Math.ceil(dungeon.w * TILE / _CHUNK_PX) - 1;
  const maxCy = Math.ceil(dungeon.h * TILE / _CHUNK_PX) - 1;
  const c0x = Math.max(0, Math.floor(camX / _CHUNK_PX));
  const c0y = Math.max(0, Math.floor(camY / _CHUNK_PX));
  const c1x = Math.min(maxCx, Math.floor((camX + W / ZOOM) / _CHUNK_PX));
  const c1y = Math.min(maxCy, Math.floor((camY + (H - HEADER_H) / ZOOM) / _CHUNK_PX));

  const vis = new Set();
  for (let cy = c0y; cy <= c1y; cy++) {
    for (let cx = c0x; cx <= c1x; cx++) {
      const key = cx + ',' + cy;
      vis.add(key);
      if (!_chunkSprCache.has(key)) {
        let cv = _tileChunks.get(key);
        if (!cv) {
          cv = _buildChunk(cx, cy);
          if (_tileChunks.size >= _CHUNK_MAX) _tileChunks.delete(_tileChunks.keys().next().value);
          _tileChunks.set(key, cv);
        }
        const tex = PIXI.Texture.from(cv);
        const spr = new PIXI.Sprite(tex);
        spr.x = cx * _CHUNK_PX - _CHUNK_G;
        spr.y = cy * _CHUNK_PX - _CHUNK_G;
        _tileCt.addChild(spr);
        _chunkSprCache.set(key, spr);
      }
    }
  }
  _chunkSprCache.forEach((spr, key) => { spr.visible = vis.has(key); });
}

// ── safe zone ─────────────────────────────────────────────

function _updateSafeZone() {
  if (_szBuiltFor === dungeon) return;
  _szBuiltFor = dungeon;
  _szGfx.clear();
  if (!dungeon || !dungeon.safeZone) return;
  const sz = dungeon.safeZone;
  const w = sz.x2 - sz.x1, h = sz.y2 - sz.y1;
  _szGfx.beginFill(0x3cdc64, 0.08);
  _szGfx.drawRect(sz.x1, sz.y1, w, h);
  _szGfx.endFill();
  _szGfx.lineStyle(3 / ZOOM, 0x3cdc64, 0.35);
  _szGfx.drawRect(sz.x1, sz.y1, w, h);
  _szGfx.lineStyle(0);
}

// ── AOE rings ─────────────────────────────────────────────

function _updateAoeRings() {
  _aoeGfx.clear();
  aoeRings.forEach(ring => {
    const a = ring.life / ring.maxLife;
    _aoeGfx.beginFill(0x44aaff, a * 0.20);
    _aoeGfx.drawCircle(ring.x, ring.y, ring.r);
    _aoeGfx.endFill();
    _aoeGfx.lineStyle(2 / ZOOM, 0x44aaff, a * 0.85);
    _aoeGfx.drawCircle(ring.x, ring.y, ring.r);
    _aoeGfx.lineStyle(0);
  });
}

// ── NPCs ──────────────────────────────────────────────────

function _updateNpcs(ts) {
  if (!npcs || !npcs.length) { _npcGfx.clear(); return; }
  // Sync name text objects count
  while (_npcNames.length > npcs.length) {
    const t = _npcNames.pop();
    _worldCt.removeChild(t); t.destroy();
  }
  while (_npcNames.length < npcs.length) {
    const n = npcs[_npcNames.length];
    const t = new PIXI.Text(n.name, {
      fontFamily: 'system-ui, Arial', fontSize: 10, fontWeight: 'bold',
      fill: n.color || '#7b5ea7', stroke: '#000', strokeThickness: 3,
    });
    t.anchor.set(0.5, 1);
    _worldCt.addChild(t);
    _npcNames.push(t);
  }
  _npcGfx.clear();
  const pulse  = 0.7 + 0.3 * Math.sin(ts * 0.0048);
  const bounce = Math.sin(ts * 0.009) * 3;
  for (let i = 0; i < npcs.length; i++) {
    const n = npcs[i], t = _npcNames[i];
    const onScreen = n.x >= _vL && n.x <= _vR && n.y >= _vT && n.y <= _vB;
    t.visible = onScreen;
    if (!onScreen) continue;
    const col = parseInt((n.color || '#7b5ea7').replace('#', ''), 16);
    _npcGfx.beginFill(0x000000, 0.3);
    _npcGfx.drawEllipse(n.x, n.y + 18, 14, 5);
    _npcGfx.endFill();
    _npcGfx.beginFill(col);
    _npcGfx.drawCircle(n.x, n.y, 18);
    _npcGfx.endFill();
    _npcGfx.lineStyle(2, col, pulse * 0.8);
    _npcGfx.drawCircle(n.x, n.y, 22);
    _npcGfx.lineStyle(0);
    t.x = n.x; t.y = n.y - 26;
    if (nearNpc && nearNpc.id === n.id) {
      // chat bubble indicator
      _npcGfx.beginFill(0xffffff, 0.85);
      _npcGfx.drawRoundedRect(n.x - 8, n.y - 44 + bounce, 16, 13, 3);
      _npcGfx.endFill();
    }
  }
}

// ── drops ─────────────────────────────────────────────────

function _updateDrops(ts) {
  _dropGfx.clear();
  if (!drops.length) return;
  const s = Math.sin(ts * 0.0054);
  const bob = s * 3;
  drops.forEach(d => {
    const a = Math.min(1, d.life * 1.5) * (0.85 + 0.15 * s);
    if (d.type === 'gold') {
      _dropGfx.beginFill(0xffff00, a);
      _dropGfx.drawCircle(d.x, d.y + bob, 9);
      _dropGfx.endFill();
      _dropGfx.beginFill(0xcc8800, a * 0.9);
      _dropGfx.drawCircle(d.x, d.y + bob, 5);
      _dropGfx.endFill();
    } else {
      _dropGfx.beginFill(0xaaaacc, a * 0.85);
      _dropGfx.drawRoundedRect(d.x - 10, d.y + bob - 10, 20, 20, 3);
      _dropGfx.endFill();
      _dropGfx.lineStyle(1.5, 0xffffff, a * 0.5);
      _dropGfx.drawRoundedRect(d.x - 10, d.y + bob - 10, 20, 20, 3);
      _dropGfx.lineStyle(0);
    }
  });
}

// ── particles ─────────────────────────────────────────────

function _updateParticles() {
  _partGfx.clear();
  if (!particles.length) return;
  if (_particlesDirty) {
    if (particles.length > 1) particles.sort((a, b) => (a.color > b.color) - (a.color < b.color));
    _particlesDirty = false;
  }
  let i = 0;
  while (i < particles.length) {
    const col = particles[i].color;
    const cn = parseInt(col.replace('#', ''), 16);
    let j = i;
    while (j < particles.length && particles[j].color === col) j++;
    // find max alpha in this batch for beginFill (individual alphas via separate fills)
    while (i < j) {
      const p = particles[i++];
      const a = Math.max(0, p.life);
      if (a <= 0) continue;
      _partGfx.beginFill(cn, a);
      _partGfx.drawCircle(p.x, p.y, p.size);
      _partGfx.endFill();
    }
  }
}

// ── projectiles ───────────────────────────────────────────

function _pixiDrawProj(p) {
  const col = parseInt((p.color || '#fa0').replace('#', ''), 16);
  if (p.projType === 'arrow') {
    const ang = p.angle ?? Math.atan2(p.vy, p.vx);
    const cos = Math.cos(ang), sin = Math.sin(ang);
    const rx = (dx, dy) => p.x + dx * cos - dy * sin;
    const ry = (dx, dy) => p.y + dx * sin + dy * cos;
    _projGfx.lineStyle(2.5, col, 1);
    _projGfx.moveTo(rx(-13, 0), ry(-13, 0));
    _projGfx.lineTo(rx(9,   0), ry(9,   0));
    _projGfx.lineStyle(0);
    _projGfx.beginFill(col);
    _projGfx.drawPolygon([
      rx(13, 0), ry(13, 0),
      rx(6, -3.5), ry(6, -3.5),
      rx(6,  3.5), ry(6,  3.5),
    ]);
    _projGfx.endFill();
  } else {
    _projGfx.beginFill(col, 0.3);
    _projGfx.drawCircle(p.x, p.y, p.size + 7);
    _projGfx.endFill();
    _projGfx.beginFill(col, 0.8);
    _projGfx.drawCircle(p.x, p.y, p.size);
    _projGfx.endFill();
    _projGfx.beginFill(0xffffff, 0.9);
    _projGfx.drawCircle(p.x, p.y, p.size * 0.38);
    _projGfx.endFill();
  }
}

function _updateProjs() {
  _projGfx.clear();
  projs.forEach(_pixiDrawProj);
  otherProjs.forEach(_pixiDrawProj);
}

// ── damage numbers ────────────────────────────────────────

function _getDmgText() {
  if (_dmgPool.length) return _dmgPool.pop();
  const t = new PIXI.Text('', {
    fontFamily: 'Arial', fontWeight: 'bold',
    fill: '#fff', stroke: '#000', strokeThickness: 3,
    align: 'center',
  });
  t.anchor.set(0.5, 0.5);
  _dmgNumCt.addChild(t);
  return t;
}

function _updateDmgNums() {
  while (_dmgActive.length > dmgNums.length) {
    const t = _dmgActive.pop();
    t.visible = false;
    _dmgPool.push(t);
  }
  while (_dmgActive.length < dmgNums.length) _dmgActive.push(_getDmgText());
  for (let i = 0; i < dmgNums.length; i++) {
    const d = dmgNums[i], t = _dmgActive[i];
    t.visible = true;
    if (t.text !== d.text) t.text = d.text;
    if (t.style.fontSize !== (d.fontSize || 15)) t.style.fontSize = d.fontSize || 15;
    if (t.style.fill !== (d.color || '#fff')) t.style.fill = d.color || '#fff';
    t.alpha = Math.min(1, d.life * 1.5);
    t.x = d.x; t.y = d.y;
  }
}

// ── enemy pool ────────────────────────────────────────────

function _getEnemy(id) {
  if (_enemyPool.has(id)) return _enemyPool.get(id);
  const ct  = new PIXI.Container();
  const spr = new PIXI.Sprite(PIXI.Texture.WHITE);
  spr.visible = false;
  const gfx = new PIXI.Graphics();
  const lbl = new PIXI.Text('', { fontFamily: 'system-ui,Arial', fontWeight: 'bold', fontSize: 14, fill: '#e8e8e8', stroke: '#000', strokeThickness: 4 });
  lbl.anchor.set(0.5, 1);
  ct.addChild(spr, gfx, lbl);
  _enemyCt.addChild(ct);
  const obj = { ct, spr, gfx, lbl };
  _enemyPool.set(id, obj);
  return obj;
}

function _updateEnemyObj(e, obj, dt, pulse, bossGlow) {
  const { ct, spr, gfx } = obj;
  ct.x = e.x; ct.y = e.y;
  gfx.clear();

  // Selection ring
  if (e.id === targetId && !targetIsPlayer) {
    gfx.lineStyle(2.5, 0xff3c3c, 0.65 + 0.35 * pulse);
    gfx.drawCircle(0, 0, e.size + 8 + pulse * 3);
    gfx.lineStyle(0);
  }

  // Determine animation key (mirrors drawEnemySprite logic)
  if (!e._facing) e._facing = 'down';
  let key;
  if (e.hp <= 0)                               key = 'death';
  else if (e.atkAnimTimer > 0 && !e._atkDone) key = 'attack';
  else if (e.aggro && (e._moveTimer||0) > 0)  key = 'walk';
  else                                         key = 'idle';

  // Advance animation timer (drawEnemySprite did this; now we do it here)
  const def = ENEMY_SPRITE_DEF[e.eid];
  if (def) {
    const sh = def.sheets[key];
    if (sh) {
      if (e._animKey !== key) { e._animKey = key; e._animFrame = 0; e._animTimer = 0; }
      e._animTimer = (e._animTimer || 0) + dt;
      const fd = 1 / sh.fps;
      while (e._animTimer >= fd) {
        e._animTimer -= fd;
        e._animFrame = (e._animFrame || 0) + 1;
        if (e._animFrame >= sh.cols) {
          e._animFrame = sh.loop ? 0 : sh.cols - 1;
          if (!sh.loop && key === 'attack') e._atkDone = true;
        }
      }
    }
  }

  const ds     = (e.isBoss ? e.size * 4.5 : e.size * 6.75) * 0.85;
  const texRows = def ? _enemyTextures(e.eid, key) : null;
  const sh = def?.sheets[key];
  if (texRows && sh) {
    const facing = e._facing || 'down';
    const rowTex = texRows[facing];
    const frame  = Math.min(e._animFrame || 0, sh.cols - 1);
    const tex    = rowTex?.[frame];
    if (tex) {
      spr.texture  = tex;
      spr.width    = ds;
      spr.height   = ds;
      spr.x        = -ds * 0.5;
      spr.y        = -ds * 0.55;
      spr.tint    = (e.hurtTimer > 0) ? 0xff4444 : 0xffffff;
      spr.visible = true;
    } else { spr.visible = false; }
  } else {
    spr.visible = false;
    // Circle fallback
    const hurt = (e.hurtTimer||0) > 0;
    const fc = parseInt((e.color||'#aa0000').replace('#',''), 16);
    gfx.beginFill(hurt ? 0xff4444 : fc);
    gfx.drawCircle(0, 0, e.size);
    gfx.endFill();
    gfx.beginFill(0x000000);
    gfx.drawCircle(-e.size * 0.3, -e.size * 0.18, e.size * 0.18);
    gfx.drawCircle( e.size * 0.3, -e.size * 0.18, e.size * 0.18);
    gfx.endFill();
  }

  // Status overlays
  if ((e.slowTimer||0) > 0) { gfx.beginFill(0x44aaff, 0.28); gfx.drawCircle(0,0,e.size); gfx.endFill(); }
  if ((e.stunTimer||0) > 0) { gfx.beginFill(0xffff88, 0.35); gfx.drawCircle(0,0,e.size); gfx.endFill(); }

  if (e.hp <= 0) return; // no bars for corpse

  // HP bar
  const bw  = Math.round(ds * 0.7 * 0.85);
  const bh  = 5;
  const bx  = -bw / 2;
  const by  = -ds * 0.55 - 8;
  gfx.beginFill(0x440000); gfx.drawRect(bx, by, bw, bh); gfx.endFill();
  const pct = e.hp / e.maxHp;
  const bc  = pct > 0.5 ? 0x22dd22 : pct > 0.25 ? 0xddaa22 : 0xdd2222;
  gfx.beginFill(bc); gfx.drawRect(bx, by, bw * pct, bh); gfx.endFill();

  if (e.isBoss) {
    gfx.lineStyle(3, 0xff3232, bossGlow);
    gfx.drawCircle(0, 0, e.size + 5);
    gfx.lineStyle(0);
  }

  // Name / boss label above HP bar
  const { lbl } = obj;
  const lblText = e.isBoss ? `⚠ БОСС · ${e.name || ''}` : (e.name || '');
  if (lbl.text !== lblText) lbl.text = lblText;
  lbl.style.fill         = e.isBoss ? '#ff9999' : '#e8e8e8';
  lbl.style.fontSize     = e.isBoss ? 18 : 14;
  lbl.style.strokeThickness = e.isBoss ? 5 : 4;
  lbl.x = 0;
  lbl.y = by - 4;
}

function _updateEnemies(dt, pulse, bossGlow) {
  _visEnm = 0;
  const seen = new Set();
  serverEnemies.forEach(e => {
    if (!_isOnScreen(e.x, e.y)) return;
    // Lazy-load sprites on first encounter (mirrors old drawEnemySprite behaviour)
    if (!enemySpriteCache[e.eid]) loadEnemySprites(e.eid);
    _visEnm++;
    seen.add(e.id);
    const obj = _getEnemy(e.id);
    obj.ct.visible = true;
    _updateEnemyObj(e, obj, dt, pulse, bossGlow);
  });
  _enemyPool.forEach((obj, id) => { if (!seen.has(id)) obj.ct.visible = false; });
}

// ── other players ─────────────────────────────────────────

function _getOtherPlayer(sid) {
  if (_otherPool.has(sid)) return _otherPool.get(sid);
  const ct  = new PIXI.Container();
  const spr = new PIXI.Sprite(PIXI.Texture.WHITE);
  spr.visible = false;
  const gfx = new PIXI.Graphics();
  const lbl = new PIXI.Text('', { fontFamily: 'system-ui,Arial', fontSize: 10, fontWeight: 'bold', fill: '#ffffff', stroke: '#000', strokeThickness: 3 });
  lbl.anchor.set(0.5, 1);
  // Clan row: icon sprite + name in a Container so they center as a group
  const clanCt  = new PIXI.Container();
  const iconSpr = new PIXI.Sprite(PIXI.Texture.EMPTY);
  iconSpr.width = 12; iconSpr.height = 12;
  iconSpr.anchor.set(0, 0.5);
  const clanLbl = new PIXI.Text('', { fontFamily: 'system-ui,Arial', fontSize: 10, fontWeight: 'bold', fill: '#f93', stroke: '#000', strokeThickness: 3 });
  clanLbl.anchor.set(0, 0.5);
  clanLbl.x = 14; // icon 12 + gap 2
  clanCt.addChild(iconSpr, clanLbl);
  clanCt.visible = false;
  ct.addChild(spr, gfx, lbl, clanCt);
  _otherPCt.addChild(ct);
  const obj = { ct, spr, gfx, lbl, clanCt, clanLbl, iconSpr };
  _otherPool.set(sid, obj);
  return obj;
}

function _updateOtherPlayers(pulse) {
  const seen = new Set();
  otherPlayers.forEach((p, pid) => {
    if (p.x == null || isNaN(p.x) || !_isOnScreen(p.x, p.y)) return;
    seen.add(pid);
    const obj = _getOtherPlayer(pid);
    const { ct, spr, gfx } = obj;
    ct.visible = true;
    ct.x = p.x; ct.y = p.y;
    gfx.clear();

    // Selection ring
    if (pid === targetId && targetIsPlayer) {
      gfx.lineStyle(2.5, 0xff5050, 0.65 + 0.35 * pulse);
      gfx.drawCircle(0, 0, 22 + pulse * 3);
      gfx.lineStyle(0);
    }

    // Swing arc
    if ((p._swingTimer||0) > 0) {
      const sa = p._swingAngle || 0;
      gfx.lineStyle(2.5, 0xc8dcff, 0.65);
      gfx.arc(0, 0, 30, sa - 0.65, sa + 0.65);
      gfx.lineStyle(0);
    }

    // Sprite
    const key      = getOtherPlayerAnimKey(p);
    const textures = _playerTextures(p.type, key);
    const def      = SPRITE_DEF[p.type];
    let usedSprite = false;
    if (textures && def) {
      const ad = def.anims[key];
      const fi = Math.min(Math.floor(p.animFrame || 0), (ad?.n || 1) - 1);
      spr.texture = textures[fi] || PIXI.Texture.WHITE;
      const cache = spriteCache[p.type];
      const img   = cache?.[key];
      const fw    = img?.frameW || def.frameW || 64;
      const fh    = img?.frameH || def.frameH || 64;
      const dh = 68, dw = dh * fw / fh;
      spr.width = dw; spr.height = dh;
      spr.x = -dw / 2; spr.y = -dh * 0.62;
      spr.visible = true;
      usedSprite = true;
    } else {
      spr.visible = false;
      const fc = parseInt((CHAR_DEF[p.type]?.color || '#aaaaaa').replace('#',''), 16);
      gfx.beginFill(fc); gfx.drawCircle(0, 0, 14); gfx.endFill();
    }

    // Status overlays
    if ((p.slowTimer||0) > 0) { gfx.beginFill(0x44aaff, 0.28); gfx.drawCircle(0,0,18); gfx.endFill(); }
    if ((p.stunTimer||0) > 0) { gfx.beginFill(0xffff88, 0.35); gfx.drawCircle(0,0,18); gfx.endFill(); }

    // HP bar
    const barTop = usedSprite ? -39 : -20;
    const bw = 38, bh = 4;
    gfx.beginFill(0x330000); gfx.drawRect(-bw/2, barTop, bw, bh); gfx.endFill();
    gfx.beginFill(0x22dd22); gfx.drawRect(-bw/2, barTop, bw * Math.max(0,(p.hp||0)/(p.maxHp||1)), bh); gfx.endFill();

    // Player name
    const { lbl, clanCt, clanLbl, iconSpr } = obj;
    const uname = (p.username || '?').slice(0, 16);
    if (lbl.text !== uname) lbl.text = uname;
    lbl.style.fill = p.pvpMode ? '#ff9999' : '#ffffff';
    lbl.x = 0;
    lbl.y = barTop - 3;

    // Clan row: icon + name, centered as a group above the player name
    const cname = p.clanName || '';
    if (cname) {
      if (clanLbl.text !== cname) clanLbl.text = cname;
      iconSpr.texture = _getClanIconTex(p.clanIcon || 1);
      clanCt.visible = true;
      clanCt.y = lbl.y - 14;
      clanCt.x = -clanCt.width / 2; // center icon+text group over player
    } else {
      clanCt.visible = false;
    }
  });
  _otherPool.forEach((obj, id) => { if (!seen.has(id)) obj.ct.visible = false; });
}

// ── player ────────────────────────────────────────────────

function _initPlayer() {
  if (_plSpr) return;
  _plSpr = new PIXI.Sprite(PIXI.Texture.WHITE);
  _plSpr.visible = false;
  _plGfx = new PIXI.Graphics();
  _playerCt.addChild(_plSpr, _plGfx);
}

function _updatePlayer(dt) {
  _initPlayer();
  if (!player || (state !== 'playing' && state !== 'dead')) {
    _playerCt.visible = false;
    return;
  }
  _playerCt.visible = true;
  _playerCt.alpha   = invisTimer > 0 ? 0.35 : 1;
  _plGfx.clear();

  // Shadow ellipse
  _plGfx.beginFill(0x000000, 0.4);
  _plGfx.drawEllipse(player.x, player.y + 14, 11, 4);
  _plGfx.endFill();

  const key      = getSpriteAnimKey(player);
  const textures = _playerTextures(player.type, key);
  const def      = SPRITE_DEF[player.type];
  let usedSprite = false;
  if (textures && def) {
    const ad = def.anims[key];
    const fi = Math.min(Math.floor(player.animFrame), (ad?.n || 1) - 1);
    _plSpr.texture = textures[fi] || PIXI.Texture.WHITE;
    const cache = spriteCache[player.type];
    const img   = cache?.[key];
    const fw    = img?.frameW || def.frameW || 64;
    const fh    = img?.frameH || def.frameH || 64;
    const dh = 68, dw = dh * fw / fh;
    _plSpr.width = dw; _plSpr.height = dh;
    _plSpr.x = player.x - dw / 2;
    _plSpr.y = player.y - dh * 0.62;
    _plSpr.tint    = (player.hurtTimer > 0) ? 0xff4444 : 0xffffff;
    _plSpr.visible = true;
    usedSprite = true;
  } else {
    _plSpr.visible = false;
    const hurt = player.hurtTimer > 0;
    const fc   = parseInt((player.charDef?.color || '#888888').replace('#',''), 16);
    _plGfx.beginFill(hurt ? 0xff4444 : fc);
    _plGfx.drawCircle(player.x, player.y, 14);
    _plGfx.endFill();
    _plGfx.lineStyle(2, 0xffffff, 0.4);
    _plGfx.drawCircle(player.x, player.y, 14);
    _plGfx.lineStyle(0);
  }

  // Swing arc
  if (swingTimer > 0) {
    _plGfx.lineStyle(3, 0xc8dcff, 0.75);
    _plGfx.arc(player.x, player.y, 34, swingAngle - 0.7, swingAngle + 0.7);
    _plGfx.lineStyle(0);
  }

  // HP bar
  const barTop = usedSprite ? player.y - 39 : player.y - 28;
  const bw = 44, bh = 4, bx = player.x - bw / 2;
  const hpPct = Math.max(0, Math.min(1, player.hp / player.maxHp));
  _plGfx.beginFill(0x1e0000, 0.75); _plGfx.drawRect(bx, barTop, bw, bh); _plGfx.endFill();
  if (hpPct > 0) {
    const bc = hpPct > 0.5 ? 0x2ecc71 : hpPct > 0.25 ? 0xf39c12 : 0xe74c3c;
    _plGfx.beginFill(bc); _plGfx.drawRect(bx, barTop, bw * hpPct, bh); _plGfx.endFill();
  }

  _lastPlayerUsedSprite = usedSprite;
}

// ── main render entry ─────────────────────────────────────

function pixiWorldRender(dt, ts, camX, camY, theme) {
  if (!_pixiApp) return;

  const bgCol = theme ? theme.bg : '#060610';
  if (bgCol !== _lastBgColor) { pixiSetBg(bgCol); _lastBgColor = bgCol; }
  _worldCt.visible = true;
  _worldCt.x = -camX * ZOOM;
  _worldCt.y = HEADER_H - camY * ZOOM;

  const pulse    = 0.5 + 0.5 * Math.sin(ts * 0.009);
  const bossGlow = 0.6 + 0.4 * Math.sin(ts * 0.006);

  _updateTiles(camX, camY);
  _updateSafeZone();
  _updateAoeRings();
  _updateNpcs(ts);
  _updateDrops(ts);
  _updateParticles();
  _updateEnemies(dt, pulse, bossGlow);
  _updateOtherPlayers(pulse);
  _updateProjs();
  _updatePlayer(dt);
  _updateDmgNums();

  _pixiApp.renderer.render(_pixiApp.stage);
}
