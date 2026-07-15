// ── Network module ───────────────────────────────────────────
const SERVER_URL = (() => {
  const h = window.location.hostname;
  return (h === 'localhost' || h === '127.0.0.1' || h === '')
    ? 'http://localhost:3000'
    : 'https://one-production-ae10.up.railway.app';
})();

let _authMode = 'login';
let _roomPlayers = [];

// ── Socket setup ──────────────────────────────────────────────
function netConnect(onReady) {
  socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });

  socket.on('connect', () => { if (onReady) onReady(); });

  socket.on('connect_error', () => {
    showAuthError('Нет соединения с сервером');
  });

  socket.on('authOk', ({ username }) => {
    netUsername = username;
    _showLobbyScreen(username);
  });

  socket.on('authError', ({ message }) => { showAuthError(message); });

  socket.on('roomCreated', ({ code }) => {
    netRoom = code;
    _roomPlayers = [{ id: socket.id, username: netUsername }];
    _showRoomLobby(code);
  });

  socket.on('roomJoined', ({ code, players }) => {
    netRoom = code;
    _roomPlayers = players;
    _showRoomLobby(code);
  });

  socket.on('roomError', ({ message }) => {
    document.getElementById('lobby-error').textContent = message;
  });

  socket.on('playerJoined', ({ id, username }) => {
    _roomPlayers.push({ id, username });
    _renderRoomPlayers();
    if (!otherPlayers[id]) otherPlayers[id] = {};
    otherPlayers[id].username = username;
  });

  socket.on('playerLeft', ({ id }) => {
    delete otherPlayers[id];
    _roomPlayers = _roomPlayers.filter(p => p.id !== id);
    _renderRoomPlayers();
  });

  socket.on('playerChar', ({ id, type }) => {
    if (!otherPlayers[id]) otherPlayers[id] = {};
    otherPlayers[id].type = type;
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
    _finishOnlineStart();
  });

  socket.on('gameState', ({ players, enemies }) => {
    const myId = socket.id;
    players.forEach(p => {
      if (p.id !== myId) {
        if (!otherPlayers[p.id]) {
          otherPlayers[p.id] = { ...p }; // init at real position
        } else {
          const op = otherPlayers[p.id];
          op.targetX = p.x; op.targetY = p.y;
          op.hp = p.hp; op.maxHp = p.maxHp;
          op.facing = p.facing; op.type = p.type; op.username = p.username;
        }
      }
    });
    const ids = new Set(players.map(p => p.id));
    Object.keys(otherPlayers).forEach(id => { if (!ids.has(id)) delete otherPlayers[id]; });

    // Update enemy targets while preserving current render positions for interpolation
    const incomingMap = new Map(enemies.map(e => [e.id, e]));
    serverEnemies = serverEnemies.filter(e => incomingMap.has(e.id));
    enemies.forEach(se => {
      const ex = serverEnemies.find(e => e.id === se.id);
      if (ex) {
        ex.targetX = se.x; ex.targetY = se.y;
        ex.hp = se.hp; ex.maxHp = se.maxHp;
        ex.hurtTimer = se.hurtTimer;
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

// ── Lobby ─────────────────────────────────────────────────────
function _showLobbyScreen(username) {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('lobby-screen').style.display = 'flex';
  document.getElementById('lobby-welcome').textContent = '👋 Привет, ' + username + '!';
}

function doJoinRoom() {
  const code = (document.getElementById('room-code-input').value || '').trim().toUpperCase();
  if (code.length !== 6) {
    document.getElementById('lobby-error').textContent = 'Введите 6-значный код';
    return;
  }
  document.getElementById('lobby-error').textContent = '';
  socket.emit('joinRoom', { code });
}

function _showRoomLobby(code) {
  document.getElementById('lobby-screen').style.display = 'none';
  document.getElementById('room-lobby-screen').style.display = 'flex';
  document.getElementById('room-code-display').textContent = code;
  _renderRoomPlayers();
}

function _renderRoomPlayers() {
  const el = document.getElementById('room-players-list');
  if (!el) return;
  el.innerHTML = _roomPlayers.map(p =>
    `<div class="room-player">${p.username === netUsername ? '⭐ ' : '👤 '}${p.username}</div>`
  ).join('');
}

function startOnlineGame() {
  document.getElementById('room-lobby-screen').style.display = 'none';
  document.getElementById('char-select').style.display = 'flex';
}

function leaveRoom() {
  if (socket) { socket.disconnect(); socket = null; }
  netRoom = null; _roomPlayers = [];
  serverEnemies = []; otherPlayers = {};
  document.getElementById('room-lobby-screen').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('auth-error').textContent = '';
}

function _finishOnlineStart() {
  document.getElementById('char-select').style.display = 'none';
  document.getElementById('bottom-nav').style.display = 'block';
  document.querySelectorAll('.bpanel').forEach(p => p.style.display = 'block');
  state = 'playing';
  setTab(0);
}

function playOffline() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('lobby-screen').style.display = 'none';
  document.getElementById('char-select').style.display = 'flex';
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
