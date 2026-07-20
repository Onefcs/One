// ─────────────────────────────────────────────────────────
//  PANEL UIs
// ─────────────────────────────────────────────────────────
function _itemIcon(it, size) {
  if (it && it.img) {
    return `<img src="${it.img}" width="${size}" height="${size}"
      style="image-rendering:pixelated;border-radius:3px;"
      onerror="this.style.display='none'">`;
  }
  const rc = it ? (RARITY_COLOR[it.rarity] || '#aaa') : '#505070';
  return iconHTML((it && it.icon) || 'weapon', size, rc);
}
function updateInvUI() {
  if (!player) return;
  const p = player;
  const inv = p.inventory;

  // Equipment grid (5 columns × 2 rows)
  document.getElementById('eq-grid').innerHTML = EQ_SLOTS.map(({ slot, label, emptyIcon }) => {
    const it = p.equipment[slot];
    const rc = it ? (RARITY_COLOR[it.rarity] || '#aaa') : '';
    const enhBadge = it && it.enhance ? `<span style="position:absolute;top:1px;right:2px;font-size:7px;color:#ffd700;font-weight:bold">+${it.enhance}</span>` : '';
    return `<div class="eq-cell${it ? ' filled' : ''}" onclick="${it ? `openEqItemModal('${slot}')` : ''}"
      title="${it ? it.name + (it.enhance ? ' +' + it.enhance : '') + ' — ' + statStr(it) : label}"
      style="${it ? 'border-color:' + rc + '55;position:relative' : ''}">
      <div class="cell-icon">${it ? _itemIcon(it, 28) : iconHTML(emptyIcon, 22, '#505070')}</div>
      <div class="cell-lbl" style="${it ? 'color:' + rc : ''}">${it ? it.name : label}</div>
      ${enhBadge}
    </div>`;
  }).join('');

  // Character preview
  const _bag = p.potionBag || {};
  const _hudPtDef = ITEM_DEF.find(d => d.id === (p.hudPotion || 'pt1'));
  const _hudCount = _bag[p.hudPotion || 'pt1'] || 0;
  const _activeBufCount = Object.values(p.buffs || {}).filter(v => v > 0).length;
  document.getElementById('char-preview').innerHTML = `
    <div class="inv-char-row">
      <div style="line-height:1">${iconHTML(p.charDef.icon, 40, p.charDef.color)}</div>
      <div style="flex:1">
        <div style="font-size:14px;font-weight:bold;color:${p.charDef.color}">${p.charDef.name}</div>
        <div style="font-size:11px;color:#999;margin-top:2px">Уровень ${p.lvl}</div>
        <div style="font-size:11px;color:#484860;margin-top:2px;display:flex;align-items:center;gap:3px">
          ${iconHTML('heart',11,'#e74c3c')}${Math.ceil(p.hp)}/${p.maxHp} ·
          <span style="color:#f93;font-weight:700">БМ ${typeof calcBM==='function'?calcBM(p):0}</span> ·
          ${iconHTML('coin',11,'#f1c40f')}${p.gold}
        </div>
      </div>
      <div onclick="openHpPicker()" style="color:#4f4;text-align:right;font-weight:bold;display:flex;flex-direction:column;align-items:center;gap:1px;cursor:pointer">
        ${_hudPtDef && _hudPtDef.img ? `<img src="${_hudPtDef.img}" width="20" height="20" style="image-rendering:pixelated">` : iconHTML('potion',20,'#3ef07a')}
        <span style="font-size:10px">×${_hudCount}</span>
        ${_activeBufCount > 0 ? `<span style="font-size:9px;color:#f0c040">${_activeBufCount} бафф</span>` : ''}
      </div>
    </div>
  `;

  // Potion shelf hidden — HP potions managed via HUD picker
  const ptEl = document.getElementById('potion-shelf');
  if (ptEl) ptEl.innerHTML = '';

  // Inventory grid — materials stack by id
  document.getElementById('inv-count').textContent = invSlotCount() + '/50';
  const _displayInv = [];
  inv.forEach((it, idx) => {
    if (_isStackable(it)) {
      _displayInv.push({ it, idx, count: it.qty || 1 });
    } else {
      _displayInv.push({ it, idx });
    }
  });

  document.getElementById('inv-grid').innerHTML = Array.from({ length: 50 }, (_, i) => {
    const entry = _displayInv[i];
    if (!entry) return `<div class="inv-cell"></div>`;
    const { it, idx, count } = entry;
    const rc = RARITY_COLOR[it.rarity] || '#aaa';
    const enh = it.enhance ? `<span style="position:absolute;top:1px;right:2px;font-size:7px;color:#ffd700;font-weight:bold">+${it.enhance}</span>` : '';
    const cntBadge = count ? `<span style="position:absolute;bottom:1px;right:2px;font-size:7px;color:#aee;font-weight:bold">×${count}</span>` : '';
    const clickable = idx !== undefined;
    return `<div class="inv-cell filled" onclick="${clickable ? `openInvItemModal(${idx})` : ''}"
      title="${it.name + (it.enhance ? ' +' + it.enhance : '') + ' — ' + statStr(it)}"
      style="border-color:${rc}77;position:relative">
      <div style="display:flex;justify-content:center;align-items:center">${_itemIcon(it, 24)}</div>
      <div style="font-size:7px;color:${rc};text-align:center;margin-top:1px;overflow:hidden;white-space:normal;word-break:break-word;line-height:1.2">${it.name}</div>
      ${enh}${cntBadge}
    </div>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────
//  HP PICKER MODAL
// ─────────────────────────────────────────────────────────
function openHpPicker() {
  if (!player) return;
  const existing = document.getElementById('hp-picker-ov');
  if (existing) existing.remove();

  const bag = player.potionBag || {};
  const hudPt = player.hudPotion || 'pt1';
  const autoThresholds = [0, 0.3, 0.5, 0.7];
  const autoLabels = ['ВЫКЛ', '30%', '50%', '70%'];
  const curAuto = player.autoHpPct || 0;

  const hpPots = ITEM_DEF.filter(d => d.slot === 'use');
  const potCells = hpPots.map(def => {
    const cnt = bag[def.id] || 0;
    const isHud = def.id === hudPt;
    const imgEl = def.img
      ? `<img src="${def.img}" width="28" height="28" style="image-rendering:pixelated;display:block;margin:0 auto 2px">`
      : iconHTML(def.icon || 'potion', 28, isHud ? '#3ef07a' : '#8090a0');
    return `<div onclick="setHudPotion('${def.id}');openHpPicker()" style="
      flex:1;padding:10px 6px;border-radius:10px;text-align:center;cursor:pointer;
      border:2px solid ${isHud ? '#3ef07a' : 'rgba(255,255,255,0.1)'};
      background:${isHud ? 'rgba(60,240,120,0.12)' : 'rgba(255,255,255,0.04)'};
    ">
      ${imgEl}
      <div style="font-size:10px;color:${isHud ? '#3ef07a' : '#888'};font-weight:${isHud?'700':'400'}">${def.name}</div>
      <div style="font-size:11px;color:#4f4;margin-top:2px">×${cnt}</div>
      <div style="font-size:9px;color:#666">HP+${def.hp} · откат 4с</div>
      ${isHud ? '<div style="font-size:9px;color:#3ef07a;font-weight:700;margin-top:2px">✓ В HUD</div>' : ''}
    </div>`;
  }).join('');

  const autoRows = autoThresholds.map((v, i) => {
    const isActive = Math.abs(curAuto - v) < 0.01;
    return `<button onclick="setAutoHpPct(${v})" style="
      flex:1;padding:8px 4px;border:none;border-radius:8px;cursor:pointer;font-size:12px;font-weight:700;
      background:${isActive ? '#1a3a2a' : 'rgba(255,255,255,0.06)'};
      color:${isActive ? '#3ef07a' : '#888'};
      border:1px solid ${isActive ? '#3ef07a44' : 'transparent'};
    ">${autoLabels[i]}</button>`;
  }).join('');

  const ov = document.createElement('div');
  ov.id = 'hp-picker-ov';
  ov.onclick = () => ov.remove();
  ov.style.cssText = 'position:fixed;inset:0;z-index:220;background:rgba(0,0,0,.75);backdrop-filter:blur(4px);display:flex;align-items:flex-end;justify-content:center;';
  ov.innerHTML = `<div onclick="event.stopPropagation()" style="width:100%;background:#0d0818;border-radius:18px 18px 0 0;border-top:1px solid rgba(255,255,255,.1);padding:18px 16px 30px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <div style="font-size:15px;font-weight:800;color:#3ef07a">Зелья лечения</div>
      <button onclick="document.getElementById('hp-picker-ov').remove()" style="width:28px;height:28px;border:none;border-radius:50%;background:rgba(255,255,255,.08);color:#888;font-size:13px;cursor:pointer;">✕</button>
    </div>
    <div style="display:flex;gap:10px;margin-bottom:16px">${potCells}</div>
    <div style="font-size:11px;color:#666;margin-bottom:8px">Авто-использование при HP &lt;</div>
    <div style="display:flex;gap:8px">${autoRows}</div>
    <button onclick="usePotion();document.getElementById('hp-picker-ov').remove()" style="
      width:100%;margin-top:14px;padding:12px;border:none;border-radius:12px;
      background:linear-gradient(135deg,#1a3a1a,#2a5a2a);color:#3ef07a;font-size:15px;font-weight:700;cursor:pointer;
    ">Использовать</button>
  </div>`;
  document.getElementById('app').appendChild(ov);
}

function setAutoHpPct(pct) {
  if (!player) return;
  player.autoHpPct = pct;
  netSaveProgress();
  openHpPicker();
}

function closePotionModal() {
  const el = document.getElementById('hp-picker-ov');
  if (el) el.remove();
  const el2 = document.getElementById('pt-modal');
  if (el2) el2.style.display = 'none';
}

function usePotionById(itemId) {
  if (!player || state !== 'playing') return;
  if ((player.potCd || 0) > 0) return;
  const bag = player.potionBag || {};
  if ((bag[itemId] || 0) <= 0 || player.hp >= player.maxHp) return;
  bag[itemId]--;
  const def = ITEM_DEF.find(d => d.id === itemId);
  const heal = (def && def.hp) || 20;
  player.hp = Math.min(player.maxHp, player.hp + heal);
  player.potCd = 4;
  dmgNum(player.x, player.y - 26, '+' + heal + '♥', '#4f4');
  spawnBurst(player.x, player.y, '#4f4', 5);
  if (typeof netUsePotion === 'function') netUsePotion(heal);
  updateInvUI();
  netSaveProgress();
}

