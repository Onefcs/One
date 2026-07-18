function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }
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
