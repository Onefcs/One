// ── Network module ───────────────────────────────────────────
const SERVER_URL = (() => {
  const h = window.location.hostname;
  return (h === 'localhost' || h === '127.0.0.1' || h === '')
    ? 'http://localhost:3000'
    : 'https://one-production-ae10.up.railway.app';
})();

let _savedData = null;

// Snapshot interpolation state
let _svrTimeOffset = null; // null = not yet calibrated
const _INTERP_MS  = 65;   // render others 65ms in the past (~1.3 player-cast intervals at 20Hz)
const _SNAP_MAX   = 10;   // ~250ms of buffer

// RTT ping measurement — updated every 2s, read by perf overlay
let _pingMs = -1;
let _pingTimer = null;

// ── Socket setup ──────────────────────────────────────────────
function netConnect(onReady) {
  if (socket && socket.connected) { if (onReady) onReady(); return; }
  if (socket) { socket.disconnect(); socket = null; }
  socket = io(SERVER_URL, {
    transports: ['websocket'],  // skip polling — polling adds 200-400ms per packet
    upgrade: false,
  });

  socket.on('connect', () => {
    if (onReady) onReady();
    // Start RTT ping loop
    if (_pingTimer) clearInterval(_pingTimer);
    _pingTimer = setInterval(() => {
      if (socket?.connected) socket.volatile.emit('_ping', Date.now());
    }, 2000);
  });

  socket.on('_pong', t0 => { _pingMs = Date.now() - t0; });

  socket.on('connect_error', () => {
    showAuthError('Нет соединения с сервером');
  });

  socket.on('authOk', ({ username, savedData, clanInfo }) => {
    netUsername = username;
    _savedData = savedData || null;
    if (clanInfo && typeof onClanData === 'function') onClanData(clanInfo);
    document.getElementById('login-screen').style.display = 'none';
    _showCharSelect(_savedData);
  });

  socket.on('authError', ({ message }) => { showAuthError(message); });

  socket.on('playerJoined', ({ id, username }) => {
    if (!otherPlayers.has(id)) otherPlayers.set(id, { animFrame: 0, animTimer: 0, moving: false });
    otherPlayers.get(id).username = username;
  });

  socket.on('playerLeft', ({ id }) => {
    otherPlayers.delete(id);
  });

  socket.on('playerChar', ({ id, type }) => {
    if (!otherPlayers.has(id)) otherPlayers.set(id, { animFrame: 0, animTimer: 0, moving: false });
    otherPlayers.get(id).type = type;
    loadSprites(type, () => {});
  });

  socket.on('gameStart', ({ floor, dungeon: d, enemies: initialEnemies }) => {
    dungeonLvl = floor;
    dungeon = { ...d, enemies: [], safeZone: d.safeZone || null };
    serverEnemies = (initialEnemies || []).map(e => ({ ...e, targetX: e.x, targetY: e.y }));
    serverEnemiesMap = new Map(serverEnemies.map(e => [e.id, e]));
    otherPlayers = new Map();
    resetNetCodecMaps(); // binary handle→id maps are scoped to the room
    buildTileCanvas();
    projs = []; otherProjs = []; drops = []; particles = []; dmgNums = [];
    if (player) {
      player.x = d.spawn.x; player.y = d.spawn.y;
      camera.x = player.x - W / (2 * ZOOM); camera.y = player.y - (H - HEADER_H) / (2 * ZOOM);
      clampCamera();
    }
    const restore = _savedData && _savedData.type === player?.type ? _savedData : null;
    if (restore) { restoreFromSave(restore); _savedData = null; }
    csOnServerReady();
  });

  socket.on('gameState', (data) => {
    if (inRaid) return; // raid uses raidState updates, not floor gameState
    const _gs0 = performance.now();
    // Binary packet (ArrayBuffer / typed view) — decode via shared codec;
    // plain-object fallback kept for a server running older code
    const _st = (data instanceof ArrayBuffer || ArrayBuffer.isView(data))
      ? decodeGameState(data) : data;
    const players = _st.players, enemies = _st.enemies, t = _st.t;
    const myId = socket.id;

    // Calibrate server↔client clock once, then keep EMA
    if (_svrTimeOffset === null) _svrTimeOffset = t - Date.now();
    else _svrTimeOffset = _svrTimeOffset * 0.95 + (t - Date.now()) * 0.05;

    // Players arrive only every other tick (20Hz) — packets without a
    // players field must not touch (or prune) the player map.
    // Entries come in two shapes: full (first sight / profile change) with
    // username/type/maxHp/pvpMode, or slim {id,x,y,facing,hp,atkSeq}.
    if (players) {
      players.forEach(p => {
        if (p.id === myId) return;
        if (!otherPlayers.has(p.id)) {
          otherPlayers.set(p.id, { ...p, targetX: p.x, targetY: p.y,
            _buf: [{ x: p.x, y: p.y, t }],
            animFrame: 0, animTimer: 0, moving: false });
          if (p.type) loadSprites(p.type, () => {});
        } else {
          const op = otherPlayers.get(p.id);
          if (p.type && op.type !== p.type) { op.type = p.type; loadSprites(p.type, () => {}); }
          if (p.username !== undefined) op.username = p.username;
          if (p.maxHp    !== undefined) op.maxHp    = p.maxHp;
          if (p.pvpMode  !== undefined) op.pvpMode  = p.pvpMode || false;
          op.hp = p.hp; op.facing = p.facing;
          if (op.x === undefined) { op.x = p.x; op.y = p.y; }

          // Snapshot ring buffer
          if (!op._buf) op._buf = [];
          op._buf.push({ x: p.x, y: p.y, t });
          if (op._buf.length > _SNAP_MAX) op._buf.shift();
          op.targetX = p.x; op.targetY = p.y;

          if (p.atkSeq !== undefined && p.atkSeq !== (op.atkSeq || 0)) {
            op.atkSeq = p.atkSeq;
            op.atkAnimTimer = 0.55; op.animFrame = 0; op.animTimer = 0;
          }
        }
      });

      // Remove players that left AOI or disconnected
      const pids = new Set();
      for (let i = 0; i < players.length; i++) pids.add(players[i].id);
      otherPlayers.forEach((_, id) => { if (!pids.has(id)) otherPlayers.delete(id); });
    }

    // Delta update: only changed enemies arrive — add or update, never remove
    // (removal happens via enemyKilled; respawn via re-add when hp > 0)
    enemies.forEach(se => {
      const ex = serverEnemiesMap.get(se.id);
      if (ex) {
        ex.hp = se.hp;
        if (se.maxHp !== undefined) ex.maxHp = se.maxHp;
        // Compute facing + move signal from server position delta (not client lerp)
        const sdx = se.x - (ex.targetX ?? ex.x);
        const sdy = se.y - (ex.targetY ?? ex.y);
        const sdist = Math.abs(sdx) + Math.abs(sdy);
        if (sdist > 0.3) {
          ex._moveTimer = 0.35;
          // Facing with axis hysteresis: on diagonal paths |dx|≈|dy|, so a
          // plain >= comparison flip-flops left/down every tick — keep the
          // current axis unless the other is clearly (1.4x) dominant
          const ax = Math.abs(sdx), ay = Math.abs(sdy);
          let useX;
          if (ax > ay * 1.4)      useX = true;
          else if (ay > ax * 1.4) useX = false;
          else useX = ex._facing === 'left' || ex._facing === 'right';
          if (useX) ex._facing = sdx > 0 ? 'right' : 'left';
          else      ex._facing = sdy > 0 ? 'down'  : 'up';
        }
        ex.targetX = se.x; ex.targetY = se.y;
        ex.aggro = se.aggro;
        if (se.aggroR) ex.aggroR = se.aggroR;
        if (se.spd)    ex.spd    = se.spd;
        // (hurtTimer arrives via the enemyHurt event, not gameState)
        if (se.atkAnimTimer > 0) {
          ex.atkAnimTimer = se.atkAnimTimer;
          ex._atkDone = false;
          // Face the victim — the server always strikes the closest player,
          // so reconstruct that choice client-side (self + visible others)
          let tx, ty, best = Infinity;
          if (player && player.hp > 0) {
            best = (player.x - se.x) ** 2 + (player.y - se.y) ** 2;
            tx = player.x; ty = player.y;
          }
          otherPlayers.forEach(op => {
            if (op.x == null || (op.hp || 0) <= 0) return;
            const d2 = (op.x - se.x) ** 2 + (op.y - se.y) ** 2;
            if (d2 < best) { best = d2; tx = op.x; ty = op.y; }
          });
          if (tx !== undefined) {
            const fdx = tx - se.x, fdy = ty - se.y;
            if (Math.abs(fdx) >= Math.abs(fdy)) ex._facing = fdx > 0 ? 'right' : 'left';
            else                                ex._facing = fdy > 0 ? 'down'  : 'up';
          }
        }
      } else {
        // Slim entry for an enemy we don't know — skip; the server's periodic
        // full refresh (every ~2s) will deliver the complete record shortly
        if (se.eid === undefined) return;
        const newE = { ...se, targetX: se.x, targetY: se.y, _st: t };
        serverEnemies.push(newE);
        serverEnemiesMap.set(se.id, newE);
      }
    });
    _profSocketEvts++;
    _profSocketMs += performance.now() - _gs0;
  });

  socket.on('playerHurt', ({ id, hp, dmg }) => {
    if (player && id === socket.id) {
      if (typeof inSafeZone === 'function' && inSafeZone(player.x, player.y)) return;
      if (barrierTimer > 0) {
        dmgNum(player.x, player.y - 24, 'БЛОК', '#88f');
        spawnBurst(player.x, player.y, '#88f', 5);
        return;
      }
      player.hp = (dmg != null) ? Math.max(0, player.hp - dmg) : hp;
      player.hurtTimer = 0.1;
      if (player.hp <= 0) { player.hp = 0; playerDie(); }
    } else {
      const op = otherPlayers.get(id);
      if (op) {
        op.hp = hp;
        op.hurtTimer = 0.1;
        if (hp <= 0 && id === targetId && targetIsPlayer) { targetId = null; targetIsPlayer = false; }
      }
    }
  });

  socket.on('faithShieldBuff', ({ duration }) => {
    if (!player) return;
    faithShieldTimer = duration;
    player.def = Math.floor(player.def * 1.5);
    if (typeof netStatsUpdate === 'function') netStatsUpdate(player.atk, player.def, player.maxHp);
    dmgNum(player.x, player.y - 40, '🛡 Щит веры!', '#ff4');
    spawnBurst(player.x, player.y, '#ff4', 8);
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
    const _hitOp = hitTargetId ? otherPlayers.get(hitTargetId) : null;
    if (_hitOp) _hitOp.hurtTimer = 0.1;
  });

  socket.on('enemyHurt', ({ id, hp, dmg }) => {
    const e = serverEnemiesMap.get(id);
    if (e) {
      e.hp = hp;
      e.hurtTimer = 0.3;
      if (dmg) dmgNum(e.x, e.y - e.size - 4, dmg, '#ff4');
    }
  });

  function _addStoneToInv(stoneId, qty, px, py) {
    const def = CRAFT_MATS.find(m => m.id === stoneId);
    if (!def || !player) return;
    const ex2 = player.inventory.find(i => i.id === stoneId);
    if (ex2) { ex2.qty = (ex2.qty || 1) + qty; }
    else { player.inventory.push({ ...def, qty }); }
    const label = stoneId === 'bless_stone' ? 'Безоп. камень' : 'Камень заточки';
    dmgNum(px, py - 52, `+${qty}× ${label}`, stoneId === 'bless_stone' ? '#88f' : '#fa8');
    netSaveProgress();
  }

  socket.on('enemyKilled', ({ id, xp, gold, dmg, ex, ey, color, gotLoot, eid, bossStone, normStone, blessStone }) => {
    if (id === targetId && !targetIsPlayer) { targetId = null; targetIsPlayer = false; }
    const e = serverEnemiesMap.get(id);
    const px = ex ?? (e ? e.x : player?.x ?? 0);
    const py = ey ?? (e ? e.y : player?.y ?? 0);
    if (dmg) dmgNum(px, py - 20, dmg, '#ff4');
    spawnBurst(px, py, color || '#f80', 8);
    const dd = e && typeof ENEMY_SPRITE_DEF !== 'undefined' && ENEMY_SPRITE_DEF[e.eid]?.sheets?.death;
    if (dd) {
      // Keep the corpse just long enough to play the death animation;
      // game.js removes it when _deathTimer expires. All targeting/collision
      // loops skip hp <= 0, so the corpse is inert.
      e.hp = 0;
      e.atkAnimTimer = 0; e.hurtTimer = 0; e._moveTimer = 0;
      e._deathTimer = dd.cols / dd.fps + 0.1;
    } else {
      serverEnemiesMap.delete(id);
      let j = 0;
      for (let i = 0; i < serverEnemies.length; i++) {
        if (serverEnemies[i].id !== id) serverEnemies[j++] = serverEnemies[i];
      }
      serverEnemies.length = j;
    }
    if (xp && player) {
      player.kills++;
      const _cb = typeof getClanBonus === 'function' ? getClanBonus() : null;
      const _xpFinal = _cb && _cb.xp > 0 ? Math.round(xp * (1 + _cb.xp / 100)) : xp;
      gainXP(_xpFinal);
    }
    if (eid && player && typeof onEnemyKill === 'function') {
      const _eDef = ENEMY_DEF.find(e => e.eid === eid);
      if (_eDef) onEnemyKill(_eDef.name);
    }
    if (gotLoot && player) applyLootToInventory(eid);
    if (bossStone && player) {
      const stone = CRAFT_MATS.find(m => m.id === 'boss_stone');
      if (stone) {
        const existing = player.inventory.find(i => i.id === 'boss_stone');
        if (existing) {
          existing.qty = (existing.qty || 1) + bossStone;
        } else {
          player.inventory.push({ ...stone, qty: bossStone });
        }
        dmgNum(px, py - 52, '+' + bossStone + '× Камень Босса', '#aaf');
        netSaveProgress();
      }
    }
    if (normStone)  _addStoneToInv('norm_stone',  normStone,  px, py);
    if (blessStone) _addStoneToInv('bless_stone', blessStone, px, py - 16);
    if (gold && player) {
      const _cb = typeof getClanBonus === 'function' ? getClanBonus() : null;
      const _goldFinal = _cb && _cb.gold > 0 ? Math.round(gold * (1 + _cb.gold / 100)) : gold;
      player.gold += _goldFinal;
      const g = _goldFinal % 1 === 0 ? _goldFinal : +_goldFinal.toFixed(1);
      dmgNum(px, py - 36, '+' + g + 'g', '#ff0');
    }
    // Notify server for clan XP (1 kill = 1 clan point)
    if (xp && player && clanData) socket.emit('clanKill');
  });

  socket.on('floorChanged', ({ floor, dungeon: d, enemies: initialEnemies }) => {
    dungeonLvl = floor;
    dungeon = { ...d, enemies: [] };
    serverEnemies = (initialEnemies || []).map(e => ({ ...e, targetX: e.x, targetY: e.y }));
    serverEnemiesMap = new Map(serverEnemies.map(e => [e.id, e]));
    otherPlayers = new Map();
    resetNetCodecMaps(); // binary handle→id maps are scoped to the room
    buildTileCanvas();
    projs = []; otherProjs = []; drops = []; particles = []; dmgNums = [];
    if (player) {
      player.x = d.spawn.x; player.y = d.spawn.y;
      camera.x = player.x - W / (2 * ZOOM); camera.y = player.y - (H - HEADER_H) / (2 * ZOOM);
      clampCamera();
    }
    initNpcs();
    transTimer = 0.5;
    // Preload sprites for enemies on this floor to avoid mid-game hitches
    const fe = FLOOR_ENEMIES && FLOOR_ENEMIES[floor];
    if (fe) {
      (fe.pool || []).concat([fe.boss]).filter(Boolean).forEach(eid => loadEnemySprites(eid));
    }
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
    // partyUpdated (or disconnect) will clear the member list; don't wipe here
  });

  socket.on('healPartyMember', ({ amount }) => {
    if (!player || state !== 'playing') return;
    player.hp = Math.min(player.maxHp, player.hp + amount);
    dmgNum(player.x, player.y - 38, '+' + amount + '♥ Молитва союзника!', '#ff4');
    spawnBurst(player.x, player.y, '#ff4', 6);
  });

  socket.on('chatMsg', ({ username, text }) => {
    _addChatMsg(username, text);
  });

  socket.on('chatHistory', (msgs) => {
    if (!Array.isArray(msgs)) return;
    const el = document.getElementById('chat-msgs');
    if (!el) return;
    el.innerHTML = '';
    _chatMsgs.length = 0;
    msgs.forEach(({ username, text, time }) => {
      _chatMsgs.push({ username, text, time });
      const myName = (typeof netUsername !== 'undefined' && netUsername) || '';
      const isMe = myName && username === myName;
      const row = document.createElement('div');
      row.className = 'chat-row';
      row.innerHTML = `<div class="chat-row-hdr"><span class="chat-name${isMe ? ' is-me' : ''}">${_escHtml(username)}</span><span class="chat-time">${time}</span></div><div class="chat-text">${_escHtml(text)}</div>`;
      el.appendChild(row);
    });
    el.scrollTop = el.scrollHeight;
  });

  // ── Clan listeners ────────────────────────────────────────
  socket.on('clanData', data => {
    if (typeof onClanData === 'function') onClanData(data);
  });
  socket.on('clanError', ({ msg }) => {
    if (typeof onClanError === 'function') onClanError(msg);
  });
  socket.on('clanSearchResults', results => {
    if (typeof onClanSearchResults === 'function') onClanSearchResults(results);
  });

  // ── Raid listeners ────────────────────────────────────────
  socket.on('raidError', ({ msg }) => {
    if (player && typeof dmgNum === 'function')
      dmgNum(player.x, player.y - 38, msg, '#f93');
  });

  socket.on('raidStart', (data) => {
    if (typeof enterRaidMode === 'function') enterRaidMode(data);
  });

  socket.on('raidState', ({ enemies, players, wave }) => {
    if (!inRaid) return;
    // Merge enemy list — preserve ALL client-side animation state
    const prevMap = new Map(serverEnemies.map(e => [e.id, e]));
    serverEnemies.length = 0;
    serverEnemiesMap.clear();
    (enemies || []).forEach(se => {
      const prev = prevMap.get(se.id);
      const e = { ...se, targetX: se.x, targetY: se.y };
      if (prev) {
        e.hurtTimer   = prev.hurtTimer   || 0;
        e.atkAnimTimer = prev.atkAnimTimer || 0;
        e._animFrame  = prev._animFrame  || 0;
        e._animTimer  = prev._animTimer  || 0;
        e._animKey    = prev._animKey;
        e._atkDone    = prev._atkDone    || false;
        e._moveTimer  = prev._moveTimer  || 0;
        e._facing     = prev._facing     || 'down';
      }
      serverEnemies.push(e);
      serverEnemiesMap.set(se.id, e);
    });
    // Update other raid players — use targetX/Y only so lerp detects movement
    const myId = socket.id;
    (players || []).forEach(p => {
      if (p.id === myId) return;
      if (!otherPlayers.has(p.id)) {
        otherPlayers.set(p.id, { ...p, targetX: p.x, targetY: p.y, animFrame: 0, animTimer: 0, moving: false, facing: 'down' });
        if (p.type) loadSprites(p.type, () => {});
      } else {
        const op = otherPlayers.get(p.id);
        const dx = p.x - op.targetX, dy = p.y - op.targetY;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
          if (Math.abs(dx) >= Math.abs(dy)) op.facing = dx > 0 ? 'right' : 'left';
          else op.facing = dy > 0 ? 'down' : 'up';
        }
        op.hp = p.hp; op.maxHp = p.maxHp;
        if (p.username !== undefined) op.username = p.username;
        if (p.type && op.type !== p.type) { op.type = p.type; loadSprites(p.type, () => {}); }
        op.targetX = p.x; op.targetY = p.y;
      }
    });
  });

  socket.on('raidWave', ({ wave, totalWaves, isBoss, enemies }) => {
    if (!inRaid) return;
    serverEnemies.length = 0;
    serverEnemiesMap.clear();
    (enemies || []).forEach(se => {
      const e = { ...se, targetX: se.x, targetY: se.y };
      serverEnemies.push(e);
      serverEnemiesMap.set(se.id, e);
    });
    const txt = isBoss ? '⚔️ ФИНАЛЬНЫЙ БОСС!' : `Волна ${wave} / ${totalWaves}`;
    _raidWaveNotif = { text: txt, timer: 3.5 };
  });

  socket.on('raidComplete', ({ gold, xp, weaponRarity }) => {
    if (player) {
      player.gold = (player.gold || 0) + gold;
      if (typeof gainXP === 'function') gainXP(xp);
      // Apply weapon drop if player was the lucky winner
      if (weaponRarity && typeof CRAFT_MATS !== 'undefined') {
        const weapons = CRAFT_MATS.filter(m => m.slot === 'weapon' && m.rarity === weaponRarity);
        if (weapons.length) {
          const w = weapons[Math.floor(Math.random() * weapons.length)];
          if (typeof addToInventory === 'function') addToInventory({ ...w });
          if (typeof showRaidComplete === 'function')
            showRaidComplete({ gold, xp, weaponName: w.name, weaponRarity });
          if (typeof netSaveProgress === 'function') netSaveProgress();
          if (typeof exitRaidMode === 'function') exitRaidMode();
          return;
        }
      }
    }
    if (typeof exitRaidMode === 'function') exitRaidMode();
    if (typeof showRaidComplete === 'function') showRaidComplete({ gold, xp, weaponName: null, weaponRarity: null });
    if (typeof netSaveProgress === 'function') netSaveProgress();
  });

  socket.on('raidFailed', () => {
    if (typeof exitRaidMode === 'function') exitRaidMode();
    if (typeof showRaidFailed === 'function') showRaidFailed();
  });

  socket.on('raidPlayerHurt', ({ hp, dmg }) => {
    if (!player || state !== 'playing') return;
    if (barrierTimer > 0) {
      dmgNum(player.x, player.y - 24, 'БЛОК', '#88f');
      spawnBurst(player.x, player.y, '#88f', 5);
      return;
    }
    player.hp = Math.max(0, hp);
    player.hurtTimer = 0.1;
    if (dmg) dmgNum(player.x, player.y - 24, dmg, '#f55');
    spawnBurst(player.x, player.y, '#f44', 4);
    if (player.hp <= 0) { player.hp = 0; if (typeof playerDie === 'function') playerDie(); }
  });

  socket.on('raidEnemyKilled', ({ id, ex, ey, isBoss, normStone, blessStone }) => {
    const e = serverEnemiesMap.get(id);
    const px = ex ?? (e ? e.x : player?.x ?? 0);
    const py = ey ?? (e ? e.y : player?.y ?? 0);
    spawnBurst(px, py, isBoss ? '#ff3333' : '#f80', isBoss ? 14 : 8);
    serverEnemiesMap.delete(id);
    let j = 0;
    for (let i = 0; i < serverEnemies.length; i++) {
      if (serverEnemies[i].id !== id) serverEnemies[j++] = serverEnemies[i];
    }
    serverEnemies.length = j;
    if (normStone)  _addStoneToInv('norm_stone',  normStone,  px, py);
    if (blessStone) _addStoneToInv('bless_stone', blessStone, px, py - 16);
  });

  socket.on('raidEnemyHurt', ({ id, hp, dmg }) => {
    const e = serverEnemiesMap.get(id);
    if (e) {
      e.hp = hp;
      e.hurtTimer = 0.3;
      if (dmg) dmgNum(e.x, e.y - (e.size || 16) - 4, dmg, '#ff4');
    }
  });

  socket.on('raidEnemyAtk', ({ enemyId, targetId: tgtId }) => {
    const e = serverEnemiesMap.get(enemyId);
    if (e) { e.atkAnimTimer = 0.45; e._atkDone = false; }
  });

  socket.on('raidPlayerAtk', ({ playerId, tx, ty }) => {
    if (playerId === socket.id) return;
    const op = otherPlayers.get(playerId);
    if (op) {
      op.atkAnimTimer = 0.45; op.castDuration = 0.45;
      op._swingAngle = Math.atan2(ty - op.y, tx - op.x);
      op._swingTimer = 0.18;
    }
  });

  // ── Raid lobby events ───────────────────────────────────────────────────
  socket.on('lobbyList', ({ lobbies }) => {
    _raidLobbyList = lobbies || [];
    if (typeof updateRaidPanelUI === 'function') updateRaidPanelUI();
  });

  socket.on('lobbyJoined', ({ lobbyId, isCreator, members }) => {
    _myLobbyId = lobbyId;
    _isLobbyCreator = isCreator;
    _myLobbyMembers = members || [];
    if (typeof updateRaidPanelUI === 'function') updateRaidPanelUI();
  });

  socket.on('lobbyLeft', ({ reason } = {}) => {
    _myLobbyId = null; _isLobbyCreator = false; _myLobbyMembers = [];
    if (typeof updateRaidPanelUI === 'function') updateRaidPanelUI();
    if (reason === 'disbanded') dmgNum(player?.x || 0, (player?.y || 0) - 30, 'Группа распущена', '#f93');
  });

  socket.on('lobbyError', ({ msg }) => {
    if (typeof dmgNum === 'function' && player) dmgNum(player.x, player.y - 30, msg, '#f55');
  });

  socket.on('disconnect', () => {
    socket = null;
    inRaid = false;
    _raidWaveNotif = null;
    serverEnemies = [];
    otherPlayers = new Map();
    otherProjs = [];
    partyMembers = [];
    partyInvitePending = null;
    clanData = null;
    const chatBtn = document.getElementById('chat-btn');
    if (chatBtn) chatBtn.style.display = 'none';
    const chatPanel = document.getElementById('chat-panel');
    if (chatPanel) chatPanel.classList.remove('open');
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

// ── Clan helpers ──────────────────────────────────────────────
function netClanCreate(name, icon) {
  if (socket?.connected) socket.emit('clanCreate', { name, icon });
}
function netClanApply(clanId) {
  if (socket?.connected) socket.emit('clanApply', { clanId });
}
function netClanApprove(telegramId) {
  if (socket?.connected) socket.emit('clanApprove', { telegramId });
}
function netClanDecline(telegramId) {
  if (socket?.connected) socket.emit('clanDecline', { telegramId });
}
function netClanKick(telegramId) {
  if (socket?.connected) socket.emit('clanKick', { telegramId });
}
function netClanLeave() {
  if (socket?.connected) socket.emit('clanLeave');
  clanData = null;
  updateClanUI();
}
function netClanDisband() {
  if (socket?.connected) socket.emit('clanDisband');
  clanData = null;
  updateClanUI();
}
function netClanSearch(query) {
  if (socket?.connected) socket.emit('clanSearch', { query: (query || '').slice(0, 20) });
}

// ── Auth ──────────────────────────────────────────────────────
function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  if (el) el.textContent = msg;
}

// Called by the Telegram Login Widget iframe when the user authenticates
window.onTelegramAuth = function(user) {
  showAuthError('Вход...');
  if (!socket || !socket.connected) {
    netConnect(() => socket.emit('loginTelegram', user));
  } else {
    socket.emit('loginTelegram', user);
  }
};

function _initTelegramWidget() {
  const twa = window.Telegram?.WebApp;

  // Running inside Telegram Mini App — initData already has the signed user info
  if (twa && twa.initData) {
    twa.ready();
    twa.expand();
    const loading = document.getElementById('tg-auth-loading');
    if (loading) loading.innerHTML = '<div class="tg-spinner"></div><span>Авторизация...</span>';
    netConnect(() => socket.emit('loginTelegramWebApp', { initData: twa.initData }));
    return;
  }

  // Regular browser — show the Telegram Login Widget button
  netConnect();
  fetch('/tg-botname')
    .then(r => r.json())
    .then(({ username }) => {
      if (!username) throw new Error('no username');
      const loading   = document.getElementById('tg-auth-loading');
      const container = document.getElementById('tg-widget-container');
      if (!container) return;

      // Telegram reads data-* from the <script> tag itself, then replaces it with an iframe
      const script = document.createElement('script');
      script.async = true;
      script.src = 'https://telegram.org/js/telegram-widget.js?22';
      script.setAttribute('data-telegram-login', username);
      script.setAttribute('data-size', 'large');
      script.setAttribute('data-radius', '8');
      script.setAttribute('data-onauth', 'onTelegramAuth(user)');
      script.setAttribute('data-request-access', 'write');
      container.appendChild(script);

      if (loading) loading.style.display = 'none';
      container.style.display = 'flex';
    })
    .catch(() => {
      const loading = document.getElementById('tg-auth-loading');
      if (loading) loading.innerHTML = '<span style="color:#f66">Ошибка загрузки.<br>Обновите страницу.</span>';
    });
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


function _emitSaveProgress() {
  if (!player || state !== 'playing') return;
  const stats = {
    type: player.type,
    floor: dungeonLvl || 1,
    lvl: player.lvl, xp: player.xp, xpNext: player.xpNext,
    gold: player.gold, kills: player.kills,
    hp: player.hp, maxHp: player.maxHp,
    atk: player.atk, def: player.def,
    baseAtk: player.baseAtk, baseDef: player.baseDef, baseMaxHp: player.baseMaxHp,
    inventory: player.inventory, equipment: player.equipment,
    potionBag: player.potionBag || { pt1: 0, pt2: 0 },
    hudPotion: player.hudPotion || 'pt1',
    upgrades: player.upgrades || {},
    questIdx: player.questIdx || 0,
    questKills: player.questKills || {},
  };
  if (socket?.connected) socket.emit('saveProgress', { stats });
}

// Debounced save — serializing the full inventory + equipment on every kill
// and pickup caused frame spikes mid-combat. Coalesce into at most one emit
// per 2s (trailing edge); netSaveProgressNow() flushes immediately for
// floor changes and page unload where the save must not be lost.
let _saveTimer = null, _lastSaveMs = 0;
function netSaveProgress() {
  if (!player || state !== 'playing') return;
  const now = Date.now();
  if (now - _lastSaveMs >= 2000) { _lastSaveMs = now; _emitSaveProgress(); return; }
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    _lastSaveMs = Date.now();
    _emitSaveProgress();
  }, 2000 - (now - _lastSaveMs));
}