function setHudPotion(itemId) {
  if (!player) return;
  player.hudPotion = itemId;
  updateInvUI();
  netSaveProgress();
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
  const totalSP = (player.lvl || 1) * 3;
  const spentSP = Object.values(player.upgrades || {}).reduce((s, v) => s + v, 0);
  const availSP = totalSP - spentSP;
  const spLbl = document.getElementById('upg-sp-lbl');
  if (spLbl) spLbl.textContent = `Очки навыка: ${availSP}`;
  const u = player.upgrades || {};
  el.innerHTML = Object.entries(UPGRADE_DEF).map(([key, cfg]) => {
    const lvl  = u[key] || 0;
    const cost = 300 * (lvl + 1);
    const can  = player.gold >= cost && availSP >= 1;
    return `<div class="upg-row">
      <div class="upg-info">
        <span class="upg-label">${iconHTML(cfg.icon, 14, '#9090bb')} ${cfg.label}</span>
        <span class="upg-meta">Ур.${lvl} · ${cfg.desc}</span>
      </div>
      <button class="upg-btn${can ? '' : ' disabled'}" onclick="upgradeStats('${key}')">
        ${iconHTML('coin',12,'#f1c40f')}${cost} + 1 ОН
      </button>
    </div>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────
//  SKILL UPGRADE UI
// ─────────────────────────────────────────────────────────
function _skillBonusDesc(type, level) {
  if (level <= 0) return null;
  switch (type) {
    case 'damage':   return `+${level}% к урону`;
    case 'buff':     return `+${level}с. действия`;
    case 'heal':     return `+${level}% к лечению`;
    case 'mobility': return `+${level * 10}px дальность`;
    default:         return null;
  }
}

function _skillBonusTypeLabel(type) {
  switch (type) {
    case 'damage':   return '+1%/ур. урон';
    case 'buff':     return '+1с/ур. действие';
    case 'heal':     return '+1%/ур. лечение';
    case 'mobility': return '+10px/ур. дальность';
    default:         return '';
  }
}

function updateSkillsUI() {
  if (!player) return;
  const el = document.getElementById('skill-upgrade-panel');
  if (!el) return;
  const skills = SKILL_DEF[player.type];
  if (!skills) { el.innerHTML = '<div style="padding:16px;color:#556;text-align:center">Выберите персонажа</div>'; return; }
  const bonusTypes = (SKILL_BONUS_TYPE || {})[player.type] || {};
  const sl = player.skillLevels || {};
  const sx = player.skillXp || {};

  const UPGRADE_COST = 100;
  const canAfford = player.gold >= UPGRADE_COST;

  el.innerHTML = `
    <div class="skill-upg-header">
      <span>${iconHTML('coin', 13, '#f1c40f')} <span id="skill-gold-lbl">${player.gold}</span> золота</span>
      <span class="skill-upg-hint">100 зол. · 50% шанс · +5 опыта</span>
    </div>
    ${skills.map(sk => {
      const level = sl[sk.key] || 0;
      const xp    = sx[sk.key] || 0;
      const maxed = level >= 10;
      const xpReq = typeof skillXpRequired === 'function' ? skillXpRequired(level) : Math.round(100 * Math.pow(1.5, level));
      const xpPct = maxed ? 100 : Math.min(100, Math.round(xp / xpReq * 100));
      const bonusType = bonusTypes[sk.key] || 'damage';
      const bonusNow  = _skillBonusDesc(bonusType, level);
      const bonusNext = maxed ? null : _skillBonusDesc(bonusType, level + 1);

      const dots = Array.from({ length: 10 }, (_, i) =>
        `<span class="sk-dot${i < level ? ' filled' : ''}"></span>`
      ).join('');

      return `<div class="skill-upg-card">
        <div class="skill-upg-top">
          <div class="skill-upg-icon">${sk.img ? `<img src="${sk.img}" width="26" height="26" style="image-rendering:pixelated;border-radius:4px;opacity:${level > 0 ? 1 : 0.4}">` : iconHTML(sk.icon, 26, level > 0 ? '#f1c40f' : '#556')}</div>
          <div class="skill-upg-info">
            <div class="skill-upg-name">${sk.name}<span class="skill-upg-lvl">${maxed ? ' МАКС' : ' Ур.' + level}</span></div>
            <div class="skill-upg-desc">${sk.desc}</div>
            <div class="skill-upg-type">${_skillBonusTypeLabel(bonusType)}</div>
          </div>
        </div>
        <div class="sk-dots">${dots}</div>
        ${!maxed ? `
        <div class="sk-xp-row">
          <div class="sk-xp-bar-bg"><div class="sk-xp-bar-fill" style="width:${xpPct}%"></div></div>
          <span class="sk-xp-lbl">${xp} / ${xpReq} опыта</span>
        </div>` : ''}
        <div class="sk-bonus-row">
          ${bonusNow ? `<span class="sk-bonus-now">${bonusNow}</span>` : ''}
          ${bonusNext && !maxed ? `<span class="sk-bonus-next">→ ${bonusNext}</span>` : ''}
        </div>
        <button class="skill-upg-btn${maxed ? ' disabled' : (!canAfford ? ' disabled' : '')}"
          onclick="${maxed ? '' : `upgradeSkill('${sk.key}')`}">
          ${maxed ? 'Максимум' : iconHTML('coin', 12, '#f1c40f') + ' 100 · Прокачать'}
        </button>
      </div>`;
    }).join('')}
  `;
}

function upgradeSkill(key) {
  if (!player) return;
  const cost = 100;
  if (player.gold < cost) { dmgNum(player.x, player.y - 30, 'Мало золота!', '#f88'); return; }
  const sl = player.skillLevels || (player.skillLevels = { Q:0, W:0, E:0, R:0 });
  const sx = player.skillXp    || (player.skillXp    = { Q:0, W:0, E:0, R:0 });
  const lvl = sl[key] || 0;
  if (lvl >= 10) return;

  player.gold -= cost;
  const xpReq = typeof skillXpRequired === 'function' ? skillXpRequired(lvl) : Math.round(100 * Math.pow(1.5, lvl));
  if (Math.random() < 0.5) {
    sx[key] = (sx[key] || 0) + 5;
    if (sx[key] >= xpReq) {
      sx[key] = 0;
      sl[key] = lvl + 1;
      spawnBurst(player.x, player.y, '#fa0', 10);
      dmgNum(player.x, player.y - 42, '↑ Навык +' + sl[key] + ' ур.!', '#fa0');
    } else {
      dmgNum(player.x, player.y - 36, '+5 опыта навыка', '#7ef');
    }
  } else {
    dmgNum(player.x, player.y - 36, 'Неудача...', '#f44');
  }
  netSaveProgress();
  updateSkillsUI();
  document.getElementById('skill-gold-lbl') && (document.getElementById('skill-gold-lbl').textContent = player.gold);
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
  const aliveEnemies = mapEnemies.filter(e => (e.hp || 0) > 0);
  mx2.fillStyle = '#ff3322';
  mx2.beginPath();
  aliveEnemies.forEach(e => {
    if (e.isBoss) return;
    mx2.moveTo(ox + (e.x / TILE) * sc + Math.max(1.5, sc * 0.5), oy + (e.y / TILE) * sc);
    mx2.arc(ox + (e.x / TILE) * sc, oy + (e.y / TILE) * sc, Math.max(1.5, sc * 0.5), 0, Math.PI * 2);
  });
  mx2.fill();
  // Boss skull icon on map
  const _bossIconSz = Math.max(10, Math.round(sc * 4));
  mx2.font = `${_bossIconSz}px serif`;
  mx2.textAlign = 'center'; mx2.textBaseline = 'middle';
  aliveEnemies.forEach(e => {
    if (!e.isBoss) return;
    mx2.fillText('💀', ox + (e.x / TILE) * sc, oy + (e.y / TILE) * sc);
  });
  // NPC blips on map
  mx2.fillStyle = '#ffcc00';
  mx2.beginPath();
  npcs.forEach(n => {
    mx2.moveTo(ox + (n.x / TILE) * sc + Math.max(2, sc * 0.7), oy + (n.y / TILE) * sc);
    mx2.arc(ox + (n.x / TILE) * sc, oy + (n.y / TILE) * sc, Math.max(2, sc * 0.7), 0, Math.PI * 2);
  });
  mx2.fill();
  document.getElementById('map-status').textContent =
    th.name + ' · Этаж ' + dungeonLvl + ' · Враги: ' + aliveEnemies.length;
}

function _floorEnemyNames(n) {
  const eMap = new Map(ENEMY_DEF.map(e => [e.eid, e]));
  if (FLOOR_ENEMIES[n]) {
    const fe = FLOOR_ENEMIES[n];
    const names = fe.pool.map(eid => (eMap.get(eid) || {}).name || eid);
    const boss  = (eMap.get(fe.boss) || {}).name || fe.boss;
    return [...names, boss].join(', ');
  }
  return 'Орк, Тролль, ДЕМОН';
}

function _floorEnemyPool(n) {
  const eMap = new Map(ENEMY_DEF.map(e => [e.eid, e]));
  if (FLOOR_ENEMIES[n]) {
    const fe = FLOOR_ENEMIES[n];
    const regular = fe.pool.map(eid => eMap.get(eid)).filter(Boolean);
    const boss    = eMap.get(fe.boss);
    return { regular, boss };
  }
  return {
    regular: ENEMY_DEF.filter(e => e.eid === 'orc' || e.eid === 'troll'),
    boss:    ENEMY_DEF.find(e => e.eid === 'demon'),
  };
}

function updateFloorUI() {
  const grid = document.getElementById('floor-grid');
  if (!grid) return;
  const plvl = player?.lvl || 1;
  grid.innerHTML = Array.from({ length: 5 }, (_, i) => {
    const n   = i + 1;
    const th  = getTheme(n);
    const cur = n === dungeonLvl;
    const req = (typeof FLOOR_UNLOCK_LEVEL !== 'undefined') ? (FLOOR_UNLOCK_LEVEL[n] || 0) : 0;
    const locked = plvl < req;
    const enemyNames = _floorEnemyNames(n);
    return `
      <div class="floor-item${cur ? ' active' : ''}${locked ? ' floor-locked' : ''}">
        <div class="floor-item-left" onclick="${locked ? `showFloorLock(${n},${req})` : `goToFloor(${n})`}">
          <div class="floor-item-row1">
            <span class="floor-item-num">${locked ? '🔒 ' : ''}Этаж ${n}</span>
            <span class="floor-item-loc">${th.name}</span>
            ${cur ? '<span class="floor-item-cur">ВЫ ЗДЕСЬ</span>' : ''}
            ${locked ? `<span class="floor-item-lock-req">Ур. ${req}</span>` : ''}
          </div>
          <div class="floor-item-brief">${enemyNames}</div>
        </div>
        <button class="floor-item-btn" onclick="${locked ? `showFloorLock(${n},${req})` : `showFloorInfo(${n})`}">Инфо</button>
      </div>`;
  }).join('');
}

function showFloorLock(n, req) {
  if (typeof dmgNum === 'function' && player) {
    dmgNum(player.x, player.y - 38, `🔒 Нужен уровень ${req}`, '#f93');
  }
}

function showFloorInfo(floor) {
  floor = floor || dungeonLvl || 1;
  const sc    = 1 + (floor - 1) * 0.28;
  const atkSc = 1 + (floor - 1) * 0.18;

  const rarityNames  = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'];
  const rarityColors = ['#aaa',   '#3ef07a',   '#55aaff', '#c55ef5', '#ffd700'];
  const maxRarIdx    = Math.min(4, Math.max(0, Math.floor((floor - 1) / 4)));
  const dropRarName  = rarityNames[Math.min(maxRarIdx + 1, 4)];
  const dropRarColor = rarityColors[Math.min(maxRarIdx + 1, 4)];

  const { regular: regularPool, boss } = _floorEnemyPool(floor);
  const allEnemies = boss ? [...regularPool, boss] : regularPool;

  // Multipliers matching actual game logic
  const goldBonus = (floor >= 2 && floor <= 5) ? 3 : 1;
  const fMult     = (floor >= 1 && floor <= 5) ? floor : 1;
  function _fmtPct(base) {
    const v = base * fMult;
    if (v >= 1)    return v.toFixed(1).replace(/\.0$/, '') + '%';
    if (v >= 0.1)  return v.toFixed(2).replace(/\.?0+$/, '') + '%';
    return v.toFixed(3).replace(/\.?0+$/, '') + '%';
  }

  const html = allEnemies.map(e => {
    const isBoss = !!e.isBoss;
    const hp     = Math.floor(e.hp  * sc);
    const atk    = Math.floor(e.atk * atkSc);

    // Gold drop text
    let goldText;
    if (isBoss) {
      const g = e.gold || [50, 50];
      const gMin = Math.round(g[0] * goldBonus), gMax = Math.round(g[1] * goldBonus);
      const gText = gMin === gMax ? `${gMin}g` : `${gMin}–${gMax}g`;
      goldText = `<span style="color:#ff0">${gText}</span>`;
    } else {
      const gMin = Math.round(e.gold[0] * Math.pow(2, floor - 1) * goldBonus);
      const gMax = Math.round(e.gold[1] * Math.pow(2, floor - 1) * goldBonus);
      goldText = `${gMin}–${gMax}g · 30%`;
    }

    // XP text (×3 on floors 2-5)
    const xpFinal = (floor >= 2 && floor <= 5) ? e.xp * 3 : e.xp;
    const xpColor = isBoss ? '#0f0' : '#8f8';

    // Boss stone row
    const _mi = typeof _matIcon === 'function' ? _matIcon : () => '';
    const stoneRow = isBoss
      ? `<div class="fi-drop">
           <span class="fi-drop-icon">${_mi(CRAFT_MATS.find(m=>m.id==='boss_stone'), 16)}</span>
           <span class="fi-drop-lbl" style="color:#aaf">Камень Босса</span>
           <span class="fi-drop-val" style="color:#aaf">&times;${floor}–${floor + 2} · 100%</span>
         </div>
         <div class="fi-drop">
           <span class="fi-drop-icon">${_mi(CRAFT_MATS.find(m=>m.id==='norm_stone'), 16)}</span>
           <span class="fi-drop-lbl" style="color:#fa8">Камень обычной заточки</span>
           <span class="fi-drop-val" style="color:#fa8">&times;1 · <b style="color:#fa8">10%</b></span>
         </div>
         <div class="fi-drop">
           <span class="fi-drop-icon">${_mi(CRAFT_MATS.find(m=>m.id==='bless_stone'), 16)}</span>
           <span class="fi-drop-lbl" style="color:#88f">Камень безопасной заточки</span>
           <span class="fi-drop-val" style="color:#88f">&times;1 · <b style="color:#88f">1%</b></span>
         </div>`
      : '';

    // Material drop rows for non-boss
    let matSection = '';
    if (!isBoss && typeof _matIcon === 'function') {
      const matDrops = [];
      const matPct = _fmtPct(5);
      if (e.eType === 'warrior') {
        matDrops.push({ id:'bonec', chance: matPct });
        matDrops.push({ id:'coalc', chance: matPct });
      } else if (e.eType === 'guard') {
        matDrops.push({ id:'orec',  chance: matPct });
        matDrops.push({ id:'skinc', chance: matPct });
      }
      matDrops.push({ id:'recu', chance: _fmtPct(0.1)   });
      matDrops.push({ id:'recr', chance: _fmtPct(0.05)  });
      matDrops.push({ id:'rece', chance: _fmtPct(0.02)  });
      matDrops.push({ id:'recl', chance: _fmtPct(0.001) });

      const rows = matDrops.map(d => {
        const mat = CRAFT_MATS.find(m => m.id === d.id);
        if (!mat) return '';
        const rc = (typeof RARITY_COLOR !== 'undefined' ? RARITY_COLOR[mat.rarity] : null) || '#aaa';
        return `<div class="fi-drop">
          <span class="fi-drop-icon">${_matIcon(mat, 16)}</span>
          <span class="fi-drop-lbl" style="color:${rc}">${mat.name}</span>
          <span class="fi-drop-val">&times;1 · <b style="color:${rc}">${d.chance}</b></span>
        </div>`;
      }).join('');

      matSection = `<div class="fi-drops-hdr" style="margin-top:8px">Материалы</div>
        <div class="fi-drops">${rows}</div>`;
    }

    return `
      <div class="fi-monster${isBoss ? ' fi-boss' : ''}">
        <div class="fi-mhdr">
          <span class="fi-mname" style="color:${e.color}">${e.name}</span>
          ${isBoss ? '<span class="fi-boss-tag">БОСС</span>' : ''}
        </div>
        <div class="fi-mstats">
          <span>HP <b>${hp}</b></span>
          <span>ATK <b>${atk}</b></span>
          <span>DEF <b>${e.def}</b></span>
          <span>СПД <b>${e.spd}</b></span>
        </div>
        <div class="fi-drops-hdr">Дроп</div>
        <div class="fi-drops">
          <div class="fi-drop">
            <span class="fi-drop-lbl">Опыт</span>
            <span class="fi-drop-val" style="color:${xpColor}">${xpFinal} XP</span>
          </div>
          <div class="fi-drop">
            <span class="fi-drop-lbl">Золото</span>
            <span class="fi-drop-val">${goldText}</span>
          </div>
          ${stoneRow}
        </div>
        ${matSection}
      </div>`;
  }).join('');

  const modal = document.getElementById('floor-info-modal');
  if (!modal) return;
  const _fiTh = getTheme(floor);
  modal.querySelector('.fi-title').textContent = _fiTh.name;
  document.getElementById('floor-info-body').innerHTML = html;
  modal.style.display = 'flex';
}

function closeFloorInfo() {
  const modal = document.getElementById('floor-info-modal');
  if (modal) modal.style.display = 'none';
}

function updateRaidPanelUI() {
  const body = document.getElementById('raid-panel-body');
  if (!body) return;
  const RARITY_COL = { common: '#aaa', uncommon: '#3ef07a' };
  const plvl = player?.lvl || 1;
  const lvlOk = plvl >= 3;

  if (inRaid) {
    body.innerHTML = `<div class="raid-hint" style="text-align:center;padding:20px 0">⚔️ Вы в бою...</div>`;
    return;
  }

  // Inside a lobby
  if (_myLobbyId) {
    const memberRows = (_myLobbyMembers || []).map(m =>
      `<div class="raid-member" style="display:flex;justify-content:space-between;align-items:center">
        <span>👤 ${m.name}</span>
        <span style="color:#999;font-size:11px">Ур.${m.lvl} · БМ ${m.bm}</span>
      </div>`).join('');
    const canStart = _isLobbyCreator && (_myLobbyMembers?.length || 0) >= 2;
    body.innerHTML = `
      <div class="raid-dungeon-card">
        <div class="raid-dungeon-name">⚔️ Подземелье 1</div>
        <div style="font-size:12px;color:#888;margin-bottom:8px">Ваша группа · ${_myLobbyMembers?.length || 1} / 5</div>
        <div style="margin-bottom:10px">${memberRows}</div>
        ${_isLobbyCreator
          ? `<div class="raid-hint" style="margin-bottom:8px">Вы — создатель · ждите игроков или начните</div>
             <button class="raid-enter-btn${canStart ? '' : ' disabled'}" onclick="${canStart ? 'netStartLobby()' : ''}">Начать рейд</button>`
          : `<div class="raid-hint">Ожидание старта от создателя...</div>`}
      </div>
      <button onclick="netLeaveLobby();updateRaidPanelUI()" style="width:100%;margin-top:8px;padding:10px;background:rgba(255,60,60,.12);color:#f55;border:1px solid rgba(255,60,60,.25);border-radius:8px;font-size:13px;cursor:pointer">Покинуть группу</button>
    `;
    return;
  }

  // Lobby list
  const dungeonCard = `
    <div class="raid-dungeon-card" style="margin-bottom:10px">
      <div class="raid-dungeon-name">⚔️ Подземелье 1</div>
      <div class="raid-dungeon-desc">Волны монстров · 7 волн · Финальный босс</div>
      <div class="raid-dungeon-rewards">
        <span>💰 500 голд</span><span>⭐ 500 опыт</span>
        <span style="color:${RARITY_COL.common}">30% Common</span>
        <span style="color:${RARITY_COL.uncommon}">5% Uncommon</span>
      </div>
    </div>`;

  const createBtn = lvlOk
    ? `<button class="raid-enter-btn" onclick="netCreateLobby(1);netGetLobbyList()" style="margin-bottom:12px">Создать группу</button>`
    : `<button class="raid-enter-btn disabled" style="margin-bottom:12px">🔒 Нужен уровень 3</button>`;

  const lobbies = _raidLobbyList || [];
  let lobbyListHtml = '';
  if (lobbies.length === 0) {
    lobbyListHtml = `<div class="raid-hint">Нет открытых групп. Создайте свою!</div>`;
  } else {
    lobbyListHtml = lobbies.map(lb => {
      const mList = (lb.members || []).map(m => `<span style="font-size:10px;color:#888">Ур.${m.lvl}</span> ${m.name}`).join(', ');
      const full = (lb.members?.length || 0) >= 5;
      return `
        <div class="raid-dungeon-card" style="margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <span style="font-size:13px;font-weight:700;color:#fff">${lb.creatorName}</span>
            <span style="font-size:11px;color:#888">${lb.members?.length || 1} / 5</span>
          </div>
          <div style="font-size:11px;color:#999;margin-bottom:8px">${mList}</div>
          <button class="raid-enter-btn${full ? ' disabled' : ''}" style="padding:8px" onclick="${full ? '' : `netJoinLobby('${lb.id}')`}">${full ? 'Полная' : 'Войти'}</button>
        </div>`;
    }).join('');
  }

  body.innerHTML = dungeonCard + createBtn +
    `<div style="font-size:12px;color:#666;margin-bottom:6px">Открытые группы <button onclick="netGetLobbyList()" style="background:none;border:none;color:#60a5fa;font-size:11px;cursor:pointer">обновить</button></div>` +
    lobbyListHtml;
}

function showRaidComplete({ gold, xp, weaponName, weaponRarity }) {
  const RARITY_COL = { common: '#aaa', uncommon: '#3ef07a' };
  document.getElementById('raid-reward-body').innerHTML =
    `<div>💰 +${gold} голда</div>` +
    `<div>⭐ +${xp} опыта</div>` +
    (weaponName
      ? `<div style="margin-top:6px;color:${RARITY_COL[weaponRarity] || '#aaa'}">🗡 ${weaponName}</div>`
      : '');
  document.getElementById('raid-complete-modal').style.display = 'flex';
}

function showRaidFailed() {
  document.getElementById('raid-failed-modal').style.display = 'flex';
}

// ─────────────────────────────────────────────────────────
//  TAB MANAGEMENT
// ─────────────────────────────────────────────────────────
let _invTab = 0;
let _mapTab = 0;

function setMapTab(n) {
  _mapTab = n;
  document.querySelectorAll('.map-tab').forEach((el, i) => el.classList.toggle('active', i === n));
  document.getElementById('map-tab-content-0').style.display = n === 0 ? '' : 'none';
  document.getElementById('map-tab-content-1').style.display = n === 1 ? '' : 'none';
  if (n === 0) { updateFloorUI(); setTimeout(drawMapPanel, 320); }
  if (n === 1) { updateRaidPanelUI(); if (typeof netGetLobbyList === 'function') netGetLobbyList(); }
}

function setInvTab(n) {
  _invTab = n;
  document.querySelectorAll('.inv-tab').forEach((el, i) => el.classList.toggle('active', i === n));
  document.getElementById('inv-tab-content-0').style.display = n === 0 ? '' : 'none';
  document.getElementById('inv-tab-content-1').style.display = n === 1 ? '' : 'none';
  document.getElementById('inv-tab-content-2').style.display = n === 2 ? '' : 'none';
  if (n === 0) updateInvUI();
  if (n === 1) updateProfileUI();
  if (n === 2) updateSkillsUI();
}

function setTab(n) {
  activeTab = n;
  document.querySelectorAll('.nav-tab').forEach((el, i) => el.classList.toggle('active', i === n));
  document.querySelectorAll('.bpanel').forEach(p => { p.classList.remove('open'); });
  if (n !== 0) {
    joy.active = false; joy.dx = 0; joy.dy = 0;
    const tb = document.getElementById('npc-talk-btn');
    if (tb) tb.style.display = 'none';
  }
  const pid = ['', 'panel-inv', 'panel-map', 'panel-quests', 'panel-clans', 'panel-profile'][n];
  if (pid) {
    const el = document.getElementById(pid);
    el.style.display = 'block';
    requestAnimationFrame(() => { el.classList.add('open'); });
    if (n === 1) { if (_invTab === 1) updateProfileUI(); else if (_invTab === 2) updateSkillsUI(); else updateInvUI(); }
    if (n === 2) { setMapTab(_mapTab); }
    if (n === 3 && typeof updateQuestUI === 'function') updateQuestUI();
    if (n === 4 && typeof updateClanUI === 'function') updateClanUI();
    if (n === 5) switchProfileTab(window._profileTab || 'wallet');
  }
}

// ─────────────────────────────────────────────────────────
//  UNIFIED HEADER  (player info + minimap)
// ─────────────────────────────────────────────────────────
let _hdrBgGrad = null, _hdrSepGrad = null, _hdrGradW = 0;
let _hpGradGreen = null, _hpGradOrange = null, _hpGradRed = null;
let _hpShineGrad = null, _xpGrad = null, _xpShineGrad = null, _hdrGradH = 0;
// Avatar bg gradient (re-created only when character color changes)
let _avBgGrad = null, _avBgColor = '';
// All button + target-frame gradients — rebuilt when null (set null on resize)
let _uiBtnGrads = null;
// Cached character name text width (measureText is expensive; name never changes mid-session)
let _hdrNameW = 0, _hdrNameStr = '';

function drawHeader() {
  if (!player || !dungeon) return;
  const p = player;
  const F = 'system-ui, -apple-system, sans-serif';

  ctx.save();

  // ── Background (cached gradient — same every frame) ───────
  if (!_hdrBgGrad || _hdrGradW !== W) {
    _hdrGradW = W;
    _hpGradGreen = null; // invalidate dependent bar gradients
    _avBgGrad = null;    // also invalidate avatar bg on resize
    _hdrNameW = 0;       // force measureText recompute (infoW changes with W)
    _hdrBgGrad = ctx.createLinearGradient(0, 0, 0, HEADER_H);
    _hdrBgGrad.addColorStop(0, 'rgba(11,7,26,0.98)');
    _hdrBgGrad.addColorStop(1, 'rgba(5,3,14,0.99)');
    _hdrSepGrad = ctx.createLinearGradient(0, 0, W, 0);
    _hdrSepGrad.addColorStop(0,   'rgba(60,35,130,0)');
    _hdrSepGrad.addColorStop(0.15,'rgba(90,55,185,0.75)');
    _hdrSepGrad.addColorStop(0.85,'rgba(90,55,185,0.75)');
    _hdrSepGrad.addColorStop(1,   'rgba(60,35,130,0)');
  }
  ctx.fillStyle = _hdrBgGrad;
  ctx.fillRect(0, 0, W, HEADER_H);

  // Bottom separator glow
  ctx.strokeStyle = _hdrSepGrad; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, HEADER_H - 0.5); ctx.lineTo(W, HEADER_H - 0.5); ctx.stroke();

  // ── Minimap (right side) ──────────────────────────────────
  const mmPad = 6;
  const mmH = HEADER_H - mmPad * 2;
  const mmW = Math.floor(Math.min(mmH * (dungeon.w / dungeon.h), W * 0.27));
  const mmX = W - mmW - mmPad - 4;
  const mmY = mmPad;
  const mmSc = mmW / dungeon.w;

  // Tile cache at native DPR for crisp rendering (independent of game DPR)
  const th = getTheme(dungeonLvl);
  const _mmDPR = window.devicePixelRatio || 1;
  const mmCW = Math.round(mmW * _mmDPR), mmCH = Math.round(mmH * _mmDPR);
  const mmCSc = mmCW / dungeon.w;
  if (minimapCacheFloor !== dungeonLvl || !minimapCache ||
      minimapCache.width !== mmCW || minimapCache.height !== mmCH) {
    minimapCacheFloor = dungeonLvl;
    minimapCache = document.createElement('canvas');
    minimapCache.width = mmCW; minimapCache.height = mmCH;
    const mctx = minimapCache.getContext('2d');
    mctx.fillStyle = th.mmFloor;
    mctx.beginPath();
    for (let ty = 0; ty < dungeon.h; ty++) {
      for (let tx = 0; tx < dungeon.w; tx++) {
        if (dungeon.grid[ty][tx] !== WALL) {
          mctx.rect(
            Math.floor(tx * mmCSc), Math.floor(ty * mmCSc),
            Math.max(1, Math.ceil(mmCSc)), Math.max(1, Math.ceil(mmCSc))
          );
        }
      }
    }
    mctx.fill();
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
  const _mmR = Math.max(1, mmSc * 0.8);
  ctx.fillStyle = 'rgba(255,45,35,0.9)';
  ctx.beginPath();
  mmEnemies.forEach(e => {
    if ((e.hp || 0) <= 0 || e.isBoss) return;
    const ex = mmX + (e.x / TILE) * mmSc, ey = mmY + (e.y / TILE) * mmSc;
    ctx.moveTo(ex + _mmR, ey); ctx.arc(ex, ey, _mmR, 0, Math.PI * 2);
  });
  ctx.fill();
  // Boss skull icon on minimap
  const _bossIconSz = Math.max(8, Math.round(mmSc * 4));
  ctx.font = `${_bossIconSz}px serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  mmEnemies.forEach(e => {
    if ((e.hp || 0) <= 0 || !e.isBoss) return;
    const ex = mmX + (e.x / TILE) * mmSc, ey = mmY + (e.y / TILE) * mmSc;
    ctx.fillText('💀', ex, ey);
  });
  const _mmRn = Math.max(1, mmSc);
  ctx.fillStyle = 'rgba(255,200,0,0.9)';
  ctx.beginPath();
  npcs.forEach(n => {
    const nx = mmX + (n.x / TILE) * mmSc, ny = mmY + (n.y / TILE) * mmSc;
    ctx.moveTo(nx + _mmRn, ny); ctx.arc(nx, ny, _mmRn, 0, Math.PI * 2);
  });
  ctx.fill();
  if (socket?.connected) {
    const _mmRop = Math.max(1.5, mmSc);
    ctx.fillStyle = 'rgba(100,180,255,0.9)';
    ctx.beginPath();
    otherPlayers.forEach(op => {
      if (op.x == null) return;
      const ox = mmX + (op.x / TILE) * mmSc, oy = mmY + (op.y / TILE) * mmSc;
      ctx.moveTo(ox + _mmRop, oy); ctx.arc(ox, oy, _mmRop, 0, Math.PI * 2);
    });
    ctx.fill();
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
  if (!_avBgGrad || _avBgColor !== p.charDef.color) {
    _avBgGrad = ctx.createRadialGradient(avX - 5, avY - 5, 2, avX, avY, avR);
    _avBgGrad.addColorStop(0, p.charDef.color + '40');
    _avBgGrad.addColorStop(1, 'rgba(0,0,0,0.6)');
    _avBgColor = p.charDef.color;
  }
  ctx.fillStyle = _avBgGrad;
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

  // Row 2: Class name + inline stats (gold / atk / def)
  ctx.textAlign = 'left'; ctx.font = `10px ${F}`; ctx.fillStyle = p.charDef.color + 'cc';
  ctx.fillText(p.charDef.name, infoX, 27);
  if (!_hdrNameW || _hdrNameStr !== p.charDef.name) {
    _hdrNameStr = p.charDef.name;
    _hdrNameW = ctx.measureText(p.charDef.name).width;
  }
  let stxH = infoX + _hdrNameW + 10;
  ctx.textBaseline = 'middle';
  // БМ label + value
  const bmVal = typeof calcBM === 'function' ? calcBM(p) : 0;
  ctx.font = `bold 9px ${F}`; ctx.textAlign = 'left'; ctx.fillStyle = '#ff9933';
  ctx.fillText('БМ', stxH, 24);
  const _bmLabelW = ctx.measureText('БМ').width;
  ctx.font = `bold 10px ${F}`; ctx.fillStyle = '#ff9933';
  ctx.fillText(bmVal, stxH + _bmLabelW + 3, 24);
  stxH += _bmLabelW + 3 + ctx.measureText(String(bmVal)).width + 10;
  // Gold
  drawIconCtx(ctx, 'coin', stxH + 5, 24, 11, '#f1c40f');
  ctx.font = `bold 10px ${F}`; ctx.textAlign = 'left'; ctx.fillStyle = '#f1c40f';
  ctx.fillText(p.gold, stxH + 13, 24);
  ctx.textBaseline = 'alphabetic';

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
    // Cache horizontal HP gradients — only depend on bar X/W, not HP amount
    if (!_hpGradGreen || _hdrGradW !== W) {
      _hpGradGreen  = ctx.createLinearGradient(hbX, 0, hbX + hbW, 0);
      _hpGradGreen.addColorStop(0, '#0d5c28'); _hpGradGreen.addColorStop(1, '#2ecc71');
      _hpGradOrange = ctx.createLinearGradient(hbX, 0, hbX + hbW, 0);
      _hpGradOrange.addColorStop(0, '#7a4400'); _hpGradOrange.addColorStop(1, '#f39c12');
      _hpGradRed    = ctx.createLinearGradient(hbX, 0, hbX + hbW, 0);
      _hpGradRed.addColorStop(0, '#6b0f0f'); _hpGradRed.addColorStop(1, '#e74c3c');
      _hpShineGrad  = ctx.createLinearGradient(0, hpY - hbH / 2, 0, hpY);
      _hpShineGrad.addColorStop(0, 'rgba(255,255,255,0.2)'); _hpShineGrad.addColorStop(1, 'rgba(255,255,255,0)');
    }
    ctx.fillStyle = hpPct > 0.5 ? _hpGradGreen : hpPct > 0.25 ? _hpGradOrange : _hpGradRed;
    roundRect(ctx, hbX, hpY - hbH / 2, hbW * hpPct, hbH, 4); ctx.fill();
    ctx.fillStyle = _hpShineGrad;
    roundRect(ctx, hbX, hpY - hbH / 2, hbW * hpPct, hbH * 0.5, 4); ctx.fill();
    if (hpPct < 0.3) {
      ctx.strokeStyle = 'rgba(231,76,60,0.6)'; ctx.lineWidth = 1.5;
      roundRect(ctx, hbX, hpY - hbH / 2, hbW * hpPct, hbH, 4); ctx.stroke();
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
    if (!_xpGrad || _hdrGradW !== W) {
      _xpGrad = ctx.createLinearGradient(xbX, 0, xbX + xbW, 0);
      _xpGrad.addColorStop(0, '#180f5a'); _xpGrad.addColorStop(1, '#7c4dff');
      _xpShineGrad = ctx.createLinearGradient(0, xpY - xbH / 2, 0, xpY);
      _xpShineGrad.addColorStop(0, 'rgba(255,255,255,0.16)'); _xpShineGrad.addColorStop(1, 'rgba(255,255,255,0)');
    }
    ctx.fillStyle = _xpGrad;
    roundRect(ctx, xbX, xpY - xbH / 2, xbW * xpPct, xbH, 3); ctx.fill();
    ctx.fillStyle = _xpShineGrad;
    roundRect(ctx, xbX, xpY - xbH / 2, xbW * xpPct, xbH * 0.5, 3); ctx.fill();
  }
  ctx.font = `8px ${F}`; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(180,155,255,0.7)';
  ctx.fillText(p.xp + '/' + p.xpNext, xbX + xbW / 2, xpY);

  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  JOYSTICK
// ─────────────────────────────────────────────────────────
let _joyKnobGrad = null, _joyKnobGradKx = null, _joyKnobGradKy = null;
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
  // Recreate gradient only when knob position actually changes
  if (_joyKnobGrad === null || kx !== _joyKnobGradKx || ky !== _joyKnobGradKy) {
    _joyKnobGrad = ctx.createRadialGradient(kx - JOY_KNOB * .3, ky - JOY_KNOB * .3, 0, kx, ky, JOY_KNOB);
    _joyKnobGrad.addColorStop(0, 'rgba(210,210,255,.95)'); _joyKnobGrad.addColorStop(1, 'rgba(80,80,180,.7)');
    _joyKnobGradKx = kx; _joyKnobGradKy = ky;
  }
  ctx.fillStyle = _joyKnobGrad; ctx.beginPath(); ctx.arc(kx, ky, JOY_KNOB, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(kx, ky, JOY_KNOB, 0, Math.PI * 2); ctx.stroke();
  ctx.globalAlpha = 1;
}

// ─────────────────────────────────────────────────────────
//  SKILL BUTTONS (2×2 grid)
// ─────────────────────────────────────────────────────────
// Gradient cache: 4 buttons × 3 states (flash / ready / cooldown)
// Invalidated on resize via _skillBtnGradCache = null in game.js
let _skillBtnGradCache = null;
function _buildSkillBtnGrads() {
  _skillBtnGradCache = Array.from({ length: 4 }, (_, i) => {
    const b = getSkillBtnPos(i);
    const flash = ctx.createLinearGradient(b.x, b.y, b.x, b.y + b.h);
    flash.addColorStop(0, 'rgba(80,60,10,0.97)'); flash.addColorStop(1, 'rgba(40,30,5,0.99)');
    const ready = ctx.createLinearGradient(b.x, b.y, b.x, b.y + b.h);
    ready.addColorStop(0, 'rgba(18,14,40,0.97)'); ready.addColorStop(1, 'rgba(8,6,20,0.99)');
    const cd = ctx.createLinearGradient(b.x, b.y, b.x, b.y + b.h);
    cd.addColorStop(0, 'rgba(10,8,22,0.97)'); cd.addColorStop(1, 'rgba(5,4,12,0.99)');
    return { flash, ready, cd, x: b.x, y: b.y, w: b.w, h: b.h };
  });
}

const _F_SKILL = 'system-ui, -apple-system, Arial';
function drawSkillButtons() {
  if (!player) return;
  const skills = SKILL_DEF[player.type];
  if (!skills) return;
  if (!_skillBtnGradCache) _buildSkillBtnGrads();

  for (let i = 0; i < 4; i++) {
    const sk = skills[i];
    const grads = _skillBtnGradCache[i];
    const b = grads; // positions cached inside grads
    const cd = player.skillCooldowns[sk.key] || 0;
    const ready = cd <= 0;
    const isFlash = skillFlash && skillFlash.key === sk.key && skillFlash.timer > 0;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;

    // Background gradient (cached)
    ctx.fillStyle = isFlash ? grads.flash : ready ? grads.ready : grads.cd;
    roundRect(ctx, b.x, b.y, b.w, b.h, 11); ctx.fill();

    // Border
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = isFlash ? 'rgba(255,200,50,0.95)' : ready ? 'rgba(75,110,220,0.7)' : 'rgba(35,30,65,0.7)';
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

    // Icon — prefer PNG, fall back to SVG icon
    ctx.globalAlpha = ready ? 1 : 0.45;
    if (sk.img) {
      const img = _getPotImg(sk.img);
      if (img && img.complete && img.naturalWidth > 0) {
        const is = 30;
        ctx.drawImage(img, cx - is / 2, cy - 7 - is / 2, is, is);
      } else {
        drawIconCtx(ctx, sk.icon, cx, cy - 7, 22, ready ? '#b0c4ff' : '#606080');
      }
    } else {
      drawIconCtx(ctx, sk.icon, cx, cy - 7, 22, ready ? '#b0c4ff' : '#606080');
    }

    // Key badge
    ctx.globalAlpha = 1;
    ctx.font = `bold 9px ${_F_SKILL}`; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'center';
    ctx.fillStyle = ready ? 'rgba(200,210,255,0.85)' : 'rgba(80,80,100,0.7)';
    ctx.fillText(sk.key, cx, b.y + b.h - 6);

    // Cooldown overlay number
    if (!ready) {
      ctx.font = `bold 14px ${_F_SKILL}`; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      ctx.fillText(cd >= 10 ? Math.ceil(cd) : cd.toFixed(1), cx, cy - 7);
    }
    ctx.globalAlpha = 1;
  }
}

// ─────────────────────────────────────────────────────────
//  CACHED BUTTON GRADIENTS  (rebuilt only on resize / first call)
// ─────────────────────────────────────────────────────────
function _buildUiBtnGrads() {
  const pb  = getPotionBtnPos();
  const tb  = getTargetBtnPos();
  const ab  = getAttackBtnPos();
  const aab = getAutoBtnPos();
  const pvp = getPvpBtnPos();
  const pty = getPartyBtnPos();
  const tfW = 160, tfH = 42;
  const tfX = W / 2 - tfW / 2, tfY = HEADER_H + 6;
  const hbX = tfX + 8, hbW = tfW - 16, hbY = tfY + 20;

  const pg0 = ctx.createRadialGradient(pb.x-5, pb.y-5, 2, pb.x, pb.y, pb.r);
  pg0.addColorStop(0,'rgba(16,12,32,0.98)'); pg0.addColorStop(1,'rgba(8,6,18,0.99)');
  const pg1 = ctx.createRadialGradient(pb.x-5, pb.y-5, 2, pb.x, pb.y, pb.r);
  pg1.addColorStop(0,'rgba(20,70,35,0.98)'); pg1.addColorStop(1,'rgba(8,30,15,0.99)');

  const tg0 = ctx.createRadialGradient(tb.x-4, tb.y-4, 2, tb.x, tb.y, tb.r);
  tg0.addColorStop(0,'rgba(16,12,32,0.98)'); tg0.addColorStop(1,'rgba(8,6,18,0.99)');
  const tg1 = ctx.createRadialGradient(tb.x-4, tb.y-4, 2, tb.x, tb.y, tb.r);
  tg1.addColorStop(0,'rgba(55,10,10,0.98)'); tg1.addColorStop(1,'rgba(25,5,5,0.99)');

  const pvg0 = ctx.createLinearGradient(pvp.x, pvp.y, pvp.x, pvp.y+pvp.h);
  pvg0.addColorStop(0,'rgba(16,12,32,0.97)'); pvg0.addColorStop(1,'rgba(8,6,18,0.99)');
  const pvg1 = ctx.createLinearGradient(pvp.x, pvp.y, pvp.x, pvp.y+pvp.h);
  pvg1.addColorStop(0,'rgba(70,10,10,0.98)'); pvg1.addColorStop(1,'rgba(35,5,5,0.99)');

  const ptg0 = ctx.createLinearGradient(pty.x, pty.y, pty.x, pty.y+pty.h);
  ptg0.addColorStop(0,'rgba(10,40,18,0.97)'); ptg0.addColorStop(1,'rgba(5,20,9,0.99)');
  const ptg1 = ctx.createLinearGradient(pty.x, pty.y, pty.x, pty.y+pty.h);
  ptg1.addColorStop(0,'rgba(50,10,10,0.97)'); ptg1.addColorStop(1,'rgba(25,5,5,0.99)');

  const ag0 = ctx.createRadialGradient(ab.x-6, ab.y-6, 3, ab.x, ab.y, ab.r);
  ag0.addColorStop(0,'rgba(12,10,28,0.90)'); ag0.addColorStop(1,'rgba(6,5,14,0.92)');
  const ag1 = ctx.createRadialGradient(ab.x-6, ab.y-6, 3, ab.x, ab.y, ab.r);
  ag1.addColorStop(0,'rgba(60,20,10,0.98)'); ag1.addColorStop(1,'rgba(28,8,5,0.99)');
  const ag2 = ctx.createRadialGradient(ab.x-6, ab.y-6, 3, ab.x, ab.y, ab.r);
  ag2.addColorStop(0,'rgba(18,14,40,0.98)'); ag2.addColorStop(1,'rgba(8,6,20,0.99)');

  const aag0 = ctx.createLinearGradient(aab.x, aab.y, aab.x, aab.y+aab.h);
  aag0.addColorStop(0,'rgba(35,15,5,0.95)'); aag0.addColorStop(1,'rgba(18,7,3,0.97)');
  const aag1 = ctx.createLinearGradient(aab.x, aab.y, aab.x, aab.y+aab.h);
  aag1.addColorStop(0,'rgba(10,35,15,0.95)'); aag1.addColorStop(1,'rgba(5,18,8,0.97)');

  const tfBg = ctx.createLinearGradient(tfX, tfY, tfX, tfY+tfH);
  tfBg.addColorStop(0,'rgba(14,9,28,0.97)'); tfBg.addColorStop(1,'rgba(7,5,16,0.99)');
  const hpHi = ctx.createLinearGradient(hbX, 0, hbX+hbW, 0);
  hpHi.addColorStop(0,'#0c5a22'); hpHi.addColorStop(1,'#1ec95a');
  const hpMid = ctx.createLinearGradient(hbX, 0, hbX+hbW, 0);
  hpMid.addColorStop(0,'#7a4200'); hpMid.addColorStop(1,'#f0921a');
  const hpLo = ctx.createLinearGradient(hbX, 0, hbX+hbW, 0);
  hpLo.addColorStop(0,'#6b0c0c'); hpLo.addColorStop(1,'#e03030');
  const tfShine = ctx.createLinearGradient(0, hbY, 0, hbY+4);
  tfShine.addColorStop(0,'rgba(255,255,255,0.15)'); tfShine.addColorStop(1,'rgba(255,255,255,0)');

  // Cache positions too — avoids creating new objects every _renderUI() call
  _uiBtnGrads = { pg0, pg1, tg0, tg1, pvg0, pvg1, ptg0, ptg1, ag0, ag1, ag2, aag0, aag1,
                  tfBg, hpHi, hpMid, hpLo, tfShine,
                  potBtn: pb, tgtBtn: tb, atkBtn: ab, autoBtn: aab, pvpBtn: pvp, ptyBtn: pty };
}

// ─────────────────────────────────────────────────────────
//  POTION BUTTON
// ─────────────────────────────────────────────────────────
const _potImgCache = {};
function _getPotImg(src) {
  if (!src) return null;
  if (!_potImgCache[src]) {
    const img = new Image();
    img.src = src;
    _potImgCache[src] = img;
  }
  return _potImgCache[src];
}

function drawPotionButton() {
  if (!player) return;
  if (!_uiBtnGrads) _buildUiBtnGrads();
  const pb = _uiBtnGrads.potBtn;
  const bag = player.potionBag || {};
  const hudPt = player.hudPotion || 'pt1';
  const count = bag[hudPt] || 0;
  const ready = count > 0 && player.hp < player.maxHp;
  const cd = player.potCd || 0;
  const F = 'system-ui, -apple-system, Arial';

  ctx.save();

  // Circle background (cached gradient)
  ctx.fillStyle = ready && cd <= 0 ? _uiBtnGrads.pg1 : _uiBtnGrads.pg0;
  ctx.beginPath(); ctx.arc(pb.x, pb.y, pb.r, 0, Math.PI * 2); ctx.fill();

  ctx.strokeStyle = ready && cd <= 0 ? 'rgba(60,200,90,0.75)' : 'rgba(50,40,90,0.6)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(pb.x, pb.y, pb.r, 0, Math.PI * 2); ctx.stroke();
  if (ready && cd <= 0) {
    ctx.strokeStyle = 'rgba(80,220,110,0.15)'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(pb.x, pb.y, pb.r + 2, 0, Math.PI * 2); ctx.stroke();
  }

  // Draw PNG image or fallback SVG icon
  const hudDef = ITEM_DEF.find(d => d.id === hudPt);
  ctx.globalAlpha = ready && cd <= 0 ? 1 : 0.45;
  if (hudDef && hudDef.img) {
    const img = _getPotImg(hudDef.img);
    if (img && img.complete && img.naturalWidth > 0) {
      const is = 22;
      ctx.drawImage(img, pb.x - is / 2, pb.y - is / 2 - 5, is, is);
    } else {
      drawIconCtx(ctx, 'potion', pb.x, pb.y - 5, 18, '#606080');
    }
  } else {
    drawIconCtx(ctx, 'potion', pb.x, pb.y - 5, 18, ready && cd <= 0 ? '#3ef07a' : '#606080');
  }

  ctx.globalAlpha = 1;
  ctx.font = `bold 10px ${F}`; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = ready && cd <= 0 ? '#3ef07a' : 'rgba(100,100,130,0.7)';
  ctx.fillText('×' + count, pb.x, pb.y + pb.r - 3);

  // Show cooldown if active
  if (cd > 0) {
    ctx.font = `bold 9px ${F}`; ctx.fillStyle = '#f88';
    ctx.fillText(cd.toFixed(1) + 'с', pb.x, pb.y + pb.r + 10);
  } else {
    ctx.font = `7px ${F}`; ctx.fillStyle = 'rgba(120,120,150,0.55)';
    ctx.fillText('[F]', pb.x, pb.y + pb.r + 10);
  }

  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  TARGET BUTTON
// ─────────────────────────────────────────────────────────
function drawTargetButton() {
  if (!player) return;
  if (!_uiBtnGrads) _buildUiBtnGrads();
  const tb = _uiBtnGrads.tgtBtn;
  const F = 'system-ui, -apple-system, Arial';
  const hasTarget = !!targetId;

  ctx.save();

  ctx.fillStyle = hasTarget ? _uiBtnGrads.tg1 : _uiBtnGrads.tg0;
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
//  BUFF / DEBUFF STRIP  (left of skill panel)
// ─────────────────────────────────────────────────────────
function drawBuffStrip() {
  if (!player) return;
  const p = player;
  const F = 'system-ui, -apple-system, Arial';

  // Collect active buffs / debuffs
  const chips = [];

  // Potion buffs
  const pbuffs = p.buffs || {};
  for (const [btype, rem] of Object.entries(pbuffs)) {
    if (rem <= 0) continue;
    const bdef = ITEM_DEF.find(d => d.buffType === btype && d.slot === 'buff_potion');
    if (!bdef) continue;
    const secs = Math.ceil(rem);
    chips.push({ kind:'pot', img: bdef.img, label: secs < 60 ? secs + 'с' : Math.ceil(rem/60) + 'м', color:'#f0c040' });
  }

  // Skill buffs
  const skillBuffs = [
    { t: typeof barrierTimer     !== 'undefined' ? barrierTimer     : 0, icon:'barrier',   color:'#b082ff' },
    { t: typeof battleCryTimer   !== 'undefined' ? battleCryTimer   : 0, icon:'battleCry', color:'#ffc81e' },
    { t: typeof atkSpeedTimer    !== 'undefined' ? atkSpeedTimer    : 0, icon:'lightning', color:'#2ee8ff' },
    { t: typeof faithShieldTimer !== 'undefined' ? faithShieldTimer : 0, icon:'shield',    color:'#ffee44' },
    { t: typeof invisTimer       !== 'undefined' ? invisTimer       : 0, icon:'teleport',  color:'#aaddff' },
    { t: typeof dodgeTimer       !== 'undefined' ? dodgeTimer       : 0, icon:'dash',      color:'#44ff88' },
  ];
  for (const b of skillBuffs) {
    if (b.t > 0) chips.push({ kind:'icon', icon: b.icon, label: Math.ceil(b.t) + 'с', color: b.color });
  }

  // Debuffs
  if ((p.slowTimer   || 0) > 0) chips.push({ kind:'icon', icon:'wind',      label: Math.ceil(p.slowTimer)   + 'с', color:'#88ccff', debuff:true });
  if ((p.stunTimer   || 0) > 0) chips.push({ kind:'icon', icon:'holyLight', label: Math.ceil(p.stunTimer)   + 'с', color:'#ff8844', debuff:true });
  if ((p.freezeTimer || 0) > 0) chips.push({ kind:'icon', icon:'iceNova',   label: Math.ceil(p.freezeTimer) + 'с', color:'#66ddff', debuff:true });

  if (!chips.length) return;

  // 2-column icon grid to the left of the skill buttons panel
  // Skill grid: left = W-14-(SKILL_SZ+SKILL_GAP)-SKILL_SZ = W-130, bottom = H-NAV_H-14
  const SZ = 22, GAP = 3, COLS = 2;
  const skillLeft  = W - 14 - (SKILL_SZ + SKILL_GAP) - SKILL_SZ;  // W-130
  const gridRight  = skillLeft - 8;                                  // 8px gap from skills
  const gridX      = gridRight - (COLS * SZ + (COLS - 1) * GAP);   // left edge of chip area
  const gridBottom = H - NAV_H - 14;                                 // aligned with skills bottom
  const F2 = 'system-ui, -apple-system, Arial';

  ctx.save();

  for (let i = 0; i < chips.length; i++) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const cx = gridX + col * (SZ + GAP);
    const cy = gridBottom - row * (SZ + GAP) - SZ;
    const chip = chips[i];

    // Background cell
    ctx.fillStyle = chip.debuff ? 'rgba(40,5,5,0.90)' : 'rgba(8,4,22,0.90)';
    roundRect(ctx, cx, cy, SZ, SZ, 5); ctx.fill();
    ctx.globalAlpha = 0.75;
    ctx.strokeStyle = chip.color; ctx.lineWidth = 1;
    roundRect(ctx, cx, cy, SZ, SZ, 5); ctx.stroke();
    ctx.globalAlpha = 1;

    // Icon (upper portion of cell)
    const iconCX = cx + SZ / 2, iconCY = cy + SZ / 2 - 3;
    if (chip.kind === 'pot' && chip.img) {
      const img = _getPotImg(chip.img);
      if (img && img.complete && img.naturalWidth > 0)
        ctx.drawImage(img, cx + 3, cy + 2, 16, 13);
    } else {
      drawIconCtx(ctx, chip.icon, iconCX, iconCY, 11, chip.color);
    }

    // Time label at bottom of cell
    ctx.font = `bold 6px ${F2}`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = chip.color;
    ctx.fillText(chip.label, cx + SZ / 2, cy + SZ - 2);
  }

  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  PK / МИР BUTTON
// ─────────────────────────────────────────────────────────
function drawPvpButton() {
  if (!player) return;
  if (!_uiBtnGrads) _buildUiBtnGrads();
  const pb = _uiBtnGrads.pvpBtn;
  const F = 'system-ui, -apple-system, Arial';

  ctx.save();

  ctx.fillStyle = pvpMode ? _uiBtnGrads.pvg1 : _uiBtnGrads.pvg0;
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
    const op = otherPlayers.get(targetId);
    if (!op) return;
    name = op.username || '?';
    hp = op.hp || 0; maxHp = op.maxHp || 1; color = '#ff8888';
  } else {
    const e = serverEnemiesMap.get(targetId);
    if (!e) return;
    name = e.name || '?';
    hp = Math.max(0, e.hp || 0); maxHp = e.maxHp || 1; color = e.color || '#f80';
  }

  const bw = 160, bh = 42;
  const bx = W / 2 - bw / 2;
  const by = HEADER_H + 6;
  const F = 'system-ui, -apple-system, Arial';
  const pct = Math.max(0, Math.min(1, hp / maxHp));

  if (!_uiBtnGrads) _buildUiBtnGrads();
  ctx.save();

  ctx.fillStyle = _uiBtnGrads.tfBg;
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
    ctx.fillStyle = pct > 0.5 ? _uiBtnGrads.hpHi : (pct > 0.25 ? _uiBtnGrads.hpMid : _uiBtnGrads.hpLo);
    roundRect(ctx, hbx, hby, hbw * pct, hbh, 4); ctx.fill();
    ctx.fillStyle = _uiBtnGrads.tfShine;
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
  if (!_uiBtnGrads) _buildUiBtnGrads();
  const ab = _uiBtnGrads.atkBtn;
  const F = 'system-ui, -apple-system, Arial';
  const hasTarget = !!targetId;
  const animBusy = (player.atkAnimTimer || 0) > 0;
  const ready = (player.atkTimer || 0) <= 0 && !animBusy;

  ctx.save();
  ctx.fillStyle = hasTarget && ready ? _uiBtnGrads.ag1 : (!autoAttackMode ? _uiBtnGrads.ag2 : _uiBtnGrads.ag0);
  ctx.beginPath(); ctx.arc(ab.x, ab.y, ab.r, 0, Math.PI * 2); ctx.fill();

  // cooldown arc overlay while attack animation is playing
  if (animBusy && player.castDuration > 0) {
    const frac = (player.atkAnimTimer || 0) / player.castDuration;
    ctx.strokeStyle = 'rgba(255,80,40,0.55)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(ab.x, ab.y, ab.r - 1, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
    ctx.stroke();
  }

  const borderColor = !autoAttackMode
    ? (hasTarget && ready ? 'rgba(255,120,60,0.9)' : 'rgba(80,100,220,0.7)')
    : 'rgba(50,40,90,0.45)';
  ctx.strokeStyle = borderColor; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(ab.x, ab.y, ab.r, 0, Math.PI * 2); ctx.stroke();
  if (!autoAttackMode && hasTarget && ready) {
    ctx.strokeStyle = 'rgba(255,100,50,0.15)'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(ab.x, ab.y, ab.r + 2, 0, Math.PI * 2); ctx.stroke();
  }

  ctx.globalAlpha = autoAttackMode ? 0.4 : (animBusy ? 0.55 : 1);
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
  if (!_uiBtnGrads) _buildUiBtnGrads();
  const ab = _uiBtnGrads.autoBtn;
  const F = 'system-ui, -apple-system, Arial';
  ctx.save();
  ctx.fillStyle = autoAttackMode ? _uiBtnGrads.aag1 : _uiBtnGrads.aag0;
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
  const inParty = partyMembers.length > 0;
  if (inParty) return; // leave button is in party HUD
  const canInvite = targetIsPlayer && !!targetId;
  if (!canInvite) return;

  if (!_uiBtnGrads) _buildUiBtnGrads();
  const pb = _uiBtnGrads.ptyBtn;
  const F = 'system-ui, -apple-system, Arial';
  ctx.save();

  ctx.fillStyle = inParty ? _uiBtnGrads.ptg1 : _uiBtnGrads.ptg0;
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
//  PARTY HUD (all member HP bars)
// ─────────────────────────────────────────────────────────
let _partyHpGrads = null; // cached {hi,mid,lo,hbx,ctx} — invalidated on resize

function drawPartyHUD() {
  if (!partyMembers.length || !player) return;
  const F = 'system-ui, -apple-system, Arial';
  const bw = 130, bh = 26, gap = 4;
  const pvpBtn = getPvpBtnPos();
  const startX = pvpBtn.x;
  const startY = HEADER_H + BUFF_BAR_H + 56;

  // Cache the three HP bar gradients (position fixed, only depends on startX)
  const _hbx = startX + 20, _hbw = 130 - 24;
  if (!_partyHpGrads || _partyHpGrads.hbx !== _hbx || _partyHpGrads.c !== ctx) {
    const _gh = ctx.createLinearGradient(_hbx, 0, _hbx + _hbw, 0);
    _gh.addColorStop(0, '#0c5a22'); _gh.addColorStop(1, '#1ec95a');
    const _gm = ctx.createLinearGradient(_hbx, 0, _hbx + _hbw, 0);
    _gm.addColorStop(0, '#7a4200'); _gm.addColorStop(1, '#f0921a');
    const _gl = ctx.createLinearGradient(_hbx, 0, _hbx + _hbw, 0);
    _gl.addColorStop(0, '#6b0c0c'); _gl.addColorStop(1, '#e03030');
    _partyHpGrads = { hi: _gh, mid: _gm, lo: _gl, hbx: _hbx, c: ctx };
  }

  partyMembers.forEach((member, i) => {
    const op = otherPlayers.get(member.id);
    const hp = op ? (op.hp || 0) : 0;
    const maxHp = op ? (op.maxHp || 1) : 1;
    const pct = Math.max(0, Math.min(1, hp / maxHp));
    const bx = startX;
    const by = startY + i * (bh + gap);

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
    ctx.fillText((member.name || '?').slice(0, 12), bx + 20, by + 10);

    const hbx = bx + 20, hby = by + 13, hbw = bw - 24, hbh = 8;
    ctx.fillStyle = 'rgba(10,30,10,0.9)';
    roundRect(ctx, hbx, hby, hbw, hbh, 3); ctx.fill();
    if (pct > 0) {
      ctx.fillStyle = pct > 0.5 ? _partyHpGrads.hi : pct > 0.25 ? _partyHpGrads.mid : _partyHpGrads.lo;
      roundRect(ctx, hbx, hby, hbw * pct, hbh, 3); ctx.fill();
    }
    ctx.font = `6.5px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.fillText(Math.ceil(hp) + '/' + maxHp, hbx + hbw / 2, hby + hbh / 2);

    ctx.restore();
  });

  // Leave party button below member list
  const lb = getPartyLeaveBtnPos();
  ctx.save();
  const lbg = ctx.createLinearGradient(lb.x, lb.y, lb.x, lb.y + lb.h);
  lbg.addColorStop(0, 'rgba(50,10,10,0.97)'); lbg.addColorStop(1, 'rgba(25,5,5,0.99)');
  ctx.fillStyle = lbg;
  roundRect(ctx, lb.x, lb.y, lb.w, lb.h, 7); ctx.fill();
  ctx.strokeStyle = 'rgba(220,60,60,0.75)'; ctx.lineWidth = 1.2;
  roundRect(ctx, lb.x, lb.y, lb.w, lb.h, 7); ctx.stroke();
  drawIconCtx(ctx, 'partyLeave', lb.x + 13, lb.y + lb.h / 2, 10, '#ff7070');
  ctx.font = `bold 9px ${F}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ff7070';
  ctx.fillText('Выйти', lb.x + 22, lb.y + lb.h / 2);
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
//  INVENTORY ITEM MODAL
// ─────────────────────────────────────────────────────────
const _ENH_RARITY_COST = { common:40, uncommon:70, rare:120, epic:200, legendary:350 };
const _ENH_MAX = 15;
function _enhSuccessRate(enh) { return Math.max(10, 100 - enh * 10); }
function _enhStoneQty(stoneId) {
  if (!player) return 0;
  const s = player.inventory.find(i => i.id === stoneId);
  return s ? (s.qty || 1) : 0;
}
function _enhStonesBlock(actionFn, param) {
  const normQty  = _enhStoneQty('norm_stone');
  const blessQty = _enhStoneQty('bless_stone');
  const p = JSON.stringify(param);
  return `<div class="imod-enh-stones">
    <button class="imod-enh-stone-btn${normQty > 0 ? '' : ' disabled'}" onclick="${actionFn}(${p},'norm')" title="При неудаче вещь сгорит">
      <img src="/images/norm.png" width="16" height="16" style="vertical-align:middle;image-rendering:pixelated;margin-right:4px">Обычный (${normQty})
    </button>
    <button class="imod-enh-stone-btn imod-enh-stone-bless${blessQty > 0 ? '' : ' disabled'}" onclick="${actionFn}(${p},'bless')" title="При неудаче вещь останется">
      <img src="/images/bless.png" width="16" height="16" style="vertical-align:middle;image-rendering:pixelated;margin-right:4px">Безопасный (${blessQty})
    </button>
  </div>`;
}
const _RARITY_NAMES = { common:'Обычный', uncommon:'Необычный', rare:'Редкий', epic:'Эпический', legendary:'Легендарный' };
const _SLOT_NAMES   = { weapon:'Оружие', helmet:'Шлем', body:'Броня', gloves:'Перчатки', boots:'Боты', ring:'Кольцо', belt:'Пояс', use:'Расходник', material:'Материал', recipe:'Рецепт', buff_potion:'Зелье усиления' };

function openInvItemModal(idx) {
  if (!player) return;
  const it = player.inventory[idx];
  if (!it) return;

  // Buff potion — show use modal
  if (it.slot === 'buff_potion') {
    closeInvItemModal();
    const btype = it.buffType;
    const active = btype && ((player.buffs || {})[btype] || 0) > 0;
    const remaining = active ? Math.ceil((player.buffs[btype] || 0) / 60) : 0;
    const qty = it.qty || 1;
    const ov = document.createElement('div');
    ov.id = 'inv-item-modal-ov';
    ov.className = 'imod-overlay';
    ov.onclick = closeInvItemModal;
    ov.innerHTML = `<div class="imod-box" onclick="event.stopPropagation()" style="max-width:340px">
      <div class="imod-hdr">
        <span class="imod-big-icon">${_itemIcon(it, 52)}</span>
        <div class="imod-title-block">
          <div class="imod-name" style="color:#f0c040">${it.name}</div>
          <div class="imod-sub"><span style="color:#f0c040">${_RARITY_NAMES[it.rarity]||it.rarity}</span> · Зелье усиления · ×${qty}</div>
        </div>
        <button class="npc-close" onclick="closeInvItemModal()" style="touch-action:manipulation">✕</button>
      </div>
      <div class="imod-stats">${it.buffDesc || ''}</div>
      ${active ? `<div style="padding:8px 12px;background:rgba(240,192,64,0.1);border-radius:8px;color:#f0c040;font-size:12px;text-align:center">✓ Активно · осталось ~${remaining} мин</div>` : ''}
      <div class="imod-btns">
        <button class="imod-btn imod-equip${active ? ' disabled' : ''}" onclick="${active ? '' : `useBuffPotion('${it.id}');closeInvItemModal()`}">
          ${active ? 'Уже активно' : 'Использовать'}
        </button>
      </div>
    </div>`;
    document.getElementById('app').appendChild(ov);
    return;
  }

  if (_isStackable(it) || it.slot === 'use') return;

  const rc    = RARITY_COLOR[it.rarity] || '#aaa';
  const enh   = it.enhance || 0;
  const eb    = _enhBonus(it);
  const next1 = _enhBonusAt(it, 1);

  // Stats display with enhance bonus highlighted
  const statRows = [];
  if (it.atk || eb.atk) {
    const base = it.atk || 0;
    const total = base + (eb.atk || 0);
    statRows.push(`ATK <b>+${total}</b>${eb.atk ? ` <span style="color:#ffd700">(+${eb.atk})</span>` : ''}`);
  }
  if (it.def || eb.def) {
    const total = (it.def || 0) + (eb.def || 0);
    statRows.push(`DEF <b>+${total}</b>${eb.def ? ` <span style="color:#ffd700">(+${eb.def})</span>` : ''}`);
  }
  if (it.hp || eb.hp) {
    const total = (it.hp || 0) + (eb.hp || 0);
    statRows.push(`HP <b>+${total}</b>${eb.hp ? ` <span style="color:#ffd700">(+${eb.hp})</span>` : ''}`);
  }
  if (it.critChance) statRows.push(`Крит <b>${(it.critChance*100).toFixed(0)}%</b>`);
  if (it.atkSpeed)   statRows.push(`Скор <b>${(it.atkSpeed*100).toFixed(0)}%</b>`);
  if (it.hpPct)      statRows.push(`HP% <b>+${(it.hpPct*100).toFixed(0)}%</b>`);

  // Next enhance preview
  const canEnh = enh < _ENH_MAX;
  const nextParts = [];
  if (next1.atk) nextParts.push(`+${next1.atk} ATK`);
  if (next1.def) nextParts.push(`+${next1.def} DEF`);
  if (next1.hp)  nextParts.push(`+${next1.hp} HP`);

  const rate = _enhSuccessRate(enh);
  const rateColor = rate >= 80 ? '#4f4' : rate >= 50 ? '#ff0' : rate >= 30 ? '#f80' : '#f44';
  const enhBlock = canEnh
    ? `<div class="imod-enh-block">
        <div class="imod-enh-title">Заточка: ${enh > 0 ? '+' + enh : '0'} → <span style="color:#ffd700">+${enh+1}</span></div>
        ${nextParts.length ? `<div class="imod-enh-preview">${nextParts.join(' · ')}</div>` : ''}
        <div class="imod-enh-chance">Шанс: <b style="color:${rateColor}">${rate}%</b></div>
        ${_enhStonesBlock('enhanceItem', idx)}
      </div>`
    : `<div class="imod-enh-block"><div class="imod-enh-title" style="color:#ffd700">✦ Максимальная заточка</div></div>`;

  closeInvItemModal();
  const ov = document.createElement('div');
  ov.id = 'inv-item-modal-ov';
  ov.className = 'imod-overlay';
  ov.onclick = closeInvItemModal;
  ov.innerHTML = `<div class="imod-box" onclick="event.stopPropagation()">
    <div class="imod-hdr">
      <span class="imod-big-icon">${_itemIcon(it, 52)}</span>
      <div class="imod-title-block">
        <div class="imod-name" style="color:${rc}">${it.name}${enh ? ` <span style="color:#ffd700">+${enh}</span>` : ''}</div>
        <div class="imod-sub"><span style="color:${rc}">${_RARITY_NAMES[it.rarity]||it.rarity}</span> · ${_SLOT_NAMES[it.slot]||it.slot}</div>
      </div>
      <button class="npc-close" onclick="closeInvItemModal()" style="touch-action:manipulation">✕</button>
    </div>
    <div class="imod-stats">${statRows.join('<br>') || '—'}</div>
    ${enhBlock}
    <div class="imod-btns">
      <button class="imod-btn imod-equip" onclick="equipFromModal(${idx})">Надеть</button>
    </div>
  </div>`;
  document.getElementById('app').appendChild(ov);
}

function closeInvItemModal() {
  const el = document.getElementById('inv-item-modal-ov');
  if (el) el.remove();
}

function equipFromModal(idx) {
  closeInvItemModal();
  equipItem(idx);
}

function enhanceItem(idx, stoneType) {
  if (!player) return;
  const it = player.inventory[idx];
  if (!it) return;
  const enh = it.enhance || 0;
  if (enh >= _ENH_MAX) return;

  const stoneId = stoneType === 'bless' ? 'bless_stone' : 'norm_stone';
  let stoneIdx = player.inventory.findIndex(s => s.id === stoneId && (s.qty || 1) > 0);
  if (stoneIdx < 0) { dmgNum(player.x, player.y - 30, 'Нет камня!', '#f88'); return; }

  const stoneItem = player.inventory[stoneIdx];
  if ((stoneItem.qty || 1) <= 1) {
    player.inventory.splice(stoneIdx, 1);
    if (stoneIdx < idx) idx--;
  } else {
    stoneItem.qty--;
  }

  const success = Math.random() * 100 < _enhSuccessRate(enh);
  if (success) {
    it.enhance = enh + 1;
    recompute(); netSaveProgress();
    dmgNum(player.x, player.y - 30, `+${it.enhance} Успех!`, '#ffd700');
    openInvItemModal(idx);
  } else if (stoneType === 'bless') {
    recompute(); netSaveProgress();
    dmgNum(player.x, player.y - 30, 'Заточка не удалась', '#f88');
    openInvItemModal(idx);
  } else {
    player.inventory.splice(idx, 1);
    recompute(); netSaveProgress();
    closeInvItemModal();
    dmgNum(player.x, player.y - 30, 'Вещь сгорела!', '#f44');
  }
}

function openEqItemModal(slot) {
  if (!player) return;
  const it = player.equipment[slot];
  if (!it) return;

  const rc   = RARITY_COLOR[it.rarity] || '#aaa';
  const enh  = it.enhance || 0;
  const eb   = _enhBonus(it);
  const next1 = _enhBonusAt(it, 1);

  const statRows = [];
  if (it.atk || eb.atk) {
    const total = (it.atk || 0) + (eb.atk || 0);
    statRows.push(`ATK <b>+${total}</b>${eb.atk ? ` <span style="color:#ffd700">(+${eb.atk})</span>` : ''}`);
  }
  if (it.def || eb.def) {
    const total = (it.def || 0) + (eb.def || 0);
    statRows.push(`DEF <b>+${total}</b>${eb.def ? ` <span style="color:#ffd700">(+${eb.def})</span>` : ''}`);
  }
  if (it.hp || eb.hp) {
    const total = (it.hp || 0) + (eb.hp || 0);
    statRows.push(`HP <b>+${total}</b>${eb.hp ? ` <span style="color:#ffd700">(+${eb.hp})</span>` : ''}`);
  }
  if (it.critChance) statRows.push(`Крит <b>${(it.critChance*100).toFixed(0)}%</b>`);
  if (it.atkSpeed)   statRows.push(`Скор <b>${(it.atkSpeed*100).toFixed(0)}%</b>`);
  if (it.hpPct)      statRows.push(`HP% <b>+${(it.hpPct*100).toFixed(0)}%</b>`);

  const canEnh = enh < _ENH_MAX;
  const nextParts = [];
  if (next1.atk) nextParts.push(`+${next1.atk} ATK`);
  if (next1.def) nextParts.push(`+${next1.def} DEF`);
  if (next1.hp)  nextParts.push(`+${next1.hp} HP`);

  const rate2 = _enhSuccessRate(enh);
  const rateColor2 = rate2 >= 80 ? '#4f4' : rate2 >= 50 ? '#ff0' : rate2 >= 30 ? '#f80' : '#f44';
  const enhBlock = canEnh
    ? `<div class="imod-enh-block">
        <div class="imod-enh-title">Заточка: ${enh > 0 ? '+' + enh : '0'} → <span style="color:#ffd700">+${enh+1}</span></div>
        ${nextParts.length ? `<div class="imod-enh-preview">${nextParts.join(' · ')}</div>` : ''}
        <div class="imod-enh-chance">Шанс: <b style="color:${rateColor2}">${rate2}%</b></div>
        ${_enhStonesBlock('enhanceEqItem', slot)}
      </div>`
    : `<div class="imod-enh-block"><div class="imod-enh-title" style="color:#ffd700">✦ Максимальная заточка</div></div>`;

  closeInvItemModal();
  const ov = document.createElement('div');
  ov.id = 'inv-item-modal-ov';
  ov.className = 'imod-overlay';
  ov.onclick = closeInvItemModal;
  ov.innerHTML = `<div class="imod-box" onclick="event.stopPropagation()">
    <div class="imod-hdr">
      <span class="imod-big-icon">${_itemIcon(it, 52)}</span>
      <div class="imod-title-block">
        <div class="imod-name" style="color:${rc}">${it.name}${enh ? ` <span style="color:#ffd700">+${enh}</span>` : ''}</div>
        <div class="imod-sub"><span style="color:${rc}">${_RARITY_NAMES[it.rarity]||it.rarity}</span> · ${_SLOT_NAMES[it.slot]||it.slot} · <span style="color:#7ab8ff">Надето</span></div>
      </div>
      <button class="npc-close" onclick="closeInvItemModal()" style="touch-action:manipulation">✕</button>
    </div>
    <div class="imod-stats">${statRows.join('<br>') || '—'}</div>
    ${enhBlock}
    <div class="imod-btns">
      <button class="imod-btn imod-equip" style="background:linear-gradient(135deg,#3a1a1a,#6a2a2a);color:#ff9999" onclick="unequipFromModal('${slot}')">Снять</button>
    </div>
  </div>`;
  document.getElementById('app').appendChild(ov);
}

function unequipFromModal(slot) {
  closeInvItemModal();
  unequipItem(slot);
}

function enhanceEqItem(slot, stoneType) {
  if (!player) return;
  const it = player.equipment[slot];
  if (!it) return;
  const enh = it.enhance || 0;
  if (enh >= _ENH_MAX) return;

  const stoneId = stoneType === 'bless' ? 'bless_stone' : 'norm_stone';
  const stoneIdx = player.inventory.findIndex(s => s.id === stoneId && (s.qty || 1) > 0);
  if (stoneIdx < 0) { dmgNum(player.x, player.y - 30, 'Нет камня!', '#f88'); return; }

  const stoneItem = player.inventory[stoneIdx];
  if ((stoneItem.qty || 1) <= 1) { player.inventory.splice(stoneIdx, 1); }
  else { stoneItem.qty--; }

  const success = Math.random() * 100 < _enhSuccessRate(enh);
  if (success) {
    it.enhance = enh + 1;
    recompute(); netSaveProgress();
    dmgNum(player.x, player.y - 30, `+${it.enhance} Успех!`, '#ffd700');
    openEqItemModal(slot);
  } else if (stoneType === 'bless') {
    recompute(); netSaveProgress();
    dmgNum(player.x, player.y - 30, 'Заточка не удалась', '#f88');
    openEqItemModal(slot);
  } else {
    player.equipment[slot] = null;
    recompute(); netSaveProgress();
    closeInvItemModal();
    dmgNum(player.x, player.y - 30, 'Вещь сгорела!', '#f44');
  }
}

// ─────────────────────────────────────────────────────────
//  DEAD SCREEN
// ─────────────────────────────────────────────────────────
function drawDead() {
  ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillRect(0, 0, W, H);
}

// ─────────────────────────────────────────────────────────
//  GRAM WALLET (Profile tab)
// ─────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────
//  RATING PANEL
// ─────────────────────────────────────────────────────────
let _ratingTab = 'players';
let _ratingData = { players: null, clans: null };

function _positionRatingBtn() {
  const btn = document.getElementById('rating-btn');
  if (!btn) return;
  // Position below the minimap, aligned to the right edge
  const mmPad = 6;
  const mmH = HEADER_H - mmPad * 2;
  const mmW = Math.floor(Math.min(mmH * 1.3, W * 0.27));
  const mmX = W - mmW - mmPad - 4;
  btn.style.top   = (HEADER_H + 6) + 'px';
  btn.style.left  = mmX + 'px';
  btn.style.width = (mmW + 8) + 'px';
  btn.style.right = 'auto';
  btn.style.transform = 'none';
}

function showRatingBtn() {
  const btn = document.getElementById('rating-btn');
  if (btn) { btn.style.display = 'flex'; _positionRatingBtn(); }
}

function openRatingPanel() {
  const panel = document.getElementById('rating-panel');
  if (!panel) return;
  panel.style.display = 'flex';
  switchRatingTab(_ratingTab);
}

function closeRatingPanel() {
  const panel = document.getElementById('rating-panel');
  if (panel) panel.style.display = 'none';
}

function switchRatingTab(tab) {
  _ratingTab = tab;
  document.querySelectorAll('.rating-tab').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('rtab-' + tab);
  if (btn) btn.classList.add('active');
  _renderRatingBody();
  if (typeof netGetRating === 'function') netGetRating(tab);
}

function onRatingData(tab, rows) {
  _ratingData[tab] = rows;
  if (_ratingTab === tab) _renderRatingBody();
}

function _renderRatingBody() {
  const el = document.getElementById('rating-body');
  if (!el) return;
  const rows = _ratingData[_ratingTab];
  if (!rows) {
    el.innerHTML = '<div class="rating-loading">Загрузка...</div>';
    return;
  }
  if (!rows.length) {
    el.innerHTML = '<div class="rating-empty">Нет данных</div>';
    return;
  }

  if (_ratingTab === 'players') {
    const myUsername = typeof netUsername !== 'undefined' ? netUsername : '';
    let html = '';
    rows.forEach((r, i) => {
      const isGap = r.gap;
      if (isGap) {
        html += `<div class="rating-gap">• • •</div>`;
      }
      const rank = r.rank != null ? r.rank : i + 1;
      const rankCls = rank === 1 ? 'rating-rank-1' : rank === 2 ? 'rating-rank-2' : rank === 3 ? 'rating-rank-3' : '';
      const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank;
      const isMe = r.username === myUsername || r.isSelf;
      const init = (r.username || '?')[0].toUpperCase();
      html += `<div class="rating-row${isMe ? ' rating-me' : ''}">
        <div class="rating-rank ${rankCls}">${medal}</div>
        <div class="rating-avatar">${init}</div>
        <div style="flex:1;min-width:0">
          <div class="rating-name">@${r.username}${isMe ? ' <span style="font-size:10px;color:#ffd23c;opacity:.7">(вы)</span>' : ''}</div>
          <div class="rating-sub">Ур. ${r.level || 1}</div>
        </div>
        <div class="rating-bm">
          <div class="rating-bm-val">${(r.bm || 0).toLocaleString()}</div>
          <div class="rating-bm-lbl">БМ</div>
        </div>
      </div>`;
    });
    el.innerHTML = html;
  } else {
    el.innerHTML = rows.map((r, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1);
      const rankCls = i === 0 ? 'rating-rank-1' : i === 1 ? 'rating-rank-2' : i === 2 ? 'rating-rank-3' : '';
      return `<div class="rating-row">
        <div class="rating-rank ${rankCls}">${medal}</div>
        <div class="rating-clan-icon">${typeof clanIconSVG === 'function' ? clanIconSVG(r.icon || 1, 22) : '🛡'}</div>
        <div style="flex:1;min-width:0">
          <div class="rating-name">${r.name}</div>
          <div class="rating-sub">${r.memberCount} участн.</div>
        </div>
        <div class="rating-bm">
          <div class="rating-bm-val">${(r.totalBm || 0).toLocaleString()}</div>
          <div class="rating-bm-lbl">БМ</div>
        </div>
      </div>`;
    }).join('');
  }
}

let _gramTxList = [];
let _refFriendsList = [];

function switchProfileTab(tab) {
  window._profileTab = tab;
  document.querySelectorAll('.profile-tab').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('ptab-' + tab);
  if (btn) btn.classList.add('active');
  if (tab === 'wallet') updateGramUI();
  else updateFriendsUI();
}

function updateFriendsUI() {
  const el = document.getElementById('gram-body');
  if (!el) return;
  const refLink = window._refLink || '';
  const friends = _refFriendsList;
  const totalBonus = friends.reduce((s, f) => s + (f.bonus || 0), 0);

  el.innerHTML = `
    <div class="ref-card">
      <div class="ref-card-title">Ваша реферальная ссылка</div>
      <div class="ref-link-box">
        <span id="ref-link-val" style="flex:1;font-size:12px">${refLink || 'Загрузка...'}</span>
        <button class="ref-copy-btn" onclick="refCopyLink()">Копировать</button>
      </div>
      <div style="font-size:11px;color:#556688;margin-top:8px">За каждый депозит друга вы получаете <b style="color:#4ecb71">5%</b></div>
    </div>

    <div class="ref-stats-row">
      <div class="ref-stat-box">
        <div class="ref-stat-num">${friends.length}</div>
        <div class="ref-stat-lbl">Друзей</div>
      </div>
      <div class="ref-stat-box">
        <div class="ref-stat-num">${totalBonus.toFixed(2)}</div>
        <div class="ref-stat-lbl">GRAM получено</div>
      </div>
    </div>

    <div class="gram-section-title" style="margin-bottom:8px">Список друзей</div>
    <div id="ref-friends-list">
      ${friends.length === 0
        ? '<div class="ref-empty">Пока нет приглашённых друзей<br><span style="font-size:12px">Отправьте ссылку и получайте бонусы</span></div>'
        : friends.map(f => {
            const init = (f.username || '?')[0].toUpperCase();
            return `<div class="ref-friend-row">
              <div class="ref-friend-avatar">${init}</div>
              <div class="ref-friend-name">@${f.username || 'игрок'}</div>
              <div class="ref-friend-bonus">+${(f.bonus || 0).toFixed(2)} GRAM</div>
            </div>`;
          }).join('')
      }
    </div>
  `;

  if (typeof netGetReferrals === 'function') netGetReferrals();
}

function refCopyLink() {
  const link = window._refLink || '';
  if (!link) return;
  navigator.clipboard.writeText(link).then(() => {
    const btn = document.querySelector('.ref-copy-btn');
    if (btn) { const old = btn.textContent; btn.textContent = 'Скопировано!'; btn.style.color = '#4ecb71'; setTimeout(() => { btn.textContent = old; btn.style.color = ''; }, 2000); }
  }).catch(() => {});
}

function onRefData(data) {
  _refFriendsList = data.friends || [];
  window._refLink = data.refLink || '';
  if (window._profileTab === 'friends') updateFriendsUI();
}

function onFriendJoined(data) {
  _refFriendsList.unshift({ username: data.username, bonus: 0 });
  const el = document.getElementById('ref-friends-list');
  if (el && window._profileTab === 'friends') updateFriendsUI();
  // Toast notification
  const toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;top:80px;left:50%;transform:translateX(-50%);background:#1a3a2a;border:1px solid #4ecb71;color:#4ecb71;padding:10px 18px;border-radius:10px;font-size:13px;font-weight:600;z-index:9999;pointer-events:none';
  toast.textContent = `Друг @${data.username || 'игрок'} присоединился!`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function onRefBonusReceived(data) {
  const f = _refFriendsList.find(x => x.username === data.fromUsername);
  if (f) f.bonus = (f.bonus || 0) + data.bonus;
  if (window._profileTab === 'friends') updateFriendsUI();
  const toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;top:80px;left:50%;transform:translateX(-50%);background:#1a2a3a;border:1px solid #7eb8ff;color:#7eb8ff;padding:10px 18px;border-radius:10px;font-size:13px;font-weight:600;z-index:9999;pointer-events:none';
  toast.textContent = `+${data.bonus.toFixed(2)} GRAM от реферала @${data.fromUsername}`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function updateGramUI() {
  const el = document.getElementById('gram-body');
  if (!el) return;
  const balance = window._gramBalance || 0;

  el.innerHTML = `
    <div class="gram-balance-card">
      <div class="gram-balance-label">Баланс GRAM</div>
      <div class="gram-balance-amount" id="gram-balance-val">${balance.toFixed(2)} <span class="gram-unit">GRAM</span></div>
    </div>

    <div style="display:flex;gap:10px;margin-bottom:14px">
      <button class="gram-btn gram-btn-green" style="flex:1;padding:13px" onclick="openGramDepositModal()">
        ↓ Пополнить
      </button>
      <button class="gram-btn gram-btn-orange" style="flex:1;padding:13px" onclick="openGramWithdrawModal()">
        ↑ Вывести
      </button>
    </div>

    <div class="gram-section">
      <div class="gram-section-title">История операций</div>
      <div id="gram-history-list"><div class="gram-hint" style="text-align:center;padding:12px 0">Загрузка...</div></div>
    </div>
  `;

  if (typeof netGramHistory === 'function') netGramHistory();
}

function _renderGramHistory() {
  const el = document.getElementById('gram-history-list');
  if (!el) return;
  if (!_gramTxList.length) {
    el.innerHTML = '<div class="gram-hint" style="text-align:center;padding:12px 0">Операций пока нет</div>';
    return;
  }
  el.innerHTML = _gramTxList.map(tx => {
    const isDeposit = tx.type === 'deposit';
    const statusCls = tx.status === 'confirmed' ? 'gram-st-ok' : tx.status === 'rejected' ? 'gram-st-no' : 'gram-st-wait';
    const statusLbl = tx.status === 'confirmed' ? '✓ Выполнено' : tx.status === 'rejected' ? '✕ Отклонено' : '⏳ Ожидание';
    const date = new Date(tx.createdAt).toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
    return `<div class="gram-tx-row">
      <div class="gram-tx-icon ${isDeposit ? 'gram-tx-dep' : 'gram-tx-wd'}">${isDeposit ? '↓' : '↑'}</div>
      <div class="gram-tx-info">
        <div class="gram-tx-type">${isDeposit ? 'Пополнение' : 'Вывод'}</div>
        <div class="gram-tx-date">${date}</div>
      </div>
      <div style="text-align:right">
        <div class="gram-tx-amount ${isDeposit ? 'gram-tx-dep' : 'gram-tx-wd'}">${isDeposit ? '+' : '-'}${tx.amount} GRAM</div>
        <div class="gram-tx-status ${statusCls}">${statusLbl}</div>
      </div>
    </div>`;
  }).join('');
}

function onGramHistory(txs) {
  _gramTxList = txs || [];
  _renderGramHistory();
}

function onGramTxCreated(tx) {
  _gramTxList.unshift(tx);
  _renderGramHistory();
  const bal = document.getElementById('gram-balance-val');
  if (bal) bal.textContent = (window._gramBalance || 0).toFixed(2) + ' ';
}

function onGramTxUpdate(id, status) {
  const tx = _gramTxList.find(t => t.id === id);
  if (tx) { tx.status = status; _renderGramHistory(); }
  const bal = document.getElementById('gram-balance-val');
  if (bal) bal.textContent = (window._gramBalance || 0).toFixed(2) + ' ';
}

// ── Deposit modal ─────────────────────────────────────────
function openGramDepositModal() {
  const wallet = window._gramWallet || 'Адрес не настроен';
  const memo   = (player && player.telegramId) ? player.telegramId
                 : (window.netUsername || String(Date.now()));
  const html = `
    <div id="gram-modal-overlay" onclick="closeGramModal()" style="position:fixed;inset:0;z-index:400;background:rgba(0,0,0,.75);backdrop-filter:blur(4px);display:flex;align-items:flex-end;justify-content:center;">
      <div onclick="event.stopPropagation()" style="width:100%;max-width:500px;background:#0d0818;border-radius:18px 18px 0 0;border-top:1px solid rgba(255,255,255,.1);padding:22px 20px 36px;">
        <div style="display:flex;align-items:center;margin-bottom:18px">
          <div style="font-size:16px;font-weight:800;color:#3ef07a">Пополнение GRAM</div>
          <button onclick="closeGramModal()" style="margin-left:auto;width:28px;height:28px;border:none;border-radius:50%;background:rgba(255,255,255,.08);color:#888;cursor:pointer">✕</button>
        </div>

        <div class="gram-hint" style="margin-bottom:6px">Переведите GRAM на адрес кошелька:</div>
        <div class="gram-copy-box" onclick="gramCopy('gram-addr-val')">
          <span id="gram-addr-val">${wallet}</span>
          <span class="gram-copy-icon">⎘</span>
        </div>

        <div class="gram-hint" style="margin:12px 0 6px">Обязательно укажите MEMO (комментарий):</div>
        <div class="gram-copy-box" onclick="gramCopy('gram-memo-val')">
          <span id="gram-memo-val">${memo}</span>
          <span class="gram-copy-icon">⎘</span>
        </div>

        <div class="gram-warn">⚠ Без мемо перевод не будет зачислен</div>

        <div style="margin:16px 0 10px">
          <div class="gram-hint" style="margin-bottom:6px">Сумма перевода:</div>
          <input id="gram-dep-amount" type="number" min="1" step="0.01" placeholder="Введите сумму GRAM" class="gram-input" style="width:100%;box-sizing:border-box">
        </div>

        <button class="gram-btn gram-btn-green" style="width:100%;padding:14px;font-size:15px" onclick="gramDepositConfirm('${memo}')">
          Я оплатил ✓
        </button>
        <div id="gram-modal-msg" class="gram-msg" style="display:none;margin-top:10px"></div>
      </div>
    </div>`;
  const div = document.createElement('div');
  div.id = 'gram-modal-wrap';
  div.innerHTML = html;
  document.body.appendChild(div);
}

function gramDepositConfirm(memo) {
  const amount = parseFloat(document.getElementById('gram-dep-amount').value);
  if (!amount || amount < 1) { _gramModalMsg('Введите сумму от 1 GRAM', 'err'); return; }
  if (typeof netGramDeposit === 'function') {
    netGramDeposit(amount, memo);
    closeGramModal();
    _gramMsg('Заявка на пополнение создана — ожидайте подтверждения', 'ok');
  } else {
    _gramModalMsg('Сервис недоступен', 'err');
  }
}

// ── Withdraw modal ────────────────────────────────────────
function openGramWithdrawModal() {
  const balance = window._gramBalance || 0;
  const html = `
    <div id="gram-modal-overlay" onclick="closeGramModal()" style="position:fixed;inset:0;z-index:400;background:rgba(0,0,0,.75);backdrop-filter:blur(4px);display:flex;align-items:flex-end;justify-content:center;">
      <div onclick="event.stopPropagation()" style="width:100%;max-width:500px;background:#0d0818;border-radius:18px 18px 0 0;border-top:1px solid rgba(255,255,255,.1);padding:22px 20px 36px;">
        <div style="display:flex;align-items:center;margin-bottom:18px">
          <div style="font-size:16px;font-weight:800;color:#f0a040">Вывод GRAM</div>
          <button onclick="closeGramModal()" style="margin-left:auto;width:28px;height:28px;border:none;border-radius:50%;background:rgba(255,255,255,.08);color:#888;cursor:pointer">✕</button>
        </div>

        <div style="background:rgba(240,160,64,0.08);border:1px solid rgba(240,160,64,0.2);border-radius:10px;padding:10px 14px;margin-bottom:16px;font-size:13px;color:#c0a060">
          Доступно: <b>${balance.toFixed(2)} GRAM</b>
        </div>

        <div style="margin-bottom:12px">
          <div class="gram-hint" style="margin-bottom:6px">Сумма вывода (мин. 10 GRAM):</div>
          <input id="gram-wd-amount" type="number" min="10" step="0.01" placeholder="Сумма GRAM" class="gram-input" style="width:100%;box-sizing:border-box">
        </div>

        <div style="margin-bottom:16px">
          <div class="gram-hint" style="margin-bottom:6px">TON-адрес получателя:</div>
          <input id="gram-wd-addr" type="text" placeholder="UQ..." class="gram-input gram-input-addr" style="width:100%;box-sizing:border-box">
        </div>

        <button class="gram-btn gram-btn-orange" style="width:100%;padding:14px;font-size:15px" onclick="gramWithdrawConfirm()">
          Подать заявку на вывод
        </button>
        <div id="gram-modal-msg" class="gram-msg" style="display:none;margin-top:10px"></div>
      </div>
    </div>`;
  const div = document.createElement('div');
  div.id = 'gram-modal-wrap';
  div.innerHTML = html;
  document.body.appendChild(div);
}

function gramWithdrawConfirm() {
  const amount = parseFloat(document.getElementById('gram-wd-amount').value);
  const addr   = (document.getElementById('gram-wd-addr').value || '').trim();
  const balance = window._gramBalance || 0;
  if (!amount || amount < 10)    { _gramModalMsg('Минимум 10 GRAM', 'err'); return; }
  if (!addr)                     { _gramModalMsg('Введите TON-адрес', 'err'); return; }
  if (amount > balance)          { _gramModalMsg('Недостаточно средств', 'err'); return; }
  if (typeof netGramWithdraw === 'function') {
    netGramWithdraw(amount, addr);
    closeGramModal();
    _gramMsg('Заявка на вывод создана — ожидайте подтверждения', 'ok');
  } else {
    _gramModalMsg('Сервис недоступен', 'err');
  }
}

function gramCopy(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  navigator.clipboard?.writeText(el.textContent.trim()).then(() => {
    el.style.color = '#3ef07a';
    setTimeout(() => { el.style.color = ''; }, 1000);
  });
}

function closeGramModal() {
  const w = document.getElementById('gram-modal-wrap');
  if (w) w.remove();
}

function _gramModalMsg(text, type) {
  const el = document.getElementById('gram-modal-msg');
  if (!el) return;
  el.textContent = text;
  el.style.display = 'block';
  el.className = 'gram-msg ' + (type === 'err' ? 'gram-msg-err' : 'gram-msg-ok');
}

function _gramMsg(text, type) {
  const el = document.getElementById('gram-msg');
  if (!el) return;
  el.textContent = text;
  el.style.display = 'block';
  el.className = 'gram-msg ' + (type === 'err' ? 'gram-msg-err' : 'gram-msg-ok');
  clearTimeout(_gramMsg._t);
  _gramMsg._t = setTimeout(() => { if (el) el.style.display = 'none'; }, 5000);
}
