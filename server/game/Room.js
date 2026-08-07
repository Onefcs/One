const crypto = require('crypto');
const { generateOpenWorld, TILE, WALL } = require('./dungeon');
const { calcGoldDrop, CHAR_DEF, ARM_NAMES, EVENT_BOSS, EVENT_BOSS_DROP_LIFE_MS, rollEventBossDrops,
        ARENA3_BOSS_HP, ENEMY_AOI_R, enhanceBonus, passiveBonusTotal,
        ENEMY_DEF, FLOOR_ENEMIES, bandForLocalLevel, monsterStatsAtLevel, monsterNameAtLevel,
        monsterColorAtLevel, xpAtLevel, goldAtLevel, armIndexForLevel, ARM_OFFSETS, roomsInArm,
        FEAR_MAX_WAVE } = require('../../shared/definitions');
const { encodeGameState, packGrid } = require('../../shared/netcodec');

// Replicates client recompute() formula — single source of truth for server
// stats. Must stay step-for-step identical to recompute() (js/player.js) for
// every PERMANENT stat source: base + upgrades + equipment (including its
// enhancement) + passive skills. Temporary buffs (potions, skill buffs) are
// deliberately left out — those are exactly what STAT_BUFF_HEADROOM below
// leaves room for on top of this value.
//
// The per-point upgrade values are the ones UPGRADE_DEF advertises in the
// upgrade UI (js/definitions.js): +1 ATK, +1 DEF, +10 MaxHP, +1% crit chance,
// +3% crit power. This function used to carry its own, much larger numbers
// (×3 ATK, ×2 DEF, ×25 HP, +2.5%/+15% crit) and to ignore both item
// enhancement and passives entirely, so the server's idea of a player never
// matched the character sheet the player was looking at. For atk/def/maxHp
// that only skewed the anti-cheat ceiling, but updatePlayerStats() ASSIGNS
// crit from here rather than capping it, so the wrong crit numbers were the
// ones actually rolled in combat — a crit landed for a different multiplier
// than the sheet showed, and "Кровавая ярость" (+4% crit power per level) did
// nothing at all because passives never reached the server.
// clanAtkBonusPct is the caller's clan's current % atk bonus (shared/
// definitions.js's clanAtkBonusPct(level), already resolved by server/
// index.js since Room.js has no access to clan state) — recompute()
// (js/player.js) applies the identical multiplier, and it was missing here
// entirely until now: setPlayerChar/updatePlayerStats/publicProfile all
// route through this function, so every one of them silently dropped a
// clan's attack bonus, and setPlayerChar in particular re-runs on every
// selectChar — including the one a reconnect (background tab, brief network
// drop) sends automatically — resetting a clan member's combat atk back
// down until their own client happened to recompute() again for an
// unrelated reason. That's what made the same hit against the same monster
// swing between two different numbers depending on whether a reconnect had
// just clobbered it.
function computeStats(sd, cd, type, clanAtkBonusPct) {
  const u = sd.upgrades || {};
  let a = (sd.baseAtk   ?? cd.baseAtk) + (u.atk || 0) * 1;
  let d = (sd.baseDef   ?? cd.baseDef) + (u.def || 0) * 1;
  let h = (sd.baseMaxHp ?? cd.baseHP)  + (u.hp  || 0) * 10;
  let hpPct = 0, extraCrit = 0, extraAS = 0;
  Object.values(sd.equipment || {}).forEach(it => {
    if (!it) return;
    // Enhancement (+N) is part of an item's real stats — see _canonSavedItem
    // (server/index.js), which validates and preserves `enhance` on the way in.
    const eb = enhanceBonus(it, it.enhance || 0);
    a     += (it.atk || 0) + (eb.atk || 0);
    d     += (it.def || 0) + (eb.def || 0);
    h     += (it.hp  || 0) + (eb.hp  || 0);
    hpPct += it.hpPct || 0;
    if (it.critChance) extraCrit += it.critChance;
    if (it.atkSpeed)   extraAS   += it.atkSpeed;
  });
  // Passive skills (shared/definitions.js). passiveBonusTotal clamps every
  // level to PASSIVE_MAX_LEVEL and only reads known passive ids, so a client
  // can't inflate these by sending junk in savedData.passiveLevels.
  const pt = passiveBonusTotal(sd.passiveLevels, type || sd.type);
  hpPct += pt.hpPct;
  h = Math.floor(h * (1 + hpPct));
  a = Math.floor(a * (1 + pt.atkPct));
  d = Math.floor(d * (1 + pt.defPct));
  // Same multiplier recompute() applies via getClanBonus() — after passives,
  // like there.
  if (clanAtkBonusPct > 0) a = Math.floor(a * (1 + clanAtkBonusPct / 100));
  extraAS += (cd.atkSpeed || 0) * pt.atkSpeedPct;
  const lvl = (sd.lvl || 1) - 1;
  return {
    atk: a,
    def: d,
    maxHp: h,
    critChance: Math.min(0.80, 0.05 + lvl * 0.004 + (u.critChance || 0) * 0.01 + extraCrit),
    critPower:  1.5 + lvl * 0.015 + (u.critPower  || 0) * 0.03 + pt.critPowerFlat,
    // Permanent-only — mirrors recompute() (js/player.js) minus its buff/skill
    // timer terms, same as every other field here (see the file header note).
    atkSpeed: (cd.atkSpeed || 0) * (1 + lvl * 0.015) + (u.atkSpeed || 0) * 0.05 + extraAS,
    hpRegen:  lvl * 0.02 + (u.hpRegen || 0) * 0.1 + pt.hpRegenFlat,
  };
}

function _critDmg(base, critChance, critPower) {
  const isCrit = Math.random() < (critChance || 0);
  return { dmg: isCrit ? Math.floor(base * (critPower || 1.5)) : base, isCrit };
}

// How far above the server's own computed "true" stats (from validated
// equipment/upgrades/level, see computeStats) a statsUpdate push is allowed
// to land. Must cover every buff that can legitimately stack at once — the
// biggest is a Танк's own +80% DEF plus a received party heal-shield's +50%
// (≈2.7×) — with margin, while still closing off a client just claiming
// arbitrary numbers (previously the cap ratcheted off the client's OWN prior
// value, so repeated calls walked it up to 9999 in ~10 packets).
const STAT_BUFF_HEADROOM = 3;
const HP_BUFF_HEADROOM   = 1.5;
// Passive-regen ceiling used to bound how fast a playerMove-reported HP
// increase is allowed to land (see syncPlayerHp) — real heals (potions,
// faithShield/party heal, respawn) all go through their own dedicated,
// server-applied paths and are never gated by this.
const MAX_HP_REGEN_PER_SEC = 30;
// Server-side minimum gap between two skill CASTS from the same player. The
// real cooldowns are seconds long and enforced by the client; this only has to
// be tight enough that spamming the event isn't worth anything.
const SKILL_CD_MS = 400;
// An AOE skill (_skillAOEMult/_skillDirMult, js/player.js) fires one
// skillAttack/pvpSkillAttack event per enemy caught in its radius, all in the
// same client-side pass — they land here within a few ms of each other, not
// spread out. Hits arriving within this window of the current cast's first
// hit are treated as the same cast and don't gate each other; a hit outside
// the window starts a new cast and is judged against SKILL_CD_MS as before.
// Without this, only the first enemy an AOE press touched ever took damage —
// every other hit from the same cast landed inside the old floor and was
// silently dropped.
const SKILL_BURST_MS = 150;
// Upper bound on how many enemies one crowd-control packet may name (see
// applySkillEffectMany).
const MAX_CC_TARGETS = 64;

const TICK_MS   = 25;              // 40 ticks/sec — halves avg broadcast wait vs 50ms
const LEASH_R2  = 420 * 420;      // max distance from spawn before leash triggers
// Players render on a ~700px-wide viewport — 600px AOI covers everything visible
// with margin, at 2.25× less area than the 900px enemy AOI.
const PLAYER_AOI_R2 = 600 * 600;
// Party rewards (shared XP/gold, the healer's party heal) only reach members
// who are actually there for the fight. Set a little wider than PLAYER_AOI_R2
// so someone right at the edge of the screen — visible, but whose exact
// position the client and server may disagree on by a few frames of movement
// — still counts, instead of flickering in and out of the share.
// Equipped pet id out of a save blob, or null. Pets live in the normal
// equipment map (slot 'pet'), so this is just a guarded lookup.
function _petIdOf(sd) {
  return (sd && sd.equipment && sd.equipment.pet && sd.equipment.pet.id) || null;
}

const PARTY_SHARE_R = 700;
const PARTY_SHARE_R2 = PARTY_SHARE_R * PARTY_SHARE_R;
// At most this many other players per packet (screen fits ~15). Bounds the
// N² blowup when hundreds of players stack in one spot.
const PLAYER_CAP = 20;
// Every N casts a PLAYER entry goes out full even if the recipient "knows"
// it — self-heals any client/server known-state divergence within ~2s.
// Players are AOI-limited and capped at PLAYER_CAP, so this stays cheap.
const FULL_REFRESH_TICKS = 80;
// Cap on one resync request, so a malformed or hostile client can't ask the
// server to encode the whole world on demand.
const ENEMY_RESYNC_MAX = 40;

// Radius for purely visual combat fan-out (projectiles, AOE rings, the CC
// flash on a monster) — see nearbyPlayerIds and its callers in server/index.js.
// Wider than PLAYER_AOI_R2 because a projectile outlives the frame it was
// fired in: the fastest one travels ~400px/s for 1.8s, so a shot aimed away
// from the shooter can end up well past the radius the shooter themselves is
// streamed within. Everything beyond this is unreachable on screen anyway —
// the client is never told the shooter exists, so a projectile arriving from
// there would be a bolt out of empty space.
const VISUAL_FANOUT_R = 1000;
const VISUAL_FANOUT_R2 = VISUAL_FANOUT_R * VISUAL_FANOUT_R;
// Upper bound on recipients of one visual, for the case the radius can't
// bound on its own: a hundred players standing on the same hub tile are all
// legitimately "in range" of each other. See nearbyPlayerIds.
const VISUAL_FANOUT_CAP = 24;

// Ceiling on one player's pending combat visuals between two casts. Only
// reachable when their casts are being dropped for backpressure while a fight
// rages next to them — in which case the oldest few are the ones worth having.
const VISUAL_QUEUE_MAX = 48;

// A player receiving nothing at all still gets one packet this often, purely
// so their clock offset (js/network.js's _svrTimeOffset EMA) keeps tracking
// the server. At 20 casts/s this is once a second.
const IDLE_HEARTBEAT_CASTS = 20;

// ── Страх (Fear) tuning ──────────────────────────────────────────────────────
// FEAR_MAX_WAVE (the last wave's level) is shared with server/index.js for the
// UI's wave counter (shared/definitions.js); these two are only ever read
// inside fearSpawnWave below, so they stay local.
const FEAR_WAVE_MOBS = 20;  // monsters per wave
const FEAR_XP_MULT   = 10;  // XP multiplier for every Fear-event kill
// A wave spawns in a ring this far from the entry point (px) — see
// fearSpawnWave. Kept well inside _closestTargetFor's own search radius
// (max(aggroR*2.2, 300), aggroR tops out at 230 so that's ~506px) so every
// monster in the wave is guaranteed to find the player on its first AI tick,
// and inside the FEAR_ROOM=12 room's own walls (dungeon.js) with a tile of
// margin to spare (half-width 240px, minus the 1-tile border ≈ 200px).
//
// The floor (140) matters as much as the ceiling: the tick loop only ever
// moves an aggro'd enemy while closestD > e.size + 14 (~30-46px depending on
// species/level) — spawning any closer than that leaves it already standing
// in melee range on frame one, with nothing to visibly walk across, which is
// exactly what read as "they're just standing there" once the room shrank.
// Starting the whole ring past that threshold means every monster in the
// wave visibly closes real distance before the first swing lands.
const FEAR_SPAWN_RING_MIN = 140;
const FEAR_SPAWN_RING_MAX = 190;
// Species/stat lookup by eid, built once — same table server/game/dungeon.js
// builds locally for the open world's own spawns (`_enemyByEid` there), needed
// here too since Fear's waves are spawned at runtime instead of at world-gen.
const _FEAR_ENEMY_BY_EID = new Map(ENEMY_DEF.map(e => [e.eid, e]));

// Enemy interest management. ENEMY_AOI_R (shared/definitions.js — the client
// prunes against the same number) is the radius each player is streamed
// enemies within; the grid cell is sized to match it so the per-player query
// only ever touches a 2x2..3x3 block of cells.
const ENEMY_AOI_R2 = ENEMY_AOI_R * ENEMY_AOI_R;
const ENEMY_GRID_CELL = ENEMY_AOI_R;
// Players get the same treatment as enemies, and for two callers: the AOI
// candidate scan (which was a nested players.forEach, O(N²) per cast) and the
// enemy AI's closest-target search (which scanned every player, per enemy).
// Bucketing into PLAYER_AOI_R-sized cells means each query only looks at the
// block of cells that can possibly contain someone in range.
//
// Sized to PLAYER_AOI_R so the broadcast query walks exactly 3x3 cells. The AI
// search uses a per-enemy radius and walks however many cells that covers.
const PLAYER_GRID_CELL = 600;
// Shared by both spatial grids. Cell keys are Math.floor(coord / cell) which
// can go negative near the world origin, so the multiplier has to be big
// enough that no two distinct (cx, cy) pairs collide — the world is ~1000
// tiles across, so ±50000 of headroom on each axis is ample.
const GRID_KEY_STRIDE = 100000;
function _gridKey(cx, cy) { return cx * GRID_KEY_STRIDE + cy; }
// How long (in casts, which run every other tick — so ~150ms) an enemy may be
// out of a player's range before the server forgets having told them about
// it. Small on purpose: see the ordering requirement in _collectEnemiesFor.
const EKNOWN_FORGET_CASTS = 6;
// Map-panel dot refresh, in ticks (40/s) — 1Hz. Only sent to players with the
// panel open; see _broadcastMapBlips.
const MAP_BLIP_EVERY = 40;
// Every N casts an enemy is re-sent in full even if this player's copy looks
// current, staggered per enemy so it costs a handful of entries per cast
// rather than a world-wide sweep. Purely a self-heal: it puts an authoritative
// position, hp and aggro flag back in front of a client whose own copy has
// drifted for any reason. Dropping it (when enemies moved to per-player
// streaming) is what let a client-invented aggro survive indefinitely instead
// of correcting itself within a minute.
const ENEMY_REFRESH_CASTS = 1200; // 20 casts/s -> once a minute

