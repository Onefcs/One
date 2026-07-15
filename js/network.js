// ── Network module ───────────────────────────────────────────
const SERVER_URL = (() => {
  const h = window.location.hostname;
  return (h === 'localhost' || h === '127.0.0.1' || h === '')
    ? 'http://localhost:3000'
    : 'https://one-production-ae10.up.railway.app';
})();

let _authMode = 'login';
let _savedData = null;

// ── Socket setup ──────────────────────────────────────────────
function netConnect(onReady) {
  socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });

  socket.on('connect', () => { if (onReady) onReady(); });

  socket.on('connect_error', () => {
    showAuthError('Нет соединения с сервером');
  });

  socket.on('authOk', ({ username, savedData }) => {
    netUsername = username;
    _savedData = savedData || null;
    document.getElementById('login-screen').style.display = 'none';
    _showCharSelect(_savedData);
  });

  socket.on('authError', ({ message }) => { showAuthError(message); });

  socket.on('playerJoined', ({ id, username }) => {
    if (!otherPlayers[id]) otherPlayers[id] = { animFrame: 0, animTimer: 0, moving: false };
    otherPlayers[id].username = username;
  });

  socket.on('playerLeft', ({ id }) => {
    delete otherPlayers[id];
  });

  socket.on('playerChar', ({ id, type }) => {
    if (!otherPlayers[id]) otherPlayers[id] = { animFrame: 0, animTimer: 0, moving: false };
    otherPlayers[id].type = type;
    loadSprites(type, () => {});
  });

  socket.on('gameStart', ({ floor, dungeon: d, enemies: initialEnemies }) => {
    dungeonLvl = floor;
    dungeon = { ...d, enemies: [] };
    // Populate from initial snapshot — no delta until first gameState
    serverEnemies = (initialEnemies || []).map(e => ({ ...e, targetX: e.x, targetY: e.y }));
    otherPlayers = {};
    buildTileCanvas();
    projs = []; drops = []; particles = []; dmgNums = [];
    if (player) {
      player.x = d.spawn.x; player.y = d.spawn.y;
      camera.x = player.x - W / 2; camera.y = player.y - H / 2;
      clampCamera();
    }
    const restore = _savedData && _savedData.type === player?.type ? _savedData : null;
    loadSprites(player?.type, () => {
      if (restore) { restoreFromSave(restore); _savedData = null; }
      initNpcs();
      _finishOnlineStart();
    });
  });

  socket.on('gameState', ({ players, enemies }) => {
    const myId = socket.id;

    players.forEach(p => {
      if (p.id === myId) return;
      if (!otherPlayers[p.id]) {
        otherPlayers[p.id] = { ...p, targetX: p.x, targetY: p.y, animFrame: 0, animTimer: 0, moving: false };
        if (p.type) loadSprites(p.type, () => {});
      } else {
        const op = otherPlayers[p.id];
        if (p.type && op.type !== p.type) { op.type = p.type; loadSprites(p.type, () => {}); }
        op.hp = p.hp; op.maxHp = p.maxHp;
        op.facing = p.facing; op.username = p.username;
        op.pvpMode = p.pvpMode || false;
        if (op.x === undefined) { op.x = p.x; op.y = p.y; }
        op.targetX = p.x; op.targetY = p.y;
      }
    });

    // Remove players that left AOI or disconnected
    const pids = new Set(players.map(p => p.id));
    Object.keys(otherPlayers).forEach(id => { if (!pids.has(id)) delete otherPlayers[id]; });

    // Delta update: only changed enemies arrive — add or update, never remove
    // (removal happens via enemyKilled; respawn via re-add when hp > 0)
    enemies.forEach(se => {
      const ex = serverEnemies.find(e => e.id === se.id);
      if (ex) {
        ex.hp = se.hp; ex.maxHp = se.maxHp;
        ex.targetX = se.x; ex.targetY = se.y;
        ex.aggro = se.aggro;
      } else {
        serverEnemies.push({ ...se, targetX: se.x, targetY: se.y });
      }
    });
  });

  socket.on('playerHurt', ({ id, hp }) => {
    if (player && id === socket.id) {
      player.hp = hp;
      player.hurtTimer = 0.35;
      if (player.hp <= 0) { player.hp = 0; state = 'dead'; }
    } else if (otherPlayers[id]) {
      otherPlayers[id].hp = hp;
      otherPlayers[id].hurtTimer = 0.35;
      if (hp <= 0 && id === targetId && targetIsPlayer) { targetId = null; targetIsPlayer = false; }
    }
  });

  socket.on('pvpDamage', ({ dmg }) => {
    if (!player) return;
    if (barrierTimer > 0) { dmgNum(player.x, player.y - 24, 'БЛОК', '#88f'); return; }
    const actual = Math.max(1, Math.floor(dmg * (dodgeTimer > 0 ? 0.3 : 1)));
    player.hp = Math.max(0, player.hp - actual);
    player.hurtTimer = 0.35;
    dmgNum(player.x, player.y - 24, actual, '#f55');
    spawnBurst(player.x, player.y, '#f44', 5);
    if (player.hp <= 0) { player.hp = 0; state = 'dead'; }
  });

  socket.on('pvpHit', ({ x, y, dmg }) => {
    if (dmg) dmgNum(x, y - 24, dmg, '#f88');
    spawnBurst(x, y, '#f44', 4);
  });

  socket.on('enemyHurt', ({ id, hp, dmg }) => {
    const e = serverEnemies.find(e => e.id === id);
    if (e) {
      e.hp = hp;
      e.hurtTimer = 0.3;
      if (dmg) dmgNum(e.x, e.y - e.size - 4, dmg, '#ff4');
    }
  });

  socket.on('enemyKilled', ({ id, xp, gold, dmg, ex, ey, color }) => {
    if (id === targetId && !targetIsPlayer) { targetId = null; targetIsPlayer = false; }
    const e = serverEnemies.find(e => e.id === id);
    const px = ex ?? (e ? e.x : player?.x ?? 0);
    const py = ey ?? (e ? e.y : player?.y ?? 0);
    if (dmg) dmgNum(px, py - 20, dmg, '#ff4');
    spawnBurst(px, py, color || '#f80', 8);
    serverEnemies = serverEnemies.filter(e => e.id !== id);
    if (xp && player) gainXP(xp);
    if (gold && player) {
      player.gold += gold;
      dmgNum(px, py - 36, '+' + gold + '💰', '#ff0');
    }
  });

  socket.on('floorChanged', ({ floor, dungeon: d, enemies: initialEnemies }) => {
    dungeonLvl = floor;
    dungeon = { ...d, enemies: [] };
    serverEnemies = (initialEnemies || []).map(e => ({ ...e, targetX: e.x, targetY: e.y }));
    otherPlayers = {};
    buildTileCanvas();
    projs = []; drops = []; particles = []; dmgNums = [];
    if (player) {
      player.x = d.spawn.x; player.y = d.spawn.y;
      camera.x = player.x - W / 2; camera.y = player.y - H / 2;
      clampCamera();
    }
    initNpcs();
    transTimer = 0.5;
  });

  socket.on('disconnect', () => {
    socket = null;
    serverEnemies = [];
    otherPlayers = {};
  });
}

