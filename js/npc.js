// ─────────────────────────────────────────────────────────
//  NPC DIALOG SYSTEM
// ─────────────────────────────────────────────────────────
function openNpc(npcId) {
  if (!npcId || !player) return;
  const def = NPC_DEF.find(n => n.id === npcId);
  if (!def) return;

  document.getElementById('npc-emoji-lbl').innerHTML = iconHTML(def.icon, 32, def.color);
  document.getElementById('npc-name-lbl').textContent  = def.name;
  document.getElementById('npc-desc-lbl').textContent  = def.desc;
  document.getElementById('npc-body').innerHTML = _buildNpcBody(npcId);
  const ov = document.getElementById('npc-overlay');
  ov.style.display = 'flex';
}

function closeNpc() {
  document.getElementById('npc-overlay').style.display = 'none';
}

function _buildNpcBody(npcId) {
  if (npcId === 'merchant') return _merchantBody();
  if (npcId === 'craftsman') return _craftsmanBody();
  if (npcId === 'storage') return _storageBody();
  return '';
}

// ── Merchant ────────────────────────────────────────────
function _potImg(entry, size) {
  if (entry.img) return `<img src="${entry.img}" width="${size}" height="${size}" style="image-rendering:pixelated;vertical-align:middle;border-radius:2px;">`;
  return iconHTML(entry.icon || 'potion', size, '#90d653');
}

function _merchantBody() {
  const p = player;
  const bag = p.potionBag || {};
  const total = (bag.pt1 || 0) + (bag.pt2 || 0);
  let html = `<div class="shop-gold">${iconHTML('coin',16,'#e3941d')} ${typeof t === 'function' ? t('npcGoldLbl') : 'Золото'}: <b>${p.gold}</b> · ${typeof t === 'function' ? t('npcHpPotionsLbl') : 'Зелий HP'}: <b>${total}/999</b></div>`;

  // HP potions
  html += '<div class="shop-sec">' + (typeof t === 'function' ? t('npcHealPotionsHdr') : 'Зелья лечения') + '</div><div class="shop-list">';
  MERCHANT_SHOP.filter(e => {
    const def = ITEM_DEF.find(d => d.id === e.itemId);
    return def && def.slot === 'use';
  }).forEach((entry, i) => {
    const idx = MERCHANT_SHOP.indexOf(entry);
    const cur = bag[entry.itemId] || 0;
    const canBuy = p.gold >= entry.price && cur < 999;
    html += `<div class="shop-row">
      <span class="shop-item-icon">${_potImg(entry, 22)}</span>
      <div class="shop-item-info">
        <span class="shop-item-name">${entry.name}</span>
        <span class="shop-item-stat">${entry.desc} · <b style="color:#90d653">×${cur}</b></span>
      </div>
      <button class="shop-btn${canBuy ? '' : ' disabled'}" onclick="buyPotion(${idx})">
        ${entry.price}${iconHTML('coin',14,'#e3941d')}
      </button>
    </div>`;
  });
  html += '</div>';
  return html;
}

function buyPotion(idx) {
  const entry = MERCHANT_SHOP[idx];
  if (!entry || !player) return;
  const def = ITEM_DEF.find(d => d.id === entry.itemId);
  if (!def) return;
  if (player.gold < entry.price) { _shopMsg(typeof t === 'function' ? t('npcNotEnoughGold') : 'Мало золота!'); return; }

  if (!player.potionBag) player.potionBag = { pt1: 0, pt2: 0 };
  const cur = player.potionBag[entry.itemId] || 0;
  if (cur >= 999) { _shopMsg(typeof t === 'function' ? t('npcMaxPotions') : 'Максимум 999 зелий!'); return; }
  player.gold -= entry.price;
  player.potionBag[entry.itemId] = cur + 1;
  if (typeof onBuyPotion === 'function') onBuyPotion();
  netSaveProgress();
  openNpc('merchant');
  _shopMsgOk((typeof t === 'function' ? t('npcBoughtPrefix') : '✓ Куплено: ') + def.name);
}

// ── Craftsman ───────────────────────────────────────────
let _craftsmanTab = 'items'; // 'items' | 'mats'

function _matIcon(mat, size) {
  if (!mat) return '?';
  if (mat.img) {
    return `<img src="${mat.img}" width="${size}" height="${size}" style="image-rendering:pixelated;vertical-align:middle;border-radius:2px;">`;
  }
  return iconHTML(mat.icon || '', size);
}

