// ─────────────────────────────────────────────────────────
//  PANEL UIs
// ─────────────────────────────────────────────────────────
function _itemIcon(it, size) {
  if (it && it.img) {
    return `<img src="${it.img}" width="${size}" height="${size}"
      style="image-rendering:pixelated;border-radius:3px;"
      onerror="this.style.display='none'">`;
  }
  const rc = it ? (RARITY_COLOR[it.rarity] || '#aea599') : '#6c6354';
  return iconHTML((it && it.icon) || 'weapon', size, rc);
}
function updateInvUI() {
  if (!player) return;
  const p = player;
  const inv = p.inventory;

  // Equipment grid (5 columns × 2 rows)
  document.getElementById('eq-grid').innerHTML = EQ_SLOTS.map(({ slot, label, emptyIcon }) => {
    const it = p.equipment[slot];
    const rc = it ? (RARITY_COLOR[it.rarity] || '#aea599') : '';
    const enhBadge = it && it.enhance ? `<span style="position:absolute;top:1px;right:2px;font-size:7px;color:#e69419;font-weight:bold">+${it.enhance}</span>` : '';
    return `<div class="eq-cell${it ? ' filled' : ''}" onclick="${it ? `openEqItemModal('${slot}')` : ''}"
      title="${it ? it.name + (it.enhance ? ' +' + it.enhance : '') + ' — ' + statStr(it) : label}"
      style="${it ? 'border-color:' + rc + '55;position:relative' : ''}">
      <div class="cell-icon">${it ? _itemIcon(it, 28) : iconHTML(emptyIcon, 22, '#6c6354')}</div>
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
        <div style="font-size:11px;color:#a2988a;margin-top:2px">Уровень ${p.lvl}</div>
        <div style="font-size:11px;color:#5d564b;margin-top:2px;display:flex;align-items:center;gap:3px">
          ${iconHTML('heart',11,'#da4658')}${Math.ceil(p.hp)}/${p.maxHp} ·
          <span style="color:#eaa742;font-weight:700">БМ ${typeof calcBM==='function'?calcBM(p):0}</span> ·
          ${iconHTML('coin',11,'#e3941d')}${p.gold}
        </div>
      </div>
      <div onclick="openHpPicker()" style="color:#98e456;text-align:right;font-weight:bold;display:flex;flex-direction:column;align-items:center;gap:1px;cursor:pointer">
        ${_hudPtDef && _hudPtDef.img ? `<img src="${_hudPtDef.img}" width="20" height="20" style="image-rendering:pixelated">` : iconHTML('potion',20,'#90d653')}
        <span style="font-size:10px">×${_hudCount}</span>
        ${_activeBufCount > 0 ? `<span style="font-size:9px;color:#e5a546">${_activeBufCount} бафф</span>` : ''}
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
    const rc = RARITY_COLOR[it.rarity] || '#aea599';
    const enh = it.enhance ? `<span style="position:absolute;top:1px;right:2px;font-size:7px;color:#e69419;font-weight:bold">+${it.enhance}</span>` : '';
    const cntBadge = count ? `<span style="position:absolute;bottom:1px;right:2px;font-size:7px;color:#cfc0ad;font-weight:bold">×${count}</span>` : '';
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
      : iconHTML(def.icon || 'potion', 28, isHud ? '#90d653' : '#9c9383');
    return `<div onclick="setHudPotion('${def.id}');openHpPicker()" style="
      flex:1;padding:10px 6px;border-radius:10px;text-align:center;cursor:pointer;
      border:2px solid ${isHud ? '#90d653' : 'rgba(209,204,197,0.1)'};
      background:${isHud ? 'rgba(143,214,82,0.12)' : 'rgba(209,204,197,0.04)'};
    ">
      ${imgEl}
      <div style="font-size:10px;color:${isHud ? '#90d653' : '#968a7a'};font-weight:${isHud?'700':'400'}">${def.name}</div>
      <div style="font-size:11px;color:#98e456;margin-top:2px">×${cnt}</div>
      <div style="font-size:9px;color:#72685a">HP+${def.hp} · откат 4с</div>
      ${isHud ? '<div style="font-size:9px;color:#90d653;font-weight:700;margin-top:2px">✓ В HUD</div>' : ''}
    </div>`;
  }).join('');

  const autoRows = autoThresholds.map((v, i) => {
    const isActive = Math.abs(curAuto - v) < 0.01;
    return `<button onclick="setAutoHpPct(${v})" style="
      flex:1;padding:8px 4px;border:none;border-radius:8px;cursor:pointer;font-size:12px;font-weight:700;
      background:${isActive ? '#29361e' : 'rgba(209,204,197,0.06)'};
      color:${isActive ? '#90d653' : '#968a7a'};
      border:1px solid ${isActive ? '#90d65344' : 'transparent'};
    ">${autoLabels[i]}</button>`;
  }).join('');

  const ov = document.createElement('div');
  ov.id = 'hp-picker-ov';
  ov.onclick = () => ov.remove();
  ov.style.cssText = 'position:fixed;inset:0;z-index:220;background:rgba(0,0,0,.75);backdrop-filter:blur(4px);display:flex;align-items:flex-end;justify-content:center;';
  ov.innerHTML = `<div onclick="event.stopPropagation()" style="width:100%;background:#16120a;border-radius:18px 18px 0 0;border-top:1px solid rgba(209,204,197,.1);padding:18px 16px 30px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <div style="font-size:15px;font-weight:800;color:#90d653">Зелья лечения</div>
      <button onclick="document.getElementById('hp-picker-ov').remove()" style="width:28px;height:28px;border:none;border-radius:50%;background:rgba(209,204,197,.08);color:#968a7a;font-size:13px;cursor:pointer;">✕</button>
    </div>
    <div style="display:flex;gap:10px;margin-bottom:16px">${potCells}</div>
    <div style="font-size:11px;color:#72685a;margin-bottom:8px">Авто-использование при HP &lt;</div>
    <div style="display:flex;gap:8px">${autoRows}</div>
    <button onclick="usePotion();document.getElementById('hp-picker-ov').remove()" style="
      width:100%;margin-top:14px;padding:12px;border:none;border-radius:12px;
      background:linear-gradient(135deg,#29361e,#415331);color:#90d653;font-size:15px;font-weight:700;cursor:pointer;
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
  dmgNum(player.x, player.y - 26, '+' + heal + '♥', '#98e456');
  spawnBurst(player.x, player.y, '#98e456', 5);
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
      <div class="stat-card"><div class="stat-ic">${iconHTML('heart',14,'#da4658')}</div><div class="stat-vl">${Math.ceil(p.hp)}</div><div class="stat-nm">HP</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('sword',14,'#da952e')}</div><div class="stat-vl">${p.atk}</div><div class="stat-nm">Атака</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('shield',14,'#d1aa65')}</div><div class="stat-vl">${p.def}</div><div class="stat-nm">Защита</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('lightning',14,'#e3941d')}</div><div class="stat-vl">${p.atkSpeed.toFixed(2)}</div><div class="stat-nm">Скор. ат.</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('star',14,'#da4658')}</div><div class="stat-vl">${fmt1(p.critChance)}</div><div class="stat-nm">Крит шанс</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('flame',14,'#da952e')}</div><div class="stat-vl">${p.critPower.toFixed(2)}x</div><div class="stat-nm">Крит сила</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('hpPlus',14,'#79b644')}</div><div class="stat-vl">${p.hpRegen.toFixed(2)}</div><div class="stat-nm">HP реген</div></div>
    </div>`;
  updateUpgradeUI();
}

