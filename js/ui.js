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
  const pw = 196, ph = 82;
  const F = 'system-ui, -apple-system, Arial';

  ctx.save();

  // Background
  ctx.fillStyle = 'rgba(5,3,16,0.93)';
  roundRect(ctx, pad, pad, pw, ph, 10); ctx.fill();
  ctx.strokeStyle = 'rgba(75,45,145,0.7)'; ctx.lineWidth = 1.5;
  roundRect(ctx, pad, pad, pw, ph, 10); ctx.stroke();

  const bx = pad + 9, bw = pw - 18;

  // ── Character row ──
  const cy = pad + 17;
  ctx.font = `15px ${F}`; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff';
  ctx.fillText(p.charDef.emoji, pad + 9, cy);

  ctx.fillStyle = p.charDef.color;
  ctx.font = `bold 12px ${F}`; ctx.textAlign = 'left';
  ctx.fillText(p.charDef.name, pad + 32, cy - 4);

  ctx.font = `10px ${F}`; ctx.fillStyle = 'rgba(190,155,255,0.9)';
  ctx.fillText('Ур. ' + p.lvl, pad + 32, cy + 6);

  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(150,120,210,0.85)';
  ctx.font = `bold 10px ${F}`;
  ctx.fillText('Этаж ' + dungeonLvl, pad + pw - 8, cy - 4);
  ctx.fillStyle = 'rgba(110,90,170,0.7)';
  ctx.font = `9px ${F}`;
  ctx.fillText(getTheme(dungeonLvl).name, pad + pw - 8, cy + 6);

  // ── HP bar ──
  const hpy = pad + 35;
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(245,110,110,1)';
  ctx.font = `bold 9px ${F}`;
  ctx.fillText('HP', bx, hpy);

  const hpBarX = bx + 20, hpBarW = bw - 20, hpBarH = 11;
  const hpPct = Math.max(0, Math.min(1, p.hp / p.maxHp));

  ctx.fillStyle = 'rgba(45,8,8,0.9)';
  roundRect(ctx, hpBarX, hpy - 9, hpBarW, hpBarH, 4); ctx.fill();

  if (hpPct > 0) {
    const hg = ctx.createLinearGradient(hpBarX, 0, hpBarX + hpBarW * hpPct, 0);
    if (hpPct > 0.5) { hg.addColorStop(0, '#1c8c3c'); hg.addColorStop(1, '#44ee77'); }
    else if (hpPct > 0.25) { hg.addColorStop(0, '#9c7020'); hg.addColorStop(1, '#ffcc44'); }
    else { hg.addColorStop(0, '#8c1c1c'); hg.addColorStop(1, '#ff4444'); }
    ctx.fillStyle = hg;
    roundRect(ctx, hpBarX, hpy - 9, hpBarW * hpPct, hpBarH, 4); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.13)';
    roundRect(ctx, hpBarX, hpy - 9, hpBarW * hpPct, 4, 3); ctx.fill();
  }

  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.font = `bold 8px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(Math.ceil(p.hp) + ' / ' + p.maxHp, hpBarX + hpBarW / 2, hpy - 3.5);

  // ── XP bar ──
  const xpy = pad + 51;
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(120,120,240,0.95)';
  ctx.font = `bold 9px ${F}`;
  ctx.fillText('XP', bx, xpy);

  const xpBarX = bx + 20, xpBarW = bw - 20, xpBarH = 7;
  const xpPct = Math.min(1, p.xp / p.xpNext);

  ctx.fillStyle = 'rgba(6,6,32,0.88)';
  roundRect(ctx, xpBarX, xpy - 6, xpBarW, xpBarH, 3); ctx.fill();

  if (xpPct > 0) {
    const xg = ctx.createLinearGradient(xpBarX, 0, xpBarX + xpBarW * xpPct, 0);
    xg.addColorStop(0, '#2233aa'); xg.addColorStop(1, '#7766ff');
    ctx.fillStyle = xg;
    roundRect(ctx, xpBarX, xpy - 6, xpBarW * xpPct, xpBarH, 3); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    roundRect(ctx, xpBarX, xpy - 6, xpBarW * xpPct, 3, 2); ctx.fill();
  }

  ctx.fillStyle = 'rgba(180,180,255,0.75)';
  ctx.font = `8px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(p.xp + ' / ' + p.xpNext, xpBarX + xpBarW / 2, xpy - 2.5);

  // ── Stats row ──
  const sy = pad + 71;
  ctx.strokeStyle = 'rgba(55,35,100,0.35)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(bx, sy - 8); ctx.lineTo(bx + bw, sy - 8); ctx.stroke();

  const stats = [
    { icon: '💰', val: p.gold, color: '#ffd040', xFrac: 0    },
    { icon: '⚔',  val: p.atk,  color: '#ff9966', xFrac: 0.37 },
    { icon: '🛡',  val: p.def,  color: '#8899ff', xFrac: 0.68 },
  ];

  ctx.textBaseline = 'middle';
  stats.forEach(s => {
    const sx2 = bx + s.xFrac * bw;
    ctx.font = `12px ${F}`; ctx.textAlign = 'left'; ctx.fillStyle = '#ccc';
    ctx.fillText(s.icon, sx2, sy);
    ctx.fillStyle = s.color; ctx.font = `bold 11px ${F}`;
    ctx.fillText(s.val, sx2 + 16, sy);
  });

  // Barrier / battle cry indicators
  if (barrierTimer > 0) {
    ctx.fillStyle = 'rgba(200,150,255,0.85)';
    ctx.font = `bold 9px ${F}`; ctx.textAlign = 'right';
    ctx.fillText('🔮 ' + Math.ceil(barrierTimer) + 'с', pad + pw - 8, pad + ph - 5);
  }
  if (battleCryTimer > 0) {
    ctx.fillStyle = 'rgba(255,180,0,0.85)';
    ctx.font = `bold 9px ${F}`; ctx.textAlign = 'right';
    ctx.fillText('⚔ КЛИЧ ' + Math.ceil(battleCryTimer) + 'с', pad + pw - 8, pad + ph - 5);
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
  ctx.fillStyle = 'rgba(0,0,0,.75)'; ctx.fillRect(mx - 2, my - 2, mmW + 4, mmH + 4);
  ctx.strokeStyle = 'rgba(80,50,140,0.5)'; ctx.lineWidth = 1;
  ctx.strokeRect(mx - 2, my - 2, mmW + 4, mmH + 4);
  ctx.drawImage(minimapCache, mx, my);
  ctx.fillStyle = '#0f0'; ctx.fillRect(mx + (player.x / TILE) * sc - 2, my + (player.y / TILE) * sc - 2, 4, 4);
  const mmEnemies = (typeof socket !== 'undefined' && socket?.connected) ? serverEnemies : enemies;
  ctx.fillStyle = '#f00';
  mmEnemies.forEach(e => ctx.fillRect(mx + (e.x / TILE) * sc - 1, my + (e.y / TILE) * sc - 1, 2, 2));
  // NPC blips
  ctx.fillStyle = '#fc0';
  npcs.forEach(n => ctx.fillRect(mx + (n.x / TILE) * sc - 2, my + (n.y / TILE) * sc - 2, 3, 3));
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
//  SKILL BUTTONS (LoL-style 2×2)
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

    ctx.save();
    ctx.globalAlpha = ready ? 0.88 : 0.55;

    // Background
    ctx.fillStyle = isFlash ? 'rgba(255,200,50,0.35)' : 'rgba(8,6,20,0.88)';
    roundRect(ctx, b.x, b.y, b.w, b.h, 10); ctx.fill();

    ctx.strokeStyle = ready
      ? (isFlash ? 'rgba(255,200,50,0.9)' : 'rgba(80,120,220,0.8)')
      : 'rgba(40,40,80,0.6)';
    ctx.lineWidth = 1.5;
    roundRect(ctx, b.x, b.y, b.w, b.h, 10); ctx.stroke();

    // Cooldown overlay
    if (!ready) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      roundRect(ctx, b.x, b.y, b.w, b.h, 10); ctx.fill();
    }

    // Emoji icon
    ctx.globalAlpha = 1;
    ctx.font = `22px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(sk.emoji, b.x + b.w / 2, b.y + b.h / 2 - 6);

    // Key label
    ctx.font = `bold 9px ${F}`; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = ready ? '#fff' : '#666';
    ctx.fillText('[' + sk.key + ']', b.x + b.w / 2, b.y + b.h - 6);

    // Cooldown number
    if (!ready) {
      ctx.font = `bold 13px ${F}`; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      ctx.fillText(Math.ceil(cd), b.x + b.w / 2, b.y + b.h / 2 - 6);
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
  ctx.globalAlpha = ready ? 0.88 : 0.50;

  // Circle background
  ctx.fillStyle = ready ? 'rgba(20,60,30,0.9)' : 'rgba(8,6,20,0.85)';
  ctx.beginPath(); ctx.arc(pb.x, pb.y, pb.r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = ready ? 'rgba(80,200,100,0.8)' : 'rgba(40,60,40,0.5)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(pb.x, pb.y, pb.r, 0, Math.PI * 2); ctx.stroke();

  // Flask emoji
  ctx.globalAlpha = 1;
  ctx.font = `18px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('🧪', pb.x, pb.y - 5);

  // Count badge
  ctx.font = `bold 10px ${F}`; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = ready ? '#4f4' : '#666';
  ctx.fillText('×' + count, pb.x, pb.y + pb.r - 3);

  // Key hint
  ctx.font = `8px ${F}`; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(150,150,150,0.6)';
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
  ctx.globalAlpha = 0.88;

  ctx.fillStyle = hasTarget ? 'rgba(40,8,8,0.92)' : 'rgba(8,6,20,0.85)';
  ctx.beginPath(); ctx.arc(tb.x, tb.y, tb.r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = hasTarget ? 'rgba(255,60,60,0.9)' : 'rgba(80,60,120,0.6)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(tb.x, tb.y, tb.r, 0, Math.PI * 2); ctx.stroke();

  ctx.globalAlpha = 1;
  ctx.font = `16px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('🎯', tb.x, tb.y - 5);

  ctx.font = `bold 8px ${F}`; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = hasTarget ? '#f88' : '#888';
  ctx.fillText('ЦЕЛЬ', tb.x, tb.y + tb.r - 3);

  ctx.font = `7px ${F}`; ctx.fillStyle = 'rgba(150,150,150,0.6)';
  ctx.fillText('[Tab]', tb.x, tb.y + tb.r + 10);

  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  PvP BUTTON
// ─────────────────────────────────────────────────────────
function drawPvpButton() {
  if (!player) return;
  const pb = getPvpBtnPos();
  const F = 'system-ui, -apple-system, Arial';

  ctx.save();

  ctx.fillStyle = pvpMode ? 'rgba(60,8,8,0.94)' : 'rgba(8,6,20,0.88)';
  roundRect(ctx, pb.x, pb.y, pb.w, pb.h, 8); ctx.fill();
  ctx.strokeStyle = pvpMode ? 'rgba(255,60,60,0.85)' : 'rgba(60,120,200,0.55)';
  ctx.lineWidth = 1.5;
  roundRect(ctx, pb.x, pb.y, pb.w, pb.h, 8); ctx.stroke();

  ctx.font = `bold 11px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = pvpMode ? '#ff7070' : '#7aaaee';
  ctx.fillText(pvpMode ? '⚔ PvP' : '🕊 Мир', pb.x + pb.w / 2, pb.y + pb.h / 2);

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
    if (!op || (op.hp || 0) <= 0) { targetId = null; targetIsPlayer = false; return; }
    name = op.username || '?';
    hp = op.hp || 0; maxHp = op.maxHp || 1; color = '#f77';
  } else {
    const e = activeEnemies.find(e => e.id === targetId);
    if (!e || (e.hp || 0) <= 0) { targetId = null; targetIsPlayer = false; return; }
    name = e.name || '?';
    hp = e.hp || 0; maxHp = e.maxHp || 1; color = e.color || '#f80';
  }

  const pb = getPvpBtnPos();
  const bx = pb.x, by = pb.y + pb.h + 6;
  const bw = 150, bh = 34;
  const F = 'system-ui, -apple-system, Arial';

  ctx.save();

  ctx.fillStyle = 'rgba(5,3,16,0.92)';
  roundRect(ctx, bx, by, bw, bh, 8); ctx.fill();
  ctx.strokeStyle = `rgba(200,60,60,0.65)`; ctx.lineWidth = 1.5;
  roundRect(ctx, bx, by, bw, bh, 8); ctx.stroke();

  ctx.font = `bold 10px ${F}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = color;
  ctx.fillText('🎯 ' + name.slice(0, 16), bx + 8, by + 14);

  const hbx = bx + 8, hby = by + 19, hbw = bw - 16, hbh = 9;
  const pct = Math.max(0, Math.min(1, hp / maxHp));
  ctx.fillStyle = 'rgba(50,10,10,0.85)';
  roundRect(ctx, hbx, hby, hbw, hbh, 3); ctx.fill();
  if (pct > 0) {
    ctx.fillStyle = pct > 0.5 ? '#2d2' : pct > 0.25 ? '#da2' : '#d22';
    roundRect(ctx, hbx, hby, hbw * pct, hbh, 3); ctx.fill();
  }
  ctx.font = `bold 8px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.fillText(Math.ceil(hp) + ' / ' + maxHp, hbx + hbw / 2, hby + hbh / 2);

  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  DEAD SCREEN
// ─────────────────────────────────────────────────────────
function drawDead() {
  ctx.fillStyle = 'rgba(0,0,0,.8)'; ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const F = 'system-ui, -apple-system, Arial';
  ctx.fillStyle = '#f44'; ctx.font = `bold ${clamp(32, W * .09, 54)}px ${F}`; ctx.fillText('ВЫ ПОГИБЛИ', W / 2, H / 2 - 50);
  ctx.fillStyle = '#777'; ctx.font = `${clamp(14, W * .04, 20)}px ${F}`;
  ctx.fillText(`${getTheme(dungeonLvl).name} · Этаж ${dungeonLvl}`, W / 2, H / 2 + 5);
  ctx.fillStyle = '#ff0'; ctx.fillText(`Золото: ${player.gold}  •  Убито: ${player.kills}`, W / 2, H / 2 + 38);
  ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.font = `${clamp(13, W * .034, 17)}px ${F}`;
  ctx.fillText('Нажмите, чтобы начать снова', W / 2, H / 2 + 84);
}
