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
    serverEnemies = (initialEnemies || []).map(e => ({ ...e, targetX: e.x, targetY: e.y }));
    serverEnemiesMap = new Map(serverEnemies.map(e => [e.id, e]));
    otherPlayers = {};
    buildTileCanvas();
    projs = []; otherProjs = []; drops = []; particles = []; dmgNums = [];
    if (player) {
      player.x = d.spawn.x; player.y = d.spawn.y;
      camera.x = player.x - W / 2; camera.y = player.y - H / 2;
      clampCamera();
    }
    const restore = _savedData && _savedData.type === player?.type ? _savedData : null;
    if (restore) { restoreFromSave(restore); _savedData = null; }
    csOnServerReady();
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
        if (p.atkSeq !== undefined && p.atkSeq !== (op.atkSeq || 0)) {
          op.atkSeq = p.atkSeq;
          op.atkAnimTimer = 0.55; op.animFrame = 0; op.animTimer = 0;
        }
      }
    });

    // Remove players that left AOI or disconnected
    const pids = new Set(players.map(p => p.id));
    Object.keys(otherPlayers).forEach(id => { if (!pids.has(id)) delete otherPlayers[id]; });

    // Delta update: only changed enemies arrive — add or update, never remove
    // (removal happens via enemyKilled; respawn via re-add when hp > 0)
    enemies.forEach(se => {
      const ex = serverEnemiesMap.get(se.id);
      if (ex) {
        ex.hp = se.hp; ex.maxHp = se.maxHp;
        ex.targetX = se.x; ex.targetY = se.y;
        ex.aggro = se.aggro;
        if (se.hurtTimer > (ex.hurtTimer || 0)) ex.hurtTimer = se.hurtTimer;
        if (se.atkAnimTimer > (ex.atkAnimTimer || 0)) ex.atkAnimTimer = se.atkAnimTimer;
      } else {
        const newE = { ...se, targetX: se.x, targetY: se.y };
        serverEnemies.push(newE);
        serverEnemiesMap.set(se.id, newE);
      }
    });
  });

  socket.on('playerHurt', ({ id, hp }) => {
    if (player && id === socket.id) {
      player.hp = hp;
      player.hurtTimer = 0.1;
      if (player.hp <= 0) { player.hp = 0; playerDie(); }
    } else if (otherPlayers[id]) {
      otherPlayers[id].hp = hp;
      otherPlayers[id].hurtTimer = 0.1;
      if (hp <= 0 && id === targetId && targetIsPlayer) { targetId = null; targetIsPlayer = false; }
    }
  });

  socket.on('pvpDamage', ({ dmg }) => {
    if (!player || state !== 'playing') return;
    let actual = 0;
    if (barrierTimer > 0) {
      dmgNum(player.x, player.y - 24, 'БЛОК', '#88f');
    } else {
      actual = Math.max(1, Math.floor(dmg * (dodgeTimer > 0 ? 0.3 : 1)));
      player.hp = Math.max(0, player.hp - actual);
      player.hurtTimer = 0.1;
      dmgNum(player.x, player.y - 24, actual, '#f55');
      spawnBurst(player.x, player.y, '#f44', 5);
      if (player.hp <= 0 && state === 'playing') { player.hp = 0; playerDie(); }
    }
    // Report actual damage taken so server can track authoritative HP
    socket.emit('pvpDamageTaken', { actual });
  });

  socket.on('pvpHit', ({ x, y, dmg, targetId: hitTargetId }) => {
    if (dmg) dmgNum(x, y - 24, dmg, '#f88');
    spawnBurst(x, y, '#f44', 4);
    if (hitTargetId && otherPlayers[hitTargetId])
      otherPlayers[hitTargetId].hurtTimer = 0.1;
  });

  socket.on('enemyHurt', ({ id, hp, dmg }) => {
    const e = serverEnemiesMap.get(id);
    if (e) {
      e.hp = hp;
      e.hurtTimer = 0.3;
      if (dmg) dmgNum(e.x, e.y - e.size - 4, dmg, '#ff4');
    }
  });

  socket.on('enemyKilled', ({ id, xp, gold, dmg, ex, ey, color }) => {
    if (id === targetId && !targetIsPlayer) { targetId = null; targetIsPlayer = false; }
    const e = serverEnemiesMap.get(id);
    const px = ex ?? (e ? e.x : player?.x ?? 0);
    const py = ey ?? (e ? e.y : player?.y ?? 0);
    if (dmg) dmgNum(px, py - 20, dmg, '#ff4');
    spawnBurst(px, py, color || '#f80', 8);
    serverEnemiesMap.delete(id);
    let j = 0;
    for (let i = 0; i < serverEnemies.length; i++) {
      if (serverEnemies[i].id !== id) serverEnemies[j++] = serverEnemies[i];
    }
    serverEnemies.length = j;
    if (xp && player) { gainXP(xp); spawnLootDrop(px, py); }
    if (gold && player) {
      player.gold += gold;
      const g = gold % 1 === 0 ? gold : +gold.toFixed(1);
      dmgNum(px, py - 36, '+' + g + 'g', '#ff0');
    }
  });

  socket.on('floorChanged', ({ floor, dungeon: d, enemies: initialEnemies }) => {
    dungeonLvl = floor;
    dungeon = { ...d, enemies: [] };
    serverEnemies = (initialEnemies || []).map(e => ({ ...e, targetX: e.x, targetY: e.y }));
    serverEnemiesMap = new Map(serverEnemies.map(e => [e.id, e]));
    otherPlayers = {};
    buildTileCanvas();
    projs = []; otherProjs = []; drops = []; particles = []; dmgNums = [];
    if (player) {
      player.x = d.spawn.x; player.y = d.spawn.y;
      camera.x = player.x - W / 2; camera.y = player.y - H / 2;
      clampCamera();
    }
    initNpcs();
    transTimer = 0.5;
  });

  socket.on('spawnProj', data => {
    otherProjs.push({ ...data });
  });

  socket.on('spawnAoe', ({ x, y }) => {
    spawnAOE(x, y);
    spawnBurst(x, y, '#f4f', 6);
  });

  socket.on('partyInviteReceived', ({ fromId, fromName }) => {
    if (partyMembers.length > 0) return; // already in party
    partyInvitePending = { fromId, fromName, timer: 15 };
  });

  // Server sends full updated member list (excluding self) on every party change
  socket.on('partyUpdated', ({ members }) => {
    partyMembers = members; // [{ id, name }]
    partyInvitePending = null;
    if (player && partyMembers.length > 0)
      dmgNum(player.x, player.y - 30, 'Пати: ' + partyMembers.length + ' чел.', '#3ef07a');
  });

  socket.on('partyLeft', ({ leftName }) => {
    if (leftName && player)
      dmgNum(player.x, player.y - 30, leftName + ' покинул пати', '#fa0');
    partyMembers = [];
  });

  socket.on('disconnect', () => {
    socket = null;
    serverEnemies = [];
    otherPlayers = {};
    otherProjs = [];
    partyMembers = [];
    partyInvitePending = null;
  });
}