function netSaveProgressNow() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  _lastSaveMs = Date.now();
  _emitSaveProgress();
}

function netHealParty(amount) {
  if (socket?.connected) socket.emit('healParty', { amount: Math.max(0, Math.min(amount, 9999)) });
}
function netSkillAttack(enemyId, multiplier) {
  if (socket?.connected) socket.emit('skillAttack', { enemyId, multiplier });
}
function netSkillStun(enemyId, duration) {
  if (socket?.connected && enemyId) socket.emit('skillEffect', { enemyId, type: 'stun', duration });
}
function netSkillSlow(enemyIds, duration) {
  if (socket?.connected && enemyIds && enemyIds.length) socket.emit('skillEffect', { enemyIds, type: 'slow', duration });
}
function netPlayerInvis(invis) {
  if (socket?.connected) socket.emit('playerInvis', { invis: !!invis });
}
function netFaithShield(duration) {
  if (socket?.connected) socket.emit('faithShield', { duration });
}

function netChat(text) {
  if (!text || !text.trim() || !socket?.connected) return;
  socket.emit('chat', { text: text.trim().slice(0, 100) });
}

const _chatMsgs = [];
function _addChatMsg(username, text) {
  const now = new Date();
  const time = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
  _chatMsgs.push({ username, text, time });
  if (_chatMsgs.length > 30) _chatMsgs.shift();

  const el = document.getElementById('chat-msgs');
  if (!el) return;

  const myName = (typeof netUsername !== 'undefined' && netUsername) || '';
  const isMe = myName && username === myName;

  const row = document.createElement('div');
  row.className = 'chat-row';
  row.innerHTML = `<div class="chat-row-hdr"><span class="chat-name${isMe ? ' is-me' : ''}">${_escHtml(username)}</span><span class="chat-time">${time}</span></div><div class="chat-text">${_escHtml(text)}</div>`;
  el.appendChild(row);
  while (el.children.length > 30) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;

  const panel = document.getElementById('chat-panel');
  if (!panel || !panel.classList.contains('open')) {
    if (typeof _chatUnread !== 'undefined') _chatUnread++;
    const badge = document.getElementById('chat-badge');
    if (badge) {
      badge.textContent = (_chatUnread || 0) > 9 ? '9+' : String(_chatUnread || 1);
      badge.style.display = 'flex';
    }
  }
}

