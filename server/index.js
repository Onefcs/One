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

app.use(express.static(path.join(__dirname, '..')));

const rooms = new Map(); // code → Room

function genCode() {
  let code;
  do { code = Math.random().toString(36).slice(2, 8).toUpperCase(); } while (rooms.has(code));
  return code;
}

io.on('connection', socket => {
  console.log('connect:', socket.id);
  let authed = null;   // DB player doc
  let currentRoom = null;

  socket.on('register', async ({ username, password }) => {
    try {
      if (!username || username.length < 2 || !password || password.length < 4)
        return socket.emit('authError', { message: 'Имя ≥2 символа, пароль ≥4 символа' });
      if (await PlayerModel.findOne({ username }))
        return socket.emit('authError', { message: 'Имя уже занято' });
      const hash = await bcrypt.hash(password, 10);
      const doc = await PlayerModel.create({ username, passwordHash: hash });
      authed = doc;
      socket.emit('authOk', { playerId: String(doc._id), username: doc.username });
    } catch { socket.emit('authError', { message: 'Ошибка сервера' }); }
  });

  socket.on('login', async ({ username, password }) => {
    try {
      const doc = await PlayerModel.findOne({ username });
      if (!doc) return socket.emit('authError', { message: 'Пользователь не найден' });
      if (!await bcrypt.compare(password, doc.passwordHash))
        return socket.emit('authError', { message: 'Неверный пароль' });
      authed = doc;
      socket.emit('authOk', { playerId: String(doc._id), username: doc.username });
    } catch { socket.emit('authError', { message: 'Ошибка сервера' }); }
  });

  socket.on('createRoom', () => {
    if (!authed) return;
    const code = genCode();
    const room = new Room(code, io);
    rooms.set(code, room);
    currentRoom = room;
    socket.join(code);
    room.addPlayer(socket.id, authed.username);
    socket.emit('roomCreated', { code });
  });

  socket.on('joinRoom', ({ code }) => {
    if (!authed) return;
    const room = rooms.get(code);
    if (!room) return socket.emit('roomError', { message: 'Комната не найдена' });
    if (room.isFull()) return socket.emit('roomError', { message: 'Комната полна (макс. 4)' });
    currentRoom = room;
    socket.join(code);
    room.addPlayer(socket.id, authed.username);
    socket.emit('roomJoined', { code, players: room.getPlayerList() });
    socket.to(code).emit('playerJoined', { id: socket.id, username: authed.username });
  });

  socket.on('selectChar', ({ type }) => {
    if (!currentRoom) return;
    currentRoom.setPlayerChar(socket.id, type);
    socket.to(currentRoom.code).emit('playerChar', { id: socket.id, type });
    const dungeonData = currentRoom.getDungeonData();
    socket.emit('gameStart', { floor: currentRoom.floor, dungeon: dungeonData });
  });

  socket.on('playerMove', ({ x, y, facing }) => {
    if (currentRoom) currentRoom.updatePlayerPos(socket.id, x, y, facing);
  });

  socket.on('attack', ({ enemyId }) => {
    if (!currentRoom) return;
    const result = currentRoom.attackEnemy(socket.id, enemyId);
    if (!result) return;
    if (result.killed) {
      io.to(currentRoom.code).emit('enemyKilled', {
        id: enemyId, xp: result.xp, gold: result.gold,
        dmg: result.dmg, ex: result.ex, ey: result.ey, color: result.color,
      });
    } else {
      io.to(currentRoom.code).emit('enemyHurt', { id: enemyId, hp: result.hp, dmg: result.dmg });
    }
  });

  socket.on('changeFloor', ({ floor }) => {
    if (!currentRoom) return;
    currentRoom.changeFloor(floor);
    const dungeonData = currentRoom.getDungeonData();
    io.to(currentRoom.code).emit('floorChanged', { floor: currentRoom.floor, dungeon: dungeonData });
  });

  socket.on('saveProgress', ({ stats }) => {
    if (authed) PlayerModel.findByIdAndUpdate(authed._id, { savedData: stats }).catch(() => {});
  });

  socket.on('disconnect', () => {
    console.log('disconnect:', socket.id);
    if (!currentRoom) return;
    currentRoom.removePlayer(socket.id);
    io.to(currentRoom.code).emit('playerLeft', { id: socket.id });
    if (currentRoom.isEmpty()) {
      currentRoom.stop();
      rooms.delete(currentRoom.code);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
