// ─────────────────────────────────────────────────────────
//  LOCATION THEMES  — one per floor (5 total, matching the 5 real
//  dungeon floors and their enemy identity: goblins / skeletons /
//  mushrooms / ghosts / golems).
//  buildTileCanvas() in game.js handles all drawing.
// ─────────────────────────────────────────────────────────

// ── Floor props (painted sprites, not procedural shapes) ──────────────────
// Source: a hand-painted top-down dungeon prop pack. Each entry's `w` is the
// world-px display width; height follows the source image's own aspect
// ratio so nothing looks squashed.
const PROP_DEF = {
  barrel_small:    { src: 'images/props/barrel_small.png',    w: 20 },
  barrel_large:    { src: 'images/props/barrel_large.png',    w: 28 },
  barrel_slime:    { src: 'images/props/barrel_slime.png',    w: 24 },
  crate_stack:     { src: 'images/props/crate_stack.png',     w: 26 },
  crate_single:    { src: 'images/props/crate_single.png',    w: 22 },
  chest_round:     { src: 'images/props/chest_round.png',     w: 26 },
  chest_banded:    { src: 'images/props/chest_banded.png',    w: 24 },
  treasure_small:  { src: 'images/props/treasure_small.png',  w: 30 },
  treasure_medium: { src: 'images/props/treasure_medium.png', w: 40 },
  treasure_large:  { src: 'images/props/treasure_large.png',  w: 46 },
  treasure_trophy: { src: 'images/props/treasure_trophy.png', w: 36 },
  trophy:          { src: 'images/props/trophy.png',          w: 18 },
  key_gold:        { src: 'images/props/key_gold.png',        w: 12 },
  gem_red:         { src: 'images/props/gem_red.png',         w: 8  },
  gem_gold:        { src: 'images/props/gem_gold.png',        w: 8  },
  gem_blue:        { src: 'images/props/gem_blue.png',        w: 8  },
  gem_green:       { src: 'images/props/gem_green.png',       w: 8  },
  gem_purple:      { src: 'images/props/gem_purple.png',      w: 8  },
  slime_small:     { src: 'images/props/slime_small.png',     w: 22 },
  slime_medium:    { src: 'images/props/slime_medium.png',    w: 30 },
  slime_large:     { src: 'images/props/slime_large.png',     w: 38 },
  stump:           { src: 'images/props/stump.png',           w: 20 },
  branch1:         { src: 'images/props/branch1.png',         w: 16 },
  branch2:         { src: 'images/props/branch2.png',         w: 16 },
  grave_marker:    { src: 'images/props/grave_marker.png',    w: 16 },
  signpost:        { src: 'images/props/signpost.png',        w: 22 },
  jug:             { src: 'images/props/jug.png',              w: 14 },
  trap_bear:       { src: 'images/props/trap_bear.png',       w: 20 },
  trap_spike:      { src: 'images/props/trap_spike.png',      w: 18 },
  spikes_row:      { src: 'images/props/spikes_row.png',      w: 34 },
  boulder:         { src: 'images/props/boulder.png',         w: 34 },
  pillar:          { src: 'images/props/pillar.png',          w: 28 },
  vine1:           { src: 'images/props/vine1.png',           w: 24 },
  vine2:           { src: 'images/props/vine2.png',           w: 24 },
  bush1:           { src: 'images/props/bush1.png',           w: 20 },
  bush2:           { src: 'images/props/bush2.png',           w: 18 },
};

// Start loading immediately (script parse time) — small, low-priority
// images, no reason to gate the character-select loading screen on them.
const _propImg = {};
Object.keys(PROP_DEF).forEach(key => {
  const img = new Image();
  img.src = PROP_DEF[key].src;
  _propImg[key] = img;
});

// Draws prop `key` with its ground-contact point at (x, groundY).
function drawProp(c, key, x, groundY) {
  const def = PROP_DEF[key];
  const img = _propImg[key];
  if (!def || !img || !img.complete || !img.naturalWidth) return;
  const w = def.w;
  const h = w * (img.naturalHeight / img.naturalWidth);
  c.drawImage(img, x - w / 2, groundY - h, w, h);
}

// Builds a drawFloorProp(c,px,py,h) for a theme from a short prop list —
// h % entries.length picks (at most) one entry per floor tile, so overall
// density is 1-in-N where N = the modulus, not the list length.
function _floorProps(mod, entries) {
  return function (c, px, py, h) {
    const idx = h % mod;
    if (idx >= entries.length) return;
    const e = entries[idx];
    drawProp(c, e.key, px + (e.dx ?? TILE / 2), py + (e.dy ?? TILE - 4));
  };
}

