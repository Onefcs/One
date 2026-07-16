// ─────────────────────────────────────────────────────────
//  PANEL UIs
// ─────────────────────────────────────────────────────────
function updateInvUI() {
  if (!player) return;
  const p = player;
  const inv = p.inventory;

  // Equipment grid (5 columns × 2 rows)
  document.getElementById('eq-grid').innerHTML = EQ_SLOTS.map(({ slot, label, empty }) => {
    const it = p.equipment[slot];
    const rc = it ? (RARITY_COLOR[it.rarity] || '#aaa') : '';
    return `<div class="eq-cell${it ? ' filled' : ''}" onclick="${it ? `unequipItem('${slot}')` : ''}"
      title="${it ? it.name + ' — ' + statStr(it) : label}"
      style="${it ? 'border-color:' + rc + '55' : ''}">
      <div class="cell-icon">${it ? it.emoji : empty}</div>
      <div class="cell-lbl" style="${it ? 'color:' + rc : ''}">${it ? it.name.slice(0, 8) : label}</div>
    </div>`;
  }).join('');

  // Character preview
  document.getElementById('char-preview').innerHTML = `
    <div class="inv-char-row">
      <div style="font-size:40px;line-height:1">${p.charDef.emoji}</div>
      <div style="flex:1">
        <div style="font-size:14px;font-weight:bold;color:${p.charDef.color}">${p.charDef.name}</div>
        <div style="font-size:11px;color:#555;margin-top:2px">Уровень ${p.lvl}</div>
        <div style="font-size:11px;color:#484860;margin-top:2px">♥${Math.ceil(p.hp)}/${p.maxHp} · ⚔${p.atk} · 🛡${p.def} · 💰${p.gold}</div>
      </div>
      <div style="font-size:13px;color:#f96;text-align:right;font-weight:bold">🧪×${p.potions || 0}</div>
    </div>
  `;

  // Inventory grid (10 slots)
  document.getElementById('inv-count').textContent = inv.length + '/10';
  document.getElementById('inv-grid').innerHTML = Array.from({ length: 10 }, (_, i) => {
    const it = inv[i];
    const rc = it ? (RARITY_COLOR[it.rarity] || '#aaa') : '';
    return `<div class="inv-cell${it ? ' filled' : ''}" onclick="${it ? `equipItem(${i})` : ''}"
      title="${it ? it.name + ' — ' + statStr(it) : ''}"
      style="${it ? 'border-color:' + rc + '77' : ''}">
      ${it ? `<span style="font-size:18px;display:block;text-align:center">${it.emoji}</span>
              <div style="font-size:7px;color:${rc};text-align:center;margin-top:1px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${it.name.slice(0,8)}</div>` : ''}
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
        const rc = it ? (RARITY_COLOR[it.rarity] || '#aaa') : '';
        return `<div class="eq-row"><span class="eq-sl-nm">${label}</span><span style="font-size:12px;color:${rc}">${it ? it.emoji + ' ' + it.name : '—'}</span></div>`;
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
  // NPC blips on map
  mx2.fillStyle = '#ffcc00';
  npcs.forEach(n => {
    mx2.beginPath(); mx2.arc(ox + (n.x / TILE) * sc, oy + (n.y / TILE) * sc, Math.max(2, sc * 0.7), 0, Math.PI * 2); mx2.fill();
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
  if (n !== 0) {
    joy.active = false; joy.dx = 0; joy.dy = 0;
    const tb = document.getElementById('npc-talk-btn');
    if (tb) tb.style.display = 'none';
  }
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
//  HUD
// ─────────────────────────────────────────────────────────
function drawHUD() {
  if (!player) return;
  const p = player;
  const pad = 8;
  const pw = 218, ph = 96;
  const F = 'system-ui, -apple-system, Arial';

  ctx.save();

  // Panel background — dark gradient
  const bg = ctx.createLinearGradient(pad, pad, pad, pad + ph);
  bg.addColorStop(0, 'rgba(14,9,30,0.97)');
  bg.addColorStop(1, 'rgba(7,5,18,0.99)');
  ctx.fillStyle = bg;
  roundRect(ctx, pad, pad, pw, ph, 12); ctx.fill();

  // Outer border glow
  ctx.strokeStyle = 'rgba(90,55,180,0.55)'; ctx.lineWidth = 1.5;
  roundRect(ctx, pad, pad, pw, ph, 12); ctx.stroke();
  // Inner highlight
  ctx.strokeStyle = 'rgba(150,100,255,0.12)'; ctx.lineWidth = 1;
  roundRect(ctx, pad + 1.5, pad + 1.5, pw - 3, ph - 3, 11); ctx.stroke();

  // Avatar circle
  const avX = pad + 27, avY = pad + 28, avR = 20;
  const avBg = ctx.createRadialGradient(avX - 5, avY - 5, 2, avX, avY, avR);
  avBg.addColorStop(0, p.charDef.color + '30');
  avBg.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.fillStyle = avBg;
  ctx.beginPath(); ctx.arc(avX, avY, avR, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = p.charDef.color; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(avX, avY, avR, 0, Math.PI * 2); ctx.stroke();
  // Avatar inner ring
  ctx.strokeStyle = p.charDef.color + '44'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(avX, avY, avR + 3, 0, Math.PI * 2); ctx.stroke();
  ctx.font = `20px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(p.charDef.emoji, avX, avY + 1);

  // Username + class
  const tx0 = pad + 57;
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.font = `bold 13px ${F}`; ctx.fillStyle = '#f0eeff';
  ctx.fillText((netUsername || p.charDef.name).slice(0, 14), tx0, pad + 22);
  ctx.font = `10px ${F}`; ctx.fillStyle = p.charDef.color + 'bb';
  ctx.fillText(p.charDef.name, tx0, pad + 35);

  // Level + floor (top-right)
  const rr = pad + pw - 10;
  ctx.textAlign = 'right';
  ctx.font = `bold 12px ${F}`; ctx.fillStyle = 'rgba(200,170,255,0.95)';
  ctx.fillText('Ур. ' + p.lvl, rr, pad + 22);
  ctx.font = `9px ${F}`; ctx.fillStyle = 'rgba(130,100,200,0.75)';
  ctx.fillText('Этаж ' + dungeonLvl, rr, pad + 35);

  // Separator
  const bx = pad + 9, bw = pw - 18;
  ctx.strokeStyle = 'rgba(70,45,130,0.4)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(bx, pad + 42); ctx.lineTo(pad + pw - 9, pad + 42); ctx.stroke();

  // HP bar
  const hpy = pad + 57;
  const hpPct = Math.max(0, Math.min(1, p.hp / p.maxHp));
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.font = `bold 8px ${F}`; ctx.fillStyle = 'rgba(255,100,100,1)';
  ctx.fillText('HP', bx, hpy);

  const hbX = bx + 20, hbW = bw - 20, hbH = 11;
  ctx.fillStyle = 'rgba(35,10,10,0.95)';
  roundRect(ctx, hbX, hpy - 5.5, hbW, hbH, 5); ctx.fill();

  if (hpPct > 0) {
    const hg = ctx.createLinearGradient(hbX, 0, hbX + hbW, 0);
    if (hpPct > 0.5) { hg.addColorStop(0, '#0d5c28'); hg.addColorStop(0.6, '#17a84a'); hg.addColorStop(1, '#2ecc71'); }
    else if (hpPct > 0.25) { hg.addColorStop(0, '#7a4400'); hg.addColorStop(1, '#f39c12'); }
    else { hg.addColorStop(0, '#6b0f0f'); hg.addColorStop(1, '#e74c3c'); }
    ctx.fillStyle = hg;
    roundRect(ctx, hbX, hpy - 5.5, hbW * hpPct, hbH, 5); ctx.fill();
    // Shine overlay
    const shine = ctx.createLinearGradient(0, hpy - 5.5, 0, hpy - 1);
    shine.addColorStop(0, 'rgba(255,255,255,0.18)');
    shine.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = shine;
    roundRect(ctx, hbX, hpy - 5.5, hbW * hpPct, hbH * 0.5, 5); ctx.fill();
    // Critical HP glow
    if (hpPct < 0.3) {
      ctx.save();
      ctx.shadowColor = '#e74c3c'; ctx.shadowBlur = 10;
      ctx.strokeStyle = 'rgba(231,76,60,0.6)'; ctx.lineWidth = 1;
      roundRect(ctx, hbX, hpy - 5.5, hbW * hpPct, hbH, 5); ctx.stroke();
      ctx.restore();
    }
  }
  ctx.font = `bold 7.5px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillText(Math.ceil(p.hp) + ' / ' + p.maxHp, hbX + hbW / 2, hpy);

  // XP bar
  const xpy = pad + 74;
  const xpPct = Math.min(1, p.xp / p.xpNext);
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.font = `bold 8px ${F}`; ctx.fillStyle = 'rgba(140,110,255,0.95)';
  ctx.fillText('XP', bx, xpy);

  const xbX = bx + 20, xbW = bw - 20, xbH = 7;
  ctx.fillStyle = 'rgba(8,6,25,0.95)';
  roundRect(ctx, xbX, xpy - 3.5, xbW, xbH, 3); ctx.fill();
  if (xpPct > 0) {
    const xg = ctx.createLinearGradient(xbX, 0, xbX + xbW, 0);
    xg.addColorStop(0, '#180f5a'); xg.addColorStop(1, '#7c4dff');
    ctx.fillStyle = xg;
    roundRect(ctx, xbX, xpy - 3.5, xbW * xpPct, xbH, 3); ctx.fill();
    const xs = ctx.createLinearGradient(0, xpy - 3.5, 0, xpy);
    xs.addColorStop(0, 'rgba(255,255,255,0.14)'); xs.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = xs;
    roundRect(ctx, xbX, xpy - 3.5, xbW * xpPct, xbH * 0.5, 3); ctx.fill();
  }
  ctx.font = `7px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(190,165,255,0.75)';
  ctx.fillText(p.xp + ' / ' + p.xpNext, xbX + xbW / 2, xpy);

  // Stats row
  const sy = pad + ph - 10;
  ctx.strokeStyle = 'rgba(60,40,110,0.35)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(bx, sy - 8); ctx.lineTo(pad + pw - 9, sy - 8); ctx.stroke();

  const stats = [
    { icon: '💰', val: p.gold, color: '#f1c40f', xFrac: 0    },
    { icon: '⚔',  val: p.atk,  color: '#e67e22', xFrac: 0.38 },
    { icon: '🛡',  val: p.def,  color: '#5dade2', xFrac: 0.68 },
  ];
  ctx.textBaseline = 'middle';
  stats.forEach(s => {
    const sx2 = bx + s.xFrac * bw;
    ctx.font = `11px ${F}`; ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(180,180,180,0.8)';
    ctx.fillText(s.icon, sx2, sy);
    ctx.fillStyle = s.color; ctx.font = `bold 11px ${F}`;
    ctx.fillText(s.val, sx2 + 16, sy);
  });

  // Active status indicators
  const statusX = pad + pw - 10;
  if (barrierTimer > 0) {
    ctx.font = `bold 9px ${F}`; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(180,130,255,0.95)';
    ctx.fillText('🔮 ' + Math.ceil(barrierTimer) + 'с', statusX, sy);
  }
  if (battleCryTimer > 0) {
    ctx.font = `bold 9px ${F}`; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,190,30,0.95)';
    ctx.fillText('⚔ КЛИЧ ' + Math.ceil(battleCryTimer) + 'с', statusX, sy);
  }

  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  MINI-MAP
// ─────────────────────────────────────────────────────────
function drawMinimap() {
  const th = getTheme(dungeonLvl);
  const sc = 1.5;

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
  const border = 4, r = 6;

  // Panel background
  ctx.fillStyle = 'rgba(8,6,20,0.92)';
  roundRect(ctx, mx - border, my - border, mmW + border * 2, mmH + border * 2, r); ctx.fill();
  ctx.strokeStyle = 'rgba(80,50,160,0.55)'; ctx.lineWidth = 1.5;
  roundRect(ctx, mx - border, my - border, mmW + border * 2, mmH + border * 2, r); ctx.stroke();
  // Inner line
  ctx.strokeStyle = 'rgba(120,80,220,0.12)'; ctx.lineWidth = 1;
  roundRect(ctx, mx - border + 1, my - border + 1, mmW + border * 2 - 2, mmH + border * 2 - 2, r - 1); ctx.stroke();

  // Clip to map area
  ctx.save();
  ctx.beginPath();
  roundRect(ctx, mx, my, mmW, mmH, 3);
  ctx.clip();
  ctx.drawImage(minimapCache, mx, my);
  ctx.restore();

  // Player dot
  const px2 = mx + (player.x / TILE) * sc, py2 = my + (player.y / TILE) * sc;
  ctx.fillStyle = 'rgba(0,255,80,0.25)';
  ctx.beginPath(); ctx.arc(px2, py2, 5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#00ff50';
  ctx.beginPath(); ctx.arc(px2, py2, 2.5, 0, Math.PI * 2); ctx.fill();

  const mmEnemies = (typeof socket !== 'undefined' && socket?.connected) ? serverEnemies : enemies;
  ctx.fillStyle = '#ff3322';
  mmEnemies.forEach(e => {
    ctx.beginPath(); ctx.arc(mx + (e.x / TILE) * sc, my + (e.y / TILE) * sc, 1.5, 0, Math.PI * 2); ctx.fill();
  });

  ctx.fillStyle = '#ffcc00';
  npcs.forEach(n => {
    ctx.beginPath(); ctx.arc(mx + (n.x / TILE) * sc, my + (n.y / TILE) * sc, 2, 0, Math.PI * 2); ctx.fill();
  });
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
//  SKILL BUTTONS (2×2 grid)
// ─────────────────────────────────────────────────────────
function drawSkillButtons() {
  if (!player) return;
  const skills = SKILL_DEF[player.type];
  if (!skills) return;
  const F = 'system-ui, -apple-system, Arial';

  for (let i = 0; i < 4; i++) {
    const sk = skills[i];
    const b = getSkillBtnPos(i);
    const cd = player.skillCooldowns[sk.key] || 0;
    const ready = cd <= 0;
    const isFlash = skillFlash && skillFlash.key === sk.key && skillFlash.timer > 0;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;

    ctx.save();

    // Background gradient
    const bgG = ctx.createLinearGradient(b.x, b.y, b.x, b.y + b.h);
    if (isFlash) {
      bgG.addColorStop(0, 'rgba(80,60,10,0.97)');
      bgG.addColorStop(1, 'rgba(40,30,5,0.99)');
    } else if (ready) {
      bgG.addColorStop(0, 'rgba(18,14,40,0.97)');
      bgG.addColorStop(1, 'rgba(8,6,20,0.99)');
    } else {
      bgG.addColorStop(0, 'rgba(10,8,22,0.97)');
      bgG.addColorStop(1, 'rgba(5,4,12,0.99)');
    }
    ctx.fillStyle = bgG;
    roundRect(ctx, b.x, b.y, b.w, b.h, 11); ctx.fill();

    // Border
    ctx.lineWidth = 1.5;
    if (isFlash) {
      ctx.strokeStyle = 'rgba(255,200,50,0.95)';
    } else if (ready) {
      ctx.strokeStyle = 'rgba(75,110,220,0.7)';
    } else {
      ctx.strokeStyle = 'rgba(35,30,65,0.7)';
    }
    roundRect(ctx, b.x, b.y, b.w, b.h, 11); ctx.stroke();

    // Inner glow line when ready
    if (ready && !isFlash) {
      ctx.strokeStyle = 'rgba(100,140,255,0.15)'; ctx.lineWidth = 1;
      roundRect(ctx, b.x + 1.5, b.y + 1.5, b.w - 3, b.h - 3, 10); ctx.stroke();
    }

    // Cooldown dark overlay
    if (!ready) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      roundRect(ctx, b.x, b.y, b.w, b.h, 11); ctx.fill();
    }

    // Emoji
    ctx.globalAlpha = ready ? 1 : 0.45;
    ctx.font = `24px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(sk.emoji, cx, cy - 7);

    // Key badge
    ctx.globalAlpha = 1;
    ctx.font = `bold 9px ${F}`; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'center';
    ctx.fillStyle = ready ? 'rgba(200,210,255,0.85)' : 'rgba(80,80,100,0.7)';
    ctx.fillText(sk.key, cx, b.y + b.h - 6);

    // Cooldown overlay number
    if (!ready) {
      ctx.font = `bold 14px ${F}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
      ctx.fillStyle = '#fff';
      ctx.fillText(cd >= 10 ? Math.ceil(cd) : cd.toFixed(1), cx, cy - 7);
    }

    ctx.restore();
  }
}

// ─────────────────────────────────────────────────────────
//  POTION BUTTON
// ─────────────────────────────────────────────────────────
function drawPotionButton() {
  if (!player) return;
  const pb = getPotionBtnPos();
  const count = player.potions || 0;
  const ready = count > 0 && player.hp < player.maxHp;
  const F = 'system-ui, -apple-system, Arial';

  ctx.save();

  // Circle background
  const cg = ctx.createRadialGradient(pb.x - 5, pb.y - 5, 2, pb.x, pb.y, pb.r);
  if (ready) { cg.addColorStop(0, 'rgba(20,70,35,0.98)'); cg.addColorStop(1, 'rgba(8,30,15,0.99)'); }
  else        { cg.addColorStop(0, 'rgba(16,12,32,0.98)'); cg.addColorStop(1, 'rgba(8,6,18,0.99)'); }
  ctx.fillStyle = cg;
  ctx.beginPath(); ctx.arc(pb.x, pb.y, pb.r, 0, Math.PI * 2); ctx.fill();

  ctx.strokeStyle = ready ? 'rgba(60,200,90,0.75)' : 'rgba(50,40,90,0.6)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(pb.x, pb.y, pb.r, 0, Math.PI * 2); ctx.stroke();
  if (ready) {
    ctx.strokeStyle = 'rgba(80,220,110,0.15)'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(pb.x, pb.y, pb.r + 2, 0, Math.PI * 2); ctx.stroke();
  }

  ctx.globalAlpha = ready ? 1 : 0.45;
  ctx.font = `18px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('🧪', pb.x, pb.y - 5);

  ctx.globalAlpha = 1;
  ctx.font = `bold 10px ${F}`; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = ready ? '#3ef07a' : 'rgba(100,100,130,0.7)';
  ctx.fillText('×' + count, pb.x, pb.y + pb.r - 3);

  ctx.font = `7px ${F}`; ctx.fillStyle = 'rgba(120,120,150,0.55)';
  ctx.fillText('[F]', pb.x, pb.y + pb.r + 10);

  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  TARGET BUTTON
// ─────────────────────────────────────────────────────────
function drawTargetButton() {
  if (!player) return;
  const tb = getTargetBtnPos();
  const F = 'system-ui, -apple-system, Arial';
  const hasTarget = !!targetId;

  ctx.save();

  const cg = ctx.createRadialGradient(tb.x - 4, tb.y - 4, 2, tb.x, tb.y, tb.r);
  if (hasTarget) { cg.addColorStop(0, 'rgba(55,10,10,0.98)'); cg.addColorStop(1, 'rgba(25,5,5,0.99)'); }
  else           { cg.addColorStop(0, 'rgba(16,12,32,0.98)'); cg.addColorStop(1, 'rgba(8,6,18,0.99)'); }
  ctx.fillStyle = cg;
  ctx.beginPath(); ctx.arc(tb.x, tb.y, tb.r, 0, Math.PI * 2); ctx.fill();

  ctx.strokeStyle = hasTarget ? 'rgba(255,60,60,0.85)' : 'rgba(70,55,120,0.6)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(tb.x, tb.y, tb.r, 0, Math.PI * 2); ctx.stroke();
  if (hasTarget) {
    ctx.strokeStyle = 'rgba(255,60,60,0.15)'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(tb.x, tb.y, tb.r + 2, 0, Math.PI * 2); ctx.stroke();
  }

  ctx.font = `16px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('🎯', tb.x, tb.y - 5);

  ctx.font = `bold 8px ${F}`; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = hasTarget ? 'rgba(255,140,140,0.9)' : 'rgba(130,120,170,0.7)';
  ctx.fillText('ЦЕЛЬ', tb.x, tb.y + tb.r - 3);

  ctx.font = `7px ${F}`; ctx.fillStyle = 'rgba(120,120,150,0.55)';
  ctx.fillText('[Tab]', tb.x, tb.y + tb.r + 10);

  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  PK / МИР BUTTON
// ─────────────────────────────────────────────────────────
function drawPvpButton() {
  if (!player) return;
  const pb = getPvpBtnPos();
  const F = 'system-ui, -apple-system, Arial';

  ctx.save();

  const bg = ctx.createLinearGradient(pb.x, pb.y, pb.x, pb.y + pb.h);
  if (pvpMode) {
    bg.addColorStop(0, 'rgba(70,10,10,0.98)');
    bg.addColorStop(1, 'rgba(35,5,5,0.99)');
  } else {
    bg.addColorStop(0, 'rgba(16,12,32,0.97)');
    bg.addColorStop(1, 'rgba(8,6,18,0.99)');
  }
  ctx.fillStyle = bg;
  roundRect(ctx, pb.x, pb.y, pb.w, pb.h, 9); ctx.fill();

  ctx.strokeStyle = pvpMode ? 'rgba(240,60,60,0.85)' : 'rgba(70,100,210,0.55)';
  ctx.lineWidth = 1.5;
  roundRect(ctx, pb.x, pb.y, pb.w, pb.h, 9); ctx.stroke();

  if (pvpMode) {
    ctx.strokeStyle = 'rgba(240,60,60,0.12)'; ctx.lineWidth = 4;
    roundRect(ctx, pb.x - 2, pb.y - 2, pb.w + 4, pb.h + 4, 11); ctx.stroke();
  }

  ctx.font = `bold 11px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = pvpMode ? '#ff7070' : 'rgba(130,170,240,0.9)';
  ctx.fillText(pvpMode ? '⚔ ПК' : '🕊 Мир', pb.x + pb.w / 2, pb.y + pb.h / 2);

  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  TARGET FRAME
// ─────────────────────────────────────────────────────────
function drawTargetFrame() {
  if (!targetId || !player) return;
  const isOnline = !!(socket?.connected);
  const activeEnemies = isOnline ? serverEnemies : enemies;

  let name = '', hp = 0, maxHp = 1, color = '#f80';
  if (targetIsPlayer && isOnline) {
    const op = otherPlayers[targetId];
    if (!op) return;
    name = op.username || '?';
    hp = op.hp || 0; maxHp = op.maxHp || 1; color = '#ff8888';
  } else {
    const e = activeEnemies.find(e => e.id === targetId);
    if (!e) return;
    name = e.name || '?';
    hp = Math.max(0, e.hp || 0); maxHp = e.maxHp || 1; color = e.color || '#f80';
  }

  const pb = getPvpBtnPos();
  const bx = pb.x, by = pb.y + pb.h + 8;
  const bw = 155, bh = 38;
  const F = 'system-ui, -apple-system, Arial';
  const pct = Math.max(0, Math.min(1, hp / maxHp));

  ctx.save();

  const bg = ctx.createLinearGradient(bx, by, bx, by + bh);
  bg.addColorStop(0, 'rgba(14,9,28,0.97)');
  bg.addColorStop(1, 'rgba(7,5,16,0.99)');
  ctx.fillStyle = bg;
  roundRect(ctx, bx, by, bw, bh, 9); ctx.fill();

  ctx.strokeStyle = 'rgba(200,55,55,0.6)'; ctx.lineWidth = 1.5;
  roundRect(ctx, bx, by, bw, bh, 9); ctx.stroke();
  ctx.strokeStyle = 'rgba(220,80,80,0.1)'; ctx.lineWidth = 1;
  roundRect(ctx, bx + 1.5, by + 1.5, bw - 3, bh - 3, 8); ctx.stroke();

  ctx.font = `bold 10px ${F}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = color;
  ctx.fillText('🎯 ' + name.slice(0, 16), bx + 8, by + 15);

  const hbx = bx + 8, hby = by + 20, hbw = bw - 16, hbh = 10;
  ctx.fillStyle = 'rgba(40,10,10,0.9)';
  roundRect(ctx, hbx, hby, hbw, hbh, 4); ctx.fill();
  if (pct > 0) {
    const hg = ctx.createLinearGradient(hbx, 0, hbx + hbw, 0);
    if (pct > 0.5) { hg.addColorStop(0, '#0c5a22'); hg.addColorStop(1, '#1ec95a'); }
    else if (pct > 0.25) { hg.addColorStop(0, '#7a4200'); hg.addColorStop(1, '#f0921a'); }
    else { hg.addColorStop(0, '#6b0c0c'); hg.addColorStop(1, '#e03030'); }
    ctx.fillStyle = hg;
    roundRect(ctx, hbx, hby, hbw * pct, hbh, 4); ctx.fill();
    const shine = ctx.createLinearGradient(0, hby, 0, hby + 4);
    shine.addColorStop(0, 'rgba(255,255,255,0.15)'); shine.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = shine;
    roundRect(ctx, hbx, hby, hbw * pct, hbh * 0.45, 4); ctx.fill();
  }
  ctx.font = `bold 7.5px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillText(Math.ceil(hp) + ' / ' + maxHp, hbx + hbw / 2, hby + hbh / 2);

  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  DEAD SCREEN
// ─────────────────────────────────────────────────────────
function drawDead() {
  ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillRect(0, 0, W, H);
}
