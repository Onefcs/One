let canvas, ctx, W, H, DPR = 1;
let state = 'select';
let player = null, dungeon = null;
let projs = [], otherProjs = [], drops = [], particles = [], dmgNums = [];
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
let serverEnemies = [];     // authoritative enemy list (server-driven)
let serverEnemiesMap = new Map(); // id → enemy for O(1) lookup
let netUsername = null;
let netRoom = null;

// Minimap tile cache
let minimapCache = null;
let minimapCacheFloor = -1;

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

// Target & PK mode
let targetId = null;
let targetIsPlayer = false;
let pvpMode = false;

// Party — array of { id, name } for all OTHER members
let partyMembers = [];

// Incoming invite popup { fromId, fromName, timer }
let partyInvitePending = null;

// Attack mode
let autoAttackMode = true;

// Clan state (null = not in a clan)
let clanData = null;

// Raid state
let inRaid = false;
let _normalDungeon = null;
let _normalDungeonLvl = 1;
let _normalPlayerX = null;
let _normalPlayerY = null;
let _raidWaveNotif = null; // { text, timer }

// Raid lobby state
let _raidLobbyList = [];     // [{ id, creatorName, dungeonId, members: [{id,name,bm,lvl}] }]
let _myLobbyId    = null;
let _isLobbyCreator = false;
let _myLobbyMembers = [];    // [{id,name,bm,lvl}]