function _listMats() {
  const parts = [];
  CRAFT_MATS.forEach(m => {
    const n = countMaterial(m.id);
    if (n > 0) parts.push(_matIcon(m, 14) + '<span style="font-size:10px">×' + n + '</span>');
  });
  return parts.join(' ') || (typeof t === 'function' ? t('npcNone') : 'нет');
}

function _matAvailable(m) {
  if (m.minEnhance != null) return countEnhancedItem(m.id, m.minEnhance) >= m.n;
  return countMaterial(m.id) >= m.n;
}

function _setCraftsmanTab(tab) {
  _craftsmanTab = tab;
  document.getElementById('npc-body').innerHTML = _buildNpcBody('craftsman');
}

function _craftsmanBody() {
  const p = player;
  const tabs = `<div class="craft-tabs">
    <button class="craft-tab${_craftsmanTab==='items'?' active':''}" onclick="_setCraftsmanTab('items')">${typeof t === 'function' ? t('craftTabItems') : 'Предметы'}</button>
    <button class="craft-tab${_craftsmanTab==='mats'?' active':''}" onclick="_setCraftsmanTab('mats')">${typeof t === 'function' ? t('craftTabMats') : 'Материалы'}</button>
  </div>`;

  let html = `<div class="shop-gold">${iconHTML('coin',16,'#e3941d')} ${typeof t === 'function' ? t('npcGoldLbl') : 'Золото'}: <b>${p.gold}</b>
    &nbsp;·&nbsp; ${_nexumIconHtml(16)} Liberty: <b>${window._nexumBalance || 0}</b></div>`;
  html += tabs;
  html += _craftsmanTab === 'items' ? _craftsmanItemsTab() : _craftsmanMatsTab();
  return html;
}

function _craftsmanItemsTab() {
  const RARITIES = [
    { key:'uncommon',  label: typeof t === 'function' ? t('rarityGroupUncommon') : 'Необычные' },
    { key:'rare',      label: typeof t === 'function' ? t('rarityGroupRare') : 'Редкие' },
    { key:'epic',      label: typeof t === 'function' ? t('rarityGroupEpic') : 'Эпические' },
    { key:'legendary', label: typeof t === 'function' ? t('rarityGroupLegendary') : 'Легендарные' },
  ];

  let html = '<div class="craft-mats-info">' + (typeof t === 'function' ? t('craftRecipesPrefix') : 'Рецепты: ') + _listMats() + '</div>';

  RARITIES.forEach(r => {
    const entries = ITEM_CRAFT_RECIPES
      .map((rec, idx) => ({ rec, idx, item: rec.itemId ? ITEM_DEF.find(i => i.id === rec.itemId) : null }))
      .filter(({ item }) => item && item.rarity === r.key);
    if (!entries.length) return;

    const rc = RARITY_COLOR[r.key] || '#aea599';
    html += `<div class="craft-group-hdr" style="color:${rc}">${r.label}</div><div class="craft-items-grid">`;
    entries.forEach(({ rec, idx, item }) => {
      const canCraft = invHasSpace() &&
        rec.mats.every(m => _matAvailable(m)) &&
        player.gold >= (rec.goldCost || 0);
      const enhance = _craftResultEnhance(rec);
      const enhBadge = enhance ? `<span style="position:absolute;top:1px;right:3px;font-size:8px;color:#e69419;font-weight:bold">+${enhance}</span>` : '';
      html += `<div class="craft-item-cell${canCraft ? ' craftable' : ''}" onclick="openCraftModal(${idx})" style="border-color:${rc}66;position:relative">
        ${enhBadge}
        <div class="craft-item-cell-icon">${_itemIcon(item, 32)}</div>
        <div class="craft-item-cell-name" style="color:${rc}">${item.name}</div>
      </div>`;
    });
    html += '</div>';
  });

  return html;
}

// Crafting consumes 2 items enhanced to the recipe's minEnhance (e.g. +8) —
// the result comes out pre-enhanced 2 levels below that (+6), instead of
// starting back at +0. Shared by the preview (openCraftModal) and the
// actual craft (craftSpecificItem) so they always agree.
function _craftResultEnhance(rec) {
  const baseMat = rec.mats.find(m => m.minEnhance != null);
  return baseMat ? Math.max(0, baseMat.minEnhance - 2) : 0;
}
function _itemWithEnhance(item, enhance) {
  if (!enhance) return item;
  const b = enhanceBonus(item, enhance);
  return { ...item, atk: (item.atk || 0) + (b.atk || 0), def: (item.def || 0) + (b.def || 0), hp: (item.hp || 0) + (b.hp || 0) };
}

