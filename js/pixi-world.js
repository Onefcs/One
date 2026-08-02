// ── pixi-world.js — PixiJS WebGL world renderer ────────────────────────────
// Replaces Canvas 2D world drawing; HUD stays on _uiOverlay (2D canvas).

const _isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

let _pixiApp = null;
let _worldCt  = null;   // Container — camera transform applied here
let _tileCt   = null;
let _lightsGfx = null;  // torch flames + warm glow (Graphics, additive blend, cleared each frame)
let _aoeGfx   = null;   // AOE rings (Graphics, cleared each frame)
let _npcCt    = null;   // NPC bodies (Container — pooled per-npc sprite+gfx)
let _npcNames = [];      // PIXI.Text per NPC
let _dropGfx  = null;
let _partGfx  = null;   // particles (Graphics, cleared each frame)
let _enemyCt  = null;
let _otherPCt = null;
let _projGfx  = null;
let _playerCt = null;
let _plAura = null;
let _dmgNumCt = null;
let _petCt = null; // equipped-pet follower (local player only, see _updatePet)

// Entity sprite pools
const _enemyPool  = new Map(); // id  → {ct, spr, gfx}
const _otherPool  = new Map(); // sid → {ct, spr, gfx}
const _npcPool    = new Map(); // npc.id → {ct, spr, gfx}

// Player rendering objects
let _plSpr = null, _plGfx = null;

// Equipped-pet follower rendering objects + trailing-follow simulation state
let _petSpr = null, _petGfx = null;
let _petState = null;       // { x, y, facing, moving } — world-space, eased toward a point behind the player
let _petLoadedFor = null;   // petId whose sheets loadPetSprites() has been asked to fetch

// Damage-number pool
const _dmgActive = [];
const _dmgPool   = [];

// Chunk sprite cache — separate from _tileChunks canvas cache
const _chunkSprCache = new Map(); // "cx,cy" → PIXI.Sprite

// Texture caches
const _pTex = {};          // charType|animKey → PIXI.Texture[]
const _eTex = {};          // eid|sheetKey     → {down,up,left,right}: PIXI.Texture[]
const _npcTex = {};        // npc icon id      → PIXI.Texture[]
const _petTex = {};        // petId|animKey    → PIXI.Texture[]

let _lastBgColor = null; // dirty flag — bg color only changes on floor switch

