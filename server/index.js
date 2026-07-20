const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const PlayerModel = require('./models/Player');
const ClanModel   = require('./models/Clan');
const Room = require('./game/Room');
const { RaidRoom } = require('./game/RaidRoom');

// Bot token — set TG_BOT_TOKEN env var in Railway; the value here is the fallback
const _TG_TOKEN = process.env.TG_BOT_TOKEN || '8851991556:AAH4hdTeSHPP8sY4wENmSCNfdzurpUi05c4';
let _tgBotUsername = process.env.TG_BOT_USERNAME || '';

// Login Widget verification (browser button)
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

// Mini App verification (opened inside Telegram app) — different secret derivation
function verifyTelegramWebApp(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const checkStr = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(_TG_TOKEN).digest();
    const computed = crypto.createHmac('sha256', secret).update(checkStr).digest('hex');
    if (computed !== hash) return null;
    if (Date.now() / 1000 - Number(params.get('auth_date')) > 86400) return null;
    const userStr = params.get('user');
    return userStr ? JSON.parse(userStr) : null;
  } catch { return null; }
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
  'shared/netcodec.js',
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
  'js/clans.js',
  'js/game.js',
  'js/npc.js',
].map(f => path.join(ROOT, f));

const jsBundle = BUNDLE_FILES.map(f => fs.readFileSync(f, 'utf8')).join('\n;\n');
const jsBundleEtag = `"${crypto.createHash('sha1').update(jsBundle).digest('hex').slice(0, 8)}"`;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket'],   // force WebSocket only — no polling overhead
  pingTimeout: 20000,
  pingInterval: 10000,
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

// ── Battle Power (БМ) formula ─────────────────────────────────────────────────
function calcBM(s) {
  if (!s) return 0;
  const upg = s.upgrades || {};
  const extras = ((upg.critChance || 0) + (upg.critPower || 0) +
    (upg.hpRegen || 0) + (upg.atkSpeed || 0)) * 8;
  return Math.round((s.level || 1) * 50 + (s.atk || 0) * 5 + (s.def || 0) * 3 + (s.maxHp || 100) * 0.5 + extras);
}

// Global chat history (last 30 messages across all floors)
const globalChatHistory = [];
function _recordChat(username, text) {
  const now = new Date();
  const time = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
  globalChatHistory.push({ username, text, time });
  if (globalChatHistory.length > 30) globalChatHistory.shift();
}

// ── Party state ───────────────────────────────────────────────────────────────
// partyId -> Map<socketId, username>  (up to 5 members)
const parties     = new Map();
// socketId -> partyId
const playerParty = new Map();
// socketId -> current floor number (for proximity check)
const playerFloorMap = new Map();

// ── Raid state ────────────────────────────────────────────────────────────────
// raidId -> RaidRoom
const raidRooms  = new Map();
// socketId -> raidId
const playerRaid = new Map();

// ── Raid lobby state ─────────────────────────────────────────────────────────
// lobbyId -> { id, creatorId, creatorName, dungeonId, members: Map<sid, {name, bm, lvl}> }
const raidLobbies = new Map();
// socketId -> lobbyId
const playerLobby = new Map();

function _lobbyBroadcast() {
  const list = [...raidLobbies.values()].map(lb => ({
    id: lb.id, creatorName: lb.creatorName, dungeonId: lb.dungeonId,
    members: [...lb.members.entries()].map(([sid, m]) => ({ id: sid, name: m.name, bm: m.bm, lvl: m.lvl })),
  }));
  io.emit('lobbyList', { lobbies: list });
}

function _cleanupLobby(socketId) {
  const lobbyId = playerLobby.get(socketId);
  if (!lobbyId) return;
  const lb = raidLobbies.get(lobbyId);
  if (!lb) { playerLobby.delete(socketId); return; }
  lb.members.delete(socketId);
  playerLobby.delete(socketId);
  if (lb.members.size === 0 || lb.creatorId === socketId) {
    lb.members.forEach((_, mid) => { playerLobby.delete(mid); io.to(mid).emit('lobbyLeft', { reason: 'disbanded' }); });
    raidLobbies.delete(lobbyId);
    _lobbyBroadcast();
  } else {
    _lobbyBroadcast();
  }
}

function _cleanupRaidPlayer(socketId) {
  playerRaid.delete(socketId);
  const fl = playerFloorMap.get(socketId);
  if (fl !== undefined) {
    const fr = floorRooms.get(fl);
    if (fr) {
      const p = fr.players.get(socketId);
      if (p) {
        p._inRaid = false;
        p._knownE.clear(); // force full enemy refresh on next gameState
      }
    }
  }
}

