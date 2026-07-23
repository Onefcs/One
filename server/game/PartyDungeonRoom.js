// Instanced party dungeon: a maze (server/game/mazeDungeon.js) with ~100
// static monsters and one boss at the far end. Self-contained, modeled on
// RaidRoom.js's isolation pattern (its own player/enemy maps, its own tick
// loop, its own socket.io broadcast channel) so it never touches the
// per-floor Room/currentRoom machinery used by the 5 normal floors — but
// its AI/attack logic is adapted from Room.js since, unlike RaidRoom's open
// wall-less arena, this dungeon has real maze walls enemies must path
// around and players can hide behind.
const { generatePartyDungeon, TILE, WALL } = require('./mazeDungeon');
const { calcGoldDrop } = require('../../shared/definitions');

const TICK_MS = 25;

function _critDmg(base, critChance, critPower) {
  const isCrit = Math.random() < (critChance || 0);
  return { dmg: isCrit ? Math.floor(base * (critPower || 1.5)) : base, isCrit };
}

class PartyDungeonRoom {
  constructor(id, io, memberIds, onFail) {
    this.id = id;
    this.io = io;
    this.channel = 'pd_' + id;
    this.memberIds = [...memberIds];
    this.onFail = onFail || null;
    this.players = new Map();
    this.state = 'fighting'; // fighting | complete | failed
    this._dungeon = generatePartyDungeon(Date.now() ^ Math.floor(Math.random() * 0xffffffff));
    this.enemies = this._dungeon.enemies.map(e => ({
      ...e, hp: e.maxHp, aggro: false,
      atkTimer: 1 + Math.random(), hurtTimer: 0, atkAnimTimer: 0,
    }));
    this._enemyMap = new Map(this.enemies.map(e => [e.id, e]));
    this._tickNo = 0;
    this._lastTick = Date.now();
    this._interval = null;
  }

  get dungeonData() {
    const d = this._dungeon;
    return { grid: d.grid, rooms: d.rooms, spawn: d.spawn, w: d.w, h: d.h, safeZone: d.safeZone };
  }

  enemySnapshot() {
    return this.enemies.filter(e => e.hp > 0).map(e => ({
      id: e.id, eid: e.eid, x: e.x, y: e.y, hp: e.hp, maxHp: e.maxHp,
      name: e.name, color: e.color, size: e.size, isBoss: e.isBoss, aggro: e.aggro,
      aggroR: e.aggroR, spd: e.spd,
    }));
  }

  start() {
    if (this._interval) return;
    this._lastTick = Date.now();
    this._interval = setInterval(() => this._tick(), TICK_MS);
  }

  stop() {
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
  }

  addPlayer(socketId, username, stats) {
    const spawn = this._dungeon.spawn;
    this.players.set(socketId, {
      socketId, username: username || '',
      x: spawn.x, y: spawn.y, facing: 'front',
      type: stats?.type || 'warrior',
      hp: stats?.maxHp || 200, maxHp: stats?.maxHp || 200,
      atk: stats?.atk || 10, def: stats?.def || 0,
      critChance: stats?.critChance || 0.05, critPower: stats?.critPower || 1.5,
    });
    return spawn;
  }

  removePlayer(socketId) {
    this.players.delete(socketId);
    this.memberIds = this.memberIds.filter(id => id !== socketId);
    if (this.players.size === 0) this.stop();
  }

  updatePlayerStats(socketId, { atk, def, maxHp, critChance, critPower }) {
    const p = this.players.get(socketId);
    if (!p) return;
    if (atk  >  0) p.atk  = Math.min(atk,  p.atk  * 1.5 + 100, 9999);
    if (def  >= 0) p.def  = Math.min(def,  p.def  * 1.5 + 100, 9999);
    if (maxHp > 0) {
      const cap = Math.min(maxHp, p.maxHp * 1.5 + 500, 99999);
      p.hp = Math.min(p.hp, cap);
      p.maxHp = cap;
    }
    if (critChance !== undefined) p.critChance = Math.min(0.80, Math.max(0, critChance));
    if (critPower  !== undefined) p.critPower  = Math.min(10,   Math.max(1, critPower));
  }

  // Trusts client hp on every move update (matching RaidRoom's convention,
  // not Room.js's) — there is no dedicated respawn round-trip for this
  // instance, so a player reviving client-side (respawnPlayer() in game.js)
  // only ever reaches the server through this same position sync. Gating
  // on "only update while currently alive" (as Room.js does for the real
  // floors, which DO have a separate respawn() event) would permanently
  // strand a respawned player's server-side hp at 0.
  updatePlayerPos(socketId, x, y, facing, hp) {
    const p = this.players.get(socketId);
    if (!p) return;
    p.x = x; p.y = y; p.facing = facing || p.facing;
    if (hp != null && isFinite(hp)) p.hp = Math.min(p.maxHp, Math.max(0, hp));
  }

  _inSafeZone(x, y) {
    const sz = this._dungeon.safeZone;
    if (!sz) return false;
    return x >= sz.x1 && x <= sz.x2 && y >= sz.y1 && y <= sz.y2;
  }