// ── init ──────────────────────────────────────────────────
function pixiInit(canvasEl) {
  _pixiApp = new PIXI.Application({
    view: canvasEl,
    width:  canvasEl.clientWidth  || 375,
    height: canvasEl.clientHeight || 667,
    resolution: Math.min(window.devicePixelRatio || 1, _isMobile ? 1.0 : 1.5),
    autoDensity: true,
    backgroundAlpha: 1,
    antialias: false,
    powerPreference: _isMobile ? 'default' : 'high-performance',
  });
  _pixiApp.stop(); // manual render call

  _worldCt  = new PIXI.Container();
  _tileCt   = new PIXI.Container();
  _lightsGfx = new PIXI.Graphics();
  _lightsGfx.blendMode = PIXI.BLEND_MODES.ADD;
  _aoeGfx   = new PIXI.Graphics();
  _npcCt    = new PIXI.Container();
  _dropGfx  = new PIXI.Graphics();
  _partGfx  = new PIXI.Graphics();
  _enemyCt  = new PIXI.Container();
  _otherPCt = new PIXI.Container();
  _projGfx  = new PIXI.Graphics();
  _playerCt = new PIXI.Container();
  _petCt    = new PIXI.Container();
  _dmgNumCt = new PIXI.Container();

  _worldCt.addChild(
    _tileCt, _lightsGfx, _aoeGfx,
    _npcCt, _dropGfx, _partGfx,
    _enemyCt, _otherPCt, _projGfx,
    _petCt, _playerCt, _dmgNumCt
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

// Enemies/other-players are only bulk-freed on floor/raid change (above). Within
// a single floor visit, mobs die and respawn with new ids and other players
// enter/leave your AOI continuously — without this, their pooled Container is
// never destroyed, so _enemyPool/_otherPool grow for as long as the floor visit
// lasts and the per-frame visibility sweep (_updateEnemies/_updateOtherPlayers)
// keeps iterating that ever-growing history instead of just what's on screen.
// The growth tracks play time and exploration, so it reads as "gets janky the
// longer/more I move around" rather than a fixed cost.
function pixiRemoveEnemy(id) {
  const obj = _enemyPool.get(id);
  if (!obj) return;
  obj.ct.destroy({ children: true });
  _enemyPool.delete(id);
}
function pixiRemoveOtherPlayer(sid) {
  const obj = _otherPool.get(sid);
  if (!obj) return;
  obj.ct.destroy({ children: true });
  _otherPool.delete(sid);
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

function _petTextures(petId, animKey) {
  const k = petId + '|' + animKey;
  if (_petTex[k]) return _petTex[k];
  const def   = PET_SPRITE_DEF[petId];
  const cache = petSpriteCache[petId];
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
  return (_petTex[k] = arr);
}

// img is only ever a raw <img> while its network load/decode is still in
// flight (enemySpriteCache[eid][sheetKey] flips to a rasterized <canvas>
// once ready, see loadEnemySprites/js/sprites.js) — naturalWidth is
// undefined on a canvas but a number on an <img>, same check _playerTextures
// uses. Building a texture straight off the raw Image (as this used to)
// skipped that rasterize step entirely, so PIXI.BaseTexture.from() paid a
// real GPU upload (~5ms avg, spiking 30-40ms — see profiling notes) off a
// full-size sheet the very first time a new species/animation was seen.
function _enemyTextures(eid, sheetKey) {
  const k = eid + '|' + sheetKey;
  if (_eTex[k]) return _eTex[k];
  const def   = ENEMY_SPRITE_DEF[eid];
  const cache = enemySpriteCache[eid];
  if (!def || !cache) return null;
  const img = cache[sheetKey];
  if (!img || img.naturalWidth !== undefined) return null; // not yet rasterized
  const sh = def.sheets[sheetKey];
  const fw = img.frameW, fh = img.frameH; // rasterized cell size, not the source sheet's
  const bt = PIXI.BaseTexture.from(img);
  bt.scaleMode = PIXI.SCALE_MODES.LINEAR;
  const rows = {};
  for (const [facing, ri] of Object.entries(ENEMY_FACING_ROW)) {
    rows[facing] = [];
    for (let c = 0; c < sh.cols; c++)
      rows[facing].push(new PIXI.Texture(bt, new PIXI.Rectangle(c * fw, ri * fh, fw, fh)));
  }
  return (_eTex[k] = rows);
}

function _npcTextures(id) {
  if (_npcTex[id]) return _npcTex[id];
  const def = NPC_SPRITE_DEF[id];
  const img = npcSpriteCache[id];
  if (!def || !img || img.naturalWidth !== undefined) return null; // not yet rasterized
  const fw = img.frameW, fh = img.frameH;
  const bt = PIXI.BaseTexture.from(img);
  bt.scaleMode = PIXI.SCALE_MODES.LINEAR;
  const arr = [];
  for (let c = 0; c < def.cols; c++)
    arr.push(new PIXI.Texture(bt, new PIXI.Rectangle(c * fw, 0, fw, fh)));
  return (_npcTex[id] = arr);
}

// ── tiles ─────────────────────────────────────────────────

// Visibility is tracked with a generation stamp on each sprite rather than a
// fresh Set every frame — avoids one GC-pressuring allocation per render on
// mobile, where collection pauses show up as visible hitches.
let _tileVisGen = 0;
// Building a chunk (_buildChunk: 5-6 full passes over its tiles — wall fill,
// floor, cliff caps, two shadow passes, props) plus the GPU texture upload
// from PIXI.Texture.from() is real synchronous work per chunk. Revealing a
// whole viewport of never-seen chunks at once — floor entry, a dash, a
// teleport — used to build all of them (up to ~12 on a typical viewport) in
// a single frame: a real, reproducible hitch every time it happened. Capping
// how many NEW chunks build per frame spreads that burst across a handful of
// frames instead — a brief progressive pop-in rather than one big freeze.
// Already-built chunks are unaffected, this only throttles first-time builds.
const _CHUNK_BUILD_BUDGET = 2;
// Profiling (see PR discussion) found _buildChunk's own canvas drawing is
// cheap (~0.6ms avg) but PIXI.Texture.from()'s GPU upload is not (~5ms avg,
// spikes over 30ms) — and until now a chunk's build+upload only ever started
// the exact frame the camera reached it, i.e. zero lead time while running.
// _CHUNK_LOOKAHEAD extends the range of chunks considered for building (NOT
// the range marked visible, see the cx/cy bounds check below) by this many
// whole chunk-widths in whichever direction the player is currently moving.
// Because c0x/c1x are chunk INDICES (not the viewport edge's exact world
// position), a lookahead of only 1 chunk index can, depending on where the
// viewport edge sits inside its current chunk, buy anywhere from almost a
// full chunk-width of lead down to almost none — so this is 2, guaranteeing
// at least one full chunk-width (~320 world px, ~2s at normal move speed) of
// lead in the worst-case alignment. That's comfortably inside
// _CHUNK_BUILD_BUDGET's 2-per-frame throttle, so the expensive GPU texture
// upload has already happened well before the chunk actually scrolls into
// view instead of landing in the same frame the player needed it rendered.
const _CHUNK_LOOKAHEAD = 2;
function _updateTiles(camX, camY) {
  if (!dungeon || !dungeon.grid) return;
  const maxCx = Math.ceil(dungeon.w * TILE / _CHUNK_PX) - 1;
  const maxCy = Math.ceil(dungeon.h * TILE / _CHUNK_PX) - 1;
  const c0x = Math.max(0, Math.floor(camX / _CHUNK_PX));
  const c0y = Math.max(0, Math.floor(camY / _CHUNK_PX));
  const c1x = Math.min(maxCx, Math.floor((camX + W / ZOOM) / _CHUNK_PX));
  const c1y = Math.min(maxCy, Math.floor((camY + (H - HEADER_H) / ZOOM) / _CHUNK_PX));

  const dir = (typeof inputDir === 'function') ? inputDir() : null;
  const bx0 = (dir && dir.dx < -0.15) ? Math.max(0, c0x - _CHUNK_LOOKAHEAD) : c0x;
  const bx1 = (dir && dir.dx >  0.15) ? Math.min(maxCx, c1x + _CHUNK_LOOKAHEAD) : c1x;
  const by0 = (dir && dir.dy < -0.15) ? Math.max(0, c0y - _CHUNK_LOOKAHEAD) : c0y;
  const by1 = (dir && dir.dy >  0.15) ? Math.min(maxCy, c1y + _CHUNK_LOOKAHEAD) : c1y;

  const gen = ++_tileVisGen;
  let _built = 0;
  _visibleTorches.length = 0;
  for (let cy = by0; cy <= by1; cy++) {
    for (let cx = bx0; cx <= bx1; cx++) {
      const key = cx + ',' + cy;
      let spr = _chunkSprCache.get(key);
      if (!spr) {
        if (_built >= _CHUNK_BUILD_BUDGET) continue; // picked up next frame(s)
        _built++;
        let cv = _tileChunks.get(key);
        if (!cv) {
          cv = _buildChunk(cx, cy);
          if (_tileChunks.size >= _CHUNK_MAX) _tileChunks.delete(_tileChunks.keys().next().value);
          _tileChunks.set(key, cv);
        }
        const tex = PIXI.Texture.from(cv);
        spr = new PIXI.Sprite(tex);
        spr.x = cx * _CHUNK_PX - _CHUNK_G;
        spr.y = cy * _CHUNK_PX - _CHUNK_G;
        _tileCt.addChild(spr);
        _chunkSprCache.set(key, spr);
      }
      // Only chunks truly inside the viewport get marked visible this frame —
      // lookahead chunks outside c0x/c1x/c0y/c1y stay built (upload cost
      // already paid) but hidden until the camera actually reaches them.
      if (cx >= c0x && cx <= c1x && cy >= c0y && cy <= c1y) {
        spr._visGen = gen;
        const torches = _chunkTorches.get(key);
        if (torches) for (let i = 0; i < torches.length; i++) _visibleTorches.push(torches[i]);
      }
    }
  }
  _chunkSprCache.forEach(spr => { spr.visible = spr._visGen === gen; });
}

// ── torch light + ambient dust ───────────────────────────────
// Torches: the iron bracket is baked flat into the chunk texture (see
// _buildChunk); only the flame flicker + its warm glow pooling onto the
// floor are live, driven off the anchor points _updateTiles collected for
// whichever chunks are actually on screen this frame.
const _visibleTorches = [];

function _updateLights(ts) {
  _lightsGfx.clear();
  // Devices the adaptive tier already flagged as struggling (sustained
  // <20fps, see _drawPerf in game.js) skip the big soft falloff circle —
  // it's the widest fill here and large translucent circles are exactly
  // what tends to be fill-rate-bound on low-end mobile GPUs — and drop the
  // dimmest of the two glow rings entirely, keeping just the flame + one
  // tight glow so torches still read as lit without the extra overdraw.
  const lite = (typeof _qualityTier !== 'undefined' && _qualityTier > 0);
  for (let i = 0; i < _visibleTorches.length; i++) {
    const t = _visibleTorches[i];
    const flick = 0.8 + 0.15 * Math.sin(ts * 0.006 + t.x * 0.11) + 0.08 * Math.sin(ts * 0.023 + t.y * 0.05);
    const fx = t.x + Math.sin(ts * 0.014 + t.x) * 1.2;
    const fy = t.y - 2 + Math.sin(ts * 0.02 + t.y) * 1;
    if (!lite) {
      _lightsGfx.beginFill(0xff9d3c, 0.05 * flick); _lightsGfx.drawCircle(t.x, t.y + 10, 60 * flick); _lightsGfx.endFill();
    }
    _lightsGfx.beginFill(0xffb85c, 0.09 * flick); _lightsGfx.drawCircle(t.x, t.y + 10, 32 * flick); _lightsGfx.endFill();
    _lightsGfx.beginFill(0xff8a2e, 0.75); _lightsGfx.drawCircle(fx, fy + 2, 5 * flick); _lightsGfx.endFill();
    _lightsGfx.beginFill(0xffe6a8, 0.9); _lightsGfx.drawCircle(fx, fy, 3.2 * flick); _lightsGfx.endFill();
  }
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

const _NPC_DISPLAY_H = 74; // world px — square frames, so width == height

function _getNpcObj(id) {
  if (_npcPool.has(id)) return _npcPool.get(id);
  const ct  = new PIXI.Container();
  const gfx = new PIXI.Graphics();
  const spr = new PIXI.Sprite(PIXI.Texture.WHITE);
  spr.visible = false;
  ct.addChild(gfx, spr);
  _npcCt.addChild(ct);
  const obj = { ct, gfx, spr };
  _npcPool.set(id, obj);
  return obj;
}

function _updateNpcs(dt, ts) {
  if (!npcs || !npcs.length) return;
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
  const bounce = Math.sin(ts * 0.009) * 3;
  for (let i = 0; i < npcs.length; i++) {
    const n = npcs[i], t = _npcNames[i];
    const onScreen = n.x >= _vL && n.x <= _vR && n.y >= _vT && n.y <= _vB;
    t.visible = onScreen;
    const obj = _getNpcObj(n.id);
    obj.ct.visible = onScreen;
    if (!onScreen) continue;
    obj.ct.x = n.x; obj.ct.y = n.y;
    const { gfx, spr } = obj;
    gfx.clear();
    const col = parseInt((n.color || '#7b5ea7').replace('#', ''), 16);

    // Sprite (lazy-load on first encounter, matches enemy loading pattern)
    if (!npcSpriteCache[n.icon]) loadNpcSprites(n.icon);
    const def      = NPC_SPRITE_DEF[n.icon];
    const textures = def ? _npcTextures(n.icon) : null;

    // Sprite top/bottom in local space — the shadow and label are derived
    // from this so they line up with the character instead of the small
    // fixed-radius token they were sized for before sprites existed.
    const spriteTop    = -_NPC_DISPLAY_H * 0.55;
    const spriteBottom = spriteTop + _NPC_DISPLAY_H;

    // Shadow at the feet
    gfx.beginFill(0x000000, 0.3);
    gfx.drawEllipse(0, textures ? spriteBottom - 6 : 18, 14, 5);
    gfx.endFill();

    if (textures && def) {
      if (n._animTimer === undefined) { n._animFrame = 0; n._animTimer = 0; }
      n._animTimer += dt;
      const fd = 1 / def.fps;
      while (n._animTimer >= fd) {
        n._animTimer -= fd;
        n._animFrame = (n._animFrame + 1) % def.cols;
      }
      spr.texture = textures[n._animFrame] || textures[0];
      spr.width  = _NPC_DISPLAY_H;
      spr.height = _NPC_DISPLAY_H;
      spr.x = -_NPC_DISPLAY_H * 0.5;
      spr.y = spriteTop;
      spr.visible = true;
    } else {
      // Circle fallback while the sheet is still loading
      spr.visible = false;
      gfx.beginFill(col);
      gfx.drawCircle(0, 0, 18);
      gfx.endFill();
    }

    t.x = n.x; t.y = n.y + (textures ? spriteTop + 8 : -26);

    if (nearNpc && nearNpc.id === n.id) {
      // chat bubble indicator
      const bubbleY = (textures ? spriteTop - 20 : -44) + bounce;
      gfx.beginFill(0xffffff, 0.85);
      gfx.drawRoundedRect(-8, bubbleY, 16, 13, 3);
      gfx.endFill();
    }
  }
}

// ── drops ─────────────────────────────────────────────────

function _updateDrops(ts) {
  _dropGfx.clear();
  _drawWorldDrops(ts);
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

// Event-boss ground loot (js/state.js worldDrops). Drawn as rarity-tinted
// gems on the same graphics layer as ordinary drops, with a soft halo so a
// field of 60+ piles reads clearly against the floor tiles.
const _WD_RARITY_HEX = {
  common: 0x9aa0a6, uncommon: 0x6fc46f, rare: 0x5aa8e6, epic: 0xb06fe0, legendary: 0xe0a24a,
};
function _drawWorldDrops(ts) {
  if (!worldDrops || !worldDrops.size) return;
  const s = Math.sin(ts * 0.0054);
  const bob = s * 3;
  const a = 0.85 + 0.15 * s;
  worldDrops.forEach(d => {
    const col = _WD_RARITY_HEX[d.item && d.item.rarity] || 0xc4a276;
    const y = d.y + bob;
    _dropGfx.beginFill(col, a * 0.18);
    _dropGfx.drawCircle(d.x, y, 17);
    _dropGfx.endFill();
    _dropGfx.beginFill(col, a * 0.9);
    _dropGfx.drawRoundedRect(d.x - 9, y - 9, 18, 18, 4);
    _dropGfx.endFill();
    _dropGfx.lineStyle(1.5, 0xffffff, a * 0.55);
    _dropGfx.drawRoundedRect(d.x - 9, y - 9, 18, 18, 4);
    _dropGfx.lineStyle(0);
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
  const lbl = new PIXI.Text('', { fontFamily: 'system-ui,Arial', fontWeight: 'bold', fontSize: 14, fill: '#e8e8e8', stroke: '#000', strokeThickness: 4, align: 'center' });
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

  const isSelected = e.id === targetId && !targetIsPlayer;

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
  }

  const hurt    = (e.hurtTimer||0)  > 0;
  const slowed  = (e.slowTimer||0)  > 0;
  const stunned = (e.stunTimer||0)  > 0;
  const dead    = e.hp <= 0;
  const isBossAlive = e.isBoss && !dead;

  // The selection ring and boss glow pulse every frame (sin-based), so those
  // force a rebuild while active. Everything else here — HP bar, status
  // tints — only changes when the underlying state changes, so
  // gfx.clear()+redraw (CPU tessellation + a fresh GPU buffer upload) is
  // skipped unless something actually moved. Previously this ran unconditionally
  // for every visible enemy every frame, a cost that scaled with enemy count
  // (crowded rooms, raids) even when nothing on screen was changing.
  const needsRedraw = isSelected || isBossAlive ||
    obj._gfxSelected  !== isSelected ||
    obj._gfxHurt     !== hurt ||
    obj._gfxSlowed    !== slowed ||
    obj._gfxStunned   !== stunned ||
    obj._gfxDead       !== dead ||
    obj._gfxHp          !== e.hp ||
    obj._gfxMaxHp         !== e.maxHp;

  if (!needsRedraw) return;

  gfx.clear();
  obj._gfxSelected = isSelected;

  // Selection ring
  if (isSelected) {
    gfx.lineStyle(2.5, 0xff3c3c, 0.65 + 0.35 * pulse);
    gfx.drawCircle(0, 0, e.size + 8 + pulse * 3);
    gfx.lineStyle(0);
  }

  // Status overlays
  if (slowed)  { gfx.beginFill(0x44aaff, 0.28); gfx.drawCircle(0,0,e.size); gfx.endFill(); }
  if (stunned) { gfx.beginFill(0xffff88, 0.35); gfx.drawCircle(0,0,e.size); gfx.endFill(); }

  obj._gfxHurt     = hurt;
  obj._gfxSlowed    = slowed;
  obj._gfxStunned   = stunned;
  obj._gfxDead       = dead;
  obj._gfxHp          = e.hp;
  obj._gfxMaxHp         = e.maxHp;

  if (dead) return; // no bars for corpse

  // HP bar
  const bw  = Math.round(ds * 0.7 * 0.85);
  const bh  = 5;
  const bx  = -bw / 2;
  const by  = -ds * 0.55 - 8;
  gfx.beginFill(0x440000); gfx.drawRect(bx, by, bw, bh); gfx.endFill();
  const pct = e.hp / e.maxHp;
  const bc  = pct > 0.5 ? 0x22dd22 : pct > 0.25 ? 0xddaa22 : 0xdd2222;
  gfx.beginFill(bc); gfx.drawRect(bx, by, bw * pct, bh); gfx.endFill();

  if (isBossAlive) {
    gfx.lineStyle(3, 0xff3232, bossGlow);
    gfx.drawCircle(0, 0, e.size + 5);
    gfx.lineStyle(0);
  }

  // Name / boss label above HP bar — level on its own line above the name
  const { lbl } = obj;
  const lvlLine  = e.rlvl > 0 ? `Уровень ${e.rlvl}\n` : '';
  const nameLine = e.isBoss ? `⚠ БОСС · ${e.name || ''}` : `${e.name || ''}`;
  const lblText  = lvlLine + nameLine;
  if (lbl.text !== lblText) lbl.text = lblText;
  lbl.style.fill         = e.isBoss ? '#ff9999' : '#e8e8e8';
  lbl.style.fontSize     = e.isBoss ? 18 : 14;
  lbl.style.strokeThickness = e.isBoss ? 5 : 4;
  lbl.x = 0;
  lbl.y = by - 4;
}

let _enemyVisGen = 0;
function _updateEnemies(dt, pulse, bossGlow) {
  _visEnm = 0;
  const gen = ++_enemyVisGen;
  serverEnemies.forEach(e => {
    if (!_isOnScreen(e.x, e.y)) return;
    // Lazy-load sprites on first encounter (mirrors old drawEnemySprite behaviour)
    if (!enemySpriteCache[e.eid]) loadEnemySprites(e.eid);
    _visEnm++;
    const obj = _getEnemy(e.id);
    obj.ct.visible = true;
    obj._visGen = gen;
    _updateEnemyObj(e, obj, dt, pulse, bossGlow);
  });
  _enemyPool.forEach(obj => { if (obj._visGen !== gen) obj.ct.visible = false; });
}

// Base sprite display height for the local player and other players (world
// px, before each class's own def.dispScale) — ×1.1 over the original 68.
const _PLAYER_DISPLAY_H = 68 * 1.1;

// ── other players ─────────────────────────────────────────

// Username + clan tag for other players are drawn on the 2D UI overlay
// (see _drawOtherPlayerNamesOnUI in game.js), not here — a WebGL PIXI.Text
// gets rasterized once and then scaled by the world container's ZOOM factor,
// which blurs it, and re-centering it every frame from live text metrics is
// what caused the jitter. The overlay draws text at native screen resolution
// every frame, exactly like the local player's own name/clan tag already do.
// ── rating-leader aura ────────────────────────────────────
// The #1 player in the rating (server/index.js _refreshTopPlayer tells every
// client who that is) is wrapped in a golden aura so they're recognisable on
// sight. Drawn on its own Graphics UNDER the sprite, so it reads as light
// around the character rather than paint on top of them.
//
// Everything here is flat Graphics — the strict CSP this game ships under
// rules out loading a glow texture, so the soft falloff is faked with a few
// stacked translucent ellipses, cheapest-first. Only ever one player wears
// this, so the per-frame redraw it forces costs one Graphics rebuild.
function isTopPlayer(username) {
  const top = window._topPlayer;
  return !!top && !!username && username === top;
}

function _drawTopAura(g, cx, cy, ts) {
  const t     = ts * 0.001;
  const pulse = 0.5 + 0.5 * Math.sin(t * 2.2);
  const gy    = cy + 6;                       // ground contact, just below the feet

  // Ground pool: widest and faintest first, so the overlaps build a falloff.
  // Many thin layers rather than few thick ones — at three or four the steps
  // between them read as visible rings instead of as light.
  for (let i = 10; i >= 1; i--) {
    const r = 6 + i * 2.9 + pulse * 2;
    g.beginFill(0xffc63c, 0.020 + 0.013 * (11 - i));
    g.drawEllipse(cx, gy, r, r * 0.42);
    g.endFill();
  }
  // Body halo — vertical, so the character stands inside the light rather
  // than on top of a lit patch.
  for (let i = 7; i >= 1; i--) {
    g.beginFill(0xffd76a, 0.013 + 0.009 * (8 - i));
    g.drawEllipse(cx, cy - 12, 12 + i * 2.6, 20 + i * 3.6);
    g.endFill();
  }
  // Bright core where the light meets the floor.
  g.beginFill(0xfff3cf, 0.10 + 0.06 * pulse);
  g.drawEllipse(cx, gy, 11, 4.6);
  g.endFill();
  // Rim of the pool.
  const rr = 25 + pulse * 2.5;
  g.lineStyle(2, 0xffe9a8, 0.40 + 0.25 * pulse);
  g.drawEllipse(cx, gy, rr, rr * 0.42);
  g.lineStyle(0);
  // Rays sweeping around the rim, at two speeds so the motion isn't a rigid
  // spin. These are what read as "radiant" rather than just "lit".
  for (let i = 0; i < 8; i++) {
    const a  = t * 0.7 + (i * Math.PI * 2) / 8;
    const r1 = 30 + 5 * Math.sin(t * 3 + i);
    g.lineStyle(2, 0xffd76a, 0.16 + 0.16 * pulse);
    g.moveTo(cx + Math.cos(a) * 13, gy + Math.sin(a) * 13 * 0.42);
    g.lineTo(cx + Math.cos(a) * r1, gy + Math.sin(a) * r1 * 0.42);
  }
  g.lineStyle(0);
  // Motes drifting upward around the body.
  for (let i = 0; i < 5; i++) {
    const a  = t * 1.1 + (i * Math.PI * 2) / 5;
    const ry = ((t * 22 + i * 15) % 46);
    g.beginFill(0xfff0c0, 0.5 * (1 - ry / 46));
    g.drawCircle(cx + Math.cos(a) * 17, gy - ry, 1.7);
    g.endFill();
  }
}

function _getOtherPlayer(sid) {
  if (_otherPool.has(sid)) return _otherPool.get(sid);
  const ct   = new PIXI.Container();
  const aura = new PIXI.Graphics();
  const spr  = new PIXI.Sprite(PIXI.Texture.WHITE);
  spr.visible = false;
  const gfx = new PIXI.Graphics();
  ct.addChild(aura, spr, gfx);
  _otherPCt.addChild(ct);
  const obj = { ct, spr, gfx, aura };
  _otherPool.set(sid, obj);
  return obj;
}

let _otherVisGen = 0;
function _updateOtherPlayers(pulse, ts) {
  const gen = ++_otherVisGen;
  otherPlayers.forEach((p, pid) => {
    if (p.x == null || isNaN(p.x) || !_isOnScreen(p.x, p.y)) return;
    const obj = _getOtherPlayer(pid);
    obj._visGen = gen;
    const { ct, spr, gfx, aura } = obj;
    ct.visible = true;
    ct.x = p.x; ct.y = p.y;

    // Rating leader's aura. Animated, so unlike the gfx layer below it can't
    // sit behind the needsRedraw guard — but it only ever runs for one player.
    // Drawn in container-local space, hence 0,0.
    const isTop = isTopPlayer(p.username);
    if (isTop) {
      aura.clear();
      _drawTopAura(aura, 0, 0, ts);
      aura.visible = true;
    } else if (obj._auraOn) {
      aura.clear();
      aura.visible = false;
    }
    obj._auraOn = isTop;

    const isSelected = pid === targetId && targetIsPlayer;
    const swinging = (p._swingTimer || 0) > 0;

    // Sprite — always updated, the texture/frame changes with the walk/idle
    // animation every frame regardless of whether the Graphics layer redraws.
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
      const dh = _PLAYER_DISPLAY_H * (def.dispScale || 1), dw = dh * fw / fh;
      spr.width = dw; spr.height = dh;
      spr.x = -dw / 2; spr.y = -dh * 0.62;
      spr.visible = true;
      usedSprite = true;
    } else {
      spr.visible = false;
    }

    // Read every frame by the 2D name/clan overlay — cheap, independent of gfx.
    const barTop = usedSprite ? -39 : -20;
    p._nameBarTop = barTop;

    const slowed  = (p.slowTimer||0) > 0;
    const stunned = (p.stunTimer||0) > 0;
    const hp = p.hp || 0, maxHp = p.maxHp || 1;

    // Selection ring pulses continuously while active, so it forces a redraw
    // every frame it's on. Everything else (swing arc, HP bar, status tints,
    // fallback circle) is state-driven, not animated — skip the Graphics
    // rebuild (CPU tessellation + GPU buffer upload) unless the underlying
    // state actually changed. Previously this ran unconditionally for every
    // visible other player every frame, a cost that scaled with player count
    // (raids, crowded floors) even while everyone stood still.
    const needsRedraw = isSelected ||
      obj._gfxSelected   !== isSelected ||
      obj._gfxSwinging   !== swinging ||
      obj._gfxUsedSprite !== usedSprite ||
      obj._gfxSlowed      !== slowed ||
      obj._gfxStunned      !== stunned ||
      obj._gfxHp             !== hp ||
      obj._gfxMaxHp            !== maxHp;

    if (!needsRedraw) return;

    gfx.clear();
    obj._gfxSelected = isSelected;

    if (isSelected) {
      gfx.lineStyle(2.5, 0xff5050, 0.65 + 0.35 * pulse);
      gfx.drawCircle(0, 0, 22 + pulse * 3);
      gfx.lineStyle(0);
    }

    if (swinging) {
      const sa = p._swingAngle || 0;
      gfx.lineStyle(2.5, 0xc8dcff, 0.65);
      gfx.arc(0, 0, 30, sa - 0.65, sa + 0.65);
      gfx.lineStyle(0);
    }

    if (!usedSprite) {
      const fc = parseInt((CHAR_DEF[p.type]?.color || '#aaaaaa').replace('#',''), 16);
      gfx.beginFill(fc); gfx.drawCircle(0, 0, 14); gfx.endFill();
    }

    if (slowed)  { gfx.beginFill(0x44aaff, 0.28); gfx.drawCircle(0,0,18); gfx.endFill(); }
    if (stunned) { gfx.beginFill(0xffff88, 0.35); gfx.drawCircle(0,0,18); gfx.endFill(); }

    const bw = 38, bh = 4;
    gfx.beginFill(0x330000); gfx.drawRect(-bw/2, barTop, bw, bh); gfx.endFill();
    gfx.beginFill(0x22dd22); gfx.drawRect(-bw/2, barTop, bw * Math.max(0, hp/maxHp), bh); gfx.endFill();

    obj._gfxSwinging    = swinging;
    obj._gfxUsedSprite  = usedSprite;
    obj._gfxSlowed       = slowed;
    obj._gfxStunned       = stunned;
    obj._gfxHp              = hp;
    obj._gfxMaxHp             = maxHp;
  });
  _otherPool.forEach(obj => { if (obj._visGen !== gen) obj.ct.visible = false; });
}

// ── player ────────────────────────────────────────────────

function _initPlayer() {
  if (_plSpr) return;
  _plSpr = new PIXI.Sprite(PIXI.Texture.WHITE);
  _plSpr.visible = false;
  _plGfx  = new PIXI.Graphics();
  _plAura = new PIXI.Graphics();
  // Under the sprite, same as other players' aura layer.
  _playerCt.addChild(_plAura, _plSpr, _plGfx);
}

function _updatePlayer(dt, ts) {
  _initPlayer();
  if (!player || (state !== 'playing' && state !== 'dead')) {
    _playerCt.visible = false;
    return;
  }
  _playerCt.visible = true;
  _playerCt.alpha   = invisTimer > 0 ? 0.35 : 1;
  _plGfx.clear();

  // The leader sees their own aura too. netUsername is this client's own name,
  // the same value the rating table matches on.
  _plAura.clear();
  const _selfTop = isTopPlayer(typeof netUsername !== 'undefined' ? netUsername : null);
  _plAura.visible = _selfTop;
  if (_selfTop) _drawTopAura(_plAura, player.x, player.y, ts);

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
    const dh = _PLAYER_DISPLAY_H * (def.dispScale || 1), dw = dh * fw / fh;
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

// ── equipped pet (local player only — see the equip-slot 'pet' feature) ──
// Trails a point behind the player rather than sitting glued to player.x/y,
// so it visibly follows instead of teleporting; the chase speed is capped at
// player.speed (never faster) per the spec ("follows at the same speed as
// the character") — it only visibly keeps pace rather than closing the gap
// instantly, same as a real trailing companion would.
function _dirVecFromFacing(facing) {
  const idx = FACING8_DIRS.indexOf(facing);
  if (idx < 0) return [0, 1]; // default: front
  const rad = idx * 45 * Math.PI / 180;
  return [Math.cos(rad), Math.sin(rad)];
}
function _petFacing4(nx, ny) {
  return Math.abs(nx) > Math.abs(ny) ? (nx > 0 ? 'right' : 'left') : (ny > 0 ? 'front' : 'back');
}
const _PET_TRAIL_OFFSET = 24;  // world px behind the player the pet trails at
const _PET_SNAP_DIST    = 260; // floor change / respawn — snap instead of visibly sliding across the map

function _updatePet(dt) {
  const petItem = player && player.equipment ? player.equipment.pet : null;
  if (!_petCt) return;
  if (!player || (state !== 'playing' && state !== 'dead') || !petItem) {
    _petCt.visible = false;
    _petState = null;
    return;
  }

  const petId = petItem.id;
  if (_petLoadedFor !== petId) {
    _petLoadedFor = petId;
    if (typeof loadPetSprites === 'function') loadPetSprites(petId);
  }

  const [fx, fy] = _dirVecFromFacing(player.facing);
  const targetX = player.x - fx * _PET_TRAIL_OFFSET;
  const targetY = player.y - fy * _PET_TRAIL_OFFSET;

  if (!_petState) _petState = { x: targetX, y: targetY, facing: 'front', moving: false };

  const dx = targetX - _petState.x, dy = targetY - _petState.y;
  const dist = Math.hypot(dx, dy);
  if (dist > _PET_SNAP_DIST) {
    _petState.x = targetX; _petState.y = targetY;
    _petState.moving = false;
  } else if (dist > 0.5) {
    const step = Math.min(dist, (player.speed || 0) * dt);
    _petState.x += (dx / dist) * step;
    _petState.y += (dy / dist) * step;
    _petState.moving = step > 0.05;
    if (_petState.moving) _petState.facing = _petFacing4(dx / dist, dy / dist);
  } else {
    _petState.moving = false;
  }

  if (!_petSpr) {
    _petSpr = new PIXI.Sprite(PIXI.Texture.WHITE);
    _petSpr.visible = false;
    _petGfx = new PIXI.Graphics();
    _petCt.addChild(_petGfx, _petSpr);
  }
  _petCt.visible = true;

  _petGfx.clear();
  _petGfx.beginFill(0x000000, 0.25);
  _petGfx.drawEllipse(_petState.x, _petState.y + 3, 9, 3.5);
  _petGfx.endFill();

  const def = PET_SPRITE_DEF[petId];
  const key = `${_petState.facing}-${_petState.moving ? 'run' : 'idle'}`;
  const textures = _petTextures(petId, key);
  if (textures && def) {
    const ad = def.anims[key];
    if (_petState._animKey !== key) { _petState._animKey = key; _petState._animFrame = 0; _petState._animTimer = 0; }
    _petState._animTimer += dt;
    const step = 1 / ad.fps;
    while (_petState._animTimer >= step) {
      _petState._animTimer -= step;
      _petState._animFrame = ad.loop ? (_petState._animFrame + 1) % ad.n : Math.min(ad.n - 1, _petState._animFrame + 1);
    }
    const cache = petSpriteCache[petId];
    const img   = cache && cache[key];
    const fw    = img?.frameW || def.frameW;
    const fh    = img?.frameH || def.frameH;
    const dh = _PLAYER_DISPLAY_H / 3, dw = dh * fw / fh;
    _petSpr.texture = textures[_petState._animFrame] || PIXI.Texture.WHITE;
    _petSpr.width = dw; _petSpr.height = dh;
    _petSpr.x = _petState.x - dw / 2;
    _petSpr.y = _petState.y - dh * (def.anchorY != null ? def.anchorY : 0.7);
    _petSpr.visible = true;
  } else {
    _petSpr.visible = false;
  }
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
  _updateLights(ts);
  _updateAoeRings();
  _updateNpcs(dt, ts);
  _updateDrops(ts);
  _updateParticles();
  _updateEnemies(dt, pulse, bossGlow);
  _updateOtherPlayers(pulse, ts);
  _updateProjs();
  _updatePet(dt);
  _updatePlayer(dt, ts);
  _updateDmgNums();

  _pixiApp.renderer.render(_pixiApp.stage);
}
