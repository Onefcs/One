// ─────────────────────────────────────────────────────────
//  PANEL UIs
// ─────────────────────────────────────────────────────────
function _itemIcon(it, size) {
  // Skill books: the book glyph framed around that skill's own icon/art, so
  // each one is identifiable at a glance instead of all looking identical.
  if (it && it.skillKey && it.forClass) {
    const sk = (SKILL_DEF[it.forClass] || []).find(s => s.key === it.skillKey);
    const gs = Math.round(size * 0.58);
    const glyph = sk && sk.img
      ? `<img src="${sk.img}" width="${gs}" height="${gs}" style="image-rendering:pixelated;border-radius:2px">`
      : iconHTML((sk && sk.icon) || 'book', gs, '#e3941d');
    return `<div style="position:relative;width:${size}px;height:${size}px">
      ${iconHTML('book', size, '#c48a3a')}
      <div style="position:absolute;left:50%;top:46%;transform:translate(-50%,-50%)">${glyph}</div>
    </div>`;
  }
  // Passive skill books: same book-glyph treatment, framing the passive's
  // own icon (PASSIVE_CLASS_DEF for class-exclusive ones, PASSIVE_COMMON_DEF
  // for universal ones — passiveDefById checks both).
  if (it && it.passiveId) {
    const pd = typeof passiveDefById === 'function' ? passiveDefById(it.forClass, it.passiveId) : null;
    const gs = Math.round(size * 0.58);
    const glyph = pd && pd.img
      ? `<img src="${pd.img}" width="${gs}" height="${gs}" style="image-rendering:pixelated;border-radius:2px">`
      : iconHTML('star', gs, '#e3941d');
    return `<div style="position:relative;width:${size}px;height:${size}px">
      ${iconHTML('book', size, '#c48a3a')}
      <div style="position:absolute;left:50%;top:46%;transform:translate(-50%,-50%)">${glyph}</div>
    </div>`;
  }
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
        <div style="font-size:11px;color:#a2988a;margin-top:2px">${tVars('charLevelFmt', { lvl: p.lvl })}</div>
        <div style="font-size:11px;color:#5d564b;margin-top:2px;display:flex;align-items:center;gap:3px">
          ${iconHTML('heart',11,'#da4658')}${Math.ceil(p.hp)}/${p.maxHp} ·
          <span style="color:#eaa742;font-weight:700">${t('bmAbbrev')} ${typeof calcBM==='function'?calcBM(p):0}</span> ·
          ${iconHTML('coin',11,'#e3941d')}${p.gold}
        </div>
      </div>
      <div onclick="openHpPicker()" style="color:#98e456;text-align:right;font-weight:bold;display:flex;flex-direction:column;align-items:center;gap:1px;cursor:pointer">
        ${_hudPtDef && _hudPtDef.img ? `<img src="${_hudPtDef.img}" width="20" height="20" style="image-rendering:pixelated">` : iconHTML('potion',20,'#90d653')}
        <span style="font-size:10px">×${_hudCount}</span>
        ${_activeBufCount > 0 ? `<span style="font-size:9px;color:#e5a546">${_activeBufCount} ${t('buffCountSuffix')}</span>` : ''}
      </div>
    </div>
  `;

  // Potion shelf hidden — HP potions managed via HUD picker
  const ptEl = document.getElementById('potion-shelf');
  if (ptEl) ptEl.innerHTML = '';

  // Inventory grid — materials stack by id
  document.getElementById('inv-count').textContent = invSlotCount() + '/150';
  const _displayInv = [];
  inv.forEach((it, idx) => {
    if (_isStackable(it)) {
      _displayInv.push({ it, idx, count: it.qty || 1 });
    } else {
      _displayInv.push({ it, idx });
    }
  });

  document.getElementById('inv-grid').innerHTML = Array.from({ length: 150 }, (_, i) => {
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
  const autoLabels = [t('offLbl'), '30%', '50%', '70%'];
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
      <div style="font-size:9px;color:#72685a">${tVars('potCooldownFmt', { hp: def.hp, s: 4 })}</div>
      ${isHud ? `<div style="font-size:9px;color:#90d653;font-weight:700;margin-top:2px">${t('inHudBadge')}</div>` : ''}
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
      <div style="font-size:15px;font-weight:800;color:#90d653">${t('npcHealPotionsHdr')}</div>
      <button onclick="document.getElementById('hp-picker-ov').remove()" style="width:28px;height:28px;border:none;border-radius:50%;background:rgba(209,204,197,.08);color:#968a7a;font-size:13px;cursor:pointer;">✕</button>
    </div>
    <div style="display:flex;gap:10px;margin-bottom:16px">${potCells}</div>
    <div style="font-size:11px;color:#72685a;margin-bottom:8px">${t('autoUseHint')}</div>
    <div style="display:flex;gap:8px">${autoRows}</div>
    <button onclick="usePotion();document.getElementById('hp-picker-ov').remove()" style="
      width:100%;margin-top:14px;padding:12px;border:none;border-radius:12px;
      background:linear-gradient(135deg,#29361e,#415331);color:#90d653;font-size:15px;font-weight:700;cursor:pointer;
    ">${t('useBtn')}</button>
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
        <div class="prof-lvl">${tVars('charLevelFmt', { lvl: p.lvl })} · ${th.name}</div>
      </div>
    </div>
    <div class="xp-lbl">${tVars('xpFmt', { xp: Math.floor(p.xp), xpNext: p.xpNext })}</div>
    <div class="xp-bg"><div class="xp-fill" style="width:${pct}%"></div></div>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-ic">${iconHTML('heart',14,'#da4658')}</div><div class="stat-vl">${Math.ceil(p.hp)}</div><div class="stat-nm">HP</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('sword',14,'#da952e')}</div><div class="stat-vl">${p.atk}</div><div class="stat-nm">${t('clanPerkAtk')}</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('shield',14,'#d1aa65')}</div><div class="stat-vl">${p.def}</div><div class="stat-nm">${t('statDef')}</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('lightning',14,'#e3941d')}</div><div class="stat-vl">${p.atkSpeed.toFixed(2)}</div><div class="stat-nm">${t('statAtkSpeedAbbrev')}</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('star',14,'#da4658')}</div><div class="stat-vl">${fmt1(p.critChance)}</div><div class="stat-nm">${t('statCritChance')}</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('flame',14,'#da952e')}</div><div class="stat-vl">${p.critPower.toFixed(2)}x</div><div class="stat-nm">${t('statCritPower')}</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('hpPlus',14,'#79b644')}</div><div class="stat-vl">${p.hpRegen.toFixed(2)}</div><div class="stat-nm">${t('statHpRegen')}</div></div>
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
  if (spLbl) spLbl.textContent = tVars('skillPointsFmt', { n: availSP });
  const u = player.upgrades || {};
  el.innerHTML = Object.entries(UPGRADE_DEF).map(([key, cfg]) => {
    const lvl  = u[key] || 0;
    const cost = 300 * (lvl + 1);
    const can  = player.gold >= cost && availSP >= 1;
    return `<div class="upg-row">
      <div class="upg-info">
        <span class="upg-label">${iconHTML(cfg.icon, 14, '#b2a58e')} ${cfg.label}</span>
        <span class="upg-meta">${t('levelAbbrev')}${lvl} · ${cfg.desc}</span>
      </div>
      <button class="upg-btn${can ? '' : ' disabled'}" onclick="upgradeStats('${key}')">
        ${iconHTML('coin',12,'#e3941d')}${cost} + 1 ${t('spAbbrev')}
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
    case 'damage':   return `+${level}% ${t('bonusToDamage')}`;
    case 'buff':     return `+${level}${t('bonusToDuration')}`;
    case 'heal':     return `+${level}% ${t('bonusToHeal')}`;
    case 'mobility': return `+${level * 10}${t('bonusToRange')}`;
    default:         return null;
  }
}

function _skillBonusTypeLabel(type) {
  switch (type) {
    case 'damage':   return t('bonusTypeDamage');
    case 'buff':     return t('bonusTypeBuff');
    case 'heal':     return t('bonusTypeHeal');
    case 'mobility': return t('bonusTypeMobility');
    default:         return '';
  }
}

const SKILL_STUDY_COST   = 1;   // books to unlock a level-0 (locked) skill
const SKILL_UPGRADE_COST = 2;   // books per upgrade attempt once studied
const SKILL_UPGRADE_CHANCE = 0.30;

// Every class+key combo has its OWN book (shared/definitions.js CRAFT_MATS,
// id "book_<class>_<key>") — a generic book wouldn't say which of the 4
// different abilities it's for.
function _skillBookId(cls, key) { return `book_${cls}_${key}`; }
function _skillBookDef(cls, key) {
  return CRAFT_MATS.find(m => m.id === _skillBookId(cls, key));
}

function updateSkillsUI() {
  if (!player) return;
  const el = document.getElementById('skill-upgrade-panel');
  if (!el) return;
  const skills = SKILL_DEF[player.type];
  if (!skills) { el.innerHTML = `<div style="padding:16px;color:#645f57;text-align:center">${t('selectCharacterHint')}</div>`; return; }
  const bonusTypes = (SKILL_BONUS_TYPE || {})[player.type] || {};
  const sl = player.skillLevels || {};

  el.innerHTML = `
    <div class="skill-upg-header">
      <span>${iconHTML('book', 13, '#e3941d')} ${t('skillBooksHdr')}</span>
      <span class="skill-upg-hint">${tVars('studyUpgradeHintFmt', { a: SKILL_STUDY_COST, b: SKILL_UPGRADE_COST, c: Math.round(SKILL_UPGRADE_CHANCE * 100) })}</span>
    </div>
    ${skills.map(sk => {
      const level = sl[sk.key] || 0;
      const locked = level <= 0;
      const maxed = level >= 10;
      const bonusType = bonusTypes[sk.key] || 'damage';
      const bonusNow  = locked ? null : _skillBonusDesc(bonusType, level);
      const bonusNext = (locked || maxed) ? null : _skillBonusDesc(bonusType, level + 1);
      const bookId = _skillBookId(player.type, sk.key);
      const bookName = (_skillBookDef(player.type, sk.key) || {}).name || t('skillBookFallback');
      const bookCount = countMaterial(bookId);

      const dots = Array.from({ length: 10 }, (_, i) =>
        `<span class="sk-dot${i < level ? ' filled' : ''}"></span>`
      ).join('');

      // Book-framed icon — the skill's own icon/art nested inside the book
      // glyph, so each skill's book is visually identifiable at a glance.
      const skillGlyph = sk.img
        ? `<img src="${sk.img}" width="15" height="15" style="image-rendering:pixelated;border-radius:2px">`
        : iconHTML(sk.icon, 15, locked ? '#645f57' : '#e3941d');
      const iconEl = `<div style="position:relative;width:26px;height:26px;opacity:${locked ? 0.4 : 1}">
        ${iconHTML('book', 26, locked ? '#645f57' : '#c48a3a')}
        <div style="position:absolute;left:50%;top:46%;transform:translate(-50%,-50%)">${skillGlyph}</div>
      </div>`;

      let btnLabel, btnAction, btnDisabled;
      if (locked) {
        btnDisabled = bookCount < SKILL_STUDY_COST;
        btnLabel = iconHTML('book', 12, '#e3941d') + ` ${SKILL_STUDY_COST} · ${tVars('studyBtnFmt', { n: bookCount })}`;
        btnAction = `studySkill('${sk.key}')`;
      } else if (maxed) {
        btnDisabled = true;
        btnLabel = t('maxLbl');
        btnAction = '';
      } else {
        btnDisabled = bookCount < SKILL_UPGRADE_COST;
        btnLabel = iconHTML('book', 12, '#e3941d') + ` ${SKILL_UPGRADE_COST} · ${tVars('upgradeBtnFmt', { pct: Math.round(SKILL_UPGRADE_CHANCE * 100), n: bookCount })}`;
        btnAction = `upgradeSkillWithBook('${sk.key}')`;
      }

      return `<div class="skill-upg-card">
        <div class="skill-upg-top">
          <div class="skill-upg-icon" style="position:relative">
            ${iconEl}
            ${locked ? `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">${iconHTML('lock', 15, '#d1ccc5')}</div>` : ''}
          </div>
          <div class="skill-upg-info">
            <div class="skill-upg-name">${sk.name}<span class="skill-upg-lvl">${locked ? ' 🔒 ' + t('notStudiedLbl') : maxed ? ' ' + t('maxAbbrev') : ' ' + t('levelAbbrev') + level}</span></div>
            <div class="skill-upg-desc">${sk.desc}</div>
            <div class="skill-upg-type">${locked ? bookName : _skillBonusTypeLabel(bonusType)}</div>
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
  const bookId = _skillBookId(player.type, key);
  if (countMaterial(bookId) < SKILL_STUDY_COST) {
    dmgNum(player.x, player.y - 30, t('needSkillBookToast'), '#f17e8b');
    return;
  }
  removeFromInventory(bookId, SKILL_STUDY_COST);
  sl[key] = 1;
  spawnBurst(player.x, player.y, '#e69419', 10);
  dmgNum(player.x, player.y - 42, t('skillStudiedToast'), '#e69419');
  netSaveProgress();
  updateSkillsUI();
  updateInvUI();
}

function upgradeSkillWithBook(key) {
  if (!player) return;
  const sl = player.skillLevels || (player.skillLevels = { Q:0, W:0, E:0, R:0 });
  const lvl = sl[key] || 0;
  if (lvl <= 0) { dmgNum(player.x, player.y - 30, t('studySkillFirstToast'), '#f17e8b'); return; }
  if (lvl >= 10) return;
  const bookId = _skillBookId(player.type, key);
  if (countMaterial(bookId) < SKILL_UPGRADE_COST) {
    dmgNum(player.x, player.y - 30, tVars('needNSkillBooksFmt', { n: SKILL_UPGRADE_COST }), '#f17e8b');
    return;
  }
  removeFromInventory(bookId, SKILL_UPGRADE_COST);
  if (Math.random() < SKILL_UPGRADE_CHANCE) {
    sl[key] = lvl + 1;
    spawnBurst(player.x, player.y, '#e69419', 10);
    dmgNum(player.x, player.y - 42, tVars('skillLevelUpToast', { n: sl[key] }), '#e69419');
  } else {
    dmgNum(player.x, player.y - 36, t('failToast'), '#eb4e61');
  }
  netSaveProgress();
  updateSkillsUI();
  updateInvUI();
}

// ─────────────────────────────────────────────────────────
//  PASSIVE SKILL UI
// ─────────────────────────────────────────────────────────
let _activeSkillSubTab = 'active';

function switchSkillTab(tab) {
  _activeSkillSubTab = tab;
  const wrapActive  = document.getElementById('skill-active-wrap');
  const wrapPassive = document.getElementById('skill-passive-wrap');
  const btnActive   = document.getElementById('sktab-active');
  const btnPassive  = document.getElementById('sktab-passive');
  if (!wrapActive || !wrapPassive) return;
  const onPassive = tab === 'passive';
  wrapActive.style.display  = onPassive ? 'none' : '';
  wrapPassive.style.display = onPassive ? '' : 'none';
  btnActive?.classList.toggle('active', !onPassive);
  btnPassive?.classList.toggle('active', onPassive);
  if (onPassive) updatePassiveSkillsUI(); else updateSkillsUI();
}

function _passiveBonusText(p, level) {
  if (level <= 0) return null;
  const val = p.perLevel * level;
  if (p.stat === 'hpRegenFlat') return `+${val.toFixed(1)} ${t('hpPerSecSuffix')}`;
  if (p.stat === 'cdrPct') return `-${Math.round(val * 100)}% ${t('skillCdrSuffix')}`;
  const label = {
    atkPct: t('passiveStatAtk'), defPct: t('passiveStatDef'), hpPct: t('passiveStatHp'),
    atkSpeedPct: t('passiveStatAtkSpeed'), moveSpeedPct: t('passiveStatMoveSpeed'), critPowerFlat: t('passiveStatCritPower'),
  }[p.stat] || '';
  return `+${Math.round(val * 100)}% ${label}`;
}

// One book per passive id (shared/definitions.js CRAFT_MATS, id
// "book_pas_<id>") — mirrors _skillBookId/_skillBookDef above exactly.
function _passiveBookId(id) { return `book_pas_${id}`; }
function _passiveBookDef(id) {
  return CRAFT_MATS.find(m => m.id === _passiveBookId(id));
}