function updateUpgradeUI() {
  if (!player) return;
  const el = document.getElementById('upgrade-grid');
  if (!el) return;
  const goldLbl = document.getElementById('upg-gold-lbl');
  if (goldLbl) goldLbl.innerHTML = iconHTML('coin', 14, '#e3941d') + ' ' + player.gold;
  const availSP = getAvailableSkillPoints();
  const spLbl = document.getElementById('upg-sp-lbl');
  if (spLbl) spLbl.textContent = `Очки навыка: ${availSP}`;
  const u = player.upgrades || {};
  el.innerHTML = Object.entries(UPGRADE_DEF).map(([key, cfg]) => {
    const lvl  = u[key] || 0;
    const cost = 300 * (lvl + 1);
    const can  = player.gold >= cost && availSP >= 1;
    return `<div class="upg-row">
      <div class="upg-info">
        <span class="upg-label">${iconHTML(cfg.icon, 14, '#b2a58e')} ${cfg.label}</span>
        <span class="upg-meta">Ур.${lvl} · ${cfg.desc}</span>
      </div>
      <button class="upg-btn${can ? '' : ' disabled'}" onclick="upgradeStats('${key}')">
        ${iconHTML('coin',12,'#e3941d')}${cost} + 1 ОН
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

const SKILL_STUDY_COST   = 1;   // books to unlock a level-0 (locked) skill
const SKILL_UPGRADE_COST = 2;   // books per upgrade attempt once studied
const SKILL_UPGRADE_CHANCE = 0.30;

function updateSkillsUI() {
  if (!player) return;
  const el = document.getElementById('skill-upgrade-panel');
  if (!el) return;
  const skills = SKILL_DEF[player.type];
  if (!skills) { el.innerHTML = '<div style="padding:16px;color:#645f57;text-align:center">Выберите персонажа</div>'; return; }
  const bonusTypes = (SKILL_BONUS_TYPE || {})[player.type] || {};
  const sl = player.skillLevels || {};
  const books = typeof countMaterial === 'function' ? countMaterial('skill_book') : 0;

  el.innerHTML = `
    <div class="skill-upg-header">
      <span>${iconHTML('book', 13, '#e3941d')} <span id="skill-book-lbl">${books}</span> книг навыков</span>
      <span class="skill-upg-hint">Изучение: ${SKILL_STUDY_COST} кн. · Улучшение: ${SKILL_UPGRADE_COST} кн. · ${Math.round(SKILL_UPGRADE_CHANCE * 100)}% шанс</span>
    </div>
    ${skills.map(sk => {
      const level = sl[sk.key] || 0;
      const locked = level <= 0;
      const maxed = level >= 10;
      const bonusType = bonusTypes[sk.key] || 'damage';
      const bonusNow  = locked ? null : _skillBonusDesc(bonusType, level);
      const bonusNext = (locked || maxed) ? null : _skillBonusDesc(bonusType, level + 1);

      const dots = Array.from({ length: 10 }, (_, i) =>
        `<span class="sk-dot${i < level ? ' filled' : ''}"></span>`
      ).join('');

      const iconEl = sk.img
        ? `<img src="${sk.img}" width="26" height="26" style="image-rendering:pixelated;border-radius:4px;opacity:${locked ? 0.35 : 1}">`
        : iconHTML(sk.icon, 26, locked ? '#645f57' : '#e3941d');

      let btnLabel, btnAction, btnDisabled;
      if (locked) {
        btnDisabled = books < SKILL_STUDY_COST;
        btnLabel = iconHTML('book', 12, '#e3941d') + ` ${SKILL_STUDY_COST} · Изучить`;
        btnAction = `studySkill('${sk.key}')`;
      } else if (maxed) {
        btnDisabled = true;
        btnLabel = 'Максимум';
        btnAction = '';
      } else {
        btnDisabled = books < SKILL_UPGRADE_COST;
        btnLabel = iconHTML('book', 12, '#e3941d') + ` ${SKILL_UPGRADE_COST} · Улучшить (${Math.round(SKILL_UPGRADE_CHANCE * 100)}%)`;
        btnAction = `upgradeSkillWithBook('${sk.key}')`;
      }

      return `<div class="skill-upg-card">
        <div class="skill-upg-top">
          <div class="skill-upg-icon" style="position:relative">
            ${iconEl}
            ${locked ? `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">${iconHTML('lock', 15, '#d1ccc5')}</div>` : ''}
          </div>
          <div class="skill-upg-info">
            <div class="skill-upg-name">${sk.name}<span class="skill-upg-lvl">${locked ? ' 🔒 Не изучен' : maxed ? ' МАКС' : ' Ур.' + level}</span></div>
            <div class="skill-upg-desc">${sk.desc}</div>
            ${!locked ? `<div class="skill-upg-type">${_skillBonusTypeLabel(bonusType)}</div>` : ''}
          </div>
        </div>
        ${!locked ? `<div class="sk-dots">${dots}</div>` : ''}
        ${!locked ? `<div class="sk-bonus-row">
          ${bonusNow ? `<span class="sk-bonus-now">${bonusNow}</span>` : ''}
          ${bonusNext ? `<span class="sk-bonus-next">→ ${bonusNext}</span>` : ''}
        </div>` : ''}
        <button class="skill-upg-btn${btnDisabled ? ' disabled' : ''}" onclick="${btnAction}">${btnLabel}</button>
      </div>`;
    }).join('')}
  `;
}

function studySkill(key) {
  if (!player) return;
  const sl = player.skillLevels || (player.skillLevels = { Q:0, W:0, E:0, R:0 });
  if ((sl[key] || 0) > 0) return; // already studied
  if (countMaterial('skill_book') < SKILL_STUDY_COST) {
    dmgNum(player.x, player.y - 30, 'Нужна книга навыков!', '#f17e8b');
    return;
  }
  removeFromInventory('skill_book', SKILL_STUDY_COST);
  sl[key] = 1;
  spawnBurst(player.x, player.y, '#e69419', 10);
  dmgNum(player.x, player.y - 42, 'Навык изучен!', '#e69419');
  netSaveProgress();
  updateSkillsUI();
  updateInvUI();
}

function upgradeSkillWithBook(key) {
  if (!player) return;
  const sl = player.skillLevels || (player.skillLevels = { Q:0, W:0, E:0, R:0 });
  const lvl = sl[key] || 0;
  if (lvl <= 0) { dmgNum(player.x, player.y - 30, 'Сначала изучите навык!', '#f17e8b'); return; }
  if (lvl >= 10) return;
  if (countMaterial('skill_book') < SKILL_UPGRADE_COST) {
    dmgNum(player.x, player.y - 30, `Нужно ${SKILL_UPGRADE_COST} книги!`, '#f17e8b');
    return;
  }
  removeFromInventory('skill_book', SKILL_UPGRADE_COST);
  if (Math.random() < SKILL_UPGRADE_CHANCE) {
    sl[key] = lvl + 1;
    spawnBurst(player.x, player.y, '#e69419', 10);
    dmgNum(player.x, player.y - 42, '↑ Навык +' + sl[key] + ' ур.!', '#e69419');
  } else {
    dmgNum(player.x, player.y - 36, 'Неудача...', '#eb4e61');
  }
  netSaveProgress();
  updateSkillsUI();
  updateInvUI();
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
  mx2.fillStyle = '#070604'; mx2.fillRect(0, 0, pw, ph);
  for (let ty = 0; ty < dungeon.h; ty++) {
    for (let tx = 0; tx < dungeon.w; tx++) {
      const t = dungeon.grid[ty][tx]; if (t === WALL) continue;
      mx2.fillStyle = th.mmFloor;
      mx2.fillRect(ox + tx * sc, oy + ty * sc, Math.max(1, sc - 0.5), Math.max(1, sc - 0.5));
    }
  }
  mx2.fillStyle = '#79dc23';
  mx2.beginPath(); mx2.arc(ox + (player.x / TILE) * sc, oy + (player.y / TILE) * sc, Math.max(2, sc * 0.7), 0, Math.PI * 2); mx2.fill();
  // There is no offline mode in this game — serverEnemies is the only enemy
  // list that ever exists. The old `: enemies` fallback below referenced a
  // global that was never declared anywhere; it silently never ran while the
  // socket stayed connected, but any real disconnect (a backgrounded tab
  // losing its connection, a network blip) hit it immediately and threw a
  // ReferenceError out of render() — which is called from the
  // requestAnimationFrame loop, so the throw skipped the loop's own
  // rAF(loop) call at the end and froze the entire game, permanently, even
  // after the socket reconnected moments later.
  const mapEnemies = serverEnemies;
  const aliveEnemies = mapEnemies.filter(e => (e.hp || 0) > 0);
  mx2.fillStyle = '#e9364b';
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
  mx2.fillStyle = '#e69419';
  mx2.beginPath();
  npcs.forEach(n => {
    mx2.moveTo(ox + (n.x / TILE) * sc + Math.max(2, sc * 0.7), oy + (n.y / TILE) * sc);
    mx2.arc(ox + (n.x / TILE) * sc, oy + (n.y / TILE) * sc, Math.max(2, sc * 0.7), 0, Math.PI * 2);
  });
  mx2.fill();
  const _pRoom = (typeof _getRoomAt === 'function') ? _getRoomAt(player.x, player.y) : null;
  const _locLabel = _pRoom?.arm ? (_ARM_LABELS[_pRoom.arm] + ' · Ур. ' + _pRoom.monsterLvl) : 'Центральный зал';
  document.getElementById('map-status').textContent =
    _locLabel + ' · Враги: ' + aliveEnemies.length;
}

const _ARM_LABELS = { left: 'Левый коридор', top: 'Верхний коридор', bottom: 'Нижний коридор', right: 'Правый коридор' };

function _floorEnemyPool(n, localLvl) {
  const eMap = new Map(ENEMY_DEF.map(e => [e.eid, e]));
  const fe = FLOOR_ENEMIES[n];
  const band = bandForLocalLevel(fe, localLvl);
  const regular = band.pool.map(eid => eMap.get(eid)).filter(Boolean);
  const boss    = eMap.get(fe.boss);
  return { regular, boss };
}

// Flat monster reference list (no corridor/location grouping) — one row per
// GLOBAL LEVEL 1-MAX_MONSTER_LEVEL (matching what actually spawns at that
// level, name/color included), collapsed by default; tapping a row expands
// its full stat/drop breakdown for the one regular species+archetype that
// room spawns (which one depends on the level's room within its arm, cycling
// every room, see FLOOR_ENEMIES/bandForLocalLevel in shared/definitions.js —
// or the zone boss on its one level).
function updateFloorUI() {
  const grid = document.getElementById('floor-grid');
  if (!grid) return;
  let html = '';
  for (let lvl = 1; lvl <= MAX_MONSTER_LEVEL; lvl++) {
    const armIdx = armIndexForLevel(lvl);
    const floor = armIdx;
    const localLvl = armLocalLevel(lvl);
    const roomCount = roomsInArm(armIdx);
    const maxLocalLvl = roomCount - 1;
    const isBossLvl = localLvl === roomCount;
    const { regular, boss } = _floorEnemyPool(floor, localLvl);
    html += isBossLvl
      ? _levelAccordionItem(lvl, [_liveEnemy(boss, lvl, localLvl, true, maxLocalLvl)], floor, true)
      : _levelAccordionItem(lvl, regular.map(base => _liveEnemy(base, lvl, localLvl, false, maxLocalLvl)), floor, false);
  }
  grid.innerHTML = html;
}

// Builds the enemy instance exactly as it would spawn at this level (same
// monsterStatsAtLevel/monsterNameAtLevel/monsterColorAtLevel calls dungeon.js
// uses), so the reference list always matches what's actually in the world.
function _liveEnemy(base, lvl, localLvl, isBoss, maxLocalLvl) {
  const stats = monsterStatsAtLevel(lvl, isBoss ? 'boss' : base.eType);
  return {
    ...base, isBoss,
    name: monsterNameAtLevel(base.name, localLvl, isBoss, base.fem, maxLocalLvl),
    color: monsterColorAtLevel(base.color, base.endColor, localLvl, isBoss, maxLocalLvl),
    hp: stats.hp, atk: stats.atk, def: stats.def,
    xp: xpAtLevel(lvl), gold: goldAtLevel(lvl),
  };
}

function _levelAccordionItem(lvl, variants, floor, isBossLvl) {
  const head = variants[0];
  const nameRow = isBossLvl
    ? `<span class="mon-name">${head.name}</span><span class="fi-boss-tag">БОСС</span>`
    : `<span class="mon-name">${variants.map(v => v.name).join(' / ')}</span>`;
  const body = variants.map(e => `
    <div class="mon-variant">
      ${variants.length > 1 ? `<div class="mon-variant-hdr"><span class="dot" style="background:${e.color}"></span>${e.name}</div>` : ''}
      ${_monsterDropBodyHtml(e, floor, lvl)}
    </div>`).join('');
  return `
    <div class="mon-item">
      <div class="mon-hdr" onclick="_toggleMonster(this)">
        <span class="dot" style="background:${head.color}"></span>
        <div class="mon-titles">
          <span class="mon-lvl">Уровень ${lvl}</span>
          <div class="mon-name-row">${nameRow}</div>
        </div>
        <span class="mon-chevron">›</span>
      </div>
      <div class="mon-body">${body}</div>
    </div>`;
}

function _toggleMonster(hdrEl) {
  const item = hdrEl.closest('.mon-item');
  if (!item) return;
  const opening = !item.classList.contains('open');
  item.classList.toggle('open', opening);
  const body = item.querySelector('.mon-body');
  if (body) body.style.display = opening ? 'block' : 'none';
}

// Every row below mirrors a real roll in applyLootToInventory() (js/combat.js)
// — same drop-chance formulas, same item pools — so this list is a complete,
// accurate picture of everything that enemy can drop, not just a subset.
function _monsterDropBodyHtml(e, floor, lvl) {
  const isBoss = !!e.isBoss;
  const hp  = e.hp;
  const atk = e.atk;

  // dropMult matches _dropMult in combat.js exactly: arm index × room-level
  // growth (roomDropMult), used for recipes below.
  const localLvl = typeof armLocalLevel === 'function' ? armLocalLevel(lvl) : (floor >= 1 ? 1 : 1);
  const dropMult = floor * (typeof roomDropMult === 'function' ? roomDropMult(localLvl) : 1);
  const NEXUM_CHANCES = [0, 0.1, 0.2, 0.5, 1, 2];
  const nexumChancePct = NEXUM_CHANCES[floor] || 0;
  function _pctText(v) {
    if (v <= 0) return '0%';
    if (v >= 1)   return v.toFixed(1).replace(/\.0$/, '') + '%';
    if (v >= 0.1) return v.toFixed(2).replace(/\.?0+$/, '') + '%';
    return v.toFixed(4).replace(/\.?0+$/, '') + '%';
  }
  function _dropRow(icon, label, valHtml, color) {
    const st = color ? ` style="color:${color}"` : '';
    return `<div class="fi-drop">
      <span class="fi-drop-icon">${icon}</span>
      <span class="fi-drop-lbl"${st}>${label}</span>
      <span class="fi-drop-val"${st}>${valHtml}</span>
    </div>`;
  }

  // Gold: deterministic amount = level, 30% chance to drop (100% for boss)
  const goldText = isBoss
    ? `<span style="color:#e6ac19">${e.gold}g</span>`
    : `${e.gold}g · 30%`;

  // XP: deterministic = level
  const xpFinal = e.xp;
  const xpColor = isBoss ? '#79dc23' : '#b4eb84';

  const _mi = typeof _matIcon === 'function' ? _matIcon : () => '';

  // Boss-only rows — fixed chances matching the server's boss-kill payout
  const stoneRow = isBoss
    ? _dropRow(_itemIcon(BOX_DEF.find(bx=>bx.id==='box_uncommon'), 16), 'Необычный бокс', `&times;1 · <b style="color:#90d653">50%</b>`, '#90d653')
    + _dropRow(_itemIcon(BOX_DEF.find(bx=>bx.id==='box_rare'), 16), 'Редкий бокс', `&times;1 · <b style="color:#4a7bab">10%</b>`, '#4a7bab')
    + _dropRow(_mi(CRAFT_MATS.find(m=>m.id==='norm_stone'), 16), 'Камень обычной заточки', `&times;1 · <b style="color:#f17e8b">10%</b>`, '#f17e8b')
    + _dropRow(_mi(CRAFT_MATS.find(m=>m.id==='bless_stone'), 16), 'Камень безопасной заточки', `&times;1 · <b style="color:#efc680">1%</b>`, '#efc680')
    : '';

  // Recipe drops (non-boss only) — one roll picks at most one of the 4
  // tiers via cumulative thresholds in combat.js; the numbers below are the
  // equivalent independent per-item percentages (the gaps between those
  // thresholds), so they can be shown as separate rows.
  let recipeSection = '';
  if (!isBoss) {
    const recipeDrops = [
      { id:'recl', base:0.001 },
      { id:'rece', base:0.02  },
      { id:'recr', base:0.05  },
      { id:'recu', base:0.1   },
    ];
    const rows = recipeDrops.map(d => {
      const mat = CRAFT_MATS.find(m => m.id === d.id);
      if (!mat) return '';
      const rc = (typeof RARITY_COLOR !== 'undefined' ? RARITY_COLOR[mat.rarity] : null) || '#aea599';
      return _dropRow(_mi(mat, 16), mat.name, `&times;1 · <b style="color:${rc}">${_pctText(d.base * dropMult)}</b>`, rc);
    }).join('');
    recipeSection = `<div class="fi-drops-hdr" style="margin-top:8px">Рецепты</div><div class="fi-drops">${rows}</div>`;
  }

  // Room-level keys + enchant stone (non-boss only — bosses use the fixed
  // stoneRow above instead)
  let keySection = '';
  if (!isBoss && typeof roomKeyChance === 'function') {
    const matU = CRAFT_MATS.find(m => m.id === 'key_uncommon');
    const matR = CRAFT_MATS.find(m => m.id === 'key_rare');
    const matN = CRAFT_MATS.find(m => m.id === 'norm_stone');
    const rows =
      (matU ? _dropRow(_mi(matU, 16), matU.name, `&times;1 · <b>${_pctText(roomKeyChance(localLvl, 'uncommon') * 100)}</b>`) : '') +
      (matR ? _dropRow(_mi(matR, 16), matR.name, `&times;1 · <b>${_pctText(roomKeyChance(localLvl, 'rare') * 100)}</b>`) : '') +
      (matN && typeof roomEnchantStoneChance === 'function' ? _dropRow(_mi(matN, 16), matN.name, `&times;1 · <b>${_pctText(roomEnchantStoneChance(localLvl) * 100)}</b>`) : '');
    keySection = `<div class="fi-drops-hdr" style="margin-top:8px">Ключи и камни</div><div class="fi-drops">${rows}</div>`;
  }

  // Equipment drop: one continuous chance (+0.1%/level, never resets across
  // zones) picks a single rarity by the level's arm (itemDropChanceAtLevel/
  // itemRarityForLevel) then one item uniformly among that rarity's 7
  // class-filtered slots (1 weapon for your class + 6 armor/accessory
  // slots) — every item at that rarity is shown below, each normalized to
  // that same 1-in-7 share so the percentage matches what an actual player
  // of that item's class would see.
  let gearSection = '';
  if (typeof itemDropChanceAtLevel === 'function') {
    const pct = Math.min(100, itemDropChanceAtLevel(lvl) * (isBoss ? BOSS_ITEM_DROP_MULT : 1));
    const rarity = itemRarityForLevel(lvl);
    const rc = (typeof RARITY_COLOR !== 'undefined' ? RARITY_COLOR[rarity] : null) || '#aea599';
    const rn = (typeof _RARITY_NAMES !== 'undefined' ? _RARITY_NAMES[rarity] : null) || rarity;
    const GEAR_SLOTS = ['weapon', 'helmet', 'body', 'gloves', 'boots', 'ring', 'belt'];
    const perItemPct = pct / 7; // 1 weapon (for your class) + 6 other slots always compete 1-in-7
    const candidates = ITEM_DEF.filter(d => d.rarity === rarity && GEAR_SLOTS.includes(d.slot));
    const rows = candidates.map(it => _dropRow(_itemIcon(it, 16), it.name, `&times;1 · <b style="color:${rc}">${_pctText(perItemPct)}</b>`, rc)).join('');
    gearSection = `<div class="fi-drops-hdr" style="margin-top:8px">Экипировка (${rn})</div><div class="fi-drops">${rows}</div>`;
  }

  return `
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
      <div class="fi-drop">
        <span class="fi-drop-icon"><img src="/images/nexum-coin.png" width="16" height="16" style="vertical-align:middle;border-radius:50%"></span>
        <span class="fi-drop-lbl" style="color:#b2864d">Nexum</span>
        <span class="fi-drop-val" style="color:#b2864d">&times;1 · <b style="color:#b2864d">${nexumChancePct}%</b></span>
      </div>
      ${stoneRow}
    </div>
    ${recipeSection}
    ${keySection}
    ${gearSection}`;
}

function updateRaidPanelUI() {
  const body = document.getElementById('raid-panel-body');
  if (!body) return;
  const RARITY_COL = { common: '#aea599', uncommon: '#90d653' };
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
        <span style="color:#a2988a;font-size:11px">Ур.${m.lvl} · БМ ${m.bm}</span>
      </div>`).join('');
    const canStart = _isLobbyCreator && (_myLobbyMembers?.length || 0) >= 2;
    body.innerHTML = `
      <div class="raid-dungeon-card">
        <div class="raid-dungeon-name">⚔️ Подземелье 1</div>
        <div style="font-size:12px;color:#968a7a;margin-bottom:8px">Ваша группа · ${_myLobbyMembers?.length || 1} / 5</div>
        <div style="margin-bottom:10px">${memberRows}</div>
        ${_isLobbyCreator
          ? `<div class="raid-hint" style="margin-bottom:8px">Вы — создатель · ждите игроков или начните</div>
             <button class="raid-enter-btn${canStart ? '' : ' disabled'}" onclick="${canStart ? 'netStartLobby()' : ''}">Начать рейд</button>`
          : `<div class="raid-hint">Ожидание старта от создателя...</div>`}
      </div>
      <button onclick="netLeaveLobby();updateRaidPanelUI()" style="width:100%;margin-top:8px;padding:10px;background:rgba(235,73,92,.12);color:#ed5a6b;border:1px solid rgba(235,73,92,.25);border-radius:8px;font-size:13px;cursor:pointer">Покинуть группу</button>
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
      const mList = (lb.members || []).map(m => `<span style="font-size:10px;color:#968a7a">Ур.${m.lvl}</span> ${m.name}`).join(', ');
      const full = (lb.members?.length || 0) >= 5;
      return `
        <div class="raid-dungeon-card" style="margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <span style="font-size:13px;font-weight:700;color:#d1ccc5">${lb.creatorName}</span>
            <span style="font-size:11px;color:#968a7a">${lb.members?.length || 1} / 5</span>
          </div>
          <div style="font-size:11px;color:#a2988a;margin-bottom:8px">${mList}</div>
          <button class="raid-enter-btn${full ? ' disabled' : ''}" style="padding:8px" onclick="${full ? '' : `netJoinLobby('${lb.id}')`}">${full ? 'Полная' : 'Войти'}</button>
        </div>`;
    }).join('');
  }

  body.innerHTML = dungeonCard + createBtn +
    `<div style="font-size:12px;color:#72685a;margin-bottom:6px">Открытые группы <button onclick="netGetLobbyList()" style="background:none;border:none;color:#e7b765;font-size:11px;cursor:pointer">обновить</button></div>` +
    lobbyListHtml;
}

function showRaidComplete({ gold, xp, weaponName, weaponRarity }) {
  const RARITY_COL = { common: '#aea599', uncommon: '#90d653' };
  document.getElementById('raid-reward-body').innerHTML =
    `<div>💰 +${gold} голда</div>` +
    `<div>⭐ +${xp} опыта</div>` +
    (weaponName
      ? `<div style="margin-top:6px;color:${RARITY_COL[weaponRarity] || '#aea599'}">🗡 ${weaponName}</div>`
      : '');
  document.getElementById('raid-complete-modal').style.display = 'flex';
}

function showRaidFailed() {
  document.getElementById('raid-failed-modal').style.display = 'flex';
}

function updatePartyDungeonPanelUI() {
  const body = document.getElementById('pd-panel-body');
  if (!body) return;

  if (inPartyDungeon) {
    body.innerHTML = `<div class="raid-hint" style="text-align:center;padding:20px 0">🌀 Вы в лабиринте...</div>`;
    return;
  }

  if (_myPdLobbyId) {
    const memberRows = (_myPdLobbyMembers || []).map(m =>
      `<div class="raid-member" style="display:flex;justify-content:space-between;align-items:center">
        <span>👤 ${m.name}</span>
        <span style="color:#a2988a;font-size:11px">Ур.${m.lvl} · БМ ${m.bm}</span>
      </div>`).join('');
    const canStart = _isPdLobbyCreator && (_myPdLobbyMembers?.length || 0) >= 3;
    body.innerHTML = `
      <div class="raid-dungeon-card">
        <div class="raid-dungeon-name">🌀 Лабиринт</div>
        <div style="font-size:12px;color:#968a7a;margin-bottom:8px">Ваша группа · ${_myPdLobbyMembers?.length || 1} / 8 (мин. 3)</div>
        <div style="margin-bottom:10px">${memberRows}</div>
        ${_isPdLobbyCreator
          ? `<div class="raid-hint" style="margin-bottom:8px">Вы — создатель · нужно минимум 3 игрока</div>
             <button class="raid-enter-btn${canStart ? '' : ' disabled'}" onclick="${canStart ? 'netStartPdLobby()' : ''}">Начать</button>`
          : `<div class="raid-hint">Ожидание старта от создателя...</div>`}
      </div>
      <button onclick="netLeavePdLobby();updatePartyDungeonPanelUI()" style="width:100%;margin-top:8px;padding:10px;background:rgba(235,73,92,.12);color:#ed5a6b;border:1px solid rgba(235,73,92,.25);border-radius:8px;font-size:13px;cursor:pointer">Покинуть группу</button>
    `;
    return;
  }

  const dungeonCard = `
    <div class="raid-dungeon-card" style="margin-bottom:10px">
      <div class="raid-dungeon-name">🌀 Лабиринт</div>
      <div class="raid-dungeon-desc">Ветвящийся лабиринт · 100 монстров · Финальный босс · Мин. 3 игрока</div>
      <div class="raid-dungeon-rewards">
        <span style="color:#b2864d">50% Nexum с монстров</span>
        <span style="color:#f17e8b">50% Заточка с босса</span>
        <span style="color:#efc680">10% Безоп. заточка с босса</span>
      </div>
      <div style="font-size:11px;color:#eaa742;margin-top:4px">Доступно 1 раз в день</div>
    </div>`;

  const createBtn = `<button class="raid-enter-btn" onclick="netCreatePdLobby();netGetPdLobbyList()" style="margin-bottom:12px">Создать группу</button>`;

  const lobbies = _pdLobbyList || [];
  let lobbyListHtml = '';
  if (lobbies.length === 0) {
    lobbyListHtml = `<div class="raid-hint">Нет открытых групп. Создайте свою!</div>`;
  } else {
    lobbyListHtml = lobbies.map(lb => {
      const mList = (lb.members || []).map(m => `<span style="font-size:10px;color:#968a7a">Ур.${m.lvl}</span> ${m.name}`).join(', ');
      const full = (lb.members?.length || 0) >= 8;
      return `
        <div class="raid-dungeon-card" style="margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <span style="font-size:13px;font-weight:700;color:#d1ccc5">${lb.creatorName}</span>
            <span style="font-size:11px;color:#968a7a">${lb.members?.length || 1} / 8</span>
          </div>
          <div style="font-size:11px;color:#a2988a;margin-bottom:8px">${mList}</div>
          <button class="raid-enter-btn${full ? ' disabled' : ''}" style="padding:8px" onclick="${full ? '' : `netJoinPdLobby('${lb.id}')`}">${full ? 'Полная' : 'Войти'}</button>
        </div>`;
    }).join('');
  }

  body.innerHTML = dungeonCard + createBtn +
    `<div style="font-size:12px;color:#72685a;margin-bottom:6px">Открытые группы <button onclick="netGetPdLobbyList()" style="background:none;border:none;color:#e7b765;font-size:11px;cursor:pointer">обновить</button></div>` +
    lobbyListHtml;
}

function showPartyDungeonComplete({ gold, xp }) {
  document.getElementById('pd-reward-body').innerHTML =
    `<div>💰 +${gold} голда</div>` +
    `<div>⭐ +${xp} опыта</div>`;
  document.getElementById('pd-complete-modal').style.display = 'flex';
}

function showPartyDungeonFailed() {
  document.getElementById('pd-failed-modal').style.display = 'flex';
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
  if (n === 1) {
    updateRaidPanelUI(); if (typeof netGetLobbyList === 'function') netGetLobbyList();
    updatePartyDungeonPanelUI(); if (typeof netGetPdLobbyList === 'function') netGetPdLobbyList();
  }
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

// Chat / VIP / Market / Rating float above the world canvas and only make
// sense while actually playing — hidden on every other bottom-nav tab.
// dataset.shown gates this so a button that hasn't been unlocked yet
// (before login/char-select finishes) never gets forced visible.
const _GAME_ONLY_BTNS = ['chat-btn', 'vip-btn', 'market-btn', 'gram-shop-btn', 'rating-btn', 'boss-timer-btn'];
function _syncGameOnlyBtns(n) {
  _GAME_ONLY_BTNS.forEach(id => {
    const el = document.getElementById(id);
    if (el && el.dataset.shown === '1') el.style.display = (n === 0) ? 'flex' : 'none';
  });
}

function setTab(n) {
  activeTab = n;
  // Keep the world rendering through the panel slide-in/out animation (~0.28s
  // CSS transition) so it doesn't freeze mid-slide; render() stops drawing the
  // hidden world once this grace window elapses. See _menuGraceUntil in game.js.
  _menuGraceUntil = performance.now() + 350;
  document.querySelectorAll('.nav-tab').forEach((el, i) => el.classList.toggle('active', i === n));
  document.querySelectorAll('.bpanel').forEach(p => { p.classList.remove('open'); });
  _syncGameOnlyBtns(n);
  if (n !== 0) {
    joy.active = false; joy.dx = 0; joy.dy = 0;
    const tb = document.getElementById('npc-talk-btn');
    if (tb) tb.style.display = 'none';
  }
  const pid = ['', 'panel-inv', 'panel-map', 'panel-quests', 'panel-clans', 'panel-profile'][n];
  if (pid) {
    const el = document.getElementById(pid);
    el.style.display = 'block';
    requestAnimationFrame(() => { el.classList.add('open'); el.scrollTop = 0; });
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
let _nexumIconImg = null;

// Telegram profile photo shown in the header avatar slot in place of the
// class-color/icon avatar, once it loads. Set once from initDataUnsafe at
// login (see _initTelegramWidget in network.js) — not every user has one,
// so drawHeader() keeps the existing icon avatar as a fallback.
let _tgAvatarImg = null, _tgAvatarReady = false;
function setTelegramAvatar(url) {
  if (!url) return;
  const img = new Image();
  img.crossOrigin = 'anonymous'; // avoid tainting the canvas if the CDN sends CORS headers
  img.onload  = () => { _tgAvatarReady = true; };
  img.onerror = () => { _tgAvatarReady = false; _tgAvatarImg = null; };
  img.src = url;
  _tgAvatarImg = img;
}

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
    _hdrBgGrad.addColorStop(0, 'rgba(24,18,9,0.98)');
    _hdrBgGrad.addColorStop(1, 'rgba(13,10,4,0.99)');
    _hdrSepGrad = ctx.createLinearGradient(0, 0, W, 0);
    _hdrSepGrad.addColorStop(0,   'rgba(119,92,46,0)');
    _hdrSepGrad.addColorStop(0.15,'rgba(170,133,70,0.75)');
    _hdrSepGrad.addColorStop(0.85,'rgba(170,133,70,0.75)');
    _hdrSepGrad.addColorStop(1,   'rgba(119,92,46,0)');
  }
  ctx.fillStyle = _hdrBgGrad;
  ctx.fillRect(0, 0, W, HEADER_H);

  // Bottom separator glow
  ctx.strokeStyle = _hdrSepGrad; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, HEADER_H - 0.5); ctx.lineTo(W, HEADER_H - 0.5); ctx.stroke();

  // ── Minimap (right side) ──────────────────────────────────
  // Local window only — shows just the area around the player instead of
  // the whole (huge) world. The window follows the player continuously
  // (float-precision top-left, not tile-snapped) and is small enough
  // (~60×60 tiles) to redraw from scratch every frame with no cache needed.
  const _MM_RADIUS = 30; // tiles each direction from the player
  const mmPad = 6;
  const mmH = HEADER_H - mmPad * 2;
  const mmW = mmH;
  const mmX = W - mmW - mmPad - 4;
  const mmY = mmPad;
  const mmSc = mmW / (_MM_RADIUS * 2);
  const th = getTheme(dungeonLvl);
  const winTx = p.x / TILE - _MM_RADIUS, winTy = p.y / TILE - _MM_RADIUS;

  // Map panel border (circular)
  const mmCx = mmX + mmW / 2, mmCy = mmY + mmH / 2;
  const mpX = mmX - 4; // left-edge reference used by the header divider/info-area layout below
  ctx.fillStyle = 'rgba(15,11,4,0.92)';
  ctx.beginPath(); ctx.arc(mmCx, mmCy, mmW / 2 + 4, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(143,111,57,0.6)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(mmCx, mmCy, mmW / 2 + 4, 0, Math.PI * 2); ctx.stroke();

  // Clip, draw tiles and blips
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.beginPath(); ctx.arc(mmCx, mmCy, mmW / 2, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = '#070604'; ctx.fillRect(mmX, mmY, mmW, mmH);

  ctx.fillStyle = th.mmFloor;
  ctx.beginPath();
  const _mmTx0 = Math.max(0, Math.floor(winTx)), _mmTx1 = Math.min(dungeon.w - 1, Math.ceil(winTx + _MM_RADIUS * 2));
  const _mmTy0 = Math.max(0, Math.floor(winTy)), _mmTy1 = Math.min(dungeon.h - 1, Math.ceil(winTy + _MM_RADIUS * 2));
  for (let ty = _mmTy0; ty <= _mmTy1; ty++) {
    const row = dungeon.grid[ty];
    for (let tx = _mmTx0; tx <= _mmTx1; tx++) {
      if (row[tx] === WALL) continue;
      ctx.rect(mmX + (tx - winTx) * mmSc, mmY + (ty - winTy) * mmSc, Math.max(1, Math.ceil(mmSc)), Math.max(1, Math.ceil(mmSc)));
    }
  }
  ctx.fill();

  const mmEnemies = serverEnemies; // see the comment on the identical fallback in drawHeader()
  const _mmR = Math.max(1, mmSc * 0.8);
  ctx.fillStyle = 'rgba(233,55,76,0.9)';
  ctx.beginPath();
  mmEnemies.forEach(e => {
    if ((e.hp || 0) <= 0 || e.isBoss) return;
    const ex = mmX + (e.x / TILE - winTx) * mmSc, ey = mmY + (e.y / TILE - winTy) * mmSc;
    ctx.moveTo(ex + _mmR, ey); ctx.arc(ex, ey, _mmR, 0, Math.PI * 2);
  });
  ctx.fill();
  // Boss skull icon on minimap
  const _bossIconSz = Math.max(8, Math.round(mmSc * 4));
  ctx.font = `${_bossIconSz}px serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  mmEnemies.forEach(e => {
    if ((e.hp || 0) <= 0 || !e.isBoss) return;
    const ex = mmX + (e.x / TILE - winTx) * mmSc, ey = mmY + (e.y / TILE - winTy) * mmSc;
    ctx.fillText('💀', ex, ey);
  });
  const _mmRn = Math.max(1, mmSc);
  ctx.fillStyle = 'rgba(230,148,25,0.9)';
  ctx.beginPath();
  npcs.forEach(n => {
    const nx = mmX + (n.x / TILE - winTx) * mmSc, ny = mmY + (n.y / TILE - winTy) * mmSc;
    ctx.moveTo(nx + _mmRn, ny); ctx.arc(nx, ny, _mmRn, 0, Math.PI * 2);
  });
  ctx.fill();
  if (socket?.connected) {
    const _mmRop = Math.max(1.5, mmSc);
    ctx.fillStyle = 'rgba(236,187,103,0.9)';
    ctx.beginPath();
    otherPlayers.forEach(op => {
      if (op.x == null) return;
      const ox = mmX + (op.x / TILE - winTx) * mmSc, oy = mmY + (op.y / TILE - winTy) * mmSc;
      ctx.moveTo(ox + _mmRop, oy); ctx.arc(ox, oy, _mmRop, 0, Math.PI * 2);
    });
    ctx.fill();
  }
  // Player is always at the window's center
  const pdx = mmX + mmW / 2, pdy = mmY + mmH / 2;
  ctx.fillStyle = 'rgba(121,220,35,0.25)';
  ctx.beginPath(); ctx.arc(pdx, pdy, 5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#79dc23';
  ctx.beginPath(); ctx.arc(pdx, pdy, 2.5, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // Current room-level label (global monster level 1-80, or "Зал" in the hub)
  const _hudRoom = (typeof _getRoomAt === 'function') ? _getRoomAt(p.x, p.y) : null;
  const _hudLbl = _hudRoom?.monsterLvl ? ('Ур.' + _hudRoom.monsterLvl) : 'Зал';
  ctx.font = `bold 10px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillText(_hudLbl, mmX + mmW / 2 + 1, mmY + mmH - 2);
  ctx.fillStyle = 'rgba(239,199,131,0.95)';
  ctx.fillText(_hudLbl, mmX + mmW / 2, mmY + mmH - 3);

  // Vertical divider
  ctx.strokeStyle = 'rgba(120,96,55,0.3)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(mpX - 5, 5); ctx.lineTo(mpX - 5, HEADER_H - 5); ctx.stroke();

  // ── Avatar ────────────────────────────────────────────────
  const avX = 30, avY = HEADER_H / 2, avR = 18;
  const hasTgAvatar = _tgAvatarReady && _tgAvatarImg;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath(); ctx.arc(avX + 1, avY + 1, avR, 0, Math.PI * 2); ctx.fill();
  if (hasTgAvatar) {
    ctx.save();
    ctx.beginPath(); ctx.arc(avX, avY, avR, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(_tgAvatarImg, avX - avR, avY - avR, avR * 2, avR * 2);
    ctx.restore();
  } else {
    if (!_avBgGrad || _avBgColor !== p.charDef.color) {
      _avBgGrad = ctx.createRadialGradient(avX - 5, avY - 5, 2, avX, avY, avR);
      _avBgGrad.addColorStop(0, p.charDef.color + '40');
      _avBgGrad.addColorStop(1, 'rgba(0,0,0,0.6)');
      _avBgColor = p.charDef.color;
    }
    ctx.fillStyle = _avBgGrad;
    ctx.beginPath(); ctx.arc(avX, avY, avR, 0, Math.PI * 2); ctx.fill();
  }
  ctx.strokeStyle = p.charDef.color; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(avX, avY, avR, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = p.charDef.color + '33'; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.arc(avX, avY, avR + 3, 0, Math.PI * 2); ctx.stroke();
  if (!hasTgAvatar) drawIconCtx(ctx, p.charDef.icon, avX, avY + 1, 20, p.charDef.color);

  // ── Info area ─────────────────────────────────────────────
  const infoX = avX + avR + 9;
  const infoRight = mpX - 10;
  const infoW = infoRight - infoX;

  // Row 1: Name + Level
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left'; ctx.font = `bold 13px ${F}`; ctx.fillStyle = '#f4d8a7';
  ctx.fillText((netUsername || p.charDef.name).slice(0, 15), infoX, 15);
  ctx.textAlign = 'right'; ctx.font = `bold 11px ${F}`; ctx.fillStyle = 'rgba(241,206,144,0.95)';
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
  ctx.font = `bold 9px ${F}`; ctx.textAlign = 'left'; ctx.fillStyle = '#eaa742';
  ctx.fillText('БМ', stxH, 24);
  const _bmLabelW = ctx.measureText('БМ').width;
  ctx.font = `bold 10px ${F}`; ctx.fillStyle = '#eaa742';
  ctx.fillText(bmVal, stxH + _bmLabelW + 3, 24);
  stxH += _bmLabelW + 3 + ctx.measureText(String(bmVal)).width + 10;
  // Gold
  drawIconCtx(ctx, 'coin', stxH + 5, 24, 11, '#e3941d');
  ctx.font = `bold 10px ${F}`; ctx.textAlign = 'left'; ctx.fillStyle = '#e3941d';
  ctx.fillText(p.gold, stxH + 13, 24);
  stxH += 13 + ctx.measureText(String(p.gold)).width + 8;
  // Nexum balance
  const _nxBal = window._nexumBalance || 0;
  if (_nxBal > 0 || true) {
    const _nxImg = _nexumIconImg || (_nexumIconImg = (() => { const i = new Image(); i.src = '/images/nexum-coin.png'; return i; })());
    if (_nxImg.complete && _nxImg.naturalWidth > 0) {
      ctx.drawImage(_nxImg, stxH, 24 - 6, 12, 12);
    } else {
      ctx.fillStyle = '#b2864d'; ctx.font = `bold 9px ${F}`;
      ctx.fillText('N', stxH + 2, 24);
    }
    ctx.font = `bold 10px ${F}`; ctx.textAlign = 'left'; ctx.fillStyle = '#b2864d';
    ctx.fillText(_nxBal, stxH + 14, 24);
  }
  ctx.textBaseline = 'alphabetic';

  // Separator
  ctx.strokeStyle = 'rgba(109,88,51,0.4)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(infoX, 32); ctx.lineTo(infoRight, 32); ctx.stroke();

  // ── HP bar ────────────────────────────────────────────────
  const hpY = 42, hbH = 9;
  const hpPct = Math.max(0, Math.min(1, p.hp / p.maxHp));
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.font = `bold 9px ${F}`; ctx.fillStyle = 'rgba(238,101,117,0.95)';
  ctx.fillText('HP', infoX, hpY);

  const hbX = infoX + 22, hbW = infoW - 22;
  ctx.fillStyle = 'rgba(33,12,14,0.92)';
  roundRect(ctx, hbX, hpY - hbH / 2, hbW, hbH, 4); ctx.fill();
  if (hpPct > 0) {
    // Cache horizontal HP gradients — only depend on bar X/W, not HP amount
    if (!_hpGradGreen || _hdrGradW !== W) {
      _hpGradGreen  = ctx.createLinearGradient(hbX, 0, hbX + hbW, 0);
      _hpGradGreen.addColorStop(0, '#335118'); _hpGradGreen.addColorStop(1, '#79b644');
      _hpGradOrange = ctx.createLinearGradient(hbX, 0, hbX + hbW, 0);
      _hpGradOrange.addColorStop(0, '#6e470c'); _hpGradOrange.addColorStop(1, '#e59620');
      _hpGradRed    = ctx.createLinearGradient(hbX, 0, hbX + hbW, 0);
      _hpGradRed.addColorStop(0, '#64161f'); _hpGradRed.addColorStop(1, '#da4658');
      _hpShineGrad  = ctx.createLinearGradient(0, hpY - hbH / 2, 0, hpY);
      _hpShineGrad.addColorStop(0, 'rgba(209,204,197,0.2)'); _hpShineGrad.addColorStop(1, 'rgba(209,204,197,0)');
    }
    ctx.fillStyle = hpPct > 0.5 ? _hpGradGreen : hpPct > 0.25 ? _hpGradOrange : _hpGradRed;
    roundRect(ctx, hbX, hpY - hbH / 2, hbW * hpPct, hbH, 4); ctx.fill();
    ctx.fillStyle = _hpShineGrad;
    roundRect(ctx, hbX, hpY - hbH / 2, hbW * hpPct, hbH * 0.5, 4); ctx.fill();
    if (hpPct < 0.3) {
      ctx.strokeStyle = 'rgba(218,70,88,0.6)'; ctx.lineWidth = 1.5;
      roundRect(ctx, hbX, hpY - hbH / 2, hbW * hpPct, hbH, 4); ctx.stroke();
    }
  }
  ctx.font = `8px ${F}`; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(209,204,197,0.9)';
  ctx.fillText(Math.ceil(p.hp) + '/' + p.maxHp, hbX + hbW / 2, hpY);

  // ── XP bar ────────────────────────────────────────────────
  const xpY = 55, xbH = 6;
  const xpPct = Math.min(1, p.xp / p.xpNext);
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.font = `bold 9px ${F}`; ctx.fillStyle = 'rgba(237,190,110,0.9)';
  ctx.fillText('XP', infoX, xpY);

  const xbX = infoX + 22, xbW = infoW - 22;
  ctx.fillStyle = 'rgba(23,17,8,0.9)';
  roundRect(ctx, xbX, xpY - xbH / 2, xbW, xbH, 3); ctx.fill();
  if (xpPct > 0) {
    if (!_xpGrad || _hdrGradW !== W) {
      _xpGrad = ctx.createLinearGradient(xbX, 0, xbX + xbW, 0);
      _xpGrad.addColorStop(0, '#523c17'); _xpGrad.addColorStop(1, '#eab457');
      _xpShineGrad = ctx.createLinearGradient(0, xpY - xbH / 2, 0, xpY);
      _xpShineGrad.addColorStop(0, 'rgba(209,204,197,0.16)'); _xpShineGrad.addColorStop(1, 'rgba(209,204,197,0)');
    }
    ctx.fillStyle = _xpGrad;
    roundRect(ctx, xbX, xpY - xbH / 2, xbW * xpPct, xbH, 3); ctx.fill();
    ctx.fillStyle = _xpShineGrad;
    roundRect(ctx, xbX, xpY - xbH / 2, xbW * xpPct, xbH * 0.5, 3); ctx.fill();
  }
  ctx.font = `8px ${F}`; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(241,204,141,0.7)';
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
  ctx.strokeStyle = 'rgba(209,204,197,.6)'; ctx.lineWidth = 2; ctx.fillStyle = 'rgba(209,204,197,.07)';
  ctx.beginPath(); ctx.arc(jc.x, jc.y, JOY_R, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = 'rgba(209,204,197,.18)'; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(jc.x - JOY_R, jc.y); ctx.lineTo(jc.x + JOY_R, jc.y);
  ctx.moveTo(jc.x, jc.y - JOY_R); ctx.lineTo(jc.x, jc.y + JOY_R);
  ctx.stroke();
  const kx = jc.x + joy.dx * JOY_R, ky = jc.y + joy.dy * JOY_R;
  // Recreate gradient only when knob position actually changes
  if (_joyKnobGrad === null || kx !== _joyKnobGradKx || ky !== _joyKnobGradKy) {
    _joyKnobGrad = ctx.createRadialGradient(kx - JOY_KNOB * .3, ky - JOY_KNOB * .3, 0, kx, ky, JOY_KNOB);
    _joyKnobGrad.addColorStop(0, 'rgba(245,219,173,.95)'); _joyKnobGrad.addColorStop(1, 'rgba(169,140,91,.7)');
    _joyKnobGradKx = kx; _joyKnobGradKy = ky;
  }
  ctx.fillStyle = _joyKnobGrad; ctx.beginPath(); ctx.arc(kx, ky, JOY_KNOB, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(209,204,197,.7)'; ctx.lineWidth = 2;
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
    flash.addColorStop(0, 'rgba(76,51,14,0.97)'); flash.addColorStop(1, 'rgba(38,26,7,0.99)');
    const ready = ctx.createLinearGradient(b.x, b.y, b.x, b.y + b.h);
    ready.addColorStop(0, 'rgba(37,30,17,0.97)'); ready.addColorStop(1, 'rgba(18,14,8,0.99)');
    const cd = ctx.createLinearGradient(b.x, b.y, b.x, b.y + b.h);
    cd.addColorStop(0, 'rgba(20,16,10,0.97)'); cd.addColorStop(1, 'rgba(11,9,5,0.99)');
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
    const locked = ((player.skillLevels || {})[sk.key] || 0) <= 0;
    const cd = player.skillCooldowns[sk.key] || 0;
    const ready = !locked && cd <= 0;
    const isFlash = skillFlash && skillFlash.key === sk.key && skillFlash.timer > 0;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const r = b.w / 2;

    // Background gradient (cached) — circular
    ctx.fillStyle = isFlash ? grads.flash : ready ? grads.ready : grads.cd;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();

    // Icon — clipped to the circle and scaled to fully cover it, no padding
    // and no key-letter label, so the art fills the whole button.
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r - 1.5, 0, Math.PI * 2); ctx.clip();
    ctx.globalAlpha = ready ? 1 : 0.45;
    const img = sk.img ? _getPotImg(sk.img) : null;
    if (img && img.complete && img.naturalWidth > 0) {
      const d = r * 2;
      ctx.drawImage(img, cx - d / 2, cy - d / 2, d, d);
    } else {
      drawIconCtx(ctx, sk.icon, cx, cy, r * 1.3, ready ? '#f2d39c' : '#7c7364');
    }
    if (!ready) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;

    // Border
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = isFlash ? 'rgba(234,167,66,0.95)' : ready ? 'rgba(203,161,89,0.7)' : 'rgba(61,51,34,0.7)';
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();

    // Not-yet-studied skills show a lock instead of a cooldown countdown
    if (locked) {
      drawIconCtx(ctx, 'lock', cx, cy, r * 0.85, '#d1ccc5');
    } else if (!ready) {
      ctx.font = `bold 14px ${_F_SKILL}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
      ctx.fillStyle = '#d1ccc5';
      ctx.fillText(cd >= 10 ? Math.ceil(cd) : cd.toFixed(1), cx, cy);
    }
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
  pg0.addColorStop(0,'rgba(30,24,14,0.98)'); pg0.addColorStop(1,'rgba(17,13,7,0.99)');
  const pg1 = ctx.createRadialGradient(pb.x-5, pb.y-5, 2, pb.x, pb.y, pb.r);
  pg1.addColorStop(0,'rgba(44,63,27,0.98)'); pg1.addColorStop(1,'rgba(18,27,11,0.99)');

  const tg0 = ctx.createRadialGradient(tb.x-4, tb.y-4, 2, tb.x, tb.y, tb.r);
  tg0.addColorStop(0,'rgba(30,24,14,0.98)'); tg0.addColorStop(1,'rgba(17,13,7,0.99)');
  const tg1 = ctx.createRadialGradient(tb.x-4, tb.y-4, 2, tb.x, tb.y, tb.r);
  tg1.addColorStop(0,'rgba(52,13,18,0.98)'); tg1.addColorStop(1,'rgba(24,6,8,0.99)');

  const pvg0 = ctx.createLinearGradient(pvp.x, pvp.y, pvp.x, pvp.y+pvp.h);
  pvg0.addColorStop(0,'rgba(30,24,14,0.97)'); pvg0.addColorStop(1,'rgba(17,13,7,0.99)');
  const pvg1 = ctx.createLinearGradient(pvp.x, pvp.y, pvp.x, pvp.y+pvp.h);
  pvg1.addColorStop(0,'rgba(66,14,20,0.98)'); pvg1.addColorStop(1,'rgba(33,7,10,0.99)');

  const ptg0 = ctx.createLinearGradient(pty.x, pty.y, pty.x, pty.y+pty.h);
  ptg0.addColorStop(0,'rgba(24,36,14,0.97)'); ptg0.addColorStop(1,'rgba(12,18,7,0.99)');
  const ptg1 = ctx.createLinearGradient(pty.x, pty.y, pty.x, pty.y+pty.h);
  ptg1.addColorStop(0,'rgba(47,13,17,0.97)'); ptg1.addColorStop(1,'rgba(24,6,8,0.99)');

  const ag0 = ctx.createRadialGradient(ab.x-6, ab.y-6, 3, ab.x, ab.y, ab.r);
  ag0.addColorStop(0,'rgba(26,21,12,0.90)'); ag0.addColorStop(1,'rgba(13,10,6,0.92)');
  const ag1 = ctx.createRadialGradient(ab.x-6, ab.y-6, 3, ab.x, ab.y, ab.r);
  ag1.addColorStop(0,'rgba(56,14,19,0.98)'); ag1.addColorStop(1,'rgba(26,7,9,0.99)');
  const ag2 = ctx.createRadialGradient(ab.x-6, ab.y-6, 3, ab.x, ab.y, ab.r);
  ag2.addColorStop(0,'rgba(37,30,17,0.98)'); ag2.addColorStop(1,'rgba(18,14,8,0.99)');

  const aag0 = ctx.createLinearGradient(aab.x, aab.y, aab.x, aab.y+aab.h);
  aag0.addColorStop(0,'rgba(33,7,10,0.95)'); aag0.addColorStop(1,'rgba(17,4,6,0.97)');
  const aag1 = ctx.createLinearGradient(aab.x, aab.y, aab.x, aab.y+aab.h);
  aag1.addColorStop(0,'rgba(22,32,13,0.95)'); aag1.addColorStop(1,'rgba(11,16,7,0.97)');

  const tfBg = ctx.createLinearGradient(tfX, tfY, tfX, tfY+tfH);
  tfBg.addColorStop(0,'rgba(26,20,11,0.97)'); tfBg.addColorStop(1,'rgba(15,12,6,0.99)');
  const hpHi = ctx.createLinearGradient(hbX, 0, hbX+hbW, 0);
  hpHi.addColorStop(0,'#314f17'); hpHi.addColorStop(1,'#6fb136');
  const hpMid = ctx.createLinearGradient(hbX, 0, hbX+hbW, 0);
  hpMid.addColorStop(0,'#6e470c'); hpMid.addColorStop(1,'#e39827');
  const hpLo = ctx.createLinearGradient(hbX, 0, hbX+hbW, 0);
  hpLo.addColorStop(0,'#64131c'); hpLo.addColorStop(1,'#d33d4e');
  const tfShine = ctx.createLinearGradient(0, hbY, 0, hbY+4);
  tfShine.addColorStop(0,'rgba(209,204,197,0.15)'); tfShine.addColorStop(1,'rgba(209,204,197,0)');

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

  ctx.strokeStyle = ready && cd <= 0 ? 'rgba(127,181,79,0.75)' : 'rgba(84,70,46,0.6)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(pb.x, pb.y, pb.r, 0, Math.PI * 2); ctx.stroke();
  if (ready && cd <= 0) {
    ctx.strokeStyle = 'rgba(144,199,96,0.15)'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(pb.x, pb.y, pb.r + 2, 0, Math.PI * 2); ctx.stroke();
  }

  // Draw PNG image or fallback SVG icon
  const hudDef = ITEM_DEF.find(d => d.id === hudPt);
  ctx.globalAlpha = ready && cd <= 0 ? 1 : 0.45;
  if (hudDef && hudDef.img) {
    const img = _getPotImg(hudDef.img);
    if (img && img.complete && img.naturalWidth > 0) {
      const is = Math.round(pb.r * 0.85);
      ctx.drawImage(img, pb.x - is / 2, pb.y - is / 2 - 5, is, is);
    } else {
      drawIconCtx(ctx, 'potion', pb.x, pb.y - 5, Math.round(pb.r * 0.69), '#7c7364');
    }
  } else {
    drawIconCtx(ctx, 'potion', pb.x, pb.y - 5, Math.round(pb.r * 0.69), ready && cd <= 0 ? '#90d653' : '#7c7364');
  }

  ctx.globalAlpha = 1;
  ctx.font = `bold 10px ${F}`; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = ready && cd <= 0 ? '#90d653' : 'rgba(127,118,103,0.7)';
  ctx.fillText('×' + count, pb.x, pb.y + pb.r - 3);

  // Show cooldown if active
  if (cd > 0) {
    ctx.font = `bold 9px ${F}`; ctx.fillStyle = '#f17e8b';
    ctx.fillText(cd.toFixed(1) + 'с', pb.x, pb.y + pb.r + 10);
  } else {
    ctx.font = `7px ${F}`; ctx.fillStyle = 'rgba(147,138,123,0.55)';
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
  const hasTarget = !!targetId;

  ctx.save();

  ctx.fillStyle = hasTarget ? _uiBtnGrads.tg1 : _uiBtnGrads.tg0;
  ctx.beginPath(); ctx.arc(tb.x, tb.y, tb.r, 0, Math.PI * 2); ctx.fill();

  ctx.strokeStyle = hasTarget ? 'rgba(235,73,92,0.85)' : 'rgba(113,94,62,0.6)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(tb.x, tb.y, tb.r, 0, Math.PI * 2); ctx.stroke();
  if (hasTarget) {
    ctx.strokeStyle = 'rgba(235,73,92,0.15)'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(tb.x, tb.y, tb.r + 2, 0, Math.PI * 2); ctx.stroke();
  }

  drawIconCtx(ctx, 'crosshair', tb.x, tb.y, 20, hasTarget ? '#f17e8b' : '#a49783');

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
    chips.push({ kind:'pot', img: bdef.img, label: secs < 60 ? secs + 'с' : Math.ceil(rem/60) + 'м', color:'#e5a546' });
  }

  // Skill buffs
  const skillBuffs = [
    { t: typeof barrierTimer     !== 'undefined' ? barrierTimer     : 0, icon:'barrier',   color:'#eec47c' },
    { t: typeof battleCryTimer   !== 'undefined' ? battleCryTimer   : 0, icon:'battleCry', color:'#e8a034' },
    { t: typeof atkSpeedTimer    !== 'undefined' ? atkSpeedTimer    : 0, icon:'lightning', color:'#bf9a6a' },
    { t: typeof faithShieldTimer !== 'undefined' ? faithShieldTimer : 0, icon:'shield',    color:'#ebad4e' },
    { t: typeof invisTimer       !== 'undefined' ? invisTimer       : 0, icon:'teleport',  color:'#f2d197' },
    { t: typeof dodgeTimer       !== 'undefined' ? dodgeTimer       : 0, icon:'dash',      color:'#98e456' },
  ];
  for (const b of skillBuffs) {
    if (b.t > 0) chips.push({ kind:'icon', icon: b.icon, label: Math.ceil(b.t) + 'с', color: b.color });
  }

  // Debuffs
  if ((p.slowTimer   || 0) > 0) chips.push({ kind:'icon', icon:'wind',      label: Math.ceil(p.slowTimer)   + 'с', color:'#efc680', debuff:true });
  if ((p.stunTimer   || 0) > 0) chips.push({ kind:'icon', icon:'holyLight', label: Math.ceil(p.stunTimer)   + 'с', color:'#ebad4e', debuff:true });
  if ((p.freezeTimer || 0) > 0) chips.push({ kind:'icon', icon:'iceNova',   label: Math.ceil(p.freezeTimer) + 'с', color:'#ccaf88', debuff:true });
  // Death XP penalty — remaining seconds, same as any other player.buffs entry
  const _penaltyLeft = (p.buffs || {}).deathPenalty || 0;
  if (_penaltyLeft > 0) {
    const _pm = Math.ceil(_penaltyLeft / 60);
    chips.push({ kind:'icon', icon:'star', label: '−XP ' + _pm + 'м', color:'#c34d5b', debuff:true });
  }

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
    ctx.fillStyle = chip.debuff ? 'rgba(37,8,11,0.90)' : 'rgba(20,15,6,0.90)';
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

  ctx.strokeStyle = pvpMode ? 'rgba(226,70,88,0.85)' : 'rgba(194,154,86,0.55)';
  ctx.lineWidth = 1.5;
  roundRect(ctx, pb.x, pb.y, pb.w, pb.h, 9); ctx.stroke();

  if (pvpMode) {
    ctx.strokeStyle = 'rgba(226,70,88,0.12)'; ctx.lineWidth = 4;
    roundRect(ctx, pb.x - 2, pb.y - 2, pb.w + 4, pb.h + 4, 11); ctx.stroke();
  }

  const pvpLabel = pvpMode ? 'ПК' : 'Мир';
  const pvpColor = pvpMode ? '#ef6d7c' : 'rgba(224,188,127,0.9)';
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
  const activeEnemies = serverEnemies; // see the comment on the identical fallback in drawHeader()

  let name = '', hp = 0, maxHp = 1, color = '#e69419';
  if (targetIsPlayer && isOnline) {
    const op = otherPlayers.get(targetId);
    if (!op) return;
    name = op.username || '?';
    hp = op.hp || 0; maxHp = op.maxHp || 1; color = '#f17e8b';
  } else {
    const e = serverEnemiesMap.get(targetId);
    if (!e) return;
    name = e.name || '?';
    hp = Math.max(0, e.hp || 0); maxHp = e.maxHp || 1; color = e.color || '#e69419';
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

  ctx.strokeStyle = 'rgba(191,64,79,0.6)'; ctx.lineWidth = 1.5;
  roundRect(ctx, bx, by, bw, bh, 9); ctx.stroke();
  ctx.strokeStyle = 'rgba(209,86,101,0.1)'; ctx.lineWidth = 1;
  roundRect(ctx, bx + 1.5, by + 1.5, bw - 3, bh - 3, 8); ctx.stroke();

  drawIconCtx(ctx, 'crosshair', bx + 14, by + 10, 10, color);
  ctx.font = `bold 10px ${F}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = color;
  ctx.fillText(name.slice(0, 16), bx + 22, by + 15);

  const hbx = bx + 8, hby = by + 20, hbw = bw - 16, hbh = 10;
  ctx.fillStyle = 'rgba(38,12,15,0.9)';
  roundRect(ctx, hbx, hby, hbw, hbh, 4); ctx.fill();
  if (pct > 0) {
    ctx.fillStyle = pct > 0.5 ? _uiBtnGrads.hpHi : (pct > 0.25 ? _uiBtnGrads.hpMid : _uiBtnGrads.hpLo);
    roundRect(ctx, hbx, hby, hbw * pct, hbh, 4); ctx.fill();
    ctx.fillStyle = _uiBtnGrads.tfShine;
    roundRect(ctx, hbx, hby, hbw * pct, hbh * 0.45, 4); ctx.fill();
  }
  ctx.font = `bold 7.5px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(209,204,197,0.92)';
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
  const hasTarget = !!targetId;
  const animBusy = (player.atkAnimTimer || 0) > 0;
  const ready = (player.atkTimer || 0) <= 0 && !animBusy;

  ctx.save();
  ctx.fillStyle = hasTarget && ready ? _uiBtnGrads.ag1 : (!autoAttackMode ? _uiBtnGrads.ag2 : _uiBtnGrads.ag0);
  ctx.beginPath(); ctx.arc(ab.x, ab.y, ab.r, 0, Math.PI * 2); ctx.fill();

  // cooldown arc overlay while attack animation is playing
  if (animBusy && player.castDuration > 0) {
    const frac = (player.atkAnimTimer || 0) / player.castDuration;
    ctx.strokeStyle = 'rgba(233,59,79,0.55)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(ab.x, ab.y, ab.r - 1, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
    ctx.stroke();
  }

  const borderColor = !autoAttackMode
    ? (hasTarget && ready ? 'rgba(235,73,92,0.9)' : 'rgba(203,163,93,0.7)')
    : 'rgba(84,70,46,0.45)';
  ctx.strokeStyle = borderColor; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(ab.x, ab.y, ab.r, 0, Math.PI * 2); ctx.stroke();
  if (!autoAttackMode && hasTarget && ready) {
    ctx.strokeStyle = 'rgba(234,66,85,0.15)'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(ab.x, ab.y, ab.r + 2, 0, Math.PI * 2); ctx.stroke();
  }

  ctx.globalAlpha = autoAttackMode ? 0.4 : (animBusy ? 0.55 : 1);
  const iconColor = hasTarget && ready ? '#ee6272' : (autoAttackMode ? '#5c5344' : '#f1ce90');
  drawIconCtx(ctx, 'sword', ab.x, ab.y, Math.round(ab.r * 0.87), iconColor);

  ctx.globalAlpha = 1;
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

  ctx.strokeStyle = autoAttackMode ? 'rgba(127,181,79,0.7)' : 'rgba(210,150,60,0.7)';
  ctx.lineWidth = 1.5;
  roundRect(ctx, ab.x, ab.y, ab.w, ab.h, 8); ctx.stroke();

  ctx.font = `bold 9px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = autoAttackMode ? '#90d653' : '#e5aa52';
  ctx.fillText(autoAttackMode ? 'АВТО' : 'РУЧ', ab.x + ab.w / 2, ab.y + ab.h / 2);
  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  PARTY BUTTON (invite / leave)
// ─────────────────────────────────────────────────────────
function drawPartyButton() {
  if (!player) return;
  const canInvite = targetIsPlayer && !!targetId;
  if (!canInvite) return;

  if (!_uiBtnGrads) _buildUiBtnGrads();
  const pb = _uiBtnGrads.ptyBtn;
  const F = 'system-ui, -apple-system, Arial';
  ctx.save();

  ctx.fillStyle = _uiBtnGrads.ptg0;
  roundRect(ctx, pb.x, pb.y, pb.w, pb.h, 9); ctx.fill();

  ctx.strokeStyle = 'rgba(127,181,79,0.8)';
  ctx.lineWidth = 1.5;
  roundRect(ctx, pb.x, pb.y, pb.w, pb.h, 9); ctx.stroke();

  drawIconCtx(ctx, 'party', pb.x + 14, pb.y + pb.h / 2, 12, '#90d653');
  ctx.font = `bold 10px ${F}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#90d653';
  ctx.fillText('Пати+', pb.x + 23, pb.y + pb.h / 2);

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
    _gh.addColorStop(0, '#314f17'); _gh.addColorStop(1, '#6fb136');
    const _gm = ctx.createLinearGradient(_hbx, 0, _hbx + _hbw, 0);
    _gm.addColorStop(0, '#6e470c'); _gm.addColorStop(1, '#e39827');
    const _gl = ctx.createLinearGradient(_hbx, 0, _hbx + _hbw, 0);
    _gl.addColorStop(0, '#64131c'); _gl.addColorStop(1, '#d33d4e');
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
    bg.addColorStop(0, 'rgba(18,27,11,0.97)'); bg.addColorStop(1, 'rgba(9,13,6,0.99)');
    ctx.fillStyle = bg;
    roundRect(ctx, bx, by, bw, bh, 8); ctx.fill();
    ctx.strokeStyle = 'rgba(117,163,77,0.55)'; ctx.lineWidth = 1.2;
    roundRect(ctx, bx, by, bw, bh, 8); ctx.stroke();

    drawIconCtx(ctx, 'party', bx + 11, by + bh / 2, 11, '#90d653');

    ctx.font = `bold 9px ${F}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#90d653';
    ctx.fillText((member.name || '?').slice(0, 12), bx + 20, by + 10);

    const hbx = bx + 20, hby = by + 13, hbw = bw - 24, hbh = 8;
    ctx.fillStyle = 'rgba(20,27,13,0.9)';
    roundRect(ctx, hbx, hby, hbw, hbh, 3); ctx.fill();
    if (pct > 0) {
      ctx.fillStyle = pct > 0.5 ? _partyHpGrads.hi : pct > 0.25 ? _partyHpGrads.mid : _partyHpGrads.lo;
      roundRect(ctx, hbx, hby, hbw * pct, hbh, 3); ctx.fill();
    }
    ctx.font = `6.5px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(209,204,197,0.88)';
    ctx.fillText(Math.ceil(hp) + '/' + maxHp, hbx + hbw / 2, hby + hbh / 2);

    ctx.restore();
  });

  // Leave party button below member list
  const lb = getPartyLeaveBtnPos();
  ctx.save();
  const lbg = ctx.createLinearGradient(lb.x, lb.y, lb.x, lb.y + lb.h);
  lbg.addColorStop(0, 'rgba(47,13,17,0.97)'); lbg.addColorStop(1, 'rgba(24,6,8,0.99)');
  ctx.fillStyle = lbg;
  roundRect(ctx, lb.x, lb.y, lb.w, lb.h, 7); ctx.fill();
  ctx.strokeStyle = 'rgba(209,71,87,0.75)'; ctx.lineWidth = 1.2;
  roundRect(ctx, lb.x, lb.y, lb.w, lb.h, 7); ctx.stroke();
  drawIconCtx(ctx, 'partyLeave', lb.x + 13, lb.y + lb.h / 2, 10, '#ef6d7c');
  ctx.font = `bold 9px ${F}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ef6d7c';
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
  bg.addColorStop(0, 'rgba(18,27,11,0.99)'); bg.addColorStop(1, 'rgba(9,13,6,0.99)');
  ctx.fillStyle = bg;
  roundRect(ctx, px, py, pw, ph, 12); ctx.fill();
  ctx.strokeStyle = 'rgba(127,181,79,0.75)'; ctx.lineWidth = 1.5;
  roundRect(ctx, px, py, pw, ph, 12); ctx.stroke();

  drawIconCtx(ctx, 'party', px + 20, py + 18, 16, '#90d653');
  ctx.font = `bold 12px ${F}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#d5d0ca';
  ctx.fillText('Приглашение в пати', px + 34, py + 14);
  ctx.font = `10px ${F}`; ctx.fillStyle = '#90d653';
  ctx.fillText(inv.fromName, px + 34, py + 28);

  // Accept button
  const ac = getPartyAcceptPos();
  ctx.fillStyle = 'rgba(29,44,16,0.99)';
  roundRect(ctx, ac.x, ac.y, ac.w, ac.h, 8); ctx.fill();
  ctx.strokeStyle = 'rgba(127,181,79,0.8)'; ctx.lineWidth = 1.2;
  roundRect(ctx, ac.x, ac.y, ac.w, ac.h, 8); ctx.stroke();
  ctx.font = `bold 11px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#90d653';
  ctx.fillText('Принять', ac.x + ac.w / 2, ac.y + ac.h / 2);

  // Decline button
  const dc = getPartyDeclinePos();
  ctx.fillStyle = 'rgba(38,12,15,0.99)';
  roundRect(ctx, dc.x, dc.y, dc.w, dc.h, 8); ctx.fill();
  ctx.strokeStyle = 'rgba(190,60,75,0.8)'; ctx.lineWidth = 1.2;
  roundRect(ctx, dc.x, dc.y, dc.w, dc.h, 8); ctx.stroke();
  ctx.fillStyle = '#ef6d7c';
  ctx.fillText('Отказ', dc.x + dc.w / 2, dc.y + dc.h / 2);

  // Timer bar
  const alpha = Math.min(1, inv.timer / 3);
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = '#90d653';
  roundRect(ctx, px + 8, py + ph - 6, (pw - 16) * alpha, 3, 2); ctx.fill();
  ctx.globalAlpha = 1;

  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  INVENTORY ITEM MODAL
// ─────────────────────────────────────────────────────────
const _ENH_RARITY_COST = { common:40, uncommon:70, rare:120, epic:200, legendary:350 };
const _ENH_MAX = 15;
function _enhSuccessRate(enh) { return Math.max(10, 80 - enh * 10); }
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
const _SLOT_NAMES   = { weapon:'Оружие', helmet:'Шлем', body:'Броня', gloves:'Перчатки', boots:'Боты', ring:'Кольцо', belt:'Пояс', use:'Расходник', material:'Материал', recipe:'Рецепт', buff_potion:'Зелье усиления', box:'Бокс' };

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
          <div class="imod-name" style="color:#e5a546">${it.name}</div>
          <div class="imod-sub"><span style="color:#e5a546">${_RARITY_NAMES[it.rarity]||it.rarity}</span> · Зелье усиления · ×${qty}</div>
        </div>
        <button class="npc-close" onclick="closeInvItemModal()" style="touch-action:manipulation">✕</button>
      </div>
      <div class="imod-stats">${it.buffDesc || ''}</div>
      ${active ? `<div style="padding:8px 12px;background:rgba(229,165,70,0.1);border-radius:8px;color:#e5a546;font-size:12px;text-align:center">✓ Активно · осталось ~${remaining} мин</div>` : ''}
      <div class="imod-btns">
        <button class="imod-btn imod-equip${active ? ' disabled' : ''}" onclick="${active ? '' : `useBuffPotion('${it.id}');closeInvItemModal()`}">
          ${active ? 'Уже активно' : 'Использовать'}
        </button>
      </div>
    </div>`;
    document.getElementById('app').appendChild(ov);
    return;
  }

  if (it.slot === 'box') { closeInvItemModal(); openBoxModal(idx); return; }

  if (_isStackable(it) || it.slot === 'use') return;

  const rc    = RARITY_COLOR[it.rarity] || '#aea599';
  const enh   = it.enhance || 0;
  const eb    = _enhBonus(it);
  const next1 = _enhBonusAt(it, 1);

  // Stats display with enhance bonus highlighted
  const statRows = [];
  if (it.atk || eb.atk) {
    const base = it.atk || 0;
    const total = base + (eb.atk || 0);
    statRows.push(`ATK <b>+${total}</b>${eb.atk ? ` <span style="color:#e69419">(+${eb.atk})</span>` : ''}`);
  }
  if (it.def || eb.def) {
    const total = (it.def || 0) + (eb.def || 0);
    statRows.push(`DEF <b>+${total}</b>${eb.def ? ` <span style="color:#e69419">(+${eb.def})</span>` : ''}`);
  }
  if (it.hp || eb.hp) {
    const total = (it.hp || 0) + (eb.hp || 0);
    statRows.push(`HP <b>+${total}</b>${eb.hp ? ` <span style="color:#e69419">(+${eb.hp})</span>` : ''}`);
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
  const rateColor = rate >= 80 ? '#98e456' : rate >= 50 ? '#e6ac19' : rate >= 30 ? '#e69419' : '#eb4e61';
  const enhBlock = canEnh
    ? `<div class="imod-enh-block">
        <div class="imod-enh-title">Заточка: ${enh > 0 ? '+' + enh : '0'} → <span style="color:#e69419">+${enh+1}</span></div>
        ${nextParts.length ? `<div class="imod-enh-preview">${nextParts.join(' · ')}</div>` : ''}
        <div class="imod-enh-chance">Шанс: <b style="color:${rateColor}">${rate}%</b></div>
        ${_enhStonesBlock('enhanceItem', idx)}
      </div>`
    : `<div class="imod-enh-block"><div class="imod-enh-title" style="color:#e69419">✦ Максимальная заточка</div></div>`;

  closeInvItemModal();
  const ov = document.createElement('div');
  ov.id = 'inv-item-modal-ov';
  ov.className = 'imod-overlay';
  ov.onclick = closeInvItemModal;
  ov.innerHTML = `<div class="imod-box" onclick="event.stopPropagation()">
    <div class="imod-hdr">
      <span class="imod-big-icon">${_itemIcon(it, 52)}</span>
      <div class="imod-title-block">
        <div class="imod-name" style="color:${rc}">${it.name}${enh ? ` <span style="color:#e69419">+${enh}</span>` : ''}</div>
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

// ── Loot boxes ────────────────────────────────────────────
function _boxCandidates(rarity) {
  const gearSlots = ['weapon', 'helmet', 'body', 'gloves', 'boots', 'ring', 'belt'];
  return ITEM_DEF.filter(d => d.rarity === rarity && gearSlots.includes(d.slot) &&
    (d.slot !== 'weapon' || (d.forClass && player && d.forClass.includes(player.type))));
}

function openBoxModal(idx) {
  if (!player) return;
  const it = player.inventory[idx];
  if (!it) return;
  const boxDef = BOX_DEF.find(b => b.id === it.id);
  if (!boxDef) return;
  const qty = it.qty || 1;
  const rc = RARITY_COLOR[boxDef.rarity] || '#aea599';

  const oddsHtml = boxDef.odds.map(o => {
    const rcO = RARITY_COLOR[o.rarity] || '#aea599';
    const cands = _boxCandidates(o.rarity);
    const icons = cands.map(c => `<span title="${c.name}" style="display:inline-block;margin:2px">${_itemIcon(c, 26)}</span>`).join('');
    return `<div class="box-odds-row">
      <div class="box-odds-hdr" style="color:${rcO}">${_RARITY_NAMES[o.rarity] || o.rarity} · <b>${Math.round(o.chance * 100)}%</b></div>
      <div class="box-odds-icons">${icons || '—'}</div>
    </div>`;
  }).join('');

  closeInvItemModal();
  const ov = document.createElement('div');
  ov.id = 'inv-item-modal-ov';
  ov.className = 'imod-overlay';
  ov.onclick = closeInvItemModal;
  ov.innerHTML = `<div class="imod-box" onclick="event.stopPropagation()" style="max-width:380px;max-height:80vh;overflow-y:auto">
    <div class="imod-hdr">
      <span class="imod-big-icon">${_itemIcon(boxDef, 52)}</span>
      <div class="imod-title-block">
        <div class="imod-name" style="color:${rc}">${boxDef.name}</div>
        <div class="imod-sub"><span style="color:${rc}">${_RARITY_NAMES[boxDef.rarity] || boxDef.rarity}</span> · Бокс · ×${qty}</div>
      </div>
      <button class="npc-close" onclick="closeInvItemModal()" style="touch-action:manipulation">✕</button>
    </div>
    <div style="font-size:11px;color:#968a7a">Открытие даёт 1 случайный предмет:</div>
    <div class="box-odds-list">${oddsHtml}</div>
    <div class="imod-btns">
      <button class="imod-btn imod-equip" onclick="openLootBox(${idx})">Открыть</button>
    </div>
  </div>`;
  document.getElementById('app').appendChild(ov);
}

function openLootBox(idx) {
  if (!player) return;
  const it = player.inventory[idx];
  if (!it) return;
  const boxDef = BOX_DEF.find(b => b.id === it.id);
  if (!boxDef) return;
  if (!invHasSpace()) { dmgNum(player.x, player.y - 30, 'Инвентарь полон!', '#f17e8b'); return; }

  if ((it.qty || 1) <= 1) player.inventory.splice(idx, 1);
  else it.qty--;

  const r = Math.random();
  let acc = 0, resultRarity = boxDef.odds[boxDef.odds.length - 1].rarity;
  for (const o of boxDef.odds) {
    acc += o.chance;
    if (r < acc) { resultRarity = o.rarity; break; }
  }
  const cands = _boxCandidates(resultRarity);
  const wonItem = cands[Math.floor(Math.random() * cands.length)];
  if (wonItem && addToInventory({ ...wonItem })) {
    dmgNum(player.x, player.y - 30, '+ ' + wonItem.name, RARITY_COLOR[wonItem.rarity] || '#c4a276');
  }
  netSaveProgress();
  closeInvItemModal();
  updateInvUI();
}

function enhanceItem(idx, stoneType) {
  if (!player) return;
  const it = player.inventory[idx];
  if (!it) return;
  const enh = it.enhance || 0;
  if (enh >= _ENH_MAX) return;

  const stoneId = stoneType === 'bless' ? 'bless_stone' : 'norm_stone';
  let stoneIdx = player.inventory.findIndex(s => s.id === stoneId && (s.qty || 1) > 0);
  if (stoneIdx < 0) { dmgNum(player.x, player.y - 30, 'Нет камня!', '#f17e8b'); return; }

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
    dmgNum(player.x, player.y - 30, `+${it.enhance} Успех!`, '#e69419');
    openInvItemModal(idx);
  } else if (stoneType === 'bless') {
    recompute(); netSaveProgress();
    dmgNum(player.x, player.y - 30, 'Заточка не удалась', '#f17e8b');
    openInvItemModal(idx);
  } else {
    player.inventory.splice(idx, 1);
    recompute(); netSaveProgress();
    closeInvItemModal();
    dmgNum(player.x, player.y - 30, 'Вещь сгорела!', '#eb4e61');
  }
  updateInvUI();
}

function openEqItemModal(slot) {
  if (!player) return;
  const it = player.equipment[slot];
  if (!it) return;

  const rc   = RARITY_COLOR[it.rarity] || '#aea599';
  const enh  = it.enhance || 0;
  const eb   = _enhBonus(it);
  const next1 = _enhBonusAt(it, 1);

  const statRows = [];
  if (it.atk || eb.atk) {
    const total = (it.atk || 0) + (eb.atk || 0);
    statRows.push(`ATK <b>+${total}</b>${eb.atk ? ` <span style="color:#e69419">(+${eb.atk})</span>` : ''}`);
  }
  if (it.def || eb.def) {
    const total = (it.def || 0) + (eb.def || 0);
    statRows.push(`DEF <b>+${total}</b>${eb.def ? ` <span style="color:#e69419">(+${eb.def})</span>` : ''}`);
  }
  if (it.hp || eb.hp) {
    const total = (it.hp || 0) + (eb.hp || 0);
    statRows.push(`HP <b>+${total}</b>${eb.hp ? ` <span style="color:#e69419">(+${eb.hp})</span>` : ''}`);
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
  const rateColor2 = rate2 >= 80 ? '#98e456' : rate2 >= 50 ? '#e6ac19' : rate2 >= 30 ? '#e69419' : '#eb4e61';
  const enhBlock = canEnh
    ? `<div class="imod-enh-block">
        <div class="imod-enh-title">Заточка: ${enh > 0 ? '+' + enh : '0'} → <span style="color:#e69419">+${enh+1}</span></div>
        ${nextParts.length ? `<div class="imod-enh-preview">${nextParts.join(' · ')}</div>` : ''}
        <div class="imod-enh-chance">Шанс: <b style="color:${rateColor2}">${rate2}%</b></div>
        ${_enhStonesBlock('enhanceEqItem', slot)}
      </div>`
    : `<div class="imod-enh-block"><div class="imod-enh-title" style="color:#e69419">✦ Максимальная заточка</div></div>`;

  closeInvItemModal();
  const ov = document.createElement('div');
  ov.id = 'inv-item-modal-ov';
  ov.className = 'imod-overlay';
  ov.onclick = closeInvItemModal;
  ov.innerHTML = `<div class="imod-box" onclick="event.stopPropagation()">
    <div class="imod-hdr">
      <span class="imod-big-icon">${_itemIcon(it, 52)}</span>
      <div class="imod-title-block">
        <div class="imod-name" style="color:${rc}">${it.name}${enh ? ` <span style="color:#e69419">+${enh}</span>` : ''}</div>
        <div class="imod-sub"><span style="color:${rc}">${_RARITY_NAMES[it.rarity]||it.rarity}</span> · ${_SLOT_NAMES[it.slot]||it.slot} · <span style="color:#eec276">Надето</span></div>
      </div>
      <button class="npc-close" onclick="closeInvItemModal()" style="touch-action:manipulation">✕</button>
    </div>
    <div class="imod-stats">${statRows.join('<br>') || '—'}</div>
    ${enhBlock}
    <div class="imod-btns">
      <button class="imod-btn imod-equip" style="background:linear-gradient(135deg,#381c1f,#672d34);color:#f28a96" onclick="unequipFromModal('${slot}')">Снять</button>
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
  if (stoneIdx < 0) { dmgNum(player.x, player.y - 30, 'Нет камня!', '#f17e8b'); return; }

  const stoneItem = player.inventory[stoneIdx];
  if ((stoneItem.qty || 1) <= 1) { player.inventory.splice(stoneIdx, 1); }
  else { stoneItem.qty--; }

  const success = Math.random() * 100 < _enhSuccessRate(enh);
  if (success) {
    it.enhance = enh + 1;
    recompute(); netSaveProgress();
    dmgNum(player.x, player.y - 30, `+${it.enhance} Успех!`, '#e69419');
    openEqItemModal(slot);
  } else if (stoneType === 'bless') {
    recompute(); netSaveProgress();
    dmgNum(player.x, player.y - 30, 'Заточка не удалась', '#f17e8b');
    openEqItemModal(slot);
  } else {
    player.equipment[slot] = null;
    recompute(); netSaveProgress();
    closeInvItemModal();
    dmgNum(player.x, player.y - 30, 'Вещь сгорела!', '#eb4e61');
  }
  updateInvUI();
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
  if (btn) { btn.dataset.shown = '1'; btn.style.display = (activeTab === 0) ? 'flex' : 'none'; _positionRatingBtn(); }
}

function openRatingPanel() {
  const panel = document.getElementById('rating-panel');
  if (!panel) return;
  if (player && (player.lvl || 1) < FEATURE_UNLOCK_LEVEL) {
    if (typeof dmgNum === 'function') dmgNum(player.x, player.y - 38, `🔒 Рейтинг с ${FEATURE_UNLOCK_LEVEL} уровня`, '#eaa742');
    return;
  }
  panel.style.display = 'flex';
  _ratingData = { players: null, clans: null };
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
          <div class="rating-name">@${r.username}${isMe ? ' <span style="font-size:10px;color:#ebaa49;opacity:.7">(вы)</span>' : ''}</div>
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

// ─────────────────────────────────────────────────────────
//  VIP PANEL
// ─────────────────────────────────────────────────────────

function _positionVipBtn() {
  const ratingBtn = document.getElementById('rating-btn');
  const vipBtn    = document.getElementById('vip-btn');
  if (!vipBtn || !ratingBtn) return;
  const rTop = parseFloat(ratingBtn.style.top) || 0;
  vipBtn.style.top       = (rTop + 28 + 4) + 'px';
  vipBtn.style.left      = ratingBtn.style.left;
  vipBtn.style.width     = ratingBtn.style.width;
  vipBtn.style.right     = 'auto';
  vipBtn.style.transform = 'none';
}

function showVipBtn() {
  const btn = document.getElementById('vip-btn');
  if (btn) { btn.dataset.shown = '1'; btn.style.display = (activeTab === 0) ? 'flex' : 'none'; _positionVipBtn(); }
}

function openVipPanel() {
  const panel = document.getElementById('vip-panel');
  if (!panel) return;
  panel.style.display = 'flex';
  renderVipPanel();
}

function closeVipPanel() {
  const panel = document.getElementById('vip-panel');
  if (panel) panel.style.display = 'none';
}

function renderVipPanel() {
  const el = document.getElementById('vip-body');
  if (!el) return;
  const vip       = window._vipData || { level: 0, deposited: 0, pending: [] };
  const level     = vip.level     || 0;
  const deposited = vip.deposited || 0;
  const pending   = vip.pending   || [];
  const bonuses   = typeof VIP_BONUSES    !== 'undefined' ? VIP_BONUSES    : null;
  const thresholds= typeof VIP_THRESHOLDS !== 'undefined' ? VIP_THRESHOLDS : [0,1,5,10,25,50,100,150,200,300,500];
  const bon       = bonuses ? (bonuses[level] || bonuses[0]) : { xp:0, gold:0, drop:0 };

  let progressHtml = '';
  if (level < 10) {
    const needed = thresholds[level + 1] || 1;
    const pct    = Math.min(100, (deposited / needed) * 100).toFixed(1);
    progressHtml = `
      <div class="vip-progress-wrap">
        <div class="vip-progress-label">
          <span>До VIP ${level + 1}</span>
          <span>${deposited.toFixed ? deposited.toFixed(2) : deposited} / ${needed} GRAM</span>
        </div>
        <div class="vip-progress-bar"><div class="vip-progress-fill" style="width:${pct}%"></div></div>
      </div>`;
  } else {
    progressHtml = `<div class="vip-max-badge">👑 Максимальный VIP достигнут!</div>`;
  }

  el.innerHTML = `
    <div class="vip-level-badge">VIP ${level}</div>
    ${progressHtml}
    <div class="vip-bonuses">
      <div class="vip-bonus-item ${bon.xp   > 0 ? '' : 'vip-bonus-dim'}">⚡ +${bon.xp}% XP</div>
      <div class="vip-bonus-item ${bon.gold > 0 ? '' : 'vip-bonus-dim'}">💰 +${bon.gold}% Золото</div>
      <div class="vip-bonus-item ${bon.drop > 0 ? '' : 'vip-bonus-dim'}">🎁 +${bon.drop}% Дроп</div>
    </div>
    <div class="vip-section-title">Уровни VIP</div>
    <div class="vip-levels">${_renderVipLevels(level, pending, bonuses, thresholds)}</div>
  `;
}

function _renderVipLevels(curLevel, pending, bonuses, thresholds) {
  let html = '';
  for (let lvl = 1; lvl <= 10; lvl++) {
    const b         = bonuses ? (bonuses[lvl] || { xp:0, gold:0, drop:0 }) : { xp:0, gold:0, drop:0 };
    const isPending = pending.includes(lvl);
    const isDone    = curLevel >= lvl && !isPending;
    const cls       = isPending ? 'vip-card vip-card-pending' : isDone ? 'vip-card vip-card-done' : 'vip-card vip-card-locked';
    const badge     = isPending ? '🎁' : isDone ? '✓' : lvl;
    const bonHtml   = [
      b.xp   > 0 ? `<span>+${b.xp}% XP</span>`     : '',
      b.gold > 0 ? `<span>+${b.gold}% Золото</span>` : '',
      b.drop > 0 ? `<span>+${b.drop}% Дроп</span>`   : '',
    ].join('');
    html += `
      <div class="${cls}">
        <div class="vip-card-head">
          <div class="vip-card-badge">${badge}</div>
          <div class="vip-card-title">VIP ${lvl}</div>
          <div class="vip-card-gram">${thresholds[lvl]} GRAM</div>
        </div>
        ${bonHtml ? `<div class="vip-card-bonuses">${bonHtml}</div>` : ''}
        ${_vipItemDesc(lvl)}
        ${isPending ? `<button class="vip-claim-btn" onclick="netClaimVipRewards()">Забрать награду</button>` : ''}
      </div>`;
  }
  return html;
}

function _vipItemDesc(lvl) {
  const wepSfx = { deathknight:'k', lev:'t', ranger:'b', mage:'s', warlock:'s' }[player?.type] || 't';
  const wepPfx = { uncommon:'u', rare:'r', epic:'e', legendary:'l' };

  function ri(img, label, cls) {
    return `<div class="vip-ri${cls ? ' vip-ri-' + cls : ''}"><img class="vip-ri-img" src="${img}"><span class="vip-ri-label">${label}</span></div>`;
  }
  function wep(rarity, enhance) {
    return ri(`/images/wep/${wepPfx[rarity]}${wepSfx}.png`, enhance ? `+${enhance}` : '★', rarity);
  }
  function bless(qty) { return ri('/images/bless.png',       `×${qty}`, 'rare');   }
  function norm(qty)  { return ri('/images/norm.png',        `×${qty}`, 'uncommon'); }
  function gold(amt)  {
    const uri = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23f1c40f' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='9'/><path d='M12 7v10'/><path d='M15 9.5a3 3 0 0 0-6 0c0 1.5 1 2.2 3 3 2 .8 3 1.5 3 3a3 3 0 0 1-6 0'/></svg>`;
    return ri(uri, `${(amt/1000).toFixed(0)}k зол.`, 'gold');
  }
  function pots(qty) {
    return ['hp','exp','gold','regen','atkspeed','atk']
      .map(p => ri(`/images/potion/${p}.png`, `×${qty}`, '')).join('');
  }

  const rows = {
    3:  bless(2),
    4:  bless(5) + pots(10),
    5:  bless(7) + pots(10),
    6:  wep('uncommon', 8) + bless(7) + pots(10),
    7:  wep('rare', 8) + norm(20) + bless(10) + gold(10000),
    8:  wep('epic', 1) + pots(50) + norm(50) + bless(30) + gold(20000),
    9:  wep('epic', 8) + pots(80) + norm(70) + bless(30),
    10: wep('legendary', 0) + pots(100) + norm(100) + bless(100),
  };
  const d = rows[lvl];
  return d ? `<div class="vip-items-row">${d}</div>` : '';
}

// ─────────────────────────────────────────────────────────
//  MARKET PANEL
// ─────────────────────────────────────────────────────────
const MARKET_MIN_PRICE = 0.1;
const MARKET_MAX_PRICE = 1000;
const MARKET_FEE_PCT   = 0.10; // burned — mirrors server; display only, not authoritative

let _marketTab    = 'lots';
let _marketLots    = [];
let _marketMine     = [];
let _marketHist     = [];
let _marketLoaded  = { lots: false, mine: false, history: false };
let _pendingSellItem = null; // { item } while a marketList request is in flight — used to roll back on error
let _marketSellPick  = null; // selected inventory index in the sell picker modal

function _positionMarketBtn() {
  const vipBtn    = document.getElementById('vip-btn');
  const marketBtn = document.getElementById('market-btn');
  if (!marketBtn || !vipBtn) return;
  const vTop = parseFloat(vipBtn.style.top) || 0;
  marketBtn.style.top       = (vTop + 28 + 4) + 'px';
  marketBtn.style.left      = vipBtn.style.left;
  marketBtn.style.width     = vipBtn.style.width;
  marketBtn.style.right     = 'auto';
  marketBtn.style.transform = 'none';
}

function _positionGramShopBtn() {
  const marketBtn   = document.getElementById('market-btn');
  const shopBtn     = document.getElementById('gram-shop-btn');
  if (!shopBtn || !marketBtn) return;
  const mTop = parseFloat(marketBtn.style.top) || 0;
  shopBtn.style.top       = (mTop + 28 + 4) + 'px';
  shopBtn.style.left      = marketBtn.style.left;
  shopBtn.style.width     = marketBtn.style.width;
  shopBtn.style.right     = 'auto';
  shopBtn.style.transform = 'none';
}

function showMarketBtn() {
  const btn = document.getElementById('market-btn');
  if (btn) { btn.dataset.shown = '1'; btn.style.display = (activeTab === 0) ? 'flex' : 'none'; _positionMarketBtn(); }
}

function _positionBossTimerBtn() {
  const shopBtn = document.getElementById('gram-shop-btn');
  const btn     = document.getElementById('boss-timer-btn');
  if (!btn || !shopBtn) return;
  const sTop = parseFloat(shopBtn.style.top) || 0;
  btn.style.top       = (sTop + 28 + 4) + 'px';
  btn.style.left      = shopBtn.style.left;
  btn.style.width     = shopBtn.style.width;
  btn.style.right     = 'auto';
  btn.style.transform = 'none';
}

function showBossTimerBtn() {
  const btn = document.getElementById('boss-timer-btn');
  if (btn) { btn.dataset.shown = '1'; btn.style.display = (activeTab === 0) ? 'flex' : 'none'; _positionBossTimerBtn(); }
  _renderBossTimerBtn();
}

function _fmtBossTime(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60), r = s % 60;
  return m + ':' + String(r).padStart(2, '0');
}

// One boss per corridor now — bossStatus is a map keyed by arm name
// ({ left: {alive,respawnAt}, top: {...}, ... }), set on gameStart and
// updated per-arm on 'bossStatus' pushes (kill / respawn) — see network.js.
// The button shows whichever corridor the player is currently standing in;
// in the hub (no corridor) it just shows "—". The countdown itself just
// re-reads the stored respawnAt every second, no extra network traffic
// needed for the ticking display.
function _renderBossTimerBtn() {
  const btn = document.getElementById('boss-timer-btn');
  const txt = document.getElementById('boss-timer-text');
  if (!btn || !txt) return;
  const arm = (typeof _getRoomAt === 'function' && player) ? (_getRoomAt(player.x, player.y)?.arm || null) : null;
  const bs = (arm && typeof bossStatus !== 'undefined' && bossStatus) ? bossStatus[arm] : null;
  if (!bs) {
    btn.classList.remove('boss-alive');
    txt.textContent = '—';
  } else if (bs.alive) {
    btn.classList.add('boss-alive');
    txt.textContent = 'Живой';
  } else {
    btn.classList.remove('boss-alive');
    txt.textContent = _fmtBossTime((bs.respawnAt || 0) - Date.now());
  }
}

if (typeof setInterval === 'function') {
  setInterval(() => { if (document.getElementById('boss-timer-btn')?.style.display !== 'none') _renderBossTimerBtn(); }, 1000);
}

function openMarketPanel() {
  const panel = document.getElementById('market-panel');
  if (!panel) return;
  if (player && (player.lvl || 1) < FEATURE_UNLOCK_LEVEL) {
    if (typeof dmgNum === 'function') dmgNum(player.x, player.y - 38, `🔒 Маркет с ${FEATURE_UNLOCK_LEVEL} уровня`, '#eaa742');
    return;
  }
  panel.style.display = 'flex';
  switchMarketTab(_marketTab);
}

function closeMarketPanel() {
  const panel = document.getElementById('market-panel');
  if (panel) panel.style.display = 'none';
}

function switchMarketTab(tab) {
  _marketTab = tab;
  document.querySelectorAll('#market-panel .rating-tab').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('mtab-' + tab);
  if (btn) btn.classList.add('active');
  _renderMarketBody();
  if (tab === 'lots') netMarketBrowse();
  else if (tab === 'mine') netMarketMyListings();
  else if (tab === 'history') netMarketHistory();
}

function _renderMarketBody() {
  const el = document.getElementById('market-body');
  if (!el) return;
  if (_marketTab === 'lots') _renderMarketLots(el);
  else if (_marketTab === 'mine') _renderMarketMine(el);
  else _renderMarketHistoryTab(el);
}

function _marketRowHtml(l, mode) {
  const it = l.item || {};
  const rc = RARITY_COLOR[it.rarity] || '#aea599';
  const qtySuffix = it.qty > 1 ? ` ×${it.qty}` : '';
  const sub = mode === 'buy' ? `@${l.sellerUsername || '?'}` : (statStr(it) || '');
  const action = mode === 'buy'
    ? `<button class="market-buy-btn" onclick="openMarketBuyConfirm('${l.id}')">Купить</button>`
    : `<button class="market-cancel-btn" onclick="marketCancelListing('${l.id}')">Снять</button>`;
  return `<div class="market-row">
    <div class="market-row-icon">${_itemIcon(it, 28)}</div>
    <div class="market-row-info">
      <div class="market-row-name" style="color:${rc}">${it.name || '?'}${it.enhance ? ' +' + it.enhance : ''}${qtySuffix}</div>
      <div class="market-row-sub">${sub}</div>
      ${action}
    </div>
    <div class="market-row-price">${l.price.toFixed(2)}<br><span style="font-size:9px;color:#a3957c;font-weight:600">GRAM</span></div>
  </div>`;
}

function _renderMarketLots(el) {
  if (!_marketLoaded.lots) { el.innerHTML = '<div class="rating-loading">Загрузка...</div>'; return; }
  if (!_marketLots.length) { el.innerHTML = '<div class="rating-empty">Пока никто ничего не продаёт</div>'; return; }
  el.innerHTML = _marketLots.map(l => _marketRowHtml(l, 'buy')).join('');
}

function _renderMarketMine(el) {
  const addBtn = `<button class="market-add-btn" onclick="openMarketSellPicker()">+ Выставить лот</button>`;
  if (!_marketLoaded.mine) { el.innerHTML = addBtn + '<div class="rating-loading">Загрузка...</div>'; return; }
  if (!_marketMine.length) { el.innerHTML = addBtn + '<div class="rating-empty">У вас нет активных лотов</div>'; return; }
  el.innerHTML = addBtn + _marketMine.map(l => _marketRowHtml(l, 'mine')).join('');
}

function _renderMarketHistoryTab(el) {
  if (!_marketLoaded.history) { el.innerHTML = '<div class="rating-loading">Загрузка...</div>'; return; }
  if (!_marketHist.length) { el.innerHTML = '<div class="rating-empty">История пуста</div>'; return; }
  el.innerHTML = _marketHist.map(h => {
    const it = h.item || {};
    const rc = RARITY_COLOR[it.rarity] || '#aea599';
    const isSell = h.role === 'sell';
    const cancelled = h.status === 'cancelled';
    const statusCls = cancelled ? 'market-hist-cancelled' : (isSell ? 'market-hist-sell' : 'market-hist-buy');
    const statusLbl = cancelled ? 'Снято' : (isSell ? 'Продано' : 'Куплено');
    const date = new Date(h.soldAt || h.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const amt = cancelled ? '' : (isSell ? (h.price * (1 - MARKET_FEE_PCT)).toFixed(2) : h.price.toFixed(2));
    const amtSign = cancelled ? '' : (isSell ? '+' : '-');
    return `<div class="market-row">
      <div class="market-row-icon">${_itemIcon(it, 28)}</div>
      <div class="market-row-info">
        <div class="market-row-name" style="color:${rc}">${it.name || '?'}${it.enhance ? ' +' + it.enhance : ''}${it.qty > 1 ? ' ×' + it.qty : ''}</div>
        <div class="market-row-sub">${h.counterpart ? '@' + h.counterpart + ' · ' : ''}${date}</div>
        <span class="market-hist-status ${statusCls}">${statusLbl}</span>
      </div>
      <div class="market-row-price">${amt ? amtSign + amt + '<br><span style="font-size:9px;color:#a3957c;font-weight:600">GRAM</span>' : ''}</div>
    </div>`;
  }).join('');
}

function _marketToast(text, type) {
  const ok = type !== 'err';
  const toast = document.createElement('div');
  toast.style.cssText = `position:fixed;top:80px;left:50%;transform:translateX(-50%);background:${ok ? '#29361e' : '#381c1f'};border:1px solid ${ok ? '#89ba5f' : '#d55d6b'};color:${ok ? '#89ba5f' : '#f17e8b'};padding:10px 18px;border-radius:10px;font-size:13px;font-weight:600;z-index:9999;pointer-events:none;max-width:80vw;text-align:center`;
  toast.textContent = text;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ── Buy flow ────────────────────────────────────────────────
function openMarketBuyConfirm(listingId) {
  const l = _marketLots.find(x => x.id === listingId);
  if (!l) return;
  if (typeof invHasSpace === 'function' && !invHasSpace()) {
    _marketToast('Инвентарь полон — освободите место', 'err');
    return;
  }
  const existing = document.getElementById('market-buy-ov');
  if (existing) existing.remove();
  const it  = l.item || {};
  const rc  = RARITY_COLOR[it.rarity] || '#aea599';
  const bal = window._gramBalance || 0;
  const canAfford = bal >= l.price;
  const ov = document.createElement('div');
  ov.className = 'market-modal-overlay';
  ov.id = 'market-buy-ov';
  ov.onclick = () => ov.remove();
  ov.innerHTML = `
    <div class="market-modal-sheet" onclick="event.stopPropagation()">
      <div style="display:flex;align-items:center;margin-bottom:14px">
        <div style="font-size:16px;font-weight:800;color:#90d653">Подтверждение покупки</div>
        <button onclick="document.getElementById('market-buy-ov').remove()" style="margin-left:auto;width:28px;height:28px;border:none;border-radius:50%;background:rgba(209,204,197,.08);color:#968a7a;cursor:pointer">✕</button>
      </div>
      <div style="display:flex;align-items:center;gap:12px;padding:10px;background:rgba(209,204,197,.04);border-radius:10px;margin-bottom:14px">
        <div class="market-row-icon" style="width:44px;height:44px">${_itemIcon(it, 32)}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;color:${rc}">${it.name || '?'}${it.enhance ? ' +' + it.enhance : ''}${it.qty > 1 ? ' ×' + it.qty : ''}</div>
          <div style="font-size:11px;color:#a3957c;margin-top:2px">${statStr(it) || '&nbsp;'}</div>
          <div style="font-size:11px;color:#a3957c;margin-top:2px">Продавец: @${l.sellerUsername || '?'}</div>
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px"><span style="color:#b2a288">Цена</span><span style="font-weight:700;color:#90d653">${l.price.toFixed(2)} GRAM</span></div>
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:16px"><span style="color:#b2a288">Ваш баланс</span><span style="font-weight:700;color:${canAfford ? '#f5dbae' : '#ee6676'}">${bal.toFixed(2)} GRAM</span></div>
      ${canAfford
        ? `<button class="gram-btn gram-btn-green" style="width:100%;padding:13px" onclick="_confirmMarketBuy('${listingId}')">Купить за ${l.price.toFixed(2)} GRAM</button>`
        : `<div style="text-align:center;color:#ee6676;font-size:12px;font-weight:600">Недостаточно GRAM</div>`}
    </div>`;
  document.body.appendChild(ov);
}

function _confirmMarketBuy(listingId) {
  const ov = document.getElementById('market-buy-ov');
  if (ov) ov.remove();
  netMarketBuy(listingId);
}

function marketCancelListing(listingId) {
  netMarketCancel(listingId);
}

// ── Sell flow ───────────────────────────────────────────────
function openMarketSellPicker() {
  if (!player) return;
  const existing = document.getElementById('market-sell-ov');
  if (existing) existing.remove();
  _marketSellPick = null;
  const ov = document.createElement('div');
  ov.className = 'market-modal-overlay';
  ov.id = 'market-sell-ov';
  ov.onclick = () => ov.remove();
  ov.innerHTML = `
    <div class="market-modal-sheet" onclick="event.stopPropagation()">
      <div style="display:flex;align-items:center;margin-bottom:10px">
        <div style="font-size:16px;font-weight:800;color:#90d653">Выставить предмет</div>
        <button onclick="document.getElementById('market-sell-ov').remove()" style="margin-left:auto;width:28px;height:28px;border:none;border-radius:50%;background:rgba(209,204,197,.08);color:#968a7a;cursor:pointer">✕</button>
      </div>
      <div style="font-size:11px;color:#a3957c;margin-bottom:8px">Выберите предмет из инвентаря</div>
      <div class="market-pick-grid" id="market-pick-grid"></div>
      <div id="market-sell-confirm" style="display:none;margin-top:6px">
        <div style="display:flex;align-items:center;gap:10px;padding:10px;background:rgba(209,204,197,.04);border-radius:10px;margin-bottom:12px" id="market-sell-selected"></div>
        <div id="market-qty-row" style="display:none;margin-bottom:10px">
          <div style="font-size:11px;color:#a3957c;margin-bottom:5px">Количество</div>
          <input type="number" id="market-qty-input" min="1" step="1" value="1"
            style="width:100%;padding:11px;border-radius:9px;border:1px solid rgba(209,204,197,.15);background:rgba(209,204,197,.05);color:#d1ccc5;font-size:15px;font-weight:700;box-sizing:border-box" oninput="_clampMarketQtyInput()">
        </div>
        <div style="font-size:11px;color:#a3957c;margin-bottom:5px">Цена за всё количество (${MARKET_MIN_PRICE}–${MARKET_MAX_PRICE} GRAM)</div>
        <input type="number" id="market-price-input" min="${MARKET_MIN_PRICE}" max="${MARKET_MAX_PRICE}" step="0.1" value="1"
          style="width:100%;padding:11px;border-radius:9px;border:1px solid rgba(209,204,197,.15);background:rgba(209,204,197,.05);color:#d1ccc5;font-size:15px;font-weight:700;margin-bottom:6px;box-sizing:border-box" oninput="_updateMarketFeePreview()">
        <div id="market-fee-preview" style="font-size:11px;color:#a3957c;margin-bottom:14px"></div>
        <button class="market-add-btn" id="market-confirm-btn" onclick="_confirmMarketList()">Выставить на продажу</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  _renderMarketPickGrid();
}

function closeMarketSellPicker() {
  const ov = document.getElementById('market-sell-ov');
  if (ov) ov.remove();
  _marketSellPick = null;
}

function _renderMarketPickGrid() {
  const grid = document.getElementById('market-pick-grid');
  if (!grid || !player) return;
  if (!player.inventory.length) { grid.innerHTML = '<div class="rating-empty" style="grid-column:1/-1">Инвентарь пуст</div>'; return; }
  grid.innerHTML = player.inventory.map((it, idx) => {
    const rc  = RARITY_COLOR[it.rarity] || '#aea599';
    const sel = _marketSellPick === idx ? ' selected' : '';
    const cnt = it.qty > 1 ? `<span style="position:absolute;bottom:1px;right:2px;font-size:7px;color:#cfc0ad;font-weight:bold">×${it.qty}</span>` : '';
    return `<div class="market-pick-cell${sel}" style="border-color:${rc}55" onclick="_pickMarketSellItem(${idx})" title="${it.name}">
      ${_itemIcon(it, 26)}${cnt}
    </div>`;
  }).join('');
}

function _pickMarketSellItem(idx) {
  _marketSellPick = idx;
  _renderMarketPickGrid();
  const it = player.inventory[idx];
  const box = document.getElementById('market-sell-selected');
  const confirmWrap = document.getElementById('market-sell-confirm');
  const qtyRow = document.getElementById('market-qty-row');
  if (!it || !box || !confirmWrap) return;
  const rc = RARITY_COLOR[it.rarity] || '#aea599';
  const have = it.qty || 1;
  const stackable = _isStackable(it) && have > 1;
  box.innerHTML = `<div class="market-row-icon" style="width:40px;height:40px">${_itemIcon(it, 28)}</div>
    <div><div style="font-weight:700;color:${rc}">${it.name}${it.enhance ? ' +' + it.enhance : ''}</div>
    <div style="font-size:11px;color:#a3957c;margin-top:2px">${statStr(it) || (have > 1 ? 'У вас: ×' + have : '')}</div></div>`;
  confirmWrap.style.display = 'block';
  if (qtyRow) {
    qtyRow.style.display = stackable ? 'block' : 'none';
    if (stackable) {
      const qtyInput = document.getElementById('market-qty-input');
      if (qtyInput) { qtyInput.max = have; qtyInput.value = have; } // default: list the whole stack
    }
  }
  _updateMarketFeePreview();
}

function _clampMarketQtyInput() {
  const idx = _marketSellPick;
  const it  = idx !== null && player ? player.inventory[idx] : null;
  const input = document.getElementById('market-qty-input');
  if (!it || !input) return;
  const have = it.qty || 1;
  let v = Math.floor(Number(input.value));
  if (!Number.isFinite(v) || v < 1) v = 1;
  if (v > have) v = have;
  input.value = v;
}

function _updateMarketFeePreview() {
  const el    = document.getElementById('market-fee-preview');
  const input = document.getElementById('market-price-input');
  if (!el || !input) return;
  const p = Number(input.value);
  if (!Number.isFinite(p) || p < MARKET_MIN_PRICE || p > MARKET_MAX_PRICE) {
    el.textContent = `Цена должна быть от ${MARKET_MIN_PRICE} до ${MARKET_MAX_PRICE} GRAM`;
    el.style.color = '#ee6676';
    return;
  }
  const payout = p * (1 - MARKET_FEE_PCT);
  el.textContent = `Комиссия 10% сгорает — вы получите ${payout.toFixed(2)} GRAM`;
  el.style.color = '#a3957c';
}

function _setSellPickerBusy(busy) {
  const btn = document.getElementById('market-confirm-btn');
  if (btn) { btn.disabled = busy; btn.style.opacity = busy ? '0.5' : '1'; btn.textContent = busy ? 'Выставляем…' : 'Выставить на продажу'; }
}

function _confirmMarketList() {
  if (_marketSellPick === null || !player || _pendingSellItem) return;
  const priceInput = document.getElementById('market-price-input');
  const p = Number(priceInput?.value);
  if (!Number.isFinite(p) || p < MARKET_MIN_PRICE || p > MARKET_MAX_PRICE) {
    _marketToast(`Цена должна быть от ${MARKET_MIN_PRICE} до ${MARKET_MAX_PRICE} GRAM`, 'err');
    return;
  }
  const idx = _marketSellPick;
  const it  = player.inventory[idx];
  if (!it) return;
  const have = it.qty || 1;
  let itemSnapshot;
  if (_isStackable(it) && have > 1) {
    const qtyInput = document.getElementById('market-qty-input');
    let qty = Math.floor(Number(qtyInput?.value));
    if (!Number.isFinite(qty) || qty < 1) qty = 1;
    if (qty > have) qty = have;
    itemSnapshot = { ...it, qty };
    if (qty >= have) player.inventory.splice(idx, 1);
    else it.qty = have - qty;
  } else {
    // Single unit (stackable with qty 1, or non-stackable equipment)
    itemSnapshot = it;
    player.inventory.splice(idx, 1);
  }
  _pendingSellItem = { item: itemSnapshot };
  _setSellPickerBusy(true);
  updateInvUI();
  netMarketList(itemSnapshot, Math.round(p * 100) / 100);
}

// ── Server event handlers (called from network.js) ───────────────────────────
function onMarketBrowseData(listings) {
  _marketLots = listings;
  _marketLoaded.lots = true;
  if (_marketTab === 'lots') _renderMarketBody();
}
function onMarketMyListingsData(listings) {
  _marketMine = listings;
  _marketLoaded.mine = true;
  if (_marketTab === 'mine') _renderMarketBody();
}
function onMarketHistoryData(entries) {
  _marketHist = entries;
  _marketLoaded.history = true;
  if (_marketTab === 'history') _renderMarketBody();
}
function onMarketListed(listing) {
  _pendingSellItem = null;
  closeMarketSellPicker();
  _marketMine.unshift(listing);
  if (_marketTab === 'mine') _renderMarketBody();
  netSaveProgressNow();
  _marketToast(`Лот «${listing.item?.name || ''}» выставлен за ${listing.price} GRAM`, 'ok');
}
function onMarketCancelled(listingId, item) {
  _marketMine = _marketMine.filter(l => l.id !== listingId);
  if (item) addToInventoryQty(item, item.qty || 1);
  updateInvUI();
  if (_marketTab === 'mine') _renderMarketBody();
  netSaveProgressNow();
  _marketToast('Лот снят, предмет возвращён в инвентарь', 'ok');
}
function onMarketBought(listingId, item) {
  _marketLots = _marketLots.filter(l => l.id !== listingId);
  if (item && !addToInventoryQty(item, item.qty || 1)) _marketToast('Инвентарь полон — предмет не поместился!', 'err');
  updateInvUI();
  if (_marketTab === 'lots') _renderMarketBody();
  netSaveProgressNow();
  _marketToast(`Куплено: ${item?.name || ''}${item?.qty > 1 ? ' ×' + item.qty : ''}`, 'ok');
}
function onMarketSold(data) {
  _marketToast(`Продано: ${data.itemName} за ${data.price} GRAM (+${(data.payout || 0).toFixed(2)} вам)`, 'ok');
  const panel = document.getElementById('market-panel');
  if (_marketTab === 'mine' && panel && panel.style.display !== 'none') netMarketMyListings();
}
function onMarketError(msg) {
  _marketToast(msg || 'Ошибка', 'err');
}
function onMarketListError(msg) {
  if (_pendingSellItem) {
    const it = _pendingSellItem.item;
    addToInventoryQty(it, it.qty || 1);
    updateInvUI();
    _pendingSellItem = null;
    _setSellPickerBusy(false);
  }
  _marketToast(msg || 'Ошибка', 'err');
}

// ─────────────────────────────────────────────────────────
//  GRAM SHOP PANEL
// ─────────────────────────────────────────────────────────
const _GRAM_SHOP_PKGS_UI = [
  { id:'pkg1',   gram:1,   label:'Стартовый',  gold:1000,   potions:2,  armor:null,       weapon:null,       bonusSP:0,  color:'#a3957c' },
  { id:'pkg5',   gram:5,   label:'Базовый',    gold:5000,   potions:10, armor:null,       weapon:null,       bonusSP:0,  color:'#89ba5f' },
  { id:'pkg10',  gram:10,  label:'Стандарт',   gold:7000,   potions:10, armor:'Common',   weapon:'Common',   bonusSP:1,  color:'#eab65d' },
  { id:'pkg30',  gram:30,  label:'Продвинутый',gold:20000,  potions:30, armor:'Uncommon', weapon:'Uncommon', bonusSP:2,  color:'#e6b761' },
  { id:'pkg50',  gram:50,  label:'Элитный',    gold:50000,  potions:50, armor:'Rare',     weapon:null,       bonusSP:5,  color:'#e5a546' },
  { id:'pkg100', gram:100, label:'Легендарный',gold:100000, potions:100,armor:'Rare',     weapon:'Rare',     bonusSP:10, color:'#eb4e61' },
];

function showGramShopBtn() {
  const btn = document.getElementById('gram-shop-btn');
  if (btn) { btn.dataset.shown = '1'; btn.style.display = (activeTab === 0) ? 'flex' : 'none'; _positionGramShopBtn(); }
}

function openGramShopPanel() {
  const panel = document.getElementById('gram-shop-panel');
  if (!panel) return;
  panel.style.display = 'flex';
  _renderGramShopPanel();
}

function closeGramShopPanel() {
  const panel = document.getElementById('gram-shop-panel');
  if (panel) panel.style.display = 'none';
}

function _renderGramShopPanel() {
  const el = document.getElementById('gram-shop-body');
  if (!el) return;
  const bal = window._gramBalance || 0;
  el.innerHTML = `
    <div style="background:rgba(230,148,25,0.08);border:1px solid rgba(230,148,25,0.2);border-radius:10px;padding:10px 14px;margin-bottom:14px;font-size:13px;color:#e6af5e;text-align:center">
      Баланс: <b>${bal.toFixed(2)} GRAM</b>
    </div>
    ${_GRAM_SHOP_PKGS_UI.map(pkg => _gramShopPkgHtml(pkg, bal)).join('')}
  `;
}

function _gramShopPkgHtml(pkg, bal) {
  const canAfford = bal >= pkg.gram;
  const kGold = pkg.gold >= 1000 ? (pkg.gold / 1000).toFixed(0) + 'k' : pkg.gold;

  // same ri() pattern as VIP
  function ri(img, label, cls) {
    return `<div class="vip-ri${cls ? ' vip-ri-' + cls : ''}"><img class="vip-ri-img" src="${img}"><span class="vip-ri-label">${label}</span></div>`;
  }

  const wepSfx = { deathknight:'k', lev:'t', ranger:'b', mage:'s', warlock:'s' }[player?.type] || 't';
  const wepPfxMap = { common:'c', uncommon:'u', rare:'r' };

  const _ARMOR_ICONS = {
    common:   ['arm/ch.png','arm/ct.png','arm/cg.png','arm/cb.png','acs/cr.png','acs/cp.png'],
    uncommon: ['arm/uh.png','arm/ut.png','arm/ug.png','arm/ub.png','acs/ur.png','acs/up.png'],
    rare:     ['arm/rh.png','arm/rt.png','arm/rg.png','arm/rb.png','acs/rr.png','acs/rp.png'],
  };
  const _POTION_NAMES = ['hp','exp','gold','regen','atkspeed','atk'];
  const coinUri = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23f1c40f' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='9'/><path d='M12 7v10'/><path d='M15 9.5a3 3 0 0 0-6 0c0 1.5 1 2.2 3 3 2 .8 3 1.5 3 3a3 3 0 0 1-6 0'/></svg>`;

  // gold
  let rows = ri(coinUri, kGold + ' зол.', 'gold');

  // potions
  rows += _POTION_NAMES.map(p => ri(`/images/potion/${p}.png`, `×${pkg.potions}`, '')).join('');

  // armor set
  if (pkg.armor) {
    const key = pkg.armor.toLowerCase();
    const icons = _ARMOR_ICONS[key] || [];
    rows += icons.map(i => ri(`/images/${i}`, '', key)).join('');
  }

  // weapon — class-specific
  if (pkg.weapon) {
    const key = pkg.weapon.toLowerCase();
    const pfx = wepPfxMap[key] || 'c';
    rows += ri(`/images/wep/${pfx}${wepSfx}.png`, '', key);
  }

  // bonus skill points
  if (pkg.bonusSP) {
    const spUri = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23c084fc' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polygon points='12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26'/></svg>`;
    rows += ri(spUri, `+${pkg.bonusSP} ОН`, 'epic');
  }

  return `<div class="gram-shop-card" style="border-color:${pkg.color}44">
    <div class="gram-shop-card-head">
      <div>
        <div class="gram-shop-title" style="color:${pkg.color}">${pkg.label}</div>
        <div class="gram-shop-price">${pkg.gram} GRAM</div>
      </div>
      <button class="gram-shop-buy-btn${canAfford ? '' : ' disabled'}"
        style="border-color:${pkg.color};color:${canAfford ? pkg.color : '#645f57'}"
        onclick="${canAfford ? `openGramShopConfirm('${pkg.id}')` : ''}">
        ${canAfford ? 'Купить' : 'Мало'}
      </button>
    </div>
    <div class="vip-items-row">${rows}</div>
  </div>`;
}

function openGramShopConfirm(pkgId) {
  const pkg = _GRAM_SHOP_PKGS_UI.find(p => p.id === pkgId);
  if (!pkg) return;
  const bal = window._gramBalance || 0;
  if (bal < pkg.gram) return;
  const existing = document.getElementById('gram-shop-confirm-ov');
  if (existing) existing.remove();
  const kGold = pkg.gold >= 1000 ? (pkg.gold / 1000).toFixed(0) + 'k' : pkg.gold;
  const armorLine  = pkg.armor  ? `<div style="color:#c5bfb7">• Полный ${pkg.armor} сет</div>` : '';
  const weaponLine = pkg.weapon ? `<div style="color:#c5bfb7">• Оружие ${pkg.weapon} (по классу)</div>` : '';
  const spLine     = pkg.bonusSP ? `<div style="color:#c5bfb7">• +${pkg.bonusSP} очко${pkg.bonusSP > 1 ? 'в' : ''} навыка</div>` : '';
  const ov = document.createElement('div');
  ov.className = 'market-modal-overlay';
  ov.id = 'gram-shop-confirm-ov';
  ov.onclick = () => ov.remove();
  ov.innerHTML = `
    <div class="market-modal-sheet" onclick="event.stopPropagation()">
      <div style="display:flex;align-items:center;margin-bottom:14px">
        <div style="font-size:16px;font-weight:800;color:${pkg.color}">${pkg.label} — ${pkg.gram} GRAM</div>
        <button onclick="document.getElementById('gram-shop-confirm-ov').remove()" style="margin-left:auto;width:28px;height:28px;border:none;border-radius:50%;background:rgba(209,204,197,.08);color:#968a7a;cursor:pointer">✕</button>
      </div>
      <div style="background:rgba(209,204,197,.04);border-radius:10px;padding:12px 14px;margin-bottom:14px;font-size:13px;line-height:1.8">
        <div style="color:#c5bfb7">• ${kGold} золота</div>
        <div style="color:#c5bfb7">• ${pkg.potions}× каждое зелье (6 видов)</div>
        ${armorLine}${weaponLine}${spLine}
      </div>
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:16px">
        <span style="color:#b2a288">Стоимость</span>
        <span style="font-weight:700;color:${pkg.color}">${pkg.gram} GRAM</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:16px">
        <span style="color:#b2a288">Ваш баланс</span>
        <span style="font-weight:700;color:#f5dbae">${bal.toFixed(2)} GRAM</span>
      </div>
      <button class="gram-btn gram-btn-green" style="width:100%;padding:13px"
        onclick="_confirmGramShopBuy('${pkgId}')">Купить за ${pkg.gram} GRAM</button>
    </div>`;
  document.body.appendChild(ov);
}

function _confirmGramShopBuy(pkgId) {
  const ov = document.getElementById('gram-shop-confirm-ov');
  if (ov) ov.remove();
  if (typeof netGramShopBuy === 'function') netGramShopBuy(pkgId);
}

function onGramShopResult(data) {
  window._gramBalance = data.newBalance;
  if (player) {
    player.gold = data.newGold;
    if (data.newPotionBag) player.potionBag = data.newPotionBag;
    if (data.newInventory) player.inventory = data.newInventory;
    if (data.newBonusSP != null) player.bonusSP = data.newBonusSP;
  }
  if (data.vipData) window._vipData = data.vipData;
  const pkg = _GRAM_SHOP_PKGS_UI.find(p => p.id === data.pkgId);
  const lbl = pkg ? pkg.label : 'Пакет';
  _marketToast(`✓ ${lbl} куплен!`, 'ok');
  const panel = document.getElementById('gram-shop-panel');
  if (panel && panel.style.display !== 'none') _renderGramShopPanel();
  updateInvUI();
  if (activeTab === 1 && _invTab === 1) updateProfileUI();
  if (activeTab === 1 && _invTab === 0) updateUpgradeUI();
}

function onGramShopError(msg) {
  _marketToast(msg || 'Ошибка покупки', 'err');
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
      <div style="font-size:11px;color:#82745b;margin-top:8px">За каждый депозит друга вы получаете <b style="color:#89ba5f">5%</b></div>
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
    if (btn) { const old = btn.textContent; btn.textContent = 'Скопировано!'; btn.style.color = '#89ba5f'; setTimeout(() => { btn.textContent = old; btn.style.color = ''; }, 2000); }
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
  toast.style.cssText = 'position:fixed;top:80px;left:50%;transform:translateX(-50%);background:#29361e;border:1px solid #89ba5f;color:#89ba5f;padding:10px 18px;border-radius:10px;font-size:13px;font-weight:600;z-index:9999;pointer-events:none';
  toast.textContent = `Друг @${data.username || 'игрок'} присоединился!`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function onRefBonusReceived(data) {
  const f = _refFriendsList.find(x => x.username === data.fromUsername);
  if (f) f.bonus = (f.bonus || 0) + data.bonus;
  if (window._profileTab === 'friends') updateFriendsUI();
  const toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;top:80px;left:50%;transform:translateX(-50%);background:#362d1e;border:1px solid #eec379;color:#eec379;padding:10px 18px;border-radius:10px;font-size:13px;font-weight:600;z-index:9999;pointer-events:none';
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
      <div onclick="event.stopPropagation()" style="width:100%;max-width:500px;background:#16120a;border-radius:18px 18px 0 0;border-top:1px solid rgba(209,204,197,.1);padding:22px 20px 36px;">
        <div style="display:flex;align-items:center;margin-bottom:18px">
          <div style="font-size:16px;font-weight:800;color:#90d653">Пополнение GRAM</div>
          <button onclick="closeGramModal()" style="margin-left:auto;width:28px;height:28px;border:none;border-radius:50%;background:rgba(209,204,197,.08);color:#968a7a;cursor:pointer">✕</button>
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
      <div onclick="event.stopPropagation()" style="width:100%;max-width:500px;background:#16120a;border-radius:18px 18px 0 0;border-top:1px solid rgba(209,204,197,.1);padding:22px 20px 36px;">
        <div style="display:flex;align-items:center;margin-bottom:18px">
          <div style="font-size:16px;font-weight:800;color:#e5a546">Вывод GRAM</div>
          <button onclick="closeGramModal()" style="margin-left:auto;width:28px;height:28px;border:none;border-radius:50%;background:rgba(209,204,197,.08);color:#968a7a;cursor:pointer">✕</button>
        </div>

        <div style="background:rgba(229,165,70,0.08);border:1px solid rgba(229,165,70,0.2);border-radius:10px;padding:10px 14px;margin-bottom:16px;font-size:13px;color:#ba9865">
          Доступно: <b>${balance.toFixed(2)} GRAM</b> · Комиссия 10%
        </div>

        <div style="margin-bottom:12px">
          <div class="gram-hint" style="margin-bottom:6px">Сумма вывода (мин. 10 GRAM):</div>
          <input id="gram-wd-amount" type="number" min="10" step="0.01" placeholder="Сумма GRAM" class="gram-input" style="width:100%;box-sizing:border-box" oninput="_updateWdPreview()">
        </div>
        <div id="gram-wd-preview" style="font-size:12px;color:#a3957c;margin:-6px 0 12px;padding:0 2px"></div>

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

function _updateWdPreview() {
  const el = document.getElementById('gram-wd-preview');
  if (!el) return;
  const v = parseFloat(document.getElementById('gram-wd-amount')?.value);
  if (!v || v < 10) { el.textContent = ''; return; }
  const fee = Math.round(v * 0.10 * 100) / 100;
  const net = Math.round((v - fee) * 100) / 100;
  el.textContent = `Комиссия ${fee} GRAM — к получению: ${net} GRAM`;
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
    const net = Math.round((amount - amount * 0.10) * 100) / 100;
    _gramMsg(`Заявка на вывод создана — к получению: ${net} GRAM`, 'ok');
  } else {
    _gramModalMsg('Сервис недоступен', 'err');
  }
}

function gramCopy(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  navigator.clipboard?.writeText(el.textContent.trim()).then(() => {
    el.style.color = '#90d653';
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
