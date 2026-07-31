// ─────────────────────────────────────────────────────────
//  LOCATION THEMES — indices 1-4 match the open world's 4 corridor arms
//  (index = armIndexForLevel, see shared/definitions.js) and their rotating
//  monster cast: Крыса→Слизень→Бес (arm1), Зомби→Ящер→Орк (arm2),
//  Лоза→Вампир→Бехолдер (arm3), Древень→Демон (arm4) — see FLOOR_ENEMIES'
//  `bands`. The live world itself renders with a single theme
//  (getTheme(dungeonLvl), dungeonLvl is fixed at 1).
//  buildTileCanvas() in game.js handles all drawing.
// ─────────────────────────────────────────────────────────

// ── Tile textures (painted, tinted per-theme) ──────────────────────────────
// Ground/wall tiles are drawn procedurally now (see _buildChunk in game.js),
// so the only painted tile art left is the hub's spawn-door leaves.
// /images/* is served with a 30-day immutable cache — these files get
// overwritten in place as the art is iterated on, so a version query string
// is the only way a returning browser ever sees the new content instead of
// its stale cached copy. Bump this whenever door_left/door_right change.
const _TILE_TEX_V = 4;
const _TILE_TEX_DEF = {
  doorLeft:  'images/tiles/door_left.png',
  doorRight: 'images/tiles/door_right.png',
};
const _tileTexImg = {};
Object.keys(_TILE_TEX_DEF).forEach(key => {
  const img = new Image();
  img.src = _TILE_TEX_DEF[key] + '?v=' + _TILE_TEX_V;
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

// Draws one of the hub's 4 exit doors — a matched pair of tile-sized images
// (left leaf + right leaf) spanning the 2-tile gap the world generator
// leaves open in the hub's wall. tx/ty = the gap's first tile; dir is which
// wall it's in ('top'/'bottom' = horizontal gap, 2 tiles wide; 'left'/
// 'right' = vertical gap, 2 tiles tall — the leaf pair rotated 90° to match).
function drawSpawnDoor(c, tx, ty, tintColor, dir) {
  const left = _getTintedTileCanvas('doorLeft', tintColor);
  const right = _getTintedTileCanvas('doorRight', tintColor);
  if (dir === 'left' || dir === 'right') {
    if (left) {
      c.save();
      c.translate(tx * TILE + TILE / 2, ty * TILE + TILE / 2);
      c.rotate(-Math.PI / 2);
      c.drawImage(left, -TILE / 2, -TILE / 2, TILE, TILE);
      c.restore();
    }
    if (right) {
      c.save();
      c.translate(tx * TILE + TILE / 2, (ty + 1) * TILE + TILE / 2);
      c.rotate(-Math.PI / 2);
      c.drawImage(right, -TILE / 2, -TILE / 2, TILE, TILE);
      c.restore();
    }
    return;
  }
  if (left) c.drawImage(left, tx * TILE, ty * TILE, TILE, TILE);
  if (right) c.drawImage(right, (tx + 1) * TILE, ty * TILE, TILE, TILE);
}

// ── Themes ────────────────────────────────────────────────
const THEMES = [

  // Floor 1 — Костяной склеп (skeletons)
  {
    name: '💀 Костяной склеп', bg: '#0a0c10', mmFloor: '#6a7488',
    wallColor: '#3a4550', floorA: '#262c34', floorB: '#2d333c',
  },

  // Floor 2 — Логово гоблинов (goblins)
  {
    name: '🏹 Логово гоблинов', bg: '#0a1408', mmFloor: '#5a8a2e',
    wallColor: '#3d5a2e', floorA: '#33471f', floorB: '#3d5625',
  },

  // Floor 3 — Грибные пещеры (mushrooms)
  {
    name: '🍄 Грибные пещеры', bg: '#0a0814', mmFloor: '#6a4d8a',
    wallColor: '#3d3a5a', floorA: '#241f38', floorB: '#2b2542',
  },

  // Floor 4 — Обитель призраков (ghosts)
  {
    name: '👻 Обитель призраков', bg: '#0a0c16', mmFloor: '#7a7ab0',
    wallColor: '#4a4568', floorA: '#2c2c48', floorB: '#333356',
  },

  // Floor 5 — Крепость големов (golems)
  {
    name: '🗿 Крепость големов', bg: '#120c08', mmFloor: '#b07840',
    wallColor: '#6b4a35', floorA: '#3c2c20', floorB: '#453427',
  },
];

function getTheme(lvl) {
  return THEMES[Math.max(0, Math.min(lvl - 1, THEMES.length - 1))];
}