// The complete record for one enemy — every field the client needs to render
// and fight it. Shared by the tick's periodic refresh and the on-demand
// resync so the two can never describe an enemy differently.
function _fullEnemyEntry(e) {
  return {
    id: e.id, idx: e._idx, eid: e.eid, x: e.x, y: e.y, hp: e.hp, maxHp: e.maxHp,
    name: e.name, color: e.color, size: e.size, isBoss: e.isBoss, aggro: e.aggro,
    aggroR: e.aggroR, spd: e.spd, rlvl: e.rlvl || 0,
    atkAnimTimer: e._atkPulse ? e.atkAnimTimer : 0,
  };
}
// Each enemy only re-runs its full closest-eligible-player scan (O(players))
// once every this many ticks (staggered by enemy index, see _tick()) instead
// of every tick — O(enemies × players) exceeded the 25ms tick budget at
// ~200 concurrent players once enemy count doubled (ROOM_CHAIN_LEN 3->6).
// Movement/attack still use a freshly recomputed distance to the (possibly
// cached) target every tick, so this only throttles how often "who's
// closest" is re-decided — at 4 ticks (~10Hz) that's a ≤75ms-stale target
// choice, imperceptible in play.
const AI_TARGET_SEARCH_EVERY = 4;

// Per-arm boss respawn: random 1-2h, not a flat 3600s — otherwise every
// boss on the map ticks back in at exactly the same offset from whatever
// moment killed/reset them, which reads as suspiciously mechanical over a
// full day of restarts/kills.
const BOSS_RESPAWN_MIN_S = 60 * 60;
const BOSS_RESPAWN_MAX_S = 2 * 60 * 60;
function _bossRespawnSecs() {
  return BOSS_RESPAWN_MIN_S + Math.random() * (BOSS_RESPAWN_MAX_S - BOSS_RESPAWN_MIN_S);
}

class Room {
  // bossState: { [arm]: respawnAtMs } — this floor's persisted per-arm boss
  // deadlines (server/index.js loads BossState from Mongo before creating
  // any Room). onBossDeath(arm, respawnAtMs) is called every time a per-arm
  // boss actually dies, so index.js can persist the new deadline the same
  // way — see attackEnemy/skillAttackEnemy below, the only two places a
  // per-arm boss's hp reaches 0.
  constructor(floor, io, bossState = {}, onBossDeath = null) {
    this.floor = floor;
    this.io = io;
    this._onBossDeath = onBossDeath;
    this.players = new Map();
    this._dungeon = generateOpenWorld();
    this._gridPacked = packGrid(this._dungeon.grid, this._dungeon.w, this._dungeon.h);
    // Which arms currently have >=1 player, recomputed once per tick (see
    // _tick's players.forEach) — lets the enemy AI and grid-rebuild loops
    // skip regular arm enemies nobody is there to see, same idea as the
    // existing race10-idle skip below.
    this._armBounds = this._dungeon.armBounds;
    this._armPresent = new Set();
    const _now = Date.now();
    this.enemies = this._dungeon.enemies.map(e => {
      if (!e.isBoss) {
        return { ...e, hp: e.maxHp, aggro: false, atkTimer: 1 + Math.random(),
          hurtTimer: 0, atkAnimTimer: 0, _sx: e.x, _sy: e.y, _shp: e.maxHp };
      }
      const savedAt = bossState[e.arm];
      // Three cases for a per-arm boss at startup:
      //  - a persisted deadline still in the future: stay dead, and resume
      //    the real remaining cooldown rather than losing it to the restart.
      //  - a deadline already in the past: the cooldown ran out while the
      //    server was down, so it's alive again now.
      //  - no record at all: this boss has never been killed, so it's alive.
      //    (Before deadlines were persisted, this case had to assume the
      //    worst and start every boss dead on a fresh timer, or a restart
      //    would respawn one that had just been killed. Now that a kill
      //    always leaves a record, a missing one is unambiguous — and
      //    assuming death here was killing bosses nobody had touched, every
      //    restart, for up to two hours at a time.)
      const dead = savedAt != null && savedAt > _now;
      const hp = dead ? 0 : e.maxHp;
      const respawnTimer = dead ? (savedAt - _now) / 1000 : undefined;
      return {
        ...e, hp, aggro: false, atkTimer: 1 + Math.random(), hurtTimer: 0, atkAnimTimer: 0,
        _sx: e.x, _sy: e.y, _shp: hp,
        ...(respawnTimer !== undefined ? { respawnTimer } : {}),
      };
    });
    // O(1) enemy lookup for attack handler
    this._enemyMap = new Map(this.enemies.map(e => [e.id, e]));
    // Reusable buffers — avoids array allocation every tick
    this._nearPlayersBuf = [];
    this._nearEnemiesBuf = [];
    this._candBuf = [];
    // Spatial index over alive non-boss enemies, rebuilt every tick, so the
    // per-player interest query in _collectEnemiesFor doesn't have to walk
    // the whole enemy list. Bosses sit in _bossBuf instead — they're sent to
    // everyone regardless of distance.
    this._enemyGrid = new Map();
    this._bossBuf = [];
    // Same idea for players — see PLAYER_GRID_CELL. Rebuilt every tick (the
    // AI reads it too), not just on the casts that broadcast.
    this._playerGrid = new Map();
    // Pool of reusable {op, d2} slots for the capped nearest-N selection, so a
    // busy hub doesn't allocate PLAYER_CAP objects per player per cast (at 200
    // players that was ~80k short-lived objects a second, all of it GC work).
    this._candPool = [];
    // Reusable buffer for "who can currently see this enemy" fan-outs
    // (enemyHurt/enemyKilled) — see viewersOfEnemy.
    this._viewerBuf = [];
    // Second buffer plus a rotating offset, for the capped visual fan-out —
    // see nearbyPlayerIds.
    this._fanoutWin = [];
    this._fanoutRot = 0;
    this._tickNo = 0;
    this._pSeq = 0;
    // Tick timing, exposed via stats() and the /health endpoint. A tick that
    // regularly overruns TICK_MS is the direct cause of the whole room feeling
    // sluggish, and until now nothing recorded it.
    this._tickMsMax = 0;
    this._tickMsSum = 0;
    this._tickSamples = 0;
    this._tickOverruns = 0;
    this.enemies.forEach((e, i) => { e._idx = i; });
    this._lastTick = Date.now();
    this._interval = null;
    // Counts _tick() calls, purely to stagger the closest-target re-search
    // below (a separate counter from _tickNo, which is actually a cast-id
    // sequence, not a tick counter, despite the name).
    this._aiTickNo = 0;
    // Still used by resendEnemies (below), which builds one throwaway list
    // for a single recipient and wants encodeGameState's byte cache bypassed.
    this._nearEnemiesGen = 0;
    // ── World drops (event-boss loot lying on the floor) ───────────────────
    // id -> { id, x, y, item, expiresAt }. Not per-player: one shared pool
    // everyone can see, claimed atomically by claimWorldDrop() so exactly one
    // player can ever take a given pile ("кто успел, тот забрал").
    this.worldDrops = new Map();
    this._dropSeq = 0;
    this._eventBossId = null;
    // ── Страх (Fear) lane bookkeeping ───────────────────────────────────────
    // lane index -> socketId currently occupying it (fearDeploy/
    // fearReleaseLane), and lane index -> monsters still alive in that lane's
    // CURRENT wave (fearSpawnWave/fearRegisterKill) — server/index.js reads
    // the latter indirectly via fearRegisterKill's return value to decide
    // whether to advance to the next wave.
    this._fearOwner = new Map();
    this._fearAlive = new Map();
  }

  // ── Event boss ────────────────────────────────────────────────────────────
  // Spawns EVENT_BOSS at the centre of the dedicated arena (server/game/
  // dungeon.js), a sealed square room reachable only via the event teleport
  // pad that appears in the hub while the event is running. Keeping it out of
  // the hub means the safe zone stays genuinely safe for anyone who doesn't
  // opt in by stepping on the pad.
  spawnEventBoss() {
    if (this.isEventBossAlive()) return null;
    const ar = this._dungeon.arena;
    const x = ar.cx, y = ar.cy;
    const e = {
      id: `evtboss_${Date.now()}`,
      ...EVENT_BOSS,
      arm: 'hub',
      rlvl: 0,
      maxHp: EVENT_BOSS.hp,
      hp: EVENT_BOSS.hp,
      x, y, spawnX: x, spawnY: y,
      atkTimer: 1, hurtTimer: 0, atkAnimTimer: 0,
      aggro: false,
      // Wide enough to cover the arena — the default 175 would leave a boss
      // this size idle unless someone walked right into it.
      aggroR: 900,
      _sx: x, _sy: y, _shp: EVENT_BOSS.hp,
      _idx: this.enemies.length,
    };
    this.enemies.push(e);
    this._enemyMap.set(e.id, e);
    this._eventBossId = e.id;
    return e;
  }

  isEventBossAlive() {
    const e = this._eventBossId ? this._enemyMap.get(this._eventBossId) : null;
    return !!(e && e.hp > 0);
  }

  // ── Страх (Fear) ─────────────────────────────────────────────────────────
  // A private wave-survival instance, one lane per concurrent entrant
  // (server/game/dungeon.js's `fear.lanes`, sealed rooms with no baked-in
  // monsters). Isolation from the rest of the world — and between lanes —
  // reuses the exact same machinery race10 lanes rely on (_raceVisible,
  // nearbyPlayerIds, mapBlips), keyed off p._fearLane instead of p._raceLane;
  // see those for the actual filtering.

  // Claims the first unoccupied lane and places the player at its entry
  // point, full HP, in one step — the single-entrant sibling of raceDeploy.
  // Deliberately not split into a separate "find a free lane" + "deploy into
  // it" pair: with no reservation in between, two calls racing between those
  // steps could both pick the same lane. Returns null if every lane is
  // currently in use. Wave 1 is spawned separately (fearSpawnWave) right
  // after this, by the caller.
  fearDeploy(socketId) {
    const p = this.players.get(socketId);
    if (!p) return null;
    const lanes = this._dungeon.fear.lanes;
    let lane = -1;
    for (let i = 0; i < lanes.length; i++) if (!this._fearOwner.has(i)) { lane = i; break; }
    if (lane === -1) return null;
    const spot = lanes[lane];
    p.x = spot.entryX; p.y = spot.entryY;
    p.hp = p.maxHp;
    p._fearLane = lane;
    p._raceLane = null;
    p._profileRev++;
    this._fearOwner.set(lane, socketId);
    return { x: p.x, y: p.y, lane };
  }

  // Spawns FEAR_WAVE_MOBS monsters at global level `lvl`, scattered inside
  // lane `lane`'s room — same random-floor-tile placement buildArm's
  // spawnRoomEnemies uses (server/game/dungeon.js), just done at runtime
  // since a private instance's monsters can't be pre-baked into the shared
  // world map the way race10's corridors are. Reuses the same global-level
  // species/name/color/stat functions the open world's own rooms use, so a
  // Fear wave at level 12 looks and hits exactly like an open-world level-12
  // room would.
  fearSpawnWave(lane, lvl) {
    const room = this._dungeon.fear.lanes[lane];
    if (!room) return;
    const armIdx = armIndexForLevel(lvl);
    const fe = FLOOR_ENEMIES[armIdx];
    const localLvl = lvl - ARM_OFFSETS[armIdx - 1];
    const maxLocalLvl = roomsInArm(armIdx) - 1;
    let spawned = 0;
    for (let n = 0; n < FEAR_WAVE_MOBS; n++) {
      const pool = bandForLocalLevel(fe, localLvl).pool;
      const d = _FEAR_ENEMY_BY_EID.get(pool[Math.floor(Math.random() * pool.length)]);
      if (!d) continue;
      // In a ring around the entry point (not scattered across the whole
      // room the way buildArm's open-world spawnRoomEnemies does) — a wave
      // is supposed to swarm the player the instant it appears, not sit in a
      // far corner waiting to be walked into. FEAR_SPAWN_RING_MAX is well
      // inside _closestTargetFor's own search radius (aggroR*2.2, ~500px),
      // so every monster in the wave is guaranteed to actually find the
      // player on its very first AI tick.
      let ex = room.entryX, ey = room.entryY;
      for (let attempt = 0; attempt < 40; attempt++) {
        const ang = Math.random() * Math.PI * 2;
        const ring = FEAR_SPAWN_RING_MIN + Math.random() * (FEAR_SPAWN_RING_MAX - FEAR_SPAWN_RING_MIN);
        const tx = room.entryX + Math.cos(ang) * ring, ty = room.entryY + Math.sin(ang) * ring;
        if (!this._isWall(tx, ty)) { ex = tx; ey = ty; break; }
      }
      const stats = monsterStatsAtLevel(lvl, d.eType);
      // Same halving buildArm's spawnRoomEnemies applies to every regular
      // room's monster pack — a fresh-level-1 player facing 20 full-strength
      // level-1 monsters at once is a much rougher fight than the same
      // player would ever meet in a 5-10-monster open-world room.
      const weakMult = 0.5;
      const e = {
        id: `fear_${lane}_${this._fearSeq = (this._fearSeq || 0) + 1}`,
        ...d, isBoss: false, arm: 'fear', lane, rlvl: lvl,
        name: monsterNameAtLevel(d.name, localLvl, false, d.fem, maxLocalLvl),
        color: monsterColorAtLevel(d.color, d.endColor, localLvl, false, maxLocalLvl),
        maxHp: Math.floor(stats.hp * weakMult), hp: Math.floor(stats.hp * weakMult),
        atk: Math.floor(stats.atk * weakMult), def: stats.def, spd: d.spd,
        xp: xpAtLevel(lvl) * FEAR_XP_MULT, gold: goldAtLevel(lvl),
        x: ex, y: ey, spawnX: ex, spawnY: ey,
        // Pre-aggroed straight out of the spawn (unlike every other monster
        // in the game, which only wakes up once a player crosses its aggroR)
        // — waves are meant to charge in immediately, not wait to be pulled.
        atkTimer: 1 + Math.random(), aggro: true, aggroR: 175 + Math.random() * 55,
      };
      this.enemies.push(e);
      this._enemyMap.set(e.id, e);
      spawned++;
    }
    this._fearAlive.set(lane, spawned);
  }

  // Called by server/index.js right after a kill lands on a `fear`-tagged
  // enemy. Returns the lane's remaining alive count (0 means the wave is
  // clear and the caller should spawn the next one, or finish the run if the
  // wave that just fell was FEAR_MAX_WAVE).
  fearRegisterKill(lane) {
    const left = Math.max(0, (this._fearAlive.get(lane) || 0) - 1);
    this._fearAlive.set(lane, left);
    return left;
  }

  // Frees a lane and clears out whatever is left of its current wave (dead or
  // still standing) — called on every exit path: death, clearing wave
  // FEAR_MAX_WAVE, or a disconnect mid-run. Idempotent: safe to call on a
  // lane that's already been released.
  fearReleaseLane(lane) {
    if (lane == null || !this._fearOwner.has(lane)) return;
    this._fearOwner.delete(lane);
    this._fearAlive.delete(lane);
    this.enemies = this.enemies.filter(e => {
      if (e.arm !== 'fear' || e.lane !== lane) return true;
      this._enemyMap.delete(e.id);
      this._forgetEnemy(e.id);
      return false;
    });
    this.enemies.forEach((e, i) => { e._idx = i; });
  }

