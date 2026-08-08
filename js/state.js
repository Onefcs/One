let canvas, ctx, W, H, DPR = 1;
let state = 'select';
let player = null, dungeon = null;
let projs = [], otherProjs = [], drops = [], particles = [], dmgNums = [], aoeRings = [];
// Event-boss ground loot, shared by everyone: id -> {id, x, y, item}. The
// server owns it (see pickupWorldDrop in server/index.js) — this map only
// mirrors what's currently on the floor so it can be drawn and walked over.
let worldDrops = new Map();
// Pickup requests already sent and not yet answered, so walking over a pile
// doesn't spam one emit per frame while the round trip is in flight.
let _worldDropPending = new Map();
let camera = { x: 0, y: 0 };
let dungeonLvl = 1;
let frameCount = 0, lastTs = 0;
let activeTab = 0;
let keys = {};
let joy = { active: false, id: null, sx: 0, sy: 0, dx: 0, dy: 0 };
let swingAngle = 0, swingTimer = 0;
let transTimer = 0;

// Multiplayer state
let socket = null;
let otherPlayers = new Map();   // socketId → { x, y, type, facing, hp, maxHp, username }
// socketId → equipped pet id, kept OUTSIDE otherPlayers on purpose: that map
// is rebuilt from scratch on gameStart, which would drop pet ids the server
// only sends on join and on change. Fed by the 'playerPets'/'playerPet'
// events (js/network.js).
let otherPets = new Map();
let serverEnemies = [];     // authoritative enemy list (server-driven, near the player only)
// Flat Int16 [tileX, tileY, ...] of every alive non-boss enemy in the world,
// for the КАРТА panel — which draws a whole arm, well past the radius
// serverEnemies now covers. Pushed at 1Hz and only while that panel is open
// (see 'mapView'/'mapBlips', js/network.js). null = nothing received yet.
let _mapBlips = null;
let serverEnemiesMap = new Map(); // id → enemy for O(1) lookup
let netUsername = null;
let netRoom = null;

// NPCs in current floor
let npcs = [];
let nearNpc = null;

// Skill state
let skillFlash = null; // { key, timer }
let barrierTimer = 0;
let battleCryTimer = 0;
let dodgeTimer = 0;
let atkSpeedTimer = 0;
let faithShieldTimer = 0;
let invisTimer = 0;
let guardTimer = 0;      // Танк (lev) E — +80% DEF buff
let vampirismTimer = 0;  // Рыцарь Смерти (deathknight) Q — % lifesteal buff
const VAMPIRISM_PCT = 0.10;

// Target & PK mode
let targetId = null;
let targetIsPlayer = false;
let pvpMode = false;
// True only when the attack button was actually pressed on the current
// target — tapping/cycling a target to look at it must not by itself make
// the character run at it.
let _chaseArmed = false;

// Per-corridor boss status, keyed by arm name: { left: {alive,respawnAt}, ... }
let bossStatus = {};

// Party — array of { id, name } for all OTHER members
let partyMembers = [];

// Incoming invite popup { fromId, fromName, timer }
let partyInvitePending = null;

// Attack mode — manual by default; player switches to auto explicitly
let autoAttackMode = false;

// Clan state (null = not in a clan)
let clanData = null;

// Death Battle (Битва на смерть) — scheduled free-for-all, see the handlers
// in js/network.js and the panel in js/ui.js.
let _dbState = { phase: 'idle', startAt: 0, nextAt: 0, count: 0 };
let _dbRegistered = false;
let _dbInFight = false;
// 3v3 arena. _a3Team is 'A' or 'B' while in a match, and _a3Mates holds the
// socket ids of everyone in it by side, so nameplates can colour allies and
// opponents differently — the server already refuses friendly fire, this is
// just so players can tell who is who.
// attemptsLeft is only refreshed by an explicit sync (opening the panel, a
// registration, a match ending) — the frequent queue-count pushes leave it
// alone, so it starts as null meaning "not known yet" rather than 0.
let _a3State = { phase: 'idle', nextAt: 0, queued: 0, needed: 6, live: false, minLevel: 15, reward: 10, attemptsLeft: null, maxAttempts: 3 };
let _a3Registered = false;
let _a3InMatch = false;
let _a3Team = null;
let _a3Mates = { A: [], B: [] };
let _a3Score = { a: 3, b: 3 };
// This match's two guard bosses (see spawnPvpArenaBosses, server/game/
// Room.js) — id of the one standing on each side. Used to keep the target
// button/tap-select (js/input.js) from ever offering up your OWN side's
// boss: the server refuses the hit anyway, this just keeps it out of the
// candidate list in the first place.
let _a3BossIds = { A: null, B: null };
// Wall-clock time the current round ends, or 0 outside a live fight — drives
// the on-screen match countdown (see showArena3Timer, js/ui.js).
let _a3RoundEndAt = 0;
// While set and still in the future, this client is standing in the arena
// waiting out the pre-fight countdown: movement and attacks are blocked here
// as well as on the server (see _dbFrozen).
let _dbFightAt = 0;

// 10-player corridor race (Забег) — queue-driven like the 3v3 arena, but a
// free-for-all against one shared boss instead of a team match: everyone who
// makes it to the boss room fights the SAME boss, and whoever dealt it the
// most cumulative damage wins. myDamage is this client's own running total,
// pushed by the server (see js/network.js's race10Score handler) so the HUD
// can show it live.
let _race10State = { phase: 'idle', nextAt: 0, startAt: 0, queued: 0, needed: 10, live: false, minLevel: 10, reward: 10, attemptsLeft: null, maxAttempts: 3 };
let _race10Registered = false;
let _race10InMatch = false;
let _race10Lane = null;
let _race10MyDamage = 0;

// Страх (Fear) — on-demand, solo wave-survival instance: no registration
// queue and no scheduled window, unlike the arena/race above — entering IS
// starting (see js/network.js's netFearEnter/fearStarted). wave/maxWave
// track progress through the current run, pushed by fearWave/fearStarted.
let _fearState = { attemptsLeft: null, maxAttempts: 2, maxWave: 39, minLevel: 10, freeLanes: null, totalLanes: null };
let _fearInRun = false;
let _fearWave = 0;

// Сезон — points race with a fixed end date. Everything here is pushed by the
// server (points and quest progress are server-owned, see the seasonSync
// handler in server/index.js); nothing is computed locally.
let _seasonState = { endAt: 0, active: false, points: 0, quest: null, target: 5000,
                     questPoints: 100, minLvl: 1, maxLvl: 19, burn: { common: 1, uncommon: 5 }, prizes: [],
                     eventTasks: [], eventPoints: 50, enhance: { common: 10, uncommon: 50 } };
let _seasonRating = null;   // null = not fetched yet
