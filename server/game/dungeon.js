const { TILE, WALL, FLOOR, ENEMY_DEF, FLOOR_ENEMIES, bandForLocalLevel, monsterStatsAtLevel, monsterNameAtLevel, monsterColorAtLevel, xpAtLevel, goldAtLevel, ARM_NAMES, ARM_ROOM_PAIRS, ARM_OFFSETS, ARM_LEVEL_REQ, roomsInArm } = require('../../shared/definitions');

function seededRng(seed) {
  let s = seed >>> 0;
  return function() {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Open world: one small hub + 4 detached "comb" zones ─────────────────────
// The hub is just spawn + NPCs + 4 teleport pads (one per arm/level range,
// ARM_LEVEL_REQ) — there's no walkable corridor out of it. Each arm is its
// own self-contained zone stacked below the hub, spaced far enough apart
// (ZONE_GAP) that its room chains can never reach a neighboring zone's,
// however the random room sizes land. Reaching a zone means walking onto its
// hub pad, which teleports the player straight to that zone's own corridor
// entrance — see the teleport-pad handling in js/game.js.
//
// Inside a zone the layout is unchanged from before: a dead-straight, always-
// empty main corridor with rooms branching off both sides at ARM_ROOM_PAIRS
// [armIdx-1] evenly spaced positions. Each branch chains ROOM_CHAIN_LEN rooms
// in a row (linked by more short stubs) instead of stopping at one, so every
// position has ROOM_CHAIN_LEN rooms per side, all sharing the same monster
// level. The very last position's far side is the exception: a single,
// un-chained boss room. Global room level = arm's base (ARM_OFFSETS[armIdx-1])
// + position-in-arm, reusing one FLOOR_ENEMIES pool per arm (arm index 1-4
// standing in for the old floor 1-4 themes) so enemy stats/gold/xp tuning
// carries over unchanged.
const HUB = 48;           // hub room size (tiles) — spawn + 2 NPCs + 4 teleport pads;
                          // safe to keep small since nothing physically borders it anymore
const SMALL = 9;          // 9×9 → 5 monsters
const LARGE = 14;         // 14×14 → 10 monsters
const CW = 1;             // main corridor half-width (3 tiles wide total)
const BW = 1;             // branch corridor half-width (3 tiles wide total)
const STUB = 6;           // branch length between the main corridor / each chained room
const PITCH = 20;         // tile spacing between consecutive room-pair positions
const LEAD_IN = 10;       // distance from a zone's entrance to its first position
const MARGIN = 10;        // outer wall padding
const ROOM_CHAIN_LEN = 6; // rooms chained per side per position (except the boss slot, always 1)
const ZONE_GAP = 30;      // gap (tiles) between zones/hub — comfortably more than any
                          // chain's max reach (CW + ROOM_CHAIN_LEN*(STUB+LARGE)) so
                          // neighboring zones' rooms can never touch

const MAX_ARM_PAIRS = Math.max(...ARM_ROOM_PAIRS); // longest arm sizes the zone width; shorter arms just end sooner
const ZONE_LEN = LEAD_IN + (MAX_ARM_PAIRS - 1) * PITCH + Math.floor(PITCH / 2) + LARGE;
const REACH = CW + ROOM_CHAIN_LEN * (STUB + LARGE); // max perpendicular room-chain reach from the corridor centerline
const ZONE_H = REACH * 2 + 4; // both sides plus a little pad

const DW = MARGIN * 2 + ZONE_LEN;
const HUB_X0 = MARGIN, HUB_Y0 = MARGIN;
// ── Boss arena ──────────────────────────────────────────────────────────────
// A plain square room off to the right of the hub, in the otherwise empty
// band above the first zone. Nothing spawns here during normal play and it
// has no walkable connection to anything — the only way in is the event
// teleport pad that appears in the hub while a world boss is active (see
// _buildArmGates / _updateTeleportPads in js/game.js). Sized so a size-165
// boss (≈630px across) has room to be kited and its 62 loot piles still land
// well inside the walls.
const ARENA = 40;
const ARENA_X0 = HUB_X0 + HUB + ZONE_GAP;
const ARENA_Y0 = HUB_Y0;
const ZONES_Y0 = HUB_Y0 + HUB + ZONE_GAP;
const DH = ZONES_Y0 + ARM_NAMES.length * (ZONE_H + ZONE_GAP);

function generateOpenWorld() {
  const rng = seededRng(2026 * 1337 + 777);
  const grid = Array.from({ length: DH }, () => new Array(DW).fill(WALL));

  function inBounds(gx, gy) { return gx >= 0 && gx < DW && gy >= 0 && gy < DH; }
  function paintFloor(gx, gy) { if (inBounds(gx, gy)) grid[gy][gx] = FLOOR; }
  function paintRect(x0, y0, x1, y1) {
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) paintFloor(gx, gy);
  }

  const hub = {
    x: HUB_X0, y: HUB_Y0, size: HUB,
    bx1: HUB_X0 - 1, by1: HUB_Y0 - 1, bx2: HUB_X0 + HUB + 1, by2: HUB_Y0 + HUB + 1,
    cx: HUB_X0 + Math.floor(HUB / 2), cy: HUB_Y0 + Math.floor(HUB / 2),
    isHub: true,
  };
  paintRect(hub.x, hub.y, hub.x + hub.size - 1, hub.y + hub.size - 1);

  const arena = {
    x: ARENA_X0, y: ARENA_Y0, size: ARENA,
    bx1: ARENA_X0 - 1, by1: ARENA_Y0 - 1, bx2: ARENA_X0 + ARENA + 1, by2: ARENA_Y0 + ARENA + 1,
    cx: ARENA_X0 + Math.floor(ARENA / 2), cy: ARENA_Y0 + Math.floor(ARENA / 2),
    isArena: true,
  };
  paintRect(arena.x, arena.y, arena.x + arena.size - 1, arena.y + arena.size - 1);

  const rooms = [hub, arena];
  const enemyList = [];
  const corridorGates = [];
  const armEntries = [];
  let eid = 0;
  const _enemyByEid = new Map(ENEMY_DEF.map(e => [e.eid, e]));

  function buildArm(dir, armIdx, zoneIndex) {
    const fe = FLOOR_ENEMIES[armIdx];
    const pairs = ARM_ROOM_PAIRS[armIdx - 1];
    const roomCount = roomsInArm(armIdx);
    const maxLocalLvl = roomCount - 1; // last room is the boss; ranks/colors ramp to this
    function pickEnemy(isBoss, localLvl) {
      if (isBoss) return _enemyByEid.get(fe.boss);
      const pool = bandForLocalLevel(fe, localLvl).pool;
      return _enemyByEid.get(pool[Math.floor(rng() * pool.length)]);
    }

    // Main corridor: one dead-straight, always-empty strip from the zone's
    // entrance out to the last position (plus a little tail), 3 tiles wide.
    const zoneY0 = ZONES_Y0 + zoneIndex * (ZONE_H + ZONE_GAP);
    const fixedCoord = zoneY0 + Math.floor(ZONE_H / 2);
    const mainStart = MARGIN;
    const mainEnd = mainStart + LEAD_IN + (pairs - 1) * PITCH + Math.floor(PITCH / 2);
    paintRect(mainStart, fixedCoord - CW, mainEnd, fixedCoord + CW);

    // Level-gated checkpoints between each room-pair position — same
    // level-gate mechanic that used to guard the arm's entrance (now the
    // teleport pad's own level check does that job instead), just repeated
    // at every position boundary along the corridor. Gate before position
    // `pos` requires the level of that position's first (weaker) room —
    // e.g. the gate before the room pair hosting local levels 3-4 requires
    // character level 3.
    for (let pos = 1; pos < pairs; pos++) {
      const boundary = mainStart + LEAD_IN + (pos - 0.5) * PITCH;
      const req = ARM_OFFSETS[armIdx - 1] + (pos * 2 + 1);
      corridorGates.push({ dir, tx: Math.round(boundary), ty: fixedCoord, req });
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
        // Movement speed isn't part of monsterStatsAtLevel (it's flat per
        // species in ENEMY_DEF) — scale it up separately past level 20 (and
        // for the level-20 boss itself, see below) to match the HP jumps.
        const isLvl20Boss = isBoss && room.monsterLvl === 20;
        const spdMult = (room.monsterLvl > 20 || isLvl20Boss) ? 1.5 : 1;
        // The boss guarding the end of the starting arm (level 20, right
        // before the level-20 gate) gets an extra x10 HP on top of the
        // regular BOSS_HP_MULT — it was underwhelming next to the buffed
        // level-21+ mobs that immediately follow it.
        const boss20HpMult = isLvl20Boss ? 10 : 1;
        enemyList.push({
          id: `e_${dir}_${eid++}`, ...d, isBoss, arm: dir,
          rlvl: room.monsterLvl,
          name: monsterNameAtLevel(d.name, room.localLvl, isBoss, d.fem, maxLocalLvl),
          color: monsterColorAtLevel(d.color, d.endColor, room.localLvl, isBoss, maxLocalLvl),
          maxHp: Math.floor(stats.hp * weakMult * boss20HpMult), hp: Math.floor(stats.hp * weakMult * boss20HpMult),
          atk: Math.floor(stats.atk * weakMult),
          def: stats.def,
          spd: d.spd * spdMult,
          xp: xpAtLevel(room.monsterLvl), gold: goldAtLevel(room.monsterLvl),
          x: ex, y: ey, spawnX: ex, spawnY: ey,
          atkTimer: 1 + rng(), aggro: false, aggroR: 175 + rng() * 55,
        });
      }
    }

    // side = -1 (near/top side of the corridor) or +1 (far/bottom side).
    // Chains `chainLen` rooms in a row starting from the main corridor's
    // edge and going outward — each subsequent room links to the previous
    // one via another short stub instead of the main corridor, so the
    // corridor itself never gets any longer/wider. All rooms in the chain
    // share the same localLvl/monsterLvl (more room to fight the same
    // level's monsters, not more levels).
    function buildRoomChain(pos, side, localLvl, chainLen, isBoss) {
      const alongCenter = mainStart + LEAD_IN + pos * PITCH;
      let cursor = side < 0 ? (fixedCoord - CW) : (fixedCoord + CW); // outer edge of whatever it's linking from

      for (let i = 0; i < chainLen; i++) {
        const roomIsBoss = isBoss && i === chainLen - 1;
        const size = roomIsBoss ? LARGE : (rng() < 0.5 ? SMALL : LARGE);

        const x = alongCenter - Math.floor(size / 2);
        const y = side < 0 ? (cursor - STUB - size) : (cursor + STUB);
        const branchX0 = alongCenter - BW, branchX1 = alongCenter + BW;
        const branchY0 = side < 0 ? (y + size) : cursor;
        const branchY1 = side < 0 ? (cursor - 1) : (y - 1);

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

        cursor = side < 0 ? y : (y + size);
      }
    }

    for (let pos = 0; pos < pairs; pos++) {
      const lvlA = pos * 2 + 1, lvlB = pos * 2 + 2;
      const lvlBIsBossSlot = lvlB === roomCount;
      buildRoomChain(pos, -1, lvlA, ROOM_CHAIN_LEN, false);
      buildRoomChain(pos, 1, lvlB, lvlBIsBossSlot ? 1 : ROOM_CHAIN_LEN, lvlBIsBossSlot);
    }

    // Where a teleport into this arm drops the player — right at the start
    // of its main corridor, clear of both hub-side pads and the first rooms.
    armEntries.push({
      dir, req: ARM_LEVEL_REQ[dir] || 0,
      x: (mainStart + 2) * TILE + TILE / 2,
      y: fixedCoord * TILE + TILE / 2,
    });
  }

  ARM_NAMES.forEach((dir, i) => buildArm(dir, i + 1, i));

  return {
    grid, rooms, w: DW, h: DH,
    spawn: { x: hub.cx * TILE + TILE / 2, y: hub.cy * TILE + TILE / 2 },
    safeZone: { x1: hub.bx1 * TILE, y1: hub.by1 * TILE, x2: hub.bx2 * TILE, y2: hub.by2 * TILE },
    // Arena geometry the client needs to place the event pads. Players arrive
    // at the middle of the west wall; the way out sits in the north-west
    // corner, well clear of both the arrival spot and the boss in the centre
    // so nobody teleports out by accident mid-fight.
    arena: {
      cx: arena.cx * TILE + TILE / 2, cy: arena.cy * TILE + TILE / 2,
      entryX: (ARENA_X0 + 6) * TILE + TILE / 2, entryY: arena.cy * TILE + TILE / 2,
      exitX:  (ARENA_X0 + 3) * TILE + TILE / 2, exitY:  (ARENA_Y0 + 3) * TILE + TILE / 2,
    },
    armEntries,
    corridorGates,
    enemies: enemyList,
  };
}

module.exports = { generateOpenWorld, TILE, WALL, FLOOR };