  // Scatters `items` on the floor around (cx, cy) as individually claimable
  // piles and tells everyone about them. Positions are rejected if they'd
  // land in a wall so nothing spawns unreachable.
  spawnWorldDrops(items, cx, cy) {
    const now = Date.now();
    const spawned = [];
    items.forEach((item, i) => {
      // Rings of increasing radius — 62 piles in one tight cluster would
      // overlap into an unreadable heap and all get vacuumed by one player
      // standing still (pickup radius is 30px, see js/game.js).
      let x = cx, y = cy;
      for (let attempt = 0; attempt < 24; attempt++) {
        const ring = 70 + Math.floor(i / 10) * 55 + Math.random() * 45;
        const ang = Math.random() * Math.PI * 2;
        const tx = cx + Math.cos(ang) * ring, ty = cy + Math.sin(ang) * ring;
        if (!this._isWall(tx, ty)) { x = tx; y = ty; break; }
      }
      const d = { id: `wd_${++this._dropSeq}`, x, y, item, expiresAt: now + EVENT_BOSS_DROP_LIFE_MS };
      this.worldDrops.set(d.id, d);
      spawned.push(d);
    });
    if (spawned.length) this.io.to(`floor_${this.floor}`).emit('worldDropsSpawned', { drops: spawned });
    return spawned;
  }

  // Atomic claim — the Map delete is the arbitration point, so two players
  // walking over the same pile in the same tick can't both get it.
  claimWorldDrop(dropId, px, py) {
    const d = this.worldDrops.get(dropId);
    if (!d) return null;
    if (d.expiresAt <= Date.now()) { this.worldDrops.delete(dropId); return null; }
    // Server-side range check so a modified client can't hoover the map from
    // across the hub. Generous vs the client's own 30px pickup radius to
    // allow for movement latency.
    const dx = d.x - px, dy = d.y - py;
    if (dx * dx + dy * dy > 120 * 120) return null;
    this.worldDrops.delete(dropId);
    this.io.to(`floor_${this.floor}`).emit('worldDropTaken', { id: dropId });
    return d;
  }

  // Answers a client that received position deltas for enemies it has no
  // record of. Replaces what the 2s world-wide refresh used to do by accident,
  // at a fraction of the cost: one small packet to one player, only for the
  // enemies actually missing. Encoded as an ordinary gameState (players: null)
  // so the client's existing merge path handles it with no new format.
  resendEnemies(socketId, ids) {
    if (!this.players.has(socketId) || !Array.isArray(ids) || !ids.length) return;
    const out = [];
    const known = this.players.get(socketId)?._eKnown;
    for (const id of ids) {
      if (out.length >= ENEMY_RESYNC_MAX) break;
      const e = this._enemyMap.get(id);
      if (!e || e.hp <= 0) continue;
      out.push(_fullEnemyEntry(e));
      // Record it as sent, or the next tick would spend another full entry on
      // the same enemy before any slim delta could be used for it.
      if (known) known.set(e.id, { x: e.x, y: e.y, hp: e.hp, aggro: e.aggro, seen: this._tickNo });
    }
    if (!out.length) return;
    // A fresh generation number every time — the gen is an encoder cache key,
    // and reusing a tick's would serve that tick's bytes instead of these.
    this._nearEnemiesGen++;
    this.io.to(socketId).emit('gameState',
      encodeGameState(null, out, Date.now(), this._nearEnemiesGen));
  }

  worldDropSnapshot() {
    const now = Date.now();
    return [...this.worldDrops.values()].filter(d => d.expiresAt > now);
  }

  _startLoop() {
    if (this._interval) return;
    this._lastTick = Date.now();
    this._interval = setInterval(() => {
      const t0 = Date.now();
      try { this._tick(); } catch (err) { console.error(`[Room ${this.floor} tick]`, err); }
      const ms = Date.now() - t0;
      this._tickMsSum += ms;
      this._tickSamples++;
      if (ms > this._tickMsMax) this._tickMsMax = ms;
      if (ms > TICK_MS) this._tickOverruns++;
    }, TICK_MS);
  }

  _stopLoop() {
    if (!this._interval) return;
    clearInterval(this._interval);
    this._interval = null;
  }

  // Snapshot of how the loop is actually keeping up, for /health. Reading it
  // resets the window so each poll describes the interval since the last one
  // rather than an ever-flattening lifetime average.
  stats() {
    const s = {
      floor: this.floor,
      players: this.players.size,
      enemies: this.enemies.length,
      tickMsAvg: this._tickSamples ? +(this._tickMsSum / this._tickSamples).toFixed(2) : 0,
      tickMsMax: this._tickMsMax,
      tickOverruns: this._tickOverruns,
      tickSamples: this._tickSamples,
      tickBudgetMs: TICK_MS,
    };
    this._tickMsMax = 0; this._tickMsSum = 0; this._tickSamples = 0; this._tickOverruns = 0;
    return s;
  }

  // The map as one self-contained buffer, plus a content hash naming it.
  //
  // The world is generated from a FIXED seed (see generateOpenWorld in
  // server/game/dungeon.js), so every process builds a byte-identical map:
  // the hash is stable across restarts and redeploys, which is what makes it
  // safe to serve this over HTTP with an immutable, effectively permanent
  // cache. Before this, the whole thing — 52KB of packed grid plus ~79KB of
  // room JSON — was serialized into gameStart for every single join, and a
  // join happens on every socket.io reconnect, not just at login. A restart
  // reconnects everyone at once, and 150 simultaneous joins stretched a 25ms
  // tick to 125ms.
  //
  // Layout: u32 JSON byte length, the JSON (everything except the grid), then
  // the raw packed grid. Decoded by _decodeWorldMap in js/network.js.
  get mapPayload() {
    if (this._mapPayload) return this._mapPayload;
    const d = this.dungeonData;
    const meta = { ...d, gridPacked: undefined };
    delete meta.gridPacked;
    const json = Buffer.from(JSON.stringify(meta), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(json.length, 0);
    this._mapPayload = Buffer.concat([head, json, d.gridPacked]);
    this._mapVersion = crypto.createHash('sha1').update(this._mapPayload).digest('hex').slice(0, 12);
    return this._mapPayload;
  }

  get mapVersion() {
    if (!this._mapVersion) this.mapPayload; // builds both
    return this._mapVersion;
  }

  get dungeonData() {
    const d = this._dungeon;
    // arena must be included: the client builds the event teleport pads from
    // it in _buildArmGates (js/game.js), and without it _evtPad stays null so
    // the portal never appears no matter what the event state says.
    // race10.bounds is what lets the client tint that zone's floor/walls to
    // look like "Кровавая Башня" (see _buildChunk, js/game.js).
    return { gridPacked: this._gridPacked, rooms: d.rooms, spawn: d.spawn, w: d.w, h: d.h, safeZone: d.safeZone, armEntries: d.armEntries, corridorGates: d.corridorGates, arena: d.arena, race10: d.race10 };
  }

  _inSafeZone(x, y) {
    const sz = this._dungeon.safeZone;
    return x >= sz.x1 && x <= sz.x2 && y >= sz.y1 && y <= sz.y2;
  }

  isPlayerInSafeZone(socketId) {
    const p = this.players.get(socketId);
    return p ? this._inSafeZone(p.x, p.y) : false;
  }

  // The client's starting enemy list. Scoped to what's near that player for
  // the same reason the live stream is (see _collectEnemiesFor): unscoped
  // this was ~960KB of JSON on every single login, essentially all of it
  // describing enemies on the far side of the world that the very next tick
  // would prune again. Bosses are always included, wherever they are.
  //
  // Also records what it sent in the player's _eKnown, so the first tick
  // after this doesn't immediately repeat all of it as "first sight".
  enemySnapshot(socketId) {
    const p = socketId != null ? this.players.get(socketId) : null;
    const out = [];
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (e.hp <= 0) continue;
      if (p && !e.isBoss) {
        const dx = e.x - p.x, dy = e.y - p.y;
        if (dx * dx + dy * dy > ENEMY_AOI_R2) continue;
      }
      out.push({
        id: e.id, eid: e.eid, x: e.x, y: e.y, hp: e.hp, maxHp: e.maxHp,
        name: e.name, color: e.color, size: e.size, isBoss: e.isBoss, aggro: e.aggro,
        aggroR: e.aggroR, spd: e.spd, rlvl: e.rlvl || 0,
      });
      if (p) p._eKnown.set(e.id, { x: e.x, y: e.y, hp: e.hp, aggro: e.aggro, seen: this._tickNo });
    }
    return out;
  }

  // One boss per corridor (arm) — alive or, once dead, the timestamp it
  // respawns at. respawnTimer is undefined for the single tick right after
  // death (the AI loop hasn't assigned it its full duration yet), so fall
  // back to the same constant used to seed it.
  getBossStatus() {
    const status = {};
    ARM_NAMES.forEach(arm => {
      const boss = this.enemies.find(e => e.isBoss && e.arm === arm);
      if (!boss) return;
      if (boss.hp > 0) { status[arm] = { alive: true }; return; }
      const secs = boss.respawnTimer !== undefined ? boss.respawnTimer : _bossRespawnSecs();
      status[arm] = { alive: false, respawnAt: Date.now() + Math.max(0, secs) * 1000 };
    });
    return status;
  }

  _isWall(x, y) {
    const d = this._dungeon;
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    if (tx < 0 || ty < 0 || tx >= d.w || ty >= d.h) return true;
    return d.grid[ty][tx] === WALL;
  }

  // Same sampling algorithm as the client's hasLOS() (combat.js) — kept in
  // lockstep so a shot the client thinks is clear doesn't get rejected here.
  // ── Кровавая Башня: lane isolation ────────────────────────────────────────
  // Lanes sit RACE10_LANE_PITCH (5 tiles = 200px) apart and monsters aggro out
  // to 230px, so on distance alone a monster reaches two rows either side —
  // straight through a solid wall. The line-of-sight test only gates the FIRST
  // aggro, and losing sight never drops it (a deliberate rule everywhere else
  // in the world), so a monster pulled by its own runner would then chase
  // whoever was nearest afterwards, wall or no wall, and stand there grinding
  // into it. The same radius on the client's side is what let a player's
  // auto-target lock a monster in the next corridor and run at it.
  //
  // Distance can't separate corridors, so identity does: every corridor
  // monster carries the lane it was generated in, every entrant carries the
  // lane they were deployed into, and the two only interact when those match.
  // Both the AI's target search and the per-player enemy stream go through
  // these, so a monster in another lane is not merely unreachable — the client
  // is never told it exists, and therefore cannot target it.
  //
  // The boss is deliberately laneless: it stands in the one shared room every
  // corridor opens into, and every entrant must be able to see and fight it.
  // Also covers Страх (Fear): its lanes are isolated by the same rule, just
  // keyed off p._fearLane/e.arm === 'fear' instead of the tower's own fields
  // — a player can only ever be in at most one of the two instance types at
  // once, so the two checks never both apply.
  _raceVisible(p, e) {
    if (e.arm === 'race10') return p._raceLane != null && (e.lane == null || e.lane === p._raceLane);
    if (e.arm === 'fear') return p._fearLane != null && (e.lane == null || e.lane === p._fearLane);
    return p._raceLane == null && p._fearLane == null;
  }

  // The composite lane identity used to scope visual fan-out (nearbyPlayerIds/
  // queueProjectile/queueAoe/laneOf) — distinguishes "not in any instance",
  // "tower lane N" and "Fear lane N" with one comparable value, since a raw
  // _raceLane number and a raw _fearLane number would otherwise collide (lane
  // 0 of one instance type must never see lane 0 of the other).
  _playerLaneKey(p) {
    if (p._raceLane != null) return 'r' + p._raceLane;
    if (p._fearLane != null) return 'f' + p._fearLane;
    return null;
  }

