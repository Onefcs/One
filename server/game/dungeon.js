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
// ── 3v3 PvP arena ───────────────────────────────────────────────────────────
// Two team bases facing each other across a single central corridor — one
// lane, so both teams meet head-on instead of splitting into side skirmishes.
// Like the boss arena it is walled off from everything — the only way in is
// being placed there by the match, and the only way out is dying or the
// match ending. Sits in the empty band between the boss arena and the first
// zone. Each base also holds a stationary guard boss (see A3_BOSS_DX below) —
// the opposing team destroying it wins the match instantly.
const A3_X0 = ARENA_X0;
const A3_Y0 = ARENA_Y0 + ARENA + 5;
const A3_W = 60, A3_H = 27;
const A3_BASE_W = 10;                       // depth of each team's starting box
const A3_LANE_YS = [13];                    // single corridor row, relative to A3_Y0
// Spawn rows are kept separate from the (now singular) lane row so a team's
// 3 players still land on 3 distinct tiles inside their own base instead of
// stacking on the one lane spawn.
const A3_SPAWN_YS = [4, 13, 22];
const A3_LANE_HW = 1;                       // half-width: 3 tiles for the corridor
const A3_BOSS_DX = 2;                       // guard boss sits this many tiles inside the base's back wall

// ── Corridor race ("Кровавая Башня") ─────────────────────────────────────────
// Every entrant runs their own sealed lane: 60 level-5 monsters packed
// shoulder-to-shoulder, a short gap, then 60 level-10 monsters the same way —
// "впритык", so there's no way past them except fighting through. All lanes
// open into ONE shared room at the far end holding a single boss (same
// identity as the world EVENT_BOSS — see spawnRaceBoss, server/game/Room.js).
// Whoever has dealt it the most damage when it dies wins; dying anywhere in a
// lane eliminates that player from the run (see the 'respawn' handler,
// server/index.js). Sits below the 3v3 arena, same sealed-off rules: the only
// way in is being placed there by the event.
//
// The event takes however many players register, one lane each — but the world
// is generated once at startup and its geometry never changes, so the lanes
// have to exist before anyone signs up. This is the ceiling on entrants
// (RACE10_MAX_ENTRANTS, server/index.js reads it from here): raising it costs
// RACE10_LANE_PITCH tiles of map height and RACE10_MOB_PER_TIER*2 monsters,
// and those monsters are skipped by the AI loop entirely while no race is
// running (see the race10 branch in Room.js's _tick), so an unused lane costs
// nothing per tick.
const RACE10_LANES        = 30;
const RACE10_LANE_HW      = 1;   // half-width — 3 tiles wide, same convention as every other corridor
const RACE10_LANE_GAP     = 2;   // wall tiles between adjacent lanes
const RACE10_LANE_PITCH   = RACE10_LANE_HW * 2 + 1 + RACE10_LANE_GAP; // 5 tiles, row to row
const RACE10_MOB_PER_TIER = 60;
const RACE10_MOB_SPACING  = 30;  // px between consecutive monster centres within a tier — "впритык"
const RACE10_XP_MULT      = 4;   // corridor kills grant 4x normal XP — part of the event's own reward, not just the boss-damage prize
const RACE10_TIER_LEN     = Math.ceil((RACE10_MOB_PER_TIER * RACE10_MOB_SPACING) / TILE); // tiles
const RACE10_TIER_GAP     = 4;   // tiles between the level-5 line and the level-10 line
// Spawn sits 2 tiles into the lane (see the `lanes` spot below) — LEAD_IN has
// to clear the first monster's aggro radius (up to 230px, aggroR = 175 +
// rng()*55) from there, or a monster could start hitting a still-frozen
// player during the pre-race countdown with no way to fight back or flee.
const RACE10_LEAD_IN      = 9;   // (9-2)*40 = 280px clearance
const RACE10_LEAD_OUT     = 6;   // last monster to the shared boss room
const RACE10_LANE_LEN     = RACE10_LEAD_IN + RACE10_TIER_LEN * 2 + RACE10_TIER_GAP + RACE10_LEAD_OUT;
// Barrier positions (tile x, relative to RACE10_X0) — centred in the gap
// after each tier's monster line, so the player runs into it right where the
// line ends rather than partway through empty corridor. Client-side only
// (see _isRaceBarrierBlocked, js/game.js) — same trust model as the level
// gates elsewhere in the open world (dungeon.corridorGates).
const RACE10_BARRIER1_X = RACE10_LEAD_IN + RACE10_TIER_LEN + RACE10_TIER_GAP / 2;
const RACE10_BARRIER2_X = RACE10_LEAD_IN + RACE10_TIER_LEN * 2 + RACE10_TIER_GAP + RACE10_LEAD_OUT / 2;
const RACE10_BOSS_ROOM    = 44;  // shared room, square
const RACE10_X0 = ARENA_X0;
const RACE10_Y0 = A3_Y0 + A3_H + 5;
const RACE10_H  = RACE10_LANES * RACE10_LANE_PITCH;
const RACE10_W  = RACE10_LANE_LEN + RACE10_BOSS_ROOM;

