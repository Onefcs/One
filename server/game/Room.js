const { generateOpenWorld, TILE, WALL } = require('./dungeon');
const { calcGoldDrop, CHAR_DEF, ARM_NAMES, EVENT_BOSS, EVENT_BOSS_DROP_LIFE_MS, rollEventBossDrops,
        ARENA3_BOSS_HP, ENEMY_AOI_R, enhanceBonus, passiveBonusTotal } = require('../../shared/definitions');
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
function computeStats(sd, cd, type) {
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

// Enemy interest management. ENEMY_AOI_R (shared/definitions.js — the client
// prunes against the same number) is the radius each player is streamed
// enemies within; the grid cell is sized to match it so the per-player query
// only ever touches a 2x2..3x3 block of cells.
const ENEMY_AOI_R2 = ENEMY_AOI_R * ENEMY_AOI_R;
const ENEMY_GRID_CELL = ENEMY_AOI_R;
// How long (in casts, which run every other tick — so ~150ms) an enemy may be
// out of a player's range before the server forgets having told them about
// it. Small on purpose: see the ordering requirement in _collectEnemiesFor.
const EKNOWN_FORGET_CASTS = 6;
// Map-panel dot refresh, in ticks (40/s) — 1Hz. Only sent to players with the
// panel open; see _broadcastMapBlips.
const MAP_BLIP_EVERY = 40;

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
    const _now = Date.now();
    this.enemies = this._dungeon.enemies.map(e => {
      if (!e.isBoss) {
        return { ...e, hp: e.maxHp, aggro: false, atkTimer: 1 + Math.random(),
          hurtTimer: 0, atkAnimTimer: 0, _sx: e.x, _sy: e.y, _shp: e.maxHp };
      }
      const savedAt = bossState[e.arm];
      // Three cases for a per-arm boss at startup:
      //  - a persisted deadline that's still in the future: dead, resume the
      //    real remaining cooldown instead of losing it to the restart.
      //  - a persisted deadline already in the past: the whole cooldown
      //    elapsed while the server was down, so it's alive again now.
      //  - no record at all (first boot ever for this arm): fall back to
      //    dead with a fresh random 1-2h wait — the original fix for every
      //    restart otherwise dropping a full-HP boss on the map instantly.
      const hp = (savedAt != null && savedAt <= _now) ? e.maxHp : 0;
      const respawnTimer = hp > 0 ? undefined : (savedAt != null ? (savedAt - _now) / 1000 : _bossRespawnSecs());
      return {
        ...e, hp, aggro: false, atkTimer: 1 + Math.random(), hurtTimer: 0, atkAnimTimer: 0,
        _sx: e.x, _sy: e.y, _shp: hp,
        ...(respawnTimer !== undefined ? { respawnTimer } : {}),
      };
    });
    // O(1) enemy lookup for attack handler
    this._enemyMap = new Map(this.enemies.map(e => [e.id, e]));
    // Reusable buffers — avoids array allocation every tick
    this._alivePlayers = [];
    this._nearPlayersBuf = [];
    this._nearEnemiesBuf = [];
    this._candBuf = [];
    // Spatial index over alive non-boss enemies, rebuilt every tick, so the
    // per-player interest query in _collectEnemiesFor doesn't have to walk
    // the whole enemy list. Bosses sit in _bossBuf instead — they're sent to
    // everyone regardless of distance.
    this._enemyGrid = new Map();
    this._bossBuf = [];
    this._tickNo = 0;
    this._pSeq = 0;
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
      try { this._tick(); } catch (err) { console.error(`[Room ${this.floor} tick]`, err); }
    }, TICK_MS);
  }

  _stopLoop() {
    if (!this._interval) return;
    clearInterval(this._interval);
    this._interval = null;
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

    // Rebuild alive-players buffer without allocation (reuse arrays)
    const alivePlayers = this._alivePlayers;
    alivePlayers.length = 0;
    const nearPlayers = this._nearPlayersBuf;
    const nearEnemies = this._nearEnemiesBuf;
    this.players.forEach(p => { if (p.hp > 0 && p.type) alivePlayers.push(p); });

    // Detect players entering the safe zone — reset only enemies chasing that player
    this.players.forEach(p => {
      const nowIn = this._inSafeZone(p.x, p.y);
      if (nowIn && !p._wasInSafeZone) {
        this.enemies.forEach(e => {
          if (e.hp <= 0 || e._targetId !== p.socketId) return;
          if (e.ignoresSafeZone) return; // event boss keeps chasing into the hub
          e.x = e.spawnX; e.y = e.spawnY;
          e.aggro = false;
          e._targetId = null;
          e._shp = -1;
        });
      }
      p._wasInSafeZone = nowIn;
    });

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

      // Tick CC timers
      if ((e.stunTimer || 0) > 0) { e.stunTimer -= dt; return; }
      if ((e.slowTimer || 0) > 0) e.slowTimer -= dt;

      // Find closest alive player not in safe zone, not in raid, not invisible
      // — but only actually re-scan every AI_TARGET_SEARCH_EVERY ticks (see
      // its comment above); otherwise reuse the cached target as long as
      // it's still eligible, so a stale reference never keeps an enemy
      // chasing someone who died/vanished/hid for multiple ticks.
      // The event boss (shared/definitions.js EVENT_BOSS) is summoned INTO the
      // hub, which is the safe zone — the normal rules would leave it with no
      // eligible target forever. It alone may target players standing there;
      // every other enemy still skips them, so the hub stays safe from
      // everything except this one deliberate world event.
      const _sz = !e.ignoresSafeZone;
      const cached = e._cachedTarget;
      const cachedStillValid = cached && cached.hp > 0 && this.players.get(cached.socketId) === cached &&
        !(_sz && this._inSafeZone(cached.x, cached.y)) && !cached._inRaid && !cached._invis;
      const dueForSearch = (e._idx % AI_TARGET_SEARCH_EVERY) === (this._aiTickNo % AI_TARGET_SEARCH_EVERY);
      let closest = cachedStillValid ? cached : null;
      if (dueForSearch || !cachedStillValid) {
        closest = null;
        let bestD2 = Infinity;
        for (let i = 0; i < alivePlayers.length; i++) {
          const p = alivePlayers[i];
          if (_sz && this._inSafeZone(p.x, p.y)) continue;
          if (p._inRaid) continue;
          if (p._invis) continue;
          const dx = p.x - e.x, dy = p.y - e.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2) { bestD2 = d2; closest = p; }
        }
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
      if (closestD < e.aggroR && this._hasLOS(e.x, e.y, closest.x, closest.y)) e.aggro = true;
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
        if (closestD > e.size + 14) {
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
          this.io.to(closest.socketId).emit('playerHurt', {
            id: closest.socketId, hp: closest.hp, dmg,
          });
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

    this.players.forEach(p => {
      nearPlayers.length = 0;
      cand.length = 0;
      this.players.forEach(op => {
        if (op.socketId === p.socketId) return;
        const dx = op.x - p.x, dy = op.y - p.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > PLAYER_AOI_R2) return;
        cand.push({ op, d2 });
      });
      if (cand.length > PLAYER_CAP) {
        cand.sort((a, b) => a.d2 - b.d2);
        cand.length = PLAYER_CAP;
      }
      for (let i = 0; i < cand.length; i++) {
        const op = cand[i].op;
        const k = p._known.get(op.socketId);
        const full = !k || k.rev !== op._profileRev || k.seen !== castId - 2 ||
          ((castId >> 1) + op._seq) % FULL_REFRESH_TICKS === 0;
        if (full) {
          nearPlayers.push({
            id: op.socketId, seq: op._seq, username: op.username, type: op.type,
            x: op.x, y: op.y, facing: op.facing, hp: op.hp, maxHp: op.maxHp,
            pvpMode: op.pvpMode || false, atkSeq: op.lastAtkSeq || 0,
            clanName: op.clanName || null, clanIcon: op.clanIcon || null,
          });
        } else {
          nearPlayers.push({
            id: op.socketId, seq: op._seq, x: op.x, y: op.y, facing: op.facing,
            hp: op.hp, atkSeq: op.lastAtkSeq || 0,
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
      this.io.to(p.socketId).emit('gameState', encodeGameState(playersOut, nearEnemies, now, undefined));
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
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (e.hp <= 0) continue;
      if (e.isBoss) { this._bossBuf.push(e); continue; }
      const key = Math.floor(e.x / ENEMY_GRID_CELL) * 100000 + Math.floor(e.y / ENEMY_GRID_CELL);
      let cell = grid.get(key);
      if (!cell) { cell = []; grid.set(key, cell); }
      cell.push(e);
    }
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

    for (let i = 0; i < this._bossBuf.length; i++) this._pushEnemyEntry(this._bossBuf[i], known, out, castId);

    const grid = this._enemyGrid;
    const cx0 = Math.floor((p.x - ENEMY_AOI_R) / ENEMY_GRID_CELL);
    const cx1 = Math.floor((p.x + ENEMY_AOI_R) / ENEMY_GRID_CELL);
    const cy0 = Math.floor((p.y - ENEMY_AOI_R) / ENEMY_GRID_CELL);
    const cy1 = Math.floor((p.y + ENEMY_AOI_R) / ENEMY_GRID_CELL);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const cell = grid.get(cx * 100000 + cy);
        if (!cell) continue;
        for (let i = 0; i < cell.length; i++) {
          const e = cell[i];
          const dx = e.x - p.x, dy = e.y - p.y;
          if (dx * dx + dy * dy > ENEMY_AOI_R2) continue;
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
    if (!k) {
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
    let n = 0;
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (e.hp > 0 && !e.isBoss) n++;
    }
    const buf = new Int16Array(n * 2);
    let o = 0;
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (e.hp <= 0 || e.isBoss) continue;
      buf[o++] = Math.round(e.x / TILE);
      buf[o++] = Math.round(e.y / TILE);
    }
    this.players.forEach(p => {
      if (p._mapOpen) this.io.to(p.socketId).emit('mapBlips', buf.buffer);
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

  addPlayer(socketId, username, clanName, clanIcon, telegramId) {
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
      clanName: clanName || null, clanIcon: clanIcon || null,
      x: spawn.x, y: spawn.y, facing: 'front',
      hp: 200, maxHp: 200, atk: 5, def: 5,
      pvpMode: false, lastAtkSeq: 0,
      _known: new Map(),
      // Enemies already streamed to this player: id -> last {x,y,hp,aggro}
      // sent, plus the cast it was last in range for. See _collectEnemiesFor.
      _eKnown: new Map(),
      _mapOpen: false,
      _profileRev: 1, _seq: ++this._pSeq,
    });
    if (this.players.size === 1) this._startLoop();
    return { spawn, staleSocketId };
  }

  setPlayerClan(socketId, clanName, clanIcon) {
    const p = this.players.get(socketId);
    if (!p) return;
    p.clanName = clanName || null;
    p.clanIcon = clanIcon || null;
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
      const s = computeStats(savedStats, cd, type);
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

  updatePlayerPos(socketId, x, y, facing) {
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
    p.x = x; p.y = y; p.facing = facing;
  }

  syncPlayerHp(socketId, clientHp) {
    const p = this.players.get(socketId);
    if (!p || p.hp <= 0) return;
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

  healPlayer(socketId, amount) {
    const p = this.players.get(socketId);
    if (!p || p.hp <= 0) return;
    p.hp = Math.min(p.maxHp, p.hp + amount);
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
    socketIds.forEach((sid, i) => {
      const p = this.players.get(sid);
      if (!p) return;
      const spot = race.lanes[i % race.lanes.length];
      let x = spot.x, y = spot.y;
      if (this._isWall(x, y)) { x = race.boss.x; y = race.boss.y; }
      p.x = x; p.y = y;
      p.hp = p.maxHp;
      p._profileRev++;
      placed.push({ socketId: sid, x, y, hp: p.hp, lane: i });
    });
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

  // Sends a player back to the hub with PvP off — used both for entrants
  // knocked out of a round and for the winner once they close the reward
  // modal. Returns the landing spot so the caller can tell that client.
  deathBattleReturn(socketId) {
    const p = this.players.get(socketId);
    if (!p) return null;
    p.x = this._dungeon.spawn.x;
    p.y = this._dungeon.spawn.y;
    p.pvpMode = false;
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
    const trueBase = computeStats(p._sd || {}, cd, p.type);
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
    const stats = computeStats(sd, cd, p.type);
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
      return { killed: true, xp: enemy.xp, gold: g, dmg, isCrit, ex: enemy.x, ey: enemy.y, color: enemy.color, isBoss: !!enemy.isBoss, eid: enemy.eid, rlvl: enemy.rlvl || 0, arm: enemy.arm, respawnAt };
    }
    if (enemy.raceBoss) return { killed: false, hp: enemy.hp, dmg, isCrit, raceBoss: true };
    return { killed: false, hp: enemy.hp, dmg, isCrit };
  }

  skillAttackEnemy(socketId, enemyId, multiplier) {
    const attacker = this.players.get(socketId);
    if (!attacker) return null;
    const enemy = this._enemyMap.get(enemyId);
    if (!enemy || enemy.hp <= 0) return null;
    const rdx = attacker.x - enemy.x, rdy = attacker.y - enemy.y;
    if (rdx * rdx + rdy * rdy > 600 * 600) return null;
    if (!this._hasLOS(attacker.x, attacker.y, enemy.x, enemy.y)) return null;
    const mult = Math.max(1, Math.min(multiplier || 1, 10));
    const base = Math.max(1, Math.floor((attacker.atk - enemy.def + Math.floor(Math.random() * 7) - 3) * mult));
    const { dmg, isCrit } = _critDmg(base, attacker.critChance, attacker.critPower);
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
      return { killed: true, xp: enemy.xp, gold: g, dmg, isCrit, ex: enemy.x, ey: enemy.y, color: enemy.color, isBoss: !!enemy.isBoss, eid: enemy.eid, rlvl: enemy.rlvl || 0, arm: enemy.arm, respawnAt };
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

  applySkillEffectMany(enemyIds, type, duration) {
    for (const id of enemyIds) this.applySkillEffect(id, type, duration);
  }

  healPartyMember(socketId, amount) {
    const p = this.players.get(socketId);
    if (!p || p.hp <= 0) return false;
    p.hp = Math.min(p.maxHp, p.hp + amount);
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
