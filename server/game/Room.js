const { generateOpenWorld, TILE, WALL } = require('./dungeon');
const { calcGoldDrop, CHAR_DEF, ARM_NAMES } = require('../../shared/definitions');
const { encodeGameState, packGrid } = require('../../shared/netcodec');

// Replicates client recompute() formula — single source of truth for server stats
function computeStats(sd, cd) {
  const u = sd.upgrades || {};
  const baseAtk   = sd.baseAtk   ?? cd.baseAtk;
  const baseDef   = sd.baseDef   ?? cd.baseDef;
  const baseMaxHp = sd.baseMaxHp ?? cd.baseHP;
  let eqAtk = 0, eqDef = 0, eqHp = 0, hpPct = 0, extraCrit = 0;
  Object.values(sd.equipment || {}).forEach(it => {
    if (!it) return;
    eqAtk  += it.atk   || 0;
    eqDef  += it.def   || 0;
    eqHp   += it.hp    || 0;
    hpPct  += it.hpPct || 0;
    if (it.critChance) extraCrit += it.critChance;
  });
  const lvl = (sd.lvl || 1) - 1;
  return {
    atk:       baseAtk   + (u.atk || 0) * 3 + eqAtk,
    def:       baseDef   + (u.def || 0) * 2 + eqDef,
    maxHp:     Math.floor((baseMaxHp + (u.hp || 0) * 25 + eqHp) * (1 + hpPct)),
    critChance: Math.min(0.80, 0.05 + lvl * 0.004 + (u.critChance || 0) * 0.025 + extraCrit),
    critPower:  1.5 + lvl * 0.015 + (u.critPower || 0) * 0.15,
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
// At most this many other players per packet (screen fits ~15). Bounds the
// N² blowup when hundreds of players stack in one spot.
const PLAYER_CAP = 20;
// Every N casts an entry goes out full even if the recipient "knows" it —
// self-heals any client/server known-state divergence within ~2s.
const FULL_REFRESH_TICKS = 80;

class Room {
  constructor(floor, io) {
    this.floor = floor;
    this.io = io;
    this.players = new Map();
    this._dungeon = generateOpenWorld();
    this._gridPacked = packGrid(this._dungeon.grid, this._dungeon.w, this._dungeon.h);
    this.enemies = this._dungeon.enemies.map(e => ({
      ...e, hp: e.maxHp, aggro: false,
      atkTimer: 1 + Math.random(), hurtTimer: 0, atkAnimTimer: 0,
      _sx: e.x, _sy: e.y, _shp: e.maxHp,
    }));
    // O(1) enemy lookup for attack handler
    this._enemyMap = new Map(this.enemies.map(e => [e.id, e]));
    // Reusable buffers — avoids array allocation every tick
    this._alivePlayers = [];
    this._nearPlayersBuf = [];
    this._nearEnemiesBuf = [];
    this._candBuf = [];
    // Enemy sight/delta tracking is room-wide, not per-player: enemies are
    // never AOI-filtered (minimap needs full dungeon-wide coverage — see the
    // comment in _tick()), so every connected player was computing and
    // receiving the exact same nearEnemies delta every tick anyway. Tracking
    // it once here instead of via a per-player Map avoids redoing that same
    // O(enemies) walk once per player, every tick.
    this._enemyKnown = new Map();
    this._tickNo = 0;
    this._pSeq = 0;
    this.enemies.forEach((e, i) => { e._idx = i; });
    this._lastTick = Date.now();
    this._interval = null;
  }

  _startLoop() {
    if (this._interval) return;
    this._lastTick = Date.now();
    this._interval = setInterval(() => this._tick(), TICK_MS);
  }

  _stopLoop() {
    if (!this._interval) return;
    clearInterval(this._interval);
    this._interval = null;
  }

  get dungeonData() {
    const d = this._dungeon;
    return { gridPacked: this._gridPacked, rooms: d.rooms, spawn: d.spawn, w: d.w, h: d.h, safeZone: d.safeZone, armEntries: d.armEntries, corridorGates: d.corridorGates };
  }

  _inSafeZone(x, y) {
    const sz = this._dungeon.safeZone;
    return x >= sz.x1 && x <= sz.x2 && y >= sz.y1 && y <= sz.y2;
  }

  isPlayerInSafeZone(socketId) {
    const p = this.players.get(socketId);
    return p ? this._inSafeZone(p.x, p.y) : false;
  }

  enemySnapshot() {
    return this.enemies
      .filter(e => e.hp > 0)
      .map(e => ({
        id: e.id, eid: e.eid, x: e.x, y: e.y, hp: e.hp, maxHp: e.maxHp,
        name: e.name, color: e.color, size: e.size, isBoss: e.isBoss, aggro: e.aggro,
        aggroR: e.aggroR, spd: e.spd, rlvl: e.rlvl || 0,
      }));
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
      const secs = boss.respawnTimer !== undefined ? boss.respawnTimer : 3600;
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
          e.x = e.spawnX; e.y = e.spawnY;
          e.aggro = false;
          e._targetId = null;
          e._shp = -1;
        });
      }
      p._wasInSafeZone = nowIn;
    });

    // Enemy AI + respawn
    this.enemies.forEach(e => {
      if (e.hp <= 0) {
        if (e.respawnTimer === undefined) { e.respawnTimer = e.isBoss ? 3600 : 12; return; }
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

      // Tick CC timers
      if ((e.stunTimer || 0) > 0) { e.stunTimer -= dt; return; }
      if ((e.slowTimer || 0) > 0) e.slowTimer -= dt;

      // Find closest alive player not in safe zone, not in raid, not invisible
      let closest = null, closestD2 = Infinity;
      for (let i = 0; i < alivePlayers.length; i++) {
        const p = alivePlayers[i];
        if (this._inSafeZone(p.x, p.y)) continue;
        if (p._inRaid) continue;
        if (p._invis) continue;
        const dx = p.x - e.x, dy = p.y - e.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < closestD2) { closestD2 = d2; closest = p; }
      }
      // No eligible target anywhere in the room (e.g. a solo player just
      // died, or everyone left/entered a safe zone) — snap straight back to
      // spawn instead of freezing mid-chase wherever it happened to be. The
      // enemy only ever moves while aggro is true, so this is the only place
      // that state needs resetting; without it an enemy could sit stalled
      // off its spawn point indefinitely, only recovering once some other
      // player later wanders close enough to re-target it.
      if (!closest) {
        e._targetId = null;
        if (e.aggro) { e.aggro = false; e.x = e.spawnX; e.y = e.spawnY; e._shp = -1; }
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
      if (closestD > e.aggroR * 2.2 && e.aggro) {
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

      // Leash: too far from spawn → full HP reset back to spawn
      const ldx = e.x - e.spawnX, ldy = e.y - e.spawnY;
      if (ldx * ldx + ldy * ldy > LEASH_R2) {
        e.hp = e.maxHp;
        e.x = e.spawnX; e.y = e.spawnY;
        e.aggro = false;
        e._shp = -1;
      }
    });

    // Per-player emit: AOI filter + delta (reuse buffers — emit serializes synchronously).
    // Bandwidth protocol:
    //  - players are broadcast every OTHER tick (20Hz; client interpolates)
    //  - static fields (username/type/maxHp/pvpMode) go out only on first
    //    sight, on profile change (_profileRev), or on periodic refresh;
    //    otherwise a slim {id,x,y,facing,hp,atkSeq} entry is sent
    //  - at most PLAYER_CAP nearest players per packet
    //  - enemies keep 40Hz change-delta, but static fields (name/color/size/…)
    //    are likewise sent only on first sight / periodic refresh
    const castId = ++this._tickNo;
    const castPlayers = (castId & 1) === 0;
    const cand = this._candBuf;

    // All alive enemies dungeon-wide (not AOI-limited) — minimap/map need
    // full, always-current coverage regardless of player position; the delta
    // protocol below already keeps idle far-away enemies near-free. Computed
    // ONCE per tick (not once per player): with no per-enemy AOI, every
    // connected player ends up with the exact same fresh/moved/hpChanged
    // decision anyway, so a room-wide tracker (this._enemyKnown) replaces the
    // old per-player one and this walk no longer repeats per player.
    // Math.abs instead of hypot for moved-check.
    nearEnemies.length = 0;
    this.enemies.forEach(e => {
      if (e.hp <= 0) return;
      const k = this._enemyKnown.get(e.id);
      const fresh = !k || k.seen !== castId - 1 ||
        (castId + e._idx) % FULL_REFRESH_TICKS === 0;
      if (k) k.seen = castId; else this._enemyKnown.set(e.id, { seen: castId });
      const moved = e.aggro || Math.abs(e.x - e._sx) > 0.5 || Math.abs(e.y - e._sy) > 0.5;
      const hpChanged = e.hp !== e._shp;
      if (!moved && !hpChanged && !fresh) return;
      if (fresh) {
        nearEnemies.push({
          id: e.id, idx: e._idx, eid: e.eid, x: e.x, y: e.y, hp: e.hp, maxHp: e.maxHp,
          name: e.name, color: e.color, size: e.size, isBoss: e.isBoss, aggro: e.aggro,
          aggroR: e.aggroR, spd: e.spd, rlvl: e.rlvl || 0,
          atkAnimTimer: e._atkPulse ? e.atkAnimTimer : 0,
        });
      } else {
        nearEnemies.push({
          id: e.id, idx: e._idx, x: e.x, y: e.y, hp: e.hp, aggro: e.aggro,
          atkAnimTimer: e._atkPulse ? e.atkAnimTimer : 0,
        });
      }
    });

    this.players.forEach(p => {
      let playersOut = null;

      if (castPlayers) {
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
        playersOut = nearPlayers;
      }

      // t: server tick timestamp — the client uses real tick spacing (setInterval
      // drifts 45-60ms) to time snapshot playback at true velocity.
      // Payload is a binary ArrayBuffer — see shared/netcodec.js
      this.io.to(p.socketId).emit('gameState', encodeGameState(playersOut, nearEnemies, now));
    });

    // Update delta markers after all per-player emits
    this.enemies.forEach(e => {
      if (e.hp > 0) { e._sx = e.x; e._sy = e.y; e._shp = e.hp; e._atkPulse = false; }
    });
  }

  addPlayer(socketId, username, clanName, clanIcon) {
    const spawn = this._dungeon.spawn;
    this.players.set(socketId, {
      socketId, username, type: null,
      clanName: clanName || null, clanIcon: clanIcon || null,
      x: spawn.x, y: spawn.y, facing: 'front',
      hp: 200, maxHp: 200, atk: 5, def: 5,
      pvpMode: false, lastAtkSeq: 0,
      _known: new Map(),
      _profileRev: 1, _seq: ++this._pSeq,
    });
    if (this.players.size === 1) this._startLoop();
    return spawn;
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
      const s = computeStats(savedStats, cd);
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
    } else {
      p.hp = p.maxHp = cd.baseHP;
      p.atk = cd.baseAtk;
      p.def = cd.baseDef;
      p._sd = {};
    }
  }

  // Called on every saveProgress — keeps p._sd (the basis for statsUpdate's
  // true-base recomputation) in sync with the player's actual equipment/
  // upgrades/level without waiting for the next character (re)selection.
  updatePlayerSavedData(socketId, sd) {
    const p = this.players.get(socketId);
    if (!p) return;
    p._sd = sd || {};
  }

  updatePlayerPos(socketId, x, y, facing) {
    const p = this.players.get(socketId);
    if (!p) return;
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
    const trueBase = computeStats(p._sd || {}, cd);
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

  attackEnemy(socketId, enemyId) {
    const attacker = this.players.get(socketId);
    if (!attacker) return null;
    // Rate-limit: max one server hit every 150ms
    const now = Date.now();
    if (now - (attacker._lastAtk || 0) < 150) return null;
    attacker._lastAtk = now;
    const enemy = this._enemyMap.get(enemyId); // O(1) Map lookup
    if (!enemy || enemy.hp <= 0) return null;
    // Range check: must be within 350px (generous for AoE skills)
    const rdx = attacker.x - enemy.x, rdy = attacker.y - enemy.y;
    if (rdx * rdx + rdy * rdy > 350 * 350) return null;
    if (!this._hasLOS(attacker.x, attacker.y, enemy.x, enemy.y)) return null;
    const base = Math.max(1, attacker.atk - enemy.def + Math.floor(Math.random() * 7) - 3);
    const { dmg, isCrit } = _critDmg(base, attacker.critChance, attacker.critPower);
    attacker.lastAtkSeq = (attacker.lastAtkSeq || 0) + 1;
    enemy.hp = Math.max(0, enemy.hp - dmg);
    enemy.aggro = true;
    if (enemy.hp <= 0) {
      const g = calcGoldDrop(enemy);
      return { killed: true, xp: enemy.xp, gold: g, dmg, isCrit, ex: enemy.x, ey: enemy.y, color: enemy.color, isBoss: !!enemy.isBoss, eid: enemy.eid, rlvl: enemy.rlvl || 0, arm: enemy.arm };
    }
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
      const g = calcGoldDrop(enemy);
      return { killed: true, xp: enemy.xp, gold: g, dmg, isCrit, ex: enemy.x, ey: enemy.y, color: enemy.color, isBoss: !!enemy.isBoss, eid: enemy.eid, rlvl: enemy.rlvl || 0, arm: enemy.arm };
    }
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

  stop() { clearInterval(this._interval); }
}

module.exports = Room;