function openCraftModal(idx) {
  const rec = ITEM_CRAFT_RECIPES[idx];
  if (!rec || !player) return;
  const item = rec.itemId ? ITEM_DEF.find(i => i.id === rec.itemId) : null;
  const mat  = rec.matId  ? CRAFT_MATS.find(m => m.id === rec.matId)  : null;
  const resultDef = item || mat;
  if (!resultDef) return;
  const rc = RARITY_COLOR[resultDef.rarity] || '#aea599';
  const resultEnhance = item ? _craftResultEnhance(rec) : 0;

  const matsHtml = rec.mats.map(m => {
    if (m.minEnhance != null) {
      const iDef = ITEM_DEF.find(i => i.id === m.id);
      const have = countEnhancedItem(m.id, m.minEnhance);
      const ok = have >= m.n;
      const rc2 = iDef ? (RARITY_COLOR[iDef.rarity] || '#aea599') : '#aea599';
      return `<div class="craft-req-row">
        <span class="craft-req-icon">${iDef ? _itemIcon(iDef, 20) : m.id}</span>
        <span class="craft-req-name" style="color:${rc2}">${iDef ? iDef.name : m.id} <b style="color:#e69419">+${m.minEnhance}</b></span>
        <span class="craft-req-count" style="color:${ok ? '#98e456' : '#eb4e61'}">${have}/${m.n}</span>
      </div>`;
    }
    const matDef = CRAFT_MATS.find(c => c.id === m.id);
    const have = countMaterial(m.id);
    const ok = have >= m.n;
    return `<div class="craft-req-row">
      <span class="craft-req-icon">${matDef ? _matIcon(matDef, 20) : m.id}</span>
      <span class="craft-req-name">${matDef ? matDef.name : m.id}</span>
      <span class="craft-req-count" style="color:${ok ? '#98e456' : '#eb4e61'}">${have}/${m.n}</span>
    </div>`;
  }).join('');

  const goldRow = rec.goldCost ? `<div class="craft-req-row">
    <span class="craft-req-icon">${iconHTML('coin', 20, '#e3941d')}</span>
    <span class="craft-req-name">${typeof t === 'function' ? t('npcGoldLbl') : 'Золото'}</span>
    <span class="craft-req-count" style="color:${player.gold >= rec.goldCost ? '#98e456' : '#eb4e61'}">${player.gold}/${rec.goldCost}</span>
  </div>` : '';

  const canCraft = invHasSpace() &&
    rec.mats.every(m => _matAvailable(m)) &&
    player.gold >= (rec.goldCost || 0);

  const resultIconHtml = item ? _itemIcon(item, 52) : _matIcon(mat, 52);
  const statsHtml = item ? (statStr(_itemWithEnhance(item, resultEnhance)) || '—') : '';
  const enhBadge = resultEnhance ? ` <b style="color:#e69419">+${resultEnhance}</b>` : '';

  const _backTab = rec.matId ? 'mats' : 'items';
  document.getElementById('npc-body').innerHTML = `
    <button class="craft-back-btn" onclick="_setCraftsmanTab('${_backTab}')">${typeof t === 'function' ? t('craftBackBtn') : '← Назад'}</button>
    <div class="craft-detail-header">
      <div class="craft-detail-icon">${resultIconHtml}</div>
      <div class="craft-detail-info">
        <div class="craft-detail-name" style="color:${rc};text-shadow:0 0 8px ${rc}66">${resultDef.name}${enhBadge}</div>
        ${statsHtml ? `<div class="craft-detail-stats">${statsHtml}</div>` : ''}
      </div>
    </div>
    <div class="craft-reqs-title">${typeof t === 'function' ? t('craftRequiredLbl') : 'Требуется:'}</div>
    <div class="craft-reqs-list">${matsHtml}${goldRow}</div>
    <div class="craft-chance-row">${typeof t === 'function' ? t('craftChanceLbl') : 'Шанс успеха: '}<b style="color:#ebab4b">${Math.round(rec.chance * 100)}%</b></div>
    <button class="shop-btn craft-do-btn${canCraft ? '' : ' disabled'}" onclick="craftSpecificItem(${idx})">${typeof t === 'function' ? t('craftDoBtn') : 'Крафтить'}</button>
  `;
}

