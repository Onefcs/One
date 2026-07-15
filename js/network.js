// ── Network module ───────────────────────────────────────────
const SERVER_URL = (() => {
  const h = window.location.hostname;
  return (h === 'localhost' || h === '127.0.0.1' || h === '')
    ? 'http://localhost:3000'
    : 'https://one-production-ae10.up.railway.app';
})();

let _authMode = 'login';

// ── Socket setup ──────────────────────────────────────────────
function netConnect(onReady) {
  socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });

  socket.on('connect', () => { if (onReady) onReady(); });

  socket.on('connect_error', () => {
    showAuthError('Нет соединения с сервером');
  });

  socket.on('authOk', ({ username }) => {
    netUsername = username;
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('char-select').style.display = 'flex';
  });

  socket.on('authError', ({ message }) => { showAuthError(message); });

  socket.on('playerJoined', ({ id, username }) => {
    if (!otherPlayers[id]) otherPlayers[id] = { animFrame: 0, animTimer: 0, moving: false };
    otherPlayers[id].username = username;
  });

  socket.on('playerLeft', ({ id }) => {
    delete otherPlayers[id];
    delete _posBuffers[id];
  });

  socket.on('playerChar', ({ id, type }) => {
    if (!otherPlayers[id]) otherPlayers[id] = { animFrame: 0, animTimer: 0, moving: false };
    otherPlayers[id].type = type;
    loadSprites(type, () => {});
  });

  socket.on('gameStart', ({ floor, dungeon: d }) => {
    dungeonLvl = floor;
    dungeon = { ...d, enemies: [] };
    buildTileCanvas();
    projs = []; drops = []; particles = []; dmgNums = [];
    if (player) {
      player.x = d.spawn.x; player.y = d.spawn.y;
      camera.x = player.x - W / 2; camera.y = player.y - H / 2;
      clampCamera();
    }
    // Wait for sprites to finish loading before starting — char-select stays
    // visible as a natural loading screen; loadSprites is instant if already cached
    loadSprites(player?.type, _finishOnlineStart);
  });

  socket.on('gameState', ({ players, enemies }) => {
    const myId = socket.id;
    const now = Date.now();
    const cutoff = now - 600;

    // Buffer other players' positions with timestamps for smooth interpolation
    players.forEach(p => {
      if (p.id === myId) return;
      if (!otherPlayers[p.id]) {
        otherPlayers[p.id] = { ...p, animFrame: 0, animTimer: 0, moving: false };
        if (p.type) loadSprites(p.type, () => {});
      } else {
        const op = otherPlayers[p.id];
        if (p.type && op.type !== p.type) { op.type = p.type; loadSprites(p.type, () => {}); }
        op.hp = p.hp; op.maxHp = p.maxHp;
        op.facing = p.facing; op.username = p.username;
      }
      if (!_posBuffers[p.id]) _posBuffers[p.id] = [];
      _posBuffers[p.id].push({ t: now, x: p.x, y: p.y });
      while (_posBuffers[p.id].length > 1 && _posBuffers[p.id][0].t < cutoff)
        _posBuffers[p.id].shift();
    });
    const pids = new Set(players.map(p => p.id));
    Object.keys(otherPlayers).forEach(id => {
      if (!pids.has(id)) { delete otherPlayers[id]; delete _posBuffers[id]; }
    });

    // Buffer enemy positions with timestamps
    const incomingMap = new Map(enemies.map(e => [e.id, e]));
    serverEnemies = serverEnemies.filter(e => incomingMap.has(e.id));
    Object.keys(_posBuffers).forEach(id => {
      if (id.startsWith('e_') && !incomingMap.has(id)) delete _posBuffers[id];
    });
    enemies.forEach(se => {
      const ex = serverEnemies.find(e => e.id === se.id);
      if (ex) { ex.hp = se.hp; ex.maxHp = se.maxHp; ex.hurtTimer = se.hurtTimer; }
      else serverEnemies.push({ ...se });
      if (!_posBuffers[se.id]) _posBuffers[se.id] = [];
      _posBuffers[se.id].push({ t: now, x: se.x, y: se.y });
      while (_posBuffers[se.id].length > 1 && _posBuffers[se.id][0].t < cutoff)
        _posBuffers[se.id].shift();
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
    }
  });

  socket.on('enemyHurt', ({ id, hp, dmg }) => {
    const e = serverEnemies.find(e => e.id === id);
    if (e) {
      e.hp = hp;
      if (dmg) dmgNum(e.x, e.y - e.size - 4, dmg, '#ff4');
    }
  });

  socket.on('enemyKilled', ({ id, xp, gold, dmg, ex, ey, color }) => {
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

  socket.on('floorChanged', ({ floor, dungeon: d }) => {
    dungeonLvl = floor;
    dungeon = { ...d, enemies: [] };
    buildTileCanvas();
    _posBuffers = {};
    projs = []; drops = []; particles = []; dmgNums = [];
    if (player) {
      player.x = d.spawn.x; player.y = d.spawn.y;
      camera.x = player.x - W / 2; camera.y = player.y - H / 2;
      clampCamera();
    }
    transTimer = 0.5;
  });

  socket.on('disconnect', () => {
    socket = null;
    serverEnemies = [];
    otherPlayers = {};
    _posBuffers = {};
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

function playOffline() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('char-select').style.display = 'flex';
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
  if (now - _lastMoveSend < 50) return;
  _lastMoveSend = now;
  socket.emit('playerMove', { x: player.x, y: player.y, facing: player.facing });
}

function netAttack(enemyId) {
  if (socket?.connected) socket.emit('attack', { enemyId });
}

function netSendChangeFloor(floor) {
  if (socket?.connected) socket.emit('changeFloor', { floor });
}

function netSelectChar(type) {
  if (socket?.connected) socket.emit('selectChar', { type });
}
