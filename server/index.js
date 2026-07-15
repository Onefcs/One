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

const world = new Room('world', io);

io.on('connection', socket => {
  console.log('connect:', socket.id);
  let authed = null;
  let inWorld = false;

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
    if (!inWorld) {
      inWorld = true;
      socket.join('world');
      world.addPlayer(socket.id, authed.username);
      socket.to('world').emit('playerJoined', { id: socket.id, username: authed.username });
    }
    world.setPlayerChar(socket.id, type, savedStats || null);
    socket.to('world').emit('playerChar', { id: socket.id, type });
    const dungeonData = world.getDungeonData();
    socket.emit('gameStart', { floor: world.floor, dungeon: dungeonData });
  });

  socket.on('playerMove', ({ x, y, facing }) => {
    if (inWorld) world.updatePlayerPos(socket.id, x, y, facing);
  });

  socket.on('attack', ({ enemyId }) => {
    if (!inWorld) return;
    const result = world.attackEnemy(socket.id, enemyId);
    if (!result) return;
    if (result.killed) {
      io.to('world').emit('enemyKilled', {
        id: enemyId, xp: result.xp, gold: result.gold,
        dmg: result.dmg, ex: result.ex, ey: result.ey, color: result.color,
      });
    } else {
      io.to('world').emit('enemyHurt', { id: enemyId, hp: result.hp, dmg: result.dmg });
    }
  });

  socket.on('changeFloor', ({ floor }) => {
    if (!inWorld) return;
    world.changeFloor(floor);
    const dungeonData = world.getDungeonData();
    io.to('world').emit('floorChanged', { floor: world.floor, dungeon: dungeonData });
  });

  socket.on('saveProgress', ({ stats }) => {
    if (authed) PlayerModel.findByIdAndUpdate(authed._id, { savedData: stats }).catch(() => {});
  });

  socket.on('disconnect', () => {
    console.log('disconnect:', socket.id);
    if (!inWorld) return;
    world.removePlayer(socket.id);
    io.to('world').emit('playerLeft', { id: socket.id });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