function craftSpecificItem(idx) {
  const rec = ITEM_CRAFT_RECIPES[idx];
  if (!rec || !player) return;

  for (const m of rec.mats) {
    if (!_matAvailable(m)) { _shopMsg(typeof t === 'function' ? t('craftNotEnoughMats') : 'Недостаточно материалов!'); return; }
  }
  if ((rec.goldCost || 0) > 0 && player.gold < rec.goldCost) {
    _shopMsg(typeof t === 'function' ? t('npcNotEnoughGold') : 'Мало золота!'); return;
  }
  if (!invHasSpace()) { _shopMsg(typeof t === 'function' ? t('invFull') : 'Инвентарь полон!'); return; }

  for (const m of rec.mats) {
    if (m.minEnhance != null) removeEnhancedItem(m.id, m.n, m.minEnhance);
    else removeFromInventory(m.id, m.n);
  }
  if (rec.goldCost) player.gold -= rec.goldCost;

  if (Math.random() < rec.chance) {
    if (rec.matId) {
      const mat = CRAFT_MATS.find(m => m.id === rec.matId);
      if (mat) { addToInventory({ ...mat }); _shopMsg((typeof t === 'function' ? t('craftCreatedPrefix') : '✓ Создано: ') + mat.name); }
    } else {
      const item = ITEM_DEF.find(i => i.id === rec.itemId);
      if (item) {
        const enhance = _craftResultEnhance(rec);
        addToInventory(enhance > 0 ? { ...item, enhance } : { ...item });
        _shopMsg((typeof t === 'function' ? t('craftCreatedPrefix') : '✓ Создано: ') + item.name + (enhance ? ' +' + enhance : ''));
      }
    }
  } else {
    _shopMsg(typeof t === 'function' ? t('craftFailMsg') : 'Провал! Материалы потеряны.');
  }
  netSaveProgress();
  openCraftModal(idx);
}

function _craftsmanMatsTab() {
  let html = '<div class="craft-group-hdr">' + (typeof t === 'function' ? t('craftRecipesHdr') : 'Рецепты') + '</div><div class="craft-items-grid">';
  MAT_UPGRADE_RECIPES.forEach((recipe, idx) => {
    const fromMat = CRAFT_MATS.find(m => m.id === recipe.from);
    const toMat   = CRAFT_MATS.find(m => m.id === recipe.to);
    if (!fromMat || !toMat) return;
    const have = countMaterial(recipe.from);
    const canCraft = have >= recipe.count && invHasSpace();
    const rc = RARITY_COLOR[toMat.rarity] || '#aea599';
    html += `<div class="craft-item-cell${canCraft ? ' craftable' : ''}" onclick="openMatModal(${idx})" style="border-color:${rc}66">
      <div class="craft-item-cell-icon">${_matIcon(toMat, 32)}</div>
      <div class="craft-item-cell-name" style="color:${rc}">${toMat.name}</div>
    </div>`;
  });
  html += '</div>';

  const stoneEntries = ITEM_CRAFT_RECIPES
    .map((rec, idx) => ({ rec, idx }))
    .filter(({ rec }) => rec.matId);
  if (stoneEntries.length) {
    html += `<div class="craft-group-hdr" style="color:#ebab4b">${typeof t === 'function' ? t('craftEnchantStonesHdr') : 'Камни заточки'}</div><div class="craft-items-grid">`;
    stoneEntries.forEach(({ rec, idx }) => {
      const mat = CRAFT_MATS.find(m => m.id === rec.matId);
      if (!mat) return;
      const rc = RARITY_COLOR[mat.rarity] || '#aea599';
      const canCraft = invHasSpace() &&
        rec.mats.every(m => _matAvailable(m)) &&
        player.gold >= (rec.goldCost || 0);
      html += `<div class="craft-item-cell${canCraft ? ' craftable' : ''}" onclick="openCraftModal(${idx})" style="border-color:${rc}66">
        <div class="craft-item-cell-icon">${_matIcon(mat, 32)}</div>
        <div class="craft-item-cell-name" style="color:${rc}">${mat.name}</div>
      </div>`;
    });
    html += '</div>';
  }

  if (typeof BOX_DEF !== 'undefined' && BOX_DEF.length) {
    html += `<div class="craft-group-hdr" style="color:#e5a546">${typeof t === 'function' ? t('craftBoxesHdr') : 'Боксы'}</div><div class="craft-items-grid">`;
    BOX_DEF.forEach(box => {
      const have = countMaterial(box.keyId);
      const canCraft = have >= box.keyCost && invHasSpace();
      const rc = RARITY_COLOR[box.rarity] || '#aea599';
      html += `<div class="craft-item-cell${canCraft ? ' craftable' : ''}" onclick="openBoxCraftModal('${box.id}')" style="border-color:${rc}66">
        <div class="craft-item-cell-icon">${_itemIcon(box, 32)}</div>
        <div class="craft-item-cell-name" style="color:${rc}">${box.name}</div>
      </div>`;
    });
    html += '</div>';
  }

  if (typeof PET_CRAFT_RECIPES !== 'undefined' && PET_CRAFT_RECIPES.length) {
    const nexumBal = window._nexumBalance || 0;
    html += `<div class="craft-group-hdr" style="color:#89ba5f">${typeof t === 'function' ? t('craftPetsHdr') : 'Питомцы'}</div><div class="craft-items-grid">`;
    PET_CRAFT_RECIPES.forEach((rec, idx) => {
      const pets = _petsOfRarity(rec.rarity);
      if (!pets.length) return;
      const rc = RARITY_COLOR[rec.rarity] || '#aea599';
      const canCraft = invHasSpace() && nexumBal >= (rec.nexumCost || 0);
      html += `<div class="craft-item-cell${canCraft ? ' craftable' : ''}" onclick="openPetCraftModal(${idx})" style="border-color:${rc}66">
        <div class="craft-item-cell-icon">${_itemIcon(pets[0], 32)}</div>
        <div class="craft-item-cell-name" style="color:${rc}">${_RARITY_NAMES[rec.rarity] || rec.rarity}</div>
      </div>`;
    });
    html += '</div>';
  }

  return html;
}

