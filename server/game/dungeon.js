const { TILE, WALL, FLOOR, ENEMY_DEF } = require('../../shared/definitions');

function generateDungeon(lvl) {
  const DW = 72, DH = 56;
  const grid = Array.from({ length: DH }, () => new Array(DW).fill(WALL));
  const rooms = [];
  const wantRooms = Math.min(20 + Math.floor(lvl / 2), 35);
  let tries = 0;
  while (rooms.length < wantRooms && tries < 1400) {
    tries++;
    const rw = 5 + Math.floor(Math.random() * 9);
    const rh = 4 + Math.floor(Math.random() * 7);
    const rx = 1 + Math.floor(Math.random() * (DW - rw - 2));
    const ry = 1 + Math.floor(Math.random() * (DH - rh - 2));
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
    const count = isBoss ? 1 : 2 + Math.floor(Math.random() * (2 + Math.floor(lvl / 2)));
    for (let i = 0; i < count; i++) {
      const maxEIdx = Math.min(6, 1 + Math.floor(lvl / 2));
      const rawIdx = Math.floor(Math.random() * (maxEIdx + 1));
      // Floor 1 (Лес): always slime so sprites are visible from start
      const defIdx = isBoss ? 7 : (lvl === 1 ? 1 : rawIdx);
      const d = ENEMY_DEF[defIdx];
      const ex = (room.x + 1 + Math.floor(Math.random() * (room.w - 2))) * TILE + TILE / 2;
      const ey = (room.y + 1 + Math.floor(Math.random() * (room.h - 2))) * TILE + TILE / 2;
      enemyList.push({
        id: `e_${lvl}_${eid++}`,
        ...d,
        maxHp: Math.floor(d.hp * sc), hp: Math.floor(d.hp * sc),
        atk: Math.floor(d.atk * (1 + (lvl - 1) * 0.18)),
        x: ex, y: ey,
        spawnX: ex, spawnY: ey,
        atkTimer: 1 + Math.random(),
        aggro: false, aggroR: 175 + Math.random() * 55,
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
