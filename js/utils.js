function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }
const FACING8_DIRS = ['right', 'frontright', 'front', 'frontleft', 'left', 'backleft', 'back', 'backright'];
// Screen-space delta (dx>0 east/right, dy>0 south/front) → one of 8 facings,
// sector centers at 0°,45°,...,315° matching FACING8_DIRS order. `cur` is the
// previous facing; hysteresis keeps it unless the new angle has moved clearly
// past the current sector's edge, so tiny input jitter near a boundary doesn't
// flip facing (and restart the run animation) every frame.
function facing8FromDelta(dx, dy, cur) {
  if (!dx && !dy) return cur || 'front';
  let angle = Math.atan2(dy, dx) * 180 / Math.PI;
  if (angle < 0) angle += 360;
  const curIdx = FACING8_DIRS.indexOf(cur);
  if (curIdx >= 0) {
    let diff = Math.abs(angle - curIdx * 45);
    if (diff > 180) diff = 360 - diff;
    if (diff <= 28) return cur;
  }
  return FACING8_DIRS[Math.round(angle / 45) % 8];
}
function rnd(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
const _hasNativeRoundRect = typeof CanvasRenderingContext2D !== 'undefined' &&
  typeof CanvasRenderingContext2D.prototype.roundRect === 'function';

function roundRect(ctx, x, y, w, h, r) {
  if (_hasNativeRoundRect) {
    ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return;
  }
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r); ctx.closePath();
}

// Pointy-top/bottom hexagon inscribed in a 2r×2r box, centered at (cx,cy) —
// the Iron Fang skill/attack button shape (mirrors the CSS clip-path
// polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%) used in the design
// mockups this was built from).
function hexPath(ctx, cx, cy, r) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy - r * 0.5);
  ctx.lineTo(cx + r, cy + r * 0.5);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r, cy + r * 0.5);
  ctx.lineTo(cx - r, cy - r * 0.5);
  ctx.closePath();
}

// Rectangle with corners cut at 45° by `cut` px — the Iron Fang riveted-plate
// shape used for the rectangular HUD buttons (PvP, Профессия, Auto, party).
function cutRectPath(ctx, x, y, w, h, cut) {
  ctx.beginPath();
  ctx.moveTo(x + cut, y);
  ctx.lineTo(x + w - cut, y);
  ctx.lineTo(x + w, y + cut);
  ctx.lineTo(x + w, y + h - cut);
  ctx.lineTo(x + w - cut, y + h);
  ctx.lineTo(x + cut, y + h);
  ctx.lineTo(x, y + h - cut);
  ctx.lineTo(x, y + cut);
  ctx.closePath();
}
