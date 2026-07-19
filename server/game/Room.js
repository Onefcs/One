const { generateDungeon, TILE, WALL } = require('./dungeon');
const { calcGoldDrop, CHAR_DEF } = require('../../shared/definitions');

// Replicates client recompute() formula — single source of truth for server stats
function computeStats(sd, cd) {
  const u = sd.upgrades || {};
  const baseAtk   = sd.baseAtk   ?? cd.baseAtk;
  const baseDef   = sd.baseDef   ?? cd.baseDef;
  const baseMaxHp = sd.baseMaxHp ?? cd.baseHP;
  let eqAtk = 0, eqDef = 0, eqHp = 0, hpPct = 0;
  Object.values(sd.equipment || {}).forEach(it => {
    if (!it) return;
    eqAtk  += it.atk   || 0;
    eqDef  += it.def   || 0;
    eqHp   += it.hp    || 0;
    hpPct  += it.hpPct || 0;
  });
  return {
    atk:   baseAtk   + (u.atk || 0) * 3 + eqAtk,
    def:   baseDef   + (u.def || 0) * 2 + eqDef,
    maxHp: Math.floor((baseMaxHp + (u.hp || 0) * 25 + eqHp) * (1 + hpPct)),
  };
}

const TICK_MS   = 25;              // 40 ticks/sec — halves avg broadcast wait vs 50ms
const AOI_RADIUS = 900;
const AOI_R2    = AOI_RADIUS * AOI_RADIUS; // squared — avoids sqrt in AOI check
const LEASH_R2  = 420 * 420;      // max distance from spawn before leash triggers

class Room {
  constructor(floor, io) {
    this.floor = floor;
    this.io = io;
    this.players = new Map();
    this._dungeon = generateDungeon(floor);
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
    this._lastTick = Date.now();
    this._interval = setInterval(() => this._tick(), TICK_MS);
  }

  get dungeonData() {
    const d = this._dungeon;
    return { grid: d.grid, rooms: d.rooms, spawn: d.spawn, w: d.w, h: d.h };
  }

  enemySnapshot() {
    return this.enemies
      .filter(e => e.hp > 0)
      .map(e => ({
        id: e.id, eid: e.eid, x: e.x, y: e.y, hp: e.hp, maxHp: e.maxHp,
        name: e.name, color: e.color, size: e.size, isBoss: e.isBoss, aggro: e.aggro,
        aggroR: e.aggroR, spd: e.spd,
      }));
  }

