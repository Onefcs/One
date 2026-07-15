// ─────────────────────────────────────────────────────────
//  CAMERA
// ─────────────────────────────────────────────────────────
function clampCamera() {
  camera.x = clamp(camera.x, 0, Math.max(0, dungeon.w * TILE - W));
  camera.y = clamp(camera.y, 0, Math.max(0, dungeon.h * TILE - H));
}

function updateCamera(dt) {
  camera.x += (player.x - W / 2 - camera.x) * Math.min(1, 8 * dt);
  camera.y += (player.y - H / 2 - camera.y) * Math.min(1, 8 * dt);
  clampCamera();
}

// ─────────────────────────────────────────────────────────
//  UPDATE
// ─────────────────────────────────────────────────────────
function update(dt) {
  if (state !== 'playing') return;
  frameCount++;
  if (transTimer > 0) { transTimer -= dt; return; }

  const isOnline = !!(socket?.connected);
  const activeEnemies = isOnline ? serverEnemies : enemies;

  if (activeTab === 0) {
    const inp = inputDir();
    if (inp.len > 0) {
      const vx = inp.dx * player.speed * inp.len * dt;
      const vy = inp.dy * player.speed * inp.len * dt;
      if (canMoveX(player, vx, 12)) player.x += vx;
      if (canMoveY(player, vy, 12)) player.y += vy;
      const ax = Math.abs(inp.dx), ay = Math.abs(inp.dy);
      if (ax > ay * 0.8) player.facing = inp.dx > 0 ? 'right' : 'left';
      else               player.facing = inp.dy > 0 ? 'front' : 'back';
    }
    if (isOnline) netSendMove();
  }

  if (player.hurtTimer > 0) player.hurtTimer -= dt;
  if (swingTimer > 0)       swingTimer -= dt;
  if (player.atkAnimTimer > 0) player.atkAnimTimer -= dt;

  // advance sprite animation frame
  if (SPRITE_DEF[player.type]) {
    const ak = getSpriteAnimKey(player);
    const ad = SPRITE_DEF[player.type].anims[ak];
    if (ad) {
      player.animTimer += dt;
      const step = 1 / ad.fps;
      while (player.animTimer >= step) {
        player.animTimer -= step;
        const maxF = (spriteCache[player.type]?.[ak] || []).length || ad.n;
        if (ad.loop) { player.animFrame = (player.animFrame + 1) % maxF; }
        else if (player.animFrame < maxF - 1) { player.animFrame++; }
      }
    }
  }

  player.atkTimer -= dt;
  if (player.atkTimer <= 0 && activeEnemies.length > 0) {
    let closest = null, closestD = Infinity;
    activeEnemies.forEach(e => { const d = dist(e.x, e.y, player.x, player.y); if (d < closestD) { closestD = d; closest = e; } });
    if (closest && closestD < player.charDef.atkRange) {
      player.atkTimer = 1 / player.charDef.atkSpeed;
      if (isOnline) {
        // Visual feedback only; damage applied server-side
        netAttack(closest.id);
        faceTowards(closest.x, closest.y);
        swingAngle = Math.atan2(closest.y - player.y, closest.x - player.x);
        swingTimer = 0.18;
        player.atkAnimTimer = 0.55; player.animFrame = 0; player.animTimer = 0;
        if (player.charDef.atkType === 'ranged') fireProj(closest.x, closest.y);
        else if (player.charDef.atkType === 'aoe') spawnAOE(player.x, player.y, player.charDef.atkRange);
      } else {
        if (player.charDef.atkType === 'ranged') fireProj(closest.x, closest.y);
        else doMeleeAttack(closest);
      }
    }
  }

  if (!isOnline) {
    const dead = [];
    enemies.forEach(e => {
      if (e.hurtTimer > 0) e.hurtTimer -= dt;
      const dp = dist(e.x, e.y, player.x, player.y);
      if (dp < e.aggroR) e.aggro = true;
      if (dp > e.aggroR * 2.2) e.aggro = false;
      if (e.aggro) {
        if (dp > e.size + 14) {
          const ex2 = (player.x - e.x) / dp, ey2 = (player.y - e.y) / dp;
          const er = e.size * 0.55, evx = ex2 * e.spd * dt, evy = ey2 * e.spd * dt;
          if (canMoveX(e, evx, er)) e.x += evx;
          if (canMoveY(e, evy, er)) e.y += evy;
        }
        e.atkTimer -= dt;
        if (dp < e.size + 20 && e.atkTimer <= 0) { e.atkTimer = 1.4 + Math.random() * 0.6; hitPlayer(e.atk); }
      }
      if (e.hp <= 0) dead.push(e);
    });

    dead.forEach(e => {
      spawnBurst(e.x, e.y, e.color, 8);
      spawnDrops(e);
      gainXP(e.xp);
      player.kills++;
      deadEnemies.push({ ...e, hp: e.maxHp, respawnTimer: 10, aggro: false, hurtTimer: 0, atkTimer: 1 + Math.random() });
    });
    enemies = enemies.filter(e => e.hp > 0);

    const stillDead = [];
    deadEnemies.forEach(e => {
      e.respawnTimer -= dt;
      if (e.respawnTimer <= 0) {
        enemies.push({ ...e, x: e.spawnX, y: e.spawnY, hp: e.maxHp, hurtTimer: 0, aggro: false, atkTimer: 1 + Math.random() });
      } else {
        stillDead.push(e);
      }
    });
    deadEnemies = stillDead;

    projs = projs.filter(p => {
      p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
      if (p.life <= 0 || isWall(p.x, p.y)) return false;
      if (p.isPlayer) {
        let hit = false;
        enemies = enemies.filter(e => {
          if (hit) return true;
          if (dist(p.x, p.y, e.x, e.y) < e.size + p.size) {
            hitEnemy(e, p.dmg);
            if (e.hp <= 0) {
              spawnBurst(e.x, e.y, e.color, 8); spawnDrops(e); gainXP(e.xp); player.kills++;
              deadEnemies.push({ ...e, hp: e.maxHp, respawnTimer: 10, aggro: false, hurtTimer: 0, atkTimer: 1 + Math.random() });
            }
            hit = true; return e.hp > 0;
          }
          return true;
        });
        return !hit;
      }
      return true;
    });
  } else {
    // Online: advance visual projectiles (no damage check)
    projs = projs.filter(p => {
      p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
      return p.life > 0 && !isWall(p.x, p.y);
    });
  }

  drops = drops.filter(d => {
    d.life -= dt;
    if (d.life <= 0) return false;
    if (dist(player.x, player.y, d.x, d.y) < 30) { pickup(d); return false; }
    return true;
  });

  particles = particles.filter(p => { p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; return p.life > 0; });
  dmgNums = dmgNums.filter(d => { d.y += d.vy * dt; d.life -= dt; return d.life > 0; });

  // Entity interpolation: render at (now - INTERP_DELAY) using buffered snapshots
  // so movement is always smooth regardless of server tick rate
  if (isOnline) {
    Object.entries(otherPlayers).forEach(([id, op]) => {
      const pos = getInterpPos(id);
      if (pos) { op.x = pos.x; op.y = pos.y; }
    });
    serverEnemies.forEach(e => {
      const pos = getInterpPos(e.id);
      if (pos) { e.x = pos.x; e.y = pos.y; }
    });
  }

  updateCamera(dt);
}

