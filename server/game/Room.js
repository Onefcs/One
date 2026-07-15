const { generateDungeon, TILE, WALL } = require('./dungeon');

const TICK_MS = 50; // 20 fps

class Room {
  constructor(code, io) {
    this.code = code;
    this.io = io;
    this.players = new Map(); // socketId → player data
    this.floor = 1;
    this.dungeons = {};
    this._loadFloor(1);
    this._lastTick = Date.now();
    this._interval = setInterval(() => this._tick(), TICK_MS);
  }

  _loadFloor(lvl) {
    if (!this.dungeons[lvl]) this.dungeons[lvl] = generateDungeon(lvl);
    this.floor = lvl;
    const src = this.dungeons[lvl];
    this.enemies = src.enemies.map(e => ({
      ...e, hp: e.maxHp, aggro: false, atkTimer: 1 + Math.random(),
    }));
  }

  _isWall(x, y) {
    const d = this.dungeons[this.floor];
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

    this.enemies.forEach(e => {
      if (e.hp <= 0) return;

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
          this.io.to(this.code).emit('playerHurt', { id: closest.socketId, hp: closest.hp, dmg });
        }
      }
    });

    this.io.to(this.code).emit('gameState', {
      players: [...this.players.values()].map(p => ({
        id: p.socketId, username: p.username, type: p.type,
        x: p.x, y: p.y, facing: p.facing, hp: p.hp, maxHp: p.maxHp,
      })),
      enemies: this.enemies.filter(e => e.hp > 0).map(e => ({
        id: e.id, x: e.x, y: e.y, hp: e.hp, maxHp: e.maxHp,
        name: e.name, color: e.color, size: e.size, isBoss: e.isBoss, aggro: e.aggro,
      })),
    });
  }

  addPlayer(socketId, username) {
    const spawn = this.dungeons[this.floor].spawn;
    this.players.set(socketId, {
      socketId, username, type: null,
      x: spawn.x, y: spawn.y, facing: 'front',
      hp: 200, maxHp: 200, atk: 25, def: 10,
    });
  }

  removePlayer(socketId) { this.players.delete(socketId); }

  setPlayerChar(socketId, type) {
    const p = this.players.get(socketId);
    if (!p) return;
    const base = { warrior: [200,25,10], archer: [140,20,5], mage: [110,38,3] }[type] || [200,25,10];
    p.type = type;
    p.hp = p.maxHp = base[0];
    p.atk = base[1]; p.def = base[2];
  }

  updatePlayerPos(socketId, x, y, facing) {
    const p = this.players.get(socketId);
    if (p) { p.x = x; p.y = y; p.facing = facing; }
  }

  attackEnemy(socketId, enemyId) {
    const attacker = this.players.get(socketId);
    if (!attacker) return null;
    const enemy = this.enemies.find(e => e.id === enemyId && e.hp > 0);
    if (!enemy) return null;
    const dmg = Math.max(1, attacker.atk - enemy.def + Math.floor(Math.random() * 7) - 3);
    enemy.hp = Math.max(0, enemy.hp - dmg);
    if (enemy.hp <= 0) {
      const g = enemy.gold[0] + Math.floor(Math.random() * (enemy.gold[1] - enemy.gold[0] + 1));
      return { killed: true, xp: enemy.xp, gold: g, dmg, ex: enemy.x, ey: enemy.y, color: enemy.color };
    }
    return { killed: false, hp: enemy.hp, dmg };
  }

  changeFloor(floor) {
    this._loadFloor(Math.max(1, Math.min(20, floor)));
    const spawn = this.dungeons[this.floor].spawn;
    this.players.forEach(p => { p.x = spawn.x; p.y = spawn.y; });
  }

  getDungeonData() {
    const d = this.dungeons[this.floor];
    return { grid: d.grid, rooms: d.rooms, spawn: d.spawn, w: d.w, h: d.h };
  }

  getPlayerList() {
    return [...this.players.values()].map(p => ({ id: p.socketId, username: p.username, type: p.type }));
  }

  stop() { clearInterval(this._interval); }
}

module.exports = Room;
