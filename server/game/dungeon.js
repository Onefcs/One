const { TILE, WALL, FLOOR, ENEMY_DEF, FLOOR_ENEMIES, bandForLocalLevel, monsterStatsAtLevel, monsterNameAtLevel, monsterColorAtLevel, xpAtLevel, goldAtLevel, ARM_NAMES, ARM_ROOM_PAIRS, ARM_OFFSETS, roomsInArm } = require('../../shared/definitions');

function seededRng(seed) {
  let s = seed >>> 0;
  return function() {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Open world: one hub room + 4 "comb" corridors ───────────────────────────
// Layout is a plus shape: a big central hub (spawn, NPCs, safe zone) with a
// dead-straight, always-empty main corridor running out to each side. Rooms
// never sit on that path — instead, at ARM_ROOM_PAIRS[armIdx-1] evenly spaced
// positions along it, a short branch forks off to EACH side. That branch
// doesn't stop at one room: it chains ROOM_CHAIN_LEN rooms in a row, each
// linked to the next by another short stub, so every position has
// ROOM_CHAIN_LEN rooms facing the corridor per side (2x that many per
// position) — all sharing the same monster level (more space/monsters per
// level, not more levels). The chain only extends OUTWARD (deeper into the
// hub's corner, away from the main corridor), so corridor length — and with
// it the level-gate positions and overall level count — is untouched; only
// the hub has to grow to keep neighboring arms' chains from ever reaching
// into each other (see HUB's comment below). The very last position's far
// side is the sole exception: that slot stays a single, un-chained boss room
// (chainLen 1) — the "one boss per arm" design is preserved. Arms can have
// different lengths (see ARM_ROOM_PAIRS in shared/definitions.js), so the
// world's overall size is sized to fit the longest one. Global room level =
// arm's base (ARM_OFFSETS[armIdx-1]) + position-in-arm (1..roomsInArm, 2
// levels per corridor position), reusing one FLOOR_ENEMIES pool per arm (arm
// index 1-4 standing in for the old floor 1-4 themes) so enemy stats/gold/xp
// tuning carries over unchanged.
const HUB = 140;          // hub room size (tiles) — big enough for 3 NPCs + 4 doors
                          // and to keep adjacent arms' room chains from ever
                          // reaching into each other's corner (needs
                          // HUB/2 >= CW + ROOM_CHAIN_LEN * (STUB + LARGE), see below)
const SMALL = 9;          // 9×9 → 5 monsters
const LARGE = 14;         // 14×14 → 10 monsters
const CW = 1;             // main corridor half-width (3 tiles wide total)
const BW = 1;             // branch corridor half-width (3 tiles wide total)
const STUB = 6;           // branch length between the main corridor / each chained room
const PITCH = 20;         // tile spacing between consecutive room-pair positions
const LEAD_IN = 12;       // distance from hub wall to the first position
const MARGIN = 6;         // outer wall padding
const DOOR_STUB = 3;      // door gap depth carved into the hub's wall
const ROOM_CHAIN_LEN = 3; // rooms chained per side per position (except the boss slot, always 1)

const MAX_ARM_PAIRS = Math.max(...ARM_ROOM_PAIRS); // longest arm sizes the world grid; shorter arms just end sooner
const ARM_LEN = LEAD_IN + (MAX_ARM_PAIRS - 1) * PITCH + Math.floor(PITCH / 2) + LARGE;
const DW = MARGIN * 2 + ARM_LEN * 2 + HUB;
const DH = DW;

function generateOpenWorld() {
  const rng = seededRng(2026 * 1337 + 777);
  const grid = Array.from({ length: DH }, () => new Array(DW).fill(WALL));

  function inBounds(gx, gy) { return gx >= 0 && gx < DW && gy >= 0 && gy < DH; }
  function paintFloor(gx, gy) { if (inBounds(gx, gy)) grid[gy][gx] = FLOOR; }
  function paintRect(x0, y0, x1, y1) {
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) paintFloor(gx, gy);
  }

  const hubX0 = MARGIN + ARM_LEN, hubY0 = MARGIN + ARM_LEN;
  const hub = {
    x: hubX0, y: hubY0, size: HUB,
    bx1: hubX0 - 1, by1: hubY0 - 1, bx2: hubX0 + HUB + 1, by2: hubY0 + HUB + 1,
    cx: hubX0 + Math.floor(HUB / 2), cy: hubY0 + Math.floor(HUB / 2),
    isHub: true,
  };
  paintRect(hub.x, hub.y, hub.x + hub.size - 1, hub.y + hub.size - 1);

  // Carves a narrow door gap in the hub's wall facing `dir`. Returns both:
  // - render: the point right at the hub's wall (where the door sprite goes)
  // - route: the stub's outer end (where the main corridor starts painting
  //   from, so the door stub reads as a distinct gap in solid wall)
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
  const corridorGates = [];
  let eid = 0;
  const _enemyByEid = new Map(ENEMY_DEF.map(e => [e.eid, e]));

  function buildArm(dir, armIdx) {
    const horizontal = dir === 'left' || dir === 'right';
    const sign = (dir === 'left' || dir === 'top') ? -1 : 1;
    const fe = FLOOR_ENEMIES[armIdx];
    const pairs = ARM_ROOM_PAIRS[armIdx - 1];
    const roomCount = roomsInArm(armIdx);
    const maxLocalLvl = roomCount - 1; // last room is the boss; ranks/colors ramp to this
    function pickEnemy(isBoss, localLvl) {
      if (isBoss) return _enemyByEid.get(fe.boss);
      const pool = bandForLocalLevel(fe, localLvl).pool;
      return _enemyByEid.get(pool[Math.floor(rng() * pool.length)]);
    }

    // Main corridor: one dead-straight, always-empty strip from the hub door
    // out to the last position (plus a little tail), 3 tiles wide.
    const route = doors[dir].route;
    const mainStart = horizontal ? route.x : route.y;
    const mainEnd = mainStart + sign * (LEAD_IN + (pairs - 1) * PITCH + Math.floor(PITCH / 2));
    const fixedCoord = horizontal ? route.y : route.x;
    {
      const lo = Math.min(mainStart, mainEnd), hi = Math.max(mainStart, mainEnd);
      if (horizontal) paintRect(lo, fixedCoord - CW, hi, fixedCoord + CW);
      else paintRect(fixedCoord - CW, lo, fixedCoord + CW, hi);
    }

    // Level-gated checkpoints between each room-pair position — same
    // level-gate mechanic as the arm's own entrance (ARM_LEVEL_REQ, see
    // js/game.js's ARM GATES section), just repeated at every position
    // boundary along the corridor instead of only once at the hub door.
    // Gate before position `pos` requires the level of that position's
    // first (weaker) room — e.g. the gate before the room pair hosting
    // local levels 3-4 requires character level 3.
    for (let pos = 1; pos < pairs; pos++) {
      const boundary = mainStart + sign * (LEAD_IN + (pos - 0.5) * PITCH);
      const req = ARM_OFFSETS[armIdx - 1] + (pos * 2 + 1);
      corridorGates.push(horizontal
        ? { dir, tx: Math.round(boundary), ty: fixedCoord, req }
        : { dir, tx: fixedCoord, ty: Math.round(boundary), req });
    }

    function spawnRoomEnemies(room, x, y, size, isBoss) {
      const count = isBoss ? 1 : (room.isSmall ? 5 : 10);
      const weakMult = isBoss ? 1 : 0.5; // regular monsters spawn in packs — halved individually
      for (let n = 0; n < count; n++) {
        const d = pickEnemy(isBoss, room.localLvl);
        if (!d) continue;
        let ex = room.cx * TILE + TILE / 2, ey = room.cy * TILE + TILE / 2;
        for (let attempt = 0; attempt < 40; attempt++) {
          const gx = x + 1 + Math.floor(rng() * Math.max(1, size - 2));
          const gy = y + 1 + Math.floor(rng() * Math.max(1, size - 2));
          if (inBounds(gx, gy) && grid[gy][gx] === FLOOR) { ex = gx * TILE + TILE / 2; ey = gy * TILE + TILE / 2; break; }
        }
        const stats = monsterStatsAtLevel(room.monsterLvl, isBoss ? 'boss' : d.eType);
        enemyList.push({
          id: `e_${dir}_${eid++}`, ...d, isBoss, arm: dir,
          rlvl: room.monsterLvl,
          name: monsterNameAtLevel(d.name, room.localLvl, isBoss, d.fem, maxLocalLvl),
          color: monsterColorAtLevel(d.color, d.endColor, room.localLvl, isBoss, maxLocalLvl),
          maxHp: Math.floor(stats.hp * weakMult), hp: Math.floor(stats.hp * weakMult),
          atk: Math.floor(stats.atk * weakMult),
          def: stats.def,
          xp: xpAtLevel(room.monsterLvl), gold: goldAtLevel(room.monsterLvl),
          x: ex, y: ey, spawnX: ex, spawnY: ey,
          atkTimer: 1 + rng(), aggro: false, aggroR: 175 + rng() * 55,
        });
      }
    }

    // side = -1 (near side, e.g. "top"/"left" of the corridor) or +1 (far
    // side). Chains `chainLen` rooms in a row starting from the main
    // corridor's edge and going outward — each subsequent room links to the
    // previous one via another short stub instead of the main corridor, so
    // the corridor itself never gets any longer/wider. All rooms in the
    // chain share the same localLvl/monsterLvl (more room to fight the same
    // level's monsters, not more levels).
    function buildRoomChain(pos, side, localLvl, chainLen, isBoss) {
      const alongCenter = mainStart + sign * (LEAD_IN + pos * PITCH);
      let cursor = side < 0 ? (fixedCoord - CW) : (fixedCoord + CW); // outer edge of whatever it's linking from

      for (let i = 0; i < chainLen; i++) {
        const roomIsBoss = isBoss && i === chainLen - 1;
        const size = roomIsBoss ? LARGE : (rng() < 0.5 ? SMALL : LARGE);

        let x, y, branchX0, branchY0, branchX1, branchY1;
        if (horizontal) {
          x = alongCenter - Math.floor(size / 2);
          y = side < 0 ? (cursor - STUB - size) : (cursor + STUB);
          branchX0 = alongCenter - BW; branchX1 = alongCenter + BW;
          branchY0 = side < 0 ? (y + size) : cursor;
          branchY1 = side < 0 ? (cursor - 1) : (y - 1);
        } else {
          y = alongCenter - Math.floor(size / 2);
          x = side < 0 ? (cursor - STUB - size) : (cursor + STUB);
          branchY0 = alongCenter - BW; branchY1 = alongCenter + BW;
          branchX0 = side < 0 ? (x + size) : cursor;
          branchX1 = side < 0 ? (cursor - 1) : (x - 1);
        }

        const cx = x + Math.floor(size / 2), cy = y + Math.floor(size / 2);
        const room = {
          x, y, size,
          bx1: x - 1, by1: y - 1, bx2: x + size + 1, by2: y + size + 1,
          cx, cy, isSmall: size === SMALL,
          arm: dir, localLvl, monsterLvl: ARM_OFFSETS[armIdx - 1] + localLvl, isBoss: roomIsBoss,
        };
        rooms.push(room);
        paintRect(x, y, x + size - 1, y + size - 1);
        paintRect(branchX0, branchY0, branchX1, branchY1);
        spawnRoomEnemies(room, x, y, size, roomIsBoss);

        cursor = horizontal
          ? (side < 0 ? y : (y + size))
          : (side < 0 ? x : (x + size));
      }
    }

    for (let pos = 0; pos < pairs; pos++) {
      const lvlA = pos * 2 + 1, lvlB = pos * 2 + 2;
      const lvlBIsBossSlot = lvlB === roomCount;
      buildRoomChain(pos, -1, lvlA, ROOM_CHAIN_LEN, false);
      buildRoomChain(pos, 1, lvlB, lvlBIsBossSlot ? 1 : ROOM_CHAIN_LEN, lvlBIsBossSlot);
    }
  }

  ARM_NAMES.forEach((dir, i) => buildArm(dir, i + 1));

  return {
    grid, rooms, w: DW, h: DH,
    spawn: { x: hub.cx * TILE + TILE / 2, y: hub.cy * TILE + TILE / 2 },
    safeZone: { x1: hub.bx1 * TILE, y1: hub.by1 * TILE, x2: hub.bx2 * TILE, y2: hub.by2 * TILE },
    spawnDoors: ARM_NAMES.map(dir => ({ tx: doors[dir].render.x, ty: doors[dir].render.y, dir })),
    corridorGates,
    enemies: enemyList,
  };
}

module.exports = { generateOpenWorld, TILE, WALL, FLOOR };
