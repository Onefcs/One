// ─────────────────────────────────────────────────────────
//  PANEL UIs
// ─────────────────────────────────────────────────────────
function updateInvUI() {
  if (!player) return;

  document.getElementById('eq-left').innerHTML = EQ_SLOTS.map(({ slot, label, empty }) => {
    const it = player.equipment[slot];
    return `<div class="eq-cell${it ? ' filled' : ''}" onclick="${it ? `unequipItem('${slot}')` : ''}" title="${it ? it.name + ' ' + statStr(it) : label}">
      <div class="cell-icon">${it ? it.emoji : empty}</div>
      <div class="cell-lbl">${it ? it.name.slice(0, 9) : label}</div>
    </div>`;
  }).join('');

  const p = player;
  document.getElementById('char-preview').innerHTML = `
    <div class="char-big">${p.charDef.emoji}</div>
    <div class="char-name" style="color:${p.charDef.color}">${p.charDef.name}</div>
    <div class="char-lvl">Уровень ${p.lvl}</div>
    <div class="char-stats">
      ♥ ${Math.ceil(p.hp)}/${p.maxHp}<br>
      ⚔ ${p.atk} · 🛡 ${p.def}<br>
      💰 ${p.gold} · 💀 ${p.kills}
    </div>
  `;

  const inv = player.inventory;
  document.getElementById('eq-right').innerHTML = Array.from({ length: 5 }, (_, i) => {
    const it = inv[i];
    return `<div class="eq-cell${it ? ' filled' : ''}" onclick="${it ? `equipItem(${i})` : ''}" title="${it ? it.name + ' ' + statStr(it) : ''}">
      <div class="cell-icon">${it ? it.emoji : '·'}</div>
      <div class="cell-lbl">${it ? it.name.slice(0, 9) : '—'}</div>
    </div>`;
  }).join('');

  document.getElementById('inv-count').textContent = inv.length + '/20';

  document.getElementById('inv-grid').innerHTML = Array.from({ length: 20 }, (_, i) => {
    const it = inv[i];
    return `<div class="inv-cell${it ? ' filled' : ''}" onclick="${it ? `equipItem(${i})` : ''}" title="${it ? it.name + ' ' + statStr(it) : ''}">
      ${it ? `<span>${it.emoji}</span>` : ''}
    </div>`;
  }).join('');
}

function updateProfileUI() {
  if (!player) return;
  const p = player, d = p.charDef;
  const th = getTheme(dungeonLvl);
  const pct = Math.floor(p.xp / p.xpNext * 100);
  document.getElementById('profile-body').innerHTML = `
    <div class="prof-hero">
      <div class="prof-emoji">${d.emoji}</div>
      <div>
        <div class="prof-cls" style="color:${d.color}">${d.name}</div>
        <div class="prof-lvl">Уровень ${p.lvl} · ${th.name}</div>
      </div>
    </div>
    <div class="xp-lbl">Опыт: ${p.xp} / ${p.xpNext}</div>
    <div class="xp-bg"><div class="xp-fill" style="width:${pct}%"></div></div>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-ic">♥</div><div class="stat-vl">${Math.ceil(p.hp)}</div><div class="stat-nm">Здоровье</div></div>
      <div class="stat-card"><div class="stat-ic">⚔️</div><div class="stat-vl">${p.atk}</div><div class="stat-nm">Урон</div></div>
      <div class="stat-card"><div class="stat-ic">🛡️</div><div class="stat-vl">${p.def}</div><div class="stat-nm">Броня</div></div>
      <div class="stat-card"><div class="stat-ic">💰</div><div class="stat-vl">${p.gold}</div><div class="stat-nm">Золото</div></div>
      <div class="stat-card"><div class="stat-ic">🏰</div><div class="stat-vl">${dungeonLvl}</div><div class="stat-nm">Этаж</div></div>
      <div class="stat-card"><div class="stat-ic">💀</div><div class="stat-vl">${p.kills}</div><div class="stat-nm">Убийства</div></div>
    </div>
    <div class="sec-title">Снаряжение</div>
    <div class="equip-sum">
      ${EQ_SLOTS.map(({ slot, label }) => {
        const it = p.equipment[slot];
        return `<div class="eq-row"><span class="eq-sl-nm">${label}</span><span class="${it ? 'rarity-' + it.rarity : ''}" style="font-size:12px">${it ? it.emoji + ' ' + it.name : '—'}</span></div>`;
      }).join('')}
    </div>`;
}

