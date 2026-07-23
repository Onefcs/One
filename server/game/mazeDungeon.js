// Party dungeon: a real branching maze (recursive-backtracker spanning tree
// over a cell grid), not the linear room-chain used by the normal 5 floors
// (server/game/dungeon.js). Monsters and boss both use floor-2 stats —
// computed with the exact same scaling formulas as generateDungeon() so
// numbers match what players already see on that floor. Returns the same
// {grid, rooms, w, h, spawn, safeZone, enemies} shape Room.js/the client
// renderer already expect, so nothing downstream needs to know this wasn't
// produced by generateDungeon().
const { TILE, WALL, FLOOR } = require('./dungeon');
const { ENEMY_DEF, FLOOR_ENEMIES } = require('../../shared/definitions');

function seededRng(seed) {
  let s = seed >>> 0;
  return function() {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COLS = 9, ROWS = 8;                 // 72 cells: 1 spawn + 1 boss + 70 regular
const CELL = 11;                          // tiles per cell
const DW = COLS * CELL, DH = ROWS * CELL; // 99 x 88
const ROOM_SIZE = 6;                      // regular room (tiles)
const SPAWN_SIZE = 9;
const BOSS_SIZE = 9;
const CW = 1;                             // corridor half-width (3 tiles wide)
const TOTAL_MOBS = 100;

function _key(col, row) { return col + ',' + row; }

// Recursive backtracker over the cell grid — produces a spanning tree
// (every cell reachable from every other cell by exactly one path), i.e. a
// real maze with dead ends and no loops.
function _buildMaze(rng) {
  const visited = Array.from({ length: ROWS }, () => new Array(COLS).fill(false));
  const edges = [];
  const start = { col: 0, row: Math.floor(ROWS / 2) };
  visited[start.row][start.col] = true;
  const stack = [start];
  const dirs = [{ dc: 1, dr: 0 }, { dc: -1, dr: 0 }, { dc: 0, dr: 1 }, { dc: 0, dr: -1 }];

  while (stack.length) {
    const cur = stack[stack.length - 1];
    const shuffled = dirs.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    let advanced = false;
    for (const d of shuffled) {
      const nc = cur.col + d.dc, nr = cur.row + d.dr;
      if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
      if (visited[nr][nc]) continue;
      visited[nr][nc] = true;
      edges.push({ a: { col: cur.col, row: cur.row }, b: { col: nc, row: nr } });
      stack.push({ col: nc, row: nr });
      advanced = true;
      break;
    }
    if (!advanced) stack.pop();
  }
  return { edges, start };
}

// BFS over the spanning tree to find the cell farthest (by path length) from
// spawn — that becomes the boss room, guaranteeing a real trek through the
// maze rather than a boss room that might land right next to spawn.
function _farthestCell(edges, start) {
  const adj = new Map();
  edges.forEach(({ a, b }) => {
    const ka = _key(a.col, a.row), kb = _key(b.col, b.row);
    if (!adj.has(ka)) adj.set(ka, []);
    if (!adj.has(kb)) adj.set(kb, []);
    adj.get(ka).push(kb);
    adj.get(kb).push(ka);
  });
  const dist = new Map([[_key(start.col, start.row), 0]]);
  const q = [start];
  let far = start, farD = 0;
  while (q.length) {
    const cur = q.shift();
    const kc = _key(cur.col, cur.row);
    const d = dist.get(kc);
    if (d > farD) { farD = d; far = cur; }
    (adj.get(kc) || []).forEach(nk => {
      if (!dist.has(nk)) {
        dist.set(nk, d + 1);
        const [c, r] = nk.split(',').map(Number);
        q.push({ col: c, row: r });
      }
    });
  }
  return far;
}

function generatePartyDungeon(seed) {
  const rng = seededRng((seed >>> 0) || (Date.now() & 0xffffffff));
  const grid = Array.from({ length: DH }, () => new Array(DW).fill(WALL));
  function inBounds(gx, gy) { return gx >= 0 && gx < DW && gy >= 0 && gy < DH; }
  function paintFloor(gx, gy) { if (inBounds(gx, gy)) grid[gy][gx] = FLOOR; }

  const { edges, start } = _buildMaze(rng);
  const bossCell = _farthestCell(edges, start);

  // Build a room for every cell in the grid (the backtracker always visits
  // every cell of a fully-connected rectangular grid, so this is exactly
  // COLS*ROWS rooms).
  const cellRoom = new Map(); // "col,row" -> room object
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const isSpawn = col === start.col && row === start.row;
      const isBossCell = col === bossCell.col && row === bossCell.row;
      const size = isSpawn ? SPAWN_SIZE : isBossCell ? BOSS_SIZE : ROOM_SIZE;
      const maxOfsX = CELL - size - 2, maxOfsY = CELL - size - 2;
      const ofsX = 1 + Math.floor(rng() * Math.max(1, maxOfsX));
      const ofsY = 1 + Math.floor(rng() * Math.max(1, maxOfsY));
      const x = col * CELL + ofsX, y = row * CELL + ofsY;
      const cx = x + Math.floor(size / 2), cy = y + Math.floor(size / 2);
      const room = {
        x, y, size,
        bx1: x - 1, by1: y - 1, bx2: x + size + 1, by2: y + size + 1,
        cx, cy,
        isSpawn, isBossRoom: isBossCell,
        isSmall: size === ROOM_SIZE,
      };
      cellRoom.set(_key(col, row), room);
    }
  }

  const rooms = Array.from(cellRoom.values());
  rooms.forEach(r => {
    for (let gy = r.y; gy < r.y + r.size; gy++)
      for (let gx = r.x; gx < r.x + r.size; gx++)
        paintFloor(gx, gy);
  });

  // Carve corridors along maze edges only (grid-adjacent cells) — this is
  // what makes it a real maze (dead ends, single path between any two
  // rooms) instead of the normal floors' linear room-chain.
  edges.forEach(({ a, b }) => {
    const ra = cellRoom.get(_key(a.col, a.row)), rb = cellRoom.get(_key(b.col, b.row));
    let cx = ra.cx, cy = ra.cy;
    const tx = rb.cx, ty = rb.cy;
    while (cx !== tx) {
      for (let d = -CW; d <= CW; d++) paintFloor(cx, cy + d);
      cx += tx > cx ? 1 : -1;
    }
    while (cy !== ty) {
      for (let d = -CW; d <= CW; d++) paintFloor(cx + d, cy);
      cy += ty > cy ? 1 : -1;
    }
  });

  // ── Enemies: monsters and boss both use floor-2 stats ───────────────────
  // Same scaling formulas as generateDungeon() (server/game/dungeon.js) so
  // numbers match what's already on those floors.
  const MOB_LVL = 2, BOSS_LVL = 2;
  const mobSc    = 1 + (MOB_LVL  - 1) * 0.28, mobAtkSc  = 1 + (MOB_LVL  - 1) * 0.18;
  const bossSc   = 1 + (BOSS_LVL - 1) * 0.28, bossAtkSc = 1 + (BOSS_LVL - 1) * 0.18;
  const mobWeakMult = 0.5; // matches the halving applied to all regular dungeon monsters

  const _enemyByEid = new Map(ENEMY_DEF.map(e => [e.eid, e]));
  const mobPool = FLOOR_ENEMIES[MOB_LVL].pool;
  const bossDef = _enemyByEid.get(FLOOR_ENEMIES[BOSS_LVL].boss);

  const enemyList = [];
  let eid = 0;
  function _placeInRoom(room) {
    let ex = room.cx * TILE + TILE / 2, ey = room.cy * TILE + TILE / 2;
    for (let attempt = 0; attempt < 40; attempt++) {
      const gx = room.x + 1 + Math.floor(rng() * (room.size - 2));
      const gy = room.y + 1 + Math.floor(rng() * (room.size - 2));
      if (inBounds(gx, gy) && grid[gy][gx] === FLOOR) { ex = gx * TILE + TILE / 2; ey = gy * TILE + TILE / 2; break; }
    }
    return { x: ex, y: ey };
  }

  const regularRooms = rooms.filter(r => !r.isSpawn && !r.isBossRoom);
  // Distribute exactly TOTAL_MOBS monsters across the regular rooms.
  const per = Math.floor(TOTAL_MOBS / regularRooms.length);
  let remainder = TOTAL_MOBS - per * regularRooms.length;
  const order = regularRooms.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  order.forEach((room, idx) => {
    const count = per + (idx < remainder ? 1 : 0);
    for (let i = 0; i < count; i++) {
      const d = _enemyByEid.get(mobPool[Math.floor(rng() * mobPool.length)]);
      if (!d) continue;
      const pos = _placeInRoom(room);
      enemyList.push({
        id: `pd_${eid++}`, ...d, isBoss: false,
        maxHp: Math.floor(d.hp * mobSc * mobWeakMult), hp: Math.floor(d.hp * mobSc * mobWeakMult),
        atk:   Math.floor(d.atk * mobAtkSc * mobWeakMult),
        x: pos.x, y: pos.y, spawnX: pos.x, spawnY: pos.y,
        atkTimer: 1 + rng(), aggro: false, aggroR: 175 + rng() * 55,
      });
    }
  });

  if (bossDef) {
    const bossRoom = cellRoom.get(_key(bossCell.col, bossCell.row));
    const pos = { x: bossRoom.cx * TILE + TILE / 2, y: bossRoom.cy * TILE + TILE / 2 };
    enemyList.push({
      id: `pd_${eid++}`, ...bossDef, isBoss: true,
      maxHp: Math.floor(bossDef.hp * bossSc), hp: Math.floor(bossDef.hp * bossSc),
      atk:   Math.floor(bossDef.atk * bossAtkSc),
      x: pos.x, y: pos.y, spawnX: pos.x, spawnY: pos.y,
      atkTimer: 1 + rng(), aggro: false, aggroR: 175 + rng() * 55,
    });
  }

  const spawnRoom = cellRoom.get(_key(start.col, start.row));
  return {
    grid, rooms, w: DW, h: DH,
    spawn: { x: spawnRoom.cx * TILE + TILE / 2, y: spawnRoom.cy * TILE + TILE / 2 },
    safeZone: {
      x1: spawnRoom.bx1 * TILE, y1: spawnRoom.by1 * TILE,
      x2: spawnRoom.bx2 * TILE, y2: spawnRoom.by2 * TILE,
    },
    enemies: enemyList,
  };
}

module.exports = { generatePartyDungeon, TILE, WALL, FLOOR };