  _isWall(x, y) {
    const d = this._dungeon;
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    if (tx < 0 || ty < 0 || tx >= d.w || ty >= d.h) return true;
    return d.grid[ty][tx] === WALL;
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

  attackEnemy(socketId, enemyId) {
    const attacker = this.players.get(socketId);
    if (!attacker || attacker.hp <= 0) return null;
    const now = Date.now();
    if (now - (attacker._lastAtk || 0) < 150) return null;
    attacker._lastAtk = now;
    const enemy = this._enemyMap.get(enemyId);
    if (!enemy || enemy.hp <= 0) return null;
    const rdx = attacker.x - enemy.x, rdy = attacker.y - enemy.y;
    if (rdx * rdx + rdy * rdy > 350 * 350) return null;
    if (!this._hasLOS(attacker.x, attacker.y, enemy.x, enemy.y)) return null;
    const base = Math.max(1, attacker.atk - enemy.def + Math.floor(Math.random() * 7) - 3);
    const { dmg, isCrit } = _critDmg(base, attacker.critChance, attacker.critPower);
    enemy.hp = Math.max(0, enemy.hp - dmg);
    enemy.aggro = true;
    if (enemy.hp <= 0) {
      return {
        killed: true, xp: enemy.xp * 3, gold: calcGoldDrop(enemy, 2),
        dmg, isCrit, ex: enemy.x, ey: enemy.y, color: enemy.color,
        isBoss: !!enemy.isBoss, eid: enemy.eid,
      };
    }
    return { killed: false, hp: enemy.hp, dmg, isCrit };
  }

  skillAttackEnemy(socketId, enemyId, multiplier) {
    const attacker = this.players.get(socketId);
    if (!attacker || attacker.hp <= 0) return null;
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
      return {
        killed: true, xp: enemy.xp * 3, gold: calcGoldDrop(enemy, 2),
        dmg, isCrit, ex: enemy.x, ey: enemy.y, color: enemy.color,
        isBoss: !!enemy.isBoss, eid: enemy.eid,
      };
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

  _tick() {
    const now = Date.now();
    const dt = Math.min((now - this._lastTick) / 1000, 0.1);
    this._lastTick = now;
    if (this.state !== 'fighting') return;
    if (this.players.size === 0) return;

    const alivePlayers = [];
    this.players.forEach(p => { if (p.hp > 0) alivePlayers.push(p); });
    if (alivePlayers.length === 0) { this._fail(); return; }

    this.enemies.forEach(e => {
      if (e.hp <= 0) return;
      if ((e.stunTimer || 0) > 0) { e.stunTimer -= dt; return; }
      if ((e.slowTimer || 0) > 0) e.slowTimer -= dt;

      let closest = null, closestD2 = Infinity;
      for (let i = 0; i < alivePlayers.length; i++) {
        const p = alivePlayers[i];
        if (this._inSafeZone(p.x, p.y)) continue;
        const dx = p.x - e.x, dy = p.y - e.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < closestD2) { closestD2 = d2; closest = p; }
      }
      if (!closest) {
        if (e.aggro) { e.aggro = false; e.x = e.spawnX; e.y = e.spawnY; }
        return;
      }
      const closestD = Math.sqrt(closestD2);
      if (closestD < e.aggroR && this._hasLOS(e.x, e.y, closest.x, closest.y)) e.aggro = true;
      if (closestD > e.aggroR * 2.2 && e.aggro) {
        e.aggro = false;
        e.x = e.spawnX; e.y = e.spawnY;
      }

      if (e.aggro) {
        if (closestD > e.size + 14) {
          const spdMult = (e.slowTimer || 0) > 0 ? 0.35 : 1;
          const nx = (closest.x - e.x) / closestD, ny = (closest.y - e.y) / closestD;
          const evx = nx * e.spd * spdMult * dt, evy = ny * e.spd * spdMult * dt;
          if (!this._isWall(e.x + evx, e.y)) e.x += evx;
          if (!this._isWall(e.x, e.y + evy)) e.y += evy;
        }
        if (e.atkAnimTimer > 0) e.atkAnimTimer -= dt;
        e.atkTimer -= dt;
        if (closestD < e.size + 20 && e.atkTimer <= 0) {
          e.atkTimer = 1.4 + Math.random() * 0.6;
          e.atkAnimTimer = 0.9;
          const dmg = Math.max(1, e.atk - (closest.def || 0));
          closest.hp = Math.max(0, closest.hp - dmg);
          this.io.to(closest.socketId).emit('partyDungeonPlayerHurt', { hp: closest.hp, dmg });
        }
      }
    });

    this._tickNo++;
    if (this._tickNo % 2 === 0) {
      const msg = {
        enemies: this.enemySnapshot(),
        players: Array.from(this.players.values()).map(p => ({
          id: p.socketId, x: p.x, y: p.y, facing: p.facing,
          hp: p.hp, maxHp: p.maxHp, username: p.username, type: p.type,
        })),
      };
      this.io.to(this.channel).emit('partyDungeonState', msg);
    }
  }

  _fail() {
    this.state = 'failed';
    this.stop();
    this.io.to(this.channel).emit('partyDungeonFailed', {});
    if (this.onFail) this.onFail([...this.memberIds]);
  }
}

module.exports = { PartyDungeonRoom };
