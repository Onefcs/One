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
  if (npcId === 'shopkeeper') return _shopkeeperBody();
  return '';
}

// ── Merchant ────────────────────────────────────────────
function _merchantBody() {
  const p = player;
  const bag = p.potionBag || {};
  const total = (bag.pt1 || 0) + (bag.pt2 || 0);
  let html = `<div class="shop-gold">${iconHTML('coin',16,'#f1c40f')} Золото: <b>${p.gold}</b> · ${iconHTML('potion',16,'#3ef07a')} Зелий: <b>${total}/999</b></div>`;
  html += '<div class="shop-sec">Зелья</div><div class="shop-list">';
  MERCHANT_SHOP.forEach((entry, idx) => {
    const cur = bag[entry.itemId] || 0;
    const canBuy = p.gold >= entry.price && cur < 999;
    html += `<div class="shop-row">
      <span class="shop-item-icon">${iconHTML(entry.icon, 22)}</span>
      <div class="shop-item-info">
        <span class="shop-item-name">${entry.name}</span>
        <span class="shop-item-stat">${entry.desc} · <b style="color:#3ef07a">×${cur}</b></span>
      </div>
      <button class="shop-btn${canBuy ? '' : ' disabled'}" onclick="buyPotion(${idx})">
        ${entry.price}${iconHTML('coin',14,'#f1c40f')}
      </button>
    </div>`;
  });
  html += '</div>';
  return html;
}

function buyPotion(idx) {
  const entry = MERCHANT_SHOP[idx];
  if (!entry || !player) return;
  if (!player.potionBag) player.potionBag = { pt1: 0, pt2: 0 };
  const cur = player.potionBag[entry.itemId] || 0;
  if (cur >= 999)              { _shopMsg('Максимум 999 зелий!'); return; }
  if (player.gold < entry.price) { _shopMsg('Мало золота!'); return; }
  player.gold -= entry.price;
  player.potionBag[entry.itemId] = cur + 1;
  if (typeof onBuyPotion === 'function') onBuyPotion();
  netSaveProgress();
  openNpc('merchant');
}

// ── Craftsman ───────────────────────────────────────────
let _craftsmanTab = 'items'; // 'items' | 'mats'

function _matIcon(mat, size) {
  if (!mat) return '?';
  if (mat.img) {
    const rc = RARITY_COLOR[mat.rarity] || '#aaa';
    return `<img src="${mat.img}" width="${size}" height="${size}" style="image-rendering:pixelated;vertical-align:middle;border-radius:2px;outline:1px solid ${rc}66">`;
  }
  return iconHTML(mat.icon || '', size);
}

function _listMats() {
  const parts = [];
  CRAFT_MATS.forEach(m => {
    const n = player.inventory.filter(i => i.id === m.id).length;
    if (n > 0) parts.push(_matIcon(m, 14) + '<span style="font-size:10px">×' + n + '</span>');
  });
  return parts.join(' ') || 'нет';
}

function _setCraftsmanTab(tab) {
  _craftsmanTab = tab;
  document.getElementById('npc-body').innerHTML = _buildNpcBody('craftsman');
}

function _craftsmanBody() {
  const p = player;
  const tabs = `<div class="craft-tabs">
    <button class="craft-tab${_craftsmanTab==='items'?' active':''}" onclick="_setCraftsmanTab('items')">Предметы</button>
    <button class="craft-tab${_craftsmanTab==='mats'?' active':''}" onclick="_setCraftsmanTab('mats')">Материалы</button>
  </div>`;

  let html = `<div class="shop-gold">${iconHTML('coin',16,'#f1c40f')} Золото: <b>${p.gold}</b></div>`;
  html += tabs;
  html += _craftsmanTab === 'items' ? _craftsmanItemsTab() : _craftsmanMatsTab();
  return html;
}

function _craftsmanItemsTab() {
  const RARITIES = [
    { key:'common',    label:'Обычные'    },
    { key:'uncommon',  label:'Необычные'  },
    { key:'rare',      label:'Редкие'     },
    { key:'epic',      label:'Эпические'  },
    { key:'legendary', label:'Легендарные'},
  ];

  let html = '<div class="craft-mats-info">Инвентарь: ' + _listMats() + '</div>';

  RARITIES.forEach(r => {
    const entries = ITEM_CRAFT_RECIPES
      .map((rec, idx) => ({ rec, idx, item: ITEM_DEF.find(i => i.id === rec.itemId) }))
      .filter(({ item }) => item && item.rarity === r.key);
    if (!entries.length) return;

    const rc = RARITY_COLOR[r.key] || '#aaa';
    html += `<div class="craft-group-hdr" style="color:${rc}">${r.label}</div><div class="craft-items-grid">`;
    entries.forEach(({ rec, idx, item }) => {
      const canCraft = player.inventory.length < 50 &&
        rec.mats.every(m => player.inventory.filter(i => i.id === m.id).length >= m.n);
      html += `<div class="craft-item-cell${canCraft ? ' craftable' : ''}" onclick="openCraftModal(${idx})" style="border-color:${rc}66">
        <div class="craft-item-cell-icon">${_itemIcon(item, 32)}</div>
        <div class="craft-item-cell-name" style="color:${rc}">${item.name}</div>
      </div>`;
    });
    html += '</div>';
  });

  return html;
}

