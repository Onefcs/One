// Minimal test server - no MongoDB needed - serves game files and stubs auth
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const ROOT = __dirname;
const BUNDLE_FILES = [
  'shared/definitions.js',
  'js/constants.js',
  'js/utils.js',
  'js/state.js',
  'js/icons.js',
  'js/themes.js',
  'js/definitions.js',
  'js/sprites.js',
  'js/particles.js',
  'js/player.js',
  'js/combat.js',
  'js/input.js',
  'js/ui.js',
  'js/charselect.js',
  'js/network.js',
  'js/quests.js',
  'js/game.js',
  'js/npc.js',
].map(f => path.join(ROOT, f));

const jsBundle = BUNDLE_FILES.map(f => fs.readFileSync(f, 'utf8')).join('\n;\n');
const jsBundleEtag = `"${crypto.createHash('sha1').update(jsBundle).digest('hex').slice(0, 8)}"`;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use('/images', express.static(path.join(ROOT, 'images'), { maxAge: '30d' }));
// Stub: test server doesn't verify Telegram; bot username returned for widget init
app.get('/tg-botname', (req, res) => res.json({ username: 'TestBotDev' }));
app.get('/bundle.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('ETag', jsBundleEtag);
  res.setHeader('Cache-Control', 'no-cache');
  res.send(jsBundle);
});
// Serve index.html with CDN socket.io replaced by local endpoint
app.get('/', (req, res) => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
    .replace('https://cdn.socket.io/4.7.2/socket.io.min.js', '/socket.io/socket.io.js');
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});
app.use(express.static(ROOT));

const Room = require('./server/game/Room');
const floorRooms = new Map();

function getRoom(floor) {
  if (!floorRooms.has(floor)) floorRooms.set(floor, new Room(floor, io));
  return floorRooms.get(floor);
}

io.on('connection', socket => {
  let currentRoom = null, currentFloor = 1;
  const username = 'TestPlayer_' + socket.id.slice(0,4);

  // Stub auth - auto-accept (no signature check in test mode)
  socket.on('loginTelegram', () => socket.emit('authOk', { username, savedData: null }));
  socket.on('loginTelegramWebApp', () => socket.emit('authOk', { username, savedData: null }));

  socket.on('selectChar', ({ type, savedStats }) => {
    if (!currentRoom) {
      currentRoom = getRoom(1);
      socket.join('floor_1');
      currentRoom.addPlayer(socket.id, username);
    }
    currentRoom.setPlayerChar(socket.id, type, savedStats || null);
    socket.emit('gameStart', { floor: 1, dungeon: currentRoom.dungeonData, enemies: currentRoom.enemySnapshot() });
  });

  socket.on('playerMove', ({ x, y, facing }) => { if (currentRoom) currentRoom.updatePlayerPos(socket.id, x, y, facing); });
  socket.on('attack', ({ enemyId }) => {
    if (!currentRoom) return;
    const result = currentRoom.attackEnemy(socket.id, enemyId);
    if (!result) return;
    if (result.killed) {
      socket.emit('enemyKilled', { id: enemyId, xp: result.xp, gold: result.gold, dmg: result.dmg, ex: result.ex, ey: result.ey, color: result.color });
    } else {
      io.to('floor_1').emit('enemyHurt', { id: enemyId, hp: result.hp, dmg: result.dmg });
    }
  });
  socket.on('respawn', () => { if (currentRoom) currentRoom.respawnPlayer(socket.id); });
  socket.on('setPvpMode', ({ pvpMode }) => { if (currentRoom) currentRoom.setPlayerPvpMode(socket.id, pvpMode); });
  socket.on('usePotion', ({ amount }) => { if (currentRoom) currentRoom.healPlayer(socket.id, Math.min(amount || 60, 200)); });
  socket.on('statsUpdate', ({ atk, def, maxHp }) => { if (currentRoom) currentRoom.updatePlayerStats(socket.id, { atk, def, maxHp }); });
  socket.on('spawnProj', data => { socket.to('floor_1').emit('spawnProj', data); });
  socket.on('spawnAoe', data => { socket.to('floor_1').emit('spawnAoe', data); });
  socket.on('saveProgress', () => {});

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    socket.to('floor_1').emit('playerLeft', { id: socket.id });
    currentRoom.removePlayer(socket.id);
  });
});

server.listen(3000, () => console.log('Test server on port 3000'));
