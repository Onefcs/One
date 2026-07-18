const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const PlayerModel = require('./models/Player');
const Room = require('./game/Room');

// Bot token — set TG_BOT_TOKEN env var in Railway; the value here is the fallback
const _TG_TOKEN = process.env.TG_BOT_TOKEN || '8851991556:AAH4hdTeSHPP8sY4wENmSCNfdzurpUi05c4';
let _tgBotUsername = process.env.TG_BOT_USERNAME || '';

function verifyTelegramAuth(data) {
  const { hash, ...rest } = data;
  if (!hash) return false;
  const checkStr = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(_TG_TOKEN).digest();
  const computed = crypto.createHmac('sha256', secret).update(checkStr).digest('hex');
  if (computed !== hash) return false;
  if (Date.now() / 1000 - Number(data.auth_date) > 86400) return false;
  return true;
}

if (!_tgBotUsername) {
  fetch(`https://api.telegram.org/bot${_TG_TOKEN}/getMe`)
    .then(r => r.json())
    .then(d => { if (d.ok) { _tgBotUsername = d.result.username; console.log('TG bot:', _tgBotUsername); } })
    .catch(err => console.error('Could not fetch TG bot username:', err));
}

const ROOT = path.join(__dirname, '..');
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
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 20000,
});

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err));

// Images: cache 30 days — sprites never change between deploys
app.use('/images', express.static(path.join(__dirname, '..', 'images'), { maxAge: '30d', immutable: true }));

// Single JS bundle — ETag changes on every server restart (bundle rebuilt on startup)
app.get('/bundle.js', (req, res) => {
  if (req.headers['if-none-match'] === jsBundleEtag) return res.status(304).end();
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('ETag', jsBundleEtag);
  res.setHeader('Cache-Control', 'no-cache');
  res.send(jsBundle);
});

// HTML/CSS: no cache so updates are picked up immediately
app.use(express.static(path.join(__dirname, '..')));

app.get('/tg-botname', (req, res) => {
  if (_tgBotUsername) return res.json({ username: _tgBotUsername });
  // Retry fetch once in case startup request is still in-flight
  fetch(`https://api.telegram.org/bot${_TG_TOKEN}/getMe`)
    .then(r => r.json())
    .then(d => {
      if (d.ok) { _tgBotUsername = d.result.username; res.json({ username: _tgBotUsername }); }
      else res.status(503).json({ error: 'bot not resolved' });
    })
    .catch(() => res.status(503).json({ error: 'bot not resolved' }));
});

// One Room per floor, created on demand, destroyed when empty
const floorRooms = new Map();

// ── Party state ───────────────────────────────────────────────────────────────
// partyId -> Map<socketId, username>  (up to 5 members)
const parties     = new Map();
// socketId -> partyId
const playerParty = new Map();
// socketId -> current floor number (for proximity check)
const playerFloorMap = new Map();