function _escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function _finishOnlineStart() {
  csHide();
  document.getElementById('bottom-nav').style.display = 'block';
  document.querySelectorAll('.bpanel').forEach(p => p.style.display = 'block');
  const chatBtn = document.getElementById('chat-btn');
  if (chatBtn) chatBtn.style.display = 'flex';
  state = 'playing';
  setTab(0);
}

// ── Move throttle ─────────────────────────────────────────────
let _lastMoveSend = 0;
function netSendMove() {
  if (!socket?.connected || !player) return;
  const now = Date.now();
  // Server ticks at 25ms (40Hz) — sending faster than that is pure waste:
  // extra emits cost JSON serialization + radio wakeups on mobile.
  if (now - _lastMoveSend < 25) return;
  _lastMoveSend = now;
  if (inRaid) {
    socket.emit('raidMove', { x: player.x, y: player.y, hp: player.hp });
  } else {
    socket.emit('playerMove', { x: player.x, y: player.y, facing: player.facing, hp: player.hp });
  }
}

function netUsePotion(amount) {
  if (socket?.connected) socket.emit('usePotion', { amount });
}

function netStatsUpdate(atk, def, maxHp) {
  if (socket?.connected) socket.emit('statsUpdate', { atk, def, maxHp });
}

function netAttack(enemyId) {
  if (!socket?.connected) return;
  if (typeof inSafeZone === 'function' && player && inSafeZone(player.x, player.y)) return;
  if (invisTimer > 0) { invisTimer = 0; socket.emit('playerInvis', { invis: false }); }
  if (inRaid) { socket.emit('raidAttack', { enemyId }); return; }
  socket.emit('attack', { enemyId });
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

function netEnterRaid() {
  if (socket?.connected) socket.emit('enterRaid', { dungeonId: 1 });
}
function netLeaveRaid() {
  if (socket?.connected) socket.emit('leaveRaid');
  inRaid = false;
}

function netCreateLobby(dungeonId) {
  if (socket?.connected) socket.emit('createRaidLobby', { dungeonId: dungeonId || 1 });
}
function netJoinLobby(lobbyId) {
  if (socket?.connected) socket.emit('joinRaidLobby', { lobbyId });
}
function netLeaveLobby() {
  if (socket?.connected) socket.emit('leaveRaidLobby');
  _myLobbyId = null; _isLobbyCreator = false; _myLobbyMembers = [];
}
function netStartLobby() {
  if (socket?.connected) socket.emit('startRaidLobby');
}
function netGetLobbyList() {
  if (socket?.connected) socket.emit('getLobbyList');
}

// Init Telegram widget on page load (bundle runs at end of <body>)
_initTelegramWidget();