// ── Pet crafting (Liberty/Nexum-only; result is random among that rarity's
// 3 skins — see PET_CRAFT_RECIPES/ITEM_DEF slot:'pet' in
// shared/definitions.js). Nexum is server-authoritative (unlike gold, which
// every other craft here spends client-side), so this is the one craft flow
// that's a real round-trip: craftPet() just asks the server and waits, the
// item + new balance only ever come from onPetCrafted/onPetCraftError below
// (see netCraftPet/'petCrafted'/'petCraftError' in js/network.js).
function _petsOfRarity(rarity) {
  return ITEM_DEF.filter(d => d.slot === 'pet' && d.rarity === rarity);
}
function _nexumIconHtml(size) {
  return `<img src="/images/nexum-coin_v2.png" width="${size}" height="${size}" style="vertical-align:middle;border-radius:50%">`;
}

let _pendingPetCraftIdx = null; // recipe idx awaiting a server response

function openPetCraftModal(idx) {
  const rec = PET_CRAFT_RECIPES[idx];
  if (!rec || !player) return;
  const pets = _petsOfRarity(rec.rarity);
  if (!pets.length) return;
  const rc = RARITY_COLOR[rec.rarity] || '#aea599';
  const nexumBal = window._nexumBalance || 0;
  const pending = _pendingPetCraftIdx === idx;

  const candidatesHtml = pets.map(p => `
    <div style="text-align:center;flex:1">
      <div>${_itemIcon(p, 44)}</div>
      <div style="font-size:11px;color:${rc};margin-top:2px">${p.name}</div>
    </div>`).join('');

  const costRow = `<div class="craft-req-row">
    <span class="craft-req-icon">${_nexumIconHtml(20)}</span>
    <span class="craft-req-name">Liberty</span>
    <span class="craft-req-count" style="color:${nexumBal >= rec.nexumCost ? '#98e456' : '#eb4e61'}">${nexumBal}/${rec.nexumCost}</span>
  </div>`;

  const canCraft = !pending && invHasSpace() && nexumBal >= (rec.nexumCost || 0);

  document.getElementById('npc-body').innerHTML = `
    <button class="craft-back-btn" onclick="_setCraftsmanTab('mats')">${typeof t === 'function' ? t('craftBackBtn') : '← Назад'}</button>
    <div class="craft-detail-header">
      <div class="craft-detail-info">
        <div class="craft-detail-name" style="color:${rc};text-shadow:0 0 8px ${rc}66">${_RARITY_NAMES[rec.rarity] || rec.rarity}</div>
        <div class="craft-detail-stats">${typeof t === 'function' ? t('craftPetPickOneOf') : 'Один случайный из 3'}</div>
      </div>
    </div>
    <div style="display:flex;gap:6px;margin:8px 0">${candidatesHtml}</div>
    <div class="craft-reqs-title">${typeof t === 'function' ? t('craftRequiredLbl') : 'Требуется:'}</div>
    <div class="craft-reqs-list">${costRow}</div>
    <button class="shop-btn craft-do-btn${canCraft ? '' : ' disabled'}" onclick="craftPet(${idx})">${pending ? (typeof t === 'function' ? t('listingBusyLbl') : '...') : (typeof t === 'function' ? t('craftDoBtn') : 'Крафтить')}</button>
  `;
}

