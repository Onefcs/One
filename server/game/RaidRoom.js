const { TILE, FLOOR } = require('./dungeon');
const { ENEMY_DEF } = require('../../shared/definitions');

const MAP_TILES = 20;
const MAP_PX    = MAP_TILES * TILE; // 800 px
const CENTER    = MAP_PX / 2;       // 400 px
const TICK_MS   = 25;

const _byEid = new Map(ENEMY_DEF.map(e => [e.eid, e]));
const MOB_POOL  = ['goblin_guard', 'goblin_warrior'];
const BOSS_EID  = 'goblin_boss';

function _makeGrid() {
  return Array.from({ length: MAP_TILES }, () => new Array(MAP_TILES).fill(FLOOR));
}

class RaidRoom {
  constructor(raidId, io, memberIds) {
    this.raidId    = raidId;
    this.io        = io;
    this.memberIds = [...memberIds];
    this.players   = new Map();
    this.enemies   = [];
    this._enemyMap = new Map();
    this._eid      = 0;
    this._tickNo   = 0;
    this.wave      = 0;
    this.totalWaves = 7;
    this.state     = 'waiting';
    this._lastTick = Date.now();
    this._interval = null;
  }

  get dungeonData() {
    return {
      grid: _makeGrid(),
      w: MAP_TILES, h: MAP_TILES,
      spawn: { x: CENTER, y: CENTER },
      rooms: [], safeZone: null,
      isRaid: true, raidId: this.raidId,
    };
  }

  addPlayer(socketId, stats) {
    const off = (Math.random() - 0.5) * 60;
    this.players.set(socketId, {
      socketId,
      x: CENTER + off, y: CENTER + off,
      hp: stats.maxHp, maxHp: stats.maxHp,
      atk: stats.atk || 10, def: stats.def || 0,
      type: stats.type || 'warrior',
      username: stats.username || '',
    });
  }

  removePlayer(socketId) {
    this.players.delete(socketId);
    this.memberIds = this.memberIds.filter(id => id !== socketId);
    if (this.players.size === 0) this._stop();
  }

  updatePlayerPos(socketId, x, y, hp) {
    const p = this.players.get(socketId);
    if (!p) return;
    p.x = x; p.y = y;
    if (hp !== undefined && hp >= 0) p.hp = hp;
  }

  start() {
    this.state     = 'fighting';
    this._lastTick = Date.now();
    this._interval = setInterval(() => this._tick(), TICK_MS);
    this._spawnWave(1);
  }

  _stop() {
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
  }

  _spawnWave(waveNum) {
    this.wave = waveNum;
    this.enemies   = [];
    this._enemyMap.clear();

    if (waveNum === 7) {
      const def = _byEid.get(BOSS_EID);
      const e = this._makeEnemy(def, CENTER, 2 * TILE, true);
      this.enemies.push(e);
      this._enemyMap.set(e.id, e);
    } else {
      const count = waveNum;
      const poses = [];
      for (let i = 0; i < count; i++) {
        const t = (i + 0.5) / count;
        const p = TILE + t * (MAP_PX - 2 * TILE);
        poses.push(
          { x: p,             y: TILE               },
          { x: p,             y: MAP_PX - TILE       },
          { x: TILE,          y: p                   },
          { x: MAP_PX - TILE, y: p                   },
        );
      }
      poses.forEach(pos => {
        const def = _byEid.get(MOB_POOL[Math.floor(Math.random() * MOB_POOL.length)]);
        const e = this._makeEnemy(def, pos.x, pos.y, false);
        this.enemies.push(e);
        this._enemyMap.set(e.id, e);
      });
    }

    this.memberIds.forEach(id => this.io.to(id).emit('raidWave', {
      wave: waveNum, totalWaves: this.totalWaves,
      isBoss: waveNum === 7,
      enemies: this._snapshot(),
    }));
  }

  _makeEnemy(def, x, y, isBoss) {
    const sc = isBoss ? 2 : 1;
    const id = `raid_${this.raidId}_${this._eid++}`;
    return {
      id, eid: def.eid,
      name:  isBoss ? 'Страж Подземелья' : def.name,
      color: isBoss ? '#ff3333'           : def.color,
      size:  isBoss ? def.size + 8        : def.size,
      hp:    Math.floor(def.hp  * sc),
      maxHp: Math.floor(def.hp  * sc),
      atk:   Math.floor(def.atk * sc),
      def:   def.def || 0,
      spd:   def.spd,
      isBoss,
      x, y, aggro: false,
      atkTimer: 1 + Math.random(),
      _shp: -1,
    };
  }