function _passiveCardHtml(p) {
  if (!player) return '';
  const pl = player.passiveLevels || {};
  const level = pl[p.id] || 0;
  const locked = level <= 0;
  const maxed = level >= PASSIVE_MAX_LEVEL;
  const bonusNow  = locked ? null : _passiveBonusText(p, level);
  const bonusNext = (locked || maxed) ? null : _passiveBonusText(p, level + 1);
  const bookId = _passiveBookId(p.id);
  const bookName = (_passiveBookDef(p.id) || {}).name || t('skillBookFallback');
  const bookCount = countMaterial(bookId);

  const dots = Array.from({ length: PASSIVE_MAX_LEVEL }, (_, i) =>
    `<span class="sk-dot${i < level ? ' filled' : ''}"></span>`
  ).join('');

  // Book-framed icon — the passive's own icon nested inside the book glyph,
  // same visual treatment as active skill books.
  const passiveGlyph = `<img src="${p.img}" width="15" height="15" style="image-rendering:pixelated;border-radius:2px;opacity:${locked ? 0.5 : 1}">`;
  const iconEl = `<div style="position:relative;width:26px;height:26px;opacity:${locked ? 0.4 : 1}">
    ${iconHTML('book', 26, locked ? '#645f57' : '#c48a3a')}
    <div style="position:absolute;left:50%;top:46%;transform:translate(-50%,-50%)">${passiveGlyph}</div>
  </div>`;

  let btnLabel, btnAction, btnDisabled;
  if (locked) {
    btnDisabled = bookCount < SKILL_STUDY_COST;
    btnLabel = iconHTML('book', 12, '#e3941d') + ` ${SKILL_STUDY_COST} · ${tVars('studyBtnFmt', { n: bookCount })}`;
    btnAction = `studyPassiveSkill('${p.id}')`;
  } else if (maxed) {
    btnDisabled = true;
    btnLabel = t('maxLbl');
    btnAction = '';
  } else {
    btnDisabled = bookCount < SKILL_UPGRADE_COST;
    btnLabel = iconHTML('book', 12, '#e3941d') + ` ${SKILL_UPGRADE_COST} · ${tVars('upgradeBtnFmt', { pct: Math.round(SKILL_UPGRADE_CHANCE * 100), n: bookCount })}`;
    btnAction = `upgradePassiveSkillWithBook('${p.id}')`;
  }

  return `<div class="skill-upg-card">
    <div class="skill-upg-top">
      <div class="skill-upg-icon" style="position:relative">
        ${iconEl}
        ${locked ? `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">${iconHTML('lock', 15, '#d1ccc5')}</div>` : ''}
      </div>
      <div class="skill-upg-info">
        <div class="skill-upg-name">${p.name}<span class="skill-upg-lvl">${locked ? ' 🔒 ' + t('notStudiedLbl') : maxed ? ' ' + t('maxAbbrev') : ' ' + t('levelAbbrev') + level}</span></div>
        <div class="skill-upg-desc">${p.desc}</div>
        <div class="skill-upg-type">${locked ? bookName : ''}</div>
      </div>
    </div>
    ${!locked ? `<div class="sk-dots">${dots}</div>` : ''}
    ${!locked ? `<div class="sk-bonus-row">
      ${bonusNow ? `<span class="sk-bonus-now">${bonusNow}</span>` : ''}
      ${bonusNext ? `<span class="sk-bonus-next">→ ${bonusNext}</span>` : ''}
    </div>` : ''}
    <button class="skill-upg-btn${btnDisabled ? ' disabled' : ''}" onclick="${btnAction}">${btnLabel}</button>
  </div>`;
}

function updatePassiveSkillsUI() {
  const el = document.getElementById('passive-skill-panel');
  if (!el || !player) return;
  const classDef = PASSIVE_CLASS_DEF[player.type] || [];

  el.innerHTML = `
    <div class="skill-upg-header">
      <span>${iconHTML('book', 13, '#e3941d')} ${t('passiveBooksHdr')}</span>
      <span class="skill-upg-hint">${tVars('studyUpgradeHintFmt', { a: SKILL_STUDY_COST, b: SKILL_UPGRADE_COST, c: Math.round(SKILL_UPGRADE_CHANCE * 100) })}</span>
    </div>
    <div class="sec-title">${tVars('classPassivesFmt', { cls: CHAR_DEF[player.type]?.name || '' })}</div>
    ${classDef.map(_passiveCardHtml).join('')}
    <div class="sec-title" style="margin-top:14px">${t('commonPassivesHdr')}</div>
    ${PASSIVE_COMMON_DEF.map(_passiveCardHtml).join('')}
  `;
}

function studyPassiveSkill(id) {
  if (!player) return;
  const def = typeof passiveDefById === 'function' ? passiveDefById(player.type, id) : null;
  if (!def) return;
  const pl = player.passiveLevels || (player.passiveLevels = {});
  if ((pl[id] || 0) > 0) return; // already studied
  const bookId = _passiveBookId(id);
  if (countMaterial(bookId) < SKILL_STUDY_COST) {
    dmgNum(player.x, player.y - 30, t('needPassiveBookToast'), '#f17e8b');
    return;
  }
  removeFromInventory(bookId, SKILL_STUDY_COST);
  pl[id] = 1;
  recompute();
  spawnBurst(player.x, player.y, '#e69419', 10);
  dmgNum(player.x, player.y - 42, t('passiveStudiedToast'), '#e69419');
  netSaveProgress();
  updatePassiveSkillsUI();
  updateInvUI();
}

function upgradePassiveSkillWithBook(id) {
  if (!player) return;
  const def = typeof passiveDefById === 'function' ? passiveDefById(player.type, id) : null;
  if (!def) return;
  const pl = player.passiveLevels || (player.passiveLevels = {});
  const lvl = pl[id] || 0;
  if (lvl <= 0) { dmgNum(player.x, player.y - 30, t('studyPassiveFirstToast'), '#f17e8b'); return; }
  if (lvl >= PASSIVE_MAX_LEVEL) return;
  const bookId = _passiveBookId(id);
  if (countMaterial(bookId) < SKILL_UPGRADE_COST) {
    dmgNum(player.x, player.y - 30, tVars('needNPassiveBooksFmt', { n: SKILL_UPGRADE_COST }), '#f17e8b');
    return;
  }
  removeFromInventory(bookId, SKILL_UPGRADE_COST);
  if (Math.random() < SKILL_UPGRADE_CHANCE) {
    pl[id] = lvl + 1;
    recompute();
    spawnBurst(player.x, player.y, '#e69419', 10);
    dmgNum(player.x, player.y - 42, tVars('passiveLevelUpToast', { n: pl[id] }), '#e69419');
  } else {
    dmgNum(player.x, player.y - 36, t('failToast'), '#eb4e61');
  }
  netSaveProgress();
  updatePassiveSkillsUI();
  updateInvUI();
}

// Which location (hub or one of the 4 corridor arms) the player is currently
// in, as a tile bounding box — so the "Мир" map only ever draws that one
// location instead of the whole world (hub + all 4 arms stacked end to end).
// Uses the player's Y position against each arm's own room-derived Y range
// rather than requiring the player stand inside a specific room rectangle,
// since most play happens in the connecting corridor between rooms.
function _currentLocationBounds() {
  if (!dungeon || !dungeon.rooms) return null;
  const margin = 6;
  const sz = dungeon.safeZone;
  if (sz && player.x >= sz.x1 && player.x <= sz.x2 && player.y >= sz.y1 && player.y <= sz.y2) {
    return {
      tx0: Math.max(0, Math.floor(sz.x1 / TILE) - margin),
      ty0: Math.max(0, Math.floor(sz.y1 / TILE) - margin),
      tx1: Math.min(dungeon.w - 1, Math.ceil(sz.x2 / TILE) + margin),
      ty1: Math.min(dungeon.h - 1, Math.ceil(sz.y2 / TILE) + margin),
    };
  }
  const playerTy = player.y / TILE;
  for (const dir of ARM_NAMES) {
    const armRooms = dungeon.rooms.filter(r => r.arm === dir);
    if (!armRooms.length) continue;
    const minTy = Math.min(...armRooms.map(r => r.by1));
    const maxTy = Math.max(...armRooms.map(r => r.by2));
    if (playerTy < minTy - margin || playerTy > maxTy + margin) continue;
    const minTx = Math.min(...armRooms.map(r => r.bx1));
    const maxTx = Math.max(...armRooms.map(r => r.bx2));
    // Include the arm's own entrance point so its corridor lead-in (between
    // the teleport pad and the first room pair) never gets clipped off.
    const entry = (dungeon.armEntries || []).find(e => e.dir === dir);
    const entryTx = entry ? entry.x / TILE : minTx;
    return {
      tx0: Math.max(0, Math.floor(Math.min(minTx, entryTx)) - margin),
      ty0: Math.max(0, minTy - margin),
      tx1: Math.min(dungeon.w - 1, maxTx + margin),
      ty1: Math.min(dungeon.h - 1, maxTy + margin),
    };
  }
  // Shouldn't normally happen (hub + 4 arms should cover every reachable Y) —
  // fall back to the whole map rather than drawing nothing.
  return { tx0: 0, ty0: 0, tx1: dungeon.w - 1, ty1: dungeon.h - 1 };
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
  const b = _currentLocationBounds() || { tx0: 0, ty0: 0, tx1: dungeon.w - 1, ty1: dungeon.h - 1 };
  const bw = b.tx1 - b.tx0 + 1, bh = b.ty1 - b.ty0 + 1;
  const sc = Math.min((pw - 20) / bw, (ph - 10) / bh);
  const ox = (pw - bw * sc) / 2, oy = 8;
  const wx = tx => ox + (tx - b.tx0) * sc, wy = ty => oy + (ty - b.ty0) * sc;
  mx2.fillStyle = '#070604'; mx2.fillRect(0, 0, pw, ph);
  for (let ty = b.ty0; ty <= b.ty1; ty++) {
    for (let tx = b.tx0; tx <= b.tx1; tx++) {
      const t = dungeon.grid[ty][tx]; if (t === WALL) continue;
      mx2.fillStyle = th.mmFloor;
      mx2.fillRect(wx(tx), wy(ty), Math.max(1, sc - 0.5), Math.max(1, sc - 0.5));
    }
  }
  mx2.fillStyle = '#79dc23';
  mx2.beginPath(); mx2.arc(wx(player.x / TILE), wy(player.y / TILE), Math.max(2, sc * 0.7), 0, Math.PI * 2); mx2.fill();
  // There is no offline mode in this game — serverEnemies is the only enemy
  // list that ever exists. The old `: enemies` fallback below referenced a
  // global that was never declared anywhere; it silently never ran while the
  // socket stayed connected, but any real disconnect (a backgrounded tab
  // losing its connection, a network blip) hit it immediately and threw a
  // ReferenceError out of render() — which is called from the
  // requestAnimationFrame loop, so the throw skipped the loop's own
  // rAF(loop) call at the end and froze the entire game, permanently, even
  // after the socket reconnected moments later.
  const inBounds = (x, y) => {
    const tx = x / TILE, ty = y / TILE;
    return tx >= b.tx0 && tx <= b.tx1 && ty >= b.ty0 && ty <= b.ty1;
  };
  const mapEnemies = serverEnemies;
  const aliveEnemies = mapEnemies.filter(e => (e.hp || 0) > 0 && inBounds(e.x, e.y));
  mx2.fillStyle = '#e9364b';
  mx2.beginPath();
  aliveEnemies.forEach(e => {
    if (e.isBoss) return;
    mx2.moveTo(wx(e.x / TILE) + Math.max(1.5, sc * 0.5), wy(e.y / TILE));
    mx2.arc(wx(e.x / TILE), wy(e.y / TILE), Math.max(1.5, sc * 0.5), 0, Math.PI * 2);
  });
  mx2.fill();
  // Boss skull icon on map
  const _bossIconSz = Math.max(10, Math.round(sc * 4));
  mx2.font = `${_bossIconSz}px serif`;
  mx2.textAlign = 'center'; mx2.textBaseline = 'middle';
  aliveEnemies.forEach(e => {
    if (!e.isBoss) return;
    mx2.fillText('💀', wx(e.x / TILE), wy(e.y / TILE));
  });
  // NPC blips on map
  mx2.fillStyle = '#e69419';
  mx2.beginPath();
  npcs.filter(n => inBounds(n.x, n.y)).forEach(n => {
    mx2.moveTo(wx(n.x / TILE) + Math.max(2, sc * 0.7), wy(n.y / TILE));
    mx2.arc(wx(n.x / TILE), wy(n.y / TILE), Math.max(2, sc * 0.7), 0, Math.PI * 2);
  });
  mx2.fill();
  const _pRoom = (typeof _getRoomAt === 'function') ? _getRoomAt(player.x, player.y) : null;
  // _armLabel/_ARM_LABEL (js/game.js) only return the bare adjective (e.g.
  // "left") — corridorSuffix is appended at each call site instead of baked
  // into the shared helper, matching how enteredCorridorToast's own template
  // already does it.
  const _locLabel = _pRoom?.arm ? (_armLabel(_pRoom.arm) + ' ' + t('corridorSuffix') + ' · ' + t('levelAbbrev') + ' ' + _pRoom.monsterLvl) : t('centralHall');
  document.getElementById('map-status').textContent =
    _locLabel + ' · ' + tVars('enemiesCountFmt', { n: aliveEnemies.length });
}

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
    ? `<span class="mon-name">${head.name}</span><span class="fi-boss-tag">${t('bossTag')}</span>`
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
          <span class="mon-lvl">${tVars('charLevelFmt', { lvl })}</span>
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
  const _boxUncommon = BOX_DEF.find(bx=>bx.id==='box_uncommon');
  const _boxRare = BOX_DEF.find(bx=>bx.id==='box_rare');
  const _normStone = CRAFT_MATS.find(m=>m.id==='norm_stone');
  const _blessStone = CRAFT_MATS.find(m=>m.id==='bless_stone');
  const stoneRow = isBoss
    ? _dropRow(_itemIcon(_boxUncommon, 16), _boxUncommon.name, `&times;1 · <b style="color:#90d653">50%</b>`, '#90d653')
    + _dropRow(_itemIcon(_boxRare, 16), _boxRare.name, `&times;1 · <b style="color:#4a7bab">10%</b>`, '#4a7bab')
    + _dropRow(_mi(_normStone, 16), _normStone.name, `&times;1 · <b style="color:#f17e8b">10%</b>`, '#f17e8b')
    + _dropRow(_mi(_blessStone, 16), _blessStone.name, `&times;1 · <b style="color:#efc680">1%</b>`, '#efc680')
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
    recipeSection = `<div class="fi-drops-hdr" style="margin-top:8px">${t('craftRecipesHdr')}</div><div class="fi-drops">${rows}</div>`;
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
    keySection = `<div class="fi-drops-hdr" style="margin-top:8px">${t('keysStonesHdr')}</div><div class="fi-drops">${rows}</div>`;
  }

  // Equipment drop: one continuous chance (+0.1%/level, never resets across
  // zones) picks a single rarity by the level's arm (itemDropChanceAtLevel/
  // itemRarityForLevel) then one item uniformly among ALL candidates at that
  // rarity — every class's weapon competes alongside every armor/accessory
  // slot now (js/combat.js no longer restricts weapons to the killing
  // player's own class), so each item's share is 1-in-candidates.length,
  // not a fixed 1-in-7.
  let gearSection = '';
  if (typeof itemDropChanceAtLevel === 'function') {
    const pct = Math.min(100, itemDropChanceAtLevel(lvl) * (isBoss ? BOSS_ITEM_DROP_MULT : 1));
    const rarity = itemRarityForLevel(lvl);
    const rc = (typeof RARITY_COLOR !== 'undefined' ? RARITY_COLOR[rarity] : null) || '#aea599';
    const rn = (typeof _RARITY_NAMES !== 'undefined' ? _RARITY_NAMES[rarity] : null) || rarity;
    const GEAR_SLOTS = ['weapon', 'helmet', 'body', 'gloves', 'boots', 'ring', 'belt'];
    const candidates = ITEM_DEF.filter(d => d.rarity === rarity && GEAR_SLOTS.includes(d.slot));
    const perItemPct = candidates.length ? pct / candidates.length : 0;
    const rows = candidates.map(it => _dropRow(_itemIcon(it, 16), it.name, `&times;1 · <b style="color:${rc}">${_pctText(perItemPct)}</b>`, rc)).join('');
    gearSection = `<div class="fi-drops-hdr" style="margin-top:8px">${tVars('gearRarityFmt', { rn })}</div><div class="fi-drops">${rows}</div>`;
  }

  // Skill books — one per class+skill (shared/definitions.js CRAFT_MATS).
  // Any class's book can drop from any monster (not just the current
  // character's own — see js/combat.js), so every book across all 5
  // classes is listed here, each tagged with which class it's for.
  let bookSection = '';
  {
    const allBooks = CRAFT_MATS.filter(m => m.skillKey);
    if (allBooks.length) {
      const rows = allBooks.map(b => {
        const className = (CHAR_DEF[b.forClass] || {}).name || b.forClass;
        const label = `${b.name} <span style="opacity:.6">(${className})</span>`;
        return isBoss
          ? _dropRow(_itemIcon(b, 16), label, `&times;2 · <b style="color:#98e456">${_pctText(100 / allBooks.length * 0.001)}</b>`, '#98e456')
          : _dropRow(_itemIcon(b, 16), label, `&times;1 · <b>${_pctText(0.00002 * Math.min(dropMult, 3) / allBooks.length * 100)}</b>`);
      }).join('');
      bookSection = `<div class="fi-drops-hdr" style="margin-top:8px">${t('skillBooksAllClassesHdr')}</div><div class="fi-drops">${rows}</div>`;
    }
  }

  // Passive skill books — same mechanic/odds as active skill books above,
  // separate roll and separate pool (js/combat.js).
  let passiveBookSection = '';
  {
    const allPassiveBooks = CRAFT_MATS.filter(m => m.passiveId);
    if (allPassiveBooks.length) {
      const rows = allPassiveBooks.map(b => {
        const label = b.forClass
          ? `${b.name} <span style="opacity:.6">(${(CHAR_DEF[b.forClass] || {}).name || b.forClass})</span>`
          : `${b.name} <span style="opacity:.6">(${t('commonTag')})</span>`;
        return isBoss
          ? _dropRow(_itemIcon(b, 16), label, `&times;2 · <b style="color:#98e456">${_pctText(100 / allPassiveBooks.length * 0.001)}</b>`, '#98e456')
          : _dropRow(_itemIcon(b, 16), label, `&times;1 · <b>${_pctText(0.00002 * Math.min(dropMult, 3) / allPassiveBooks.length * 100)}</b>`);
      }).join('');
      passiveBookSection = `<div class="fi-drops-hdr" style="margin-top:8px">${t('passiveBooksAllClassesHdr')}</div><div class="fi-drops">${rows}</div>`;
    }
  }

  return `
    <div class="fi-mstats">
      <span>HP <b>${hp}</b></span>
      <span>ATK <b>${atk}</b></span>
      <span>DEF <b>${e.def}</b></span>
      <span>${t('spdAbbrev')} <b>${e.spd}</b></span>
    </div>
    <div class="fi-drops-hdr">${t('dropHdr')}</div>
    <div class="fi-drops">
      <div class="fi-drop">
        <span class="fi-drop-lbl">${t('clanPerkXp')}</span>
        <span class="fi-drop-val" style="color:${xpColor}">${xpFinal} XP</span>
      </div>
      <div class="fi-drop">
        <span class="fi-drop-lbl">${t('npcGoldLbl')}</span>
        <span class="fi-drop-val">${goldText}</span>
      </div>
      <div class="fi-drop">
        <span class="fi-drop-icon"><img src="/images/nexum-coin_v2.png" width="16" height="16" style="vertical-align:middle;border-radius:50%"></span>
        <span class="fi-drop-lbl" style="color:#b2864d">Liberty</span>
        <span class="fi-drop-val" style="color:#b2864d">&times;1 · <b style="color:#b2864d">${nexumChancePct}%</b></span>
      </div>
      ${stoneRow}
    </div>
    ${recipeSection}
    ${keySection}
    ${gearSection}
    ${bookSection}
    ${passiveBookSection}`;
}

function updateRaidPanelUI() {
  const body = document.getElementById('raid-panel-body');
  if (!body) return;
  const RARITY_COL = { common: '#aea599', uncommon: '#90d653' };
  const plvl = player?.lvl || 1;
  const lvlOk = plvl >= 3;

  if (inRaid) {
    body.innerHTML = `<div class="raid-hint" style="text-align:center;padding:20px 0">${t('inBattleHint')}</div>`;
    return;
  }

  // Inside a lobby
  if (_myLobbyId) {
    const memberRows = (_myLobbyMembers || []).map(m =>
      `<div class="raid-member" style="display:flex;justify-content:space-between;align-items:center">
        <span>👤 ${m.name}</span>
        <span style="color:#a2988a;font-size:11px">${tVars('memberStatsFmt', { lvl: m.lvl, bm: m.bm })}</span>
      </div>`).join('');
    const canStart = _isLobbyCreator && (_myLobbyMembers?.length || 0) >= 2;
    body.innerHTML = `
      <div class="raid-dungeon-card">
        <div class="raid-dungeon-name">${t('dungeon1Name')}</div>
        <div style="font-size:12px;color:#968a7a;margin-bottom:8px">${tVars('yourGroupFmt', { n: _myLobbyMembers?.length || 1 })}</div>
        <div style="margin-bottom:10px">${memberRows}</div>
        ${_isLobbyCreator
          ? `<div class="raid-hint" style="margin-bottom:8px">${t('creatorWaitHint')}</div>
             <button class="raid-enter-btn${canStart ? '' : ' disabled'}" onclick="${canStart ? 'netStartLobby()' : ''}">${t('startRaidBtn')}</button>`
          : `<div class="raid-hint">${t('waitingStartHint')}</div>`}
      </div>
      <button onclick="netLeaveLobby();updateRaidPanelUI()" style="width:100%;margin-top:8px;padding:10px;background:rgba(235,73,92,.12);color:#ed5a6b;border:1px solid rgba(235,73,92,.25);border-radius:8px;font-size:13px;cursor:pointer">${t('leaveGroupBtn')}</button>
    `;
    return;
  }

  // Lobby list
  const dungeonCard = `
    <div class="raid-dungeon-card" style="margin-bottom:10px">
      <div class="raid-dungeon-name">${t('dungeon1Name')}</div>
      <div class="raid-dungeon-desc">${tVars('monsterWavesFmt', { lvl: 3, w: 6 })}</div>
      <div class="raid-dungeon-rewards">
        <span>💰 500 ${t('goldShortSuffix')}</span><span>⭐ 500 ${t('xpShortSuffix')}</span>
        <span style="color:${RARITY_COL.common}">30% ${_RARITY_NAMES.common}</span>
        <span style="color:${RARITY_COL.uncommon}">5% ${_RARITY_NAMES.uncommon}</span>
      </div>
      <div style="font-size:11px;color:#eaa742;margin-top:4px">${tVars('availableTimesPerDayFmt', { n: 3 })}</div>
    </div>`;

  const createBtn = lvlOk
    ? `<button class="raid-enter-btn" onclick="netCreateLobby(1);netGetLobbyList()" style="margin-bottom:12px">${t('createGroupBtn')}</button>`
    : `<button class="raid-enter-btn disabled" style="margin-bottom:12px">${tVars('lockedNeedLevel', { n: 3 })}</button>`;

  const lobbies = _raidLobbyList || [];
  let lobbyListHtml = '';
  if (lobbies.length === 0) {
    lobbyListHtml = `<div class="raid-hint">${t('noOpenGroupsHint')}</div>`;
  } else {
    lobbyListHtml = lobbies.map(lb => {
      const mList = (lb.members || []).map(m => `<span style="font-size:10px;color:#968a7a">${t('levelAbbrev')}${m.lvl}</span> ${m.name}`).join(', ');
      const full = (lb.members?.length || 0) >= 5;
      return `
        <div class="raid-dungeon-card" style="margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <span style="font-size:13px;font-weight:700;color:#d1ccc5">${lb.creatorName}</span>
            <span style="font-size:11px;color:#968a7a">${lb.members?.length || 1} / 5</span>
          </div>
          <div style="font-size:11px;color:#a2988a;margin-bottom:8px">${mList}</div>
          <button class="raid-enter-btn${full ? ' disabled' : ''}" style="padding:8px" onclick="${full ? '' : `netJoinLobby('${lb.id}')`}">${full ? t('fullLbl') : t('enterBtn')}</button>
        </div>`;
    }).join('');
  }

  body.innerHTML = dungeonCard + createBtn +
    `<div style="font-size:12px;color:#72685a;margin-bottom:6px">${t('openGroupsLbl')} <button onclick="netGetLobbyList()" style="background:none;border:none;color:#e7b765;font-size:11px;cursor:pointer">${t('refreshBtn')}</button></div>` +
    lobbyListHtml;
}

function showRaidComplete({ gold, xp, weaponName, weaponRarity }) {
  const RARITY_COL = { common: '#aea599', uncommon: '#90d653' };
  document.getElementById('raid-reward-body').innerHTML =
    `<div>${tVars('goldRewardFmt', { gold })}</div>` +
    `<div>${tVars('xpRewardFmt', { xp })}</div>` +
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
    body.innerHTML = `<div class="raid-hint" style="text-align:center;padding:20px 0">${t('inMazeHint')}</div>`;
    return;
  }

  if (_myPdLobbyId) {
    const memberRows = (_myPdLobbyMembers || []).map(m =>
      `<div class="raid-member" style="display:flex;justify-content:space-between;align-items:center">
        <span>👤 ${m.name}</span>
        <span style="color:#a2988a;font-size:11px">${tVars('memberStatsFmt', { lvl: m.lvl, bm: m.bm })}</span>
      </div>`).join('');
    const canStart = _isPdLobbyCreator && (_myPdLobbyMembers?.length || 0) >= 3;
    body.innerHTML = `
      <div class="raid-dungeon-card">
        <div class="raid-dungeon-name">${t('mazeName')}</div>
        <div style="font-size:12px;color:#968a7a;margin-bottom:8px">${tVars('yourGroupMinFmt', { n: _myPdLobbyMembers?.length || 1 })}</div>
        <div style="margin-bottom:10px">${memberRows}</div>
        ${_isPdLobbyCreator
          ? `<div class="raid-hint" style="margin-bottom:8px">${t('creatorNeedMin3Hint')}</div>
             <button class="raid-enter-btn${canStart ? '' : ' disabled'}" onclick="${canStart ? 'netStartPdLobby()' : ''}">${t('startBtn')}</button>`
          : `<div class="raid-hint">${t('waitingStartHint')}</div>`}
      </div>
      <button onclick="netLeavePdLobby();updatePartyDungeonPanelUI()" style="width:100%;margin-top:8px;padding:10px;background:rgba(235,73,92,.12);color:#ed5a6b;border:1px solid rgba(235,73,92,.25);border-radius:8px;font-size:13px;cursor:pointer">${t('leaveGroupBtn')}</button>
    `;
    return;
  }

  const dungeonCard = `
    <div class="raid-dungeon-card" style="margin-bottom:10px">
      <div class="raid-dungeon-name">${t('mazeName')}</div>
      <div class="raid-dungeon-desc">${t('mazeDescFull')}</div>
      <div class="raid-dungeon-rewards">
        <span style="color:#b2864d">${t('libertyFromMonstersLbl')}</span>
        <span style="color:#f17e8b">${t('enchantFromBossLbl')}</span>
        <span style="color:#efc680">${t('safeEnchantFromBossLbl')}</span>
      </div>
      <div style="font-size:11px;color:#eaa742;margin-top:4px">${tVars('availableTimesPerDayFmt', { n: 3 })}</div>
    </div>`;

  const pdLvlOk = (player?.lvl || 1) >= 10;
  const createBtn = pdLvlOk
    ? `<button class="raid-enter-btn" onclick="netCreatePdLobby();netGetPdLobbyList()" style="margin-bottom:12px">${t('createGroupBtn')}</button>`
    : `<button class="raid-enter-btn disabled" style="margin-bottom:12px">${tVars('lockedNeedLevel', { n: 10 })}</button>`;

  const lobbies = _pdLobbyList || [];
  let lobbyListHtml = '';
  if (lobbies.length === 0) {
    lobbyListHtml = `<div class="raid-hint">${t('noOpenGroupsHint')}</div>`;
  } else {
    lobbyListHtml = lobbies.map(lb => {
      const mList = (lb.members || []).map(m => `<span style="font-size:10px;color:#968a7a">${t('levelAbbrev')}${m.lvl}</span> ${m.name}`).join(', ');
      const full = (lb.members?.length || 0) >= 8;
      const locked = !pdLvlOk;
      const btnLabel = full ? t('fullLbl') : locked ? `🔒 ${t('minPlayersShort')}` : t('enterBtn');
      return `
        <div class="raid-dungeon-card" style="margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <span style="font-size:13px;font-weight:700;color:#d1ccc5">${lb.creatorName}</span>
            <span style="font-size:11px;color:#968a7a">${lb.members?.length || 1} / 8</span>
          </div>
          <div style="font-size:11px;color:#a2988a;margin-bottom:8px">${mList}</div>
          <button class="raid-enter-btn${(full || locked) ? ' disabled' : ''}" style="padding:8px" onclick="${(full || locked) ? '' : `netJoinPdLobby('${lb.id}')`}">${btnLabel}</button>
        </div>`;
    }).join('');
  }

  body.innerHTML = dungeonCard + createBtn +
    `<div style="font-size:12px;color:#72685a;margin-bottom:6px">${t('openGroupsLbl')} <button onclick="netGetPdLobbyList()" style="background:none;border:none;color:#e7b765;font-size:11px;cursor:pointer">${t('refreshBtn')}</button></div>` +
    lobbyListHtml;
}

function showPartyDungeonComplete({ gold, xp }) {
  document.getElementById('pd-reward-body').innerHTML =
    `<div>${tVars('goldRewardFmt', { gold })}</div>` +
    `<div>${tVars('xpRewardFmt', { xp })}</div>`;
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
  if (n === 2) switchSkillTab(_activeSkillSubTab);
}

// Chat / VIP / Market / Rating float above the world canvas and only make
// sense while actually playing — hidden on every other bottom-nav tab.
// dataset.shown gates this so a button that hasn't been unlocked yet
// (before login/char-select finishes) never gets forced visible.
const _GAME_ONLY_BTNS = ['chat-btn', 'vip-btn', 'market-btn', 'gram-shop-btn', 'rating-btn', 'events-btn'];
function _syncGameOnlyBtns(n) {
  _GAME_ONLY_BTNS.forEach(id => {
    const el = document.getElementById(id);
    if (el && el.dataset.shown === '1') el.style.display = (n === 0) ? 'flex' : 'none';
  });
  // chat-btn's own visibility just changed above — keep the last-message
  // preview bubble (js/network.js) in sync with it (also hidden off the
  // Игра tab).
  if (typeof _refreshChatPreview === 'function') _refreshChatPreview();
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
    if (n === 1) { if (_invTab === 1) updateProfileUI(); else if (_invTab === 2) switchSkillTab(_activeSkillSubTab); else updateInvUI(); }
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
let _gramIconImg = null;

// Minimap floor-tile buffer — see the cache block inside drawHeader() below.
// Only rebuilt when the player crosses into a new tile (or theme/scale
// changes); every other frame just blits it at the current sub-tile offset.
// Invalidated on floor change too, see buildTileCanvas() in js/game.js.
let _mmTileCv = null, _mmTileCvTx = null, _mmTileCvTy = null, _mmTileCvSc = null, _mmTileCvTheme = null;
const _MM_MARGIN = 2; // buffer margin (tiles) beyond the visible window

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

  // The floor pattern only actually changes when the player crosses into a
  // new tile — this window's origin is float-precision but the underlying
  // grid isn't — so rebuilding a ~3700-rect path and filling it EVERY frame
  // (profiled at ~1.1ms, the single biggest chunk of drawHeader's cost) was
  // redoing the same work up to a dozen-plus times between actual changes.
  // Redraw the static pattern into an offscreen buffer only on a tile
  // crossing (or scale/theme change); every other frame just blits it,
  // repositioned for the current sub-tile offset.
  const _mmTileFx = Math.floor(winTx), _mmTileFy = Math.floor(winTy);
  if (!_mmTileCv || _mmTileCvTx !== _mmTileFx || _mmTileCvTy !== _mmTileFy || _mmTileCvSc !== mmSc || _mmTileCvTheme !== th.mmFloor) {
    _mmTileCvTx = _mmTileFx; _mmTileCvTy = _mmTileFy; _mmTileCvSc = mmSc; _mmTileCvTheme = th.mmFloor;
    const bufTiles = _MM_RADIUS * 2 + _MM_MARGIN * 2 + 2;
    const bufPx = Math.ceil(bufTiles * mmSc);
    if (!_mmTileCv) _mmTileCv = document.createElement('canvas');
    if (_mmTileCv.width !== bufPx || _mmTileCv.height !== bufPx) { _mmTileCv.width = bufPx; _mmTileCv.height = bufPx; }
    const mctx = _mmTileCv.getContext('2d');
    mctx.clearRect(0, 0, bufPx, bufPx);
    mctx.fillStyle = th.mmFloor;
    mctx.beginPath();
    const bufTx0 = _mmTileFx - _MM_MARGIN, bufTy0 = _mmTileFy - _MM_MARGIN;
    const tx0 = Math.max(0, bufTx0), tx1 = Math.min(dungeon.w - 1, bufTx0 + bufTiles - 1);
    const ty0 = Math.max(0, bufTy0), ty1 = Math.min(dungeon.h - 1, bufTy0 + bufTiles - 1);
    for (let ty = ty0; ty <= ty1; ty++) {
      const row = dungeon.grid[ty];
      for (let tx = tx0; tx <= tx1; tx++) {
        if (row[tx] === WALL) continue;
        mctx.rect((tx - bufTx0) * mmSc, (ty - bufTy0) * mmSc, Math.max(1, Math.ceil(mmSc)), Math.max(1, Math.ceil(mmSc)));
      }
    }
    mctx.fill();
  }
  const _mmBlitX = mmX - (winTx - (_mmTileCvTx - _MM_MARGIN)) * mmSc;
  const _mmBlitY = mmY - (winTy - (_mmTileCvTy - _MM_MARGIN)) * mmSc;
  ctx.drawImage(_mmTileCv, _mmBlitX, _mmBlitY);

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
  const _hudLbl = _hudRoom?.monsterLvl ? (t('levelAbbrev') + _hudRoom.monsterLvl) : t('hallShort');
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
  ctx.fillText(t('levelAbbrev') + p.lvl, infoRight, 15);

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
  ctx.fillText(t('bmAbbrev'), stxH, 24);
  const _bmLabelW = ctx.measureText(t('bmAbbrev')).width;
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
    const _nxImg = _nexumIconImg || (_nexumIconImg = (() => { const i = new Image(); i.src = '/images/nexum-coin_v2.png'; return i; })());
    if (_nxImg.complete && _nxImg.naturalWidth > 0) {
      ctx.drawImage(_nxImg, stxH, 24 - 6, 12, 12);
    } else {
      ctx.fillStyle = '#b2864d'; ctx.font = `bold 9px ${F}`;
      ctx.fillText('N', stxH + 2, 24);
    }
    ctx.font = `bold 10px ${F}`; ctx.textAlign = 'left'; ctx.fillStyle = '#b2864d';
    ctx.fillText(_nxBal, stxH + 14, 24);
    stxH += 14 + ctx.measureText(String(_nxBal)).width + 8;
  }
  // GRAM balance (tiny per-kill drop currency, see enemyKilled's 'gram' field)
  const _grBal = window._gramBalance || 0;
  const _grImg = _gramIconImg || (_gramIconImg = (() => { const i = new Image(); i.src = '/images/gram-icon.png'; return i; })());
  if (_grImg.complete && _grImg.naturalWidth > 0) {
    ctx.drawImage(_grImg, stxH, 24 - 6, 12, 12);
  } else {
    ctx.fillStyle = '#4fd67a'; ctx.font = `bold 9px ${F}`;
    ctx.fillText('G', stxH + 2, 24);
  }
  ctx.font = `bold 10px ${F}`; ctx.textAlign = 'left'; ctx.fillStyle = '#4fd67a';
  ctx.fillText(_grBal.toFixed(7), stxH + 14, 24);
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
  // Floor the XP readout: party kills split their reward (result.xp / members
  // on the server), so xp is legitimately fractional and float addition turns
  // that into "858.9999999999418" on the bar. The stored value keeps its
  // precision — only the display is whole.
  ctx.fillText(Math.floor(p.xp) + '/' + p.xpNext, xbX + xbW / 2, xpY);

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
    ctx.fillText(cd.toFixed(1) + t('secAbbrev'), pb.x, pb.y + pb.r + 10);
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
    chips.push({ kind:'pot', img: bdef.img, label: secs < 60 ? secs + t('secAbbrev') : Math.ceil(rem/60) + t('minAbbrev'), color:'#e5a546' });
  }

  // Skill buffs
  const skillBuffs = [
    { t: typeof barrierTimer     !== 'undefined' ? barrierTimer     : 0, icon:'barrier',   color:'#eec47c' },
    { t: typeof battleCryTimer   !== 'undefined' ? battleCryTimer   : 0, icon:'battleCry', color:'#e8a034' },
    { t: typeof atkSpeedTimer    !== 'undefined' ? atkSpeedTimer    : 0, icon:'lightning', color:'#bf9a6a' },
    { t: typeof faithShieldTimer !== 'undefined' ? faithShieldTimer : 0, icon:'shield',    color:'#ebad4e' },
    { t: typeof invisTimer       !== 'undefined' ? invisTimer       : 0, icon:'teleport',  color:'#f2d197' },
    { t: typeof dodgeTimer       !== 'undefined' ? dodgeTimer       : 0, icon:'dash',      color:'#98e456' },
    { t: typeof guardTimer       !== 'undefined' ? guardTimer       : 0, icon:'shield',    color:'#9aa3ab' },
    { t: typeof vampirismTimer   !== 'undefined' ? vampirismTimer   : 0, icon:'drop',      color:'#c23b5e' },
  ];
  for (const b of skillBuffs) {
    if (b.t > 0) chips.push({ kind:'icon', icon: b.icon, label: Math.ceil(b.t) + t('secAbbrev'), color: b.color });
  }

  // Debuffs
  if ((p.slowTimer   || 0) > 0) chips.push({ kind:'icon', icon:'wind',      label: Math.ceil(p.slowTimer)   + t('secAbbrev'), color:'#efc680', debuff:true });
  if ((p.stunTimer   || 0) > 0) chips.push({ kind:'icon', icon:'holyLight', label: Math.ceil(p.stunTimer)   + t('secAbbrev'), color:'#ebad4e', debuff:true });
  if ((p.freezeTimer || 0) > 0) chips.push({ kind:'icon', icon:'iceNova',   label: Math.ceil(p.freezeTimer) + t('secAbbrev'), color:'#ccaf88', debuff:true });
  // Death XP penalty — remaining seconds, same as any other player.buffs entry
  const _penaltyLeft = (p.buffs || {}).deathPenalty || 0;
  if (_penaltyLeft > 0) {
    const _pm = Math.ceil(_penaltyLeft / 60);
    chips.push({ kind:'icon', icon:'star', label: '−XP ' + _pm + t('minAbbrev'), color:'#c34d5b', debuff:true });
  }

  if (!chips.length) return;

  // 2-column icon grid to the left of the skill buttons panel
  // Skill grid: left = W-14-(SKILL_SZ+SKILL_GAP)-SKILL_SZ = W-130, bottom = H-NAV_H-14
  const SZ = 22, GAP = 3, COLS = 2;
  const skillLeft  = W - 14 - (SKILL_SZ + SKILL_GAP) - SKILL_SZ;  // W-130
  const gridRight  = skillLeft - 8;                                  // 8px gap from skills
  const gridX      = gridRight - (COLS * SZ + (COLS - 1) * GAP);   // left edge of chip area
  // Raised clear of the chat widgets rather than bottom-aligned with the
  // skills. #chat-btn and #chat-preview (index.html) sit at CSS bottom:72px
  // and stand up to ~46px tall, so they own the band from H-118 to H-72 —
  // and being DOM elements layered over the UI canvas, they paint over
  // anything drawn there regardless of draw order. The bottom row of chips
  // used to land at H-98..H-76, entirely inside that band, so an incoming
  // chat message hid it completely. Chips grow upward from here, so only
  // this baseline needs to move.
  const CHAT_STRIP_TOP = 72 + 46;   // keep in sync with #chat-btn/#chat-preview
  const gridBottom = H - CHAT_STRIP_TOP - 6;                         // 6px breathing room
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

  const pvpLabel = pvpMode ? t('pvpOnLabel') : t('pvpOffLabel');
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
  ctx.fillText(autoAttackMode ? t('autoModeAbbrev') : t('manualModeAbbrev'), ab.x + ab.w / 2, ab.y + ab.h / 2);
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
  ctx.fillText(t('partyInviteBtnLbl'), pb.x + 23, pb.y + pb.h / 2);

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
  ctx.fillText(t('partyLeaveBtnLbl'), lb.x + 22, lb.y + lb.h / 2);
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
  ctx.fillText(t('partyInviteTitle'), px + 34, py + 14);
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
  ctx.fillText(t('acceptBtn'), ac.x + ac.w / 2, ac.y + ac.h / 2);

  // Decline button
  const dc = getPartyDeclinePos();
  ctx.fillStyle = 'rgba(38,12,15,0.99)';
  roundRect(ctx, dc.x, dc.y, dc.w, dc.h, 8); ctx.fill();
  ctx.strokeStyle = 'rgba(190,60,75,0.8)'; ctx.lineWidth = 1.2;
  roundRect(ctx, dc.x, dc.y, dc.w, dc.h, 8); ctx.stroke();
  ctx.fillStyle = '#ef6d7c';
  ctx.fillText(t('declineBtn'), dc.x + dc.w / 2, dc.y + dc.h / 2);

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
    <button class="imod-enh-stone-btn${normQty > 0 ? '' : ' disabled'}" onclick="${actionFn}(${p},'norm')" title="${t('enhFailBurnHint')}">
      <img src="/images/norm.png" width="16" height="16" style="vertical-align:middle;image-rendering:pixelated;margin-right:4px">${tVars('normalStoneBtnFmt', { n: normQty })}
    </button>
    <button class="imod-enh-stone-btn imod-enh-stone-bless${blessQty > 0 ? '' : ' disabled'}" onclick="${actionFn}(${p},'bless')" title="${t('enhFailKeepHint')}">
      <img src="/images/bless.png" width="16" height="16" style="vertical-align:middle;image-rendering:pixelated;margin-right:4px">${tVars('safeStoneBtnFmt', { n: blessQty })}
    </button>
  </div>`;
}
const _RARITY_NAMES = { common:'Обычный', uncommon:'Необычный', rare:'Редкий', epic:'Эпический', legendary:'Легендарный' };
const _SLOT_NAMES   = { weapon:'Оружие', helmet:'Шлем', body:'Броня', gloves:'Перчатки', boots:'Боты', ring:'Кольцо', belt:'Пояс', pet:'Питомец', use:'Расходник', material:'Материал', recipe:'Рецепт', buff_potion:'Зелье усиления', box:'Бокс' };

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
          <div class="imod-sub"><span style="color:#e5a546">${_RARITY_NAMES[it.rarity]||it.rarity}</span> · ${t('buffPotionSlotName')} · ×${qty}</div>
        </div>
        <button class="npc-close" onclick="closeInvItemModal()" style="touch-action:manipulation">✕</button>
      </div>
      <div class="imod-stats">${it.buffDesc || ''}</div>
      ${active ? `<div style="padding:8px 12px;background:rgba(229,165,70,0.1);border-radius:8px;color:#e5a546;font-size:12px;text-align:center">${tVars('activeRemainingFmt', { n: remaining })}</div>` : ''}
      <div class="imod-btns">
        <button class="imod-btn imod-equip${active ? ' disabled' : ''}" onclick="${active ? '' : `useBuffPotion('${it.id}');closeInvItemModal()`}">
          ${active ? t('alreadyActiveLbl') : t('useBtn')}
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
  if (it.critChance) statRows.push(`${t('statCritInline')} <b>${(it.critChance*100).toFixed(0)}%</b>`);
  if (it.atkSpeed)   statRows.push(`${t('statSpeedInline')} <b>${(it.atkSpeed*100).toFixed(0)}%</b>`);
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
        <div class="imod-enh-title">${tVars('enhanceTitleFmt', { cur: enh > 0 ? '+' + enh : '0', next: '<span style="color:#e69419">+' + (enh+1) + '</span>' })}</div>
        ${nextParts.length ? `<div class="imod-enh-preview">${nextParts.join(' · ')}</div>` : ''}
        <div class="imod-enh-chance">${tVars('enhChanceFmt', { rate: `<b style="color:${rateColor}">${rate}</b>` })}</div>
        ${_enhStonesBlock('enhanceItem', idx)}
      </div>`
    : `<div class="imod-enh-block"><div class="imod-enh-title" style="color:#e69419">${t('maxEnhanceLbl')}</div></div>`;

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
      <button class="imod-btn imod-equip" onclick="equipFromModal(${idx})">${t('equipBtn')}</button>
      ${it.rarity === 'common' ? `<button class="imod-btn imod-sell" onclick="sellCommonItem(${idx})">${t('sellForFmt')}${iconHTML('coin',12,'#e3941d')}</button>` : ''}
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

const SELL_COMMON_PRICE = 100;
function sellCommonItem(idx) {
  if (!player) return;
  const it = player.inventory[idx];
  if (!it || it.rarity !== 'common') return;
  player.inventory.splice(idx, 1);
  player.gold += SELL_COMMON_PRICE;
  netSaveProgress();
  closeInvItemModal();
  dmgNum(player.x, player.y - 36, '+' + SELL_COMMON_PRICE + 'g', '#ff0');
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
        <div class="imod-sub"><span style="color:${rc}">${_RARITY_NAMES[boxDef.rarity] || boxDef.rarity}</span> · ${t('boxSlotName')} · ×${qty}</div>
      </div>
      <button class="npc-close" onclick="closeInvItemModal()" style="touch-action:manipulation">✕</button>
    </div>
    <div style="font-size:11px;color:#968a7a">${t('boxOpensRandomHint')}</div>
    <div class="box-odds-list">${oddsHtml}</div>
    <div class="imod-btns">
      <button class="imod-btn imod-equip" onclick="openLootBox(${idx})">${t('openBtn')}</button>
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
  if (!invHasSpace()) { dmgNum(player.x, player.y - 30, t('invFull'), '#f17e8b'); return; }

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
  if (stoneIdx < 0) { dmgNum(player.x, player.y - 30, t('noStoneToast'), '#f17e8b'); return; }

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
    dmgNum(player.x, player.y - 30, tVars('enhSuccessToast', { n: it.enhance }), '#e69419');
    openInvItemModal(idx);
  } else if (stoneType === 'bless') {
    recompute(); netSaveProgress();
    dmgNum(player.x, player.y - 30, t('enhFailedToast'), '#f17e8b');
    openInvItemModal(idx);
  } else {
    player.inventory.splice(idx, 1);
    recompute(); netSaveProgress();
    closeInvItemModal();
    dmgNum(player.x, player.y - 30, t('itemBurnedToast'), '#eb4e61');
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
  if (it.critChance) statRows.push(`${t('statCritInline')} <b>${(it.critChance*100).toFixed(0)}%</b>`);
  if (it.atkSpeed)   statRows.push(`${t('statSpeedInline')} <b>${(it.atkSpeed*100).toFixed(0)}%</b>`);
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
        <div class="imod-enh-title">${tVars('enhanceTitleFmt', { cur: enh > 0 ? '+' + enh : '0', next: '<span style="color:#e69419">+' + (enh+1) + '</span>' })}</div>
        ${nextParts.length ? `<div class="imod-enh-preview">${nextParts.join(' · ')}</div>` : ''}
        <div class="imod-enh-chance">${tVars('enhChanceFmt', { rate: `<b style="color:${rateColor2}">${rate2}</b>` })}</div>
        ${_enhStonesBlock('enhanceEqItem', slot)}
      </div>`
    : `<div class="imod-enh-block"><div class="imod-enh-title" style="color:#e69419">${t('maxEnhanceLbl')}</div></div>`;

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
        <div class="imod-sub"><span style="color:${rc}">${_RARITY_NAMES[it.rarity]||it.rarity}</span> · ${_SLOT_NAMES[it.slot]||it.slot} · <span style="color:#eec276">${t('equippedLbl')}</span></div>
      </div>
      <button class="npc-close" onclick="closeInvItemModal()" style="touch-action:manipulation">✕</button>
    </div>
    <div class="imod-stats">${statRows.join('<br>') || '—'}</div>
    ${enhBlock}
    <div class="imod-btns">
      <button class="imod-btn imod-equip" style="background:linear-gradient(135deg,#381c1f,#672d34);color:#f28a96" onclick="unequipFromModal('${slot}')">${t('unequipBtn')}</button>
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
  if (stoneIdx < 0) { dmgNum(player.x, player.y - 30, t('noStoneToast'), '#f17e8b'); return; }

  const stoneItem = player.inventory[stoneIdx];
  if ((stoneItem.qty || 1) <= 1) { player.inventory.splice(stoneIdx, 1); }
  else { stoneItem.qty--; }

  const success = Math.random() * 100 < _enhSuccessRate(enh);
  if (success) {
    it.enhance = enh + 1;
    recompute(); netSaveProgress();
    dmgNum(player.x, player.y - 30, tVars('enhSuccessToast', { n: it.enhance }), '#e69419');
    openEqItemModal(slot);
  } else if (stoneType === 'bless') {
    recompute(); netSaveProgress();
    dmgNum(player.x, player.y - 30, t('enhFailedToast'), '#f17e8b');
    openEqItemModal(slot);
  } else {
    player.equipment[slot] = null;
    recompute(); netSaveProgress();
    closeInvItemModal();
    dmgNum(player.x, player.y - 30, t('itemBurnedToast'), '#eb4e61');
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
    if (typeof dmgNum === 'function') dmgNum(player.x, player.y - 38, tVars('ratingUnlockToast', { n: FEATURE_UNLOCK_LEVEL }), '#eaa742');
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
    el.innerHTML = `<div class="rating-loading">${t('questLoading')}</div>`;
    return;
  }
  if (!rows.length) {
    el.innerHTML = `<div class="rating-empty">${t('noDataLbl')}</div>`;
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
          <div class="rating-name">@${r.username}${isMe ? ` <span style="font-size:10px;color:#ebaa49;opacity:.7">${t('youMarker')}</span>` : ''}</div>
          <div class="rating-sub">${t('levelAbbrev')} ${r.level || 1}</div>
        </div>
        <div class="rating-bm">
          <div class="rating-bm-val">${(r.bm || 0).toLocaleString()}</div>
          <div class="rating-bm-lbl">${t('bmAbbrev')}</div>
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
          <div class="rating-sub">${tVars('membersAbbrevFmt', { n: r.memberCount })}</div>
        </div>
        <div class="rating-bm">
          <div class="rating-bm-val">${(r.totalBm || 0).toLocaleString()}</div>
          <div class="rating-bm-lbl">${t('bmAbbrev')}</div>
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

// VIP_THRESHOLDS[lvl] is only the GRAM delta for that one level-up (the
// server's deposit counter rolls over — resets to the remainder — after
// each level, see server/index.js), which reads as "starting over from
// scratch" every level. This is the running TOTAL a player must have
// deposited overall (since VIP 0) to be at each level, for the "how much
// do I need in total" answer the per-level number alone doesn't give.
function _vipCumulative(thresholds) {
  const out = [0];
  for (let i = 1; i < thresholds.length; i++) out.push(out[i - 1] + thresholds[i]);
  return out;
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
  const cumulative= _vipCumulative(thresholds);
  const bon       = bonuses ? (bonuses[level] || bonuses[0]) : { xp:0, gold:0, drop:0 };

  let progressHtml = '';
  if (level < 10) {
    const needed = thresholds[level + 1] || 1;
    const pct    = Math.min(100, (deposited / needed) * 100).toFixed(1);
    progressHtml = `
      <div class="vip-progress-wrap">
        <div class="vip-progress-label">
          <span>${tVars('vipNextFmt', { lvl: level + 1, total: cumulative[level + 1] })}</span>
          <span>${deposited.toFixed ? deposited.toFixed(2) : deposited} / ${needed} GRAM</span>
        </div>
        <div class="vip-progress-bar"><div class="vip-progress-fill" style="width:${pct}%"></div></div>
      </div>`;
  } else {
    progressHtml = `<div class="vip-max-badge">${t('vipMaxBadge')}</div>`;
  }

  el.innerHTML = `
    <div class="vip-level-badge">VIP ${level}</div>
    ${progressHtml}
    <div class="vip-bonuses">
      <div class="vip-bonus-item ${bon.xp   > 0 ? '' : 'vip-bonus-dim'}">⚡ +${bon.xp}% XP</div>
      <div class="vip-bonus-item ${bon.gold > 0 ? '' : 'vip-bonus-dim'}">💰 +${bon.gold}% ${t('vipGoldLbl')}</div>
      <div class="vip-bonus-item ${bon.drop > 0 ? '' : 'vip-bonus-dim'}">🎁 +${bon.drop}% ${t('vipDropLbl')}</div>
    </div>
    <div class="vip-section-title">${t('vipLevelsHdr')}</div>
    <div class="vip-levels">${_renderVipLevels(level, pending, bonuses, cumulative)}</div>
  `;
}

function _renderVipLevels(curLevel, pending, bonuses, cumulative) {
  let html = '';
  for (let lvl = 1; lvl <= 10; lvl++) {
    const b         = bonuses ? (bonuses[lvl] || { xp:0, gold:0, drop:0 }) : { xp:0, gold:0, drop:0 };
    const isPending = pending.includes(lvl);
    const isDone    = curLevel >= lvl && !isPending;
    const cls       = isPending ? 'vip-card vip-card-pending' : isDone ? 'vip-card vip-card-done' : 'vip-card vip-card-locked';
    const badge     = isPending ? '🎁' : isDone ? '✓' : lvl;
    const bonHtml   = [
      b.xp   > 0 ? `<span>+${b.xp}% XP</span>`     : '',
      b.gold > 0 ? `<span>+${b.gold}% ${t('vipGoldLbl')}</span>` : '',
      b.drop > 0 ? `<span>+${b.drop}% ${t('vipDropLbl')}</span>`   : '',
    ].join('');
    html += `
      <div class="${cls}">
        <div class="vip-card-head">
          <div class="vip-card-badge">${badge}</div>
          <div class="vip-card-title">VIP ${lvl}</div>
          <div class="vip-card-gram">${cumulative[lvl]} GRAM</div>
        </div>
        ${bonHtml ? `<div class="vip-card-bonuses">${bonHtml}</div>` : ''}
        ${_vipItemDesc(lvl)}
        ${isPending ? `<button class="vip-claim-btn" onclick="netClaimVipRewards()">${t('vipClaimBtn')}</button>` : ''}
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
  function boxU(qty)  { return ri('/images/material/boxu.png', `×${qty}`, 'uncommon'); }
  function boxR(qty)  { return ri('/images/material/boxr.png', `×${qty}`, 'rare'); }
  function gold(amt)  {
    const uri = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23f1c40f' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='9'/><path d='M12 7v10'/><path d='M15 9.5a3 3 0 0 0-6 0c0 1.5 1 2.2 3 3 2 .8 3 1.5 3 3a3 3 0 0 1-6 0'/></svg>`;
    return ri(uri, `${(amt/1000).toFixed(0)}${t('vipGoldShortSuffix')}`, 'gold');
  }
  function pots(qty) {
    return ['hp','exp','gold','regen','atkspeed','atk']
      .map(p => ri(`/images/potion/${p}.png`, `×${qty}`, '')).join('');
  }

  const rows = {
    2:  boxU(3),
    3:  bless(2) + boxU(5),
    4:  bless(5) + pots(10) + boxR(2) + boxU(3),
    5:  bless(7) + pots(10) + boxR(5),
    6:  wep('uncommon', 8) + bless(7) + pots(10) + boxR(10),
    7:  wep('rare', 8) + norm(20) + bless(10) + gold(10000) + boxR(15),
    8:  wep('epic', 1) + pots(50) + norm(50) + bless(30) + gold(20000) + boxR(20),
    9:  wep('epic', 8) + pots(80) + norm(70) + bless(30) + boxR(25),
    10: wep('legendary', 0) + pots(100) + norm(100) + bless(100) + boxR(30),
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
// Per-category floors — mirrors _marketMinPrice (server/index.js) exactly;
// display/pre-check only, the server is the real authority. Keys/recipes/
// stones are per unit (scaled by however many are in this listing), rare
// gear is a flat per-listing floor.
function _marketMinPriceFor(it, qty) {
  if (!it) return MARKET_MIN_PRICE;
  const n = qty || it.qty || 1;
  if (it.id === 'norm_stone') return 0.40 * n;
  if (it.id === 'bless_stone') return 1.5 * n;
  if (it.id && it.id.startsWith('key_')) return 0.01 * n;
  if (it.slot === 'recipe') return 0.01 * n;
  if (it.slot === 'box') return 2 * n;
  if (it.rarity === 'rare' && typeof ENHANCEABLE_SLOTS !== 'undefined' && ENHANCEABLE_SLOTS.has(it.slot) && it.slot !== 'pet') return 5;
  return MARKET_MIN_PRICE;
}

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

// ─────────────────────────────────────────────────────────
//  EVENTS (События) — Битва + Мировой босс
// ─────────────────────────────────────────────────────────
// One entry point for both scheduled events; each is a tab inside the panel.
// The server owns both schedules (shared/definitions.js DEATH_BATTLE_*/
// WORLD_BOSS_*) and pushes their state, so everything here just renders what
// arrived and counts the seconds down locally.
function _positionEventsBtn() {
  const shopBtn = document.getElementById('gram-shop-btn');
  const btn     = document.getElementById('events-btn');
  if (!btn || !shopBtn) return;
  const sTop = parseFloat(shopBtn.style.top) || 0;
  btn.style.top       = (sTop + 28 + 4) + 'px';
  btn.style.left      = shopBtn.style.left;
  btn.style.width     = shopBtn.style.width;
  btn.style.right     = 'auto';
  btn.style.transform = 'none';
}

function showEventsBtn() {
  const btn = document.getElementById('events-btn');
  if (btn) { btn.dataset.shown = '1'; btn.style.display = (activeTab === 0) ? 'flex' : 'none'; _positionEventsBtn(); }
}

function _fmtBossTime(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60), r = s % 60;
  return m + ':' + String(r).padStart(2, '0');
}

// Countdowns longer than an hour ("следующая битва в четверг") read as
// nonsense in m:ss, so anything past 60 minutes is shown as д/ч/м instead.
function _fmtEventEta(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 3600) return _fmtBossTime(ms);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}д ${h}ч` : `${h}ч ${m}м`;
}

// Weekday + time of the next occurrence, so the panel says when it is rather
// than only how long is left.
function _fmtEventWhen(at) {
  if (!at) return '';
  const d = new Date(at);
  const days = t('eventWeekdays').split(',');
  return `${days[d.getDay()]}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

let _eventTab = 'battle';

function openEventsPanel() {
  const panel = document.getElementById('events-panel');
  if (!panel) return;
  panel.style.display = 'flex';
  if (typeof netDeathBattleSync === 'function') netDeathBattleSync();
  if (typeof netArena3Sync === 'function') netArena3Sync();
  if (typeof netRace10Sync === 'function') netRace10Sync();
  _renderEventsBody();
}

function closeEventsPanel() {
  const panel = document.getElementById('events-panel');
  if (panel) panel.style.display = 'none';
}

function switchEventTab(tab) {
  _eventTab = tab;
  document.querySelectorAll('#events-panel .rating-tab').forEach(b => b.classList.remove('active'));
  document.getElementById('etab-' + tab)?.classList.add('active');
  _renderEventsBody();
}

function _eventsPanelOpen() {
  return document.getElementById('events-panel')?.style.display === 'flex';
}

function _renderEventsBody() {
  const body = document.getElementById('events-panel-body');
  if (!body) return;
  body.innerHTML = _eventTab === 'boss'    ? _worldBossBodyHTML()
                 : _eventTab === 'a3'      ? _arena3BodyHTML()
                 : _eventTab === 'race10'  ? _race10BodyHTML()
                 : _deathBattleBodyHTML();
}

// ── 3v3 arena tab ───────────────────────────────────────────────────────────
// Queue-driven, so there is no countdown to show — the headline number is how
// many of the six are waiting. Everything here comes from _a3State, pushed by
// the server (see _initArena3Handlers in js/network.js).
function _arena3BodyHTML() {
  const st = (typeof _a3State !== 'undefined' && _a3State) || { queued: 0, needed: 6, minLevel: 15, reward: 10 };
  const inMatch = typeof _a3InMatch !== 'undefined' && _a3InMatch;
  const lvl = (player && player.lvl) || 1;
  const tooLow = lvl < (st.minLevel || 15);

  // null means the panel hasn't synced yet — don't lock the button on a count
  // we haven't actually been told.
  const spent = st.attemptsLeft !== null && st.attemptsLeft !== undefined && st.attemptsLeft <= 0;

  let phaseTxt, action;
  if (inMatch) {
    phaseTxt = t('a3PhaseFighting');
    action = `<button class="db-action" disabled>${t('a3PhaseFighting')}</button>`;
  } else if (tooLow) {
    phaseTxt = tVars('a3NeedLevelFmt', { n: st.minLevel });
    action = `<button class="db-action disabled" disabled>${tVars('a3NeedLevelFmt', { n: st.minLevel })}</button>`;
  } else if (spent && !_a3Registered) {
    phaseTxt = t('a3NoAttempts');
    action = `<button class="db-action disabled" disabled>${t('a3NoAttempts')}</button>`;
  } else if (_a3Registered) {
    phaseTxt = t('a3PhaseQueued');
    action = `<button class="db-action db-leave" onclick="netArena3Unregister()">${t('dbLeaveBtn')}</button>`;
  } else {
    phaseTxt = t('a3PhaseIdle');
    action = `<button class="db-action" onclick="netArena3Register()">${t('dbJoinBtn')}</button>`;
  }

  const score = inMatch
    ? `<div class="db-count">${tVars('a3ScoreFmt', { a: _a3Score.a, b: _a3Score.b })}</div>`
    : (st.attemptsLeft !== null && st.attemptsLeft !== undefined
        ? `<div class="db-count">${tVars('a3AttemptsFmt', { n: st.attemptsLeft, max: st.maxAttempts })}</div>` : '');

  return `
    <div style="padding:16px">
      <div class="db-countdown">${st.queued}/${st.needed}</div>
      <div class="db-phase">${phaseTxt}</div>
      ${score}
      ${action}
      <div class="db-rules">
        ${t('dbRulesHdr')}
        <ul>
          <li>${tVars('a3Rule1', { n: st.needed })}</li>
          <li>${t('a3Rule2')}</li>
          <li>${t('a3Rule3')}</li>
          <li>${t('a3Rule4')}</li>
          <li>${t('a3RuleBoss')}</li>
          <li>${t('a3RuleDuration')}</li>
          <li>${tVars('a3Rule5', { n: st.minLevel })}</li>
          <li>${tVars('a3Rule6', { n: st.maxAttempts })}</li>
        </ul>
      </div>
      <div class="db-rewards-hdr">${t('a3RewardHdr')}</div>
      <div class="db-rewards">
        <div class="db-reward-row">
          <img src="/images/nexum-coin_v2.png" alt="">
          <span>Liberty</span><span class="db-reward-qty">+${st.reward}</span>
        </div>
      </div>
    </div>`;
}

// ── Кровавая Башня tab (10-player corridor race) ────────────────────────────
// Open every day 20:00–21:00 MSK (see _race10Schedule, server/index.js) —
// same reg/idle phase shape as _deathBattleBodyHTML above, plus the queue
// count and team-less damage race once the window is open.
function _race10BodyHTML() {
  const st = (typeof _race10State !== 'undefined' && _race10State) || { phase: 'idle', nextAt: 0, queued: 0, needed: 10, minLevel: 10, reward: 10 };
  const inMatch = typeof _race10InMatch !== 'undefined' && _race10InMatch;
  const open = st.phase === 'reg';
  const lvl = (player && player.lvl) || 1;
  const tooLow = lvl < (st.minLevel || 10);
  const spent = st.attemptsLeft !== null && st.attemptsLeft !== undefined && st.attemptsLeft <= 0;

  let phaseTxt, action;
  if (inMatch) {
    phaseTxt = t('race10PhaseFighting');
    action = `<button class="db-action" disabled>${t('race10PhaseFighting')}</button>`;
  } else if (!open) {
    phaseTxt = t('race10PhaseIdle');
    action = `<button class="db-action" disabled>${t('dbClosedBtn')}</button>`;
  } else if (tooLow) {
    phaseTxt = tVars('a3NeedLevelFmt', { n: st.minLevel });
    action = `<button class="db-action disabled" disabled>${tVars('a3NeedLevelFmt', { n: st.minLevel })}</button>`;
  } else if (spent && !_race10Registered) {
    phaseTxt = t('a3NoAttempts');
    action = `<button class="db-action disabled" disabled>${t('a3NoAttempts')}</button>`;
  } else if (_race10Registered) {
    phaseTxt = t('a3PhaseQueued');
    action = `<button class="db-action db-leave" onclick="netRace10Unregister()">${t('dbLeaveBtn')}</button>`;
  } else {
    phaseTxt = t('a3PhaseIdle');
    action = `<button class="db-action" onclick="netRace10Register()">${t('dbJoinBtn')}</button>`;
  }

  // Idle counts down to the next daily window (can be many hours away), open/
  // in-match stay on a plain queue count or the live damage race.
  const countdown = !open && !inMatch ? _fmtEventEta(Math.max(0, (st.nextAt || 0) - Date.now())) : `${st.queued}/${st.needed}`;
  const score = inMatch
    ? `<div class="db-count">${tVars('race10ScoreFmt', { dmg: Math.floor(_race10MyDamage || 0), rank: _race10Rank || 0, total: _race10Total || 0 })}</div>`
    : open && st.attemptsLeft !== null && st.attemptsLeft !== undefined
        ? `<div class="db-count">${tVars('a3AttemptsFmt', { n: st.attemptsLeft, max: st.maxAttempts })}</div>`
        : (!open && st.nextAt ? `<div class="db-count">${_fmtEventWhen(st.nextAt)}</div>` : '');

  return `
    <div style="padding:16px">
      <div class="db-countdown">${countdown}</div>
      <div class="db-phase">${phaseTxt}</div>
      ${score}
      ${action}
      <div class="db-rules">
        ${t('dbRulesHdr')}
        <ul>
          <li>${t('race10Rule6')}</li>
          <li>${tVars('race10Rule1', { n: st.needed })}</li>
          <li>${t('race10Rule2')}</li>
          <li>${t('race10Rule3')}</li>
          <li>${t('race10Rule4')}</li>
          <li>${t('race10Rule5')}</li>
          <li>${tVars('a3Rule5', { n: st.minLevel })}</li>
          <li>${tVars('a3Rule6', { n: st.maxAttempts })}</li>
        </ul>
      </div>
      <div class="db-rewards-hdr">${t('race10RewardHdr')}</div>
      <div class="db-rewards">
        <div class="db-reward-row">
          <img src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23e3941d' stroke='%23e3941d' stroke-width='1' stroke-linejoin='round'><polygon points='12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26'/></svg>" alt="">
          <span>${t('race10XpRewardName')}</span><span class="db-reward-qty">×4</span>
        </div>
        <div class="db-reward-row">
          <img src="/images/nexum-coin_v2.png" alt="">
          <span>Liberty</span><span class="db-reward-qty">+${st.reward}</span>
        </div>
      </div>
    </div>`;
}

// Called from the network handlers on every server push.
function onRace10State() {
  _updateEventsBtnHighlight();
  if (_eventsPanelOpen() && _eventTab === 'race10') _renderEventsBody();
}

// Live damage-race feedback while the fight is on — rank/total aren't
// persisted in _race10State (they only make sense mid-fight), just enough
// module state to redraw the panel between pushes.
let _race10Rank = 0, _race10Total = 0;
function onRace10Score(rank, total) {
  _race10Rank = rank; _race10Total = total;
  if (_eventsPanelOpen() && _eventTab === 'race10') _renderEventsBody();
}

function showRace10Result(won, winnerName, myDamage, timedOut, reward) {
  const modal = document.getElementById('race10-result-modal');
  if (!modal) return;
  const title = won ? t('race10Victory') : (timedOut ? t('a3NoResult') : t('race10Defeat'));
  document.getElementById('race10-result-icon').textContent = won ? '👑' : (timedOut ? '⏳' : '💀');
  document.getElementById('race10-result-title').textContent = title;
  document.getElementById('race10-result-title').style.color = won ? '#ffd18a' : '#f07886';
  document.getElementById('race10-result-sub').textContent = won
    ? t('race10VictorySub')
    : (timedOut ? t('race10NoResultSub') : tVars('race10DefeatSub', { name: winnerName || '?', dmg: Math.floor(myDamage || 0) }));
  document.getElementById('race10-result-rewards').innerHTML = reward
    ? `<div class="db-reward-row"><img src="/images/nexum-coin_v2.png" alt="">
       <span>Liberty</span><span class="db-reward-qty">+${reward}</span></div>`
    : '';
  modal.style.display = 'flex';
}

function closeRace10Result() {
  const modal = document.getElementById('race10-result-modal');
  if (modal) modal.style.display = 'none';
  // Same reasoning as closeArena3Result: server already moved this player
  // back to the hub safe zone when the race ended, this just makes the
  // client catch up visually.
  if (typeof netRace10Return === 'function') netRace10Return();
}

// Called from the network handlers on every server push.
function onArena3State() {
  if (_eventsPanelOpen() && _eventTab === 'a3') _renderEventsBody();
}

function showArena3Result(won, wedged, reward) {
  const modal = document.getElementById('a3-result-modal');
  if (!modal) return;
  document.getElementById('a3-result-icon').textContent  = won ? '👑' : (wedged ? '⏳' : '💀');
  document.getElementById('a3-result-title').textContent = won ? t('a3Victory') : (wedged ? t('a3NoResult') : t('a3Defeat'));
  document.getElementById('a3-result-title').style.color = won ? '#ffd18a' : '#f07886';
  document.getElementById('a3-result-sub').textContent   = won ? t('a3VictorySub') : (wedged ? t('a3NoResultSub') : t('a3DefeatSub'));
  document.getElementById('a3-result-rewards').innerHTML = reward
    ? `<div class="db-reward-row"><img src="/images/nexum-coin_v2.png" alt="">
       <span>Liberty</span><span class="db-reward-qty">+${reward}</span></div>`
    : '';
  modal.style.display = 'flex';
}

function closeArena3Result() {
  const modal = document.getElementById('a3-result-modal');
  if (modal) modal.style.display = 'none';
  // Server already moved this player back to the hub spawn (a safe zone) the
  // moment the match ended — this just makes the client catch up visually
  // instead of leaving them rendered wherever the arena left them.
  if (typeof netArena3Return === 'function') netArena3Return();
}

// ── 3v3 match countdown ──────────────────────────────────────────────────────
// A small on-screen clock for the round's 3-minute duration (ARENA3_ROUND_MS,
// server/index.js), shown from the moment the pre-fight freeze ends until the
// match's result modal appears. Built lazily, same pattern as _dbFreezeEl above.
let _a3TimerTick = null;
function _a3TimerEl() {
  let el = document.getElementById('a3-match-timer');
  if (!el) {
    el = document.createElement('div');
    el.id = 'a3-match-timer';
    document.body.appendChild(el);
  }
  return el;
}
function showArena3Timer(endAt) {
  if (!endAt) return;
  const el = _a3TimerEl();
  clearInterval(_a3TimerTick);
  const paint = () => {
    const msLeft = Math.max(0, endAt - Date.now());
    const s = Math.ceil(msLeft / 1000);
    el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    el.style.display = 'block';
    if (msLeft <= 0) clearInterval(_a3TimerTick);
  };
  paint();
  _a3TimerTick = setInterval(paint, 250);
}
function hideArena3Timer() {
  clearInterval(_a3TimerTick);
  _a3TimerTick = null;
  const el = document.getElementById('a3-match-timer');
  if (el) el.style.display = 'none';
}

// World boss: alive right now, mid-summon countdown, or waiting for its next
// scheduled appearance. _evtBossState is filled from gameStart and the
// eventBoss* pushes (see network.js).
function _worldBossBodyHTML() {
  const st = (typeof _evtBossState !== 'undefined' && _evtBossState) || {};
  const alive   = !!(typeof _evtBossAlive !== 'undefined' ? _evtBossAlive : st.alive);
  const summonAt = st.spawnAt || 0;
  const pending = summonAt > Date.now();

  let phaseTxt, timeTxt, note;
  if (alive) {
    phaseTxt = t('wbPhaseAlive');
    timeTxt  = '⚔';
    note     = t('wbNoteAlive');
  } else if (pending) {
    phaseTxt = t('wbPhaseSummon');
    timeTxt  = _fmtBossTime(summonAt - Date.now());
    note     = t('wbNoteSummon');
  } else {
    phaseTxt = t('wbPhaseIdle');
    timeTxt  = st.nextAt ? _fmtEventEta(st.nextAt - Date.now()) : '—';
    note     = st.nextAt ? _fmtEventWhen(st.nextAt) : '';
  }

  return `
    <div style="padding:16px">
      <div class="db-countdown">${timeTxt}</div>
      <div class="db-phase">${phaseTxt}</div>
      ${note ? `<div class="db-count">${note}</div>` : ''}
      <div class="db-rules">
        ${t('wbScheduleHdr')}
        <ul>
          <li>${t('wbRule1')}</li>
          <li>${t('wbRule2')}</li>
          <li>${t('wbRule3')}</li>
        </ul>
      </div>
    </div>`;
}

// ─────────────────────────────────────────────────────────
//  DEATH BATTLE (Битва на смерть)
// ─────────────────────────────────────────────────────────
// Scheduled free-for-all (shared/definitions.js DEATH_BATTLE_*). The server
// drives every transition and pushes them as deathBattleState; this panel just
// renders whatever _dbState currently says and counts the seconds down locally
// so an open panel stays live without extra traffic.
// Called from the network handlers on every server push — keeps the Events
// button's highlight and (if open) the panel in step with the round.
// Shared by the death battle and race10 (Кровавая Башня) pushes — either
// one's registration window opening should highlight the Events button, and
// whichever closes last shouldn't clobber the other's still-open state.
function _updateEventsBtnHighlight() {
  const btn = document.getElementById('events-btn');
  if (!btn) return;
  const dbOpen = typeof _dbState !== 'undefined' && _dbState.phase === 'reg';
  const raceOpen = typeof _race10State !== 'undefined' && _race10State.phase === 'reg';
  const open = dbOpen || raceOpen;
  btn.classList.toggle('db-open', open);
  const label = document.getElementById('events-btn-text');
  if (label) label.textContent = open ? t('dbBtnOpen') : t('eventsBtn');
}

function onDeathBattleState() {
  _updateEventsBtnHighlight();
  if (_eventsPanelOpen() && _eventTab === 'battle') _renderEventsBody();
}

function _deathBattleBodyHTML() {
  const st = (typeof _dbState !== 'undefined' && _dbState) || { phase: 'idle', nextAt: 0, startAt: 0, count: 0 };
  const reg  = st.phase === 'reg';
  const live = st.phase === 'live';
  const target = reg ? st.startAt : st.nextAt;
  const left = Math.max(0, (target || 0) - Date.now());

  let phaseTxt, countTxt, action;
  if (live) {
    phaseTxt = t('dbPhaseLive');
    countTxt = tVars('dbAliveFmt', { n: st.count });
    action = `<button class="db-action" disabled>${t('dbPhaseLive')}</button>`;
  } else if (reg) {
    phaseTxt = t('dbPhaseReg');
    countTxt = tVars('dbSignedUpFmt', { n: st.count });
    action = _dbRegistered
      ? `<button class="db-action db-leave" onclick="netDeathBattleUnregister()">${t('dbLeaveBtn')}</button>`
      : `<button class="db-action" onclick="netDeathBattleRegister()">${t('dbJoinBtn')}</button>`;
  } else {
    phaseTxt = t('dbPhaseIdle');
    countTxt = '';
    action = `<button class="db-action" disabled>${t('dbClosedBtn')}</button>`;
  }

  // Idle counts down to a start that can be days away (вт/чт/сб), so it gets
  // the long-form ETA and the weekday; a live round stays on m:ss.
  const timeTxt = (reg || live) ? _fmtBossTime(left) : _fmtEventEta(left);
  const whenTxt = (!reg && !live && st.nextAt) ? _fmtEventWhen(st.nextAt) : countTxt;

  return `
    <div style="padding:16px">
      <div class="db-countdown">${timeTxt}</div>
      <div class="db-phase">${phaseTxt}</div>
      ${whenTxt ? `<div class="db-count">${whenTxt}</div>` : ''}
      ${action}
      <div class="db-rules">
        ${t('dbRulesHdr')}
        <ul>
          <li>${t('dbRule1')}</li>
          <li>${t('dbRule2')}</li>
          <li>${t('dbRule3')}</li>
          <li>${t('dbRule5')}</li>
          <li>${t('dbRule4')}</li>
        </ul>
      </div>
      <div class="db-rewards-hdr">${t('dbRewardsHdr')}</div>
      <div class="db-rewards">${_dbRewardRows()}</div>
    </div>`;
}

// One row per prize, shared by the panel's "what you can win" list and the
// winner's modal so the two can't drift apart. Called with no arguments it
// reads the canonical prize list straight out of shared/definitions.js, which
// is the same function the server grants from.
function _dbRewardRows(gram, items) {
  const g = gram !== undefined ? gram
    : (typeof DEATH_BATTLE_GRAM_REWARD !== 'undefined' ? DEATH_BATTLE_GRAM_REWARD : 0);
  const list = items || (typeof deathBattleRewards === 'function' ? deathBattleRewards() : []);
  const rows = [];
  if (g) {
    rows.push(`<div class="db-reward-row">
      <img src="/images/gram-icon.png" alt="">
      <span>GRAM</span><span class="db-reward-qty">+${g}</span></div>`);
  }
  list.forEach(it => {
    // Items carry their own inventory icon; the emoji is only a stand-in for a
    // prize that somehow has no art rather than a broken image.
    const icon = it.img ? `<img src="${it.img}" alt="">` : '<span class="db-reward-fallback">🎁</span>';
    rows.push(`<div class="db-reward-row">
      ${icon}<span>${it.name || it.id}</span><span class="db-reward-qty">×${it.qty || 1}</span></div>`);
  });
  return rows.join('');
}

// One ticker for the whole Events panel — both tabs count down, and only the
// visible one is rendered.
if (typeof setInterval === 'function') {
  setInterval(() => { if (_eventsPanelOpen()) _renderEventsBody(); }, 1000);
}

// Victory modal. The prize is already granted server-side by the time this
// shows; closing it is what sends the winner back to the hub.
function showDeathBattleWin(gram, items) {
  const modal = document.getElementById('db-win-modal');
  const list  = document.getElementById('db-win-rewards');
  if (!modal || !list) return;
  list.innerHTML = _dbRewardRows(gram, items || []);
  modal.style.display = 'flex';
}

// Pre-fight countdown overlay. Everyone is standing on their start point,
// frozen, until this hits zero — big and centred so it's unmissable, and
// pointer-events:none so it can't swallow a joystick touch the instant the
// freeze lifts. Built lazily like the event-boss banner.
let _dbFreezeTick = null;
function _dbFreezeEl() {
  let el = document.getElementById('db-freeze');
  if (!el) {
    el = document.createElement('div');
    el.id = 'db-freeze';
    el.innerHTML = '<div class="db-freeze-num"></div><div class="db-freeze-lbl"></div>';
    document.body.appendChild(el);
  }
  return el;
}

function showDeathBattleFreeze(fightAt) {
  const el = _dbFreezeEl();
  const num = el.querySelector('.db-freeze-num');
  const lbl = el.querySelector('.db-freeze-lbl');
  lbl.textContent = t('dbFreezeLbl');
  clearInterval(_dbFreezeTick);
  const paint = () => {
    const left = Math.max(0, (fightAt || 0) - Date.now());
    if (left <= 0) { hideDeathBattleFreeze(); return; }
    num.textContent = Math.ceil(left / 1000);
    el.style.display = 'flex';
  };
  paint();
  _dbFreezeTick = setInterval(paint, 200);
}

function hideDeathBattleFreeze() {
  clearInterval(_dbFreezeTick);
  _dbFreezeTick = null;
  const el = document.getElementById('db-freeze');
  if (el) el.style.display = 'none';
}

function closeDeathBattleWin() {
  const modal = document.getElementById('db-win-modal');
  if (modal) modal.style.display = 'none';
  if (typeof netDeathBattleReturn === 'function') netDeathBattleReturn();
}

function openMarketPanel() {
  const panel = document.getElementById('market-panel');
  if (!panel) return;
  if (player && (player.lvl || 1) < FEATURE_UNLOCK_LEVEL) {
    if (typeof dmgNum === 'function') dmgNum(player.x, player.y - 38, tVars('marketUnlockToast', { n: FEATURE_UNLOCK_LEVEL }), '#eaa742');
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
    ? `<button class="market-buy-btn" onclick="openMarketBuyConfirm('${l.id}')">${t('buyBtn')}</button>`
    : `<button class="market-cancel-btn" onclick="marketCancelListing('${l.id}')">${t('cancelListingBtn')}</button>`;
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

// Market category filter — checked in order, first match wins, so more
// specific categories (books, which are craft-mat items with a book_ id)
// come ahead of their broader slot (material).
const _MARKET_CATEGORIES = [
  { key: 'weapon',    get label() { return t('catWeapon'); },    match: it => it.slot === 'weapon' },
  { key: 'helmet',    get label() { return t('catHelmet'); },    match: it => it.slot === 'helmet' },
  { key: 'body',      get label() { return t('catBody'); },      match: it => it.slot === 'body' },
  { key: 'gloves',    get label() { return t('catGloves'); },    match: it => it.slot === 'gloves' },
  { key: 'boots',     get label() { return t('catBoots'); },     match: it => it.slot === 'boots' },
  { key: 'ring',      get label() { return t('catRing'); },      match: it => it.slot === 'ring' },
  { key: 'belt',      get label() { return t('catBelt'); },      match: it => it.slot === 'belt' },
  { key: 'books',     get label() { return t('catBooks'); },     match: it => (it.id || '').startsWith('book_') },
  { key: 'potions',   get label() { return t('catPotions'); },   match: it => it.slot === 'use' || it.slot === 'buff_potion' },
  { key: 'materials', get label() { return t('catMaterials'); }, match: it => it.slot === 'material' || it.slot === 'recipe' },
  { key: 'other',     get label() { return t('catOther'); },     match: () => true },
];
let _marketCategoryFilter = 'all';

function _marketCategoryOf(it) {
  return (_MARKET_CATEGORIES.find(c => c.match(it)) || _MARKET_CATEGORIES[_MARKET_CATEGORIES.length - 1]).key;
}

function setMarketCategory(key) {
  _marketCategoryFilter = key;
  _renderMarketBody();
}

function _renderMarketFiltered(lots, mode) {
  const counts = new Map(_MARKET_CATEGORIES.map(c => [c.key, 0]));
  lots.forEach(l => {
    const key = _marketCategoryOf(l.item || {});
    counts.set(key, counts.get(key) + 1);
  });

  const allTab = `<button class="market-cat-tab${_marketCategoryFilter === 'all' ? ' active' : ''}" onclick="setMarketCategory('all')">${t('allCatLbl')} <span class="market-cat-count">${lots.length}</span></button>`;
  const catTabs = _MARKET_CATEGORIES.map(c => {
    const n = counts.get(c.key);
    if (!n) return '';
    return `<button class="market-cat-tab${_marketCategoryFilter === c.key ? ' active' : ''}" onclick="setMarketCategory('${c.key}')">${c.label} <span class="market-cat-count">${n}</span></button>`;
  }).join('');
  const tabsHtml = `<div class="market-cat-tabs">${allTab}${catTabs}</div>`;

  const shown = _marketCategoryFilter === 'all' ? lots : lots.filter(l => _marketCategoryOf(l.item || {}) === _marketCategoryFilter);
  const listHtml = shown.length
    ? shown.map(l => _marketRowHtml(l, mode)).join('')
    : `<div class="rating-empty">${t('noItemsInCategoryHint')}</div>`;
  return tabsHtml + listHtml;
}

function _renderMarketLots(el) {
  if (!_marketLoaded.lots) { el.innerHTML = `<div class="rating-loading">${t('questLoading')}</div>`; return; }
  if (!_marketLots.length) { el.innerHTML = `<div class="rating-empty">${t('nobodySellingHint')}</div>`; return; }
  el.innerHTML = _renderMarketFiltered(_marketLots, 'buy');
}

function _renderMarketMine(el) {
  const addBtn = `<button class="market-add-btn" onclick="openMarketSellPicker()">${t('addListingBtn')}</button>`;
  if (!_marketLoaded.mine) { el.innerHTML = addBtn + `<div class="rating-loading">${t('questLoading')}</div>`; return; }
  if (!_marketMine.length) { el.innerHTML = addBtn + `<div class="rating-empty">${t('noActiveLotsHint')}</div>`; return; }
  el.innerHTML = addBtn + _renderMarketFiltered(_marketMine, 'mine');
}

function _renderMarketHistoryTab(el) {
  if (!_marketLoaded.history) { el.innerHTML = `<div class="rating-loading">${t('questLoading')}</div>`; return; }
  if (!_marketHist.length) { el.innerHTML = `<div class="rating-empty">${t('historyEmptyHint')}</div>`; return; }
  el.innerHTML = _marketHist.map(h => {
    const it = h.item || {};
    const rc = RARITY_COLOR[it.rarity] || '#aea599';
    const isSell = h.role === 'sell';
    const cancelled = h.status === 'cancelled';
    const statusCls = cancelled ? 'market-hist-cancelled' : (isSell ? 'market-hist-sell' : 'market-hist-buy');
    const statusLbl = cancelled ? t('cancelledLbl') : (isSell ? t('soldLbl') : t('boughtLbl'));
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

// ─────────────────────────────────────────────────────────
//  EVENT BOSS — countdown banner + arrival/defeat announcement
// ─────────────────────────────────────────────────────────
// One persistent strip under the HUD counting down to the summoned boss
// (shared/definitions.js EVENT_BOSS), replaced by a short flash message when
// it actually arrives or dies. Created lazily so the markup lives in one
// place instead of index.html.
let _evtBossSpawnAt = 0, _evtBossTick = null;

function _evtBossEl() {
  let el = document.getElementById('evt-boss-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'evt-boss-banner';
    el.style.cssText = 'position:fixed;top:74px;left:50%;transform:translateX(-50%);' +
      'background:rgba(22,18,10,.94);border:1px solid #d55d6b;color:#f5dbae;' +
      'padding:8px 16px;border-radius:10px;font-size:13px;font-weight:700;z-index:350;' +
      'pointer-events:none;max-width:88vw;text-align:center;display:none;' +
      'box-shadow:0 4px 18px rgba(0,0,0,.5)';
    document.body.appendChild(el);
  }
  return el;
}

// spawnAt = 0 clears the countdown (boss arrived, or nothing pending).
function setEventBossCountdown(spawnAt) {
  _evtBossSpawnAt = spawnAt || 0;
  clearInterval(_evtBossTick);
  _evtBossTick = null;
  const el = _evtBossEl();
  if (!_evtBossSpawnAt || _evtBossSpawnAt <= Date.now()) { el.style.display = 'none'; return; }
  const paint = () => {
    const left = Math.max(0, _evtBossSpawnAt - Date.now());
    if (left <= 0) { clearInterval(_evtBossTick); _evtBossTick = null; el.style.display = 'none'; return; }
    const m = Math.floor(left / 60000), s = Math.floor(left % 60000 / 1000);
    el.style.borderColor = '#d55d6b';
    el.style.display = 'block';
    el.textContent = tVars('evtBossIncomingFmt', { time: m + ':' + String(s).padStart(2, '0') });
  };
  paint();
  _evtBossTick = setInterval(paint, 1000);
}

// Dedicated HP readout for the event boss. Its own bar over its head is
// useless at this scale: 100k HP against a level-13 character's ~55 damage
// moves that bar 0.2px per hit, which reads as "damage isn't registering"
// even though every shot lands. This shows the exact numbers and a percentage
// so progress is unmistakable, and because it's shared it also makes a raid's
// combined DPS visible.
function _evtBossHpEl() {
  let el = document.getElementById('evt-boss-hp');
  if (!el) {
    el = document.createElement('div');
    el.id = 'evt-boss-hp';
    el.style.cssText = 'position:fixed;top:110px;left:50%;transform:translateX(-50%);' +
      'width:min(420px,92vw);z-index:340;pointer-events:none;display:none;text-align:center';
    el.innerHTML =
      '<div id="evt-hp-name" style="font-size:12px;font-weight:800;color:#f5dbae;text-shadow:0 1px 3px #000;margin-bottom:3px"></div>' +
      '<div style="height:14px;background:rgba(10,8,4,.85);border:1px solid #7a2b33;border-radius:7px;overflow:hidden">' +
      '<div id="evt-hp-fill" style="height:100%;width:100%;background:linear-gradient(90deg,#8c1f2a,#e0432f);transition:width .18s linear"></div>' +
      '</div>' +
      '<div id="evt-hp-num" style="font-size:11px;color:#d9c9a8;text-shadow:0 1px 3px #000;margin-top:2px;font-variant-numeric:tabular-nums"></div>';
    document.body.appendChild(el);
  }
  return el;
}

// Called from the game loop (throttled) — reads the live enemy snapshot.
// Doubles as the race10 boss's HP readout (own eid, see the comment in
// js/sprites.js) — a player is never near both at once, so sharing the one
// element is harmless and saves building a second copy of this bar.
function updateEventBossHpBar() {
  const el = _evtBossHpEl();
  const b = (typeof serverEnemies !== 'undefined')
    ? serverEnemies.find(e => (e.eid === 'demon_event_boss' || e.eid === 'race10_boss') && (e.hp || 0) > 0) : null;
  if (!b) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  const pct = Math.max(0, Math.min(1, b.hp / (b.maxHp || 1)));
  document.getElementById('evt-hp-name').textContent = b.name || '';
  document.getElementById('evt-hp-fill').style.width = (pct * 100).toFixed(2) + '%';
  document.getElementById('evt-hp-num').textContent =
    Math.ceil(b.hp).toLocaleString('ru-RU') + ' / ' + (b.maxHp || 0).toLocaleString('ru-RU') +
    '  ·  ' + (pct * 100).toFixed(1) + '%';
}

function showEventBossBanner(text, color) {
  clearInterval(_evtBossTick);
  _evtBossTick = null;
  _evtBossSpawnAt = 0;
  const el = _evtBossEl();
  el.style.borderColor = color || '#d55d6b';
  el.style.display = 'block';
  el.textContent = text;
  clearTimeout(showEventBossBanner._t);
  showEventBossBanner._t = setTimeout(() => { el.style.display = 'none'; }, 8000);
}

// ── Buy flow ────────────────────────────────────────────────
function openMarketBuyConfirm(listingId) {
  const l = _marketLots.find(x => x.id === listingId);
  if (!l) return;
  if (typeof invHasSpace === 'function' && !invHasSpace()) {
    _marketToast(t('invFullFreeSpaceToast'), 'err');
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
        <div style="font-size:16px;font-weight:800;color:#90d653">${t('confirmPurchaseTitle')}</div>
        <button onclick="document.getElementById('market-buy-ov').remove()" style="margin-left:auto;width:28px;height:28px;border:none;border-radius:50%;background:rgba(209,204,197,.08);color:#968a7a;cursor:pointer">✕</button>
      </div>
      <div style="display:flex;align-items:center;gap:12px;padding:10px;background:rgba(209,204,197,.04);border-radius:10px;margin-bottom:14px">
        <div class="market-row-icon" style="width:44px;height:44px">${_itemIcon(it, 32)}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;color:${rc}">${it.name || '?'}${it.enhance ? ' +' + it.enhance : ''}${it.qty > 1 ? ' ×' + it.qty : ''}</div>
          <div style="font-size:11px;color:#a3957c;margin-top:2px">${statStr(it) || '&nbsp;'}</div>
          <div style="font-size:11px;color:#a3957c;margin-top:2px">${tVars('sellerLbl', { u: l.sellerUsername || '?' })}</div>
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px"><span style="color:#b2a288">${t('priceLbl')}</span><span style="font-weight:700;color:#90d653">${l.price.toFixed(2)} GRAM</span></div>
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:16px"><span style="color:#b2a288">${t('yourBalanceLbl')}</span><span style="font-weight:700;color:${canAfford ? '#f5dbae' : '#ee6676'}">${bal.toFixed(7)} GRAM</span></div>
      ${canAfford
        ? `<button class="gram-btn gram-btn-green" style="width:100%;padding:13px" onclick="_confirmMarketBuy('${listingId}')">${tVars('buyForFmt', { price: l.price.toFixed(2) })}</button>`
        : `<div style="text-align:center;color:#ee6676;font-size:12px;font-weight:600">${t('notEnoughGramLbl')}</div>`}
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
        <div style="font-size:16px;font-weight:800;color:#90d653">${t('listItemTitle')}</div>
        <button onclick="document.getElementById('market-sell-ov').remove()" style="margin-left:auto;width:28px;height:28px;border:none;border-radius:50%;background:rgba(209,204,197,.08);color:#968a7a;cursor:pointer">✕</button>
      </div>
      <div style="font-size:11px;color:#a3957c;margin-bottom:8px">${t('selectFromInvHint')}</div>
      <div class="market-pick-grid" id="market-pick-grid"></div>
      <div id="market-sell-confirm" style="display:none;margin-top:6px">
        <div style="display:flex;align-items:center;gap:10px;padding:10px;background:rgba(209,204,197,.04);border-radius:10px;margin-bottom:12px" id="market-sell-selected"></div>
        <div id="market-qty-row" style="display:none;margin-bottom:10px">
          <div style="font-size:11px;color:#a3957c;margin-bottom:5px">${t('quantityLbl')}</div>
          <input type="number" id="market-qty-input" min="1" step="1" value="1"
            style="width:100%;padding:11px;border-radius:9px;border:1px solid rgba(209,204,197,.15);background:rgba(209,204,197,.05);color:#d1ccc5;font-size:15px;font-weight:700;box-sizing:border-box" oninput="_clampMarketQtyInput()">
        </div>
        <div style="font-size:11px;color:#a3957c;margin-bottom:5px" id="market-price-hint">${tVars('priceForAllFmt', { min: MARKET_MIN_PRICE, max: MARKET_MAX_PRICE })}</div>
        <input type="number" id="market-price-input" min="${MARKET_MIN_PRICE}" max="${MARKET_MAX_PRICE}" step="0.1" value="1"
          style="width:100%;padding:11px;border-radius:9px;border:1px solid rgba(209,204,197,.15);background:rgba(209,204,197,.05);color:#d1ccc5;font-size:15px;font-weight:700;margin-bottom:6px;box-sizing:border-box" oninput="_updateMarketFeePreview()">
        <div id="market-fee-preview" style="font-size:11px;color:#a3957c;margin-bottom:14px"></div>
        <button class="market-add-btn" id="market-confirm-btn" onclick="_confirmMarketList()">${t('listForSaleBtn')}</button>
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
  if (!player.inventory.length) { grid.innerHTML = `<div class="rating-empty" style="grid-column:1/-1">${t('storageInvEmpty')}</div>`; return; }
  grid.innerHTML = player.inventory.map((it, idx) => {
    const rc  = RARITY_COLOR[it.rarity] || '#aea599';
    const sel = _marketSellPick === idx ? ' selected' : '';
    const cnt = it.qty > 1 ? `<span style="position:absolute;bottom:1px;right:2px;font-size:7px;color:#cfc0ad;font-weight:bold">×${it.qty}</span>` : '';
    return `<div class="market-pick-cell${sel}" style="border-color:${rc}55" onclick="_pickMarketSellItem(${idx})" title="${it.name}">
      ${_itemIcon(it, 26)}${cnt}
    </div>`;
  }).join('');
}

// Current pick's item + however many units this listing covers right now
// (the qty input when it's showing, otherwise 1) — the one place both the
// hint and the validation read the live minimum from.
function _currentMarketMinPrice() {
  const idx = _marketSellPick;
  const it  = idx !== null && player ? player.inventory[idx] : null;
  if (!it) return MARKET_MIN_PRICE;
  const qtyInput = document.getElementById('market-qty-input');
  const qtyRow   = document.getElementById('market-qty-row');
  const qty = (qtyRow && qtyRow.style.display !== 'none' && qtyInput) ? (Number(qtyInput.value) || 1) : 1;
  return _marketMinPriceFor(it, qty);
}

// Refreshes the price input's floor (both the hint text and its `min`
// attribute) for whatever's picked right now — called on pick and on every
// qty change, since keys/recipes/stones price per unit.
function _updateMarketPriceHint() {
  const hint  = document.getElementById('market-price-hint');
  const input = document.getElementById('market-price-input');
  if (!hint || !input) return;
  const min = _currentMarketMinPrice();
  hint.textContent = tVars('priceForAllFmt', { min, max: MARKET_MAX_PRICE });
  input.min = min;
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
    <div style="font-size:11px;color:#a3957c;margin-top:2px">${statStr(it) || (have > 1 ? tVars('youHaveFmt', { n: have }) : '')}</div></div>`;
  confirmWrap.style.display = 'block';
  if (qtyRow) {
    qtyRow.style.display = stackable ? 'block' : 'none';
    if (stackable) {
      const qtyInput = document.getElementById('market-qty-input');
      if (qtyInput) { qtyInput.max = have; qtyInput.value = have; } // default: list the whole stack
    }
  }
  _updateMarketPriceHint();
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
  _updateMarketPriceHint();
  _updateMarketFeePreview();
}

function _updateMarketFeePreview() {
  const el    = document.getElementById('market-fee-preview');
  const input = document.getElementById('market-price-input');
  if (!el || !input) return;
  const min = _currentMarketMinPrice();
  const p = Number(input.value);
  if (!Number.isFinite(p) || p < min || p > MARKET_MAX_PRICE) {
    el.textContent = tVars('priceRangeFmt', { min, max: MARKET_MAX_PRICE });
    el.style.color = '#ee6676';
    return;
  }
  const payout = p * (1 - MARKET_FEE_PCT);
  el.textContent = tVars('feePreviewFmt', { n: payout.toFixed(2) });
  el.style.color = '#a3957c';
}

function _setSellPickerBusy(busy) {
  const btn = document.getElementById('market-confirm-btn');
  if (btn) { btn.disabled = busy; btn.style.opacity = busy ? '0.5' : '1'; btn.textContent = busy ? t('listingBusyLbl') : t('listForSaleBtn'); }
}

function _confirmMarketList() {
  if (_marketSellPick === null || !player || _pendingSellItem) return;
  const priceInput = document.getElementById('market-price-input');
  const p = Number(priceInput?.value);
  const minPrice = _currentMarketMinPrice();
  if (!Number.isFinite(p) || p < minPrice || p > MARKET_MAX_PRICE) {
    _marketToast(tVars('priceRangeFmt', { min: minPrice, max: MARKET_MAX_PRICE }), 'err');
    return;
  }
  const idx = _marketSellPick;
  const it  = player.inventory[idx];
  if (!it) return;
  // Bail out before touching the inventory if there's no connection: the
  // splice below is optimistic and is only ever rolled back by a
  // marketListError from the server, so emitting into a dead socket left the
  // item removed from the inventory with no listing and no error to undo it.
  if (!netIsLive()) {
    _marketToast(t('noServerConn'), 'err');
    return;
  }
  // Flush a save with the item STILL in the inventory, before the optimistic
  // splice below. The server verifies the seller actually owns what they're
  // listing against its own copy of the inventory (see marketList in
  // server/index.js), and socket.io delivers per-connection messages in order,
  // so this save is guaranteed to have been applied by the time the listing
  // request is handled. Without it, an item picked up in the last couple of
  // seconds — not yet covered by the debounced autosave — would be rejected as
  // "not in inventory".
  netSaveProgressNow();
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
  _marketToast(tVars('listedForFmt', { name: listing.item?.name || '', price: listing.price }), 'ok');
}
function onMarketCancelled(listingId, item, delivered) {
  _marketMine = _marketMine.filter(l => l.id !== listingId);
  // delivered: the server already put the item back and its inventorySync has
  // arrived, so it's in player.inventory right now — adding it again here
  // would give a free second copy of every cancelled listing.
  //
  // Only when it could NOT (no room server-side) do we add it locally, and
  // then the return value MUST be checked — an unchecked failure is what
  // destroyed items: the add silently fails on a full inventory and the
  // unconditional netSaveProgressNow() below shipped an inventory without the
  // returned item, overwriting the server's copy which did have it. On failure
  // skip the save and let the server's inventorySync bring us back in line.
  const stored = (delivered || !item) ? true : addToInventoryQty(item, item.qty || 1);
  updateInvUI();
  if (_marketTab === 'mine') _renderMarketBody();
  if (!stored) {
    _marketToast(t('invFullItemLostToast'), 'err');
    return;
  }
  netSaveProgressNow();
  _marketToast(t('listingCancelledToast'), 'ok');
}
function onMarketBought(listingId, item, delivered) {
  _marketLots = _marketLots.filter(l => l.id !== listingId);
  // delivered: already in player.inventory via the inventorySync that came
  // with this purchase. Adding it again handed out a free duplicate of every
  // bought lot — which is how a bought skill book survived being spent.
  if (!delivered && item && !addToInventoryQty(item, item.qty || 1)) {
    _marketToast(t('invFullItemLostToast'), 'err');
  }
  updateInvUI();
  if (_marketTab === 'lots') _renderMarketBody();
  netSaveProgressNow();
  _marketToast(tVars('boughtItemToast', { name: `${item?.name || ''}${item?.qty > 1 ? ' ×' + item.qty : ''}` }), 'ok');
}
function onMarketSold(data) {
  _marketToast(tVars('soldItemToast', { name: data.itemName, price: data.price, payout: (data.payout || 0).toFixed(2) }), 'ok');
  const panel = document.getElementById('market-panel');
  if (_marketTab === 'mine' && panel && panel.style.display !== 'none') netMarketMyListings();
}
function onMarketError(msg) {
  _marketToast(msg || t('genericErrorLbl'), 'err');
}
function onMarketListError(msg) {
  if (_rollbackPendingSell()) _marketToast(msg || t('genericErrorLbl'), 'err');
}
// Called when the socket drops while a marketList request is in flight
// (js/network.js's 'disconnect' handler) — the optimistic splice in
// _confirmMarketList is normally undone by marketListError, but that event
// can never arrive once the connection itself is gone, which is exactly the
// "оборвалась связь" scenario that used to strand the item in limbo forever
// (see _pendingSellItem). Restore it locally instead of waiting for a
// response that will never come.
function onMarketConnectionLost() {
  if (_rollbackPendingSell()) _marketToast(t('noServerConn'), 'err');
}
// Shared by onMarketListError and onMarketConnectionLost. Returns true if
// there was a pending sell to roll back.
function _rollbackPendingSell() {
  if (!_pendingSellItem) return false;
  const it = _pendingSellItem.item;
  addToInventoryQty(it, it.qty || 1);
  updateInvUI();
  _pendingSellItem = null;
  _setSellPickerBusy(false);
  return true;
}

// ─────────────────────────────────────────────────────────
//  GRAM SHOP PANEL
// ─────────────────────────────────────────────────────────
const _GRAM_SHOP_PKGS_UI = [
  { id:'pkg1',   gram:1,   get label() { return t('gramPkgLabel_pkg1'); },   gold:1000,   potions:2,  armor:null,       weapon:null,       bonusSP:0,  color:'#a3957c', skillBooks:null },
  { id:'pkg5',   gram:5,   get label() { return t('gramPkgLabel_pkg5'); },   gold:5000,   potions:10, armor:null,       weapon:null,       bonusSP:0,  color:'#89ba5f', skillBooks:{ random:1 } },
  { id:'pkg10',  gram:10,  get label() { return t('gramPkgLabel_pkg10'); },  gold:7000,   potions:10, armor:'Common',   weapon:'Common',   bonusSP:1,  color:'#eab65d', skillBooks:{ random:2 } },
  { id:'pkg30',  gram:30,  get label() { return t('gramPkgLabel_pkg30'); },  gold:20000,  potions:30, armor:'Uncommon', weapon:'Uncommon', bonusSP:2,  color:'#e6b761', skillBooks:{ each:1 },  enhance:5, nexum:500 },
  { id:'pkg50',  gram:100, get label() { return t('gramPkgLabel_pkg50'); },  gold:50000,  potions:50, armor:'Rare',     weapon:'Rare',     bonusSP:5,  color:'#e5a546', skillBooks:{ each:4 },  boxes:{ box_rare:10 }, enhance:5, nexum:4000 },
  { id:'pkg100', gram:220, get label() { return t('gramPkgLabel_pkg100'); }, gold:100000, potions:100,armor:'Rare',     weapon:'Rare',     bonusSP:10, color:'#eb4e61', skillBooks:{ each:12 }, boxes:{ box_rare:30 }, enhance:8, nexum:10000 },
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
      ${tVars('gramShopBalanceFmt', { bal: `<b>${bal.toFixed(7)}</b>` })}
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
  let rows = ri(coinUri, kGold + ' ' + t('gramShopGoldSuffix'), 'gold');

  // potions
  rows += _POTION_NAMES.map(p => ri(`/images/potion/${p}.png`, `×${pkg.potions}`, '')).join('');

  // armor set
  if (pkg.armor) {
    const key = pkg.armor.toLowerCase();
    const icons = _ARMOR_ICONS[key] || [];
    const enhLbl = pkg.enhance ? `+${pkg.enhance}` : '';
    rows += icons.map(i => ri(`/images/${i}`, enhLbl, key)).join('');
  }

  // weapon — class-specific
  if (pkg.weapon) {
    const key = pkg.weapon.toLowerCase();
    const pfx = wepPfxMap[key] || 'c';
    rows += ri(`/images/wep/${pfx}${wepSfx}.png`, pkg.enhance ? `+${pkg.enhance}` : '', key);
  }

  // bonus skill points
  if (pkg.bonusSP) {
    const spUri = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23c084fc' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polygon points='12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26'/></svg>`;
    rows += ri(spUri, `+${pkg.bonusSP} ${t('bonusSpSuffixShort')}`, 'epic');
  }

  // skill books — for the buyer's own class (see _skillBooksLabel below)
  if (pkg.skillBooks) {
    const bookUri = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23e3941d' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5'/><path d='M4 4.5v17'/><line x1='9' y1='7' x2='16' y2='7'/><line x1='9' y1='11' x2='16' y2='11'/></svg>`;
    rows += ri(bookUri, _skillBooksLabel(pkg.skillBooks), 'epic');
  }

  // Liberty (Nexum) bonus — same coin icon Liberty uses everywhere else
  // (pet crafting, drop toasts, quest/arena rewards).
  if (pkg.nexum) {
    rows += ri('/images/nexum-coin_v2.png', `+${pkg.nexum} Liberty`, 'epic');
  }

  // boxes (BOX_DEF — see _boxesLabel below)
  if (pkg.boxes) {
    rows += _boxesLabel(pkg.boxes).map(({ img, label, cls }) => ri(img, label, cls)).join('');
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
        ${canAfford ? t('affordableBuyBtn') : t('notEnoughBtn')}
      </button>
    </div>
    <div class="vip-items-row">${rows}</div>
  </div>`;
}

// Shared between the shop card preview and the confirm modal. The icon row
// has no room for "по 12 каждой книги навыка (все 4)" — just the total count
// (each × the 4 class books, or random's own count) reads at a glance.
function _skillBooksLabel(skillBooks) {
  if (!skillBooks) return '';
  const total = skillBooks.each ? skillBooks.each * 4 : (skillBooks.random || 0);
  return tVars('skillBooksTotalLbl', { n: total });
}

// Shared between the shop card preview and the confirm modal — mirrors
// server/index.js's pkg.boxes handling in the gramShopBuy handler.
const _BOX_IMG = { box_uncommon: '/images/material/boxu.png', box_rare: '/images/material/boxr.png' };
const _BOX_CLS = { box_uncommon: 'uncommon', box_rare: 'rare' };
function _boxesLabel(boxes) {
  return Object.entries(boxes).map(([id, qty]) => ({
    img: _BOX_IMG[id] || '', label: `×${qty}`, cls: _BOX_CLS[id] || '',
  }));
}
function _boxesLine(boxes) {
  return Object.entries(boxes).map(([id, qty]) => {
    const name = id === 'box_rare' ? t('rareBoxesLbl') : t('uncommonBoxesLbl');
    return `${qty}× ${name}`;
  }).join(', ');
}

function openGramShopConfirm(pkgId) {
  const pkg = _GRAM_SHOP_PKGS_UI.find(p => p.id === pkgId);
  if (!pkg) return;
  const bal = window._gramBalance || 0;
  if (bal < pkg.gram) return;
  const existing = document.getElementById('gram-shop-confirm-ov');
  if (existing) existing.remove();
  const kGold = pkg.gold >= 1000 ? (pkg.gold / 1000).toFixed(0) + 'k' : pkg.gold;
  const enhSuffix  = pkg.enhance ? ` +${pkg.enhance}` : '';
  const armorLine  = pkg.armor  ? `<div style="color:#c5bfb7">${tVars('fullArmorSetFmt', { rarity: pkg.armor })}${enhSuffix}</div>` : '';
  const weaponLine = pkg.weapon ? `<div style="color:#c5bfb7">${tVars('classWeaponFmt', { rarity: pkg.weapon })}${enhSuffix}</div>` : '';
  const spLine     = pkg.bonusSP ? `<div style="color:#c5bfb7">${tVars('bonusSkillPointsFmt', { n: pkg.bonusSP })}</div>` : '';
  const bookLine   = pkg.skillBooks ? `<div style="color:#c5bfb7">• ${_skillBooksLabel(pkg.skillBooks)} ${t('classBooksSuffix')}</div>` : '';
  const boxLine    = pkg.boxes ? `<div style="color:#c5bfb7">• ${_boxesLine(pkg.boxes)}</div>` : '';
  const nexumLine  = pkg.nexum ? `<div style="color:#6fc7ff">• +${pkg.nexum} Liberty</div>` : '';
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
        <div style="color:#c5bfb7">${tVars('goldAmountFmt', { n: kGold })}</div>
        <div style="color:#c5bfb7">${tVars('eachPotionFmt', { n: pkg.potions })}</div>
        ${armorLine}${weaponLine}${spLine}${bookLine}${boxLine}${nexumLine}
      </div>
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:16px">
        <span style="color:#b2a288">${t('costLbl')}</span>
        <span style="font-weight:700;color:${pkg.color}">${pkg.gram} GRAM</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:16px">
        <span style="color:#b2a288">${t('yourBalanceLbl')}</span>
        <span style="font-weight:700;color:#f5dbae">${bal.toFixed(7)} GRAM</span>
      </div>
      <button class="gram-btn gram-btn-green" style="width:100%;padding:13px"
        onclick="_confirmGramShopBuy('${pkgId}')">${tVars('buyForFmt', { price: pkg.gram })}</button>
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
  if (data.newNexumBalance != null) window._nexumBalance = data.newNexumBalance;
  if (player) {
    player.gold = data.newGold;
    if (data.newPotionBag) player.potionBag = data.newPotionBag;
    if (data.newInventory) player.inventory = data.newInventory;
    if (data.newBonusSP != null) player.bonusSP = data.newBonusSP;
    if (data.newNexumBalance != null) player.nexumBalance = data.newNexumBalance;
  }
  if (data.vipData) window._vipData = data.vipData;
  const pkg = _GRAM_SHOP_PKGS_UI.find(p => p.id === data.pkgId);
  const lbl = pkg ? pkg.label : t('packageFallbackLbl');
  _marketToast(tVars('pkgBoughtToast', { lbl }), 'ok');
  const panel = document.getElementById('gram-shop-panel');
  if (panel && panel.style.display !== 'none') _renderGramShopPanel();
  updateInvUI();
  if (activeTab === 1 && _invTab === 1) updateProfileUI();
  if (activeTab === 1 && _invTab === 0) updateUpgradeUI();
}

function onGramShopError(msg) {
  _marketToast(msg || t('purchaseErrorLbl'), 'err');
}

let _gramTxList = [];
let _refFriendsList = [];

function switchProfileTab(tab) {
  window._profileTab = tab;
  document.querySelectorAll('.profile-tab').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('ptab-' + tab);
  if (btn) btn.classList.add('active');
  if (tab === 'wallet') updateGramUI();
  else if (tab === 'lang') _renderLangPicker();
  else if (tab === 'sound') _renderSoundPicker();
  else updateFriendsUI();
}

// ── Sound toggle (Профиль → Звук) ───────────────────────────
function _renderSoundPicker() {
  if (window._profileTab !== 'sound') return;
  const el = document.getElementById('gram-body');
  if (!el || typeof Sound === 'undefined') return;
  const sfxOn = !Sound.muted;
  const bgmOn = typeof Music !== 'undefined' && !Music.muted;
  el.innerHTML = `
    <div class="gram-section-title" style="margin-bottom:10px">${t('bgmSectionTitle')}</div>
    <div class="lang-card-grid">
      <button class="lang-card${bgmOn ? ' active' : ''}" onclick="_setBgmMuted(false)">
        <span class="lang-card-flag">🎵</span>
        <span class="lang-card-name">${t('sfxOnLbl')}</span>
        ${bgmOn ? '<span class="lang-card-check">✓</span>' : ''}
      </button>
      <button class="lang-card${bgmOn ? '' : ' active'}" onclick="_setBgmMuted(true)">
        <span class="lang-card-flag">🔇</span>
        <span class="lang-card-name">${t('sfxOffLbl')}</span>
        ${bgmOn ? '' : '<span class="lang-card-check">✓</span>'}
      </button>
    </div>

    <div class="gram-section-title" style="margin:18px 0 10px">${t('sfxSectionTitle')}</div>
    <div class="lang-card-grid">
      <button class="lang-card${sfxOn ? ' active' : ''}" onclick="_setSfxMuted(false)">
        <span class="lang-card-flag">🔊</span>
        <span class="lang-card-name">${t('sfxOnLbl')}</span>
        ${sfxOn ? '<span class="lang-card-check">✓</span>' : ''}
      </button>
      <button class="lang-card${sfxOn ? '' : ' active'}" onclick="_setSfxMuted(true)">
        <span class="lang-card-flag">🔇</span>
        <span class="lang-card-name">${t('sfxOffLbl')}</span>
        ${sfxOn ? '' : '<span class="lang-card-check">✓</span>'}
      </button>
    </div>
    <div style="font-size:11px;color:#82745b;margin-top:12px;text-align:center">${t('sfxHint')}</div>
  `;
}

function _setSfxMuted(v) {
  if (typeof Sound === 'undefined') return;
  Sound.setMuted(v);
  _renderSoundPicker();
}

function _setBgmMuted(v) {
  if (typeof Music === 'undefined') return;
  Music.setMuted(v);
  _renderSoundPicker();
}

// ── Language picker (Профиль → Язык) ───────────────────────
function _renderLangPicker() {
  if (window._profileTab !== 'lang') return;
  const el = document.getElementById('gram-body');
  if (!el || typeof I18N_LANGS === 'undefined') return;
  const cards = I18N_LANGS.map(l => `
    <button class="lang-card${l.code === currentLang ? ' active' : ''}" onclick="setLang('${l.code}')">
      <span class="lang-card-flag">${l.flag}</span>
      <span class="lang-card-name">${l.native}</span>
      ${l.code === currentLang ? '<span class="lang-card-check">✓</span>' : ''}
    </button>`).join('');
  el.innerHTML = `
    <div class="gram-section-title" style="margin-bottom:10px">${t('langPickerTitle')}</div>
    <div class="lang-card-grid">${cards}</div>
    <div style="font-size:11px;color:#82745b;margin-top:12px;text-align:center">${t('langPickerHint')}</div>
  `;
}

function updateFriendsUI() {
  const el = document.getElementById('gram-body');
  if (!el) return;
  const refLink = window._refLink || '';
  const friends = _refFriendsList;
  const totalBonus = friends.reduce((s, f) => s + (f.bonus || 0), 0);

  el.innerHTML = `
    <div class="ref-card">
      <div class="ref-card-title">${t('refLinkCardTitle')}</div>
      <div class="ref-link-box">
        <span id="ref-link-val" style="flex:1;font-size:12px">${refLink || t('questLoading')}</span>
        <button class="ref-copy-btn" onclick="refCopyLink()">${t('copyBtn')}</button>
      </div>
      <div style="font-size:11px;color:#82745b;margin-top:8px">${tVars('refBonusHintFmt', { pct: '<b style="color:#89ba5f">5%</b>' })}</div>
    </div>

    <div class="ref-stats-row">
      <div class="ref-stat-box">
        <div class="ref-stat-num">${friends.length}</div>
        <div class="ref-stat-lbl">${t('friendsCountLbl')}</div>
      </div>
      <div class="ref-stat-box">
        <div class="ref-stat-num">${totalBonus.toFixed(2)}</div>
        <div class="ref-stat-lbl">${t('gramReceivedLbl')}</div>
      </div>
    </div>

    <div class="gram-section-title" style="margin-bottom:8px">${t('friendsListHdr')}</div>
    <div id="ref-friends-list">
      ${friends.length === 0
        ? `<div class="ref-empty">${t('noFriendsInvitedHint')}<br><span style="font-size:12px">${t('sendLinkHint')}</span></div>`
        : friends.map(f => {
            const init = (f.username || '?')[0].toUpperCase();
            return `<div class="ref-friend-row">
              <div class="ref-friend-avatar">${init}</div>
              <div class="ref-friend-name">@${f.username || t('playerFallbackLbl')}</div>
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
    if (btn) { const old = btn.textContent; btn.textContent = t('copiedLbl'); btn.style.color = '#89ba5f'; setTimeout(() => { btn.textContent = old; btn.style.color = ''; }, 2000); }
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
  toast.textContent = tVars('friendJoinedToast', { u: data.username || t('playerFallbackLbl') });
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function onRefBonusReceived(data) {
  const f = _refFriendsList.find(x => x.username === data.fromUsername);
  if (f) f.bonus = (f.bonus || 0) + data.bonus;
  if (window._profileTab === 'friends') updateFriendsUI();
  const toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;top:80px;left:50%;transform:translateX(-50%);background:#362d1e;border:1px solid #eec379;color:#eec379;padding:10px 18px;border-radius:10px;font-size:13px;font-weight:600;z-index:9999;pointer-events:none';
  toast.textContent = tVars('refBonusReceivedToast', { n: data.bonus.toFixed(2), u: data.fromUsername });
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function updateGramUI() {
  const el = document.getElementById('gram-body');
  if (!el) return;
  const balance = window._gramBalance || 0;

  el.innerHTML = `
    <div class="gram-airdrop-card" style="background:linear-gradient(135deg,rgba(230,148,25,0.14),rgba(230,148,25,0.05));border:1px solid rgba(230,148,25,0.3);border-radius:14px;padding:14px 16px;text-align:center;margin-bottom:14px">
      <div style="font-size:16px;font-weight:800;color:#e6ac19;letter-spacing:0.03em">🪂 AirDrop</div>
      <div style="font-size:12px;color:#c5bfb7;margin-top:4px">${t('airdropCollectHint')}</div>
    </div>

    <div class="gram-balance-card">
      <div class="gram-balance-label">${t('gramBalanceLbl')}</div>
      <div class="gram-balance-amount" id="gram-balance-val">${balance.toFixed(7)} <span class="gram-unit">GRAM</span></div>
    </div>

    <div id="ton-connect-row" style="margin-bottom:14px"></div>

    <div style="display:flex;gap:10px;margin-bottom:14px">
      <button class="gram-btn gram-btn-green" style="flex:1;padding:13px" onclick="openGramDepositModal()">
        ${t('depositBtn')}
      </button>
      <button class="gram-btn gram-btn-orange" style="flex:1;padding:13px" onclick="openGramWithdrawModal()">
        ${t('withdrawBtn')}
      </button>
    </div>

    <div class="gram-section">
      <div class="gram-section-title">${t('txHistoryHdr')}</div>
      <div id="gram-history-list"><div class="gram-hint" style="text-align:center;padding:12px 0">${t('questLoading')}</div></div>
    </div>
  `;

  _renderTonConnectRow();
  if (typeof netGramHistory === 'function') netGramHistory();
}

// Short "UQ...ab3f" form for display — TON addresses are long and don't need
// to be shown in full outside the copy-paste boxes that specifically need it.
function _shortenTonAddr(addr) {
  if (!addr) return '';
  return addr.length > 12 ? addr.slice(0, 6) + '…' + addr.slice(-4) : addr;
}

function _renderTonConnectRow() {
  const el = document.getElementById('ton-connect-row');
  if (!el) return;
  const addr = typeof tcAddress === 'function' ? tcAddress() : null;
  el.innerHTML = addr
    ? `<div style="display:flex;align-items:center;gap:8px;background:rgba(209,204,197,.04);border:1px solid rgba(209,204,197,.12);border-radius:10px;padding:9px 12px;font-size:12px">
        <span style="color:#90d653">✓ ${t('tcConnectedLbl')}</span>
        <span style="color:#a3957c;font-variant-numeric:tabular-nums">${_shortenTonAddr(addr)}</span>
        <button onclick="tcDisconnect()" style="margin-left:auto;background:none;border:none;color:#ee6676;font-size:11px;cursor:pointer;text-decoration:underline">${t('tcDisconnectBtn')}</button>
      </div>`
    : `<button class="gram-btn" style="width:100%;padding:11px;background:rgba(209,204,197,.06);border:1px solid rgba(209,204,197,.15);color:#d1ccc5" onclick="tcConnect()">${t('tcConnectBtn')}</button>`;
}

// Called by js/tonconnect.js whenever the wallet connect status changes —
// keeps the wallet tab (and any open deposit/withdraw modal) in sync without
// the player needing to close and reopen anything.
function _onTonConnectChange() {
  _renderTonConnectRow();
  const depBtn = document.getElementById('ton-deposit-send-wrap');
  if (depBtn) _renderTonDepositSection();
  const wdAddr = document.getElementById('gram-wd-addr');
  const addr = typeof tcAddress === 'function' ? tcAddress() : null;
  if (wdAddr && addr && !wdAddr.value) wdAddr.value = addr;
  if (document.getElementById('ton-wd-connect-wrap')) _renderTonWithdrawConnectHint();
}

function _renderGramHistory() {
  const el = document.getElementById('gram-history-list');
  if (!el) return;
  if (!_gramTxList.length) {
    el.innerHTML = `<div class="gram-hint" style="text-align:center;padding:12px 0">${t('noTxYetHint')}</div>`;
    return;
  }
  el.innerHTML = _gramTxList.map(tx => {
    const isDeposit = tx.type === 'deposit';
    const statusCls = tx.status === 'confirmed' ? 'gram-st-ok' : tx.status === 'rejected' ? 'gram-st-no' : 'gram-st-wait';
    const statusLbl = tx.status === 'confirmed' ? t('txDoneLbl') : tx.status === 'rejected' ? t('txRejectedLbl') : t('txWaitingLbl');
    const date = new Date(tx.createdAt).toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
    return `<div class="gram-tx-row">
      <div class="gram-tx-icon ${isDeposit ? 'gram-tx-dep' : 'gram-tx-wd'}">${isDeposit ? '↓' : '↑'}</div>
      <div class="gram-tx-info">
        <div class="gram-tx-type">${isDeposit ? t('depositTypeLbl') : t('withdrawTypeLbl')}</div>
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
  if (bal) bal.textContent = (window._gramBalance || 0).toFixed(7) + ' ';
}

function onGramTxUpdate(id, status) {
  const tx = _gramTxList.find(t => t.id === id);
  if (tx) { tx.status = status; _renderGramHistory(); }
  const bal = document.getElementById('gram-balance-val');
  if (bal) bal.textContent = (window._gramBalance || 0).toFixed(7) + ' ';
}

// ── Deposit modal ─────────────────────────────────────────
function openGramDepositModal() {
  const wallet = window._gramWallet || t('walletNotSetLbl');
  const memo   = (player && player.telegramId) ? player.telegramId
                 : (window.netUsername || String(Date.now()));
  const html = `
    <div id="gram-modal-overlay" onclick="closeGramModal()" style="position:fixed;inset:0;z-index:400;background:rgba(0,0,0,.75);backdrop-filter:blur(4px);display:flex;align-items:flex-end;justify-content:center;">
      <div onclick="event.stopPropagation()" style="width:100%;max-width:500px;background:#16120a;border-radius:18px 18px 0 0;border-top:1px solid rgba(209,204,197,.1);padding:22px 20px 36px;">
        <div style="display:flex;align-items:center;margin-bottom:18px">
          <div style="font-size:16px;font-weight:800;color:#90d653">${t('depositModalTitle')}</div>
          <button onclick="closeGramModal()" style="margin-left:auto;width:28px;height:28px;border:none;border-radius:50%;background:rgba(209,204,197,.08);color:#968a7a;cursor:pointer">✕</button>
        </div>

        <div style="margin-bottom:10px">
          <div class="gram-hint" style="margin-bottom:6px">${t('transferAmountHint')}</div>
          <input id="gram-dep-amount" type="number" min="1" step="0.01" placeholder="${t('enterGramAmountPlaceholder')}" class="gram-input" style="width:100%;box-sizing:border-box" oninput="_renderTonDepositSection()">
        </div>

        <div id="ton-deposit-send-wrap" style="margin-bottom:6px"></div>

        <div class="gram-hint" style="margin-bottom:6px">${t('transferToWalletHint')}</div>
        <div class="gram-copy-box" onclick="gramCopy('gram-addr-val')">
          <span id="gram-addr-val">${wallet}</span>
          <span class="gram-copy-icon">⎘</span>
        </div>

        <div class="gram-hint" style="margin:12px 0 6px">${t('memoRequiredHint')}</div>
        <div class="gram-copy-box" onclick="gramCopy('gram-memo-val')">
          <span id="gram-memo-val">${memo}</span>
          <span class="gram-copy-icon">⎘</span>
        </div>

        <div class="gram-warn">${t('memoWarnHint')}</div>

        <button class="gram-btn gram-btn-green" style="width:100%;padding:14px;font-size:15px;margin-top:16px" onclick="gramDepositConfirm('${memo}')">
          ${t('iPaidBtn')}
        </button>
        <div id="gram-modal-msg" class="gram-msg" style="display:none;margin-top:10px"></div>
      </div>
    </div>`;
  const div = document.createElement('div');
  div.id = 'gram-modal-wrap';
  div.innerHTML = html;
  document.body.appendChild(div);
  window._gramDepositMemo = memo;
  _renderTonDepositSection();
}

// Fills #ton-deposit-send-wrap inside the (currently open) deposit modal:
// a connect prompt if no wallet is linked yet, or a one-tap "send from
// wallet" button that fires an actual on-chain transfer once one is. The
// manual copy-paste address/memo boxes below stay available either way —
// TON Connect only makes *sending* easier, admin approval is unchanged.
function _renderTonDepositSection() {
  const el = document.getElementById('ton-deposit-send-wrap');
  if (!el) return;
  const addr = typeof tcAddress === 'function' ? tcAddress() : null;
  if (!addr) {
    el.innerHTML = `<button class="gram-btn" style="width:100%;padding:12px;background:rgba(209,204,197,.06);border:1px solid rgba(209,204,197,.15);color:#d1ccc5;margin-bottom:10px" onclick="tcConnect()">${t('tcConnectBtn')}</button>
      <div class="gram-hint" style="text-align:center;margin-bottom:10px">${t('tcOrManualHint')}</div>`;
    return;
  }
  const amountVal = document.getElementById('gram-dep-amount')?.value || '0';
  el.innerHTML = `<button id="ton-deposit-send-btn" class="gram-btn gram-btn-green" style="width:100%;padding:13px;margin-bottom:10px" onclick="_tcDepositSend()">${tVars('tcSendFromWalletFmt', { n: amountVal })}</button>
    <div class="gram-hint" style="text-align:center;margin-bottom:10px">${t('tcOrManualHint')}</div>`;
}

// Sends the entered amount as a real on-chain transfer from the connected
// wallet, then registers the same pending GramTx the manual "I paid" flow
// creates (netGramDeposit) so admin approval works identically either way.
async function _tcDepositSend() {
  const amount = parseFloat(document.getElementById('gram-dep-amount')?.value);
  if (!amount || amount < 1) { _gramModalMsg(t('tcEnterAmountFirstToast'), 'err'); return; }
  const wallet = window._gramWallet;
  const memo = window._gramDepositMemo;
  if (!wallet || typeof tcSendDeposit !== 'function') { _gramModalMsg(t('serviceUnavailableToast'), 'err'); return; }
  const btn = document.getElementById('ton-deposit-send-btn');
  if (btn) { btn.disabled = true; btn.textContent = t('tcSendingLbl'); }
  try {
    await tcSendDeposit(wallet, amount, memo);
    if (typeof netGramDeposit === 'function') netGramDeposit(amount, memo);
    closeGramModal();
    _gramMsg(t('tcTxSentToast'), 'ok');
  } catch (e) {
    _gramModalMsg(t('tcTxErrorToast'), 'err');
    if (btn) { btn.disabled = false; _renderTonDepositSection(); }
  }
}

function gramDepositConfirm(memo) {
  const amount = parseFloat(document.getElementById('gram-dep-amount').value);
  if (!amount || amount < 1) { _gramModalMsg(t('minAmountErrToast'), 'err'); return; }
  if (typeof netGramDeposit === 'function') {
    netGramDeposit(amount, memo);
    closeGramModal();
    _gramMsg(t('depositRequestCreatedToast'), 'ok');
  } else {
    _gramModalMsg(t('serviceUnavailableToast'), 'err');
  }
}

// ── Withdraw modal ────────────────────────────────────────
function openGramWithdrawModal() {
  const balance = window._gramBalance || 0;
  const html = `
    <div id="gram-modal-overlay" onclick="closeGramModal()" style="position:fixed;inset:0;z-index:400;background:rgba(0,0,0,.75);backdrop-filter:blur(4px);display:flex;align-items:flex-end;justify-content:center;">
      <div onclick="event.stopPropagation()" style="width:100%;max-width:500px;background:#16120a;border-radius:18px 18px 0 0;border-top:1px solid rgba(209,204,197,.1);padding:22px 20px 36px;">
        <div style="display:flex;align-items:center;margin-bottom:18px">
          <div style="font-size:16px;font-weight:800;color:#e5a546">${t('withdrawModalTitle')}</div>
          <button onclick="closeGramModal()" style="margin-left:auto;width:28px;height:28px;border:none;border-radius:50%;background:rgba(209,204,197,.08);color:#968a7a;cursor:pointer">✕</button>
        </div>

        <div style="background:rgba(229,165,70,0.08);border:1px solid rgba(229,165,70,0.2);border-radius:10px;padding:10px 14px;margin-bottom:16px;font-size:13px;color:#ba9865">
          ${tVars('availableFeeFmt', { bal: `<b>${balance.toFixed(7)}</b>` })}
        </div>

        <div style="margin-bottom:12px">
          <div class="gram-hint" style="margin-bottom:6px">${tVars('withdrawAmountHint', { n: GRAM_MIN_WITHDRAW })}</div>
          <input id="gram-wd-amount" type="number" min="${GRAM_MIN_WITHDRAW}" step="0.01" placeholder="${t('gramAmountPlaceholder')}" class="gram-input" style="width:100%;box-sizing:border-box" oninput="_updateWdPreview()">
        </div>
        <div id="gram-wd-preview" style="font-size:12px;color:#a3957c;margin:-6px 0 12px;padding:0 2px"></div>

        <div style="margin-bottom:16px">
          <div class="gram-hint" style="margin-bottom:6px">${t('tonAddrHint')}</div>
          <input id="gram-wd-addr" type="text" placeholder="UQ..." class="gram-input gram-input-addr" style="width:100%;box-sizing:border-box">
          <div id="ton-wd-connect-wrap" style="margin-top:8px"></div>
        </div>

        <button class="gram-btn gram-btn-orange" style="width:100%;padding:14px;font-size:15px" onclick="gramWithdrawConfirm()">
          ${t('submitWithdrawBtn')}
        </button>
        <div id="gram-modal-msg" class="gram-msg" style="display:none;margin-top:10px"></div>
      </div>
    </div>`;
  const div = document.createElement('div');
  div.id = 'gram-modal-wrap';
  div.innerHTML = html;
  document.body.appendChild(div);
  const connectedAddr = typeof tcAddress === 'function' ? tcAddress() : null;
  if (connectedAddr) document.getElementById('gram-wd-addr').value = connectedAddr;
  _renderTonWithdrawConnectHint();
}

// Small "connect wallet to autofill" link shown under the address field
// while no wallet is linked; disappears once one connects (see
// _onTonConnectChange, which re-renders this if the modal is still open).
function _renderTonWithdrawConnectHint() {
  const el = document.getElementById('ton-wd-connect-wrap');
  if (!el) return;
  const addr = typeof tcAddress === 'function' ? tcAddress() : null;
  el.innerHTML = addr ? '' : `<button style="background:none;border:none;color:#e5a546;font-size:12px;cursor:pointer;text-decoration:underline;padding:0" onclick="tcConnect()">${t('tcConnectBtn')}</button>`;
}

function _updateWdPreview() {
  const el = document.getElementById('gram-wd-preview');
  if (!el) return;
  const v = parseFloat(document.getElementById('gram-wd-amount')?.value);
  if (!v || v < 10) { el.textContent = ''; return; }
  const fee = Math.round(v * 0.10 * 100) / 100;
  const net = Math.round((v - fee) * 100) / 100;
  el.textContent = tVars('feeReceiveFmt', { fee, net });
}

function gramWithdrawConfirm() {
  const amount = parseFloat(document.getElementById('gram-wd-amount').value);
  const addr   = (document.getElementById('gram-wd-addr').value || '').trim();
  const balance = window._gramBalance || 0;
  if (!amount || amount < GRAM_MIN_WITHDRAW) {
    _gramModalMsg(tVars('minWithdrawToast', { n: GRAM_MIN_WITHDRAW }), 'err'); return;
  }
  if (!addr)                     { _gramModalMsg(t('enterTonAddrToast'), 'err'); return; }
  if (amount > balance)          { _gramModalMsg(t('notEnoughFundsToast'), 'err'); return; }
  if (typeof netGramWithdraw === 'function') {
    netGramWithdraw(amount, addr);
    closeGramModal();
    const net = Math.round((amount - amount * 0.10) * 100) / 100;
    _gramMsg(tVars('withdrawRequestCreatedFmt', { net }), 'ok');
  } else {
    _gramModalMsg(t('serviceUnavailableToast'), 'err');
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