  _isWall(x, y) {
    const d = this._dungeon;
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    if (tx < 0 || ty < 0 || tx >= d.w || ty >= d.h) return true;
    return d.grid[ty][tx] === WALL;
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

    // Enemy AI + respawn
    this.enemies.forEach(e => {
      if (e.hp <= 0) {
        if (e.respawnTimer === undefined) { e.respawnTimer = e.isBoss ? 3600 : 12; return; }
        e.respawnTimer -= dt;
        if (e.respawnTimer <= 0) {
          e.hp = e.maxHp;
          e.x = e.spawnX; e.y = e.spawnY;
          e.aggro = false; e.atkTimer = 1 + Math.random(); e.hurtTimer = 0;
          e._shp = -1;
          delete e.respawnTimer;
        }
        return;
      }

      // Find closest alive player — squared dist comparison, one sqrt on winner
      let closest = null, closestD2 = Infinity;
      for (let i = 0; i < alivePlayers.length; i++) {
        const p = alivePlayers[i];
        const dx = p.x - e.x, dy = p.y - e.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < closestD2) { closestD2 = d2; closest = p; }
      }
      if (!closest) return;

      const closestD = Math.sqrt(closestD2);

      if (closestD < e.aggroR) e.aggro = true;
      if (closestD > e.aggroR * 2.2) e.aggro = false;

      if (e.aggro) {
        if (closestD > e.size + 14) {
          const nx = (closest.x - e.x) / closestD;
          const ny = (closest.y - e.y) / closestD;
          const evx = nx * e.spd * dt, evy = ny * e.spd * dt;
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

    // Per-player emit: AOI filter + delta for enemies (reuse buffers — emit serializes synchronously)
    this.players.forEach(p => {
      nearPlayers.length = 0;
      nearEnemies.length = 0;

      // Other players within AOI — squared dist avoids sqrt per pair
      this.players.forEach(op => {
        if (op.socketId === p.socketId) return;
        const dx = op.x - p.x, dy = op.y - p.y;
        if (dx * dx + dy * dy > AOI_R2) return;
        nearPlayers.push({
          id: op.socketId, username: op.username, type: op.type,
          x: op.x, y: op.y, facing: op.facing, hp: op.hp, maxHp: op.maxHp,
          pvpMode: op.pvpMode || false, atkSeq: op.lastAtkSeq || 0,
        });
      });

      // Enemies within AOI that moved or changed HP — Math.abs instead of hypot for moved-check
      this.enemies.forEach(e => {
        if (e.hp <= 0) return;
        const dx = e.x - p.x, dy = e.y - p.y;
        if (dx * dx + dy * dy > AOI_R2) return;
        const moved = e.aggro || Math.abs(e.x - e._sx) > 0.5 || Math.abs(e.y - e._sy) > 0.5;
        const hpChanged = e.hp !== e._shp;
        if (!moved && !hpChanged) return;
        nearEnemies.push({
          id: e.id, eid: e.eid, x: e.x, y: e.y, hp: e.hp, maxHp: e.maxHp,
          name: e.name, color: e.color, size: e.size, isBoss: e.isBoss, aggro: e.aggro,
          aggroR: e.aggroR, spd: e.spd,
          atkAnimTimer: e._atkPulse ? e.atkAnimTimer : 0,
        });
      });

      // t: server tick timestamp — the client uses real tick spacing (setInterval
      // drifts 45-60ms) to time snapshot playback at true velocity
      this.io.to(p.socketId).emit('gameState', { players: nearPlayers, enemies: nearEnemies, t: now });
    });

    // Update delta markers after all per-player emits
    this.enemies.forEach(e => {
      if (e.hp > 0) { e._sx = e.x; e._sy = e.y; e._shp = e.hp; e._atkPulse = false; }
    });
  }

  addPlayer(socketId, username) {
    const spawn = this._dungeon.spawn;
    this.players.set(socketId, {
      socketId, username, type: null,
      x: spawn.x, y: spawn.y, facing: 'front',
      hp: 200, maxHp: 200, atk: 5, def: 5,
      pvpMode: false, lastAtkSeq: 0,
    });
    return spawn;
  }

  setPlayerPvpMode(socketId, mode) {
    const p = this.players.get(socketId);
    if (p) p.pvpMode = !!mode;
  }

  pvpAttack(attackerSocketId, targetSocketId) {
    const attacker = this.players.get(attackerSocketId);
    const target = this.players.get(targetSocketId);
    if (!attacker || !target) return null;
    if (!attacker.pvpMode) return null;
    if (target.hp <= 0) return null;
    const dx = attacker.x - target.x, dy = attacker.y - target.y;
    if (dx * dx + dy * dy > 500 * 500) return null;
    const dmg = Math.max(1, attacker.atk - (target.def || 0) + Math.floor(Math.random() * 7) - 3);
    attacker.lastAtkSeq = (attacker.lastAtkSeq || 0) + 1;
    return { dmg, x: target.x, y: target.y };
  }

  removePlayer(socketId) { this.players.delete(socketId); }

  setPlayerChar(socketId, type, savedStats = null) {
    const p = this.players.get(socketId);
    if (!p) return;
    const cd = CHAR_DEF[type];
    if (!cd) return;
    p.type = type;
    p.pvpMode = false;
    if (savedStats) {
      const s = computeStats(savedStats, cd);
      p.atk   = s.atk;
      p.def   = s.def;
      p.maxHp = s.maxHp;
      p.hp    = (savedStats.hp && savedStats.hp > 0) ? Math.min(savedStats.hp, p.maxHp) : p.maxHp;
    } else {
      p.hp = p.maxHp = cd.baseHP;
      p.atk = cd.baseAtk;
      p.def = cd.baseDef;
    }
  }

  updatePlayerPos(socketId, x, y, facing) {
    const p = this.players.get(socketId);
    if (!p) return;
    p.x = x; p.y = y; p.facing = facing;
  }

  syncPlayerHp(socketId, clientHp) {
    const p = this.players.get(socketId);
    if (!p || p.hp <= 0) return;
    // Trust client HP for regen tracking; clamp to [0, maxHp]
    p.hp = Math.min(p.maxHp, Math.max(0, clientHp));
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

  updatePlayerStats(socketId, { atk, def, maxHp }) {
    const p = this.players.get(socketId);
    if (!p) return;
    // Cap at 1.5× current server value — blocks console-injection hacks while
    // allowing legitimate growth from level-ups and upgrades during a session
    if (atk  >  0) p.atk  = Math.min(atk,  p.atk  * 1.5 + 100, 9999);
    if (def  >= 0) p.def  = Math.min(def,  p.def  * 1.5 + 100, 9999);
    if (maxHp > 0) {
      const cap = Math.min(maxHp, p.maxHp * 1.5 + 500, 99999);
      p.hp = Math.min(p.hp, cap); p.maxHp = cap;
    }
  }

  applyPvpDamage(socketId, actual) {
    const p = this.players.get(socketId);
    if (!p || p.hp <= 0) return null;
    p.hp = Math.max(0, p.hp - actual);
    return p.hp;
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
    const dmg = Math.max(1, attacker.atk - enemy.def + Math.floor(Math.random() * 7) - 3);
    attacker.lastAtkSeq = (attacker.lastAtkSeq || 0) + 1;
    enemy.hp = Math.max(0, enemy.hp - dmg);
    enemy.aggro = true;
    if (enemy.hp <= 0) {
      const g = calcGoldDrop(enemy, this.floor);
      return { killed: true, xp: enemy.xp, gold: g, dmg, ex: enemy.x, ey: enemy.y, color: enemy.color, isBoss: !!enemy.isBoss };
    }
    return { killed: false, hp: enemy.hp, dmg };
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