  _snapshot() {
    return this.enemies
      .filter(e => e.hp > 0)
      .map(e => ({ id: e.id, eid: e.eid, x: e.x, y: e.y,
        hp: e.hp, maxHp: e.maxHp, name: e.name, color: e.color,
        size: e.size, isBoss: e.isBoss, aggro: e.aggro,
        spd: e.spd, aggroR: 350 }));
  }

  attackEnemy(socketId, enemyId, playerAtk) {
    const e = this._enemyMap.get(enemyId);
    if (!e || e.hp <= 0) return null;
    const dmg = Math.max(1, playerAtk - (e.def || 0));
    e.hp = Math.max(0, e.hp - dmg);
    e._shp = -1;
    if (e.hp <= 0) return { killed: true, eid: e.eid, ex: e.x, ey: e.y, isBoss: e.isBoss };
    return { killed: false, hp: e.hp, dmg };
  }

  _tick() {
    const now = Date.now();
    const dt  = Math.min((now - this._lastTick) / 1000, 0.1);
    this._lastTick = now;
    if (this.state !== 'fighting') return;

    const alivePlayers = [];
    this.players.forEach(p => { if (p.hp > 0) alivePlayers.push(p); });

    if (alivePlayers.length === 0) { this._fail(); return; }

    const aliveEnemies = this.enemies.filter(e => e.hp > 0);
    if (aliveEnemies.length === 0) {
      this.state = 'wave_clear';
      setTimeout(() => {
        if (this.state !== 'wave_clear') return;
        if (this.wave >= this.totalWaves) {
          this._complete();
        } else {
          this.state = 'fighting';
          this._spawnWave(this.wave + 1);
        }
      }, 2000);
      return;
    }

    this.enemies.forEach(e => {
      if (e.hp <= 0) return;
      let closest = null, closestD2 = Infinity;
      for (const p of alivePlayers) {
        const dx = p.x - e.x, dy = p.y - e.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < closestD2) { closestD2 = d2; closest = p; }
      }
      if (!closest) { e.aggro = false; return; }
      const dist = Math.sqrt(closestD2);
      if (dist < 350) e.aggro = true;
      if (!e.aggro) return;
      if (dist > e.size + 14) {
        e.x += (closest.x - e.x) / dist * e.spd * dt;
        e.y += (closest.y - e.y) / dist * e.spd * dt;
        e.x = Math.max(TILE / 2, Math.min(MAP_PX - TILE / 2, e.x));
        e.y = Math.max(TILE / 2, Math.min(MAP_PX - TILE / 2, e.y));
      }
      e.atkTimer -= dt;
      if (dist < e.size + 20 && e.atkTimer <= 0) {
        e.atkTimer = 1.4 + Math.random() * 0.6;
        const dmg = Math.max(1, e.atk - (closest.def || 0));
        closest.hp = Math.max(0, closest.hp - dmg);
        this.io.to(closest.socketId).emit('raidPlayerHurt', { hp: closest.hp, dmg });
        if (closest.hp <= 0) {
          const stillAlive = alivePlayers.filter(p => p.hp > 0);
          if (stillAlive.length === 0) { this._fail(); return; }
        }
      }
    });

    // Broadcast state every other tick (20 Hz)
    this._tickNo++;
    if (this._tickNo % 2 === 0) {
      const msg = {
        enemies: this._snapshot(),
        players: Array.from(this.players.values()).map(p => ({
          id: p.socketId, x: p.x, y: p.y,
          hp: p.hp, maxHp: p.maxHp,
          username: p.username, type: p.type,
        })),
        wave: this.wave,
      };
      this.memberIds.forEach(id => this.io.to(id).emit('raidState', msg));
    }
  }

  _complete() {
    this.state = 'complete';
    this._stop();
    const n = Math.max(1, this.memberIds.length);
    const goldEach = Math.floor(500 / n);
    const xpEach   = Math.floor(500 / n);
    const roll = Math.random();
    const weaponRarity = roll < 0.05 ? 'uncommon' : roll < 0.35 ? 'common' : null;
    const winner = weaponRarity
      ? this.memberIds[Math.floor(Math.random() * n)]
      : null;
    this.memberIds.forEach(id => this.io.to(id).emit('raidComplete', {
      gold: goldEach, xp: xpEach,
      weaponRarity: winner === id ? weaponRarity : null,
    }));
  }

  _fail() {
    this.state = 'failed';
    this._stop();
    this.memberIds.forEach(id => this.io.to(id).emit('raidFailed', {}));
  }
}

module.exports = { RaidRoom };