  _hasLOS(x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 1) return true;
    const steps = Math.ceil(len / (TILE * 0.45));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (this._isWall(x1 + dx * t, y1 + dy * t)) return false;
    }
    return true;
  }

  _tick() {
    const now = Date.now();
    const dt = Math.min((now - this._lastTick) / 1000, 0.1);
    this._lastTick = now;
    if (this.players.size === 0) return;

    const nearPlayers = this._nearPlayersBuf;
    const nearEnemies = this._nearEnemiesBuf;
    // Built every tick, not just on cast ticks: the enemy AI's closest-target
    // search queries it too, and that runs at the full 40Hz. It replaces the
    // flat alive-players array the AI used to scan end-to-end per enemy, so
    // that array is no longer built at all.
    this._rebuildPlayerGrid();

    // Detect players entering the safe zone — reset only enemies chasing them.
    // Collect the transitions first and make at most ONE pass over the enemy
    // list for the whole set: this used to run a full enemies.forEach per
    // entering player, so a group of ten stepping into the hub on the same
    // tick cost ten sweeps of ~4500 enemies inside a 25ms budget.
    let entered = null;
    const armPresent = this._armPresent;
    armPresent.clear();
    this.players.forEach(p => {
      const nowIn = this._inSafeZone(p.x, p.y);
      if (nowIn && !p._wasInSafeZone) (entered || (entered = new Set())).add(p.socketId);
      p._wasInSafeZone = nowIn;
      // Arms are stacked by Y with no overlap (see dungeon.js's armBounds
      // comment) — at most one of these can match, so break on the first hit.
      for (let i = 0; i < ARM_NAMES.length; i++) {
        const b = this._armBounds[ARM_NAMES[i]];
        if (p.y >= b.y0 && p.y < b.y1) { armPresent.add(ARM_NAMES[i]); break; }
      }
    });
    if (entered) {
      for (let i = 0; i < this.enemies.length; i++) {
        const e = this.enemies[i];
        if (e.hp <= 0 || e.ignoresSafeZone) continue; // event boss chases into the hub
        if (!e._targetId || !entered.has(e._targetId)) continue;
        e.x = e.spawnX; e.y = e.spawnY;
        e.aggro = false;
        e._targetId = null;
        e._cachedTarget = null;
        e._shp = -1;
      }
    }

    // Enemy AI + respawn
    this._aiTickNo++;
    this.enemies.forEach(e => {
      if (e.hp <= 0) {
        // 3v3 guard boss: killing one ends the match on the spot (see the
        // a3Team check in server/index.js's attack/skillAttack handlers,
        // which calls despawnPvpArenaBosses() in the same tick it dies) — it
        // never lingers here long enough to loot or respawn.
        if (e.a3Team) return;
        // Race10 boss: same reasoning — server/index.js ends the race and
        // calls despawnRaceBoss() in the same tick it dies (no loot table,
        // the reward is a Liberty payout to whoever dealt it the most damage).
        if (e.raceBoss) return;
        // Race10 corridor monsters: stay dead until resetRaceMonsters() revives
        // the whole lane for the next race — a 12s auto-respawn (the normal
        // rule below) would let an early kill come back mid-run and the
        // client's "all dead" barrier check (js/game.js) would never pass.
        if (e.arm === 'race10') return;
        // Fear wave monsters: same reasoning — stay dead until the wave
        // clears and fearReleaseLane purges them (or fearSpawnWave replaces
        // them with the next wave's fresh batch). A 12s auto-respawn here
        // would let an early kill silently come back and never let
        // fearRegisterKill's count reach zero.
        if (e.arm === 'fear') return;
        // Event boss: drop its whole loot table on the floor for everyone and
        // remove it for good. Unlike the per-arm bosses it never respawns on
        // a timer — only another admin summon brings it back. _evtLooted
        // guards against the drop firing twice before the removal below runs.
        if (e.ignoresSafeZone) {
          if (!e._evtLooted) {
            e._evtLooted = true;
            this.spawnWorldDrops(rollEventBossDrops(), e.x, e.y);
            this.io.to(`floor_${this.floor}`).emit('eventBossDefeated', {});
            e._evtRemove = true; // purged after this forEach, see below
            this._evtPurge = true;
          }
          return;
        }
        // Defensive fallback only — attackEnemy/skillAttackEnemy already
        // assign a per-arm boss's respawnTimer (and persist it) the instant
        // it dies, so this branch only ever fires for regular enemies' 12s
        // timer, or for a boss killed through some other path.
        if (e.respawnTimer === undefined) {
          e.respawnTimer = e.isBoss ? _bossRespawnSecs() : 12;
          if (e.isBoss && this._onBossDeath) this._onBossDeath(e.arm, Date.now() + e.respawnTimer * 1000);
          return;
        }
        e.respawnTimer -= dt;
        if (e.respawnTimer <= 0) {
          e.hp = e.maxHp;
          e.x = e.spawnX; e.y = e.spawnY;
          e.aggro = false; e.atkTimer = 1 + Math.random(); e.hurtTimer = 0;
          e.stunTimer = 0; e.slowTimer = 0;
          e._shp = -1;
          delete e.respawnTimer;
          if (e.isBoss) this.io.to(`floor_${this.floor}`).emit('bossStatus', { arm: e.arm, alive: true });
        }
        return;
      }

      // 3v3 guard boss: stands exactly where it spawned for the whole match —
      // no targeting, no movement, no attack, no leash. Damage still applies
      // normally via attackEnemy/skillAttackEnemy, which don't go through
      // this loop at all.
      if (e.a3Passive) return;

      // Corridor monsters while no race is running: there is nobody inside the
      // tower to see, so the target search below can only ever come back empty.
      // Skipping them outright is what makes a large number of pre-generated
      // lanes free — with RACE10_LANES lanes at 120 monsters each they are a
      // sizeable share of the world's enemies, and every one of them was being
      // walked 40 times a second to answer "is anyone near?" with "no".
      if (e.arm === 'race10' && !e.raceBoss && !this._raceActive) return;

      // Same idea, applied to the 4 open-world arms: a regular (non-boss)
      // enemy whose arm currently has zero players can't have anyone to
      // aggro onto or be seen by (armPresent is recomputed every tick above,
      // from live player positions) — skip its target search/movement/attack
      // entirely. Bosses are excluded: there are only 4 of them, so the cost
      // is negligible, and skipping would also skip their leash/respawn-
      // adjacent state below in ways not worth reasoning about here.
      if (!e.isBoss && this._armBounds[e.arm] && !armPresent.has(e.arm)) return;

      // Tick CC timers
      if ((e.stunTimer || 0) > 0) { e.stunTimer -= dt; return; }
      if ((e.slowTimer || 0) > 0) e.slowTimer -= dt;

      // Find closest alive player not in safe zone, not invisible — but only
      // actually re-scan every AI_TARGET_SEARCH_EVERY ticks (see its comment
      // above); otherwise reuse the cached target as long as it's still
      // eligible, so a stale reference never keeps an enemy chasing someone
      // who died/vanished/hid for multiple ticks.
      // The event boss (shared/definitions.js EVENT_BOSS) is summoned INTO the
      // hub, which is the safe zone — the normal rules would leave it with no
      // eligible target forever. It alone may target players standing there;
      // every other enemy still skips them, so the hub stays safe from
      // everything except this one deliberate world event.
      const _sz = !e.ignoresSafeZone;
      const cached = e._cachedTarget;
      const cachedStillValid = cached && cached.hp > 0 && this.players.get(cached.socketId) === cached &&
        !(_sz && this._inSafeZone(cached.x, cached.y)) && !cached._invis;
      const dueForSearch = (e._idx % AI_TARGET_SEARCH_EVERY) === (this._aiTickNo % AI_TARGET_SEARCH_EVERY);
      let closest = cachedStillValid ? cached : null;
      if (dueForSearch || !cachedStillValid) {
        closest = this._closestTargetFor(e, _sz);
        e._cachedTarget = closest;
      }
      const closestD2 = closest ? (closest.x - e.x) * (closest.x - e.x) + (closest.y - e.y) * (closest.y - e.y) : Infinity;
      // No eligible target anywhere in the room (e.g. a solo player just
      // died, or everyone left/entered a safe zone) — snap straight back to
      // spawn instead of freezing mid-chase wherever it happened to be. The
      // enemy only ever moves while aggro is true, so this is the only place
      // that state needs resetting; without it an enemy could sit stalled
      // off its spawn point indefinitely, only recovering once some other
      // player later wanders close enough to re-target it.
      if (!closest) {
        e._targetId = null;
        if (e.aggro && !e.ignoresSafeZone) { e.aggro = false; e.x = e.spawnX; e.y = e.spawnY; e._shp = -1; }
        if (e.ignoresSafeZone) e.aggro = false;
        return;
      }
      e._targetId = closest.socketId;

      const closestD = Math.sqrt(closestD2);

      // Only trigger aggro with a clear line of sight — an enemy on the
      // other side of a wall within radius shouldn't wake up and start
      // charging at a player it can't actually see. Losing LOS after
      // aggro doesn't cancel it (still purely distance-gated below) so a
      // player briefly ducking behind a corner mid-chase doesn't flicker
      // the enemy off and on.
      // `!e.aggro` first: losing LOS never cancels aggro (see above), so once
      // an enemy is awake the sampled wall-walk in _hasLOS can only ever
      // re-confirm what's already true. Skipping it there takes the single
      // most expensive call in this loop off every already-chasing enemy,
      // every tick — which in a busy arm is most of them.
      if (!e.aggro && closestD < e.aggroR && this._hasLOS(e.x, e.y, closest.x, closest.y)) e.aggro = true;
      // Same immediate-teleport-home as above: the closest remaining player
      // isn't necessarily near THIS enemy (they could be dead here and the
      // "closest" is someone else across the floor) — de-aggroing shouldn't
      // leave the enemy stranded wherever the chase ended.
      if (closestD > e.aggroR * 2.2 && e.aggro && !e.ignoresSafeZone) {
        e.aggro = false;
        e.x = e.spawnX; e.y = e.spawnY;
        e._shp = -1;
      }

      if (e.aggro) {
        // `stationary` holds an enemy on its spawn point while leaving the
        // rest of its behaviour alone — it still aggros, still swings at
        // anyone who steps into reach. Used by the tower's boss (see
        // spawnRaceBoss); everything else moves as before.
        if (!e.stationary && closestD > e.size + 14) {
          const spdMult = (e.slowTimer || 0) > 0 ? 0.35 : 1;
          const nx = (closest.x - e.x) / closestD;
          const ny = (closest.y - e.y) / closestD;
          const evx = nx * e.spd * spdMult * dt, evy = ny * e.spd * spdMult * dt;
          if (!this._isWall(e.x + evx, e.y)) e.x += evx;
          if (!this._isWall(e.x, e.y + evy)) e.y += evy;
        }
        if (e.atkAnimTimer > 0) e.atkAnimTimer -= dt;
        e.atkTimer -= dt;
        if (closestD < e.size + 20 && e.atkTimer <= 0) {
          e.atkTimer = 1.4 + Math.random() * 0.6;
          e.atkAnimTimer = 0.9;
          e._atkPulse = true;
          const dmg = Math.max(1, e.atk - (closest.def || 0));
          closest.hp = Math.max(0, closest.hp - dmg);
          // Straight down the victim's own socket, not io.to(id): the room
          // form builds a BroadcastOperator plus a rooms Set on every call,
          // and this runs inside the 40Hz AI loop on every monster swing —
          // the same reasoning the gameState emit below already follows.
          const vsock = this._socketFor(closest);
          if (vsock) vsock.emit('playerHurt', { id: closest.socketId, hp: closest.hp, dmg });
        }
      }

      // Leash: too far from spawn → full HP reset back to spawn. Skipped for
      // the event boss: LEASH_R2 is only 420px and the hub is 48 tiles across,
      // so players circling it would repeatedly reset its 100k HP to full.
      const ldx = e.x - e.spawnX, ldy = e.y - e.spawnY;
      if (!e.ignoresSafeZone && ldx * ldx + ldy * ldy > LEASH_R2) {
        e.hp = e.maxHp;
        e.x = e.spawnX; e.y = e.spawnY;
        e.aggro = false;
        e._shp = -1;
      }
    });

    // Drop a defeated event boss out of the world for good. Deferred to here
    // because splicing this.enemies inside the forEach above would skip an
    // element and leave every _idx (used for the AI target-search stagger and
    // the per-player delta trackers) pointing at the wrong enemy.
    if (this._evtPurge) {
      this._evtPurge = false;
      this.enemies = this.enemies.filter(e => {
        if (!e._evtRemove) return true;
        this._enemyMap.delete(e.id);
        this._forgetEnemy(e.id);
        return false;
      });
      this.enemies.forEach((e, i) => { e._idx = i; });
    }

    // Expire ground loot nobody picked up in time.
    if (this.worldDrops.size) {
      const expired = [];
      this.worldDrops.forEach(d => { if (d.expiresAt <= now) expired.push(d.id); });
      if (expired.length) {
        expired.forEach(id => this.worldDrops.delete(id));
        this.io.to(`floor_${this.floor}`).emit('worldDropsExpired', { ids: expired });
      }
    }

    // Per-player emit: AOI filter + delta (reuse buffers — emit serializes synchronously).
    // Bandwidth protocol:
    //  - players are broadcast every OTHER tick (20Hz; client interpolates)
    //  - static fields (username/type/maxHp/pvpMode) go out only on first
    //    sight, on profile change (_profileRev), or on periodic refresh;
    //    otherwise a slim {id,x,y,facing,hp,atkSeq} entry is sent
    //  - at most PLAYER_CAP nearest players per packet
    //  - enemies ride the same every-other-tick cast as players, as a
    //    change-delta within ENEMY_AOI_R; static fields (name/color/size/…)
    //    go only on that player's first sight of them
    const castId = ++this._tickNo;
    const castPlayers = (castId & 1) === 0;
    const cand = this._candBuf;

    // Nothing to send on the off ticks — the AI above still runs at the full
    // 40Hz, this just halves how often the result is cast out. Clients
    // interpolate enemy positions toward the last one received (see the
    // exponential pull in js/game.js), and the feedback that has to feel
    // instant — your own hits — rides its own enemyHurt event rather than
    // this stream, so 20Hz here is indistinguishable in play while halving
    // both the packet count and the per-player collect/encode cost.
    if (!castPlayers) return;

    // Bucket every alive enemy into the spatial grid once per cast, so the
    // per-player interest query below only walks the handful of cells around
    // that player instead of all ~4500 enemies (which at 200 players would be
    // ~900k distance checks every 25ms).
    this._rebuildEnemyGrid();
    // The player grid was already rebuilt at the top of this tick for the AI
    // target search, and nothing has moved players since — reuse it.

    this.players.forEach(p => {
      nearPlayers.length = 0;
      cand.length = 0;
      // Same 3x3-cell interest query the enemies use, for the same reason —
      // see PLAYER_GRID_CELL.
      //
      // Only the PLAYER_CAP nearest survive, and they are selected as we go
      // rather than collected and sorted afterwards. The old version pushed
      // every candidate into an array and ran Array.sort on the lot: in a
      // crowded hub a single 600px radius holds well over a hundred other
      // players, so that was a ~150-element comparator sort per player per
      // cast. Profiling a 300-player room measured it at 58% of the entire
      // tick — comfortably the largest single cost in the whole loop, larger
      // than the enemy AI and the packet encoding put together.
      //
      // Bounded insertion instead: `cand` is kept sorted ascending by d2 and
      // never grows past the cap, so once it is full the common case is a
      // single compare against the current worst and a skip. Slots come from a
      // pool, so this allocates nothing at all.
      const pgrid = this._playerGrid;
      const pcx0 = Math.floor((p.x - PLAYER_GRID_CELL) / PLAYER_GRID_CELL);
      const pcx1 = Math.floor((p.x + PLAYER_GRID_CELL) / PLAYER_GRID_CELL);
      const pcy0 = Math.floor((p.y - PLAYER_GRID_CELL) / PLAYER_GRID_CELL);
      const pcy1 = Math.floor((p.y + PLAYER_GRID_CELL) / PLAYER_GRID_CELL);
      let nCand = 0;
      for (let pcx = pcx0; pcx <= pcx1; pcx++) {
        for (let pcy = pcy0; pcy <= pcy1; pcy++) {
          const cell = pgrid.get(_gridKey(pcx, pcy));
          if (!cell) continue;
          for (let ci = 0; ci < cell.length; ci++) {
            const op = cell[ci];
            if (op.socketId === p.socketId) continue;
            const dx = op.x - p.x, dy = op.y - p.y;
            const d2 = dx * dx + dy * dy;
            if (d2 > PLAYER_AOI_R2) continue;
            // Full, and no closer than the furthest one we're keeping — the
            // branch that takes almost every candidate in a busy hub.
            if (nCand === PLAYER_CAP && d2 >= cand[PLAYER_CAP - 1].d2) continue;
            let slot;
            if (nCand < PLAYER_CAP) {
              // Pool slots are claimed by index 0..nCand-1, so this index has
              // not been handed out yet in this player's pass, wherever the
              // insertion below ends up moving the earlier ones to.
              slot = this._candPool[nCand];
              if (!slot) { slot = { op: null, d2: 0 }; this._candPool[nCand] = slot; }
              cand[nCand] = slot;
              nCand++;
            } else {
              slot = cand[PLAYER_CAP - 1]; // evict the current worst, reuse its slot
            }
            slot.op = op; slot.d2 = d2;
            let j = nCand - 1;
            while (j > 0 && cand[j - 1].d2 > d2) { cand[j] = cand[j - 1]; j--; }
            cand[j] = slot;
          }
        }
      }
      cand.length = nCand;
      for (let i = 0; i < cand.length; i++) {
        const op = cand[i].op;
        const k = p._known.get(op.socketId);
        const full = !k || k.rev !== op._profileRev || k.seen !== castId - 2 ||
          ((castId >> 1) + op._seq) % FULL_REFRESH_TICKS === 0;
        if (full) {
          nearPlayers.push({
            id: op.socketId, seq: op._seq, username: op.username, type: op.type,
            x: op.x, y: op.y, facing: op.facing, hp: op.hp, maxHp: op.maxHp,
            pvpMode: op.pvpMode || false, atkSeq: op.lastAtkSeq || 0, moving: !!op.moving,
            clanName: op.clanName || null, clanIcon: op.clanIcon || null,
          });
        } else {
          nearPlayers.push({
            id: op.socketId, seq: op._seq, x: op.x, y: op.y, facing: op.facing,
            hp: op.hp, atkSeq: op.lastAtkSeq || 0, moving: !!op.moving,
          });
        }
        if (k) { k.rev = op._profileRev; k.seen = castId; }
        else p._known.set(op.socketId, { rev: op._profileRev, seen: castId });
      }
      const playersOut = nearPlayers;

      // Enemies are now picked per player (only what's near them), so unlike
      // the players segment there's nothing shared to reuse between
      // recipients — hence the undefined gen, which tells encodeGameState to
      // skip its cross-recipient byte cache. That cache existed because this
      // list used to be identical for everyone and re-encoding ~1300 entries
      // per player blew the tick budget; the AOI list is ~6x smaller, so
      // encoding it per player is cheaper than the old shared encode was.
      this._collectEnemiesFor(p, nearEnemies, castId);

      // t: server tick timestamp — the client uses real tick spacing (setInterval
      // drifts 45-60ms) to time snapshot playback at true velocity.
      // Payload is a binary ArrayBuffer — see shared/netcodec.js
      //
      // Sent straight down the socket rather than via io.to(id): the room
      // form builds a BroadcastOperator plus a rooms Set and goes through the
      // adapter on every call, which at 20 casts/s × every player is pure
      // overhead for what is always a single known recipient.
      //
      // ...and *volatile*, which is the fix for the stalls this stream causes
      // on a flaky mobile link. A plain emit to a socket whose send buffer is
      // backed up (radio asleep, tunnel hiccup, the Telegram WebView
      // backgrounded) queues the packet; at 20 packets/s a few seconds of
      // that is a queue the client then receives as one flood of stale world
      // states, which is exactly what "иногда тупит" looks like from the
      // inside. Volatile drops those instead, and dropping is safe here
      // precisely because this stream is self-healing: enemies a client ends
      // up missing are re-sent in full by ENEMY_REFRESH_CASTS or pulled back
      // on demand by its own enemyResync, and players by FULL_REFRESH_TICKS.
      // Nothing to say to this player: nobody in range, no enemy moved or
      // changed inside their radius. That is the steady state for anyone
      // playing alone in a corridor, standing in the hub with the market
      // open, or idling in a menu — and it used to cost a packet anyway, 20
      // times a second, forever. Each one is TWO WebSocket frames (socket.io
      // sends a JSON envelope plus the binary attachment) of which ~79% of
      // the bytes are the envelope, and one writev syscall — measured as the
      // single largest entry in the server's CPU profile.
      //
      // One empty packet still has to go out after a non-empty one: the
      // client prunes players it stops hearing about (see the gameState
      // handler in js/network.js), so going silent immediately would freeze
      // whoever just walked out of range on their screen. After that, silence
      // until something happens — with a heartbeat every IDLE_HEARTBEAT_CASTS
      // so the clock-offset EMA keeps tracking.
      const projQ = p._projQ, aoeQ = p._aoeQ;
      const empty = playersOut.length === 0 && nearEnemies.length === 0 &&
        projQ.length === 0 && aoeQ.length === 0;
      if (empty && p._lastSentEmpty && (castId - p._lastSentAt) < IDLE_HEARTBEAT_CASTS * 2) return;
      p._lastSentEmpty = empty;
      p._lastSentAt = castId;
      // Age is stamped now, not when queued, so it measures the real wait.
      // Written in place: every recipient's cast runs inside this same tick,
      // so the value is identical for all of them and the entry can stay one
      // shared object rather than a copy per player.
      for (let i = 0; i < projQ.length; i++) projQ[i].ageMs = now - projQ[i].at;
      const sock = this._socketFor(p);
      if (sock) sock.volatile.emit('gameState',
        encodeGameState(playersOut, nearEnemies, now, undefined, projQ, aoeQ));
      projQ.length = 0;
      aoeQ.length = 0;
    });

    // Coarse dot feed for the full-map panel (the КАРТА tab), which draws the
    // player's whole current arm — far more than the AOI stream above covers.
    // Only goes to players who actually have that panel open, and only at
    // MAP_BLIP_EVERY, because it's the one thing here that is still
    // proportional to the whole world's enemy count.
    if (castId % MAP_BLIP_EVERY === 0) this._broadcastMapBlips();

    // Update delta markers after all per-player emits
    this.enemies.forEach(e => {
      if (e.hp > 0) { e._sx = e.x; e._sy = e.y; e._shp = e.hp; e._atkPulse = false; }
    });
  }

  // Buckets alive non-boss enemies by ENEMY_GRID_CELL-sized cell. Cell arrays
  // are emptied and refilled rather than reallocated — this runs 40x a second
  // over several thousand enemies, and churning that many arrays showed up as
  // GC pressure. Bosses are collected separately: they're never AOI-culled,
  // so they don't belong in a spatial lookup at all.
  _rebuildEnemyGrid() {
    const grid = this._enemyGrid;
    grid.forEach(arr => { arr.length = 0; });
    this._bossBuf.length = 0;
    const armPresent = this._armPresent;
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (e.hp <= 0) continue;
      if (e.isBoss) { this._bossBuf.push(e); continue; }
      // Same empty-arm skip as the AI loop above: nobody in that arm could
      // possibly have it inside their AOI query, so indexing it here would
      // be pure waste.
      if (this._armBounds[e.arm] && !armPresent.has(e.arm)) continue;
      const key = _gridKey(Math.floor(e.x / ENEMY_GRID_CELL), Math.floor(e.y / ENEMY_GRID_CELL));
      let cell = grid.get(key);
      if (!cell) { cell = []; grid.set(key, cell); }
      cell.push(e);
    }
  }

  // The closest player this enemy is allowed to chase, or null if there isn't
  // one worth considering. `sz` is false only for the event boss, which alone
  // may target players standing in the hub.
  //
  // This was a linear scan of every alive player, run per enemy — and with
  // AI_TARGET_SEARCH_EVERY = 4 at 40 ticks/s that is ten full player sweeps
  // per enemy per second. Across ~4500 enemies and a few hundred players it
  // works out to eight figures of distance checks a second, and it was by far
  // the largest single cost in the loop: profiling a 300-player room put the
  // AI at ~15ms of a 25ms budget, essentially all of it here, and it grew
  // strictly linearly with the player count. It is also the only part of the
  // tick that got slower purely because the game got more popular.
  //
  // Bounding the search is behaviour-preserving, not an approximation. A
  // target further than aggroR * 2.2 is already discarded by the de-aggro
  // rule immediately below the call site, which takes the same branch as
  // "no target at all" — so anything outside that radius could never have
  // survived the search anyway, and refusing to look at it costs nothing.
  _closestTargetFor(e, sz) {
    // The de-aggro threshold, plus a cell of slack. The floor matters for
    // enemies with a tiny (or zero) aggro radius, which would otherwise never
    // see anyone even standing on top of them.
    const R = Math.max((e.aggroR || 0) * 2.2, 300);
    const R2 = R * R;
    const grid = this._playerGrid;
    const cx0 = Math.floor((e.x - R) / PLAYER_GRID_CELL);
    const cx1 = Math.floor((e.x + R) / PLAYER_GRID_CELL);
    const cy0 = Math.floor((e.y - R) / PLAYER_GRID_CELL);
    const cy1 = Math.floor((e.y + R) / PLAYER_GRID_CELL);
    let closest = null, bestD2 = R2;
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const cell = grid.get(_gridKey(cx, cy));
        if (!cell) continue;
        for (let i = 0; i < cell.length; i++) {
          const p = cell[i];
          // The grid holds every player in the room, so the alive/eligible
          // filtering the old alivePlayers scan did up front happens here.
          if (p.hp <= 0 || !p.type) continue;
          if (sz && this._inSafeZone(p.x, p.y)) continue;
          if (p._invis) continue;
          // Corridor monsters only ever see their own runner; world monsters
          // never see anyone inside the tower — see _raceVisible.
          if (!this._raceVisible(p, e)) continue;
          const dx = p.x - e.x, dy = p.y - e.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2) { bestD2 = d2; closest = p; }
        }
      }
    }
    return closest;
  }

  // Player equivalent of _rebuildEnemyGrid — same empty-and-refill discipline
  // so a busy hub doesn't churn one array per occupied cell per cast.
  _rebuildPlayerGrid() {
    const grid = this._playerGrid;
    grid.forEach(arr => { arr.length = 0; });
    this.players.forEach(p => {
      const key = _gridKey(Math.floor(p.x / PLAYER_GRID_CELL), Math.floor(p.y / PLAYER_GRID_CELL));
      let cell = grid.get(key);
      if (!cell) { cell = []; grid.set(key, cell); }
      cell.push(p);
    });
  }

  // The live Socket for a player, memoised on the player record. Looked up
  // lazily rather than stored at addPlayer time so a socket that reconnects
  // under the same entry can't leave a dead reference behind, and dropped
  // again the moment it stops being connected.
  _socketFor(p) {
    const s = p._socket;
    if (s && s.connected) return s;
    const fresh = this.io.sockets.sockets.get(p.socketId) || null;
    p._socket = fresh;
    return fresh;
  }

  // socketIds of everyone close enough to (x, y) to actually see something
  // happen there, minus `exceptSocketId`. For visual-only combat fan-out:
  // projectiles, AOE rings and the crowd-control flash used to go to the whole
  // floor, and the world is a single floor — so one archer's auto-attack cost
  // one packet per player online, and the total cost of the feature grew as
  // the square of the population. Measured at 150 players firing twice a
  // second it was 37% of a CPU core on its own, more than the entire world
  // simulation. The same spatial index the broadcast already maintains answers
  // "who could possibly see this" in a couple of cell lookups.
  //
  // `lane` is the caster's _playerLaneKey(): corridors in the tower sit 200px
  // apart, well inside the radius, so without it a runner would see arrows
  // flying through the wall from the next lane over (Fear lanes are isolated
  // the same way, just via _fearLane instead). Same two-way rule as
  // everything else — see _raceVisible.
  //
  // The result buffer is reused, so callers must consume it before calling
  // again.
  nearbyPlayerIds(x, y, exceptSocketId, lane) {
    const out = this._viewerBuf;
    out.length = 0;
    const grid = this._playerGrid;
    // Cell range from the RADIUS, not the cell size: the fan-out radius is
    // wider than one cell, so a ±1 cell walk would silently miss everyone in
    // the outer ring.
    const R = VISUAL_FANOUT_R;
    const cx0 = Math.floor((x - R) / PLAYER_GRID_CELL);
    const cx1 = Math.floor((x + R) / PLAYER_GRID_CELL);
    const cy0 = Math.floor((y - R) / PLAYER_GRID_CELL);
    const cy1 = Math.floor((y + R) / PLAYER_GRID_CELL);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const cell = grid.get(_gridKey(cx, cy));
        if (!cell) continue;
        for (let i = 0; i < cell.length; i++) {
          const p = cell[i];
          if (p.socketId === exceptSocketId) continue;
          if (this._playerLaneKey(p) !== (lane ?? null)) continue;
          const dx = p.x - x, dy = p.y - y;
          if (dx * dx + dy * dy > VISUAL_FANOUT_R2) continue;
          out.push(p.socketId);
        }
      }
    }
    // A packed hub puts everyone inside the radius, which is precisely the
    // situation the radius was meant to bound — so cap the fan-out as well.
    // The cap is above PLAYER_CAP: a client is only ever streamed its 20
    // nearest players, so a projectile from someone outside that set already
    // has no visible owner on their screen. Which slice is dropped rotates per
    // call, so the same players aren't systematically the ones missing out.
    if (out.length > VISUAL_FANOUT_CAP) {
      const win = this._fanoutWin;
      win.length = 0;
      const start = this._fanoutRot++ % out.length;
      for (let i = 0; i < VISUAL_FANOUT_CAP; i++) win.push(out[(start + i) % out.length]);
      return win;
    }
    return out;
  }

  // The lane a player is currently deployed into, or null — lets server/
  // index.js scope a visual fan-out without reaching into player records.
  laneOf(socketId) {
    const p = this.players.get(socketId);
    return p ? this._playerLaneKey(p) : null;
  }

  // ── Combat visuals ────────────────────────────────────────────────────────
  // A projectile or AOE ring is dropped into the queue of every player near
  // enough to see it, and rides out with their next world cast (at most 50ms
  // later, and the entry carries its own age so the receiver can catch it up).
  //
  // This replaces a socket.io event per recipient per shot. The packet was the
  // expensive part, not the data: ~133 bytes of JSON in its own frame, 40 of
  // them a second for a player standing in a fight, which came to 28% of
  // everything they downloaded. In the cast it is 19 bytes and no packet at
  // all.
  queueProjectile(fromSocketId, proj) {
    const from = this.players.get(fromSocketId);
    if (!from) return;
    const ids = this.nearbyPlayerIds(proj.x, proj.y, fromSocketId, this._playerLaneKey(from));
    if (!ids.length) return;
    const entry = { ...proj, at: Date.now() };
    for (let i = 0; i < ids.length; i++) {
      const p = this.players.get(ids[i]);
      if (!p) continue;
      // Bounded: a cast drains the queue every 50ms, so this only ever holds
      // one interval's worth. The cap is there for the case a client's casts
      // are being dropped (volatile) while shots keep arriving.
      if (p._projQ.length >= VISUAL_QUEUE_MAX) continue;
      p._projQ.push(entry);
    }
  }

  queueAoe(fromSocketId, aoe) {
    const from = this.players.get(fromSocketId);
    if (!from) return;
    const ids = this.nearbyPlayerIds(aoe.x, aoe.y, fromSocketId, this._playerLaneKey(from));
    for (let i = 0; i < ids.length; i++) {
      const p = this.players.get(ids[i]);
      if (!p || p._aoeQ.length >= VISUAL_QUEUE_MAX) continue;
      p._aoeQ.push(aoe);
    }
  }

  // socketIds of everyone who currently has this enemy streamed to them, i.e.
  // everyone who can actually see it on screen. Combat events (enemyHurt /
  // enemyKilled) used to go to the whole floor on every single swing, so the
  // cost of one player hitting one monster scaled with the total number of
  // players online — hundreds of packets describing an enemy almost none of
  // the recipients had ever been told about. The result buffer is reused, so
  // callers must consume it before the next call.
  viewersOfEnemy(enemyId, exceptSocketId) {
    const out = this._viewerBuf;
    out.length = 0;
    this.players.forEach(p => {
      if (p.socketId === exceptSocketId) return;
      if (!p._eKnown.has(enemyId)) return;
      out.push(p.socketId);
    });
    return out;
  }

  // Fills `out` with what this one player needs to hear about this tick:
  // every boss, plus non-boss enemies within ENEMY_AOI_R. Each entry is
  // either a full record (first time THIS player is being told about it) or
  // a slim positional delta.
  //
  // The "have they already got this" bookkeeping is per player (p._eKnown)
  // rather than the room-wide tracker this used to share, because with an
  // interest radius two players no longer receive the same thing: an enemy
  // that's been streaming to someone standing next to it is brand new to
  // someone who just walked into range, and must be sent in full or their
  // client has no id/name/sprite to attach the delta to.
  _collectEnemiesFor(p, out, castId) {
    out.length = 0;
    const known = p._eKnown;

    // Bosses go to everyone regardless of distance, which needs the same
    // two-way filter as everything else: the tower's boss only to its
    // entrants, and the world's arm bosses to everyone EXCEPT them — someone
    // running a corridor has no use for a boss on the far side of the map, and
    // it only clutters their target list.
    for (let i = 0; i < this._bossBuf.length; i++) {
      const b = this._bossBuf[i];
      if (!this._raceVisible(p, b)) continue;
      this._pushEnemyEntry(b, known, out, castId);
    }

    const grid = this._enemyGrid;
    const cx0 = Math.floor((p.x - ENEMY_AOI_R) / ENEMY_GRID_CELL);
    const cx1 = Math.floor((p.x + ENEMY_AOI_R) / ENEMY_GRID_CELL);
    const cy0 = Math.floor((p.y - ENEMY_AOI_R) / ENEMY_GRID_CELL);
    const cy1 = Math.floor((p.y + ENEMY_AOI_R) / ENEMY_GRID_CELL);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const cell = grid.get(_gridKey(cx, cy));
        if (!cell) continue;
        for (let i = 0; i < cell.length; i++) {
          const e = cell[i];
          const dx = e.x - p.x, dy = e.y - p.y;
          if (dx * dx + dy * dy > ENEMY_AOI_R2) continue;
          // The corridor next door is well inside the AOI radius. Filtering
          // here is what stops the client ever seeing — and so auto-targeting
          // — a monster it cannot reach.
          if (!this._raceVisible(p, e)) continue;
          this._pushEnemyEntry(e, known, out, castId);
        }
      }
    }

    // Forget enemies this player has walked away from. Everything still in
    // range had its `seen` refreshed by the loops above, so anything left
    // behind is out of range; EKNOWN_FORGET_CASTS of slack keeps an enemy
    // hovering right on the boundary from being dropped and re-sent in full
    // every other cast.
    //
    // This has to stay strictly *quicker* to forget than the client is to
    // prune (ENEMY_AOI_R + 600, js/network.js): the server forgetting early
    // only costs one redundant full record, whereas the reverse — the server
    // still believing a player has an enemy their client already dropped —
    // sends a positional delta for something they can't apply it to, and the
    // enemy silently goes missing for them.
    known.forEach((k, id) => { if (castId - k.seen >= EKNOWN_FORGET_CASTS) known.delete(id); });
  }

  _pushEnemyEntry(e, known, out, castId) {
    const k = known.get(e.id);
    // castId advances two per cast (casts run every other tick), so halve it
    // before the stagger — on the raw value an enemy with an odd _idx would
    // never satisfy the modulo and would never be refreshed at all.
    const stale = ((castId >> 1) + (e._idx || 0)) % ENEMY_REFRESH_CASTS === 0;
    if (!k || stale) {
      out.push(_fullEnemyEntry(e));
      known.set(e.id, { x: e.x, y: e.y, hp: e.hp, aggro: e.aggro, seen: castId });
      return;
    }
    k.seen = castId;
    // An aggro'd enemy is re-sent every cast even when it hasn't actually
    // moved. That looks wasteful, but the client runs its own copy of the
    // chase AI between packets (js/game.js) and its aggro test is a plain
    // distance check with no line-of-sight and no safe-zone rule — so it
    // will happily push an enemy the server is deliberately holding still.
    // The stream of authoritative positions is what keeps that prediction
    // reconciled; without it the client walks the enemy forward, the
    // correction snaps it back, and it jogs on the spot with its run
    // animation stuck on. Only enemies actually chasing someone within this
    // player's radius pay for it, which is a small fraction of the world.
    //
    // Everything else is compared against what was last sent to THIS player,
    // which also covers the cases the old code needed an explicit _shp = -1
    // poke for (leash teleport, respawn): those move the enemy or change its
    // hp, so they fall out of this same check.
    if (!e.aggro && !e._atkPulse && e.hp === k.hp && e.aggro === k.aggro &&
        Math.abs(e.x - k.x) <= 0.5 && Math.abs(e.y - k.y) <= 0.5) return;
    out.push({
      id: e.id, idx: e._idx, x: e.x, y: e.y, hp: e.hp, aggro: e.aggro,
      atkAnimTimer: e._atkPulse ? e.atkAnimTimer : 0,
    });
    k.x = e.x; k.y = e.y; k.hp = e.hp; k.aggro = e.aggro;
  }

  // Every alive non-boss enemy as a flat Int16 tile-coordinate pair list.
  // ~4500 enemies is ~18KB, which is why only players with the map panel
  // actually open get it, at MAP_BLIP_EVERY. Bosses are left out: they're in
  // the normal stream from anywhere, so the panel's skull markers already
  // have them.
  _broadcastMapBlips() {
    let any = false;
    this.players.forEach(p => { if (p._mapOpen) any = true; });
    if (!any) return;
    // Built per arm, and only for the arms someone is actually looking at.
    // The panel draws the viewer's own arm, so the other three were never
    // going to be rendered — and the tower's 3600 corridor monsters were
    // being sent to everyone even though _raceVisible forbids showing them
    // outside a race. That was ~7100 dots (14KB) a second per viewer where
    // ~900 (3.6KB) is the whole truth.
    // Keyed by arm, and inside the tower by lane as well: a runner may only
    // ever see their own corridor (see _raceVisible), so sending them all
    // RACE10_LANES corridors at once would be both wrong and the single
    // biggest packet in the game.
    const cache = new Map();
    const bufFor = (arm, lane) => {
      const key = (arm === 'race10' || arm === 'fear') ? `${arm}#${lane}` : arm;
      let b = cache.get(key);
      if (b !== undefined) return b;
      const want = e => e.hp > 0 && !e.isBoss && e.arm === arm &&
        ((arm !== 'race10' && arm !== 'fear') || e.lane == null || e.lane === lane);
      let n = 0;
      for (let i = 0; i < this.enemies.length; i++) if (want(this.enemies[i])) n++;
      const buf = new Int16Array(n * 2);
      let o = 0;
      for (let i = 0; i < this.enemies.length; i++) {
        const e = this.enemies[i];
        if (!want(e)) continue;
        buf[o++] = Math.round(e.x / TILE);
        buf[o++] = Math.round(e.y / TILE);
      }
      cache.set(key, buf.buffer);
      return buf.buffer;
    };
    // Which arm a viewer is standing in — the same Y-band test the tick uses.
    const armAt = y => {
      for (let i = 0; i < ARM_NAMES.length; i++) {
        const b = this._armBounds[ARM_NAMES[i]];
        if (b && y >= b.y0 && y < b.y1) return ARM_NAMES[i];
      }
      return null;
    };
    this.players.forEach(p => {
      if (!p._mapOpen) return;
      const arm = p._raceLane != null ? 'race10' : (p._fearLane != null ? 'fear' : armAt(p.y));
      // In the hub (or anywhere outside an arm) there are no regular monsters
      // to plot, so there is nothing to send at all.
      if (!arm) return;
      // Volatile for the same reason gameState is: a dot dump is the last
      // thing that should be queuing up behind a stalled client, and the next
      // one is a second away regardless.
      const sock = this._socketFor(p);
      if (sock) sock.volatile.emit('mapBlips', bufFor(arm, arm === 'fear' ? p._fearLane : p._raceLane));
    });
  }

  setMapOpen(socketId, open) {
    const p = this.players.get(socketId);
    if (p) p._mapOpen = !!open;
  }

  // Called when an enemy leaves the world for good (event boss looted, arena
  // guards despawned). Its per-player entries would be swept a second later
  // anyway once they stopped being refreshed, but dropping them here keeps
  // "known" meaning strictly "exists and I've told them about it".
  _forgetEnemy(id) {
    this.players.forEach(p => p._eKnown.delete(id));
  }

  addPlayer(socketId, username, clanName, clanIcon, clanAtkBonus, telegramId) {
    // A reconnect (network blip, backgrounded tab) can occasionally leave the
    // old socket's entry in this room a moment longer than its own disconnect
    // cleanup takes to land — the new connection would then render as a
    // second, ghost copy of the same player until the stale entry's eventual
    // disconnect fires. Since every reconnect re-authenticates with the same
    // telegramId, proactively drop any existing entry for that account here
    // rather than relying solely on the old socket's own cleanup timing.
    // Returns the removed stale socketId (if any) so the caller can also
    // tell other clients to drop it immediately, instead of waiting for its
    // disconnect event.
    let staleSocketId = null;
    if (telegramId) {
      for (const [sid, p] of this.players) {
        if (sid !== socketId && p.telegramId === telegramId) { staleSocketId = sid; break; }
      }
      if (staleSocketId) this.removePlayer(staleSocketId);
    }
    const spawn = this._dungeon.spawn;
    this.players.set(socketId, {
      socketId, username, type: null, telegramId: telegramId || null,
      clanName: clanName || null, clanIcon: clanIcon || null, clanAtkBonus: clanAtkBonus || 0,
      x: spawn.x, y: spawn.y, facing: 'front', moving: false,
      hp: 200, maxHp: 200, atk: 5, def: 5,
      pvpMode: false, lastAtkSeq: 0,
      _raceLane: null,
      _fearLane: null,
      _known: new Map(),
      // Enemies already streamed to this player: id -> last {x,y,hp,aggro}
      // sent, plus the cast it was last in range for. See _collectEnemiesFor.
      _eKnown: new Map(),
      _mapOpen: false,
      // Idle-stream bookkeeping — see the `empty` check in _tick. Starting
      // "not empty" guarantees the first cast after joining is always sent.
      _lastSentEmpty: false,
      _lastSentAt: 0,
      // Combat visuals waiting for this player's next cast — see
      // queueProjectile/queueAoe.
      _projQ: [],
      _aoeQ: [],
      // Memoised live Socket — see _socketFor.
      _socket: null,
      _profileRev: 1, _seq: ++this._pSeq,
    });
    if (this.players.size === 1) this._startLoop();
    return { spawn, staleSocketId };
  }

  setPlayerClan(socketId, clanName, clanIcon, clanAtkBonus) {
    const p = this.players.get(socketId);
    if (!p) return;
    p.clanName = clanName || null;
    p.clanIcon = clanIcon || null;
    p.clanAtkBonus = clanAtkBonus || 0;
    p._profileRev++;
  }

  setPlayerPvpMode(socketId, mode) {
    const p = this.players.get(socketId);
    if (p && p.pvpMode !== !!mode) { p.pvpMode = !!mode; p._profileRev++; }
  }

  pvpAttack(attackerSocketId, targetSocketId) {
    const attacker = this.players.get(attackerSocketId);
    const target = this.players.get(targetSocketId);
    if (!attacker || !target) return null;
    if (!attacker.pvpMode) return null;
    if (attacker.hp <= 0) return null;
    if (target.hp <= 0) return null;
    if (this._inSafeZone(attacker.x, attacker.y)) return null;
    if (this._inSafeZone(target.x, target.y)) return null;
    const dx = attacker.x - target.x, dy = attacker.y - target.y;
    if (dx * dx + dy * dy > 500 * 500) return null;
    const base = Math.max(1, attacker.atk - (target.def || 0) + Math.floor(Math.random() * 7) - 3);
    const { dmg, isCrit } = _critDmg(base, attacker.critChance, attacker.critPower);
    attacker.lastAtkSeq = (attacker.lastAtkSeq || 0) + 1;
    // Apply the damage to the authoritative server-side HP right here — the
    // target's client used to self-report "actual damage taken" afterwards
    // (pvpDamageTaken), which a modified client could always report as 0 to
    // become unkillable in PvP while still dealing full damage to others.
    target.hp = Math.max(0, target.hp - dmg);
    return { dmg, isCrit, x: target.x, y: target.y, hp: target.hp };
  }

  pvpSkillAttack(attackerSocketId, targetSocketId, multiplier) {
    const attacker = this.players.get(attackerSocketId);
    const target = this.players.get(targetSocketId);
    if (!attacker || !target) return null;
    if (!attacker.pvpMode) return null;
    if (attacker.hp <= 0) return null;
    // Same server-side floor as skillAttackEnemy — and it matters more here:
    // this handler doesn't go through the attack limiter in server/index.js at
    // all, so it sat in the 300 events/s bucket with a ×10 multiplier, which
    // is an instant kill on anyone. See SKILL_BURST_MS above for why this
    // isn't a flat per-hit gate.
    const _nowCd = Date.now();
    const _castStart = attacker._lastSkillAtk || 0;
    if (_nowCd - _castStart > SKILL_BURST_MS) {
      if (_nowCd - _castStart < SKILL_CD_MS) return null;
      attacker._lastSkillAtk = _nowCd;
    }
    if (target.hp <= 0) return null;
    if (this._inSafeZone(attacker.x, attacker.y)) return null;
    if (this._inSafeZone(target.x, target.y)) return null;
    const dx = attacker.x - target.x, dy = attacker.y - target.y;
    if (dx * dx + dy * dy > 600 * 600) return null;
    const mult = Math.max(1, Math.min(10, multiplier || 1));
    const base = Math.max(1, Math.round(attacker.atk * mult) - (target.def || 0) + Math.floor(Math.random() * 7) - 3);
    const { dmg, isCrit } = _critDmg(base, attacker.critChance, attacker.critPower);
    attacker.lastAtkSeq = (attacker.lastAtkSeq || 0) + 1;
    target.hp = Math.max(0, target.hp - dmg);
    return { dmg, isCrit, x: target.x, y: target.y, hp: target.hp };
  }

  removePlayer(socketId) {
    this.players.delete(socketId);
    this.players.forEach(p => p._known.delete(socketId));
    if (this.players.size === 0) this._stopLoop();
  }

  setPlayerChar(socketId, type, savedStats = null) {
    const p = this.players.get(socketId);
    if (!p) return;
    const cd = CHAR_DEF[type];
    if (!cd) return;
    p.type = type;
    p.pvpMode = false;
    p._profileRev++;
    if (savedStats) {
      const s = computeStats(savedStats, cd, type, p.clanAtkBonus);
      p.atk        = s.atk;
      p.def        = s.def;
      p.maxHp      = s.maxHp;
      p.critChance = s.critChance;
      p.critPower  = s.critPower;
      // hp === 0 is meaningful (the player died) and must not be confused with
      // "no hp in this save" — a truthy check treated 0 as missing data and
      // handed back a full heal, so anyone who reconnected (a backgrounded
      // tab getting suspended mid-session, a network blip) while dead, or
      // logged back in having quit during the death screen, resumed at full
      // HP with no death ever recorded.
      p.hp    = (savedStats.hp != null) ? Math.max(0, Math.min(savedStats.hp, p.maxHp)) : p.maxHp;
      p.lvl   = savedStats.lvl || 1;
      // Kept fresh via updatePlayerSavedData() (called on every saveProgress)
      // so statsUpdate can always re-derive a true base from up-to-date
      // equipment/upgrades instead of trusting the client's own numbers.
      p._sd = savedStats;
      p.petId = _petIdOf(savedStats);
    } else {
      p.hp = p.maxHp = cd.baseHP;
      p.atk = cd.baseAtk;
      p.def = cd.baseDef;
      p._sd = {};
      p.petId = null;
    }
  }

  // Called on every saveProgress — keeps p._sd (the basis for statsUpdate's
  // true-base recomputation) in sync with the player's actual equipment/
  // upgrades/level without waiting for the next character (re)selection.
  // Returns true when the equipped pet changed, so the caller knows to tell
  // the other clients (pets are broadcast as their own small event rather
  // than as a gameState field — see the playerPet handler in server/index.js).
  updatePlayerSavedData(socketId, sd) {
    const p = this.players.get(socketId);
    if (!p) return false;
    p._sd = sd || {};
    const petId = _petIdOf(p._sd);
    if (petId === p.petId) return false;
    p.petId = petId;
    return true;
  }

  // socketId -> equipped pet id, for everyone in the room who has one. Sent
  // to a player as they join so they see the pets that are already out,
  // instead of only ones equipped after they arrived.
  petSnapshot() {
    const out = [];
    this.players.forEach(p => { if (p.petId) out.push({ id: p.socketId, petId: p.petId }); });
    return out;
  }

  updatePlayerPos(socketId, x, y, facing, moving) {
    const p = this.players.get(socketId);
    if (!p) return;
    // A dead player's own client can keep sending playerMove (e.g. its "you
    // died" flow never ran because the tab was backgrounded for the fatal
    // hit) — without this, the server kept applying it, so the player could
    // walk and fight normally while every other client correctly rendered
    // them as dead (hp stuck at 0, since nothing ever prompted a respawn).
    //
    // Refusing the move alone left that split permanent, though: hp<=0 also
    // makes syncPlayerHp/healPlayer no-ops, and only a client-sent 'respawn'
    // clears it — which a client that never noticed it died will never send.
    // The player kept playing while everyone else saw a frozen corpse until
    // they happened to reconnect. So re-announce the death (throttled, it
    // arrives once per second at most) until their client acts on it.
    if (p.hp <= 0) {
      const now = Date.now();
      if (now - (p._deathResendAt || 0) >= 1000) {
        p._deathResendAt = now;
        this.io.to(socketId).emit('playerHurt', { id: socketId, hp: 0 });
      }
      return;
    }
    // Non-finite values are refused: Math.floor(NaN) is NaN, which drops the
    // player out of the spatial grid entirely (invisible to everyone,
    // untargetable by enemy AI) and poisons every distance comparison. This is
    // not a movement rule — it's the guard that stops one malformed packet
    // corrupting room state.
    //
    // There is deliberately NO distance/speed check here. Movement is
    // client-authoritative in this game, and the world's own teleport pads move
    // the player tens of thousands of pixels through this very function (see
    // _updateTeleportPads, js/game.js), so any cap has to carve them out — and
    // the version that didn't took the game down in production. The exemption
    // was written and tested, then removed again by choice: teleport-hacking is
    // worth less than the risk of a movement rule mis-firing on real players.
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    // undefined means a client still running the pre-authoritative-flag
    // bundle (mid-rollout, tab open since before the deploy) — its 'mv'
    // packet has no 5th element at all. Leaving p.moving untouched in that
    // case sticks it at whatever it was when the connection started (false,
    // set at spawn) for as long as that tab stays open: position keeps
    // updating normally, but every other client reads a permanent 'idle'
    // for a player who is plainly running. Fall back to inferring it from
    // the position change since the last packet instead — the same idea the
    // client used to do, but on two known-good, un-buffered points 25ms
    // apart rather than through the render-side interpolation lag.
    if (moving === undefined) {
      const ddx = x - p.x, ddy = y - p.y;
      moving = (ddx * ddx + ddy * ddy) > 0.1;
    }
    p.x = x; p.y = y; p.facing = facing; p.moving = moving;
  }

  syncPlayerHp(socketId, clientHp) {
    const p = this.players.get(socketId);
    if (!p || p.hp <= 0) return;
    if (!Number.isFinite(clientHp)) return;
    const requested = Math.min(p.maxHp, Math.max(0, clientHp));
    // Decreases are always trusted immediately — they can never help a
    // cheater. Increases (passive HP regen ticking up between potions/heals)
    // are rate-limited to MAX_HP_REGEN_PER_SEC instead of being applied
    // outright — otherwise a modified client could report hp:maxHp on every
    // movement packet and become unkillable (this is also what would have
    // silently undone the server-applied PvP damage in pvpAttack/
    // pvpSkillAttack below). Real heals (potions, faithShield/party heal,
    // respawn) all go through their own dedicated methods and aren't gated
    // by this at all.
    if (requested <= p.hp) { p.hp = requested; p._lastHpSyncAt = Date.now(); return; }
    const now = Date.now();
    const elapsed = Math.max(0, (now - (p._lastHpSyncAt || now)) / 1000);
    p._lastHpSyncAt = now;
    p.hp = Math.min(requested, p.hp + elapsed * MAX_HP_REGEN_PER_SEC, p.maxHp);
  }

  // Every heal path funnels through here and healPartyMember below, so this is
  // the one place that has to refuse a non-finite amount: NaN written to hp is
  // absorbing (all later comparisons, including the `hp <= 0` death check,
  // return false) and would leave the player alive but unkillable. Callers
  // validate too — this is the backstop so a future one can't reintroduce it.
  healPlayer(socketId, amount) {
    const p = this.players.get(socketId);
    if (!p || p.hp <= 0) return;
    if (!Number.isFinite(amount)) return;
    p.hp = Math.min(p.maxHp, p.hp + Math.max(0, amount));
  }

  respawnPlayer(socketId) {
    const p = this.players.get(socketId);
    if (!p) return;
    p.hp = p.maxHp;
    p.x = this._dungeon.spawn.x;
    p.y = this._dungeon.spawn.y;
  }

  // ── Death Battle (Битва на смерть) ────────────────────────────────────────
  // Drops every entrant onto its own point of a ring inside the event arena —
  // the one room in the world that is sealed off and outside the hub's safe
  // zone, so PvP works there and nobody can wander in mid-round. Everyone is
  // healed and flipped into PvP here rather than client-side: the server owns
  // hp and pvpMode, and a client that ignored the request would otherwise be
  // an unkillable participant.
  deathBattleDeploy(socketIds) {
    const ar = this._dungeon.arena;
    if (!ar) return [];
    const placed = [];
    const n = Math.max(1, socketIds.length);
    // Arena is 40 tiles across; 13 tiles from the centre keeps the whole ring
    // clear of the walls whatever the entrant count.
    const R = 13 * TILE;
    socketIds.forEach((sid, i) => {
      const p = this.players.get(sid);
      if (!p) return;
      // Remembered so dbReturnToPrevSpot can send this entrant back to
      // wherever they actually were instead of the shared hub spawn
      // deathBattleReturn always uses (arena3/race10 never set this).
      p._dbPrevX = p.x; p._dbPrevY = p.y;
      const ang = (i / n) * Math.PI * 2;
      let x = ar.cx + Math.cos(ang) * R;
      let y = ar.cy + Math.sin(ang) * R;
      if (this._isWall(x, y)) { x = ar.cx; y = ar.cy; }
      p.x = x; p.y = y;
      p.hp = p.maxHp;
      p.pvpMode = true;
      p._profileRev++;
      placed.push({ socketId: sid, x, y, hp: p.hp });
    });
    return placed;
  }

  // Death-battle-only sibling of deathBattleReturn (above): sends this
  // entrant back to wherever they were standing right before deployment
  // (saved on p._dbPrevX/Y by deathBattleDeploy) instead of the fixed hub
  // spawn — arena3 and race10 keep using deathBattleReturn/the hub spawn
  // unchanged. Falls back to the hub spawn if no saved spot exists (e.g.
  // this socket was never actually deployed), so it never leaves a player
  // stranded with an undefined position.
  dbReturnToPrevSpot(socketId) {
    const p = this.players.get(socketId);
    if (!p) return null;
    if (p._dbPrevX != null && p._dbPrevY != null) {
      p.x = p._dbPrevX;
      p.y = p._dbPrevY;
    } else {
      p.x = this._dungeon.spawn.x;
      p.y = this._dungeon.spawn.y;
    }
    p._dbPrevX = null;
    p._dbPrevY = null;
    p.pvpMode = false;
    p._raceLane = null;
    if (p._fearLane != null) { this.fearReleaseLane(p._fearLane); p._fearLane = null; }
    p._profileRev++;
    return { x: p.x, y: p.y };
  }

  // Places a 3v3 match: one side per base, one player per lane, full HP and
  // PvP on. Returns what was actually placed so the caller only counts players
  // who really made it in. Falls back to the arena centre if a lane spawn ever
  // lands on a wall, so a map tweak can't strand someone inside geometry.
  pvpArenaDeploy(teamA, teamB) {
    const ar = this._dungeon.pvpArena;
    if (!ar) return [];
    const placed = [];
    const put = (ids, spots, team) => {
      ids.forEach((sid, i) => {
        const p = this.players.get(sid);
        if (!p) return;
        const spot = spots[i % spots.length];
        let x = spot.x, y = spot.y;
        if (this._isWall(x, y)) { x = ar.cx; y = ar.cy; }
        p.x = x; p.y = y;
        p.hp = p.maxHp;
        p.pvpMode = true;
        p._profileRev++;
        placed.push({ socketId: sid, x, y, hp: p.hp, team });
      });
    };
    put(teamA, ar.teamA, 'A');
    put(teamB, ar.teamB, 'B');
    return placed;
  }

  // Places a race10 entrant into their own lane's spawn point (array index =
  // lane number), full HP, normal PvE combat (no pvpMode — this event has no
  // player-vs-player component at all). Falls back to the shared boss room if
  // a lane spawn ever lands on a wall.
  raceDeploy(socketIds) {
    const race = this._dungeon.race10;
    if (!race) return [];
    const placed = [];
    // One lane per entrant, never shared: two players in the same corridor
    // would fight the same monsters and re-create exactly the cross-lane mess
    // the isolation above removes. The caller caps the list at lanes.length.
    socketIds.slice(0, race.lanes.length).forEach((sid, i) => {
      const p = this.players.get(sid);
      if (!p) return;
      const spot = race.lanes[i];
      let x = spot.x, y = spot.y;
      if (this._isWall(x, y)) { x = race.boss.x; y = race.boss.y; }
      p.x = x; p.y = y;
      p.hp = p.maxHp;
      // Their lane for as long as the run lasts — read by _raceVisible on both
      // the targeting and the streaming side. Cleared when they leave, in
      // deathBattleReturn (every exit path goes through it) and removePlayer.
      p._raceLane = i;
      p._profileRev++;
      placed.push({ socketId: sid, x, y, hp: p.hp, lane: i });
    });
    this._raceActive = placed.length > 0;
    return placed;
  }

  // Spawns the single shared race10 boss — same identity/stats as the world
  // EVENT_BOSS (full HP, normal aggro/attack AI included — unlike the 3v3
  // guard boss this one actually fights back). ignoresSafeZone carries over
  // from the spread for the same reason the real one needs it: the shared
  // room is big enough that players kiting it would otherwise trip the
  // 420px leash and reset its HP mid-race. raceBoss marks it so the tick
  // loop's hp<=0 branch skips the event-boss loot-drop-and-purge behavior
  // below (see that guard) — server/index.js ends the race and despawns it
  // itself the moment the kill lands.
  spawnRaceBoss() {
    const race = this._dungeon.race10;
    if (!race || !race.boss) return null;
    const { x, y } = race.boss;
    const e = {
      id: `race10boss_${Date.now()}`,
      ...EVENT_BOSS,
      eid: 'race10_boss',
      maxHp: EVENT_BOSS.hp, hp: EVENT_BOSS.hp,
      arm: 'race10', rlvl: 0,
      x, y, spawnX: x, spawnY: y,
      atkTimer: 1, hurtTimer: 0, atkAnimTimer: 0,
      aggro: false, aggroR: 900,
      raceBoss: true,
      // Holds its ground in the middle of the shared room instead of chasing.
      // Unlike the 3v3 guard bosses (a3Passive) it is NOT inert: it still
      // aggros and still hits whoever comes into reach — see the stationary
      // branch in _tick. Chasing made it drag the fight back down whichever
      // corridor it happened to pick, which is neither fair to that runner nor
      // to the ones it walked away from.
      stationary: true,
      _sx: x, _sy: y, _shp: EVENT_BOSS.hp,
      _idx: this.enemies.length,
    };
    this.enemies.push(e);
    this._enemyMap.set(e.id, e);
    this._raceBossId = e.id;
    return e.id;
  }

  // Removes the race10 boss (dead or still standing) once the race ends.
  despawnRaceBoss() {
    // Also the end of the race as far as the tick loop is concerned: corridor
    // monsters go back to being skipped entirely (see the race10 branch in
    // _tick). Called from _race10Finish on every ending — win, timeout or
    // nobody left standing.
    this._raceActive = false;
    if (!this._raceBossId) return;
    const id = this._raceBossId;
    this.enemies = this.enemies.filter(e => {
      if (e.id !== id) return true;
      this._enemyMap.delete(e.id);
      this._forgetEnemy(e.id);
      return false;
    });
    this.enemies.forEach((e, i) => { e._idx = i; });
    this._raceBossId = null;
  }

  // Revives every race10 corridor monster to full HP at its spawn point.
  // Called once per race, right before deploying entrants (server/index.js
  // _race10Deploy) — race10 monsters never respawn on their own (see the
  // tick loop's hp<=0 branch below), so without this the second race of the
  // day would find every lane already cleared out by the first one.
  resetRaceMonsters() {
    this.enemies.forEach(e => {
      if (e.arm !== 'race10') return;
      e.hp = e.maxHp;
      e.x = e.spawnX; e.y = e.spawnY;
      e.aggro = false; e.atkTimer = 1 + Math.random(); e.hurtTimer = 0;
      e.stunTimer = 0; e.slowTimer = 0;
      e._shp = -1;
      delete e.respawnTimer;
    });
  }

  // Spawns the two stationary guard bosses for a 3v3 match — same identity as
  // the world EVENT_BOSS, but ARENA3_BOSS_HP and no loot. a3Team marks which
  // side owns each one (that team can't damage it — see the a3Team check in
  // server/index.js's attack/skillAttack handlers); a3Passive tells the AI
  // tick loop to skip it entirely, so it never moves, aggros or attacks.
  // Returns { A: bossId, B: bossId } for the caller to hand to both clients.
  spawnPvpArenaBosses() {
    const ar = this._dungeon.pvpArena;
    if (!ar || !ar.bossA || !ar.bossB) return null;
    const mk = (spot, team) => {
      const e = {
        id: `a3boss_${team}_${Date.now()}`,
        ...EVENT_BOSS,
        // Own eid (not EVENT_BOSS's demon_event_boss) — the client keys the
        // world event boss's HP-bar overlay and alive-tracking off that exact
        // string (js/ui.js updateEventBossHpBar), and this boss sharing it
        // would show up there too. Its sprite entry (js/sprites.js
        // arena3_guard_boss) points at the identical sheets, so it still
        // looks the same.
        eid: 'arena3_guard_boss',
        arm: 'a3', rlvl: 0,
        atk: 0, spd: 0,
        maxHp: ARENA3_BOSS_HP, hp: ARENA3_BOSS_HP,
        x: spot.x, y: spot.y, spawnX: spot.x, spawnY: spot.y,
        atkTimer: 1, hurtTimer: 0, atkAnimTimer: 0,
        aggro: false, aggroR: 0,
        a3Team: team, a3Passive: true,
        _sx: spot.x, _sy: spot.y, _shp: ARENA3_BOSS_HP,
        _idx: this.enemies.length,
      };
      this.enemies.push(e);
      this._enemyMap.set(e.id, e);
      return e;
    };
    const bossA = mk(ar.bossA, 'A');
    const bossB = mk(ar.bossB, 'B');
    this._a3BossIds = { A: bossA.id, B: bossB.id };
    return this._a3BossIds;
  }

  // Removes whatever's left of the two guard bosses — called once a match
  // ends, win or wedge, so a leftover boss (dead or still standing) never
  // lingers into the next match.
  despawnPvpArenaBosses() {
    if (!this._a3BossIds) return;
    const ids = new Set([this._a3BossIds.A, this._a3BossIds.B]);
    this.enemies = this.enemies.filter(e => {
      if (!ids.has(e.id)) return true;
      this._enemyMap.delete(e.id);
      this._forgetEnemy(e.id);
      return false;
    });
    this.enemies.forEach((e, i) => { e._idx = i; });
    this._a3BossIds = null;
  }

  // Sends a player back to the hub with PvP off — shared exit path for
  // arena3, race10 and Fear (eliminated, the match/wave-run finishing, the
  // round ending under them). The death battle uses its own
  // dbReturnToPrevSpot instead (below) so its entrants land back where they
  // actually were rather than the hub. Returns the landing spot so the
  // caller can tell that client. Clears the tower lane (and releases a Fear
  // lane, if any) as well as the PvP flag — leaving either set would keep
  // the player invisible to ordinary world monsters (and them to it) for the
  // rest of the session, since that is exactly what _raceVisible keys on.
  deathBattleReturn(socketId) {
    const p = this.players.get(socketId);
    if (!p) return null;
    p.x = this._dungeon.spawn.x;
    p.y = this._dungeon.spawn.y;
    p.pvpMode = false;
    p._raceLane = null;
    if (p._fearLane != null) { this.fearReleaseLane(p._fearLane); p._fearLane = null; }
    p._profileRev++;
    return { x: p.x, y: p.y };
  }

  updatePlayerStats(socketId, { atk, def, maxHp, critChance, critPower }) {
    const p = this.players.get(socketId);
    if (!p) return;
    const cd = CHAR_DEF[p.type];
    if (!cd) return;
    // Anchor the accepted stats to a value the server can independently
    // derive from the player's own already-sanitized saved equipment/
    // upgrades/level (see computeStats), not to whatever this same client
    // claimed last time — a self-referential cap ("min(x, prev*1.5+100)")
    // ratchets up to its ceiling in ~10 calls regardless of what prev
    // actually was, since the client controls prev too.
    const trueBase = computeStats(p._sd || {}, cd, p.type, p.clanAtkBonus);
    if (atk  >  0) p.atk  = Math.min(atk,  trueBase.atk * STAT_BUFF_HEADROOM);
    if (def  >= 0) p.def  = Math.min(def,  trueBase.def * STAT_BUFF_HEADROOM);
    if (maxHp > 0) {
      const cap = Math.min(maxHp, trueBase.maxHp * HP_BUFF_HEADROOM);
      p.hp = Math.min(p.hp, cap);
      if (p.maxHp !== cap) { p.maxHp = cap; p._profileRev++; }
    }
    // No skill or item in the game grants a temporary crit bonus — always
    // the server-derived truth, never whatever the client claims.
    p.critChance = trueBase.critChance;
    p.critPower  = trueBase.critPower;
  }

  // Answers the "view profile" (Инфо button) request entirely server-side —
  // see requestPlayerProfile, server/index.js. Deriving straight from this
  // player's own already-validated p._sd (kept in sync by
  // updatePlayerSavedData on every saveProgress) means it never depends on
  // the target's own client being responsive, unlike an earlier version that
  // asked their client to answer and could go unanswered indefinitely. Both
  // players are guaranteed to be in this same Room already — the requester
  // can only ever target someone currently rendered in their own AOI.
  publicProfile(socketId) {
    const p = this.players.get(socketId);
    if (!p) return null;
    const cd = CHAR_DEF[p.type] || {};
    const sd = p._sd || {};
    const stats = computeStats(sd, cd, p.type, p.clanAtkBonus);
    const equipment = {};
    Object.entries(sd.equipment || {}).forEach(([slot, it]) => {
      if (!it) return;
      equipment[slot] = {
        name: it.name, img: it.img || null, icon: it.icon || null, rarity: it.rarity || null,
        enhance: it.enhance || 0,
        atk: it.atk || 0, def: it.def || 0, hp: it.hp || 0,
        critChance: it.critChance || 0, atkSpeed: it.atkSpeed || 0, hpPct: it.hpPct || 0,
      };
    });
    return {
      name: p.username, charIcon: cd.icon || null, charColor: cd.color || null, className: cd.name || p.type,
      lvl: p.lvl, upgrades: sd.upgrades || {},
      hp: Math.ceil(p.hp), maxHp: stats.maxHp,
      atk: stats.atk, def: stats.def, atkSpeed: stats.atkSpeed,
      critChance: stats.critChance, critPower: stats.critPower, hpRegen: stats.hpRegen,
      equipment,
    };
  }

  attackEnemy(socketId, enemyId) {
    const attacker = this.players.get(socketId);
    // Same reasoning as updatePlayerPos above — a dead attacker's client can
    // keep firing attack events; the server must independently refuse them.
    if (!attacker || attacker.hp <= 0) return null;
    // Rate-limit: max one server hit every 150ms
    const now = Date.now();
    if (now - (attacker._lastAtk || 0) < 150) return null;
    attacker._lastAtk = now;
    const enemy = this._enemyMap.get(enemyId); // O(1) Map lookup
    if (!enemy || enemy.hp <= 0) return null;
    // Range check: must be within 350px of the enemy's BODY (generous for AoE
    // skills). enemy.size is added because this is measured to its centre —
    // without it a large enemy shrinks the usable window by its own radius,
    // which rejected hits on the size-165 event boss.
    const rdx = attacker.x - enemy.x, rdy = attacker.y - enemy.y;
    const _reach = 350 + (enemy.size || 0);
    if (rdx * rdx + rdy * rdy > _reach * _reach) return null;
    if (!this._hasLOS(attacker.x, attacker.y, enemy.x, enemy.y)) return null;
    const base = Math.max(1, attacker.atk - enemy.def + Math.floor(Math.random() * 7) - 3);
    const { dmg, isCrit } = _critDmg(base, attacker.critChance, attacker.critPower);
    attacker.lastAtkSeq = (attacker.lastAtkSeq || 0) + 1;
    enemy.hp = Math.max(0, enemy.hp - dmg);
    enemy.aggro = true;
    if (enemy.hp <= 0) {
      // 3v3 guard boss: no xp/gold/loot, just enough (ex/ey/color) for the
      // caller to still show the death visually — it ends the match off
      // a3Team instead of running the normal kill-reward flow.
      if (enemy.a3Team) return { killed: true, dmg, isCrit, a3Team: enemy.a3Team, ex: enemy.x, ey: enemy.y, color: enemy.color };
      // Race10 boss: no xp/gold/loot either — server/index.js tallies dmg per
      // attacker across every hit (not just this killing one) to decide the
      // race's winner, so raceBoss has to come back on non-kills too (below).
      if (enemy.raceBoss) return { killed: true, dmg, isCrit, raceBoss: true, ex: enemy.x, ey: enemy.y, color: enemy.color };
      const g = calcGoldDrop(enemy);
      // Assigned right here rather than left for the AI tick loop to notice
      // next frame — that gap is what forced an earlier version to guess an
      // independent random ETA for the immediate bossStatus broadcast
      // (server/index.js), which could disagree with what the tick loop
      // then actually assigned.
      let respawnAt;
      if (enemy.isBoss) {
        enemy.respawnTimer = _bossRespawnSecs();
        respawnAt = Date.now() + enemy.respawnTimer * 1000;
        if (this._onBossDeath) this._onBossDeath(enemy.arm, respawnAt);
      }
      return { killed: true, xp: enemy.xp, gold: g, dmg, isCrit, ex: enemy.x, ey: enemy.y, color: enemy.color, isBoss: !!enemy.isBoss, eid: enemy.eid, rlvl: enemy.rlvl || 0, arm: enemy.arm, lane: enemy.lane, respawnAt };
    }
    if (enemy.raceBoss) return { killed: false, hp: enemy.hp, dmg, isCrit, raceBoss: true };
    return { killed: false, hp: enemy.hp, dmg, isCrit };
  }

  skillAttackEnemy(socketId, enemyId, multiplier) {
    const attacker = this.players.get(socketId);
    if (!attacker) return null;
    // Dead attackers can't cast — attackEnemy has refused this for basic hits
    // for the same reason (a client that never noticed it died keeps firing).
    if (attacker.hp <= 0) return null;
    // Real skill cooldowns (12–20s) live in the client, which makes them
    // advisory. This is the server's own floor: without it the only limit was
    // the socket-level 20 events/s, and each of those can carry a ×10
    // multiplier — roughly thirty times the intended damage output. SKILL_CD_MS
    // is far below any real cooldown, so legitimate play never reaches it; it
    // exists purely to bound a modified client. See SKILL_BURST_MS above for
    // why one AOE cast's several hits don't gate each other.
    const now = Date.now();
    const castStart = attacker._lastSkillAtk || 0;
    if (now - castStart > SKILL_BURST_MS) {
      if (now - castStart < SKILL_CD_MS) return null;
      attacker._lastSkillAtk = now;
    }
    const enemy = this._enemyMap.get(enemyId);
    if (!enemy || enemy.hp <= 0) return null;
    const rdx = attacker.x - enemy.x, rdy = attacker.y - enemy.y;
    if (rdx * rdx + rdy * rdy > 600 * 600) return null;
    if (!this._hasLOS(attacker.x, attacker.y, enemy.x, enemy.y)) return null;
    const mult = Math.max(1, Math.min(multiplier || 1, 10));
    const base = Math.max(1, Math.floor((attacker.atk - enemy.def + Math.floor(Math.random() * 7) - 3) * mult));
    const { dmg, isCrit } = _critDmg(base, attacker.critChance, attacker.critPower);
    // Missing here (unlike attackEnemy/pvpAttack/pvpSkillAttack, which all
    // bump this) meant every skill cast against a monster that doesn't also
    // fire its own netSpawnProj/netSpawnAoe — Пинок, Кувырок, Оковы тьмы —
    // was completely invisible to other nearby players: no swing, no effect,
    // just the monster's hp dropping. The generic swing this drives isn't a
    // perfect match for every skill, but it beats showing nothing at all,
    // and matches what pvpSkillAttack already does for the exact same case.
    attacker.lastAtkSeq = (attacker.lastAtkSeq || 0) + 1;
    enemy.hp = Math.max(0, enemy.hp - dmg);
    enemy.aggro = true;
    if (enemy.hp <= 0) {
      if (enemy.a3Team) return { killed: true, dmg, isCrit, a3Team: enemy.a3Team, ex: enemy.x, ey: enemy.y, color: enemy.color };
      if (enemy.raceBoss) return { killed: true, dmg, isCrit, raceBoss: true, ex: enemy.x, ey: enemy.y, color: enemy.color };
      const g = calcGoldDrop(enemy);
      // Assigned right here rather than left for the AI tick loop to notice
      // next frame — that gap is what forced an earlier version to guess an
      // independent random ETA for the immediate bossStatus broadcast
      // (server/index.js), which could disagree with what the tick loop
      // then actually assigned.
      let respawnAt;
      if (enemy.isBoss) {
        enemy.respawnTimer = _bossRespawnSecs();
        respawnAt = Date.now() + enemy.respawnTimer * 1000;
        if (this._onBossDeath) this._onBossDeath(enemy.arm, respawnAt);
      }
      return { killed: true, xp: enemy.xp, gold: g, dmg, isCrit, ex: enemy.x, ey: enemy.y, color: enemy.color, isBoss: !!enemy.isBoss, eid: enemy.eid, rlvl: enemy.rlvl || 0, arm: enemy.arm, lane: enemy.lane, respawnAt };
    }
    if (enemy.raceBoss) return { killed: false, hp: enemy.hp, dmg, isCrit, raceBoss: true };
    return { killed: false, hp: enemy.hp, dmg, isCrit };
  }

  applySkillEffect(enemyId, type, duration) {
    const enemy = this._enemyMap.get(enemyId);
    if (!enemy || enemy.hp <= 0) return;
    if (type === 'stun') enemy.stunTimer = Math.min(duration, 6);
    else if (type === 'slow') enemy.slowTimer = Math.min(duration, 6);
  }

  // Capped: the id list comes straight from a client packet (up to the 512 KB
  // socket.io message limit) and this loop runs on the same thread as the world
  // tick, so an oversized array is a direct way to stall the whole room. No
  // real AoE touches anywhere near this many enemies.
  applySkillEffectMany(enemyIds, type, duration) {
    if (!Array.isArray(enemyIds)) return;
    const n = Math.min(enemyIds.length, MAX_CC_TARGETS);
    for (let i = 0; i < n; i++) this.applySkillEffect(enemyIds[i], type, duration);
  }

  healPartyMember(socketId, amount) {
    const p = this.players.get(socketId);
    if (!p || p.hp <= 0) return false;
    if (!Number.isFinite(amount)) return false;   // see healPlayer above
    p.hp = Math.min(p.maxHp, p.hp + Math.max(0, amount));
    return true;
  }

  // Are these two players close enough to share party rewards/heals? Both
  // must actually be in this room. Used by the kill-reward split and the
  // party heal in server/index.js — the world is a single shared floor, so
  // "same floor" was never a real proximity check and a party member parked
  // anywhere on the map still collected a full share.
  arePlayersNear(socketIdA, socketIdB) {
    const a = this.players.get(socketIdA);
    const b = this.players.get(socketIdB);
    if (!a || !b) return false;
    const dx = a.x - b.x, dy = a.y - b.y;
    return dx * dx + dy * dy <= PARTY_SHARE_R2;
  }

  stop() { clearInterval(this._interval); }
}

module.exports = Room;