// Remove leaverId from their party; notify remaining members.
// If only 1 member remains the party dissolves entirely.
function _removeFromParty(partyId, leaverId) {
  const members = parties.get(partyId);
  if (!members) return;

  const leaverName = members.get(leaverId) || leaverId.slice(0, 6);
  members.delete(leaverId);
  playerParty.delete(leaverId);

  const remaining = [];
  members.forEach((name, id) => remaining.push({ id, name }));

  if (remaining.length <= 1) {
    // Party fully dissolves
    parties.delete(partyId);
    remaining.forEach(m => {
      playerParty.delete(m.id);
      io.to(m.id).emit('partyLeft', { leftName: leaverName });
    });
  } else {
    // Party shrinks; send notification then updated list to each remaining member
    remaining.forEach(m => {
      io.to(m.id).emit('partyLeft', { leftName: leaverName });
      const othersForM = remaining.filter(r => r.id !== m.id);
      io.to(m.id).emit('partyUpdated', { members: othersForM });
    });
  }
}

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
  playerFloorMap.set(socket.id, currentFloor);

  socket.on('loginTelegram', async (data) => {
    try {
      if (!verifyTelegramAuth(data))
        return socket.emit('authError', { message: 'Ошибка авторизации Telegram' });
      const telegramId = String(data.id);
      const username = data.username || data.first_name || `tg_${telegramId}`;
      let doc = await PlayerModel.findOne({ telegramId });
      if (!doc) doc = await PlayerModel.create({ telegramId, username });
      authed = doc;
      socket.data.username = doc.username;
      socket.emit('authOk', { username: doc.username, savedData: doc.savedData || null });
    } catch (err) {
      console.error('loginTelegram:', err);
      socket.emit('authError', { message: 'Ошибка сервера' });
    }
  });

  socket.on('selectChar', ({ type, savedStats }) => {
    if (!authed) return;
    if (!currentRoom) {
      currentFloor = 1;
      currentRoom = getRoom(1);
      playerFloorMap.set(socket.id, currentFloor);
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

  socket.on('playerMove', ({ x, y, facing, hp }) => {
    if (!currentRoom) return;
    currentRoom.updatePlayerPos(socket.id, x, y, facing);
    if (hp != null && isFinite(hp)) currentRoom.syncPlayerHp(socket.id, hp);
  });

  socket.on('usePotion', ({ amount }) => {
    if (currentRoom) currentRoom.healPlayer(socket.id, Math.min(amount || 60, 200));
  });

  socket.on('statsUpdate', ({ atk, def, maxHp }) => {
    if (currentRoom) currentRoom.updatePlayerStats(socket.id, { atk, def, maxHp });
  });

  socket.on('pvpDamageTaken', ({ actual }) => {
    if (!currentRoom) return;
    const newHp = currentRoom.applyPvpDamage(socket.id, Math.max(0, Math.min(actual, 9999)));
    if (newHp !== null && newHp <= 0)
      io.to(socket.id).emit('playerHurt', { id: socket.id, hp: 0 });
  });

  socket.on('attack', ({ enemyId }) => {
    if (!currentRoom) return;
    const result = currentRoom.attackEnemy(socket.id, enemyId);
    if (!result) return;
    if (result.killed) {
      const partyId    = playerParty.get(socket.id);
      const partyMap   = partyId ? parties.get(partyId) : null;

      // Party members on the same floor (excluding attacker)
      const memberIds = [];
      if (partyMap) {
        partyMap.forEach((_, mid) => {
          if (mid !== socket.id && playerFloorMap.get(mid) === currentFloor) memberIds.push(mid);
        });
      }

      // Boss stone: 100% drop, quantity = floor + 0..2 (floor 1→1-3, floor 2→2-4, ...)
      const bossStone = result.isBoss
        ? (currentFloor + Math.floor(Math.random() * 3)) : 0;

      if (memberIds.length > 0) {
        const totalMembers = memberIds.length + 1;
        const xpShare   = result.xp   / totalMembers;
        const goldShare = result.gold  / totalMembers;

        // Random loot recipient among party + attacker
        const allIds = [socket.id, ...memberIds];
        const lootWinnerId = allIds[Math.floor(Math.random() * allIds.length)];

        socket.emit('enemyKilled', {
          id: enemyId, xp: xpShare, gold: goldShare,
          dmg: result.dmg, ex: result.ex, ey: result.ey, color: result.color,
          gotLoot: lootWinnerId === socket.id,
          bossStone: lootWinnerId === socket.id ? bossStone : 0,
        });
        memberIds.forEach(mid => {
          io.to(mid).emit('enemyKilled', {
            id: enemyId, xp: xpShare, gold: goldShare,
            ex: result.ex, ey: result.ey, color: result.color,
            gotLoot: lootWinnerId === mid,
            bossStone: lootWinnerId === mid ? bossStone : 0,
          });
        });
        // Visual only to the rest of the floor
        socket.to(`floor_${currentFloor}`).except(memberIds).emit('enemyKilled', {
          id: enemyId, ex: result.ex, ey: result.ey, color: result.color,
        });
      } else {
        // No party: attacker gets full reward and loot
        socket.emit('enemyKilled', {
          id: enemyId, xp: result.xp, gold: result.gold,
          dmg: result.dmg, ex: result.ex, ey: result.ey, color: result.color,
          gotLoot: true, bossStone,
        });
        socket.to(`floor_${currentFloor}`).emit('enemyKilled', {
          id: enemyId, ex: result.ex, ey: result.ey, color: result.color,
        });
      }
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
    playerFloorMap.set(socket.id, currentFloor);
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
      if (p.pvpMode) currentRoom.setPlayerPvpMode(socket.id, true);
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
    socket.emit('pvpHit', { x: result.x, y: result.y, dmg: result.dmg, targetId });
  });

  socket.on('respawn', () => {
    if (currentRoom) currentRoom.respawnPlayer(socket.id);
  });

  socket.on('setPvpMode', ({ pvpMode }) => {
    if (currentRoom) currentRoom.setPlayerPvpMode(socket.id, pvpMode);
  });

  socket.on('spawnProj', data => {
    if (!currentRoom) return;
    socket.to(`floor_${currentFloor}`).emit('spawnProj', data);
  });

  socket.on('spawnAoe', data => {
    if (!currentRoom) return;
    socket.to(`floor_${currentFloor}`).emit('spawnAoe', data);
  });

  socket.on('healParty', ({ amount }) => {
    if (!authed || !currentRoom) return;
    const healAmt = Math.max(0, Math.min(Math.floor(amount), 9999));
    const partyId = playerParty.get(socket.id);
    if (!partyId) return;
    const partyMap = parties.get(partyId);
    if (!partyMap) return;
    partyMap.forEach((_, mid) => {
      if (mid === socket.id) return;
      if (playerFloorMap.get(mid) !== currentFloor) return;
      if (currentRoom.healPartyMember(mid, healAmt))
        io.to(mid).emit('healPartyMember', { amount: healAmt });
    });
  });

  socket.on('chat', ({ text }) => {
    if (!authed || !text || typeof text !== 'string') return;
    const msg = text.trim().slice(0, 100);
    if (!msg) return;
    io.to(`floor_${currentFloor}`).emit('chatMsg', { username: authed.username, text: msg });
  });

  socket.on('saveProgress', ({ stats }) => {
    if (authed) PlayerModel.findByIdAndUpdate(authed._id, { savedData: stats }).catch(() => {});
  });

  // ── Party ─────────────────────────────────────────────────────────────────
  socket.on('partyInvite', ({ targetId }) => {
    if (!authed) return;
    // Target must not already be in a party
    if (playerParty.has(targetId)) return;
    // Inviter's party must not be full (max 5)
    const inviterPartyId = playerParty.get(socket.id);
    if (inviterPartyId) {
      const inviterParty = parties.get(inviterPartyId);
      if (inviterParty && inviterParty.size >= 5) return;
    }
    const targetSocket = io.sockets.sockets.get(targetId);
    if (!targetSocket) return;
    targetSocket.emit('partyInviteReceived', { fromId: socket.id, fromName: authed.username });
  });

  socket.on('partyAccept', ({ fromId }) => {
    if (!authed || playerParty.has(socket.id)) return;
    const fromSocket = io.sockets.sockets.get(fromId);
    if (!fromSocket) return;

    const fromPartyId = playerParty.get(fromId);
    let partyId, partyMap;

    if (fromPartyId) {
      // Join inviter's existing party
      partyMap = parties.get(fromPartyId);
      if (!partyMap || partyMap.size >= 5) return;
      partyId = fromPartyId;
      partyMap.set(socket.id, authed.username);
      playerParty.set(socket.id, partyId);
    } else {
      // Create new party
      partyId = fromId + '_' + socket.id;
      partyMap = new Map();
      partyMap.set(fromId, fromSocket.data.username || fromId.slice(0, 6));
      partyMap.set(socket.id, authed.username);
      parties.set(partyId, partyMap);
      playerParty.set(fromId, partyId);
      playerParty.set(socket.id, partyId);
    }

    // Emit partyUpdated to each member with the list of OTHER members
    partyMap.forEach((_, mid) => {
      const others = [];
      partyMap.forEach((name, oid) => { if (oid !== mid) others.push({ id: oid, name }); });
      io.to(mid).emit('partyUpdated', { members: others });
    });
  });

  socket.on('partyDecline', () => { /* no cleanup needed */ });

  socket.on('partyLeave', () => {
    const partyId = playerParty.get(socket.id);
    if (partyId) _removeFromParty(partyId, socket.id);
  });

  socket.on('disconnect', () => {
    console.log('disconnect:', socket.id);
    playerFloorMap.delete(socket.id);
    const partyId = playerParty.get(socket.id);
    if (partyId) _removeFromParty(partyId, socket.id);
    if (!currentRoom) return;
    socket.to(`floor_${currentFloor}`).emit('playerLeft', { id: socket.id });
    currentRoom.removePlayer(socket.id);
    releaseRoom(currentFloor);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
