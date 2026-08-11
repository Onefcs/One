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
const GAUNTLET_STUB = 12; // wider branch spacing for the local-level-19 pre-boss gauntlet
                          // rooms (see HAS_LVL19_GAUNTLET below) — the default STUB (6 tiles
                          // = 240px) is barely past a monster's max aggro radius (175 + 55 =
                          // 230px), so a player on auto-attack/chase could get dragged clean
                          // out of one gauntlet room into the next one's fight; double the gap
                          // there so that can't happen.
const PITCH = 20;         // tile spacing between consecutive room-pair positions
const LEAD_IN = 10;       // distance from a zone's entrance to its first position
const MARGIN = 10;        // outer wall padding
const ROOM_CHAIN_LEN = 6; // rooms chained per side per position (except the boss slot, always 1)
const ZONE_GAP = 30;      // gap (tiles) between zones/hub — comfortably more than any
                          // chain's max reach (CW + ROOM_CHAIN_LEN*(STUB+LARGE)) so
                          // neighboring zones' rooms can never touch

const MAX_ARM_PAIRS = Math.max(...ARM_ROOM_PAIRS); // longest arm sizes the zone width; shorter arms just end sooner
// +1 extra PITCH: room for the second local-level-19 gauntlet corridor (see
// HAS_LVL19_GAUNTLET) that sits one position past the last regular one.
const ZONE_LEN = LEAD_IN + MAX_ARM_PAIRS * PITCH + Math.floor(PITCH / 2) + LARGE;
const REACH = CW + ROOM_CHAIN_LEN * (GAUNTLET_STUB + LARGE); // max perpendicular room-chain reach from the corridor centerline (sized off the wider gauntlet stub, the deepest any chain gets)
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

// ── Страх (Fear) — private wave-survival instances ──────────────────────────
// FEAR_LANES identical sealed square rooms, one per concurrent entrant —
// unlike race10's corridors these hold no baked-in monsters: each wave (20
// monsters, escalating one global level at a time) is spawned dynamically at
// runtime by Room.js's fearSpawnWave once the player is deployed, and removed
// once the lane is released, so only geometry needs to exist ahead of time.
// Sealed off from everything else the same way arena/pvpArena/race10 are —
// the only way in is server.js's fearEnter handler placing a player at a
// lane's entry point directly.
const FEAR_LANES = 8;      // max concurrent Fear runs
const FEAR_ROOM   = 12;    // room size (tiles) — tight enough that a wave doesn't feel spread thin
const FEAR_GAP    = 8;     // wall padding between stacked lanes
const FEAR_PITCH  = FEAR_ROOM + FEAR_GAP;
const FEAR_X0 = ARENA_X0;
const FEAR_Y0 = RACE10_Y0 + RACE10_H + ZONE_GAP;
const FEAR_H  = FEAR_LANES * FEAR_PITCH;

// ── Война гильдий (Guild War) ────────────────────────────────────────────────
// One square sealed zone with a single stationary tower/castle dead centre.
// Whichever clan lands the killing blow owns it (Room.js's capture logic
// resets its HP in place — it is never despawned/respawned, see
// Room.spawnGuildWarTower). No matchmaking/capacity cap ("Без ограничений —
// открытая зона"), so sized generously like the boss ARENA rather than
// tightly like a sealed instance — a big simultaneous crowd from multiple
// clans shouldn't feel like a mosh pit around one tile. `spawns` is a ring of
// entry points used both for initial placement and for in-zone respawn while
// the window is live (Room.guildWarRespawn) — dying here doesn't eject you,
// unlike every other sealed zone.
const GW_SIZE = 60;
const GW_X0 = ARENA_X0;
const GW_Y0 = FEAR_Y0 + FEAR_H + ZONE_GAP;
const GW_SPAWN_COUNT = 8;
const GW_SPAWN_R = Math.floor(GW_SIZE / 2) - 4;

