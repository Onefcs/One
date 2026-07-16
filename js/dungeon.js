const floorCache = {};
let _eid = 1;

// Deterministic PRNG seeded per floor so every floor always looks the same
function _rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

function generateDungeon(lvl) {
  const r = _rng(lvl * 2654435761 + 1013904223);

  const DW = 100, DH = 78;
  const grid = Array.from({ length: DH }, () => new Array(DW).fill(WALL));
  const rooms = [];
  const wantRooms = Math.min(16 + Math.floor(lvl / 2), 26);
  let tries = 0;
  while (rooms.length < wantRooms && tries < 3000) {
    tries++;
    const rw = 16 + Math.floor(r() * 14);
    const rh = 12 + Math.floor(r() * 10);
    const rx = 1 + Math.floor(r() * (DW - rw - 2));
    const ry = 1 + Math.floor(r() * (DH - rh - 2));
    const ok = !rooms.some(room =>
      rx < room.x + room.w + 1 && rx + rw + 1 > room.x &&
      ry < room.y + room.h + 1 && ry + rh + 1 > room.y
    );
    if (ok) rooms.push({ x: rx, y: ry, w: rw, h: rh });
  }

  rooms.forEach(rm => {
    for (let y = rm.y; y < rm.y + rm.h; y++)
      for (let x = rm.x; x < rm.x + rm.w; x++)
        grid[y][x] = FLOOR;
  });

  // 2-tile-wide corridors
  for (let i = 1; i < rooms.length; i++) {
    const a = rooms[i - 1], b = rooms[i];
    let cx = Math.floor(a.x + a.w / 2), cy = Math.floor(a.y + a.h / 2);
    const tx = Math.floor(b.x + b.w / 2), ty = Math.floor(b.y + b.h / 2);
    while (cx !== tx) {
      grid[cy][cx] = FLOOR;
      if (cy + 1 < DH) grid[cy + 1][cx] = FLOOR;
      cx += tx > cx ? 1 : -1;
    }
    while (cy !== ty) {
      grid[cy][cx] = FLOOR;
      if (cx + 1 < DW) grid[cy][cx + 1] = FLOOR;
      cy += ty > cy ? 1 : -1;
    }
  }

  const sc = 1 + (lvl - 1) * 0.28;
  const enemyList = [];
  rooms.slice(1).forEach((room, idx) => {
    const isBoss = idx === rooms.length - 2;
    const count = isBoss ? 1 : 5 + Math.floor(r() * (5 + Math.floor(lvl / 2)));
    for (let i = 0; i < count; i++) {
      const maxEIdx = Math.min(6, 1 + Math.floor(lvl / 2));
      const defIdx = isBoss ? 7 : Math.floor(r() * (maxEIdx + 1));
      const d = ENEMY_DEF[defIdx];
      const ex = (room.x + 1 + Math.floor(r() * (room.w - 2))) * TILE + TILE / 2;
      const ey = (room.y + 1 + Math.floor(r() * (room.h - 2))) * TILE + TILE / 2;
      enemyList.push({
        ...d,
        id: _eid++,
        maxHp: Math.floor(d.hp * sc), hp: Math.floor(d.hp * sc),
        atk:   Math.floor(d.atk * (1 + (lvl - 1) * 0.18)),
        x: ex, y: ey,
        spawnX: ex, spawnY: ey,
        atkTimer: 1 + r(), hurtTimer: 0,
        aggro: false, aggroR: 175 + r() * 55,
      });
    }
  });

  return {
    grid, rooms,
    spawn: {
      x: Math.floor(rooms[0].x + rooms[0].w / 2) * TILE + TILE / 2,
      y: Math.floor(rooms[0].y + rooms[0].h / 2) * TILE + TILE / 2,
    },
    enemies: enemyList, w: DW, h: DH, wantRooms,
  };
}
