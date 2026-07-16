// ─────────────────────────────────────────────────────────
//  PANEL UIs
// ─────────────────────────────────────────────────────────
function updateInvUI() {
  if (!player) return;
  const p = player;
  const inv = p.inventory;

  // Equipment grid (5 columns × 2 rows)
  document.getElementById('eq-grid').innerHTML = EQ_SLOTS.map(({ slot, label, emptyIcon }) => {
    const it = p.equipment[slot];
    const rc = it ? (RARITY_COLOR[it.rarity] || '#aaa') : '';
    return `<div class="eq-cell${it ? ' filled' : ''}" onclick="${it ? `unequipItem('${slot}')` : ''}"
      title="${it ? it.name + ' — ' + statStr(it) : label}"
      style="${it ? 'border-color:' + rc + '55' : ''}">
      <div class="cell-icon">${it ? iconHTML(it.icon, 22, rc) : iconHTML(emptyIcon, 22, '#505070')}</div>
      <div class="cell-lbl" style="${it ? 'color:' + rc : ''}">${it ? it.name.slice(0, 8) : label}</div>
    </div>`;
  }).join('');

  // Character preview
  document.getElementById('char-preview').innerHTML = `
    <div class="inv-char-row">
      <div style="line-height:1">${iconHTML(p.charDef.icon, 40, p.charDef.color)}</div>
      <div style="flex:1">
        <div style="font-size:14px;font-weight:bold;color:${p.charDef.color}">${p.charDef.name}</div>
        <div style="font-size:11px;color:#555;margin-top:2px">Уровень ${p.lvl}</div>
        <div style="font-size:11px;color:#484860;margin-top:2px;display:flex;align-items:center;gap:3px">
          ${iconHTML('heart',11,'#e74c3c')}${Math.ceil(p.hp)}/${p.maxHp} ·
          ${iconHTML('sword',11,'#e67e22')}${p.atk} ·
          ${iconHTML('shield',11,'#5dade2')}${p.def} ·
          ${iconHTML('coin',11,'#f1c40f')}${p.gold}
        </div>
      </div>
      <div style="color:#f96;text-align:right;font-weight:bold;display:flex;align-items:center;gap:2px">${iconHTML('potion',16,'#3ef07a')}×${p.potions || 0}</div>
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
      ${it ? `<div style="display:flex;justify-content:center;align-items:center">${iconHTML(it.icon,18,rc)}</div>
              <div style="font-size:7px;color:${rc};text-align:center;margin-top:1px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${it.name.slice(0,8)}</div>` : ''}
    </div>`;
  }).join('');
}

function updateProfileUI() {
  if (!player) return;
  const p = player, d = p.charDef;
  const th = getTheme(dungeonLvl);
  const pct = Math.floor(p.xp / p.xpNext * 100);
  const fmt1 = v => (v * 100).toFixed(1) + '%';
  document.getElementById('profile-body').innerHTML = `
    <div class="prof-hero">
      <div class="prof-emoji">${iconHTML(d.icon, 40, d.color)}</div>
      <div>
        <div class="prof-cls" style="color:${d.color}">${d.name}</div>
        <div class="prof-lvl">Уровень ${p.lvl} · ${th.name}</div>
      </div>
    </div>
    <div class="xp-lbl">Опыт: ${p.xp} / ${p.xpNext}</div>
    <div class="xp-bg"><div class="xp-fill" style="width:${pct}%"></div></div>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-ic">${iconHTML('heart',14,'#e74c3c')}</div><div class="stat-vl">${Math.ceil(p.hp)}</div><div class="stat-nm">HP</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('sword',14,'#e67e22')}</div><div class="stat-vl">${p.atk}</div><div class="stat-nm">Атака</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('shield',14,'#5dade2')}</div><div class="stat-vl">${p.def}</div><div class="stat-nm">Защита</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('lightning',14,'#f1c40f')}</div><div class="stat-vl">${p.atkSpeed.toFixed(2)}</div><div class="stat-nm">Скор. ат.</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('star',14,'#e74c3c')}</div><div class="stat-vl">${fmt1(p.critChance)}</div><div class="stat-nm">Крит шанс</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('flame',14,'#e67e22')}</div><div class="stat-vl">${p.critPower.toFixed(2)}x</div><div class="stat-nm">Крит сила</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('wind',14,'#95a5a6')}</div><div class="stat-vl">${fmt1(p.dodge)}</div><div class="stat-nm">Уворот</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('crosshair',14,'#3498db')}</div><div class="stat-vl">${fmt1(p.accuracy)}</div><div class="stat-nm">Точность</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('drop',14,'#e74c3c')}</div><div class="stat-vl">${fmt1(p.lifeSteal)}</div><div class="stat-nm">Вампиризм</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('hpPlus',14,'#2ecc71')}</div><div class="stat-vl">${p.hpRegen.toFixed(2)}</div><div class="stat-nm">HP реген</div></div>
    </div>`;
  updateUpgradeUI();
}

function updateUpgradeUI() {
  if (!player) return;
  const el = document.getElementById('upgrade-grid');
  if (!el) return;
  const goldLbl = document.getElementById('upg-gold-lbl');
  if (goldLbl) goldLbl.innerHTML = iconHTML('coin', 14, '#f1c40f') + ' ' + player.gold;
  const u = player.upgrades || {};
  el.innerHTML = Object.entries(UPGRADE_DEF).map(([key, cfg]) => {
    const lvl  = u[key] || 0;
    const cost = Math.floor(cfg.baseCost * Math.pow(1.4, lvl));
    const can  = player.gold >= cost;
    return `<div class="upg-row">
      <div class="upg-info">
        <span class="upg-label">${iconHTML(cfg.icon, 14, '#9090bb')} ${cfg.label}</span>
        <span class="upg-meta">Ур.${lvl} · ${cfg.desc}</span>
      </div>
      <button class="upg-btn${can ? '' : ' disabled'}" onclick="upgradeStats('${key}')">${iconHTML('coin',12,'#f1c40f')}${cost}</button>
    </div>`;
  }).join('');
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
    th.name + ' · Этаж ' + dungeonLvl + ' · Враги: ' + mapEnemies.length;
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
  const pid = ['', 'panel-inv', 'panel-map', 'panel-quests', 'panel-profile'][n];
  if (pid) {
    const el = document.getElementById(pid);
    el.style.display = 'block';
    requestAnimationFrame(() => { el.classList.add('open'); });
    if (n === 1) updateInvUI();
    if (n === 2) { updateFloorUI(); setTimeout(drawMapPanel, 320); }
    if (n === 3 && typeof updateQuestUI === 'function') updateQuestUI();
    if (n === 4) updateProfileUI();
  }
}

// ─────────────────────────────────────────────────────────
//  UNIFIED HEADER  (player info + minimap)
// ─────────────────────────────────────────────────────────
function drawHeader() {
  if (!player || !dungeon) return;
  const p = player;
  const F = 'system-ui, -apple-system, sans-serif';

  ctx.save();

  // ── Background ────────────────────────────────────────────
  const bgGrad = ctx.createLinearGradient(0, 0, 0, HEADER_H);
  bgGrad.addColorStop(0, 'rgba(11,7,26,0.98)');
  bgGrad.addColorStop(1, 'rgba(5,3,14,0.99)');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, HEADER_H);

  // Bottom separator glow
  const sepGrad = ctx.createLinearGradient(0, 0, W, 0);
  sepGrad.addColorStop(0,   'rgba(60,35,130,0)');
  sepGrad.addColorStop(0.15,'rgba(90,55,185,0.75)');
  sepGrad.addColorStop(0.85,'rgba(90,55,185,0.75)');
  sepGrad.addColorStop(1,   'rgba(60,35,130,0)');
  ctx.strokeStyle = sepGrad; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, HEADER_H - 0.5); ctx.lineTo(W, HEADER_H - 0.5); ctx.stroke();

  // ── Minimap (right side) ──────────────────────────────────
  const mmPad = 6;
  const mmH = HEADER_H - mmPad * 2;
  const mmW = Math.floor(Math.min(mmH * (dungeon.w / dungeon.h), W * 0.27));
  const mmX = W - mmW - mmPad - 4;
  const mmY = mmPad;
  const mmSc = mmW / dungeon.w;

  // Tile cache at DPR resolution for crisp rendering
  const th = getTheme(dungeonLvl);
  const mmCW = Math.round(mmW * DPR), mmCH = Math.round(mmH * DPR);
  const mmCSc = mmCW / dungeon.w;
  if (minimapCacheFloor !== dungeonLvl || !minimapCache ||
      minimapCache.width !== mmCW || minimapCache.height !== mmCH) {
    minimapCacheFloor = dungeonLvl;
    minimapCache = document.createElement('canvas');
    minimapCache.width = mmCW; minimapCache.height = mmCH;
    const mctx = minimapCache.getContext('2d');
    mctx.fillStyle = th.mmFloor;
    for (let ty = 0; ty < dungeon.h; ty++) {
      for (let tx = 0; tx < dungeon.w; tx++) {
        if (dungeon.grid[ty][tx] !== WALL) {
          mctx.fillRect(
            Math.floor(tx * mmCSc), Math.floor(ty * mmCSc),
            Math.max(1, Math.ceil(mmCSc)), Math.max(1, Math.ceil(mmCSc))
          );
        }
      }
    }
  }

  // Map panel border
  const mpX = mmX - 4, mpY = mmY - 4, mpW = mmW + 8, mpH = mmH + 8;
  ctx.fillStyle = 'rgba(5,3,16,0.92)';
  roundRect(ctx, mpX, mpY, mpW, mpH, 6); ctx.fill();
  ctx.strokeStyle = 'rgba(70,45,155,0.6)'; ctx.lineWidth = 1;
  roundRect(ctx, mpX, mpY, mpW, mpH, 6); ctx.stroke();

  // Clip, draw tiles and blips
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.beginPath(); roundRect(ctx, mmX, mmY, mmW, mmH, 3); ctx.clip();
  ctx.drawImage(minimapCache, mmX, mmY, mmW, mmH);

  const mmEnemies = socket?.connected ? serverEnemies : enemies;
  ctx.fillStyle = 'rgba(255,45,35,0.9)';
  mmEnemies.forEach(e => {
    if ((e.hp || 0) <= 0) return;
    ctx.beginPath();
    ctx.arc(mmX + (e.x / TILE) * mmSc, mmY + (e.y / TILE) * mmSc, Math.max(1, mmSc * 0.8), 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.fillStyle = 'rgba(255,200,0,0.9)';
  npcs.forEach(n => {
    ctx.beginPath();
    ctx.arc(mmX + (n.x / TILE) * mmSc, mmY + (n.y / TILE) * mmSc, Math.max(1, mmSc), 0, Math.PI * 2);
    ctx.fill();
  });
  if (socket?.connected) {
    ctx.fillStyle = 'rgba(100,180,255,0.9)';
    Object.values(otherPlayers).forEach(op => {
      if (op.x == null) return;
      ctx.beginPath();
      ctx.arc(mmX + (op.x / TILE) * mmSc, mmY + (op.y / TILE) * mmSc, Math.max(1.5, mmSc), 0, Math.PI * 2);
      ctx.fill();
    });
  }
  const pdx = mmX + (p.x / TILE) * mmSc, pdy = mmY + (p.y / TILE) * mmSc;
  ctx.fillStyle = 'rgba(0,255,80,0.25)';
  ctx.beginPath(); ctx.arc(pdx, pdy, 5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#00ff55';
  ctx.beginPath(); ctx.arc(pdx, pdy, 2.5, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // Floor label
  ctx.font = `bold 10px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillText('Эт.' + dungeonLvl, mmX + mmW / 2 + 1, mmY + mmH - 2);
  ctx.fillStyle = 'rgba(170,140,255,0.95)';
  ctx.fillText('Эт.' + dungeonLvl, mmX + mmW / 2, mmY + mmH - 3);

  // Vertical divider
  ctx.strokeStyle = 'rgba(70,45,130,0.3)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(mpX - 5, 5); ctx.lineTo(mpX - 5, HEADER_H - 5); ctx.stroke();

  // ── Avatar ────────────────────────────────────────────────
  const avX = 30, avY = HEADER_H / 2, avR = 18;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath(); ctx.arc(avX + 1, avY + 1, avR, 0, Math.PI * 2); ctx.fill();
  const avBg = ctx.createRadialGradient(avX - 5, avY - 5, 2, avX, avY, avR);
  avBg.addColorStop(0, p.charDef.color + '40');
  avBg.addColorStop(1, 'rgba(0,0,0,0.6)');
  ctx.fillStyle = avBg;
  ctx.beginPath(); ctx.arc(avX, avY, avR, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = p.charDef.color; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(avX, avY, avR, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = p.charDef.color + '33'; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.arc(avX, avY, avR + 3, 0, Math.PI * 2); ctx.stroke();
  drawIconCtx(ctx, p.charDef.icon, avX, avY + 1, 20, p.charDef.color);

  // ── Info area ─────────────────────────────────────────────
  const infoX = avX + avR + 9;
  const infoRight = mpX - 10;
  const infoW = infoRight - infoX;

  // Row 1: Name + Level
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left'; ctx.font = `bold 13px ${F}`; ctx.fillStyle = '#f0eeff';
  ctx.fillText((netUsername || p.charDef.name).slice(0, 15), infoX, 15);
  ctx.textAlign = 'right'; ctx.font = `bold 11px ${F}`; ctx.fillStyle = 'rgba(190,160,255,0.95)';
  ctx.fillText('Ур.' + p.lvl, infoRight, 15);

  // Row 2: Class + Theme
  ctx.textAlign = 'left'; ctx.font = `10px ${F}`; ctx.fillStyle = p.charDef.color + 'cc';
  ctx.fillText(p.charDef.name, infoX, 27);
  ctx.textAlign = 'right'; ctx.font = `10px ${F}`; ctx.fillStyle = 'rgba(120,95,195,0.85)';
  ctx.fillText(getTheme(dungeonLvl).name, infoRight, 27);

  // Separator
  ctx.strokeStyle = 'rgba(65,42,118,0.4)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(infoX, 32); ctx.lineTo(infoRight, 32); ctx.stroke();

  // ── HP bar ────────────────────────────────────────────────
  const hpY = 42, hbH = 9;
  const hpPct = Math.max(0, Math.min(1, p.hp / p.maxHp));
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.font = `bold 9px ${F}`; ctx.fillStyle = 'rgba(255,100,100,0.95)';
  ctx.fillText('HP', infoX, hpY);

  const hbX = infoX + 22, hbW = infoW - 22;
  ctx.fillStyle = 'rgba(35,10,10,0.92)';
  roundRect(ctx, hbX, hpY - hbH / 2, hbW, hbH, 4); ctx.fill();
  if (hpPct > 0) {
    const hg = ctx.createLinearGradient(hbX, 0, hbX + hbW, 0);
    if (hpPct > 0.5) { hg.addColorStop(0, '#0d5c28'); hg.addColorStop(1, '#2ecc71'); }
    else if (hpPct > 0.25) { hg.addColorStop(0, '#7a4400'); hg.addColorStop(1, '#f39c12'); }
    else { hg.addColorStop(0, '#6b0f0f'); hg.addColorStop(1, '#e74c3c'); }
    ctx.fillStyle = hg;
    roundRect(ctx, hbX, hpY - hbH / 2, hbW * hpPct, hbH, 4); ctx.fill();
    const hsh = ctx.createLinearGradient(0, hpY - hbH / 2, 0, hpY);
    hsh.addColorStop(0, 'rgba(255,255,255,0.2)'); hsh.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hsh;
    roundRect(ctx, hbX, hpY - hbH / 2, hbW * hpPct, hbH * 0.5, 4); ctx.fill();
    if (hpPct < 0.3) {
      ctx.save(); ctx.shadowColor = '#e74c3c'; ctx.shadowBlur = 7;
      ctx.strokeStyle = 'rgba(231,76,60,0.5)'; ctx.lineWidth = 1;
      roundRect(ctx, hbX, hpY - hbH / 2, hbW * hpPct, hbH, 4); ctx.stroke();
      ctx.restore();
    }
  }
  ctx.font = `8px ${F}`; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fillText(Math.ceil(p.hp) + '/' + p.maxHp, hbX + hbW / 2, hpY);

  // ── XP bar ────────────────────────────────────────────────
  const xpY = 55, xbH = 6;
  const xpPct = Math.min(1, p.xp / p.xpNext);
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.font = `bold 9px ${F}`; ctx.fillStyle = 'rgba(140,110,255,0.9)';
  ctx.fillText('XP', infoX, xpY);

  const xbX = infoX + 22, xbW = infoW - 22;
  ctx.fillStyle = 'rgba(8,6,25,0.9)';
  roundRect(ctx, xbX, xpY - xbH / 2, xbW, xbH, 3); ctx.fill();
  if (xpPct > 0) {
    const xg = ctx.createLinearGradient(xbX, 0, xbX + xbW, 0);
    xg.addColorStop(0, '#180f5a'); xg.addColorStop(1, '#7c4dff');
    ctx.fillStyle = xg;
    roundRect(ctx, xbX, xpY - xbH / 2, xbW * xpPct, xbH, 3); ctx.fill();
    const xsh = ctx.createLinearGradient(0, xpY - xbH / 2, 0, xpY);
    xsh.addColorStop(0, 'rgba(255,255,255,0.16)'); xsh.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = xsh;
    roundRect(ctx, xbX, xpY - xbH / 2, xbW * xpPct, xbH * 0.5, 3); ctx.fill();
  }
  ctx.font = `8px ${F}`; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(180,155,255,0.7)';
  ctx.fillText(p.xp + '/' + p.xpNext, xbX + xbW / 2, xpY);

  // ── Stats row ─────────────────────────────────────────────
  const stY = HEADER_H - 6;
  const statItems = [
    { icon: 'coin',   val: p.gold, color: '#f1c40f' },
    { icon: 'sword',  val: p.atk,  color: '#e67e22' },
    { icon: 'shield', val: p.def,  color: '#5dade2' },
  ];
  const statSlotW = infoW / 3;
  ctx.textBaseline = 'middle';
  statItems.forEach((s, i) => {
    const sx = infoX + i * statSlotW;
    drawIconCtx(ctx, s.icon, sx + 6, stY, 12, s.color);
    ctx.font = `bold 11px ${F}`; ctx.textAlign = 'left'; ctx.fillStyle = s.color;
    ctx.fillText(s.val, sx + 16, stY);
  });

  // Status effects
  if (barrierTimer > 0 || battleCryTimer > 0) {
    let stx = infoX + infoW * 0.55;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.font = `bold 9px ${F}`;
    if (barrierTimer > 0) {
      drawIconCtx(ctx, 'barrier', stx + 5, stY, 11, 'rgba(180,130,255,0.95)');
      ctx.fillStyle = 'rgba(180,130,255,0.95)';
      ctx.fillText(Math.ceil(barrierTimer) + 'с', stx + 14, stY); stx += 38;
    }
    if (battleCryTimer > 0) {
      drawIconCtx(ctx, 'battleCry', stx + 5, stY, 11, 'rgba(255,190,30,0.95)');
      ctx.fillStyle = 'rgba(255,190,30,0.95)';
      ctx.fillText(Math.ceil(battleCryTimer) + 'с', stx + 14, stY);
    }
  }

  ctx.restore();
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

    // Icon
    ctx.globalAlpha = ready ? 1 : 0.45;
    drawIconCtx(ctx, sk.icon, cx, cy - 7, 22, ready ? '#b0c4ff' : '#606080');

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
  drawIconCtx(ctx, 'potion', pb.x, pb.y - 5, 18, ready ? '#3ef07a' : '#606080');

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

  drawIconCtx(ctx, 'crosshair', tb.x, tb.y - 5, 16, hasTarget ? '#ff8888' : '#8880aa');

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

  const pvpLabel = pvpMode ? 'ПК' : 'Мир';
  const pvpColor = pvpMode ? '#ff7070' : 'rgba(130,170,240,0.9)';
  drawIconCtx(ctx, pvpMode ? 'pvpOn' : 'pvpOff', pb.x + pb.w / 2 - 14, pb.y + pb.h / 2, 12, pvpColor);
  ctx.font = `bold 11px ${F}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = pvpColor;
  ctx.fillText(pvpLabel, pb.x + pb.w / 2 - 5, pb.y + pb.h / 2);

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

  drawIconCtx(ctx, 'crosshair', bx + 14, by + 10, 10, color);
  ctx.font = `bold 10px ${F}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = color;
  ctx.fillText(name.slice(0, 16), bx + 22, by + 15);

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
//  ATTACK BUTTON (manual)
// ─────────────────────────────────────────────────────────
function drawAttackButton() {
  if (!player) return;
  const ab = getAttackBtnPos();
  const F = 'system-ui, -apple-system, Arial';
  const hasTarget = !!targetId;
  const ready = (player.atkTimer || 0) <= 0;

  ctx.save();
  const cg = ctx.createRadialGradient(ab.x - 6, ab.y - 6, 3, ab.x, ab.y, ab.r);
  if (hasTarget && ready) {
    cg.addColorStop(0, 'rgba(60,20,10,0.98)'); cg.addColorStop(1, 'rgba(28,8,5,0.99)');
  } else if (!autoAttackMode) {
    cg.addColorStop(0, 'rgba(18,14,40,0.98)'); cg.addColorStop(1, 'rgba(8,6,20,0.99)');
  } else {
    cg.addColorStop(0, 'rgba(12,10,28,0.90)'); cg.addColorStop(1, 'rgba(6,5,14,0.92)');
  }
  ctx.fillStyle = cg;
  ctx.beginPath(); ctx.arc(ab.x, ab.y, ab.r, 0, Math.PI * 2); ctx.fill();

  const borderColor = !autoAttackMode
    ? (hasTarget && ready ? 'rgba(255,120,60,0.9)' : 'rgba(80,100,220,0.7)')
    : 'rgba(50,40,90,0.45)';
  ctx.strokeStyle = borderColor; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(ab.x, ab.y, ab.r, 0, Math.PI * 2); ctx.stroke();
  if (!autoAttackMode && hasTarget && ready) {
    ctx.strokeStyle = 'rgba(255,100,50,0.15)'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(ab.x, ab.y, ab.r + 2, 0, Math.PI * 2); ctx.stroke();
  }

  ctx.globalAlpha = autoAttackMode ? 0.4 : 1;
  const iconColor = hasTarget && ready ? '#ff9060' : (autoAttackMode ? '#404060' : '#a0b4ff');
  drawIconCtx(ctx, 'sword', ab.x, ab.y - 5, 20, iconColor);

  ctx.globalAlpha = 1;
  ctx.font = `bold 8px ${F}`; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'center';
  ctx.fillStyle = autoAttackMode ? 'rgba(80,80,110,0.6)' : (hasTarget ? 'rgba(255,160,100,0.9)' : 'rgba(160,180,255,0.8)');
  ctx.fillText('АТК', ab.x, ab.y + ab.r - 3);
  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  AUTO / MANUAL TOGGLE
// ─────────────────────────────────────────────────────────
function drawAutoToggle() {
  if (!player) return;
  const ab = getAutoBtnPos();
  const F = 'system-ui, -apple-system, Arial';

  ctx.save();
  const bg = ctx.createLinearGradient(ab.x, ab.y, ab.x, ab.y + ab.h);
  if (autoAttackMode) {
    bg.addColorStop(0, 'rgba(10,35,15,0.95)'); bg.addColorStop(1, 'rgba(5,18,8,0.97)');
  } else {
    bg.addColorStop(0, 'rgba(35,15,5,0.95)'); bg.addColorStop(1, 'rgba(18,7,3,0.97)');
  }
  ctx.fillStyle = bg;
  roundRect(ctx, ab.x, ab.y, ab.w, ab.h, 8); ctx.fill();

  ctx.strokeStyle = autoAttackMode ? 'rgba(60,200,90,0.7)' : 'rgba(220,120,50,0.7)';
  ctx.lineWidth = 1.5;
  roundRect(ctx, ab.x, ab.y, ab.w, ab.h, 8); ctx.stroke();

  ctx.font = `bold 9px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = autoAttackMode ? '#3ef07a' : '#f09050';
  ctx.fillText(autoAttackMode ? 'АВТО' : 'РУЧ', ab.x + ab.w / 2, ab.y + ab.h / 2);
  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  PARTY BUTTON (invite / leave)
// ─────────────────────────────────────────────────────────
function drawPartyButton() {
  if (!player) return;
  const inParty = !!partyPartnerId;
  const canInvite = !inParty && targetIsPlayer && !!targetId;
  if (!inParty && !canInvite) return;

  const pb = getPartyBtnPos();
  const F = 'system-ui, -apple-system, Arial';
  ctx.save();

  const bg = ctx.createLinearGradient(pb.x, pb.y, pb.x, pb.y + pb.h);
  if (inParty) {
    bg.addColorStop(0, 'rgba(50,10,10,0.97)'); bg.addColorStop(1, 'rgba(25,5,5,0.99)');
  } else {
    bg.addColorStop(0, 'rgba(10,40,18,0.97)'); bg.addColorStop(1, 'rgba(5,20,9,0.99)');
  }
  ctx.fillStyle = bg;
  roundRect(ctx, pb.x, pb.y, pb.w, pb.h, 9); ctx.fill();

  ctx.strokeStyle = inParty ? 'rgba(220,60,60,0.8)' : 'rgba(60,200,90,0.8)';
  ctx.lineWidth = 1.5;
  roundRect(ctx, pb.x, pb.y, pb.w, pb.h, 9); ctx.stroke();

  const iconName = inParty ? 'partyLeave' : 'party';
  const color = inParty ? '#ff7070' : '#3ef07a';
  drawIconCtx(ctx, iconName, pb.x + 14, pb.y + pb.h / 2, 12, color);
  ctx.font = `bold 10px ${F}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(inParty ? 'Выйти' : 'Пати+', pb.x + 23, pb.y + pb.h / 2);

  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  PARTY HUD (partner HP bar)
// ─────────────────────────────────────────────────────────
function drawPartyHUD() {
  if (!partyPartnerId || !player) return;
  const op = otherPlayers[partyPartnerId];
  const hp = op ? (op.hp || 0) : 0;
  const maxHp = op ? (op.maxHp || 1) : 1;
  const name = partyPartnerName || '?';
  const pct = Math.max(0, Math.min(1, hp / maxHp));

  const pb = getPvpBtnPos();
  const partyBtn = getPartyBtnPos();
  const bx = partyBtn.x + partyBtn.w + 8;
  const by = pb.y;
  const bw = 130, bh = 26;
  const F = 'system-ui, -apple-system, Arial';

  ctx.save();
  const bg = ctx.createLinearGradient(bx, by, bx, by + bh);
  bg.addColorStop(0, 'rgba(8,30,14,0.97)'); bg.addColorStop(1, 'rgba(4,15,7,0.99)');
  ctx.fillStyle = bg;
  roundRect(ctx, bx, by, bw, bh, 8); ctx.fill();
  ctx.strokeStyle = 'rgba(60,180,80,0.55)'; ctx.lineWidth = 1.2;
  roundRect(ctx, bx, by, bw, bh, 8); ctx.stroke();

  drawIconCtx(ctx, 'party', bx + 11, by + bh / 2, 11, '#3ef07a');

  ctx.font = `bold 9px ${F}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#3ef07a';
  ctx.fillText(name.slice(0, 12), bx + 20, by + 10);

  const hbx = bx + 20, hby = by + 13, hbw = bw - 24, hbh = 8;
  ctx.fillStyle = 'rgba(10,30,10,0.9)';
  roundRect(ctx, hbx, hby, hbw, hbh, 3); ctx.fill();
  if (pct > 0) {
    const hg = ctx.createLinearGradient(hbx, 0, hbx + hbw, 0);
    if (pct > 0.5) { hg.addColorStop(0, '#0c5a22'); hg.addColorStop(1, '#1ec95a'); }
    else if (pct > 0.25) { hg.addColorStop(0, '#7a4200'); hg.addColorStop(1, '#f0921a'); }
    else { hg.addColorStop(0, '#6b0c0c'); hg.addColorStop(1, '#e03030'); }
    ctx.fillStyle = hg;
    roundRect(ctx, hbx, hby, hbw * pct, hbh, 3); ctx.fill();
  }
  ctx.font = `6.5px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  ctx.fillText(Math.ceil(hp) + '/' + maxHp, hbx + hbw / 2, hby + hbh / 2);

  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  PARTY INVITE POPUP
// ─────────────────────────────────────────────────────────
function drawPartyInvitePopup() {
  if (!partyInvitePending) return;
  const inv = partyInvitePending;
  const F = 'system-ui, -apple-system, Arial';
  const pw = 220, ph = 76;
  const px = W / 2 - pw / 2, py = H / 2 - ph / 2;

  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, W, H);

  const bg = ctx.createLinearGradient(px, py, px, py + ph);
  bg.addColorStop(0, 'rgba(8,30,14,0.99)'); bg.addColorStop(1, 'rgba(4,15,8,0.99)');
  ctx.fillStyle = bg;
  roundRect(ctx, px, py, pw, ph, 12); ctx.fill();
  ctx.strokeStyle = 'rgba(60,200,90,0.75)'; ctx.lineWidth = 1.5;
  roundRect(ctx, px, py, pw, ph, 12); ctx.stroke();

  drawIconCtx(ctx, 'party', px + 20, py + 18, 16, '#3ef07a');
  ctx.font = `bold 12px ${F}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#eee';
  ctx.fillText('Приглашение в пати', px + 34, py + 14);
  ctx.font = `10px ${F}`; ctx.fillStyle = '#3ef07a';
  ctx.fillText(inv.fromName, px + 34, py + 28);

  // Accept button
  const ac = getPartyAcceptPos();
  ctx.fillStyle = 'rgba(10,50,20,0.99)';
  roundRect(ctx, ac.x, ac.y, ac.w, ac.h, 8); ctx.fill();
  ctx.strokeStyle = 'rgba(60,200,90,0.8)'; ctx.lineWidth = 1.2;
  roundRect(ctx, ac.x, ac.y, ac.w, ac.h, 8); ctx.stroke();
  ctx.font = `bold 11px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#3ef07a';
  ctx.fillText('Принять', ac.x + ac.w / 2, ac.y + ac.h / 2);

  // Decline button
  const dc = getPartyDeclinePos();
  ctx.fillStyle = 'rgba(40,10,10,0.99)';
  roundRect(ctx, dc.x, dc.y, dc.w, dc.h, 8); ctx.fill();
  ctx.strokeStyle = 'rgba(200,50,50,0.8)'; ctx.lineWidth = 1.2;
  roundRect(ctx, dc.x, dc.y, dc.w, dc.h, 8); ctx.stroke();
  ctx.fillStyle = '#ff7070';
  ctx.fillText('Отказ', dc.x + dc.w / 2, dc.y + dc.h / 2);

  // Timer bar
  const alpha = Math.min(1, inv.timer / 3);
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = '#3ef07a';
  roundRect(ctx, px + 8, py + ph - 6, (pw - 16) * alpha, 3, 2); ctx.fill();
  ctx.globalAlpha = 1;

  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  DEAD SCREEN
// ─────────────────────────────────────────────────────────
function drawDead() {
  ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillRect(0, 0, W, H);
}
