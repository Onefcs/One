const { TILE, WALL, FLOOR, ENEMY_DEF } = require('../../shared/definitions');

// Mulberry32 — fast seeded PRNG. Same seed → same dungeon every time.
function seededRng(seed) {
  let s = seed >>> 0;
  return function() {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateDungeon(lvl) {
  const rng = seededRng(lvl * 1337 + 777);

  const DW = 96, DH = 72;
  const grid = Array.from({ length: DH }, () => new Array(DW).fill(WALL));
  const rooms = [];
  const wantRooms = Math.min(22 + Math.floor(lvl / 2), 38);

  let tries = 0;
  while (rooms.length < wantRooms && tries < 2000) {
    tries++;
    const rw = 10 + Math.floor(rng() * 14);   // 10-23 tiles wide (was 5-13)
    const rh =  6 + Math.floor(rng() * 8);    //  6-13 tiles tall (was 4-10)
    const rx = 1 + Math.floor(rng() * (DW - rw - 2));
    const ry = 1 + Math.floor(rng() * (DH - rh - 2));
    const ok = !rooms.some(r =>
      rx < r.x + r.w + 2 && rx + rw + 2 > r.x &&
      ry < r.y + r.h + 2 && ry + rh + 2 > r.y
    );
    if (ok) rooms.push({ x: rx, y: ry, w: rw, h: rh });
  }

  rooms.forEach(r => {
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++)
        grid[y][x] = FLOOR;
  });

  for (let i = 1; i < rooms.length; i++) {
    const a = rooms[i - 1], b = rooms[i];
    let cx = Math.floor(a.x + a.w / 2), cy = Math.floor(a.y + a.h / 2);
    const tx = Math.floor(b.x + b.w / 2), ty = Math.floor(b.y + b.h / 2);
    while (cx !== tx) { grid[cy][cx] = FLOOR; cx += tx > cx ? 1 : -1; }
    while (cy !== ty) { grid[cy][cx] = FLOOR; cy += ty > cy ? 1 : -1; }
  }

  const sc = 1 + (lvl - 1) * 0.28;
  const enemyList = [];
  let eid = 0;

  rooms.slice(1).forEach((room, idx) => {
    const isBoss = idx === rooms.length - 2;
    const count = isBoss ? 1 : 5 + Math.floor(rng() * (4 + Math.floor(lvl / 2)));
    for (let i = 0; i < count; i++) {
      const maxEIdx = Math.min(6, 1 + Math.floor(lvl / 2));
      const rawIdx  = Math.floor(rng() * (maxEIdx + 1));
      const defIdx  = isBoss ? 7 : (lvl === 1 ? 1 : rawIdx);
      const d = ENEMY_DEF[defIdx];
      const ex = (room.x + 1 + Math.floor(rng() * (room.w - 2))) * TILE + TILE / 2;
      const ey = (room.y + 1 + Math.floor(rng() * (room.h - 2))) * TILE + TILE / 2;
      enemyList.push({
        id: `e_${lvl}_${eid++}`,
        ...d,
        maxHp: Math.floor(d.hp * sc), hp: Math.floor(d.hp * sc),
        atk:   Math.floor(d.atk * (1 + (lvl - 1) * 0.18)),
        x: ex, y: ey,
        spawnX: ex, spawnY: ey,
        atkTimer: 1 + rng(),
        aggro: false, aggroR: 175 + rng() * 55,
      });
    }
  });

  return {
    grid, rooms, w: DW, h: DH,
    spawn: {
      x: Math.floor(rooms[0].x + rooms[0].w / 2) * TILE + TILE / 2,
      y: Math.floor(rooms[0].y + rooms[0].h / 2) * TILE + TILE / 2,
    },
    enemies: enemyList,
  };
}

module.exports = { generateDungeon, TILE, WALL, FLOOR };