// ── Tile textures (painted, tiled + tinted per-theme) ──────────────────────
// Source: the same hand-painted dungeon tileset as the floor props. These are
// real seamless-ish photographic-style textures (grayscale stone/brick), not
// procedural fills — each theme recolors them via a canvas 'color' blend
// (keeps the painted shading, swaps hue/sat to the theme's own palette) so
// the 20 existing zone moods carry over without touching per-theme data.
const _TILE_TEX_DEF = {
  floor:    'images/tiles/floor.png',
  wallBody: 'images/tiles/wall_body.png',
  wallFaceA: 'images/tiles/wall_face_a.png',
  wallFaceB: 'images/tiles/wall_face_b.png',
  wallFaceC: 'images/tiles/wall_face_c.png',
};
const WALL_FACE_KEYS = ['wallFaceA', 'wallFaceB', 'wallFaceC'];
const _tileTexImg = {};
Object.keys(_TILE_TEX_DEF).forEach(key => {
  const img = new Image();
  img.src = _TILE_TEX_DEF[key];
  _tileTexImg[key] = img;
});

// theme.name + ':' + key -> tinted offscreen <canvas>, built once and reused
// as the source for cheap per-chunk createPattern() calls.
const _tintedTileCache = new Map();

function _getTintedTileCanvas(key, tintColor) {
  const cacheKey = key + ':' + tintColor;
  let cv = _tintedTileCache.get(cacheKey);
  if (cv) return cv;
  const img = _tileTexImg[key];
  if (!img || !img.complete || !img.naturalWidth) return null;
  cv = document.createElement('canvas');
  cv.width = img.naturalWidth; cv.height = img.naturalHeight;
  const oc = cv.getContext('2d');
  oc.drawImage(img, 0, 0);
  oc.globalCompositeOperation = 'color';
  oc.fillStyle = tintColor;
  oc.fillRect(0, 0, cv.width, cv.height);
  oc.globalCompositeOperation = 'destination-in';
  oc.drawImage(img, 0, 0);
  oc.globalCompositeOperation = 'source-over';
  _tintedTileCache.set(cacheKey, cv);
  return cv;
}

// Returns a repeating CanvasPattern for `key` tinted to `tintColor`, or null
// if the source image hasn't finished loading yet (caller should keep using
// its flat-color fallback fill until then).
function getTilePattern(ctx, key, tintColor) {
  const cv = _getTintedTileCanvas(key, tintColor);
  if (!cv) return null;
  return ctx.createPattern(cv, 'repeat');
}

// Returns the tinted offscreen <canvas> itself (for a plain drawImage per
// wall tile instead of a repeating pattern) — used for the full painted
// wall-face art, where each tile shows one whole (scaled-down) picture
// rather than a continuously-tiled texture.
function getTintedTexture(key, tintColor) {
  return _getTintedTileCanvas(key, tintColor);
}

// Picks one of the 3 wall-face art variants per tile (by hash) so a long
// wall doesn't visibly stamp the same picture over and over.
function getWallFaceKey(h) {
  return WALL_FACE_KEYS[h % WALL_FACE_KEYS.length];
}

// ── Themes ────────────────────────────────────────────────
const THEMES = [

  // Floor 1 — Логово гоблинов (goblins)
  {
    name: '🏹 Логово гоблинов', bg: '#0a1408', mmFloor: '#5a8a2e',
    wallColor: '#3d5a2e', floorA: '#33471f', floorB: '#3d5625',
    drawFloorProp: _floorProps(40, [{ key: 'stump' }, { key: 'branch1' }, { key: 'branch2' }, { key: 'bush1' }, { key: 'crate_single' }, { key: 'barrel_small' }]),
  },

  // Floor 2 — Костяной склеп (skeletons)
  {
    name: '💀 Костяной склеп', bg: '#0a0c10', mmFloor: '#6a7488',
    wallColor: '#3a4550', floorA: '#262c34', floorB: '#2d333c',
    drawFloorProp: _floorProps(40, [{ key: 'grave_marker' }, { key: 'chest_banded' }, { key: 'key_gold' }, { key: 'spikes_row' }]),
  },

  // Floor 3 — Грибные пещеры (mushrooms)
  {
    name: '🍄 Грибные пещеры', bg: '#0a0814', mmFloor: '#6a4d8a',
    wallColor: '#3d3a5a', floorA: '#241f38', floorB: '#2b2542',
    drawFloorProp: _floorProps(40, [{ key: 'slime_small' }, { key: 'slime_medium' }, { key: 'bush1' }, { key: 'barrel_slime' }]),
  },

  // Floor 4 — Обитель призраков (ghosts)
  {
    name: '👻 Обитель призраков', bg: '#0a0c16', mmFloor: '#7a7ab0',
    wallColor: '#4a4568', floorA: '#2c2c48', floorB: '#333356',
    drawFloorProp: _floorProps(40, [{ key: 'grave_marker' }, { key: 'chest_round' }, { key: 'treasure_medium' }, { key: 'spikes_row' }]),
  },

  // Floor 5 — Крепость големов (golems)
  {
    name: '🗿 Крепость големов', bg: '#120c08', mmFloor: '#b07840',
    wallColor: '#6b4a35', floorA: '#3c2c20', floorB: '#453427',
    drawFloorProp: _floorProps(40, [{ key: 'boulder' }, { key: 'crate_single' }, { key: 'treasure_large' }, { key: 'pillar' }]),
  },
];

function getTheme(lvl) {
  return THEMES[Math.max(0, Math.min(lvl - 1, THEMES.length - 1))];
}