const ZONES_Y0 = RACE10_Y0 + RACE10_H + ZONE_GAP;
const DH = ZONES_Y0 + ARM_NAMES.length * (ZONE_H + ZONE_GAP);
const DW = Math.max(MARGIN * 2 + ZONE_LEN, RACE10_X0 + RACE10_W + MARGIN);

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

  // 3v3 arena: a base box at each end, joined by a single central lane.
  const a3 = {
    x: A3_X0, y: A3_Y0, size: A3_W,
    bx1: A3_X0 - 1, by1: A3_Y0 - 1, bx2: A3_X0 + A3_W + 1, by2: A3_Y0 + A3_H + 1,
    cx: A3_X0 + Math.floor(A3_W / 2), cy: A3_Y0 + Math.floor(A3_H / 2),
    isPvpArena: true,
  };
  paintRect(A3_X0, A3_Y0, A3_X0 + A3_BASE_W - 1, A3_Y0 + A3_H - 1);                       // left base
  paintRect(A3_X0 + A3_W - A3_BASE_W, A3_Y0, A3_X0 + A3_W - 1, A3_Y0 + A3_H - 1);         // right base
  A3_LANE_YS.forEach(dy => {
    const cy = A3_Y0 + dy;
    paintRect(A3_X0 + A3_BASE_W, cy - A3_LANE_HW, A3_X0 + A3_W - A3_BASE_W - 1, cy + A3_LANE_HW);
  });

  // 10-player corridor race: ten parallel lanes, each running the full
  // RACE10_LANE_LEN before opening into one shared boss room spanning every
  // lane's row.
  const race10LaneRows = [];
  for (let i = 0; i < RACE10_LANES; i++) {
    const cy = RACE10_Y0 + i * RACE10_LANE_PITCH + RACE10_LANE_HW;
    race10LaneRows.push(cy);
    paintRect(RACE10_X0, cy - RACE10_LANE_HW, RACE10_X0 + RACE10_LANE_LEN - 1, cy + RACE10_LANE_HW);
  }
  const race10BossRoomX0 = RACE10_X0 + RACE10_LANE_LEN;
  paintRect(race10BossRoomX0, RACE10_Y0, race10BossRoomX0 + RACE10_BOSS_ROOM - 1, RACE10_Y0 + RACE10_H - 1);
  const race10BossCx = race10BossRoomX0 + Math.floor(RACE10_BOSS_ROOM / 2);
  const race10BossCy = RACE10_Y0 + Math.floor(RACE10_H / 2);

  const rooms = [hub, arena, a3];
  const enemyList = [];
  const corridorGates = [];
  const armEntries = [];
  let eid = 0;
  const _enemyByEid = new Map(ENEMY_DEF.map(e => [e.eid, e]));

  // Race10 monster lines — exact pixel spacing (RACE10_MOB_SPACING), not the
  // random-within-a-room placement buildArm's rooms use below: "впритык"
  // means the gap itself has to be exact. Arm 1's species rotation (rat/
  // slime/imp) covers both tiers (level 5 and level 10) comfortably.
  const race10Fe = FLOOR_ENEMIES[1];
  function pickRace10Enemy(lvl) {
    const pool = bandForLocalLevel(race10Fe, lvl).pool;
    return _enemyByEid.get(pool[Math.floor(rng() * pool.length)]);
  }
  function spawnRace10Tier(laneIdx, laneRow, tierIdx, lvl) {
    const baseX = (RACE10_X0 + RACE10_LEAD_IN + tierIdx * (RACE10_TIER_LEN + RACE10_TIER_GAP)) * TILE;
    const ey = laneRow * TILE + TILE / 2;
    for (let i = 0; i < RACE10_MOB_PER_TIER; i++) {
      const d = pickRace10Enemy(lvl);
      if (!d) continue;
      const stats = monsterStatsAtLevel(lvl, d.eType);
      const ex = baseX + i * RACE10_MOB_SPACING + TILE / 2;
      enemyList.push({
        id: `race10_${laneIdx}_${eid++}`, ...d, isBoss: false, arm: 'race10',
        // Which lane this monster belongs to. The id has carried it all along
        // (the client slices it out to match barriers), but the server needs it
        // as a field: it is what keeps a monster from ever seeing — or being
        // seen by — a player running a different corridor. Lanes are 5 tiles
        // apart and aggro reaches up to 230px, so without it every monster
        // within two rows was fair game across a solid wall.
        lane: laneIdx,
        rlvl: lvl,
        name: monsterNameAtLevel(d.name, lvl, false, d.fem, 20),
        color: monsterColorAtLevel(d.color, d.endColor, lvl, false, 20),
        maxHp: stats.hp, hp: stats.hp,
        atk: stats.atk, def: stats.def, spd: d.spd,
        xp: xpAtLevel(lvl) * RACE10_XP_MULT, gold: goldAtLevel(lvl),
        x: ex, y: ey, spawnX: ex, spawnY: ey,
        atkTimer: 1 + rng(), aggro: false, aggroR: 175 + rng() * 55,
      });
    }
  }
  race10LaneRows.forEach((laneRow, laneIdx) => {
    spawnRace10Tier(laneIdx, laneRow, 0, 5);
    spawnRace10Tier(laneIdx, laneRow, 1, 10);
  });

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
    // 3v3 spawn points: one per player per side, set back inside each base so
    // a match never starts with the two teams already in contact. bossA/bossB
    // are each team's stationary guard boss, further back still so the
    // owning team stands between it and the lane.
    pvpArena: {
      cx: a3.cx * TILE + TILE / 2, cy: a3.cy * TILE + TILE / 2,
      teamA: A3_SPAWN_YS.map(dy => ({
        x: (A3_X0 + 4) * TILE + TILE / 2, y: (A3_Y0 + dy) * TILE + TILE / 2,
      })),
      teamB: A3_SPAWN_YS.map(dy => ({
        x: (A3_X0 + A3_W - 5) * TILE + TILE / 2, y: (A3_Y0 + dy) * TILE + TILE / 2,
      })),
      bossA: {
        x: (A3_X0 + A3_BOSS_DX) * TILE + TILE / 2, y: (A3_Y0 + Math.floor(A3_H / 2)) * TILE + TILE / 2,
      },
      bossB: {
        x: (A3_X0 + A3_W - 1 - A3_BOSS_DX) * TILE + TILE / 2, y: (A3_Y0 + Math.floor(A3_H / 2)) * TILE + TILE / 2,
      },
    },
    // Race10 ("Кровавая Башня"): one spawn point per lane (index = lane
    // number) and the single shared boss's spot at the end of every lane.
    // bounds (tile coords) lets the client tint this whole zone's floor/
    // walls to match the name — see _buildChunk, js/game.js.
    race10: {
      lanes: race10LaneRows.map(cy => ({
        x: (RACE10_X0 + 2) * TILE + TILE / 2, y: cy * TILE + TILE / 2,
      })),
      boss: {
        x: race10BossCx * TILE + TILE / 2, y: race10BossCy * TILE + TILE / 2,
      },
      bounds: { x0: RACE10_X0, y0: RACE10_Y0, x1: race10BossRoomX0 + RACE10_BOSS_ROOM, y1: RACE10_Y0 + RACE10_H },
      // One barrier pair per lane: tier 0 blocks until every level-5 monster
      // in that lane is dead, tier 1 until every level-10 one is. lane/tier
      // let the client match a barrier to the right slice of serverEnemies
      // (ids are `race10_<lane>_<n>`, rlvl is 5 or 10 — see spawnRace10Tier).
      barriers: race10LaneRows.flatMap((cy, lane) => [
        { x: (RACE10_X0 + RACE10_BARRIER1_X) * TILE + TILE / 2, y: cy * TILE + TILE / 2, lane, tier: 0 },
        { x: (RACE10_X0 + RACE10_BARRIER2_X) * TILE + TILE / 2, y: cy * TILE + TILE / 2, lane, tier: 1 },
      ]),
    },
    armEntries,
    corridorGates,
    enemies: enemyList,
    // Per-arm Y span (px, world coords) — arms are stacked purely by Y with
    // ZONE_GAP of solid wall between them and everything else (see the file
    // header comment), so a player's Y alone unambiguously places them in at
    // most one arm. Lets Room.js cheaply know which arms currently have
    // nobody in them, without tracking per-player arm state anywhere else.
    armBounds: ARM_NAMES.reduce((acc, dir, i) => {
      const zoneY0 = ZONES_Y0 + i * (ZONE_H + ZONE_GAP);
      acc[dir] = { y0: zoneY0 * TILE, y1: (zoneY0 + ZONE_H) * TILE };
      return acc;
    }, {}),
  };
}

module.exports = { generateOpenWorld, TILE, WALL, FLOOR };