// ── Party helpers ─────────────────────────────────────────
function netPartyInvite(targetId) {
  if (socket?.connected) socket.emit('partyInvite', { targetId });
}
function netPartyAccept(fromId) {
  if (socket?.connected) socket.emit('partyAccept', { fromId });
  partyInvitePending = null;
}
function netPartyDecline(fromId) {
  if (socket?.connected) socket.emit('partyDecline', { fromId });
  partyInvitePending = null;
}
function netPartyLeave() {
  if (socket?.connected) socket.emit('partyLeave');
  partyMembers = [];
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
  if (savedData && savedData.type) {
    // Character already exists — skip selection screen, go straight to loading
    const el = document.getElementById('char-select');
    if (el) {
      el.style.display = 'flex';
      const cards = el.querySelector('.cs-cards');
      if (cards) cards.style.display = 'none';
    }
    selectChar(savedData.type);
  } else {
    csShow(savedData);
  }
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
  csHide();
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
  socket.emit('playerMove', { x: player.x, y: player.y, facing: player.facing });
}

function netUsePotion(amount) {
  if (socket?.connected) socket.emit('usePotion', { amount });
}

function netStatsUpdate(atk, def, maxHp) {
  if (socket?.connected) socket.emit('statsUpdate', { atk, def, maxHp });
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

function netSpawnProj(proj) {
  if (socket?.connected) socket.emit('spawnProj', proj);
}

function netSpawnAoe(x, y) {
  if (socket?.connected) socket.emit('spawnAoe', { x, y });
}

