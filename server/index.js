const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const PlayerModel = require('./models/Player');
const Room = require('./game/Room');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 20000,
});

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err));

// Images: cache 30 days — sprites never change between deploys
app.use('/images', express.static(path.join(__dirname, '..', 'images'), { maxAge: '30d', immutable: true }));
// HTML/JS/CSS: no cache so updates are picked up immediately
app.use(express.static(path.join(__dirname, '..')));

// One Room per floor, created on demand, destroyed when empty
const floorRooms = new Map();

function getRoom(floor) {
  if (!floorRooms.has(floor)) {
    floorRooms.set(floor, new Room(floor, io));
    console.log(`floor ${floor}: room created`);
  }
  return floorRooms.get(floor);
}

function releaseRoom(floor) {
  const room = floorRooms.get(floor);
  if (room && room.players.size === 0) {
    room.stop();
    floorRooms.delete(floor);
    console.log(`floor ${floor}: room destroyed`);
  }
}

io.on('connection', socket => {
  console.log('connect:', socket.id);
  let authed = null;
  let currentRoom = null;
  let currentFloor = 1;

  socket.on('register', async ({ username, password }) => {
    try {
      if (!username || username.length < 2 || !password || password.length < 4)
        return socket.emit('authError', { message: 'Имя ≥2 символа, пароль ≥4 символа' });
      if (await PlayerModel.findOne({ username }))
        return socket.emit('authError', { message: 'Имя уже занято' });
      const hash = await bcrypt.hash(password, 10);
      const doc = await PlayerModel.create({ username, passwordHash: hash });
      authed = doc;
      socket.emit('authOk', { username: doc.username, savedData: doc.savedData || null });
    } catch { socket.emit('authError', { message: 'Ошибка сервера' }); }
  });

  socket.on('login', async ({ username, password }) => {
    try {
      const doc = await PlayerModel.findOne({ username });
      if (!doc) return socket.emit('authError', { message: 'Пользователь не найден' });
      if (!await bcrypt.compare(password, doc.passwordHash))
        return socket.emit('authError', { message: 'Неверный пароль' });
      authed = doc;
      socket.emit('authOk', { username: doc.username, savedData: doc.savedData || null });
    } catch { socket.emit('authError', { message: 'Ошибка сервера' }); }
  });

  socket.on('selectChar', ({ type, savedStats }) => {
    if (!authed) return;
    if (!currentRoom) {
      currentFloor = 1;
      currentRoom = getRoom(1);
      socket.join(`floor_${currentFloor}`);
      currentRoom.addPlayer(socket.id, authed.username);
      socket.to(`floor_${currentFloor}`).emit('playerJoined', { id: socket.id, username: authed.username });
    }
    currentRoom.setPlayerChar(socket.id, type, savedStats || null);
    socket.to(`floor_${currentFloor}`).emit('playerChar', { id: socket.id, type });
    socket.emit('gameStart', {
      floor: currentFloor,
      dungeon: currentRoom.dungeonData,
      enemies: currentRoom.enemySnapshot(),
    });
  });

  socket.on('playerMove', ({ x, y, facing, hp, maxHp }) => {
    if (currentRoom) currentRoom.updatePlayerPos(socket.id, x, y, facing, hp, maxHp);
  });

  socket.on('attack', ({ enemyId }) => {
    if (!currentRoom) return;
    const result = currentRoom.attackEnemy(socket.id, enemyId);
    if (!result) return;
    if (result.killed) {
      io.to(`floor_${currentFloor}`).emit('enemyKilled', {
        id: enemyId, xp: result.xp, gold: result.gold,
        dmg: result.dmg, ex: result.ex, ey: result.ey, color: result.color,
      });
    } else {
      io.to(`floor_${currentFloor}`).emit('enemyHurt', { id: enemyId, hp: result.hp, dmg: result.dmg });
    }
  });

  socket.on('changeFloor', ({ floor }) => {
    if (!currentRoom) return;
    const newFloor = Math.max(1, Math.min(20, floor));
    if (newFloor === currentFloor) return;

    // Snapshot player state before leaving
    const p = currentRoom.players.get(socket.id);

    // Leave old floor
    socket.leave(`floor_${currentFloor}`);
    socket.to(`floor_${currentFloor}`).emit('playerLeft', { id: socket.id });
    currentRoom.removePlayer(socket.id);
    releaseRoom(currentFloor);

    // Join new floor
    currentFloor = newFloor;
    currentRoom = getRoom(newFloor);
    socket.join(`floor_${newFloor}`);
    currentRoom.addPlayer(socket.id, authed.username);

    // Re-apply character stats (carry over HP, atk, def, maxHp)
    if (p?.type) {
      currentRoom.setPlayerChar(socket.id, p.type, {
        maxHp: p.maxHp, atk: p.atk, def: p.def,
      });
      const np = currentRoom.players.get(socket.id);
      if (np) np.hp = p.hp;
    }

    socket.to(`floor_${newFloor}`).emit('playerJoined', { id: socket.id, username: authed.username });
    if (p?.type) socket.to(`floor_${newFloor}`).emit('playerChar', { id: socket.id, type: p.type });

    socket.emit('floorChanged', {
      floor: newFloor,
      dungeon: currentRoom.dungeonData,
      enemies: currentRoom.enemySnapshot(),
    });
  });

  socket.on('pvpAttack', ({ targetId }) => {
    if (!currentRoom) return;
    const result = currentRoom.pvpAttack(socket.id, targetId);
    if (!result) return;
    // Send damage delta to target (client applies it; avoids server HP sync issues)
    io.to(targetId).emit('pvpDamage', { dmg: result.dmg });
    socket.emit('pvpHit', { x: result.x, y: result.y, dmg: result.dmg });
  });

  socket.on('saveProgress', ({ stats }) => {
    if (authed) PlayerModel.findByIdAndUpdate(authed._id, { savedData: stats }).catch(() => {});
  });

  socket.on('disconnect', () => {
    console.log('disconnect:', socket.id);
    if (!currentRoom) return;
    socket.to(`floor_${currentFloor}`).emit('playerLeft', { id: socket.id });
    currentRoom.removePlayer(socket.id);
    releaseRoom(currentFloor);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
