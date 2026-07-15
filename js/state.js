let canvas, ctx, W, H;
let state = 'select';
let player = null, dungeon = null;
let enemies = [], projs = [], drops = [], particles = [], dmgNums = [];
let deadEnemies = [];
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
let otherPlayers = {};   // socketId → { x, y, type, facing, hp, maxHp, username }
let serverEnemies = [];  // authoritative enemy list when online
let netUsername = null;
let netRoom = null;

// Minimap tile cache
let minimapCache = null;
let minimapCacheFloor = -1;

// Full dungeon tile canvas
let tileCanvas = null;

// NPCs in current floor
let npcs = [];
let nearNpc = null;

// Skill state
let skillFlash = null; // { key, timer }
let barrierTimer = 0;
let battleCryTimer = 0;
let dodgeTimer = 0;

// Target & PvP
let targetId = null;
let targetIsPlayer = false;
let pvpMode = false;
