// ── Network module ───────────────────────────────────────────
const SERVER_URL = (() => {
  const h = window.location.hostname;
  // Same-origin in production — the server serves both the static site and
  // the Socket.IO endpoint from one process (server/index.js), so this
  // always points at wherever the page itself was loaded from. Avoids
  // hardcoding a specific deploy domain that breaks the moment it changes
  // (as a hardcoded Railway URL did here).
  // Always the page's own origin, including on localhost. It used to pin
  // localhost to port 3000, which is right only when the dev server happens to
  // be on that port — anything else (a second instance, the test harness) had
  // the client dial 3000 and fail to connect while the page itself loaded fine.
  return (h === '') ? 'http://localhost:3000' : window.location.origin;
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
// Set right when this client asks the server for a floor transition
// (netEnterLocation below), consumed by the next gameStart the same way
// _isReconnectRejoin is — a floor change reuses the exact same 'gameStart'
// event as first login/reconnect (see server/index.js's enterLocation
// handler, which builds the payload with the same _buildGameStartPayload),
// so this is what tells _applyGameStart which of the three it's handling.
let _pendingFloorChange = false;
// True only once gameStart's non-reconnect branch has actually run
// restoreFromSave() (or made the deliberate "no data yet, start fresh" call
// for a genuinely new account) at least once this session. The authOk
// reconnect-guard below used to key off `player` merely being non-null, but
// `player` is already assigned (blank, via makePlayer() in selectChar())
// the instant the FIRST authOk's char-select flow starts — well before its
// matching gameStart/restoreFromSave has round-tripped. A slow/flaky
// connection that drops and reconnects in that window made a second authOk
// arrive while player was still that blank object, which the old check
// couldn't tell apart from a legitimate live reconnect: it took the
// reconnect branch, sent the blank stats to the server as "current", and the
// very next autosave persisted them — wiping progress (see the '_lastStats'
// guard added in server/index.js's selectChar handler for the matching
// server-side half of this fix). Until this flag is true, every authOk is
// treated as the original fresh login, however many reconnects happen first.
let _playerRestored = false;
// Last-ditch backstop for the same class of bug as _playerRestored, covering
// any path (present or future) that reaches state==='playing' without real
// data behind it. _accountIsNew comes straight from authOk's isNewAccount —
// the server's own "this telegramId had no record" answer, the only reliable
// way to tell "this character legitimately has nothing yet" apart from "the
// character has progress but this session failed to load it." _sessionHasRealData
// records whether the restore that actually ran carried anything. Together
// they let _emitSaveProgress refuse to write a blank save to the DB for an
// account the server says already exists — the write that turned the
// load-time race below into permanent data loss.
let _accountIsNew = false;
let _sessionHasRealData = false;

// Snapshot interpolation state
let _svrTimeOffset = null; // null = not yet calibrated
// How far in the past other players are rendered. Snapshots arrive every 50ms
// (the server casts at 20Hz), so this is also the budget for a late one: at 65
// a packet arriving 15ms behind schedule already pushed the render clock past
// the newest snapshot, the interpolation clamped, and the avatar froze until
// the packet landed and then jumped. Mobile jitter is routinely 20-50ms, which
// is why other players stuttered for some people at an otherwise fine ping.
// 110 gives a full extra interval of slack. The cost is that everyone else is
// seen 45ms further behind — about 10px of movement, against a 350px hit
// radius on the server, so it changes nothing about whether shots land.
const _INTERP_MS  = 110;
const _SNAP_MAX   = 10;   // ~250ms of buffer
// Staggers the out-of-range enemy sweep in the gameState handler — once a
// second is plenty for something the server already stopped sending.
let _aoiPruneTick = 0;

// RTT ping measurement — updated every _PING_EVERY_MS, read by perf overlay
let _pingMs = -1;
let _pingTimer = null;
const _PING_EVERY_MS = 2000;
// Watchdog state — see the ping loop in netConnect. Four unanswered probes is
// eight seconds: long enough that a brief stall or a GC pause on either side
// can't trip it, short enough that a player is back in the game in seconds
// instead of the two minutes the protocol timeout allows.
//
// Counted in probes, NOT as "now - lastPongAt", because that wall-clock form
// could not tell a dead link from a frozen client, and killed healthy sockets
// for the second reason constantly. Everything that stops this timer from
// running on schedule — a hidden tab (browsers throttle background timers to
// as little as once a minute), the Telegram WebView suspended while the player
// answers a message, a long main-thread stall on a weak phone — makes the next
// tick read many seconds of "silence" that the link had nothing to do with.
// The old check reconnected on the spot: the world was wiped and re-fetched,
// the server kicked and re-seated the session, and to the player it looked
// like the game randomly reconnects itself on a perfectly good connection.
// A counter can be forgiven instead (see _pingTick), so only silence actually
// observed by a running client counts against the link.
let _pongMissed = 0;
const _PONG_MISS_LIMIT = 4;
// Set once this session has been kicked in favour of another login (see the
// 'kicked' handler). Every automatic path back onto the wire checks it: this
// session is over by the server's decision, and re-establishing it would just
// kick the session that replaced it.
let _kicked = false;
// Wall-clock time the watchdog tick last ran, to detect that it did not.
let _lastPingTickAt = 0;
// How late a tick may be before we treat it as the timer having been frozen
// rather than as elapsed time we can hold the link responsible for. Ordinary
// jitter is tens of milliseconds; a throttled or suspended timer overshoots by
// seconds, so anything past one extra interval is the latter.
const _TICK_LATE_MS = _PING_EVERY_MS * 2;

// Give the link a fresh, full silence budget. Called whenever we learn that
// the previous budget was spent on something other than the link being quiet:
// a new connection, or the client coming back from being frozen.
function _resetPingWatchdog() {
  _pongMissed = 0;
  _lastPingTickAt = Date.now();
}

// Watchdog + latency probe, one tick every _PING_EVERY_MS.
//
// engine.io only gives up after pingInterval + pingTimeout, and a link that
// black-holes (Wi-Fi to LTE handover, a sleeping radio, a WebView suspended in
// the background) does not close the TCP connection — it just goes quiet.
// Until the protocol timeout fires the client believes it is online and shows
// a frozen world without even trying to reconnect. We already round-trip every
// two seconds for the latency readout, so unanswered probes are a far faster
// signal: reconnect after four of them instead of waiting out the protocol.
function _pingTick() {
  const now = Date.now();
  const sinceTick = _lastPingTickAt ? now - _lastPingTickAt : 0;
  _lastPingTickAt = now;
  if (_kicked) return;
  if (!socket?.connected) return;

  // This tick fired far later than it was scheduled to, so the timer itself
  // was stopped — the tab was hidden and throttled, the WebView suspended, or
  // the main thread blocked. Probes that were never sent cannot have gone
  // unanswered, and the gap says nothing about the link, so start the budget
  // over rather than spending it on time we spent frozen. The link still gets
  // checked, just from here: if it really did die while we were away, the next
  // four probes go unanswered and the reconnect happens ~8s from now.
  if (sinceTick > _TICK_LATE_MS) _pongMissed = 0;
  // Same reasoning, ahead of time: a hidden page is exactly where the timer is
  // least trustworthy, and nobody is looking at the world anyway. Keep probing
  // (the readout stays warm and engine.io still has its own timeout), but do
  // not tear down a session on evidence gathered in that state.
  else if (_pongMissed >= _PONG_MISS_LIMIT && !_isPageHidden()) {
    _resetPingWatchdog(); // don't re-fire every tick while it reconnects
    _pingMs = -1;
    socket.disconnect();
    socket.connect();
    return;
  }

  _pongMissed++;
  // Deliberately not volatile: socket.io drops a volatile packet whenever the
  // transport is not writable at that instant, and a probe that was silently
  // discarded before it left is indistinguishable here from one the server
  // never answered. Four such drops in a row used to disconnect a healthy
  // session. It is one tiny packet every two seconds — send it for real.
  socket.emit('_ping', now);
}

function _isPageHidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

// Coming back to the foreground after the tab/WebView was hidden: the timer
// above was throttled or stopped for the whole time away, so whatever the
// watchdog has counted up is about us, not about the link. Clear it and probe
// straight away — a link that really did die while we were backgrounded is
// then caught by the normal budget, instead of every single return to the app
// tearing down a working session.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    _resetPingWatchdog();
    if (socket?.connected) socket.emit('_ping', Date.now());
  });
}

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
    // A fresh socket knows nothing about what we last told the server —
    // force the next netSendMove to send rather than compare against a
    // position the old connection reported.
    _lastSentX = null;
    _resetPingWatchdog();
    // Start RTT ping loop
    if (_pingTimer) clearInterval(_pingTimer);
    _pingTimer = setInterval(_pingTick, _PING_EVERY_MS);
  });

  _initGramHandlers(socket);
  _initMarketHandlers(socket);
  _initPetCraftHandlers(socket);
  _initEventBossHandlers(socket);

  socket.on('_pong', t0 => { _pingMs = Date.now() - t0; _pongMissed = 0; });

  socket.on('connect_error', () => {
    showAuthError(typeof t === 'function' ? t('noServerConn') : 'Нет соединения с сервером');
  });

  socket.on('authOk', ({ username, savedData, isNewAccount, clanInfo, gramBalance, gramWallet, refLink, vipData, nexumBalance, topPlayer, vipAuras }) => {
    _authOkReceived = true;
    netUsername = username;
    // Rating leader, for the aura in pixi-world.js. Carried on authOk so a
    // client that joins between two 'topPlayer' broadcasts still knows.
    window._topPlayer = topPlayer || null;
    // The server had no record for this telegramId — either a genuine first
    // login, or an account that existed before but was deleted from the DB
    // (e.g. by an admin). Either way there's nothing to resume: clear the
    // remembered class so _showCharSelect's fallback doesn't resurrect the
    // old (deleted) character's class from this device's local cache.
    if (isNewAccount) {
      try { localStorage.removeItem(_lastCharTypeKey()); } catch (_) {}
    }
    // Only ever widens (never resets to false on a later authOk): once the
    // server has told us this account is brand new, a reconnect's authOk
    // reporting otherwise must not retroactively lock this session out of
    // saving its first, still-empty state. See _emitSaveProgress.
    if (isNewAccount) _accountIsNew = true;
    if (clanInfo && typeof onClanData === 'function') onClanData(clanInfo);
    // Store GRAM info globally
    window._gramBalance   = gramBalance   || 0;
    window._gramWallet    = gramWallet    || '';
    window._refLink       = refLink       || '';
    window._vipData       = vipData       || { level: 0, deposited: 0, pending: [] };
    window._nexumBalance  = nexumBalance  || 0;
    // Usernames of online VIP players who get an aura (js/pixi-world.js).
    // Sent as a whole roster, both here and via the 'vipAuras' broadcast
    // below, so it self-heals rather than drifting on a missed delta.
    window._vipAuraUsers = new Set(vipAuras || []);

    // netConnect()'s 'connect' handler re-sends the login on EVERY socket.io
    // reconnect, not just the first — mobile network drops/backgrounding
    // trigger this routinely mid-session. authOk always fires in response,
    // so without this guard every reconnect re-ran the char-select flow,
    // which calls selectChar() -> player = makePlayer(type), silently
    // discarding whatever progress happened since the last save. If we
    // already have a live player, this is a reconnect, not a fresh login:
    // just re-establish the server-side room/floor with our current
    // in-memory stats and leave the local player untouched.
    if (typeof player !== 'undefined' && player && _playerRestored) {
      _isReconnectRejoin = true;
      netSelectChar(player.type, _buildSaveStats());
      return;
    }

    _savedData = savedData || null;
    const _ls = document.getElementById('login-screen');
    if (_ls) {
      _ls.classList.add('splash-out');
      setTimeout(() => { _ls.style.display = 'none'; }, 420);
    }
    _showCharSelect(_savedData);
  });

  socket.on('authError', ({ message }) => { showAuthError(message); });

  // The server allows one live session per account: a second login kicks the
  // first (see loginTelegramWebApp, server/index.js). This is that message.
  //
  // It must NOT reconnect on its own. Reloading here re-runs the login, which
  // kicks whichever session is now the live one, which reloads and kicks this
  // one back — two clients on one account (a phone plus Telegram Desktop, two
  // browser tabs) ping-ponged forever, each reloading every couple of seconds
  // and paying for a full login round trip every time. From inside either one
  // that is indistinguishable from a server that keeps restarting.
  //
  // So: stop the transport for good — socket.io would otherwise reconnect on
  // its own the moment anything nudged it — and let the player decide when to
  // come back. Telegram still closes the Mini App, which is that platform's
  // own "you're done here" and does not re-enter the loop.
  socket.on('kicked', ({ reason } = {}) => {
    const msg = reason || (typeof t === 'function' ? t('loggedInElsewhere') : 'Вы вошли с другого устройства');
    showAuthError(msg);
    _kicked = true;
    if (_pingTimer) { clearInterval(_pingTimer); _pingTimer = null; }
    if (socket.io) socket.io.reconnection(false);
    socket.disconnect();
    const _ls = document.getElementById('login-screen');
    if (_ls) { _ls.style.display = ''; _ls.classList.remove('splash-out'); }
    setTimeout(() => {
      if (window.Telegram?.WebApp?.close) window.Telegram.WebApp.close();
    }, 2000);
  });

  socket.on('playerJoined', ({ id, username }) => {
    if (!otherPlayers.has(id)) otherPlayers.set(id, { animFrame: 0, animTimer: 0, moving: false });
    otherPlayers.get(id).username = username;
  });

  socket.on('playerLeft', ({ id }) => {
    otherPlayers.delete(id);
    otherPets.delete(id);
    if (typeof pixiRemoveOtherPlayer === 'function') pixiRemoveOtherPlayer(id);
  });

  socket.on('playerChar', ({ id, type }) => {
    if (!otherPlayers.has(id)) otherPlayers.set(id, { animFrame: 0, animTimer: 0, moving: false });
    otherPlayers.get(id).type = type;
    loadSprites(type, () => {});
  });

  // Equipped pets of everyone already on the floor, sent as we join. A full
  // roster, so it replaces the map outright and prunes anyone who has left.
  socket.on('playerPets', ({ pets } = {}) => {
    otherPets = new Map();
    (pets || []).forEach(({ id, petId }) => {
      if (!petId) return;
      otherPets.set(id, petId);
      if (typeof loadPetSprites === 'function') loadPetSprites(petId);
    });
  });

  // One player equipped/unequipped a pet.
  socket.on('playerPet', ({ id, petId } = {}) => {
    if (petId) {
      otherPets.set(id, petId);
      if (typeof loadPetSprites === 'function') loadPetSprites(petId);
    } else {
      otherPets.delete(id);
    }
  });

  // ── World map ──────────────────────────────────────────────────────────────
  // gameStart no longer carries the map (~132KB); it names a version and the
  // map comes from /api/world-map, which is immutable and cached by the
  // browser. That matters most on reconnect: selectChar re-runs on every
  // socket.io reconnect, so a phone that changes network used to re-download
  // and re-parse the whole world every time.
  //
  // Held in memory across reconnects (and floor changes) too, so the common
  // case doesn't even reach the HTTP cache. Each location is now its own
  // floor with its own grid bytes (server/game/floors.js), so the cache is
  // keyed by floor — a stale entry from a different floor sharing the same
  // version string would otherwise serve the wrong map.
  const _mapCache = new Map(); // floor -> { version, data }
  function _decodeWorldMap(buf) {
    const u8 = new Uint8Array(buf);
    const dv = new DataView(buf);
    const jsonLen = dv.getUint32(0, true);
    const meta = JSON.parse(new TextDecoder().decode(u8.subarray(4, 4 + jsonLen)));
    meta.gridPacked = u8.subarray(4 + jsonLen);
    return meta;
  }
  async function _loadWorldMap(floor, version) {
    const cached = _mapCache.get(floor);
    if (cached && cached.version === version) return cached.data;
    try {
      const res = await fetch(`/api/world-map/${floor}/${encodeURIComponent(version)}`);
      if (!res.ok) throw new Error(`map ${res.status}`);
      const data = _decodeWorldMap(await res.arrayBuffer());
      _mapCache.set(floor, { version, data });
      return data;
    } catch (err) {
      // Proxy ate it, cache handed back a 404, offline for a moment — fall
      // back to the socket, which is by definition still working since this
      // code only runs in response to a gameStart that arrived on it. The
      // socket fallback resolves the map for whatever floor the server
      // currently has this socket on, so no floor param is needed here.
      console.warn('[map] HTTP fetch failed, falling back to socket:', err);
      const data = await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('map timeout')), 15000);
        socket.once('worldMap', buf => { clearTimeout(to); resolve(_decodeWorldMap(
          buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))); });
        socket.emit('worldMapInline');
      });
      _mapCache.set(floor, { version, data });
      return data;
    }
  }

  socket.on('gameStart', payload => {
    // Fast path kept strictly synchronous: once this session has the map (i.e.
    // every reconnect, which is when gameStart actually matters for stability)
    // the handler runs start to finish in the same task, exactly as it did
    // when the map travelled inline. Only a genuinely first-time (or new-floor)
    // load defers.
    const cachedEntry = _mapCache.get(payload.floor);
    const cached = (cachedEntry && cachedEntry.version === payload.mapVersion) ? cachedEntry.data : null;
    if (cached) return _applyGameStart(payload, cached);
    _loadWorldMap(payload.floor, payload.mapVersion)
      .then(d => _applyGameStart(payload, d))
      .catch(err => {
        console.error('[map] could not load world map:', err);
        showAuthError(typeof t === 'function' ? t('noServerConn') : 'Нет соединения с сервером');
      });
  });

  function _applyGameStart(payload, d) {
    const { floor, spawn: srvSpawn, enemies: initialEnemies, bossStatus: bs, eventBoss: evb,
            deathBattle: dbs, race10: r10s, arena3: a3s, fear: fs, guildWar: gws } = payload;
    dungeonLvl = floor;
    // A fresh room attachment: whatever this session last told the server
    // about its position belongs to the old one.
    _lastSentX = null;
    dungeon = { ...d, grid: unpackGrid(d.gridPacked, d.w, d.h), enemies: [], safeZone: d.safeZone || null };
    if (typeof _buildArmGates === 'function') _buildArmGates();
    // Every location is its own floor now — NPCs (hub only) need rebuilding
    // on every floor load, not just the very first one.
    if (typeof initNpcs === 'function') initNpcs();
    serverEnemies = (initialEnemies || []).map(e => ({ ...e, targetX: e.x, targetY: e.y }));
    serverEnemiesMap = new Map(serverEnemies.map(e => [e.id, e]));
    otherPlayers = new Map();
    bossStatus = bs || {};
    resetNetCodecMaps(); // binary handle→id maps are scoped to the room
    buildTileCanvas();
    projs = []; otherProjs = []; drops = []; particles = []; dmgNums = []; aoeRings = [];
    // Event-boss ground loot and the map panel's dot cache are both scoped to
    // whatever floor they were fetched/claimed on — stale entries from the
    // floor just left would otherwise survive the switch.
    _worldDropPending.clear();
    _mapBlips = null;
    // Event boss: restore the countdown banner and any loot already lying on
    // the floor, so joining mid-event shows the same state as everyone else.
    worldDrops = new Map((evb && evb.drops || []).map(d => [d.id, d]));
    _evtBossAlive = !!(evb && evb.alive);
    _evtBossState = {
      spawnAt: (evb && evb.spawnAt) || 0,
      alive:   _evtBossAlive,
      nextAt:  (evb && evb.nextAt) || 0,
    };
    if (typeof setEventBossCountdown === 'function') setEventBossCountdown(evb && evb.spawnAt || 0);
    // Death battle: same idea — joining mid-registration shows the live
    // countdown and whether this account is already signed up.
    if (dbs) {
      _dbState = { phase: dbs.phase, startAt: dbs.startAt, nextAt: dbs.nextAt, count: dbs.count };
      _dbRegistered = !!dbs.registered;
      if (typeof onDeathBattleState === 'function') onDeathBattleState();
    }
    // Кровавая Башня: same idea — joining before/during the 20:30 MSK,
    // 5-minute window shows the live phase and countdown instead of "not
    // known yet".
    if (r10s) {
      _race10State = {
        queued: r10s.queued || 0, needed: r10s.needed || 10, live: !!r10s.live,
        minLevel: r10s.minLevel || 10, reward: r10s.reward || 50,
        maxAttempts: r10s.maxAttempts || 3, attemptsLeft: null,
        phase: r10s.phase || 'idle', nextAt: r10s.nextAt || 0, startAt: r10s.startAt || 0,
      };
      _race10Registered = !!r10s.registered;
      if (typeof onRace10State === 'function') onRace10State();
    }
    // 3v3 arena: same idea — joining before/during the 21:00–22:00 MSK window
    // shows the live phase and countdown instead of "not known yet".
    if (a3s) {
      _a3State = {
        queued: a3s.queued || 0, needed: a3s.needed || 6, live: !!a3s.live,
        minLevel: a3s.minLevel || 15, reward: a3s.reward || 10,
        maxAttempts: a3s.maxAttempts || 3, attemptsLeft: null,
        phase: a3s.phase || 'idle', nextAt: a3s.nextAt || 0,
      };
      _a3Registered = !!a3s.registered;
      if (typeof onArena3State === 'function') onArena3State();
    }
    // Война гильдий: unlike race10/a3 above there's no queue/registration to
    // restore — just the live phase/countdown and whoever currently owns the
    // tower, sent unconditionally (never gated on a live run for this socket,
    // unlike Fear below) since ownership persists whether or not anyone is
    // even in the zone.
    if (gws) {
      _gwState = { ..._gwState, ...gws };
      _gwPhase = _gwState.phase;
      if (typeof onGuildWarState === 'function') onGuildWarState();
    }
    // Страх: fs is only sent at all when a run is live for this socket (see
    // the server-side comment) — the common case is a reconnect that landed
    // back in a held hall (fearGrace), where the run and its monsters
    // resumed server-side but this client's own wave HUD/"in run" flag never
    // got told. The else branch matters just as much: netConnect's 'connect'
    // handler re-sends the login (and so re-runs this whole function) on
    // EVERY socket.io reconnect, not just a hard page refresh — a mobile
    // network drop mid-run is exactly as common. If the reconnect's grace
    // window had already lapsed (or the reclaim otherwise failed), the
    // server correctly sends no fear field at all — meaning this player is
    // NOT in a run any more, in the hub, with none of that lane's monsters —
    // but _fearInRun is ordinary page-level JS state that survives a mere
    // socket reconnect untouched. Left alone, it would still read "in run"
    // from before the drop: the wave HUD and Events panel keep showing a
    // fight that's already over server-side, with no monsters left to end
    // it, reading exactly like "stuck".
    if (fs && fs.inRun) {
      _fearInRun = true;
      _fearWave = fs.wave || 0;
      if (fs.maxWave) _fearState = { ..._fearState, maxWave: fs.maxWave };
      if (typeof onFearState === 'function') onFearState();
    } else if (_fearInRun) {
      _fearInRun = false;
      _fearWave = 0;
      if (typeof onFearState === 'function') onFearState();
    }
    // Preload only the corridors this character can actually be in: arm 1,
    // which everyone passes through, plus whichever arm their level puts them
    // in. All four used to be fetched here — 104 sprite sheets, 2.1 MB, on
    // every cold start, most of it for zones a new player cannot reach for
    // hours. Whatever is skipped still loads the moment an enemy from it is
    // first drawn (see _updateOneEnemy in js/pixi-world.js), so this changes
    // only WHEN the bytes are spent, not whether the sprites appear.
    if (typeof FLOOR_ENEMIES !== 'undefined') {
      const _lvl = (typeof player !== 'undefined' && player && player.lvl) || 1;
      const _arm = typeof armIndexForLevel === 'function' ? armIndexForLevel(_lvl) : 1;
      new Set([1, _arm]).forEach(i => {
        const fe = FLOOR_ENEMIES[i];
        if (fe) (fe.species || []).flatMap(sp => [sp + '_guard', sp + '_warrior']).concat([fe.boss]).filter(Boolean).forEach(eid => loadEnemySprites(eid));
      });
    }
    // The event boss is one more sheet set that almost never gets used: it is
    // only on the map during an event, and the announce gives five minutes'
    // warning — far more than the sheets need to arrive.
    if (evb && (evb.alive || evb.spawnAt)) loadEnemySprites('demon_event_boss');
    // The tower persists forever (see server/game/Room.js's spawnGuildWarTower
    // comment), so unlike the event boss's sheets there's no "only during an
    // event" window to gate this behind — load it every session.
    loadEnemySprites('guildwar_castle');
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
      // suspended mid-session, brief network drop — routine on mobile)
      // leaves the chat button and its last-message preview permanently
      // hidden, reading as if the whole client had reset.
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
    if (_pendingFloorChange) {
      // A real floor transition (netEnterLocation) — this player's stats/
      // inventory/etc are already loaded and live; only reposition them onto
      // the new floor's spawn, same as the first-login branch below does,
      // but skip restoreFromSave (there is nothing new to restore, and
      // running it would stomp live progress with the account's DB blob —
      // same reasoning as the reconnect branch above).
      _pendingFloorChange = false;
      if (player) {
        const sp = srvSpawn || d.spawn;
        player.x = sp.x; player.y = sp.y;
        camera.x = player.x - W / (2 * ZOOM); camera.y = player.y - _visH() / 2;
        clampCamera();
      }
      csOnServerReady();
      return;
    }
    if (player) {
      // srvSpawn is this socket's actual server-side position — the reclaimed
      // Fear hall when a run was restored (see the matching comment on the
      // server's gameStart emit), the map's ordinary spawn otherwise. Falling
      // back to the map's static d.spawn only covers an old/cached payload
      // that never carried the field; the normal case always has it.
      const sp = srvSpawn || d.spawn;
      player.x = sp.x; player.y = sp.y;
      camera.x = player.x - W / (2 * ZOOM); camera.y = player.y - _visH() / 2;
      clampCamera();
    }
    // See matching comment in selectChar() (game.js) — one savedData blob per
    // account, not per-type, so don't gate restoration on a .type match.
    const restore = _savedData || null;
    if (restore) { restoreFromSave(restore); _savedData = null; }
    // Did the data we just restored actually carry progress? Recorded before
    // anything can save, so _emitSaveProgress can tell "this character really
    // is empty" from "this session never managed to load the character".
    if (restore && !_looksBlankSave(restore)) _sessionHasRealData = true;
    // Either real data just got restored above, or there genuinely was none
    // (brand-new account) — either way the fresh-login decision has now been
    // made for real, so any authOk from here on is a genuine reconnect. See
    // _playerRestored's declaration for the race this closes.
    _playerRestored = true;
    csOnServerReady();
  }

  // Enemies we've been told about but have no record of. Batched into one
  // request per _ENEMY_RESYNC_MS so a burst (e.g. a whole corridor coming
  // into view at once) is a single round trip, and each id is asked for once
  // per window so a reply that is still in flight isn't re-requested every
  // tick. Bounded to what the server will answer at once.
  const _ENEMY_RESYNC_MS = 500;
  const _ENEMY_RESYNC_MAX = 40;
  const _enemyResyncQueue = new Set();
  let _enemyResyncTimer = null;

  function _queueEnemyResync(id) {
    if (id === undefined || _enemyResyncQueue.has(id)) return;
    if (_enemyResyncQueue.size >= _ENEMY_RESYNC_MAX) return;
    _enemyResyncQueue.add(id);
    if (_enemyResyncTimer) return;
    _enemyResyncTimer = setTimeout(() => {
      _enemyResyncTimer = null;
      const ids = [..._enemyResyncQueue];
      _enemyResyncQueue.clear();
      if (ids.length && socket?.connected) socket.emit('enemyResync', { ids });
    }, _ENEMY_RESYNC_MS);
  }

  socket.on('gameState', (data) => {
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
            animFrame: 0, animTimer: 0, moving: !!p.moving });
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
          // Authoritative — straight from the sender's own input state (see
          // netSendMove). No hold/debounce needed: unlike a value re-derived
          // from position deltas every frame, this only changes when a new
          // packet actually says so, so a dropped or late packet just leaves
          // the last known value in place instead of flickering it.
          op.moving = !!p.moving;
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

      // Кровавая Башня lane hints (shared/netcodec.js's own trailing
      // section, not part of the player entry itself — see its format note).
      // Only present for a racer whose entry this packet was full, same
      // "keep the last known value otherwise" rule slim updates already
      // follow for clanName/pvpMode/etc — see _raceUnselectable, js/input.js.
      if (_st.raceLaneById && _st.raceLaneById.size) {
        _st.raceLaneById.forEach((lane, id) => {
          const op = otherPlayers.get(id);
          if (op) op.raceLane = lane;
        });
      }

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

    // Enemies outside ENEMY_AOI_R aren't streamed at all any more, so the ones
    // we already hold out there would otherwise sit frozen forever as ghosts —
    // drawn on the minimap, and worse, offered up by tap/cycle targeting at
    // positions they left long ago. Dropping them on distance needs no extra
    // traffic and matches exactly what the server stopped sending (the margin
    // covers a player walking outward between sweeps). Bosses are exempt on
    // both sides: they're streamed from anywhere, and the boss HP bar and the
    // map's skull markers look them up by id.
    if (player && (++_aoiPruneTick % 40) === 0) {
      const cull = ENEMY_AOI_R + 600, cull2 = cull * cull;
      for (let i = serverEnemies.length - 1; i >= 0; i--) {
        const e = serverEnemies[i];
        if (e.isBoss) continue;
        const dx = e.x - player.x, dy = e.y - player.y;
        if (dx * dx + dy * dy <= cull2) continue;
        serverEnemies.splice(i, 1);
        serverEnemiesMap.delete(e.id);
        if (typeof pixiRemoveEnemy === 'function') pixiRemoveEnemy(e.id);
      }
    }

    // Delta update: only changed enemies arrive — add or update, never remove
    // (removal happens via enemyKilled, by the distance prune above, or when
    // the server stops including them; respawn via re-add when hp > 0)
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
          // "The server is actually walking this one right now." The local
          // chase prediction in js/game.js is gated on this, so it can only
          // ever smooth out movement the server is already doing — never
          // invent movement of its own. See the comment there for why.
          ex._srvMoving = 0.4;
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
        // Slim entry for an enemy we have no record of. The server no longer
        // re-broadcasts the whole world on a timer (that was ~97% of this
        // client's download), so ask for this one specifically instead of
        // waiting for a sweep that isn't coming.
        if (se.eid === undefined) { _queueEnemyResync(se.id); return; }
        const newE = { ...se, targetX: se.x, targetY: se.y, _st: t };
        serverEnemies.push(newE);
        serverEnemiesMap.set(se.id, newE);
      }
    });
    // Other players' projectiles and AOE rings, carried by the same packet
    // (see shared/netcodec.js). The decoder has already advanced each one by
    // however long it waited for this cast, so they start where they should be
    // rather than at the muzzle.
    const _sp = _st.projs;
    if (_sp && _sp.length) for (let i = 0; i < _sp.length; i++) otherProjs.push(_sp[i]);
    const _sa = _st.aoes;
    if (_sa && _sa.length) for (let i = 0; i < _sa.length; i++) {
      const sa = _sa[i];
      spawnAOE(sa.x, sa.y, sa.r || 80, sa.style, sa.color, sa.color2);
    }

    _profSocketEvts++;
    _profSocketMs += performance.now() - _gs0;
  });

  socket.on('mapBlips', (buf) => {
    _mapBlips = new Int16Array(buf);
    // Arrives once a second while the panel is open — redraw so the dots
    // actually move instead of freezing at whatever was there on open.
    if (activeTab === 2 && typeof drawMapPanel === 'function') drawMapPanel();
  });

  socket.on('playerHurt', ({ id, hp, dmg }) => {
    if (player && id === socket.id) {
      // No safe-zone check here on purpose. The server decides who can be
      // hit and has ALREADY applied this damage to its own copy of our hp
      // (see the enemy attack in Room.js's tick loop); regular monsters skip
      // safe-zone players there every tick, and the world boss is
      // deliberately exempt so it can be fought in the hub. Dropping the
      // packet because we believe we're standing somewhere safe therefore
      // can't prevent the damage — it only desyncs us, and once the server's
      // copy hits 0 it stops accepting our movement and hp entirely, so
      // everyone else sees a frozen corpse while we walk around.
      //
      // Damage itself still applies to our own hp rather than to whatever
      // the server reports, so a heal it hasn't caught up on yet (level-up,
      // a self-heal skill — syncPlayerHp rate-limits increases) isn't undone
      // by one hit. Its verdict on DEATH is final though: the server won't
      // take our hp or position back once it has us at 0, so ignoring that
      // is what strands us as the frozen corpse above.
      player.hp = (hp != null && hp <= 0) ? 0
                : (dmg != null) ? Math.max(0, player.hp - dmg) : hp;
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
    if (typeof recompute === 'function') recompute();
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

  // Floating-text feedback only — the server has already rolled AND granted
  // every one of these (mob loot table, and on a boss kill the box/enchant-
  // stone drops below) via socket.data._grantKillLoot before this event was
  // even sent; inventorySync (the plain socket.on above) landed first on
  // this same socket and already applied them to player.inventory.
  function _showStoneLoot(stoneId, qty, px, py) {
    const label = typeof t === 'function' ? (stoneId === 'bless_stone' ? t('safeStoneLbl') : t('enchantStoneLbl')) : (stoneId === 'bless_stone' ? 'Безоп. камень' : 'Камень заточки');
    dmgNum(px, py - 52, `+${qty}× ${label}`, stoneId === 'bless_stone' ? '#88f' : '#fa8');
  }

  function _showBoxLoot(boxId, qty, px, py) {
    const def = BOX_DEF.find(b => b.id === boxId);
    if (!def) return;
    dmgNum(px, py - 52, `+${qty}× ${def.name}`, boxId === 'box_rare' ? '#5dade2' : '#98e456');
  }

  socket.on('enemyKilled', ({ id, xp, gold, goldTotal, level, dmg, isCrit, ex, ey, color, items, eid, rlvl, boxUncommon, boxRare, normStone, blessStone, nexum, gram }) => {
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
    // `xp` is what this kill actually paid THIS player — clan bonus, potion and
    // death penalty already applied server-side — and `level` is the state it
    // produced. The client used to apply those multipliers and run the level
    // curve itself, which is why the server had to audit the result.
    if (xp && player) player.kills++;
    if (player && level) applyLevelState(level);
    if (eid && player && typeof onEnemyKill === 'function') {
      const _eDef = ENEMY_DEF.find(e => e.eid === eid);
      if (_eDef) onEnemyKill(_eDef.name);
    }
    if (rlvl && player && typeof onEnterArm === 'function') onEnterArm(rlvl);
    if (items && items.length && player) {
      items.forEach(it => {
        const label = (it.qty && it.qty > 1 ? `+${it.qty}× ` : '+ ') + it.name;
        dmgNum(px, py - 70, label, RARITY_COLOR[it.rarity] || '#c4a276');
      });
      if (typeof Sound !== 'undefined' && _seen) Sound.loot();
    }
    if (boxUncommon) _showBoxLoot('box_uncommon', boxUncommon, px, py);
    if (boxRare)     _showBoxLoot('box_rare',      boxRare,     px, py - 16);
    if (normStone)  _showStoneLoot('norm_stone',  normStone,  px, py - 32);
    if (blessStone) _showStoneLoot('bless_stone', blessStone, px, py - 48);
    // `gold` is what this kill actually paid THIS player, clan bonus and potion
    // already applied server-side; goldTotal is the balance it produced. The
    // client used to apply those multipliers itself and add the result to its
    // own total, which is exactly why the server could not know what anyone's
    // balance should be.
    if (gold && player) dmgNum(px, py - 36, '+' + gold + 'g', '#ff0');
    if (player && Number.isFinite(goldTotal)) player.gold = goldTotal;
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

  // Enemies that left the room without dying on screen — currently only
  // Room.js's fearReleaseLane, for whatever a Fear wave hadn't killed yet
  // when the run ended (death cut it short). No animation/rewards, just a
  // silent drop — otherwise these would sit as unremovable ghosts (still
  // selectable/targetable) until the client's own distance prune caught up.
  socket.on('enemiesRemoved', ({ ids } = {}) => {
    if (!Array.isArray(ids) || !ids.length) return;
    const idSet = new Set(ids);
    idSet.forEach(id => {
      if (id === targetId && !targetIsPlayer) { targetId = null; targetIsPlayer = false; _chaseArmed = false; }
      serverEnemiesMap.delete(id);
      if (typeof pixiRemoveEnemy === 'function') pixiRemoveEnemy(id);
    });
    let j = 0;
    for (let i = 0; i < serverEnemies.length; i++) {
      if (!idSet.has(serverEnemies[i].id)) serverEnemies[j++] = serverEnemies[i];
    }
    serverEnemies.length = j;
  });

  // Rating leader changed — whoever this is now wears the aura (pixi-world.js).
  // Sent to everyone, so the glow moves the moment the top spot does.
  socket.on('topPlayer', ({ username } = {}) => {
    window._topPlayer = username || null;
  });

  socket.on('vipAuras', ({ usernames } = {}) => {
    window._vipAuraUsers = new Set(usernames || []);
  });

  // One boss per corridor — bossStatus is a map keyed by arm name
  // ({ left: {alive,...}, top: {...}, ... }). This push updates just the
  // arm that changed; 'gameStart' below sets the initial full map.
  socket.on('bossStatus', ({ arm, alive, respawnAt }) => {
    if (!bossStatus) bossStatus = {};
    if (arm) bossStatus[arm] = { alive, respawnAt };
  });

  // spawnProj/spawnAoe as their own events are gone — other players' arrows
  // and rings now arrive inside the world cast (see the gameState handler and
  // the format note in shared/netcodec.js). Kept as a receiver only for the
  // window right after a deploy, when a client that has not reloaded may still
  // be talking to a server that emits them.
  socket.on('spawnProj', data => { otherProjs.push({ ...data }); });
  socket.on('spawnAoe', ({ x, y, r }) => { spawnAOE(x, y, r || 80); });

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

  // partyDecline (server/index.js) used to be a pure no-op — the inviter
  // never found out their invite was refused, and just had no way to tell
  // that apart from "still pending" or "their client silently ate it".
  socket.on('partyInviteDeclined', ({ byName }) => {
    if (player) dmgNum(player.x, player.y - 30, typeof tVars === 'function' ? tVars('partyDeclinedToast', { name: byName || '?' }) : (byName || '?') + ' отклонил(а) приглашение', '#fa0');
  });

  // Answer to the Инфо button next to Пати+ (getPartyInfoBtnPos, js/input.js
  // / drawPartyButton, js/ui.js) — the server computes this straight from
  // its own record of the target (Room.publicProfile), so unlike an earlier
  // version this never depends on the target's own client being around to
  // answer. profile is only ever null if they disconnected in the instant
  // between being targeted and the tap landing — too rare and too late to
  // usefully react to, so there's nothing to show for it.
  socket.on('playerProfileResult', ({ fromName, profile }) => {
    if (profile && typeof showPeerProfileModal === 'function') showPeerProfileModal(fromName, profile);
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
    _setChannelHistory('global', _chatMsgs, _GLOBAL_CHAT_CAP, msgs);
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

  // "Translate" button on a chat bubble — reqId (set in _chatTranslateRow,
  // js/network.js below) maps the reply back to the row that asked for it,
  // since several translate clicks can be in flight across different rows.
  socket.on('translateChatResult', ({ reqId, text, error }) => _onChatTranslateResult(reqId, text, error));

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

  // ── Хранилище клана ───────────────────────────────────────
  // Pushed to every online member on any change, so a leader handing shards
  // out and a member depositing see each other's effect without reopening.
  socket.on('clanStorage', data => {
    _clanStorage = data || null;
    if (typeof onClanStorage === 'function') onClanStorage();
  });
  socket.on('clanStorageError', ({ msg } = {}) => {
    if (typeof _marketToast === 'function') _marketToast(msg || t('genericErrorLbl'), 'err');
  });
  socket.on('clanStorageOk', ({ msg } = {}) => {
    if (typeof _marketToast === 'function' && msg) _marketToast(msg, 'ok');
  });
  // The unlock was charged server-side. newGold is an absolute, not a delta.
  //
  // The flush is immediate (netSaveProgressNow), not the usual debounced one,
  // and it runs before any UI call so nothing can throw ahead of it. Both
  // matter: a debounced save leaves up to two seconds in which a save composed
  // BEFORE the purchase can land and hand the gold back, and the same call is
  // what rewrites this device's localStorage backup — which the next load
  // compares against the server copy by savedAt, and would otherwise restore
  // at the pre-purchase figure.
  socket.on('clanStorageUnlocked', ({ newGold, cost } = {}) => {
    if (typeof _marketToast === 'function') _marketToast(t('clanStorageUnlockedToast'), 'ok');
  });

  // The server changed this account's gold on its own authority (a spend it
  // charged, or a correction to a save that predated one). Absolute, not a
  // delta. Flushed immediately rather than on the usual 2s debounce so the
  // figure reaches both the server and this device's localStorage backup
  // before anything else can save the old one over it.
  socket.on('goldSync', ({ gold } = {}) => {
    if (!player || !Number.isFinite(gold)) return;
    if (player.gold === gold) return;
    player.gold = gold;
    // The merchant panel prints the balance and gates its buttons on it.
    if (typeof refreshNpcPanel === 'function') refreshNpcPanel();
    if (typeof netSaveProgressNow === 'function') netSaveProgressNow();
    if (typeof updateInvUI === 'function') updateInvUI();
    if (typeof updateClanUI === 'function') updateClanUI();
  });
  // The server capped a level/XP claim to what it has actually granted this
  // session (see _allowXp, server/index.js). Without applying it the client
  // keeps the rejected figures and resends them in every later save, so each
  // one trips the same check and the correction never converges.
  // recompute() is what turns the corrected level into the stats this side
  // uses — baseAtk/baseDef/baseMaxHp all track it.
  // The authoritative level state. Sent on join and whenever the server has
  // corrected or recomputed it. The base stats travel with the level rather
  // than being re-derived here: the server owns the curve now, and two places
  // computing the same three numbers is how they come to disagree.
  socket.on('xpSync', (st = {}) => {
    if (!player || !Number.isFinite(st.lvl)) return;
    applyLevelState(st);
    if (player.hp > player.maxHp) player.hp = player.maxHp;
    if (typeof updateProfileUI === 'function') updateProfileUI();
  });
  // The shards are already in the inventory via the inventorySync that
  // preceded this; this only reports what arrived.
  socket.on('clanStorageClaimed', ({ items } = {}) => {
    const n = (items || []).reduce((s, i) => s + (i.qty || 0), 0);
    if (typeof _marketToast === 'function') _marketToast(tVars('clanStorageClaimedToast', { n }), 'ok');
    if (typeof updateInvUI === 'function') updateInvUI();
  });
  socket.on('clanApplySent', ({ clanId }) => {
    if (typeof onClanApplySent === 'function') onClanApplySent(clanId);
  });

  socket.on('specialQuestDone', ({ questId, reward, alreadyDone }) => {
    if (typeof onSpecialQuestDone === 'function') onSpecialQuestDone(questId, reward, alreadyDone);
  });

  socket.on('specialQuestError', ({ questId, reason }) => {
    // Re-enable the quest button so the player can retry
    if (typeof _specialQuestUnlock === 'function') _specialQuestUnlock(questId);
  });

  socket.on('adminGive', ({ gold, nexum, gram, newGold, newBonusSP }) => {
    if (!player) return;
    // Gold/nexum/gram all arrive as a total via their own sync events
    // (goldSync/gramBalanceUpdate/etc.), which already refresh their own
    // displays — this only shows the toast. The mass "give to all" admin
    // route (server/index.js's /admin/give-all) is the one caller that also
    // carries newGold/newBonusSP directly, since a bulk grant has no
    // per-account goldSync round trip to ride along on.
    let _changed = false;
    if (Number.isFinite(newGold) && player.gold !== newGold) { player.gold = newGold; _changed = true; }
    if (Number.isFinite(newBonusSP) && player.bonusSP !== newBonusSP) { player.bonusSP = newBonusSP; _changed = true; }
    if (_changed) {
      // Same refresh set goldSync uses just above; the skill-point screen
      // isn't among them because it (like goldSync's own bonusSP-adjacent
      // rebirthDone handler) reads player.bonusSP fresh whenever it's opened
      // rather than needing a push.
      if (typeof refreshNpcPanel === 'function') refreshNpcPanel();
      if (typeof netSaveProgressNow === 'function') netSaveProgressNow();
      if (typeof updateInvUI === 'function') updateInvUI();
      if (typeof updateClanUI === 'function') updateClanUI();
    }
    if (typeof dmgNum === 'function' && player) dmgNum(player.x, player.y - 40, typeof t === 'function' ? t('adminGiftToast') : '🎁 Подарок от админа!', '#fd0');
  });

  // The authoritative item set. Every change to it happens server-side —
  // loot, sale, craft, enhance, box, market, VIP, admin, and equip/unequip/
  // storage moves too — and this is how the change reaches the screen. The
  // client no longer holds an item set of its own to reconcile against; it
  // renders this one.
  socket.on('inventorySync', ({ inventory, equipment, storage } = {}) => {
    if (!player) return;
    if (Array.isArray(inventory) && typeof _migrateInventory === 'function') {
      player.inventory = _migrateInventory(inventory);
    }
    // Only present when the server rolled an inventory <-> storage move back
    // (the stale-rev and forged-census branches of saveProgress). Applying
    // just the inventory half of that rollback is what left the local copy
    // holding the item in BOTH places — which the next save then reported as
    // a duplicate and got the whole item set rejected for. An ordinary grant
    // omits the field entirely, and this is a no-op for it.
    if (Array.isArray(storage) && typeof _migrateInventory === 'function') {
      player.storage = _migrateInventory(storage);
    }
    if (equipment && typeof equipment === 'object' && typeof _rebuildFromCatalog === 'function') {
      // Same blank-template merge restoreFromSave uses — every slot key has to
      // exist (equipItem/recompute index into them by name), and only the
      // filled ones come from the payload.
      const blank = { weapon:null, helmet:null, body:null, gloves:null, boots:null, ring:null, belt:null, pet:null, cloak:null, artifact:null };
      const rebuilt = {};
      Object.keys(equipment).forEach(sl => { if (equipment[sl]) rebuilt[sl] = _rebuildFromCatalog(equipment[sl]); });
      player.equipment = { ...blank, ...rebuilt };
    }
    if (typeof recompute === 'function') recompute();
    if (typeof updateInvUI === 'function') updateInvUI();
    // The storage NPC panel indexes straight into the arrays just replaced —
    // see refreshStorageNpc (js/npc.js). No-op when it isn't open.
    if (typeof refreshStorageNpc === 'function') refreshStorageNpc();
  });

  // Merchant sale confirmed — the item is already gone via the
  // inventorySync that precedes this; only the balance is left to apply,
  // and it comes as the server's authoritative total rather than a delta.
  socket.on('itemSold', ({ gold, newGold } = {}) => {
    if (!player) return;
    if (Number.isFinite(newGold)) player.gold = newGold;
    if (gold && typeof dmgNum === 'function') {
      dmgNum(player.x, player.y - 36, '+' + gold + 'g', '#ff0');
    }
    if (typeof updateInvUI === 'function') updateInvUI();
  });

  socket.on('sellItemError', ({ msg } = {}) => {
    if (typeof _marketToast === 'function') _marketToast(msg || t('genericErrorLbl'), 'err');
  });

  // Story quest reward — items already arrived via inventorySync, this
  // carries the gold/xp/questIdx the server actually recorded.
  socket.on('questClaimed', (data) => {
    if (typeof onQuestClaimed === 'function') onQuestClaimed(data || {});
    netSaveProgress();
  });

  socket.on('questClaimError', ({ msg } = {}) => {
    if (typeof onQuestClaimError === 'function') onQuestClaimError(msg);
  });

  // The server's authoritative quest counter, pushed whenever it sees ours
  // has drifted — see onQuestSync (js/quests.js).
  socket.on('questSync', (data) => {
    if (typeof onQuestSync === 'function') onQuestSync(data || {});
  });

  // The server refused a move as impossibly fast and is telling us where it
  // still has us (see _checkMoveBudget, server/game/Room.js). Only ever sent
  // in enforce mode. Applied rather than argued with: the server's copy is
  // what every other player, every monster and every hit test already uses, so
  // a client that ignores this is playing somewhere nobody else can see.
  socket.on('posCorrect', ({ x, y } = {}) => {
    if (!player || !Number.isFinite(x) || !Number.isFinite(y)) return;
    player.x = x; player.y = y;
    // The camera follows the player every frame anyway, but snapping it here
    // too keeps the correction from being rendered as one frame of the world
    // sliding — and clampCamera is what stops it leaving the map bounds.
    if (typeof camera !== 'undefined' && camera) {
      camera.x = player.x - W / (2 * ZOOM);
      camera.y = player.y - _visH() / 2;
      if (typeof clampCamera === 'function') clampCamera();
    }
    // The next netSendMove compares against the last position we told the
    // server; leaving that stale would make it skip the packet that confirms
    // we accepted the correction.
    _lastSentX = null;
  });

  // The server refused this save because a server-side item op was holding
  // the inventory when it arrived (_itemOpBusy, server/index.js). Nothing is
  // wrong with the blob — it just has to come again once that op finishes.
  // netSaveProgress rebuilds it from the live player and rate-limits itself to
  // one emit per 2s, so this is a re-arm rather than a resend, and a session
  // where the op somehow never clears settles into ordinary autosave traffic
  // instead of quietly persisting nothing at all.
  socket.on('saveDeferred', () => {
    if (typeof netSaveProgress === 'function') setTimeout(netSaveProgress, 1200);
  });

  // The authoritative studied levels. The client no longer writes these at all
  // — studySkill/upgradePassive/... are requests (js/ui.js) and this is the
  // answer — so it is applied verbatim rather than merged: there is no newer
  // local version left to protect, and merging would make a legitimate
  // correction (an admin edit, a rolled-back forgery) impossible to deliver.
  socket.on('progressSync', (data) => {
    if (!player || !data || typeof data !== 'object') return;
    if (data.upgrades)        player.upgrades        = { ...data.upgrades };
    if (data.skillLevels)     player.skillLevels     = { Q:0, W:0, E:0, R:0, ...data.skillLevels };
    if (data.passiveLevels)   player.passiveLevels   = { ...data.passiveLevels };
    if (data.advSkillLearned) player.advSkillLearned = { Q:false, W:false, E:false, R:false, ...data.advSkillLearned };
    if (data.advSkillActive)  player.advSkillActive  = { Q:false, W:false, E:false, R:false, ...data.advSkillActive };
    // passiveLevels feed the stat bonuses (passiveBonusTotal,
    // shared/definitions.js), so a new level has to reach the live stats and
    // not just the panel.
    if (typeof recompute === 'function') recompute();
    if (typeof updateSkillsUI === 'function') updateSkillsUI();
    if (typeof updatePassiveSkillsUI === 'function') updatePassiveSkillsUI();
    if (typeof _refreshProfessionPanelIfOpen === 'function') _refreshProfessionPanelIfOpen();
    if (typeof updateInvUI === 'function') updateInvUI();
    if (typeof updateUpgradeUI === 'function') updateUpgradeUI();
    if (typeof updateProfileUI === 'function') updateProfileUI();
  });

  // The outcome of one upgrade attempt. The level itself arrives in the
  // progressSync above; this is only what the player sees happen.
  socket.on('upgradeRolled', ({ kind, ok, level } = {}) => {
    if (!player) return;
    if (ok) {
      if (typeof spawnBurst === 'function') spawnBurst(player.x, player.y, '#e69419', 10);
      const msg = kind === 'passive'
        ? tVars('passiveLevelUpToast', { n: level })
        : tVars('skillLevelUpToast', { n: level });
      dmgNum(player.x, player.y - 42, msg, '#e69419');
    } else {
      dmgNum(player.x, player.y - 36, t('failToast'), '#eb4e61');
    }
  });

  // A learn/upgrade request the server refused — wrong class, not studied yet,
  // books gone between the click and the packet. The client's own pre-checks
  // catch these first in normal play, so this is the case where the two copies
  // had drifted; showing it beats a button that silently does nothing.
  // A move the server refused — a full container, a class-locked item, or an
  // index that no longer points at what the client thought it did.
  // The server refused a gold spend — not enough, or the potion bag is full.
  socket.on('goldError', ({ msg } = {}) => {
    if (typeof _shopMsg === 'function') _shopMsg(msg || '');
    else if (player && msg) dmgNum(player.x, player.y - 30, msg, '#f17e8b');
  });

  // The authoritative potion bag, after a purchase or a use.
  socket.on('potionBag', ({ potionBag, bought } = {}) => {
    if (!player || !potionBag) return;
    player.potionBag = { ...potionBag };
    // The merchant panel reads the counts and the gold straight off `player`,
    // so it has to be told to redraw — the purchase is a request now and this
    // reply is the only thing that knows it landed.
    if (typeof refreshNpcPanel === 'function') refreshNpcPanel();
    if (typeof onBuyPotion === 'function') onBuyPotion();
    if (typeof updateInvUI === 'function') updateInvUI();
    // The "✓ Куплено" line the shop used to print itself, before the purchase
    // became a request and the confirmation moved to the reply.
    if (bought && typeof _shopMsgOk === 'function') {
      const def = typeof ITEM_DEF !== 'undefined' ? ITEM_DEF.find(d => d.id === bought.id) : null;
      _shopMsgOk((typeof t === 'function' ? t('npcBoughtPrefix') : '✓ Куплено: ') +
        ((def && def.name) || bought.id) + (bought.n > 1 ? ' ×' + bought.n : ''));
    }
  });

  // The authoritative buff timers. The client keeps counting them down for its
  // own HUD; this is what starts one, and what a reconnect resumes from.
  socket.on('buffSync', ({ buffs } = {}) => {
    if (!player || !buffs) return;
    player.buffs = { ...buffs };
    if (typeof recompute === 'function') recompute();
    if (player.hp > player.maxHp) player.hp = player.maxHp;
    if (typeof updateInvUI === 'function') updateInvUI();
    if (typeof spawnBurst === 'function') spawnBurst(player.x, player.y, '#f0c040', 6);
  });

  socket.on('itemError', ({ msg } = {}) => {
    if (!player || !msg) return;
    if (typeof _invMsg === 'function') _invMsg(msg);
    else dmgNum(player.x, player.y - 30, msg, '#f17e8b');
  });

  socket.on('progressError', ({ msg } = {}) => {
    if (!player || !msg) return;
    dmgNum(player.x, player.y - 30, msg, '#f17e8b');
  });

  socket.on('seasonState', (st) => {
    if (!st) return;
    _seasonState = { ..._seasonState, ...st };
    if (typeof onSeasonState === 'function') onSeasonState();
  });

  socket.on('seasonRatingData', (data) => {
    _seasonRating = data || { list: [], me: null };
    if (typeof onSeasonRating === 'function') onSeasonRating();
  });

  // A quest finished: points already added server-side, the next one is here.
  socket.on('seasonQuestDone', ({ points, total, next } = {}) => {
    if (Number.isFinite(total)) _seasonState = { ..._seasonState, points: total };
    if (next) _seasonState = { ..._seasonState, quest: next };
    if (typeof showEventBossBanner === 'function' && points) {
      showEventBossBanner(tVars('seasonQuestDoneMsg', { n: points }), '#50af95');
    }
    if (typeof Sound !== 'undefined') Sound.loot?.();
    if (typeof onSeasonState === 'function') onSeasonState();
  });

  // Items are already gone via the inventorySync that preceded this.
  socket.on('seasonBurned', ({ burned, points, total } = {}) => {
    if (Number.isFinite(total)) _seasonState = { ..._seasonState, points: total };
    if (typeof _marketToast === 'function') {
      _marketToast(tVars('seasonBurnedToast', { n: burned || 0, p: points || 0 }), 'ok');
    }
    if (typeof updateInvUI === 'function') updateInvUI();
    if (typeof onSeasonState === 'function') onSeasonState();
  });

  // A repeatable event task paid out (3v3 / death battle / world boss).
  socket.on('seasonEventDone', ({ points, total } = {}) => {
    if (Number.isFinite(total)) _seasonState = { ..._seasonState, points: total };
    if (typeof showEventBossBanner === 'function' && points) {
      showEventBossBanner(tVars('seasonEventDoneMsg', { n: points }), '#50af95');
    }
    if (typeof onSeasonState === 'function') onSeasonState();
  });

  socket.on('seasonBurnError', ({ msg } = {}) => {
    if (typeof _marketToast === 'function') _marketToast(msg || t('genericErrorLbl'), 'err');
  });

  // Refused band switch (below the level it needs) and anything else the
  // season panel can be told "no" about.
  socket.on('seasonError', ({ msg } = {}) => {
    if (typeof _marketToast === 'function') _marketToast(msg || t('genericErrorLbl'), 'err');
  });

  // An admin moved this account's season points by hand. The session's own
  // copy is authoritative for the panel, so it has to be told rather than left
  // showing a stale figure until the next reconnect.
  socket.on('seasonRefresh', ({ total } = {}) => {
    if (Number.isFinite(total)) _seasonState = { ..._seasonState, points: total };
    if (typeof onSeasonState === 'function') onSeasonState();
  });

  // An invited friend reached the level that pays the referrer. This arrives
  // on the REFERRER's socket, triggered by somebody else's session, so the
  // total comes with it rather than being derived from anything local.
  socket.on('seasonRefBonus', ({ points, friend, total } = {}) => {
    if (Number.isFinite(total)) _seasonState = { ..._seasonState, points: total };
    if (typeof showEventBossBanner === 'function' && points) {
      showEventBossBanner(tVars('seasonRefBonusMsg', { n: points, name: friend || '' }), '#50af95');
    }
    if (typeof Sound !== 'undefined') Sound.loot?.();
    if (typeof onSeasonState === 'function') onSeasonState();
  });

  socket.on('disconnect', () => {
    _authOkReceived = false;
    // A marketList request may be in flight right now (item already spliced
    // out of the local inventory optimistically, see _confirmMarketList in
    // js/ui.js). The only rollback path, marketListError, comes over this
    // same socket, so once it's dead that response is never coming — restore
    // the item locally instead of leaving it stranded forever.
    if (typeof onMarketConnectionLost === 'function') onMarketConnectionLost();
    // NOT socket = null: this is the same Socket.IO client instance that
    // will auto-reconnect (default behavior) and re-fire 'connect' on itself
    // — nulling the module-level reference here left every socket?.emit(...)
    // call across the app silently no-op-ing (or the 'connect' handler's own
    // onReady() throwing on a null socket) forever after, even once the
    // underlying transport successfully reconnected. socket.connected already
    // reads false while down and true again once back, which is exactly what
    // every call site here guards on.
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
// Requests a real floor transition — replaces the old client-only
// _teleportTo trick (js/game.js) for the hub's arm pads, and for the special
// zones being split off the hub the same way (see server/game/floors.js).
// `target` is an arm key ('left'/'top'/'bottom'/'right'), a special-zone key
// ('guildWar', …), or 'hub'. The server answers
// with a fresh 'gameStart' for the new floor, same shape as first login —
// _pendingFloorChange tells _applyGameStart to treat it as a floor change
// (reposition, but don't restoreFromSave/csOnServerReady's login path).
function netEnterLocation(target) {
  if (!socket?.connected) return;
  _pendingFloorChange = true;
  socket.emit('enterLocation', { target });
}

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

// The server answers this synchronously from its own record of the target
// (Room.publicProfile, server/game/Room.js) — see playerProfileResult above.
function netRequestPlayerProfile(targetId) {
  if (socket?.connected) socket.emit('requestPlayerProfile', { targetId });
}

// Tells the server whether the КАРТА panel is on screen, so it only streams
// the world-wide dot list (mapBlips) while someone is actually looking at it.
let _mapViewSent = false;
function netSetMapView(open) {
  if (!socket?.connected || open === _mapViewSent) return;
  _mapViewSent = open;
  socket.emit('mapView', { open });
  if (!open) _mapBlips = null;
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
function netClanSetDescription(description) {
  if (socket?.connected) socket.emit('clanSetDescription', { description });
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
// Pull fresh clan state (XP bar, member list, applications) when the panel is
// opened. The server used to push this on every monster kill to keep it live,
// which cost a clan read and a full packet per kill, server-wide.
function netClanRequest() {
  if (socket?.connected && clanData) socket.emit('clanRequest');
}

// ── Хранилище клана ───────────────────────────────────────────
function netClanStorageSync() {
  if (socket?.connected && clanData) socket.emit('clanStorageSync');
}
function netClanStorageDeposit(id, qty) {
  if (socket?.connected) socket.emit('clanStorageDeposit', { id, qty });
}
function netClanStorageGive(telegramId, id, qty) {
  if (socket?.connected) socket.emit('clanStorageGive', { telegramId, id, qty });
}
function netClanStorageCancel(telegramId, id) {
  if (socket?.connected) socket.emit('clanStorageCancel', { telegramId, id });
}
function netClanStorageClaim() {
  if (socket?.connected) socket.emit('clanStorageClaim');
}
function netClanStorageUnlock() {
  if (socket?.connected) socket.emit('clanStorageUnlock');
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

  // Local dev (dev/local.js): opened in a desktop browser against the local
  // server, so there is no Telegram and no initData. That server — and only
  // that server, it's behind DEV_LOCAL — will sign one for the account named
  // in ?dev=<name>, which then logs in through the same path as above. On any
  // other host the route doesn't exist and this falls through to the splash.
  if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
    fetch('/dev/init-data' + location.search)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(({ initData, user }) => {
        // Stand-in for the SDK object: initData for the login, initDataUnsafe
        // because the per-account localStorage save backup is keyed off the
        // user id (see _tgUserId), so two dev accounts don't share one.
        window.Telegram = { ...window.Telegram, WebApp: { initData, initDataUnsafe: { user } } };
        netConnect(() => socket.emit('loginTelegramWebApp', { initData }));
      })
      .catch(() => _showTelegramOnlySplash());
    return;
  }

  _showTelegramOnlySplash();
}

// The "Доступно только в Telegram" screen shown when the game is opened
// anywhere other than inside the Mini App.
function _showTelegramOnlySplash() {
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
    try { return localStorage.getItem(_lastCharTypeKey()); } catch (_) { return null; }
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


// What the client still owns. Everything else the character used to carry —
// items, equipment, storage, gold, level, XP and the stats derived from it,
// studied skills and passives, stat upgrades, quest progress, buffs, the potion
// bag, bonusSP, rebirths — is applied and persisted server-side as it happens,
// and pinned there on the way in, so sending it would be sending a number
// nobody reads.
//
// What is left is genuinely this side's: which class, where the player is, the
// display preferences, and a couple of counters nothing is entitled to.
function _buildSaveStats() {
  if (!player) return null;
  return {
    type: player.type,
    floor: dungeonLvl || 1,
    hp: player.hp, maxHp: player.maxHp,
    kills: player.kills,
    hudPotion: player.hudPotion || 'pt1',
    autoHpPct: player.autoHpPct != null ? player.autoHpPct : 0,
    autoBuffTypes: player.autoBuffTypes || {},
    lang: (typeof currentLang !== 'undefined' && currentLang) || 'ru',
    savedAt: Date.now(),
  };
}

// No local save backup any more — a hand-edited localStorage blob had no way
// to be told apart from a real one once _pickFreshestSave decided it was
// "newer" and the gameStart restore pushed it straight back to the server as
// the new saveProgress. The server's own anti-forgery checks (item census,
// gold growth cap — see server/index.js) are what actually have to hold the
// line regardless of what a client claims, so this was pure client-side
// upside (recovering the last couple of unsaved seconds on an unclean tab
// close) bought at the cost of trusting arbitrary local storage content.
// Keyed per Telegram user id so a shared device never mixes accounts up.
function _tgUserId() {
  try { return String(window.Telegram?.WebApp?.initDataUnsafe?.user?.id || ''); }
  catch (_) { return ''; }
}
// '_lastCharType' used to be one flat key shared by every Telegram account
// that ever opened the game on a given device/browser. An account with a DB
// record but no savedData.type yet (e.g. they connected once and closed the
// app mid char-select, so isNewAccount is false on their next login and the
// localStorage-remembered-class clear in the authOk handler never fires for
// them) fell through _showCharSelect's fallback and inherited whatever class
// the PREVIOUS account on that device had picked — auto-creating that same
// character without ever showing them the selection screen.
function _lastCharTypeKey() {
  const id = _tgUserId();
  return id ? `_lastCharType_${id}` : '_lastCharType';
}
// Whether a save/restore blob has no real progress behind it. Used to tell
// "this character legitimately has nothing yet" apart from "this session
// failed to load real data" (_sessionHasRealData below) and to stop
// _emitSaveProgress from persisting a blank state over an existing account's
// real one.
// NB: counts only FILLED equipment slots, not keys. The client's live
// player.equipment always carries all EQ_SLOTS keys with null values (see
// makePlayer in js/player.js), so a plain Object.keys().length — which is
// what the server's copy of this check can safely use, since
// _sanitizeSavedStats drops the nulls before it ever sees the object —
// reads EQ_SLOTS.length here even for a brand-new blank character and would
// silently never fire.
function _looksBlankSave(s) {
  if (!s) return true;
  const equipped = Object.values(s.equipment || {}).filter(Boolean).length;
  return (s.lvl || 1) <= 1 && (s.gold || 0) === 0 &&
    (s.inventory || []).length === 0 && equipped === 0;
}

function _emitSaveProgress() {
  if (!player || state !== 'playing') return;
  // Never let a session that hasn't got real data behind it write a blank
  // save. In the normal flow this is unreachable (state only becomes
  // 'playing' after gameStart ran the restore), so it costs nothing — but it
  // is the single choke point every save path in the game funnels through,
  // and blank-save-over-real-progress is exactly the failure that cost a
  // player their character. The DB half is already guarded server-side too
  // (_looksLikeCatastrophicReset in saveProgress/selectChar).
  // _accountIsNew accounts are exempt: their first save legitimately is blank.
  const stats = _buildSaveStats();
  if (!_accountIsNew && !_sessionHasRealData && _looksBlankSave(stats)) {
    console.warn('[save] refusing to persist a blank save for an existing account — no real data loaded this session');
    return;
  }
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
  socket.emit('healParty', { amount: amt });
}
// `key` is the skill slot that was cast (Q/W/E/R). The server derives the
// damage multiplier from it — see skillDamageMult, shared/definitions.js — so
// this no longer sends a number for the server to trust. `multiplier` is still
// computed locally for the client's own prediction (projectile damage,
// floating text) and is deliberately NOT sent: a value on the wire is a value
// somebody edits.
function netSkillAttack(enemyId, multiplier, key) {
  if (!socket?.connected) return;
  socket.emit('skillAttack', { enemyId, key });
}
// ── Learning and upgrading ──────────────────────────────────────────────────
// Requests, not results. The server counts the books, rolls the upgrade chance
// and applies the level; what comes back is progressSync (authoritative maps),
// inventorySync (the books it spent) and upgradeRolled (so the success/failure
// text still plays). See the handlers in server/index.js.
function netLearnSkill(key)      { if (socket?.connected) socket.emit('learnSkill', { key }); }
function netUpgradeSkill(key)    { if (socket?.connected) socket.emit('upgradeSkill', { key }); }
function netLearnPassive(id)     { if (socket?.connected) socket.emit('learnPassive', { id }); }
function netUpgradePassive(id)   { if (socket?.connected) socket.emit('upgradePassive', { id }); }
function netLearnAdvSkill(key)   { if (socket?.connected) socket.emit('learnAdvSkill', { key }); }
function netToggleAdvSkill(key)  { if (socket?.connected) socket.emit('toggleAdvSkill', { key }); }
function netSpendUpgrade(key)    { if (socket?.connected) socket.emit('spendUpgrade', { key }); }

// ── Item placement ──────────────────────────────────────────────────────────
// Moving an item between the inventory, an equipment slot and the storage
// chest is the server's job now; the answer comes back as inventorySync.
function netEquipItem(idx)       { if (socket?.connected) socket.emit('equipItem', { idx }); }
function netUnequipItem(slot)    { if (socket?.connected) socket.emit('unequipItem', { slot }); }
function netStorageDeposit(idx)  { if (socket?.connected) socket.emit('storageDeposit', { idx }); }
function netStorageWithdraw(idx) { if (socket?.connected) socket.emit('storageWithdraw', { idx }); }
// The merchant is the only shop priced in gold, so it is the only purchase
// that had to move here for gold to become server-owned.
function netBuyPotion(idx, qty)  { if (socket?.connected) socket.emit('buyPotion', { idx, qty }); }
function netUseBuffPotion(id)    { if (socket?.connected) socket.emit('useBuffPotion', { id }); }

function netSkillStun(enemyId, duration) {
  if (!socket?.connected || !enemyId) return;
  socket.emit('skillEffect', { enemyId, type: 'stun', duration });
}
function netSkillSlow(enemyIds, duration) {
  if (!socket?.connected || !enemyIds || !enemyIds.length) return;
  socket.emit('skillEffect', { enemyIds, type: 'slow', duration });
}
// "Охота" (advanced deathknight R, js/player.js) — Room.js's applySkillEffect
// clamps duration to 6s server-side same as stun/slow, regardless of what's
// requested here.
function netSkillDefDown(enemyId, duration) {
  if (!socket?.connected || !enemyId) return;
  socket.emit('skillEffect', { enemyId, type: 'defDown', duration });
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
// Keep in sync with CHAT_HISTORY_MAX in server/index.js — the server both
// stores and replays this many global messages, so a smaller cap here would
// silently throw away part of the restored history on arrival.
const _GLOBAL_CHAT_CAP = 50;
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
  row.dataset.origText = text;
  // Own name isn't clickable — replying to yourself makes no sense, so it
  // skips the data-user attribute the delegated click handler below reads.
  const nameAttr = isMe ? '' : ` data-user="${_escAttr(username)}"`;
  row.innerHTML = `<div class="chat-row-hdr">
      <span class="chat-name${isMe ? ' is-me' : ' chat-name-clickable'}"${nameAttr}>${_escHtml(username)}</span>
      <span class="chat-time">${time}</span>
      <button class="chat-translate-btn" onclick="_chatTranslateRow(this)" title="Перевести">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
      </button>
    </div>
    <div class="chat-text">${_escHtml(text)}</div>
    <div class="chat-translation" style="display:none"></div>`;
  el.appendChild(row);
}

// ── Chat translation ("🌐" button on each bubble) ──────────────────────────
// Translates to whichever language is currently selected in the app (i18n.js
// currentLang), via a server-side proxy to Google Translate's free endpoint
// (server has no way to know which channel a row's message came from, nor
// does it need to — same request shape for global/clan/DM).
let _chatTranslateSeq = 0;
const _chatTranslatePending = new Map(); // reqId -> row element

function _chatTranslateRow(btn) {
  const row = btn.closest('.chat-row');
  if (!row) return;
  const box = row.querySelector('.chat-translation');
  if (!box) return;

  // Already fetched once — clicking again just toggles it back into view,
  // no need to hit the network (or the server's rate limit) a second time.
  if (row.dataset.translated) {
    box.style.display = box.style.display === 'none' ? 'block' : 'none';
    return;
  }
  if (row.dataset.translating) return;
  row.dataset.translating = '1';
  box.style.display = 'block';
  box.textContent = '…';

  const reqId = String(++_chatTranslateSeq);
  _chatTranslatePending.set(reqId, row);
  const target = (typeof currentLang !== 'undefined' && currentLang) || 'en';
  socket?.emit('translateChat', { text: row.dataset.origText, target, reqId });
}

function _onChatTranslateResult(reqId, text, error) {
  const row = _chatTranslatePending.get(reqId);
  if (!row) return;
  _chatTranslatePending.delete(reqId);
  delete row.dataset.translating;
  const box = row.querySelector('.chat-translation');
  if (!box) return;
  if (error || typeof text !== 'string') {
    box.textContent = typeof t === 'function' ? t('chatTranslateError') : 'Не удалось перевести';
    return;
  }
  row.dataset.translated = '1';
  box.textContent = text;
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
  _pushChatMsg('global', _chatMsgs, _GLOBAL_CHAT_CAP, username, text, _nowHHMM());
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
  if (typeof showEventsBtn === 'function') showEventsBtn();
  if (typeof showSeasonBtn === 'function') showSeasonBtn();
  state = 'playing';
  setTab(0);
  // Immediately save so a page refresh always finds the character type
  _emitSaveProgress();
  // "What's new" announcement — once per WHATS_NEW_VERSION (js/ui.js), only
  // on a genuine first join like everything else in this function, so a
  // reconnect never re-shows it mid-session.
  try {
    if (typeof openWhatsNewModal === 'function' && localStorage.getItem('whatsNewSeen') !== WHATS_NEW_VERSION) {
      openWhatsNewModal();
    }
  } catch (_) {}
}

// ── Move throttle ─────────────────────────────────────────────
let _lastMoveSend = 0;
let _lastSentX = null, _lastSentY = null, _lastSentFacing = null, _lastSentHp = null, _lastSentMoving = null;
// Has to stay comfortably ABOVE the server's 20Hz cast rate, not equal to it.
//
// This was briefly set to 50ms on the reasoning that the world is broadcast
// every other tick, so a position sent faster could not reach anyone sooner.
// That misses two things. First, netSendMove is called from the frame loop, so
// the threshold is quantised to frame boundaries: at 60fps a 50ms limit
// actually sends every 66.7ms — about 15Hz, BELOW the cast rate. Second, when
// the sender is slower than the caster, some casts have no new position to
// report and repeat the previous one; the receiver's interpolation then has
// nothing to advance towards for that 50ms window, so the other player stands
// still for a frame and jumps on the next — and because the animation key
// flips run->idle->run, their run cycle restarts from frame 0 each time, which
// reads on screen as the character twitching or turning on the spot.
//
// Measured with dev/snapshot-check.js, share of snapshots that repeated the
// previous position while running: 15Hz -> 20.9%, 20Hz -> 1.5%, 30Hz -> 0%.
// At 25ms both 30fps and 60fps devices land on 30Hz.
const _MOVE_SEND_MS = 25;
// Even a perfectly still player re-states their position this often. Two
// reasons: the packet below is volatile (dropped rather than queued on a
// stalled link), so the one that says "I stopped here" can be lost, and the
// server has no other way to notice it is holding a stale position.
const _MOVE_KEEPALIVE_MS = 1000;
function netSendMove() {
  if (!socket?.connected || !player) return;
  const now = Date.now();
  if (now - _lastMoveSend < _MOVE_SEND_MS) return;
  // Authoritative moving state — the same read the local animation itself
  // uses (getSpriteAnimKey, js/sprites.js), not something a receiver has to
  // infer later from position deltas. Deltas are noisy by the time they've
  // gone through the network and the interpolation buffer (a dropped packet,
  // a late one, the render clock sitting _INTERP_MS in the past all zero one
  // out for a frame), which used to flip the run/idle animation key on and
  // off and reset the run cycle — the "twitching" other players stuttered.
  // Sending the true value directly means a stop is exact and immediate for
  // everyone watching, not eventually true once their render catches up.
  const moving = (typeof inputDir === 'function' && inputDir().len > 0.05) || !!player._chasing;
  // Standing still — in a menu, at a vendor, reading chat — used to cost 40
  // packets a second forever, and receiving them was measured at 18.5% of a
  // CPU core with 150 players online. Nothing in them ever differed from the
  // packet before. Send on actual change instead, with a keepalive so a
  // dropped "I stopped" still gets corrected.
  const moved = _lastSentX === null ||
    Math.abs(player.x - _lastSentX) > 0.5 || Math.abs(player.y - _lastSentY) > 0.5 ||
    player.facing !== _lastSentFacing || player.hp !== _lastSentHp || moving !== _lastSentMoving;
  if (!moved && now - _lastMoveSend < _MOVE_KEEPALIVE_MS) return;
  _lastMoveSend = now;
  _lastSentX = player.x; _lastSentY = player.y;
  _lastSentFacing = player.facing; _lastSentHp = player.hp; _lastSentMoving = moving;
  // Volatile: on a link that has stalled (backgrounded WebView, radio asleep,
  // tunnel hiccup) a plain emit queues, and the queue is then delivered as one
  // burst of stale positions — which the server applies in order, so the
  // character visibly re-walks the path they took while frozen. Dropping them
  // is correct here: the next packet is a truthful 50ms away, and the
  // keepalive above guarantees one is coming even if the player never moves.
  // Compact form. The old shape —
  //   42["playerMove",{"x":1380.4321,"y":13380.1234,"facing":"front","hp":200}]
  // — was 73 bytes, 20 times a second, and 83% of everything a player uploads.
  // Almost all of it was packaging: the event name, the field names, a facing
  // spelled out in full, and four decimal places on a coordinate the wire
  // format rounds to a half pixel anyway. As a positional array of integers in
  // half-pixel units it is ~26 bytes and still a single frame — a binary
  // payload would have been smaller but socket.io puts binary in a SECOND
  // frame behind a ~46-byte JSON envelope, which costs more than it saves at
  // this size.
  socket.volatile.emit('mv', [
    Math.round(player.x * 2), Math.round(player.y * 2),
    Math.max(0, NC_FACING.indexOf(player.facing)), Math.round(player.hp),
    moving ? 1 : 0,
  ]);
}

// `id` is what the server actually spends and heals from (it looks the amount
// up in the catalog itself now — see the usePotion handler); `amount` is kept
// only so a server that hasn't been redeployed yet still heals the right
// number. Callers must pass the potion they drank, not just its size.
function netUsePotion(id, amount) {
  if (socket?.connected) socket.emit('usePotion', { id, amount });
}

function netStatsUpdate(atk, def, maxHp, critChance, critPower) {
  if (socket?.connected) socket.emit('statsUpdate', { atk, def, maxHp, critChance, critPower });
}

function netAttack(enemyId) {
  if (!socket?.connected) return;
  if (typeof inSafeZone === 'function' && player && inSafeZone(player.x, player.y)) return;
  if (invisTimer > 0) { invisTimer = 0; socket.emit('playerInvis', { invis: false }); }
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

// Same as netSkillAttack above: the slot travels, the number does not.
function netPvpSkillAttack(targetId, multiplier, key) {
  if (!socket?.connected) return;
  if (typeof inSafeZone === 'function' && player && inSafeZone(player.x, player.y)) return;
  socket.emit('pvpSkillAttack', { targetId, key });
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

function netSpawnAoe(x, y, r, style, color, color2) {
  if (socket?.connected) socket.emit('spawnAoe', { x, y, r, style, color, color2 });
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
function netGramShopBuy(pkgId, petId) {
  if (socket?.connected) socket.emit('gramShopBuy', { pkgId, petId });
}
function netSpecialShopBuy(pkgId, books, petId) {
  if (socket?.connected) socket.emit('specialShopBuy', { pkgId, books, petId });
}
function netGramHistory() {
  if (socket?.connected) socket.emit('gramGetHistory');
}

function netGetReferrals() {
  if (socket?.connected) socket.emit('getReferrals');
}

function netGetPvpHistory() {
  if (socket?.connected) socket.emit('getPvpHistory');
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

function netCraftPet(rarity) {
  if (socket?.connected) socket.emit('craftPet', { rarity });
}

function netCraftStone(matId) {
  if (socket?.connected) socket.emit('craftStone', { matId });
}

function netCraftGear(itemId) {
  if (socket?.connected) socket.emit('craftGear', { itemId });
}

function netEnhanceItem(id, enhance, stoneType, slot) {
  if (socket?.connected) socket.emit('enhanceItem', { id, enhance, stoneType, slot: slot || null });
}

function netCraftBox(boxId) {
  if (socket?.connected) socket.emit('craftBox', { boxId });
}

function netCraftMatUpgrade(from) {
  if (socket?.connected) socket.emit('craftMatUpgrade', { from });
}

function netOpenLootBox(id) {
  if (socket?.connected) socket.emit('openLootBox', { id });
}

function netCraftClassGear(slot, rarity) {
  if (socket?.connected) socket.emit('craftClassGear', { slot, rarity });
}

// Charged in Liberty, so the server does the whole thing and answers with
// 'upgradesReset' — see the handler above.
function netResetUpgrades() {
  if (socket?.connected) socket.emit('resetUpgrades');
}

// Item cost only (REBIRTH_COST, shared/definitions.js) — the server checks
// and removes it, resets level/xp/upgrades and answers with 'rebirthDone'
// (see the handler below).
function netRebirth() {
  if (socket?.connected) socket.emit('rebirth');
}

function netGetRating(tab) {
  if (socket?.connected) socket.emit('getRating', { tab });
}

// "ТЕХ" one-time gift button (getTechGiftBtnPos, js/input.js) — the server
// answers with either techClaimResult or techClaimError (handlers below).
function netTechClaim() {
  if (socket?.connected) socket.emit('techClaim');
}

// ── Event boss + world drops ────────────────────────────────────────────────
// worldDrops is the shared ground-loot pool (id -> {id,x,y,item}); the server
// arbitrates every pickup, so this map is display-only — an entry disappearing
// means someone else got there first.
function _initEventBossHandlers(s) {
  s.on('eventBossAnnounce', ({ spawnAt }) => {
    _evtBossState = { ..._evtBossState, spawnAt: spawnAt || 0 };
    // Fetch its sheets now rather than at gameStart — the countdown is minutes
    // long, so they are always in place before it appears.
    if (typeof loadEnemySprites === 'function') loadEnemySprites('demon_event_boss');
    // No explicit re-render — the Events panel's own 1s ticker picks this up.
    if (typeof setEventBossCountdown === 'function') setEventBossCountdown(spawnAt);
  });
  s.on('eventBossSpawned', ({ x, y } = {}) => {
    _evtBossAlive = true;
    _evtBossState = { ..._evtBossState, spawnAt: 0, alive: true };
    if (typeof setEventBossCountdown === 'function') setEventBossCountdown(0);
    if (typeof showEventBossBanner === 'function') showEventBossBanner(t('evtBossArrived'), '#ff5a4a');
    if (typeof Sound !== 'undefined' && (typeof _isPosVisible !== 'function' || x === undefined || _isPosVisible(x, y))) Sound.bossSpawn();
  });
  s.on('eventBossDefeated', () => {
    _evtBossAlive = false;
    _evtBossState = { ..._evtBossState, alive: false };
    if (typeof showEventBossBanner === 'function') showEventBossBanner(t('evtBossDefeated'), '#90d653');
  });
  s.on('worldDropsSpawned', ({ drops: ds }) => {
    (ds || []).forEach(d => worldDrops.set(d.id, d));
  });
  s.on('worldDropTaken', ({ id }) => { worldDrops.delete(id); _worldDropPending.delete(id); });
  s.on('worldDropsExpired', ({ ids }) => { (ids || []).forEach(id => { worldDrops.delete(id); _worldDropPending.delete(id); }); });
  s.on('worldDropPicked', ({ id, item, delivered }) => {
    worldDrops.delete(id);
    _worldDropPending.delete(id);
    if (!player || !item) return;
    // The server owns the grant and pushes it down via inventorySync, which
    // arrives before this event. delivered:false means it could not hand the
    // pile over at all — adding it here would be forging an item the server
    // refused, which the save path now rejects.
    if (!delivered) {
      if (typeof _marketToast === 'function') _marketToast(t('invFull'), 'err');
      return;
    }
    if (typeof updateInvUI === 'function') updateInvUI();
    if (typeof dmgNum === 'function') dmgNum(player.x, player.y - 40, '+ ' + item.name, (typeof RARITY_COLOR !== 'undefined' && RARITY_COLOR[item.rarity]) || '#c4a276');
    if (typeof Sound !== 'undefined') Sound.loot();
    netSaveProgress();
  });
  s.on('worldDropError', ({ msg }) => {
    if (typeof _marketToast === 'function') _marketToast(msg, 'err');
  });
  _initDeathBattleHandlers(s);
  _initArena3Handlers(s);
  _initRace10Handlers(s);
  _initFearHandlers(s);
  _initGuildWarHandlers(s);
}

// ── Death Battle (Битва на смерть) ──────────────────────────────────────────
// The server owns the whole round (schedule, who is in, who is out, the
// prize); everything here just mirrors that into the UI and moves the local
// camera/player to wherever the server says they now are.
function _initDeathBattleHandlers(s) {
  s.on('deathBattleState', st => {
    _dbState = { phase: st.phase, startAt: st.startAt, nextAt: st.nextAt, count: st.count };
    if (st.registered !== undefined) _dbRegistered = !!st.registered;
    if (st.phase !== 'reg') _dbRegistered = false;
    if (st.phase !== 'live') _dbInFight = false;
    if (typeof onDeathBattleState === 'function') onDeathBattleState();
  });

  s.on('deathBattleRegistered', ({ registered }) => {
    _dbRegistered = !!registered;
    if (typeof onDeathBattleState === 'function') onDeathBattleState();
    if (typeof dmgNum === 'function' && player) {
      dmgNum(player.x, player.y - 40, registered ? t('dbSignedUpToast') : t('dbLeftToast'), registered ? '#8fc95c' : '#f07886');
    }
  });

  s.on('deathBattleError', ({ msg }) => {
    if (typeof _marketToast === 'function') _marketToast(msg, 'err');
  });

  s.on('deathBattleCancelled', () => {
    _dbInFight = false;
    _dbFightAt = 0;
    if (typeof showEventBossBanner === 'function') showEventBossBanner(t('dbCancelledMsg'), '#f0b25a');
  });

  // The round begins: the server has already moved this player into the arena,
  // healed them and switched PvP on server-side — mirror all three locally so
  // the client doesn't fight its own authoritative state.
  s.on('deathBattleStarted', ({ x, y, hp, total, fightAt }) => {
    if (!player) return;
    _dbInFight = true;
    _dbRegistered = false;
    _dbFightAt = fightAt || 0;
    if (hp) player.hp = hp;
    pvpMode = true;
    if (typeof _teleportTo === 'function') _teleportTo(x, y, t('dbArenaLbl'));
    else { player.x = x; player.y = y; }
    if (typeof showEventBossBanner === 'function') showEventBossBanner(tVars('dbStartedFmt', { n: total }), '#e8574f');
    if (typeof Sound !== 'undefined') Sound.bossSpawn();
    if (typeof showDeathBattleFreeze === 'function') showDeathBattleFreeze(_dbFightAt);
    if (typeof onDeathBattleState === 'function') onDeathBattleState();
  });

  // Countdown is over — the server has lifted the freeze for everyone at once.
  s.on('deathBattleFight', () => {
    _dbFightAt = 0;
    if (typeof hideDeathBattleFreeze === 'function') hideDeathBattleFreeze();
    if (typeof showEventBossBanner === 'function') showEventBossBanner(t('dbFightMsg'), '#e8574f');
    if (typeof Sound !== 'undefined') Sound.bossSpawn();
  });

  s.on('deathBattleEliminated', ({ left, x, y }) => {
    _dbInFight = false;
    _dbFightAt = 0;
    if (typeof hideDeathBattleFreeze === 'function') hideDeathBattleFreeze();
    pvpMode = false;
    if (player && x != null && y != null) {
      // Lands back wherever this player actually was before the battle —
      // the server has already moved this connection onto that floor by the
      // time this event arrives (see _dbReturnEntrant, server/index.js), so
      // this is just the visual catch-up, same idea as deathBattleStarted's
      // own _teleportTo above — hence its own label rather than centralHall.
      if (typeof _teleportTo === 'function') _teleportTo(x, y, t('dbReturnPrevLbl'));
      else { player.x = x; player.y = y; }
    }
    if (typeof showEventBossBanner === 'function') showEventBossBanner(tVars('dbEliminatedFmt', { n: left }), '#f07886');
    if (typeof onDeathBattleState === 'function') onDeathBattleState();
  });

  s.on('deathBattleWon', ({ gram, items, delivered }) => {
    _dbInFight = false;
    _dbFightAt = 0;
    if (typeof hideDeathBattleFreeze === 'function') hideDeathBattleFreeze();
    pvpMode = false;
    // The server owns the prize and its inventorySync has already arrived
    // with it. delivered:false means it had no live inventory to put it in —
    // mirroring it locally would be forging items the server never granted,
    // which the save path now rejects.
    if (gram) window._gramBalance = (window._gramBalance || 0) + gram;
    if (typeof updateInvUI === 'function') updateInvUI();
    netSaveProgress();
    if (typeof showDeathBattleWin === 'function') showDeathBattleWin(gram, items || []);
    if (typeof onDeathBattleState === 'function') onDeathBattleState();
  });

  s.on('deathBattleReturned', ({ x, y }) => {
    if (!player) return;
    if (typeof _teleportTo === 'function') _teleportTo(x, y, t('centralHall'));
    else { player.x = x; player.y = y; }
  });

  // Death-battle winner closing the reward modal — own event (not the
  // shared deathBattleReturned above) since this lands the winner back at
  // their own pre-battle spot, not the hub.
  s.on('deathBattleReturnedPrev', ({ x, y }) => {
    if (!player) return;
    if (typeof _teleportTo === 'function') _teleportTo(x, y, t('dbReturnPrevLbl'));
    else { player.x = x; player.y = y; }
  });
}

function netArena3Register()   { if (socket?.connected) socket.emit('arena3Register'); }
function netArena3Unregister() { if (socket?.connected) socket.emit('arena3Unregister'); }
function netArena3Sync()       { if (socket?.connected) socket.emit('arena3Sync'); }
// Sent once the result modal is closed — see closeArena3Result (js/ui.js).
function netArena3Return()     { if (socket?.connected) socket.emit('arena3Return'); }

// ── 3v3 Arena ───────────────────────────────────────────────────────────────
// The match runs inside the normal world room — the arena is a walled-off part
// of the map, so movement, combat and rendering all keep working unchanged.
// These handlers only track which side the player is on and drive the UI.
function _initArena3Handlers(s) {
  s.on('arena3State', (st) => {
    _a3State = {
      queued: st.queued || 0, needed: st.needed || 6, live: !!st.live,
      minLevel: st.minLevel || 15, reward: st.reward || 10,
      maxAttempts: st.maxAttempts || _a3State.maxAttempts || 3,
      // Absent on the frequent queue pushes — keep whatever the last sync
      // told us rather than resetting the counter to "unknown" every time
      // somebody else joins the queue.
      attemptsLeft: st.attemptsLeft !== undefined ? st.attemptsLeft : _a3State.attemptsLeft,
      // 'idle' outside the 21:00–22:00 MSK window, 'reg' while it's open —
      // nextAt is the next window's open time, used for the countdown.
      phase: st.phase || 'idle', nextAt: st.nextAt || 0,
    };
    if (st.registered !== undefined) _a3Registered = !!st.registered;
    if (st.inMatch !== undefined) _a3InMatch = !!st.inMatch;
    if (typeof onArena3State === 'function') onArena3State();
  });

  s.on('arena3Registered', ({ registered, attemptsLeft }) => {
    _a3Registered = !!registered;
    if (attemptsLeft !== undefined) _a3State = { ..._a3State, attemptsLeft };
    if (typeof onArena3State === 'function') onArena3State();
  });

  s.on('arena3Error', ({ msg }) => {
    if (typeof _marketToast === 'function') _marketToast(msg || t('genericErrorLbl'), 'err');
  });

  s.on('arena3Started', ({ x, y, hp, team, fightAt, roundEndAt, roster, bossIds }) => {
    if (!player) return;
    _a3InMatch = true;
    _a3Registered = false;
    _a3Team = team;
    _a3Mates = { A: [], B: [] };
    (roster || []).forEach(r => { if (_a3Mates[r.team]) _a3Mates[r.team].push(r.id); });
    _a3BossIds = bossIds || { A: null, B: null };
    _a3RoundEndAt = 0; // countdown only starts once the freeze ends — see arena3Fight below
    _a3Score = { a: 3, b: 3 };
    if (hp) player.hp = hp;
    pvpMode = true;
    _dbFightAt = fightAt || 0;   // same freeze overlay as the death battle
    if (typeof _teleportTo === 'function') _teleportTo(x, y, t('a3ArenaLbl'));
    else { player.x = x; player.y = y; }
    if (typeof showEventBossBanner === 'function') {
      // Always "Синие" here — this line is always about the RECIPIENT's own
      // side, and a player's own team always renders as blue (see _a3NameColor,
      // js/game.js) regardless of which internal team (A/B) they were dealt.
      showEventBossBanner(tVars('a3StartedFmt', { team: t('a3TeamA') }), '#e8574f');
    }
    if (typeof Sound !== 'undefined') Sound.bossSpawn();
    if (typeof showDeathBattleFreeze === 'function') showDeathBattleFreeze(_dbFightAt);
    // Guard bosses use their own sprite entry (js/sprites.js arena3_guard_boss)
    // rather than piggybacking on the world event boss's — see the eid
    // comment in spawnPvpArenaBosses (server/game/Room.js). Unlike that one,
    // nothing else preloads it, so it has to happen here.
    if (typeof loadEnemySprites === 'function') loadEnemySprites('arena3_guard_boss');
    if (typeof onArena3State === 'function') onArena3State();
  });

  s.on('arena3Fight', ({ roundEndAt } = {}) => {
    _dbFightAt = 0;
    _a3RoundEndAt = roundEndAt || 0;
    if (typeof hideDeathBattleFreeze === 'function') hideDeathBattleFreeze();
    if (typeof showEventBossBanner === 'function') showEventBossBanner(t('dbFightMsg'), '#e8574f');
    if (typeof showArena3Timer === 'function') showArena3Timer(_a3RoundEndAt);
    if (typeof Sound !== 'undefined') Sound.bossSpawn();
  });

  // mine/enemy are already relative to this socket (see the arena3Score emit
  // in server/index.js) — stored as a/b so the existing blue-left/red-right
  // display code (js/ui.js) doesn't need to change.
  s.on('arena3Score', ({ mine, enemy }) => {
    _a3Score = { a: mine || 0, b: enemy || 0 };
    if (typeof onArena3State === 'function') onArena3State();
  });

  // Knocked out: back to the world immediately. The result screen still comes
  // later, when the match itself finishes.
  s.on('arena3Eliminated', ({ x, y }) => {
    _dbFightAt = 0;
    _a3RoundEndAt = 0;
    if (typeof hideDeathBattleFreeze === 'function') hideDeathBattleFreeze();
    if (typeof hideArena3Timer === 'function') hideArena3Timer();
    pvpMode = false;
    if (player && x != null && y != null) {
      if (typeof _teleportTo === 'function') _teleportTo(x, y, t('centralHall'));
      else { player.x = x; player.y = y; }
    }
    if (typeof showEventBossBanner === 'function') showEventBossBanner(t('a3Eliminated'), '#f07886');
    if (typeof onArena3State === 'function') onArena3State();
  });

  s.on('arena3Result', ({ won, wedged, reward }) => {
    _a3InMatch = false;
    _a3Team = null;
    _a3Mates = { A: [], B: [] };
    _a3BossIds = { A: null, B: null };
    _a3RoundEndAt = 0;
    _dbFightAt = 0;
    if (typeof hideDeathBattleFreeze === 'function') hideDeathBattleFreeze();
    if (typeof hideArena3Timer === 'function') hideArena3Timer();
    pvpMode = false;
    // No local balance bump here: the server's _a3GrantWin already sent an
    // authoritative 'nexumBalanceUpdate' for this exact reward just before
    // this event (see server/index.js), so adding `reward` again on top of it
    // double-counted the win — displaying balance+20 for a real +10, which
    // then "corrected" itself back down on the next legitimate sync and
    // looked like Liberty being taken away.
    if (typeof showArena3Result === 'function') showArena3Result(!!won, !!wedged, reward || 0);
    // The attempt was spent when the match started; re-sync so the panel shows
    // the new count instead of the one from before the match.
    if (typeof netArena3Sync === 'function') netArena3Sync();
    if (typeof onArena3State === 'function') onArena3State();
  });

  s.on('nexumBalanceUpdate', ({ balance }) => {
    if (balance == null) return;
    window._nexumBalance = balance;
    if (player) player.nexumBalance = balance;
  });
}

function netRace10Register()   { if (socket?.connected) socket.emit('race10Register'); }
function netRace10Unregister() { if (socket?.connected) socket.emit('race10Unregister'); }
function netRace10Sync()       { if (socket?.connected) socket.emit('race10Sync'); }
// Sent once the result modal is closed — see closeRace10Result (js/ui.js).
function netRace10Return()     { if (socket?.connected) socket.emit('race10Return'); }

// ── 10-Player Corridor Race (Забег) ──────────────────────────────────────────
// Same shape as the 3v3 handlers above, minus the team bookkeeping: everyone
// fights the same shared boss, so all that matters here is this client's own
// lane, its own damage tally, and whether it's still in the race.
function _initRace10Handlers(s) {
  s.on('race10State', (st) => {
    _race10State = {
      queued: st.queued || 0, needed: st.needed || 10, live: !!st.live,
      minLevel: st.minLevel || 10, reward: st.reward || 50,
      maxAttempts: st.maxAttempts || _race10State.maxAttempts || 3,
      attemptsLeft: st.attemptsLeft !== undefined ? st.attemptsLeft : _race10State.attemptsLeft,
      // 'idle' outside the 20:30 MSK, 5-minute window, 'reg' while it's open —
      // nextAt is the next window's open time; startAt is when registration
      // closes and the run itself starts, used for the countdown while
      // phase is 'reg' (see _race10BodyHTML, js/ui.js).
      phase: st.phase || 'idle', nextAt: st.nextAt || 0, startAt: st.startAt || 0,
    };
    if (st.registered !== undefined) _race10Registered = !!st.registered;
    if (st.inMatch !== undefined) _race10InMatch = !!st.inMatch;
    if (typeof onRace10State === 'function') onRace10State();
  });

  s.on('race10Registered', ({ registered, attemptsLeft }) => {
    _race10Registered = !!registered;
    if (attemptsLeft !== undefined) _race10State = { ..._race10State, attemptsLeft };
    if (typeof onRace10State === 'function') onRace10State();
  });

  s.on('race10Error', ({ msg }) => {
    if (typeof _marketToast === 'function') _marketToast(msg || t('genericErrorLbl'), 'err');
  });

  s.on('race10Started', ({ x, y, hp, lane, fightAt }) => {
    if (!player) return;
    _race10InMatch = true;
    _race10Registered = false;
    _race10Lane = lane;
    _race10MyDamage = 0;
    if (hp) player.hp = hp;
    _dbFightAt = fightAt || 0;   // same freeze overlay the death battle/3v3 use
    if (typeof _teleportTo === 'function') _teleportTo(x, y, t('race10ArenaLbl'));
    else { player.x = x; player.y = y; }
    if (typeof showEventBossBanner === 'function') showEventBossBanner(t('race10StartedMsg'), '#e8574f');
    if (typeof Sound !== 'undefined') Sound.bossSpawn();
    if (typeof showDeathBattleFreeze === 'function') showDeathBattleFreeze(_dbFightAt);
    // The boss shares the world event boss's look but needs its own sprite
    // entry (js/sprites.js race10_boss) — see the eid comment in
    // spawnRaceBoss (server/game/Room.js). Nothing else preloads it.
    if (typeof loadEnemySprites === 'function') loadEnemySprites('race10_boss');
    if (typeof onRace10State === 'function') onRace10State();
  });

  s.on('race10Fight', () => {
    _dbFightAt = 0;
    if (typeof hideDeathBattleFreeze === 'function') hideDeathBattleFreeze();
    if (typeof showEventBossBanner === 'function') showEventBossBanner(t('dbFightMsg'), '#e8574f');
    if (typeof Sound !== 'undefined') Sound.bossSpawn();
  });

  // Live feedback while fighting the shared boss — this client's own tally
  // and rank among however many are still hitting it.
  s.on('race10Score', ({ myDamage, rank, total }) => {
    _race10MyDamage = myDamage || 0;
    if (typeof onRace10Score === 'function') onRace10Score(rank || 0, total || 0);
  });

  // Knocked out (died anywhere in the lane): the generic death/respawn flow
  // already moved the player back to the hub — this is purely the "you're
  // out of the race" notice.
  s.on('race10Eliminated', () => {
    _race10InMatch = false;
    if (typeof showEventBossBanner === 'function') showEventBossBanner(t('race10Eliminated'), '#f07886');
    if (typeof onRace10State === 'function') onRace10State();
  });

  s.on('race10Result', ({ won, winnerName, myDamage, timedOut, reward }) => {
    _race10InMatch = false;
    _race10Lane = null;
    _dbFightAt = 0;
    if (typeof hideDeathBattleFreeze === 'function') hideDeathBattleFreeze();
    // No local balance bump here — same reasoning as arena3Result above: the
    // server's _race10GrantWin already sent an authoritative
    // 'nexumBalanceUpdate' for this reward, so adding it again double-counted
    // the win client-side.
    if (typeof showRace10Result === 'function') showRace10Result(!!won, winnerName, myDamage || 0, !!timedOut, reward || 0);
    if (typeof netRace10Sync === 'function') netRace10Sync();
    if (typeof onRace10State === 'function') onRace10State();
  });
}

// ── Война гильдий (Guild War) ────────────────────────────────────────────────
// No queue/registration like race10/arena3 above — the zone is an open walk-in
// (see js/game.js's _gwPad), so the only live pushes are the phase/ownership
// state itself, a capture announcement, and a generic action-refused error
// (no clan, or trying to hit your own tower).
function _initGuildWarHandlers(s) {
  s.on('guildWarState', (st) => {
    _gwState = { ..._gwState, ...st };
    _gwPhase = _gwState.phase;
    if (typeof onGuildWarState === 'function') onGuildWarState();
  });

  s.on('guildWarCaptured', ({ newOwnerClanName, newOwnerClanIcon, prevOwnerClanName }) => {
    if (typeof showGuildWarCapturedBanner === 'function') {
      showGuildWarCapturedBanner(newOwnerClanName, newOwnerClanIcon, prevOwnerClanName);
    }
  });

  s.on('guildWarError', ({ msg }) => {
    if (typeof _marketToast === 'function') _marketToast(msg || t('genericErrorLbl'), 'err');
  });
}

function netFearEnter()  { if (socket?.connected) socket.emit('fearEnter'); }
function netFearSync()   { if (socket?.connected) socket.emit('fearSync'); }
// Sent once the result banner has been shown for a cleared run — see the
// fearFinished handler below. Same round-trip race10Return/arena3Return use:
// the server already moved this player back to the hub when the run ended,
// this just makes the client catch up visually.
function netFearReturn() { if (socket?.connected) socket.emit('fearReturn'); }

// ── Страх (Fear) ─────────────────────────────────────────────────────────────
// On-demand, solo wave-survival instance: entering IS starting (fearStarted),
// so unlike arena3/race10 above there is no separate register/queue step.
function _initFearHandlers(s) {
  s.on('fearState', (st) => {
    _fearState = {
      maxAttempts: st.maxAttempts || _fearState.maxAttempts || 2,
      maxWave: st.maxWave || _fearState.maxWave || 39,
      minLevel: st.minLevel || _fearState.minLevel || 10,
      attemptsLeft: st.attemptsLeft !== undefined ? st.attemptsLeft : _fearState.attemptsLeft,
    };
    _fearInRun = !!st.inRun;
    _fearWave = st.wave || 0;
    if (typeof onFearState === 'function') onFearState();
  });

  s.on('fearError', ({ msg }) => {
    if (typeof _marketToast === 'function') _marketToast(msg || t('genericErrorLbl'), 'err');
  });

  s.on('fearStarted', ({ x, y, hp, maxWave, attemptsLeft, readyAt }) => {
    if (!player) return;
    _fearInRun = true;
    // Wave 1 doesn't actually spawn until readyAt (FEAR_START_DELAY_MS after
    // entry — see server's fearEnter); wave stays 0 until the fearWave event
    // below confirms it's really up.
    _fearWave = 0;
    if (maxWave) _fearState = { ..._fearState, maxWave };
    if (attemptsLeft !== undefined) _fearState = { ..._fearState, attemptsLeft };
    if (hp) player.hp = hp;
    if (typeof _teleportTo === 'function') _teleportTo(x, y, t('fearLbl'));
    else { player.x = x; player.y = y; }
    // Unlike deathBattle/race10/arena3 — which all sit behind a registration
    // window, giving the player time to close this panel themselves before
    // anything actually happens — clicking "Войти" here teleports the
    // player into Fear right away. Left open, the near-opaque #events-panel
    // (97% alpha, z-index 120) would still cover the whole screen for the
    // readyAt grace window, so close it up front and show the same
    // freeze-countdown overlay Death Battle uses instead — wave 1 (and its
    // banner/sound) only fires for real once the fearWave event below
    // arrives.
    if (typeof closeEventsPanel === 'function') closeEventsPanel();
    if (readyAt && typeof showFearCountdown === 'function') showFearCountdown(readyAt);
    if (typeof onFearState === 'function') onFearState();
  });

  // The previous wave fell and the next one just spawned in the same lane —
  // a HUD update only, no teleport: the player stays exactly where they are.
  // Also fires for wave 1 itself once the post-entry grace window elapses
  // (see fearStarted above), which is why the countdown overlay is hidden
  // and the spawn banner/sound played here rather than at fearStarted.
  s.on('fearWave', ({ wave, maxWave }) => {
    _fearWave = wave || 0;
    if (maxWave) _fearState = { ..._fearState, maxWave };
    if (typeof hideFearCountdown === 'function') hideFearCountdown();
    if (typeof showEventBossBanner === 'function') showEventBossBanner(tVars('fearWaveMsg', { wave: _fearWave, max: _fearState.maxWave }), '#8a3ffc');
    if (typeof Sound !== 'undefined') Sound.bossSpawn();
    if (typeof onFearState === 'function') onFearState();
  });

  // Run over — either died mid-wave (cleared: false) or beat FEAR_MAX_WAVE
  // (cleared: true). A death already sends the player home through the
  // generic death/respawn flow (js/game.js's respawnPlayer), so only the
  // "cleared" case still needs an explicit return trip.
  s.on('fearFinished', ({ cleared, wave }) => {
    _fearInRun = false;
    _fearWave = 0;
    if (typeof hideFearCountdown === 'function') hideFearCountdown();
    const msg = cleared ? t('fearClearedMsg') : tVars('fearDiedMsg', { wave: wave || 0, max: _fearState.maxWave });
    if (typeof showEventBossBanner === 'function') showEventBossBanner(msg, cleared ? '#ffd18a' : '#f07886');
    if (cleared && typeof netFearReturn === 'function') netFearReturn();
    if (typeof netFearSync === 'function') netFearSync();
    if (typeof onFearState === 'function') onFearState();
  });
}

function netDeathBattleRegister()   { if (socket?.connected) socket.emit('deathBattleRegister'); }
function netDeathBattleUnregister() { if (socket?.connected) socket.emit('deathBattleUnregister'); }
function netDeathBattleReturn()     { if (socket?.connected) socket.emit('deathBattleReturn'); }
function netDeathBattleSync()       { if (socket?.connected) socket.emit('deathBattleSync'); }

function netPickupWorldDrop(id) {
  if (socket?.connected) socket.emit('pickupWorldDrop', { id });
}

// Sell a common item to the merchant. The server removes it and credits the
// gold (see the sellItem handler) — nothing is applied locally, the result
// arrives as inventorySync + itemSold.
// id/enhance travel with the slot index so the server can verify it is about
// to destroy the item the player actually tapped — the two inventories are
// briefly renumbered differently after any server-side splice, and the index
// alone addressed whatever had slid into that slot. See _resolveInvIdx.
function netSellItem(idx, id, enhance) {
  if (socket?.connected) socket.emit('sellItem', { idx, id, enhance });
}

// Claim the current story quest's reward. `idx` names the quest so a save
// still in flight can't make the server grant the next one's reward.
function netClaimQuest(idx) {
  if (socket?.connected) socket.emit('claimQuest', { idx });
}

// ── Сезон ───────────────────────────────────────────────────────────────────
function netSeasonSync()   { if (socket?.connected) socket.emit('seasonSync'); }
function netSeasonRating() { if (socket?.connected) socket.emit('seasonRating'); }
// Switch the quest band (10+ / 20+). The server answers with a full
// seasonState, or a seasonError when the level isn't there yet.
function netSeasonSetTier(tier) { if (socket?.connected) socket.emit('seasonSetTier', { tier }); }
// Burning destroys the item for season points — the server owns both halves,
// nothing is applied locally.
// Same identity check as netSellItem above, and it matters more here: burning
// accepts any burnable rarity, so a stale index could destroy a legendary the
// player never picked.
function netSeasonBurn(idx, id, enhance) { if (socket?.connected) socket.emit('seasonBurn', { idx, id, enhance }); }
function netSeasonBurnAll(rarity) { if (socket?.connected) socket.emit('seasonBurnAll', { rarity }); }

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
  s.on('pvpHistoryResult', ({ history }) => {
    if (typeof onPvpHistoryResult === 'function') onPvpHistoryResult(history || []);
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
    if (player && goldAdded > 0 && player.x !== undefined) {
      // The balance itself arrives as a total via goldSync.
      dmgNum(player.x, player.y - 40, '+' + goldAdded + 'g VIP', '#ffd700');
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
  s.on('specialShopResult', (data) => {
    if (typeof onSpecialShopResult === 'function') onSpecialShopResult(data);
    netSaveProgressNow();
  });
  s.on('specialShopError', ({ msg }) => {
    if (typeof onSpecialShopError === 'function') onSpecialShopError(msg);
  });
}

// Incoming pet-crafting events — Liberty (Nexum) is server-authoritative, so
// unlike every other craft in this game (all resolved instantly client-side)
// this one is a real round-trip: netCraftPet just asks, the actual pet and
// the new balance only ever come from here (see 'craftPet' in server/index.js).
function _initPetCraftHandlers(s) {
  s.on('petCrafted', ({ pet, newNexumBalance, delivered }) => {
    window._nexumBalance = newNexumBalance;
    if (typeof onPetCrafted === 'function') onPetCrafted(pet, delivered);
  });
  s.on('petCraftError', ({ msg }) => {
    if (typeof onPetCraftError === 'function') onPetCraftError(msg);
  });

  // Enchant stones. Materials and the stone itself both move server-side (it
  // costs Liberty), so the authoritative inventory arrives via inventorySync
  // and there's nothing for this side to add or remove by hand.
  s.on('stoneCrafted', ({ matId, newNexumBalance }) => {
    window._nexumBalance = newNexumBalance;
    if (player) player.nexumBalance = newNexumBalance;
    if (typeof onStoneCrafted === 'function') onStoneCrafted(matId);
  });
  s.on('craftStoneError', ({ msg }) => {
    if (typeof onStoneCraftError === 'function') onStoneCraftError(msg);
  });

  // Epic/legendary gear (Liberty-priced tiers). Same shape as stoneCrafted
  // above, plus `success`: unlike stones this can genuinely roll a failure —
  // mats and Liberty are gone either way (inventorySync already reflects
  // that), only the item itself depends on the roll.
  s.on('gearCrafted', ({ itemId, success, newNexumBalance }) => {
    window._nexumBalance = newNexumBalance;
    if (player) player.nexumBalance = newNexumBalance;
    if (typeof onGearCrafted === 'function') onGearCrafted(itemId, success);
  });
  s.on('craftGearError', ({ msg }) => {
    if (typeof onGearCraftError === 'function') onGearCraftError(msg);
  });

  // Class cloaks/artifacts (salvage + Liberty). Same "delivered" shape as
  // petCrafted above: inventorySync (mats removed + item added) normally
  // lands before this event on the same socket, so `delivered` is mostly a
  // defensive fallback for the rare case the grant itself couldn't land.
  s.on('classGearCrafted', ({ item, newNexumBalance, delivered }) => {
    window._nexumBalance = newNexumBalance;
    if (player) player.nexumBalance = newNexumBalance;
    if (typeof onClassGearCrafted === 'function') onClassGearCrafted(item, delivered);
  });
  s.on('craftClassGearError', ({ msg }) => {
    if (typeof onClassGearCraftError === 'function') onClassGearCraftError(msg);
  });

  // Enhance / заточка. inventorySync (the plain socket.on above) always lands
  // first on this same socket and already applied the mutated inventory/
  // equipment; this only carries the user-facing outcome (see onEnhanceResult,
  // js/ui.js) so the modal can show the right toast and reopen at the item's
  // new state.
  s.on('enhanceResult', (data) => {
    if (typeof onEnhanceResult === 'function') onEnhanceResult(data);
  });
  s.on('enhanceError', ({ msg }) => {
    if (typeof onEnhanceError === 'function') onEnhanceError(msg);
  });

  // Box crafting (keys → box, 100% success) and material tier-up (recipe
  // scroll → next tier, can fail) — both server round trips now, same
  // "inventorySync already landed, this only carries the outcome" shape as
  // stoneCrafted/gearCrafted above.
  s.on('boxCrafted', ({ boxId }) => {
    if (typeof onBoxCrafted === 'function') onBoxCrafted(boxId);
  });
  s.on('craftBoxError', ({ msg }) => {
    if (typeof onBoxCraftError === 'function') onBoxCraftError(msg);
  });
  s.on('matUpgraded', ({ from, to, success }) => {
    if (typeof onMatUpgraded === 'function') onMatUpgraded(from, to, success);
  });
  s.on('craftMatUpgradeError', ({ msg }) => {
    if (typeof onMatUpgradeError === 'function') onMatUpgradeError(msg);
  });

  // Loot box opening — same "inventorySync already landed" shape as the
  // crafting events above; this only carries which item (if any) it won.
  s.on('boxOpened', (data) => {
    if (typeof onBoxOpened === 'function') onBoxOpened(data);
  });
  s.on('openBoxError', ({ msg }) => {
    if (typeof onOpenBoxError === 'function') onOpenBoxError(msg);
  });

  // Upgrade reset. The server has already charged the Liberty and cleared its
  // own copy of the upgrades; clearing ours here is what actually returns the
  // points, since "spent" is derived from this map rather than stored (see
  // getAvailableSkillPoints, js/player.js). Save straight away so an autosave
  // composed a moment earlier can't put the old upgrades back.
  s.on('upgradesReset', ({ pointsReturned, newNexumBalance }) => {
    window._nexumBalance = newNexumBalance;
    if (!player) return;
    player.nexumBalance = newNexumBalance;
    player.upgrades = {};
    if (typeof recompute === 'function') recompute();
    if (typeof netSaveProgress === 'function') netSaveProgress();
    if (typeof onUpgradesReset === 'function') onUpgradesReset(pointsReturned);
  });
  s.on('resetUpgradesError', ({ msg }) => {
    if (typeof onUpgradesResetError === 'function') onUpgradesResetError(msg);
  });

  // Rebirth (Перерождение). Same "inventorySync already landed" shape as
  // boxOpened above — the server's own _commitServerItems call inside the
  // rebirth handler already pushed the item-cost removal; this only carries
  // the progression reset (level/xp/upgrades/bonusSP/rebirths).
  s.on('rebirthDone', ({ lvl, xp, xpNext, baseAtk, baseDef, baseMaxHp, upgrades, bonusSP, rebirths } = {}) => {
    if (!player) return;
    player.lvl = lvl; player.xp = xp; player.xpNext = xpNext;
    player.baseAtk = baseAtk; player.baseDef = baseDef; player.baseMaxHp = baseMaxHp;
    player.upgrades = upgrades || {};
    player.bonusSP = bonusSP || 0;
    player.rebirths = rebirths || 0;
    if (typeof recompute === 'function') recompute();
    // Rebirth is framed as a fresh start — full heal, matching the +HP an
    // ordinary level-up already grants (gainXP, js/player.js).
    player.hp = player.maxHp;
    if (typeof netSaveProgress === 'function') netSaveProgress();
    if (typeof onRebirthDone === 'function') onRebirthDone();
  });
  s.on('rebirthError', ({ msg }) => {
    if (typeof onRebirthError === 'function') onRebirthError(msg);
  });

  // "ТЕХ" one-time gift button (getTechGiftBtnPos, js/input.js) — gold/
  // Liberty arrive via the normal goldSync/nexumBalanceUpdate events the
  // server already emits alongside this (see the techClaim handler, server/
  // index.js); this only flips the permanent claimed flag (so the button
  // stops drawing — see drawTechGiftButton, js/ui.js) and shows the toast.
  s.on('techClaimResult', () => {
    if (!player) return;
    player.techClaimed = true;
    if (typeof netSaveProgress === 'function') netSaveProgress();
    if (typeof dmgNum === 'function') dmgNum(player.x, player.y - 40, typeof t === 'function' ? t('techGiftToast') : '🎁 Технический подарок получен!', '#fd0');
  });
  // Left alone rather than forced to true here: a generic server error isn't
  // proof the gift was already claimed, so hiding the button on one would
  // strand an account that never actually got it. Worst case on the real
  // "already claimed" message is a harmless re-click.
  s.on('techClaimError', ({ msg }) => {
    if (typeof dmgNum === 'function' && player) dmgNum(player.x, player.y - 40, msg || 'Ошибка', '#f88');
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
  s.on('marketCancelled', ({ listingId, item, delivered }) => {
    if (typeof onMarketCancelled === 'function') onMarketCancelled(listingId, item, delivered);
  });
  s.on('marketBought', ({ listingId, item, newBalance, delivered }) => {
    window._gramBalance = newBalance;
    if (typeof onMarketBought === 'function') onMarketBought(listingId, item, delivered);
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

