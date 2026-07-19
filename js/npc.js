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
  const RARITY_LABEL = { uncommon:'Необычные', rare:'Редкие', epic:'Эпические', legendary:'Легендарные' };
  const matIds = id => CRAFT_MATS.filter(m => m.slot === 'material' && m.rarity === id).map(m => m.id);

  let html = '<div class="craft-mats-info">Инвентарь: ' + _listMats() + '</div>';
  html += '<div class="shop-list">';

  ITEM_CRAFT_TIERS.forEach((tier, idx) => {
    const rc = RARITY_COLOR[tier.rarity] || '#aaa';
    const mIds = matIds(tier.rarity);
    const matHave = player.inventory.filter(i => mIds.includes(i.id)).length;
    const recHave = player.inventory.filter(i => i.id === tier.recipeId).length;
    const recMat  = CRAFT_MATS.find(m => m.id === tier.recipeId);
    const canCraft = matHave >= tier.matCount && recHave >= tier.recipeCount && player.inventory.length < 50;

    html += `<div class="shop-row craft-tier-row">
      <div class="shop-item-info" style="flex:1;min-width:0">
        <div class="shop-item-name" style="color:${rc}">${RARITY_LABEL[tier.rarity] || tier.rarity} предмет</div>
        <div class="shop-item-stat">
          Матер.: <b style="color:${matHave>=tier.matCount?'#4f4':'#f44'}">${matHave}/${tier.matCount}</b> ·
          Рецепт: <b style="color:${recHave>=tier.recipeCount?'#4f4':'#f44'}">${recHave}/${tier.recipeCount}</b> ·
          Шанс 30%
        </div>
      </div>
      <button class="shop-btn${canCraft?'':' disabled'}" onclick="craftItemByTier(${idx})">Крафт</button>
    </div>`;
  });

  html += '</div>';
  return html;
}

function _craftsmanMatsTab() {
  const GROUP = [
    { label:'Кость',  ids:['bonec','boneu','boner','bonee','bonel'] },
    { label:'Уголь',  ids:['coalc','coalu','coalr','coale','coall'] },
    { label:'Руда',   ids:['orec', 'oreu', 'orer', 'oree', 'orel' ] },
    { label:'Шкура',  ids:['skinc','skinu','skinr','skine','skinl'] },
    { label:'Рецепты',ids:['recu', 'recr', 'rece', 'recl'         ] },
  ];

  let html = '<div class="shop-list">';

  GROUP.forEach(g => {
    html += `<div class="craft-group-hdr">${g.label}</div>`;
    MAT_UPGRADE_RECIPES.forEach((recipe, idx) => {
      if (!g.ids.includes(recipe.from)) return;
      const fromMat = CRAFT_MATS.find(m => m.id === recipe.from);
      const toMat   = CRAFT_MATS.find(m => m.id === recipe.to);
      if (!fromMat || !toMat) return;
      const fromHave = player.inventory.filter(i => i.id === recipe.from).length;
      const canCraft = fromHave >= recipe.count && player.inventory.length < 50;
      const rc = RARITY_COLOR[toMat.rarity] || '#aaa';

      html += `<div class="shop-row">
        <span class="shop-item-icon">${_matIcon(fromMat, 22)}</span>
        <div class="shop-item-info">
          <div class="shop-item-name" style="color:${rc}">${fromMat.name} → ${toMat.name}</div>
          <div class="shop-item-stat"><b style="color:${canCraft?'#4f4':'#f44'}">${fromHave}/${recipe.count}</b> шт · шанс 30%</div>
        </div>
        <button class="shop-btn${canCraft?'':' disabled'}" onclick="craftMatUpgrade(${idx})">×1</button>
      </div>`;
    });
  });

  html += '</div>';
  return html;
}

function craftItemByTier(idx) {
  const tier = ITEM_CRAFT_TIERS[idx];
  if (!tier || !player) return;
  const mIds = CRAFT_MATS.filter(m => m.slot === 'material' && m.rarity === tier.rarity).map(m => m.id);
  const matHave = player.inventory.filter(i => mIds.includes(i.id)).length;
  const recHave = player.inventory.filter(i => i.id === tier.recipeId).length;
  if (matHave < tier.matCount)       { _shopMsg('Недостаточно материалов!'); return; }
  if (recHave < tier.recipeCount)    { _shopMsg('Недостаточно рецептов!'); return; }
  if (player.inventory.length >= 50) { _shopMsg('Инвентарь полон!'); return; }

  // Consume mats
  let matNeed = tier.matCount;
  player.inventory = player.inventory.filter(i => {
    if (mIds.includes(i.id) && matNeed > 0) { matNeed--; return false; }
    return true;
  });
  // Consume recipes
  let recNeed = tier.recipeCount;
  player.inventory = player.inventory.filter(i => {
    if (i.id === tier.recipeId && recNeed > 0) { recNeed--; return false; }
    return true;
  });

  if (Math.random() < tier.chance) {
    const pool = ITEM_DEF.filter(i => i.rarity === tier.rarity && i.slot !== 'use' && i.slot !== 'material');
    if (pool.length > 0) {
      const item = { ...pool[Math.floor(Math.random() * pool.length)] };
      player.inventory.push(item);
      _shopMsg('✓ Создано: ' + item.name);
    }
  } else {
    _shopMsg('Провал! Материалы потеряны.');
  }
  netSaveProgress();
  openNpc('craftsman');
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
  openNpc('craftsman');
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