// ─────────────────────────────────────────────────────────
//  RENDER
// ─────────────────────────────────────────────────────────
function render() {
  ctx.clearRect(0, 0, W, H);
  const theme = (state === 'playing' || state === 'dead') && dungeon ? getTheme(dungeonLvl) : null;
  ctx.fillStyle = theme ? theme.bg : '#060610';
  ctx.fillRect(0, 0, W, H);
  if (state === 'select') return;

  ctx.save(); // [camera]
  ctx.translate(-Math.round(camera.x), -Math.round(camera.y));

  if (tileCanvas) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tileCanvas, 0, 0);
  }

  // Drops
  drops.forEach(d => {
    ctx.save(); ctx.globalAlpha = Math.min(1, d.life * 1.5) * (0.85 + 0.15 * Math.sin(frameCount * .12));
    const bob = Math.sin(frameCount * .09) * 3;
    if (d.type === 'gold') {
      ctx.fillStyle = '#ff0'; ctx.beginPath(); ctx.arc(d.x, d.y + bob, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#a80'; ctx.font = 'bold 9px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(d.amount + 'g', d.x, d.y + bob);
    } else {
      ctx.font = '20px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(d.item.emoji, d.x, d.y + bob);
    }
    ctx.restore();
  });

  // Particles
  particles.forEach(p => { ctx.globalAlpha = Math.max(0, p.life); ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill(); });
  ctx.globalAlpha = 1;

  // Enemies (authoritative source depends on online/offline mode)
  const drawEnemyList = socket?.connected ? serverEnemies : enemies;
  drawEnemyList.forEach(e => {
    const hurt = e.hurtTimer > 0;
    ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.beginPath(); ctx.ellipse(e.x, e.y + e.size, e.size * .8, e.size * .3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = hurt ? '#fff' : e.color; ctx.beginPath(); ctx.arc(e.x, e.y, e.size, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.arc(e.x - e.size * .3, e.y - e.size * .18, e.size * .18, 0, Math.PI * 2); ctx.arc(e.x + e.size * .3, e.y - e.size * .18, e.size * .18, 0, Math.PI * 2); ctx.fill();
    if (e.isBoss) {
      ctx.strokeStyle = `rgba(255,50,50,${0.6 + 0.4 * Math.sin(frameCount * .1)})`; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(e.x, e.y, e.size + 5, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#f44'; ctx.font = 'bold 9px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillText('БОСС', e.x, e.y - e.size - 16);
    }
    const bw = e.size * 2.6, bh = 5, bx = e.x - bw / 2, by = e.y - e.size - 13;
    ctx.fillStyle = '#400'; ctx.fillRect(bx, by, bw, bh);
    const pct = e.hp / e.maxHp;
    ctx.fillStyle = pct > .5 ? '#2d2' : pct > .25 ? '#da2' : '#d22';
    ctx.fillRect(bx, by, bw * pct, bh);
  });

  // Other players (online only)
  if (socket?.connected) {
    Object.values(otherPlayers).forEach(p => {
      if (!p.x) return;
      ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.ellipse(p.x, p.y + 14, 11, 4, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = p.type === 'warrior' ? '#5af' : p.type === 'archer' ? '#7e7' : p.type === 'mage' ? '#e8e' : '#aaa';
      ctx.beginPath(); ctx.arc(p.x, p.y, 14, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 10px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.strokeText(p.username || '?', p.x, p.y - 18);
      ctx.fillText(p.username || '?', p.x, p.y - 18);
      const bw = 32, bh = 4, bx = p.x - bw / 2, by = p.y - 26;
      ctx.fillStyle = '#300'; ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = '#2d2'; ctx.fillRect(bx, by, bw * Math.max(0, (p.hp || 0) / (p.maxHp || 1)), bh);
    });
  }

  // Projectiles (faux glow via two circles — no shadowBlur GPU cost)
  projs.forEach(p => {
    ctx.globalAlpha = 0.28; ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.size + 5, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1; ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
  });

  // Player
  const phurt = player.hurtTimer > 0 && (frameCount % 6 < 3);
  if (!phurt) {
    const usedSprite = drawSprite(player);
    if (!usedSprite) {
      ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.beginPath(); ctx.ellipse(player.x, player.y + 14, 11, 4, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = player.charDef.color; ctx.beginPath(); ctx.arc(player.x, player.y, 14, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.4)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(player.x, player.y, 14, 0, Math.PI * 2); ctx.stroke();
      const fdx = joy.dx || (keys['ArrowRight'] || keys['d'] ? 1 : keys['ArrowLeft'] || keys['a'] ? -1 : 1);
      const fdy = joy.dy || (keys['ArrowDown'] || keys['s'] ? 1 : keys['ArrowUp'] || keys['w'] ? -1 : 0);
      const fl = Math.hypot(fdx, fdy) || 1;
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(player.x + fdx / fl * 8, player.y + fdy / fl * 8, 3.5, 0, Math.PI * 2); ctx.fill();
    }
    if (swingTimer > 0) {
      ctx.strokeStyle = player.charDef.atkType === 'aoe' ? 'rgba(240,100,255,.7)' : 'rgba(200,220,255,.75)';
      ctx.lineWidth = player.charDef.atkType === 'aoe' ? 4 : 3;
      const sr = player.charDef.atkType === 'aoe' ? player.charDef.atkRange * .65 : 34;
      ctx.beginPath(); ctx.arc(player.x, player.y, sr, swingAngle - .7, swingAngle + .7); ctx.stroke();
    }
  }

  // Damage numbers
  dmgNums.forEach(d => {
    ctx.globalAlpha = Math.min(1, d.life * 1.5);
    ctx.fillStyle = d.color;
    const fs = isNaN(d.text) ? 12 : 15;
    ctx.font = `bold ${fs}px Arial`; ctx.textAlign = 'center';
    ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.strokeText(d.text, d.x, d.y); ctx.fillText(d.text, d.x, d.y);
  });
  ctx.globalAlpha = 1;
  ctx.restore(); // [camera]

  drawHUD();
  drawMinimap();
  if (activeTab === 0) drawJoystick();
  if (state === 'dead') drawDead();

  if (transTimer > 0) {
    ctx.fillStyle = `rgba(180,120,255,${Math.min(1, transTimer * 3)})`; ctx.fillRect(0, 0, W, H);
  }
}

// ─────────────────────────────────────────────────────────
//  GAME FLOW
// ─────────────────────────────────────────────────────────
function goToFloor(n) {
  if (n === dungeonLvl || !player) return;
  if (socket?.connected) {
    netSendChangeFloor(clamp(n, 1, 20));
    setTab(0);
  } else {
    dungeonLvl = clamp(n, 1, 20);
    transTimer = 0.5;
    loadLevel();
    setTab(0);
  }
}

function selectChar(type) {
  joy.active = false; joy.dx = 0; joy.dy = 0;
  player = makePlayer(type);
  dungeonLvl = 1;

  if (socket?.connected) {
    // Online: send to server; sprites are loaded when gameStart arrives (see network.js)
    netSelectChar(type);
  } else {
    // Offline: dim cards, wait for sprites + dungeon to build, then start
    const cards = document.querySelector('.cards');
    if (cards) { cards.style.opacity = '0.4'; cards.style.pointerEvents = 'none'; }
    loadSprites(type, () => {
      if (cards) { cards.style.opacity = ''; cards.style.pointerEvents = ''; }
      document.getElementById('char-select').style.display = 'none';
      document.getElementById('bottom-nav').style.display = 'block';
      document.querySelectorAll('.bpanel').forEach(p => { p.style.display = 'block'; });
      loadLevel();
      state = 'playing';
      setTab(0);
    });
  }
}

// Returns the interpolated {x, y} for an entity at (now - INTERP_DELAY),
// using two buffered snapshots to linearly interpolate between them.
function getInterpPos(id) {
  const buf = _posBuffers[id];
  if (!buf || buf.length === 0) return null;
  const rt = Date.now() - INTERP_DELAY;
  let lo = null, hi = null;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i].t <= rt) lo = buf[i];
    else if (!hi) { hi = buf[i]; break; }
  }
  if (!lo) return { x: hi.x, y: hi.y };   // no past data yet — snap to earliest
  if (!hi) return { x: lo.x, y: lo.y };   // past end of buffer — hold last known
  const t = (rt - lo.t) / (hi.t - lo.t);
  return { x: lo.x + (hi.x - lo.x) * t, y: lo.y + (hi.y - lo.y) * t };
}

function buildTileCanvas() {
  if (!dungeon) return;
  const th = getTheme(dungeonLvl);
  tileCanvas = document.createElement('canvas');
  tileCanvas.width = dungeon.w * TILE;
  tileCanvas.height = dungeon.h * TILE;
  const tctx = tileCanvas.getContext('2d');
  for (let ty = 0; ty < dungeon.h; ty++) {
    for (let tx = 0; tx < dungeon.w; tx++) {
      const t = dungeon.grid[ty][tx];
      if (t === WALL) th.drawWall(tctx, tx * TILE, ty * TILE, 0);
      else            th.drawFloor(tctx, tx * TILE, ty * TILE, 0);
    }
  }
}

function loadLevel() {
  // Cache dungeon layout per floor so revisiting keeps the same map
  if (!floorCache[dungeonLvl]) {
    floorCache[dungeonLvl] = generateDungeon(dungeonLvl);
  }
  dungeon = floorCache[dungeonLvl];
  // Reset enemies to fresh state (full HP, original positions)
  enemies = dungeon.enemies.map(e => ({
    ...e, hp: e.maxHp, hurtTimer: 0, aggro: false, atkTimer: 1 + Math.random()
  }));
  deadEnemies = [];
  projs = []; drops = []; particles = []; dmgNums = [];
  player.x = dungeon.spawn.x; player.y = dungeon.spawn.y;
  if (dungeonLvl > 1) player.hp = Math.min(player.maxHp, player.hp + Math.floor(player.maxHp * .25));
  camera.x = player.x - W / 2; camera.y = player.y - H / 2;
  clampCamera();
  buildTileCanvas();
}

function restartGame() {
  if (state !== 'dead') return;
  serverEnemies = []; otherPlayers = {};
  Object.keys(floorCache).forEach(k => delete floorCache[k]);
  tileCanvas = null;
  document.getElementById('char-select').style.display = 'flex';
  const cards = document.querySelector('.cards');
  if (cards) { cards.style.opacity = ''; cards.style.pointerEvents = ''; }
  document.getElementById('bottom-nav').style.display = 'none';
  document.querySelectorAll('.bpanel').forEach(p => { p.classList.remove('open'); p.style.display = 'none'; });
  setTab(0);
  player = null; dungeonLvl = 1;
  enemies = []; projs = []; drops = []; particles = []; dmgNums = [];
  deadEnemies = [];
  state = 'select';
}

// ─────────────────────────────────────────────────────────
//  LOOP
// ─────────────────────────────────────────────────────────
function loop(ts) {
  const dt = Math.min((ts - lastTs) / 1000, .05); lastTs = ts;
  update(dt); render();
  requestAnimationFrame(loop);
}

window.addEventListener('load', () => {
  canvas = document.getElementById('canvas');
  ctx = canvas.getContext('2d');
  const resize = () => {
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
    if (dungeon) clampCamera();
  };
  resize(); window.addEventListener('resize', resize);
  initInput();
  requestAnimationFrame(ts => { lastTs = ts; requestAnimationFrame(loop); });
});
