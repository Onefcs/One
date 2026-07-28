const { TILE, WALL, FLOOR, ENEMY_DEF, FLOOR_ENEMIES, roomStrengthMult, ARM_NAMES, ROOMS_PER_ARM } = require('../../shared/definitions');

function seededRng(seed) {
  let s = seed >>> 0;
  return function() {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Open world: one hub room + 4 corridors of ROOMS_PER_ARM rooms each ──────
// Layout is a "plus" shape: a big central hub (spawn, NPCs, safe zone) with a
// straight chain of rooms extending left/top/bottom/right from it, connected
// by L-shaped corridors exactly like the old per-floor room chain did. Each
// arm is its own monster "zone": global room level = arm's base (0/20/40/60)
// + position-in-arm (1..ROOMS_PER_ARM), reusing one FLOOR_ENEMIES pool per
// arm (arm index 1-4 standing in for the old floor 1-4 themes) so enemy
// stats/gold/xp tuning carries over unchanged. The last room of each arm is
// that arm's boss room.
const HUB = 30;          // hub room size (tiles) — big enough for 3 NPCs + 4 doors
const SMALL = 9;          // 9×9 → 5 monsters
const LARGE = 14;         // 14×14 → 10 monsters
const CELL = 24;          // tile pitch per room slot along an arm
const CW = 1;             // corridor half-width (3 tiles wide total)
const MARGIN = 6;         // outer wall padding
const DOOR_STUB = 3;      // door gap depth carved into the hub's wall

const ARM_LEN = ROOMS_PER_ARM * CELL;
const DW = MARGIN * 2 + ARM_LEN * 2 + HUB;
const DH = DW;

function generateOpenWorld() {
  const rng = seededRng(2026 * 1337 + 777);
  const grid = Array.from({ length: DH }, () => new Array(DW).fill(WALL));

  function inBounds(gx, gy) { return gx >= 0 && gx < DW && gy >= 0 && gy < DH; }
  function paintFloor(gx, gy) { if (inBounds(gx, gy)) grid[gy][gx] = FLOOR; }

  const hubX0 = MARGIN + ARM_LEN, hubY0 = MARGIN + ARM_LEN;
  const hub = {
    x: hubX0, y: hubY0, size: HUB,
    bx1: hubX0 - 1, by1: hubY0 - 1, bx2: hubX0 + HUB + 1, by2: hubY0 + HUB + 1,
    cx: hubX0 + Math.floor(HUB / 2), cy: hubY0 + Math.floor(HUB / 2),
    isHub: true,
  };
  for (let gy = hub.y; gy < hub.y + hub.size; gy++)
    for (let gx = hub.x; gx < hub.x + hub.size; gx++)
      paintFloor(gx, gy);

  // Generic L-shaped 3-wide corridor between two centers (same algorithm the
  // old per-floor generator used to chain its 20 rooms).
  function carveCorridor(ax, ay, bx, by) {
    let cx = ax, cy = ay;
    while (cx !== bx) {
      for (let d = -CW; d <= CW; d++) paintFloor(cx, cy + d);
      cx += bx > cx ? 1 : -1;
    }
    while (cy !== by) {
      for (let d = -CW; d <= CW; d++) paintFloor(cx + d, cy);
      cy += by > cy ? 1 : -1;
    }
  }

  // Carves a narrow door gap in the hub's wall facing `dir`. Returns both:
  // - render: the point right at the hub's wall (where the door sprite goes)
  // - route: the stub's outer end (where the first corridor segment starts
  //   stepping from, so the L-shaped corridor doesn't cut through the stub)
  function carveHubDoor(dir) {
    if (dir === 'left') {
      const ty = hub.cy, tx0 = hub.x - DOOR_STUB;
      for (let s = 0; s < DOOR_STUB; s++) { paintFloor(tx0 + s, ty); paintFloor(tx0 + s, ty + 1); }
      return { render: { x: hub.x - 1, y: ty }, route: { x: tx0, y: ty } };
    }
    if (dir === 'right') {
      const ty = hub.cy, tx0 = hub.x + hub.size;
      for (let s = 0; s < DOOR_STUB; s++) { paintFloor(tx0 + s, ty); paintFloor(tx0 + s, ty + 1); }
      return { render: { x: tx0, y: ty }, route: { x: tx0 + DOOR_STUB - 1, y: ty } };
    }
    if (dir === 'top') {
      const tx = hub.cx, ty0 = hub.y - DOOR_STUB;
      for (let s = 0; s < DOOR_STUB; s++) { paintFloor(tx, ty0 + s); paintFloor(tx + 1, ty0 + s); }
      return { render: { x: tx, y: hub.y - 1 }, route: { x: tx, y: ty0 } };
    }
    // bottom
    const tx = hub.cx, ty0 = hub.y + hub.size;
    for (let s = 0; s < DOOR_STUB; s++) { paintFloor(tx, ty0 + s); paintFloor(tx + 1, ty0 + s); }
    return { render: { x: tx, y: ty0 }, route: { x: tx, y: ty0 + DOOR_STUB - 1 } };
  }

  const doors = {
    left:   carveHubDoor('left'),
    top:    carveHubDoor('top'),
    bottom: carveHubDoor('bottom'),
    right:  carveHubDoor('right'),
  };

  const rooms = [hub];
  const enemyList = [];
  let eid = 0;
  const _enemyByEid = new Map(ENEMY_DEF.map(e => [e.eid, e]));

  function buildArm(dir, armIdx) {
    const horizontal = dir === 'left' || dir === 'right';
    const sign = (dir === 'left' || dir === 'top') ? -1 : 1;
    const sc    = 1 + (armIdx - 1) * 0.28;
    const atkSc = 1 + (armIdx - 1) * 0.18;
    const fe = FLOOR_ENEMIES[armIdx];
    function pickEnemy(isBoss) {
      const id = isBoss ? fe.boss : fe.pool[Math.floor(rng() * fe.pool.length)];
      return _enemyByEid.get(id);
    }

    let prevCx = doors[dir].route.x, prevCy = doors[dir].route.y;
    for (let i = 1; i <= ROOMS_PER_ARM; i++) {
      const isBoss = i === ROOMS_PER_ARM;
      const size = isBoss ? LARGE : (rng() < 0.5 ? SMALL : LARGE);

      // Slot k=0 is nearest the hub; each slot is CELL tiles deep along the
      // arm's axis and CELL tiles wide across it (room jitters within).
      const k = i - 1;
      const alongMin = k * CELL, alongMax = alongMin + CELL;
      const maxOfsAlong = Math.max(1, CELL - size - 2);
      const ofsAlong = 1 + Math.floor(rng() * maxOfsAlong);
      // Across-axis jitter centered on the hub's centerline
      const acrossSpan = Math.max(1, CELL - size);
      const ofsAcross = Math.floor(rng() * acrossSpan) - Math.floor(acrossSpan / 2);

      let x, y;
      if (horizontal) {
        const alongStart = sign > 0 ? (hub.x + hub.size + alongMin) : (hub.x - alongMax);
        x = alongStart + ofsAlong;
        y = hub.cy - Math.floor(size / 2) + ofsAcross;
      } else {
        const alongStart = sign > 0 ? (hub.y + hub.size + alongMin) : (hub.y - alongMax);
        y = alongStart + ofsAlong;
        x = hub.cx - Math.floor(size / 2) + ofsAcross;
      }

      const cx = x + Math.floor(size / 2), cy = y + Math.floor(size / 2);
      const room = {
        x, y, size,
        bx1: x - 1, by1: y - 1, bx2: x + size + 1, by2: y + size + 1,
        cx, cy, isSmall: size === SMALL,
        arm: dir, localLvl: i, monsterLvl: (armIdx - 1) * ROOMS_PER_ARM + i, isBoss,
      };
      rooms.push(room);

      for (let gy = y; gy < y + size; gy++)
        for (let gx = x; gx < x + size; gx++)
          paintFloor(gx, gy);
      carveCorridor(prevCx, prevCy, cx, cy);
      prevCx = cx; prevCy = cy;

      const rMult = isBoss ? 1 : roomStrengthMult(i);
      const count = isBoss ? 1 : (room.isSmall ? 5 : 10);
      const weakMult = isBoss ? 1 : 0.5;

      for (let n = 0; n < count; n++) {
        const d = pickEnemy(isBoss);
        if (!d) continue;
        let ex = cx * TILE + TILE / 2, ey = cy * TILE + TILE / 2;
        for (let attempt = 0; attempt < 40; attempt++) {
          const gx = x + 1 + Math.floor(rng() * Math.max(1, size - 2));
          const gy = y + 1 + Math.floor(rng() * Math.max(1, size - 2));
          if (inBounds(gx, gy) && grid[gy][gx] === FLOOR) { ex = gx * TILE + TILE / 2; ey = gy * TILE + TILE / 2; break; }
        }
        enemyList.push({
          id: `e_${dir}_${eid++}`, ...d, isBoss, arm: dir,
          rlvl: room.monsterLvl,
          maxHp: Math.floor(d.hp * sc * weakMult * rMult), hp: Math.floor(d.hp * sc * weakMult * rMult),
          atk: Math.floor(d.atk * atkSc * weakMult * rMult),
          x: ex, y: ey, spawnX: ex, spawnY: ey,
          atkTimer: 1 + rng(), aggro: false, aggroR: 175 + rng() * 55,
        });
      }
    }
  }

  ARM_NAMES.forEach((dir, i) => buildArm(dir, i + 1));

  return {
    grid, rooms, w: DW, h: DH,
    spawn: { x: hub.cx * TILE + TILE / 2, y: hub.cy * TILE + TILE / 2 },
    safeZone: { x1: hub.bx1 * TILE, y1: hub.by1 * TILE, x2: hub.bx2 * TILE, y2: hub.by2 * TILE },
    spawnDoors: ARM_NAMES.map(dir => ({ tx: doors[dir].render.x, ty: doors[dir].render.y, dir })),
    enemies: enemyList,
  };
}

module.exports = { generateOpenWorld, TILE, WALL, FLOOR };