function craftPet(idx) {
  const rec = PET_CRAFT_RECIPES[idx];
  if (!rec || !player || _pendingPetCraftIdx !== null) return;
  if (!netIsLive()) { _shopMsg(typeof t === 'function' ? t('noServerConn') : 'Нет соединения с сервером'); return; }
  if ((window._nexumBalance || 0) < (rec.nexumCost || 0)) { _shopMsg('Недостаточно Liberty!'); return; }
  if (!invHasSpace()) { _shopMsg(typeof t === 'function' ? t('invFull') : 'Инвентарь полон!'); return; }

  _pendingPetCraftIdx = idx;
  openPetCraftModal(idx); // re-render with the button disabled/busy
  netCraftPet(rec.rarity);
}

function onPetCrafted(pet) {
  const idx = _pendingPetCraftIdx;
  _pendingPetCraftIdx = null;
  if (pet) {
    addToInventory({ ...pet });
    if (typeof updateInvUI === 'function') updateInvUI();
    _shopMsg((typeof t === 'function' ? t('craftCreatedPrefix') : '✓ Создано: ') + pet.name);
  } else {
    _shopMsg(typeof t === 'function' ? t('craftFailMsg') : 'Провал! Материалы потеряны.');
  }
  if (idx !== null) openPetCraftModal(idx);
}

function onPetCraftError(msg) {
  const idx = _pendingPetCraftIdx;
  _pendingPetCraftIdx = null;
  _shopMsg(msg || (typeof t === 'function' ? t('genericErrorLbl') : 'Ошибка'));
  if (idx !== null) openPetCraftModal(idx);
}

function openBoxCraftModal(boxId) {
  const box = BOX_DEF.find(b => b.id === boxId);
  if (!box || !player) return;
  const keyDef = CRAFT_MATS.find(m => m.id === box.keyId);
  const have = countMaterial(box.keyId);
  const ok = have >= box.keyCost;
  const canCraft = ok && invHasSpace();
  const rc = RARITY_COLOR[box.rarity] || '#aea599';

  const oddsHtml = box.odds.map(o => {
    const rcO = RARITY_COLOR[o.rarity] || '#aea599';
    return `<div class="craft-req-row">
      <span class="craft-req-name" style="color:${rcO}">${_RARITY_NAMES[o.rarity] || o.rarity}</span>
      <span class="craft-req-count" style="color:${rcO}">${Math.round(o.chance * 100)}%</span>
    </div>`;
  }).join('');

  document.getElementById('npc-body').innerHTML = `
    <button class="craft-back-btn" onclick="_setCraftsmanTab('mats')">${typeof t === 'function' ? t('craftBackBtn') : '← Назад'}</button>
    <div class="craft-detail-header">
      <div class="craft-detail-icon">${_itemIcon(box, 52)}</div>
      <div class="craft-detail-info">
        <div class="craft-detail-name" style="color:${rc};text-shadow:0 0 8px ${rc}66">${box.name}</div>
      </div>
    </div>
    <div class="craft-reqs-title">${typeof t === 'function' ? t('craftRequiredLbl') : 'Требуется:'}</div>
    <div class="craft-reqs-list">
      <div class="craft-req-row">
        <span class="craft-req-icon">${keyDef ? _matIcon(keyDef, 20) : box.keyId}</span>
        <span class="craft-req-name">${keyDef ? keyDef.name : box.keyId}</span>
        <span class="craft-req-count" style="color:${ok ? '#98e456' : '#eb4e61'}">${have}/${box.keyCost}</span>
      </div>
    </div>
    <div class="craft-reqs-title">${typeof t === 'function' ? t('craftBoxContentsLbl') : 'Содержимое (1 предмет из бокса):'}</div>
    <div class="craft-reqs-list">${oddsHtml}</div>
    <button class="shop-btn craft-do-btn${canCraft ? '' : ' disabled'}" onclick="craftBox('${box.id}')">${typeof t === 'function' ? t('craftDoBtn') : 'Крафтить'}</button>
  `;
}

