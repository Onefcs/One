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
// is rebuilt from scratch on gameStart and on every raid/party-dungeon
// enter/exit, which would drop pet ids the server only sends on join and on
// change. Fed by the 'playerPets'/'playerPet' events (js/network.js).
let otherPets = new Map();
let serverEnemies = [];     // authoritative enemy list (server-driven)
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

// Raid state
let inRaid = false;
let _normalDungeon = null;
let _normalDungeonLvl = 1;
let _normalPlayerX = null;
let _normalPlayerY = null;
// The rest of the open world's own contents, parked while an instance
// (raid arena / party-dungeon maze) is on screen. NPCs and event-boss
// ground loot belong to the world, not to the instance — without this
// they kept rendering (and the NPCs stayed interactable) inside the maze.
let _normalNpcs = null;
let _normalWorldDrops = null;
let _raidWaveNotif = null; // { text, timer }

// Raid lobby state
let _raidLobbyList = [];     // [{ id, creatorName, dungeonId, members: [{id,name,bm,lvl}] }]
let _myLobbyId    = null;
let _isLobbyCreator = false;
let _myLobbyMembers = [];    // [{id,name,bm,lvl}]

// Death Battle (Битва на смерть) — scheduled free-for-all, see the handlers
// in js/network.js and the panel in js/ui.js.
let _dbState = { phase: 'idle', startAt: 0, nextAt: 0, count: 0 };
let _dbRegistered = false;
let _dbInFight = false;
// 3v3 arena. _a3Team is 'A' or 'B' while in a match, and _a3Mates holds the
// socket ids of everyone in it by side, so nameplates can colour allies and
// opponents differently — the server already refuses friendly fire, this is
// just so players can tell who is who.
let _a3State = { queued: 0, needed: 6, live: false, minLevel: 15, reward: 10 };
let _a3Registered = false;
let _a3InMatch = false;
let _a3Team = null;
let _a3Mates = { A: [], B: [] };
let _a3Score = { a: 3, b: 3 };
// While set and still in the future, this client is standing in the arena
// waiting out the pre-fight countdown: movement and attacks are blocked here
// as well as on the server (see _dbFrozen).
let _dbFightAt = 0;

// Party dungeon (maze + boss) state
let inPartyDungeon = false;
let _pdLobbyList = [];       // [{ id, creatorName, members: [{id,name,bm,lvl}] }]
let _myPdLobbyId = null;
let _isPdLobbyCreator = false;
let _myPdLobbyMembers = [];  // [{id,name,bm,lvl}]