function drawMapPanel() {
  if (!dungeon || !player) return;
  const th = getTheme(dungeonLvl);
  const mc = document.getElementById('map-canvas');
  const panel = document.getElementById('panel-map');
  const pw = panel.clientWidth;
  const ph = Math.max(180, Math.floor((panel.clientHeight - 240) * 0.85));
  mc.width = pw; mc.height = ph;
  mc.style.width = pw + 'px'; mc.style.height = ph + 'px';
  const mx2 = mc.getContext('2d');
  const sc = Math.min((pw - 20) / dungeon.w, (ph - 10) / dungeon.h);
  const ox = (pw - dungeon.w * sc) / 2, oy = 8;
  mx2.fillStyle = '#030308'; mx2.fillRect(0, 0, pw, ph);
  for (let ty = 0; ty < dungeon.h; ty++) {
    for (let tx = 0; tx < dungeon.w; tx++) {
      const t = dungeon.grid[ty][tx]; if (t === WALL) continue;
      mx2.fillStyle = th.mmFloor;
      mx2.fillRect(ox + tx * sc, oy + ty * sc, Math.max(1, sc - 0.5), Math.max(1, sc - 0.5));
    }
  }
  mx2.fillStyle = '#00ff44';
  mx2.beginPath(); mx2.arc(ox + (player.x / TILE) * sc, oy + (player.y / TILE) * sc, Math.max(2, sc * 0.7), 0, Math.PI * 2); mx2.fill();
  const mapEnemies = (typeof socket !== 'undefined' && socket?.connected) ? serverEnemies : enemies;
  mx2.fillStyle = '#ff3322';
  mapEnemies.forEach(e => {
    mx2.beginPath(); mx2.arc(ox + (e.x / TILE) * sc, oy + (e.y / TILE) * sc, Math.max(1.5, sc * 0.5), 0, Math.PI * 2); mx2.fill();
  });
  document.getElementById('map-status').textContent =
    th.name + ' · Этаж ' + dungeonLvl + ' · 👾 ' + mapEnemies.length;
}