// ── Auth ──────────────────────────────────────────────────────
function switchAuthTab(mode) {
  _authMode = mode;
  document.getElementById('tab-login').classList.toggle('active', mode === 'login');
  document.getElementById('tab-register').classList.toggle('active', mode === 'register');
  const btn = document.querySelector('#login-screen .auth-btn.primary');
  if (btn) btn.textContent = mode === 'login' ? 'Войти' : 'Зарегистрироваться';
  document.getElementById('auth-error').textContent = '';
}

function authSubmit() {
  const username = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value;
  if (!username || !password) { showAuthError('Заполните все поля'); return; }
  document.getElementById('auth-error').textContent = '';
  if (!socket || !socket.connected) {
    netConnect(() => socket.emit(_authMode, { username, password }));
  } else {
    socket.emit(_authMode, { username, password });
  }
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  if (el) el.textContent = msg;
}

function _showCharSelect(savedData) {
  const resumeEl = document.getElementById('char-resume');
  const resumeBtn = document.getElementById('resume-btn');
  if (resumeEl && resumeBtn) {
    if (savedData && savedData.type) {
      const d = CHAR_DEF[savedData.type];
      resumeBtn.textContent = `▶ Продолжить: ${d ? d.emoji + ' ' + d.name : savedData.type} · Ур.${savedData.lvl || 1} · 💰${savedData.gold || 0}`;
      resumeEl.style.display = 'flex';
    } else {
      resumeEl.style.display = 'none';
    }
  }
  document.getElementById('char-select').style.display = 'flex';
}

function resumeGame() {
  if (_savedData && _savedData.type) selectChar(_savedData.type);
}

function netSaveProgress() {
  if (!player || state !== 'playing') return;
  const stats = {
    type: player.type,
    lvl: player.lvl, xp: player.xp, xpNext: player.xpNext,
    gold: player.gold, kills: player.kills,
    hp: player.hp, maxHp: player.maxHp,
    atk: player.atk, def: player.def,
    baseAtk: player.baseAtk, baseDef: player.baseDef, baseMaxHp: player.baseMaxHp,
    inventory: player.inventory, equipment: player.equipment,
    potions: player.potions || 0,
  };
  if (socket?.connected) socket.emit('saveProgress', { stats });
}

function _finishOnlineStart() {
  document.getElementById('char-select').style.display = 'none';
  document.getElementById('bottom-nav').style.display = 'block';
  document.querySelectorAll('.bpanel').forEach(p => p.style.display = 'block');
  state = 'playing';
  setTab(0);
}

// ── Move throttle ─────────────────────────────────────────────
let _lastMoveSend = 0;
function netSendMove() {
  if (!socket?.connected || !player) return;
  const now = Date.now();
  if (now - _lastMoveSend < 33) return;
  _lastMoveSend = now;
  socket.emit('playerMove', { x: player.x, y: player.y, facing: player.facing, hp: player.hp, maxHp: player.maxHp });
}

function netAttack(enemyId) {
  if (socket?.connected) socket.emit('attack', { enemyId });
}

function netSendChangeFloor(floor) {
  if (socket?.connected) socket.emit('changeFloor', { floor });
}

function netSelectChar(type, savedStats) {
  if (socket?.connected) socket.emit('selectChar', { type, savedStats: savedStats || null });
}

function netPvpAttack(targetSocketId) {
  if (socket?.connected) socket.emit('pvpAttack', { targetId: targetSocketId });
}

function netSetPvpMode(mode) {
  if (socket?.connected) socket.emit('setPvpMode', { pvpMode: mode });
}