function openCraftModal(idx) {
  const rec = ITEM_CRAFT_RECIPES[idx];
  if (!rec || !player) return;
  const item = ITEM_DEF.find(i => i.id === rec.itemId);
  if (!item) return;
  const rc = RARITY_COLOR[item.rarity] || '#aaa';

  const matsHtml = rec.mats.map(m => {
    const matDef = CRAFT_MATS.find(c => c.id === m.id);
    const have = player.inventory.filter(i => i.id === m.id).length;
    const ok = have >= m.n;
    return `<div class="craft-req-row">
      <span class="craft-req-icon">${matDef ? _matIcon(matDef, 20) : m.id}</span>
      <span class="craft-req-name">${matDef ? matDef.name : m.id}</span>
      <span class="craft-req-count" style="color:${ok ? '#4f4' : '#f44'}">${have}/${m.n}</span>
    </div>`;
  }).join('');

  const canCraft = player.inventory.length < 50 &&
    rec.mats.every(m => player.inventory.filter(i => i.id === m.id).length >= m.n);
  const stats = statStr(item);

  document.getElementById('npc-body').innerHTML = `
    <button class="craft-back-btn" onclick="_setCraftsmanTab('items')">← Назад</button>
    <div class="craft-detail-header">
      <div class="craft-detail-icon">${_itemIcon(item, 52)}</div>
      <div class="craft-detail-info">
        <div class="craft-detail-name" style="color:${rc};text-shadow:0 0 8px ${rc}66">${item.name}</div>
        <div class="craft-detail-stats">${stats || '—'}</div>
      </div>
    </div>
    <div class="craft-reqs-title">Требуется:</div>
    <div class="craft-reqs-list">${matsHtml}</div>
    <div class="craft-chance-row">Шанс успеха: <b style="color:#ffd040">${Math.round(rec.chance * 100)}%</b></div>
    <button class="shop-btn craft-do-btn${canCraft ? '' : ' disabled'}" onclick="craftSpecificItem(${idx})">Крафтить</button>
  `;
}

function craftSpecificItem(idx) {
  const rec = ITEM_CRAFT_RECIPES[idx];
  if (!rec || !player) return;

  for (const m of rec.mats) {
    if (player.inventory.filter(i => i.id === m.id).length < m.n) {
      _shopMsg('Недостаточно материалов!'); return;
    }
  }
  if (player.inventory.length >= 50) { _shopMsg('Инвентарь полон!'); return; }

  for (const m of rec.mats) {
    let need = m.n;
    player.inventory = player.inventory.filter(i => {
      if (i.id === m.id && need > 0) { need--; return false; }
      return true;
    });
  }

  const item = ITEM_DEF.find(i => i.id === rec.itemId);
  if (Math.random() < rec.chance) {
    player.inventory.push({ ...item });
    _shopMsg('✓ Создано: ' + item.name);
  } else {
    _shopMsg('Провал! Материалы потеряны.');
  }
  netSaveProgress();
  openCraftModal(idx);
}

function _craftsmanMatsTab() {
  const RARITY_SHORT = { uncommon:'Необыч.', rare:'Редк.', epic:'Эпич.', legendary:'Легенд.' };
  const GROUPS = [
    { label:'Кость',   fromIds:['bonec','boneu','boner','bonee'] },
    { label:'Уголь',   fromIds:['coalc','coalu','coalr','coale'] },
    { label:'Руда',    fromIds:['orec', 'oreu', 'orer', 'oree' ] },
    { label:'Шкура',   fromIds:['skinc','skinu','skinr','skine'] },
    { label:'Рецепты', fromIds:['recu', 'recr', 'rece'         ] },
  ];

  let html = '';
  GROUPS.forEach(g => {
    html += `<div class="craft-group-hdr">${g.label}</div><div class="craft-items-grid">`;
    MAT_UPGRADE_RECIPES.forEach((recipe, idx) => {
      if (!g.fromIds.includes(recipe.from)) return;
      const fromMat = CRAFT_MATS.find(m => m.id === recipe.from);
      const toMat   = CRAFT_MATS.find(m => m.id === recipe.to);
      if (!fromMat || !toMat) return;
      const have = player.inventory.filter(i => i.id === recipe.from).length;
      const canCraft = have >= recipe.count && player.inventory.length < 50;
      const rc = RARITY_COLOR[toMat.rarity] || '#aaa';
      html += `<div class="craft-item-cell${canCraft ? ' craftable' : ''}" onclick="openMatModal(${idx})" style="border-color:${rc}66">
        <div class="craft-item-cell-icon">${_matIcon(toMat, 32)}</div>
        <div class="craft-item-cell-name" style="color:${rc}">${toMat.name.split(' ').slice(1).join(' ') || toMat.name}</div>
      </div>`;
    });
    html += '</div>';
  });

  return html;
}