function craftBox(boxId) {
  const box = BOX_DEF.find(b => b.id === boxId);
  if (!box || !player) return;
  const have = countMaterial(box.keyId);
  if (have < box.keyCost) { _shopMsg(typeof t === 'function' ? t('craftNotEnoughKeys') : 'Недостаточно ключей!'); return; }
  if (!invHasSpace())     { _shopMsg(typeof t === 'function' ? t('invFull') : 'Инвентарь полон!'); return; }

  removeFromInventory(box.keyId, box.keyCost);
  addToInventory({ ...box });
  _shopMsg((typeof t === 'function' ? t('craftCreatedPrefix') : '✓ Создано: ') + box.name);
  netSaveProgress();
  openBoxCraftModal(boxId);
}

function openMatModal(idx) {
  const recipe = MAT_UPGRADE_RECIPES[idx];
  if (!recipe || !player) return;
  const fromMat = CRAFT_MATS.find(m => m.id === recipe.from);
  const toMat   = CRAFT_MATS.find(m => m.id === recipe.to);
  if (!fromMat || !toMat) return;

  const have = countMaterial(recipe.from);
  const ok = have >= recipe.count;
  const canCraft = ok && invHasSpace();
  const rcTo = RARITY_COLOR[toMat.rarity] || '#aea599';

  document.getElementById('npc-body').innerHTML = `
    <button class="craft-back-btn" onclick="_setCraftsmanTab('mats')">${typeof t === 'function' ? t('craftBackBtn') : '← Назад'}</button>
    <div class="craft-detail-header">
      <div class="craft-detail-icon">${_matIcon(toMat, 52)}</div>
      <div class="craft-detail-info">
        <div class="craft-detail-name" style="color:${rcTo};text-shadow:0 0 8px ${rcTo}66">${toMat.name}</div>
      </div>
    </div>
    <div class="craft-reqs-title">${typeof t === 'function' ? t('craftRequiredLbl') : 'Требуется:'}</div>
    <div class="craft-reqs-list">
      <div class="craft-req-row">
        <span class="craft-req-icon">${_matIcon(fromMat, 20)}</span>
        <span class="craft-req-name">${fromMat.name}</span>
        <span class="craft-req-count" style="color:${ok ? '#98e456' : '#eb4e61'}">${have}/${recipe.count}</span>
      </div>
    </div>
    <div class="craft-chance-row">${typeof t === 'function' ? t('craftChanceLbl') : 'Шанс успеха: '}<b style="color:#ebab4b">${Math.round(recipe.chance * 100)}%</b></div>
    <button class="shop-btn craft-do-btn${canCraft ? '' : ' disabled'}" onclick="craftMatUpgrade(${idx})">${typeof t === 'function' ? t('craftDoBtn') : 'Крафтить'}</button>
  `;
}

function craftMatUpgrade(idx) {
  const recipe = MAT_UPGRADE_RECIPES[idx];
  if (!recipe || !player) return;
  const fromHave = countMaterial(recipe.from);
  if (fromHave < recipe.count)  { _shopMsg(typeof t === 'function' ? t('craftNotEnoughMats') : 'Недостаточно материалов!'); return; }
  if (!invHasSpace())           { _shopMsg(typeof t === 'function' ? t('invFull') : 'Инвентарь полон!'); return; }

  removeFromInventory(recipe.from, recipe.count);

  if (Math.random() < recipe.chance) {
    const mat = CRAFT_MATS.find(m => m.id === recipe.to);
    if (mat) {
      addToInventory({ ...mat });
      _shopMsg((typeof t === 'function' ? t('craftReceivedPrefix') : '✓ Получено: ') + mat.name);
    }
  } else {
    _shopMsg(typeof t === 'function' ? t('craftFailMsg') : 'Провал! Материалы потеряны.');
  }
  netSaveProgress();
  openMatModal(idx);
}

