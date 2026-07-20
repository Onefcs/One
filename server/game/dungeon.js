const { TILE, WALL, FLOOR, ENEMY_DEF, FLOOR_ENEMIES } = require('../../shared/definitions');

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
  const DW = 110, DH = 84;
  const grid = Array.from({ length: DH }, () => new Array(DW).fill(WALL));

  // 5 columns × 4 rows = 20 guaranteed rooms
  const COLS = 5, ROWS = 4;
  const CELL_W = Math.floor(DW / COLS);  // 22
  const CELL_H = Math.floor(DH / ROWS);  // 21
  const SMALL = 9;   // 9×9 → 5 monsters
  const LARGE = 14;  // 14×14 → 10 monsters

  function inBounds(gx, gy) { return gx >= 0 && gx < DW && gy >= 0 && gy < DH; }
  function paintFloor(gx, gy) { if (inBounds(gx, gy)) grid[gy][gx] = FLOOR; }

  // Shuffle cell order using Fisher-Yates so corridor path is random
  const cellOrder = [];
  for (let row = 0; row < ROWS; row++)
    for (let col = 0; col < COLS; col++)
      cellOrder.push({ col, row });
  for (let i = cellOrder.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [cellOrder[i], cellOrder[j]] = [cellOrder[j], cellOrder[i]];
  }

  const rooms = [];
  cellOrder.forEach((cell, idx) => {
    const isFirst = idx === 0;
    const isLast  = idx === cellOrder.length - 1;

    let size;
    if (isFirst) {
      size = SMALL;  // spawn room always small
    } else if (isLast) {
      size = LARGE;  // boss room always large
    } else {
      size = rng() < 0.5 ? SMALL : LARGE;
    }

    // Random offset within the cell, keeping 1-tile border from cell edges
    const maxOfsX = CELL_W - size - 2;
    const maxOfsY = CELL_H - size - 2;
    const ofsX = 1 + Math.floor(rng() * Math.max(1, maxOfsX));
    const ofsY = 1 + Math.floor(rng() * Math.max(1, maxOfsY));

    const x = cell.col * CELL_W + ofsX;
    const y = cell.row * CELL_H + ofsY;
    const cx = x + Math.floor(size / 2);
    const cy = y + Math.floor(size / 2);

    rooms.push({
      x, y, size,
      bx1: x - 1, by1: y - 1, bx2: x + size + 1, by2: y + size + 1,
      cx, cy,
      isSmall: size === SMALL,
    });
  });

  // Paint rooms
  rooms.forEach(r => {
    for (let gy = r.y; gy < r.y + r.size; gy++)
      for (let gx = r.x; gx < r.x + r.size; gx++)
        paintFloor(gx, gy);
  });

  // Connect rooms in sequence with L-shaped corridors (3 tiles wide)
  const CW = 1;
  for (let i = 1; i < rooms.length; i++) {
    const a = rooms[i - 1], b = rooms[i];
    let cx = a.cx, cy = a.cy;
    const tx = b.cx, ty = b.cy;
    while (cx !== tx) {
      for (let d = -CW; d <= CW; d++) paintFloor(cx, cy + d);
      cx += tx > cx ? 1 : -1;
    }
    while (cy !== ty) {
      for (let d = -CW; d <= CW; d++) paintFloor(cx + d, cy);
      cy += ty > cy ? 1 : -1;
    }
  }

  // Spawn enemies
  const sc = 1 + (lvl - 1) * 0.28;
  const enemyList = [];
  let eid = 0;

  const _enemyByEid = new Map(ENEMY_DEF.map(e => [e.eid, e]));
  function _pickEnemy(isBoss) {
    if (FLOOR_ENEMIES[lvl]) {
      const fe = FLOOR_ENEMIES[lvl];
      const id = isBoss ? fe.boss : fe.pool[Math.floor(rng() * fe.pool.length)];
      return _enemyByEid.get(id);
    }
    if (isBoss) return _enemyByEid.get('demon');
    return _enemyByEid.get(['orc', 'troll'][Math.floor(rng() * 2)]);
  }

  // rooms[0] = safe spawn, rooms[rooms.length-1] = boss
  rooms.slice(1).forEach((room, idx) => {
    const isBoss = idx === rooms.length - 2;
    const count  = isBoss ? 1 : (room.isSmall ? 5 : 10);

    for (let i = 0; i < count; i++) {
      const d = _pickEnemy(isBoss);
      if (!d) continue;

      let ex = room.cx * TILE + TILE / 2;
      let ey = room.cy * TILE + TILE / 2;
      for (let attempt = 0; attempt < 40; attempt++) {
        const gx = room.x + 1 + Math.floor(rng() * (room.size - 2));
        const gy = room.y + 1 + Math.floor(rng() * (room.size - 2));
        if (inBounds(gx, gy) && grid[gy][gx] === FLOOR) {
          ex = gx * TILE + TILE / 2;
          ey = gy * TILE + TILE / 2;
          break;
        }
      }

      enemyList.push({
        id: `e_${lvl}_${eid++}`,
        ...d,
        isBoss,
        maxHp: Math.floor(d.hp * sc), hp: Math.floor(d.hp * sc),
        atk:   Math.floor(d.atk * (1 + (lvl - 1) * 0.18)),
        x: ex, y: ey, spawnX: ex, spawnY: ey,
        atkTimer: 1 + rng(), aggro: false, aggroR: 175 + rng() * 55,
      });
    }
  });

  return {
    grid, rooms, w: DW, h: DH,
    spawn: {
      x: rooms[0].cx * TILE + TILE / 2,
      y: rooms[0].cy * TILE + TILE / 2,
    },
    safeZone: {
      x1: rooms[0].bx1 * TILE,
      y1: rooms[0].by1 * TILE,
      x2: rooms[0].bx2 * TILE,
      y2: rooms[0].by2 * TILE,
    },
    enemies: enemyList,
  };
}

module.exports = { generateDungeon, TILE, WALL, FLOOR };
