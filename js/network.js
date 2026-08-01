// ── Network module ───────────────────────────────────────────
const SERVER_URL = (() => {
  const h = window.location.hostname;
  // Same-origin in production — the server serves both the static site and
  // the Socket.IO endpoint from one process (server/index.js), so this
  // always points at wherever the page itself was loaded from. Avoids
  // hardcoding a specific deploy domain that breaks the moment it changes
  // (as a hardcoded Railway URL did here).
  return (h === 'localhost' || h === '127.0.0.1' || h === '')
    ? 'http://localhost:3000'
    : window.location.origin;
})();

let _savedData = null;
// True only between a received 'authOk' and the next 'disconnect' — a fresh
// socket.io reconnect (e.g. switching away to Tonkeeper to approve a TON
// Connect transaction/connection and back — the mini app's WebView routinely
// drops the socket while backgrounded) reconnects the *transport* first;
// the server doesn't treat this connection as authed until the client's
// re-sent loginTelegramWebApp round-trips. socket.connected alone can't
// tell the two apart, which used to let a GRAM deposit/withdraw fired right
// after such a reconnect reach the server before authed was set there — the
// handler's `if (!authed) return;` guard then silently dropped it with no
// error shown. See _emitWhenAuthed below.
let _authOkReceived = false;
// Set by the authOk reconnect-guard, consumed by the gameStart handler —
// see comment there for why a reconnect must not reposition/restore.
let _isReconnectRejoin = false;
// Set when authOk picked the local (localStorage) backup over the server's
// savedData because the backup was newer — the gameStart restore then pushes
// it back so the DB catches up. See _pickFreshestSave / the unload-save note.
let _restoredFromBackup = false;

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

  _initGramHandlers(socket);
  _initMarketHandlers(socket);
  _initEventBossHandlers(socket);

  socket.on('_pong', t0 => { _pingMs = Date.now() - t0; });

  socket.on('connect_error', () => {
    showAuthError(typeof t === 'function' ? t('noServerConn') : 'Нет соединения с сервером');
  });

  socket.on('authOk', ({ username, savedData, isNewAccount, clanInfo, gramBalance, gramWallet, refLink, vipData, nexumBalance }) => {
    _authOkReceived = true;
    netUsername = username;
    // The server had no record for this telegramId — either a genuine first
    // login, or an account that existed before but was deleted from the DB
    // (e.g. by an admin). Either way there's nothing to resume: clear any
    // localStorage save backup / remembered class so _pickFreshestSave below
    // and _showCharSelect's fallback don't resurrect the old (deleted)
    // character from this device's local cache.
    if (isNewAccount) {
      try { localStorage.removeItem('_lastCharType'); } catch (_) {}
      if (typeof _clearSaveBackup === 'function') _clearSaveBackup();
    }
    if (clanInfo && typeof onClanData === 'function') onClanData(clanInfo);
    // Store GRAM info globally
    window._gramBalance   = gramBalance   || 0;
    window._gramWallet    = gramWallet    || '';
    window._refLink       = refLink       || '';
    window._vipData       = vipData       || { level: 0, deposited: 0, pending: [] };
    window._nexumBalance  = nexumBalance  || 0;

    // netConnect()'s 'connect' handler re-sends the login on EVERY socket.io
    // reconnect, not just the first — mobile network drops/backgrounding
    // trigger this routinely mid-session. authOk always fires in response,
    // so without this guard every reconnect re-ran the char-select flow,
    // which calls selectChar() -> player = makePlayer(type), silently
    // discarding whatever progress happened since the last save. If we
    // already have a live player, this is a reconnect, not a fresh login:
    // just re-establish the server-side room/floor with our current
    // in-memory stats and leave the local player untouched.
    if (typeof player !== 'undefined' && player) {
      _isReconnectRejoin = true;
      netSelectChar(player.type, _buildSaveStats());
      return;
    }

    _savedData = _pickFreshestSave(savedData || null);
    const _ls = document.getElementById('login-screen');
    if (_ls) {
      _ls.classList.add('splash-out');
      setTimeout(() => { _ls.style.display = 'none'; }, 420);
    }
    _showCharSelect(_savedData);
  });

  socket.on('authError', ({ message }) => { showAuthError(message); });

  socket.on('kicked', ({ reason } = {}) => {
    const msg = reason || (typeof t === 'function' ? t('loggedInElsewhere') : 'Вы вошли с другого устройства');
    showAuthError(msg);
    const _ls = document.getElementById('login-screen');
    if (_ls) { _ls.style.display = ''; _ls.classList.remove('splash-out'); }
    setTimeout(() => {
      if (window.Telegram?.WebApp?.close) window.Telegram.WebApp.close();
      else location.reload();
    }, 2000);
  });

  socket.on('playerJoined', ({ id, username }) => {
    if (!otherPlayers.has(id)) otherPlayers.set(id, { animFrame: 0, animTimer: 0, moving: false });
    otherPlayers.get(id).username = username;
  });

  socket.on('playerLeft', ({ id }) => {
    otherPlayers.delete(id);
    if (typeof pixiRemoveOtherPlayer === 'function') pixiRemoveOtherPlayer(id);
  });

  socket.on('playerChar', ({ id, type }) => {
    if (!otherPlayers.has(id)) otherPlayers.set(id, { animFrame: 0, animTimer: 0, moving: false });
    otherPlayers.get(id).type = type;
    loadSprites(type, () => {});
  });

  socket.on('gameStart', ({ floor, dungeon: d, enemies: initialEnemies, bossStatus: bs, eventBoss: evb }) => {
    dungeonLvl = floor;
    dungeon = { ...d, grid: unpackGrid(d.gridPacked, d.w, d.h), enemies: [], safeZone: d.safeZone || null };
    if (typeof _buildArmGates === 'function') _buildArmGates();
    serverEnemies = (initialEnemies || []).map(e => ({ ...e, targetX: e.x, targetY: e.y }));
    serverEnemiesMap = new Map(serverEnemies.map(e => [e.id, e]));
    otherPlayers = new Map();
    bossStatus = bs || {};
    if (typeof _renderBossPanelBody === 'function') _renderBossPanelBody();
    resetNetCodecMaps(); // binary handle→id maps are scoped to the room
    buildTileCanvas();
    projs = []; otherProjs = []; drops = []; particles = []; dmgNums = []; aoeRings = [];
    // Event boss: restore the countdown banner and any loot already lying on
    // the floor, so joining mid-event shows the same state as everyone else.
    worldDrops = new Map((evb && evb.drops || []).map(d => [d.id, d]));
    _evtBossAlive = !!(evb && evb.alive);
    if (typeof setEventBossCountdown === 'function') setEventBossCountdown(evb && evb.spawnAt || 0);
    // Preload sprites for every corridor's enemy pool — the whole world is
    // reachable from the start, not gated behind a single "current floor".
    if (typeof ARM_NAMES !== 'undefined') {
      ARM_NAMES.forEach((_, i) => {
        const fe = FLOOR_ENEMIES && FLOOR_ENEMIES[i + 1];
        if (fe) (fe.species || []).flatMap(sp => [sp + '_guard', sp + '_warrior']).concat([fe.boss]).filter(Boolean).forEach(eid => loadEnemySprites(eid));
      });
    }
    loadEnemySprites('demon_event_boss');
    if (_isReconnectRejoin) {
      // Resuming after a socket.io reconnect (see authOk guard above) — the
      // dungeon/enemy resync above is still needed since this is a fresh
      // server-side room attachment, but the player already has live,
      // current stats and a real position: don't teleport back to spawn and
      // don't run restoreFromSave, which would stomp them with whatever
      // (possibly stale) savedData this reconnect's authOk carried.
      _isReconnectRejoin = false;
      csOnServerReady();
      // The 'disconnect' handler below force-hides chat-btn (display:none)
      // on any drop, same as the whole-state wipe it also does — but only
      // _finishOnlineStart() (the FIRST-join path) ever sets it back to
      // visible, and a reconnect skips straight to this branch instead of
      // going through that. Without this, a reconnect (background tab
      // suspended mid-session, brief network drop — routine on mobile, and
      // exactly what a raid/party-dungeon transition's loading gap can also
      // trigger) leaves the chat button and its last-message preview
      // permanently hidden, reading as if the whole client had reset.
      const _chatBtn = document.getElementById('chat-btn');
      if (_chatBtn) { _chatBtn.dataset.shown = '1'; _chatBtn.style.display = (typeof activeTab === 'undefined' || activeTab === 0) ? 'flex' : 'none'; }
      if (typeof _refreshChatPreview === 'function') _refreshChatPreview();
      // A reconnect (background tab suspended mid-session, brief network
      // drop, etc.) re-joins as a fresh server-side room entry — if the
      // player's own last-known hp was already 0 when that happened, the
      // death screen never got a chance to show (or got lost along with the
      // dropped connection). Without this, the room resumes them as if nothing
      // happened: no modal, and — since the server now has no record they'd
      // died — no penalty either. Re-run the same death handling a live
      // 'playerHurt' would have triggered.
      if (player && player.hp <= 0 && state !== 'dead') playerDie();
      return;
    }
    if (player) {
      player.x = d.spawn.x; player.y = d.spawn.y;
      camera.x = player.x - W / (2 * ZOOM); camera.y = player.y - _visH() / 2;
      clampCamera();
    }
    // See matching comment in selectChar() (game.js) — one savedData blob per
    // account, not per-type, so don't gate restoration on a .type match.
    const restore = _savedData || null;
    if (restore) { restoreFromSave(restore); _savedData = null; }
    csOnServerReady();
    // If the restore came from the local backup (server DB was behind because a
    // prior unload couldn't flush), push it straight back so the server and DB
    // catch up to the recovered state.
    if (_restoredFromBackup) { _restoredFromBackup = false; netSaveProgressNow(); }
  });

  socket.on('gameState', (data) => {
    if (inRaid || inPartyDungeon) return; // raid/party dungeon use their own *State updates, not floor gameState
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
          if (p.clanName !== undefined && op.clanName !== p.clanName) { op.clanName = p.clanName; op._clanTagCanvas = null; }
          if (p.clanIcon !== undefined && op.clanIcon !== p.clanIcon) { op.clanIcon = p.clanIcon; op._clanTagCanvas = null; }
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
            op.atkAnimTimer = 0.55 / ATTACK_ANIM_SPEEDUP; op.castDuration = op.atkAnimTimer;
            op.animFrame = 0; op.animTimer = 0;
          }
        }
      });

      // Remove players that left AOI or disconnected
      const pids = new Set();
      for (let i = 0; i < players.length; i++) pids.add(players[i].id);
      otherPlayers.forEach((_, id) => {
        if (!pids.has(id)) {
          otherPlayers.delete(id);
          if (typeof pixiRemoveOtherPlayer === 'function') pixiRemoveOtherPlayer(id);
        }
      });
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
      player.hp = (dmg != null) ? Math.max(0, player.hp - dmg) : hp;
      player.hurtTimer = 0.1;
      if (player.hp <= 0) { player.hp = 0; playerDie(); }
    } else {
      const op = otherPlayers.get(id);
      if (op) {
        op.hp = hp;
        op.hurtTimer = 0.1;
        if (hp <= 0 && id === targetId && targetIsPlayer) { targetId = null; targetIsPlayer = false; _chaseArmed = false; }
      }
    }
  });

  socket.on('faithShieldBuff', ({ duration }) => {
    if (!player) return;
    faithShieldTimer = duration;
    player.def = Math.floor(player.def * 1.5);
    if (typeof netStatsUpdate === 'function') netStatsUpdate(player.atk, player.def, player.maxHp);
    dmgNum(player.x, player.y - 40, typeof t === 'function' ? t('faithShieldToast') : '🛡 Щит веры!', '#ff4');
    spawnBurst(player.x, player.y, '#ff4', 8);
  });

  socket.on('pvpDamage', ({ dmg, hp }) => {
    if (!player || state !== 'playing') return;
    // hp is the server's own authoritative post-hit value (Room.js applies
    // PvP damage server-side now) — trust it directly instead of computing
    // and self-reporting a damage number back.
    const actual = Math.max(1, Math.floor(dmg || 0));
    player.hp = hp != null ? Math.max(0, hp) : Math.max(0, player.hp - actual);
    player.hurtTimer = 0.1;
    dmgNum(player.x, player.y - 24, actual, '#f55');
    spawnBurst(player.x, player.y, '#f44', 5);
    if (player.hp <= 0 && state === 'playing') { player.hp = 0; playerDie(); }
  });

  socket.on('pvpHit', ({ x, y, dmg, targetId: hitTargetId }) => {
    if (dmg) {
      dmgNum(x, y - 24, dmg, '#f88');
      if (typeof _applyVampirism === 'function') _applyVampirism(dmg);
    }
    spawnBurst(x, y, '#f44', 4);
    const _hitOp = hitTargetId ? otherPlayers.get(hitTargetId) : null;
    if (_hitOp) _hitOp.hurtTimer = 0.1;
  });

  socket.on('enemyCC', ({ enemyId, enemyIds, type, duration }) => {
    function _applyCC(id) {
      const e = serverEnemiesMap.get(id);
      if (!e) return;
      if (type === 'stun') e.stunTimer = duration;
      else if (type === 'slow') e.slowTimer = duration;
    }
    if (enemyId) _applyCC(enemyId);
    if (enemyIds) enemyIds.forEach(_applyCC);
  });

  socket.on('pvpPlayerCC', ({ targetId, type, duration }) => {
    if (targetId === socket.id) {
      if (!player || state !== 'playing') return;
      if (type === 'stun') {
        player.stunTimer = Math.max(player.stunTimer || 0, duration);
        dmgNum(player.x, player.y - 40, typeof t === 'function' ? t('stunToast') : 'СТАН!', '#ff8');
        spawnBurst(player.x, player.y, '#ff8', 6);
      } else if (type === 'slow') {
        player.slowTimer = Math.max(player.slowTimer || 0, duration);
        dmgNum(player.x, player.y - 40, typeof t === 'function' ? t('slowToast') : 'ЗАМЕДЛЕНИЕ!', '#4af');
        spawnBurst(player.x, player.y, '#4af', 4);
      }
      return;
    }
    const op = otherPlayers.get(targetId);
    if (op) {
      if (type === 'stun') op.stunTimer = duration;
      else if (type === 'slow') op.slowTimer = duration;
    }
  });

  socket.on('enemyHurt', ({ id, hp, dmg, isCrit }) => {
    const e = serverEnemiesMap.get(id);
    if (e) {
      e.hp = hp; // overrides any optimistic hp=0 if kill was wrong
      e.hurtTimer = 0.3;
      if (dmg) {
        _lastOwnDmg = dmg; // track for optimistic kill prediction
        if (isCrit) dmgNum(e.x, e.y - e.size - 4, `⚡ ${dmg}`, '#ff8c00', 19);
        else dmgNum(e.x, e.y - e.size - 4, dmg, '#ff4');
        if (typeof _applyVampirism === 'function') _applyVampirism(dmg);
        // No Sound.hit() here: this broadcasts to everyone on the floor for
        // whoever's attack it was. The player's own hit sound instead fires
        // client-side the instant their own swing/shot lands — see the
        // pendingAttack branch in js/game.js — so only their own shots are
        // ever heard, never other players'.
      }
    }
  });

  function _addStoneToInv(stoneId, qty, px, py) {
    const def = CRAFT_MATS.find(m => m.id === stoneId);
    if (!def || !player) return;
    const ex2 = player.inventory.find(i => i.id === stoneId);
    if (ex2) { ex2.qty = (ex2.qty || 1) + qty; }
    else { player.inventory.push({ ...def, qty }); }
    const label = typeof t === 'function' ? (stoneId === 'bless_stone' ? t('safeStoneLbl') : t('enchantStoneLbl')) : (stoneId === 'bless_stone' ? 'Безоп. камень' : 'Камень заточки');
    dmgNum(px, py - 52, `+${qty}× ${label}`, stoneId === 'bless_stone' ? '#88f' : '#fa8');
    netSaveProgress();
  }

  function _addBoxToInv(boxId, qty, px, py) {
    const def = BOX_DEF.find(b => b.id === boxId);
    if (!def || !player) return;
    const ex2 = player.inventory.find(i => i.id === boxId);
    if (ex2) { ex2.qty = (ex2.qty || 1) + qty; }
    else { player.inventory.push({ ...def, qty }); }
    dmgNum(px, py - 52, `+${qty}× ${def.name}`, boxId === 'box_rare' ? '#5dade2' : '#98e456');
    netSaveProgress();
  }

  socket.on('enemyKilled', ({ id, xp, gold, dmg, isCrit, ex, ey, color, gotLoot, eid, rlvl, boxUncommon, boxRare, normStone, blessStone, nexum, gram }) => {
    if (id === targetId && !targetIsPlayer) { targetId = null; targetIsPlayer = false; _chaseArmed = false; }
    const e = serverEnemiesMap.get(id);
    const px = ex ?? (e ? e.x : player?.x ?? 0);
    const py = ey ?? (e ? e.y : player?.y ?? 0);
    if (dmg) {
      if (isCrit) dmgNum(px, py - 20, `⚡ ${dmg}`, '#ff8c00', 19); else dmgNum(px, py - 20, dmg, '#ff4');
      if (typeof _applyVampirism === 'function') _applyVampirism(dmg);
    }
    spawnBurst(px, py, color || '#f80', 8);
    const _seen = typeof _isPosVisible !== 'function' || _isPosVisible(px, py);
    if (typeof Sound !== 'undefined' && _seen) Sound.death();
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
      if (typeof pixiRemoveEnemy === 'function') pixiRemoveEnemy(id);
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
    if (rlvl && player && typeof onEnterArm === 'function') onEnterArm(rlvl);
    if (gotLoot && player) {
      applyLootToInventory(eid, rlvl);
      if (typeof Sound !== 'undefined' && _seen) Sound.loot();
      // VIP drop bonus: extra loot roll proportional to drop%
      const _vipDrop = (window._vipData?.level > 0 && typeof VIP_BONUSES !== 'undefined')
        ? (VIP_BONUSES[window._vipData.level] || VIP_BONUSES[0]).drop : 0;
      if (_vipDrop > 0 && Math.random() * 100 < _vipDrop) applyLootToInventory(eid, rlvl);
    }
    if (boxUncommon) _addBoxToInv('box_uncommon', boxUncommon, px, py);
    if (boxRare)     _addBoxToInv('box_rare',      boxRare,     px, py - 16);
    if (normStone)  _addStoneToInv('norm_stone',  normStone,  px, py - 32);
    if (blessStone) _addStoneToInv('bless_stone', blessStone, px, py - 48);
    if (gold && player) {
      const _cb = typeof getClanBonus === 'function' ? getClanBonus() : null;
      const _goldFinal = _cb && _cb.gold > 0 ? Math.round(gold * (1 + _cb.gold / 100)) : gold;
      player.gold += _goldFinal;
      const g = _goldFinal % 1 === 0 ? _goldFinal : +_goldFinal.toFixed(1);
      dmgNum(px, py - 36, '+' + g + 'g', '#ff0');
    }
    if (nexum && player) {
      window._nexumBalance = (window._nexumBalance || 0) + nexum;
      player.nexumBalance = window._nexumBalance;
      dmgNum(px, py - 52, '+' + nexum + ' Liberty', '#00e5ff');
    }
    if (gram && player) {
      window._gramBalance = (window._gramBalance || 0) + gram;
      dmgNum(px, py - 68, '+' + gram.toFixed(7) + ' GRAM', '#4fd67a');
    }
  });

  // One boss per corridor — bossStatus is a map keyed by arm name
  // ({ left: {alive,...}, top: {...}, ... }). This push updates just the
  // arm that changed; 'gameStart' below sets the initial full map.
  socket.on('bossStatus', ({ arm, alive, respawnAt }) => {
    if (!bossStatus) bossStatus = {};
    if (arm) bossStatus[arm] = { alive, respawnAt };
    if (typeof _renderBossPanelBody === 'function') _renderBossPanelBody();
  });

  socket.on('spawnProj', data => {
    otherProjs.push({ ...data });
  });

  socket.on('spawnAoe', ({ x, y, r }) => {
    spawnAOE(x, y, r || 80);
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
      dmgNum(player.x, player.y - 30, typeof tVars === 'function' ? tVars('partyCountToast', { n: partyMembers.length }) : 'Пати: ' + partyMembers.length + ' чел.', '#3ef07a');
  });

  socket.on('partyLeft', ({ leftName }) => {
    if (leftName && player)
      dmgNum(player.x, player.y - 30, typeof tVars === 'function' ? tVars('leftPartyToast', { name: leftName }) : leftName + ' покинул пати', '#fa0');
    // partyUpdated (or disconnect) will clear the member list; don't wipe here
  });

  socket.on('healPartyMember', ({ amount }) => {
    if (!player || state !== 'playing') return;
    player.hp = Math.min(player.maxHp, player.hp + amount);
    dmgNum(player.x, player.y - 38, '+' + amount + '♥ ' + (typeof t === 'function' ? t('allyPrayerToast') : 'Молитва союзника!'), '#ff4');
    spawnBurst(player.x, player.y, '#ff4', 6);
  });

  socket.on('chatMsg', ({ username, text }) => {
    _addChatMsg(username, text);
  });

  socket.on('chatHistory', (msgs) => {
    if (!Array.isArray(msgs)) return;
    _setChannelHistory('global', _chatMsgs, 30, msgs);
  });

  // ── Clan chat ─────────────────────────────────────────────
  socket.on('clanChatMsg', ({ username, text }) => {
    _pushChatMsg('clan', _clanChatMsgs, 30, username, text, _nowHHMM());
  });
  socket.on('clanChatHistory', ({ messages }) => {
    _setChannelHistory('clan', _clanChatMsgs, 30, messages);
  });

  // ── Private messages (Беседа) ─────────────────────────────
  // withUsername is always "the other party in this conversation" — the
  // server sends it that way for both the sender's own echo and the
  // recipient's live copy, so this client always knows which conversation a
  // message belongs to regardless of which side originated it. Each partner
  // gets their own persistent entry (_dmConvos) — receiving from someone new
  // never discards whatever conversation you already have open.
  socket.on('privMsg', ({ withUsername, username, text }) => {
    if (!withUsername) return;
    _recordDmMessage(withUsername, username, text, _nowHHMM());
    // Nothing open yet at all → default to showing this one as a convenience.
    // Otherwise leave whatever conversation the user is already viewing alone.
    if (!_currentDmUser() && typeof _setActiveDmUser === 'function') _setActiveDmUser(withUsername);
  });
  socket.on('privMsgHistory', ({ withUsername, messages }) => {
    _setDmConvoHistory(withUsername, messages);
    if (typeof _setActiveDmUser === 'function') _setActiveDmUser(withUsername);
  });
  socket.on('privMsgError', ({ msg }) => _chatChannelError(msg));
  socket.on('chatError', ({ msg }) => _chatChannelError(msg));

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
    const staleIds = new Set(prevMap.keys());
    serverEnemies.length = 0;
    serverEnemiesMap.clear();
    (enemies || []).forEach(se => {
      staleIds.delete(se.id);
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
    // Enemies present last tick but absent now (killed, or wave cleared) — free their pooled sprite
    if (typeof pixiRemoveEnemy === 'function') staleIds.forEach(id => pixiRemoveEnemy(id));
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
    // Previous wave's enemies are all gone now — free their pooled sprites
    if (typeof pixiRemoveEnemy === 'function') serverEnemiesMap.forEach((_, id) => pixiRemoveEnemy(id));
    serverEnemies.length = 0;
    serverEnemiesMap.clear();
    (enemies || []).forEach(se => {
      const e = { ...se, targetX: se.x, targetY: se.y };
      serverEnemies.push(e);
      serverEnemiesMap.set(se.id, e);
    });
    const txt = isBoss ? (typeof t === 'function' ? t('finalBossToast') : '⚔️ ФИНАЛЬНЫЙ БОСС!') : (typeof tVars === 'function' ? tVars('waveToast', { w: wave, total: totalWaves }) : `Волна ${wave} / ${totalWaves}`);
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
    player.hp = Math.max(0, hp);
    player.hurtTimer = 0.1;
    if (dmg) dmgNum(player.x, player.y - 24, dmg, '#f55');
    spawnBurst(player.x, player.y, '#f44', 4);
    if (player.hp <= 0) { player.hp = 0; if (typeof playerDie === 'function') playerDie(); }
  });

  socket.on('raidEnemyKilled', ({ id, ex, ey, isBoss, normStone, blessStone }) => {
    if (id === targetId && !targetIsPlayer) { targetId = null; targetIsPlayer = false; _chaseArmed = false; }
    const e = serverEnemiesMap.get(id);
    const px = ex ?? (e ? e.x : player?.x ?? 0);
    const py = ey ?? (e ? e.y : player?.y ?? 0);
    spawnBurst(px, py, isBoss ? '#ff3333' : '#f80', isBoss ? 14 : 8);
    serverEnemiesMap.delete(id);
    if (typeof pixiRemoveEnemy === 'function') pixiRemoveEnemy(id);
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
      if (dmg) {
        dmgNum(e.x, e.y - (e.size || 16) - 4, dmg, '#ff4');
        if (typeof _applyVampirism === 'function') _applyVampirism(dmg);
      }
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
      op.atkAnimTimer = 0.45 / ATTACK_ANIM_SPEEDUP; op.castDuration = 0.45 / ATTACK_ANIM_SPEEDUP;
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
    if (reason === 'disbanded') dmgNum(player?.x || 0, (player?.y || 0) - 30, typeof t === 'function' ? t('groupDisbandedToast') : 'Группа распущена', '#f93');
  });

  socket.on('lobbyError', ({ msg }) => {
    if (typeof dmgNum === 'function' && player) dmgNum(player.x, player.y - 30, msg, '#f55');
  });

  // ── Party dungeon (maze + boss) ──────────────────────────────────────────
  socket.on('pdLobbyError', ({ msg }) => {
    if (player && typeof dmgNum === 'function') dmgNum(player.x, player.y - 38, msg, '#f93');
  });

  socket.on('pdLobbyList', ({ lobbies }) => {
    _pdLobbyList = lobbies || [];
    if (typeof updatePartyDungeonPanelUI === 'function') updatePartyDungeonPanelUI();
  });

  socket.on('pdLobbyJoined', ({ lobbyId, isCreator, members }) => {
    _myPdLobbyId = lobbyId;
    _isPdLobbyCreator = isCreator;
    _myPdLobbyMembers = members || [];
    if (typeof updatePartyDungeonPanelUI === 'function') updatePartyDungeonPanelUI();
  });

  socket.on('pdLobbyLeft', ({ reason } = {}) => {
    _myPdLobbyId = null; _isPdLobbyCreator = false; _myPdLobbyMembers = [];
    if (typeof updatePartyDungeonPanelUI === 'function') updatePartyDungeonPanelUI();
    if (reason === 'disbanded') dmgNum(player?.x || 0, (player?.y || 0) - 30, typeof t === 'function' ? t('groupDisbandedToast') : 'Группа распущена', '#f93');
  });

  socket.on('partyDungeonStart', (data) => {
    if (typeof enterPartyDungeonMode === 'function') enterPartyDungeonMode(data);
  });

  socket.on('partyDungeonState', ({ enemies, players }) => {
    if (!inPartyDungeon) return;
    const prevMap = new Map(serverEnemies.map(e => [e.id, e]));
    const staleIds = new Set(prevMap.keys());
    serverEnemies.length = 0;
    serverEnemiesMap.clear();
    (enemies || []).forEach(se => {
      staleIds.delete(se.id);
      const prev = prevMap.get(se.id);
      const e = { ...se, targetX: se.x, targetY: se.y };
      if (prev) {
        e.hurtTimer    = prev.hurtTimer    || 0;
        e.atkAnimTimer = prev.atkAnimTimer || 0;
        e._animFrame   = prev._animFrame   || 0;
        e._animTimer   = prev._animTimer   || 0;
        e._animKey     = prev._animKey;
        e._atkDone     = prev._atkDone     || false;
        e._moveTimer   = prev._moveTimer   || 0;
        e._facing      = prev._facing      || 'down';
      }
      serverEnemies.push(e);
      serverEnemiesMap.set(se.id, e);
    });
    if (typeof pixiRemoveEnemy === 'function') staleIds.forEach(id => pixiRemoveEnemy(id));
    const myId = socket.id;
    (players || []).forEach(p => {
      if (p.id === myId) return;
      if (!otherPlayers.has(p.id)) {
        otherPlayers.set(p.id, { ...p, targetX: p.x, targetY: p.y, animFrame: 0, animTimer: 0, moving: false, facing: p.facing || 'front' });
        if (p.type) loadSprites(p.type, () => {});
      } else {
        const op = otherPlayers.get(p.id);
        op.hp = p.hp; op.maxHp = p.maxHp; op.facing = p.facing || op.facing;
        if (p.username !== undefined) op.username = p.username;
        if (p.type && op.type !== p.type) { op.type = p.type; loadSprites(p.type, () => {}); }
        op.targetX = p.x; op.targetY = p.y;
      }
    });
  });

  socket.on('partyDungeonPlayerHurt', ({ hp, dmg }) => {
    if (!player || state !== 'playing') return;
    player.hp = Math.max(0, hp);
    player.hurtTimer = 0.1;
    if (dmg) dmgNum(player.x, player.y - 24, dmg, '#f55');
    spawnBurst(player.x, player.y, '#f44', 4);
    // Dying here doesn't respawn in place — the server ejects the player
    // from the instance and follows up with partyDungeonEliminated, which
    // is what actually exits the mode and shows the death screen.
  });

  socket.on('partyDungeonEliminated', () => {
    if (!player) return;
    player.hp = 0;
    if (typeof exitPartyDungeonMode === 'function') exitPartyDungeonMode();
    if (typeof playerDie === 'function') playerDie();
  });

  socket.on('partyDungeonEnemyHurt', ({ id, hp, dmg, isCrit }) => {
    const e = serverEnemiesMap.get(id);
    if (e) {
      e.hp = hp;
      e.hurtTimer = 0.3;
      if (dmg) {
        if (isCrit) dmgNum(e.x, e.y - e.size - 4, `⚡ ${dmg}`, '#ff8c00', 19); else dmgNum(e.x, e.y - e.size - 4, dmg, '#ff4');
        if (typeof _applyVampirism === 'function') _applyVampirism(dmg);
      }
    }
  });

  socket.on('partyDungeonEnemyKilled', ({ id, xp, gold, dmg, isCrit, ex, ey, color, isBoss, normStone, blessStone }) => {
    if (id === targetId && !targetIsPlayer) { targetId = null; targetIsPlayer = false; _chaseArmed = false; }
    const e = serverEnemiesMap.get(id);
    const px = ex ?? (e ? e.x : player?.x ?? 0);
    const py = ey ?? (e ? e.y : player?.y ?? 0);
    if (dmg) {
      if (isCrit) dmgNum(px, py - 20, `⚡ ${dmg}`, '#ff8c00', 19); else dmgNum(px, py - 20, dmg, '#ff4');
      if (typeof _applyVampirism === 'function') _applyVampirism(dmg);
    }
    spawnBurst(px, py, color || (isBoss ? '#ff3333' : '#f80'), isBoss ? 14 : 8);
    const dd = e && typeof ENEMY_SPRITE_DEF !== 'undefined' && ENEMY_SPRITE_DEF[e.eid]?.sheets?.death;
    if (dd) {
      e.hp = 0;
      e.atkAnimTimer = 0; e.hurtTimer = 0; e._moveTimer = 0;
      e._deathTimer = dd.cols / dd.fps + 0.1;
    } else {
      serverEnemiesMap.delete(id);
      if (typeof pixiRemoveEnemy === 'function') pixiRemoveEnemy(id);
      let j = 0;
      for (let i = 0; i < serverEnemies.length; i++) {
        if (serverEnemies[i].id !== id) serverEnemies[j++] = serverEnemies[i];
      }
      serverEnemies.length = j;
    }
    if (xp && player) { player.kills++; gainXP(xp); }
    if (gold && player) {
      player.gold += gold;
      const g = gold % 1 === 0 ? gold : +gold.toFixed(1);
      dmgNum(px, py - 36, '+' + g + 'g', '#ff0');
    }
    if (normStone)  _addStoneToInv('norm_stone',  normStone,  px, py);
    if (blessStone) _addStoneToInv('bless_stone', blessStone, px, py - 16);
  });

  socket.on('partyDungeonNexum', ({ amount, balance }) => {
    if (!player) return;
    window._nexumBalance = balance != null ? balance : (window._nexumBalance || 0) + (amount || 0);
    player.nexumBalance = window._nexumBalance;
    dmgNum(player.x, player.y - 52, '+' + amount + ' Liberty', '#00e5ff');
  });

  socket.on('partyDungeonComplete', ({ gold, xp }) => {
    // gold/xp here are the boss kill's own reward share, already granted by
    // the preceding partyDungeonEnemyKilled event for this same kill — this
    // event is a "you cleared it" notification, not a second reward, so it
    // only re-displays those numbers in the victory modal without re-adding
    // them (that would double-count on top of what enemyKilled just gave).
    if (typeof exitPartyDungeonMode === 'function') exitPartyDungeonMode();
    if (typeof showPartyDungeonComplete === 'function') showPartyDungeonComplete({ gold: Math.round(gold || 0), xp: Math.round(xp || 0) });
    if (typeof netSaveProgress === 'function') netSaveProgress();
  });

  socket.on('partyDungeonFailed', () => {
    if (typeof exitPartyDungeonMode === 'function') exitPartyDungeonMode();
    if (typeof showPartyDungeonFailed === 'function') showPartyDungeonFailed();
  });

  socket.on('specialQuestDone', ({ questId, reward, alreadyDone }) => {
    if (typeof onSpecialQuestDone === 'function') onSpecialQuestDone(questId, reward, alreadyDone);
  });

  socket.on('specialQuestError', ({ questId, reason }) => {
    // Re-enable the quest button so the player can retry
    if (typeof _specialQuestUnlock === 'function') _specialQuestUnlock(questId);
  });

  socket.on('adminGive', ({ gold, nexum, gram }) => {
    if (!player) return;
    if (gold)  { player.gold = (player.gold || 0) + gold; if (typeof updateHUD === 'function') updateHUD(); }
    if (nexum) { if (typeof updateNexumBalance === 'function') updateNexumBalance(nexum); }
    if (gram)  { if (typeof updateGramBalance === 'function') updateGramBalance(gram); }
    if (typeof dmgNum === 'function' && player) dmgNum(player.x, player.y - 40, typeof t === 'function' ? t('adminGiftToast') : '🎁 Подарок от админа!', '#fd0');
  });

  socket.on('disconnect', () => {
    _authOkReceived = false;
    // NOT socket = null: this is the same Socket.IO client instance that
    // will auto-reconnect (default behavior) and re-fire 'connect' on itself
    // — nulling the module-level reference here left every socket?.emit(...)
    // call across the app silently no-op-ing (or the 'connect' handler's own
    // onReady() throwing on a null socket) forever after, even once the
    // underlying transport successfully reconnected. socket.connected already
    // reads false while down and true again once back, which is exactly what
    // every call site here guards on.
    inRaid = false;
    _raidWaveNotif = null;
    serverEnemies = [];
    serverEnemiesMap.clear();
    otherPlayers = new Map();
    if (typeof pixiClearEntityPools === 'function') pixiClearEntityPools();
    otherProjs = [];
    partyMembers = [];
    partyInvitePending = null;
    clanData = null;
    const chatBtn = document.getElementById('chat-btn');
    if (chatBtn) chatBtn.style.display = 'none';
    const chatPanel = document.getElementById('chat-panel');
    if (chatPanel) chatPanel.classList.remove('open');
    const chatPreview = document.getElementById('chat-preview');
    if (chatPreview) chatPreview.style.display = 'none';
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

// ── Special Quests ────────────────────────────────────────
function netCompleteSpecialQuest(questId) {
  if (socket?.connected) socket.emit('completeSpecialQuest', { questId });
}

async function fetchSpecialQuests() {
  try {
    const r = await fetch('/api/special-quests');
    if (!r.ok) return [];
    const { quests } = await r.json();
    return quests || [];
  } catch { return []; }
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



function _initTelegramWidget() {
  const twa = window.Telegram?.WebApp;

  if (twa && twa.initData) {
    // Full Telegram Mini App setup
    twa.ready();
    twa.expand();
    twa.disableVerticalSwipes?.();
    twa.setHeaderColor?.('#000000');
    twa.setBackgroundColor?.('#000000');
    twa.lockOrientation?.();

    const photoUrl = twa.initDataUnsafe?.user?.photo_url;
    if (photoUrl && typeof setTelegramAvatar === 'function') setTelegramAvatar(photoUrl);

    netConnect(() => socket.emit('loginTelegramWebApp', { initData: twa.initData }));
    return;
  }

  // Opened outside Telegram — overlay a "play in Telegram" prompt over the splash
  const loginScreen = document.getElementById('login-screen');
  if (!loginScreen) return;
  fetch('/tg-botname')
    .then(r => r.json())
    .then(({ username }) => {
      const link = username ? `https://t.me/${username}` : 'https://t.me';
      const splashContent = loginScreen.querySelector('.splash-content');
      if (splashContent) {
        splashContent.innerHTML = `
          <div class="splash-emblem" style="margin-bottom:24px;">
            <img src="/images/nexum-coin_v2.png" width="160" height="160" alt="Liberty" style="border-radius:50%;display:block;">
          </div>
          <div class="splash-title">LIBERTY</div>
          <div class="splash-sub">MMORPG</div>
          <div style="margin-top:28px;font-size:13px;color:#7c3aed;line-height:1.8;">Доступно только<br>в Telegram</div>
          <a href="${link}" style="margin-top:20px;display:inline-flex;align-items:center;gap:9px;background:#229ED9;color:#fff;padding:13px 26px;border-radius:14px;font-size:15px;font-weight:600;text-decoration:none;pointer-events:auto;">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12L7.737 13.33l-2.963-.924c-.643-.204-.657-.643.136-.953l11.57-4.461c.537-.194 1.006.131.834.949z"/></svg>
            Открыть в Telegram
          </a>
        `;
      }
    })
    .catch(() => { /* keep the splash as-is */ });
}

function _showCharSelect(savedData) {
  // Prefer server savedData, fall back to localStorage for fast refresh
  // before the first DB write completes (race condition on reconnect).
  const type = savedData?.type || (() => {
    try { return localStorage.getItem('_lastCharType'); } catch (_) { return null; }
  })();
  if (type) {
    const el = document.getElementById('char-select');
    if (el) {
      el.style.display = 'flex';
      Array.from(el.children).forEach(child => {
        if (child.id !== 'cs-loading') child.style.display = 'none';
      });
    }
    selectChar(type);
  } else {
    csShow(savedData);
  }
}


function _buildSaveStats() {
  if (!player) return null;
  return {
    type: player.type,
    // Party dungeon mode force-sets dungeonLvl to 5 purely so the maze
    // renders with floor 5's theme/tileset — that's not the player's real
    // last floor, so a save mid-run must persist the floor backed up in
    // _normalDungeonLvl instead, or the account would come back on floor 5
    // next login regardless of actual progress. Raid mode never touches
    // dungeonLvl at all, so this is a no-op there.
    floor: inPartyDungeon ? (_normalDungeonLvl || 1) : (dungeonLvl || 1),
    lvl: player.lvl, xp: player.xp, xpNext: player.xpNext,
    gold: player.gold, kills: player.kills,
    hp: player.hp, maxHp: player.maxHp,
    atk: player.atk, def: player.def,
    baseAtk: player.baseAtk, baseDef: player.baseDef, baseMaxHp: player.baseMaxHp,
    inventory: player.inventory, storage: player.storage, equipment: player.equipment,
    potionBag: player.potionBag || { pt1: 0, pt2: 0 },
    hudPotion: player.hudPotion || 'pt1',
    buffs: player.buffs || {},
    autoHpPct: player.autoHpPct != null ? player.autoHpPct : 0,
    upgrades: player.upgrades || {},
    questIdx: player.questIdx || 0,
    questKills: player.questKills || {},
    specialQuestsDone: player.specialQuestsDone || [],
    skillLevels: player.skillLevels || {},
    passiveLevels: player.passiveLevels || {},
    bonusSP: player.bonusSP || 0,
    lang: (typeof currentLang !== 'undefined' && currentLang) || 'ru',
    // Freshness stamp so a reload can tell which of {server DB, local backup}
    // holds the most recent state (see _pickFreshestSave).
    savedAt: Date.now(),
  };
}

// ── Local save backup ─────────────────────────────────────────────────────
// A page unload/close usually cannot flush the final saveProgress over the
// WebSocket in time — the socket is torn down before the frame is written — so
// the DB keeps a slightly older snapshot and the player reloads to find their
// last actions rolled back. localStorage.setItem, by contrast, completes
// synchronously and survives unload, so we mirror every save into it and, on
// the next load, adopt it when it is newer than what the server returned.
// Keyed per Telegram user id so a shared device never restores account A's
// progress into account B.
function _tgUserId() {
  try { return String(window.Telegram?.WebApp?.initDataUnsafe?.user?.id || ''); }
  catch (_) { return ''; }
}
function _saveBackupKey() {
  const id = _tgUserId();
  return id ? `_saveBackup_${id}` : '_saveBackup';
}
function _writeSaveBackup(stats) {
  try { localStorage.setItem(_saveBackupKey(), JSON.stringify(stats)); } catch (_) {}
}
function _readSaveBackup() {
  try { const raw = localStorage.getItem(_saveBackupKey()); return raw ? JSON.parse(raw) : null; }
  catch (_) { return null; }
}
function _clearSaveBackup() {
  try { localStorage.removeItem(_saveBackupKey()); } catch (_) {}
}
// Choose the freshest of the server's savedData and the local backup. The
// backup only wins when it is strictly newer by its savedAt stamp, so a save
// that did reach the server (newer server savedAt) is always preferred and
// multi-device play resolves correctly by wall-clock.
function _pickFreshestSave(srv) {
  const bak = _readSaveBackup();
  if (bak && bak.type && (bak.savedAt || 0) > (srv?.savedAt || 0)) {
    _restoredFromBackup = true;
    return bak;
  }
  return srv;
}

function _emitSaveProgress() {
  if (!player || state !== 'playing') return;
  const stats = _buildSaveStats();
  _writeSaveBackup(stats); // synchronous — lands even when the emit below is lost to unload
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
  if (!socket?.connected) return;
  const amt = Math.max(0, Math.min(amount, 9999));
  if (inPartyDungeon) { socket.emit('partyDungeonHealParty', { amount: amt }); return; }
  socket.emit('healParty', { amount: amt });
}
function netSkillAttack(enemyId, multiplier) {
  if (!socket?.connected) return;
  if (inPartyDungeon) { socket.emit('partyDungeonSkillAttack', { enemyId, multiplier }); return; }
  socket.emit('skillAttack', { enemyId, multiplier });
}
function netSkillStun(enemyId, duration) {
  if (!socket?.connected || !enemyId) return;
  if (inPartyDungeon) { socket.emit('partyDungeonSkillEffect', { enemyId, type: 'stun', duration }); return; }
  socket.emit('skillEffect', { enemyId, type: 'stun', duration });
}
function netSkillSlow(enemyIds, duration) {
  if (!socket?.connected || !enemyIds || !enemyIds.length) return;
  if (inPartyDungeon) { socket.emit('partyDungeonSkillEffect', { enemyIds, type: 'slow', duration }); return; }
  socket.emit('skillEffect', { enemyIds, type: 'slow', duration });
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
function netClanChat(text) {
  if (!text || !text.trim() || !socket?.connected) return;
  socket.emit('clanChat', { text: text.trim().slice(0, 100) });
}
function netPrivMsg(toUsername, text) {
  if (!toUsername || !text || !text.trim() || !socket?.connected) return;
  socket.emit('privMsg', { toUsername, text: text.trim().slice(0, 100) });
}
function netRequestClanChatHistory() {
  if (socket?.connected) socket.emit('clanChatHistory', {});
}
function netRequestDmHistory(withUsername) {
  if (withUsername && socket?.connected) socket.emit('privMsgHistory', { withUsername });
}

// ── Multi-channel chat (Общий / Клан / Беседа) ────────────────────────────
// _chatTab ('global'|'clan'|'dm') and _activeDmUser are owned by the
// chat-panel script in index.html (co-located with _chatOpen/_chatSend/tab
// switching); referenced here via typeof guards, the same cross-file
// pattern already used throughout this file (e.g. _refreshChatPreview).
const _chatMsgs = [];
const _clanChatMsgs = [];
// Беседа keeps one entry PER partner (not a single overwritten thread) so
// writing to a new person never discards a conversation you already had
// open — that was the bug this replaced. Keyed by lowercased username;
// index.html's _renderDmConvoList/_openDmConvo/_closeDmConvo build the
// "which conversation" chip row on top of this.
const _dmConvos = new Map(); // lowercased username -> { username, messages: [], unread }

function _nowHHMM() {
  const now = new Date();
  return now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
}

function _currentChatTab() { return (typeof _chatTab !== 'undefined' && _chatTab) || 'global'; }
function _currentDmUser() { return (typeof _activeDmUser !== 'undefined' && _activeDmUser) || null; }

function _dmConvo(username, createIfMissing) {
  const key = String(username || '').toLowerCase();
  if (!key) return null;
  let c = _dmConvos.get(key);
  if (!c && createIfMissing) { c = { username, messages: [], unread: false }; _dmConvos.set(key, c); }
  return c;
}
function _dmConvoList() { return [..._dmConvos.values()]; }
function _removeDmConvoData(username) { _dmConvos.delete(String(username || '').toLowerCase()); }

function _chatListFor(tabKey) {
  if (tabKey === 'clan') return _clanChatMsgs;
  if (tabKey === 'dm') { const c = _dmConvo(_currentDmUser(), false); return c ? c.messages : []; }
  return _chatMsgs;
}

function _renderChatRow(el, username, text, time) {
  const myName = (typeof netUsername !== 'undefined' && netUsername) || '';
  const isMe = myName && username === myName;
  const row = document.createElement('div');
  row.className = 'chat-row';
  row.innerHTML = `<div class="chat-row-hdr"><span class="chat-name${isMe ? ' is-me' : ''}">${_escHtml(username)}</span><span class="chat-time">${time}</span></div><div class="chat-text">${_escHtml(text)}</div>`;
  el.appendChild(row);
}

// Re-renders #chat-msgs from scratch using whichever channel/conversation
// matches the currently active tab — called on tab switch, conversation
// switch (index.html) and whenever a history payload lands for what's
// currently on screen.
function _renderActiveChatList() {
  const el = document.getElementById('chat-msgs');
  if (!el) return;
  el.innerHTML = '';
  _chatListFor(_currentChatTab()).forEach(m => _renderChatRow(el, m.username, m.text, m.time));
  el.scrollTop = el.scrollHeight;
}

// Bumps the shared unread badge (one combined counter across every channel/
// conversation) — used whenever a message lands somewhere other than what's
// currently on screen.
function _bumpChatUnread() {
  if (typeof _chatUnread !== 'undefined') _chatUnread++;
  const badge = document.getElementById('chat-badge');
  if (badge) {
    badge.textContent = (_chatUnread || 0) > 9 ? '9+' : String(_chatUnread || 1);
    badge.style.display = 'flex';
  }
}

// Pushes one live message into a channel's array (global/clan only — see
// _recordDmMessage for Беседа, which has to pick a specific conversation
// rather than one shared array). If that channel is the one currently on
// screen it's appended immediately; otherwise just bumps the unread badge.
function _pushChatMsg(tabKey, list, cap, username, text, time) {
  list.push({ username, text, time });
  if (list.length > cap) list.shift();

  const activeTabKey = _currentChatTab();
  const panel = document.getElementById('chat-panel');
  const visible = panel && panel.classList.contains('open') && activeTabKey === tabKey;
  if (activeTabKey === tabKey) {
    const el = document.getElementById('chat-msgs');
    if (el) {
      _renderChatRow(el, username, text, time);
      while (el.children.length > cap) el.removeChild(el.firstChild);
      el.scrollTop = el.scrollHeight;
    }
  }
  if (!visible) _bumpChatUnread();
  if (tabKey === 'global') _refreshChatPreview();
}

// Records one message into a specific DM partner's conversation (creating it
// if this is a brand-new conversation). Renders live only if that exact
// conversation is the one currently open; otherwise flags it unread in the
// chip list (see index.html's _renderDmConvoList) without touching whatever
// conversation IS currently open.
function _recordDmMessage(otherUsername, senderUsername, text, time) {
  const convo = _dmConvo(otherUsername, true);
  convo.username = otherUsername; // keep the canonical casing fresh
  convo.messages.push({ username: senderUsername, text, time });
  if (convo.messages.length > 50) convo.messages.shift();

  const isActive = _currentChatTab() === 'dm' && _currentDmUser() && _currentDmUser().toLowerCase() === otherUsername.toLowerCase();
  const panel = document.getElementById('chat-panel');
  const visible = panel && panel.classList.contains('open') && isActive;
  if (isActive) {
    const el = document.getElementById('chat-msgs');
    if (el) {
      _renderChatRow(el, senderUsername, text, time);
      while (el.children.length > 50) el.removeChild(el.firstChild);
      el.scrollTop = el.scrollHeight;
    }
  } else {
    convo.unread = true;
  }
  if (typeof _renderDmConvoList === 'function' && _currentChatTab() === 'dm') _renderDmConvoList();
  if (!visible) _bumpChatUnread();
}

// Replaces a channel's whole history (initial load / tab switch fetch).
function _setChannelHistory(tabKey, list, cap, messages) {
  list.length = 0;
  (messages || []).forEach(m => list.push(m));
  if (list.length > cap) list.splice(0, list.length - cap);
  if (_currentChatTab() === tabKey) _renderActiveChatList();
  if (tabKey === 'global') _refreshChatPreview();
}

// Replaces one DM conversation's whole history (privMsgHistory response).
function _setDmConvoHistory(username, messages) {
  const convo = _dmConvo(username, true);
  convo.username = username;
  convo.messages = (messages || []).slice(-50);
  convo.unread = false;
  if (_currentChatTab() === 'dm' && _currentDmUser() && _currentDmUser().toLowerCase() === username.toLowerCase()) {
    _renderActiveChatList();
  }
  if (typeof _renderDmConvoList === 'function') _renderDmConvoList();
}

function _chatChannelError(msg) {
  if (typeof _marketToast === 'function') _marketToast(msg, 'err');
}

function _addChatMsg(username, text) {
  _pushChatMsg('global', _chatMsgs, 30, username, text, _nowHHMM());
}

// Shows the most recent chat line in the floating bubble above the chat
// button (see #chat-preview, index.html) — hidden while the chat panel is
// already open (redundant there), the chat button itself isn't shown (not
// on the Игра tab / not logged in yet), or there's no message at all.
// Called from _addChatMsg/chatHistory below, _chatOpen/_chatClose
// (index.html), _finishOnlineStart below, and _syncGameOnlyBtns (js/ui.js)
// so every place that can change any of those conditions keeps it in sync.
function _refreshChatPreview() {
  const preview = document.getElementById('chat-preview');
  if (!preview) return;
  const last = _chatMsgs[_chatMsgs.length - 1];
  const panel = document.getElementById('chat-panel');
  const chatBtn = document.getElementById('chat-btn');
  const panelOpen = panel && panel.classList.contains('open');
  const btnVisible = chatBtn && chatBtn.dataset.shown === '1' && (typeof activeTab === 'undefined' || activeTab === 0);
  if (!last || panelOpen || !btnVisible) { preview.style.display = 'none'; return; }

  const myName = (typeof netUsername !== 'undefined' && netUsername) || '';
  const isMe = myName && last.username === myName;
  const nameEl = document.getElementById('chat-preview-name');
  const textEl = document.getElementById('chat-preview-text');
  if (nameEl) { nameEl.textContent = last.username + ':'; nameEl.classList.toggle('is-me', !!isMe); }
  if (textEl) textEl.textContent = last.text;
  preview.style.display = 'flex';
}

function _escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
// For embedding untrusted text (e.g. a Telegram display name with no @handle
// set, which falls back to first_name and so isn't restricted to safe
// characters) inside a double-quoted HTML attribute — _escHtml alone doesn't
// escape quotes, which would let it break out of the attribute.
function _escAttr(s) {
  return _escHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _finishOnlineStart() {
  csHide();
  document.getElementById('bottom-nav').style.display = 'block';
  document.querySelectorAll('.bpanel').forEach(p => p.style.display = 'block');
  const chatBtn = document.getElementById('chat-btn');
  if (chatBtn) { chatBtn.dataset.shown = '1'; chatBtn.style.display = (activeTab === 0) ? 'flex' : 'none'; }
  _refreshChatPreview();
  if (typeof showRatingBtn === 'function') showRatingBtn();
  if (typeof showVipBtn === 'function') showVipBtn();
  if (typeof showMarketBtn === 'function') showMarketBtn();
  if (typeof showGramShopBtn === 'function') showGramShopBtn();
  if (typeof showBossTimerBtn === 'function') showBossTimerBtn();
  state = 'playing';
  setTab(0);
  // Immediately save so a page refresh always finds the character type
  _emitSaveProgress();
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
  } else if (inPartyDungeon) {
    socket.emit('partyDungeonMove', { x: player.x, y: player.y, facing: player.facing, hp: player.hp });
  } else {
    socket.emit('playerMove', { x: player.x, y: player.y, facing: player.facing, hp: player.hp });
  }
}

function netUsePotion(amount) {
  if (socket?.connected) socket.emit('usePotion', { amount });
}

function netStatsUpdate(atk, def, maxHp, critChance, critPower) {
  if (socket?.connected) socket.emit('statsUpdate', { atk, def, maxHp, critChance, critPower });
}

function netAttack(enemyId) {
  if (!socket?.connected) return;
  if (typeof inSafeZone === 'function' && player && inSafeZone(player.x, player.y)) return;
  if (invisTimer > 0) { invisTimer = 0; socket.emit('playerInvis', { invis: false }); }
  if (inRaid) { socket.emit('raidAttack', { enemyId }); return; }
  if (inPartyDungeon) { socket.emit('partyDungeonAttack', { enemyId }); return; }
  socket.emit('attack', { enemyId });
}

function netSelectChar(type, savedStats) {
  if (socket?.connected) socket.emit('selectChar', { type, savedStats: savedStats || null });
}

function netPvpAttack(targetSocketId) {
  if (!socket?.connected) return;
  if (typeof inSafeZone === 'function' && player && inSafeZone(player.x, player.y)) return;
  socket.emit('pvpAttack', { targetId: targetSocketId });
}

function netPvpSkillAttack(targetId, multiplier) {
  if (!socket?.connected) return;
  if (typeof inSafeZone === 'function' && player && inSafeZone(player.x, player.y)) return;
  socket.emit('pvpSkillAttack', { targetId, multiplier });
}

function netPvpSkillCC(targetId, type, duration) {
  if (!socket?.connected) return;
  if (typeof inSafeZone === 'function' && player && inSafeZone(player.x, player.y)) return;
  socket.emit('pvpSkillCC', { targetId, type, duration });
}

function netSetPvpMode(mode) {
  if (socket?.connected) socket.emit('setPvpMode', { pvpMode: mode });
}

function netSpawnProj(proj) {
  if (socket?.connected) socket.emit('spawnProj', proj);
}

function netSpawnAoe(x, y, r) {
  if (socket?.connected) socket.emit('spawnAoe', { x, y, r });
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

// ── Party dungeon (maze + boss) lobby ────────────────────────────────────────
function netCreatePdLobby() {
  if (socket?.connected) socket.emit('createPartyDungeonLobby');
}
function netJoinPdLobby(lobbyId) {
  if (socket?.connected) socket.emit('joinPartyDungeonLobby', { lobbyId });
}
function netLeavePdLobby() {
  if (socket?.connected) socket.emit('leavePartyDungeonLobby');
  _myPdLobbyId = null; _isPdLobbyCreator = false; _myPdLobbyMembers = [];
}
function netStartPdLobby() {
  if (socket?.connected) socket.emit('startPartyDungeonLobby');
}
function netGetPdLobbyList() {
  if (socket?.connected) socket.emit('getPartyDungeonLobbyList');
}
function netLeavePartyDungeon() {
  if (socket?.connected) socket.emit('leavePartyDungeon');
  inPartyDungeon = false;
}

// ── GRAM wallet ───────────────────────────────────────────────────────────────
// Waits (briefly, polling) for both the transport AND the server-side authed
// handshake before emitting — see the _authOkReceived comment up top. A
// TON Connect deposit routinely calls this right as the app returns from
// backgrounding to approve a transaction, exactly the reconnect window this
// guards against. Gives up after ~6s and surfaces an error instead of
// silently doing nothing.
function _emitWhenAuthed(event, payload, triesLeft = 30) {
  if (socket?.connected && _authOkReceived) { socket.emit(event, payload); return; }
  if (triesLeft <= 0) {
    if (typeof _gramMsg === 'function') _gramMsg(typeof t === 'function' ? t('noServerConn') : 'Нет соединения с сервером', 'err');
    return;
  }
  setTimeout(() => _emitWhenAuthed(event, payload, triesLeft - 1), 300);
}
// True only when the socket is up AND the server has re-authed this
// connection — the same condition _emitWhenAuthed waits for. Callers that
// mutate local state optimistically (the market sell flow) must check this
// first, since an emit into a dead or not-yet-authed socket is dropped
// silently and no error ever comes back to roll that mutation back.
function netIsLive() {
  return !!(socket?.connected && _authOkReceived);
}
function netGramDeposit(amount, memo) {
  _emitWhenAuthed('gramDepositRequest', { amount, memo });
}
function netGramWithdraw(amount, address) {
  _emitWhenAuthed('gramWithdrawRequest', { amount, address });
}
function netGramShopBuy(pkgId) {
  if (socket?.connected) socket.emit('gramShopBuy', { pkgId });
}
function netGramHistory() {
  if (socket?.connected) socket.emit('gramGetHistory');
}

function netGetReferrals() {
  if (socket?.connected) socket.emit('getReferrals');
}

// ── Market ──────────────────────────────────────────────────────────────────
function netMarketBrowse() {
  if (socket?.connected) socket.emit('marketBrowse');
}
function netMarketMyListings() {
  if (socket?.connected) socket.emit('marketMyListings');
}
function netMarketHistory() {
  if (socket?.connected) socket.emit('marketHistory');
}
function netMarketList(item, price) {
  if (socket?.connected) socket.emit('marketList', { item, price });
}
function netMarketCancel(listingId) {
  if (socket?.connected) socket.emit('marketCancel', { listingId });
}
function netMarketBuy(listingId) {
  if (socket?.connected) socket.emit('marketBuy', { listingId });
}

function netGetRating(tab) {
  if (socket?.connected) socket.emit('getRating', { tab });
}

// ── Event boss + world drops ────────────────────────────────────────────────
// worldDrops is the shared ground-loot pool (id -> {id,x,y,item}); the server
// arbitrates every pickup, so this map is display-only — an entry disappearing
// means someone else got there first.
function _initEventBossHandlers(s) {
  s.on('eventBossAnnounce', ({ spawnAt }) => {
    if (typeof setEventBossCountdown === 'function') setEventBossCountdown(spawnAt);
  });
  s.on('eventBossSpawned', ({ x, y } = {}) => {
    _evtBossAlive = true;
    if (typeof setEventBossCountdown === 'function') setEventBossCountdown(0);
    if (typeof showEventBossBanner === 'function') showEventBossBanner(t('evtBossArrived'), '#ff5a4a');
    if (typeof Sound !== 'undefined' && (typeof _isPosVisible !== 'function' || x === undefined || _isPosVisible(x, y))) Sound.bossSpawn();
  });
  s.on('eventBossDefeated', () => {
    _evtBossAlive = false;
    if (typeof showEventBossBanner === 'function') showEventBossBanner(t('evtBossDefeated'), '#90d653');
  });
  s.on('worldDropsSpawned', ({ drops: ds }) => {
    (ds || []).forEach(d => worldDrops.set(d.id, d));
  });
  s.on('worldDropTaken', ({ id }) => { worldDrops.delete(id); _worldDropPending.delete(id); });
  s.on('worldDropsExpired', ({ ids }) => { (ids || []).forEach(id => { worldDrops.delete(id); _worldDropPending.delete(id); }); });
  s.on('worldDropPicked', ({ id, item }) => {
    worldDrops.delete(id);
    _worldDropPending.delete(id);
    if (!player || !item) return;
    // The server already wrote this into the account's inventory; mirror it
    // locally and save so the client's own next full-array save agrees.
    if (typeof addToInventoryQty === 'function') addToInventoryQty(item, item.qty || 1);
    if (typeof updateInvUI === 'function') updateInvUI();
    if (typeof dmgNum === 'function') dmgNum(player.x, player.y - 40, '+ ' + item.name, (typeof RARITY_COLOR !== 'undefined' && RARITY_COLOR[item.rarity]) || '#c4a276');
    if (typeof Sound !== 'undefined') Sound.loot();
    netSaveProgress();
  });
  s.on('worldDropError', ({ msg }) => {
    if (typeof _marketToast === 'function') _marketToast(msg, 'err');
  });
}

function netPickupWorldDrop(id) {
  if (socket?.connected) socket.emit('pickupWorldDrop', { id });
}

// Incoming GRAM events
function _initGramHandlers(s) {
  s.on('gramTxCreated', ({ tx, newBalance }) => {
    if (newBalance != null) window._gramBalance = newBalance;
    if (typeof onGramTxCreated === 'function') onGramTxCreated(tx);
  });
  s.on('gramTxUpdate', ({ id, status }) => {
    if (typeof onGramTxUpdate === 'function') onGramTxUpdate(id, status);
  });
  s.on('gramBalanceUpdate', ({ balance }) => {
    window._gramBalance = balance;
    if (player) player.gramBalance = balance;
    if (activeTab === 5 && window._profileTab === 'wallet') updateGramUI();
  });
  s.on('gramHistory', ({ txs }) => {
    if (typeof onGramHistory === 'function') onGramHistory(txs);
  });
  s.on('gramError', ({ msg }) => {
    if (typeof _gramMsg === 'function') _gramMsg(msg, 'err');
  });
  s.on('refData', (data) => {
    if (typeof onRefData === 'function') onRefData(data);
  });
  s.on('friendJoined', (data) => {
    if (typeof onFriendJoined === 'function') onFriendJoined(data);
  });
  s.on('refBonusReceived', (data) => {
    window._gramBalance = (window._gramBalance || 0) + data.bonus;
    if (typeof onRefBonusReceived === 'function') onRefBonusReceived(data);
  });
  s.on('ratingData', ({ tab, rows }) => {
    if (typeof onRatingData === 'function') onRatingData(tab, rows);
  });
  s.on('vipUpdate', (data) => {
    window._vipData = data;
    if (typeof renderVipPanel === 'function') {
      const panel = document.getElementById('vip-panel');
      if (panel && panel.style.display !== 'none') renderVipPanel();
    }
  });
  s.on('vipRewardsClaimed', ({ newInventory, goldAdded, vipPending }) => {
    if (window._vipData) window._vipData.pending = vipPending || [];
    if (player && newInventory) player.inventory = newInventory;
    if (player && goldAdded > 0) {
      player.gold = (player.gold || 0) + goldAdded;
      if (player.x !== undefined) dmgNum(player.x, player.y - 40, '+' + goldAdded + 'g VIP', '#ffd700');
    }
    if (typeof renderVipPanel === 'function') renderVipPanel();
    netSaveProgressNow();
  });
  s.on('gramShopResult', (data) => {
    if (typeof onGramShopResult === 'function') onGramShopResult(data);
    netSaveProgressNow();
  });
  s.on('gramShopError', ({ msg }) => {
    if (typeof onGramShopError === 'function') onGramShopError(msg);
  });
}

// Incoming Market events
function _initMarketHandlers(s) {
  s.on('marketBrowseData', ({ listings }) => {
    if (typeof onMarketBrowseData === 'function') onMarketBrowseData(listings || []);
  });
  s.on('marketMyListingsData', ({ listings }) => {
    if (typeof onMarketMyListingsData === 'function') onMarketMyListingsData(listings || []);
  });
  s.on('marketHistoryData', ({ entries }) => {
    if (typeof onMarketHistoryData === 'function') onMarketHistoryData(entries || []);
  });
  s.on('marketListed', ({ listing }) => {
    if (typeof onMarketListed === 'function') onMarketListed(listing);
  });
  s.on('marketCancelled', ({ listingId, item }) => {
    if (typeof onMarketCancelled === 'function') onMarketCancelled(listingId, item);
  });
  s.on('marketBought', ({ listingId, item, newBalance }) => {
    window._gramBalance = newBalance;
    if (typeof onMarketBought === 'function') onMarketBought(listingId, item);
  });
  s.on('marketSold', (data) => {
    if (typeof onMarketSold === 'function') onMarketSold(data);
  });
  s.on('marketError', ({ msg }) => {
    if (typeof onMarketError === 'function') onMarketError(msg);
  });
  s.on('marketListError', ({ msg }) => {
    if (typeof onMarketListError === 'function') onMarketListError(msg);
  });
}

function netClaimVipRewards() {
  if (socket?.connected) socket.emit('claimVipRewards');
}

// Applies the saved (or default) language before anything renders — see
// js/i18n.js. Safe to call this early since it only mutates data arrays
// and DOM elements already present in the initial HTML.
if (typeof initLocale === 'function') initLocale();

// Init Telegram widget on page load (bundle runs at end of <body>)
_initTelegramWidget();