// ── Фарм-зона (Farm Zone) ─────────────────────────────────────────────────
// Four identical square rooms in a 2x2 grid, joined by a plus-shaped
// corridor through their shared gap so all four are reachable from one
// entrance — the whole footprint (rooms + gap) is itself a square. Baked in
// at world-gen like a regular room (not runtime-spawned like Fear's waves),
// since every monster here is a fixed level with no escalation to track.
// Monsters spawn non-aggressive (aggroR: 0 — never pull first, same pattern
// as spawnGuildWarTower) and skip the normal loot table entirely: only an
// independent FARM_SHARD_CHANCE roll per shard kind, no gold/gear/recipe/key
// drops at all (see the farmZone flag, Room.attackEnemy/skillAttackEnemy and
// _rollFarmZoneLoot, server/index.js). Entry is level-gated client-side at
// FARM_ENTRY_LEVEL, same trust model as every other level gate in the open
// world (dungeon.corridorGates) — see the farm pad in js/game.js.
// Each of the 80 monsters rolls its own level (21-30) and species/archetype
// independently, so every room comes out mixed — different kinds and
// different levels standing next to each other, not one uniform pack the
// way a normal room is.
const FARM_ROOM = 16;
const FARM_GAP = 8;
const FARM_SIZE = FARM_ROOM * 2 + FARM_GAP;
const FARM_X0 = ARENA_X0;
const FARM_Y0 = GW_Y0 + GW_SIZE + ZONE_GAP;
const FARM_MOBS_PER_ROOM = 20;
const FARM_LVL_MIN = 21;
const FARM_LVL_MAX = 30;
const FARM_ENTRY_LEVEL = 20;
const FARM_XP_MULT = 3; // 3x normal XP — the zone's own reward, on top of the shard chance
// Both archetypes of every arm-2 species — 21-30 sits inside arm 2's own
// 21-40 range (ARM_OFFSETS[1] = 20), so these are the species already tuned
// for exactly this level band.
const FARM_SPECIES = ['zombie_guard', 'zombie_warrior', 'lizardman_guard', 'lizardman_warrior', 'orc_guard', 'orc_warrior'];