function _cleanupRaid(socketId) {
  const rId = playerRaid.get(socketId);
  if (!rId) return;
  _cleanupRaidPlayer(socketId);
  const rr = raidRooms.get(rId);
  if (rr) {
    rr.removePlayer(socketId);
    if (rr.memberIds.length === 0) { rr._stop(); raidRooms.delete(rId); }
  }
}

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
  let _lastStats = null;
  let _autoSaveInterval = null;
  let _myClanName = null;
  let _myClanIcon = null;
  playerFloorMap.set(socket.id, currentFloor);

  function _startAutosave() {
    if (_autoSaveInterval) clearInterval(_autoSaveInterval);
    _autoSaveInterval = setInterval(() => {
      if (!authed || !_lastStats) return;
      const saveData = { ..._lastStats, floor: currentFloor };
      if (currentRoom) {
        const p = currentRoom.players.get(socket.id);
        if (p && p.hp > 0) saveData.hp = p.hp;
      }
      PlayerModel.findByIdAndUpdate(authed._id, { savedData: saveData }).catch(() => {});
    }, 60000);
  }

  socket.on('_ping', t0 => socket.emit('_pong', t0));

  socket.on('loginTelegramWebApp', async ({ initData }) => {
    try {
      const user = verifyTelegramWebApp(initData);
      if (!user) return socket.emit('authError', { message: 'Ошибка авторизации Telegram' });
      const telegramId = String(user.id);
      const username = user.username || user.first_name || `tg_${telegramId}`;
      let doc = await PlayerModel.findOne({ telegramId });
      if (!doc) doc = await PlayerModel.create({ telegramId, username });
      authed = doc;
      socket.data.username = doc.username;
      socket.data.telegramId = telegramId;
      if (doc.savedData) _lastStats = doc.savedData;
      _startAutosave();
      const _clan = await ClanModel.findOne({ 'members.telegramId': telegramId }).catch(() => null);
      const _clanInfo = _clan ? await _clanDataFor(_clan, telegramId) : null;
      _myClanName = _clanInfo ? _clanInfo.name : null;
      _myClanIcon = _clanInfo ? _clanInfo.icon : null;
      socket.emit('authOk', { username: doc.username, savedData: doc.savedData || null, clanInfo: _clanInfo });
    } catch (err) {
      console.error('loginTelegramWebApp:', err);
      socket.emit('authError', { message: 'Ошибка сервера' });
    }
  });

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
      socket.data.telegramId = telegramId;
      if (doc.savedData) _lastStats = doc.savedData;
      _startAutosave();
      const _clan = await ClanModel.findOne({ 'members.telegramId': telegramId }).catch(() => null);
      const _clanInfo = _clan ? await _clanDataFor(_clan, telegramId) : null;
      _myClanName = _clanInfo ? _clanInfo.name : null;
      _myClanIcon = _clanInfo ? _clanInfo.icon : null;
      socket.emit('authOk', { username: doc.username, savedData: doc.savedData || null, clanInfo: _clanInfo });
    } catch (err) {
      console.error('loginTelegram:', err);
      socket.emit('authError', { message: 'Ошибка сервера' });
    }
  });

  socket.on('selectChar', ({ type, savedStats }) => {
    if (!authed) return;
    if (savedStats) _lastStats = savedStats;
    if (!currentRoom) {
      const savedFloor = (savedStats?.floor > 1) ? Math.max(1, Math.min(20, savedStats.floor)) : 1;
      currentFloor = savedFloor;
      currentRoom = getRoom(currentFloor);
      playerFloorMap.set(socket.id, currentFloor);
      socket.join(`floor_${currentFloor}`);
      currentRoom.addPlayer(socket.id, authed.username, _myClanName, _myClanIcon);
      socket.to(`floor_${currentFloor}`).emit('playerJoined', { id: socket.id, username: authed.username });
      if (globalChatHistory.length) socket.emit('chatHistory', globalChatHistory);
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

  socket.on('statsUpdate', ({ atk, def, maxHp, critChance, critPower }) => {
    if (currentRoom) currentRoom.updatePlayerStats(socket.id, { atk, def, maxHp, critChance, critPower });
  });

  socket.on('pvpDamageTaken', ({ actual }) => {
    if (!currentRoom) return;
    const newHp = currentRoom.applyPvpDamage(socket.id, Math.max(0, Math.min(actual, 9999)));
    if (newHp !== null && newHp <= 0)
      io.to(socket.id).emit('playerHurt', { id: socket.id, hp: 0 });
  });

  socket.on('attack', ({ enemyId }) => {
    if (!currentRoom) return;
    if (currentRoom.isPlayerInSafeZone(socket.id)) return;
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

      const bossStone = result.isBoss
        ? (currentFloor + Math.floor(Math.random() * 3)) : 0;
      const normStone  = result.isBoss && Math.random() < 0.10 ? 1 : 0;
      const blessStone = result.isBoss && Math.random() < 0.01 ? 1 : 0;

      if (memberIds.length > 0) {
        const totalMembers = memberIds.length + 1;
        const xpShare   = result.xp   / totalMembers;
        const goldShare = result.gold  / totalMembers;

        // Random loot recipient among party + attacker
        const allIds = [socket.id, ...memberIds];
        const lootWinnerId = allIds[Math.floor(Math.random() * allIds.length)];

        socket.emit('enemyKilled', {
          id: enemyId, xp: xpShare, gold: goldShare,
          dmg: result.dmg, isCrit: result.isCrit, ex: result.ex, ey: result.ey, color: result.color,
          gotLoot: lootWinnerId === socket.id, eid: result.eid,
          bossStone: lootWinnerId === socket.id ? bossStone : 0,
          normStone:  lootWinnerId === socket.id ? normStone  : 0,
          blessStone: lootWinnerId === socket.id ? blessStone : 0,
        });
        memberIds.forEach(mid => {
          io.to(mid).emit('enemyKilled', {
            id: enemyId, xp: xpShare, gold: goldShare,
            ex: result.ex, ey: result.ey, color: result.color,
            gotLoot: lootWinnerId === mid, eid: result.eid,
            bossStone:  lootWinnerId === mid ? bossStone  : 0,
            normStone:  lootWinnerId === mid ? normStone  : 0,
            blessStone: lootWinnerId === mid ? blessStone : 0,
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
          dmg: result.dmg, isCrit: result.isCrit, ex: result.ex, ey: result.ey, color: result.color,
          gotLoot: true, eid: result.eid, bossStone, normStone, blessStone,
        });
        socket.to(`floor_${currentFloor}`).emit('enemyKilled', {
          id: enemyId, ex: result.ex, ey: result.ey, color: result.color,
        });
      }
    } else {
      io.to(`floor_${currentFloor}`).emit('enemyHurt', { id: enemyId, hp: result.hp, dmg: result.dmg, isCrit: result.isCrit });
    }
  });

  socket.on('skillAttack', ({ enemyId, multiplier }) => {
    const rId = playerRaid.get(socket.id);
    if (rId) {
      const rr = raidRooms.get(rId);
      if (!rr) return;
      const cp = currentRoom?.players.get(socket.id);
      const targetEnemy = rr._enemyMap.get(enemyId);
      const result = rr.skillAttackEnemy(socket.id, enemyId, cp?.atk || 10, multiplier, cp?.critChance || 0.05, cp?.critPower || 1.5);
      if (!result) return;
      if (targetEnemy) rr.memberIds.forEach(mid => io.to(mid).emit('raidPlayerAtk', { playerId: socket.id, tx: targetEnemy.x, ty: targetEnemy.y }));
      if (result.killed) {
        const rNorm  = result.isBoss && Math.random() < 0.10 ? 1 : 0;
        const rBless = result.isBoss && Math.random() < 0.01 ? 1 : 0;
        rr.memberIds.forEach(mid => io.to(mid).emit('raidEnemyKilled', {
          id: enemyId, ex: result.ex, ey: result.ey, isBoss: result.isBoss,
          normStone:  mid === socket.id ? rNorm  : 0,
          blessStone: mid === socket.id ? rBless : 0,
        }));
      } else {
        rr.memberIds.forEach(mid => io.to(mid).emit('raidEnemyHurt', { id: enemyId, hp: result.hp, dmg: result.dmg }));
      }
      return;
    }
    if (!currentRoom) return;
    if (currentRoom.isPlayerInSafeZone(socket.id)) return;
    const result = currentRoom.skillAttackEnemy(socket.id, enemyId, multiplier);
    if (!result) return;
    if (result.killed) {
      const partyId    = playerParty.get(socket.id);
      const partyMap   = partyId ? parties.get(partyId) : null;
      const memberIds  = [];
      if (partyMap) {
        partyMap.forEach((_, mid) => {
          if (mid !== socket.id && playerFloorMap.get(mid) === currentFloor) memberIds.push(mid);
        });
      }
      const bossStone  = result.isBoss ? (currentFloor + Math.floor(Math.random() * 3)) : 0;
      const normStone  = result.isBoss && Math.random() < 0.10 ? 1 : 0;
      const blessStone = result.isBoss && Math.random() < 0.01 ? 1 : 0;
      if (memberIds.length > 0) {
        const totalMembers = memberIds.length + 1;
        const xpShare = result.xp / totalMembers, goldShare = result.gold / totalMembers;
        const allIds = [socket.id, ...memberIds];
        const lootWinnerId = allIds[Math.floor(Math.random() * allIds.length)];
        socket.emit('enemyKilled', {
          id: enemyId, xp: xpShare, gold: goldShare, dmg: result.dmg, isCrit: result.isCrit,
          ex: result.ex, ey: result.ey, color: result.color,
          gotLoot: lootWinnerId === socket.id, eid: result.eid,
          bossStone: lootWinnerId === socket.id ? bossStone : 0,
          normStone:  lootWinnerId === socket.id ? normStone  : 0,
          blessStone: lootWinnerId === socket.id ? blessStone : 0,
        });
        memberIds.forEach(mid => io.to(mid).emit('enemyKilled', {
          id: enemyId, xp: xpShare, gold: goldShare,
          ex: result.ex, ey: result.ey, color: result.color,
          gotLoot: lootWinnerId === mid, eid: result.eid,
          bossStone:  lootWinnerId === mid ? bossStone  : 0,
          normStone:  lootWinnerId === mid ? normStone  : 0,
          blessStone: lootWinnerId === mid ? blessStone : 0,
        }));
        socket.to(`floor_${currentFloor}`).except(memberIds).emit('enemyKilled', { id: enemyId, ex: result.ex, ey: result.ey, color: result.color });
      } else {
        socket.emit('enemyKilled', {
          id: enemyId, xp: result.xp, gold: result.gold, dmg: result.dmg, isCrit: result.isCrit,
          ex: result.ex, ey: result.ey, color: result.color,
          gotLoot: true, eid: result.eid, bossStone, normStone, blessStone,
        });
        socket.to(`floor_${currentFloor}`).emit('enemyKilled', { id: enemyId, ex: result.ex, ey: result.ey, color: result.color });
      }
    } else {
      io.to(`floor_${currentFloor}`).emit('enemyHurt', { id: enemyId, hp: result.hp, dmg: result.dmg, isCrit: result.isCrit });
    }
  });

  socket.on('skillEffect', ({ enemyId, enemyIds, type, duration }) => {
    const rId = playerRaid.get(socket.id);
    if (rId) {
      const rr = raidRooms.get(rId);
      if (!rr) return;
      if (enemyId) rr.applySkillEffect(enemyId, type, duration);
      if (enemyIds) rr.applySkillEffectMany(enemyIds, type, duration);
      socket.to(rId).emit('enemyCC', { enemyId, enemyIds, type, duration });
      return;
    }
    if (!currentRoom) return;
    if (enemyId) currentRoom.applySkillEffect(enemyId, type, duration);
    if (enemyIds) currentRoom.applySkillEffectMany(enemyIds, type, duration);
    socket.to(`floor_${currentFloor}`).emit('enemyCC', { enemyId, enemyIds, type, duration });
  });

  socket.on('playerInvis', ({ invis }) => {
    if (!currentRoom) return;
    const p = currentRoom.players.get(socket.id);
    if (p) p._invis = !!invis;
  });

  socket.on('faithShield', ({ duration }) => {
    const partyId = playerParty.get(socket.id);
    const partyMap = partyId ? parties.get(partyId) : null;
    if (!partyMap) return;
    partyMap.forEach((_, mid) => {
      if (mid !== socket.id) io.to(mid).emit('faithShieldBuff', { duration });
    });
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
    if (globalChatHistory.length) socket.emit('chatHistory', globalChatHistory);

    // Carry over character stats directly — avoids recalculation from partial data
    if (p?.type) {
      const np = currentRoom.players.get(socket.id);
      if (np) {
        np.type   = p.type;
        np.atk    = p.atk;
        np.def    = p.def;
        np.maxHp  = p.maxHp;
        np.hp     = p.hp;
        np.pvpMode = p.pvpMode || false;
      }
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
    io.to(targetId).emit('pvpDamage', { dmg: result.dmg });
    socket.emit('pvpHit', { x: result.x, y: result.y, dmg: result.dmg, isCrit: result.isCrit, targetId });
  });

  socket.on('pvpSkillAttack', ({ targetId, multiplier }) => {
    if (!currentRoom) return;
    const result = currentRoom.pvpSkillAttack(socket.id, targetId, multiplier);
    if (!result) return;
    io.to(targetId).emit('pvpDamage', { dmg: result.dmg });
    socket.emit('pvpHit', { x: result.x, y: result.y, dmg: result.dmg, isCrit: result.isCrit, targetId });
  });

  socket.on('pvpSkillCC', ({ targetId, type, duration }) => {
    if (!currentRoom) return;
    const attacker = currentRoom.players.get(socket.id);
    if (!attacker || !attacker.pvpMode) return;
    if (currentRoom.isPlayerInSafeZone(socket.id)) return;
    const target = currentRoom.players.get(targetId);
    if (!target || target.hp <= 0) return;
    if (currentRoom.isPlayerInSafeZone(targetId)) return;
    const dur = Math.max(0, Math.min(duration, 6));
    io.to(`floor_${currentFloor}`).emit('pvpPlayerCC', { targetId, type, duration: dur });
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
    _recordChat(authed.username, msg);
    io.emit('chatMsg', { username: authed.username, text: msg });
  });

  socket.on('saveProgress', ({ stats }) => {
    if (authed) {
      _lastStats = stats;
      const bm = calcBM(stats);
      PlayerModel.findByIdAndUpdate(authed._id, { savedData: stats, bm }).catch(() => {});
    }
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

  // ── Clan handlers ─────────────────────────────────────────────
  async function _clanDataFor(clan, telegramId) {
    const myRole = clan.members.find(m => m.telegramId === telegramId)?.role || null;
    const memberIds = clan.members.map(m => m.telegramId);
    const playerDocs = await PlayerModel.find({ telegramId: { $in: memberIds } }, { telegramId: 1, bm: 1 }).lean().catch(() => []);
    const bmMap = {};
    playerDocs.forEach(d => { bmMap[d.telegramId] = d.bm || 0; });
    return {
      _id:          clan._id,
      name:         clan.name,
      icon:         clan.icon,
      level:        clan.level,
      xp:           clan.xp,
      members:      clan.members.map(m => ({ telegramId: m.telegramId, username: m.username, role: m.role, bm: bmMap[m.telegramId] || 0 })),
      applications: myRole === 'leader' ? clan.applications.map(a => ({ telegramId: a.telegramId, username: a.username })) : [],
      myRole,
    };
  }

  async function _notifyClan(clan) {
    for (const m of clan.members) {
      // Find active socket for this member by iterating connected sockets
      const target = [...io.sockets.sockets.values()].find(s => s.data.telegramId === m.telegramId);
      if (target) target.emit('clanData', await _clanDataFor(clan, m.telegramId));
    }
  }

  socket.on('clanCreate', async ({ name, icon }) => {
    if (!authed) return;
    const n = (name || '').trim().slice(0, 10);
    if (!n) return socket.emit('clanError', { msg: 'Введите название' });
    if (typeof icon !== 'number' || icon < 1 || icon > 30) return socket.emit('clanError', { msg: 'Неверная иконка' });
    const existing = await ClanModel.findOne({ 'members.telegramId': authed.telegramId }).catch(() => null);
    if (existing) return socket.emit('clanError', { msg: 'Вы уже в клане' });
    try {
      const clan = await ClanModel.create({
        name: n, icon,
        members: [{ telegramId: authed.telegramId, username: authed.username, role: 'leader' }],
      });
      const _cd = await _clanDataFor(clan, authed.telegramId);
      socket.emit('clanData', _cd);
      _myClanName = _cd ? _cd.name : null;
      _myClanIcon = _cd ? _cd.icon : null;
      currentRoom?.setPlayerClan(socket.id, _myClanName, _myClanIcon);
    } catch (e) {
      if (e.code === 11000) socket.emit('clanError', { msg: 'Название занято' });
      else socket.emit('clanError', { msg: 'Ошибка создания' });
    }
  });

  socket.on('clanSearch', async ({ query }) => {
    if (!authed) return;
    const q = (query || '').trim();
    const filter = q ? { name: { $regex: q, $options: 'i' } } : {};
    const clans = await ClanModel.find(filter).sort({ level: -1, xp: -1 }).limit(20).catch(() => []);
    socket.emit('clanSearchResults', clans.map(c => ({
      _id: c._id, name: c.name, icon: c.icon, level: c.level, members: c.members.length,
    })));
  });

  socket.on('clanApply', async ({ clanId }) => {
    if (!authed) return;
    const inClan = await ClanModel.findOne({ 'members.telegramId': authed.telegramId }).catch(() => null);
    if (inClan) return socket.emit('clanError', { msg: 'Вы уже в клане' });
    const clan = await ClanModel.findById(clanId).catch(() => null);
    if (!clan) return socket.emit('clanError', { msg: 'Клан не найден' });
    if (clan.applications.find(a => a.telegramId === authed.telegramId)) return;
    clan.applications.push({ telegramId: authed.telegramId, username: authed.username });
    await clan.save().catch(() => {});
    socket.emit('clanError', { msg: '✓ Заявка отправлена' });
    await _notifyClan(clan);
  });

  socket.on('clanApprove', async ({ telegramId }) => {
    if (!authed) return;
    const clan = await ClanModel.findOne({ 'members.telegramId': authed.telegramId }).catch(() => null);
    if (!clan) return;
    if (clan.members.find(m => m.telegramId === authed.telegramId)?.role !== 'leader') return;
    const app = clan.applications.find(a => a.telegramId === telegramId);
    if (!app) return;
    clan.applications = clan.applications.filter(a => a.telegramId !== telegramId);
    clan.members.push({ telegramId: app.telegramId, username: app.username, role: 'member' });
    await clan.save().catch(() => {});
    await _notifyClan(clan);
  });

  socket.on('clanDecline', async ({ telegramId }) => {
    if (!authed) return;
    const clan = await ClanModel.findOne({ 'members.telegramId': authed.telegramId }).catch(() => null);
    if (!clan) return;
    if (clan.members.find(m => m.telegramId === authed.telegramId)?.role !== 'leader') return;
    clan.applications = clan.applications.filter(a => a.telegramId !== telegramId);
    await clan.save().catch(() => {});
    const _cdDecl = await _clanDataFor(clan, authed.telegramId);
    socket.emit('clanData', _cdDecl);
    _myClanName = _cdDecl ? _cdDecl.name : null;
    _myClanIcon = _cdDecl ? _cdDecl.icon : null;
    currentRoom?.setPlayerClan(socket.id, _myClanName, _myClanIcon);
  });

  socket.on('clanKick', async ({ telegramId }) => {
    if (!authed) return;
    const clan = await ClanModel.findOne({ 'members.telegramId': authed.telegramId }).catch(() => null);
    if (!clan) return;
    if (clan.members.find(m => m.telegramId === authed.telegramId)?.role !== 'leader') return;
    if (telegramId === authed.telegramId) return;
    clan.members = clan.members.filter(m => m.telegramId !== telegramId);
    await clan.save().catch(() => {});
    await _notifyClan(clan);
    // Notify kicked player
    const kicked = [...io.sockets.sockets.values()].find(s => s.data.telegramId === telegramId);
    if (kicked) {
      kicked.emit('clanData', null);
      const _kFloor = playerFloorMap.get(kicked.id);
      const _kRoom = _kFloor !== undefined ? floorRooms.get(_kFloor) : null;
      if (_kRoom) _kRoom.setPlayerClan(kicked.id, null, null);
    }
  });

  socket.on('clanLeave', async () => {
    if (!authed) return;
    const clan = await ClanModel.findOne({ 'members.telegramId': authed.telegramId }).catch(() => null);
    if (!clan) return;
    const myEntry = clan.members.find(m => m.telegramId === authed.telegramId);
    if (!myEntry) return;
    if (myEntry.role === 'leader') {
      // Promote next member or disband
      const others = clan.members.filter(m => m.telegramId !== authed.telegramId);
      if (others.length > 0) {
        others[0].role = 'leader';
        clan.members = others;
        await clan.save().catch(() => {});
        await _notifyClan(clan);
      } else {
        await ClanModel.deleteOne({ _id: clan._id }).catch(() => {});
      }
    } else {
      clan.members = clan.members.filter(m => m.telegramId !== authed.telegramId);
      await clan.save().catch(() => {});
      await _notifyClan(clan);
    }
    socket.emit('clanData', null);
    _myClanName = null;
    _myClanIcon = null;
    currentRoom?.setPlayerClan(socket.id, null, null);
  });

  socket.on('clanDisband', async () => {
    if (!authed) return;
    const clan = await ClanModel.findOne({ 'members.telegramId': authed.telegramId }).catch(() => null);
    if (!clan) return;
    if (clan.members.find(m => m.telegramId === authed.telegramId)?.role !== 'leader') return;
    // Notify all members first and clear their room clan state
    for (const m of clan.members) {
      const target = [...io.sockets.sockets.values()].find(s => s.data.telegramId === m.telegramId);
      if (target) {
        target.emit('clanData', null);
        const _tFloor = playerFloorMap.get(target.id);
        const _tRoom = _tFloor !== undefined ? floorRooms.get(_tFloor) : null;
        if (_tRoom) _tRoom.setPlayerClan(target.id, null, null);
      }
    }
    await ClanModel.deleteOne({ _id: clan._id }).catch(() => {});
  });

  // 1 kill = 1 clan XP point
  socket.on('clanKill', async () => {
    if (!authed) return;
    const clan = await ClanModel.findOne({ 'members.telegramId': authed.telegramId }).catch(() => null);
    if (!clan || clan.level >= 10) return;
    clan.xp += 1;
    // Check level up
    const LEVELS = [0,500,1500,4000,10000,25000,60000,150000,350000,800000];
    const nextLvl = clan.level < 10 ? LEVELS[clan.level] : Infinity;
    if (clan.xp >= nextLvl) clan.level = Math.min(10, clan.level + 1);
    await clan.save().catch(() => {});
    // Only notify the killer (avoid DB load per kill for all members)
    const _cdKill = await _clanDataFor(clan, authed.telegramId);
    socket.emit('clanData', _cdKill);
    _myClanName = _cdKill ? _cdKill.name : null;
    _myClanIcon = _cdKill ? _cdKill.icon : null;
    currentRoom?.setPlayerClan(socket.id, _myClanName, _myClanIcon);
  });

  // ── Raid ───────────────────────────────────────────────────────────────────
  // ── Raid lobbies ──────────────────────────────────────────────────────────
  socket.on('getLobbyList', () => {
    const list = [...raidLobbies.values()].map(lb => ({
      id: lb.id, creatorName: lb.creatorName, dungeonId: lb.dungeonId,
      members: [...lb.members.entries()].map(([sid, m]) => ({ id: sid, name: m.name, bm: m.bm, lvl: m.lvl })),
    }));
    socket.emit('lobbyList', { lobbies: list });
  });

  socket.on('createRaidLobby', ({ dungeonId }) => {
    if (!authed) return;
    if (playerLobby.has(socket.id)) _cleanupLobby(socket.id);
    if (playerRaid.has(socket.id)) return socket.emit('lobbyError', { msg: 'Вы уже в рейде' });
    const cp = currentRoom?.players.get(socket.id);
    if (!cp || (cp.lvl || 1) < 3) return socket.emit('lobbyError', { msg: 'Нужен 3 уровень' });
    const bm = _lastStats ? ((_lastStats.lvl || 1) * 50 + (_lastStats.atk || 0) * 5 + (_lastStats.def || 0) * 3) : 0;
    const lobbyId = 'lb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5);
    const lb = { id: lobbyId, creatorId: socket.id, creatorName: authed.username,
      dungeonId: dungeonId || 1,
      members: new Map([[socket.id, { name: authed.username, bm, lvl: cp.lvl || 1 }]]) };
    raidLobbies.set(lobbyId, lb);
    playerLobby.set(socket.id, lobbyId);
    socket.emit('lobbyJoined', { lobbyId, isCreator: true,
      members: [...lb.members.entries()].map(([sid, m]) => ({ id: sid, name: m.name, bm: m.bm, lvl: m.lvl })) });
    _lobbyBroadcast();
  });

  socket.on('joinRaidLobby', ({ lobbyId }) => {
    if (!authed) return;
    const lb = raidLobbies.get(lobbyId);
    if (!lb) return socket.emit('lobbyError', { msg: 'Группа не найдена' });
    if (lb.members.size >= 5) return socket.emit('lobbyError', { msg: 'Группа полна (5/5)' });
    if (playerRaid.has(socket.id)) return socket.emit('lobbyError', { msg: 'Вы уже в рейде' });
    if (playerLobby.has(socket.id)) _cleanupLobby(socket.id);
    const cp = currentRoom?.players.get(socket.id);
    const bm = _lastStats ? ((_lastStats.lvl || 1) * 50 + (_lastStats.atk || 0) * 5 + (_lastStats.def || 0) * 3) : 0;
    lb.members.set(socket.id, { name: authed.username, bm, lvl: cp?.lvl || 1 });
    playerLobby.set(socket.id, lobbyId);
    const memberList = [...lb.members.entries()].map(([sid, m]) => ({ id: sid, name: m.name, bm: m.bm, lvl: m.lvl }));
    lb.members.forEach((_, mid) => io.to(mid).emit('lobbyJoined', { lobbyId, isCreator: mid === lb.creatorId, members: memberList }));
    _lobbyBroadcast();
  });

  socket.on('leaveRaidLobby', () => {
    if (!playerLobby.has(socket.id)) return;
    _cleanupLobby(socket.id);
    socket.emit('lobbyLeft', {});
    _lobbyBroadcast();
  });

  socket.on('startRaidLobby', () => {
    if (!authed) return;
    const lobbyId = playerLobby.get(socket.id);
    const lb = raidLobbies.get(lobbyId);
    if (!lb || lb.creatorId !== socket.id) return socket.emit('lobbyError', { msg: 'Вы не создатель группы' });
    if (lb.members.size < 2) return socket.emit('lobbyError', { msg: 'Нужно минимум 2 игрока' });
    const memberIds = [...lb.members.keys()];
    for (const mid of memberIds) {
      if (playerRaid.has(mid)) return socket.emit('lobbyError', { msg: 'Кто-то уже в рейде' });
    }
    raidLobbies.delete(lobbyId);
    memberIds.forEach(mid => playerLobby.delete(mid));
    const raidId = 'raid_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const raidRoom = new RaidRoom(raidId, io, memberIds, (mids) => {
      mids.forEach(mid => _cleanupRaidPlayer(mid));
      raidRooms.delete(raidId);
    });
    raidRooms.set(raidId, raidRoom);
    for (const mid of memberIds) {
      playerRaid.set(mid, raidId);
      const mfl = playerFloorMap.get(mid);
      const mRoom = mfl !== undefined ? floorRooms.get(mfl) : null;
      const mp = mRoom?.players.get(mid);
      if (mp) {
        mp._inRaid = true;
        raidRoom.addPlayer(mid, { maxHp: mp.maxHp, atk: mp.atk, def: mp.def, type: mp.type, username: mp.username || lb.members.get(mid)?.name || '' });
      } else {
        raidRoom.addPlayer(mid, { maxHp: 100, atk: 10, def: 0, type: 'warrior', username: lb.members.get(mid)?.name || '' });
      }
      io.to(mid).emit('raidStart', { raidId, dungeon: raidRoom.dungeonData });
    }
    raidRoom.start();
    _lobbyBroadcast();
  });

  // ── Raid game ─────────────────────────────────────────────────────────────
  socket.on('raidMove', ({ x, y, hp }) => {
    const rId = playerRaid.get(socket.id);
    const rr  = rId ? raidRooms.get(rId) : null;
    if (rr) rr.updatePlayerPos(socket.id, x, y, hp);
  });

  socket.on('raidAttack', ({ enemyId }) => {
    const rId = playerRaid.get(socket.id);
    const rr  = rId ? raidRooms.get(rId) : null;
    if (!rr) return;
    const cp = currentRoom?.players.get(socket.id);
    const targetEnemy = rr._enemyMap.get(enemyId);
    const result = rr.attackEnemy(socket.id, enemyId, cp?.atk || 10, cp?.critChance || 0.05, cp?.critPower || 1.5);
    if (!result) return;
    // Broadcast attacker animation to all members
    if (targetEnemy) rr.memberIds.forEach(mid => io.to(mid).emit('raidPlayerAtk', { playerId: socket.id, tx: targetEnemy.x, ty: targetEnemy.y }));
    if (result.killed) {
      const rNorm  = result.isBoss && Math.random() < 0.10 ? 1 : 0;
      const rBless = result.isBoss && Math.random() < 0.01 ? 1 : 0;
      rr.memberIds.forEach(mid => io.to(mid).emit('raidEnemyKilled', {
        id: enemyId, ex: result.ex, ey: result.ey, isBoss: result.isBoss,
        normStone:  mid === socket.id ? rNorm  : 0,
        blessStone: mid === socket.id ? rBless : 0,
      }));
    } else {
      rr.memberIds.forEach(mid => io.to(mid).emit('raidEnemyHurt', {
        id: enemyId, hp: result.hp, dmg: result.dmg,
      }));
    }
  });

  socket.on('leaveRaid', () => { _cleanupRaid(socket.id); });

  socket.on('disconnect', () => {
    console.log('disconnect:', socket.id);
    if (_autoSaveInterval) { clearInterval(_autoSaveInterval); _autoSaveInterval = null; }
    _cleanupRaid(socket.id);
    _cleanupLobby(socket.id);
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
