const { generateDungeon, TILE, WALL } = require('./dungeon');
const { calcGoldDrop, CHAR_DEF } = require('../../shared/definitions');

const TICK_MS = 33;
const AOI_RADIUS = 900; // px — covers screen + buffer

class Room {
  constructor(floor, io) {
    this.floor = floor;
    this.io = io;
    this.players = new Map();
    this._dungeon = generateDungeon(floor);
    this.enemies = this._dungeon.enemies.map(e => ({
      ...e, hp: e.maxHp, aggro: false,
      atkTimer: 1 + Math.random(), hurtTimer: 0,
      _sx: e.x, _sy: e.y, _shp: e.maxHp, // delta markers
    }));
    this._lastTick = Date.now();
    this._interval = setInterval(() => this._tick(), TICK_MS);
  }

  get dungeonData() {
    const d = this._dungeon;
    return { grid: d.grid, rooms: d.rooms, spawn: d.spawn, w: d.w, h: d.h };
  }

  // Full snapshot for new joiners — bypasses delta
  enemySnapshot() {
    return this.enemies
      .filter(e => e.hp > 0)
      .map(e => ({
        id: e.id, eid: e.eid, x: e.x, y: e.y, hp: e.hp, maxHp: e.maxHp,
        name: e.name, color: e.color, size: e.size, isBoss: e.isBoss, aggro: e.aggro,
        hurtTimer: e.hurtTimer || 0, atkAnimTimer: e.atkAnimTimer || 0,
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

    const alivePlayers = [...this.players.values()].filter(p => p.hp > 0 && p.type);

    // Enemy AI + respawn
    this.enemies.forEach(e => {
      if (e.hp <= 0) {
        if (e.respawnTimer === undefined) { e.respawnTimer = 12; return; }
        e.respawnTimer -= dt;
        if (e.respawnTimer <= 0) {
          e.hp = e.maxHp;
          e.x = e.spawnX; e.y = e.spawnY;
          e.aggro = false; e.atkTimer = 1 + Math.random(); e.hurtTimer = 0;
          e._shp = -1; // force send on respawn
          delete e.respawnTimer;
        }
        return;
      }

      let closest = null, closestD = Infinity;
      alivePlayers.forEach(p => {
        const d = Math.hypot(p.x - e.x, p.y - e.y);
        if (d < closestD) { closestD = d; closest = p; }
      });
      if (!closest) return;

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
        e.atkTimer -= dt;
        if (closestD < e.size + 20 && e.atkTimer <= 0) {
          e.atkTimer = 1.4 + Math.random() * 0.6;
          const dmg = Math.max(1, e.atk - (closest.def || 0));
          closest.hp = Math.max(0, closest.hp - dmg);
          this.io.to(closest.socketId).emit('playerHurt', {
            id: closest.socketId, hp: closest.hp, dmg,
          });
        }
      }
    });

    // Per-player emit: AOI filter + delta for enemies
    this.players.forEach(p => {
      // Other players within AOI
      const nearPlayers = [];
      this.players.forEach(op => {
        if (op.socketId === p.socketId) return;
        if (Math.hypot(op.x - p.x, op.y - p.y) > AOI_RADIUS) return;
        nearPlayers.push({
          id: op.socketId, username: op.username, type: op.type,
          x: op.x, y: op.y, facing: op.facing, hp: op.hp, maxHp: op.maxHp,
          pvpMode: op.pvpMode || false, atkSeq: op.lastAtkSeq || 0,
        });
      });

      // Enemies within AOI that moved or changed HP
      const nearEnemies = [];
      this.enemies.forEach(e => {
        if (e.hp <= 0) return;
        if (Math.hypot(e.x - p.x, e.y - p.y) > AOI_RADIUS) return;
        const moved = e.aggro || Math.hypot(e.x - e._sx, e.y - e._sy) > 0.5;
        const hpChanged = e.hp !== e._shp;
        if (!moved && !hpChanged) return;
        nearEnemies.push({
          id: e.id, eid: e.eid, x: e.x, y: e.y, hp: e.hp, maxHp: e.maxHp,
          name: e.name, color: e.color, size: e.size, isBoss: e.isBoss, aggro: e.aggro,
          hurtTimer: e.hurtTimer || 0, atkAnimTimer: e.atkAnimTimer || 0,
        });
      });

      this.io.to(p.socketId).emit('gameState', { players: nearPlayers, enemies: nearEnemies });
    });

    // Update delta markers after all per-player emits
    this.enemies.forEach(e => {
      if (e.hp > 0) { e._sx = e.x; e._sy = e.y; e._shp = e.hp; }
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
    const d = Math.hypot(attacker.x - target.x, attacker.y - target.y);
    if (d > 500) return null;
    const dmg = Math.max(1, attacker.atk - (target.def || 0) + Math.floor(Math.random() * 7) - 3);
    attacker.lastAtkSeq = (attacker.lastAtkSeq || 0) + 1;
    // Don't track HP server-side for PvP — client is authoritative for own HP
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
      // Recalculate atk from current CHAR_DEF base to respect balance changes.
      // Add level scaling and equipment bonuses on top.
      const lvlBonus = ((savedStats.lvl || 1) - 1) * 3;
      const eqAtk = Object.values(savedStats.equipment || {}).reduce((s, it) => s + (it?.atk || 0), 0);
      const eqDef = Object.values(savedStats.equipment || {}).reduce((s, it) => s + (it?.def || 0), 0);
      p.atk = cd.baseAtk + lvlBonus + eqAtk;
      p.def = cd.baseDef + eqDef + Math.floor(((savedStats.lvl || 1) - 1) * 0.5);
      p.maxHp = savedStats.maxHp || cd.baseHP;
      p.hp = p.maxHp;
    } else {
      p.hp = p.maxHp = cd.baseHP;
      p.atk = cd.baseAtk;
      p.def = cd.baseDef;
    }
  }

  updatePlayerPos(socketId, x, y, facing, hp, maxHp) {
    const p = this.players.get(socketId);
    if (!p) return;
    p.x = x; p.y = y; p.facing = facing;
    // Trust client for HP so other players see accurate values (healing included)
    if (hp !== undefined && hp >= 0) p.hp = hp;
    if (maxHp !== undefined && maxHp > 0) p.maxHp = maxHp;
  }

  attackEnemy(socketId, enemyId) {
    const attacker = this.players.get(socketId);
    if (!attacker) return null;
    const enemy = this.enemies.find(e => e.id === enemyId && e.hp > 0);
    if (!enemy) return null;
    const dmg = Math.max(1, attacker.atk - enemy.def + Math.floor(Math.random() * 7) - 3);
    attacker.lastAtkSeq = (attacker.lastAtkSeq || 0) + 1;
    enemy.hp = Math.max(0, enemy.hp - dmg);
    if (enemy.hp <= 0) {
      const g = calcGoldDrop(enemy, this.floor);
      return { killed: true, xp: enemy.xp, gold: g, dmg, ex: enemy.x, ey: enemy.y, color: enemy.color };
    }
    return { killed: false, hp: enemy.hp, dmg };
  }

  stop() { clearInterval(this._interval); }
}

module.exports = Room;