const ZONES_Y0 = FARM_Y0 + FARM_SIZE + ZONE_GAP;
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

  // Страх: FEAR_LANES plain sealed rooms stacked one per row, entry point
  // dead centre of each. Room.js scatters that lane's wave inside these same
  // tile bounds (x0/y0/size) the same way buildArm's spawnRoomEnemies picks a
  // random FLOOR tile within a room's bounds, below.
  const fearLanes = [];
  for (let i = 0; i < FEAR_LANES; i++) {
    const x0 = FEAR_X0, y0 = FEAR_Y0 + i * FEAR_PITCH;
    paintRect(x0, y0, x0 + FEAR_ROOM - 1, y0 + FEAR_ROOM - 1);
    fearLanes.push({
      x0, y0, size: FEAR_ROOM,
      entryX: (x0 + Math.floor(FEAR_ROOM / 2)) * TILE + TILE / 2,
      entryY: (y0 + Math.floor(FEAR_ROOM / 2)) * TILE + TILE / 2,
    });
  }

  const guildWar = {
    x: GW_X0, y: GW_Y0, size: GW_SIZE,
    bx1: GW_X0 - 1, by1: GW_Y0 - 1, bx2: GW_X0 + GW_SIZE + 1, by2: GW_Y0 + GW_SIZE + 1,
    cx: GW_X0 + Math.floor(GW_SIZE / 2), cy: GW_Y0 + Math.floor(GW_SIZE / 2),
    isGuildWar: true,
  };
  paintRect(guildWar.x, guildWar.y, guildWar.x + guildWar.size - 1, guildWar.y + guildWar.size - 1);

  const rooms = [hub, arena, a3];
  const enemyList = [];
  const corridorGates = [];
  const armEntries = [];
  let eid = 0;
  const _enemyByEid = new Map(ENEMY_DEF.map(e => [e.eid, e]));

  // Фарм-зона: paint the 4 rooms (2x2 grid) plus the plus-shaped corridor
  // through their shared gap, then bake in FARM_MOBS_PER_ROOM static
  // monsters per room (random floor tile inside the room, same placement
  // buildArm's spawnRoomEnemies uses below).
  const farmRoomCoords = [
    { x: FARM_X0, y: FARM_Y0 },                                         // top-left
    { x: FARM_X0 + FARM_ROOM + FARM_GAP, y: FARM_Y0 },                  // top-right
    { x: FARM_X0, y: FARM_Y0 + FARM_ROOM + FARM_GAP },                  // bottom-left
    { x: FARM_X0 + FARM_ROOM + FARM_GAP, y: FARM_Y0 + FARM_ROOM + FARM_GAP }, // bottom-right
  ];
  const farmRooms = farmRoomCoords.map(({ x, y }) => {
    const room = {
      x, y, size: FARM_ROOM,
      bx1: x - 1, by1: y - 1, bx2: x + FARM_ROOM + 1, by2: y + FARM_ROOM + 1,
      cx: x + Math.floor(FARM_ROOM / 2), cy: y + Math.floor(FARM_ROOM / 2),
      // Level varies per monster (FARM_LVL_MIN-FARM_LVL_MAX) — this is just a
      // representative midpoint for the HUD's single-number room label.
      isFarmZone: true, monsterLvl: Math.round((FARM_LVL_MIN + FARM_LVL_MAX) / 2), arm: 'farmZone',
    };
    paintRect(x, y, x + FARM_ROOM - 1, y + FARM_ROOM - 1);
    rooms.push(room);
    return room;
  });
  const farmMidX = FARM_X0 + Math.floor(FARM_SIZE / 2);
  // Top-row and bottom-row corridors (through the horizontal gap), plus one
  // vertical corridor through the centre column tying both rows together —
  // every room reaches every other one without lengthening any room itself.
  paintRect(FARM_X0, farmRooms[0].cy - CW, FARM_X0 + FARM_SIZE - 1, farmRooms[0].cy + CW);
  paintRect(FARM_X0, farmRooms[2].cy - CW, FARM_X0 + FARM_SIZE - 1, farmRooms[2].cy + CW);
  paintRect(farmMidX - CW, FARM_Y0, farmMidX + CW, FARM_Y0 + FARM_SIZE - 1);
  const farmMidY = FARM_Y0 + Math.floor(FARM_SIZE / 2);

  // Same halving every other packed room applies ("regular monsters spawn
  // in packs — halved individually") — 20 in a 16x16 room is denser than
  // the usual 5-10, so this matters here too.
  const FARM_WEAK_MULT = 0.5;
  const _farmMaxLocalLvl = roomsInArm(2) - 1; // arm 2's own rank scale (19)
  farmRooms.forEach((room, ri) => {
    for (let n = 0; n < FARM_MOBS_PER_ROOM; n++) {
      const d = _enemyByEid.get(FARM_SPECIES[Math.floor(rng() * FARM_SPECIES.length)]);
      if (!d) continue;
      const lvl = FARM_LVL_MIN + Math.floor(rng() * (FARM_LVL_MAX - FARM_LVL_MIN + 1));
      const stats = monsterStatsAtLevel(lvl, d.eType);
      let ex = room.cx * TILE + TILE / 2, ey = room.cy * TILE + TILE / 2;
      for (let attempt = 0; attempt < 40; attempt++) {
        const gx = room.x + 1 + Math.floor(rng() * Math.max(1, room.size - 2));
        const gy = room.y + 1 + Math.floor(rng() * Math.max(1, room.size - 2));
        if (inBounds(gx, gy) && grid[gy][gx] === FLOOR) { ex = gx * TILE + TILE / 2; ey = gy * TILE + TILE / 2; break; }
      }
      // Named/colored the same way arm 2's own rooms would at this level
      // (localLvl relative to ARM_OFFSETS[1]) so a level-27 zombie here looks
      // exactly like a level-27 zombie anywhere else in the open world.
      const localLvl = lvl - ARM_OFFSETS[1];
      enemyList.push({
        id: `farm_${ri}_${eid++}`, ...d, isBoss: false, arm: 'farmZone', farmZone: true,
        rlvl: lvl,
        name: monsterNameAtLevel(d.name, localLvl, false, d.fem, _farmMaxLocalLvl),
        color: monsterColorAtLevel(d.color, d.endColor, localLvl, false, _farmMaxLocalLvl),
        maxHp: Math.floor(stats.hp * FARM_WEAK_MULT), hp: Math.floor(stats.hp * FARM_WEAK_MULT),
        atk: Math.floor(stats.atk * FARM_WEAK_MULT), def: stats.def, spd: d.spd,
        xp: xpAtLevel(lvl) * FARM_XP_MULT, gold: goldAtLevel(lvl),
        x: ex, y: ey, spawnX: ex, spawnY: ey,
        atkTimer: 1 + rng(),
        // Never self-aggros (aggroR: 0) — same "stands until struck" pattern
        // as spawnGuildWarTower. attackEnemy/skillAttackEnemy unconditionally
        // set aggro:true on any hit regardless of aggroR, so it still fights
        // back once attacked; it just never pulls first.
        aggro: false, aggroR: 0,
      });
    }
  });

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
      // Same halving buildArm's spawnRoomEnemies applies to every regular
      // room monster ("regular monsters spawn in packs — halved
      // individually") — race10's lines are packed even tighter (60 per
      // tier, RACE10_MOB_SPACING=30px apart, vs. 5-10 spread across a whole
      // room), so full monsterStatsAtLevel() here hit far harder than
      // anywhere else a player meets a level 5 or 10 monster.
      const weakMult = 0.5;
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
        maxHp: Math.floor(stats.hp * weakMult), hp: Math.floor(stats.hp * weakMult),
        atk: Math.floor(stats.atk * weakMult), def: stats.def, spd: d.spd,
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
    // True for every arm whose pre-boss position lands exactly on local level
    // 19 (left/top/bottom; 'right' is one pair short and never reaches it).
    // Those arms get a second 6-large-room level-19 gauntlet corridor one
    // more position further out, past the boss junction — see below.
    const HAS_LVL19_GAUNTLET = (pairs - 1) * 2 + 1 === 19;
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
    const lastPos = HAS_LVL19_GAUNTLET ? pairs : pairs - 1; // one extra PITCH for the second level-19 gauntlet
    const mainEnd = mainStart + LEAD_IN + lastPos * PITCH + Math.floor(PITCH / 2);
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
    function buildRoomChain(pos, side, localLvl, chainLen, isBoss, stub = STUB) {
      const alongCenter = mainStart + LEAD_IN + pos * PITCH;
      let cursor = side < 0 ? (fixedCoord - CW) : (fixedCoord + CW); // outer edge of whatever it's linking from

      for (let i = 0; i < chainLen; i++) {
        const roomIsBoss = isBoss && i === chainLen - 1;
        // Local level 19 — the row right before the level-20 boss slot in
        // every arm that reaches it — is the pre-boss gauntlet: all 6 rooms
        // large (10 monsters each) instead of the usual random small/large
        // mix, same treatment as a boss room.
        const size = (roomIsBoss || localLvl === 19) ? LARGE : (rng() < 0.5 ? SMALL : LARGE);

        const x = alongCenter - Math.floor(size / 2);
        const y = side < 0 ? (cursor - stub - size) : (cursor + stub);
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
      buildRoomChain(pos, -1, lvlA, ROOM_CHAIN_LEN, false, lvlA === 19 ? GAUNTLET_STUB : STUB);
      buildRoomChain(pos, 1, lvlB, lvlBIsBossSlot ? 1 : ROOM_CHAIN_LEN, lvlBIsBossSlot);
    }

    if (HAS_LVL19_GAUNTLET) {
      // Second level-19 gauntlet: an identical 6-large-room chain one more
      // corridor position past the boss junction (near side only — the far
      // side here just stays plain corridor, nothing needs it). Doubles the
      // farming space at the level everyone bottlenecks on right before the
      // level-20 gate.
      buildRoomChain(pairs, -1, 19, ROOM_CHAIN_LEN, false, GAUNTLET_STUB);
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
      // Where the shared boss room starts (px, world x) — every lane's
      // corridor ends before this and the one shared room spans everything
      // past it. Room.js uses this to tell "still in my own sealed corridor"
      // apart from "reached the shared room", the same distinction the boss
      // itself already gets (see spawnRaceBoss's `lane`-less enemy).
      bossRoomX0: race10BossRoomX0 * TILE,
      // One barrier pair per lane: tier 0 blocks until every level-5 monster
      // in that lane is dead, tier 1 until every level-10 one is. lane/tier
      // let the client match a barrier to the right slice of serverEnemies
      // (ids are `race10_<lane>_<n>`, rlvl is 5 or 10 — see spawnRace10Tier).
      barriers: race10LaneRows.flatMap((cy, lane) => [
        { x: (RACE10_X0 + RACE10_BARRIER1_X) * TILE + TILE / 2, y: cy * TILE + TILE / 2, lane, tier: 0 },
        { x: (RACE10_X0 + RACE10_BARRIER2_X) * TILE + TILE / 2, y: cy * TILE + TILE / 2, lane, tier: 1 },
      ]),
    },
    // Страх (Fear): lane geometry only — Room.js reaches into this directly
    // (this._dungeon.fear), it is deliberately NOT part of Room.dungeonData
    // (below), since the client needs no rendering/tinting hints for it: entry
    // and every wave transition are server-pushed teleports, not something the
    // client discovers by walking around.
    fear: { lanes: fearLanes },
    // Война гильдий (Guild War): one sealed zone, one tower dead centre.
    // spawns is a ring of entry points reused both for initial placement
    // (js/game.js's teleport pad) and in-zone respawn while the window is
    // live (Room.guildWarRespawn) — see the const block above for why.
    // bounds lets the client tint the zone's floor/walls, same purpose as
    // race10.bounds above.
    guildWar: {
      cx: guildWar.cx * TILE + TILE / 2, cy: guildWar.cy * TILE + TILE / 2,
      entryX: (GW_X0 + 6) * TILE + TILE / 2, entryY: guildWar.cy * TILE + TILE / 2,
      exitX:  (GW_X0 + 3) * TILE + TILE / 2, exitY:  (GW_Y0 + 3) * TILE + TILE / 2,
      spawns: Array.from({ length: GW_SPAWN_COUNT }, (_, i) => {
        const ang = (i / GW_SPAWN_COUNT) * Math.PI * 2;
        return {
          x: guildWar.cx * TILE + TILE / 2 + Math.cos(ang) * GW_SPAWN_R * TILE,
          y: guildWar.cy * TILE + TILE / 2 + Math.sin(ang) * GW_SPAWN_R * TILE,
        };
      }),
      bounds: { x0: GW_X0, y0: GW_Y0, x1: GW_X0 + GW_SIZE, y1: GW_Y0 + GW_SIZE },
    },
    // Фарм-зона: one entry/exit pair at the centre of the plus-shaped
    // corridor (offset a couple tiles apart so arriving and leaving don't
    // trigger each other) plus minLevel for the client's teleport-pad gate
    // (js/game.js) — same req-based lock the regular arm pads already use.
    farmZone: {
      entryX: farmMidX * TILE + TILE / 2, entryY: farmMidY * TILE + TILE / 2,
      exitX:  farmMidX * TILE + TILE / 2, exitY:  (FARM_Y0 + 2) * TILE + TILE / 2,
      bounds: { x0: FARM_X0, y0: FARM_Y0, x1: FARM_X0 + FARM_SIZE, y1: FARM_Y0 + FARM_SIZE },
      minLevel: FARM_ENTRY_LEVEL,
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
