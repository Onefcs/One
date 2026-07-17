function dmgNum(x, y, text, color) {
  const t = String(text);
  dmgNums.push({ x, y, text: t, color, life: 1.1, vy: -52, fontSize: isNaN(t) ? 12 : 15 });
}

function spawnBurst(x, y, color, n) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = 60 + Math.random() * 120;
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, color, life: .7, size: 3 + Math.random() * 4 });
  }
}

function spawnAOE(x, y, r) {
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    particles.push({ x: x + Math.cos(a) * 18, y: y + Math.sin(a) * 18, vx: Math.cos(a) * 130, vy: Math.sin(a) * 130, color: '#f4f', life: .45, size: 5 });
  }
}