function updateFloorUI() {
  const grid = document.getElementById('floor-grid');
  if (!grid) return;
  grid.innerHTML = Array.from({ length: 20 }, (_, i) => {
    const n = i + 1;
    const th = getTheme(n);
    return `<div class="floor-btn${n === dungeonLvl ? ' active' : ''}" onclick="goToFloor(${n})" title="${th.name}">${n}</div>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────
//  TAB MANAGEMENT
// ─────────────────────────────────────────────────────────
function setTab(n) {
  activeTab = n;
  document.querySelectorAll('.nav-tab').forEach((el, i) => el.classList.toggle('active', i === n));
  document.querySelectorAll('.bpanel').forEach(p => { p.classList.remove('open'); });
  if (n !== 0) { joy.active = false; joy.dx = 0; joy.dy = 0; }
  const pid = ['', 'panel-inv', 'panel-map', 'panel-friends', 'panel-profile'][n];
  if (pid) {
    const el = document.getElementById(pid);
    el.style.display = 'block';
    requestAnimationFrame(() => { el.classList.add('open'); });
    if (n === 1) updateInvUI();
    if (n === 2) { updateFloorUI(); setTimeout(drawMapPanel, 320); }
    if (n === 4) updateProfileUI();
  }
}

// ─────────────────────────────────────────────────────────
//  HUD  (redesigned game-style)
// ─────────────────────────────────────────────────────────
function drawHUD() {
  if (!player) return;
  const p = player;
  const pad = 8;
  const pw = 192, ph = 78;
  const F = 'system-ui, Arial'; // readable font for canvas

  ctx.save();

  ctx.fillStyle = 'rgba(5,3,16,0.92)';
  roundRect(ctx, pad, pad, pw, ph, 10);
  ctx.fill();

  ctx.strokeStyle = 'rgba(75,45,145,0.65)';
  ctx.lineWidth = 1.5;
  roundRect(ctx, pad, pad, pw, ph, 10);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(160,120,255,0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad + 12, pad + 1.5); ctx.lineTo(pad + pw - 12, pad + 1.5);
  ctx.stroke();

  const bx = pad + 9, bw = pw - 18;

  // ── Character row ──
  const cy = pad + 15;
  ctx.font = `14px ${F}`; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff';
  ctx.fillText(p.charDef.emoji, pad + 9, cy);

  ctx.fillStyle = p.charDef.color;
  ctx.font = `bold 11px ${F}`; ctx.textAlign = 'left';
  ctx.fillText(p.charDef.name, pad + 30, cy - 4);

  ctx.font = `8px ${F}`; ctx.fillStyle = 'rgba(190,155,255,0.85)';
  ctx.fillText('Ур. ' + p.lvl, pad + 30, cy + 5);

  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(140,110,200,0.75)';
  ctx.font = `bold 8px ${F}`;
  ctx.fillText('Этаж ' + dungeonLvl, pad + pw - 8, cy - 4);
  ctx.fillStyle = 'rgba(100,80,160,0.6)';
  ctx.font = `7px ${F}`;
  ctx.fillText(getTheme(dungeonLvl).name, pad + pw - 8, cy + 5);

  // ── HP bar ──
  const hpy = pad + 30;
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(240,100,100,0.9)';
  ctx.font = `bold 7px ${F}`;
  ctx.fillText('HP', bx, hpy);

  const hpBarX = bx + 17, hpBarW = bw - 17, hpBarH = 10;
  const hpPct = Math.max(0, Math.min(1, p.hp / p.maxHp));

  ctx.fillStyle = 'rgba(45,8,8,0.88)';
  roundRect(ctx, hpBarX, hpy - 8, hpBarW, hpBarH, 4); ctx.fill();

  if (hpPct > 0) {
    const hg = ctx.createLinearGradient(hpBarX, 0, hpBarX + hpBarW * hpPct, 0);
    if (hpPct > 0.5) { hg.addColorStop(0, '#1c8c3c'); hg.addColorStop(1, '#44ee77'); }
    else if (hpPct > 0.25) { hg.addColorStop(0, '#9c7020'); hg.addColorStop(1, '#ffcc44'); }
    else { hg.addColorStop(0, '#8c1c1c'); hg.addColorStop(1, '#ff4444'); }
    ctx.fillStyle = hg;
    roundRect(ctx, hpBarX, hpy - 8, hpBarW * hpPct, hpBarH, 4); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    roundRect(ctx, hpBarX, hpy - 8, hpBarW * hpPct, 4, 3); ctx.fill();
  }

  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.font = `bold 7px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(Math.ceil(p.hp) + '/' + p.maxHp, hpBarX + hpBarW / 2, hpy - 3);

  // ── XP bar ──
  const xpy = pad + 44;
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(110,110,230,0.9)';
  ctx.font = `bold 7px ${F}`;
  ctx.fillText('XP', bx, xpy);

  const xpBarX = bx + 17, xpBarW = bw - 17, xpBarH = 6;
  const xpPct = Math.min(1, p.xp / p.xpNext);

  ctx.fillStyle = 'rgba(6,6,32,0.85)';
  roundRect(ctx, xpBarX, xpy - 5, xpBarW, xpBarH, 3); ctx.fill();

  if (xpPct > 0) {
    const xg = ctx.createLinearGradient(xpBarX, 0, xpBarX + xpBarW * xpPct, 0);
    xg.addColorStop(0, '#2233aa'); xg.addColorStop(1, '#7766ff');
    ctx.fillStyle = xg;
    roundRect(ctx, xpBarX, xpy - 5, xpBarW * xpPct, xpBarH, 3); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    roundRect(ctx, xpBarX, xpy - 5, xpBarW * xpPct, 3, 2); ctx.fill();
  }

  ctx.fillStyle = 'rgba(170,170,255,0.65)';
  ctx.font = `6px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(p.xp + ' / ' + p.xpNext, xpBarX + xpBarW / 2, xpy - 2);

  // ── Stats row ──
  const sy = pad + 65;
  ctx.strokeStyle = 'rgba(55,35,100,0.40)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(bx, sy - 8); ctx.lineTo(bx + bw, sy - 8); ctx.stroke();

  const stats = [
    { icon: '💰', val: p.gold, color: '#ffd040', xFrac: 0    },
    { icon: '⚔',  val: p.atk,  color: '#ff8866', xFrac: 0.38 },
    { icon: '🛡',  val: p.def,  color: '#8899ff', xFrac: 0.70 },
  ];

  ctx.textBaseline = 'middle';
  stats.forEach(s => {
    const sx2 = bx + s.xFrac * bw;
    ctx.font = `11px ${F}`; ctx.textAlign = 'left'; ctx.fillStyle = '#ccc';
    ctx.fillText(s.icon, sx2, sy);
    ctx.fillStyle = s.color; ctx.font = `bold 10px ${F}`;
    ctx.fillText(s.val, sx2 + 14, sy);
  });

  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  MINI-MAP  (raised higher since top-right overlay removed)
// ─────────────────────────────────────────────────────────
function drawMinimap() {
  const th = getTheme(dungeonLvl);
  const sc = 1.5;

  // Rebuild offscreen tile canvas only when floor changes — one drawImage per frame instead of 2400+ fillRects
  if (minimapCacheFloor !== dungeonLvl || !minimapCache) {
    minimapCacheFloor = dungeonLvl;
    minimapCache = document.createElement('canvas');
    minimapCache.width = dungeon.w * sc;
    minimapCache.height = dungeon.h * sc;
    const mctx = minimapCache.getContext('2d');
    mctx.fillStyle = th.mmFloor;
    for (let ty = 0; ty < dungeon.h; ty++) {
      for (let tx = 0; tx < dungeon.w; tx++) {
        if (dungeon.grid[ty][tx] !== WALL)
          mctx.fillRect(tx * sc, ty * sc, sc, sc);
      }
    }
  }

  const mmW = dungeon.w * sc, mmH = dungeon.h * sc;
  const mx = W - mmW - 10, my = 8;
  ctx.fillStyle = 'rgba(0,0,0,.75)'; ctx.fillRect(mx - 2, my - 2, mmW + 4, mmH + 4);
  ctx.strokeStyle = 'rgba(80,50,140,0.5)'; ctx.lineWidth = 1;
  ctx.strokeRect(mx - 2, my - 2, mmW + 4, mmH + 4);
  ctx.drawImage(minimapCache, mx, my);
  ctx.fillStyle = '#0f0'; ctx.fillRect(mx + (player.x / TILE) * sc - 2, my + (player.y / TILE) * sc - 2, 4, 4);
  const mmEnemies = (typeof socket !== 'undefined' && socket?.connected) ? serverEnemies : enemies;
  ctx.fillStyle = '#f00';
  mmEnemies.forEach(e => ctx.fillRect(mx + (e.x / TILE) * sc - 1, my + (e.y / TILE) * sc - 1, 2, 2));
}

// ─────────────────────────────────────────────────────────
//  JOYSTICK
// ─────────────────────────────────────────────────────────
function drawJoystick() {
  const jc = joyCenter();
  ctx.globalAlpha = 0.52;
  ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 2; ctx.fillStyle = 'rgba(255,255,255,.07)';
  ctx.beginPath(); ctx.arc(jc.x, jc.y, JOY_R, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(jc.x - JOY_R, jc.y); ctx.lineTo(jc.x + JOY_R, jc.y);
  ctx.moveTo(jc.x, jc.y - JOY_R); ctx.lineTo(jc.x, jc.y + JOY_R);
  ctx.stroke();
  const kx = jc.x + joy.dx * JOY_R, ky = jc.y + joy.dy * JOY_R;
  const kg = ctx.createRadialGradient(kx - JOY_KNOB * .3, ky - JOY_KNOB * .3, 0, kx, ky, JOY_KNOB);
  kg.addColorStop(0, 'rgba(210,210,255,.95)'); kg.addColorStop(1, 'rgba(80,80,180,.7)');
  ctx.fillStyle = kg; ctx.beginPath(); ctx.arc(kx, ky, JOY_KNOB, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(kx, ky, JOY_KNOB, 0, Math.PI * 2); ctx.stroke();
  ctx.globalAlpha = 1;
}

// ─────────────────────────────────────────────────────────
//  DEAD SCREEN
// ─────────────────────────────────────────────────────────
function drawDead() {
  ctx.fillStyle = 'rgba(0,0,0,.8)'; ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const F = 'system-ui, Arial';
  ctx.fillStyle = '#f44'; ctx.font = `bold ${clamp(32, W * .09, 54)}px ${F}`; ctx.fillText('ВЫ ПОГИБЛИ', W / 2, H / 2 - 50);
  ctx.fillStyle = '#777'; ctx.font = `${clamp(14, W * .04, 20)}px ${F}`;
  ctx.fillText(`${getTheme(dungeonLvl).name} · Этаж ${dungeonLvl}`, W / 2, H / 2 + 5);
  ctx.fillStyle = '#ff0'; ctx.fillText(`Золото: ${player.gold}  •  Убито: ${player.kills}`, W / 2, H / 2 + 38);
  ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.font = `${clamp(13, W * .034, 17)}px ${F}`;
  ctx.fillText('Нажмите, чтобы начать снова', W / 2, H / 2 + 84);
}