function openMatModal(idx) {
  const recipe = MAT_UPGRADE_RECIPES[idx];
  if (!recipe || !player) return;
  const fromMat = CRAFT_MATS.find(m => m.id === recipe.from);
  const toMat   = CRAFT_MATS.find(m => m.id === recipe.to);
  if (!fromMat || !toMat) return;

  const have = player.inventory.filter(i => i.id === recipe.from).length;
  const ok = have >= recipe.count;
  const canCraft = ok && player.inventory.length < 50;
  const rcTo = RARITY_COLOR[toMat.rarity] || '#aaa';

  document.getElementById('npc-body').innerHTML = `
    <button class="craft-back-btn" onclick="_setCraftsmanTab('mats')">← Назад</button>
    <div class="craft-detail-header">
      <div class="craft-detail-icon">${_matIcon(fromMat, 48)}</div>
      <div class="craft-detail-info">
        <div class="craft-detail-name" style="color:#aaa">${fromMat.name}</div>
        <div style="font-size:18px;color:#555;line-height:1.4">↓</div>
        <div class="craft-detail-name" style="color:${rcTo};text-shadow:0 0 8px ${rcTo}66">${toMat.name}</div>
      </div>
    </div>
    <div class="craft-reqs-title">Требуется:</div>
    <div class="craft-reqs-list">
      <div class="craft-req-row">
        <span class="craft-req-icon">${_matIcon(fromMat, 20)}</span>
        <span class="craft-req-name">${fromMat.name}</span>
        <span class="craft-req-count" style="color:${ok ? '#4f4' : '#f44'}">${have}/${recipe.count}</span>
      </div>
    </div>
    <div class="craft-chance-row">Шанс успеха: <b style="color:#ffd040">${Math.round(recipe.chance * 100)}%</b></div>
    <button class="shop-btn craft-do-btn${canCraft ? '' : ' disabled'}" onclick="craftMatUpgrade(${idx})">Крафтить</button>
  `;
}

function craftMatUpgrade(idx) {
  const recipe = MAT_UPGRADE_RECIPES[idx];
  if (!recipe || !player) return;
  const fromHave = player.inventory.filter(i => i.id === recipe.from).length;
  if (fromHave < recipe.count)       { _shopMsg('Недостаточно материалов!'); return; }
  if (player.inventory.length >= 50) { _shopMsg('Инвентарь полон!'); return; }

  let needed = recipe.count;
  player.inventory = player.inventory.filter(i => {
    if (i.id === recipe.from && needed > 0) { needed--; return false; }
    return true;
  });

  if (Math.random() < recipe.chance) {
    const mat = CRAFT_MATS.find(m => m.id === recipe.to);
    if (mat) {
      player.inventory.push({ ...mat });
      _shopMsg('✓ Получено: ' + mat.name);
    }
  } else {
    _shopMsg('Провал! Материалы потеряны.');
  }
  netSaveProgress();
  openMatModal(idx);
}

// ── Shopkeeper ──────────────────────────────────────────
function _shopkeeperBody() {
  const p = player;
  let html = `<div class="shop-gold">${iconHTML('coin',16,'#f1c40f')} Золото: <b>${p.gold}</b> · Инвентарь: <b>${p.inventory.length}/50</b></div>`;
  html += '<div class="shop-sec">Товары</div><div class="shop-list">';
  SHOP_CATALOG.forEach(entry => {
    const item = ITEM_DEF.find(i => i.id === entry.itemId);
    if (!item) return;
    const rc = RARITY_COLOR[item.rarity] || '#aaa';
    const canBuy = p.gold >= entry.price && p.inventory.length < 50;
    const stats = statStr(item);
    html += `<div class="shop-row">
      <span class="shop-item-icon">${_itemIcon(item, 28)}</span>
      <div class="shop-item-info">
        <div class="shop-item-name" style="color:${rc};text-shadow:-1px -1px 0 #000c,1px -1px 0 #000c,-1px 1px 0 #000c,1px 1px 0 #000c,0 0 8px ${rc}88">${item.name}</div>
        <div class="shop-item-stat">${stats}</div>
      </div>
      <button class="shop-btn${canBuy ? '' : ' disabled'}" onclick="buyShopItem('${entry.itemId}',${entry.price})">
        ${entry.price}${iconHTML('coin',14,'#f1c40f')}
      </button>
    </div>`;
  });
  html += '</div>';
  return html;
}

function buyShopItem(itemId, price) {
  if (!player) return;
  const item = ITEM_DEF.find(i => i.id === itemId);
  if (!item) return;
  if (player.gold < price)           { _shopMsg('Мало золота!'); return; }
  if (player.inventory.length >= 50) { _shopMsg('Инвентарь полон!'); return; }
  player.gold -= price;
  player.inventory.push({ ...item });
  netSaveProgress();
  openNpc('shopkeeper');
}

function _shopMsg(msg) {
  const body = document.getElementById('npc-body');
  const el = document.createElement('div');
  el.className = 'shop-msg';
  el.textContent = msg;
  body.insertBefore(el, body.firstChild);
  setTimeout(() => el.remove(), 2500);
}
