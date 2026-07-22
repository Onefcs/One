function dmgNum(x, y, text, color, fontSize) {
  const t = String(text);
  dmgNums.push({ x, y, text: t, color, life: 1.1, vy: -52, fontSize: fontSize || (isNaN(t) ? 12 : 15) });
}

// Set when new particles arrive — render() sorts by color only then.
// Compaction of dead particles preserves order, so no re-sort is needed
// between spawns.
let _particlesDirty = false;

function spawnBurst(x, y, color, n) {
  const _space = 120 - particles.length;
  if (_space <= 0) return;
  n = Math.min(n, _space);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = 60 + Math.random() * 120;
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, color, life: .7, size: 3 + Math.random() * 4 });
  }
  _particlesDirty = true;
}

function spawnAOE(x, y, r) {
  aoeRings.push({ x, y, r: r || 50, life: 0.45, maxLife: 0.45 });
}