// ── Storage ─────────────────────────────────────────────
let _storageTab = 'inv'; // 'inv' | 'storage'

function _setStorageTab(tab) {
  _storageTab = tab;
  document.getElementById('npc-body').innerHTML = _buildNpcBody('storage');
}

function _storageBody() {
  const tabs = `<div class="craft-tabs">
    <button class="craft-tab${_storageTab==='inv'?' active':''}" onclick="_setStorageTab('inv')">${typeof t === 'function' ? t('storageInvTab') : 'Инвентарь'} (${invSlotCount()}/150)</button>
    <button class="craft-tab${_storageTab==='storage'?' active':''}" onclick="_setStorageTab('storage')">${typeof t === 'function' ? t('storageStorageTab') : 'Хранилище'} (${storageSlotCount()}/200)</button>
  </div>`;
  return tabs + (_storageTab === 'inv' ? _storageInvTab() : _storageStoTab());
}

function _storageItemCell(it, idx, onclickFn) {
  const rc = RARITY_COLOR[it.rarity] || '#aea599';
  const cnt = it.qty > 1 ? `<span style="position:absolute;bottom:1px;right:2px;font-size:7px;color:#cfc0ad;font-weight:bold">×${it.qty}</span>` : '';
  const enh = it.enhance ? `<span style="position:absolute;top:1px;right:3px;font-size:8px;color:#e69419;font-weight:bold">+${it.enhance}</span>` : '';
  return `<div class="craft-item-cell craftable" style="border-color:${rc}66;position:relative" onclick="${onclickFn}(${idx})" title="${it.name}">
    ${enh}${cnt}
    <div class="craft-item-cell-icon">${_itemIcon(it, 32)}</div>
    <div class="craft-item-cell-name" style="color:${rc}">${it.name}</div>
  </div>`;
}

function _storageInvTab() {
  if (!player.inventory.length) return '<div class="craft-mats-info">' + (typeof t === 'function' ? t('storageInvEmpty') : 'Инвентарь пуст') + '</div>';
  let html = '<div class="craft-mats-info">' + (typeof t === 'function' ? t('storageTapToStore') : 'Нажмите на предмет, чтобы положить в хранилище') + '</div><div class="craft-items-grid">';
  player.inventory.forEach((it, idx) => { html += _storageItemCell(it, idx, '_doMoveToStorage'); });
  html += '</div>';
  return html;
}

function _storageStoTab() {
  if (!player.storage.length) return '<div class="craft-mats-info">' + (typeof t === 'function' ? t('storageEmpty') : 'Хранилище пусто') + '</div>';
  let html = '<div class="craft-mats-info">' + (typeof t === 'function' ? t('storageTapToTake') : 'Нажмите на предмет, чтобы забрать') + '</div><div class="craft-items-grid">';
  player.storage.forEach((it, idx) => { html += _storageItemCell(it, idx, '_doMoveToInventory'); });
  html += '</div>';
  return html;
}

function _doMoveToStorage(idx) {
  if (!player) return;
  if (!moveToStorage(idx)) { _shopMsg(typeof t === 'function' ? t('storageFull') : 'Хранилище полно!'); return; }
  netSaveProgress();
  document.getElementById('npc-body').innerHTML = _buildNpcBody('storage');
}

function _doMoveToInventory(idx) {
  if (!player) return;
  if (!moveToInventory(idx)) { _shopMsg(typeof t === 'function' ? t('invFull') : 'Инвентарь полон!'); return; }
  netSaveProgress();
  document.getElementById('npc-body').innerHTML = _buildNpcBody('storage');
}

function _shopMsg(msg) {
  const body = document.getElementById('npc-body');
  const el = document.createElement('div');
  el.className = 'shop-msg';
  el.textContent = msg;
  body.insertBefore(el, body.firstChild);
  setTimeout(() => el.remove(), 2500);
}

function _shopMsgOk(msg) {
  const body = document.getElementById('npc-body');
  const el = document.createElement('div');
  el.className = 'shop-msg shop-msg-ok';
  el.textContent = msg;
  body.insertBefore(el, body.firstChild);
  setTimeout(() => el.remove(), 2000);
}
