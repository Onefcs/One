const SPRITE_DEF = {
  deathknight: {
    frameW: 128, frameH: 128,
    dispScale: 1.5,
    anims: {
      'front-idle':   { src:'images/DeathKnight/Front - Idle.png?v=2',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'back-idle':    { src:'images/DeathKnight/Back - Idle.png?v=2',        cols:15, rows:1, n:15, fps:7,  loop:true  },
      'left-idle':    { src:'images/DeathKnight/Left - Idle.png?v=2',        cols:15, rows:1, n:15, fps:7,  loop:true  },
      'right-idle':   { src:'images/DeathKnight/Right - Idle.png?v=2',       cols:15, rows:1, n:15, fps:7,  loop:true  },
      'front-run':    { src:'images/DeathKnight/Front - Running.png?v=2',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'back-run':     { src:'images/DeathKnight/Back - Running.png?v=2',     cols:15, rows:1, n:15, fps:15, loop:true  },
      'left-run':     { src:'images/DeathKnight/Left - Running.png?v=2',     cols:15, rows:1, n:15, fps:15, loop:true  },
      'right-run':    { src:'images/DeathKnight/Right - Running.png?v=2',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'front-attack': { src:'images/DeathKnight/Front - Attacking.png?v=2',  cols:15, rows:1, n:15, fps:14, loop:false },
      'back-attack':  { src:'images/DeathKnight/Back - Attacking.png?v=2',   cols:15, rows:1, n:15, fps:14, loop:false },
      'left-attack':  { src:'images/DeathKnight/Left - Attacking.png?v=2',   cols:15, rows:1, n:15, fps:14, loop:false },
      'right-attack': { src:'images/DeathKnight/Right - Attacking.png?v=2',  cols:15, rows:1, n:15, fps:14, loop:false },
      'frontright-idle':   { src:'images/DeathKnight/FrontRight - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'frontleft-idle':   { src:'images/DeathKnight/FrontLeft - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'backright-idle':   { src:'images/DeathKnight/BackRight - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'backleft-idle':   { src:'images/DeathKnight/BackLeft - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'frontright-run':    { src:'images/DeathKnight/FrontRight - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'frontleft-run':    { src:'images/DeathKnight/FrontLeft - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'backright-run':    { src:'images/DeathKnight/BackRight - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'backleft-run':    { src:'images/DeathKnight/BackLeft - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'frontright-attack': { src:'images/DeathKnight/FrontRight - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'frontleft-attack': { src:'images/DeathKnight/FrontLeft - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'backright-attack': { src:'images/DeathKnight/BackRight - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'backleft-attack': { src:'images/DeathKnight/BackLeft - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'die':          { src:'images/DeathKnight/Dying.png?v=2',              cols:15, rows:1, n:15, fps:12, loop:false },
    }
  },
  ranger: {
    frameW: 128, frameH: 128,
    dispScale: 1.5,
    anims: {
      'front-idle':   { src:'images/Ranger/Front - Idle.png?v=2',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'back-idle':    { src:'images/Ranger/Back - Idle.png?v=2',        cols:15, rows:1, n:15, fps:7,  loop:true  },
      'left-idle':    { src:'images/Ranger/Left - Idle.png?v=2',        cols:15, rows:1, n:15, fps:7,  loop:true  },
      'right-idle':   { src:'images/Ranger/Right - Idle.png?v=2',       cols:15, rows:1, n:15, fps:7,  loop:true  },
      'front-run':    { src:'images/Ranger/Front - Running.png?v=2',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'back-run':     { src:'images/Ranger/Back - Running.png?v=2',     cols:15, rows:1, n:15, fps:15, loop:true  },
      'left-run':     { src:'images/Ranger/Left - Running.png?v=2',     cols:15, rows:1, n:15, fps:15, loop:true  },
      'right-run':    { src:'images/Ranger/Right - Running.png?v=2',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'front-attack': { src:'images/Ranger/Front - Attacking.png?v=2',  cols:15, rows:1, n:15, fps:14, loop:false },
      'back-attack':  { src:'images/Ranger/Back - Attacking.png?v=2',   cols:15, rows:1, n:15, fps:14, loop:false },
      'left-attack':  { src:'images/Ranger/Left - Attacking.png?v=2',   cols:15, rows:1, n:15, fps:14, loop:false },
      'right-attack': { src:'images/Ranger/Right - Attacking.png?v=2',  cols:15, rows:1, n:15, fps:14, loop:false },
      'frontright-idle':   { src:'images/Ranger/FrontRight - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'frontleft-idle':   { src:'images/Ranger/FrontLeft - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'backright-idle':   { src:'images/Ranger/BackRight - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'backleft-idle':   { src:'images/Ranger/BackLeft - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'frontright-run':    { src:'images/Ranger/FrontRight - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'frontleft-run':    { src:'images/Ranger/FrontLeft - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'backright-run':    { src:'images/Ranger/BackRight - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'backleft-run':    { src:'images/Ranger/BackLeft - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'frontright-attack': { src:'images/Ranger/FrontRight - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'frontleft-attack': { src:'images/Ranger/FrontLeft - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'backright-attack': { src:'images/Ranger/BackRight - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'backleft-attack': { src:'images/Ranger/BackLeft - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'die':          { src:'images/Ranger/Dying.png?v=2',              cols:15, rows:1, n:15, fps:12, loop:false },
    }
  },
  mage: {
    frameW: 128, frameH: 128,
    dispScale: 1.5,
    anims: {
      'front-idle':   { src:'images/Mage/Front - Idle.png?v=2',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'back-idle':    { src:'images/Mage/Back - Idle.png?v=2',        cols:15, rows:1, n:15, fps:7,  loop:true  },
      'left-idle':    { src:'images/Mage/Left - Idle.png?v=2',        cols:15, rows:1, n:15, fps:7,  loop:true  },
      'right-idle':   { src:'images/Mage/Right - Idle.png?v=2',       cols:15, rows:1, n:15, fps:7,  loop:true  },
      'front-run':    { src:'images/Mage/Front - Running.png?v=2',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'back-run':     { src:'images/Mage/Back - Running.png?v=2',     cols:15, rows:1, n:15, fps:15, loop:true  },
      'left-run':     { src:'images/Mage/Left - Running.png?v=2',     cols:15, rows:1, n:15, fps:15, loop:true  },
      'right-run':    { src:'images/Mage/Right - Running.png?v=2',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'front-attack': { src:'images/Mage/Front - Attacking.png?v=2',  cols:15, rows:1, n:15, fps:14, loop:false },
      'back-attack':  { src:'images/Mage/Back - Attacking.png?v=2',   cols:15, rows:1, n:15, fps:14, loop:false },
      'left-attack':  { src:'images/Mage/Left - Attacking.png?v=2',   cols:15, rows:1, n:15, fps:14, loop:false },
      'right-attack': { src:'images/Mage/Right - Attacking.png?v=2',  cols:15, rows:1, n:15, fps:14, loop:false },
      'frontright-idle':   { src:'images/Mage/FrontRight - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'frontleft-idle':   { src:'images/Mage/FrontLeft - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'backright-idle':   { src:'images/Mage/BackRight - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'backleft-idle':   { src:'images/Mage/BackLeft - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'frontright-run':    { src:'images/Mage/FrontRight - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'frontleft-run':    { src:'images/Mage/FrontLeft - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'backright-run':    { src:'images/Mage/BackRight - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'backleft-run':    { src:'images/Mage/BackLeft - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'frontright-attack': { src:'images/Mage/FrontRight - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'frontleft-attack': { src:'images/Mage/FrontLeft - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'backright-attack': { src:'images/Mage/BackRight - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'backleft-attack': { src:'images/Mage/BackLeft - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'die':          { src:'images/Mage/Dying.png?v=2',              cols:15, rows:1, n:15, fps:12, loop:false },
    }
  },
  warlock: {
    frameW: 128, frameH: 128,
    dispScale: 1.5,
    anims: {
      'front-idle':   { src:'images/Warlock/Front - Idle.png?v=2',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'back-idle':    { src:'images/Warlock/Back - Idle.png?v=2',        cols:15, rows:1, n:15, fps:7,  loop:true  },
      'left-idle':    { src:'images/Warlock/Left - Idle.png?v=2',        cols:15, rows:1, n:15, fps:7,  loop:true  },
      'right-idle':   { src:'images/Warlock/Right - Idle.png?v=2',       cols:15, rows:1, n:15, fps:7,  loop:true  },
      'front-run':    { src:'images/Warlock/Front - Running.png?v=2',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'back-run':     { src:'images/Warlock/Back - Running.png?v=2',     cols:15, rows:1, n:15, fps:15, loop:true  },
      'left-run':     { src:'images/Warlock/Left - Running.png?v=2',     cols:15, rows:1, n:15, fps:15, loop:true  },
      'right-run':    { src:'images/Warlock/Right - Running.png?v=2',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'front-attack': { src:'images/Warlock/Front - Attacking.png?v=2',  cols:15, rows:1, n:15, fps:14, loop:false },
      'back-attack':  { src:'images/Warlock/Back - Attacking.png?v=2',   cols:15, rows:1, n:15, fps:14, loop:false },
      'left-attack':  { src:'images/Warlock/Left - Attacking.png?v=2',   cols:15, rows:1, n:15, fps:14, loop:false },
      'right-attack': { src:'images/Warlock/Right - Attacking.png?v=2',  cols:15, rows:1, n:15, fps:14, loop:false },
      'frontright-idle':   { src:'images/Warlock/FrontRight - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'frontleft-idle':   { src:'images/Warlock/FrontLeft - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'backright-idle':   { src:'images/Warlock/BackRight - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'backleft-idle':   { src:'images/Warlock/BackLeft - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'frontright-run':    { src:'images/Warlock/FrontRight - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'frontleft-run':    { src:'images/Warlock/FrontLeft - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'backright-run':    { src:'images/Warlock/BackRight - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'backleft-run':    { src:'images/Warlock/BackLeft - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'frontright-attack': { src:'images/Warlock/FrontRight - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'frontleft-attack': { src:'images/Warlock/FrontLeft - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'backright-attack': { src:'images/Warlock/BackRight - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'backleft-attack': { src:'images/Warlock/BackLeft - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'die':          { src:'images/Warlock/Dying.png?v=2',              cols:15, rows:1, n:15, fps:12, loop:false },
    }
  },
  lev: {
    frameW: 128, frameH: 128,
    dispScale: 1.5,
    anims: {
      // ?v=3 cache-busts these paths: the underlying PNGs were re-extracted
      // (correcting left/right) multiple times under the same filenames, and
      // browsers/Telegram's WebView cache images by URL — without a version
      // bump, clients that had already loaded Lev once kept rendering the
      // stale, pre-fix sprites no matter what the server now serves.
      'front-idle':   { src:'images/Lev/Front - Idle.png?v=3',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'back-idle':    { src:'images/Lev/Back - Idle.png?v=3',        cols:15, rows:1, n:15, fps:7,  loop:true  },
      'left-idle':    { src:'images/Lev/Left - Idle.png?v=3',        cols:15, rows:1, n:15, fps:7,  loop:true  },
      'right-idle':   { src:'images/Lev/Right - Idle.png?v=3',       cols:15, rows:1, n:15, fps:7,  loop:true  },
      'front-run':    { src:'images/Lev/Front - Running.png?v=3',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'back-run':     { src:'images/Lev/Back - Running.png?v=3',     cols:15, rows:1, n:15, fps:15, loop:true  },
      'left-run':     { src:'images/Lev/Left - Running.png?v=3',     cols:15, rows:1, n:15, fps:15, loop:true  },
      'right-run':    { src:'images/Lev/Right - Running.png?v=3',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'front-attack': { src:'images/Lev/Front - Attacking.png?v=3',  cols:15, rows:1, n:15, fps:14, loop:false },
      'back-attack':  { src:'images/Lev/Back - Attacking.png?v=3',   cols:15, rows:1, n:15, fps:14, loop:false },
      'left-attack':  { src:'images/Lev/Left - Attacking.png?v=3',   cols:15, rows:1, n:15, fps:14, loop:false },
      'right-attack': { src:'images/Lev/Right - Attacking.png?v=3',  cols:15, rows:1, n:15, fps:14, loop:false },
      'frontright-idle':   { src:'images/Lev/FrontRight - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'frontleft-idle':   { src:'images/Lev/FrontLeft - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'backright-idle':   { src:'images/Lev/BackRight - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'backleft-idle':   { src:'images/Lev/BackLeft - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'frontright-run':    { src:'images/Lev/FrontRight - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'frontleft-run':    { src:'images/Lev/FrontLeft - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'backright-run':    { src:'images/Lev/BackRight - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'backleft-run':    { src:'images/Lev/BackLeft - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'frontright-attack': { src:'images/Lev/FrontRight - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'frontleft-attack': { src:'images/Lev/FrontLeft - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'backright-attack': { src:'images/Lev/BackRight - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'backleft-attack': { src:'images/Lev/BackLeft - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'die':          { src:'images/Lev/Dying.png',              cols:15, rows:1, n:15, fps:12, loop:false },
    }
  },
};

// ── ENEMY SPRITE SHEETS ─────────────────────────────────────────────────────
// 64×64 frames (golems 128×128), 4 directional rows: 0=down 1=up 2=left 3=right.
const ENEMY_SPRITE_DEF = {
  // ── Floor 1: Goblins ────────────────────────────────────────────────────
  goblin_guard: {
    frameW: 64, frameH: 64,
    sheets: {
      idle:   { src:'images/Monster/Goblin 1/Idle0_with_shadow.png',   cols:4, fps:8,  loop:true  },
      walk:   { src:'images/Monster/Goblin 1/Run0_with_shadow.png',    cols:8, fps:12, loop:true  },
      attack: { src:'images/Monster/Goblin 1/Attack0_with_shadow.png', cols:5, fps:14, loop:false },
      death:  { src:'images/Monster/Goblin 1/Death0_with_shadow.png',  cols:6, fps:8,  loop:false },
    }
  },
  goblin_warrior: {
    frameW: 64, frameH: 64,
    sheets: {
      idle:   { src:'images/Monster/Goblin2/Idle_with_shadow.png',   cols:4, fps:8,  loop:true  },
      walk:   { src:'images/Monster/Goblin2/Run_with_shadow.png',    cols:8, fps:12, loop:true  },
      attack: { src:'images/Monster/Goblin2/Attack_with_shadow.png', cols:5, fps:14, loop:false },
      death:  { src:'images/Monster/Goblin2/Death_with_shadow.png',  cols:6, fps:8,  loop:false },
    }
  },
  goblin_boss: {
    frameW: 64, frameH: 64,
    sheets: {
      idle:   { src:'images/Monster/GoblinBoss/Idle_with_shadow.png',   cols:4, fps:8,  loop:true  },
      walk:   { src:'images/Monster/GoblinBoss/Run_with_shadow.png',    cols:8, fps:12, loop:true  },
      attack: { src:'images/Monster/GoblinBoss/Attack_with_shadow.png', cols:5, fps:14, loop:false },
      death:  { src:'images/Monster/GoblinBoss/Death_with_shadow.png',  cols:6, fps:8,  loop:false },
    }
  },
  // ── Floor 2: Skeletons ──────────────────────────────────────────────────
  skel_warrior: {
    frameW: 64, frameH: 64,
    sheets: {
      idle:   { src:'images/Monster/Skeleton1/Skeleton1_Idle_with_shadow.png',   cols:4, fps:8,  loop:true  },
      walk:   { src:'images/Monster/Skeleton1/Skeleton1_Run_with_shadow.png',    cols:8, fps:12, loop:true  },
      attack: { src:'images/Monster/Skeleton1/Skeleton1_Attack_with_shadow.png', cols:9, fps:14, loop:false },
      death:  { src:'images/Monster/Skeleton1/Skeleton1_Death_with_shadow.png',  cols:6, fps:8,  loop:false },
    }
  },
  skel_barbarian: {
    frameW: 64, frameH: 64,
    sheets: {
      idle:   { src:'images/Monster/Skeleton2/Skeleton2_Idle_with_shadow.png',   cols:4, fps:8,  loop:true  },
      walk:   { src:'images/Monster/Skeleton2/Skeleton2_Run_with_shadow.png',    cols:8, fps:12, loop:true  },
      attack: { src:'images/Monster/Skeleton2/Skeleton2_Attack_with_shadow.png', cols:9, fps:14, loop:false },
      death:  { src:'images/Monster/Skeleton2/Skeleton2_Death_with_shadow.png',  cols:6, fps:8,  loop:false },
    }
  },
  skel_boss: {
    frameW: 64, frameH: 64,
    sheets: {
      idle:   { src:'images/Monster/SkeletonBoss/Skeleton3_Idle_with_shadow.png',   cols:4, fps:8,  loop:true  },
      walk:   { src:'images/Monster/SkeletonBoss/Skeleton3_Run_with_shadow.png',    cols:8, fps:12, loop:true  },
      attack: { src:'images/Monster/SkeletonBoss/Skeleton3_Attack_with_shadow.png', cols:9, fps:14, loop:false },
      death:  { src:'images/Monster/SkeletonBoss/Skeleton3_Death_with_shadow.png',  cols:6, fps:8,  loop:false },
    }
  },
  // ── Floor 3: Mushrooms ──────────────────────────────────────────────────
  mush_guard: {
    frameW: 64, frameH: 64,
    sheets: {
      idle:   { src:'images/Monster/Mushroom1/Mushroom2_Idle_with_shadow.png',   cols:4, fps:8,  loop:true  },
      walk:   { src:'images/Monster/Mushroom1/Mushroom2_Run_with_shadow.png',    cols:6, fps:12, loop:true  },
      attack: { src:'images/Monster/Mushroom1/Mushroom2_Attack_with_shadow.png', cols:8, fps:14, loop:false },
      death:  { src:'images/Monster/Mushroom1/Mushroom2_Death_with_shadow.png',  cols:9, fps:8,  loop:false },
    }
  },
  mush_warrior: {
    frameW: 64, frameH: 64,
    sheets: {
      idle:   { src:'images/Monster/Mushroom2/Mushroom1_Idle_with_shadow.png',   cols:4, fps:8,  loop:true  },
      walk:   { src:'images/Monster/Mushroom2/Mushroom1_Run_with_shadow.png',    cols:6, fps:12, loop:true  },
      attack: { src:'images/Monster/Mushroom2/Mushroom1_Attack_with_shadow.png', cols:8, fps:14, loop:false },
      death:  { src:'images/Monster/Mushroom2/Mushroom1_Death_with_shadow.png',  cols:9, fps:8,  loop:false },
    }
  },
  mush_boss: {
    frameW: 64, frameH: 64,
    sheets: {
      idle:   { src:'images/Monster/MushroomBoss/Mushroom3_Idle_with_shadow.png',   cols:4, fps:8,  loop:true  },
      walk:   { src:'images/Monster/MushroomBoss/Mushroom3_Run_with_shadow.png',    cols:6, fps:12, loop:true  },
      attack: { src:'images/Monster/MushroomBoss/Mushroom3_Attack_with_shadow.png', cols:8, fps:14, loop:false },
      death:  { src:'images/Monster/MushroomBoss/Mushroom3_Death_with_shadow.png',  cols:9, fps:8,  loop:false },
    }
  },
  // ── Floor 4: Ghosts ─────────────────────────────────────────────────────
  ghost_warrior: {
    frameW: 64, frameH: 64,
    sheets: {
      idle:   { src:'images/Monster/Ghost1/Ghost1_Idle_with_shadow.png',   cols:4,  fps:8,  loop:true  },
      walk:   { src:'images/Monster/Ghost1/Ghost1_Run_with_shadow.png',    cols:6,  fps:12, loop:true  },
      attack: { src:'images/Monster/Ghost1/Ghost1_Attack_with_shadow.png', cols:12, fps:14, loop:false },
      death:  { src:'images/Monster/Ghost1/Ghost1_Death_with_shadow.png',  cols:9,  fps:8,  loop:false },
    }
  },
  ghost_guard: {
    frameW: 64, frameH: 64,
    sheets: {
      idle:   { src:'images/Monster/Ghost2/Ghost2_Idle_with_shadow.png',   cols:4,  fps:8,  loop:true  },
      walk:   { src:'images/Monster/Ghost2/Ghost2_Run_with_shadow.png',    cols:6,  fps:12, loop:true  },
      attack: { src:'images/Monster/Ghost2/Ghost2_Attack_with_shadow.png', cols:12, fps:14, loop:false },
      death:  { src:'images/Monster/Ghost2/Ghost2_Death_with_shadow.png',  cols:9,  fps:8,  loop:false },
    }
  },
  ghost_boss: {
    frameW: 64, frameH: 64,
    sheets: {
      idle:   { src:'images/Monster/GhostBoss/Ghost3_Idle_with_shadow.png',   cols:4,  fps:8,  loop:true  },
      walk:   { src:'images/Monster/GhostBoss/Ghost3_Run_with_shadow.png',    cols:6,  fps:12, loop:true  },
      attack: { src:'images/Monster/GhostBoss/Ghost3_Attack_with_shadow.png', cols:12, fps:14, loop:false },
      death:  { src:'images/Monster/GhostBoss/Ghost3_Death_with_shadow.png',  cols:9,  fps:8,  loop:false },
    }
  },
  // ── Floor 5: Golems ─────────────────────────────────────────────────────
  golem_warrior: {
    frameW: 128, frameH: 128,
    sheets: {
      idle:   { src:'images/Monster/Golem 1/Golem1_Idle_with_shadow.png',   cols:4, fps:6,  loop:true  },
      walk:   { src:'images/Monster/Golem 1/Golem1_Run_with_shadow.png',    cols:8, fps:10, loop:true  },
      attack: { src:'images/Monster/Golem 1/Golem1_Attack_with_shadow.png', cols:9, fps:12, loop:false },
      death:  { src:'images/Monster/Golem 1/Golem1_Death_with_shadow.png',  cols:8, fps:7,  loop:false },
    }
  },
  golem_guard: {
    frameW: 128, frameH: 128,
    sheets: {
      idle:   { src:'images/Monster/Golem2/Golem2_Idle_with_shadow.png',   cols:4, fps:6,  loop:true  },
      walk:   { src:'images/Monster/Golem2/Golem2_Run_with_shadow.png',    cols:8, fps:10, loop:true  },
      attack: { src:'images/Monster/Golem2/Golem2_Attack_with_shadow.png', cols:9, fps:12, loop:false },
      death:  { src:'images/Monster/Golem2/Golem2_Death_with_shadow.png',  cols:8, fps:7,  loop:false },
    }
  },
  golem_boss: {
    frameW: 128, frameH: 128,
    sheets: {
      idle:   { src:'images/Monster/Golem3/Golem3_Idle_with_shadow.png',   cols:4, fps:6,  loop:true  },
      walk:   { src:'images/Monster/Golem3/Golem3_Run_with_shadow.png',    cols:8, fps:10, loop:true  },
      attack: { src:'images/Monster/Golem3/Golem3_Attack_with_shadow.png', cols:9, fps:12, loop:false },
      death:  { src:'images/Monster/Golem3/Golem3_Death_with_shadow.png',  cols:8, fps:7,  loop:false },
    }
  },
};

// Warm up an already-loaded image so the canvas 2D pipeline never has to
// decode/rasterize it lazily on the first real drawImage() call. decode()
// alone isn't reliable enough here — under the load of many concurrent large
// sheets it can silently reject (falling back to a no-op), and even on
// success it doesn't always warm the same raster cache canvas drawing uses.
// Actually drawing one pixel into a throwaway canvas forces genuine
// rasterization through the exact code path the game canvas will use.
let _warmCanvas = null, _warmCtx = null;
function _warmUpImage(img, onDone) {
  function draw() {
    if (!_warmCanvas) { _warmCanvas = document.createElement('canvas'); _warmCanvas.width = _warmCanvas.height = 1; _warmCtx = _warmCanvas.getContext('2d'); }
    try { _warmCtx.drawImage(img, 0, 0, 1, 1, 0, 0, 1, 1); } catch (e) { /* ignore */ }
    onDone();
  }
  if (img.decode) img.decode().then(draw, draw);
  else draw();
}

const enemySpriteCache = {};
// eid -> Promise resolved once every sheet for that enemy is loaded AND decoded.
// Callers may ask for the same eid again while a load is still in flight (e.g.
// the loading-screen gate and drawEnemySprite's own lazy-load both do) — chain
// onto the existing promise instead of firing onDone before decode finishes.
const _enemySpriteLoadPromises = {};

function loadEnemySprites(eid, onDone) {
  onDone = onDone || function () {};
  const def = ENEMY_SPRITE_DEF[eid];
  if (!def || !def.sheets) { onDone(); return; }
  if (_enemySpriteLoadPromises[eid]) { _enemySpriteLoadPromises[eid].then(onDone); return; }
  enemySpriteCache[eid] = {};
  const keys = Object.keys(def.sheets);
  let total = keys.length, done = 0;
  let resolveReady;
  _enemySpriteLoadPromises[eid] = new Promise(res => { resolveReady = res; });
  function tick() { if (++done >= total) resolveReady(); }
  keys.forEach(key => {
    const img = new Image();
    img.src = def.sheets[key].src;
    img.onload = () => _warmUpImage(img, tick);
    img.onerror = tick;
    enemySpriteCache[eid][key] = img;
  });
  if (total === 0) resolveReady();
  _enemySpriteLoadPromises[eid].then(onDone);
}

// Sheet rows are uniform across all enemy sheets: 0=down 1=up 2=left 3=right
const ENEMY_FACING_ROW = { down: 0, up: 1, left: 2, right: 3 };


// ── NPC SPRITE SHEETS ───────────────────────────────────────────────────────
// NPCs stand in one spot facing the camera — a single-row idle loop is
// enough, no per-facing rows like enemies/players need.
const NPC_SPRITE_DEF = {
  merchant:   { src: 'images/npc/merchant.png',   frameW: 128, frameH: 128, cols: 7,  fps: 6,  loop: true },
  craftsman:  { src: 'images/npc/craftsman.png',  frameW: 128, frameH: 128, cols: 12, fps: 10, loop: true },
  shopkeeper: { src: 'images/npc/shopkeeper.png', frameW: 128, frameH: 128, cols: 7,  fps: 6,  loop: true },
};

const npcSpriteCache = {};
const _npcSpriteLoadPromises = {};

function loadNpcSprites(id, onDone) {
  onDone = onDone || function () {};
  const def = NPC_SPRITE_DEF[id];
  if (!def) { onDone(); return; }
  if (npcSpriteCache[id]) { onDone(); return; }
  if (_npcSpriteLoadPromises[id]) { _npcSpriteLoadPromises[id].then(onDone); return; }
  let resolveReady;
  _npcSpriteLoadPromises[id] = new Promise(res => { resolveReady = res; });
  const img = new Image();
  img.src = def.src;
  img.onload = () => _warmUpImage(img, resolveReady);
  img.onerror = resolveReady;
  npcSpriteCache[id] = img;
  _npcSpriteLoadPromises[id].then(onDone);
}


// ── PLAYER SPRITE SHEETS ────────────────────────────────────────────────────

const spriteCache = {};
// charType -> Promise resolved once every frame is loaded AND decoded — see
// _enemySpriteLoadPromises for why concurrent callers must chain onto it
// rather than firing onDone as soon as the cache object exists.
const _spriteLoadPromises = {};

// Player sheets ship at up to 3360×2880 (~37MB decoded RGBA apiece, ~13 sheets
// per character) but the character renders at 80 world-px × ZOOM(0.75) × DPR —
// at most ~240 device px tall. Keeping the full-res decoded bitmaps resident
// costs hundreds of MB; mobile browsers respond by discarding decoded image
// data under memory pressure and silently re-decoding on the next drawImage,
// which froze the main thread for 100-300ms exactly when the animation
// switched sheets (i.e. while moving / turning). Fix: rasterize each sheet
// once, at gameplay size, into a canvas — canvases stay rasterized and are
// never re-decoded — and drop the reference to the huge Image so GC can
// reclaim the decoded bitmap.
const _SPRITE_CELL_H = Math.max(120, Math.min(240,
  Math.ceil(80 * (typeof ZOOM !== 'undefined' ? ZOOM : 1) * (window.devicePixelRatio || 1))));

// Rasterizing one 3360×2880 sheet costs 10-50ms of main-thread time; when a
// character's sheets all come from HTTP cache their decodes resolve nearly
// simultaneously and 13 back-to-back rasterizations freeze the game for a
// beat — visible as a stutter the moment another player enters the screen.
// Serialize them: one sheet per macrotask so the game loop breathes between.
const _rasterQueue = [];
let _rasterPumping = false;
function _queueRaster(job) {
  _rasterQueue.push(job);
  if (_rasterPumping) return;
  _rasterPumping = true;
  const pump = () => {
    const j = _rasterQueue.shift();
    if (j) j();
    if (_rasterQueue.length) setTimeout(pump, 0);
    else _rasterPumping = false;
  };
  setTimeout(pump, 0);
}

function _rasterizeSheet(img, ad, def) {
  const scale = _SPRITE_CELL_H / def.frameH;
  const cw = Math.ceil(def.frameW * scale), ch = _SPRITE_CELL_H;
  const rows = Math.ceil(ad.n / ad.cols);
  const cv = document.createElement('canvas');
  cv.width = cw * ad.cols; cv.height = ch * rows;
  const c = cv.getContext('2d');
  // Per-frame integer cells (not one whole-sheet scaled blit) so frames never
  // bleed into each other through bilinear filtering at fractional borders.
  for (let i = 0; i < ad.n; i++) {
    const col = i % ad.cols, row = Math.floor(i / ad.cols);
    c.drawImage(img, col * def.frameW, row * def.frameH, def.frameW, def.frameH,
      col * cw, row * ch, cw, ch);
  }
  // Draw code reads frame size off the cache entry so canvas and Image
  // entries stay interchangeable.
  cv.frameW = cw; cv.frameH = ch;
  return cv;
}

// A cache entry is drawable only after rasterization (canvas). Raw Images are
// never used for drawing — even a loaded Image can be 3360×2880px (warrior),
// and downsampling it per frame at 6× on mobile GPU costs 20ms+.
function _sheetReady(entry) {
  if (!entry) return false;
  return entry.naturalWidth === undefined; // true only for rasterized canvas
}

// Char-select shows 5 idle previews at once — only the 'front-idle' frame is
// ever drawn there, so only load+decode that one sheet per unpicked character.
// Eagerly decoding all 13 sheets × 5 characters (some up to 3360×2880px) at
// once was overwhelming the browser's image-decode pipeline: decode() calls
// started silently rejecting under the load, leaving bitmaps un-warmed, which
// then forced a synchronous decode-on-draw (a 100-300ms freeze) the first
// time the chosen character's run/attack animation was drawn mid-game.
function loadSpritePreviewFrame(charType, onDone) {
  onDone = onDone || function () {};
  const def = SPRITE_DEF[charType];
  if (!def) { onDone(); return; }
  spriteCache[charType] = spriteCache[charType] || {};
  const cache = spriteCache[charType];
  if (cache['front-idle']) { onDone(); return; }
  const img = new Image();
  img.src = def.anims['front-idle'].src;
  img.onload = () => {
    const raster = () => {
      cache['front-idle'] = _rasterizeSheet(img, def.anims['front-idle'], def);
      onDone();
    };
    if (img.decode) img.decode().then(raster, raster); else raster();
  };
  img.onerror = onDone;
  cache['front-idle'] = img;
}

function loadSprites(charType, onDone) {
  const def = SPRITE_DEF[charType];
  if (!def) { onDone(); return; }
  if (_spriteLoadPromises[charType]) { _spriteLoadPromises[charType].then(onDone); return; }
  spriteCache[charType] = spriteCache[charType] || {};
  const cache = spriteCache[charType];
  const keys = Object.keys(def.anims);
  let total = keys.length, done = 0;
  let resolveReady;
  _spriteLoadPromises[charType] = new Promise(res => { resolveReady = res; });
  function tick() { if (++done >= total) resolveReady(); }
  keys.forEach(key => {
    const existing = cache[key];
    // Already rasterized (char-select preview) — nothing left to do.
    if (existing && existing.naturalWidth === undefined) { tick(); return; }
    const applyRaster = (img) => {
      const raster = () => _queueRaster(() => {
        cache[key] = _rasterizeSheet(img, def.anims[key], def); tick();
      });
      if (img.decode) img.decode().then(raster, raster); else raster();
    };
    // Preview Image loaded but not yet rasterized — rasterize it in place.
    if (existing && existing.complete && existing.naturalWidth > 0) {
      applyRaster(existing);
      return;
    }
    const img = new Image();
    img.src = def.anims[key].src;
    img.onload = () => applyRaster(img);
    img.onerror = tick;
    cache[key] = img;
  });
  if (total === 0) resolveReady();
  _spriteLoadPromises[charType].then(onDone);
}

function getSpriteAnimKey(p) {
  if (state === 'dead') return 'die';
  const dir = p.facing || 'front';
  if (p.atkAnimTimer > 0)  return `${dir}-attack`;
  const inp = inputDir();
  if (inp.len > 0.05 || p._chasing) return `${dir}-run`;
  return `${dir}-idle`;
}

